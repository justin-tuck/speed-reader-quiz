/** Ties quiz generation to storage: generates a section's quiz and saves it as questions and flashcards. */
import type { Doc, Question, Section } from '../types';
import { QuizError, generateQuiz } from './quiz';
import { newCard } from './scheduler';
import { newId, replaceQuestions } from './storage';

// One request per section at a time. The request is not cancelled when the
// screen changes, so a quiz that was paid for is always saved.
const inFlight = new Map<string, Promise<Question[]>>();

export function generateAndSaveQuiz(
  doc: Doc,
  section: Section,
  count: number,
): Promise<Question[]> {
  if (section.skipped) {
    return Promise.reject(new QuizError('skipped', 'This section is skipped, so it has no quiz.'));
  }
  const running = inFlight.get(section.id);
  if (running) return running;

  const request = (async () => {
    const generated = await generateQuiz({ sectionText: section.text, docTitle: doc.title, count });
    const now = Date.now();
    const questions: Question[] = generated.map((g, i) => ({
      id: newId(),
      docId: doc.id,
      sectionId: section.id,
      question: g.question,
      options: g.options,
      correctIndex: g.correctIndex,
      explanation: g.explanation,
      createdAt: now + i, // keeps the model's question order
    }));
    await replaceQuestions(
      section.id,
      questions,
      questions.map((q) => newCard(q, now)),
    );
    return questions;
  })().finally(() => inFlight.delete(section.id));

  inFlight.set(section.id, request);
  return request;
}
