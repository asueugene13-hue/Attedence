import { colors, radius, spacing, typography } from '@attendsure/design-tokens';
import { useColorScheme } from 'react-native';

export type Palette = (typeof colors)['light'] | (typeof colors)['dark'];

/** The same tokens as the web dashboard, following the phone's light or dark setting. */
export function useTheme() {
  const scheme = useColorScheme();
  const palette: Palette = scheme === 'dark' ? colors.dark : colors.light;
  return { palette, spacing, radius, typography, dark: scheme === 'dark' };
}

/** [size, lineHeight, weight] token → React Native text style. */
export function textStyle(token: readonly [number, number, number]) {
  const [fontSize, lineHeight, weight] = token;
  return { fontSize, lineHeight, fontWeight: String(weight) as '400' | '500' | '600' };
}
