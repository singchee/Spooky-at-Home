// Screenshots of the animated people through the figure lab (tools/figure-lab.html). Not a gate: it
// captures frames to look at, and fails only on page errors.
// Usage: node scripts/look-figures.mjs [--out reports/figures/after] [--port 4950] [--tilt 35] [--only poses|crowd|sim]
// Starts the Vite dev server (the lab is a dev-only page), then for each scene takes:
//  - the default view (a standing figure ~32 px tall on a 1920x1080 screen, like the 40 mm) in
//    thermal white-hot, black-hot and night vision;
//  - zoomed in (~64 px, like the 25 mm zoomed), white-hot and night vision, plus a short motion sequence.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const out = arg('--out', 'reports/figures/after');
const PORT = Number(arg('--port', 4950));
const tilt = arg('--tilt', '35');
const only = arg('--only', 'all');
mkdirSync(out, { recursive: true });

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
const ready = new Promise((res, rej) => {
  server.stdout.on('data', (d) => String(d).includes(String(PORT)) && res());
  server.on('exit', () => rej(new Error('dev server exited')));
  setTimeout(() => rej(new Error('dev server did not start')), 30000);
});

const modes = ['white', 'black', 'night'];
const shots = [];
const add = (name, params) => shots.push({ name, params: { tilt, ...params } });
if (only === 'all' || only === 'poses') {
  for (const mode of modes) add(`poses-${mode}`, { scene: 'poses', mode, px: 32 });
  for (const mode of ['white', 'black', 'night']) {
    add(`poses-zoom-zombies-a-${mode}`, { scene: 'poses', mode, px: 64, fx: -14, fz: 0 });
    add(`poses-zoom-zombies-b-${mode}`, { scene: 'poses', mode, px: 64, fx: 14, fz: 0 });
    add(`poses-zoom-survivors-${mode}`, { scene: 'poses', mode, px: 64, fx: 6, fz: 13 });
  }
  for (const t of ['2.5', '2.6', '2.7', '2.8']) add(`poses-zoom-zombies-a-white-t${t}`, { scene: 'poses', mode: 'white', px: 64, fx: -14, fz: 0, t });
  add('poses-steep-white', { scene: 'poses', mode: 'white', px: 32, tilt: '15' });
}
if (only === 'all' || only === 'crowd') {
  for (const mode of modes) add(`crowd-${mode}`, { scene: 'crowd', mode, px: 32, labels: '0' });
  for (const mode of ['white', 'night']) add(`crowd-zoom-${mode}`, { scene: 'crowd', mode, px: 64, labels: '0' });
}
if (only === 'all' || only === 'sim') {
  for (const mode of modes) add(`sim-clear-${mode}`, { scene: 'sim', mode, px: 32, t: '45', type: 'clear', seed: '7', difficulty: '3' });
  add('sim-clear-zoom-white', { scene: 'sim', mode: 'white', px: 64, t: '45', type: 'clear', seed: '7', difficulty: '3' });
  add('sim-escort-white', { scene: 'sim', mode: 'white', px: 32, t: '60', type: 'escort', seed: '7', difficulty: '3' });
  add('sim-escort-night', { scene: 'sim', mode: 'night', px: 32, t: '60', type: 'escort', seed: '7', difficulty: '3' });
}

const log = [];
let code = 0;
try {
  await ready;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  for (const s of shots) {
    const errors = [];
    const onErr = (e) => errors.push(String(e));
    const onCon = (m) => m.type() === 'error' && errors.push(m.text());
    page.on('pageerror', onErr);
    page.on('console', onCon);
    const url = `http://localhost:${PORT}/tools/figure-lab.html?${new URLSearchParams(s.params)}`;
    await page.goto(url);
    await page.waitForFunction(() => window.__lab?.ready === true, null, { timeout: 120000 }).catch((e) => errors.push(String(e)));
    const info = await page.evaluate(() => window.__lab?.info ?? null);
    const path = `${out}/${s.name}.png`;
    await page.screenshot({ path });
    page.off('pageerror', onErr);
    page.off('console', onCon);
    if (errors.length) code = 1;
    log.push({ name: s.name, path, info, errors });
    console.log(s.name, JSON.stringify(info), errors.length ? errors : '');
  }
  await browser.close();
} catch (e) {
  console.error(e);
  code = 1;
} finally {
  server.kill();
}
writeFileSync(`${out}/look.json`, JSON.stringify(log, null, 2));
process.exit(code);
