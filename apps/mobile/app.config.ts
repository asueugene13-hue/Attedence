import type { ExpoConfig } from 'expo/config';

/**
 * Expo app configuration. The package and bundle identifiers are placeholders: when the university
 * publishes the app under its own Google Play and Apple developer accounts, they change to identifiers
 * the university controls (tracked in IMPLEMENTATION_PROGRESS.md).
 *
 * EXPO_PUBLIC_API_URL (read in src/lib/api.ts): where the app reaches the AttendSure API. The Android emulator reaches this PC as
 * 10.0.2.2; a real phone needs the PC's Wi-Fi address (or, in production, the HTTPS API address).
 */
/** The Expo project the cloud builds belong to (created with `eas init`, product owner's account). */
const EAS_PROJECT_ID = '199703bb-8d95-462d-9c7d-3c5daa90c2b7';

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
    // Bluetooth scanning and fine location are added by the two plugins below (Android 12+ treats
    // beacon scanning as location use). The camera is added by the expo-camera plugin (QR check-in).
    permissions: [],
    // Expo's template adds these by default; AttendSure does not need them (data minimisation, Act 843).
    blockedPermissions: [
      'android.permission.RECORD_AUDIO',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.VIBRATE',
      // No tracking: location is read once, while the app is open (PRESENCE_VERIFICATION.md §4).
      'android.permission.ACCESS_BACKGROUND_LOCATION',
    ],
  },
  plugins: [
    'expo-dev-client',
    'expo-secure-store',
    'expo-status-bar',
    [
      'expo-camera',
      {
        // The camera reads the attendance QR on the lecturer's screen; nothing is recorded or kept.
        cameraPermission: 'AttendSure uses the camera only to scan the attendance code shown in class.',
        microphonePermission: false,
        recordAudioAndroid: false,
      },
    ],
    [
      'react-native-ble-plx',
      {
        // Scanning only while the app is open, during a check-in or a classroom check (§3).
        isBackgroundEnabled: false,
        modes: [],
        bluetoothAlwaysPermission:
          'AttendSure uses Bluetooth only while you check in, to hear the classroom’s beacon. It never scans in the background.',
      },
    ],
    [
      'expo-location',
      {
        locationWhenInUsePermission:
          'AttendSure reads your location once when you check in, to confirm you are on campus. It never tracks you.',
        isAndroidBackgroundLocationEnabled: false,
        isIosBackgroundLocationEnabled: false,
      },
    ],
  ],
  extra: {
    // Links this app to its Expo project for cloud builds (EAS). Not a secret.
    eas: { projectId: process.env.EAS_PROJECT_ID ?? EAS_PROJECT_ID },
  },
};

export default config;
