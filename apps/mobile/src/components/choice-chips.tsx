import { Pressable, Text, View } from 'react-native';
import { useTheme } from '../lib/theme';

/** Pick one of a few options, as large tappable chips (screen-reader radio buttons). */
export function ChoiceChips<T extends string>(props: {
  choices: readonly (readonly [T, string])[];
  value: T | null;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const { palette, radius } = useTheme();
  return (
    <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {props.choices.map(([value, label]) => {
        const checked = props.value === value;
        return (
          <Pressable
            key={value}
            accessibilityRole="radio"
            accessibilityState={{ checked, disabled: props.disabled }}
            accessibilityLabel={label}
            disabled={props.disabled}
            onPress={() => props.onChange(value)}
            style={{
              minHeight: 44,
              justifyContent: 'center',
              paddingHorizontal: 12,
              borderWidth: 1,
              borderRadius: radius.control,
              borderColor: checked ? palette.primary : palette.border,
              backgroundColor: checked ? palette.primaryTint : palette.surface,
              opacity: props.disabled ? 0.55 : 1,
            }}
          >
            <Text style={{ color: palette.textPrimary }}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
