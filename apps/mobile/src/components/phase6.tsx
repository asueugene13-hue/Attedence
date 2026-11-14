import { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { qrGrid } from '../lib/attendance';
import type { Tone } from '../lib/requests';
import { useTheme } from '../lib/theme';

/** A small badge: a word and a tone, never colour alone. */
export function Pill({ label, tone }: { label: string; tone: Tone }) {
  const { palette, radius } = useTheme();
  const [bg, fg] = {
    info: [palette.primaryTint, palette.primary],
    warning: [palette.warningBg, palette.warning],
    success: [palette.successBg, palette.success],
    error: [palette.errorBg, palette.error],
    neutral: [palette.borderSubtle, palette.textSecondary],
  }[tone];
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        backgroundColor: bg,
        borderRadius: radius.badge,
        paddingHorizontal: 8,
        paddingVertical: 2,
      }}
    >
      <Text style={{ color: fg, fontSize: 12, fontWeight: '600' }}>{label}</Text>
    </View>
  );
}

/** A tappable row with a title, details and a chevron (a real button for screen readers). */
export function RowLink(props: {
  title: string;
  detail?: string;
  children?: React.ReactNode;
  onPress: () => void;
}) {
  const { palette, spacing } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.detail ? `${props.title}. ${props.detail}` : props.title}
      onPress={props.onPress}
      style={({ pressed }) => ({
        minHeight: 48,
        paddingVertical: spacing[3],
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing[3],
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={{ color: palette.textPrimary, fontWeight: '600', fontSize: 14 }}>{props.title}</Text>
        {props.detail ? (
          <Text style={{ color: palette.textSecondary, fontSize: 13 }}>{props.detail}</Text>
        ) : null}
        {props.children}
      </View>
      <Text
        style={{ color: palette.textMuted, fontSize: 18 }}
        accessibilityElementsHidden
        importantForAccessibility="no"
      >
        ›
      </Text>
    </Pressable>
  );
}

/** A QR code drawn from text (the same drawing as the attendance code). */
export function QrCode({ value, size, label }: { value: string; size: number; label: string }) {
  const grid = useMemo(() => qrGrid(value), [value]);
  const quiet = 4;
  const total = grid.size + quiet * 2;
  let path = '';
  for (let y = 0; y < grid.size; y++) {
    for (let x = 0; x < grid.size; x++) if (grid.dark(x, y)) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  }
  return (
    <View style={{ backgroundColor: '#FFFFFF', padding: 4 }}>
      <Svg width={size} height={size} viewBox={`0 0 ${total} ${total}`} accessibilityLabel={label}>
        <Path d={path} fill="#000000" />
      </Svg>
    </View>
  );
}
