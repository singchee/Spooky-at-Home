/**
 * Bookkeeping for synthesised sound: every source is started through here, forgotten (and its
 * little chain of nodes disconnected) when it ends, and stopped on dispose, so nothing lingers.
 */
export class Kit {
  private live = new Map<AudioScheduledSourceNode, AudioNode[]>();
  private owned: AudioNode[] = [];
  private disposed = false;

  /** `count` hears +1 / -1 as sources start and end (the engine's live-voice total). */
  constructor(
    readonly ctx: AudioContext,
    private count: (delta: number) => void = () => undefined,
  ) {}

  /** A long-lived node, disconnected on dispose. */
  own<T extends AudioNode>(n: T): T {
    this.owned.push(n);
    return n;
  }

  /** Start `src` at `at`, stop it at `stopAt` (if given); `chain` is disconnected when it ends. */
  play(src: AudioScheduledSourceNode, at: number, stopAt?: number, ...chain: AudioNode[]): void {
    if (!this.adopt(src, ...chain)) return;
    src.start(at);
    if (stopAt !== undefined) src.stop(stopAt);
  }

  /** Track a source the caller starts itself (e.g. a buffer played from an offset). False once disposed. */
  adopt(src: AudioScheduledSourceNode, ...chain: AudioNode[]): boolean {
    if (this.disposed) return false;
    this.live.set(src, chain);
    this.count(1);
    src.onended = () => this.forget(src);
    return true;
  }

  get voices(): number {
    return this.live.size;
  }

  private forget(src: AudioScheduledSourceNode): void {
    const chain = this.live.get(src);
    if (!chain) return;
    this.live.delete(src);
    this.count(-1);
    src.disconnect();
    for (const n of chain) n.disconnect();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const src of [...this.live.keys()]) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      this.forget(src);
    }
    for (const n of this.owned) n.disconnect();
    this.owned = [];
  }
}

/** MIDI note number to frequency (A4 = 69 = 440 Hz). */
export const hz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);
