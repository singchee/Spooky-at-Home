/**
 * Whether this browser has seen the intro (localStorage only, wrapped: blocked storage just
 * forgets). 'offered': the front page has offered it once; 'seen': played or skipped. Kept apart
 * from intro.ts so the front page can ask without loading the intro itself.
 */
const SEEN_KEY = 'spooky.intro';
export type IntroStatus = 'seen' | 'offered' | null;

export function introStatus(): IntroStatus {
  try {
    const v = localStorage.getItem(SEEN_KEY);
    return v === 'seen' || v === 'offered' ? v : null;
  } catch {
    return null;
  }
}

export function rememberIntro(v: 'seen' | 'offered'): void {
  try {
    if (v === 'offered' && introStatus() === 'seen') return;
    localStorage.setItem(SEEN_KEY, v);
  } catch {
    /* private mode or blocked storage */
  }
}
