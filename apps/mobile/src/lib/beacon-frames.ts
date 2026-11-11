/**
 * Reading beacon broadcasts (PRESENCE_VERIFICATION.md §3). Pure functions, so they are tested without
 * a phone. Each returns the identifier in the same form the beacon register stores it (lower case),
 * or null when the broadcast is something else.
 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 (as the Bluetooth library reports advertisement data) to bytes. */
export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const out: number[] = [];
  for (let i = 0; i + 1 < clean.length; i += 4) {
    const n = [0, 1, 2, 3].map((k) => {
      const c = clean[i + k];
      return c === undefined ? 0 : B64.indexOf(c);
    });
    const bits = (n[0]! << 18) | (n[1]! << 12) | (n[2]! << 6) | n[3]!;
    out.push((bits >> 16) & 255);
    if (i + 2 < clean.length) out.push((bits >> 8) & 255);
    if (i + 3 < clean.length) out.push(bits & 255);
  }
  return Uint8Array.from(out);
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** The Eddystone service, 0xFEAA, as a full 128-bit UUID. */
export const EDDYSTONE_SERVICE_UUID = '0000feaa-0000-1000-8000-00805f9b34fb';

/**
 * Eddystone-UID: frame type 0x00, transmit power, a 10-byte namespace and a 6-byte instance.
 * Returns the 32 hex characters "namespace + instance".
 */
export function parseEddystoneUid(serviceData: Uint8Array): string | null {
  if (serviceData.length < 18 || serviceData[0] !== 0x00) return null;
  return hex(serviceData.slice(2, 18));
}

/**
 * iBeacon: Apple's company ID (0x004C, little-endian), type 0x02, length 0x15, then a 16-byte
 * proximity UUID, a 2-byte major and a 2-byte minor (big-endian). Returns "uuid:major:minor".
 * Note: iPhones hide iBeacon broadcasts from ordinary Bluetooth scanning, so this works on Android.
 */
export function parseIBeacon(manufacturerData: Uint8Array): string | null {
  const d = manufacturerData;
  if (d.length < 25 || d[0] !== 0x4c || d[1] !== 0x00 || d[2] !== 0x02 || d[3] !== 0x15) return null;
  const u = hex(d.slice(4, 20));
  const uuid = `${u.slice(0, 8)}-${u.slice(8, 12)}-${u.slice(12, 16)}-${u.slice(16, 20)}-${u.slice(20)}`;
  const major = (d[20]! << 8) | d[21]!;
  const minor = (d[22]! << 8) | d[23]!;
  return `${uuid}:${major}:${minor}`;
}

/** What the Bluetooth library reports for one advertisement. */
export interface Advertisement {
  rssi: number | null;
  serviceData: Record<string, string> | null;
  manufacturerData: string | null;
}

/** The registered beacon identifier this advertisement carries, if any. */
export function identifierOf(ad: Advertisement): string | null {
  for (const [uuid, data] of Object.entries(ad.serviceData ?? {})) {
    const key = uuid.toLowerCase();
    if (key === EDDYSTONE_SERVICE_UUID || key === 'feaa') {
      const id = parseEddystoneUid(fromBase64(data));
      if (id) return id;
    }
  }
  return ad.manufacturerData ? parseIBeacon(fromBase64(ad.manufacturerData)) : null;
}

export interface Reading {
  identifier: string;
  rssi: number;
}

/**
 * Collects readings during a scan: only beacons on the scan list, only plausible signal strengths,
 * at most `perBeacon` readings each and `total` overall (the server accepts 200).
 */
export class ReadingCollector {
  private readonly readings: Reading[] = [];
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly wanted: ReadonlySet<string>,
    private readonly perBeacon = 20,
    private readonly total = 200,
  ) {}

  add(ad: Advertisement): void {
    if (ad.rssi === null || ad.rssi < -120 || ad.rssi > 0 || this.readings.length >= this.total) return;
    const identifier = identifierOf(ad);
    if (!identifier || !this.wanted.has(identifier)) return;
    const seen = this.counts.get(identifier) ?? 0;
    if (seen >= this.perBeacon) return;
    this.counts.set(identifier, seen + 1);
    this.readings.push({ identifier, rssi: Math.round(ad.rssi) });
  }

  result(): Reading[] {
    return [...this.readings];
  }
}

/** The middle value of a beacon's readings (steadier than one reading), for the survey. */
export function medianRssi(readings: Reading[], identifier: string): number | null {
  const values = readings
    .filter((r) => r.identifier === identifier)
    .map((r) => r.rssi)
    .sort((a, b) => a - b);
  if (values.length === 0) return null;
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid]! : Math.round((values[mid - 1]! + values[mid]!) / 2);
}
