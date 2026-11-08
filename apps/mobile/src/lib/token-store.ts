import * as SecureStore from 'expo-secure-store';

const REFRESH_TOKEN_KEY = 'attendsure.refreshToken';

// Keychain (iOS) and Keystore-backed encrypted storage (Android). Readable only while the phone is unlocked,
// and never copied to backups or other devices.
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export const tokenStore = {
  get: () => SecureStore.getItemAsync(REFRESH_TOKEN_KEY, OPTIONS),
  set: (token: string) => SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token, OPTIONS),
  clear: () => SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY, OPTIONS),
};
