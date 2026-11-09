/**
 * Turning the university's wall-clock times (for example "Tuesday 10:00 in Africa/Accra") into exact
 * instants, which is how class times are stored. The time zone comes from settings, so this works for
 * any zone, including ones with daylight-saving changes, even though Ghana has none.
 */

/** How far ahead of UTC the zone's clocks are at a given instant, in milliseconds. */
function offsetAt(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const wallClockAsUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return wallClockAsUtc - Math.floor(instant / 1000) * 1000;
}

/** The instant at which the wall clock in `timeZone` shows `day` (YYYY-MM-DD) at `minutes` after midnight. */
export function wallClockToUtc(day: string, minutes: number, timeZone: string): Date {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const asIfUtc = Date.UTC(year, month - 1, date, 0, minutes);
  // Guess with the offset at that moment, then correct once in case the guess crossed a clock change.
  const first = asIfUtc - offsetAt(asIfUtc, timeZone);
  const second = asIfUtc - offsetAt(first, timeZone);
  return new Date(second);
}

/** The calendar day (YYYY-MM-DD) an instant falls on in `timeZone`. */
export function dayIn(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}
