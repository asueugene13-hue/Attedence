import { useQuery } from '@tanstack/react-query';
import { useAuth } from './auth';

export interface ScanBeacon {
  id: string;
  identifier: string;
  protocol: 'EDDYSTONE_UID' | 'IBEACON';
  classroomId: string;
}
export interface ScanRoom {
  id: string;
  code: string;
  name: string;
}
export interface ScanList {
  data: ScanBeacon[];
  rooms: ScanRoom[];
}

/** The rooms with beacons, and the beacon identifiers this phone should listen for. */
export function useScanList() {
  const { call } = useAuth();
  return useQuery({
    queryKey: ['beacon-scan-list'],
    queryFn: () => call<ScanList>('/me/beacon-scan-list'),
    staleTime: 5 * 60_000,
  });
}

/** A short, readable name for a beacon on screen: the end of its identifier. */
export const beaconShortName = (b: ScanBeacon) => `Beacon …${b.identifier.slice(-6)}`;
