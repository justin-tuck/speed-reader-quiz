/** Quiz generation with the Claude API. Runs on the backend so the API key never reaches the browser. */
import Anthropic from '@anthropic-ai/sdk';
import type { GeneratedQuestion, QuizErrorKind } from '../../shared/api.ts';

export const QUIZ_MODEL = 'claude-sonnet-5-5';
export const OPTION_COUNT = 4;
export const MIN_QUESTIONS = 3;
export const MAX_QUESTIONS = 5;

/**
 * API Gateway gives up on a request after 30 seconds, so the Claude call has
 * to finish well inside that.
 */
const REQUEST_TIMEOUT_MS = 24_000;

/** A quiz failure with a message that is safe to show to the user. */
export class QuizError extends Error {
  readonly kind: QuizErrorKind;
  constructor(kind: QuizErrorKind, message: string) {
    super(message);
    this.name = 'QuizError';
    this.kind = kind;
  }
}

const QUIZ_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          correct_index: { type: 'integer' },
          explanation: { type: 'string' },
        },
        required: ['question', 'options', 'correct_index', 'explanation'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You write reading-comprehension quizzes. A reader has just finished one section of a longer text at high speed, and your questions check whether they understood and remember it. The same questions are later reused as flashcards for spaced-repetition study, days or weeks after the reader last saw the passage.

That second use shapes how the questions should be written:
- Each question must make sense on its own, without the passage in front of the reader. Name the subject explicitly instead of writing "the author", "the passage", "this section" or "the study".
- Ask about the ideas, claims, causes and facts that matter in the passage, not about trivial wording or the order of sentences.
- Every question must be answerable from the passage alone, and the passage must clearly support exactly one option.
- The reader should also be able to answer from memory with the options hidden, so avoid "which of the following" phrasing and options like "all of the above".
- Make the wrong options plausible to someone who skimmed, and keep all options similar in length and style so the right one does not stand out.
- The explanation is one sentence that says why the answer is right by pointing to what the passage says.`;

export function buildUserPrompt(sectionText: string, docTitle: string, count: number): string {
  return `The passage is a section of "${docTitle}".

<passage>
${sectionText}
</passage>

Write exactly ${count} multiple-choice questions about this passage. Each question has exactly ${OPTION_COUNT} options and one correct answer. "correct_index" is the zero-based position of the correct option in "options". Vary the position of the correct option between questions.`;
}

function invalid(detail: string): QuizError {
  return new QuizError('invalid', `The model's reply was not a usable quiz (${detail}).`);
}

/** Checks the model's JSON and returns clean questions, or throws a QuizError. */
export function parseQuiz(json: string, count: number): GeneratedQuestion[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw invalid('it was not valid JSON');
  }
  const list = (data as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(list)) throw invalid('it had no list of questions');

  const questions: GeneratedQuestion[] = [];
  for (const item of list as Record<string, unknown>[]) {
    if (!item || typeof item !== 'object') continue;
    const question = typeof item.question === 'string' ? item.question.trim() : '';
    const explanation = typeof item.explanation === 'string' ? item.explanation.trim() : '';
    const options = Array.isArray(item.options)
      ? item.options.map((o) => (typeof o === 'string' ? o.trim() : ''))
      : [];
    const correctIndex = item.correct_index;

    const distinct = new Set(options.map((o) => o.toLowerCase())).size === options.length;
    const usable =
      question !== '' &&
      explanation !== '' &&
      options.length === OPTION_COUNT &&
      options.every((o) => o !== '') &&
      distinct &&
      typeof correctIndex === 'number' &&
      Number.isInteger(correctIndex) &&
      correctIndex >= 0 &&
      correctIndex < OPTION_COUNT;
    if (usable) questions.push({ question, options, correctIndex: correctIndex as number, explanation });
  }

  if (questions.length < Math.min(MIN_QUESTIONS, count)) {
    throw invalid(`only ${questions.length} of its questions were well formed`);
  }
  return questions.slice(0, count);
}

export interface GenerateOptions {
  apiKey: string;
  sectionText: string;
  docTitle: string;
  count: number;
}

async function requestQuiz(
  { apiKey, sectionText, docTitle, count }: GenerateOptions,
  timeoutMs: number,
): Promise<string> {
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: timeoutMs });

  let response;
  try {
    response = await client.beta.messages.create({
      model: QUIZ_MODEL,
      max_tokens: 8000,
      // If a safety classifier declines a passage, the API retries on a fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(sectionText, docTitle, count) }],
      // Low effort keeps the reply fast enough for the 30-second gateway limit.
      output_config: { effort: 'low', format: { type: 'json_schema', schema: QUIZ_SCHEMA } },
    });
  } catch (err) {
    if (err instanceof Anthropic.APIConnectionTimeoutError) {
      throw new QuizError('timeout', 'Claude took too long to write the quiz. Try again.');
    }
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      throw new QuizError('auth', "The server's Claude API key was rejected. Check the key configured for the backend.");
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new QuizError('rate-limit', 'The Claude API is rate limiting the key. Wait a moment and try again.');
    }
    if (err instanceof Anthropic.APIConnectionError) {
      throw new QuizError('network', 'The server could not reach the Claude API. Try again.');
    }
    if (err instanceof Anthropic.APIError) {
      // Prefer the API's own sentence over the SDK's "400 {json}" summary.
      const body = err.error as { error?: { message?: unknown } } | undefined;
      const detail = typeof body?.error?.message === 'string' ? body.error.message : err.message;
      throw new QuizError('api', `The Claude API returned an error (${err.status ?? 'unknown'}): ${detail}`);
    }
    throw new QuizError('api', 'Something went wrong while asking Claude for a quiz.');
  }

  if (response.stop_reason === 'refusal') {
    throw new QuizError('refusal', 'Claude declined to write questions about this section.');
  }
  if (response.stop_reason === 'max_tokens') throw invalid('it was cut off');
  const text = response.content.find((block) => block.type === 'text');
  if (!text || text.type !== 'text') throw invalid('it was empty');
  return text.text;
}

/**
 * Asks Claude for a quiz. A malformed reply is retried once if there is time
 * left inside the gateway limit.
 */
export async function generateQuiz(options: GenerateOptions): Promise<GeneratedQuestion[]> {
  if (!options.apiKey) {
    throw new QuizError('no-key', 'The backend has no Claude API key configured.');
  }
  const count = Math.min(MAX_QUESTIONS, Math.max(MIN_QUESTIONS, Math.round(options.count) || MIN_QUESTIONS));
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const timeLeft = deadline - Date.now();
    if (attempt > 0 && timeLeft < 8_000) break;
    try {
      return parseQuiz(await requestQuiz({ ...options, count }, timeLeft), count);
    } catch (err) {
      if (!(err instanceof QuizError) || err.kind !== 'invalid') throw err;
      lastError = err;
    }
  }
  throw lastError;
}
