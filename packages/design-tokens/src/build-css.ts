import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { colors, radius, spacing, typography } from './index.js';

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function colorVars(palette: Record<string, string>): string {
  return Object.entries(palette)
    .map(([name, value]) => `  --color-${kebab(name)}: ${value};`)
    .join('\n');
}

/** Builds tokens.css: light values on :root, dark values when the system asks for dark mode. */
export function buildCss(): string {
  const other = [
    `  --font-family: ${typography.fontFamily};`,
    ...Object.entries(spacing).map(([k, v]) => `  --space-${k}: ${v}px;`),
    ...Object.entries(radius).map(([k, v]) => `  --radius-${kebab(k)}: ${v}px;`),
  ].join('\n');
  return [
    '/* Generated from packages/design-tokens/src/index.ts. Do not edit by hand. */',
    `:root {\n  color-scheme: light dark;\n${colorVars(colors.light)}\n${other}\n}`,
    `@media (prefers-color-scheme: dark) {\n  :root {\n${colorVars(colors.dark).replace(/^/gm, '  ')}\n  }\n}`,
    '',
  ].join('\n\n');
}

const outDir = fileURLToPath(new URL('.', import.meta.url));
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}tokens.css`, buildCss());
