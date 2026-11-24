// Headless browser playtest (gates G7, G8 and visual evidence).
// Usage: npm run build && node scripts/playtest.mjs [--scale 1|2] [--out reports/playtest] [--only safety|audio|wayin|tour|controls|scatter|endgame|intro|landmarks|presets|missions|crowd|crowd-flash|highrise]
// Starts `vite preview`, loads each mission type with the bot playing, switches cameras,
// takes screenshots, and records console errors and draw calls. Chromium is preinstalled.
// It also runs the photosensitivity flash checks and survivor-kit screenshots (`--only safety`
// runs just those), and the way in from the front page with OpenStreetMap stubbed out
// (`--only wayin` runs just that).
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
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
  // `--only missions`: just this short run of each mission type with the bot.
  for (const type of only && only !== 'missions' ? [] : ['clear', 'escort', 'defend']) {
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
  if (!only || only === 'safety' || only === 'crowd-flash') {
    for (const r of only === 'crowd-flash' ? [] : await safetyChecks(browser)) {
      results.push(r);
      if (r.errors.length) exitCode = 1;
    }
    // Spec 003 (also on its own: --only crowd-flash): crowd nights' flash scenarios A (surge, all guns), B (50+ kills a second) and C (zoomed 25 mm, darkening).
    for (const r of await crowdFlashChecks(browser)) {
      results.push(r);
      if (r.errors.length) exitCode = 1;
    }
  }
  // Spec 003: crowd nights at the surge (screenshots, draw calls, frame times, the HUD at tablet size, LOD parity).
  if (!only || only === 'crowd') {
    for (const r of await crowdChecks(browser)) {
      results.push(r);
      if (r.errors.length) exitCode = 1;
    }
  }
  // Sound: one shared AudioContext after a click, bounded nodes across restarts, mute silences the master.
  if (!only || only === 'audio') {
    const r = await audioChecks(browser);
    results.push(r);
    if (r.errors.length) exitCode = 1;
  }
  if (!only || only === 'wayin') {
    for (const r of await wayInChecks(browser)) {
      results.push(r);
      if (r.errors.length) exitCode = 1;
    }
  }
  if (!only || only === 'tour') {
    for (const r of await tourChecks(browser)) {
      results.push(r);
      if (r.errors.length) exitCode = 1;
    }
  }
  if (!only || only === 'controls') {
    for (const r of await controlsChecks(browser)) {
      results.push(r);
      if (r.errors.length) exitCode = 1;
    }
  }
  // Spec 002: a freshly scattered horde at t + 1, 2, 3 and 15 s in all three views (feel M3, pillar 3).
  if (!only || only === 'scatter') {
    for (const r of await scatterShots(browser)) {
      results.push(r);
      if (r.errors.length) exitCode = 1;
    }
  }
  // Famous places (3.27): each bundled preset opens from our own origin (no OpenStreetMap request) and reaches recon with the attribution.
  if (!only || only === 'presets') {
    for (const r of await presetChecks(browser)) {
      results.push(r);
      if (r.errors.length) exitCode = 1;
    }
  }
  // Endgame search help (owner's report): the soft circle on screen in thermal and night vision, and the edge arrow.
  if (!only || only === 'endgame') {
    for (const r of await endgameShots(browser)) {
      results.push(r);
      if (!r.ok) exitCode = 1;
    }
  }
  // The intro ("The Late Bulletin"): plays through on a controlled clock, captions, skip, flashes, reduced motion, leaks.
  if (!only || only === 'intro') {
    for (const r of await introChecks(browser)) {
      results.push(r);
      if (r.errors.length) exitCode = 1;
    }
  }
  // 3.19: landmark markers in white hot and night vision, on a desktop and a phone, clear of the HUD and touch controls.
  if (!only || only === 'landmarks') {
    for (const r of await landmarkChecks(browser)) {
      results.push(r);
      if (r.errors.length) exitCode = 1;
    }
  }
  // 3.39: high-rise visibility in New York and the sample town: the steeper orbit, the cut-away, MASKED, flashes.
  if (!only || only === 'highrise') {
    for (const r of await highriseChecks(browser)) {
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

/**
 * Spec 002 (feel M3, pillar 3): one 105 on the densest horde of clear-park and forest-sweep at d3, then the
 * picture through the 105's camera at t + 1, 2, 3 and 15 s after impact, and x2 at t + 3 and 15 s, in white-hot,
 * black-hot and night vision. Same seed on every page, so every view shows the same scatter. Judged by eye
 * (which way the runners went must be readable by t + 2 s); the check fails only if the shot never lands.
 */
async function scatterShots(browser) {
  const res = [];
  for (const template of ['clear-park', 'forest-sweep']) {
    for (const [view, setup] of [
      ['white-hot', async () => {}],
      ['black-hot', async (p) => { await p.keyboard.press('h'); }],
      ['night', async (p) => { await p.evaluate(() => window.__spooky.setSensor('night')); }],
    ]) {
      const { page, errs } = await gamePage(browser, `autostart=1&type=clear&template=${template}&difficulty=3&seed=5`, { viewport: { width: 1280, height: 720 } });
      const shots = {};
      await fixedStep(page, 1 / 60);
      await page.keyboard.press('3');
      await setup(page);
      // The densest horde: the zombie with most others within 15 m.
      const at = await page.evaluate(() => {
        const zs = window.__spooky.zombies();
        let best = zs[0];
        let n = -1;
        for (const a of zs) {
          const k = zs.filter((b) => Math.hypot(a.x - b.x, a.z - b.z) < 15).length;
          if (k > n) { n = k; best = a; }
        }
        return best;
      });
      await page.evaluate(([x, z]) => window.__spooky.aimAt(x, z), [at.x, at.z]);
      // Game-time waits run by advanceTo (big fixed steps between the shots): at 1/60 s a frame the
      // t + 15 s wait alone is 720 frames, over 240 s on software rendering at ~3 frames a second.
      await advanceTo(page, (await gameTime(page)) + 1.5);
      const fired = await page.evaluate(([x, z]) => window.__spooky.fireAt('105', x, z), [at.x, at.z]);
      // Impact: the first kill, found within 1/20 s of game time; 20 game seconds is far past any 105 flight.
      await advanceTo(page, (await gameTime(page)) + 20, { big: 1 / 20, untilKill: true });
      if (!(await page.evaluate(() => window.__spooky.state().kills > 0))) errs.push('the 105 never landed');
      const t0 = await gameTime(page);
      for (const dt of [1, 2, 3, 15]) {
        await advanceTo(page, t0 + dt);
        await fixedStep(page, 0);
        await page.waitForTimeout(300);
        shots[`t${dt}`] = `${out}/scatter-${template}-${view}-t${dt}.png`;
        await page.screenshot({ path: shots[`t${dt}`] });
        if (dt === 3 || dt === 15) {
          await page.keyboard.press('z');
          await page.waitForTimeout(400);
          shots[`t${dt}x2`] = `${out}/scatter-${template}-${view}-t${dt}-x2.png`;
          await page.screenshot({ path: shots[`t${dt}x2`] });
          await page.keyboard.press('z');
          await page.waitForTimeout(200);
        }
        await fixedStep(page, 1 / 60);
      }
      if (!fired) errs.push('the 105 did not fire');
      res.push({ type: `scatter: ${template} d3, ${view}`, ok: !errs.length, errors: errs, shots });
      await page.close();
    }
  }
  return res;
}

/**
 * Endgame search help: a clear-park d3 mission jumped to its last 2 cold-blooded stragglers (test hook), the help
 * started, and the camera on the search circle in white-hot thermal and night vision, at t + 1 and 8 s (they walk),
 * plus the camera turned away so the circle's edge arrow shows. Judged by eye; fails if no circle or marker shows.
 */
async function endgameShots(browser) {
  const res = [];
  for (const [view, setup] of [
    ['thermal', async () => {}],
    ['night', async (p) => { await p.evaluate(() => window.__spooky.setSensor('night')); }],
  ]) {
    const { page, errs } = await gamePage(browser, 'autostart=1&type=clear&template=clear-park&difficulty=3&seed=5', { viewport: { width: 1280, height: 720 } });
    const shots = {};
    // Coarse game steps: only the picture is judged here, and a loaded machine renders few frames a second.
    await fixedStep(page, 1 / 15);
    await setup(page);
    await untilGameTime(page, (await gameTime(page)) + 1.5);
    const left = await page.evaluate(() => window.__spooky.endgame(2));
    const areas = await page.evaluate(() => window.__spooky.searchAreas());
    if (!left || !areas.length) errs.push('no stragglers or no search circle');
    const c = areas[0]?.p ?? { x: 0, z: 0 };
    await page.evaluate(([x, z]) => window.__spooky.aimAt(x, z), [c.x, c.z]);
    const t0 = await gameTime(page);
    for (const dt of [1, 8]) {
      await untilGameTime(page, t0 + dt);
      await fixedStep(page, 0);
      await page.waitForTimeout(400);
      shots[`t${dt}`] = `${out}/endgame-${view}-t${dt}.png`;
      await page.screenshot({ path: shots[`t${dt}`] });
      if ((await page.locator('.hud-search').count()) < 1) errs.push(`t+${dt}: no search circle on screen`);
      await fixedStep(page, 1 / 15);
    }
    // Look away: the circle is off screen, so its marker pins to the edge with an arrow.
    await page.evaluate(([x, z]) => window.__spooky.aimAt(-x, -z), [c.x, c.z]);
    await untilGameTime(page, (await gameTime(page)) + 0.5);
    await fixedStep(page, 0);
    await page.waitForTimeout(400);
    shots.edge = `${out}/endgame-${view}-edge.png`;
    await page.screenshot({ path: shots.edge });
    if ((await page.locator('.hud-search-edge').count()) < 1) errs.push('no edge arrow with the circle off screen');
    res.push({ type: `endgame search help: clear-park d3, ${view}`, ok: !errs.length, errors: errs, shots });
    await page.close();
  }
  return res;
}

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
    // R cycles the guns (3.11; it was Q): 25 → 40 → 105.
    await p.keyboard.press('r');
    await p.keyboard.press('r');
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
        const t = clk === 'game' ? window.__spooky.state().t * 1000 : clk === 'intro' ? (window.__spooky.intro?.state().t ?? 0) * 1000 : performance.now();
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
function untilGameTime(page, t, timeout = 240000) {
  return page.waitForFunction((tt) => window.__spooky.state().t >= tt, t, { timeout, polling: 50 });
}
/**
 * Run the game clock (under fixedStep) to `t` seconds, or (`untilKill`) until the first kill, rendering
 * as few frames as it can: `big` game seconds a frame until the last half second, then 1/60 s, so it
 * stops within one 1/60 s frame of `t`. The sim itself always ticks in fixed STEP increments
 * (Game.frame), so the mission is the same as at 1/60 s a frame; only fewer pictures are drawn. For
 * waits that would otherwise take minutes on software rendering (a few frames a second). Leaves the
 * step at 1/60 s.
 */
async function advanceTo(page, t, { big = 0.25, untilKill = false, timeout = 240000 } = {}) {
  await page.waitForFunction(([tt, b, kill]) => {
    const h = window.__spooky;
    const s = h.state();
    const left = tt - s.t;
    const done = left <= 0 || (kill && s.kills > 0);
    h.fixedStep(done || left <= 0.5 ? 1 / 60 : b);
    return done;
  }, [t, big, untilKill], { timeout, polling: 'raf' });
  await fixedStep(page, 1 / 60);
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
  // 1b. Ten seconds of 25 mm trigger, through its 60-round magazine, the 3 s reload and on again, zoomed
  //     in, in each view (white-hot, black-hot, night vision), at the usual small window and again at a
  //     tablet size (800 x 1280, portrait). Aimed at zombies well clear of the friendlies, so the mission
  //     can't end in friendly fire part-way.
  for (const viewport of [null, { width: 800, height: 1280 }]) {
    for (const [label, setup] of [
      ['white-hot', async () => {}],
      ['black-hot', async (p) => { await p.keyboard.press('h'); }],
      ['night vision', async (p) => { await p.evaluate(() => window.__spooky.setSensor('night')); }],
    ]) {
      const { page, errs } = await gamePage(browser, 'autostart=1&type=clear&difficulty=1&seed=3', viewport ? { viewport } : {});
      await page.keyboard.press('1');
      await page.keyboard.press('z');
      await setup(page);
      await aimAway(page);
      await fixedStep(page, 1 / 60);
      await untilGameTime(page, (await gameTime(page)) + 1.2); // camera switch / polarity ease settles
      const shots0 = (await page.evaluate(() => window.__spooky.state())).shots;
      await startMeter(page, 'canvas.game-canvas');
      const t0 = await gameTime(page);
      await page.evaluate(() => window.__spooky.holdFire(true));
      await untilGameTime(page, t0 + 10, 1200000); // every frame is metered: slow on a busy machine
      await page.evaluate(() => window.__spooky.holdFire(false));
      await untilGameTime(page, t0 + 12, 600000); // the last rounds land
      const frames = await stopMeter(page);
      const shots = (await page.evaluate(() => window.__spooky.state())).shots - shots0;
      const size = viewport ? `${viewport.width}x${viewport.height}` : '640x360';
      const r = judge(`25 mm held 10 s (magazine, reload, fire again), zoomed, ${label}, ${size}`, frames, { rounds: shots });
      // 60 rounds in 5 s, a 3 s reload, then ~2 s more: about 84.
      if (shots < 75) r.errors.push(`only ${shots} rounds in 10 s (expected ~84: the 25 mm didn't fire through the reload)`);
      r.errors.push(...errs);
      res.push(r);
      await page.close();
    }
  }
  // 1c. Ten seconds of mixed guns in night vision (the view blasts wash out), zoomed in: 25 mm, then the
  //     40 mm, a 105, then the 25 mm again, trigger held throughout, metered until the 105 has landed.
  {
    const { page, errs } = await gamePage(browser, 'autostart=1&type=clear&difficulty=1&seed=3');
    await page.keyboard.press('1');
    await page.keyboard.press('z');
    await page.evaluate(() => window.__spooky.setSensor('night'));
    await aimAway(page);
    await fixedStep(page, 1 / 60);
    await untilGameTime(page, (await gameTime(page)) + 1.2);
    const shots0 = (await page.evaluate(() => window.__spooky.state())).shots;
    await startMeter(page, 'canvas.game-canvas');
    const t0 = await gameTime(page);
    await page.evaluate(() => window.__spooky.holdFire(true));
    for (const [at, key] of [[3, '2'], [6, '3'], [7, '1']]) {
      await untilGameTime(page, t0 + at, 600000);
      await page.keyboard.press(key);
    }
    await untilGameTime(page, t0 + 10, 600000);
    await page.evaluate(() => window.__spooky.holdFire(false));
    await untilGameTime(page, t0 + 15, 600000); // the 105 shell takes ~4.5 s to land
    const frames = await stopMeter(page);
    const shots = (await page.evaluate(() => window.__spooky.state())).shots - shots0;
    const r = judge('mixed guns held 10 s (25, 40, 105, 25), zoomed, night vision', frames, { rounds: shots });
    if (shots < 40) r.errors.push(`only ${shots} rounds in the mixed burst`);
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

// ---------- Sound ----------
// Audio can't be listened to headless. Instead, through the test-only window.__spooky.audio() hook
// (installed only under browser automation), check: no AudioContext before a gesture, exactly one
// after a click and still one after 10 restarts, live sources bounded across those restarts,
// gunfire ducks the music, M (the shared muted setting) silences the master gain, and quitting to
// the menu frees the mission score and engine drone. Recorded audio (public/audio): every file
// fetches and decodes, the recorded score and ambience bed take over from the generated ones, and
// radio voice lines never overlap (one at a time, a gap between, urgent calls cutting in), including
// across the restarts.
async function audioChecks(browser) {
  const errors = [];
  const { page, errs } = await gamePage(browser, 'autostart=1&type=clear&difficulty=1&seed=3');
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  const read = () => page.evaluate(() => window.__spooky.audio?.() ?? null);
  const playing = () => page.waitForFunction(() => window.__spooky?.ready === true && window.__spooky.info()?.screen === 'playing', null, { timeout: 30000 });
  const out = { type: 'audio (context, restarts, mute)', errors };
  try {
    const before = await read();
    if (!before) errors.push('no audio test hook');
    else if (before.contexts !== 0) errors.push(`${before.contexts} AudioContext(s) before any gesture`);
    await page.mouse.click(320, 180);
    await page.waitForTimeout(1500);
    const first = await read();
    out.afterClick = first;
    if (!first || first.contexts !== 1) errors.push(`expected 1 AudioContext after a click, got ${first?.contexts}`);
    if (first?.state !== 'running') errors.push(`AudioContext is ${first?.state}, not running`);
    if (first?.playing !== 'mission' || !first?.ambience) errors.push(`mission score/ambience not playing: ${JSON.stringify(first)}`);

    // Recorded files: all 34 load (fetched lazily after the click), and the recorded score and bed take over.
    // Headless on a busy machine, decoding the 60 s music files can take a while (152 s measured under a load average of 14 on 4 cores): allow up to 4 min.
    const t0 = Date.now();
    await page
      .waitForFunction(() => { const a = window.__spooky.audio?.(); return a?.assets?.pending === 0 && a.recorded?.score && a.recorded?.bed; }, null, { timeout: 240000, polling: 250 })
      .catch(() => undefined);
    out.loadSeconds = Math.round((Date.now() - t0) / 100) / 10;
    const loaded = await read();
    out.assets = loaded?.assets;
    out.recorded = loaded?.recorded;
    // 35: 36 files (spec 002 added few-left and cold-leftovers) minus the menu theme, which is
    // released once the mission claims the music (3.6b: only this screen's music stays decoded).
    if (!(loaded?.assets?.ready === 35) || loaded.assets.failed || loaded.assets.pending) errors.push(`recorded audio not all loaded: ${JSON.stringify(loaded?.assets)}`);
    if (!loaded?.recorded?.score || !loaded?.recorded?.bed) errors.push(`recorded score/bed not playing: ${JSON.stringify(loaded?.recorded)}`);

    // Radio voice: a barrage of requests plays one line at a time; CHECK FIRE cuts in.
    await page.evaluate(() => { for (const l of ['new-contacts', 'good-effect', 'more-coming', 'rushers', 'survivor-lost']) window.__spooky.audioSay(l); });
    // (Headless, the audio clock and the engine's tick can lag the wall clock: wait for the duck rather than sleep.)
    await page.waitForFunction(() => window.__spooky.audio().gains.duck > 0.2, null, { timeout: 5000, polling: 50 }).catch(() => undefined);
    const speaking = await read();
    out.duckUnderVoice = speaking?.gains?.duck;
    if (!(speaking?.gains?.duck > 0.2)) errors.push(`music not ducked under the voice (duck ${speaking?.gains?.duck})`);
    await page.evaluate(() => window.__spooky.audioSay('check-fire'));
    await page.waitForTimeout(9000);
    const talked = await read();
    out.voice = talked?.voice;
    const log = talked?.voice?.log ?? [];
    if (!(talked?.voice?.said >= 3)) errors.push(`expected at least 3 voice lines, got ${talked?.voice?.said}`);
    if (talked?.voice?.overlaps !== 0) errors.push(`voice lines overlapped: ${JSON.stringify(log)}`);
    if (!log.some((e) => e.line === 'check-fire')) errors.push(`CHECK FIRE was not said: ${JSON.stringify(log)}`);
    if (log.some((e) => e.line === 'good-effect')) errors.push('low-priority banter played while the radio was busy');
    for (let i = 1; i < log.length; i++) {
      const urgent = ['check-fire', 'friendlies-under-attack', 'mission-complete', 'mission-failed', 'cleared-hot'].includes(log[i].line);
      if (!urgent && log[i].start - log[i - 1].end < 2.9) errors.push(`only ${(log[i].start - log[i - 1].end).toFixed(2)} s between voice lines ${log[i - 1].line} and ${log[i].line}`);
    }

    // Gunfire ducks the music (first let any duck from the radio voice above recover).
    await page.waitForFunction(() => window.__spooky.audio().gains.duck < 0.01, null, { timeout: 10000, polling: 100 }).catch(() => undefined);
    await page.evaluate(() => window.__spooky.holdFire(true));
    await page.waitForTimeout(600);
    const firing = await read();
    await page.evaluate(() => window.__spooky.holdFire(false));
    out.duckUnderFire = firing?.gains?.duck;
    if (!(firing?.gains?.duck > 0.1)) errors.push(`music not ducked under fire (duck ${firing?.gains?.duck})`);

    // Mute (M) silences the master; pressing it again brings it back.
    await page.keyboard.press('m');
    await page.waitForTimeout(500);
    const muted = await read();
    await page.keyboard.press('m');
    await page.waitForTimeout(500);
    const unmuted = await read();
    out.masterMuted = muted?.gains?.master;
    out.masterUnmuted = unmuted?.gains?.master;
    if (!(muted?.gains?.master < 0.001)) errors.push(`muted, but master gain is ${muted?.gains?.master}`);
    if (!(unmuted?.gains?.master > 0.1)) errors.push(`unmuted, but master gain is ${unmuted?.gains?.master}`);

    // Ten restarts (Esc, then the pause menu's Restart; R is the gun key since 3.11): still one context,
    // and the number of live sources stays bounded.
    const voices = [first?.voices];
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => window.__spooky.info()?.screen === 'paused', null, { timeout: 10000 });
      await page.click('.overlay .pause-restart');
      await playing();
      await page.waitForTimeout(500);
      voices.push((await read())?.voices);
    }
    await page.waitForTimeout(3000);
    const after = await read();
    voices.push(after?.voices);
    out.voices = voices;
    out.afterRestarts = after;
    if (after?.contexts !== 1) errors.push(`${after?.contexts} AudioContexts after 10 restarts (must be 1)`);
    const limit = Math.max(80, (first?.voices ?? 0) * 2);
    if (voices.some((v) => !(v <= limit))) errors.push(`live sources not bounded across restarts: ${voices.join(', ')} (limit ${limit})`);
    if (after?.fading > 0) errors.push(`${after.fading} score(s) still fading 3 s after the last restart`);
    if (after?.voice?.overlaps !== 0) errors.push(`voice lines overlapped across restarts: ${JSON.stringify(after?.voice?.log)}`);
    if (!after?.recorded?.score) errors.push('recorded score not playing after the restarts');

    // Quit to the menu: the mission score and drone fade out and are freed; the menu theme plays.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__spooky.info()?.screen === 'paused', null, { timeout: 10000 });
    await page.click('.overlay button:has-text("Quit to menu")');
    await page.waitForSelector('.menu h1:visible, .menu h2:visible');
    await page.waitForTimeout(4500);
    const menu = await read();
    out.menu = menu;
    if (menu?.playing !== 'menu' || menu?.ambience || menu?.fading) errors.push(`after quitting to the menu: ${JSON.stringify(menu)}`);
    if (!(menu?.voices < (after?.voices ?? 0))) errors.push(`mission sources not freed on quitting (${after?.voices} -> ${menu?.voices})`);
  } catch (e) {
    errors.push(String(e));
  }
  errors.push(...errs);
  await page.close();
  return out;
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
  /** The map comes in two parts (3.23): the core, then the extras (trees, street lamps, bus routes). */
  const isExtras = (route) => (route.request().postData() ?? '').includes('street_lamp');
  /** Trees, lamps and a bus route for the ocean town: only looks, never missions. */
  function oceanExtras() {
    const els = [];
    let id = 100000;
    for (let k = 0; k < 60; k++) els.push({ type: 'node', id: id++, ...oceanLL(-480 + (k % 10) * 100 + 8, -480 + Math.floor(k / 10) * 100 + 8), tags: { natural: 'tree' } });
    for (let k = 0; k < 20; k++) els.push({ type: 'node', id: id++, ...oceanLL(-500 + k * 50, 2), tags: { highway: 'street_lamp' } });
    els.push({ type: 'relation', id: id++, tags: { route: 'bus', ref: '7', name: 'Reef Loop' }, members: [{ type: 'way', ref: 1, role: '', geometry: [oceanLL(0, -520), oceanLL(0, 520)] }] });
    return { elements: els };
  }
  /** How the fake OpenStreetMap answers in each scenario. */
  const OSM = {
    ok: (delay) => async (route, url) => {
      if (isGeocode(url)) return foundPlace(route);
      await new Promise((r) => setTimeout(r, delay));
      return sendJson(route, isExtras(route) ? oceanExtras() : oceanTown()).catch(() => undefined); // the page may have cancelled meanwhile
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
    /** Per OSM call: 'geocode', 'core' or 'extras'. */
    const osmParts = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    // A refused request logs "Failed to load resource" in the console: expected here, not a page error.
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errs.push(m.text()));
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(`http://localhost:${PORT}/`)) return route.continue();
      if (OSM_HOST.test(url)) {
        osmCalls.push(url);
        osmParts.push(isGeocode(url) ? 'geocode' : isExtras(route) ? 'extras' : 'core');
        return answer(route, url);
      }
      errs.push(`request to a host that isn't allowed: ${url}`);
      return route.abort('blockedbyclient');
    });
    if (path) await page.goto(`http://localhost:${PORT}${path}`); // null: the caller navigates
    return { page, errs, osmCalls, osmParts };
  }

  /**
   * For the streaming scenarios (3.23): a stand-in for fetch() to the OSM hosts, inside the page, so an
   * answer can arrive slowly, in pieces, with or without its size, or never. Playwright's route.fulfill
   * sends a body all at once. Every other request still goes through wayInPage's route check.
   * plan[part][host] (or plan[part].any): 'hang' (no answer until cancelled), 'fail', or
   * { delay: ms before the first byte, chunks, gap: ms between chunks, length: send Content-Length }.
   */
  function slowOsm({ plan, town, extras, geocode }) {
    const real = window.fetch.bind(window);
    window.__osm = [];
    const wait = (ms, signal) => new Promise((res, rej) => {
      const t = setTimeout(res, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(t);
        rej(new DOMException('aborted', 'AbortError'));
      });
    });
    window.fetch = async (input, init = {}) => {
      const url = String(input?.url ?? input);
      const m = /^https:\/\/(nominatim\.openstreetmap\.org|overpass-api\.de|overpass\.kumi\.systems)\//.exec(url);
      if (!m) return real(input, init);
      const host = m[1];
      const part = host.startsWith('nominatim') ? 'geocode' : String(init.body ?? '').includes('street_lamp') ? 'extras' : 'core';
      window.__osm.push({ host, part, at: Date.now() });
      init.signal?.addEventListener('abort', () => window.__osm.push({ host, part, at: Date.now(), aborted: true }));
      const signal = init.signal;
      if (part === 'geocode') return new Response(JSON.stringify(geocode), { headers: { 'content-type': 'application/json' } });
      const how = plan[part]?.[host] ?? plan[part]?.any ?? 'fail';
      if (how === 'hang') await new Promise((_, rej) => signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
      if (how === 'fail') {
        await wait(300, signal);
        throw new TypeError('Failed to fetch');
      }
      await wait(how.delay, signal); // the server working out the area
      const bytes = new TextEncoder().encode(JSON.stringify(part === 'core' ? town : extras));
      const size = Math.ceil(bytes.length / how.chunks);
      let i = 0;
      const body = new ReadableStream({
        async pull(c) {
          try {
            if (i) await wait(how.gap, signal);
          } catch (e) {
            c.error(e);
            return;
          }
          if (i * size >= bytes.length) c.close();
          else c.enqueue(bytes.slice(i * size, ++i * size));
        },
      });
      return new Response(body, { headers: { 'content-type': 'application/json', ...(how.length ? { 'content-length': String(bytes.length) } : {}) } });
    };
  }
  const slowPlan = (plan) => ({ plan, town: oceanTown(), extras: oceanExtras(), geocode: [{ lat: String(OCEAN.lat), lon: String(OCEAN.lon), display_name: `${PLACE}, Nowhere` }] });
  /** Waits until the extras have either arrived or quietly failed on the recon screen. */
  const extrasSettled = (page) => page.waitForFunction(() => {
    const n = document.querySelector('.recon .recon-extras');
    return !!n && (n.hidden || /added/.test(n.textContent ?? ''));
  }, null, { timeout: 20000 });
  const readoutState = (page) => page.evaluate(() => ({
    text: document.querySelector('.scout-load-text:not([hidden])')?.textContent ?? null,
    server: document.querySelector('.scout-server:not([hidden])')?.textContent ?? null,
    // The one clock (3.26), counted from pressing Scout, in the estimate line.
    elapsed: /(\d+:\d\d) so far$/.exec(document.querySelector('.scout-estimate:not([hidden])')?.textContent ?? '')?.[1] ?? null,
    clocks: document.querySelectorAll('.scout-progress:not([hidden]) .scout-elapsed').length,
    mode: document.querySelector('.scout-sweep')?.dataset.mode ?? null,
    width: document.querySelector('.scout-sweep span')?.style.width ?? '',
    anim: getComputedStyle(document.querySelector('.scout-sweep span')).animationName,
    estimate: document.querySelector('.scout-estimate:not([hidden])')?.textContent ?? null,
    stage: document.querySelector('.scout-stages li[data-state=active]')?.textContent ?? null,
    role: document.querySelector('.scout-progress')?.getAttribute('role') ?? null,
    hiddenFromSr: document.querySelector('.scout-load')?.getAttribute('aria-hidden') === 'true',
    cancel: document.querySelector('.scout-cancel')?.getBoundingClientRect().height ?? 0,
  }));
  const secs = (clock) => {
    const m = /^(\d+):(\d\d)$/.exec(clock ?? '');
    return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  };

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
      mode: document.querySelector('.scout-sweep')?.dataset.mode ?? '',
      width: document.querySelector('.scout-sweep span')?.style.width ?? '',
      place: document.querySelector('.scout-place')?.textContent ?? '',
    }));
    if (!busy.cancel) errs.push('no Cancel button while scouting');
    // A moving sweep, or (3.26, while the server prepares the area) the estimate bar, which fills over time.
    if (busy.sweep !== 'scout-sweep' && !(busy.mode === 'estimate' && busy.width.endsWith('%'))) errs.push(`loading indicator isn't moving (${busy.sweep}, ${busy.mode})`);
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

  // 6. Places remembered on this device (BACKLOG 3.12): the second scout of the same place makes no
  //    OpenStreetMap request and says it came from this device; Refresh downloads it again (map only);
  //    Forget this place and Forget all saved places (Settings) remove it. Still the stubbed OSM.
  {
    const { page, errs, osmCalls, osmParts } = await wayInPage(browser, desktop, OSM.ok(300));
    const toRecon = async (text) => {
      await scoutFor(page, text);
      await page.waitForSelector('.menu .recon .recon-cards > *', { timeout: 20000 });
      return scoutState(page);
    };
    const note = () => page.evaluate(() => document.querySelector('.recon .recon-saved')?.innerText.replace(/\s+/g, ' ').trim() ?? null);
    const backToScout = async () => {
      await page.click('.recon-change');
      await page.waitForSelector('.menu .scout h1');
    };
    const shots = {};

    await toRecon('Test Reef');
    const first = await note();
    // The extras follow the core (3.23); once they're in, the saved copy is complete.
    await extrasSettled(page).catch(() => errs.push('the extras never settled after the first scout'));
    const afterFirst = osmCalls.length;
    if (osmParts.join(',') !== 'geocode,core,extras') errs.push(`first scout: expected a search, the core and the extras: ${osmParts.join(',')}`);
    if (!/^Saved on this device, so next time it opens instantly/.test(first ?? '')) errs.push(`no "saved on this device" note after a download: ${first}`);
    if (!/never sent anywhere/.test(first ?? '')) errs.push(`no privacy note by the saved place: ${first}`);
    if (afterFirst < 2) errs.push(`first scout didn't search and download: ${osmCalls.join(', ')}`);

    await backToScout();
    const second = await toRecon('  test reef '); // the same search, typed differently
    const again = await note();
    if (osmCalls.length !== afterFirst) errs.push(`the second scout asked OpenStreetMap again: ${osmCalls.slice(afterFirst).join(', ')}`);
    if (!second.stages.some((s) => /^Loaded from this device · downloaded just now$/.test(s))) errs.push(`the readout doesn't say it loaded from this device: ${JSON.stringify(second.stages)}`);
    if (!/^Loaded from this device · downloaded just now Refresh Forget this place/.test(again ?? '')) errs.push(`recon note for a saved place: ${again}`);
    const map2 = await page.textContent('.recon h2');
    if (map2 !== PLACE) errs.push(`saved place opened as "${map2}"`);
    shots.saved = `${out}/wayin-saved-place-desktop.png`;
    await page.screenshot({ path: shots.saved });

    // Refresh: downloads the map again (no new place search), and keeps it. Since 3.23 "the map" is two
    // requests: the core once, then the extras once.
    await page.click('.recon-refresh');
    await page.waitForSelector('.menu .recon .recon-cards > *', { timeout: 20000 });
    await extrasSettled(page).catch(() => errs.push('the extras never settled after Refresh'));
    const refreshed = osmParts.slice(afterFirst);
    if (refreshed.join(',') !== 'core,extras') errs.push(`Refresh should download the core once and the extras once, and not search again: ${refreshed.join(', ')}`);
    if (!/^Saved on this device/.test((await note()) ?? '')) errs.push(`after Refresh: ${await note()}`);

    // Forget this place: gone, and the next scout downloads afresh.
    await page.click('.recon-forget');
    await page.waitForFunction(() => /^Forgotten\./.test(document.querySelector('.recon-saved-text')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => errs.push('Forget this place did not confirm'));
    if (await page.$('.recon-forget, .recon-refresh')) errs.push('Forget/Refresh still offered after forgetting');
    await backToScout();
    const beforeThird = osmCalls.length;
    await toRecon('Test Reef');
    if (osmCalls.length - beforeThird < 2) errs.push(`a forgotten place still loaded from the device: ${osmCalls.slice(beforeThird).join(', ')}`);

    // Settings → Forget all saved places.
    await page.click('.screen-settings');
    await page.waitForFunction(() => /^1 place saved on this device/.test(document.querySelector('.settings-places p')?.textContent ?? ''), null, { timeout: 5000 })
      .catch(async () => errs.push(`settings count: ${await page.textContent('.settings-places p')}`));
    shots.settings = `${out}/wayin-saved-places-settings.png`;
    await page.screenshot({ path: shots.settings });
    await page.click('.settings-forget-places');
    await page.waitForFunction(() => /^No places saved on this device\.$/.test(document.querySelector('.settings-places p')?.textContent ?? ''), null, { timeout: 5000 })
      .catch(async () => errs.push(`after Forget all: ${await page.textContent('.settings-places p')}`));
    await page.keyboard.press('Escape');
    await backToScout();
    const beforeFourth = osmCalls.length;
    await toRecon('Test Reef');
    if (osmCalls.length - beforeFourth < 2) errs.push(`"Forget all" left the place on the device: ${osmCalls.slice(beforeFourth).join(', ')}`);
    // Nothing about saved places leaves the browser: every outside request was to OSM (wayInPage fails any other).
    res.push({ type: 'way in: places remembered on this device', errors: errs, shots });
    await page.close();
  }

  // 7. A browser that refuses storage (private window, blocked site data) still scouts, just without saving.
  {
    const { page, errs, osmParts } = await wayInPage(browser, desktop, OSM.ok(200), null);
    await page.addInitScript(() => {
      Object.defineProperty(window, 'indexedDB', { get() { throw new DOMException('blocked', 'SecurityError'); } });
    });
    await page.goto(`http://localhost:${PORT}/?screen=scout`);
    for (let i = 0; i < 2; i++) {
      await scoutFor(page, 'Test Reef');
      await waitOutcome(page);
      const st = await scoutState(page);
      if (!st.recon) errs.push(`no storage: scouting failed: ${st.msg}`);
      if (await page.$('.recon-saved')) errs.push('claims the place is saved when storage is blocked');
      if (i === 0) await page.click('.recon-change');
    }
    // Two searches and two map downloads (core); each scout's extras may or may not have been asked for yet.
    const count = (p) => osmParts.filter((x) => x === p).length;
    if (count('geocode') !== 2 || count('core') !== 2) errs.push(`expected two searches and two downloads without storage: ${osmParts.join(',')}`);
    res.push({ type: 'way in: storage blocked (private window)', errors: errs });
    await page.close();
  }

  // 8. The honest download readout and the two-part load (3.23, 3.20, 3.22), with answers that arrive slowly.
  const WAITING = "OpenStreetMap is preparing your area — this can take a minute or two when it's busy";
  const missionTitles = (page) => page.$$eval('.recon .mission-card h4', (hs) => hs.map((h) => h.textContent).join(' | '));

  // 8a. A slow server, then a download of unknown size: "preparing" with a running clock and a moving bar, then
  //     bytes. Recon comes on the core; the extras arrive later and change the map, not the missions.
  {
    const { page, errs } = await wayInPage(browser, desktop, OSM.none(), null);
    await page.addInitScript(slowOsm, slowPlan({
      core: { any: { delay: 4000, chunks: 12, gap: 450, length: false } },
      extras: { any: { delay: 3500, chunks: 3, gap: 200, length: true } },
    }));
    await page.goto(`http://localhost:${PORT}/?screen=scout`);
    await page.evaluate(() => {
      window.__spoken = [];
      new MutationObserver(() => window.__spoken.push(document.querySelector('.scout-spoken')?.textContent)).observe(document.querySelector('.scout-spoken'), { childList: true, characterData: true, subtree: true });
    });
    const shots = {};
    await scoutFor(page, 'Test Reef');
    await page.waitForFunction((w) => document.querySelector('.scout-load-text:not([hidden])')?.textContent === w, WAITING, { timeout: 10000 });
    const w1 = await readoutState(page);
    await page.waitForTimeout(2100);
    const w2 = await readoutState(page);
    // 3.26: while the server works, the estimate (no history yet: the default) and a fill creeping toward it.
    if (w1.mode !== 'estimate' || w1.anim !== 'none') errs.push(`while the server works: the estimate bar (${w1.mode}, ${w1.anim})`);
    if (!/^Usually about 1–3 min · 0:0\d so far$/.test(w1.estimate ?? '') || !/^Usually about 1–3 min · 0:0\d so far$/.test(w2.estimate ?? '')) errs.push(`estimate line: ${w1.estimate} → ${w2.estimate}`);
    if (!(parseFloat(w2.width) > parseFloat(w1.width) && parseFloat(w2.width) <= 90)) errs.push(`the estimate bar should creep forward, never past 90%: ${w1.width} → ${w2.width}`);
    if (!/^Downloading streets and buildings…$/.test(w1.stage ?? '')) errs.push(`stage while waiting: ${w1.stage}`);
    if (!/Asking overpass-api\.de/.test(w1.server ?? '')) errs.push(`doesn't say which server: ${w1.server}`);
    if (!(secs(w2.elapsed) >= secs(w1.elapsed) + 1)) errs.push(`the elapsed clock doesn't run: ${w1.elapsed} → ${w2.elapsed}`);
    if (w1.clocks || w2.clocks) errs.push('two clocks on screen: one only, in the estimate line');
    if (/%/.test([w2.text, w2.estimate, w2.server].join(' '))) errs.push('a percentage on screen while nothing is known');
    if (w1.role !== 'status' || !w1.hiddenFromSr) errs.push('readout: the busy numbers should be hidden from screen readers, with a status line instead');
    if (w1.cancel < 44) errs.push(`Cancel is too small to tap: ${w1.cancel}px`);
    shots.waiting = `${out}/wayin-progress-waiting-desktop.png`;
    await page.screenshot({ path: shots.waiting });
    await page.waitForFunction(() => /^Downloading… \d+ KB$/.test(document.querySelector('.scout-load-text')?.textContent ?? ''), null, { timeout: 10000 });
    const b = await readoutState(page);
    if (b.mode !== 'bytes' || b.width) errs.push(`unknown size: bytes and a moving bar, never a fill (${b.mode}, ${b.width})`);
    if (!/overpass-api\.de is answering/.test(b.server ?? '')) errs.push(`server while downloading: ${b.server}`);
    shots.bytes = `${out}/wayin-progress-bytes-desktop.png`;
    await page.screenshot({ path: shots.bytes });
    await page.waitForSelector('.menu .recon .recon-cards > *', { timeout: 20000 });
    const before = await missionTitles(page);
    const pending = await page.textContent('.recon .recon-extras');
    if (!/still on their way/.test(pending ?? '')) errs.push(`recon doesn't say the extras are coming: ${pending}`);
    const treesBefore = await page.$$eval('.recon .tm-tree', (t) => t.length);
    shots.reconPending = `${out}/wayin-recon-extras-pending-desktop.png`;
    await page.screenshot({ path: shots.reconPending });
    await extrasSettled(page).catch(() => errs.push('the extras never arrived'));
    const after = await page.evaluate(() => ({
      note: document.querySelector('.recon .recon-extras')?.textContent ?? '',
      counts: document.querySelector('.recon .recon-counts')?.textContent ?? '',
      trees: document.querySelectorAll('.recon .tm-tree').length,
      bus: document.querySelectorAll('.recon .recon-code.fam-transport').length,
      timing: document.querySelector('.recon .recon-timing:not([hidden])')?.textContent ?? '',
    }));
    if (!/added/.test(after.note) || !/60 mapped trees · 20 street lamps/.test(after.counts) || !after.trees || treesBefore || !after.bus) errs.push(`the extras didn't merge into the map: ${JSON.stringify({ ...after, treesBefore })}`);
    if ((await missionTitles(page)) !== before) errs.push(`the extras changed the suggested missions: ${before} → ${await missionTitles(page)}`);
    if (!/^Loaded in [\d:.]+(?: s)? \(server \S+ s, download \S+ s, build \S+ s\) from overpass-api\.de · trees, lamps and bus routes \S+ s later$/.test(after.timing)) errs.push(`timing line: ${after.timing}`);
    const spoken = await page.evaluate(() => window.__spoken.filter(Boolean));
    if (spoken.length > 6) errs.push(`screen readers hear the readout too often (${spoken.length} times for 12 chunks): ${spoken.join(' / ')}`);
    if (!spoken.some((s) => /Waiting for OpenStreetMap/.test(s)) || !spoken.some((s) => /Downloading/.test(s))) errs.push(`screen readers miss a stage: ${spoken.join(' / ')}`);
    if (!spoken.some((s) => /Waiting for OpenStreetMap.*Usually about 1 to 3 minutes\./.test(s))) errs.push(`screen readers don't hear the estimate: ${spoken.join(' / ')}`);
    const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('spooky-load-times') ?? '[]'));
    if (kept.length !== 1 || kept[0].host !== 'overpass-api.de' || !(kept[0].waitMs >= 3500)) errs.push(`this device's load time wasn't kept for next time: ${JSON.stringify(kept)}`);
    shots.reconAdded = `${out}/wayin-recon-extras-added-desktop.png`;
    await page.screenshot({ path: shots.reconAdded });
    res.push({ type: 'way in: slow server, streamed bytes, extras merge later (desktop)', errors: errs, timing: after.timing, spoken: spoken.join(' / '), shots });
    await page.close();
  }

  // 8a2. With this device's own history (3.26): the estimate says so; past it, "Taking longer than usual".
  //      Forget all saved places forgets the history too. The page clock is fast-forwarded.
  {
    const { page, errs } = await wayInPage(browser, desktop, OSM.none(), null);
    await page.clock.install();
    await page.addInitScript(() => {
      if (!localStorage.getItem('spooky-load-times')) {
        localStorage.setItem('spooky-load-times', JSON.stringify([20, 22, 25].map((s, i) => ({ host: 'overpass-api.de', waitMs: s * 1000, at: i }))));
      }
    });
    await page.addInitScript(slowOsm, slowPlan({ core: { any: 'hang' } }));
    await page.goto(`http://localhost:${PORT}/?screen=scout`);
    await scoutFor(page, 'Test Reef');
    await page.waitForFunction(() => /^Usually about/.test(document.querySelector('.scout-estimate:not([hidden])')?.textContent ?? ''), null, { timeout: 10000 });
    await page.clock.fastForward('00:10');
    await page.waitForTimeout(1200);
    const e1 = await readoutState(page);
    if (!/^Usually about 20–30 s on this device \(last 3 loads\) · 0:1\d so far$/.test(e1.estimate ?? '')) errs.push(`estimate from history: ${e1.estimate}`);
    const shots = { estimate: `${out}/wayin-progress-estimate-desktop.png` };
    await page.screenshot({ path: shots.estimate });
    await page.clock.fastForward('00:30');
    await page.waitForTimeout(1200);
    const e2 = await readoutState(page);
    if (!/^Taking longer than usual · 0:4\d so far$/.test(e2.estimate ?? '') || parseFloat(e2.width) !== 90) errs.push(`past the estimate: ${e2.estimate} (${e2.width})`);
    shots.longer = `${out}/wayin-progress-longer-than-usual-desktop.png`;
    await page.screenshot({ path: shots.longer });
    await page.click('.scout-cancel');
    await page.click('.screen-settings');
    await page.waitForSelector('.settings-forget-places');
    // No place is saved here (it never loaded), so the button may be off: forget through the same path.
    const forgot = await page.evaluate(async () => {
      const b = document.querySelector('.settings-forget-places');
      b.disabled = false;
      b.click();
      await new Promise((r) => setTimeout(r, 300));
      return localStorage.getItem('spooky-load-times');
    });
    if (forgot !== null) errs.push('"Forget all saved places" kept the load times');
    res.push({ type: 'way in: load estimate from this device, then "taking longer than usual"', errors: errs, estimate: e1.estimate, longer: e2.estimate, shots });
    await page.close();
  }

  // 8b. A known size on a phone: a fill that only grows, "x KB of y KB"; reduced motion: a still bar.
  for (const reduced of [false, true]) {
    const { page, errs } = await wayInPage(browser, phone, OSM.none(), null);
    if (reduced) await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(slowOsm, slowPlan({ core: { any: { delay: 2500, chunks: 10, gap: 500, length: true } }, extras: { any: { delay: 500, chunks: 1, gap: 0, length: true } } }));
    await page.goto(`http://localhost:${PORT}/?screen=scout`);
    await scoutFor(page, 'Test Reef', 'click');
    await page.waitForFunction((w) => document.querySelector('.scout-load-text')?.textContent === w, WAITING, { timeout: 10000 });
    const w = await readoutState(page);
    if (w.mode !== 'estimate' || w.anim !== 'none') errs.push(`waiting: the estimate bar (${w.mode}, ${w.anim})`);
    // Reduced motion: the estimate fill moves in whole 10% steps, with no sliding.
    const tr = await page.evaluate(() => getComputedStyle(document.querySelector('.scout-sweep span')).transitionDuration);
    if (reduced && (Math.round(parseFloat(w.width) * 10) % 100 !== 0 || tr !== '0s')) errs.push(`reduced motion: the estimate bar should step (${w.width}, transition ${tr})`);
    await page.waitForFunction(() => /^Downloading… \d+ KB of \d+ KB$/.test(document.querySelector('.scout-load-text')?.textContent ?? ''), null, { timeout: 10000 });
    const widths = [];
    for (let i = 0; i < 4; i++) {
      const s = await readoutState(page);
      if (s.mode === 'determinate') widths.push(parseFloat(s.width));
      await page.waitForTimeout(450);
    }
    if (widths.length < 2 || widths.some((v, i) => !(v >= 0 && v <= 100) || (i && v < widths[i - 1]))) errs.push(`a known size: the fill should only grow, 0–100%: ${widths.join(', ')}`);
    const tag = reduced ? 'phone-reduced-motion' : 'phone';
    const shot = `${out}/wayin-progress-known-size-${tag}.png`;
    await page.screenshot({ path: shot });
    errs.push(...(await overlapCheck(page, '.menu-back', ['.scout .card-kicker', '.scout h1'])));
    await page.waitForSelector('.menu .recon .recon-cards > *', { timeout: 20000 });
    res.push({ type: `way in: download of known size (${tag})`, errors: errs, widths: widths.join(', '), shots: { progress: shot } });
    await page.close();
  }

  // 8c. The first server never answers: after 45 s the game says so and asks the other one (never both at once).
  //     The page clock is fast-forwarded past the limit rather than waited out.
  {
    const { page, errs } = await wayInPage(browser, desktop, OSM.none(), null);
    await page.clock.install();
    await page.addInitScript(slowOsm, slowPlan({
      core: { 'overpass-api.de': 'hang', 'overpass.kumi.systems': { delay: 1500, chunks: 4, gap: 300, length: true } },
      extras: { 'overpass.kumi.systems': { delay: 500, chunks: 1, gap: 0, length: true } },
    }));
    await page.goto(`http://localhost:${PORT}/?screen=scout`);
    await scoutFor(page, 'Test Reef');
    await page.waitForFunction((w) => document.querySelector('.scout-load-text')?.textContent === w, WAITING, { timeout: 10000 });
    await page.clock.fastForward('00:46');
    await page.waitForFunction(() => /kumi/.test(document.querySelector('.scout-server')?.textContent ?? ''), null, { timeout: 10000 });
    const f = await readoutState(page);
    if (!/^No answer from overpass-api\.de within 45 seconds, so now asking overpass\.kumi\.systems$/.test(f.server ?? '')) errs.push(`fallback not explained: ${f.server}`);
    if (!(secs(f.elapsed) >= 46)) errs.push(`elapsed clock after the wait: ${f.elapsed}`);
    const shot = `${out}/wayin-progress-fallback-desktop.png`;
    await page.screenshot({ path: shot });
    await page.waitForSelector('.menu .recon .recon-cards > *', { timeout: 20000 });
    await extrasSettled(page).catch(() => errs.push('extras never settled after a fallback'));
    const calls = await page.evaluate(() => window.__osm.filter((c) => c.part !== 'geocode' && !c.aborted));
    const order = calls.map((c) => `${c.part}@${c.host}`).join(', ');
    if (order !== 'core@overpass-api.de, core@overpass.kumi.systems, extras@overpass.kumi.systems') errs.push(`servers asked: ${order}`);
    if (calls.length >= 2 && calls[1].at - calls[0].at < 45000) errs.push(`the second server was asked before the first one's 45 s were up (${calls[1].at - calls[0].at} ms)`);
    const timing = await page.textContent('.recon .recon-timing');
    if (!/^Loaded in [\d:.]+(?: s)? \(server 4\d s, .* from overpass\.kumi\.systems/.test(timing ?? '')) errs.push(`timing line after a fallback: ${timing}`);
    res.push({ type: 'way in: first server times out, the other answers', errors: errs, order, timing, shots: { fallback: shot } });
    await page.close();
  }

  // 8e. Still nothing at 2:00: nothing is stopped; the player is asked (Keep waiting, the default; the sample
  //     town; Cancel). Keep waiting and a late answer still loads the map; if nobody ever answers, the busy
  //     message comes at the final limit (45 s + 300 s). The page clock is fast-forwarded.
  for (const ending of ['late answer', 'never answers', 'sample town']) {
    const { page, errs } = await wayInPage(browser, desktop, OSM.none(), null);
    await page.clock.install();
    const kumi = ending === 'late answer' ? { delay: 150_000, chunks: 3, gap: 200, length: true } : 'hang';
    await page.addInitScript(slowOsm, slowPlan({ core: { 'overpass-api.de': 'hang', 'overpass.kumi.systems': kumi }, extras: { any: { delay: 200, chunks: 1, gap: 0, length: true } } }));
    await page.goto(`http://localhost:${PORT}/?screen=scout`);
    await scoutFor(page, 'Test Reef');
    await page.waitForFunction((w) => document.querySelector('.scout-load-text')?.textContent === w, WAITING, { timeout: 10000 });
    await page.clock.fastForward('01:50');
    if (await page.$('.scout-ask:not([hidden])')) errs.push('asked before 2:00');
    await page.clock.fastForward('00:11');
    await page.waitForSelector('.scout-ask:not([hidden])', { timeout: 5000 }).catch(() => errs.push('no choice at 2:00'));
    const askSt = await page.evaluate(() => ({
      text: document.querySelector('.scout-ask-text')?.textContent ?? '',
      buttons: [...document.querySelectorAll('.scout-ask button')].map((b) => [b.textContent, Math.round(b.getBoundingClientRect().height)]),
      focused: document.activeElement?.textContent ?? '',
      aborted: window.__osm.filter((c) => c.aborted).map((c) => c.host),
      plainCancel: !document.querySelector('.scout-cancel')?.hidden,
    }));
    if (!/^Still waiting for OpenStreetMap \(2:0\d\)\.$/.test(askSt.text)) errs.push(`choice text: ${askSt.text}`);
    if (JSON.stringify(askSt.buttons.map((b) => b[0])) !== '["Keep waiting","Try the sample town","Cancel"]' || askSt.buttons.some((b) => b[1] < 48)) errs.push(`choice buttons: ${JSON.stringify(askSt.buttons)}`);
    if (askSt.focused !== 'Keep waiting') errs.push(`Keep waiting isn't the default: focus on "${askSt.focused}"`);
    if (askSt.aborted.join() !== 'overpass-api.de') errs.push(`at 2:00 only the first server's 45 s wait should have been stopped: ${askSt.aborted.join()}`);
    if (askSt.plainCancel) errs.push('two Cancel buttons while asking');
    const shots = {};
    if (ending === 'late answer') {
      shots.ask = `${out}/wayin-progress-still-waiting-desktop.png`;
      await page.screenshot({ path: shots.ask });
    }
    if (ending === 'sample town') {
      await page.click('.scout-ask-sample');
      await page.waitForSelector('.menu .recon .mission-card', { timeout: 10000 });
      const name = await page.textContent('.recon h2');
      if (/Test Reef/.test(name ?? '')) errs.push('"Try the sample town" opened the typed place');
      const stopped = await page.evaluate(() => window.__osm.filter((c) => c.aborted && c.host === 'overpass.kumi.systems').length);
      if (stopped !== 1) errs.push('"Try the sample town" left the download running');
    } else {
      await page.click('.scout-keep');
      const after = await page.evaluate(() => ({ ask: !document.querySelector('.scout-ask')?.hidden, cancel: !document.querySelector('.scout-cancel')?.hidden, loading: !document.querySelector('.scout-progress')?.hidden }));
      if (after.ask || !after.cancel || !after.loading) errs.push(`after Keep waiting: ${JSON.stringify(after)}`);
      if (ending === 'late answer') {
        await page.clock.fastForward('02:30'); // kumi answers 150 s after it was asked (asked once the jump past 45 s fired)
        await page.waitForSelector('.menu .recon .recon-cards > *', { timeout: 20000 }).catch(() => errs.push('a late answer after Keep waiting did not load the map'));
        const timing = await page.textContent('.recon .recon-timing').catch(() => '');
        if (!/^Loaded in [3-5]:\d\d \(server [3-5]:\d\d, /.test(timing ?? '')) errs.push(`timing after a long wait: ${timing}`);
      } else {
        await page.clock.fastForward('03:40'); // to 5:41: still within the final limit
        if (await page.$('.scout-msg:not([hidden])')) errs.push('gave up before the final limit');
        await page.clock.fastForward('00:10');
        await page.waitForSelector('.scout-msg:not([hidden])', { timeout: 10000 }).catch(() => undefined);
        const st = await scoutState(page);
        if (!MSG.busy.test(st.msg ?? '') || st.role !== 'alert' || st.recon) errs.push(`final limit: ${JSON.stringify(st)}`);
        shots.busy = `${out}/wayin-progress-final-busy-desktop.png`;
        await page.screenshot({ path: shots.busy });
      }
    }
    res.push({ type: `way in: still waiting at 2:00 (${ending})`, errors: errs, shots });
    await page.close();
  }

  // 8d. The extras fail: nothing to see. No error, no alert, and the same missions.
  {
    const { page, errs } = await wayInPage(browser, desktop, OSM.none(), null);
    await page.addInitScript(slowOsm, slowPlan({ core: { any: { delay: 300, chunks: 2, gap: 100, length: true } }, extras: { any: 'fail' } }));
    await page.goto(`http://localhost:${PORT}/?screen=scout`);
    await scoutFor(page, 'Test Reef');
    await page.waitForSelector('.menu .recon .recon-cards > *', { timeout: 20000 });
    const before = await missionTitles(page);
    await extrasSettled(page).catch(() => errs.push('failed extras left a note on screen'));
    await page.waitForTimeout(300);
    const st = await page.evaluate(() => ({
      alerts: [...document.querySelectorAll('[role=alert]')].filter((e) => !e.closest('[hidden]') && e.textContent?.trim()).map((e) => e.textContent),
      note: document.querySelector('.recon .recon-extras:not([hidden])')?.textContent ?? null,
      recon: !!document.querySelector('.menu .recon'),
      extrasAsked: window.__osm.filter((c) => c.part === 'extras').length,
    }));
    if (st.alerts.length || st.note || !st.recon) errs.push(`failed extras weren't silent: ${JSON.stringify(st)}`);
    if (st.extrasAsked < 1 || st.extrasAsked > 2) errs.push(`extras asked ${st.extrasAsked} times (one per server at most)`);
    if ((await missionTitles(page)) !== before) errs.push('failed extras changed the missions');
    res.push({ type: 'way in: extras fail silently', errors: errs });
    await page.close();
  }
  return res;
}

// ---------- Briefing walk-through ("Hello, home", 3.7) ----------
// For clear, escort, defend and a recon mission, at 1280x720 and 390x844: the tour visits every stop
// in order (area first, orbit last), each stop is screenshotted held still at mid-hold, the diorama's
// labels never overlap (checked at each stop and sampled through a real run), Skip works (button, Space,
// Enter), dragging the model hands it to the player, Start mission stays available, controls are at
// least 48 px. Reduced motion: a stepped list with Back / Next that cuts (no animation). Then 20
// briefing → mission → retry cycles must not leak WebGL contexts or dioramas.
// (Function declarations, not consts: the checks run from the top-level code above, before this line.)
function tourRank(id) {
  return { area: 0, safehouse: 1, home: 1, survivors: 2, friendlies: 2, stragglers: 2, horde: 3, wave: 3, route: 3, orbit: 4 }[id.replace(/\d+$/, '')];
}

async function tourPage(browser, viewport, extra = {}) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: scale, ...extra });
  const errs = [];
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  page.on('pageerror', (e) => errs.push(String(e)));
  // Pointer lock collapses the headless frame rate; Start mission asks for it.
  await page.addInitScript(() => {
    Element.prototype.requestPointerLock = () => Promise.resolve();
  });
  return { page, errs };
}

/** Opens a mission's briefing: a URL mission, or 'recon' (the first suggested mission on the sample town's recon screen). */
async function openBriefing(page, which) {
  if (which === 'recon') {
    await page.goto(`http://localhost:${PORT}/?screen=recon`);
    await page.waitForSelector('.menu .recon .mission-card');
    await page.click('.recon .mission-card button.primary');
  } else {
    await page.goto(`http://localhost:${PORT}/?autostart=1&type=${which}&difficulty=3&seed=7&brief=1`);
  }
  await page.waitForSelector('.card.briefing .tour', { timeout: 30000 });
  return page.textContent('.card.briefing h2');
}

/** Pairs of diorama labels that overlap on screen (should be none). */
function labelOverlaps(page) {
  return page.evaluate(() => {
    const rs = [...document.querySelectorAll('.dio-label.on')].map((e) => ({ t: e.textContent, r: e.getBoundingClientRect() }));
    const bad = [];
    for (let i = 0; i < rs.length; i++)
      for (let j = i + 1; j < rs.length; j++) {
        const a = rs[i].r;
        const b = rs[j].r;
        if (a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5) bad.push(`${rs[i].t} / ${rs[j].t}`);
      }
    return bad;
  });
}

function tourState(page) {
  return page.evaluate(() => {
    const t = document.querySelector('.tour');
    return t ? { ...t.dataset, caption: t.querySelector('.tour-cap')?.textContent ?? '', step: t.querySelector('.tour-step')?.textContent ?? '' } : null;
  });
}

async function tourChecks(browser) {
  const res = [];
  try {
    await tourCheckRuns(browser, res);
  } catch (e) {
    // Keep what already ran; report the failure as a check, not a crash.
    res.push({ type: 'briefing walk-through: checks stopped', errors: [String(e).split('\n')[0]], shots: {} });
  }
  return res;
}

async function tourCheckRuns(browser, res) {
  for (const which of ['clear', 'escort', 'defend', 'recon']) {
    for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
      const { page, errs } = await tourPage(browser, viewport);
      const shots = {};
      const tag = `${which}-${viewport.width}`;
      const title = await openBriefing(page, which);
      await page.waitForSelector('.tour[data-state="playing"]', { timeout: 15000 }).catch(() => errs.push('the tour did not start on its own'));
      const st0 = await tourState(page);
      const stops = (st0?.stops ?? '').split(',');
      if (stops[0] !== 'area' || stops[stops.length - 1] !== 'orbit') errs.push(`stops should run area … orbit: ${stops}`);
      for (let i = 1; i < stops.length; i++) if (tourRank(stops[i]) < tourRank(stops[i - 1])) errs.push(`stop ${stops[i]} out of order: ${stops}`);
      const total = Number(st0?.total);
      if (!(total >= 15 && total <= 20)) errs.push(`tour is ${total} s (15–20 s wanted)`);
      const startBtn = await page.$('.card.briefing > button.primary');
      if (!startBtn || !(await startBtn.isVisible()) || !(await startBtn.isEnabled())) errs.push('Start mission is not available during the tour');
      const small = await page.$$eval('.tour-btn', (bs) => bs.filter((b) => b.getBoundingClientRect().height < 48 || b.getBoundingClientRect().width < 48).map((b) => b.textContent));
      if (small.length) errs.push(`tour buttons under 48 px: ${small}`);

      // 1. Each stop, held still at mid-hold: right caption, a highlight, no overlapping labels. Screenshot.
      const times = await page.evaluate(() => document.querySelector('.tour').tourHook.times());
      await page.evaluate(() => document.querySelector('.tour').tourHook.freeze(true));
      const captions = [];
      for (let i = 0; i < stops.length; i++) {
        const s = times[i];
        await page.evaluate((t) => document.querySelector('.tour').tourHook.seek(t), s.t0 + s.move + s.hold * 0.6);
        await page.waitForTimeout(700);
        const st = await tourState(page);
        if (Number(st.index) !== i || st.stop !== stops[i]) errs.push(`seek to stop ${i} shows ${st.stop}`);
        if (!st.caption.trim()) errs.push(`stop ${stops[i]} has no caption`);
        captions.push(st.caption);
        const hl = await page.evaluate(() => document.querySelectorAll('.tmap-tour > *').length);
        if (!hl) errs.push(`stop ${stops[i]}: nothing highlighted on the tactical map`);
        const ov = await labelOverlaps(page);
        if (ov.length) errs.push(`stop ${stops[i]}: labels overlap: ${ov.join('; ')}`);
        await (await page.$('.briefing-visuals')).scrollIntoViewIfNeeded();
        shots[stops[i]] = `${out}/tour-${tag}-${i + 1}-${stops[i]}.png`;
        await page.screenshot({ path: shots[stops[i]] });
      }

      // 2. A real run (clock x3: the headless machine draws slowly), labels sampled as it flies.
      await page.evaluate(() => {
        const h = document.querySelector('.tour').tourHook;
        h.freeze(false);
        h.rate(3);
        h.seek(0);
      });
      const t0 = Date.now();
      let samples = 0;
      while (Date.now() - t0 < 90000) {
        const st = await tourState(page);
        if (st.state !== 'playing') break;
        const ov = await labelOverlaps(page);
        samples++;
        if (ov.length) errs.push(`labels overlap mid-flight at ${st.stop}: ${ov.join('; ')}`);
        await page.waitForTimeout(200);
      }
      const done = await tourState(page);
      if (done.ended !== 'end') errs.push(`the tour didn't end on its own (ended: ${done.ended}, state ${done.state})`);
      if (done.visited !== stops.join(',')) errs.push(`visited ${done.visited}, expected ${stops.join(',')}`);
      if (!(await page.$('.tour-replay'))) errs.push('no Replay after the tour');

      // 3. Skip: Space and Enter (focus on the page), then the button. 4. Dragging the model hands over.
      const replay = async () => {
        await page.click('.tour-replay');
        await page.waitForSelector('.tour[data-state="playing"]');
        await page.evaluate(() => document.activeElement?.blur());
      };
      for (const key of ['Space', 'Enter']) {
        await replay();
        await page.keyboard.press(key);
        const st = await tourState(page);
        if (st.ended !== 'skip' || st.state !== 'done') errs.push(`${key} didn't skip (${st.state}, ${st.ended})`);
        if (!(await page.$('.card.briefing'))) errs.push(`${key} left the briefing`);
      }
      await replay();
      await page.click('.tour-skip');
      if ((await tourState(page)).ended !== 'skip') errs.push('the Skip button did not skip');
      if (await page.isVisible('.dio-canvas')) {
        await replay();
        const box = await (await page.$('.dio-canvas')).boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 4 });
        await page.mouse.up();
        const st = await tourState(page);
        if (st.ended !== 'interrupt' || st.state !== 'done') errs.push(`dragging didn't hand over (${st.state}, ${st.ended})`);
      }
      const info = await page.evaluate(() => ({ buildMs: Number(document.querySelector('.dio')?.dataset.buildMs), drawCalls: Number(document.querySelector('.dio')?.dataset.drawCalls) }));
      res.push({ type: `briefing walk-through: ${which} (${viewport.width}x${viewport.height})`, title, stops: stops.join(' → '), total, captions, labelSamples: samples, ...info, errors: errs, shots });
      await page.close();
    }
  }

  // 5. Reduced motion: no flight. A stepped list, Back / Next cut between framings, nothing moves on its own.
  {
    const { page, errs } = await tourPage(browser, { width: 1280, height: 720 }, { reducedMotion: 'reduce' });
    await openBriefing(page, 'defend');
    await page.waitForSelector('.tour[data-state="steps"]', { timeout: 15000 }).catch(() => errs.push('no stepped list under reduced motion'));
    const st = await tourState(page);
    const n = (st?.stops ?? '').split(',').length;
    const list = await page.evaluate(() => ({ shown: getComputedStyle(document.querySelector('.tour-list')).display !== 'none', items: document.querySelectorAll('.tour-item').length }));
    if (!list.shown || list.items !== n) errs.push(`stepped list: ${JSON.stringify(list)}`);
    if (!(await page.isDisabled('.tour-back'))) errs.push('Back should be disabled on the first stop');
    const stage = await page.$('.dio-stage');
    const shots = { first: `${out}/tour-reduced-1.png` };
    await page.screenshot({ path: shots.first });
    const still = async (label) => {
      await page.waitForTimeout(400);
      const a = await stage.screenshot();
      await page.waitForTimeout(700);
      const b = await stage.screenshot();
      if (!a.equals(b)) errs.push(`the picture moved on its own (${label})`);
    };
    await still('stop 1');
    for (let i = 1; i <= n; i++) {
      await page.click('.tour-next');
      const s = await tourState(page);
      if (i < n && Number(s.index) !== i) errs.push(`Next went to ${s.index}, not ${i}`);
      if (i === 2) {
        await still(`stop ${i + 1}`);
        shots.step = `${out}/tour-reduced-${i + 1}.png`;
        await page.screenshot({ path: shots.step });
      }
      const ov = await labelOverlaps(page);
      if (ov.length) errs.push(`labels overlap at step ${i}: ${ov.join('; ')}`);
    }
    if ((await tourState(page)).step !== 'Whole area') errs.push('Next past the last stop should show the whole area');
    await page.click('.tour-back');
    if (Number((await tourState(page)).index) !== n - 1) errs.push('Back from the whole area should return to the last stop');
    res.push({ type: 'briefing walk-through: reduced motion (stepped list)', errors: errs, shots });
    await page.close();
  }

  // 6. Leaks: 20 × (briefing with the tour → Start mission → Esc → Restart mission (pause menu)). One diorama context at a time.
  {
    const { page, errs } = await tourPage(browser, { width: 1280, height: 720 });
    await page.addInitScript(() => {
      window.__ctx = { made: 0, lost: 0 };
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, attrs) {
        const c = orig.call(this, type, attrs);
        if (c && /webgl/.test(type) && !this.__counted) {
          this.__counted = true;
          window.__ctx.made++;
          this.addEventListener('webglcontextlost', () => window.__ctx.lost++);
        }
        return c;
      };
    });
    await openBriefing(page, 'defend');
    const snap = () =>
      page.evaluate(() => ({ ...window.__ctx, dioramas: document.querySelectorAll('.dio-canvas').length, tours: document.querySelectorAll('.tour').length, tourLayers: document.querySelectorAll('.tmap-tour').length, nodes: document.getElementsByTagName('*').length, heapMB: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1e5) / 10 }));
    const before = await snap();
    const t0 = Date.now();
    let cycles = 0;
    try {
      for (let i = 0; i < 20; i++) {
        await page.waitForSelector('.tour');
        // A retried mission's briefing starts with the tour done (seen already): replay it, fly a little, start.
        if (i > 0 && (await tourState(page)).state !== 'done') errs.push(`retry ${i}: the tour should start done (seen), not ${(await tourState(page)).state}`);
        if (await page.$('.tour-replay')) await page.click('.tour-replay');
        await page.waitForTimeout(300);
        await page.click('.card.briefing > button.primary');
        // Start mission disposes the walk-through and the diorama (the card itself is only hidden).
        await page.waitForFunction(() => !document.querySelector('.tour') && !document.querySelector('.dio-canvas'), null, { timeout: 15000 });
        await page.keyboard.press('Escape');
        await page.waitForSelector('.overlay .card h2:has-text("Paused")', { timeout: 10000 });
        await page.click('.pause-restart'); // since 3.11 R is the gun key; Restart is a pause-menu button
        await page.waitForSelector('.card.briefing .tour', { timeout: 30000 });
        cycles++;
      }
    } catch (e) {
      errs.push(`cycle ${cycles + 1}: ${String(e).split('\n')[0]}`);
    }
    const after = await snap();
    const alive = (s) => s.made - s.lost;
    if (alive(after) > alive(before)) errs.push(`WebGL contexts alive grew from ${alive(before)} to ${alive(after)}`);
    if (after.dioramas !== 1 || after.tours !== 1 || after.tourLayers !== 1) errs.push(`after 20 cycles: ${after.dioramas} dioramas, ${after.tours} tours, ${after.tourLayers} map layers`);
    if (after.nodes > before.nodes * 1.2 + 50) errs.push(`DOM grew from ${before.nodes} to ${after.nodes} nodes`);
    res.push({ type: 'briefing walk-through: 20 briefing → mission → retry cycles', cycles, before, after, seconds: Math.round((Date.now() - t0) / 1000), errors: errs, shots: {} });
    await page.close();
  }
  return res;
}

// ---------- Controls (3.11): key map, pause menu, hotkey strip, touch controls ----------
// Desktop: the key-hints strip is on screen, readable and clear of the HUD panels and the OSM credit; R cycles
// the gun, Q the view; Esc opens the pause menu, whose Briefing re-opens the briefing and comes back; the
// strip can be hidden in Settings. Touch (phone and tablet, portrait
// and landscape, emulated with hasTouch/isMobile and driven with real touch events): the stick moves the aim,
// FIRE fires (together with the stick), GUN and VIEW cycle, tap aims, pinch and ZOOM zoom, the pause button
// pauses; controls are 48 px or more and clear of the HUD panels; the page never scrolls; menus have 44 px+
// tap targets.
// (Functions, not consts: the checks run from top-level await above, before any const down here exists.)
function hudPanels() {
  return ['.hud-weapons', '.hud-minimap', '.hud-mission', '.hud-radio', '.hud-attrib', '.hud-sensor'];
}

/** Boxes of `sel` (all matches) that overlap any visible box of `others`. */
function overlaps(page, sel, others) {
  return page.evaluate(([sel, others]) => {
    const vis = (e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden' ? r : null;
    };
    const found = [];
    for (const a of document.querySelectorAll(sel)) {
      const ra = vis(a);
      if (!ra) continue;
      for (const o of others) {
        for (const b of document.querySelectorAll(o)) {
          if (b === a || a.contains(b) || b.contains(a)) continue;
          const rb = vis(b);
          if (!rb) continue;
          if (ra.left < rb.right && ra.right > rb.left && ra.top < rb.bottom && ra.bottom > rb.top) {
            found.push(`${a.className || sel} overlaps ${o} (${[ra, rb].map((r) => `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`).join(' / ')})`);
          }
        }
      }
    }
    return found;
  }, [sel, others]);
}

function info(page) {
  return page.evaluate(() => window.__spooky.info());
}
function waitInfo(page, fn, arg, timeout = 30000) {
  return page.waitForFunction(fn, arg, { timeout, polling: 50 });
}
/** Point the aim at the live zombie farthest from any friendly, so test fire never ends the mission in friendly fire. */
function aimAway(page) {
  return page.evaluate(() => {
    const fs = window.__spooky.survivors();
    const far = (z) => Math.min(1e9, ...fs.map((f) => Math.hypot(f.x - z.x, f.z - z.z)));
    const z = window.__spooky.zombies().sort((a, b) => far(b) - far(a))[0];
    if (z) window.__spooky.aimAt(z.x, z.z);
  });
}
/** Wait `s` seconds of game time (a busy, software-rendered machine can run far slower than real time). */
/** Wait (up to `timeout` ms of real time) until the aim has moved from `from`; returns quietly if it never does. */
function aimMoved(page, from, timeout = 10000) {
  return page
    .waitForFunction((f) => {
      const a = window.__spooky.info().aim;
      return Math.hypot(a.x - f.x, a.z - f.z) > 0.01;
    }, from, { timeout, polling: 50 })
    .catch(() => undefined);
}
async function waitGame(page, s) {
  await untilGameTime(page, (await gameTime(page)) + s);
}

async function controlsChecks(browser) {
  const res = [];
  // ----- Desktop -----
  for (const viewport of [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
    const name = `${viewport.width}x${viewport.height}`;
    const { page, errs } = await gamePage(browser, 'autostart=1&type=escort&difficulty=1&seed=3', { viewport });
    page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    const out_ = { type: `controls: desktop keys and hotkey strip (${name})`, errors: errs, shots: {} };
    try {
      // The radio's "cleared hot" line is up, so the caption box is in the overlap check.
      await page.waitForSelector('.hud-radio div');
      const strip = await page.evaluate(() => {
        const k = document.querySelector('.hud-keys');
        const r = k.getBoundingClientRect();
        const cs = getComputedStyle(k);
        return { text: k.textContent, visible: r.width > 0 && cs.display !== 'none', font: parseFloat(cs.fontSize), color: cs.color, bg: cs.backgroundColor, inView: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, clipped: k.scrollWidth > k.clientWidth + 1 };
      });
      out_.strip = strip.text;
      if (!strip.visible) errs.push('hotkey strip not visible on desktop');
      for (const want of ['R weapon', 'Q view', 'Esc menu', 'Z zoom']) if (!strip.text.includes(want)) errs.push(`hotkey strip lacks "${want}": ${strip.text}`);
      if (strip.font < 12) errs.push(`hotkey strip text ${strip.font}px (min 12)`);
      if (!strip.inView || strip.clipped) errs.push('hotkey strip is cut off');
      // Contrast, worst case: the strip's dark backing over a pure white-hot picture.
      const rgb = (s) => (s.match(/[\d.]+/g) ?? []).map(Number);
      const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      const [br, bg_, bb, ba = 1] = rgb(strip.bg);
      const back = [br, bg_, bb].map((c) => c * ba + 255 * (1 - ba));
      const contrast = (lum(rgb(strip.color)) + 0.05) / (lum(back) + 0.05);
      out_.contrast = Number(contrast.toFixed(2));
      if (contrast < 4.5) errs.push(`hotkey strip contrast ${contrast.toFixed(2)}:1 over a white picture (min 4.5)`);
      errs.push(...(await overlaps(page, '.hud-keys', hudPanels())));
      const touchOn = (await info(page)).touch;
      if (touchOn) errs.push('touch controls are on with a mouse and keyboard');
      out_.shots.hud = `${out}/controls-desktop-${name}.png`;
      await page.screenshot({ path: out_.shots.hud });

      if (viewport.width === 1280) {
        // R cycles the gun (25 → 40 → 105 → 25); 1/2/3 still pick directly.
        await page.keyboard.press('1');
        const guns = [(await info(page)).weapon];
        for (let i = 0; i < 3; i++) {
          await page.keyboard.press('r');
          guns.push((await info(page)).weapon);
        }
        out_.rCycle = guns.join(' → ');
        if (guns.join() !== '25,40,105,25') errs.push(`R cycled the guns ${out_.rCycle}`);
        // Q cycles the view: white-hot → black-hot → night vision → white-hot.
        const views = [];
        const view = async () => {
          const i = await info(page);
          return i.sensor === 'night' ? 'NV' : i.polarity ? 'BH' : 'WH';
        };
        views.push(await view());
        for (let i = 0; i < 3; i++) {
          await page.keyboard.press('q');
          await waitGame(page, 0.9); // past the 0.7 s camera switch and the 0.35 s flip limit
          views.push(await view());
        }
        out_.qCycle = views.join(' → ');
        if (views.join() !== 'WH,BH,NV,WH') errs.push(`Q cycled the views ${out_.qCycle}`);
        // Esc: the pause menu, with Briefing (read-only) and back.
        await page.keyboard.press('Escape');
        await waitInfo(page, () => window.__spooky.info().screen === 'paused');
        const buttons = await page.$$eval('.overlay .card button', (bs) => bs.map((b) => b.textContent));
        out_.pauseMenu = buttons;
        for (const b of ['Resume', 'Briefing', 'Restart mission', 'Settings', 'Quit to menu']) if (!buttons.includes(b)) errs.push(`pause menu lacks ${b}: ${buttons.join(', ')}`);
        await page.click('.overlay .pause-briefing');
        await page.waitForSelector('.overlay .card.briefing .briefing-back');
        const brief = await page.evaluate(() => ({ title: document.querySelector('.overlay .card.briefing h2')?.textContent, start: !![...document.querySelectorAll('.overlay button')].find((b) => b.textContent === 'Start mission'), keys: document.querySelector('.overlay .card.briefing p.small')?.textContent ?? '' }));
        if (!brief.title) errs.push('the pause menu briefing has no title');
        if (brief.start) errs.push('the re-opened briefing offers "Start mission" (should be read-only)');
        if (!/R or 1\/2\/3/.test(brief.keys) || !/Q cycle view/.test(brief.keys)) errs.push(`briefing keys line not updated: ${brief.keys}`);
        out_.shots.briefing = `${out}/controls-pause-briefing.png`;
        await page.screenshot({ path: out_.shots.briefing });
        await page.waitForTimeout(400);
        await page.keyboard.press('Escape'); // back to the pause card
        await page.waitForFunction(() => document.querySelector('.overlay .card.pause h2')?.textContent === 'Paused', null, { timeout: 5000 });
        if ((await info(page)).screen !== 'paused') errs.push('Esc from the briefing left the pause screen');
        await page.click('.overlay .pause-briefing');
        await page.click('.overlay .briefing-back');
        await page.waitForSelector('.overlay .card.pause');
        out_.shots.pause = `${out}/controls-pause.png`;
        await page.screenshot({ path: out_.shots.pause });
        // R on the pause screen no longer restarts (R is the gun key).
        const tBefore = await gameTime(page);
        await page.keyboard.press('r');
        await page.waitForTimeout(400);
        if ((await info(page)).screen !== 'paused' || (await gameTime(page)) < tBefore) errs.push('R on the pause screen did something');
        // Settings: turn the key hints off; the strip hides.
        await page.click('.overlay button:has-text("Settings")');
        await page.click('.settings-panel label:has-text("Show key hints")');
        await page.click('.settings-panel button:has-text("Done")');
        await page.waitForTimeout(400);
        await page.keyboard.press('Escape'); // resume
        await waitInfo(page, () => window.__spooky.info().screen === 'playing');
        const hidden = await page.evaluate(() => getComputedStyle(document.querySelector('.hud-keys')).display === 'none');
        if (!hidden) errs.push('hotkey strip still showing after turning key hints off');
        await page.evaluate(() => localStorage.removeItem('spooky.settings'));
      }
    } catch (e) {
      errs.push(String(e));
    }
    res.push(out_);
    await page.close();
  }

  // ----- Touch: phones and tablets, both ways up -----
  const touchViews = [
    ['phone-portrait', { width: 390, height: 844 }, true],
    ['phone-landscape', { width: 844, height: 390 }, true],
    ['tablet-landscape', { width: 1024, height: 768 }, false],
    ['tablet-portrait', { width: 768, height: 1024 }, false],
  ];
  for (const [name, viewport, full] of touchViews) {
    const { page, errs } = await gamePage(browser, 'autostart=1&type=escort&difficulty=1&seed=3', { viewport, hasTouch: true, isMobile: true });
    page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    const out_ = { type: `controls: touch (${name})`, errors: errs, shots: {} };
    try {
      const cdp = await page.context().newCDPSession(page);
      const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id: id + 1, radiusX: 4, radiusY: 4, force: 1 })) });
      const centre = (sel) => page.evaluate((s) => {
        const r = document.querySelector(s)?.getBoundingClientRect();
        return r && r.width ? [r.left + r.width / 2, r.top + r.height / 2] : null;
      }, sel);
      // A tap lifted 80 ms after touching, with those times on the events as a real screen stamps them. Without
      // times, Chrome stamps each event when the (busy, software-rendered) page gets round to it, and a quick tap
      // can look over a second long, so it no longer counts as a tap.
      const tapAt = async ([x, y]) => {
        const t = Date.now() / 1000;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', timestamp: t, touchPoints: [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', timestamp: t + 0.08, touchPoints: [] });
        await page.waitForTimeout(150);
      };
      out_.coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
      if (!(await info(page)).touch) {
        // Not detected up front: the first touch must switch the controls on.
        await tapAt([viewport.width / 2, viewport.height * 0.3]);
      }
      if (!(await info(page)).touch) errs.push('touch controls did not come on');
      await page.waitForSelector('.touch-controls:not([hidden]) .tc-fire');
      await page.waitForSelector('.hud-radio div');
      await page.waitForTimeout(300);
      out_.shots.controls = `${out}/controls-touch-${name}.png`;
      await page.screenshot({ path: out_.shots.controls });
      // Layout: targets 48 px+, nothing over the HUD panels or the OSM credit, credit on screen, no scrolling.
      const layout = await page.evaluate(() => {
        const boxes = [...document.querySelectorAll('.tc-btn, .tc-stick')].map((b) => [b.className, b.getBoundingClientRect()]);
        const small = boxes.filter(([, r]) => r.width < 48 || r.height < 48).map(([c, r]) => `${c} ${Math.round(r.width)}x${Math.round(r.height)}`);
        const off = boxes.filter(([, r]) => r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight).map(([c]) => c);
        const a = document.querySelector('.hud-attrib').getBoundingClientRect();
        const keys = document.querySelector('.hud-keys');
        return {
          small,
          off,
          attrib: a.width > 0 && a.left >= 0 && a.right <= innerWidth && a.bottom <= innerHeight,
          keysShown: getComputedStyle(keys).display !== 'none',
          scroll: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight || scrollX !== 0 || scrollY !== 0,
          touchAction: getComputedStyle(document.querySelector('.game-canvas')).touchAction,
        };
      });
      if (layout.small.length) errs.push(`touch targets under 48 px: ${layout.small.join(', ')}`);
      if (layout.off.length) errs.push(`touch controls off screen: ${layout.off.join(', ')}`);
      if (!layout.attrib) errs.push('OpenStreetMap credit not fully on screen');
      if (layout.keysShown) errs.push('hotkey strip showing with touch controls');
      if (layout.scroll) errs.push('page scrolls');
      if (layout.touchAction !== 'none') errs.push(`game surface touch-action is ${layout.touchAction}`);
      errs.push(...(await overlaps(page, '.tc-stick, .tc-btn', hudPanels())));

      // GUN cycles the gun.
      const gunAt = await centre('.tc-gun');
      const guns = [(await info(page)).weapon];
      for (let i = 0; i < 3; i++) {
        await tapAt(gunAt);
        guns.push((await info(page)).weapon);
      }
      out_.gunCycle = guns.join(' → ');
      if (guns.join() !== '40,105,25,40') errs.push(`GUN cycled ${out_.gunCycle}`);
      await page.waitForTimeout(100);
      const gunLabel = await page.evaluate(() => document.querySelector('.tc-gun .tc-sub')?.textContent);
      if (gunLabel !== '40') errs.push(`GUN button label ${gunLabel}, gun is 40`);
      if (full) {
        // VIEW cycles white-hot → black-hot → night vision → white-hot.
        const viewAt = await centre('.tc-view');
        const view = async () => {
          const i = await info(page);
          return i.sensor === 'night' ? 'NV' : i.polarity ? 'BH' : 'WH';
        };
        const views = [await view()];
        for (let i = 0; i < 3; i++) {
          await tapAt(viewAt);
          await waitGame(page, 0.9);
          views.push(await view());
        }
        out_.viewCycle = views.join(' → ');
        if (views.join() !== 'WH,BH,NV,WH') errs.push(`VIEW cycled ${out_.viewCycle}`);
        // ZOOM toggles; pinch spreads in and closes out.
        const zoomAt = await centre('.tc-zoom');
        await tapAt(zoomAt);
        const z1 = (await info(page)).zoom;
        await tapAt(zoomAt);
        const z2 = (await info(page)).zoom;
        if (z1 !== true || z2 !== false) errs.push(`ZOOM button: ${z1}, ${z2} (expected on, then off)`);
        const cx = viewport.width / 2;
        const cy = viewport.height * 0.4;
        const pinch = async (from, to) => {
          await touch('touchStart', [[cx - from, cy]]);
          await touch('touchStart', [[cx - from, cy], [cx + from, cy]]);
          for (let k = 1; k <= 8; k++) {
            const d = from + ((to - from) * k) / 8;
            await touch('touchMove', [[cx - d, cy], [cx + d, cy]]);
            await page.waitForTimeout(30);
          }
          await touch('touchEnd', []);
          await page.waitForTimeout(150);
        };
        const aimBeforePinch = (await info(page)).aim;
        await pinch(40, 110);
        const zin = (await info(page)).zoom;
        await pinch(110, 40);
        const zout = (await info(page)).zoom;
        if (zin !== true || zout !== false) errs.push(`pinch: spread gave zoom ${zin}, close gave ${zout}`);
        const aimAfterPinch = (await info(page)).aim;
        if (Math.hypot(aimAfterPinch.x - aimBeforePinch.x, aimAfterPinch.z - aimBeforePinch.z) > 1) errs.push('a pinch moved the aim (it should only zoom)');
      }
      // Stick and FIRE together (multi-touch): the aim moves and the gun fires (from a spot clear of friendlies).
      await aimAway(page);
      const stickAt = await centre('.tc-stick');
      const fireAt = await centre('.tc-fire');
      const before = await info(page);
      const shots0 = await page.evaluate(() => window.__spooky.state().shots);
      const t0 = await gameTime(page);
      await touch('touchStart', [stickAt]);
      await touch('touchStart', [stickAt, fireAt]);
      // Half deflection for under a second: enough to see the aim move, not enough to wander onto friendlies.
      for (let k = 1; k <= 6; k++) {
        await touch('touchMove', [[stickAt[0] + 5 * k, stickAt[1] - 3 * k], fireAt]);
        await page.waitForTimeout(40);
      }
      await untilGameTime(page, t0 + 0.9);
      const firingMid = await page.evaluate(() => document.querySelector('.tc-fire').classList.contains('down'));
      await touch('touchEnd', []);
      await page.waitForTimeout(200);
      const after = await info(page);
      const shots1 = await page.evaluate(() => window.__spooky.state().shots);
      out_.stickMovedMetres = Math.round(Math.hypot(after.aim.x - before.aim.x, after.aim.z - before.aim.z));
      out_.shotsWhileHeld = shots1 - shots0;
      if (out_.stickMovedMetres < 5) errs.push(`stick moved the aim ${out_.stickMovedMetres} m`);
      if (out_.shotsWhileHeld < 1) errs.push('holding FIRE (with the stick held) fired nothing');
      if (!firingMid) errs.push('FIRE button not shown as held');
      // After letting go, no more shots and the aim stays put.
      const s2 = await page.evaluate(() => window.__spooky.state().shots);
      await waitGame(page, 0.8);
      const s3 = await page.evaluate(() => window.__spooky.state().shots);
      const still = await info(page);
      if ((await info(page)).screen !== 'playing') errs.push(`mission no longer playing after the stick and fire test: ${JSON.stringify(await page.evaluate(() => window.__spooky.state().reason))}`);
      if (s3 - s2 > 1) errs.push(`still firing after FIRE was released (${s3 - s2} rounds)`);
      if (Math.hypot(still.aim.x - after.aim.x, still.aim.z - after.aim.z) > 0.5) errs.push('aim still drifting after the stick was released');
      // Tap the picture to aim there (from the middle of the map, so the tapped spot is never past its edge,
      // where the aim is clamped).
      await page.evaluate(() => window.__spooky.aimAt(0, 0));
      await waitGame(page, 0.2);
      const tapPoint = [viewport.width * 0.5 + Math.min(120, viewport.width * 0.2), viewport.height * 0.4];
      const aimT0 = (await info(page)).aim;
      await tapAt(tapPoint);
      // Wait for the tap to be handled (a heavy frame can hold input back well past a fixed delay).
      await aimMoved(page, aimT0);
      const aimT1 = (await info(page)).aim;
      out_.tapMovedMetres = Math.round(Math.hypot(aimT1.x - aimT0.x, aimT1.z - aimT0.z));
      if (out_.tapMovedMetres < 5) errs.push(`tap to aim moved the aim ${out_.tapMovedMetres} m`);
      if (full) {
        out_.shots.firing = `${out}/controls-touch-${name}-firing.png`;
        await touch('touchStart', [fireAt]);
        await page.waitForTimeout(400);
        await page.screenshot({ path: out_.shots.firing });
        await touch('touchEnd', []);
      }
      // The pause button pauses; the pause menu's buttons are big enough; Resume plays on.
      await tapAt(await centre('.tc-pause'));
      await waitInfo(page, () => window.__spooky.info().screen === 'paused');
      const pauseSmall = await page.$$eval('.overlay .card button', (bs) => bs.filter((b) => b.getBoundingClientRect().height < 44).map((b) => b.textContent));
      if (pauseSmall.length) errs.push(`pause menu buttons under 44 px: ${pauseSmall.join(', ')}`);
      const hiddenWhilePaused = await page.evaluate(() => document.querySelector('.touch-controls').hidden);
      if (!hiddenWhilePaused) errs.push('touch controls still showing while paused');
      out_.shots.pause = `${out}/controls-touch-${name}-pause.png`;
      await page.screenshot({ path: out_.shots.pause });
      await page.tap('.overlay button:has-text("Resume")');
      await waitInfo(page, () => window.__spooky.info().screen === 'playing');
      if (!(await info(page)).touch) errs.push('touch controls switched off by tapping Resume');
    } catch (e) {
      errs.push(String(e));
    }
    res.push(out_);
    await page.close();
  }

  // ----- Touch: the thumb stick and tap-to-aim on an Android tablet, started the way a player starts -----
  // Owner, Android tablet (Chrome): "No matter where I touch the controller it defaults up straight away.
  // Touching the screen doesn't work either." The touch checks above start with ?autostart (no briefing), so
  // they never pressed "Start mission", which asked for pointer lock even on touch screens. With the lock
  // held, Chrome reports every pointer event at (0, 0): the stick always read "up" and taps aimed at the corner.
  // Here: Galaxy Tab device profiles (Android Chrome user agent, pixel ratio 2.25, touch, mobile viewport), the
  // briefing's "Start mission" tapped with a finger, real CDP touch sequences on the stick (centre, each edge,
  // drags in small steps past the ring, a pointercancel mid-drag, with FIRE held), a tap on the picture, and
  // all of it again after turning the tablet round.
  // Each profile as loaded, then the portrait one started and turned to landscape mid-mission. That is a fresh
  // mission, because a long first round of checks can end an escort mission, and then the game clock stops.
  for (const [deviceName, turn] of [['Galaxy Tab S4 landscape', false], ['Galaxy Tab S4', false], ['Galaxy Tab S4', true]]) {
    const device = devices[deviceName];
    const { page, errs } = await gamePage(browser, 'autostart=1&brief=1&gfx=low&type=escort&difficulty=1&seed=3', { ...device });
    page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    const out_ = { type: `controls: thumb stick and tap on ${deviceName}${turn ? ', turned round after starting' : ''} (Android Chrome, via the briefing)`, errors: errs, shots: {} };
    try {
      const cdp = await page.context().newCDPSession(page);
      const finger = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y, id = 1]) => ({ x, y, id, radiusX: 12, radiusY: 12, force: 1 })) });
      const tapAt = async ([x, y]) => {
        const t = Date.now() / 1000; // hardware-like event times (see the touch checks above)
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', timestamp: t, touchPoints: [{ x, y, id: 1, radiusX: 12, radiusY: 12, force: 1 }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', timestamp: t + 0.08, touchPoints: [] });
        await page.waitForTimeout(150);
      };
      const centreOf = (sel) =>
        page.evaluate((s) => {
          const r = [...document.querySelectorAll(s)].find((e) => e.getBoundingClientRect().width)?.getBoundingClientRect();
          return r ? [r.left + r.width / 2, r.top + r.height / 2] : null;
        }, sel);
      // The briefing, then "Start mission" with a finger, as the owner does.
      await page.waitForFunction(() => [...document.querySelectorAll('.overlay button')].some((b) => b.textContent === 'Start mission' && b.getBoundingClientRect().width));
      // (In portrait the briefing scrolls: bring the button on screen first, as a player would.)
      await tapAt(await page.evaluate(() => {
        const b = [...document.querySelectorAll('.overlay button')].find((b) => b.textContent === 'Start mission');
        b.scrollIntoView({ block: 'center' });
        const r = b.getBoundingClientRect();
        return [r.left + r.width / 2, r.top + r.height / 2];
      }));
      await waitInfo(page, () => window.__spooky.info().screen === 'playing');
      await page.waitForSelector('.touch-controls:not([hidden]) .tc-stick');
      await page.waitForTimeout(300);
      // Where pointer events say a finger is, next to where the touch really is.
      await page.evaluate(() => {
        window.__pd = [];
        window.addEventListener('pointerdown', (e) => e.pointerType === 'touch' && window.__pd.push({ id: e.pointerId, x: e.clientX, y: e.clientY, target: e.target }), true);
      });
      const knob = () =>
        page.evaluate(() => {
          const m = (document.querySelector('.tc-knob').style.transform || '').match(/-?[\d.]+/g);
          return m ? [Number(m[0]), Number(m[1])] : [0, 0];
        });
      const aim = async () => ({ ...(await info(page)).aim, t: await gameTime(page) });
      /** Which way (unit vector, screen) and how far (px) the aim moved from a to b, seen in the current view. */
      const motion = (a, b) =>
        page.evaluate(([a, b]) => {
          const p = window.__spooky.screenOf(a.x, a.z);
          const q = window.__spooky.screenOf(b.x, b.z);
          const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
          return { dir: d ? [(q[0] - p[0]) / d, (q[1] - p[1]) / d] : [0, 0], px: d, speed: d / Math.max(1e-6, b.t - a.t) };
        }, [a, b]);
      const unit = (v) => (Math.hypot(...v) ? v.map((c) => c / Math.hypot(...v)) : [0, 0]);
      const angle = (u, v) => (Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1]))) * 180) / Math.PI;
      const centreAim = async () => {
        await page.evaluate(() => window.__spooky.aimAt(0, 0));
        await waitGame(page, 0.2);
      };
      /** Let go; returns how far (m) the aim moved afterwards (should stay put). */
      const release = async () => {
        await finger('touchEnd', []);
        await page.waitForTimeout(100);
        const a = await aim();
        await waitGame(page, 0.4);
        const b = await aim();
        return Math.hypot(b.x - a.x, b.z - a.z);
      };
      const S = Math.SQRT1_2;
      const dirs = [['right', 1, 0], ['down-right', S, S], ['down', 0, 1], ['down-left', -S, S], ['left', -1, 0], ['up-left', -S, -S], ['up', 0, -1], ['up-right', S, -S]];

      const checks = async (view) => {
        const res_ = { directions: {} };
        out_[view] = res_;
        const lock = await page.evaluate(() => document.pointerLockElement?.className ?? null);
        res_.pointerLock = lock;
        if (lock) errs.push(`${view}: the pointer is locked (to ${lock}) while playing with touch controls`);
        const ring = await page.evaluate(() => {
          const r = document.querySelector('.tc-stick').getBoundingClientRect();
          return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, r: r.width / 2 };
        });
        // 1. A press at the centre of the ring: no push, the aim stays put.
        await centreAim();
        await page.evaluate(() => (window.__pd = []));
        let a = await aim();
        await finger('touchStart', [[ring.cx, ring.cy]]);
        await waitGame(page, 0.3);
        let k = await knob();
        let b = await aim();
        const pd = await page.evaluate(() => window.__pd.map(({ x, y }) => [Math.round(x), Math.round(y)]));
        res_.centre = { touchAt: [Math.round(ring.cx), Math.round(ring.cy)], pointerEventAt: pd[0], knob: k, aimMovedPx: Math.round((await motion(a, b)).px) };
        await release();
        if (pd[0] && Math.hypot(pd[0][0] - ring.cx, pd[0][1] - ring.cy) > 2) errs.push(`${view}: a touch at ${res_.centre.touchAt} reached the page as a pointer at ${pd[0]}`);
        if (Math.hypot(...k) > 3) errs.push(`${view}: a press at the stick's centre put the knob at ${k}`);
        if (res_.centre.aimMovedPx > 3) errs.push(`${view}: a press at the stick's centre moved the aim ${res_.centre.aimMovedPx} px`);
        // 2. Each edge, pressed directly, pushes that way; then dragged in small steps (~300 ms) past the ring.
        const speeds = {};
        for (const [name, ux, uy] of dirs) {
          await centreAim();
          const edge = [ring.cx + ux * ring.r * 0.85, ring.cy + uy * ring.r * 0.85];
          await finger('touchStart', [edge]);
          await page.waitForTimeout(60);
          const kEdge = await knob();
          a = await aim();
          await waitGame(page, 0.3);
          b = await aim();
          const mEdge = await motion(a, b);
          for (let s = 1; s <= 10; s++) {
            const d = ring.r * (0.85 + (0.75 * s) / 10); // out to 1.6 radii: off the ring
            await finger('touchMove', [[ring.cx + ux * d, ring.cy + uy * d]]);
            await page.waitForTimeout(30);
          }
          const kOut = await knob();
          a = await aim();
          await waitGame(page, 0.4);
          b = await aim();
          const mOut = await motion(a, b);
          const drift = await release();
          const kRest = await knob();
          speeds[name] = mOut.speed;
          const r = { edgeKnob: kEdge, edgeAimOffByDeg: Math.round(angle(mEdge.dir, [ux, uy])), outKnob: kOut, outAimOffByDeg: Math.round(angle(mOut.dir, [ux, uy])), outSpeedPxPerS: Math.round(mOut.speed), afterReleaseM: Number(drift.toFixed(2)) };
          res_.directions[name] = r;
          if (angle(unit(kEdge), [ux, uy]) > 10 || Math.abs(Math.hypot(...kEdge) - ring.r * 0.85) > 4) errs.push(`${view} ${name}: pressing the ${name} edge put the knob at ${kEdge}`);
          if (mEdge.px < 5 || r.edgeAimOffByDeg > 25) errs.push(`${view} ${name}: pressing the ${name} edge moved the aim ${Math.round(mEdge.px)} px, ${r.edgeAimOffByDeg}° off`);
          if (angle(unit(kOut), [ux, uy]) > 10 || Math.abs(Math.hypot(...kOut) - ring.r) > 4) errs.push(`${view} ${name}: dragged past the ring, the knob is at ${kOut} (should sit on the rim)`);
          if (mOut.px < 20 || r.outAimOffByDeg > 25) errs.push(`${view} ${name}: dragging ${name} moved the aim ${Math.round(mOut.px)} px, ${r.outAimOffByDeg}° off`);
          if (drift > 0.5) errs.push(`${view} ${name}: the aim kept moving ${drift.toFixed(1)} m after letting go`);
          if (Math.hypot(...kRest) > 0.5) errs.push(`${view} ${name}: the knob stayed at ${kRest} after letting go`);
        }
        // 3. Proportional: half way out moves the aim at well under full speed (dead zone, then linear).
        await centreAim();
        await finger('touchStart', [[ring.cx, ring.cy]]);
        for (let s = 1; s <= 10; s++) {
          await finger('touchMove', [[ring.cx + (ring.r * 0.5 * s) / 10, ring.cy]]);
          await page.waitForTimeout(30);
        }
        a = await aim();
        await waitGame(page, 0.4);
        b = await aim();
        const half = await motion(a, b);
        await release();
        res_.halfSpeedRatio = Number((half.speed / speeds.right).toFixed(2));
        if (!(res_.halfSpeedRatio > 0.25 && res_.halfSpeedRatio < 0.65)) errs.push(`${view}: half deflection moved the aim at ${res_.halfSpeedRatio} of full speed (expected about 0.43)`);
        // 4. Chrome cancels the pointer mid-drag: the stick lets go (knob home, aim still), nothing stuck.
        await centreAim();
        await page.evaluate(() => (window.__pd = []));
        await finger('touchStart', [[ring.cx, ring.cy]]);
        for (let s = 1; s <= 5; s++) {
          await finger('touchMove', [[ring.cx + (ring.r * 0.8 * s) / 5, ring.cy]]);
          await page.waitForTimeout(30);
        }
        await page.evaluate(() => {
          const { id, target } = window.__pd.at(-1);
          target.dispatchEvent(new PointerEvent('pointercancel', { pointerId: id, pointerType: 'touch', bubbles: true }));
        });
        await page.waitForTimeout(100);
        k = await knob();
        a = await aim();
        await waitGame(page, 0.3);
        b = await aim();
        res_.afterCancel = { knob: k, aimMovedM: Number(Math.hypot(b.x - a.x, b.z - a.z).toFixed(2)) };
        await finger('touchEnd', []);
        if (Math.hypot(...k) > 0.5 || res_.afterCancel.aimMovedM > 0.5) errs.push(`${view}: after a pointercancel the stick stayed pushed (${JSON.stringify(res_.afterCancel)})`);
        // 5. Stick and FIRE together (FIRE first, then the stick, pushed up): steers and fires.
        await aimAway(page);
        const fireAt = await centreOf('.tc-fire');
        const shots0 = await page.evaluate(() => window.__spooky.state().shots);
        await finger('touchStart', [[...fireAt, 2]]);
        await finger('touchStart', [[...fireAt, 2], [ring.cx, ring.cy, 1]]);
        for (let s = 1; s <= 6; s++) {
          await finger('touchMove', [[...fireAt, 2], [ring.cx, ring.cy - (ring.r * 0.6 * s) / 6, 1]]);
          await page.waitForTimeout(30);
        }
        a = await aim();
        await waitGame(page, 0.4);
        b = await aim();
        const mf = await motion(a, b);
        await finger('touchEnd', []);
        await page.waitForTimeout(200);
        const shots1 = await page.evaluate(() => window.__spooky.state().shots);
        res_.withFire = { aimMovedPx: Math.round(mf.px), offByDeg: Math.round(angle(mf.dir, [0, -1])), shots: shots1 - shots0 };
        if (mf.px < 10 || res_.withFire.offByDeg > 25) errs.push(`${view}: stick with FIRE held did not steer up (${JSON.stringify(res_.withFire)})`);
        if (res_.withFire.shots < 1) errs.push(`${view}: FIRE held with the stick fired nothing`);
        // 6. A tap on the picture aims at the ground point under the finger.
        await centreAim();
        const target = await page.evaluate(() => {
          const a = window.__spooky.info().aim;
          for (const [ox, oz] of [[30, 0], [0, 30], [-30, 0], [0, -30], [15, 0], [0, 15], [-15, 0], [0, -15], [10, 10], [-10, -10]]) {
            const [x, y] = window.__spooky.screenOf(a.x + ox, a.z + oz);
            if (document.elementFromPoint(x, y)?.classList.contains('game-canvas')) return { x: a.x + ox, z: a.z + oz, at: [x, y] };
          }
          return null;
        });
        if (!target) errs.push(`${view}: no clear spot on the picture to tap`);
        else {
          const before = (await info(page)).aim;
          await tapAt(target.at);
          await aimMoved(page, before);
          const after = (await info(page)).aim;
          res_.tap = { tappedAt: target.at.map(Math.round), wanted: [target.x, target.z], got: [Math.round(after.x), Math.round(after.z)], offM: Number(Math.hypot(after.x - target.x, after.z - target.z).toFixed(1)) };
          if (res_.tap.offM > 3) errs.push(`${view}: a tap on the picture aimed ${res_.tap.offM} m from the spot tapped (${JSON.stringify(res_.tap)})`);
        }
        if ((await info(page)).screen !== 'playing') errs.push(`${view}: the mission stopped playing during the stick checks`);
      };

      const shotName = `${out}/controls-stick-${deviceName.replace(/\W+/g, '-')}${turn ? '-turned' : ''}.png`;
      if (turn) {
        // Turn the tablet round mid-mission: layout, ring position and the picture all change.
        const vp = page.viewportSize();
        await page.setViewportSize({ width: vp.height, height: vp.width });
        await page.waitForTimeout(600);
      }
      await checks(turn ? 'turned round' : 'as loaded');
      out_.shots.stick = shotName;
      await page.screenshot({ path: shotName });
    } catch (e) {
      errs.push(String(e));
    }
    res.push(out_);
    await page.close();
  }

  // ----- Touch: the way in (landing, recon, briefing) has 44 px+ tap targets and starts a playable mission -----
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: scale, hasTouch: true, isMobile: true });
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    const out_ = { type: 'controls: touch way in (phone)', errors: errs, shots: {} };
    const smallTargets = (scope) =>
      page.evaluate(
        (scope) =>
          [...document.querySelectorAll(`${scope} button, ${scope} select, ${scope} input:not([type=range]):not([type=hidden]), ${scope} a[href]`)]
            .filter((b) => {
              const r = b.getBoundingClientRect();
              return r.width > 0 && getComputedStyle(b).visibility !== 'hidden' && (r.height < 44 || r.width < 44);
            })
            .map((b) => `${(b.textContent || b.getAttribute('aria-label') || b.tagName).trim().slice(0, 30)} ${Math.round(b.getBoundingClientRect().width)}x${Math.round(b.getBoundingClientRect().height)}`),
        scope,
      );
    try {
      await page.goto(`http://localhost:${PORT}/`);
      await page.waitForSelector('.landing h1');
      const landing = await smallTargets('.landing');
      if (landing.length) errs.push(`landing tap targets under 44 px: ${landing.join(' | ')}`);
      out_.landingTouchLine = await page.evaluate(() => {
        const e = document.querySelector('.landing-touch');
        return e && getComputedStyle(e).display !== 'none' ? e.textContent : null;
      });
      await page.tap('.la-sample');
      await page.waitForSelector('.menu .recon .mission-card');
      const recon = await smallTargets('.menu');
      if (recon.length) errs.push(`recon tap targets under 44 px: ${recon.join(' | ')}`);
      out_.shots.recon = `${out}/controls-touch-recon.png`;
      await page.screenshot({ path: out_.shots.recon });
      await page.tap('.recon .mission-card button');
      await page.waitForSelector('.overlay .card.briefing');
      await page.waitForTimeout(600);
      const brief = await smallTargets('.overlay');
      if (brief.length) errs.push(`briefing tap targets under 44 px: ${brief.join(' | ')}`);
      const keys = await page.evaluate(() => document.querySelector('.overlay .card.briefing p.small')?.textContent ?? '');
      if (!/stick/.test(keys)) errs.push(`touch briefing shows keyboard controls: ${keys}`);
      out_.shots.briefing = `${out}/controls-touch-briefing.png`;
      await page.screenshot({ path: out_.shots.briefing });
      await page.tap('.overlay button:has-text("Start mission")');
      await waitInfo(page, () => window.__spooky.info()?.screen === 'playing', undefined, 30000);
      await page.waitForSelector('.touch-controls:not([hidden]) .tc-fire');
    } catch (e) {
      errs.push(String(e));
    }
    res.push(out_);
    await page.close();
  }
  return res;
}

// ---------- The intro: "The Late Bulletin" (src/ui/intro.ts, docs/story/intro.md) ----------
// Runs on the intro's own clock (test hook window.__spooky.intro: fixedStep / seek / state), so a slow
// machine still sees every frame a 60 fps player sees. Checks: started from a click on the front page
// (first visit offers it; afterwards a "Watch intro" link), every caption matches the script in
// docs/story/intro.md at each line's middle, each line's recording was started, the flash meter over
// the whole 44 s, skip from the first second (button >= 48 px, Esc, Space, Enter, a tap) back to the
// front page with the WebGL context freed and "seen" remembered, the reduced-motion slideshow (no
// camera moves: the picture holds still within a slide), draw calls, no console errors, and 10 start
// → skip cycles without leaking WebGL contexts. Screenshots of every shot at 1280x720 and 390x844.
function introScript() {
  const md = readFileSync('docs/story/intro.md', 'utf8');
  return md
    .split('\n')
    .filter((l) => /^\| \d+ \| `voice\/intro-/.test(l))
    .map((l) => {
      const c = l.split('|').map((x) => x.trim());
      return { id: /voice\/(intro-[a-z0-9-]+)\.mp3/.exec(c[2])[1], speaker: c[3], text: c[5], start: Number(c[6]), length: parseFloat(c[7]) };
    });
}

async function introPage(browser, viewport, extra = {}) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: scale, ...extra });
  const errs = [];
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.addInitScript(keepDrawingBuffers);
  await page.addInitScript(() => {
    window.__ctx = { made: 0, lost: 0 };
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, attrs) {
      const c = orig.call(this, type, attrs);
      if (c && /webgl/.test(type) && !this.__counted) {
        this.__counted = true;
        window.__ctx.made++;
        this.addEventListener('webglcontextlost', () => window.__ctx.lost++);
      }
      return c;
    };
  });
  return { page, errs };
}

function introState(page) {
  return page.evaluate(() => window.__spooky.intro?.state() ?? null);
}
/** Run the intro's clock (seconds per rendered frame) until it reaches t, then hold it. */
async function introRunTo(page, t, step = 1 / 30) {
  await page.evaluate((s) => window.__spooky.intro.fixedStep(s), step);
  await page.waitForFunction((tt) => (window.__spooky.intro?.state().t ?? 1e9) >= tt, t, { timeout: 300000, polling: 30 });
  await page.evaluate(() => window.__spooky.intro?.fixedStep(0));
}

async function introChecks(browser) {
  const res = [];
  try {
    await introCheckRuns(browser, res);
  } catch (e) {
    res.push({ type: 'intro: checks stopped', errors: [String(e).split('\n')[0]], shots: {} });
  }
  return res;
}

async function introCheckRuns(browser, res) {
  const script = introScript();
  const SHOT_TIMES = { '1-bulletin': 4, '2-pullback': 13.2, '3a-order-turn': 17.2, '3b-order-markers': 23, '3c-order-guns': 28.5, '3d-order-night': 33.6, '4-radio': 40, '5-title': 43 };

  // 1. From a click on the first visit's offer: captions, recordings, flash meter (desktop), shots, draw calls.
  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    const { page, errs } = await introPage(browser, viewport);
    const shots = {};
    const tag = viewport.width;
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForSelector('.landing h1');
    if (!(await page.$('.landing-intro-offer .la-intro'))) errs.push('first visit: the front page does not offer the intro');
    if (await page.$('.intro')) errs.push('the intro started without a click');
    shots.offer = `${out}/intro-${tag}-0-offer.png`;
    await page.screenshot({ path: shots.offer });
    await page.click('.landing-intro-offer .la-intro');
    await page.waitForFunction(() => window.__spooky.intro?.state().started, null, { timeout: 15000 });
    await page.evaluate(() => window.__spooky.intro.fixedStep(0));
    const after = await page.evaluate(() => [...document.querySelectorAll('canvas')].map((c) => c.className));
    if (after.length !== 1 || after[0] !== 'intro-canvas') errs.push(`one WebGL canvas at a time: ${after.join(', ')}`);
    const skipBox = await page.$eval('.intro-skip', (b) => {
      const r = b.getBoundingClientRect();
      return { w: r.width, h: r.height };
    });
    if (skipBox.w < 48 || skipBox.h < 48) errs.push(`Skip button ${skipBox.w}x${skipBox.h} px (min 48)`);
    if (tag === 1280) await startMeter(page, '.intro-canvas', 'intro');
    let maxCalls = 0;
    // The flash meter needs every frame (1/30 s steps); the phone run only checks captions and pictures.
    const step = tag === 1280 ? 1 / 30 : 1 / 10;
    const marks = [...script.map((l) => ({ t: l.start + l.length / 2, line: l })), ...Object.entries(SHOT_TIMES).map(([name, t]) => ({ t, shot: name }))].sort((a, b) => a.t - b.t);
    for (const m of marks) {
      await introRunTo(page, m.t, step);
      const st = await introState(page);
      maxCalls = Math.max(maxCalls, st.drawCalls);
      if (m.line) {
        if (st.caption !== m.line.text || st.speaker !== m.line.speaker) errs.push(`at ${m.t.toFixed(1)} s caption "${st.speaker}: ${st.caption}", script "${m.line.speaker}: ${m.line.text}"`);
      } else {
        await page.waitForTimeout(250);
        shots[m.shot] = `${out}/intro-${tag}-${m.shot}.png`;
        await page.screenshot({ path: shots[m.shot] });
      }
    }
    if (tag === 1280) {
      await introRunTo(page, 43.9);
      const frames = (await stopMeter(page)).filter((f) => f[0] > 0);
      res.push(judge('intro, the whole 44 s (1/30 s steps)', frames));
    }
    // The cues: [TV muted] and [radio click].
    for (const [t, text] of [[15.35, '[TV muted]'], [38.5, '[radio click]']]) {
      await page.evaluate((tt) => window.__spooky.intro.seek(tt), t);
      await page.waitForTimeout(200);
      const st = await introState(page);
      if (st.caption !== text) errs.push(`at ${t} s caption "${st.caption}", wanted ${text}`);
    }
    // The voice: every line's recording was started (sound was unlocked by the click).
    const aud = await page.evaluate(() => window.__spooky.audio?.() ?? null);
    const started = new Set((aud?.clips ?? []).map((c) => c.id));
    const missing = script.filter((l) => !started.has(`voice/${l.id}`)).map((l) => l.id);
    if (!aud) errs.push('no audio engine after the click');
    else if (missing.length) errs.push(`recordings not started: ${missing.join(', ')}`);
    if (maxCalls > 150) errs.push(`draw calls ${maxCalls} > 150`);
    // The end: back to the front page, which now has "Watch intro" instead of the offer.
    await page.evaluate(() => window.__spooky.intro.seek(43.6));
    await page.evaluate(() => window.__spooky.intro?.fixedStep(1 / 30));
    await page.waitForSelector('.landing h1', { timeout: 30000 });
    const end = await page.evaluate(() => ({ seen: localStorage.getItem('spooky.intro'), link: !!document.querySelector('.la-intro-link'), offer: !!document.querySelector('.landing-intro-offer'), intro: !!document.querySelector('.intro'), ctx: window.__ctx }));
    if (end.seen !== 'seen') errs.push(`"seen" not remembered: ${end.seen}`);
    if (!end.link || end.offer) errs.push('after the intro the front page should show "Watch intro", not the offer');
    if (end.intro) errs.push('the intro is still in the page after it ended');
    if (end.ctx.made - end.ctx.lost > 1) errs.push(`${end.ctx.made - end.ctx.lost} WebGL contexts alive after the intro (want 1: the front page)`);
    await page.waitForTimeout(1200);
    shots.after = `${out}/intro-${tag}-6-front-page.png`;
    await page.screenshot({ path: shots.after });
    res.push({ type: `intro: play through (${tag} px)`, maxDrawCalls: maxCalls, captionsChecked: script.length, clips: aud?.clips?.length ?? 0, errors: errs, shots });
    await page.close();
  }

  // 2. Skip from the first second: the button, Esc, Space, Enter and a tap; then "Watch intro" plays it again.
  {
    const errs = [];
    for (const how of ['button', 'Escape', 'Space', 'Enter', 'tap']) {
      const touch = how === 'tap';
      const { page, errs: e } = await introPage(browser, touch ? { width: 390, height: 844 } : { width: 1280, height: 720 }, touch ? { hasTouch: true, isMobile: true } : {});
      await page.goto(`http://localhost:${PORT}/`);
      await page.waitForSelector('.landing-intro-offer .la-intro');
      if (touch) await page.tap('.landing-intro-offer .la-intro');
      else await page.click('.landing-intro-offer .la-intro');
      await page.waitForSelector('.intro');
      await page.waitForTimeout(500);
      const t0 = (await introState(page))?.t ?? 0;
      if (how === 'button') await page.click('.intro-skip');
      else if (touch) await page.tap('.intro-canvas');
      else await page.keyboard.press(how);
      try {
        await page.waitForSelector('.landing h1', { timeout: 10000 });
      } catch {
        errs.push(`${how}: did not skip`);
      }
      const st = await page.evaluate(() => ({ intro: !!document.querySelector('.intro'), seen: localStorage.getItem('spooky.intro'), ctx: window.__ctx }));
      if (st.intro) errs.push(`${how}: intro still in the page`);
      if (st.seen !== 'seen') errs.push(`${how}: "seen" not remembered`);
      if (st.ctx.made - st.ctx.lost > 1) errs.push(`${how}: ${st.ctx.made - st.ctx.lost} WebGL contexts alive`);
      if (t0 > 1) errs.push(`${how}: skipped at ${t0.toFixed(2)} s (should work from the first second)`);
      if (how === 'Escape') {
        await page.click('.la-intro-link');
        await page.waitForSelector('.intro');
        await page.keyboard.press('Escape');
        await page.waitForSelector('.landing h1');
      }
      errs.push(...e.map((x) => `${how}: ${x}`));
      await page.close();
    }
    res.push({ type: 'intro: skip from the first second (button, Esc, Space, Enter, tap) and Watch intro', errors: errs, shots: {} });
  }

  // 3. Reduced motion: a still slideshow (no camera moves), the same captions; flash meter over all of it.
  {
    const { page, errs } = await introPage(browser, { width: 1280, height: 720 }, { reducedMotion: 'reduce' });
    const shots = {};
    await page.goto(`http://localhost:${PORT}/`);
    await page.click('.landing-intro-offer .la-intro');
    await page.waitForFunction(() => window.__spooky.intro?.state().started, null, { timeout: 15000 });
    await page.evaluate(() => window.__spooky.intro.fixedStep(0));
    if (!(await introState(page)).still) errs.push('reduced motion: the intro is not in still (slideshow) mode');
    await startMeter(page, '.intro-canvas', 'intro');
    const grid = () => page.evaluate(() => window.__meter.frames[window.__meter.frames.length - 1][1]);
    for (const [a, b] of [[2.5, 9.5], [11.5, 15], [17, 34.5], [39.5, 42]]) {
      await introRunTo(page, a, 1 / 15);
      await page.waitForTimeout(200);
      const ga = await grid();
      shots[`slide-${a}`] = `${out}/intro-reduced-${String(a).replace('.', '_')}s.png`;
      await page.screenshot({ path: shots[`slide-${a}`] });
      await introRunTo(page, b, 1 / 15);
      await page.waitForTimeout(200);
      const gb = await grid();
      // Within a slide only screen contents crossfade (monitors following the words); the camera never moves.
      let moved = 0;
      for (let i = 0; i < ga.length; i++) if (Math.abs(ga[i] - gb[i]) > 0.02) moved++;
      const share = moved / ga.length;
      if (share > 0.12) errs.push(`reduced motion: ${Math.round(share * 100)}% of the picture changed between ${a} s and ${b} s (camera moved?)`);
      const st = await introState(page);
      const line = script.find((l) => b >= l.start && b < l.start + l.length);
      if (line && st.caption !== line.text) errs.push(`reduced motion: caption at ${b} s is "${st.caption}"`);
    }
    await introRunTo(page, 43.9, 1 / 15);
    const frames = (await stopMeter(page)).filter((f) => f[0] > 0);
    res.push(judge('intro, reduced motion (slideshow, 1/15 s steps)', frames));
    res.push({ type: 'intro: reduced motion slideshow', errors: errs, shots });
    await page.close();
  }

  // 3b. Motion override (BACKLOG 3.30): the device note, "Play animated", and the Settings choice beating the device.
  {
    const cases = [
      { name: 'device asks, setting follows device', media: 'reduce', stored: null, still: true, note: true },
      { name: 'device asks, Settings = Full motion', media: 'reduce', stored: { motion: 'full' }, still: false, note: false },
      { name: 'device does not ask, Settings = Reduced', media: 'no-preference', stored: { motion: 'reduced' }, still: true, note: false },
    ];
    for (const c of cases) {
      const { page, errs } = await introPage(browser, { width: 1280, height: 720 }, { reducedMotion: c.media });
      const shots = {};
      if (c.stored) await page.addInitScript((v) => localStorage.setItem('spooky.settings', JSON.stringify(v)), c.stored);
      await page.goto(`http://localhost:${PORT}/`);
      await page.click('.landing-intro-offer .la-intro');
      await page.waitForFunction(() => window.__spooky.intro?.state().started, null, { timeout: 15000 });
      await page.evaluate(() => window.__spooky.intro.fixedStep(0));
      if ((await introState(page)).still !== c.still) errs.push(`${c.name}: still should be ${c.still}`);
      const hasNote = !!(await page.$('.intro .motion-note'));
      if (hasNote !== c.note) errs.push(`${c.name}: note present = ${hasNote}, expected ${c.note}`);
      if (c.note) {
        shots.note = `${out}/intro-motion-note.png`;
        await page.screenshot({ path: shots.note });
        const box = await page.$eval('.intro .motion-play', (b) => { const r = b.getBoundingClientRect(); return { w: r.width, h: r.height }; });
        if (box.h < 47.5 || box.w < 47.5) errs.push(`"Play animated" is ${box.w}x${box.h} px (need 48)`);
        if (await page.evaluate(() => document.documentElement.classList.contains('motion-full'))) errs.push('motion-full class set before any choice (motion must never switch on by itself)');
        await page.focus('.intro .motion-play');
        await page.keyboard.press('Enter'); // keyboard reachable, and must not skip the intro
        await page.waitForFunction(() => window.__spooky.intro?.state().started && !window.__spooky.intro.state().still, null, { timeout: 15000 }).catch(() => errs.push('"Play animated" did not restart the intro animated'));
        await page.evaluate(() => window.__spooky.intro?.fixedStep(0));
        if (!(await page.$('.intro')) || (await page.$('.intro.still')) || (await page.$('.intro .motion-note'))) errs.push('after "Play animated": expected one animated intro without the note');
        const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('spooky.settings') ?? '{}').motion ?? 'device');
        if (saved !== 'device') errs.push(`"Play animated" saved the setting (${saved}); only "Always" may`);
        shots.animated = `${out}/intro-motion-animated.png`;
        await introRunTo(page, 14, 1 / 15);
        await page.screenshot({ path: shots.animated });
      }
      res.push({ type: `intro: motion override, ${c.name}`, errors: errs, shots });
      await page.close();
    }
  }

  // 4. Leaks: 10 × (Watch intro → 2 s → Skip). One WebGL context at a time, nothing left behind.
  {
    const { page, errs } = await introPage(browser, { width: 1280, height: 720 });
    await page.goto(`http://localhost:${PORT}/`);
    await page.click('.landing-intro-offer .la-intro');
    await page.waitForSelector('.intro');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.landing h1');
    const snap = () => page.evaluate(() => ({ ...window.__ctx, canvases: document.querySelectorAll('canvas').length, intros: document.querySelectorAll('.intro').length, nodes: document.getElementsByTagName('*').length, heapMB: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1e5) / 10 }));
    const before = await snap();
    let cycles = 0;
    try {
      for (let i = 0; i < 10; i++) {
        await page.click('.la-intro-link');
        await page.waitForFunction(() => window.__spooky.intro?.state().started, null, { timeout: 15000 });
        await introRunTo(page, 2, 1 / 15);
        const alive = await page.evaluate(() => window.__ctx.made - window.__ctx.lost);
        if (alive > 1) errs.push(`cycle ${i + 1}: ${alive} WebGL contexts alive during the intro`);
        await page.click('.intro-skip');
        await page.waitForSelector('.landing h1');
        cycles++;
      }
    } catch (e) {
      errs.push(`cycle ${cycles + 1}: ${String(e).split('\n')[0]}`);
    }
    await page.waitForTimeout(800);
    const after = await snap();
    const alive = (s) => s.made - s.lost;
    if (alive(after) > alive(before)) errs.push(`WebGL contexts alive grew from ${alive(before)} to ${alive(after)}`);
    if (after.intros || after.canvases !== 1) errs.push(`after 10 cycles: ${after.intros} intros, ${after.canvases} canvases`);
    if (after.nodes > before.nodes * 1.2 + 50) errs.push(`DOM grew from ${before.nodes} to ${after.nodes} nodes`);
    res.push({ type: 'intro: 10 start → skip cycles', cycles, before, after, errors: errs, shots: {} });
    await page.close();
  }
}

// ---------- Famous places (3.27) ----------
// Picking each bundled preset must load one file from this game's own origin, never OpenStreetMap
// (every request to an OSM host is aborted and counted), reach recon with the attribution visible,
// and be touch-friendly (48 px targets, no sideways scrolling), at desktop and phone size.
async function presetChecks(browser) {
  const OSM_HOST = /^https?:\/\/(nominatim\.openstreetmap\.org|overpass-api\.de|overpass\.kumi\.systems|[a-z0-9.-]*openstreetmap\.org)\//;
  // The files that ship: the picker must offer exactly these.
  const SHIPPED = readdirSync('public/maps/presets').filter((f) => f.endsWith('.json') && f !== 'exclusions.json').map((f) => f.slice(0, -5)).sort();
  const res = [];
  for (const vp of [{ w: 1280, h: 720, touch: false }, { w: 390, h: 844, touch: true }]) {
    const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: scale, hasTouch: vp.touch, isMobile: vp.touch });
    const errs = [];
    const r = { type: `presets: famous places (${vp.w}x${vp.h})`, errors: errs, shots: {}, osmRequests: 0, loaded: {} };
    const files = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    await page.route(OSM_HOST, (route) => {
      r.osmRequests++;
      errs.push(`request to OpenStreetMap: ${route.request().url()}`);
      return route.abort();
    });
    page.on('request', (q) => /\/maps\/presets\//.test(q.url()) && files.push(q.url()));
    try {
      await page.goto(`http://localhost:${PORT}/`);
      await page.waitForSelector('.landing h1');
      const tap = (sel) => (vp.touch ? page.tap(sel) : page.click(sel));
      const small = (scope) =>
        page.evaluate(
          (scope) => [...document.querySelectorAll(`${scope} button`)].filter((b) => { const q = b.getBoundingClientRect(); return q.width > 0 && (q.height < 48 || q.width < 48); }).map((b) => `${b.textContent.trim().slice(0, 30)} ${Math.round(b.getBoundingClientRect().width)}x${Math.round(b.getBoundingClientRect().height)}`),
          scope,
        );
      const landingSmall = await small('.landing-actions');
      if (landingSmall.length) errs.push(`landing buttons under 48 px: ${landingSmall.join(' | ')}`);
      await tap('.la-famous');
      await page.waitForSelector('.famous .famous-place');
      const picker = await page.evaluate(() => ({
        countries: [...document.querySelectorAll('.famous-country')].map((h) => h.textContent.trim()),
        places: [...document.querySelectorAll('.famous-place')].map((b) => b.dataset.preset),
        attrib: document.querySelector('.scout .attrib')?.textContent ?? '',
        wide: document.documentElement.scrollWidth > window.innerWidth + 1,
      }));
      if ([...picker.places].sort().join() !== SHIPPED.join()) errs.push(`the picker offers ${picker.places.join(', ')} but the files are ${SHIPPED.join(', ')}`);
      if (picker.countries.length !== picker.places.length) errs.push(`expected one country heading per place, saw ${picker.countries.length} for ${picker.places.length}`);
      const SLUGS = picker.places;
      if (!/OpenStreetMap/.test(picker.attrib)) errs.push('the scout screen lost the OpenStreetMap attribution');
      if (picker.wide) errs.push('the scout screen scrolls sideways');
      const picks = await small('.famous');
      if (picks.length) errs.push(`famous place buttons under 48 px: ${picks.join(' | ')}`);
      r.shots.picker = `${out}/presets-picker-${vp.w}.png`;
      await page.locator('.famous').screenshot({ path: r.shots.picker });
      for (const slug of SLUGS) {
        const before = files.length;
        await page.waitForSelector(`.famous-place[data-preset="${slug}"]`);
        await tap(`.famous-place[data-preset="${slug}"]`);
        await page.waitForSelector('.menu .recon .mission-card', { timeout: 30000 });
        const st = await page.evaluate(() => ({
          title: document.querySelector('.menu .recon h2')?.textContent ?? '',
          attrib: document.querySelector('.menu .recon .attrib')?.textContent ?? '',
          cards: document.querySelectorAll('.menu .recon .mission-card').length,
          wide: document.documentElement.scrollWidth > window.innerWidth + 1,
        }));
        r.loaded[slug] = { title: st.title, cards: st.cards };
        if (!/OpenStreetMap/.test(st.attrib)) errs.push(`${slug}: recon shows no OpenStreetMap attribution (${st.attrib})`);
        if (!st.cards) errs.push(`${slug}: recon offers no missions`);
        if (st.wide) errs.push(`${slug}: recon scrolls sideways`);
        const got = files.slice(before);
        if (got.length !== 1 || !got[0].startsWith(`http://localhost:${PORT}/`) || !got[0].includes(`${slug}.json`)) errs.push(`${slug}: expected one request to our own ${slug}.json, saw ${got.join(', ') || 'none'}`);
        r.shots[slug] = `${out}/presets-${slug}-${vp.w}.png`;
        await page.screenshot({ path: r.shots[slug] });
        await tap('.recon-change');
        await page.waitForSelector('.famous .famous-place');
      }
      // A mission starts from a preset recon card and is playable.
      await tap(`.famous-place[data-preset="${SLUGS[SLUGS.length - 1]}"]`);
      await page.waitForSelector('.menu .recon .mission-card');
      await tap('.recon .mission-card button');
      await page.waitForSelector('.overlay .card.briefing', { timeout: 30000 });
      r.shots.briefing = `${out}/presets-briefing-${vp.w}.png`;
      await page.screenshot({ path: r.shots.briefing });
    } catch (e) {
      errs.push(String(e));
    }
    res.push(r);
    await page.close();
  }
  return res;
}

// ---------- Landmark markers (BACKLOG 3.19) ----------
// At 1280x720 (mouse) and 390x844 (touch): aim near the densest cluster of landmarks with the 105's wide
// lens, screenshot white hot and night vision, and check: 1-6 labels, 14 px+ outlined text, fully on
// screen, never over each other, the HUD panels, the reticle, mission markers or the touch controls;
// never a school, kindergarten, childcare or playground; and "Show landmarks" off hides them all.
async function landmarkChecks(browser) {
  const res = [];
  const CHILD = /school|kindergarten|childcare|child care|playground|nursery|preschool|college|wattle hill/i;
  const views = [
    ['desktop', { width: 1280, height: 720 }, false],
    ['phone', { width: 390, height: 844 }, true],
  ];
  for (const [name, viewport, touch] of views) {
    const { page, errs } = await gamePage(browser, 'autostart=1&type=clear&difficulty=1&seed=7', { viewport, deviceScaleFactor: scale, ...(touch ? { hasTouch: true, isMobile: true } : {}) });
    page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    const out_ = { type: `landmarks (${name} ${viewport.width}x${viewport.height})`, errors: errs, shots: {}, labels: {} };
    try {
      if (touch && !(await info(page)).touch) {
        const cdp = await page.context().newCDPSession(page);
        const t = Date.now() / 1000;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', timestamp: t, touchPoints: [{ x: viewport.width / 2, y: viewport.height * 0.3, id: 1, radiusX: 4, radiusY: 4, force: 1 }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', timestamp: t + 0.08, touchPoints: [] });
        await page.waitForTimeout(300);
      }
      if (touch) {
        if (!(await info(page)).touch) errs.push('touch controls did not come on');
        else await page.waitForSelector('.touch-controls:not([hidden]) .tc-fire');
      }
      // The 105's wide lens, aimed so the place with most others near it sits on screen a quarter of the
      // screen height above the middle: off the reticle and its DANGER CLOSE / MASKED tags. Aimed in screen
      // terms (the camera's own axes, from screenOf), not by a fixed ground offset: a 390 px portrait phone
      // shows only about 100 m of ground across, so a ground offset that suits 1280 x 720 leaves every
      // place either under the reticle keep-out or off the side of a phone.
      await page.keyboard.press('3');
      const places = await page.evaluate(() => window.__spooky.landmarks());
      if (!places.length) errs.push('no landmarks listed for the sample town');
      const bad = places.filter((p) => CHILD.test(p.label));
      if (bad.length) errs.push(`child places listed: ${bad.map((p) => p.label).join(', ')}`);
      const near = (p) => places.filter((q) => Math.hypot(q.x - p.x, q.z - p.z) < 140).length;
      const best = [...places].sort((a, b) => near(b) - near(a))[0];
      if (best) {
        let aim = { x: best.x, z: best.z };
        for (let k = 0; k < 3; k++) {
          await page.evaluate(([x, z]) => window.__spooky.aimAt(x, z), [aim.x, aim.z]);
          await page.waitForTimeout(300);
          // Screen px per ground metre along x and z near the place, then the ground offset that puts
          // the place at (middle, middle - 25% of the height).
          const [s0, sx, sz] = await page.evaluate(([x, z]) => [window.__spooky.screenOf(x, z), window.__spooky.screenOf(x + 10, z), window.__spooky.screenOf(x, z + 10)], [best.x, best.z]);
          const a = (sx[0] - s0[0]) / 10, b = (sz[0] - s0[0]) / 10, c = (sx[1] - s0[1]) / 10, d = (sz[1] - s0[1]) / 10;
          const ex = viewport.width / 2 - s0[0];
          const ey = viewport.height * 0.25 - s0[1];
          const det = a * d - b * c;
          if (!det) break;
          // Moving the aim by g (metres) moves the place on screen by -J g, so aim -= J^-1 (target - now).
          aim = { x: aim.x - (d * ex - b * ey) / det, z: aim.z - (-c * ex + a * ey) / det };
        }
        await page.evaluate(([x, z]) => window.__spooky.aimAt(x, z), [aim.x, aim.z]);
      }
      for (const [sensor, key] of [['thermal', 'whiteHot'], ['night', 'night']]) {
        await page.evaluate((s) => window.__spooky.setSensor(s), sensor);
        await page.waitForTimeout(1500);
        if (sensor === 'thermal' && (await info(page)).polarity) errs.push('expected white hot');
        // The gunship keeps circling: wait (up to 15 s) until a landmark is on screen, then hold the
        // picture still (0 s game steps) so the screenshot and the measurements show the same frame.
        await page.waitForFunction(() => [...document.querySelectorAll('.hud-landmark')].some((e) => !e.hidden), null, { timeout: 15000, polling: 50 }).catch(() => {});
        await page.evaluate(() => window.__spooky.fixedStep(0));
        await page.waitForTimeout(250);
        out_.shots[key] = `${out}/landmarks-${name}-${key}.png`;
        await page.screenshot({ path: out_.shots[key] });
        const st = await page.evaluate(() => {
          const shown = [...document.querySelectorAll('.hud-landmark')].filter((e) => !e.hidden && getComputedStyle(e).display !== 'none');
          return shown.map((e) => {
            const l = e.querySelector('.lm-label');
            const cs = getComputedStyle(l);
            const r = l.getBoundingClientRect();
            return { text: l.textContent, font: parseFloat(cs.fontSize), stroke: cs.webkitTextStrokeWidth, shadow: cs.textShadow, opacity: Number(getComputedStyle(e).opacity), r: [r.left, r.top, r.right, r.bottom], vw: innerWidth, vh: innerHeight };
          });
        });
        out_.labels[key] = st.map((l) => l.text);
        if (st.length < 1) errs.push(`${key}: no landmark on screen`);
        if (st.length > 6) errs.push(`${key}: ${st.length} landmarks on screen (max 6)`);
        for (const l of st) {
          if (l.font < 14) errs.push(`${key}: "${l.text}" at ${l.font} px (min 14)`);
          if (!(parseFloat(l.stroke) > 0) && (!l.shadow || l.shadow === 'none')) errs.push(`${key}: "${l.text}" has no outline`);
          if (l.opacity < 0.25) errs.push(`${key}: "${l.text}" shown at opacity ${l.opacity}`);
          if (CHILD.test(l.text)) errs.push(`${key}: child place on screen: "${l.text}"`);
          if (l.r[0] < 0 || l.r[1] < 0 || l.r[2] > l.vw || l.r[3] > l.vh) errs.push(`${key}: "${l.text}" not fully on screen`);
        }
        st.forEach((a, i) => st.forEach((b, j) => {
          if (j > i && a.r[0] < b.r[2] && a.r[2] > b.r[0] && a.r[1] < b.r[3] && a.r[3] > b.r[1]) errs.push(`${key}: "${a.text}" overlaps "${b.text}"`);
        }));
        const blockers = [...hudPanels(), '.hud-keys', '.hud-cross', '.hud-marker', '.touch-controls:not([hidden]) .tc-stick', '.touch-controls:not([hidden]) .tc-btn', '.touch-controls:not([hidden]) .tc-fire'];
        errs.push(...(await overlaps(page, '.hud-landmark:not([hidden]) .lm-label, .hud-landmark:not([hidden]) .lm-pin', blockers)).map((e) => `${key}: ${e}`));
        await page.evaluate(() => window.__spooky.fixedStep(null));
      }
      // Settings → "Show landmarks" off hides them all (keyboard and mouse run).
      if (!touch) {
        await page.keyboard.press('Escape');
        await page.waitForSelector('.overlay .card.pause');
        await page.click('.overlay button:has-text("Settings")');
        await page.click('.settings-panel label:has-text("Show landmarks")');
        await page.click('.settings-panel button:has-text("Done")');
        await page.waitForTimeout(400);
        await page.keyboard.press('Escape');
        await waitInfo(page, () => window.__spooky.info().screen === 'playing');
        await page.waitForTimeout(300);
        const left = await page.evaluate(() => [...document.querySelectorAll('.hud-landmark .lm-label')].filter((e) => e.getBoundingClientRect().width > 0).length);
        if (left) errs.push(`"Show landmarks" off: ${left} landmarks still showing`);
        const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('spooky.settings') ?? '{}').showLandmarks);
        if (saved !== false) errs.push(`"Show landmarks" off was not saved (${saved})`);
        out_.shots.off = `${out}/landmarks-${name}-off.png`;
        await page.screenshot({ path: out_.shots.off });
        await page.evaluate(() => localStorage.removeItem('spooky.settings'));
      }
    } catch (e) {
      errs.push(String(e));
    }
    res.push(out_);
    await page.close();
  }
  return res;
}

// ---------- 3.39: high-rise visibility ----------
// Street-level aim points: two Midtown canyons (6th Avenue by Times Square, a cross street) and a
// plaza, and the sample town's centre. Through the test hooks only (window.__spooky.orbit / sight):
//  - the orbit: Midtown flies the tighter, steeper orbit (moderate: 20-30° off vertical), the sample
//    town keeps the sim's own orbit;
//  - around a whole circle: each canyon point is clear of buildings (not MASKED) from some part of the
//    orbit, and is never covered by anything drawn solid (the cut-away keeps the aim point in sight);
//  - MASKED shows on the reticle whenever a building is on the line of fire (screenshot);
//  - flashes: sweeping and jumping the aim across Midtown in white hot and night vision.
async function highriseChecks(browser) {
  const res = [];
  const NY = 'preset=new-york-midtown&autostart=1&type=clear&difficulty=1&seed=3';
  const TOWN = 'autostart=1&type=clear&difficulty=1&seed=3';
  const canyons = [[-93, 59], [-78, 163]];
  const advance = async (page, sec, step = 0.05) => {
    const t1 = await gameTime(page);
    await fixedStep(page, step);
    // Until the clock gets there, or the mission ends (its clock stops).
    await page.waitForFunction((tt) => window.__spooky.state().t >= tt || window.__spooky.info()?.screen !== 'playing', t1 + sec, { timeout: 240000, polling: 50 });
    await fixedStep(page, 0);
  };
  // 1. Orbits and lines of sight round a whole circle (120 s of game time, sampled every 10 s), a fresh
  //    mission per point (a whole orbit is half the mission's clock). If the mission ends early (the
  //    horde wins in the sample town), the samples so far count; at least 6 are needed.
  for (const [name, query, points] of [['new york', NY, canyons], ['sample town', TOWN, [[0, 0]]]]) {
    const r = { type: `highrise: orbit and lines of sight (${name})`, errors: [], points: [] };
    for (const [x, z] of points) {
      const { page, errs } = await gamePage(browser, query);
      try {
        await page.evaluate(([x, z]) => window.__spooky.aimAt(x, z), [x, z]);
        await advance(page, 8, 0.1); // the orbit eases over a few seconds
        const o = await page.evaluate(() => window.__spooky.orbit());
        const pt = { x, z, radius: Math.round(o.r), offVertical: Number(o.offVertical.toFixed(1)), tallness: Number(o.tallness.toFixed(1)), clearAt: 0, maskedAt: 0, coveredAt: 0, samples: 0 };
        if (name === 'new york') {
          if (o.r > 800) r.errors.push(`(${x}, ${z}): Midtown should fly the tight orbit (radius ${o.r.toFixed(0)} m)`);
          if (o.offVertical < 20 || o.offVertical > 30) r.errors.push(`(${x}, ${z}): ${o.offVertical.toFixed(1)}° off vertical (moderate: 20-30°)`);
        } else if (Math.abs(o.r - 1000) > 1) r.errors.push(`sample town should keep the sim's orbit (radius ${o.r.toFixed(1)} m)`);
        for (let i = 0; i < 12; i++) {
          if ((await info(page)).screen !== 'playing') break;
          await advance(page, 10, 1);
          await advance(page, 0.4, 0.05); // fades settle (0.25 s)
          const s = await page.evaluate(([x, z]) => window.__spooky.sight(x, z), [x, z]);
          pt.samples++;
          if (s.masked) pt.maskedAt++;
          else pt.clearAt++;
          if (s.covered) pt.coveredAt++;
        }
        if (pt.samples < 6) r.errors.push(`(${x}, ${z}): only ${pt.samples} samples round the orbit`);
        if (!pt.clearAt) r.errors.push(`(${x}, ${z}): masked all the way round the orbit`);
        if (pt.coveredAt) r.errors.push(`(${x}, ${z}): covered by a solid building ${pt.coveredAt}/${pt.samples} times (the cut-away should keep the aim point in sight)`);
        r.points.push(pt);
      } catch (e) {
        r.errors.push(`(${x}, ${z}): ${e}`);
      }
      r.errors.push(...errs);
      await page.close();
    }
    res.push(r);
  }
  // 2. Screenshots at street level: three sensors and the 25 mm, a MASKED example (New York), and the town.
  for (const [name, query, aims] of [['ny', NY, [[-93, 59], [228, -223]]], ['town', TOWN, [[0, 0]]]]) {
    for (const [ai, [x, z]] of aims.entries()) {
      const { page, errs } = await gamePage(browser, query, { viewport: { width: 1280, height: 720 }, deviceScaleFactor: scale });
      const r = { type: `highrise: screenshots (${name} ${x}, ${z})`, errors: errs, shots: {} };
      try {
        await page.evaluate(([x, z]) => window.__spooky.aimAt(x, z), [x, z]);
        await advance(page, 8, 0.1);
        const shot = async (k) => {
          await page.waitForTimeout(250);
          r.shots[k] = `${out}/highrise-${name}${ai}-${k}.png`;
          await page.screenshot({ path: r.shots[k] });
        };
        // MASKED example: wait (up to one orbit) for a moment a building is on the line of fire.
        if (name === 'ny' && ai === 0) {
          let masked = false;
          for (let i = 0; i < 40 && !masked; i++) {
            masked = (await page.evaluate(() => window.__spooky.orbit().masked));
            if (!masked) await advance(page, 3, 0.5);
          }
          await advance(page, 0.4);
          if (!masked) r.errors.push('no MASKED moment in a whole orbit over a Midtown canyon');
          else {
            const tag = await page.evaluate(() => {
              const c = document.querySelector('.hud-cross');
              return { cls: c?.classList.contains('masked'), text: c?.dataset.mask };
            });
            if (!tag.cls || tag.text !== 'MASKED') r.errors.push(`the reticle doesn't show MASKED: ${JSON.stringify(tag)}`);
            r.cut = (await page.evaluate(([x, z]) => window.__spooky.sight(x, z), [x, z])).cut;
            await shot('masked');
            // The same moment without the cut-away, for comparison.
            await page.evaluate(() => window.__spooky.cutaway(false));
            await advance(page, 0.4);
            await shot('masked-no-cutaway');
            await page.evaluate(() => window.__spooky.cutaway(true));
            await advance(page, 0.4);
          }
        }
        r.drawCalls = (await info(page)).drawCalls;
        if (r.drawCalls > 40) r.errors.push(`${r.drawCalls} draw calls (aim ≤ 40)`);
        await shot('whitehot');
        await page.evaluate(() => window.__spooky.setSensor('night'));
        await advance(page, 1.2);
        await shot('night');
        await page.evaluate(() => window.__spooky.setSensor('thermal'));
        await advance(page, 1.2);
        await page.keyboard.press('1');
        await advance(page, 0.6);
        await shot('25mm');
        await page.keyboard.press('2');
        await page.keyboard.press('h');
        await advance(page, 0.8);
        await shot('blackhot');
        // A zombie in a Midtown street: aim at the live one nearest this point; it must not be covered
        // by anything drawn solid (its pixel is not under an opaque building), at 40 mm and 25 mm.
        if (name === 'ny') {
          await page.keyboard.press('h');
          await advance(page, 0.8);
          const zs = await page.evaluate(() => window.__spooky.zombies());
          const zb = zs.sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z))[0];
          if (!zb) r.errors.push('no live zombie to look at');
          else {
            r.zombie = { x: Math.round(zb.x), z: Math.round(zb.z), cold: zb.cold, samples: 0, covered: 0 };
            await page.evaluate(([x, z]) => window.__spooky.aimAt(x, z), [zb.x, zb.z]);
            for (const [gun, k] of [['2', 'zombie-40mm'], ['1', 'zombie-25mm']]) {
              await page.keyboard.press(gun);
              await advance(page, 0.6, 1 / 60);
              const near = await page.evaluate(() => window.__spooky.zombies());
              const zz = near.sort((a, b) => Math.hypot(a.x - zb.x, a.z - zb.z) - Math.hypot(b.x - zb.x, b.z - zb.z))[0] ?? zb;
              await page.evaluate(([x, z]) => window.__spooky.aimAt(x, z), [zz.x, zz.z]);
              await advance(page, 0.4, 1 / 60);
              const sg = await page.evaluate(([x, z]) => window.__spooky.sight(x, z), [zz.x, zz.z]);
              r.zombie.samples++;
              if (sg.covered) r.zombie.covered++;
              r.zombie[k === 'zombie-40mm' ? 'masked40' : 'masked25'] = sg.masked;
              await shot(k);
            }
            if (r.zombie.covered) r.errors.push(`the zombie in the street is covered by a solid building (${r.zombie.covered}/${r.zombie.samples})`);
          }
        }
      } catch (e) {
        r.errors.push(String(e));
      }
      res.push(r);
      await page.close();
    }
  }
  // 3. Flashes while the aim sweeps across Midtown at 70 m/s (the keyboard nudge, 400 px/s, at this
  //    640 x 360 window and the 40 mm lens) and then jumps between canyons once a second (fast taps):
  //    buildings cut and come back all the time. Measured on 22 Nov, night vision, cut-away on / off:
  //    a 150 m/s sweep fails the cell-area check either way (30% / 29%: Midtown's lit windows scrolling
  //    past, not the cut-away), and so do jumps every 0.4 s (34% / 56%: the whole scene changing).
  //    Both are pre-existing, reported as follow-ups.
  for (const sensor of ['thermal', 'night']) {
    const { page, errs } = await gamePage(browser, NY);
    try {
      if (sensor === 'night') await page.evaluate(() => window.__spooky.setSensor('night'));
      await advance(page, 1.5);
      await page.evaluate(() => {
        const path = [[-250, -150], [250, 150], [-200, 200], [200, -200]];
        const jumps = [[-93, 59], [228, -223], [-78, 163], [74, 53], [-245, 63], [234, -40]];
        const t0 = window.__spooky.state().t;
        const loop = () => {
          if (window.__sweepStop) return;
          const t = window.__spooky.state().t - t0;
          if (t < 6) {
            const d = t * 70;
            let k = 0;
            let left = d;
            while (k < path.length - 2) {
              const L = Math.hypot(path[k + 1][0] - path[k][0], path[k + 1][1] - path[k][1]);
              if (left <= L) break;
              left -= L;
              k++;
            }
            const [a, b] = [path[k], path[k + 1]];
            const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
            const u = Math.min(1, left / L);
            window.__spooky.aimAt(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u);
          } else {
            const j = jumps[Math.floor(t - 6) % jumps.length];
            window.__spooky.aimAt(j[0], j[1]);
          }
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      });
      await fixedStep(page, 1 / 60);
      await startMeter(page, 'canvas.game-canvas');
      const t0 = await gameTime(page);
      await untilGameTime(page, t0 + 11);
      const frames = await stopMeter(page);
      await page.evaluate(() => (window.__sweepStop = true));
      const r = judge(`highrise: aim sweeping and jumping across Midtown, ${sensor === 'night' ? 'night vision' : 'white-hot'}`, frames);
      r.errors.push(...errs);
      res.push(r);
    } catch (e) {
      res.push({ type: `highrise: sweep (${sensor})`, errors: [String(e), ...errs] });
    }
    await page.close();
  }
  // 4. Reduced motion across the edge of Midtown's high-rise blocks, (-500, 0) to (-300, -160): a slow
  //    pan back and forth (20 m/s) with stops, then a fast circle (100 m/s) over the edge. The orbit may
  //    only change in single cuts at least 1.5 s apart, and the flash checks must pass.
  {
    const { page, errs } = await gamePage(browser, NY, { reducedMotion: 'reduce' });
    try {
      await advance(page, 1.5);
      await page.evaluate(() => {
        const A = [-500, 0];
        const B = [-300, -160];
        const L = Math.hypot(B[0] - A[0], B[1] - A[1]);
        const t0 = window.__spooky.state().t;
        const log = (window.__orbitCuts = []);
        let last = null;
        const loop = () => {
          if (window.__sweepStop) return;
          const t = window.__spooky.state().t - t0;
          let x;
          let z;
          if (t < 14) {
            // 20 m/s each way, a 1.5 s stop at each end.
            const leg = L / 20 + 1.5;
            const k = Math.floor(t / leg);
            const u = Math.min(1, ((t % leg) * 20) / L);
            const f = k % 2 ? 1 - u : u;
            x = A[0] + (B[0] - A[0]) * f;
            z = A[1] + (B[1] - A[1]) * f;
          } else {
            const c = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
            const w = 100 / 130;
            x = c[0] + Math.cos((t - 14) * w) * 130;
            z = c[1] + Math.sin((t - 14) * w) * 130;
          }
          window.__spooky.aimAt(x, z);
          const o = window.__spooky.orbit();
          if (last && (Math.abs(o.cx - last.cx) > 1 || Math.abs(o.cz - last.cz) > 1 || Math.abs(o.r - last.r) > 1)) log.push(Number(t.toFixed(3)));
          last = o;
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      });
      await fixedStep(page, 1 / 60);
      await startMeter(page, 'canvas.game-canvas');
      const t0 = await gameTime(page);
      await untilGameTime(page, t0 + 20, 900000); // 1200 frames: slow on a software renderer
      const frames = await stopMeter(page);
      const cuts = await page.evaluate(() => {
        window.__sweepStop = true;
        return window.__orbitCuts;
      });
      const r = judge('highrise: reduced motion, panning over the edge of the high-rise blocks, white-hot', frames, { orbitCuts: cuts });
      for (let i = 1; i < cuts.length; i++) if (cuts[i] - cuts[i - 1] < 1.5) r.errors.push(`orbit cuts ${cuts[i - 1]} s and ${cuts[i]} s are less than 1.5 s apart`);
      r.errors.push(...errs);
      res.push(r);
    } catch (e) {
      res.push({ type: 'highrise: reduced motion sweep', errors: [String(e), ...errs] });
    }
    await page.close();
  }
  return res;
}

// ---------------------------------------------------------------------------------------------
// Spec 003 (Horde Night, a crowd mode): flash scenarios A, B and C for the safety checks, and the
// crowd section (--only crowd): screenshots at the surge, draw calls, triangles, frame times,
// the HUD at tablet size, and level-of-detail heat parity on the real models.
// ---------------------------------------------------------------------------------------------

/** The densest 16 m cell of live zombies at least `clear` metres from the doors (and its zombie count). */
function crowdDensest(page, doors, clear = 45, skip = 0) {
  return page.evaluate(([d, clr, sk]) => {
    const zs = window.__spooky.zombies();
    const m = new Map();
    for (const z of zs) {
      if (Math.hypot(z.x - d.x, z.z - d.z) < clr) continue;
      const k = `${Math.floor(z.x / 16)},${Math.floor(z.z / 16)}`;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    const cells = [...m.entries()].sort((a, b) => b[1] - a[1]);
    const pick = cells[Math.min(sk, cells.length - 1)];
    if (!pick) return { x: d.x, z: d.z, n: 0, alive: zs.length }; // nothing out on the streets: the doors
    const [i, j] = pick[0].split(',').map(Number);
    let sx = 0;
    let sz = 0;
    let n = 0;
    for (const z of zs) if (Math.floor(z.x / 16) === i && Math.floor(z.z / 16) === j) { sx += z.x; sz += z.z; n++; }
    return { x: sx / n, z: sz / n, n, alive: zs.length };
  }, [doors, clear, skip]);
}

/** Open a crowd night and fast-forward (sim only matters) to game time `t`, then back to 60 fps game time. */
async function crowdAt(browser, size, t, viewport, extra = {}, shell = true) {
  const { page, errs } = await gamePage(browser, `mode=crowd&size=${size}&seed=1&autostart=1&fps=1`, { viewport, ...extra });
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  const doors = (await info(page)).aim;
  // Nobody shooting, the streets empty onto the doors and the cap drops the surge: keep the doors' pile down
  // (105 and 40 at it), so the streams stay packed. Fast-forwarded in a tiny window (software rendering is slow).
  await page.setViewportSize({ width: 320, height: 200 });
  // (shell = false: nobody fires, so the crowd is at its size's cap when the scenario starts.)
  if (shell) await crowdFireLoop(page, doors, ['105', '40'], false, -45);
  await fixedStep(page, 1);
  await untilGameTime(page, t - 6, 1800000);
  if (shell) await stopCrowdFire(page);
  await untilGameTime(page, t, 1800000); // the 105 reloads, so scenarios start with every gun loaded
  await fixedStep(page, 1 / 60);
  await page.setViewportSize(viewport);
  await page.waitForTimeout(300);
  return { page, errs, doors };
}

/** In the page: every frame, fire each ready gun (the given ones) at the densest stream cells (test hooks only). */
function crowdFireLoop(page, doors, guns, spread, clear = 45) {
  return page.evaluate(([d, gs, spr, clr]) => {
    const st = { stop: false, aimT: -1 };
    window.__crowdFire = st;
    const cells = () => {
      const zs = window.__spooky.zombies();
      const m = new Map();
      for (const z of zs) {
        const r = Math.hypot(z.x - d.x, z.z - d.z);
        // clear > 0: streams only (this far from the doors or more); clear < 0: the doors' pile only.
        if (clr >= 0 ? r < clr : r > -clr) continue;
        const k = `${Math.floor(z.x / 16)},${Math.floor(z.z / 16)}`;
        const c = m.get(k) ?? { n: 0, x: 0, z: 0 };
        c.n++;
        c.x += z.x;
        c.z += z.z;
        m.set(k, c);
      }
      return [...m.values()].sort((a, b) => b.n - a.n).map((c) => ({ x: c.x / c.n, z: c.z / c.n }));
    };
    const loop = () => {
      if (st.stop) return;
      const t = window.__spooky.state().t;
      const cs = cells();
      if (cs.length) {
        if (t - st.aimT > 0.5) {
          window.__spooky.aimAt(cs[0].x, cs[0].z);
          st.aimT = t;
        }
        gs.forEach((g, i) => {
          const c = spr ? cs[Math.min(i, cs.length - 1)] : cs[0];
          window.__spooky.fireAt(g, c.x, c.z);
        });
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }, [doors, guns, spread, clear]);
}
/** Wheel the zoom to at least `to` (2: the x2.4 step) or back to x1 (the gun's own lens). */
async function crowdZoom(page, to) {
  const vp = page.viewportSize();
  await page.mouse.move(vp.width / 2, vp.height / 2);
  for (let i = 0; i < 5; i++) {
    const z = (await info(page)).zoomLevel;
    if (to > 1 ? z >= to : Math.abs(z - 1) < 0.01) return;
    await page.mouse.wheel(0, to > 1 || z < 1 ? -100 : 100);
    await page.waitForTimeout(50);
  }
}

function stopCrowdFire(page) {
  return page.evaluate(() => { window.__crowdFire.stop = true; });
}

// (A function, not a const: the checks run from top-level await before consts down here exist.)
function crowdSensors() {
  return [
  ['white-hot', async () => {}],
  ['black-hot', async (p) => { await p.keyboard.press('h'); }],
  ['night vision', async (p) => { await p.evaluate(() => window.__spooky.setSensor('night')); }],
  ];
}

async function crowdFlashChecks(browser) {
  const res = [];
  const SURGE = 205;
  // A. Ten seconds of the dawn surge with all three guns into the densest stream, each view, at a small
  //    desktop window (Huge) and the tablet viewport (1280 x 800, Big).
  for (const [size, viewport] of [['huge', { width: 640, height: 360 }], ['big', { width: 1280, height: 800 }]]) {
    for (const [label, setup] of crowdSensors()) {
      const { page, errs, doors } = await crowdAt(browser, size, SURGE, viewport);
      await setup(page);
      await untilGameTime(page, (await gameTime(page)) + 1.2, 600000);
      const k0 = (await page.evaluate(() => window.__spooky.state())).kills;
      await startMeter(page, 'canvas.game-canvas');
      const t0 = await gameTime(page);
      await crowdFireLoop(page, doors, ['25', '40', '105'], false);
      await untilGameTime(page, t0 + 10, 1800000);
      await stopCrowdFire(page);
      const frames = await stopMeter(page);
      const st = await page.evaluate(() => window.__spooky.state());
      const r = judge(`crowd A: surge, all three guns into the densest stream 10 s, ${label}, ${size} ${viewport.width}x${viewport.height}`, frames, { kills: st.kills - k0, rounds: st.shots, alive: st.zombiesAlive });
      if (st.kills - k0 < 50) r.errors.push(`only ${st.kills - k0} kills in 10 s: was the gun firing into the crowd?`);
      r.errors.push(...errs);
      r.ok = !r.errors.length;
      res.push(r);
      await page.close();
    }
  }
  // B. Mass kills for 10 s: hold fire to the cap, then the 105, 40 and 25 onto the densest cell, Huge, white-hot. Gate
  //    (spec 003): the spec's 50+ kills a second sustained over the 10 s, plus at least one 1-second
  //    window of 150+ kills, so the opening burst is covered too (strictly harder than the spec's gate).
  {
    // Hold fire until the crowd is at Huge's cap (800 alive, from t = 200), then open with the 105 on the densest
    // cell and bring the 40 and the 25 into the same spot as it lands: the worst burst the meter can see.
    const { page, errs, doors } = await crowdAt(browser, 'huge', 200, { width: 640, height: 360 }, {}, false);
    await untilGameTime(page, (await gameTime(page)) + 1, 600000);
    const alive0 = (await page.evaluate(() => window.__spooky.state())).zombiesAlive;
    const k0 = (await page.evaluate(() => window.__spooky.state())).kills;
    await startMeter(page, 'canvas.game-canvas');
    const t0 = await gameTime(page);
    await page.evaluate(() => {
      const log = [];
      window.__killLog = log;
      window.__killLogStop = false;
      const loop = () => {
        if (window.__killLogStop) return;
        const s = window.__spooky.state();
        log.push([s.t, s.kills]);
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    const spot = await crowdDensest(page, doors, 0);
    await page.evaluate(([x, z]) => {
      window.__spooky.aimAt(x, z);
      window.__spooky.fireAt('105', x, z);
    }, [spot.x, spot.z]);
    // The 105 flies ~3.6 s, the 40 ~2 s and the 25 ~1.7 s: start them so their first rounds land with the 105.
    await untilGameTime(page, t0 + 1.6, 600000);
    await crowdFireLoop(page, doors, ['40', '25', '105'], false, 0);
    await untilGameTime(page, t0 + 10, 1800000);
    await stopCrowdFire(page);
    const frames = await stopMeter(page);
    const kills = (await page.evaluate(() => window.__spooky.state())).kills - k0;
    // The best 1-second window of game time.
    const log = await page.evaluate(() => {
      window.__killLogStop = true;
      return window.__killLog;
    });
    let bestSecond = 0;
    for (let i = 0, j = 0; i < log.length; i++) {
      while (log[i][0] - log[j][0] > 1) j++;
      bestSecond = Math.max(bestSecond, log[i][1] - log[j][1]);
    }
    const r = judge('crowd B: 10 s of mass kills (105, 40 and 25 into the three densest cells), white-hot, huge', frames, { kills, killsPerSec: Number((kills / 10).toFixed(1)), bestSecond, aliveAtStart: alive0, firstCell: spot.n });
    if (kills < 500) r.errors.push(`${(kills / 10).toFixed(1)} kills a second over 10 s: the scenario needs 50 or more (not a flash failure; the crowd wasn't dense enough)`);
    if (bestSecond < 150) r.errors.push(`best 1-second window ${bestSecond} kills: the scenario needs a burst of 150 or more`);
    r.errors.push(...errs);
    r.ok = !r.errors.length;
    res.push(r);
    await page.close();
  }
  // C. Feel M3: the 25 mm zoomed x2 on a packed stream and a 105 into it, white-hot and black-hot. The meter
  //    counts darkening as well as brightening (a whole stream dying at once).
  for (const [label, setup] of crowdSensors().slice(0, 2)) {
    const { page, errs, doors } = await crowdAt(browser, 'huge', SURGE, { width: 640, height: 360 });
    await page.keyboard.press('1');
    await crowdZoom(page, 2);
    await setup(page);
    const c = await crowdDensest(page, doors);
    await page.evaluate(([x, z]) => window.__spooky.aimAt(x, z), [c.x, c.z]);
    await untilGameTime(page, (await gameTime(page)) + 1.2, 600000);
    const k0 = (await page.evaluate(() => window.__spooky.state())).kills;
    const fired = await page.evaluate(([x, z]) => window.__spooky.fireAt('105', x, z), [c.x, c.z]);
    const t0 = await gameTime(page);
    await fixedStep(page, 0.05);
    await untilGameTime(page, t0 + 3, 600000);
    await fixedStep(page, 1 / 60);
    await startMeter(page, 'canvas.game-canvas');
    await untilGameTime(page, t0 + 8, 1200000);
    const frames = await stopMeter(page);
    const kills = (await page.evaluate(() => window.__spooky.state())).kills - k0;
    const zl = (await info(page)).zoomLevel;
    const r = judge(`crowd C: a 105 into a packed stream through the 25 mm zoomed x${zl}, ${label} (darkening counted)`, frames, { kills, crowdInCell: c.n });
    if (!fired) r.errors.push('the 105 did not fire');
    if (zl < 2) r.errors.push(`zoom only x${zl}`);
    r.errors.push(...errs);
    r.ok = !r.errors.length;
    res.push(r);
    await page.close();
  }
  return res;
}

/** Real frame times in the page for `secs` of real time: median fps, worst whole second, longest frame. */
function crowdFrameTimes(page, secs) {
  return page.evaluate((s) => new Promise((done) => {
    const ts = [];
    const end = performance.now() + s * 1000;
    const loop = (t) => {
      ts.push(t);
      if (t < end) requestAnimationFrame(loop);
      else {
        const d = ts.slice(1).map((x, i) => x - ts[i]).sort((a, b) => a - b);
        const med = d[d.length >> 1] || 0;
        let worst = Infinity;
        for (let i = 0, j = 0; i < ts.length; i++) {
          while (ts[i] - ts[j] > 1000) j++;
          if (ts[i] - ts[0] >= 1000) worst = Math.min(worst, i - j);
        }
        done({ medianFps: med ? Number((1000 / med).toFixed(1)) : 0, worst1sFps: Number.isFinite(worst) ? worst : 0, maxFrameMs: Number((d[d.length - 1] || 0).toFixed(1)), frames: d.length });
      }
    };
    requestAnimationFrame(loop);
  }), secs);
}

async function crowdChecks(browser) {
  const res = [];
  for (const [size, viewport, touch] of [['big', { width: 1280, height: 800 }, true], ['huge', { width: 1280, height: 720 }, false]]) {
    const { page, errs, doors } = await crowdAt(browser, size, 215, viewport, touch ? { hasTouch: true, isMobile: true } : {});
    const errors = [];
    const r = { type: `crowd night: ${size} at the surge, ${viewport.width}x${viewport.height}${touch ? ' touch' : ''}`, ok: true, errors };
    // A fresh pile: a 105 into the densest stream, then the views once it has landed.
    const c = await crowdDensest(page, doors);
    await page.evaluate(([x, z]) => window.__spooky.aimAt(x, z), [c.x, c.z]);
    const k0 = (await page.evaluate(() => window.__spooky.state())).kills;
    await page.evaluate(([x, z]) => window.__spooky.fireAt('105', x, z), [c.x, c.z]);
    await untilGameTime(page, (await gameTime(page)) + 4.6, 600000);
    r.killsBy105 = (await page.evaluate(() => window.__spooky.state())).kills - k0;
    r.alive = (await page.evaluate(() => window.__spooky.state())).zombiesAlive;
    // Real-time frames (cloud: no GPU, regression only) in the 105 view.
    await page.keyboard.press('3');
    await fixedStep(page, null);
    r.frames105 = await crowdFrameTimes(page, 8);
    const i105 = await info(page);
    r.drawCalls105 = i105.drawCalls;
    r.triangles105 = i105.triangles;
    await fixedStep(page, 1 / 60);
    for (const [label, setup] of crowdSensors()) {
      await setup(page);
      await untilGameTime(page, (await gameTime(page)) + 0.8, 600000);
      const slug = label.replace(/\s+/g, '-');
      for (const zoomed of [false, true]) {
        await page.keyboard.press(zoomed ? '1' : '3');
        if (zoomed) await crowdZoom(page, 2);
        await page.evaluate(([x, z]) => window.__spooky.aimAt(x, z), [c.x, c.z]);
        await untilGameTime(page, (await gameTime(page)) + 0.6, 600000);
        const file = `${out}/crowd-${size}-${slug}-${zoomed ? 'x2' : 'x1'}.png`;
        await page.screenshot({ path: file });
        const inf = await info(page);
        (r.shots ??= []).push({ file, drawCalls: inf.drawCalls, triangles: inf.triangles, zoom: inf.zoomLevel });
        if (inf.drawCalls >= 150) errors.push(`${inf.drawCalls} draw calls (${label}, ${zoomed ? 'zoomed 25 mm' : '105 view'}): budget is < 150`);
        if (zoomed) await crowdZoom(page, 1);
      }
      if (label === 'black-hot') await page.keyboard.press('h'); // back to white-hot before night vision
    }
    // The zoomed 25 mm in real time as well (models near the aim point).
    await page.evaluate(() => window.__spooky.setSensor('thermal'));
    await page.keyboard.press('1');
    await crowdZoom(page, 2);
    await fixedStep(page, null);
    r.framesZoomed25 = await crowdFrameTimes(page, 8);
    const iz = await info(page);
    r.drawCallsZoomed25 = iz.drawCalls;
    r.trianglesZoomed25 = iz.triangles;
    await fixedStep(page, 1 / 60);
    // HUD (Feel M1, S2): KILLS, multiplier and score top centre, clear of every other panel and the touch buttons;
    // numbers 18 px or more; no FRIENDLY FIRE, FRIENDLIES or CONTACTS.
    const hud = await page.evaluate(() => {
      const px = (sel) => [...document.querySelectorAll(sel)].map((e) => parseFloat(getComputedStyle(e).fontSize));
      return { kills: px('.crowd-kills'), mult: px('.crowd-mult'), tally: px('.crowd-tally'), text: document.querySelector('.hud-mission')?.textContent ?? '', top: document.querySelector('.crowd-kills')?.textContent ?? '' };
    });
    r.hud = hud;
    if (Math.min(...hud.kills, ...hud.mult, ...hud.tally) < 18) errors.push(`HUD numbers below 18 px: ${JSON.stringify(hud)}`);
    if (/FRIENDLY FIRE|FRIENDLIES|CONTACTS/.test(hud.text)) errors.push(`mission panel shows words this mode doesn't need: ${hud.text}`);
    if (!/^KILLS \d/.test(hud.top)) errors.push(`no KILLS counter: "${hud.top}"`);
    const ov = await overlaps(page, '.crowd-top', [...hudPanels(), '.touch-controls button', '.touch-controls [class*=stick]']);
    if (ov.length) errors.push(...ov);
    await page.screenshot({ path: `${out}/crowd-${size}-hud-${viewport.width}x${viewport.height}.png` });
    // Level of detail on the real model: same mean heat (within 0.03) as the figure it stands in for.
    const lod = await page.evaluate(() => window.__spooky.lodParity?.() ?? null);
    r.lod = lod;
    if (lod && lod.model !== null) {
      const dHeat = Math.abs(lod.model - lod.figure) * (0.98 - 0.5);
      r.lodHeatGap = Number(dHeat.toFixed(4));
      if (dHeat > 0.03) errors.push(`LOD mean heat differs by ${dHeat.toFixed(3)} (limit 0.03): figure weight ${lod.figure.toFixed(3)}, model ${lod.model.toFixed(3)}`);
    } else errors.push('the character models did not load, so level of detail was not exercised');
    errors.push(...errs);
    r.ok = !errors.length;
    res.push(r);
    await page.close();
  }
  // Phone landscape (844 x 390 and 844 x 540, touch): the worst-case crowd bar and alarm must clear the minimap, the DAWN panel and the touch controls.
  for (const viewport of [{ width: 844, height: 390 }, { width: 844, height: 540 }]) {
    const { page, errs } = await crowdAt(browser, 'big', 20, viewport, { hasTouch: true, isMobile: true }, false);
    const errors = [];
    const r = { type: `crowd night: phone landscape ${viewport.width}x${viewport.height} touch, worst-case bar and alarm clear of minimap, DAWN panel and controls`, ok: true, errors };
    await untilGameTime(page, (await gameTime(page)) + 0.5, 600000);
    // Worst case: five-digit counts, a x9 multiplier and the longest alarm, measured in one synchronous step (the game loop rewrites them every frame).
    const found = await page.evaluate(() => {
      const bar = document.querySelector('.crowd-top');
      const alarm = document.querySelector('.crowd-alarm');
      if (!bar || !alarm) return { missing: true };
      alarm.hidden = false;
      alarm.textContent = 'DOORS: THEY\u2019RE CLOSE';
      bar.querySelector('.crowd-kills').textContent = 'KILLS 9,999';
      bar.querySelector('.crowd-mult').textContent = '\u00d79';
      bar.querySelector('.crowd-score').textContent = 'SCORE 99,999';
      const box = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 ? { l: b.left, t: b.top, r: b.right, b: b.bottom } : null; };
      const others = ['.hud-minimap', '.hud-weapons', '.hud-mission', '.hud-sensor', '.touch-controls:not([hidden]) .tc-stick', '.touch-controls:not([hidden]) .tc-btn', '.touch-controls:not([hidden]) .tc-fire']
        .flatMap((s) => [...document.querySelectorAll(s)].map((e) => [s, box(e)]).filter(([, b]) => b));
      const hits = [];
      for (const [name, e] of [['.crowd-top', bar], ['.crowd-alarm', alarm]]) {
        const a = box(e);
        for (const [s, b] of others) if (a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t) hits.push(name + ' overlaps ' + s);
        if (a.l < 0 || a.t < 0 || a.r > innerWidth || a.b > innerHeight) hits.push(name + ' runs off screen');
      }
      return { hits, minimap: box(document.querySelector('.hud-minimap')), bar: box(bar), alarm: box(alarm) };
    });
    if (found.missing) errors.push('no .crowd-top or .crowd-alarm element');
    else errors.push(...found.hits);
    r.boxes = found;
    await page.screenshot({ path: `${out}/crowd-big-hud-${viewport.width}x${viewport.height}.png` });
    errors.push(...errs);
    r.ok = !errors.length;
    res.push(r);
    await page.close();
  }
  return res;
}
