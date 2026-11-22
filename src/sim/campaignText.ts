import type { TemplateId } from '../map/recon';
import type { Mission, MissionType } from './missions';
import type { SimState } from './sim';
import { savedPhrase, type Grade } from './score';
import { betterRun, firstUnwon, type CampaignRecord, type Night, type NightPlan, type NightRecord, type Run, type RunNumbers } from './campaign';

/**
 * Three Nights: every word on the campaign's radio and screens, as data (spec 001; docs/story/campaign.md,
 * radio-script.md, voice.md). Pure: no DOM, no audio. Every slot comes from a stored number (the record) or
 * from the re-planned mission (names), never from map.name (hard rules 4 and 9). The UI puts these strings
 * on screen with textContent only.
 */

export type LineId =
  // A. The campaign spine
  | 'n1-open' | 'n2-open' | 'n3-open' | 'previously' | 'welcome-back' | 'first-cold' | 'big-expected' | 'n1-close' | 'n2-close'
  | 'dawn-thermal' | 'n3-close' | 'campaign-thanks' | 'night-lost' | 'night-won-losses' | 'night-won-clean'
  // B. Template flavour
  | 'tennis-open' | 'park-open' | 'forest-open' | 'shops-open' | 'station-open' | 'sports-open' | 'landmark-open'
  // C. In-mission moments (wired later, its own backlog item; captions kept here so there's one table)
  | 'ff-one-left' | 'need-met' | 'few-left' | 'cold-leftovers' | 'one-minute' | 'doors-failing' | 'reload-105' | 'idle';

/** P1 interrupts and always plays; P2 is dropped if it can't start within 3 s; P3 is dropped if any line played in the last 4 s. */
export type LinePriority = 1 | 2 | 3;

export interface LineDef {
  /** Exactly what Ground says: the recording's script text, and its caption (feel M2). Never has a slot. */
  text: string;
  priority: LinePriority;
  /** A recording exists (public/audio/voice/<id>.mp3). Held lines show as captions only. */
  recorded: boolean;
}

/** The one caption table: line id → the recording's transcript (radio-script.md, word for word). */
export const LINES: Record<LineId, LineDef> = {
  'n1-open': { text: "First night, Spooky. Let's see what we're dealing with.", priority: 2, recorded: true },
  'n2-open': { text: 'Night two. People are still stuck out there.', priority: 2, recorded: true },
  'n3-open': { text: 'Last night, Spooky. Get through this and we all go home.', priority: 2, recorded: true },
  previously: { text: 'Right, Spooky. Where were we.', priority: 3, recorded: true },
  'welcome-back': { text: "Welcome back, Spooky. The night's not over.", priority: 3, recorded: true },
  'first-cold': { text: 'Some of them are running cold tonight. Try night vision.', priority: 2, recorded: true },
  // Not recorded: its words name the 105, and recordings carry no numbers (radio script, "Not recorded").
  'big-expected': { text: "There's a big one coming tonight. Save a 105 for it.", priority: 2, recorded: false },
  'n1-close': { text: "First night down. They know we're here now.", priority: 3, recorded: true },
  'n2-close': { text: 'Night two done. Get some sleep. Well, try.', priority: 3, recorded: true },
  // Held until the dawn fade exists (campaign §8); never chosen until then.
  'dawn-thermal': { text: "Sun's up. The streets are warming. Thermal's going flat.", priority: 3, recorded: false },
  'n3-close': { text: 'Dawn patrol has the street. Spooky, go home.', priority: 2, recorded: true },
  'campaign-thanks': { text: "Residents' committee says thanks. Also, about the lawns.", priority: 3, recorded: true },
  'night-lost': { text: 'Not tonight. Same streets, same dead. Go again.', priority: 2, recorded: true },
  'night-won-losses': { text: 'Not everyone made it tonight.', priority: 2, recorded: true },
  'night-won-clean': { text: 'Everyone safe, nobody singed. Textbook, Spooky.', priority: 3, recorded: true },
  'tennis-open': { text: "Tennis club's overrun. New balls, please.", priority: 3, recorded: true },
  'park-open': { text: "Park's shut for the night. Nobody told them.", priority: 3, recorded: true },
  'forest-open': { text: "They're in the trees and running cold. Thermal will sulk.", priority: 3, recorded: true },
  'shops-open': { text: 'Unexpected item in the bagging area. Several, actually.', priority: 3, recorded: true },
  'station-open': { text: "Last service is in. Nobody's meeting them, so we are.", priority: 3, recorded: true },
  'sports-open': { text: "Home game tonight, Spooky. Let's keep a clean sheet.", priority: 3, recorded: true },
  'landmark-open': { text: "Solid walls, neighbours inside. Let's keep tonight boring.", priority: 3, recorded: true },
  'ff-one-left': { text: 'One more of those and they take the guns away.', priority: 1, recorded: true },
  'need-met': { text: "That's enough home. Now let's get the rest.", priority: 2, recorded: true },
  'few-left': { text: 'Nearly there. The last few are out there somewhere.', priority: 2, recorded: true },
  'cold-leftovers': { text: "What's left is running cold. Try night vision.", priority: 2, recorded: true },
  'one-minute': { text: 'One minute left on the clock.', priority: 2, recorded: true },
  'doors-failing': { text: "Doors won't take much more of that.", priority: 2, recorded: true },
  // Held until the unlimited-ammo 25 mm is merged.
  'reload-105': { text: "105's reloading. The 25 never does.", priority: 3, recorded: false },
  idle: { text: "Spooky, you've gone quiet. Everything all right up there?", priority: 3, recorded: true },
};

/** Each recon template's flavour line. Classic missions have none (they keep cleared-hot only). */
export const TEMPLATE_LINE: Partial<Record<TemplateId, LineId>> = {
  'clear-tennis': 'tennis-open',
  'clear-park': 'park-open',
  'forest-sweep': 'forest-open',
  'escort-shops': 'shops-open',
  'escort-station': 'station-open',
  'hold-sports': 'sports-open',
  'hold-landmark': 'landmark-open',
};

/** A line to say (if `voiced`) and caption. `detail` is the on-screen slot text shown after the spoken words. */
export interface CaptionedLine {
  id: LineId;
  text: string;
  detail?: string;
  priority: LinePriority;
  /** A recording exists. Otherwise the caption shows on its own. */
  voiced: boolean;
}

export function line(id: LineId, detail?: string): CaptionedLine {
  const d = LINES[id];
  return { id, text: d.text, ...(detail ? { detail } : {}), priority: d.priority, voiced: d.recorded };
}

/** The caption, Ground style: the spoken words, then the slot text (feel M2). */
export function captionText(l: CaptionedLine): string {
  return `GROUND: ${l.text}${l.detail ? ` ${l.detail}` : ''}`;
}

/**
 * Feel S1: the night opener plays on the night card (the player is reading, and audio is unlocked by the
 * click), leaving the sortie's start to one truth or flavour line and cleared-hot. False moves it back to
 * the start of the sortie, ahead of the extra line (the radio script's order).
 */
export const OPENER_ON_CARD = true;

const OPENER: Record<Night, LineId> = { 1: 'n1-open', 2: 'n2-open', 3: 'n3-open' };
const CLOSE: Record<Night, LineId> = { 1: 'n1-close', 2: 'n2-close', 3: 'n3-close' };
export const NIGHT_WORD: Record<Night, string> = { 1: 'one', 2: 'two', 3: 'three' };
/** Night names by the mission they really are, so a substitute night never promises the wrong thing. */
const NIGHT_TITLE: Record<MissionType, string> = { clear: 'Lights out', escort: 'The long way home', defend: 'Hold till dawn' };
const GRADE_WORD: Record<Grade, string> = { S: 'textbook', A: 'sharp', B: 'solid', C: 'shaky', D: 'scraped through' };

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "1 survivor", "2 survivors". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Lights out", "The long way home", "Hold till dawn". */
export function nightTitle(x: Pick<NightPlan, 'mission'>): string {
  return NIGHT_TITLE[x.mission.type];
}

/** "NIGHT 2 OF 3 · THE LONG WAY HOME · DIFFICULTY 3" (the briefing kicker). */
export function nightKicker(x: Pick<NightPlan, 'night' | 'difficulty' | 'mission'>): string {
  return `NIGHT ${x.night} OF 3 · ${nightTitle(x).toUpperCase()} · DIFFICULTY ${x.difficulty}`;
}

/** The first night with cold-blooded contacts, or null. */
export function firstColdNight(nights: readonly Pick<NightPlan, 'night' | 'hadCold'>[]): Night | null {
  return nights.find((x) => x.hadCold)?.night ?? null;
}

const tries = (r: CampaignRecord, n: Night) => r.nights[n - 1]?.tries ?? 0;

export interface CardContext {
  night: Night;
  nights: readonly NightPlan[];
  record: CampaignRecord;
  /** The first time this night's card opens in this session (feel S7: not on every retry). */
  firstOpenThisSession: boolean;
  /** welcome-back already played this session; it replaces `previously` that time. */
  welcomedThisSession: boolean;
}

/** Lines for a night card, in order: previously-on (nights two and three), then the night opener (first attempt only). */
export function cardLines(c: CardContext): CaptionedLine[] {
  const out: CaptionedLine[] = [];
  if (c.night > 1 && c.firstOpenThisSession && !c.welcomedThisSession) {
    const summary = previouslyOn(c.nights, c.record, c.night);
    if (summary) out.push(line('previously', summary));
  }
  if (OPENER_ON_CARD && tries(c.record, c.night) === 0) out.push(line(OPENER[c.night]));
  return out;
}

/**
 * Lines at sim start, said in order before cleared-hot. One extra line at most: a truth line (`first-cold`
 * on the first night with cold-blooded contacts, first attempt; `big-expected` on night three when a big
 * wave is planned) beats the template's flavour line.
 */
export function startLines(c: { night: Night; nights: readonly NightPlan[]; record: CampaignRecord }): CaptionedLine[] {
  const x = c.nights[c.night - 1];
  const first = tries(c.record, c.night) === 0;
  const out: CaptionedLine[] = [];
  if (!OPENER_ON_CARD && first) out.push(line(OPENER[c.night]));
  let extra: LineId | undefined;
  if (first && firstColdNight(c.nights) === c.night) extra = 'first-cold';
  else if (c.night === 3 && x.mission.waves?.kinds?.includes('big')) extra = 'big-expected';
  else extra = TEMPLATE_LINE[x.template];
  if (extra) out.push(line(extra));
  return out;
}

/**
 * Ground's lines after the sting, at most two. A loss: the replay prompt. A win: how the people did
 * (when it's true), then the night's close the first time it's won.
 */
export function endLines(c: { night: Night; run: Run; before: NightRecord | null }): CaptionedLine[] {
  if (!c.run.won) return [line('night-lost')];
  const out: CaptionedLine[] = [];
  const { survivorsTotal: n, survivorsSaved: s } = c.run;
  if (n > 0 && s < n) out.push(line('night-won-losses', `${s} of ${n} safe.`));
  else if (s >= n && c.run.friendlyHits === 0) out.push(line('night-won-clean'));
  if (!c.before?.best) out.push(line(CLOSE[c.night]));
  return out.slice(0, 2);
}

/** When the tally opens. */
export function tallyLines(): CaptionedLine[] {
  return [line('campaign-thanks')];
}

/** On the campaign screen: welcome-back, when a saved campaign with a night still to win opens in a new session. */
export function campaignScreenLines(c: { record: CampaignRecord; newSession: boolean }): CaptionedLine[] {
  if (!c.newSession || !c.record.nights.some((x) => x && x.tries > 0)) return [];
  const n = firstUnwon(c.record);
  return n ? [line('welcome-back', `Night ${n} of 3 is still waiting.`)] : [];
}

// ---------------------------------------------------------------------------------------
// Previously-on and the tally: numbers from the stored best run, names from the re-planned mission.
// ---------------------------------------------------------------------------------------

const placeOf = (m: Mission) => (m.anchor ? cap(m.anchor.name) : 'the hordes');
const pct = (b: RunNumbers) => Math.round(Math.max(0, Math.min(1, b.integrity)) * 100);
const phrase = (m: Mission, b: RunNumbers) => savedPhrase({ type: m.type, survivorsTotal: b.survivorsTotal, survivorsSaved: b.survivorsSaved, integrity: b.integrity });
const walked = (b: RunNumbers) => (b.survivorsSaved >= b.survivorsTotal ? `all ${b.survivorsTotal}` : `${b.survivorsSaved} of ${b.survivorsTotal}`);

function stragglers(b: RunNumbers): string {
  const n = b.survivorsTotal;
  const s = b.survivorsSaved;
  if (!n) return '';
  if (s >= n) return ` ${n === 2 ? 'Both' : 'All'} stragglers made it in.`;
  if (s === 0) return ' The stragglers were lost.';
  return ` ${s} of ${plural(n, 'straggler')} made it in.`;
}

/** "Last night: ..." for night n's card, from night n−1's kept best. Null for night one, or before night n−1 is won. */
export function previouslyOn(nights: readonly NightPlan[], r: CampaignRecord, night: Night): string | null {
  if (night === 1) return null;
  const x = nights[night - 2];
  const b = r.nights[night - 2]?.best;
  if (!x || !b) return null;
  const m = x.mission;
  if (m.type === 'clear') return `Last night: ${placeOf(m)} cleared, ${b.kills} down, ${phrase(m, b)}.`;
  if (m.type === 'escort') return `Last night: ${walked(b)} walked home to a house on ${m.home?.street ?? 'an unnamed street'}.`;
  return `Last night: ${cap(m.safehouse?.name ?? 'the safehouse')} held till dawn, ${pct(b)}% intact.`;
}

function tallyText(m: Mission, b: RunNumbers): string {
  if (m.type === 'clear') return `${cap(placeOf(m))} cleared. ${cap(phrase(m, b))}.`;
  if (m.type === 'escort') return `${cap(walked(b))} walked home to ${m.home?.street ?? 'an unnamed street'}.`;
  return `${cap(m.safehouse?.name ?? 'the safehouse')} held till dawn, ${pct(b)}% intact.${stragglers(b)}`;
}

export interface Tally {
  title: string;
  /** Feel S8: each night's line is its kept best run. */
  note: string;
  nights: { night: Night; label: string; text: string; grade: Grade; gradeWord: string }[];
  friendlyFire: string;
}

/** THREE NIGHTS: one line per night from its kept best, then friendly fire. Null until all three are won. */
export function tally(nights: readonly NightPlan[], r: CampaignRecord): Tally | null {
  const bests = nights.map((x) => r.nights[x.night - 1]?.best);
  if (nights.length !== 3 || bests.some((b) => !b)) return null;
  const ff = bests.reduce((s, b) => s + b!.friendlyHits, 0);
  return {
    title: 'THREE NIGHTS',
    note: 'Each night shows your best run.',
    nights: nights.map((x, i) => ({
      night: x.night, label: `Night ${NIGHT_WORD[x.night]}`, text: tallyText(x.mission, bests[i]!), grade: bests[i]!.grade, gradeWord: GRADE_WORD[bests[i]!.grade],
    })),
    friendlyFire: ff === 0 ? 'Friendly fire: none in three nights.' : `Friendly fire: ${plural(ff, 'incident')}.`,
  };
}

// ---------------------------------------------------------------------------------------
// The result card as data (feel M1, S6, S8). The UI maps actions to callbacks.
// ---------------------------------------------------------------------------------------

export type ResultAction = 'replay' | 'next' | 'back' | 'tally';
export interface ResultButton {
  action: ResultAction;
  label: string;
  /** Keyboard shortcut; only on buttons that exist, never shown on touch. */
  key?: 'r' | 'n';
  primary?: true;
}
export interface ResultModel {
  buttons: ResultButton[];
  /** "Night one best: B · NEW BEST"; empty before the night is won. The single-mission best is never shown. */
  bestLine: string;
  /** "Night one stays won · best B" when a replay of a won night is lost. */
  note?: string;
}

/**
 * The buttons after a night. `before` is the night's record before this run (reconciled), `after` the
 * record with it. Lost: fly it again or go back, never next. First win: the next night, fly again, back;
 * night three's first win: the tally only. A replay of a won night: back first.
 */
export function resultActions(c: { night: Night; run: Run; before: NightRecord | null; after: NightRecord }): ResultModel {
  const word = NIGHT_WORD[c.night];
  const wasWon = !!c.before?.best;
  const best = c.after.best;
  const isNew = c.run.won && betterRun(c.run, c.before?.best);
  const bestLine = best ? `Night ${word} best: ${best.grade}${isNew ? ' · NEW BEST' : ''}` : '';
  const back: ResultButton = { action: 'back', label: 'Back to the nights' };
  const again: ResultButton = { action: 'replay', label: 'Fly it again for a better grade', key: 'r' };
  if (wasWon) {
    return {
      buttons: [{ ...back, primary: true }, again],
      bestLine,
      ...(!c.run.won && best ? { note: `Night ${word} stays won · best ${best.grade}` } : {}),
    };
  }
  if (!c.run.won) return { buttons: [{ action: 'replay', label: `Fly night ${word} again`, key: 'r', primary: true }, back], bestLine };
  if (c.night === 3) return { buttons: [{ action: 'tally', label: 'See the three nights', key: 'n', primary: true }], bestLine };
  return {
    buttons: [{ action: 'next', label: `Night ${NIGHT_WORD[(c.night + 1) as Night]}`, key: 'n', primary: true }, again, back],
    bestLine,
  };
}

const clock = (secs: number) => {
  const s = Math.max(0, Math.floor(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Feel S6: how far a lost run got, from true data ("Held 3:52 of 4:30", "2 of 3 home", "Friendly fire 2/2"). */
export function lossProgress(m: Mission, s: SimState): string[] {
  const out: string[] = [];
  if (m.type === 'defend') out.push(`Held ${clock(Math.min(s.t, m.timeLimit))} of ${clock(m.timeLimit)}`);
  else if (m.type === 'escort') out.push(`${s.survivorsHome} of ${m.needHome} home`);
  else out.push(`${s.zombiesTotal - s.zombiesAlive} of ${s.zombiesTotal} down`);
  if (s.friendlyHits >= m.friendlyFireLimit) out.push(`Friendly fire ${s.friendlyHits}/${m.friendlyFireLimit}`);
  return out;
}
