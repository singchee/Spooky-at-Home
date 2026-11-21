/** Small synthesised sound effects (no audio files). Starts only after a user gesture, as browsers require. */
export class Sfx {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  muted = false;

  unlock(): void {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext();
      const len = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1; // audio texture only, not game logic
    } catch {
      this.ctx = null;
    }
  }

  private burst(freq: number, dur: number, vol: number, delay = 0): void {
    if (!this.ctx || !this.noise || this.muted) return;
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.ctx.destination);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  fire(weapon: string): void {
    if (weapon === '25') this.burst(2200, 0.06, 0.12);
    else if (weapon === '40') this.burst(900, 0.25, 0.35);
    else this.burst(300, 0.9, 0.7);
  }

  impact(weapon: string): void {
    if (weapon === '25') this.burst(700, 0.12, 0.05);
    else if (weapon === '40') this.burst(400, 0.4, 0.15);
    else this.burst(160, 1.4, 0.35);
  }

  /** Distinct two-tone alarm for friendly fire. */
  alarm(): void {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    for (const [i, f] of [[0, 880], [1, 660], [2, 880], [3, 660]]) {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'square';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.05, t + i * 0.12);
      g.gain.setValueAtTime(0, t + i * 0.12 + 0.11);
      o.connect(g).connect(this.ctx.destination);
      o.start(t + i * 0.12);
      o.stop(t + i * 0.12 + 0.12);
    }
  }

  radio(): void {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.frequency.value = 1400;
    g.gain.setValueAtTime(0.04, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    o.connect(g).connect(this.ctx.destination);
    o.start(t);
    o.stop(t + 0.1);
  }
}
