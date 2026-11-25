import { describe, expect, it } from 'vitest';
import { AssetBank, VOICE_LINES, voiceAsset, type Fetcher } from '../src/audio/assets';
import { GUN_IDS, loadPlan, sceneJumps } from '../src/audio/loadOrder';
import { trackIds } from '../src/audio/recorded';

// Owner playtest 2: "the cannon sounds tinny... the shot is clack, no hit sound". The recorded gun
// files loaded last, behind every voice line and the music (about a minute on the cloud machine), so
// the 40 mm played its generated stand-in. The guns must load right after the first radio line, and
// stay ahead of voice and music when the screen changes.

/** A bank whose fetches are recorded in the order they start (2 at a time, as in the game). */
function recordingBank() {
  const order: string[] = [];
  const fetcher: Fetcher = async (url: string) => {
    order.push(url.replace(/^audio\//, '').replace(/\.mp3$/, ''));
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
  };
  const buf = { duration: 1, length: 22_050, sampleRate: 22_050, numberOfChannels: 1, getChannelData: () => new Float32Array(22_050) } as unknown as AudioBuffer;
  const bank = new AssetBank({ decodeAudioData: async () => buf }, fetcher, 'audio/', 2, () => undefined);
  return { bank, order };
}

const voice = VOICE_LINES.map(voiceAsset).filter((id) => id !== voiceAsset('cleared-hot'));

describe('recorded files load in an order that keeps the guns sounding right', () => {
  it('at start-up every gun file is fetched before the rest of the voice and before any music', async () => {
    const { bank, order } = recordingBank();
    await Promise.all(loadPlan('menu').map((b) => bank.request(b)));
    const lastGun = Math.max(...GUN_IDS.map((id) => order.indexOf(id)));
    expect(Math.min(...GUN_IDS.map((id) => order.indexOf(id)))).toBeGreaterThanOrEqual(0);
    for (const id of [...voice, ...trackIds('menu')]) expect(order.indexOf(id), id).toBeGreaterThan(lastGun);
  });

  it('a screen change puts guns still waiting ahead of voice and this screen music', async () => {
    const { bank, order } = recordingBank();
    // Start-up queues everything; only the first two fetches are in flight when the mission starts.
    const all = loadPlan('menu').map((b) => bank.request(b));
    // Simulate the old order too: if anything had pushed the guns back, the jump must still win.
    const jumps = sceneJumps('mission').map((b) => bank.request(b, true));
    await Promise.all([...all, ...jumps]);
    const inFlight = 2;
    const next = order.slice(inFlight, inFlight + GUN_IDS.length);
    expect(new Set(next)).toEqual(new Set(GUN_IDS));
    const lastGun = Math.max(...GUN_IDS.map((id) => order.indexOf(id)));
    for (const id of [...voice, ...trackIds('mission')]) expect(order.indexOf(id), id).toBeGreaterThan(lastGun);
  });
});
