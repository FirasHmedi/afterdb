/**
 * Small Projects/Tasks model used by the self-check: primitives (int, string, bool, double, date), a link
 * (Task.project), a list (Project.tasks), an embedded object (Project.address) and a backlink (Task.projects).
 */
import Realm from 'realm';

export class Address extends Realm.Object<Address> {
  street!: string;
  city!: string;
  static schema: Realm.ObjectSchema = {
    name: 'Address',
    embedded: true,
    properties: { street: 'string', city: 'string' },
  };
}

export class Project extends Realm.Object<Project> {
  _id!: number;
  name!: string;
  address?: Address;
  tasks!: Realm.List<Task>;
  static schema: Realm.ObjectSchema = {
    name: 'Project',
    primaryKey: '_id',
    properties: { _id: 'int', name: 'string', address: 'Address?', tasks: 'Task[]' },
  };
}

export class Task extends Realm.Object<Task> {
  _id!: number;
  title!: string;
  done!: boolean;
  estimate!: number;
  due!: Date;
  project?: Project;
  projects!: Realm.Results<Project>;
  static schema: Realm.ObjectSchema = {
    name: 'Task',
    primaryKey: '_id',
    properties: {
      _id: 'int',
      title: 'string',
      done: { type: 'bool', default: false },
      estimate: 'double',
      due: 'date',
      project: 'Project?',
      // Backlink: the projects whose `tasks` list holds this task
      projects: { type: 'linkingObjects', objectType: 'Project', property: 'tasks' },
    },
  };
}

export const schema = [Project, Task, Address];
