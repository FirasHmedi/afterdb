/**
 * keelstore example: the app imports "realm" and "@realm/react" as usual; package.json points both names
 * at the keelstore packages. On start the screen runs a self-check on a Projects/Tasks model (schema.ts):
 * create, read, update, delete, primitives, link, list, embedded object, backlink, queries, an encrypted
 * realm, and the live hooks useQuery and useObject. It shows KEELSTORE_SELF_CHECK_OK only if every check
 * passes, otherwise the names of the failed checks. It also counts the starts in a realm file kept on disk
 * (persistence check: the number goes up by 1 on each start).
 */
import React, { useEffect, useState } from 'react';
import { SafeAreaView, StyleSheet, Text } from 'react-native';
import Realm from 'realm';
import { RealmProvider, useObject, useQuery, useRealm } from '@realm/react';
import { Address, Project, Task, schema } from './schema';

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

type Checks = Record<string, boolean>;
const due = (day: number) => new Date(Date.UTC(2026, 10, day));
// Plain object for an embedded Address (Realm's Unmanaged type does not map embedded objects)
const address = (street: string, city: string) => ({ street, city }) as Address;

// Synchronous checks on the provider's realm (in memory)
function runChecks(realm: Realm): Checks {
  realm.write(() => {
    realm.deleteAll();
    const project = realm.create(Project, { _id: 1, name: 'Keel', address: address('1 Quay', 'Lyon') });
    for (let i = 0; i < 5; i++) {
      project.tasks.push(realm.create(Task, { _id: i, title: `Task ${i}`, done: i < 2, estimate: i + 0.5, due: due(i + 1), project }));
    }
  });
  const project = realm.objectForPrimaryKey(Project, 1)!;
  const t3 = realm.objectForPrimaryKey(Task, 3)!;
  const c: Checks = {
    create: realm.objects(Project).length === 1 && realm.objects(Task).length === 5,
    primitives: t3.title === 'Task 3' && !t3.done && t3.estimate === 3.5 && t3.due.getTime() === due(4).getTime(),
    link: t3.project?._id === 1,
    list: project.tasks.length === 5 && project.tasks[3]._id === 3,
    embedded: project.address?.city === 'Lyon',
    backlink: t3.projects.length === 1 && t3.projects[0].name === 'Keel',
    query:
      realm.objects(Task).filtered('done == true AND project.address.city == $0', 'Lyon').length === 2 &&
      realm.objects(Task).filtered('ANY projects._id == 1').length === 5 &&
      realm.objects(Task).sorted('estimate', true)[0]._id === 4,
  };
  realm.write(() => {
    t3.done = true;
    project.address!.city = 'Paris';
    realm.delete(realm.objectForPrimaryKey(Task, 4)!);
  });
  c.update = t3.done && project.address?.city === 'Paris' && realm.objects(Task).filtered('done == true').length === 3;
  c.delete = realm.objectForPrimaryKey(Task, 4) === null && realm.objects(Task).length === 4 && project.tasks.length === 4;
  return { ...c, ...checkEncrypted() };
}

// Encrypted file (64-byte key): uses the bundled OpenSSL on Android
function checkEncrypted(): Checks {
  const path = 'selfcheck-encrypted.realm';
  const config = { schema, path, encryptionKey: new Int8Array(64).map((_, i) => i + 1) };
  Realm.deleteFile(config);
  const enc = new Realm(config);
  enc.write(() => enc.create(Project, { _id: 1, name: 'secret', address: address('x', 'y') }));
  enc.close();
  const reopened = new Realm(config);
  const encryptedReopen = reopened.objectForPrimaryKey(Project, 1)?.address?.city === 'y';
  reopened.close();
  let encryptedNeedsKey = false;
  try {
    new Realm({ schema, path }).close();
  } catch {
    encryptedNeedsKey = true;
  }
  return { encryptedReopen, encryptedNeedsKey };
}

function SelfCheck() {
  const realm = useRealm();
  const doneTasks = useQuery({ type: Task, query: (tasks) => tasks.filtered('done == true') });
  const project = useObject(Project, 1);
  const [checks, setChecks] = useState<Checks>();
  const [error, setError] = useState<string>();
  const [timedOut, setTimedOut] = useState(false);
  const [launches] = useState(countLaunch);

  useEffect(() => {
    try {
      setChecks(runChecks(realm));
    } catch (e) {
      setError(String(e));
    }
    const timer = setTimeout(() => setTimedOut(true), 5000);
    return () => clearTimeout(timer);
  }, [realm]);

  // Live hooks: once useObject shows the project, change it; both hooks must re-render with the change
  useEffect(() => {
    if (checks && project?.name === 'Keel') {
      realm.write(() => {
        project.name = 'Keel renamed';
        project.tasks.push(realm.create(Task, { _id: 10, title: 'Late task', done: true, estimate: 1, due: due(30), project }));
      });
    }
  }, [realm, checks, project]);

  const all: Checks | undefined = checks && {
    ...checks,
    useQuery: doneTasks.length === 4 && doneTasks.some((t) => t._id === 10),
    useObject: project?.name === 'Keel renamed' && project.tasks.length === 5,
  };
  const failed = all ? Object.keys(all).filter((name) => !all[name]) : [];
  let result = 'running';
  if (error) {
    result = `KEELSTORE_SELF_CHECK_ERROR ${error}`;
  } else if (all && failed.length === 0) {
    result = 'KEELSTORE_SELF_CHECK_OK';
  } else if (all && timedOut) {
    result = `KEELSTORE_SELF_CHECK_FAILED: ${failed.join(', ')}`;
  }

  return (
    <>
      <Text style={styles.title}>keelstore example</Text>
      <Text testID="result">{result}</Text>
      {all && <Text style={styles.small}>{Object.keys(all).length} checks: {Object.keys(all).join(', ')}</Text>}
      <Text>useQuery: {doneTasks.length} tasks done</Text>
      <Text>useObject: {project ? `${project.name}, ${project.tasks.length} tasks, ${project.address?.city}` : 'none'}</Text>
      <Text testID="launches">{launches}</Text>
    </>
  );
}

export default function App() {
  return (
    <SafeAreaView style={styles.root}>
      <RealmProvider schema={schema} inMemory>
        <SelfCheck />
      </RealmProvider>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 16 },
  title: { fontSize: 20, fontWeight: '600' },
  small: { fontSize: 12, textAlign: 'center' },
});
