/**
 * keelstore example: the app imports "realm" and "@realm/react" as usual; package.json points both names
 * at the keelstore packages. The screen runs a self-check (write, query, update, delete) on start.
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

function SelfCheck() {
  const realm = useRealm();
  const done = useQuery(Task, (tasks) => tasks.filtered('done == true'));
  const [result, setResult] = useState('running');

  useEffect(() => {
    try {
      realm.write(() => {
        realm.delete(realm.objects(Task));
        for (let i = 0; i < 50; i++) realm.create(Task, { _id: i, title: `Task ${i}`, done: i % 5 === 0 });
      });
      realm.write(() => realm.objectForPrimaryKey(Task, 1)!.done = true);
      const ok = realm.objects(Task).length === 50 && realm.objects(Task).filtered('done == true').length === 11;
      setResult(ok ? 'KEELSTORE_SELF_CHECK_OK' : 'KEELSTORE_SELF_CHECK_FAILED');
    } catch (e) {
      setResult(`KEELSTORE_SELF_CHECK_ERROR ${String(e)}`);
    }
  }, [realm]);

  return (
    <>
      <Text style={styles.title}>keelstore example</Text>
      <Text testID="result">{result}</Text>
      <Text>{done.length} tasks done (live query)</Text>
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
