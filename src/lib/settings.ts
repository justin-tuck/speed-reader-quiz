import type { Settings } from '../types';
import { clampWpm } from './rsvp';

const KEY = 'speed-reader-quiz:settings';

export const DEFAULT_SETTINGS: Settings = {
  wpm: 300,
  minWords: 300,
  maxWords: 500,
  questionsPerQuiz: 4,
  rereadFactor: 0.75,
  newCardsPerDay: 20,
};

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

export function sanitizeSettings(raw: Partial<Settings>): Settings {
  const d = DEFAULT_SETTINGS;
  const maxWords = clamp(raw.maxWords, 50, 5000, d.maxWords);
  return {
    wpm: clampWpm(typeof raw.wpm === 'number' ? raw.wpm : d.wpm),
    maxWords,
    minWords: Math.min(clamp(raw.minWords, 20, 5000, d.minWords), maxWords),
    questionsPerQuiz: clamp(raw.questionsPerQuiz, 3, 5, d.questionsPerQuiz),
    rereadFactor:
      typeof raw.rereadFactor === 'number' && raw.rereadFactor >= 0.4 && raw.rereadFactor <= 1
        ? raw.rereadFactor
        : d.rereadFactor,
    newCardsPerDay: clamp(raw.newCardsPerDay, 0, 500, d.newCardsPerDay),
  };
}

export function loadSettings(): Settings {
  try {
    const stored = localStorage.getItem(KEY);
    return sanitizeSettings(stored ? (JSON.parse(stored) as Partial<Settings>) : {});
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable (private mode); the app still works for this session.
  }
}
