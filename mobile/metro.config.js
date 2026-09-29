// Metro config. The mobile app reuses the web editor's pure modules — the
// timeline model (../src/core/timeline), the SFX catalogue and silence
// detector (../src/core/audio) and caption line grouping (../src/core/ai) —
// instead of duplicating them, so Metro must be able to see those folders.
// Imports resolve through the `@timeline/*`, `@audio/*` and `@ai/*` paths.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.watchFolders = [
  ...(config.watchFolders ?? []),
  path.resolve(__dirname, '../src/core/timeline'),
  path.resolve(__dirname, '../src/core/audio'),
  path.resolve(__dirname, '../src/core/ai'),
];

module.exports = config;
