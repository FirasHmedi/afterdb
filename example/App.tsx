/**
 * keelstore example: the app imports "realm" and "@realm/react" as usual; package.json points both names
 * at the keelstore packages. The screen runs a self-check (write, query, update, delete) on start, and counts
 * the starts in a realm file kept on disk (persistence check: the number goes up by 1 on each start).
 */
import React, { useEffect, useState } from 'react';
import { SafeAreaView, StyleSheet, Text } from 'react-native';
import Realm from 'realm';
import { RealmProvider, useQuery, useRealm } from '@realm/react';

class Task extends Realm.Object<Task> {
  _id!: number;
  title!: string;
  done!: boolean;
  static schema: Realm.ObjectSchema = {
    name: 'Task',
    primaryKey: '_id',
    properties: { _id: 'int', title: 'string', done: { type: 'bool', default: false } },
  };
}

class Launches extends Realm.Object<Launches> {
  _id!: string;
  count!: number;
  static schema: Realm.ObjectSchema = {
    name: 'Launches',
    primaryKey: '_id',
    properties: { _id: 'string', count: 'int' },
  };
}

// Counted once per process (module cache), even if React renders or runs effects twice
let launchText: string | undefined;
function countLaunch(): string {
  if (launchText === undefined) {
    try {
      // On-disk file, never deleted: the counter must survive the app being stopped
      const disk = new Realm({ schema: [Launches], path: 'launches.realm' });
      let count = 0;
      disk.write(() => {
        const row = disk.objectForPrimaryKey(Launches, 'app') ?? disk.create(Launches, { _id: 'app', count: 0 });
        row.count += 1;
        count = row.count;
      });
      disk.close();
      launchText = `launches: ${count}`;
    } catch (e) {
      launchText = `launches: error ${String(e)}`;
    }
  }
  return launchText;
}

// The result is also written to a realm file, so CI can read it from the simulator or emulator storage
// (scripts/read-selfcheck.mjs) without any UI testing tool.
class SelfCheckResult extends Realm.Object<SelfCheckResult> {
  _id!: string;
  text!: string;
  launches!: string;
  at!: Date;
  static schema: Realm.ObjectSchema = {
    name: 'SelfCheckResult',
    primaryKey: '_id',
    properties: { _id: 'string', text: 'string', launches: 'string', at: 'date' },
  };
}

function saveResult(text: string, launches: string) {
  try {
    const r = new Realm({ schema: [SelfCheckResult], path: 'selfcheck-result.realm' });
    r.write(() => r.create(SelfCheckResult, { _id: 'last', text, launches, at: new Date() }, Realm.UpdateMode.Modified));
    r.close();
  } catch {
    // the screen still shows the result
  }
}

function SelfCheck() {
  const realm = useRealm();
  const done = useQuery(Task, (tasks) => tasks.filtered('done == true'));
  const [result, setResult] = useState('running');
  const [launches] = useState(countLaunch);

  useEffect(() => {
    try {
      realm.write(() => {
        realm.delete(realm.objects(Task));
        for (let i = 0; i < 50; i++) realm.create(Task, { _id: i, title: `Task ${i}`, done: i % 5 === 0 });
      });
      realm.write(() => realm.objectForPrimaryKey(Task, 1)!.done = true);
      const ok = realm.objects(Task).length === 50 && realm.objects(Task).filtered('done == true').length === 11;
      // Encrypted file (64-byte key): uses the bundled OpenSSL on Android
      const key = new Int8Array(64).map((_, i) => i + 1);
      const path = 'selfcheck-encrypted.realm';
      Realm.deleteFile({ path });
      const enc = new Realm({ schema: [Task], path, encryptionKey: key });
      enc.write(() => enc.create(Task, { _id: 1, title: 'secret', done: true }));
      enc.close();
      const reopened = new Realm({ schema: [Task], path, encryptionKey: key });
      const encOk = reopened.objectForPrimaryKey(Task, 1)?.title === 'secret';
      reopened.close();
      let refused = false;
      try {
        new Realm({ schema: [Task], path }).close();
      } catch {
        refused = true;
      }
      setResult(ok && encOk && refused ? 'KEELSTORE_SELF_CHECK_OK' : `KEELSTORE_SELF_CHECK_FAILED ok=${ok} encrypted=${encOk} refusedWithoutKey=${refused}`);
    } catch (e) {
      setResult(`KEELSTORE_SELF_CHECK_ERROR ${String(e)}`);
    }
  }, [realm]);

  useEffect(() => {
    if (result !== 'running') saveResult(result, launches);
  }, [result, launches]);

  return (
    <>
      <Text style={styles.title}>keelstore example</Text>
      <Text testID="result">{result}</Text>
      <Text>{done.length} tasks done (live query)</Text>
      <Text testID="launches">{launches}</Text>
    </>
  );
}

export default function App() {
  return (
    <SafeAreaView style={styles.root}>
      <RealmProvider schema={[Task]} inMemory>
        <SelfCheck />
      </RealmProvider>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  title: { fontSize: 20, fontWeight: '600' },
});
