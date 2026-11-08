import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { textStyle, useTheme } from '../lib/theme';

export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  const { palette, spacing } = useTheme();
  const body = <View style={{ padding: spacing[5], gap: spacing[6] }}>{children}</View>;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.background }} edges={['top', 'left', 'right']}>
      {scroll ? <ScrollView keyboardShouldPersistTaps="handled">{body}</ScrollView> : body}
    </SafeAreaView>
  );
}

export function Heading({ children, subtitle }: { children: string; subtitle?: string }) {
  const { palette, typography } = useTheme();
  return (
    <View style={{ gap: 4 }}>
      <Text
        accessibilityRole="header"
        style={[textStyle(typography.screenHeading), { color: palette.textPrimary }]}
      >
        {children}
      </Text>
      {subtitle ? (
        <Text style={[textStyle(typography.body), { color: palette.textSecondary }]}>{subtitle}</Text>
      ) : null}
    </View>
  );
}

export function BodyText({ children, muted }: { children: ReactNode; muted?: boolean }) {
  const { palette, typography } = useTheme();
  return (
    <Text style={[textStyle(typography.body), { color: muted ? palette.textMuted : palette.textSecondary }]}>
      {children}
    </Text>
  );
}

export function Button(props: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary';
  busy?: boolean;
  disabled?: boolean;
}) {
  const { palette, radius, typography, spacing } = useTheme();
  const primary = (props.variant ?? 'primary') === 'primary';
  const disabled = props.disabled || props.busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled, busy: props.busy }}
      disabled={disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.button,
        {
          minHeight: 48,
          paddingHorizontal: spacing[4],
          borderRadius: radius.control,
          backgroundColor: primary ? (pressed ? palette.primaryPressed : palette.primary) : palette.surface,
          borderColor: primary ? 'transparent' : palette.border,
          opacity: disabled ? 0.55 : 1,
        },
      ]}
    >
      {props.busy ? (
        <ActivityIndicator color={primary ? palette.onPrimary : palette.primary} />
      ) : (
        <Text
          style={[textStyle(typography.button), { color: primary ? palette.onPrimary : palette.textPrimary }]}
        >
          {props.label}
        </Text>
      )}
    </Pressable>
  );
}

export function TextField(props: TextInputProps & { label: string; error?: string }) {
  const { palette, radius, typography, spacing } = useTheme();
  const { label, error, ...input } = props;
  return (
    <View style={{ gap: 6 }}>
      <Text style={[textStyle(typography.label), { color: palette.textPrimary }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={palette.textMuted}
        style={[
          textStyle(typography.body),
          {
            minHeight: 48,
            paddingHorizontal: spacing[3],
            borderWidth: 1,
            borderRadius: radius.control,
            borderColor: error ? palette.error : palette.border,
            backgroundColor: palette.surface,
            color: palette.textPrimary,
          },
        ]}
        {...input}
      />
      {error ? <Text style={{ color: palette.error, fontSize: 12 }}>{error}</Text> : null}
    </View>
  );
}

export function Notice({ tone, children }: { tone: 'info' | 'error' | 'success'; children: ReactNode }) {
  const { palette, radius, spacing } = useTheme();
  const colors = {
    info: [palette.primaryTint, palette.primary],
    error: [palette.errorBg, palette.error],
    success: [palette.successBg, palette.success],
  }[tone];
  return (
    <View
      accessibilityRole={tone === 'error' ? 'alert' : 'summary'}
      style={{ backgroundColor: colors[0], padding: spacing[3], borderRadius: radius.control }}
    >
      <Text style={{ color: colors[1], fontSize: 13, lineHeight: 18 }}>{children}</Text>
    </View>
  );
}

export function Card({ children }: { children: ReactNode }) {
  const { palette, radius, spacing } = useTheme();
  return (
    <View
      style={{
        backgroundColor: palette.surface,
        borderColor: palette.border,
        borderWidth: 1,
        borderRadius: radius.card,
        padding: spacing[4],
        gap: spacing[3],
      }}
    >
      {children}
    </View>
  );
}

export function Brand() {
  const { palette } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <View style={[styles.brandMark, { backgroundColor: palette.primary }]}>
        <Text style={{ color: palette.onPrimary, fontWeight: '700' }}>✓</Text>
      </View>
      <View>
        <Text style={{ color: palette.textPrimary, fontWeight: '600', fontSize: 15 }}>AttendSure</Text>
        <Text style={{ color: palette.textMuted, fontSize: 12 }}>Knutsford University</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  button: { alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  brandMark: { width: 32, height: 32, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
});
