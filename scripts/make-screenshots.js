#!/usr/bin/env node
/**
 * Captures the Chrome Web Store listing screenshots.
 *
 *   npm run screenshots
 *
 * The store accepts 1280x800 or 640x400, JPEG or 24-bit PNG with **no alpha**.
 * Both sizes are written; upload whichever you prefer (1280x800 is what the
 * listing page renders at, so it's the one to use unless a reviewer asks).
 *
 * How this is built, and why:
 *
 *   - The settings page is captured from a **real Chrome with the unpacked
 *     extension loaded**, at its natural width, on a `chrome-extension://` URL.
 *     Screenshots must show the actual product; a mock-up of the same form
 *     would be grounds for rejection, and would drift from the real page.
 *
 *   - The page's content is ~860px tall at its 520px column width, so it does
 *     not fit a 1280x800 frame one-to-one. Rather than crop off the action bar
 *     or stretch the page, the full-height capture is **scaled to fit** and
 *     centred on a backdrop, with the product name alongside. Nothing is cut
 *     off, and the aspect ratio is preserved.
 *
 *   - The output is re-encoded as 24-bit PNG by scripts/lib/png.js. Every PNG
 *     Chrome produces is 32-bit RGBA, which the store rejects outright.
 *
 * Settings shown in the shot are written to the extension's own storage first,
 * so the screenshot demonstrates the allowlist and per-domain rules rather than
 * the empty defaults — a screenshot of blank textareas says nothing about what
 * the extension does.
 */
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { decodePng, encodePng24 } from './lib/png.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXTENSION = path.join(ROOT, 'extension');
const OUT = path.join(ROOT, 'assets', 'store');

/** Store-approved listing sizes. Both are 16:10, so one composition serves both. */
const SIZES = [
  { name: 'screenshot-settings-1280x800.png', width: 1280, height: 800 },
  { name: 'screenshot-settings-640x400.png', width: 640, height: 400 },
];

/**
 * Demo settings for the shot. Chosen to show the three things the page does
 * that a description can't: a global timeout, a never-close list, and
 * per-domain overrides that beat the global value in both directions.
 */
const DEMO_SETTINGS = {
  enabled: true,
  idleMinutes: 720,
  allowlist: ['mail.google.com', '*.github.com', 'localhost'],
  rules: [
    { pattern: '*.zoom.us', minutes: 10 },
    { pattern: 'news.ycombinator.com', minutes: 60 },
    { pattern: 'docs.google.com', minutes: 2880 },
  ],
};

await fs.mkdir(OUT, { recursive: true });

const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tab-reaper-shot-'));
const context = await chromium.launchPersistentContext(profileDir, {
  // Chrome for Testing, the same build the test suite and `npm run chrome` use:
  // stable Chrome no longer accepts --load-extension.
  channel: 'chromium',
  args: [
    `--disable-extensions-except=${EXTENSION}`,
    `--load-extension=${EXTENSION}`,
    '--no-first-run',
    '--no-default-browser-check',
    // Screenshots are graded on how they look, so force the light theme rather
    // than inheriting whatever the machine running this happens to prefer.
    '--force-color-profile=srgb',
  ],
  colorScheme: 'light',
  // Capture at 2x and downscale, so text in the finished shot is crisp rather
  // than a resample of 1x pixels.
  deviceScaleFactor: 2,
});

try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;

  // Seed the demo settings through the extension's own storage, so the page
  // loads them exactly as it would for a user.
  await worker.evaluate(async (settings) => {
    await chrome.storage.sync.clear();
    await chrome.storage.sync.set(settings);
  }, DEMO_SETTINGS);

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  // The form is inert until options.js has read storage; capturing before that
  // would catch the dimmed loading state.
  await page.waitForSelector('body:not([data-loading])');

  // Fit the viewport to the content so the capture has no scrollbar and no dead
  // space, then let the sticky action bar settle at the bottom of the flow.
  const contentHeight = await page.evaluate(() => {
    document.querySelectorAll('textarea').forEach((el) => {
      // Grow each textarea to its content: a scrollbar inside the shot reads as
      // truncation, and the rules list is the interesting part.
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    });
    return Math.ceil(document.documentElement.scrollHeight);
  });
  await page.setViewportSize({ width: 640, height: contentHeight });
  await page.waitForFunction(() => document.fonts.ready.then(() => true));

  const shot = decodePng(await page.screenshot({ type: 'png' }));
  console.log(`Captured options.html at ${shot.width}x${shot.height} (2x of 640x${contentHeight}).`);

  for (const { name, width, height } of SIZES) {
    const composed = await compose(page, shot, width, height);
    const png = encodePng24(composed);
    await fs.writeFile(path.join(OUT, name), png);
    console.log(
      `${path.relative(ROOT, path.join(OUT, name))}  ${width}x${height}` +
        `  24-bit, no alpha, ${(png.length / 1024).toFixed(0)} KB`,
    );
  }
} finally {
  await context.close();
  await fs.rm(profileDir, { recursive: true, force: true });
}

console.log('\nUpload under Store listing → Screenshots in the developer console.');

/**
 * Lay the captured page onto a `width`x`height` backdrop next to the product
 * name, and return RGBA pixels.
 *
 * The composition runs on a canvas in the browser we already have open, which
 * is also what rasterizes the caption text and the source SVG icon — the same
 * approach `make-icons.js` takes, for the same reason: no image or font
 * dependency, and the result is what a browser really renders.
 */
async function compose(page, shot, width, height) {
  const icon = await fs.readFile(path.join(ROOT, 'assets', 'icon.svg'), 'utf8');

  const raw = await page.evaluate(
    async ({ shot, width, height, icon, scale }) => {
      const canvas = document.createElement('canvas');
      canvas.width = width * scale;
      canvas.height = height * scale;
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);

      // Backdrop: a soft vertical wash in the extension's own cloak colours,
      // so the shot sits in the product's palette instead of on flat white.
      const wash = ctx.createLinearGradient(0, 0, width, height);
      wash.addColorStop(0, '#2b2f45');
      wash.addColorStop(1, '#171922');
      ctx.fillStyle = wash;
      ctx.fillRect(0, 0, width, height);

      const pad = Math.round(width * 0.05);
      const textWidth = Math.round(width * 0.34);
      const paneLeft = pad + textWidth + pad;
      const paneWidth = width - paneLeft - pad;
      const paneHeight = height - pad * 2;

      // --- Caption column ---------------------------------------------------
      const iconSize = Math.round(width * 0.062);
      const iconImg = new Image();
      iconImg.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(icon)}`;
      await iconImg.decode();
      // icon.svg carries slack inside its 128 viewBox, so drawing it straight
      // leaves the mark small and sitting high and left of where it looks
      // placed. Sample only its ink — the same trim make-icons.js does for the
      // store listing icon, for the same reason.
      const ink = measureInk(iconImg);
      const iconFit = iconSize / Math.max(ink.width, ink.height);
      ctx.drawImage(
        iconImg,
        ink.x,
        ink.y,
        ink.width,
        ink.height,
        pad,
        pad + Math.round(height * 0.03),
        ink.width * iconFit,
        ink.height * iconFit,
      );

      /** Tightest box containing a non-transparent pixel. */
      function measureInk(image) {
        const probe = document.createElement('canvas');
        probe.width = image.naturalWidth;
        probe.height = image.naturalHeight;
        const pctx = probe.getContext('2d');
        pctx.drawImage(image, 0, 0);
        const px = pctx.getImageData(0, 0, probe.width, probe.height).data;
        let minX = probe.width;
        let minY = probe.height;
        let maxX = -1;
        let maxY = -1;
        for (let py = 0; py < probe.height; py += 1) {
          for (let pxx = 0; pxx < probe.width; pxx += 1) {
            if (px[(py * probe.width + pxx) * 4 + 3] === 0) continue;
            if (pxx < minX) minX = pxx;
            if (py < minY) minY = py;
            if (pxx > maxX) maxX = pxx;
            if (py > maxY) maxY = py;
          }
        }
        if (maxX < minX || maxY < minY) {
          return { x: 0, y: 0, width: probe.width, height: probe.height };
        }
        return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
      }

      const titleSize = Math.round(width * 0.042);
      const bodySize = Math.round(width * 0.019);
      let y = pad + Math.round(height * 0.03) + iconSize + Math.round(titleSize * 1.2);

      ctx.fillStyle = '#ffffff';
      ctx.font = `600 ${titleSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText('Tab Reaper', pad, y);

      y += Math.round(bodySize * 2.6);
      ctx.fillStyle = '#c9cddb';
      ctx.font = `${bodySize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      const lines = [
        'Automatically closes the tabs you',
        'stopped using — on your own timer.',
      ];
      for (const line of lines) {
        ctx.fillText(line, pad, y);
        y += Math.round(bodySize * 1.5);
      }

      y += Math.round(bodySize * 1.6);
      const bullets = [
        'One global idle timeout',
        'Per-site overrides',
        'A never-close list',
        'Pinned tabs always stay',
      ];
      ctx.font = `${bodySize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      for (const bullet of bullets) {
        ctx.fillStyle = '#7f8cb8';
        ctx.fillText('—', pad, y);
        ctx.fillStyle = '#e7eaf2';
        ctx.fillText(bullet, pad + Math.round(bodySize * 1.6), y);
        y += Math.round(bodySize * 1.9);
      }

      // --- Page pane --------------------------------------------------------
      // Scale to fit *inside* the pane, so the whole page is visible; the
      // capture is taller than it is wide, so height is the binding constraint.
      const fit = Math.min(paneWidth / shot.width, paneHeight / shot.height);
      const drawWidth = shot.width * fit;
      const drawHeight = shot.height * fit;
      const drawX = paneLeft + (paneWidth - drawWidth) / 2;
      const drawY = pad + (paneHeight - drawHeight) / 2;

      const pageImg = new Image();
      pageImg.src = shot.dataUrl;
      await pageImg.decode();

      const radius = Math.max(4, Math.round(width * 0.008));
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
      ctx.shadowBlur = Math.round(width * 0.02);
      ctx.shadowOffsetY = Math.round(width * 0.006);
      ctx.beginPath();
      ctx.roundRect(drawX, drawY, drawWidth, drawHeight, radius);
      // Fill before clipping: a shadow cast by a clipped path is clipped away
      // with it, so the drop shadow has to come from an opaque shape first.
      ctx.fillStyle = '#f6f7f9';
      ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.beginPath();
      ctx.roundRect(drawX, drawY, drawWidth, drawHeight, radius);
      ctx.clip();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(pageImg, drawX, drawY, drawWidth, drawHeight);
      ctx.restore();

      // Hairline edge, so the light page doesn't bleed into the dark backdrop.
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(drawX + 0.5, drawY + 0.5, drawWidth - 1, drawHeight - 1, radius);
      ctx.stroke();

      // Downscale the supersampled canvas to the exact output size, the same
      // supersample-then-resample trick make-icons.js uses for crisp edges.
      const final = document.createElement('canvas');
      final.width = width;
      final.height = height;
      const fctx = final.getContext('2d');
      fctx.imageSmoothingEnabled = true;
      fctx.imageSmoothingQuality = 'high';
      fctx.drawImage(canvas, 0, 0, width, height);

      const pixels = fctx.getImageData(0, 0, width, height);
      return { width, height, data: Array.from(pixels.data) };
    },
    {
      shot: { width: shot.width, height: shot.height, dataUrl: toDataUrl(shot) },
      width,
      height,
      icon,
      scale: 2,
    },
  );

  return { width: raw.width, height: raw.height, data: Buffer.from(raw.data) };
}

/** Re-wrap decoded RGBA pixels as a data URL the page can load into an <img>. */
function toDataUrl({ width, height, data }) {
  // encodePng24 is lossless for the opaque screenshot pixels it re-encodes here,
  // and lets the browser side stay a plain <img> load.
  const png = encodePng24({ width, height, data });
  return `data:image/png;base64,${png.toString('base64')}`;
}
