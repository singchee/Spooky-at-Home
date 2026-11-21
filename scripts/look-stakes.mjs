// Screenshots of the result screen (win and loss), personal bests and the settings panel.
// Usage: npm run build && node scripts/look-stakes.mjs [--port 4903] [--out reports/stakes]
// Also checks: text >= 14 px, the primary button after a win is "Next mission" and after a loss "Retry",
// the settings panel's controls are all labelled, keyboard-reachable, and change the stored settings.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const PORT = Number(arg('--port', 4903));
const out = arg('--out', 'reports/stakes');
mkdirSync(out, { recursive: true });
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
await new Promise((res, rej) => {
  server.stdout.on('data', (d) => String(d).includes(String(PORT)) && res());
  setTimeout(() => rej(new Error('preview server did not start')), 20000);
});

const results = [];
let exitCode = 0;
const fail = (r, msg) => { r.errors.push(msg); exitCode = 1; };
const smallText = (sel) => (s) => [...document.querySelectorAll(`${s} *`)]
  .filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && e.offsetParent !== null)
  .filter((e) => parseFloat(getComputedStyle(e).fontSize) < 14)
  .map((e) => e.textContent.trim().slice(0, 40));

async function untilEnded(page) {
  await page.waitForFunction(() => window.__spooky.info()?.screen === 'ended', null, { timeout: 240000, polling: 100 });
}

const browser = await chromium.launch();
try {
  // 1. A win (the bot plays a quick Clear), twice: NEW BEST, then the best line.
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const r = { type: 'result: win', errors: [], shots: {} };
    page.on('pageerror', (e) => fail(r, String(e)));
    for (const round of [1, 2]) {
      await page.goto(`http://localhost:${PORT}/?autostart=1&type=clear&difficulty=1&seed=3&bot=1`);
      await page.waitForFunction(() => window.__spooky?.ready === true);
      await page.evaluate(() => window.__spooky.fixedStep(0.1));
      await untilEnded(page);
      await page.waitForTimeout(400);
      const shot = `${out}/result-win-${round}.png`;
      await page.screenshot({ path: shot });
      r.shots[`win${round}`] = shot;
      const info = await page.evaluate(() => ({
        grade: document.querySelector('.result .grade')?.textContent,
        reason: document.querySelector('.grade-reason')?.textContent,
        best: document.querySelector('.result .best')?.textContent,
        primary: document.querySelector('.result button.primary')?.textContent,
        focused: document.activeElement?.textContent,
      }));
      const small = await page.evaluate(smallText(), '.result');
      r[`round${round}`] = info;
      if (info.primary !== 'Next mission') fail(r, `primary after a win is ${info.primary}`);
      if (info.focused !== 'Next mission') fail(r, `focus after a win is on ${info.focused}`);
      if (!/^[SABCD]: /.test(info.reason ?? '')) fail(r, `no grade reason: ${info.reason}`);
      if (round === 1 && !/NEW BEST/.test(info.best ?? '')) fail(r, `first win is not a new best: ${info.best}`);
      if (round === 2 && !/^(Best: [SABCD] \d+:\d\d|NEW BEST)/.test(info.best ?? '')) fail(r, `second win shows no best: ${info.best}`);
      if (small.length) fail(r, `text under 14 px: ${small.join(' | ')}`);
    }
    results.push(r);
    // The recon card shows the best: open the sample town's recon (the classic Clear card at difficulty 1).
    await page.close();
  }
  // 2. A loss by friendly fire (two 105s on the survivors).
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const r = { type: 'result: loss', errors: [], shots: {} };
    page.on('pageerror', (e) => fail(r, String(e)));
    await page.goto(`http://localhost:${PORT}/?autostart=1&type=escort&difficulty=1&seed=2`);
    await page.waitForFunction(() => window.__spooky?.ready === true);
    await page.evaluate(() => window.__spooky.fixedStep(0.1));
    for (let i = 0; i < 6; i++) {
      const done = await page.evaluate(() => window.__spooky.info()?.screen === 'ended');
      if (done) break;
      await page.waitForFunction(() => window.__spooky.state().t > 10, null, { timeout: 60000 });
      await page.evaluate(() => {
        const s = window.__spooky.survivors()[0];
        if (s) window.__spooky.fireAt('105', s.x, s.z);
      });
      const t = await page.evaluate(() => window.__spooky.state().t);
      await page.waitForFunction((tt) => window.__spooky.state().t > tt + 5 || window.__spooky.info()?.screen === 'ended', t, { timeout: 60000 });
    }
    await untilEnded(page);
    await page.waitForTimeout(400);
    r.shots.loss = `${out}/result-loss.png`;
    await page.screenshot({ path: r.shots.loss });
    const info = await page.evaluate(() => ({
      grade: document.querySelector('.result .grade')?.textContent,
      reason: document.querySelector('.grade-reason')?.textContent,
      best: document.querySelector('.result .best')?.textContent,
      primary: document.querySelector('.result button.primary')?.textContent,
      focused: document.activeElement?.textContent,
    }));
    r.info = info;
    if (info.primary !== 'Retry') fail(r, `primary after a loss is ${info.primary}`);
    if (info.grade !== 'D') fail(r, `a loss is graded ${info.grade}`);
    // R still retries.
    await page.keyboard.press('r');
    await page.waitForFunction(() => window.__spooky.info()?.screen === 'playing' || window.__spooky.info()?.screen === 'briefing');
    results.push(r);
    await page.close();
  }
  // 3. Settings panel from the pause screen: keyboard operable, changes settings, game keys ignored.
  for (const [name, viewport] of [['desktop', { width: 1280, height: 720 }], ['phone', { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport });
    const r = { type: `settings panel from pause (${name})`, errors: [], shots: {} };
    page.on('pageerror', (e) => fail(r, String(e)));
    await page.goto(`http://localhost:${PORT}/?autostart=1&type=defend&difficulty=1&seed=2`);
    await page.waitForFunction(() => window.__spooky?.ready === true);
    await page.waitForTimeout(800);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.overlay .card h2');
    r.shots.pause = `${out}/pause-${name}.png`;
    await page.screenshot({ path: r.shots.pause });
    await page.click('.overlay button:has-text("Settings")');
    await page.waitForSelector('.settings-panel');
    const a11y = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll('.settings-panel input')];
      return {
        count: inputs.length,
        unlabelled: inputs.filter((i) => !document.querySelector(`label[for="${i.id}"]`)).map((i) => i.id),
        focused: document.activeElement?.id,
        role: document.querySelector('.settings-panel')?.getAttribute('role'),
      };
    });
    r.a11y = a11y;
    if (a11y.count !== 8) fail(r, `${a11y.count} controls, expected 8`);
    if (a11y.unlabelled.length) fail(r, `unlabelled: ${a11y.unlabelled}`);
    if (a11y.role !== 'dialog') fail(r, 'panel is not a dialog');
    // Keyboard: the first slider (master volume) has focus; arrow keys move it.
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    // Tab to the sensitivity slider and raise it; tab to invert-Y and tick it with Space.
    const focusTo = async (sel) => {
      for (let i = 0; i < 12; i++) {
        if (await page.evaluate((s) => document.activeElement?.matches(s), sel)) return true;
        await page.keyboard.press('Tab');
      }
      return false;
    };
    if (!(await focusTo('input[id$=mouseSensitivity]'))) fail(r, 'could not tab to mouse sensitivity');
    await page.keyboard.press('ArrowRight');
    if (!(await focusTo('input[id$=invertY]'))) fail(r, 'could not tab to invert Y');
    await page.keyboard.press('Space');
    // A game key pressed while the panel is open must not restart the mission.
    await page.keyboard.press('r');
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('spooky.settings') ?? 'null'));
    r.stored = stored;
    if (!stored || stored.masterVolume !== 0.7 || stored.mouseSensitivity !== 1.05 || stored.invertY !== true) fail(r, `settings not stored as expected: ${JSON.stringify(stored)}`);
    const small = await page.evaluate(smallText(), '.settings-panel');
    if (small.length) fail(r, `text under 14 px: ${small.join(' | ')}`);
    const sideways = await page.evaluate(() => {
      const p = document.querySelector('.settings-panel').getBoundingClientRect();
      return p.left < 0 || p.right > innerWidth;
    });
    if (sideways) fail(r, 'panel wider than the screen');
    r.shots.settings = `${out}/settings-pause-${name}.png`;
    await page.screenshot({ path: r.shots.settings, fullPage: false });
    await page.keyboard.press('Escape');
    await page.waitForSelector('.settings-panel', { state: 'detached' });
    const after = await page.evaluate(() => ({ screen: window.__spooky.info()?.screen, t: window.__spooky.state().t }));
    if (after.screen !== 'paused') fail(r, `after closing settings the screen is ${after.screen}`);
    results.push(r);
    await page.close();
  }
  // 4. Settings from the front page and the menu; recon card shows the best (stored by the win above in another page: same origin).
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const r = { type: 'settings from landing and menu', errors: [], shots: {} };
    page.on('pageerror', (e) => fail(r, String(e)));
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForSelector('.landing h1');
    await page.waitForTimeout(1500);
    r.shots.landing = `${out}/landing-with-settings.png`;
    await page.screenshot({ path: r.shots.landing });
    await page.click('.screen-settings');
    await page.waitForSelector('.settings-panel');
    r.shots.panel = `${out}/settings-landing.png`;
    await page.screenshot({ path: r.shots.panel });
    await page.keyboard.press('Escape');
    await page.click('.la-sample');
    await page.waitForSelector('.menu h1');
    r.shots.menu = `${out}/menu-with-settings.png`;
    await page.screenshot({ path: r.shots.menu });
    if (!(await page.$('.screen-settings.on-menu'))) fail(r, 'no settings button on the menu');
    results.push(r);
    // Recon cards show the best per mission at the chosen difficulty: store one for every mission kind
    // on the sample town at difficulty 3 (the bests format the game itself writes), then open recon.
    const r2 = { type: 'recon cards show bests', errors: [], shots: {} };
    page.on('pageerror', (e) => fail(r2, String(e)));
    await page.evaluate(() => {
      const all = JSON.parse(localStorage.getItem('spooky.bests') ?? '{}');
      const kinds = ['clear', 'escort', 'defend', 'forest-sweep', 'clear-tennis', 'hold-sports', 'escort-shops', 'escort-station', 'clear-park', 'hold-landmark'];
      kinds.forEach((k, i) => (all[`Sampleton (sample town)|${k}|3`] = { grade: 'SABC'[i % 4], time: 95 + i * 41 }));
      localStorage.setItem('spooky.bests', JSON.stringify(all));
    });
    await page.click('.menu button:has-text("Sample town")');
    await page.waitForSelector('.mission-card');
    await page.selectOption('.recon select', '3');
    await page.waitForTimeout(300);
    const cardBests = await page.evaluate(() => [...document.querySelectorAll('.mission-card .mc-best')].map((e) => e.textContent));
    r2.cardBests = cardBests;
    if (!cardBests.length || !cardBests.every((t) => /^Best: [SABCD] \d+:\d\d$/.test(t))) fail(r2, `cards: ${JSON.stringify(cardBests)}`);
    await page.selectOption('.recon select', '5');
    await page.waitForTimeout(300);
    const none = await page.evaluate(() => [...document.querySelectorAll('.mission-card .mc-best')].map((e) => e.textContent));
    if (!none.every((t) => t === 'Not flown yet')) fail(r2, `difficulty 5 cards: ${JSON.stringify(none)}`);
    await page.selectOption('.recon select', '3');
    await page.waitForTimeout(300);
    await page.evaluate(() => document.querySelector('.recon-cards')?.scrollIntoView({ block: 'center' }));
    r2.shots.recon = `${out}/recon-cards-bests.png`;
    await page.screenshot({ path: r2.shots.recon });
    results.push(r2);
    await page.close();
  }
  // 5. Phone front page with the settings button.
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForSelector('.landing h1');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${out}/landing-phone-with-settings.png` });
    results.push({ type: 'landing phone', errors: [], shots: { landing: `${out}/landing-phone-with-settings.png` } });
    await page.close();
  }
} catch (e) {
  console.error(e);
  exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 1));
process.exit(exitCode);
