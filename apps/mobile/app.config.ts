import type { ExpoConfig } from 'expo/config';

/**
 * Expo app configuration. The package and bundle identifiers are placeholders: when the university
 * publishes the app under its own Google Play and Apple developer accounts, they change to identifiers
 * the university controls (tracked in IMPLEMENTATION_PROGRESS.md).
 *
 * EXPO_PUBLIC_API_URL (read in src/lib/api.ts): where the app reaches the AttendSure API. The Android emulator reaches this PC as
 * 10.0.2.2; a real phone needs the PC's Wi-Fi address (or, in production, the HTTPS API address).
 */
const config: ExpoConfig = {
  name: 'AttendSure',
  slug: 'attendsure',
  scheme: 'attendsure',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  ios: { bundleIdentifier: 'app.attendsure.mobile', supportsTablet: false },
  android: {
    package: 'app.attendsure.mobile',
    // Phase 1 needs no device permissions. Camera, Bluetooth and location arrive with check-in (Phase 4–5).
    permissions: [],
    // Expo's template adds these by default; AttendSure does not need them (data minimisation, Act 843).
    blockedPermissions: [
      'android.permission.RECORD_AUDIO',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.VIBRATE',
    ],
  },
  plugins: ['expo-dev-client', 'expo-secure-store', 'expo-status-bar'],
};

export default config;
