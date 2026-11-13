import { describe, expect, it } from 'vitest';
import { QuizError, buildUserPrompt, generateQuiz, parseQuiz } from './quiz.ts';

function q(overrides: Record<string, unknown> = {}) {
  return {
    question: 'What is the capital of France?',
    options: ['Paris', 'Lyon', 'Nice', 'Lille'],
    correct_index: 0,
    explanation: 'The passage names Paris as the capital.',
    ...overrides,
  };
}

const wrap = (questions: unknown[]) => JSON.stringify({ questions });

function kindOf(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    return err instanceof QuizError ? err.kind : 'other';
  }
  return 'none';
}

describe('parseQuiz', () => {
  it('accepts a well-formed quiz', () => {
    const result = parseQuiz(wrap([q(), q({ question: 'Q2?' }), q({ question: 'Q3?', correct_index: 3 })]), 3);
    expect(result).toHaveLength(3);
    expect(result[2]).toEqual({
      question: 'Q3?',
      options: ['Paris', 'Lyon', 'Nice', 'Lille'],
      correctIndex: 3,
      explanation: 'The passage names Paris as the capital.',
    });
  });

  it('rejects text that is not JSON', () => {
    expect(kindOf(() => parseQuiz('Here is your quiz!', 4))).toBe('invalid');
  });

  it('rejects JSON without a question list', () => {
    expect(kindOf(() => parseQuiz('{"items": []}', 4))).toBe('invalid');
    expect(kindOf(() => parseQuiz('null', 4))).toBe('invalid');
  });

  it('drops malformed questions and keeps the good ones', () => {
    const result = parseQuiz(
      wrap([
        q(),
        q({ correct_index: 4 }),
        q({ options: ['A', 'B', 'C'] }),
        q({ options: ['Same', 'same', 'C', 'D'] }),
        q({ question: '  ' }),
        q({ correct_index: '1' }),
        q({ question: 'Q2?' }),
        q({ question: 'Q3?' }),
      ]),
      5,
    );
    expect(result.map((r) => r.question)).toEqual(['What is the capital of France?', 'Q2?', 'Q3?']);
  });

  it('fails when too few questions survive', () => {
    expect(kindOf(() => parseQuiz(wrap([q(), q({ correct_index: -1 }), q({ explanation: '' })]), 4))).toBe(
      'invalid',
    );
  });

  it('trims extra questions to the requested count', () => {
    const many = Array.from({ length: 7 }, (_, i) => q({ question: `Q${i}?` }));
    expect(parseQuiz(wrap(many), 4)).toHaveLength(4);
  });
});

describe('generateQuiz', () => {
  it('fails clearly when the backend has no API key', async () => {
    await expect(generateQuiz({ apiKey: '', sectionText: 'x', docTitle: 'y', count: 4 })).rejects.toMatchObject({
      kind: 'no-key',
    });
  });
});

describe('buildUserPrompt', () => {
  it('includes the passage and the question count', () => {
    const prompt = buildUserPrompt('The sky is blue.', 'Colours', 4);
    expect(prompt).toContain('<passage>\nThe sky is blue.\n</passage>');
    expect(prompt).toContain('exactly 4 multiple-choice');
  });
});
