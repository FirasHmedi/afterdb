// SDK object methods, called through Realm.Object.prototype. In a file opened
// without a schema, each stored property is an accessor on the class prototype,
// so a property named `_objectKey`, `objectSchema` or `linkingObjects` hides the
// method of the same name on the object itself.
import Realm from 'realm';

const RO = Realm.Object.prototype;

export const objectKey = (obj) => RO._objectKey.call(obj);
export const classOf = (obj) => RO.objectSchema.call(obj).name;
export const linkingObjects = (obj, cls, prop) => RO.linkingObjects.call(obj, cls, prop);
