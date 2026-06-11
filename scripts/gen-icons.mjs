// Generate PWA icons from scripts/icon-source.svg into public/icons/.
// Run: node scripts/gen-icons.mjs
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'scripts/icon-source.svg');
const outDir = resolve(root, 'public/icons');
await mkdir(outDir, { recursive: true });

const targets = [
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 },
  { name: 'maskable-512.png', size: 512 }, // same art; has safe padding via rounded bg
  { name: 'apple-touch-icon.png', size: 180 }, // iOS home-screen icon
];

for (const { name, size } of targets) {
  await sharp(src).resize(size, size).png().toFile(resolve(outDir, name));
  console.log('wrote', name, size);
}
console.log('Icons generated in public/icons/');
