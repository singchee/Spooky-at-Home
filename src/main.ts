import * as THREE from 'three';
import './style.css';
import { initMotion } from './ui/motion';
initMotion();
import { makeSampleTown } from './map/sample';
import { isPresetFile, PRESET_URL, PRESETS, presetToMap } from './map/presets';
import { TEMPLATE_IDS, type TemplateId } from './map/recon';
import type { MapData } from './map/types';
import { createSim } from './sim/setup';
import type { MissionType } from './sim/missions';
import { Game } from './game/game';
import { showMenu, type MenuChoice, type MenuMode } from './ui/menu';
import { showLanding, type LandingChoice } from './ui/landing';
import { startTutorial, trainingDone, type TutorialHandle } from './ui/tutorial';
import { el } from './ui/dom';
import { openSettingsPanel } from './ui/settingsPanel';
import { introStatus, rememberIntro } from './ui/introSeen';
import type { SensorId } from './render/sensors';

// Colours in this game are sensor values, not display colours: switch off colour conversion.
THREE.ColorManagement.enabled = false;

const app = document.getElementById('app')!;
const params = new URLSearchParams(location.search);
let game: Game | null = null;
let tutorial: TutorialHandle | null = null;
/** Closes whichever non-game screen is showing (landing page or menu). */
let closeScreen: (() => void) | null = null;
let last: MenuChoice | null = null;
type ScreenName = 'landing' | 'menu' | 'tutorial' | 'game' | 'intro';

declare global {
  interface Window {
    __spooky?: {
      ready: boolean;
      screen?: ScreenName;
      state: () => unknown;
      info: () => unknown;
      setSensor: (s: SensorId) => void;
      tutorialStep?: () => string | null;
      error?: string;
    };
  }
}
window.__spooky = {
  ready: false,
  state: () => game?.sim.state() ?? null,
  info: () => game?.info() ?? null,
  setSensor: (s) => game?.setSensor(s),
  tutorialStep: () => tutorial?.steps.step ?? null,
};

/** Tear down whatever is on screen (game, tutorial, landing or menu). */
function clear(): void {
  closeScreen?.();
  closeScreen = null;
  if (tutorial) {
    // The tutorial owns its game and disposes it.
    tutorial.dispose();
    tutorial = null;
    game = null;
  }
  game?.dispose();
  game = null;
  window.__spooky!.ready = false;
}

function play(choice: MenuChoice, opts: { bot?: boolean; skipBriefing?: boolean; sensor?: SensorId } = {}): void {
  last = choice;
  clear();
  let r: ReturnType<typeof createSim>;
  try {
    r = createSim(choice.map, { type: choice.type, difficulty: choice.difficulty, seed: choice.seed, template: choice.template, anchor: choice.anchor });
  } catch (e) {
    r = { ok: false, reason: `Couldn't build a mission on this map (${(e as Error).message}).` };
  }
  if (!r.ok) {
    window.__spooky!.error = r.reason;
    menu(menuAfter(choice), { message: r.reason });
    return;
  }
  game = new Game(app, choice.map, r.sim, {
    ...opts,
    onRetry: () => play(choice, opts),
    onNext: () => play({ ...choice, seed: choice.seed + 1 }, opts),
    onMenu: () => menu(menuAfter(choice)),
  });
  window.__spooky!.screen = 'game';
  window.__spooky!.ready = true;
  window.__spooky!.error = undefined;
}

/**
 * The screens between the front page and a briefing (see menu.ts): "scout" (type your address),
 * "recon" (missions that suit the map) and "custom" (the manual form). `sample` puts the sample
 * town on the recon screen.
 */
function menu(mode: MenuMode, o: { message?: string; sample?: boolean; famous?: boolean } = {}): void {
  clear();
  window.__spooky!.screen = 'menu';
  // A recon mission's template and anchor belong to the map it was built on, not the sample town.
  let preset: Partial<MenuChoice> | undefined = last ?? undefined;
  if (o.sample) {
    const { template: _template, anchor: _anchor, ...rest } = last ?? {};
    preset = { ...rest, map: makeSampleTown() };
  }
  const close = showMenu(app, (c) => play(c), { mode, preset, famous: o.famous, onFrontPage: () => landing() });
  const settings = settingsButton('on-menu');
  let toast: HTMLDivElement | null = null;
  if (o.message) {
    toast = el('div', 'toast', o.message, app);
    toast.setAttribute('role', 'alert');
    setTimeout(() => toast?.remove(), 8000);
  }
  closeScreen = () => {
    close();
    settings();
    toast?.remove();
  };
}

/** Back from a mission: to recon for a recon mission, otherwise to the manual form it came from. */
const menuAfter = (c: MenuChoice | null): MenuMode => (c?.template ? 'recon' : 'custom');

function landing(notice?: string, enter = false): void {
  clear();
  window.__spooky!.screen = 'landing';
  // The intro is offered once, on the first visit; afterwards it's a "Watch intro" link.
  const offer = introStatus() === null;
  if (offer) rememberIntro('offered');
  const close = showLanding(app, (c: LandingChoice) => {
    if (c === 'scout') menu('scout');
    else if (c === 'sample') menu('recon', { sample: true });
    else if (c === 'famous') menu('scout', { famous: true });
    else if (c === 'intro') intro();
    else training();
  }, { notice, trained: trainingDone(), intro: offer ? 'offer' : 'link', enter });
  const settings = settingsButton('on-landing');
  closeScreen = () => {
    settings();
    close();
  };
}

/** A Settings button for the front page and the menu (the panel also opens from the pause screen). Returns its remover. */
function settingsButton(where: string): () => void {
  const b = el('button', `screen-settings ${where}`, 'Settings', app);
  b.setAttribute('aria-haspopup', 'dialog');
  let close: (() => void) | null = null;
  b.addEventListener('click', () => {
    close ??= openSettingsPanel(app, { onClose: () => (close = null) });
  });
  return () => {
    close?.();
    b.remove();
  };
}

/**
 * The 44 s intro (src/ui/intro.ts, loaded on demand so the first page stays small). Started from a
 * click on the front page, never by itself. Ends, or is skipped, back to the front page.
 */
function intro(): void {
  clear();
  window.__spooky!.screen = 'intro';
  let handle: { dispose(): void } | null = null;
  let gone = false;
  closeScreen = () => {
    gone = true;
    handle?.dispose();
    handle = null;
  };
  import('./ui/intro')
    .then(({ playIntro }) => {
      if (gone) return;
      handle = playIntro(app, () => {
        handle = null;
        landing(undefined, true);
      });
    })
    .catch(() => {
      if (!gone) landing();
    });
}

function training(): void {
  clear();
  window.__spooky!.screen = 'tutorial';
  try {
    tutorial = startTutorial(app, (to) => {
      if (to === 'restart') training();
      else if (to === 'scout') menu('scout');
      else if (to === 'landing') landing('Training complete. Your street is next.');
      else menu('recon', { sample: true });
    });
    game = tutorial.game;
    window.__spooky!.ready = true;
  } catch (e) {
    menu('scout', { message: `Training night couldn't start (${(e as Error).message}).` });
  }
}

function clampInt(v: string | null, lo: number, hi: number, dflt: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && v !== null ? Math.max(lo, Math.min(hi, n)) : dflt;
}

// URL parameters let testers and the crew skip the menu, e.g.
// ?map=sample&type=escort&difficulty=2&seed=7&autostart=1&bot=1&sensor=night
// ?screen=landing|scout|recon|custom|tutorial opens that screen directly (menu = scout).
/** ?preset=<slug>: a bundled famous place (from our own origin) instead of the sample town (3.39 playtests). */
async function autostartMap(): Promise<MapData> {
  const pl = PRESETS.find((p) => p.slug === params.get('preset'));
  if (!pl) return makeSampleTown();
  const res = await fetch(new URL(PRESET_URL(pl.slug), document.baseURI).href);
  const json: unknown = await res.json();
  if (!isPresetFile(json)) throw new Error('bad preset file');
  return presetToMap(json, pl);
}

if (params.get('autostart') === '1') {
  void autostartMap().then((map) => play(
    {
      map,
      type: (['clear', 'escort', 'defend', 'auto'].includes(params.get('type') ?? '') ? params.get('type') : 'escort') as MissionType | 'auto',
      difficulty: clampInt(params.get('difficulty'), 1, 5, 2),
      seed: clampInt(params.get('seed'), 1, 1e9, 1),
      // ?template=forest-sweep (sample town): a recon template, for /playtest scenarios (spec 002).
      template: TEMPLATE_IDS.find((id) => id === params.get('template')) as TemplateId | undefined,
    },
    { bot: params.get('bot') === '1', skipBriefing: params.get('brief') !== '1', sensor: params.get('sensor') === 'night' ? 'night' : undefined },
  ));
} else if (params.get('screen') === 'menu' || params.get('screen') === 'scout') {
  menu('scout');
} else if (params.get('screen') === 'recon') {
  menu('recon', { sample: true });
} else if (params.get('screen') === 'custom') {
  menu('custom');
} else if (params.get('screen') === 'tutorial') {
  training();
} else if (params.get('screen') === 'intro') {
  intro(); // no click: plays muted, with captions

} else {
  landing();
}
