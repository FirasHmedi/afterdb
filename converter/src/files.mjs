// Files written by a conversion: the private copy of the input, the SQLite
// output and the report. Rules (see README, Output files):
// - all paths are the paths as the system resolves them (links, and `x/..`
//   where x is a link): see canonical();
// - every path the run may create, replace or delete is checked against the
//   input (and the files the SDK keeps next to it) and against each other
//   before any work;
// - the input is never opened by the SDK: it is copied into a new private
//   folder afterdb.<12 hex>.copy (0700) in the folder of <out>, and the copy is
//   converted; the folder is deleted at the end of the run, whatever happens;
// - the database is written to a temporary file with a short unique name
//   (afterdb.<12 hex>.partial, whatever the length of <out>), created exclusively
//   in the folder of <out>, then given its name: link() when <out> must not
//   exist (it fails if anything appeared there), rename() with --force;
// - the database and the report are created no more open than the input
//   (read/write bits of the input, at most 0644, minus the umask), and a file
//   they replace keeps its narrower permissions;
// - on an error the run deletes only the files and folders it created itself,
//   recognised by their inode, never a file that was there before (the files
//   an app keeps next to the input are not the run's, see convert.mjs);
// - an old report is moved aside, not deleted, while the new one is put in its
//   place; it is moved back if the run then fails, and deleted only once the
//   database has its final name.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** Files SQLite opens next to a database `x`: x-journal, x-wal, x-shm. */
export const SQLITE_SIDE = ['-journal', '-wal', '-shm'];

// ENAMETOOLONG: a name longer than the disk allows cannot exist.
const missing = (e) => e.code === 'ENOENT' || e.code === 'ENOTDIR' || e.code === 'ENAMETOOLONG';

/** fs.Stats of a path (links followed), or null when nothing is there. */
export function statOf(p) {
  try {
    return fs.statSync(p, { bigint: true });
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
}

/** fs.Stats of a path itself (a link is not followed), or null. */
export function lstatOf(p) {
  try {
    return fs.lstatSync(p, { bigint: true });
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
}

export const sameFile = (a, b) => !!a && !!b && a.dev === b.dev && a.ino === b.ino;

/**
 * Absolute path with its longest existing prefix resolved by the system
 * (links, `.` and `..`, and on macOS the case of the names on disk). Two
 * paths that name the same place give the same string, except for names that
 * do not exist yet and differ only in case (or in Unicode normalization) on a
 * case-insensitive disk: see foldName() for the names that must never match,
 * and the checks by inode just before each rename.
 * Not path.resolve() first: it removes `x/..` as text, while the system
 * resolves x first, and x can be a link to another folder (`docs/../app.realm`
 * with docs -> device/Documents is device/app.realm).
 */
export function canonical(p) {
  const abs = path.isAbsolute(p) ? p : process.cwd() + path.sep + p;
  const tail = [];
  for (let head = abs; ; head = path.dirname(head)) {
    try {
      return path.join(fs.realpathSync.native(head), ...tail);
    } catch (e) {
      if (!missing(e)) throw e;
    }
    if (path.dirname(head) === head) return path.resolve(abs);
    tail.unshift(path.basename(head));
  }
}

/** a is b or inside b (both canonical). */
export const within = (a, b) => a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);

/**
 * A file name as a case-insensitive disk compares it (APFS and HFS+ on macOS,
 * exFAT, FAT, NTFS): case and Unicode normalization ignored. Slightly broader
 * than any of them, which is what a refusal needs.
 */
export const foldName = (n) => n.normalize('NFD').toLowerCase().normalize('NFD');

const tracked = new Set();

/**
 * Files and folders created by one run, removed on an error or an interrupt.
 * A file is removed only if the path still holds the inode the run created.
 * Old files moved aside by the run (moveAside) are moved back.
 */
export class Created {
  constructor() {
    this.files = [];
    this.dirs = [];
    this.aside = [];
    this.sqlite = [];
    this.trees = [];
    tracked.add(this);
  }
  file(p) {
    const s = fs.lstatSync(p, { bigint: true });
    this.files.push({ p, dev: s.dev, ino: s.ino });
    return p;
  }
  /**
   * `p` is a SQLite database of this run: SQLite creates p-journal (p-wal,
   * p-shm) next to it while it writes. The name of p was taken only when none
   * of these existed (createUnique), so they are removed with p.
   */
  sqliteFile(p) {
    this.sqlite.push(p);
  }
  /** A private folder of this run, deleted with all it holds (by inode) at the end. */
  tree(p) {
    const s = fs.lstatSync(p, { bigint: true });
    this.trees.push({ p, dev: s.dev, ino: s.ino });
    return p;
  }
  /**
   * Deletes the private folders of this run (the copy of the input). Also
   * called by the signal handler while the copy is still being written by a
   * worker thread: the file is unlinked (its space is freed when the process
   * ends), and a retry covers the copy creating its file between the listing
   * of the folder and its removal (ENOTEMPTY).
   */
  removeTrees() {
    for (const t of this.trees.splice(0)) {
      try {
        if (sameFile(lstatOf(t.p), t)) fs.rmSync(t.p, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
      } catch { /* best effort */ }
    }
  }
  renamed(from, to) {
    for (const f of this.files) if (f.p === from) f.p = to;
  }
  /** mkdir -p, remembering the folders it created. */
  mkdir(dir) {
    const first = fs.mkdirSync(dir, { recursive: true });
    if (first === undefined) return;
    const end = path.resolve(dir);
    for (let d = path.resolve(first); ; d = path.join(d, path.relative(d, end).split(path.sep)[0])) {
      this.dirs.push(d);
      if (d === end) break;
    }
  }
  /**
   * Moves an existing file (or link) at `p` to a new unique name next to it,
   * `<base>.<random>.old`, so that `p` can take a new file. removeAll() moves it
   * back; commit() deletes it. Returns false when nothing is at `p`.
   */
  moveAside(p, base) {
    if (!lstatOf(p)) return false;
    const bak = createUnique(base, '.old', this); // empty placeholder, replaced below
    const placeholder = lstatOf(bak);
    try {
      fs.renameSync(p, bak);
    } catch (e) {
      if (!missing(e)) throw e;
      // Gone meanwhile (another run moved it): nothing to keep, drop the placeholder.
      try { if (sameFile(lstatOf(bak), placeholder)) fs.rmSync(bak, { force: true }); } catch { /* removed by removeAll() */ }
      return false;
    }
    const s = fs.lstatSync(bak, { bigint: true });
    this.aside.push({ p, bak, dev: s.dev, ino: s.ino });
    return true;
  }
  removeAll() {
    this.removeTrees();
    for (const f of this.files.reverse()) {
      try {
        if (sameFile(lstatOf(f.p), f)) fs.rmSync(f.p, { force: true });
      } catch { /* best effort */ }
    }
    for (const p of this.sqlite) {
      for (const s of SQLITE_SIDE) {
        try { if (lstatOf(p + s)?.isFile()) fs.rmSync(p + s, { force: true }); } catch { /* best effort */ }
      }
    }
    // Old files go back to their name, unless another program has put a file
    // there meanwhile: then the old one stays under its .old name.
    for (const a of this.aside.reverse()) {
      try {
        if (sameFile(lstatOf(a.bak), a) && !lstatOf(a.p)) fs.renameSync(a.bak, a.p);
      } catch { /* best effort */ }
    }
    for (const d of this.dirs.reverse()) {
      try { fs.rmdirSync(d); } catch { /* not empty or gone: left as it is */ }
    }
    this.done();
  }
  /** The run succeeded: delete the old files it replaced and the private folders, keep everything else. */
  commit() {
    this.removeTrees();
    for (const a of this.aside) {
      try {
        if (sameFile(lstatOf(a.bak), a)) fs.rmSync(a.bak, { force: true });
      } catch { /* best effort: the old file stays under its .old name */ }
    }
    this.done();
  }
  /** Stop tracking (after commit() or removeAll()). */
  done() {
    this.files = [];
    this.dirs = [];
    this.aside = [];
    this.sqlite = [];
    this.trees = [];
    tracked.delete(this);
  }
}

/** Removes what every running conversion created (used by the CLI on SIGINT/SIGTERM/SIGHUP). */
export function removeCreatedFiles() {
  for (const c of [...tracked]) c.removeAll();
}

const rand = () => randomBytes(6).toString('hex');

/**
 * Creates an empty file with a unique name `<base>.<random><suffix>`, with
 * O_EXCL so that no existing file is ever reused, and with permissions `mode`
 * (minus the umask). With `sqlite`, the name is only taken if none of its
 * SQLite side files exists either: SQLite would delete or replay them when it
 * opens the new database.
 */
export function createUnique(base, suffix, created, { sqlite = false, content, mode = 0o644 } = {}) {
  for (let i = 0; i < 100; i++) {
    const p = `${base}.${rand()}${suffix}`;
    if (sqlite && SQLITE_SIDE.some((s) => lstatOf(p + s))) continue;
    let fd;
    try {
      fd = fs.openSync(p, 'wx', mode);
    } catch (e) {
      if (e.code === 'EEXIST') continue;
      throw e;
    }
    try {
      created.file(p);
      if (sqlite) created.sqliteFile(p);
      if (content !== undefined) fs.writeFileSync(fd, content);
    } finally {
      fs.closeSync(fd);
    }
    return p;
  }
  throw new Error(`could not create a temporary file next to ${base}`);
}

/**
 * Copies `src` into a new private folder `<dir>/afterdb.<12 hex>.copy` (0700,
 * created exclusively, deleted by removeAll() or commit()) and returns the path
 * of the copy. COPYFILE_FICLONE: a clone (instant, no extra space) where the
 * file system and Node support it (btrfs, XFS on Linux), a full copy otherwise
 * (measured: also on APFS with Node 22.19, which does not clone on macOS), so
 * the folder of <out> needs free space for a whole copy of the input. The copy
 * runs off the main thread (fs.promises), so a signal is handled at once and
 * the CLI deletes the folder while the copy goes on (see bin/ and the test
 * "during the copy of a large input": 512 MiB, signal handled in under 10 ms;
 * copyFileSync blocked the event loop until the end of the copy, 0.8 s). The
 * caller compares the SHA-256 of the copy with the source's.
 */
export async function privateCopy(src, dir, created) {
  for (let i = 0; i < 100; i++) {
    const d = path.join(dir, `afterdb.${rand()}.copy`);
    try {
      fs.mkdirSync(d, { mode: 0o700 });
    } catch (e) {
      if (e.code === 'EEXIST') continue;
      throw e;
    }
    created.tree(d);
    fs.chmodSync(d, 0o700); // whatever the umask
    const file = path.join(d, 'source.realm');
    await fs.promises.copyFile(src, file, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
    return file;
  }
  throw new Error(`could not create a temporary folder in ${dir}`);
}

/**
 * Permissions for the files of a run: the read/write bits of the input, never
 * more than 0644 (SQLite's own default), and always owner read/write (the run
 * writes them). The umask applies on top, at creation.
 */
export const modeFrom = (inputMode) => (Number(inputMode) & 0o644) | 0o600;

/**
 * Before `tmp` replaces `dest`: an existing regular file at `dest` keeps
 * narrower permissions (a private 0600 output stays 0600 with --force).
 */
export function keepNarrowerMode(tmp, dest) {
  const old = lstatOf(dest);
  if (!old?.isFile()) return;
  const cur = Number(fs.statSync(tmp).mode) & 0o777;
  const narrow = cur & Number(old.mode) & 0o777;
  if (narrow !== cur) fs.chmodSync(tmp, narrow);
}

const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK', 'EXDEV']);

/**
 * Gives `tmp` the name `dest`. With `replace`, an existing `dest` is replaced
 * (rename). Without it, `dest` must not exist: the new name is created with
 * link(), which fails if anything (a file, a folder, a dangling link) is
 * already there, so two runs or another program cannot be overwritten between
 * a check and the rename. On a file system without hard links it falls back to
 * a check followed by a rename.
 */
export function commitName(tmp, dest, { replace, exists }) {
  if (replace) {
    fs.renameSync(tmp, dest);
    return;
  }
  try {
    fs.linkSync(tmp, dest);
  } catch (e) {
    if (e.code === 'EEXIST') throw exists();
    if (!NO_HARD_LINKS.has(e.code)) throw e;
    if (lstatOf(dest)) throw exists();
    fs.renameSync(tmp, dest);
    return;
  }
  try { fs.unlinkSync(tmp); } catch { /* the file has its final name; tmp is a second name for it */ }
}
