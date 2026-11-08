import { describe, expect, it } from 'vitest';
import { colors } from './index.js';

/** WCAG relative luminance and contrast ratio. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

describe('design tokens', () => {
  it('defines the same tokens for light and dark', () => {
    expect(Object.keys(colors.dark).sort()).toEqual(Object.keys(colors.light).sort());
  });

  for (const mode of ['light', 'dark'] as const) {
    const c = colors[mode];
    it(`meets WCAG AA text contrast (4.5:1) in ${mode} mode`, () => {
      for (const text of [c.textPrimary, c.textSecondary, c.textMuted]) {
        expect(contrast(text, c.surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(text, c.background)).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(c.onPrimary, c.primary)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.success, c.successBg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.warning, c.warningBg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.error, c.errorBg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.primary, c.surface)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
