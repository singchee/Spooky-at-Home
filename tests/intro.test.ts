import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { AssetBank, INTRO_VOICE, type Fetcher } from '../src/audio/assets';
import {
  BEAT,
  CAPTIONS,
  INTRO_CUES,
  INTRO_END,
  INTRO_LINES,
  MIN_CROSSFADE,
  SHOTS,
  SLIDES,
  TICKER,
  TICKER_MAX_PX_S,
  captionAt,
  quadMatrix,
  shotAt,
  slideAt,
} from '../src/ui/introScript';

// The intro ("The Late Bulletin"): its timeline must be the script in docs/story/intro.md, word for
// word, with captions for every line and cue, and its picture changes must be slow (photosensitivity).
// The browser check is `node scripts/playtest.mjs --only intro`.

/** The script table in docs/story/intro.md: file, speaker, caption text, start and length. */
function scriptTable() {
  const md = readFileSync('docs/story/intro.md', 'utf8');
  const rows = md.split('\n').filter((l) => /^\| \d+ \| `voice\/intro-/.test(l));
  return rows.map((l) => {
    const c = l.split('|').map((x) => x.trim());
    return { id: /voice\/(intro-[a-z0-9-]+)\.mp3/.exec(c[2])![1], speaker: c[3], text: c[5], start: Number(c[6]), length: parseFloat(c[7]) };
  });
}

describe('intro script', () => {
  it('matches docs/story/intro.md: every line, speaker, caption text, start and length', () => {
    const table = scriptTable();
    expect(table.length).toBe(10);
    expect(INTRO_LINES.map(({ id, speaker, text, start, length }) => ({ id, speaker, text, start, length }))).toEqual(table);
  });

  it('plays every recorded intro file, and each one exists', () => {
    expect(INTRO_LINES.map((l) => l.id)).toEqual([...INTRO_VOICE]);
    for (const id of INTRO_VOICE) expect(existsSync(`public/audio/voice/${id}.mp3`)).toBe(true);
  });

  it('lines never overlap and all finish before the end (44 s)', () => {
    for (let i = 1; i < INTRO_LINES.length; i++) expect(INTRO_LINES[i].start).toBeGreaterThan(INTRO_LINES[i - 1].start + INTRO_LINES[i - 1].length);
    const last = INTRO_LINES[INTRO_LINES.length - 1];
    expect(last.start + last.length).toBeLessThan(INTRO_END);
    expect(INTRO_END).toBe(44);
  });

  it('captions every spoken line (with the speaker) for its whole length, and both sound cues', () => {
    for (const l of INTRO_LINES)
      for (const f of [0.01, 0.5, 0.99]) expect(captionAt(l.start + l.length * f)).toEqual({ speaker: l.speaker, text: l.text });
    expect(INTRO_CUES.map((c) => c.text)).toEqual(['[TV muted]', '[radio click]']);
    expect(INTRO_CUES.map((c) => c.start)).toEqual([15.2, 38.4]);
    for (const c of INTRO_CUES) expect(captionAt(c.start + 0.1)).toEqual({ speaker: null, text: c.text });
    // A caption is up long enough to read (cues are short sounds, but still at least 0.3 s).
    for (const c of CAPTIONS) expect(c.end - c.start).toBeGreaterThanOrEqual(0.3);
    expect(captionAt(0)).toBeNull();
    expect(captionAt(43)).toBeNull();
  });

  it('five shots back to back, as in the shot list', () => {
    expect(SHOTS.map((s) => [s.id, s.start, s.end])).toEqual([
      ['bulletin', 0, 10.5],
      ['pullback', 10.5, 15.6],
      ['order', 15.6, 38.2],
      ['radio', 38.2, 42.2],
      ['title', 42.2, 44],
    ]);
    expect(shotAt(0)).toBe('bulletin');
    expect(shotAt(20)).toBe('order');
    expect(shotAt(43.9)).toBe('title');
  });

  it('the picture follows the words: markers on line 6, guns on line 7, night vision on line 8, mug on line 9', () => {
    const during = (n: number, t: number) => t >= INTRO_LINES[n - 1].start && t < INTRO_LINES[n - 1].start + INTRO_LINES[n - 1].length;
    expect(during(6, BEAT.markers)).toBe(true);
    for (const g of BEAT.guns) expect(during(7, g)).toBe(true);
    expect(during(8, BEAT.night)).toBe(true);
    expect(during(9, BEAT.mugDown)).toBe(true);
    expect(BEAT.dollyEnd - BEAT.dollyStart).toBe(5);
  });

  it('photosensitivity: every change is a crossfade of at least 0.5 s; the night-vision change takes 1 s', () => {
    expect(BEAT.dissolve).toBeGreaterThanOrEqual(MIN_CROSSFADE);
    expect(BEAT.slideDissolve).toBeGreaterThanOrEqual(MIN_CROSSFADE);
    expect(BEAT.nightFade).toBe(1);
    expect(BEAT.fadeUp).toBeGreaterThanOrEqual(MIN_CROSSFADE);
    expect(INTRO_END - BEAT.fadeOut).toBeGreaterThanOrEqual(MIN_CROSSFADE);
    // Slides (reduced motion) at least 2 s apart: never a quick run of changes.
    for (let i = 1; i < SLIDES.length; i++) expect(SLIDES[i].at - SLIDES[i - 1].at).toBeGreaterThanOrEqual(2);
    expect(slideAt(0)).toBe('bulletin');
    expect(slideAt(40)).toBe('sky');
    expect(TICKER_MAX_PX_S).toBeLessThanOrEqual(60);
  });

  it('the ticker carries the script’s jokes, and nothing names a real place', () => {
    expect(TICKER.join(' · ')).toBe('STAY INDOORS · LOCK YOUR DOORS · DO NOT APPROACH · BIN NIGHT GOES AHEAD AS NORMAL · RESIDENTS\' COMMITTEE "DISAPPOINTED"');
    const src = readFileSync('src/ui/introScript.ts', 'utf8') + readFileSync('src/ui/intro.ts', 'utf8');
    expect(src).not.toMatch(/innerHTML|Math\.random/);
  });
});

describe('intro helpers', () => {
  it('quadMatrix maps the box corners onto the quad (the TV graphics follow the TV)', () => {
    const quad: [number, number][] = [
      [100, 50],
      [500, 60],
      [480, 300],
      [120, 280],
    ];
    const m = quadMatrix(400, 225, quad)
      .replace(/^matrix3d\(|\)$/g, '')
      .split(',')
      .map(Number);
    const map = (x: number, y: number) => {
      const X = m[0] * x + m[4] * y + m[12];
      const Y = m[1] * x + m[5] * y + m[13];
      const W = m[3] * x + m[7] * y + m[15];
      return [X / W, Y / W];
    };
    const corners = [map(0, 0), map(400, 0), map(400, 225), map(0, 225)];
    corners.forEach((c, i) => {
      expect(c[0]).toBeCloseTo(quad[i][0], 2);
      expect(c[1]).toBeCloseTo(quad[i][1], 2);
    });
  });

  it('the intro’s voice can jump the loading queue (it plays seconds after the click)', async () => {
    const order: string[] = [];
    let release: (() => void) | null = null;
    const fetcher: Fetcher = async (url) => {
      order.push(url);
      if (!release) await new Promise<void>((r) => (release = r));
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
    };
    const bank = new AssetBank({ decodeAudioData: async () => ({ duration: 1 }) as AudioBuffer }, fetcher, 'a/', 1, () => undefined);
    void bank.request(['x/1', 'x/2', 'x/3']);
    const intro = bank.request(['voice/intro-news-1', 'x/3'], true);
    await new Promise((r) => setTimeout(r, 0));
    release!();
    await intro;
    expect(order.slice(0, 3)).toEqual(['a/x/1.mp3', 'a/voice/intro-news-1.mp3', 'a/x/3.mp3']);
    expect(bank.ready(['voice/intro-news-1', 'x/3'])).toBe(true);
  });
});
