// Safe-area insets come from the device; in tests use the library's own mock (fixed insets).
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
