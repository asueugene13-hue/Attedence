/**
 * Timetable clash detection. Pure: it works on entries already expanded to their meeting dates.
 * Blocking clashes stop publishing; warnings are shown but do not (CLASS_LIFECYCLE.md §1).
 */

export interface ExpandedEntry {
  id: string;
  classroomId: string;
  lecturerId: string;
  sectionIds: string[];
  startMinute: number;
  endMinute: number;
  dates: string[];
}

export type BlockingKind = 'ROOM_CLASH' | 'LECTURER_CLASH' | 'SECTION_CLASH';

export interface Clash {
  kind: BlockingKind;
  entryIds: [string, string];
  /** The first date the two entries meet at overlapping times, and how many dates they collide on. */
  firstDate: string;
  dates: number;
}

export interface OverlapPair {
  entryIds: [string, string];
  firstDate: string;
  dates: number;
}

/** Every pair of entries that meet on the same date at overlapping times. */
export function overlappingPairs(entries: ExpandedEntry[]): OverlapPair[] {
  const byDate = new Map<string, ExpandedEntry[]>();
  for (const e of entries) for (const d of e.dates) byDate.set(d, [...(byDate.get(d) ?? []), e]);
  const pairs = new Map<string, OverlapPair>();
  for (const [date, list] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        if (a.startMinute >= b.endMinute || b.startMinute >= a.endMinute) continue;
        const ids = [a.id, b.id].sort() as [string, string];
        const key = ids.join('|');
        const pair = pairs.get(key);
        if (pair) pair.dates += 1;
        else pairs.set(key, { entryIds: ids, firstDate: date, dates: 1 });
      }
    }
  }
  return [...pairs.values()];
}

/** Clashes that block publishing: the same room, lecturer or section in two places at once. */
export function blockingClashes(entries: ExpandedEntry[], pairs: OverlapPair[]): Clash[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const clashes: Clash[] = [];
  for (const pair of pairs) {
    const a = byId.get(pair.entryIds[0])!;
    const b = byId.get(pair.entryIds[1])!;
    if (a.classroomId === b.classroomId) clashes.push({ kind: 'ROOM_CLASH', ...pair });
    if (a.lecturerId === b.lecturerId) clashes.push({ kind: 'LECTURER_CLASH', ...pair });
    if (a.sectionIds.some((s) => b.sectionIds.includes(s))) clashes.push({ kind: 'SECTION_CLASH', ...pair });
  }
  return clashes;
}

/** Students enrolled in sections of two overlapping entries (a warning: they cannot attend both). */
export function studentClashes(
  entries: ExpandedEntry[],
  pairs: OverlapPair[],
  enrolledBySection: Map<string, string[]>,
): (OverlapPair & { studentIds: string[] })[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const studentsOf = (e: ExpandedEntry) =>
    new Set(e.sectionIds.flatMap((s) => enrolledBySection.get(s) ?? []));
  const result: (OverlapPair & { studentIds: string[] })[] = [];
  for (const pair of pairs) {
    const a = byId.get(pair.entryIds[0])!;
    const b = byId.get(pair.entryIds[1])!;
    // A shared section is already a blocking clash; this warning is for different sections.
    if (a.sectionIds.some((s) => b.sectionIds.includes(s))) continue;
    const inA = studentsOf(a);
    const both = [...studentsOf(b)].filter((s) => inA.has(s));
    if (both.length > 0) result.push({ ...pair, studentIds: both });
  }
  return result;
}
