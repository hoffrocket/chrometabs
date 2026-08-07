#!/usr/bin/env node
/**
 * Rasterizes assets/*.svg into the PNG sizes Chrome wants.
 *
 *   npm run icons
 *
 * Chrome does not accept SVG for extension icons, so the shipped extension
 * carries plain PNGs. Rather than add an image-processing dependency, this
 * screenshots the SVG in the headless Chrome that the test suite already
 * uses — so the committed PNGs are exactly what a browser renders.
 *
 * Re-run this after editing the source art, and commit the resulting PNGs.
 */
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ASSETS = path.join(ROOT, 'assets');
const OUT = path.join(ROOT, 'extension', 'icons');

// Small sizes use the simplified art: the full figure is illegible at 16px.
const TARGETS = [
  { size: 16, source: 'icon-small.svg' },
  { size: 32, source: 'icon-small.svg' },
  { size: 48, source: 'icon.svg' },
  { size: 128, source: 'icon.svg' },
];

await fs.mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();

try {
  for (const { size, source } of TARGETS) {
    const svg = await fs.readFile(path.join(ASSETS, source), 'utf8');

    // Render at 4x and let Chrome downscale, which antialiases the curves far
    // better than rasterizing straight to 16px.
    const scale = 4;
    await page.setViewportSize({ width: size * scale, height: size * scale });
    await page.setContent(
      `<!doctype html><style>
         html,body{margin:0;padding:0;background:transparent}
         svg{display:block;width:${size * scale}px;height:${size * scale}px}
       </style>${svg}`,
    );

    const buffer = await page.screenshot({ omitBackground: true });
    const target = path.join(OUT, `icon-${size}.png`);
    await fs.writeFile(target, buffer);
    console.log(`icons/icon-${size}.png  <- ${source} @${size * scale}px`);
  }
} finally {
  await browser.close();
}

console.log('\nDone. Reload the extension at chrome://extensions to see the new icons.');
