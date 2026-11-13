export type SourceKind = 'pdf' | 'url' | 'text';

/**
 * Every stored record carries `updatedAt`, the time it was last changed on a
 * device. The storage layer sets it on each write; sync uses it to decide
 * which copy of a record is newer.
 */
interface Stamped {
  updatedAt?: number;
}

export interface Doc extends Stamped {
  id: string;
  title: string;
  source: SourceKind;
  /** File name or URL the text came from. */
  sourceRef?: string;
  createdAt: number;
}

export interface Section extends Stamped {
  id: string;
  docId: string;
  index: number;
  title: string;
  text: string;
  wordCount: number;
  /** Set the first time the section is read to the end. */
  readAt?: number;
  lastScore?: { correct: number; total: number; at: number };
  /** Left out of quizzes and study. The section can still be read and previewed. */
  skipped?: boolean;
  /** For PDFs: which page of the source each part of the section is on. */
  pageStarts?: PageStart[];
}

/** Page `page` (counted from 1) starts at word `word` of a section. */
export interface PageStart {
  page: number;
  word: number;
}

/** The original a text was imported from: a PDF file or a snapshot of a web page. */
export type SourceOriginal = { kind: 'pdf'; file: Blob } | { kind: 'html'; html: string; url: string };

/**
 * A stored original, kept to show page previews. It can be large, so it stays
 * on the device that imported it and is not synced. The id equals the doc id.
 */
export type DocSource = SourceOriginal & { id: string };

export interface Question extends Stamped {
  id: string;
  docId: string;
  sectionId: string;
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  createdAt: number;
}

export type CardState = 'new' | 'learning' | 'review' | 'relearning';
export type Rating = 'again' | 'hard' | 'good' | 'easy';

/** Scheduling data for one flashcard. The id equals the question id. */
export interface Card extends Stamped {
  id: string;
  docId: string;
  sectionId: string;
  state: CardState;
  /** Ease factor, e.g. 2.5 means the interval grows 2.5x on Good. */
  ease: number;
  /** Current review interval in days (0 until the card graduates). */
  interval: number;
  /** Position in the learning or relearning steps. */
  step: number;
  /** Timestamp (ms) when the card is next due. */
  due: number;
  reps: number;
  lapses: number;
}

export interface ReviewLog extends Stamped {
  id: string;
  cardId: string;
  docId: string;
  sectionId: string;
  rating: Rating;
  prevState: CardState;
  at: number;
}

/** Where reading stopped inside a section. The id equals the section id. */
export interface Progress extends Stamped {
  id: string;
  docId: string;
  /** Index of the word to resume at. */
  index: number;
  /** Number of words in the section when this was saved. */
  total: number;
}

export interface Settings {
  wpm: number;
  minWords: number;
  maxWords: number;
  questionsPerQuiz: number;
  /** Speed multiplier for a slower re-read, e.g. 0.75. */
  rereadFactor: number;
  newCardsPerDay: number;
}
