// Metro config. The mobile app reuses the web editor's pure timeline model
// (../src/core/timeline) and SFX catalogue (../src/core/audio/sfxList.ts)
// instead of duplicating them, so Metro must be able to see those folders.
// Imports resolve through the `@timeline/*` and `@audio/*` tsconfig paths.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.watchFolders = [
  ...(config.watchFolders ?? []),
  path.resolve(__dirname, '../src/core/timeline'),
  path.resolve(__dirname, '../src/core/audio'),
];

module.exports = config;
