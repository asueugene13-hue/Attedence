import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { textStyle, useTheme } from '../lib/theme';

// A date chosen from a month calendar, drawn in plain React Native (no native module, so no new app build).
// Days are "YYYY-MM-DD" strings, worked out in UTC so the phone's own time zone never shifts them.

const pad = (n: number) => String(n).padStart(2, '0');
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;
// Names are spelled out here rather than by Intl, whose wording differs between phones' JavaScript engines.
const parts = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`);
  return {
    weekday: DAY_NAMES[d.getUTCDay()]!,
    date: d.getUTCDate(),
    month: MONTH_NAMES[d.getUTCMonth()]!,
    year: d.getUTCFullYear(),
  };
};

/** "Tuesday 20 August 2030": what a screen reader says for a day. */
export function longDay(day: string) {
  const p = parts(day);
  return `${p.weekday} ${p.date} ${p.month} ${p.year}`;
}
/** "Tue 20 Aug 2030": what the field shows. */
export function shortDay(day: string) {
  const p = parts(day);
  return `${p.weekday.slice(0, 3)} ${p.date} ${p.month.slice(0, 3)} ${p.year}`;
}

/** One month's days, Monday first, with empty cells (null) before the 1st and after the last day. */
export function monthGrid(year: number, month: number): (string | null)[] {
  const lead = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= days; d++) cells.push(`${year}-${pad(month + 1)}-${pad(d)}`);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

const monthOf = (day: string) => ({ year: Number(day.slice(0, 4)), month: Number(day.slice(5, 7)) - 1 });

/** Pick a day from a calendar. `min` and `max` (inclusive) limit the days that can be chosen. */
export function DateField(props: {
  label: string;
  value: string;
  onChange: (day: string) => void;
  min?: string;
  max?: string;
}) {
  const { palette, radius, typography, spacing } = useTheme();
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(() => monthOf(props.value));
  const allowed = (day: string) => (!props.min || day >= props.min) && (!props.max || day <= props.max);
  const step = (by: number) =>
    setShown(({ year, month }) => {
      const m = month + by;
      return { year: year + Math.floor(m / 12), month: ((m % 12) + 12) % 12 };
    });
  const cells = monthGrid(shown.year, shown.month);
  const title = `${MONTH_NAMES[shown.month]} ${shown.year}`;
  const arrow = (label: string, glyph: string, by: number) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => step(by)}
      style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
    >
      <Text style={{ fontSize: 22, color: palette.primary }}>{glyph}</Text>
    </Pressable>
  );

  return (
    <View style={{ gap: 6 }}>
      <Text style={[textStyle(typography.label), { color: palette.textPrimary }]}>{props.label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${props.label}: ${longDay(props.value)}`}
        accessibilityHint={open ? 'Closes the calendar' : 'Opens a calendar to choose the day'}
        accessibilityState={{ expanded: open }}
        onPress={() => {
          setShown(monthOf(props.value));
          setOpen((o) => !o);
        }}
        style={{
          minHeight: 48,
          justifyContent: 'center',
          paddingHorizontal: spacing[3],
          borderWidth: 1,
          borderRadius: radius.control,
          borderColor: open ? palette.primary : palette.border,
          backgroundColor: palette.surface,
        }}
      >
        <Text style={[textStyle(typography.body), { color: palette.textPrimary }]}>
          {shortDay(props.value)}
        </Text>
      </Pressable>
      {open ? (
        <View
          style={{
            borderWidth: 1,
            borderColor: palette.border,
            borderRadius: radius.control,
            backgroundColor: palette.surface,
            padding: 4,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            {arrow('Previous month', '‹', -1)}
            <Text
              accessibilityRole="header"
              style={[textStyle(typography.label), { color: palette.textPrimary }]}
            >
              {title}
            </Text>
            {arrow('Next month', '›', 1)}
          </View>
          <View style={{ flexDirection: 'row' }}>
            {WEEKDAYS.map((w) => (
              <Text
                key={w}
                importantForAccessibility="no"
                style={{ flex: 1, textAlign: 'center', fontSize: 12, color: palette.textMuted }}
              >
                {w}
              </Text>
            ))}
          </View>
          {Array.from({ length: cells.length / 7 }, (_, row) => (
            <View key={row} style={{ flexDirection: 'row' }}>
              {cells.slice(row * 7, row * 7 + 7).map((day, i) => {
                if (!day) return <View key={`empty-${i}`} style={{ flex: 1, minHeight: 44 }} />;
                const selected = day === props.value;
                const enabled = allowed(day);
                return (
                  <Pressable
                    key={day}
                    accessibilityRole="button"
                    accessibilityLabel={longDay(day)}
                    accessibilityState={{ selected, disabled: !enabled }}
                    disabled={!enabled}
                    onPress={() => {
                      props.onChange(day);
                      setOpen(false);
                    }}
                    style={{
                      flex: 1,
                      minHeight: 44,
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: radius.control,
                      backgroundColor: selected ? palette.primary : 'transparent',
                    }}
                  >
                    <Text
                      style={{
                        color: selected
                          ? palette.onPrimary
                          : enabled
                            ? palette.textPrimary
                            : palette.textMuted,
                        opacity: enabled ? 1 : 0.45,
                      }}
                    >
                      {Number(day.slice(8))}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
