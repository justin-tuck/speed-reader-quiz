import { describe, expect, it } from 'vitest';
import type { Card, Rating, ReviewLog } from '../types';
import {
  DAY,
  DEFAULT_CONFIG,
  MINUTE,
  RATINGS,
  buildQueue,
  computeStats,
  formatInterval,
  newCard,
  previewIntervals,
  schedule,
  startOfDay,
} from './scheduler';

// 10:00 local time on an ordinary day.
const NOW = new Date(2026, 2, 10, 10, 0, 0).getTime();
const MIDNIGHT = new Date(2026, 2, 10).getTime();
const daysFromToday = (n: number) => new Date(2026, 2, 10 + n).getTime();

const fresh = (id = 'c1') => newCard({ id, docId: 'd1', sectionId: 's1' }, NOW);
const reviewCard = (overrides: Partial<Card> = {}): Card => ({
  ...fresh(),
  state: 'review',
  interval: 10,
  ease: 2.5,
  due: MIDNIGHT,
  reps: 5,
  ...overrides,
});

/** Applies a series of ratings, each given the moment the card comes due. */
function run(card: Card, ratings: Rating[]): Card {
  let now = NOW;
  for (const rating of ratings) {
    now = Math.max(now, card.due);
    card = schedule(card, rating, now);
  }
  return card;
}

describe('newCard', () => {
  it('starts new, due now, with the starting ease', () => {
    expect(fresh()).toEqual({
      id: 'c1',
      docId: 'd1',
      sectionId: 's1',
      state: 'new',
      ease: 2.5,
      interval: 0,
      step: 0,
      due: NOW,
      reps: 0,
      lapses: 0,
    });
  });
});

describe('learning steps', () => {
  it('Again shows a new card again after the first step', () => {
    const card = schedule(fresh(), 'again', NOW);
    expect(card).toMatchObject({ state: 'learning', step: 0, due: NOW + 1 * MINUTE, reps: 1 });
  });

  it('Hard repeats the first step with a delay halfway to the second', () => {
    const card = schedule(fresh(), 'hard', NOW);
    expect(card).toMatchObject({ state: 'learning', step: 0, due: NOW + 5.5 * MINUTE });
  });

  it('Good moves to the next step', () => {
    const card = schedule(fresh(), 'good', NOW);
    expect(card).toMatchObject({ state: 'learning', step: 1, due: NOW + 10 * MINUTE });
  });

  it('Hard on a later step repeats that step', () => {
    const card = run(fresh(), ['good', 'hard']);
    expect(card).toMatchObject({ state: 'learning', step: 1 });
    expect(card.due - (NOW + 10 * MINUTE)).toBe(10 * MINUTE);
  });

  it('Good on the last step graduates to a 1-day review', () => {
    const card = run(fresh(), ['good', 'good']);
    expect(card).toMatchObject({ state: 'review', interval: 1, ease: 2.5, due: daysFromToday(1), reps: 2 });
  });

  it('Easy graduates immediately to a 4-day review', () => {
    const card = schedule(fresh(), 'easy', NOW);
    expect(card).toMatchObject({ state: 'review', interval: 4, due: daysFromToday(4) });
  });

  it('Again during learning goes back to the first step without counting a lapse', () => {
    const card = run(fresh(), ['good', 'again']);
    expect(card).toMatchObject({ state: 'learning', step: 0, lapses: 0, ease: 2.5 });
  });
});

describe('review cards', () => {
  it('Good multiplies the interval by the ease and keeps the ease', () => {
    const card = schedule(reviewCard(), 'good', NOW);
    expect(card).toMatchObject({ state: 'review', interval: 25, ease: 2.5, due: daysFromToday(25) });
  });

  it('Hard grows the interval slowly and lowers the ease', () => {
    const card = schedule(reviewCard(), 'hard', NOW);
    expect(card).toMatchObject({ state: 'review', interval: 12, ease: 2.35 });
  });

  it('Easy grows the interval the most and raises the ease', () => {
    const card = schedule(reviewCard(), 'easy', NOW);
    expect(card).toMatchObject({ state: 'review', interval: 33, ease: 2.65 });
  });

  it('Again is a lapse: short relearning step, lower ease, interval reset', () => {
    const card = schedule(reviewCard(), 'again', NOW);
    expect(card).toMatchObject({
      state: 'relearning',
      step: 0,
      lapses: 1,
      ease: 2.3,
      interval: 1,
      due: NOW + 10 * MINUTE,
    });
  });

  it('orders the intervals Hard < Good < Easy, even for short intervals', () => {
    for (const interval of [1, 2, 3, 7, 30, 200]) {
      for (const ease of [1.3, 2, 2.5, 3]) {
        const card = reviewCard({ interval, ease });
        const hard = schedule(card, 'hard', NOW).interval;
        const good = schedule(card, 'good', NOW).interval;
        const easy = schedule(card, 'easy', NOW).interval;
        expect(hard).toBeGreaterThan(interval);
        expect(good).toBeGreaterThan(hard);
        expect(easy).toBeGreaterThan(good);
      }
    }
  });

  it('never lets the ease fall below the minimum', () => {
    let card = reviewCard({ ease: 1.4 });
    card = schedule(card, 'again', NOW);
    expect(card.ease).toBe(1.3);
    card = schedule(reviewCard({ ease: 1.35 }), 'hard', NOW);
    expect(card.ease).toBe(1.3);
  });

  it('caps the interval', () => {
    const card = schedule(reviewCard({ interval: 30_000 }), 'easy', NOW);
    expect(card.interval).toBe(DEFAULT_CONFIG.maxInterval);
  });

  it('sets the due date at the start of the day', () => {
    const late = new Date(2026, 2, 10, 23, 30).getTime();
    const card = schedule(reviewCard({ interval: 1 }), 'good', late);
    expect(card.due).toBe(daysFromToday(card.interval));
    expect(startOfDay(card.due)).toBe(card.due);
  });
});

describe('relearning', () => {
  it('Good returns a lapsed card to review at the lapse interval', () => {
    const card = run(reviewCard(), ['again', 'good']);
    expect(card).toMatchObject({ state: 'review', interval: 1, lapses: 1, ease: 2.3 });
  });

  it('Easy returns it one day later', () => {
    const card = run(reviewCard(), ['again', 'easy']);
    expect(card).toMatchObject({ state: 'review', interval: 2 });
  });

  it('Again keeps it in relearning without another lapse', () => {
    const card = run(reviewCard(), ['again', 'again']);
    expect(card).toMatchObject({ state: 'relearning', lapses: 1, ease: 2.3 });
  });
});

describe('a typical card history', () => {
  it('grows 1 → 3 → 8 → 20 days on repeated Good', () => {
    const intervals: number[] = [];
    let card = run(fresh(), ['good', 'good']);
    intervals.push(card.interval);
    for (let i = 0; i < 3; i++) {
      card = schedule(card, 'good', card.due);
      intervals.push(card.interval);
    }
    expect(intervals).toEqual([1, 3, 8, 20]);
  });

  it('does not change the card passed in', () => {
    const card = reviewCard();
    const copy = { ...card };
    for (const rating of RATINGS) schedule(card, rating, NOW);
    expect(card).toEqual(copy);
  });
});

describe('interval labels', () => {
  it('formats durations compactly', () => {
    expect(formatInterval(20_000)).toBe('<1m');
    expect(formatInterval(10 * MINUTE)).toBe('10m');
    expect(formatInterval(3 * 60 * MINUTE)).toBe('3h');
    expect(formatInterval(4 * DAY)).toBe('4d');
    expect(formatInterval(45 * DAY)).toBe('1.5mo');
    expect(formatInterval(60 * DAY)).toBe('2mo');
    expect(formatInterval(730 * DAY)).toBe('2y');
  });

  it('previews each button for a new card', () => {
    expect(previewIntervals(fresh(), NOW)).toEqual({ again: '1m', hard: '6m', good: '10m', easy: '4d' });
  });

  it('previews each button for a review card', () => {
    expect(previewIntervals(reviewCard(), NOW)).toEqual({ again: '10m', hard: '12d', good: '25d', easy: '1.1mo' });
  });
});

describe('buildQueue', () => {
  const cards: Card[] = [
    fresh('new-1'),
    fresh('new-2'),
    fresh('new-3'),
    { ...fresh('learn-due'), state: 'learning', due: NOW - MINUTE },
    { ...fresh('learn-soon'), state: 'learning', step: 1, due: NOW + 5 * MINUTE },
    { ...fresh('relearn-later'), state: 'relearning', due: NOW + 60 * MINUTE },
    reviewCard({ id: 'review-due', due: MIDNIGHT }),
    reviewCard({ id: 'review-overdue', due: daysFromToday(-3) }),
    reviewCard({ id: 'review-future', due: daysFromToday(2) }),
  ];

  it('counts new, learning and due cards', () => {
    expect(buildQueue(cards, NOW, 20).counts).toEqual({ new: 3, learning: 3, due: 2 });
  });

  it('limits new cards to what is left of the daily allowance', () => {
    expect(buildQueue(cards, NOW, 2).counts.new).toBe(2);
    expect(buildQueue(cards, NOW, 0).counts.new).toBe(0);
    expect(buildQueue(cards, NOW, -5).counts.new).toBe(0);
  });

  it('shows due learning cards first, then reviews (most overdue first), then new', () => {
    const order: string[] = [];
    let remaining = [...cards];
    for (let i = 0; i < 6; i++) {
      const { next } = buildQueue(remaining, NOW, 20);
      if (!next) break;
      order.push(next.id);
      remaining = remaining.filter((c) => c.id !== next.id);
    }
    expect(order).toEqual(['learn-due', 'review-overdue', 'review-due', 'new-1', 'new-2', 'new-3']);
  });

  it('shows a learning card early when it is due soon and nothing else is left', () => {
    const queue = buildQueue([cards[4], cards[5], cards[8]], NOW, 20);
    expect(queue.next?.id).toBe('learn-soon');
  });

  it('waits when the only learning card is far off', () => {
    const queue = buildQueue([cards[5], cards[8]], NOW, 20);
    expect(queue.next).toBeNull();
    expect(queue.waitingUntil).toBe(NOW + 60 * MINUTE);
  });

  it('is empty when nothing is due', () => {
    expect(buildQueue([cards[8]], NOW, 20)).toEqual({
      next: null,
      counts: { new: 0, learning: 0, due: 0 },
      waitingUntil: null,
    });
  });
});

describe('computeStats', () => {
  const log = (rating: Rating, prevState: Card['state'], at: number): ReviewLog => ({
    id: `r${at}${rating}${prevState}`,
    cardId: 'c',
    docId: 'd',
    sectionId: 's',
    rating,
    prevState,
    at,
  });

  it('counts today and measures retention on review cards only', () => {
    const stats = computeStats(
      [
        log('good', 'new', NOW - MINUTE),
        log('again', 'learning', NOW - MINUTE),
        log('good', 'review', NOW - MINUTE),
        log('again', 'review', NOW - 2 * DAY),
        log('hard', 'review', NOW - 3 * DAY),
        log('easy', 'review', NOW - 4 * DAY),
      ],
      NOW,
    );
    expect(stats).toEqual({ reviewedToday: 3, newToday: 1, retention: 0.75, retentionSample: 4 });
  });

  it('reports no retention figure without review answers', () => {
    expect(computeStats([log('good', 'new', NOW)], NOW).retention).toBeNull();
  });
});
