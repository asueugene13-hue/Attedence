/**
 * AttendSure design tokens, v0.1 (proposed), from the design canvas "AttendSure UI — Knutsford University".
 * The navy primary is a placeholder until Knutsford supplies its brand colours (decision D-15): change the
 * values here and both the web dashboard and the mobile app follow.
 */

export const colors = {
  light: {
    primary: '#1F4B8F',
    primaryHover: '#183C74',
    primaryPressed: '#12305E',
    primaryTint: '#E9EFF8',
    onPrimary: '#FFFFFF',
    secondary: '#2B3442',
    background: '#F5F6F8',
    surface: '#FFFFFF',
    border: '#DDE1E7',
    borderSubtle: '#EEF0F3',
    textPrimary: '#131820',
    textSecondary: '#465061',
    textMuted: '#5F6878',
    success: '#12704A',
    successBg: '#E6F3EC',
    warningFill: '#D98A16',
    warning: '#8F5300',
    warningBg: '#FDF2E1',
    error: '#B3261E',
    errorBg: '#FBEAE8',
    errorBorder: '#E8B4AF',
    focusRing: '#1F4B8F',
  },
  dark: {
    primary: '#7FA6E6',
    primaryHover: '#9BBAEC',
    primaryPressed: '#6A93D8',
    primaryTint: '#1B2A44',
    onPrimary: '#0D1117',
    secondary: '#C9D1DC',
    background: '#0D1117',
    surface: '#141A22',
    border: '#2A3340',
    borderSubtle: '#1F2630',
    textPrimary: '#E8ECF1',
    textSecondary: '#B4BDC9',
    textMuted: '#97A1AE',
    success: '#5BC48F',
    successBg: '#12291F',
    warningFill: '#E5A54B',
    warning: '#E5A54B',
    warningBg: '#2B2112',
    error: '#EF7B70',
    errorBg: '#2E1715',
    errorBorder: '#6B2E29',
    focusRing: '#7FA6E6',
  },
} as const;

export type ColorToken = keyof (typeof colors)['light'];

export const typography = {
  fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif",
  /** [size px, line-height px, weight] — mobile first; web sizes where the canvas gives one. */
  display: [28, 36, 600],
  screenHeading: [24, 32, 600],
  sectionHeading: [16, 24, 600],
  cardHeading: [15, 22, 600],
  body: [14, 20, 400],
  secondary: [13, 18, 400],
  label: [13, 16, 500],
  caption: [12, 16, 600],
  button: [14, 20, 600],
} as const;

/** 4 px grid. */
export const spacing = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48 } as const;

export const radius = { badge: 4, control: 6, card: 8, sheet: 12 } as const;

export const sizes = { controlWeb: 40, controlMobile: 48, controlCompact: 32, touchTarget: 44 } as const;
