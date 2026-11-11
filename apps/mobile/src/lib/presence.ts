import * as Location from 'expo-location';
import { PermissionsAndroid, Platform } from 'react-native';
import { BleManager, ScanMode, State } from 'react-native-ble-plx';
import { type Reading, ReadingCollector } from './beacon-frames';

/**
 * Collecting presence evidence on the phone (PRESENCE_VERIFICATION.md §4): a short Bluetooth scan and
 * one location reading, only while the person is checking in. Nothing runs in the background. The
 * phone only collects; the server decides.
 */

export const SCAN_SECONDS = 6;
export type BluetoothState = 'ON' | 'OFF' | 'DENIED';

let manager: BleManager | null = null;
const ble = () => (manager ??= new BleManager());

/**
 * Android 12+ asks for "nearby devices", and because beacon scanning counts as location use there
 * (PRESENCE_VERIFICATION §3), for precise location too; without it Android silently returns no
 * beacons. Older Android needs location only.
 */
async function bluetoothPermitted(): Promise<boolean> {
  if (Platform.OS !== 'android') return true; // iOS asks by itself on first use.
  const permissions =
    Number(Platform.Version) >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
  const result = await PermissionsAndroid.requestMultiple(permissions);
  return permissions.every((p) => result[p] === PermissionsAndroid.RESULTS.GRANTED);
}

async function bluetoothState(): Promise<BluetoothState> {
  const state = await ble().state();
  if (state === State.PoweredOn) return 'ON';
  if (state === State.Unauthorized) return 'DENIED';
  // iOS reports Unknown until it is ready; wait briefly for the real state.
  if (state === State.Unknown || state === State.Resetting) {
    const settled = await new Promise<State>((resolve) => {
      const timer = setTimeout(() => {
        subscription.remove();
        resolve(state);
      }, 2000);
      const subscription = ble().onStateChange((s) => {
        if (s === State.Unknown || s === State.Resetting) return;
        clearTimeout(timer);
        subscription.remove();
        resolve(s);
      }, true);
    });
    return settled === State.PoweredOn ? 'ON' : settled === State.Unauthorized ? 'DENIED' : 'OFF';
  }
  return 'OFF';
}

export interface ScanResult {
  bluetooth: BluetoothState;
  readings: Reading[];
}

/**
 * Listens for `seconds` and keeps readings of the listed beacons only. Bluetooth being off or refused
 * is reported, not hidden: the server tells the person what to do.
 */
export async function scanBeacons(
  wanted: ReadonlySet<string>,
  seconds = SCAN_SECONDS,
  onReading?: (count: number) => void,
): Promise<ScanResult> {
  if (!(await bluetoothPermitted())) return { bluetooth: 'DENIED', readings: [] };
  const bluetooth = await bluetoothState();
  if (bluetooth !== 'ON') return { bluetooth, readings: [] };

  const collector = new ReadingCollector(wanted);
  let scanError: Error | null = null;
  await new Promise<void>((resolve) => {
    const finish = () => {
      void ble().stopDeviceScan();
      resolve();
    };
    const timer = setTimeout(finish, seconds * 1000);
    void ble().startDeviceScan(
      null,
      { allowDuplicates: true, scanMode: ScanMode.LowLatency },
      (error, device) => {
        if (error) {
          scanError = error;
          clearTimeout(timer);
          finish();
          return;
        }
        if (!device) return;
        collector.add({
          rssi: device.rssi,
          serviceData: device.serviceData,
          manufacturerData: device.manufacturerData,
        });
        onReading?.(collector.result().length);
      },
    );
  });
  if (scanError) throw scanError;
  return { bluetooth, readings: collector.result() };
}

export interface LocationReading {
  latitude: number;
  longitude: number;
  accuracyM: number;
  isMocked?: boolean;
}

/**
 * One location reading, or null if location is refused, off or too slow. A missing location is never
 * held against the student; the server treats it as uncertain.
 */
export async function readLocation(timeoutMs = 15_000): Promise<LocationReading | null> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return null;
    const position = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (!position) return null;
    return {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      // Some phones report no accuracy; treat that as very poor rather than precise.
      accuracyM: Math.min(Math.max(Math.round(position.coords.accuracy ?? 5000), 0), 5000),
      ...(position.mocked === undefined ? {} : { isMocked: position.mocked }),
    };
  } catch {
    return null; // Location services off: reported to the server as "no location".
  }
}
