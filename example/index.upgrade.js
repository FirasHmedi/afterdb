/**
 * Entry of the upgrade test build (ENTRY_FILE=index.upgrade.js, see .github/workflows/upgrade.yml and
 * upgrade/data.ts). The default entry, index.js, keeps the self-check.
 */
import React from 'react';
import { AppRegistry } from 'react-native';
import UpgradeApp from './upgrade/UpgradeApp';
import { name as appName } from './app.json';

// Name and version of the package installed as "realm": the official realm, or @pomwik/afterdb through the alias
const realmPackage = require('realm/package.json');
const writer = `${realmPackage.name}@${realmPackage.version}`;

AppRegistry.registerComponent(appName, () => () => React.createElement(UpgradeApp, { writer }));
