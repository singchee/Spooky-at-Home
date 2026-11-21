// Visual check for animated figures and explosions (W3). Not a gate: it captures frames to look at.
// Usage: npm run build && node scripts/look-visuals.mjs [--out reports/w3-look] [--port 4194] [--only figures|blasts]
// 1. Blasts: the bot-played clear mission (difficulty 3, seed 7) early on, while the horde is still
//    being shelled; frame sequences in thermal white-hot, black-hot and night vision.
// 2. Figures: the 25 mm zoomed in (narrowest view) on the action, a frame sequence over ~2 s to judge
//    motion, in thermal then night vision. Escort by default, because its zombies chase the survivors
//    the bot camera follows.
// The cloud renders WebGL in software at ~10 fps, so judge motion from the sequence, not one frame.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const out = arg('--out', 'reports/w3-look');
const PORT = Number(arg('--port', 4194));
const only = arg('--only', 'all');
const blastUrl = arg('--blast-url', '/?autostart=1&type=clear&difficulty=3&seed=7&bot=1');
const figureUrl = arg('--figure-url', '/?autostart=1&type=escort&difficulty=3&seed=7&bot=1');
mkdirSync(out, { recursive: true });

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
const ready = new Promise((res, rej) => {
  server.stdout.on('data', (d) => String(d).includes(String(PORT)) && res());
  setTimeout(() => rej(new Error('preview server did not start')), 20000);
});

const log = [];
let code = 0;
try {
  await ready;
  const browser = await chromium.launch();
  const open = async (url, wait) => {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`http://localhost:${PORT}${url}`);
    await page.waitForFunction(() => window.__spooky?.ready === true, null, { timeout: 30000 });
    await page.waitForTimeout(wait);
    return { page, errors };
  };
  const seq = async (page, name, n, gap) => {
    for (let i = 0; i < n; i++) {
      await page.screenshot({ path: `${out}/${name}-${String(i).padStart(2, '0')}.png` });
      if (gap) await page.waitForTimeout(gap);
    }
  };
  const finish = async (name, page, errors) => {
    const info = await page.evaluate(() => window.__spooky.info());
    const state = await page.evaluate(() => window.__spooky.state());
    log.push({ name, info, t: state?.t, zombiesAlive: state?.zombiesAlive, kills: state?.kills, errors });
    if (errors.length) code = 1;
    await page.close();
  };
  if (only === 'all' || only === 'blasts') {
    const { page, errors } = await open(blastUrl, Number(arg('--blast-wait', 2500)));
    await page.keyboard.press('2'); // 40 mm view: medium field of view
    await page.evaluate(() => window.__spooky.setSensor('thermal'));
    await page.waitForTimeout(900);
    await seq(page, 'blast-thermal-white', 10, 100);
    await page.keyboard.press('h');
    await page.waitForTimeout(400);
    await seq(page, 'blast-thermal-black', 8, 100);
    await page.keyboard.press('h');
    await page.evaluate(() => window.__spooky.setSensor('night'));
    await page.waitForTimeout(900);
    await seq(page, 'blast-night', 10, 100);
    await finish('blasts', page, errors);
  }
  if (only === 'all' || only === 'figures') {
    const { page, errors } = await open(figureUrl, Number(arg('--figure-wait', 9000)));
    await page.keyboard.press(arg('--figure-gun', '1')); // default 25 mm: narrowest view
    await page.keyboard.press('z');
    await page.evaluate(() => window.__spooky.setSensor('thermal'));
    await page.waitForTimeout(1200);
    await seq(page, 'figures-thermal', 14, 60);
    await page.evaluate(() => window.__spooky.setSensor('night'));
    await page.waitForTimeout(1200);
    await seq(page, 'figures-night', 8, 60);
    await finish('figures', page, errors);
  }
  await browser.close();
} catch (e) {
  console.error(e);
  code = 1;
} finally {
  server.kill();
}
writeFileSync(`${out}/look.json`, JSON.stringify(log, null, 2));
console.log(JSON.stringify(log, null, 1));
process.exit(code);
