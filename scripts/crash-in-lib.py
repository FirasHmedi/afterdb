#!/usr/bin/env python3
"""Reads an Android tombstone (text format, Android 11) and shows which registers of the crashed thread point into
a given shared library: the load address of the library from the tombstone's memory map, the offset of each such
register in the library, the nearest exported symbol before it, and the instructions just before that address
(a return address follows the call that made it). A call to a PLT entry is resolved to the imported function.
Also lists the last entries of the library's .init_array (the constructors that run when the library is loaded).

Usage: python3 -I scripts/crash-in-lib.py <tombstone.txt> <lib.so> <llvm bin dir>
   lib.so: the same file the process loaded (e.g. extracted from the APK); llvm bin dir: an NDK's llvm tools.
"""
import os
import re
import subprocess
import sys

tomb_path, lib_path, bindir = sys.argv[1:4]
lib = os.path.basename(lib_path)
tool = lambda name, *args: subprocess.run([os.path.join(bindir, name), *args], check=True, capture_output=True,
                                          text=True).stdout
text = open(tomb_path, errors='replace').read()

# registers of the crashed thread: the first register block, between the signal line and "backtrace:"
head = text.split('backtrace:', 1)[0].splitlines()
sig = [i for i, l in enumerate(head) if re.match(r'^signal \d+ ', l)]
regs = []
for line in head[sig[0] + 1 if sig else 0:]:
    regs += re.findall(r'\b([a-z][a-z0-9]{1,3}) +([0-9a-f]{8}(?:[0-9a-f]{8})?)\b', line)

# mappings of the library: "start-end perms offset size path"
maps = []
for line in text.splitlines():
    m = re.match(r"^\s*(?:--->)?\s*([0-9a-f']+)-([0-9a-f']+) +([r-][w-][x-]) +([0-9a-f]+) +([0-9a-f]+) +(\S+)", line)
    if m and m.group(6).endswith('/' + lib):
        start, end = (int(m.group(i).replace("'", ''), 16) for i in (1, 2))
        maps.append((start, end, m.group(3), int(m.group(4), 16), m.group(6)))
if not maps:
    print(f'{lib}: not in the memory map of the tombstone')
    sys.exit(1)
base = min(s - off for s, _, _, off, _ in maps if off == 0) if any(off == 0 for *_, off, _ in maps) else None
print(f'{lib} in the crashed process: {maps[0][4]}')
for s, e, perms, off, _ in maps:
    print(f'  {s:08x}-{e:08x} {perms} file offset 0x{off:x}')
if base is None:
    print('  no mapping at file offset 0: cannot compute offsets')
    sys.exit(1)
print(f'  load address 0x{base:08x} (first LOAD segment at file offset 0, address 0)')

# exported symbols, sorted by address
syms = []
for line in tool('llvm-nm', '-D', '--defined-only', '-n', '-S', lib_path).splitlines():
    p = line.split()
    if len(p) == 4 and p[2] in 'TtWw':
        syms.append((int(p[0], 16) & ~1, int(p[1], 16), p[3]))
relocs = {}
for line in tool('llvm-readelf', '-rW', lib_path).splitlines():
    p = line.split()
    if len(p) >= 5 and p[2].endswith('JUMP_SLOT'):
        relocs[int(p[0], 16)] = p[4]
plt = None
init_array = None  # (file offset, size)
for line in tool('llvm-readelf', '-SW', lib_path).splitlines():
    m = re.search(r'\] \.plt +\S+ +([0-9a-f]+) [0-9a-f]+ ([0-9a-f]+)', line)
    if m:
        plt = (int(m.group(1), 16), int(m.group(1), 16) + int(m.group(2), 16))
    m = re.search(r'\] \.init_array +\S+ +[0-9a-f]+ ([0-9a-f]+) ([0-9a-f]+)', line)
    if m:
        init_array = (int(m.group(1), 16), int(m.group(2), 16))


def symbol_at(addr):  # "name" if a symbol starts at addr, "name+0x.." for the nearest one before it, else hex
    code = addr & ~1
    before = [s for s in syms if s[0] <= code]
    if not before:
        return f'0x{addr:x}'
    s = before[-1]
    return s[2] if s[0] == code else f'{s[2]}+0x{code - s[0]:x}'


# the library's constructors: the dynamic linker calls the .init_array entries in order when it loads the library.
# The values are read from the file (ARM32 uses REL relocations: the address is stored in place).
with open(lib_path, 'rb') as f:
    width = 4 if f.read(5)[4] == 1 else 8
    if init_array:
        f.seek(init_array[0])
        raw = f.read(init_array[1])
if init_array:
    entries = [int.from_bytes(raw[k:k + width], 'little') for k in range(0, len(raw) - width + 1, width)]
    print(f'.init_array of {lib}: {len(entries)} entries; the last ones, in call order:')
    for k, e in list(enumerate(entries))[-3:]:
        print(f'  [{k}] 0x{e:x} {symbol_at(e) if e else "(set by a relocation)"}')
else:
    print(f'{lib}: no .init_array section')


def arm_imm(op):  # "#0, #12" (value, right rotation) or "#307200"
    v = [int(x, 0) for x in re.findall(r'#(-?(?:0x)?[0-9a-f]+)', op)]
    if len(v) == 2:
        return ((v[0] >> v[1]) | (v[0] << (32 - v[1]))) & 0xffffffff
    return v[0]


def plt_target(addr):  # ARM PLT entry: add ip, pc, #a; add ip, ip, #b; ldr pc, [ip, #c]!  ->  GOT slot
    out = tool('llvm-objdump', '-d', '--triple=armv7-linux-androideabi', f'--start-address=0x{addr:x}',
               f'--stop-address=0x{addr + 12:x}', lib_path)
    ins = re.findall(r'^\s*[0-9a-f]+:\s+[0-9a-f]{8}\s+(\S+)\s+(.*)$', out, re.M)
    if len(ins) != 3 or [i[0] for i in ins] != ['add', 'add', 'ldr']:
        return None
    slot = addr + 8 + arm_imm(ins[0][1].split(',', 2)[2]) + arm_imm(ins[1][1].split(',', 2)[2]) + arm_imm(ins[2][1])
    return relocs.get(slot)


by_value = {}
for name, value in regs:
    by_value.setdefault(int(value, 16), []).append(name)
found = False
for v, names in by_value.items():
    if not any(s <= v <= e for s, e, *_ in maps):
        continue
    found = True
    name = ', '.join(names)
    off = v - base
    thumb = off & 1
    code = off & ~1
    before = [s for s in syms if s[0] <= code]
    near = before[-1] if before else None
    where = f'{near[2]} at 0x{near[0]:x} (+0x{code - near[0]:x}, symbol size 0x{near[1]:x})' if near else 'none'
    print(f'{name} = 0x{v:08x} = {lib}+0x{off:x}' + (' (Thumb code address)' if thumb else ''))
    print(f'  nearest exported symbol before it: {where}')
    triple = 'thumbv7-linux-androideabi' if thumb else 'armv7-linux-androideabi'
    out = tool('llvm-objdump', '-d', f'--triple={triple}', f'--start-address=0x{max(code - 8, 0):x}',
               f'--stop-address=0x{code + 2:x}', lib_path)
    lines = [l for l in out.splitlines() if re.match(r'^\s*[0-9a-f]+:', l)]
    print('  instructions before it:')
    for l in lines:
        print('    ' + l.strip())
        m = re.search(r'\bblx?\s+0x([0-9a-f]+)', l)
        if m and plt and plt[0] <= int(m.group(1), 16) < plt[1]:
            print(f'      call through the PLT entry at 0x{int(m.group(1), 16):x}: {plt_target(int(m.group(1), 16))}')
if not found:
    print(f'no register of the crashed thread points into {lib}')
