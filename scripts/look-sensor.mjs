// Visual check for the sensor picture (camera, post-processing, ground texture). Not a gate: it
// captures frames to look at, plus draw calls and the cloud frame rate.
// Usage: npm run build && node scripts/look-sensor.mjs [--out reports/sensor-look] [--port 4945] [--dist dist]
// For each screen (1280 x 800 desktop, 1340 x 800 tablet at 2x), the bot-played escort mission
// (difficulty 3, seed 7: survivors with zombies chasing them, some cold-blooded) is shot at the
// default gun's view in white-hot, black-hot and night vision, then through the zoomed-in 25 mm.
// Then the camera is put on a cold-blooded zombie (test hook) to check it still vanishes on grass
// and shows on roads in thermal.
// The cloud renders WebGL in software, so the frame rate is only comparable with other cloud runs.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const out = arg('--out', 'reports/sensor-look');
const PORT = Number(arg('--port', 4945));
const dist = arg('--dist', 'dist');
const url = arg('--url', '/?autostart=1&type=escort&difficulty=3&seed=7&bot=1');
const only = arg('--only', 'all');
// Cold-blooded zombies: a clear mission without the bot (its hordes wait in parks and gardens, on grass).
const coldUrl = arg('--cold-url', '/?autostart=1&type=clear&difficulty=3&seed=7');
mkdirSync(out, { recursive: true });

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort', '--outDir', dist], { stdio: 'pipe' });
const ready = new Promise((res, rej) => {
  server.stdout.on('data', (d) => String(d).includes(String(PORT)) && res());
  setTimeout(() => rej(new Error('preview server did not start')), 60000);
});

const screens = [
  ['desktop', { width: 1280, height: 800 }, 1],
  ['tablet', { width: 1340, height: 800 }, 2],
];
const log = [];
let code = 0;
try {
  await ready;
  const browser = await chromium.launch();
  for (const [name, viewport, dpr] of screens) {
    if (only !== 'all' && only !== name) continue;
    const page = await browser.newPage({ viewport, deviceScaleFactor: dpr });
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`http://localhost:${PORT}${url}`);
    await page.waitForFunction(() => window.__spooky?.ready === true, null, { timeout: 120000 });
    // Waits are in game time: the cloud renders slowly, and the game clock only advances per frame.
    const gt = () => page.evaluate(() => window.__spooky.state().t);
    const wait = async (s) => { const t = await gt(); await page.waitForFunction((tt) => window.__spooky.state().t >= tt, t + s, { timeout: 240000, polling: 100 }); };
    await page.waitForFunction(() => window.__spooky.state().t >= 9, null, { timeout: 1200000, polling: 200 });
    const shot = async (n) => page.screenshot({ path: `${out}/${name}-${n}.png` });
    await page.evaluate(() => window.__spooky.setSensor('thermal'));
    await wait(1.2);
    await shot('default-white-hot');
    await page.keyboard.press('h');
    await wait(0.6);
    await shot('default-black-hot');
    await page.keyboard.press('h');
    await page.evaluate(() => window.__spooky.setSensor('night'));
    await wait(1.2);
    await shot('default-night');
    const fps = await page.evaluate(() => new Promise((res) => {
      let n = 0; const t0 = performance.now();
      const f = () => { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(f); else res(n / ((performance.now() - t0) / 1000)); };
      requestAnimationFrame(f);
    }));
    const info = await page.evaluate(() => window.__spooky.info());
    // Rounds in flight: the 25 mm firing, white-hot. Tracers should come in from off screen.
    await page.evaluate(() => window.__spooky.setSensor('thermal'));
    await page.keyboard.press('1');
    await wait(1.0);
    await page.evaluate(() => window.__spooky.holdFire(true));
    await wait(0.5);
    await shot('25-firing-white-hot');
    await page.evaluate(() => window.__spooky.holdFire(false));
    await page.keyboard.press('z');
    await page.evaluate(() => window.__spooky.setSensor('thermal'));
    await wait(1.2);
    await shot('25z-white-hot');
    await page.evaluate(() => window.__spooky.setSensor('night'));
    await wait(1.2);
    await shot('25z-night');
    // A cold-blooded zombie through the zoomed 25 mm, white-hot and night vision. Without the bot (its
    // camera follows the survivors), aimed with the test hook at the nearest cold one.
    let cold = null;
    await page.close();
    {
      const p2 = await browser.newPage({ viewport, deviceScaleFactor: dpr });
      p2.on('pageerror', (e) => errors.push(String(e)));
      await p2.goto(`http://localhost:${PORT}${coldUrl}`);
      await p2.waitForFunction(() => window.__spooky?.ready === true, null, { timeout: 120000 });
      await p2.waitForFunction(() => (window.__spooky.zombies?.() ?? []).some((z) => z.cold) && window.__spooky.state().t > 3, null, { timeout: 1200000, polling: 250 });
      await p2.keyboard.press('1');
      await p2.keyboard.press('z');
      const follow = () => p2.evaluate(() => {
        const z = (window.__spooky.zombies?.() ?? []).find((q) => q.cold);
        if (z) window.__spooky.aimAt(z.x, z.z);
        return z ?? null;
      });
      await p2.evaluate(() => window.__spooky.fixedStep(0));
      const t0 = await p2.evaluate(() => window.__spooky.state().t);
      cold = await follow();
      await p2.waitForTimeout(1500);
      await p2.addStyleTag({ content: '.hud-cross, .hud-markers { display: none !important }' });
      await p2.screenshot({ path: `${out}/${name}-25z-coldie-white-hot.png` });
      await p2.evaluate(() => window.__spooky.fixedStep(0.1));
      await p2.evaluate(() => window.__spooky.setSensor('night'));
      await p2.waitForFunction((tt) => window.__spooky.state().t >= tt, t0 + 1.0, { timeout: 240000, polling: 100 });
      await p2.evaluate(() => window.__spooky.fixedStep(0));
      await follow();
      await p2.waitForTimeout(1500);
      await p2.screenshot({ path: `${out}/${name}-25z-coldie-night.png` });
      await p2.close();
    }
    log.push({ name, viewport, dpr, drawCalls: info?.drawCalls, cloudFps: Math.round(fps), gfx: info?.gfx, coldFound: !!cold, errors });
    if (errors.length) code = 1;
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
