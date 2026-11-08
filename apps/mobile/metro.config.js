// Expo's default Metro configuration already understands npm-workspace monorepos (SDK 52+).
const { getDefaultConfig } = require('expo/metro-config');

module.exports = getDefaultConfig(__dirname);
