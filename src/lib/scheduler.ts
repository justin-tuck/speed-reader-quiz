/**
 * Spaced-repetition scheduler: a simplified version of Anki's SM-2 variant.
 *
 * New cards go through short learning steps (minutes), then graduate to
 * review with day intervals that grow by the card's ease factor. A lapse
 * (Again on a review card) sends it through a relearning step.
 *
 * Everything here is a pure function of its inputs so it is easy to test.
 */
import type { Card, Rating, ReviewLog } from '../types';

export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;

export interface SchedulerConfig {
  /** Delays in minutes for a new card before it graduates. */
  learningSteps: number[];
  /** Delays in minutes after a lapse. */
  relearningSteps: number[];
  /** First interval in days after finishing the learning steps with Good. */
  graduatingInterval: number;
  /** First interval in days when a learning card is rated Easy. */
  easyInterval: number;
  startingEase: number;
  minEase: number;
  /** Interval multiplier for Hard on a review card. */
  hardFactor: number;
  /** Extra multiplier on top of ease for Easy on a review card. */
  easyBonus: number;
  /** Interval in days a card restarts from after a lapse. */
  lapseInterval: number;
  maxInterval: number;
  /** Learning cards due within this many minutes are shown early when nothing else is left. */
  learnAheadMinutes: number;
}

export const DEFAULT_CONFIG: SchedulerConfig = {
  learningSteps: [1, 10],
  relearningSteps: [10],
  graduatingInterval: 1,
  easyInterval: 4,
  startingEase: 2.5,
  minEase: 1.3,
  hardFactor: 1.2,
  easyBonus: 1.3,
  lapseInterval: 1,
  maxInterval: 36_500,
  learnAheadMinutes: 20,
};

export const RATINGS: Rating[] = ['again', 'hard', 'good', 'easy'];

export function newCard(
  question: { id: string; docId: string; sectionId: string },
  now: number,
  config: SchedulerConfig = DEFAULT_CONFIG,
): Card {
  return {
    id: question.id,
    docId: question.docId,
    sectionId: question.sectionId,
    state: 'new',
    ease: config.startingEase,
    interval: 0,
    step: 0,
    due: now,
    reps: 0,
    lapses: 0,
  };
}

/** Local midnight at the start of the day containing `timestamp`. */
export function startOfDay(timestamp: number): number {
  const d = new Date(timestamp);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Review cards become due at the start of the day, `days` days from today. */
function dueInDays(now: number, days: number): number {
  const d = new Date(startOfDay(now));
  d.setDate(d.getDate() + days);
  return d.getTime();
}

function toReview(card: Card, interval: number, now: number, config: SchedulerConfig): Card {
  const days = Math.min(config.maxInterval, Math.max(1, Math.round(interval)));
  return { ...card, state: 'review', step: 0, interval: days, due: dueInDays(now, days) };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Handles new, learning and relearning cards, which move through minute steps. */
function scheduleSteps(card: Card, rating: Rating, now: number, config: SchedulerConfig): Card {
  const relearning = card.state === 'relearning';
  const steps = relearning ? config.relearningSteps : config.learningSteps;
  const state = relearning ? 'relearning' : 'learning';
  const step = Math.min(card.step, steps.length - 1);

  // A relearned card returns to the interval it was given when it lapsed.
  const graduate = (easy: boolean) => {
    const interval = relearning
      ? card.interval + (easy ? 1 : 0)
      : easy
        ? config.easyInterval
        : config.graduatingInterval;
    return toReview(card, interval, now, config);
  };

  switch (rating) {
    case 'again':
      return { ...card, state, step: 0, due: now + steps[0] * MINUTE };
    case 'hard': {
      // Repeat the current step. On the first step, wait halfway to the next one.
      const delay = step === 0 ? (steps.length > 1 ? (steps[0] + steps[1]) / 2 : steps[0] * 1.5) : steps[step];
      return { ...card, state, step, due: now + delay * MINUTE };
    }
    case 'good':
      if (step + 1 < steps.length) {
        return { ...card, state, step: step + 1, due: now + steps[step + 1] * MINUTE };
      }
      return graduate(false);
    case 'easy':
      return graduate(true);
  }
}

function scheduleReview(card: Card, rating: Rating, now: number, config: SchedulerConfig): Card {
  const hardInterval = Math.max(card.interval + 1, card.interval * config.hardFactor);
  const goodInterval = Math.max(hardInterval + 1, card.interval * card.ease);
  const easyInterval = Math.max(goodInterval + 1, card.interval * card.ease * config.easyBonus);

  switch (rating) {
    case 'again':
      return {
        ...card,
        state: 'relearning',
        step: 0,
        lapses: card.lapses + 1,
        ease: round2(Math.max(config.minEase, card.ease - 0.2)),
        interval: config.lapseInterval,
        due: now + config.relearningSteps[0] * MINUTE,
      };
    case 'hard':
      return toReview(
        { ...card, ease: round2(Math.max(config.minEase, card.ease - 0.15)) },
        hardInterval,
        now,
        config,
      );
    case 'good':
      return toReview(card, goodInterval, now, config);
    case 'easy':
      return toReview({ ...card, ease: round2(card.ease + 0.15) }, easyInterval, now, config);
  }
}

/** Returns the card as it should be stored after the user rates it. */
export function schedule(
  card: Card,
  rating: Rating,
  now: number,
  config: SchedulerConfig = DEFAULT_CONFIG,
): Card {
  const next =
    card.state === 'review'
      ? scheduleReview(card, rating, now, config)
      : scheduleSteps(card, rating, now, config);
  return { ...next, reps: card.reps + 1 };
}

export function formatInterval(ms: number): string {
  const minutes = ms / MINUTE;
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${(days / 30).toFixed(1).replace(/\.0$/, '')}mo`;
  return `${(days / 365).toFixed(1).replace(/\.0$/, '')}y`;
}

/** The label for each rating button: how long until the card comes back. */
export function previewIntervals(
  card: Card,
  now: number,
  config: SchedulerConfig = DEFAULT_CONFIG,
): Record<Rating, string> {
  const label = (rating: Rating) => {
    const next = schedule(card, rating, now, config);
    return formatInterval(next.state === 'review' ? next.interval * DAY : next.due - now);
  };
  return { again: label('again'), hard: label('hard'), good: label('good'), easy: label('easy') };
}

export interface QueueCounts {
  new: number;
  learning: number;
  due: number;
}

export interface Queue {
  /** The card to show now, or null when nothing is ready. */
  next: Card | null;
  counts: QueueCounts;
  /** When nothing is ready: the time the next learning card comes due, if any. */
  waitingUntil: number | null;
}

/**
 * Builds today's queue. Learning cards that are due come first, then due
 * reviews, then new cards up to the remaining daily limit.
 */
export function buildQueue(
  cards: Card[],
  now: number,
  newCardsLeftToday: number,
  config: SchedulerConfig = DEFAULT_CONFIG,
): Queue {
  const byDue = (a: Card, b: Card) => a.due - b.due || a.id.localeCompare(b.id);
  const learning = cards.filter((c) => c.state === 'learning' || c.state === 'relearning').sort(byDue);
  const reviews = cards.filter((c) => c.state === 'review' && c.due <= now).sort(byDue);
  const fresh = cards
    .filter((c) => c.state === 'new')
    .sort(byDue)
    .slice(0, Math.max(0, newCardsLeftToday));

  const learningDue = learning.filter((c) => c.due <= now);
  const learningLater = learning.filter((c) => c.due > now);

  let next: Card | null = learningDue[0] ?? reviews[0] ?? fresh[0] ?? null;
  if (!next && learningLater[0] && learningLater[0].due - now <= config.learnAheadMinutes * MINUTE) {
    next = learningLater[0];
  }

  return {
    next,
    counts: { new: fresh.length, learning: learning.length, due: reviews.length },
    waitingUntil: next ? null : (learningLater[0]?.due ?? null),
  };
}

export interface StudyStats {
  reviewedToday: number;
  newToday: number;
  /** Share of review-card answers that were not Again, or null with no data. */
  retention: number | null;
  /** Number of review-card answers the retention figure is based on. */
  retentionSample: number;
}

/** Stats from the review log. Pass the logs for the period retention should cover. */
export function computeStats(reviews: ReviewLog[], now: number): StudyStats {
  const today = startOfDay(now);
  const todays = reviews.filter((r) => r.at >= today);
  const mature = reviews.filter((r) => r.prevState === 'review');
  const remembered = mature.filter((r) => r.rating !== 'again').length;
  return {
    reviewedToday: todays.length,
    newToday: todays.filter((r) => r.prevState === 'new').length,
    retention: mature.length > 0 ? remembered / mature.length : null,
    retentionSample: mature.length,
  };
}
