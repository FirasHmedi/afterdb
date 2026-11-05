// Fictitious data set for the query differential test.
import Realm from 'realm';
import { mulberry32 } from '../src/verify.mjs';

export const rqlSchema = [
  { name: 'City', primaryKey: 'name', properties: { name: 'string', country: 'string?', population: 'int?', mayor: 'Person?' } },
  {
    name: 'Person', primaryKey: '_id',
    properties: {
      _id: 'int', name: 'string?', nick: 'string', age: 'int?', height: 'double?', score: 'float?', active: 'bool?', born: 'date?',
      city: 'City?', boss: 'Person?', tags: 'string?[]', scores: 'int?[]', ratings: 'double[]', friends: 'Person[]', visits: 'Visit[]',
      address: 'Address?',
      fans: { type: 'linkingObjects', objectType: 'Person', property: 'friends' },
      reports: { type: 'linkingObjects', objectType: 'Person', property: 'boss' },
    },
  },
  { name: 'Visit', properties: { at: 'date', place: 'string', stars: 'int?' } }, // no primary key
  { name: 'Address', embedded: true, properties: { street: 'string', zip: 'string?', floor: 'int?' } },
];

export const NAMES = ['alice', 'Alice', 'ALICE', 'bob', 'Bob', 'émile', 'Émile', 'ÉMILE', 'Çağla', 'çağla', 'straße', 'STRASSE', 'Œuvre', 'œuvre',
  'ÿves', 'Ÿves', 'zoé', 'ZOÉ', 'a*b', 'a?b', 'a[b]c', '%_x', '', ' ', 'emoji 🙂', 'ñandú', 'ÑANDÚ', 'İstanbul', 'istanbul', 'ÆSIR', 'æsir', 'Øystein', 'øystein'];
export const TAGS = ['red', 'Red', 'RED', 'blue', 'été', 'ÉTÉ', 'Ça', 'ça', '', 'x*y', null];
export const CITIES = ['Paris', 'paris', 'Lyon', 'Évry', 'évry', 'Zürich', 'São Paulo', 'Oslo'];
export const HEIGHTS = [1.5, 1.75, 2, -0, 0, NaN, Infinity, -Infinity, 1e-300, null];
export const DATES = [new Date(-2208988800000), new Date(-1), new Date(0), new Date(86400000), new Date(Date.UTC(2000, 1, 29)), new Date(Date.UTC(2024, 5, 1, 12, 30))];

export async function makeRqlRealm(file, { n = 300, seed = 2026 } = {}) {
  const rnd = mulberry32(seed);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const realm = await Realm.open({ path: file, schema: rqlSchema });
  realm.write(() => {
    const cities = CITIES.map((name, i) => realm.create('City', { name, country: i % 3 ? (i % 2 ? 'FR' : 'CH') : null, population: i % 4 ? i * 1000 : null }));
    const ids = Array.from({ length: n }, (_, i) => i + 1).sort(() => rnd() - 0.5); // shuffled insertion
    const people = [];
    for (const [k, id] of ids.entries()) {
      const p = realm.create('Person', {
        _id: id,
        name: rnd() < 0.08 ? null : pick(NAMES),
        nick: pick(NAMES),
        age: rnd() < 0.1 ? null : Math.floor(rnd() * 12) * 5, // many ties
        height: pick(HEIGHTS),
        score: rnd() < 0.1 ? null : Math.fround(Math.floor(rnd() * 20) / 4),
        active: rnd() < 0.15 ? null : rnd() < 0.5,
        born: rnd() < 0.1 ? null : pick(DATES),
        city: rnd() < 0.2 ? null : pick(cities),
        tags: Array.from({ length: Math.floor(rnd() * 4) }, () => pick(TAGS)),
        scores: Array.from({ length: Math.floor(rnd() * 4) }, () => (rnd() < 0.15 ? null : Math.floor(rnd() * 10))),
        ratings: Array.from({ length: Math.floor(rnd() * 3) }, () => pick([0.5, 1, 2.5, NaN, -0, Infinity])),
        visits: Array.from({ length: Math.floor(rnd() * 3) }, () => ({ at: pick(DATES), place: pick(CITIES), stars: rnd() < 0.2 ? null : Math.floor(rnd() * 5) })),
        address: rnd() < 0.3 ? null : { street: pick(['rue A', 'Rue B', 'rue Été']), zip: rnd() < 0.3 ? null : pick(['75001', '69001']), floor: rnd() < 0.3 ? null : Math.floor(rnd() * 6) },
      });
      people.push(p);
      void k;
    }
    for (const p of people) {
      p.boss = rnd() < 0.3 ? null : pick(people);
      const nf = Math.floor(rnd() * 4);
      for (let j = 0; j < nf; j++) p.friends.push(pick(people));
    }
    for (const c of cities) c.mayor = rnd() < 0.3 ? null : pick(people);
  });
  realm.close();
}
