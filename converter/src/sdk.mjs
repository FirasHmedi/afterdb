// Safe access to SDK objects. The source file is opened without a schema, so
// each stored property is an accessor on the class prototype: a property named
// like an SDK member (`_objectKey`, `objectSchema`, `linkingObjects`,
// `constructor`...) hides it on the object, and SDK methods that use other
// members through `this` break as well (objectSchema() reads this.constructor,
// linkingObjects() calls this.objectSchema()). So the converter never calls a
// method on an SDK object and reads no string-keyed member of it other than its
// stored properties:
// - the object key comes from Realm.Object.prototype._objectKey, whose code
//   reads only an internal symbol;
// - the class comes from the object's prototype (one per class), mapped to the
//   class name with objects read from the realm (indexClasses);
// - backlinks are computed from the forward links (canon.mjs), not with
//   linkingObjects().
// Dictionaries are the other way round: their methods (keys, values, set,
// toString...) hide entries with the same key, so entries are read with
// Dictionary.prototype.entries, never as properties.
import Realm from 'realm';

const RO = Realm.Object.prototype;
const DICT = Realm.Dictionary.prototype;

export const objectKey = (obj) => RO._objectKey.call(obj);

/** [key, value] pairs of a Dictionary, whatever the keys are called. */
export const dictEntries = (dict) => DICT.entries.call(dict);

/** An object without prototype, so that a key named "__proto__" stays a key. */
export const record = () => Object.create(null);

const classByProto = new WeakMap();

/**
 * Remembers the prototype of each class of an open realm. All objects of a
 * class share one prototype, so one object per class is enough; a class
 * without objects cannot be the class of an object we read.
 */
export function indexClasses(realm) {
  for (const c of realm.schema) {
    if (c.embedded || c.asymmetric) continue;
    const objects = realm.objects(c.name);
    if (objects.length) classByProto.set(Object.getPrototypeOf(objects[0]), c.name);
  }
}

/** Class name of an object read from a realm passed to indexClasses(). */
export function classOf(obj) {
  const name = classByProto.get(Object.getPrototypeOf(obj));
  if (name === undefined) throw new Error('linked object of a class that is not in the file');
  return name;
}
