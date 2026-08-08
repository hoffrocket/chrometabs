#!/usr/bin/env node
/**
 * Rasterizes assets/*.svg into the PNG sizes Chrome wants.
 *
 *   npm run icons
 *
 * Chrome does not accept SVG for extension icons, so the shipped extension
 * carries plain PNGs. Rather than add an image-processing dependency, this
 * rasterizes the SVG in the headless Chrome that the test suite already
 * uses — so the committed PNGs are exactly what a browser renders.
 *
 * Two kinds of output, and they are not interchangeable:
 *
 *   extension/icons/  Full-bleed art at 16/32/48/128px, referenced by
 *                     manifest.json. Chrome applies its own spacing when it
 *                     draws these in the toolbar and on chrome://extensions.
 *
 *   assets/store/     The Chrome Web Store *listing* icon. The store requires
 *                     128x128 total with the art inset to 96x96, leaving 16px
 *                     of transparent padding per side. Uploading full-bleed art
 *                     here gets it rejected or letterboxed by the store's own
 *                     shrink-to-fit, so the padding is baked in.
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
const STORE_OUT = path.join(ASSETS, 'store');

// Small sizes use the simplified art: the full figure is illegible at 16px.
const TARGETS = [
  { out: OUT, name: 'icon-16.png', size: 16, source: 'icon-small.svg' },
  { out: OUT, name: 'icon-32.png', size: 32, source: 'icon-small.svg' },
  { out: OUT, name: 'icon-48.png', size: 48, source: 'icon.svg' },
  { out: OUT, name: 'icon-128.png', size: 128, source: 'icon.svg' },
  // Store listing icon: 96x96 of art centred in a 128x128 transparent canvas.
  // `trim` because icon.svg has its own slack inside the 128 viewBox — without
  // it the visible mark lands around 69x90 and sits high and left of centre,
  // so the store icon would read noticeably smaller than its neighbours.
  {
    out: STORE_OUT,
    name: 'store-icon-128.png',
    size: 128,
    art: 96,
    trim: true,
    source: 'icon.svg',
  },
];

await fs.mkdir(OUT, { recursive: true });
await fs.mkdir(STORE_OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();

try {
  for (const { out, name, size, source, art = size, trim = false } of TARGETS) {
    const svg = await fs.readFile(path.join(ASSETS, source), 'utf8');

    // Rasterize the art at 4x, then downscale on a canvas. Screenshotting the
    // 4x page directly is what this script used to do, and it silently shipped
    // 512px files named icon-128.png; rasterizing straight to 16px instead
    // loses the thin strokes. Supersample-then-downscale keeps both the
    // antialiasing and the promised dimensions.
    const scale = 4;
    await page.setViewportSize({ width: art * scale, height: art * scale });
    await page.setContent(
      `<!doctype html><style>
         html,body{margin:0;padding:0;background:transparent}
         svg{display:block;width:${art * scale}px;height:${art * scale}px}
       </style>${svg}`,
    );

    const dataUrl = await page.evaluate(async ({ size, art, trim }) => {
      // Round-trip the live SVG through an <img> so the canvas draw is a plain
      // image resample rather than a second, independent SVG rasterization.
      const markup = new XMLSerializer().serializeToString(document.querySelector('svg'));
      const img = new Image();
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
      await img.decode();

      // Source rectangle to sample: the whole image, or just its ink.
      let sx = 0;
      let sy = 0;
      let sw = img.width;
      let sh = img.height;

      if (trim) {
        // Find the tightest box containing any non-transparent pixel, measured
        // on the supersampled render so a stroke a fraction of a pixel wide at
        // the final size still registers here.
        const probe = document.createElement('canvas');
        probe.width = img.width;
        probe.height = img.height;
        const pctx = probe.getContext('2d');
        pctx.drawImage(img, 0, 0);
        const px = pctx.getImageData(0, 0, probe.width, probe.height).data;

        let minX = probe.width;
        let minY = probe.height;
        let maxX = -1;
        let maxY = -1;
        for (let y = 0; y < probe.height; y++) {
          for (let x = 0; x < probe.width; x++) {
            if (px[(y * probe.width + x) * 4 + 3] === 0) continue;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }

        if (maxX >= minX && maxY >= minY) {
          sx = minX;
          sy = minY;
          sw = maxX - minX + 1;
          sh = maxY - minY + 1;
        }
      }

      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      // Fit the source box inside the art square without distorting it: the
      // longer side hits `art` exactly and the shorter one is centred, so a
      // non-square mark keeps its proportions and gains extra padding on the
      // narrow axis. Whatever is left over stays transparent.
      const fit = art / Math.max(sw, sh);
      const dw = sw * fit;
      const dh = sh * fit;
      ctx.drawImage(img, sx, sy, sw, sh, (size - dw) / 2, (size - dh) / 2, dw, dh);
      return canvas.toDataURL('image/png');
    }, { size, art, trim });

    const buffer = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
    await fs.writeFile(path.join(out, name), buffer);

    const padding = art === size ? 'full-bleed' : `${art}px art + ${(size - art) / 2}px padding`;
    const rel = path.relative(ROOT, path.join(out, name));
    console.log(`${rel}  <- ${source} @${size}px (${padding})`);
  }
} finally {
  await browser.close();
}

console.log('\nDone. Reload the extension at chrome://extensions to see the new icons.');
console.log('Store listing icon: assets/store/store-icon-128.png');
