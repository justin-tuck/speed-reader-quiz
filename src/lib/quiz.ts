/**
 * Asks the backend for a quiz. The backend calls the Claude API with a key
 * that never reaches the browser (see server/core/quiz.ts).
 */
import type { GeneratedQuestion, QuizRequest, QuizResponse } from '../../shared/api';
import { ApiError, apiPost } from './api';

export type { GeneratedQuestion };

/** A quiz failure with a message that is safe to show to the user. */
export class QuizError extends Error {
  /** 'no-key', 'auth', 'rate-limit', 'refusal', 'offline', 'unauthorized', … */
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.name = 'QuizError';
    this.kind = kind;
  }
}

export async function generateQuiz(request: QuizRequest): Promise<GeneratedQuestion[]> {
  try {
    const { questions } = await apiPost<QuizResponse>('/api/quiz', request);
    if (!Array.isArray(questions) || questions.length === 0) {
      throw new QuizError('invalid', 'The server returned an empty quiz.');
    }
    return questions;
  } catch (err) {
    if (err instanceof QuizError) throw err;
    if (err instanceof ApiError) throw new QuizError(err.kind ?? 'api', err.message);
    throw new QuizError('api', 'Something went wrong while creating the quiz.');
  }
}

/** A random display order for the options, so retakes do not reward position memory. */
export function shuffledOrder(length: number, random: () => number = Math.random): number[] {
  const order = Array.from({ length }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}
