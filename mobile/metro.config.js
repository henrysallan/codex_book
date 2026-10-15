// Learn more https://docs.expo.dev/guides/customizing-metro
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Shared, dependency-free modules from the web app (`@cortex/*` → ../src/lib).
// Only that folder is watched: the web app's node_modules must never be
// resolved from here, or React loads twice.
config.watchFolders = [path.resolve(__dirname, '../src/lib')];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')];

module.exports = config;
