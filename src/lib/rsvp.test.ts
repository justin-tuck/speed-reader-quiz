import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RsvpEngine, clampWpm, delayFor, delayMultiplier, orpIndex, splitAtOrp, tokenize } from './rsvp';

describe('tokenize', () => {
  it('marks sentence starts and paragraph ends', () => {
    const tokens = tokenize('Hello there. How are you?\n\nFine.');
    expect(tokens.map((t) => t.text)).toEqual(['Hello', 'there.', 'How', 'are', 'you?', 'Fine.']);
    expect(tokens.map((t) => t.sentenceStart)).toEqual([true, false, true, false, false, true]);
    expect(tokens.map((t) => t.paragraphEnd)).toEqual([false, false, false, false, true, true]);
  });

  it('splits very long compounds at hyphens', () => {
    expect(tokenize('state-of-the-art-technology').map((t) => t.text)).toEqual([
      'state-',
      'of-',
      'the-',
      'art-',
      'technology',
    ]);
    expect(tokenize('well-known').map((t) => t.text)).toEqual(['well-known']);
  });
});

describe('orpIndex', () => {
  it('moves right as words get longer', () => {
    expect(orpIndex('a')).toBe(0);
    expect(orpIndex('to')).toBe(1);
    expect(orpIndex('hello')).toBe(1);
    expect(orpIndex('reading')).toBe(2);
    expect(orpIndex('recognition')).toBe(3);
    expect(orpIndex('internationalization')).toBe(4);
  });

  it('ignores surrounding punctuation', () => {
    expect(orpIndex('"hello,"')).toBe(2);
    expect(orpIndex('(a)')).toBe(1);
    expect(orpIndex('—')).toBe(0);
  });

  it('splits a word around the pivot letter', () => {
    expect(splitAtOrp('reading')).toEqual({ before: 're', pivot: 'a', after: 'ding' });
  });
});

describe('delays', () => {
  const token = (text: string, paragraphEnd = false) => ({ text, sentenceStart: false, paragraphEnd });

  it('uses the base word time for a plain short word', () => {
    expect(delayFor(token('cat'), 300)).toBe(200);
    expect(delayFor(token('cat'), 600)).toBe(100);
  });

  it('pauses longer after punctuation, long words and paragraphs', () => {
    const plain = delayMultiplier(token('cat'));
    expect(delayMultiplier(token('cat,'))).toBeGreaterThan(plain);
    expect(delayMultiplier(token('cat.'))).toBeGreaterThan(delayMultiplier(token('cat,')));
    expect(delayMultiplier(token('cat."'))).toBe(delayMultiplier(token('cat.')));
    expect(delayMultiplier(token('extraordinary'))).toBeGreaterThan(delayMultiplier(token('wonderful')));
    expect(delayMultiplier(token('wonderful'))).toBeGreaterThan(plain);
    expect(delayMultiplier(token('cat.', true))).toBeGreaterThan(delayMultiplier(token('cat.')));
  });

  it('clamps the speed', () => {
    expect(clampWpm(50)).toBe(200);
    expect(clampWpm(5000)).toBe(1000);
    expect(clampWpm(Number.NaN)).toBe(300);
  });
});

describe('RsvpEngine', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const text = 'One two three. Four five six. Seven eight nine.';

  it('advances one word per interval and finishes', () => {
    const onFinish = vi.fn();
    const engine = new RsvpEngine(tokenize('aa bb cc'), 600, onFinish);
    engine.play();
    expect(engine.getSnapshot().index).toBe(0);
    vi.advanceTimersByTime(100);
    expect(engine.getSnapshot().index).toBe(1);
    vi.advanceTimersByTime(100);
    expect(engine.getSnapshot().index).toBe(2);
    expect(onFinish).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(engine.getSnapshot()).toMatchObject({ index: 2, playing: false, finished: true });
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('holds its place while paused', () => {
    const engine = new RsvpEngine(tokenize(text), 600);
    engine.play();
    vi.advanceTimersByTime(100);
    engine.pause();
    vi.advanceTimersByTime(5000);
    expect(engine.getSnapshot()).toMatchObject({ index: 1, playing: false });
    engine.toggle();
    vi.advanceTimersByTime(100);
    expect(engine.getSnapshot().index).toBe(2);
  });

  it('restarts from the beginning when played after finishing', () => {
    const engine = new RsvpEngine(tokenize('aa bb'), 600);
    engine.play();
    vi.advanceTimersByTime(5000);
    expect(engine.getSnapshot().finished).toBe(true);
    engine.play();
    expect(engine.getSnapshot()).toMatchObject({ index: 0, playing: true, finished: false });
  });

  it('skips by sentence', () => {
    const engine = new RsvpEngine(tokenize(text), 300);
    engine.seek(4);
    engine.skipBack();
    expect(engine.getSnapshot().index).toBe(3);
    engine.skipBack();
    expect(engine.getSnapshot().index).toBe(0);
    engine.skipForward();
    expect(engine.getSnapshot().index).toBe(3);
    engine.skipForward();
    expect(engine.getSnapshot().index).toBe(6);
    engine.skipForward();
    expect(engine.getSnapshot().index).toBe(8);
  });

  it('applies a speed change to the word on screen', () => {
    const engine = new RsvpEngine(tokenize('aa bb cc'), 300);
    engine.play();
    engine.setWpm(600);
    vi.advanceTimersByTime(100);
    expect(engine.getSnapshot().index).toBe(1);
  });

  it('notifies subscribers and stops after dispose', () => {
    const engine = new RsvpEngine(tokenize(text), 600);
    const listener = vi.fn();
    engine.subscribe(listener);
    engine.play();
    expect(listener).toHaveBeenCalled();
    engine.dispose();
    const before = engine.getSnapshot().index;
    vi.advanceTimersByTime(5000);
    expect(engine.getSnapshot().index).toBe(before);
  });
});
