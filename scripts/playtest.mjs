// Headless browser playtest (gates G7, G8 and visual evidence).
// Usage: npm run build && node scripts/playtest.mjs [--scale 1|2] [--out reports/playtest] [--only safety|wayin]
// Starts `vite preview`, loads each mission type with the bot playing, switches cameras,
// takes screenshots, and records console errors and draw calls. Chromium is preinstalled.
// It also runs the photosensitivity flash checks and survivor-kit screenshots (`--only safety`
// runs just those), and the way in from the front page with OpenStreetMap stubbed out
// (`--only wayin` runs just that).
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const scale = Number(arg('--scale', 1));
const out = arg('--out', 'reports/playtest');
mkdirSync(out, { recursive: true });

const PORT = Number(arg('--port', 4179));
const only = arg('--only', '');
// Flash checks (see the photosensitivity section at the end).
const FLASH_LIMIT = 3;
const AREA_LIMIT = 0.25;
const LUM_STEP = 0.1;
const GRID = { cols: 32, rows: 18, sub: 5 };
const KICK_LIMIT_PX = 5.5; // 105 camera kick: 5 px cap, plus half a pixel for rounding
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
const ready = new Promise((res, rej) => {
  server.stdout.on('data', (d) => String(d).includes(String(PORT)) && res());
  setTimeout(() => rej(new Error('preview server did not start')), 60000); // slow when other builders share the machine
});

const results = [];
let exitCode = 0;
try {
  await ready;
  const browser = await chromium.launch();
  for (const type of only ? [] : ['clear', 'escort', 'defend']) {
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
  if (!only) {
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
  // Photosensitivity flash counts (WCAG 2.3.1) and the survivor kit on every camera.
  if (!only || only === 'safety') {
    for (const r of await safetyChecks(browser)) {
      results.push(r);
      if (r.errors.length) exitCode = 1;
    }
  }
  if (!only || only === 'wayin') {
    for (const r of await wayInChecks(browser)) {
      results.push(r);
      if (r.errors.length) exitCode = 1;
    }
  }
  if (!only) await restOfPlaytest(browser);
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

async function restOfPlaytest(browser) {
  // Draw-call budget (G8)
  for (const r of results) if (r.drawCalls > 150) { r.errors.push(`draw calls ${r.drawCalls} > 150`); exitCode = 1; }
  // Menu renders and has no errors
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: scale });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://localhost:${PORT}/?screen=menu`);
  await page.waitForSelector('.menu h1');
  await page.screenshot({ path: `${out}/menu-phone.png` });
  results.push({ type: 'menu (phone width)', errors, shots: { menu: `${out}/menu-phone.png` } });
  if (errors.length) exitCode = 1;
  await page.close();

  // Landing page (the default screen): desktop, phone and the narrowest phones. Text >= 14 px, no sideways
  // scrolling, the three ways in are on screen, and leaving it frees the WebGL canvas.
  for (const [name, viewport, extra] of [
    ['desktop', { width: 1280, height: 720 }, {}],
    ['phone', { width: 390, height: 844 }, {}],
    ['narrow-320', { width: 320, height: 640 }, {}],
    ['reduced-motion', { width: 1280, height: 720 }, { reducedMotion: 'reduce' }],
  ]) {
    const p = await browser.newPage({ viewport, deviceScaleFactor: scale, ...extra });
    const errs = [];
    p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    p.on('pageerror', (e) => errs.push(String(e)));
    await p.goto(`http://localhost:${PORT}/`);
    await p.waitForSelector('.landing h1');
    await p.waitForTimeout(2500); // the boot static fades and the zombies get moving
    const shot = `${out}/landing-${name}.png`;
    await p.screenshot({ path: shot });
    const check = await p.evaluate(() => {
      const textEls = [...document.querySelectorAll('.landing *')].filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
      const small = textEls.filter((e) => parseFloat(getComputedStyle(e).fontSize) < 14).map((e) => e.textContent.trim().slice(0, 40));
      const land = document.querySelector('.landing');
      const buttons = [...document.querySelectorAll('.landing-actions button')].map((b) => {
        const r = b.getBoundingClientRect();
        return { text: b.textContent, onScreen: r.width > 0 && r.left >= 0 && r.right <= innerWidth };
      });
      return {
        small,
        sideways: document.documentElement.scrollWidth > innerWidth || land.scrollWidth > land.clientWidth,
        buttons,
        canvas: !!document.querySelector('canvas.landing-canvas'),
        screen: window.__spooky?.screen,
      };
    });
    const problems = [];
    if (check.screen !== 'landing') problems.push(`default screen is ${check.screen}, not landing`);
    if (check.small.length) problems.push(`text under 14 px: ${check.small.join(' | ')}`);
    if (check.sideways) problems.push('page scrolls sideways');
    if (check.buttons.length !== 3 || check.buttons.some((b) => !b.onScreen)) problems.push(`buttons: ${JSON.stringify(check.buttons)}`);
    if (!check.canvas) problems.push('no live background canvas');
    if (name === 'desktop') {
      // "Try the sample town" goes straight to the sample town's recon screen (not a form), and the
      // background is released.
      await p.click('.la-sample');
      await p.waitForSelector('.menu .recon .mission-card');
      const after = await p.evaluate(() => ({
        canvases: document.querySelectorAll('canvas').length,
        map: document.querySelector('.menu .recon h2')?.textContent ?? '',
        attrib: document.querySelector('.menu .recon .attrib')?.textContent ?? '',
        form: !!document.querySelector('.menu .custom:not([hidden]), .menu .scout:not([hidden])'),
      }));
      if (after.canvases !== 0) problems.push(`${after.canvases} canvas(es) left after leaving the landing page`);
      if (!/sample/i.test(after.attrib)) problems.push(`recon doesn't show the sample town: ${after.map} / ${after.attrib}`);
      if (after.form) problems.push('"Try the sample town" showed a form as well as recon');
      // Back to the front page, then "Scout my neighbourhood" focuses the address box.
      await p.click('.menu-back');
      await p.waitForSelector('.landing h1');
      await p.click('.la-scout');
      await p.waitForSelector('.menu .scout h1');
      const focused = await p.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName);
      if (!/address/i.test(String(focused))) problems.push(`address box not focused (focus on ${focused})`);
    }
    errs.push(...problems);
    results.push({ type: `landing (${name})`, errors: errs, shots: { landing: shot } });
    if (errs.length) exitCode = 1;
    await p.close();
  }

  // Training night: the coach appears, the intro can be started, the first steps advance, and Skip works.
  {
    const p = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: scale });
    const errs = [];
    p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    p.on('pageerror', (e) => errs.push(String(e)));
    await p.goto(`http://localhost:${PORT}/?screen=tutorial`);
    await p.waitForSelector('.coach h2');
    await p.waitForTimeout(1500);
    const shots = { intro: `${out}/tutorial-intro.png`, step: `${out}/tutorial-step.png` };
    await p.screenshot({ path: shots.intro });
    await p.click('.coach button.primary');
    // Training HUD (BACKLOG 2.9): no clock, no friendly-fire count, and the two placeholders parked off
    // the map aren't counted (CONTACTS = live zombies on the map; FRIENDLIES = the two real ones).
    await p.waitForTimeout(400); // the HUD redraws every 0.1 s
    const hud = await p.evaluate(() => {
      const half = 600; // the sample town reaches 550 m each way; the placeholders sit 420 m beyond its edge
      const on = (window.__spooky.zombies?.() ?? []).filter((z) => Math.abs(z.x) < half && Math.abs(z.z) < half).length;
      const timer = document.querySelector('.hud-timer');
      return { text: document.querySelector('.hud-mission')?.innerText ?? '', timerShown: !!timer && getComputedStyle(timer).display !== 'none' && timer.getBoundingClientRect().height > 0, on };
    });
    if (hud.timerShown || /TIME|HOLD \d/.test(hud.text)) errs.push(`training HUD shows a clock: ${JSON.stringify(hud.text)}`);
    if (/FRIENDLY FIRE/.test(hud.text)) errs.push(`training HUD shows the friendly-fire count: ${JSON.stringify(hud.text)}`);
    const contacts = Number(/CONTACTS (\d+)/.exec(hud.text)?.[1] ?? NaN);
    if (contacts !== hud.on) errs.push(`training HUD counts ${contacts} contacts, ${hud.on} are on the map`);
    if (!/FRIENDLIES 2\b/.test(hud.text)) errs.push(`training HUD should count the 2 friendlies on the map: ${JSON.stringify(hud.text)}`);
    // Look around with the keyboard (works without pointer lock).
    await p.keyboard.down('d');
    await p.waitForTimeout(1600);
    await p.keyboard.up('d');
    await p.keyboard.down('s');
    await p.waitForTimeout(600);
    await p.keyboard.up('s');
    const afterAim = await p.evaluate(() => window.__spooky.tutorialStep());
    if (afterAim !== 'fire25') errs.push(`after looking around the step is ${afterAim}, expected fire25`);
    await p.keyboard.press('1');
    await p.waitForTimeout(800);
    await p.screenshot({ path: shots.step });
    // Fire the 25 mm (needs the pointer captured, which headless Chromium allows), then switch to the 105.
    // The 25 mm step needs a kill, not just rounds fired. Aim the trigger at a live zombie through the
    // test-only hooks (no pixel reading, no wall-clock waits) and fire bursts in game time until one drops.
    await p.mouse.move(640, 560);
    for (let i = 0; i < 10 && (await p.evaluate(() => window.__spooky.tutorialStep())) === 'fire25'; i++) {
      await p.evaluate(() => {
        const zs = window.__spooky.zombies?.() ?? [];
        const z = zs[0];
        if (z) window.__spooky.aimAt(z.x, z.z);
        window.__spooky.holdFire(true);
      });
      await untilGameTime(p, (await gameTime(p)) + 1.0);
      await p.evaluate(() => window.__spooky.holdFire(false));
      await untilGameTime(p, (await gameTime(p)) + 1.5); // let shells land
    }
    const afterFire = await p.evaluate(() => window.__spooky.tutorialStep());
    if (afterFire !== 'switch') errs.push(`after firing the 25 mm the step is ${afterFire}, expected switch`);
    await p.keyboard.press('q');
    await p.keyboard.press('q');
    await p.waitForTimeout(1500);
    const afterSwitch = await p.evaluate(() => window.__spooky.tutorialStep());
    if (afterSwitch !== 'fire105') errs.push(`after switching guns the step is ${afterSwitch}, expected fire105`);
    shots.fire105 = `${out}/tutorial-fire105.png`;
    await p.screenshot({ path: shots.fire105 });
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
    await p.click('.coach-skip');
    // Skipping lands on the sample town's recon screen (it used to be the old form).
    await p.waitForSelector('.menu .recon .mission-card');
    const remembered = await p.evaluate(() => localStorage.getItem('spooky.training'));
    if (remembered !== 'done') errs.push('skipping did not remember training');
    const canvases = await p.evaluate(() => document.querySelectorAll('canvas').length);
    if (canvases !== 0) errs.push(`${canvases} canvas(es) left after leaving the tutorial`);
    results.push({ type: 'tutorial (training night)', errors: errs, steps: { afterAim, afterFire, afterSwitch }, shots });
    if (errs.length) exitCode = 1;
    await p.close();
  }
}

// ---------- Photosensitivity: flash meter (WCAG 2.3.1 general flash threshold) ----------
// The page samples the picture on EVERY animation frame (sampling from outside is too slow to see a
// real strobe): a 32 x 18 grid of cells, each the average relative luminance of its block of pixels.
// Node then counts flashes: a flash is a pair of opposing luminance changes of at least 0.1 (where
// the darker side is below 0.8). We count them for the whole screen, for every quarter-screen window
// (25% of the area, 3 x 3 overlapping positions), and per cell, and report:
//   flashesPerSec  the most flashes in any 1 s, over the whole screen and every 25% window (limit 3);
//   areaOver3      the largest share of the screen whose cells each flash more than 3 times in the same
//                  1 s (limit: under 25%), which catches small things flashing together;
//   cellPerSec     the worst single cell (for information; a small blinking light is allowed).

/** Init script: make every WebGL canvas keep its drawing buffer so the meter can read it. */
function keepDrawingBuffers() {
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (type === 'webgl' || type === 'webgl2') attrs = { ...(attrs || {}), preserveDrawingBuffer: true };
    return orig.call(this, type, attrs);
  };
}

/**
 * Start sampling the picture on every animation frame. `clock` 'game' stamps frames with game time
 * (use with the fixedStep hook, so a slow test machine still sees every frame a 60 fps player sees);
 * 'wall' with real time.
 */
async function startMeter(page, selector, clock = 'game') {
  await page.evaluate(([sel, G, clk]) => {
    const W = G.cols * G.sub;
    const H = G.rows * G.sub;
    const g = document.createElement('canvas');
    g.width = W;
    g.height = H;
    const x = g.getContext('2d', { willReadFrequently: true });
    const lut = new Float32Array(256).map((_, i) => {
      const v = i / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    const m = { frames: [], stop: false };
    window.__meter = m;
    const loop = () => {
      if (m.stop) return;
      const c = document.querySelector(sel);
      if (c && c.width) {
        x.drawImage(c, 0, 0, W, H);
        const d = x.getImageData(0, 0, W, H).data;
        const L = new Array(G.cols * G.rows).fill(0);
        for (let py = 0; py < H; py++) {
          for (let px = 0; px < W; px++) {
            const i = (py * W + px) * 4;
            L[Math.floor(py / G.sub) * G.cols + Math.floor(px / G.sub)] += 0.2126 * lut[d[i]] + 0.7152 * lut[d[i + 1]] + 0.0722 * lut[d[i + 2]];
          }
        }
        const n = G.sub * G.sub;
        const t = clk === 'game' ? window.__spooky.state().t * 1000 : performance.now();
        const kick = clk === 'game' ? window.__spooky.aimOffset?.() ?? null : null;
        m.frames.push([t, L.map((v) => Math.round((v / n) * 1000) / 1000), performance.now(), kick]);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }, [selector, GRID, clock]);
}

async function stopMeter(page) {
  return page.evaluate(() => {
    window.__meter.stop = true;
    return window.__meter.frames;
  });
}

/** Times (ms) of luminance changes of at least LUM_STEP, each against the last turning point. */
function changeTimes(v, t) {
  const out = [];
  let dir = 0;
  let ext = v[0];
  let lo = v[0];
  let hi = v[0];
  for (let i = 1; i < v.length; i++) {
    const x = v[i];
    if (dir === 0) {
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
      if (hi - lo >= LUM_STEP && lo < 0.8) {
        dir = x === hi ? 1 : -1;
        ext = x;
        out.push(t[i]);
      }
    } else if (dir > 0) {
      if (x > ext) ext = x;
      else if (ext - x >= LUM_STEP && x < 0.8) {
        dir = -1;
        ext = x;
        out.push(t[i]);
      }
    } else if (x < ext) ext = x;
    else if (x - ext >= LUM_STEP && ext < 0.8) {
      dir = 1;
      ext = x;
      out.push(t[i]);
    }
  }
  return out;
}

/** Most entries of a sorted list of times inside any 1-second window. */
function maxPerSecond(times) {
  let best = 0;
  for (let i = 0, j = 0; i < times.length; i++) {
    while (times[i] - times[j] >= 1000) j++;
    best = Math.max(best, i - j + 1);
  }
  return best;
}

function flashStats(frames) {
  const { cols, rows } = GRID;
  const t = frames.map((f) => f[0]);
  const mean = (L, x0, y0, w, h) => {
    let s = 0;
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) s += L[y * cols + x];
    return s / (w * h);
  };
  const regions = [[0, 0, cols, rows]];
  for (const x0 of [0, cols / 4, cols / 2]) for (const y0 of [0, Math.floor(rows / 4), rows / 2]) regions.push([x0, y0, cols / 2, rows / 2]);
  let worst = 0;
  for (const [x0, y0, w, h] of regions) worst = Math.max(worst, maxPerSecond(changeTimes(frames.map((f) => mean(f[1], x0, y0, w, h)), t)) / 2);
  const cellTimes = [];
  let cellWorst = 0;
  for (let c = 0; c < cols * rows; c++) {
    const ct = changeTimes(frames.map((f) => f[1][c]), t);
    cellTimes.push(ct);
    cellWorst = Math.max(cellWorst, maxPerSecond(ct) / 2);
  }
  // Share of cells flashing more than FLASH_LIMIT times within the same 1 s window, at its worst.
  let area = 0;
  for (const t0 of t) {
    let n = 0;
    for (const ct of cellTimes) if (ct.filter((x) => x >= t0 && x < t0 + 1000).length > FLASH_LIMIT * 2) n++;
    area = Math.max(area, n / (cols * rows));
  }
  const secs = (t[t.length - 1] - t[0]) / 1000;
  // When the whole picture is brightest, seconds after sampling started, and after it first rose
  // (e.g. a blast's washout: does it peak with the blast or arrive late?).
  const full = frames.map((f) => mean(f[1], 0, 0, cols, rows));
  const peak = full.indexOf(Math.max(...full));
  const rise = Math.max(0, full.findIndex((v) => v - full[0] > 0.01));
  const wall = (frames[frames.length - 1][2] - frames[0][2]) / 1000;
  return {
    flashesPerSec: worst,
    areaOver3: Number(area.toFixed(3)),
    cellPerSec: cellWorst,
    frames: frames.length,
    seconds: Number(secs.toFixed(2)),
    brightestAt: Number(((t[peak] - t[0]) / 1000).toFixed(2)),
    brightest: Number(full[peak].toFixed(3)),
    peakAfterRise: Number(((t[peak] - t[rise]) / 1000).toFixed(2)),
    fps: Math.round(frames.length / Math.max(0.001, secs)),
    wallFps: Math.round(frames.length / Math.max(0.001, wall)),
  };
}

/**
 * The camera kick seen in the sampled frames: the largest offset of the aim point from the screen
 * centre (CSS px), and how many times it swings (changes direction by a pixel or more).
 */
function kickStats(frames) {
  const ks = frames.map((f) => f[3]).filter(Boolean);
  let max = 0;
  let swings = 0;
  let dir = 0;
  let ext = [0, 0];
  for (const [x, y] of ks) {
    max = Math.max(max, Math.hypot(x, y));
    const along = (v) => v[0] * 0.34 + v[1] * 0.94; // roughly along the kick; any big jitter shows too
    const d = along([x, y]) - along(ext);
    if (Math.abs(d) < 1) continue;
    if (Math.sign(d) !== dir) swings++;
    dir = Math.sign(d);
    ext = [x, y];
  }
  return { kickPx: Number(max.toFixed(2)), kickSwings: swings };
}

function judge(name, frames, extra = {}) {
  const st = flashStats(frames);
  const errors = [];
  if (st.frames < 20) errors.push(`only ${st.frames} frames sampled`);
  if (st.flashesPerSec > FLASH_LIMIT) errors.push(`${st.flashesPerSec} flashes in 1 s (limit ${FLASH_LIMIT}) over the screen or a quarter of it`);
  if (st.areaOver3 >= AREA_LIMIT) errors.push(`${Math.round(st.areaOver3 * 100)}% of the screen flashes more than ${FLASH_LIMIT} times in 1 s (limit 25%)`);
  return { type: `photosensitivity: ${name}`, ok: !errors.length, ...st, ...extra, errors };
}

async function gamePage(browser, query, extra = {}, init = null) {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1, ...extra });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  if (init) await page.addInitScript(init);
  await page.goto(`http://localhost:${PORT}/?${query}`);
  await page.waitForFunction(() => window.__spooky?.ready === true, null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  return { page, errs };
}

function gameTime(page) {
  return page.evaluate(() => window.__spooky.state().t);
}
/** Wait (in real time, however long it takes) until the game clock reaches `t` seconds. */
function untilGameTime(page, t) {
  return page.waitForFunction((tt) => window.__spooky.state().t >= tt, t, { timeout: 240000, polling: 50 });
}
/** Game seconds per rendered frame (null: real time). A test hook: only present under automation. */
function fixedStep(page, dt) {
  return page.evaluate((d) => window.__spooky.fixedStep(d), dt);
}

async function safetyChecks(browser) {
  const res = [];
  // 1. Two seconds of sustained 25 mm fire through the zoomed-in 25 mm, white-hot and night vision.
  for (const sensor of ['thermal', 'night']) {
    const { page, errs } = await gamePage(browser, 'autostart=1&type=clear&difficulty=1&seed=3');
    await page.keyboard.press('1');
    await page.keyboard.press('z');
    if (sensor === 'night') await page.evaluate(() => window.__spooky.setSensor('night'));
    await fixedStep(page, 1 / 60);
    await untilGameTime(page, (await gameTime(page)) + 1.2); // camera switch settles
    const shots0 = (await page.evaluate(() => window.__spooky.state())).shots;
    await startMeter(page, 'canvas.game-canvas');
    const t0 = await gameTime(page);
    // Hold the trigger through the hook: under headless pointer lock the frame rate collapses.
    await page.evaluate(() => window.__spooky.holdFire(true));
    await untilGameTime(page, t0 + 2);
    await page.evaluate(() => window.__spooky.holdFire(false));
    await untilGameTime(page, t0 + 4); // the last rounds land (~1.7 s flight)
    const frames = await stopMeter(page);
    const shots = (await page.evaluate(() => window.__spooky.state())).shots - shots0;
    const r = judge(`25 mm sustained fire 2 s, zoomed, ${sensor === 'night' ? 'night vision' : 'white-hot'}`, frames, { rounds: shots });
    if (shots < 15) r.errors.push(`only ${shots} rounds fired (the gun didn't fire continuously)`);
    r.errors.push(...errs);
    res.push(r);
    await page.close();
  }
  // 2. A 105 landing on the aim point, seen through the zoomed-in 25 mm (the worst case: the blast
  //    fills the screen), in white-hot, black-hot and night vision. Twice per page: the 105 reloads in 4.5 s.
  //    The camera kick must stay within 5 px and 1-2 swings (out and back), and be off entirely
  //    with reduced motion.
  for (const [label, setup, extra] of [
    ['white-hot', async () => {}, {}],
    ['black-hot', async (p) => { await p.keyboard.press('h'); }, {}],
    ['night vision', async (p) => { await p.evaluate(() => window.__spooky.setSensor('night')); }, {}],
    ['white-hot, reduced motion', async () => {}, { reducedMotion: 'reduce' }],
  ]) {
    const { page, errs } = await gamePage(browser, 'autostart=1&type=clear&difficulty=1&seed=3', extra);
    await page.keyboard.press('1');
    await page.keyboard.press('z');
    await setup(page);
    await page.waitForTimeout(1500);
    const fired = await page.evaluate(() => window.__spooky.fireAt?.('105') ?? false);
    const t0 = await gameTime(page);
    // ~3.6 s flight (fast-forwarded), then every frame of the blast, fireball and washout.
    await fixedStep(page, 0.05);
    await untilGameTime(page, t0 + 3.1);
    await fixedStep(page, 1 / 60);
    await startMeter(page, 'canvas.game-canvas');
    await untilGameTime(page, t0 + 7.5);
    const frames = await stopMeter(page);
    const kick = kickStats(frames);
    const r = judge(`105 impact on the aim point through the zoomed 25 mm, ${label}`, frames, kick);
    if (!fired) r.errors.push('the 105 did not fire (test hook missing?)');
    const still = extra.reducedMotion === 'reduce';
    if (still && kick.kickPx > 0.5) r.errors.push(`camera kicked ${kick.kickPx} px with reduced motion (should be still)`);
    if (!still && kick.kickPx > KICK_LIMIT_PX) r.errors.push(`camera kick ${kick.kickPx} px (limit 5)`);
    if (!still && kick.kickSwings > 2) r.errors.push(`camera kick swings ${kick.kickSwings} times (one damped kick: at most 2)`);
    if (!still && kick.kickPx < 1) r.errors.push(`no camera kick seen (${kick.kickPx} px): is the 105 landing on screen?`);
    r.errors.push(...errs);
    res.push(r);
    await page.close();
  }
  // 3. Twenty seconds of the landing page (its background is a live game with gunfire).
  {
    const page = await browser.newPage({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    await page.addInitScript(keepDrawingBuffers);
    await page.goto(`http://localhost:${PORT}/?screen=landing`);
    await page.waitForSelector('canvas.landing-canvas');
    await startMeter(page, 'canvas.landing-canvas', 'wall');
    await page.waitForTimeout(20000);
    const frames = await stopMeter(page);
    const r = judge('landing page, 20 s', frames);
    r.errors.push(...errs);
    res.push(r);
    await page.close();
  }
  // 4. Friendly fire sounds the alarm (square-wave two-tone), not the ordinary radio blip.
  {
    // Pointer lock is stubbed out (headless frame rate collapses under it); the click still unlocks audio.
    const { page, errs } = await gamePage(browser, 'autostart=1&type=clear&difficulty=1&seed=7', {}, () => {
      Element.prototype.requestPointerLock = () => Promise.resolve();
    });
    await page.evaluate(() => {
      window.__osc = [];
      const orig = AudioContext.prototype.createOscillator;
      AudioContext.prototype.createOscillator = function () {
        const o = orig.call(this);
        queueMicrotask(() => window.__osc.push({ type: o.type, f: o.frequency.value }));
        return o;
      };
    });
    await page.mouse.move(320, 180);
    await page.mouse.down(); // a click unlocks the audio
    await page.mouse.up();
    const s = (await page.evaluate(() => window.__spooky.survivors?.() ?? []))[0];
    const fired = s ? await page.evaluate(([x, z]) => window.__spooky.fireAt('40', x, z), [s.x, s.z]) : false;
    await fixedStep(page, 0.05);
    await page.waitForFunction(() => (window.__spooky.state()?.friendlyHits ?? 0) > 0, null, { timeout: 120000 }).catch(() => undefined);
    await page.waitForSelector('.hud-radio .alarm', { timeout: 15000 }).catch(() => undefined); // the HUD redraws every 0.1 s
    const st = await page.evaluate(() => ({ hits: window.__spooky.state().friendlyHits, osc: window.__osc, alarmLine: !!document.querySelector('.hud-radio .alarm') }));
    const square = st.osc.filter((o) => o.type === 'square');
    const errors = [...errs];
    if (!fired || !st.hits) errors.push(`no friendly hit to test (fired ${fired}, hits ${st.hits})`);
    else {
      if (square.length < 4 || !square.some((o) => o.f === 880) || !square.some((o) => o.f === 660)) errors.push(`friendly fire didn't sound the alarm: ${JSON.stringify(st.osc)}`);
      if (!st.alarmLine) errors.push('no alarm radio line');
    }
    res.push({ type: 'friendly fire sounds the alarm', errors, oscillators: st.osc.length, square: square.length });
    await page.close();
  }
  // 5. Survivor kit through the zoomed-in 25 mm: the cold ID panel on thermal (white-hot and black-hot),
  //    and the IR strobe blinking on night vision, on a road (escort) and on grass (clear).
  for (const [type, ground, wait] of [['escort', 'road', 12000], ['clear', 'grass', 1500]]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: scale });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    await page.goto(`http://localhost:${PORT}/?autostart=1&type=${type}&difficulty=1&seed=7`);
    await page.waitForFunction(() => window.__spooky?.ready === true, null, { timeout: 30000 });
    await page.waitForTimeout(wait);
    await page.addStyleTag({ content: '.hud-cross, .hud-markers { display: none !important }' });
    const follow = async () => {
      const s = (await page.evaluate(() => window.__spooky.survivors()))[0];
      if (s) await page.evaluate(([x, z]) => window.__spooky.aimAt(x, z), [s.x, s.z]);
      return !!s;
    };
    const shots = {};
    const peaks = [];
    if (await follow()) {
      await page.keyboard.press('1');
      await page.keyboard.press('z');
      await page.waitForTimeout(800);
      await follow();
      await page.waitForTimeout(150);
      shots.white = `${out}/survivors-${ground}-25z-white-hot.png`;
      await page.screenshot({ path: shots.white });
      await page.keyboard.press('h');
      await page.waitForTimeout(600);
      await follow();
      await page.waitForTimeout(150);
      shots.black = `${out}/survivors-${ground}-25z-black-hot.png`;
      await page.screenshot({ path: shots.black });
      await page.keyboard.press('h');
      await page.evaluate(() => window.__spooky.setSensor('night'));
      await page.waitForTimeout(1200);
      // The strobe is on 0.3 s of every second. Step the game 0.1 s at a time and freeze it, then
      // sample the centre's brightest red channel (the strobe saturates night vision to white; a lit
      // body or street lamp stays green) and keep one frame with the strobe on and one with it off.
      for (let i = 0; i < 12; i++) {
        const t = await gameTime(page);
        await fixedStep(page, 0.1);
        await untilGameTime(page, t + 0.09);
        await fixedStep(page, 0);
        await follow();
        await page.waitForTimeout(150);
        const peak = await page.evaluate(() => {
          const c = document.querySelector('canvas.game-canvas');
          const g = document.createElement('canvas');
          g.width = 160;
          g.height = 120;
          const x = g.getContext('2d');
          x.drawImage(c, c.width / 2 - 80 * (c.width / 1280), c.height / 2 - 60 * (c.height / 720), 160 * (c.width / 1280), 120 * (c.height / 720), 0, 0, 160, 120);
          const d = x.getImageData(0, 0, 160, 120).data;
          let m = 0;
          for (let k = 0; k < d.length; k += 4) m = Math.max(m, d[k]);
          return m;
        });
        peaks.push(peak);
        const name = peak >= 245 ? 'on' : peak <= 235 ? 'off' : null;
        if (name && !shots[`night_${name}`]) {
          shots[`night_${name}`] = `${out}/survivors-${ground}-25z-night-strobe-${name}.png`;
          await page.screenshot({ path: shots[`night_${name}`] });
        }
      }
      await fixedStep(page, null);
      if (!shots.night_on || !shots.night_off) errs.push(`strobe doesn't blink visibly on night vision (centre peaks ${peaks.join(',')})`);
    } else errs.push('no survivors to photograph');
    res.push({ type: `survivor kit on ${ground} (25 mm zoomed)`, errors: errs, nightCentrePeaks: peaks.join(','), shots });
    await page.close();
  }
  for (const r of res) if ('ok' in r) r.ok = !r.errors.length; // errors added after judging count too
  return res;
}

// ---------- The way in: front page → scout → recon, with OpenStreetMap stubbed (BACKLOG 2.8, 2.9) ----------
// OpenStreetMap is blocked from the cloud container, and the crew never sends test traffic to it anyway:
// every request to an OSM host is answered here (a made-up town in the open ocean, or an error), and any
// other outside request fails the check.
async function wayInChecks(browser) {
  const OSM_HOST = /^https:\/\/(nominatim\.openstreetmap\.org|overpass-api\.de|overpass\.kumi\.systems)\//;
  const OCEAN = { lat: -10, lon: 100 }; // open ocean: never anyone's street
  const PLACE = 'Test Reef, Open Ocean';
  const MSG = {
    offline: "Couldn't reach OpenStreetMap. Check your connection, or try the sample town.",
    notFound: /^Couldn't find that place\./,
    tooLittle: /^There's too little on the map there to fly a mission \(1 building and 0 roads\)\./,
    busy: /busy right now\. Try again in a minute/,
    badCoords: /^That isn't a real latitude\/longitude\./,
  };

  const oceanLL = (x, z) => ({ lat: OCEAN.lat - z / 110574, lon: OCEAN.lon + x / (111320 * Math.cos((OCEAN.lat * Math.PI) / 180)) });

  /** A small made-up grid town at OCEAN, as Overpass would send it: 22 streets, ~390 houses, a park, a school, a wood. */
  function oceanTown() {
    const ll = oceanLL;
    const box = (x, z, w, h) => [ll(x, z), ll(x + w, z), ll(x + w, z + h), ll(x, z + h), ll(x, z)];
    const names = ['Kelp', 'Coral', 'Reef', 'Tide', 'Shoal', 'Brine', 'Gull', 'Dune', 'Spray', 'Harbour', 'Jetty'];
    const els = [];
    let id = 1;
    // Streets share a point at every crossing, as OpenStreetMap ways share nodes (that's what joins the road graph).
    const along = [-520, ...Array.from({ length: 11 }, (_, k) => -500 + k * 100), 520];
    for (let i = 0; i <= 10; i++) {
      const c = -500 + i * 100;
      els.push({ type: 'way', id: id++, tags: { highway: i === 5 ? 'secondary' : 'residential', name: `${names[i]} Street` }, geometry: along.map((t) => ll(c, t)) });
      els.push({ type: 'way', id: id++, tags: { highway: i === 5 ? 'secondary' : 'residential', name: `${names[i]} Avenue` }, geometry: along.map((t) => ll(t, c)) });
    }
    for (let bx = 0; bx < 10; bx++) {
      for (let bz = 0; bz < 10; bz++) {
        const x0 = -500 + bx * 100;
        const z0 = -500 + bz * 100;
        if (bx === 3 && bz === 3) els.push({ type: 'way', id: id++, tags: { leisure: 'park', name: 'Gull Reserve' }, geometry: box(x0 + 12, z0 + 12, 76, 76) });
        else if (bx === 2 && bz === 7) els.push({ type: 'way', id: id++, tags: { natural: 'wood', name: 'Seagrass Wood' }, geometry: box(x0 + 12, z0 + 12, 76, 76) });
        else if (bx === 6 && bz === 4) {
          els.push({ type: 'way', id: id++, tags: { amenity: 'school', name: 'Driftwood Primary School' }, geometry: box(x0 + 12, z0 + 12, 76, 76) });
          els.push({ type: 'way', id: id++, tags: { building: 'school' }, geometry: box(x0 + 20, z0 + 20, 40, 24) });
        } else for (const [dx, dz] of [[14, 14], [56, 14], [14, 56], [56, 56]]) els.push({ type: 'way', id: id++, tags: { building: 'house' }, geometry: box(x0 + dx, z0 + dz, 28, 28) });
      }
    }
    els.push({ type: 'node', id: id++, ...ll(150, 250), tags: { shop: 'supermarket', name: 'Tidemark Grocer' } });
    return { elements: els };
  }

  const cors = { 'access-control-allow-origin': '*' };
  const sendJson = (route, body, status = 200) => route.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(body) });
  const isGeocode = (url) => url.includes('nominatim.openstreetmap.org');
  const foundPlace = (route) => sendJson(route, [{ lat: String(OCEAN.lat), lon: String(OCEAN.lon), display_name: `${PLACE}, Nowhere` }]);
  /** How the fake OpenStreetMap answers in each scenario. */
  const OSM = {
    ok: (delay) => async (route, url) => {
      if (isGeocode(url)) return foundPlace(route);
      await new Promise((r) => setTimeout(r, delay));
      return sendJson(route, oceanTown()).catch(() => undefined); // the page may have cancelled meanwhile
    },
    offline: () => (route) => route.abort('internetdisconnected'),
    notFound: () => (route, url) => (isGeocode(url) ? sendJson(route, []) : route.abort('failed')),
    tooLittle: () => (route, url) => {
      if (isGeocode(url)) return foundPlace(route);
      const p = oceanLL;
      return sendJson(route, { elements: [{ type: 'way', id: 1, tags: { building: 'house' }, geometry: [p(0, 0), p(10, 0), p(10, 10), p(0, 10), p(0, 0)] }] });
    },
    busy: () => (route, url) => {
      if (isGeocode(url)) return foundPlace(route);
      return route.fulfill({ status: 504, headers: cors, contentType: 'text/html', body: '<html><body>504 Gateway Timeout</body></html>' });
    },
    none: () => (route) => route.abort('failed'),
  };

  async function wayInPage(browser, viewport, answer, path = '/?screen=scout') {
    const page = await browser.newPage({ viewport, deviceScaleFactor: scale });
    const errs = [];
    const osmCalls = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    // A refused request logs "Failed to load resource" in the console: expected here, not a page error.
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errs.push(m.text()));
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(`http://localhost:${PORT}/`)) return route.continue();
      if (OSM_HOST.test(url)) {
        osmCalls.push(url);
        return answer(route, url);
      }
      errs.push(`request to a host that isn't allowed: ${url}`);
      return route.abort('blockedbyclient');
    });
    await page.goto(`http://localhost:${PORT}${path}`);
    return { page, errs, osmCalls };
  }

  /** Type a place and send it (Enter, or the main button). Records each loading stage as it becomes active. */
  async function scoutFor(page, text, how = 'enter') {
    await page.waitForSelector('.menu .scout h1');
    await page.evaluate(() => {
      window.__stages = [];
      const ol = document.querySelector('.scout-stages');
      new MutationObserver(() => {
        const a = ol.querySelector('li[data-state=active]')?.textContent;
        if (a && window.__stages[window.__stages.length - 1] !== a) window.__stages.push(a);
      }).observe(ol, { subtree: true, attributes: true, childList: true, characterData: true });
    });
    await page.fill('.scout-input', text);
    if (how === 'enter') await page.press('.scout-input', 'Enter');
    else await page.click('.scout-go');
  }
  const waitOutcome = (page) => page.waitForSelector('.menu .recon .recon-cards > *, .scout-msg:not([hidden])', { timeout: 20000 });
  const scoutState = (page) => page.evaluate(() => ({
    msg: document.querySelector('.scout-msg:not([hidden]) p')?.textContent ?? null,
    role: document.querySelector('.scout-msg:not([hidden])')?.getAttribute('role') ?? null,
    recon: !!document.querySelector('.menu .recon'),
    input: document.querySelector('.scout-input')?.value ?? '',
    inputEnabled: !document.querySelector('.scout-input')?.disabled,
    loading: !!document.querySelector('.scout-progress:not([hidden])'),
    rawError: /failed to fetch|typeerror|networkerror/i.test(document.body.innerText),
    stages: window.__stages ?? [],
  }));

  /** Does box `a` overlap any of `bs`? Also flags sideways scrolling. */
  const overlapCheck = (page, a, bs) => page.evaluate(([a, bs]) => {
    const ra = document.querySelector(a)?.getBoundingClientRect();
    if (!ra) return [`${a} missing`];
    const found = [];
    for (const b of bs) {
      const rb = document.querySelector(b)?.getBoundingClientRect();
      if (!rb || !rb.width) continue;
      if (ra.left < rb.right && ra.right > rb.left && ra.top < rb.bottom && ra.bottom > rb.top) found.push(`${a} overlaps ${b}`);
    }
    const menu = document.querySelector('.menu');
    if (document.documentElement.scrollWidth > innerWidth || menu.scrollWidth > menu.clientWidth) found.push('page scrolls sideways');
    return found;
  }, [a, bs]);

  const res = [];
  const desktop = { width: 1280, height: 720 };
  const phone = { width: 390, height: 844 };

  // 1. The happy path, from the front page: "Scout my neighbourhood" → type → Enter (desktop) or the main
  //    button (phone) → staged readout → recon on the typed place → that mission's briefing.
  for (const [name, viewport] of [['desktop', desktop], ['phone', phone]]) {
    const { page, errs, osmCalls } = await wayInPage(browser, viewport, OSM.ok(2500), name === 'desktop' ? '/?screen=landing' : '/?screen=scout');
    const shots = {};
    if (name === 'desktop') {
      await page.waitForSelector('.landing h1');
      await page.click('.la-scout');
    }
    await page.waitForSelector('.menu .scout h1');
    shots.scout = `${out}/wayin-scout-${name}.png`;
    await page.screenshot({ path: shots.scout });
    errs.push(...(await overlapCheck(page, '.menu-back', ['.scout .card-kicker', '.scout h1'])));
    await scoutFor(page, 'Test Reef', name === 'desktop' ? 'enter' : 'click');
    await page.waitForFunction(() => /Downloading/.test(document.querySelector('.scout-stages li[data-state=active]')?.textContent ?? ''), null, { timeout: 10000 });
    const busy = await page.evaluate(() => ({
      cancel: !!document.querySelector('.scout-progress:not([hidden]) .scout-cancel'),
      sweep: getComputedStyle(document.querySelector('.scout-sweep span')).animationName,
      place: document.querySelector('.scout-place')?.textContent ?? '',
    }));
    if (!busy.cancel) errs.push('no Cancel button while scouting');
    if (busy.sweep !== 'scout-sweep') errs.push(`loading indicator isn't animated (${busy.sweep})`);
    if (!busy.place.includes(PLACE)) errs.push(`the readout doesn't name the place found: ${busy.place}`);
    shots.loading = `${out}/wayin-loading-${name}.png`;
    await page.screenshot({ path: shots.loading });
    await waitOutcome(page);
    const st = await scoutState(page);
    const recon = await page.evaluate(() => ({ map: document.querySelector('.recon h2')?.textContent ?? '', cards: document.querySelectorAll('.recon .mission-card').length, attrib: document.querySelector('.recon .attrib')?.textContent ?? '' }));
    shots.recon = `${out}/wayin-recon-${name}.png`;
    await page.screenshot({ path: shots.recon });
    const want = [/^Finding the place…$/, /^Downloading streets and buildings…$/, /^Reading the map \([\d,]+ buildings, [\d,]+ roads\)…$/, /^Recon$/];
    let k = 0;
    for (const s of st.stages) if (k < want.length && want[k].test(s)) k++;
    if (k < want.length) errs.push(`loading stages out of order or missing: ${JSON.stringify(st.stages)}`);
    if (!st.recon || recon.map !== PLACE) errs.push(`recon isn't on the typed place: ${JSON.stringify(recon)} ${st.msg ?? ''}`);
    if (recon.cards < 1) errs.push('no suggested missions on the typed place');
    if (!/OpenStreetMap/.test(recon.attrib)) errs.push(`no OpenStreetMap credit on recon: ${recon.attrib}`);
    if (!osmCalls.some(isGeocode) || !osmCalls.some((u) => !isGeocode(u))) errs.push(`expected a place search and a map download: ${osmCalls.join(', ')}`);
    errs.push(...(await overlapCheck(page, '.menu-back', ['.recon .card-kicker', '.recon h2'])));
    if (name === 'desktop') {
      const title = await page.textContent('.recon .mission-card h4');
      await page.click('.recon .mission-card button.primary');
      await page.waitForFunction(() => window.__spooky?.screen === 'game', null, { timeout: 30000 });
      await page.waitForSelector('.card.briefing h2');
      const brief = await page.evaluate(() => ({ title: document.querySelector('.card.briefing h2')?.textContent ?? '', attrib: document.querySelector('.hud-attrib')?.textContent ?? '' }));
      // The card reads "Forest sweep: Seagrass Wood", the briefing "Forest sweep — Seagrass Wood": same place.
      const place = (title ?? '').split(': ').pop();
      if (!place || !brief.title.includes(place)) errs.push(`briefing "${brief.title}" isn't the chosen mission "${title}"`);
      if (!/OpenStreetMap/.test(brief.attrib)) errs.push(`no OpenStreetMap credit in the game: ${brief.attrib}`);
      shots.briefing = `${out}/wayin-briefing-${name}.png`;
      await page.screenshot({ path: shots.briefing });
    }
    res.push({ type: `way in: typed place → recon (${name})`, errors: errs, stages: st.stages.join(' → '), shots });
    await page.close();
  }

  // 2. Each failure says what happened in plain English, keeps the typed text, and never flies the sample town.
  for (const [name, answer, text, want, views] of [
    ['offline', OSM.offline(), 'Test Reef', MSG.offline, [desktop, phone]],
    ['no place found', OSM.notFound(), 'Nowhere Lane', MSG.notFound, [desktop]],
    ['too little map data', OSM.tooLittle(), 'Test Reef', MSG.tooLittle, [desktop]],
    ['map server busy', OSM.busy(), 'Test Reef', MSG.busy, [desktop]],
    ['out-of-range coordinates', OSM.none(), '91, 200', MSG.badCoords, [desktop]],
  ]) {
    for (const viewport of views) {
      const tag = viewport === phone ? 'phone' : 'desktop';
      const { page, errs, osmCalls } = await wayInPage(browser, viewport, answer);
      await scoutFor(page, text);
      await waitOutcome(page);
      const st = await scoutState(page);
      if (!st.msg || (typeof want === 'string' ? st.msg !== want : !want.test(st.msg))) errs.push(`message: ${JSON.stringify(st.msg)}`);
      if (st.role !== 'alert') errs.push(`the error isn't announced (role ${st.role})`);
      if (st.rawError) errs.push('raw browser error text on screen');
      if (st.recon) errs.push('went to recon anyway (silent fallback)');
      if (st.input !== text || !st.inputEnabled || st.loading) errs.push(`typed text not kept or box not ready again: ${JSON.stringify(st)}`);
      if (name === 'out-of-range coordinates') {
        if (osmCalls.length) errs.push(`asked OpenStreetMap about impossible coordinates: ${osmCalls.join(', ')}`);
        if (/minute/i.test(st.msg ?? '')) errs.push('bad coordinates told to "try again in a minute"');
      }
      const shot = `${out}/wayin-error-${name.replace(/\W+/g, '-')}-${tag}.png`;
      await page.screenshot({ path: shot });
      res.push({ type: `way in: ${name} (${tag})`, errors: errs, message: st.msg, shots: { error: shot } });
      await page.close();
    }
  }

  // 3. Cancel stops a slow download at once (and its late answer doesn't pop up recon); an empty box asks
  //    for a place instead of flying the sample town.
  {
    const { page, errs, osmCalls } = await wayInPage(browser, desktop, OSM.ok(4000));
    await scoutFor(page, 'Test Reef');
    await page.waitForFunction(() => /Downloading/.test(document.querySelector('.scout-stages li[data-state=active]')?.textContent ?? ''), null, { timeout: 10000 });
    const t0 = Date.now();
    await page.click('.scout-cancel');
    await page.waitForSelector('.scout-msg:not([hidden])', { timeout: 2000 }).catch(() => undefined);
    const st = await scoutState(page);
    if (st.msg !== 'Scouting cancelled.' || st.loading || !st.inputEnabled || st.recon) errs.push(`cancel: ${JSON.stringify(st)}`);
    if (Date.now() - t0 > 2000) errs.push('cancel took over 2 s');
    await page.fill('.scout-input', '');
    await page.press('.scout-input', 'Enter');
    await page.waitForTimeout(4500); // past the moment the cancelled download would have answered
    const empty = await scoutState(page);
    if (empty.recon || !/Type an address/.test(empty.msg ?? '')) errs.push(`empty box or late answer: ${JSON.stringify(empty)}`);
    if (osmCalls.length > 2) errs.push(`an empty box still searched: ${osmCalls.join(', ')}`);
    res.push({ type: 'way in: cancel and empty box', errors: errs });
    await page.close();
  }

  // 4. "Custom mission" and "Try the sample town" from the scout screen; "Other suggestions" shows
  //    different missions on each click.
  {
    const { page, errs } = await wayInPage(browser, desktop, OSM.none());
    await page.waitForSelector('.menu .scout h1');
    await page.click('.scout-custom');
    await page.waitForSelector('.menu .custom h2');
    const status = await page.textContent('.custom .status');
    if (!/sample town/i.test(status ?? '')) errs.push(`custom mission doesn't say which map: ${status}`);
    await page.click('.custom button:has-text("Scout a place")');
    await page.waitForSelector('.menu .scout h1');
    await page.click('.scout-sample');
    await page.waitForSelector('.menu .recon .mission-card');
    const sets = [];
    for (let i = 0; i < 4; i++) {
      sets.push(await page.$$eval('.recon .mission-card h4', (hs) => hs.map((h) => h.textContent)));
      await page.click('.recon-more');
    }
    for (let i = 1; i < sets.length; i++) if (!sets[i].some((t) => !sets[i - 1].includes(t))) errs.push(`"Other suggestions" showed the same missions: ${JSON.stringify(sets[i])}`);
    const shot = `${out}/wayin-other-suggestions-desktop.png`;
    await page.screenshot({ path: shot });
    res.push({ type: 'way in: sample town, custom mission, other suggestions', errors: errs, sets: sets.map((s) => s.join(' | ')), shots: { suggestions: shot } });
    await page.close();
  }

  // 5. The "← Front page" button never covers the recon heading, from the narrowest phone up.
  for (const width of [320, 390, 768, 1280]) {
    const { page, errs } = await wayInPage(browser, { width, height: 720 }, OSM.none(), '/?screen=recon');
    await page.waitForSelector('.menu .recon .mission-card');
    errs.push(...(await overlapCheck(page, '.menu-back', ['.recon .card-kicker', '.recon h2', '.recon .status'])));
    const shot = `${out}/wayin-recon-header-${width}.png`;
    await page.screenshot({ path: shot });
    res.push({ type: `way in: front-page button clear of the recon heading (${width} px)`, errors: errs, shots: { recon: shot } });
    await page.close();
  }
  return res;
}
