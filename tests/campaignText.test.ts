import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { makeSampleTown } from '../src/map/sample';
import { buildRoadGraph } from '../src/map/roadGraph';
import { WalkGrid } from '../src/map/grid';
import type { MapData } from '../src/map/types';
import { createSim } from '../src/sim/setup';
import { Bot, SKILL } from '../src/sim/bot';
import { gradeMission, scoreInput } from '../src/sim/score';
import type { SimState } from '../src/sim/sim';
import {
  LEVELS, applyRun, emptyRecord, planCampaign, runFrom, type CampaignRecord, type Level, type Night, type NightPlan, type Run, type RunNumbers,
} from '../src/sim/campaign';
import {
  LINES, OPENER_ON_CARD, TEMPLATE_LINE, campaignScreenLines, captionText, cardLines, endLines, firstColdNight, line, lossProgress,
  nightKicker, nightTitle, plural, previouslyOn, resultActions, startLines, tally, tallyLines, type CaptionedLine, type LineId,
} from '../src/sim/campaignText';

// Spec 001 step 4 (campaignText): every word Ground says, every caption and every number on a campaign
// screen. Lines are data; every slot comes from a stored number or the re-planned mission (hard rule 9).

const map = makeSampleTown();
const graph = buildRoadGraph(map);
const grid = new WalkGrid(map);

function plan(m: MapData, S: number, B: Level): NightPlan[] {
  const g = m === map ? graph : buildRoadGraph(m);
  const w = m === map ? grid : new WalkGrid(m);
  const p = planCampaign(m, g, w, S, B);
  if (!p.ok) throw new Error(p.reason);
  return p.nights;
}

const winOf = (x: NightPlan, extra: Partial<RunNumbers> = {}): Run => ({
  won: true, grade: 'B', time: x.mission.type === 'defend' ? x.mission.timeLimit : 200,
  survivorsTotal: x.mission.survivors.length, survivorsSaved: x.mission.survivors.length,
  friendlyHits: 0, kills: 37, integrity: x.mission.type === 'defend' ? 0.83 : 1, ...extra,
});
function wonAll(ns: NightPlan[], per: Partial<RunNumbers>[] = []): CampaignRecord {
  let r = emptyRecord();
  for (const x of ns) r = applyRun(r, x.night, x.fp, winOf(x, per[x.night - 1])).record;
  return r;
}

/** Plays one night with the bot to the end; the bot is deterministic, so this is a scripted run. */
function fly(x: NightPlan): { run: Run; state: SimState } {
  const r = createSim(map, x.options);
  if (!r.ok) throw new Error(r.reason);
  const bot = new Bot(r.sim, SKILL.ace);
  while (r.sim.phase === 'running' && r.sim.t < 900) {
    bot.step(1 / 30);
    r.sim.step(1 / 30);
  }
  const state = r.sim.state();
  return { run: runFrom(r.sim.mission, state, gradeMission(scoreInput(r.sim.mission, state))), state };
}

const ids = (ls: CaptionedLine[]) => ls.map((l) => l.id);

describe('the caption table is the recordings\' transcripts (feel M2)', () => {
  const script = new Map(
    [...readFileSync('docs/story/radio-script.md', 'utf8').matchAll(/^\| \d+ \| `([a-z0-9-]+)` \| ([^|]+?) \|/gm)].map((m) => [m[1], m[2].trim()]),
  );
  const credits = new Map(
    [...readFileSync('public/audio/CREDITS.md', 'utf8').matchAll(/^\| `voice\/([a-z0-9-]+)\.mp3` \| ([^|]+?) \|/gm)].map((m) => [m[1], m[2].trim()]),
  );
  const files = readdirSync('public/audio/voice').map((f) => f.replace(/\.mp3$/, ''));

  it('caption text equals each line\'s script text, word for word, for all 30 new lines', () => {
    expect(script.size).toBe(30);
    expect(Object.keys(LINES).sort()).toEqual([...script.keys()].sort());
    for (const [id, text] of script) expect(LINES[id as LineId].text, id).toBe(text);
  });

  it('a line is marked recorded exactly when its file exists, and the file\'s logged text is the caption', () => {
    for (const id of Object.keys(LINES) as LineId[]) {
      expect(LINES[id].recorded, id).toBe(files.includes(id));
      if (LINES[id].recorded) expect(credits.get(id), `CREDITS.md text for ${id}`).toBe(LINES[id].text);
    }
    // Held lines: no file yet (campaign §8, radio script "Not recorded").
    expect(['dawn-thermal', 'reload-105', 'big-expected'].map((id) => LINES[id as LineId].recorded)).toEqual([false, false, false]);
  });

  it('every voiced line id has slot-free caption text (no "{", no digits)', () => {
    for (const [id, l] of Object.entries(LINES)) {
      if (!l.recorded) continue;
      expect(l.text, id).not.toMatch(/[{}]/);
      expect(l.text, id).not.toMatch(/\d/);
    }
  });

  it('priorities follow the script (P1 safety, P2 mission state, P3 flavour)', () => {
    expect(LINES['ff-one-left'].priority).toBe(1);
    expect(LINES['night-lost'].priority).toBe(2);
    expect(LINES['n3-close'].priority).toBe(2);
    expect(LINES.previously.priority).toBe(3);
    for (const id of Object.values(TEMPLATE_LINE)) expect(LINES[id!].priority).toBe(3);
  });

  it('a caption shows the spoken words, then the slot text (M2)', () => {
    const l = line('previously', 'Last night: 4 of 5 walked home to a house on Elm Street.');
    expect(captionText(l)).toBe('GROUND: Right, Spooky. Where were we. Last night: 4 of 5 walked home to a house on Elm Street.');
    expect(captionText(line('n3-close'))).toBe('GROUND: Dawn patrol has the street. Spooky, go home.');
    expect(line('big-expected').voiced).toBe(false); // text only until it's reworded and recorded
    expect(line('n1-open').voiced).toBe(true);
  });
});

describe('which lines play (radio script rules, feel S1 and S7)', () => {
  it('first-cold is chosen iff this night hadCold and no earlier night did (B 1..3)', () => {
    let sawGentleNightTwo = false;
    for (const B of LEVELS) {
      for (const S of [1, 2, 3]) {
        const ns = plan(map, S, B);
        const first = ns.find((x) => x.hadCold)?.night ?? null;
        expect(firstColdNight(ns)).toBe(first);
        let r = emptyRecord();
        for (const x of ns) {
          const chosen = ids(startLines({ night: x.night, nights: ns, record: r })).includes('first-cold');
          const truth = x.hadCold && ns.filter((y) => y.night < x.night).every((y) => !y.hadCold);
          expect(chosen, `B${B} S${S} night ${x.night}`).toBe(truth);
          if (B === 1 && truth && x.night === 2) sawGentleNightTwo = true;
          r = applyRun(r, x.night, x.fp, winOf(x)).record;
        }
        // Standard and Hard: cold-blooded zombies from night one.
        if (B >= 2) expect(firstColdNight(ns)).toBe(1);
      }
    }
    expect(sawGentleNightTwo).toBe(true); // Gentle: the reveal is on night two (campaign §3)
  }, 60_000);

  it('big-expected is chosen iff waves.kinds includes big (night three only)', () => {
    let withBig = 0;
    let without = 0;
    for (const B of LEVELS) {
      for (let S = 1; S <= 8; S++) {
        const ns = plan(map, S, B);
        let r = emptyRecord();
        for (const x of ns) {
          if (x.night > 1) r = applyRun(r, (x.night - 1) as Night, ns[x.night - 2].fp, winOf(ns[x.night - 2])).record;
          const chosen = ids(startLines({ night: x.night, nights: ns, record: r }));
          if (chosen.includes('first-cold')) continue; // the one extra slot is taken by the other truth line
          const big = x.night === 3 && !!x.mission.waves?.kinds?.includes('big');
          expect(chosen.includes('big-expected'), `B${B} S${S} night ${x.night}`).toBe(big);
          if (x.night === 3) (big ? withBig++ : without++);
          if (x.night === 3 && x.mission.waves) {
            // The same night with no big wave planned: the line must not be chosen.
            const calm = { ...x, mission: { ...x.mission, waves: { ...x.mission.waves, kinds: x.mission.waves.kinds?.filter((k) => k !== 'big') } } };
            const ns2 = [ns[0], ns[1], calm];
            expect(ids(startLines({ night: 3, nights: ns2, record: r }))).not.toContain('big-expected');
            without++;
          }
        }
      }
    }
    expect(withBig).toBeGreaterThan(0);
    expect(without).toBeGreaterThan(0);
  }, 60_000);

  it('the sortie opens with at most one line, truth before flavour; the night opener is on the card, first attempt only', () => {
    expect(OPENER_ON_CARD).toBe(true);
    const ns = plan(map, 1, 1);
    let r = emptyRecord();
    // Night one, Gentle, the tennis club: no cold yet, so the flavour line.
    expect(ids(startLines({ night: 1, nights: ns, record: r }))).toEqual([TEMPLATE_LINE[ns[0].template]]);
    expect(ids(cardLines({ night: 1, nights: ns, record: r, firstOpenThisSession: true, welcomedThisSession: false }))).toEqual(['n1-open']);
    r = applyRun(r, 1, ns[0].fp, { ...winOf(ns[0]), won: false }).record;
    expect(ids(cardLines({ night: 1, nights: ns, record: r, firstOpenThisSession: true, welcomedThisSession: false }))).toEqual([]);
    r = applyRun(r, 1, ns[0].fp, winOf(ns[0])).record;
    // Night two: previously (first open this session), then the opener; at sim start, first-cold (Gentle).
    expect(ids(cardLines({ night: 2, nights: ns, record: r, firstOpenThisSession: true, welcomedThisSession: false }))).toEqual(['previously', 'n2-open']);
    expect(ids(cardLines({ night: 2, nights: ns, record: r, firstOpenThisSession: false, welcomedThisSession: false }))).toEqual(['n2-open']);
    expect(ids(cardLines({ night: 2, nights: ns, record: r, firstOpenThisSession: true, welcomedThisSession: true }))).toEqual(['n2-open']);
    expect(ids(startLines({ night: 2, nights: ns, record: r }))).toEqual(['first-cold']);
    for (const B of LEVELS) for (const x of plan(map, 2, B)) expect(startLines({ night: x.night, nights: plan(map, 2, B), record: emptyRecord() }).length).toBeLessThanOrEqual(1);
    // Classic missions keep cleared-hot only: no flavour line.
    const plain = plan({ ...map, name: 'Plain', features: [], pois: [], areas: [], busRoutes: [] }, 1, 3);
    expect(plain.every((x) => TEMPLATE_LINE[x.template] === undefined)).toBe(true);
    expect(ids(startLines({ night: 1, nights: plain, record: emptyRecord() }))).toEqual(['first-cold']);
  }, 60_000);

  it('first-cold plays only on the first attempt of its night', () => {
    const ns = plan(map, 1, 1);
    let r = applyRun(emptyRecord(), 1, ns[0].fp, winOf(ns[0])).record;
    expect(ids(startLines({ night: 2, nights: ns, record: r }))).toEqual(['first-cold']);
    r = applyRun(r, 2, ns[1].fp, { ...winOf(ns[1]), won: false }).record;
    expect(r.nights[1]!.tries).toBe(1);
    expect(ids(startLines({ night: 2, nights: ns, record: r }))).not.toContain('first-cold');
  });

  it('a flavour line plays only when the mission makes it true (rule 9)', () => {
    const ns = plan(map, 1, 1);
    const x = ns[0];
    expect(x.template).toBe('clear-tennis');
    expect(ids(startLines({ night: 1, nights: ns, record: emptyRecord() }))).toEqual(['tennis-open']);
    // The same night with no horde on the courts: "Tennis club's overrun" would be false.
    const away = { ...x, mission: { ...x.mission, hordes: x.mission.hordes.map((h) => ({ ...h, label: 'Elsewhere Street' })) } };
    expect(ids(startLines({ night: 1, nights: [away, ns[1], ns[2]], record: emptyRecord() }))).toEqual([]);
    // A forest sweep whose forest hordes have no cold ones: "running cold" would be false.
    const forest = {
      ...x, template: 'forest-sweep' as const,
      mission: { ...x.mission, template: 'forest-sweep' as const, hordes: x.mission.hordes.map((h) => ({ ...h, label: x.mission.anchor!.name, cold: 0 })) },
    };
    expect(ids(startLines({ night: 1, nights: [forest, ns[1], ns[2]], record: emptyRecord() }))).toEqual([]);
    const coldForest = { ...forest, mission: { ...forest.mission, hordes: forest.mission.hordes.map((h) => ({ ...h, cold: 2 })) } };
    expect(ids(startLines({ night: 1, nights: [coldForest, ns[1], ns[2]], record: emptyRecord() }))).toEqual(['forest-open']);
  });

  it('end lines: night-lost on every loss; on a win, at most two, the close only the first time', () => {
    const ns = plan(map, 1, 2);
    const [x1, x2, x3] = ns;
    expect(ids(endLines({ night: 1, run: { ...winOf(x1), won: false }, before: null }))).toEqual(['night-lost']);
    expect(ids(endLines({ night: 1, run: winOf(x1), before: null }))).toEqual(['night-won-clean', 'n1-close']);
    const lossy = endLines({ night: 2, run: winOf(x2, { survivorsSaved: 3 }), before: null });
    expect(ids(lossy)).toEqual(['night-won-losses', 'n2-close']);
    expect(lossy[0].detail).toBe(`3 of ${x2.mission.survivors.length} safe.`);
    expect(ids(endLines({ night: 3, run: winOf(x3, { friendlyHits: 1 }), before: null }))).toEqual(['n3-close']);
    const won = applyRun(emptyRecord(), 1, x1.fp, winOf(x1)).record.nights[0];
    expect(ids(endLines({ night: 1, run: winOf(x1), before: won }))).toEqual(['night-won-clean']);
    expect(ids(endLines({ night: 1, run: { ...winOf(x1), won: false }, before: won }))).toEqual(['night-lost']);
    expect(ids(tallyLines())).toEqual(['campaign-thanks']);
    expect(Object.keys(LINES)).toContain('dawn-thermal');
    for (const n of [1, 2, 3] as Night[]) expect(ids(endLines({ night: n, run: winOf(ns[n - 1]), before: null }))).not.toContain('dawn-thermal');
  });

  it('welcome-back plays when a saved campaign opens in a new session, naming the first unwon night', () => {
    const ns = plan(map, 1, 2);
    expect(campaignScreenLines({ record: emptyRecord(), newSession: true })).toEqual([]);
    const r = applyRun(emptyRecord(), 1, ns[0].fp, winOf(ns[0])).record;
    const l = campaignScreenLines({ record: r, newSession: true });
    expect(ids(l)).toEqual(['welcome-back']);
    expect(l[0].detail).toBe('Night 2 of 3 is still waiting.');
    expect(campaignScreenLines({ record: r, newSession: false })).toEqual([]);
    expect(campaignScreenLines({ record: wonAll(ns), newSession: true })).toEqual([]); // the night *is* over
  });
});

describe('previously-on and the tally (truth from stored numbers)', () => {
  it('previously-on and tally numbers equal the stored fields', () => {
    const ns = plan(map, 1, 1);
    let r = emptyRecord();
    for (const x of ns) {
      const { run } = fly(x);
      expect(run.won, `the ace bot wins night ${x.night} on Gentle`).toBe(true);
      r = applyRun(r, x.night, x.fp, run).record;
    }
    const b = r.nights.map((x) => x!.best!);
    const [m1, m2, m3] = ns.map((x) => x.mission);
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    const place1 = m1.anchor ? cap(m1.anchor.name) : 'the hordes';
    const friendlies = (s: RunNumbers) => (s.survivorsSaved >= s.survivorsTotal ? 'both friendlies safe' : s.survivorsSaved === 0 ? 'both friendlies lost' : `${s.survivorsTotal - s.survivorsSaved} of ${s.survivorsTotal} friendlies lost`);
    const walked = b[1].survivorsSaved === b[1].survivorsTotal ? `all ${b[1].survivorsTotal}` : `${b[1].survivorsSaved} of ${b[1].survivorsTotal}`;
    expect(previouslyOn(ns, r, 2)).toBe(`Last night: ${place1} cleared, ${b[0].kills} down, ${friendlies(b[0])}.`);
    expect(previouslyOn(ns, r, 3)).toBe(`Last night: ${walked} walked home to a house on ${m2.home!.street}.`);
    expect(previouslyOn(ns, r, 1)).toBeNull();

    const t = tally(ns, r)!;
    expect(t.title).toBe('THREE NIGHTS');
    expect(t.nights.map((x) => x.label)).toEqual(['Night one', 'Night two', 'Night three']);
    expect(t.nights.map((x) => x.grade)).toEqual(b.map((x) => x.grade));
    expect(t.nights[0].text).toBe(`${cap(place1)} cleared. ${cap(friendlies(b[0]))}.`);
    expect(t.nights[1].text).toBe(`${cap(walked)} walked home to ${m2.home!.street}.`);
    const pct = Math.round(b[2].integrity * 100);
    expect(t.nights[2].text).toMatch(new RegExp(`^${cap(m3.safehouse!.name)} held till dawn, ${pct}% intact\\.`));
    const ff = b.reduce((s, x) => s + x.friendlyHits, 0);
    expect(t.friendlyFire).toBe(ff === 0 ? 'Friendly fire: none in three nights.' : `Friendly fire: ${plural(ff, 'incident')}.`);
    // Every number on screen is one of the stored numbers.
    const stored = new Set(b.flatMap((x) => [x.kills, x.survivorsSaved, x.survivorsTotal, x.survivorsTotal - x.survivorsSaved, x.friendlyHits, Math.round(x.integrity * 100)]).map(String));
    stored.add(String(ff));
    const text = [previouslyOn(ns, r, 2)!, previouslyOn(ns, r, 3)!, ...t.nights.map((x) => x.text), t.friendlyFire];
    for (const s of text) for (const num of s.match(/\d+/g) ?? []) expect(stored.has(num), `${num} in "${s}"`).toBe(true);
  }, 240_000);

  it('"none in three nights" iff the friendly-hit sum is 0', () => {
    const ns = plan(map, 1, 2);
    expect(tally(ns, wonAll(ns))!.friendlyFire).toBe('Friendly fire: none in three nights.');
    expect(tally(ns, wonAll(ns, [{}, { friendlyHits: 1 }]))!.friendlyFire).toBe('Friendly fire: 1 incident.');
    expect(tally(ns, wonAll(ns, [{ friendlyHits: 1 }, {}, { friendlyHits: 1 }]))!.friendlyFire).toBe('Friendly fire: 2 incidents.');
    // A loss's friendly fire isn't in the kept best, so it isn't in the tally either.
    let r = wonAll(ns);
    r = applyRun(r, 3, ns[2].fp, { ...winOf(ns[2], { friendlyHits: 2 }), won: false }).record;
    expect(tally(ns, r)!.friendlyFire).toBe('Friendly fire: none in three nights.');
    // No tally until all three nights are won.
    expect(tally(ns, applyRun(emptyRecord(), 1, ns[0].fp, winOf(ns[0])).record)).toBeNull();
  });

  it('pluralises 1 survivor / 2 survivors', () => {
    expect(plural(1, 'survivor')).toBe('1 survivor');
    expect(plural(2, 'survivor')).toBe('2 survivors');
    expect(plural(0, 'survivor')).toBe('0 survivors');
    const ns = plan(map, 1, 2);
    const one = tally(ns, wonAll(ns, [{}, {}, { survivorsSaved: 1 }]))!;
    if (ns[2].mission.survivors.length === 2) expect(one.nights[2].text).toMatch(/ 1 of 2 stragglers made it in\.$/);
    const both = tally(ns, wonAll(ns))!;
    if (ns[2].mission.survivors.length === 2) expect(both.nights[2].text).toMatch(/ Both stragglers made it in\.$/);
  });

  it('the tally labels each line as the kept best run, and shows the grade as a letter and a word', () => {
    const ns = plan(map, 1, 2);
    const t = tally(ns, wonAll(ns, [{ grade: 'S' }, { grade: 'A' }, { grade: 'D' }]))!;
    expect(t.note).toMatch(/best run/);
    expect(t.nights.map((x) => `${x.grade} · ${x.gradeWord}`)).toEqual(['S · textbook', 'A · sharp', 'D · scraped through']);
  });

  it('no campaign text contains map.name (map named "12, Example Street")', () => {
    const named: MapData = { ...makeSampleTown(), name: '12, Example Street' };
    for (const B of LEVELS) {
      const ns = plan(named, 1, B);
      const r = wonAll(ns);
      const all: string[] = [];
      for (const x of ns) {
        all.push(nightTitle(x), nightKicker(x), previouslyOn(ns, r, x.night) ?? '');
        for (const l of [
          ...cardLines({ night: x.night, nights: ns, record: r, firstOpenThisSession: true, welcomedThisSession: false }),
          ...startLines({ night: x.night, nights: ns, record: emptyRecord() }),
          ...endLines({ night: x.night, run: winOf(x, { survivorsSaved: 0 }), before: null }),
          ...endLines({ night: x.night, run: { ...winOf(x), won: false }, before: null }),
        ]) all.push(captionText(l));
        const m = resultActions({ night: x.night, run: { ...winOf(x), won: false }, before: r.nights[x.night - 1], after: r.nights[x.night - 1]! });
        all.push(m.bestLine, m.note ?? '', ...m.buttons.map((b) => b.label));
      }
      const t = tally(ns, r)!;
      all.push(t.title, t.note, t.friendlyFire, ...t.nights.map((x) => `${x.label} ${x.text}`));
      all.push(...campaignScreenLines({ record: applyRun(emptyRecord(), 1, ns[0].fp, winOf(ns[0])).record, newSession: true }).map(captionText));
      for (const s of all) {
        expect(s).not.toContain('12, Example Street');
        expect(s).not.toContain('Example Street');
      }
      expect(all.join(' ').length).toBeGreaterThan(500);
    }
  }, 60_000);
});

describe('night cards', () => {
  it('names follow what the night really is (a substitute is named for its own mission type)', () => {
    const ns = plan(map, 1, 3);
    expect(ns.map(nightTitle)).toEqual(['Lights out', 'The long way home', 'Hold till dawn']);
    expect(nightKicker(ns[1])).toBe('NIGHT 2 OF 3 · THE LONG WAY HOME · DIFFICULTY 4');
    const sub = { ...ns[2], substitute: true, mission: ns[0].mission };
    expect(nightTitle(sub)).toBe('Lights out');
  });
});

describe('result card model (feel M1, S6, S8)', () => {
  const ns = plan(map, 1, 2);
  const [x1, , x3] = ns;
  const keyed = (m: ReturnType<typeof resultActions>) => m.buttons.filter((b) => b.key).map((b) => `${b.key}:${b.action}`);

  it('result actions: lost → replay (R) + back, with no next and no N; first win → next (N) + replay + back; night-three win → tally only; a lost replay of a won night says "stays won · best X"', () => {
    const lost = resultActions({ night: 2, run: { ...winOf(ns[1]), won: false }, before: null, after: { fp: ns[1].fp, tries: 1 } });
    expect(lost.buttons.map((b) => b.action)).toEqual(['replay', 'back']);
    expect(lost.buttons[0]).toMatchObject({ label: 'Fly night two again', key: 'r', primary: true });
    expect(lost.buttons[1].label).toBe('Back to the nights');
    expect(keyed(lost)).toEqual(['r:replay']);
    expect(lost.note).toBeUndefined();
    expect(lost.bestLine).toBe('');

    const after1 = applyRun(emptyRecord(), 1, x1.fp, winOf(x1, { grade: 'B' }));
    const first = resultActions({ night: 1, run: winOf(x1, { grade: 'B' }), before: null, after: after1.record.nights[0]! });
    expect(first.buttons.map((b) => [b.action, b.label])).toEqual([
      ['next', 'Night two'], ['replay', 'Fly it again for a better grade'], ['back', 'Back to the nights'],
    ]);
    expect(first.buttons[0].primary).toBe(true);
    expect(keyed(first)).toEqual(['n:next', 'r:replay']);
    expect(first.bestLine).toBe('Night one best: B · NEW BEST');

    const won3 = resultActions({ night: 3, run: winOf(x3), before: null, after: { fp: x3.fp, tries: 1, best: winOf(x3) } });
    expect(won3.buttons.map((b) => [b.action, b.label, b.primary])).toEqual([['tally', 'See the three nights', true]]);

    const keptB = after1.record.nights[0]!;
    const lostReplay = resultActions({ night: 1, run: { ...winOf(x1), won: false }, before: keptB, after: applyRun(after1.record, 1, x1.fp, { ...winOf(x1), won: false }).record.nights[0]! });
    expect(lostReplay.note).toBe('Night one stays won · best B');
    expect(lostReplay.buttons[0]).toMatchObject({ action: 'back', primary: true });
    expect(lostReplay.buttons.some((b) => b.action === 'next')).toBe(false);
    expect(lostReplay.bestLine).toBe('Night one best: B');

    const worseReplay = resultActions({ night: 1, run: winOf(x1, { grade: 'C' }), before: keptB, after: keptB });
    expect(worseReplay.buttons[0]).toMatchObject({ action: 'back', primary: true });
    expect(worseReplay.bestLine).toBe('Night one best: B');
    const betterReplay = resultActions({ night: 1, run: winOf(x1, { grade: 'A' }), before: keptB, after: { ...keptB, best: winOf(x1, { grade: 'A' }) } });
    expect(betterReplay.bestLine).toBe('Night one best: A · NEW BEST');

    // Keys map only to buttons that exist, and never twice.
    for (const m of [lost, first, won3, lostReplay, worseReplay, betterReplay]) {
      const ks = m.buttons.flatMap((b) => (b.key ? [b.key] : []));
      expect(new Set(ks).size).toBe(ks.length);
      expect(m.buttons.filter((b) => b.primary)).toHaveLength(1);
    }
  });

  it('a loss explains itself from true data (S6)', () => {
    const base: SimState = {
      t: 232.4, phase: 'lost', reason: 'x', type: 'defend', timeLeft: 0, zombiesAlive: 9, coldAlive: 0, zombiesTotal: 40, survivorsAlive: 0,
      survivorsHome: 2, survivorsTotal: 2, needHome: 0, integrity: 0, friendlyHits: 0, shots: 10, kills: 31, weapons: [],
    };
    const hold = x3.mission.timeLimit;
    const mmss = (v: number) => `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
    expect(lossProgress(x3.mission, { ...base, t: hold - 38.4 })).toEqual([`Held ${mmss(hold - 39)} of ${mmss(hold)}`]);
    const esc = ns[1].mission;
    expect(lossProgress(esc, { ...base, type: 'escort', survivorsHome: 2, needHome: esc.needHome, friendlyHits: 2 })).toEqual([`2 of ${esc.needHome} home`, 'Friendly fire 2/2']);
    expect(lossProgress(x1.mission, { ...base, type: 'clear', zombiesTotal: 24, zombiesAlive: 5 })).toEqual(['19 of 24 down']);
  });
});
