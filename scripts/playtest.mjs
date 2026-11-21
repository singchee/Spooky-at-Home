// Headless browser playtest (gates G7, G8 and visual evidence).
// Usage: npm run build && node scripts/playtest.mjs [--scale 1|2] [--out reports/playtest]
// Starts `vite preview`, loads each mission type with the bot playing, switches cameras,
// takes screenshots, and records console errors and draw calls. Chromium is preinstalled.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const scale = Number(arg('--scale', 1));
const out = arg('--out', 'reports/playtest');
mkdirSync(out, { recursive: true });

const PORT = 4179;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
const ready = new Promise((res, rej) => {
  server.stdout.on('data', (d) => String(d).includes(String(PORT)) && res());
  setTimeout(() => rej(new Error('preview server did not start')), 20000);
});

const results = [];
let exitCode = 0;
try {
  await ready;
  const browser = await chromium.launch();
  for (const type of ['clear', 'escort', 'defend']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: scale });
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`http://localhost:${PORT}/?autostart=1&type=${type}&difficulty=3&seed=7&bot=1`);
    await page.waitForFunction(() => window.__spooky?.ready === true, null, { timeout: 30000 });
    await page.waitForTimeout(9000); // let survivors set off and waves arrive
    const shots = {};
    await page.evaluate(() => window.__spooky.setSensor('thermal'));
    await page.waitForTimeout(1200);
    shots.thermalWhite = `${out}/${type}-thermal-white.png`;
    await page.screenshot({ path: shots.thermalWhite });
    await page.keyboard.press('h');
    await page.waitForTimeout(300);
    shots.thermalBlack = `${out}/${type}-thermal-black.png`;
    await page.screenshot({ path: shots.thermalBlack });
    await page.keyboard.press('h');
    await page.evaluate(() => window.__spooky.setSensor('night'));
    await page.waitForTimeout(1200);
    shots.night = `${out}/${type}-night-vision.png`;
    await page.screenshot({ path: shots.night });
    const state = await page.evaluate(() => window.__spooky.state());
    const info = await page.evaluate(() => window.__spooky.info());
    const fps = await page.evaluate(() => new Promise((res) => {
      let n = 0; const t0 = performance.now();
      const f = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else res(n / ((performance.now() - t0) / 1000)); };
      requestAnimationFrame(f);
    }));
    results.push({ type, errors, drawCalls: info?.drawCalls, cloudFps: Math.round(fps), t: Math.round(state?.t ?? 0), zombiesAlive: state?.zombiesAlive, survivorsAlive: state?.survivorsAlive, phase: state?.phase, shots });
    if (errors.length) exitCode = 1;
    await page.close();
  }
  // Photosensitivity: holding H (white/black-hot) must not strobe the screen.
  {
    const page = await browser.newPage({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });
    await page.goto(`http://localhost:${PORT}/?autostart=1&type=clear&difficulty=1&seed=3`);
    await page.waitForFunction(() => window.__spooky?.ready === true, null, { timeout: 30000 });
    await page.waitForTimeout(1500);
    // Sample brightness inside the page on EVERY animation frame (sampling from outside was too slow
    // to see a real strobe), while holding H with real key auto-repeat for ~2 s.
    await page.evaluate(() => {
      const c = document.querySelector('canvas');
      const g = document.createElement('canvas'); g.width = 32; g.height = 18;
      const x = g.getContext('2d', { willReadFrequently: true });
      window.__fs = []; window.__fsStop = false;
      const loop = () => {
        x.drawImage(c, 0, 0, 32, 18);
        const d = x.getImageData(0, 0, 32, 18).data; let s = 0;
        for (let i = 0; i < d.length; i += 4) s += d[i];
        window.__fs.push([performance.now(), s / (d.length / 4)]);
        if (!window.__fsStop) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 2000) { await page.keyboard.down('h'); await page.waitForTimeout(33); }
    await page.keyboard.up('h');
    const frames = await page.evaluate(() => { window.__fsStop = true; return window.__fs; });
    const samples = frames.map((f) => f[1]);
    const secs = (frames[frames.length - 1][0] - frames[0][0]) / 1000;
    // A flash = a brightness swing of > 25 (of 255) that reverses direction (WCAG: pairs of opposing changes).
    let reversals = 0;
    let lastDir = 0;
    let anchor = samples[0];
    for (const v of samples) {
      const d = v - anchor;
      if (Math.abs(d) < 25) continue;
      const dir = Math.sign(d);
      if (lastDir && dir !== lastDir) reversals++;
      lastDir = dir;
      anchor = v;
    }
    const flashesPerSec = reversals / 2 / Math.max(0.5, secs);
    const ok = flashesPerSec <= 3;
    results.push({ type: 'photosensitivity: hold H for 2 s (auto-repeat)', ok, flashesPerSec: Number(flashesPerSec.toFixed(2)), frames: samples.length, errors: ok ? [] : [`screen flashes ${flashesPerSec.toFixed(1)}/s while H is held (limit 3)`] });
    if (!ok) exitCode = 1;
    await page.close();
  }
  // Draw-call budget (G8)
  for (const r of results) if (r.drawCalls > 150) { r.errors.push(`draw calls ${r.drawCalls} > 150`); exitCode = 1; }
  // Menu renders and has no errors
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: scale });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('.menu h1');
  await page.screenshot({ path: `${out}/menu-phone.png` });
  results.push({ type: 'menu (phone width)', errors, shots: { menu: `${out}/menu-phone.png` } });
  if (errors.length) exitCode = 1;
  await browser.close();
} catch (e) {
  console.error(e);
  exitCode = 1;
} finally {
  server.kill();
}
writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results.map(({ shots, ...r }) => r), null, 1));
process.exit(exitCode);
