// Metro config. The mobile app reuses the web editor's pure timeline model
// (../src/core/timeline) instead of duplicating it, so Metro must be able to
// see that folder. Imports resolve through the `@timeline/*` tsconfig path.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.watchFolders = [
  ...(config.watchFolders ?? []),
  path.resolve(__dirname, '../src/core/timeline'),
];

module.exports = config;
