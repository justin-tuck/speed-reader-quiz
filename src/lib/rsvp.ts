/**
 * RSVP (rapid serial visual presentation) engine in the Spritz style:
 * one word at a time, aligned on its optimal recognition point (ORP).
 * Framework-free so it can be unit tested with fake timers.
 */

export const MIN_WPM = 200;
export const MAX_WPM = 1000;
export const WPM_STEP = 25;

export interface Token {
  text: string;
  /** First word of a sentence; skip back/forward jump to these. */
  sentenceStart: boolean;
  /** Last word of a paragraph; gets an extra pause. */
  paragraphEnd: boolean;
}

const SENTENCE_END = /[.!?…]["'”’)\]]*$/;
const CLAUSE_END = /[,;:—–]["'”’)\]]*$/;

/** Very long compounds are shown in parts so they fit on screen. */
function splitLongWord(word: string): string[] {
  if (word.length <= 14) return [word];
  const parts = word.split(/(?<=[-—–/])(?=\S)/);
  return parts.length > 1 ? parts : [word];
}

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let sentenceStart = true;
  for (const paragraph of text.split(/\n\s*\n/)) {
    const words = (paragraph.match(/\S+/g) ?? []).flatMap(splitLongWord);
    words.forEach((word, i) => {
      tokens.push({ text: word, sentenceStart, paragraphEnd: i === words.length - 1 });
      sentenceStart = SENTENCE_END.test(word);
    });
    sentenceStart = true;
  }
  return tokens;
}

/**
 * Index of the letter the eye should land on. It sits a little left of the
 * middle and moves right as words get longer. Leading punctuation is skipped.
 */
export function orpIndex(word: string): number {
  const lead = word.match(/^[^\p{L}\p{N}]*/u)?.[0].length ?? 0;
  const core = word.slice(lead).replace(/[^\p{L}\p{N}]+$/u, '');
  if (core.length === 0) return Math.min(word.length - 1, Math.max(0, Math.floor(word.length / 2)));
  let offset: number;
  if (core.length <= 1) offset = 0;
  else if (core.length <= 5) offset = 1;
  else if (core.length <= 9) offset = 2;
  else if (core.length <= 13) offset = 3;
  else offset = 4;
  return lead + offset;
}

export function splitAtOrp(word: string): { before: string; pivot: string; after: string } {
  const i = orpIndex(word);
  return { before: word.slice(0, i), pivot: word.slice(i, i + 1), after: word.slice(i + 1) };
}

/** How long a word stays on screen, as a multiple of the base word time. */
export function delayMultiplier(token: Token): number {
  let m = 1;
  if (SENTENCE_END.test(token.text)) m += 1.2;
  else if (CLAUSE_END.test(token.text)) m += 0.5;
  const letters = token.text.replace(/[^\p{L}\p{N}]/gu, '').length;
  if (letters > 12) m += 0.6;
  else if (letters > 8) m += 0.3;
  if (/\d/.test(token.text)) m += 0.3;
  if (token.paragraphEnd) m += 0.8;
  return m;
}

export function delayFor(token: Token, wpm: number): number {
  return (60_000 / wpm) * delayMultiplier(token);
}

export function clampWpm(wpm: number): number {
  if (!Number.isFinite(wpm)) return 300;
  return Math.min(MAX_WPM, Math.max(MIN_WPM, Math.round(wpm)));
}

/** Reading time from `from` to the end, including the pauses. */
export function remainingMs(tokens: Token[], from: number, wpm: number): number {
  let total = 0;
  for (let i = Math.max(0, from); i < tokens.length; i++) total += delayFor(tokens[i], wpm);
  return total;
}

export interface RsvpSnapshot {
  index: number;
  playing: boolean;
  finished: boolean;
  wpm: number;
}

export class RsvpEngine {
  readonly tokens: Token[];
  private snapshot: RsvpSnapshot;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private onFinish?: () => void;

  constructor(tokens: Token[], wpm: number, onFinish?: () => void) {
    this.tokens = tokens;
    this.onFinish = onFinish;
    this.snapshot = { index: 0, playing: false, finished: false, wpm: clampWpm(wpm) };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): RsvpSnapshot => this.snapshot;

  private update(patch: Partial<RsvpSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((l) => l());
  }

  private clearTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule() {
    this.clearTimer();
    const token = this.tokens[this.snapshot.index];
    this.timer = setTimeout(() => this.advance(), delayFor(token, this.snapshot.wpm));
  }

  private advance() {
    this.timer = null;
    if (this.snapshot.index >= this.tokens.length - 1) {
      this.update({ playing: false, finished: true });
      this.onFinish?.();
      return;
    }
    this.update({ index: this.snapshot.index + 1 });
    this.schedule();
  }

  play() {
    if (this.snapshot.playing || this.tokens.length === 0) return;
    if (this.snapshot.finished) this.update({ index: 0, finished: false });
    this.update({ playing: true });
    this.schedule();
  }

  pause() {
    if (!this.snapshot.playing) return;
    this.clearTimer();
    this.update({ playing: false });
  }

  toggle() {
    if (this.snapshot.playing) this.pause();
    else this.play();
  }

  seek(index: number) {
    if (this.tokens.length === 0) return;
    const clamped = Math.min(this.tokens.length - 1, Math.max(0, Math.round(index)));
    this.update({ index: clamped, finished: false });
    if (this.snapshot.playing) this.schedule();
  }

  /** Start of the current sentence, or of the previous one if already there. */
  skipBack() {
    let i = this.snapshot.index;
    // While playing, a press just after a sentence starts means "previous".
    const grace = this.snapshot.playing ? 2 : 0;
    let start = i;
    while (start > 0 && !this.tokens[start].sentenceStart) start--;
    if (i - start <= grace && start > 0) {
      start--;
      while (start > 0 && !this.tokens[start].sentenceStart) start--;
    }
    i = start;
    this.seek(i);
  }

  /** Start of the next sentence, or the last word if there is none. */
  skipForward() {
    let i = this.snapshot.index + 1;
    while (i < this.tokens.length && !this.tokens[i].sentenceStart) i++;
    this.seek(Math.min(i, this.tokens.length - 1));
  }

  setWpm(wpm: number) {
    const next = clampWpm(wpm);
    if (next === this.snapshot.wpm) return;
    this.update({ wpm: next });
    if (this.snapshot.playing) this.schedule();
  }

  /** Stops the timer. Safe to call more than once. */
  dispose() {
    this.clearTimer();
    if (this.snapshot.playing) this.update({ playing: false });
  }
}
