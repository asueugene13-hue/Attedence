// Renders the phone app icons from assets/brand/app-icon.svg (the master):
//   assets/brand/icon.png           1024 px, full navy square (iOS and Expo's default icon; no transparency)
//   assets/brand/adaptive-icon.png  1024 px Android adaptive foreground: the shield only, transparent, sized so
//                                    every launcher mask (circle, squircle, rounded square) leaves it whole
// Run from the repository root:  node apps/mobile/scripts/make-app-icon.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const brand = fileURLToPath(new URL('../assets/brand/', import.meta.url));
const master = readFileSync(`${brand}app-icon.svg`, 'utf8');

// 1. The full icon.
await sharp(Buffer.from(master))
  .resize(1024, 1024)
  .flatten({ background: '#142F5C' })
  .png()
  .toFile(`${brand}icon.png`);

// 2. The Android foreground. Android shows the middle 72 of the 108 units and masks it; the design's 180-unit
//    icon is mapped onto those 72 units (scale 0.4 of 180 → 72) and centred on the 108-unit canvas.
const mark = master.match(/<g id="mark">[\s\S]*?<\/g>/)[0];
const foreground = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="1024" height="1024">
  <g transform="translate(18 18) scale(0.4)">${mark}</g>
</svg>`;
await sharp(Buffer.from(foreground)).resize(1024, 1024).png().toFile(`${brand}adaptive-icon.png`);

console.warn('Wrote icon.png and adaptive-icon.png from app-icon.svg');
