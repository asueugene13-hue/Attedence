import {
  fromBase64,
  identifierOf,
  medianRssi,
  parseEddystoneUid,
  parseIBeacon,
  ReadingCollector,
} from './beacon-frames';

// Made-up beacons: identifiers are obviously fake test values.
const bytes = (...parts: (number[] | string)[]) =>
  Uint8Array.from(
    parts.flatMap((p) => (typeof p === 'string' ? (p.match(/../g) ?? []).map((h) => parseInt(h, 16)) : p)),
  );
const toB64 = (b: Uint8Array) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i]! << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += chars[(n >> 18) & 63]! + chars[(n >> 12) & 63]!;
    out += i + 1 < b.length ? chars[(n >> 6) & 63]! : '=';
    out += i + 2 < b.length ? chars[n & 63]! : '=';
  }
  return out;
};

const NAMESPACE = '0123456789abcdef0123';
const INSTANCE = '456789abcd01';
const eddystone = bytes([0x00, 0xee], NAMESPACE, INSTANCE, [0, 0]);
const ibeacon = bytes(
  [0x4c, 0x00, 0x02, 0x15],
  '00000000111122223333444444444444',
  [0x01, 0x02, 0x00, 0x07, 0xc5],
);

describe('beacon frames', () => {
  it('decodes base64 of every length', () => {
    for (const length of [0, 1, 2, 3, 4, 17, 18, 25]) {
      const data = Uint8Array.from({ length }, (_, i) => (i * 37 + 11) % 256);
      expect([...fromBase64(toB64(data))]).toEqual([...data]);
    }
  });

  it('reads an Eddystone-UID frame as namespace + instance', () => {
    expect(parseEddystoneUid(eddystone)).toBe(NAMESPACE + INSTANCE);
    // Other Eddystone frames (URL 0x10, TLM 0x20, EID 0x30) and short frames are not UIDs.
    expect(parseEddystoneUid(bytes([0x10, 0xee], NAMESPACE, INSTANCE))).toBeNull();
    expect(parseEddystoneUid(eddystone.slice(0, 10))).toBeNull();
  });

  it('reads an iBeacon frame as uuid:major:minor', () => {
    expect(parseIBeacon(ibeacon)).toBe('00000000-1111-2222-3333-444444444444:258:7');
    expect(parseIBeacon(bytes([0x06, 0x00, 0x02, 0x15], '00'.repeat(21)))).toBeNull(); // not Apple
  });

  it('finds the identifier in service data or manufacturer data', () => {
    expect(
      identifierOf({
        rssi: -60,
        serviceData: { '0000FEAA-0000-1000-8000-00805F9B34FB': toB64(eddystone) },
        manufacturerData: null,
      }),
    ).toBe(NAMESPACE + INSTANCE);
    expect(identifierOf({ rssi: -60, serviceData: null, manufacturerData: toB64(ibeacon) })).toMatch(
      /:258:7$/,
    );
    expect(identifierOf({ rssi: -60, serviceData: { '180f': 'AA==' }, manufacturerData: null })).toBeNull();
  });

  it('keeps only listed beacons, with a cap per beacon and overall', () => {
    const id = NAMESPACE + INSTANCE;
    const collector = new ReadingCollector(new Set([id]), 3, 200);
    const ad = (rssi: number | null, data = eddystone) => ({
      rssi,
      serviceData: { feaa: toB64(data) },
      manufacturerData: null,
    });
    collector.add(ad(-70, bytes([0x00, 0xee], 'ffffffffffffffffffffffffffffffff'))); // not on the list
    collector.add(ad(null));
    collector.add(ad(5)); // impossible strength
    for (const rssi of [-61, -65, -63, -90]) collector.add(ad(rssi));
    expect(collector.result()).toEqual([
      { identifier: id, rssi: -61 },
      { identifier: id, rssi: -65 },
      { identifier: id, rssi: -63 },
    ]);
    expect(medianRssi(collector.result(), id)).toBe(-63);
    expect(medianRssi([], id)).toBeNull();
  });
});
