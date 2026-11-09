import { Pressable, Text, View } from 'react-native';
import { type ClassSession, classLabel, classTimes, STATUS_LABELS } from '../lib/classes';
import { textStyle, useTheme } from '../lib/theme';

const WARN = ['POSTPONED', 'UNCONFIRMED', 'INTERRUPTED', 'SUSPENDED'];
const BAD = ['UNDER_REVIEW', 'CANCELLED'];

export function StatusPill({ status }: { status: ClassSession['status'] }) {
  const { palette, radius } = useTheme();
  const [bg, fg] = BAD.includes(status)
    ? [palette.errorBg, palette.error]
    : WARN.includes(status)
      ? [palette.warningBg, palette.warning]
      : status === 'ACTIVE' || status === 'COMPLETED'
        ? [palette.successBg, palette.success]
        : [palette.primaryTint, palette.primary];
  return (
    <View
      style={{ backgroundColor: bg, borderRadius: radius.control, paddingHorizontal: 8, paddingVertical: 2 }}
    >
      <Text style={{ color: fg, fontSize: 12, fontWeight: '600' }}>{STATUS_LABELS[status]}</Text>
    </View>
  );
}

/** One class in a list: what, when, where, and its status. Tapping opens it. */
export function ClassCard({ session, onPress }: { session: ClassSession; onPress: () => void }) {
  const { palette, radius, spacing, typography } = useTheme();
  const cancelled = session.status === 'CANCELLED' || session.status === 'RESCHEDULED';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${classLabel(session)}, ${classTimes(session)}, ${STATUS_LABELS[session.status]}`}
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: pressed ? palette.background : palette.surface,
        borderColor: palette.border,
        borderWidth: 1,
        borderRadius: radius.card,
        padding: spacing[4],
        gap: 6,
        opacity: cancelled ? 0.75 : 1,
      })}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <Text style={[textStyle(typography.label), { color: palette.textPrimary, flexShrink: 1 }]}>
          {classLabel(session)}
        </Text>
        <StatusPill status={session.status} />
      </View>
      <Text style={[textStyle(typography.body), { color: palette.textSecondary }]}>
        {classTimes(session)}
        {session.classroom ? ` · ${session.classroom.code}` : ''}
      </Text>
      {session.sections[0] ? (
        <Text style={{ color: palette.textMuted, fontSize: 13 }}>{session.sections[0].course.title}</Text>
      ) : null}
    </Pressable>
  );
}
