/**
 * Upgrade mode of the example app (entry index.upgrade.js): runs one stage of the upgrade test (data.ts) on start,
 * then opens the encrypted file with RealmProvider and counts its items with useQuery.
 * The screen shows AFTERDB_UPGRADE_OK stage=<n> history=<package that wrote each generation> items=<count>, or
 * AFTERDB_UPGRADE_FAILED / AFTERDB_UPGRADE_ERROR with the reasons. The same text goes to upgrade-result.realm
 * (read on iOS by scripts/read-upgrade-result.mjs) and to the log.
 */
import React, { useEffect, useState } from 'react';
import { SafeAreaView, ScrollView, StyleSheet, Text } from 'react-native';
import Realm from 'realm';
import { RealmProvider, useQuery } from '@realm/react';
import { ENCRYPTED_PATH, KEY, RESULT_PATH, type StageResult, runStage, schema } from './data';

// One stage per process (module cache), even if React renders twice
let stageResult: StageResult | { error: string } | undefined;
function stageOnce(writer: string) {
  if (stageResult === undefined) {
    try {
      stageResult = runStage(Realm, writer);
    } catch (e) {
      stageResult = { error: String(e) };
    }
  }
  return stageResult;
}

const resultSchema: Realm.ObjectSchema = {
  name: 'UpgradeResult',
  primaryKey: '_id',
  properties: { _id: 'string', text: 'string', at: 'date' },
};

function saveResult(text: string) {
  try {
    const r = new Realm({ schema: [resultSchema], path: RESULT_PATH });
    r.write(() => r.create('UpgradeResult', { _id: 'last', text, at: new Date() }, Realm.UpdateMode.Modified));
    r.close();
  } catch {
    // the screen still shows the result
  }
}

function CountItems({ onCount }: { onCount: (n: number) => void }) {
  const items = useQuery('UpItem');
  useEffect(() => onCount(items.length), [items.length, onCount]);
  return null;
}

export default function UpgradeApp({ writer }: { writer: string }) {
  const [stage] = useState(() => stageOnce(writer));
  const [count, setCount] = useState<number>();
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), 15000);
    return () => clearTimeout(timer);
  }, []);

  let text = 'running';
  if ('error' in stage) {
    text = `AFTERDB_UPGRADE_ERROR ${stage.error}`;
  } else if (!stage.ok) {
    text = stage.text;
  } else if (count === stage.items) {
    text = stage.text;
  } else if (count !== undefined || timedOut) {
    text = `AFTERDB_UPGRADE_FAILED stage=${stage.stage} useQuery on the encrypted file: ${count ?? 'no result'} items, expected ${stage.items}`;
  }

  useEffect(() => {
    if (text !== 'running') {
      console.log(text);
      saveResult(text);
    }
  }, [text]);

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>afterdb upgrade test</Text>
        <Text testID="result">{text}</Text>
        <Text style={styles.small}>{`built with ${writer}`}</Text>
        {'files' in stage &&
          stage.files.map((f) => (
            <Text key={f.file} style={styles.small}>
              {`${f.file}: ${f.before} generations found, ${f.after} after this stage`}
            </Text>
          ))}
        {'ok' in stage && stage.ok && (
          <RealmProvider schema={schema} path={ENCRYPTED_PATH} encryptionKey={KEY}>
            <CountItems onCount={setCount} />
          </RealmProvider>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 16 },
  title: { fontSize: 20, fontWeight: '600' },
  small: { fontSize: 12, textAlign: 'center' },
});
