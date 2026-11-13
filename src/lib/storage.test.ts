import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Doc, Question, Section } from '../types';
import { newCard, schedule } from './scheduler';
import {
  closeDb,
  createDocument,
  deleteDocument,
  getAllCards,
  getAllQuestions,
  getAllSections,
  getDoc,
  getQuestions,
  getReviewsSince,
  getSections,
  getSource,
  listDocs,
  putSection,
  putSections,
  replaceQuestions,
  saveReview,
  saveSource,
} from './storage';

const doc = (id: string, createdAt: number): Doc => ({ id, title: `Doc ${id}`, source: 'text', createdAt });
const section = (id: string, docId: string, index: number): Section => ({
  id,
  docId,
  index,
  title: `Section ${index + 1}`,
  text: 'Some text.',
  wordCount: 2,
});
const question = (id: string, docId: string, sectionId: string, createdAt = 1): Question => ({
  id,
  docId,
  sectionId,
  question: `Question ${id}?`,
  options: ['a', 'b', 'c', 'd'],
  correctIndex: 0,
  explanation: 'Because.',
  createdAt,
});

async function seed() {
  await createDocument(doc('d1', 100), [section('s2', 'd1', 1), section('s1', 'd1', 0)]);
  await createDocument(doc('d2', 200), [section('s3', 'd2', 0)]);
  const q1 = [question('q1', 'd1', 's1', 1), question('q2', 'd1', 's1', 2)];
  const q3 = [question('q3', 'd2', 's3')];
  await replaceQuestions('s1', q1, q1.map((q) => newCard(q, 1000)));
  await replaceQuestions('s3', q3, q3.map((q) => newCard(q, 1000)));
}

beforeEach(async () => {
  await closeDb();
  globalThis.indexedDB = new IDBFactory();
});

describe('storage', () => {
  it('saves documents and returns sections in order', async () => {
    await seed();
    expect((await listDocs()).map((d) => d.id)).toEqual(['d2', 'd1']);
    expect((await getDoc('d1'))?.title).toBe('Doc d1');
    expect((await getSections('d1')).map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('updates a section', async () => {
    await seed();
    const [first] = await getSections('d1');
    await putSection({ ...first, readAt: 5, lastScore: { correct: 3, total: 4, at: 6 } });
    expect((await getSections('d1'))[0]).toMatchObject({ readAt: 5, lastScore: { correct: 3, total: 4 } });
  });

  it('replaces a section\'s questions and cards without touching other sections', async () => {
    await seed();
    const fresh = [question('q9', 'd1', 's1')];
    await replaceQuestions('s1', fresh, fresh.map((q) => newCard(q, 2000)));
    expect((await getQuestions('s1')).map((q) => q.id)).toEqual(['q9']);
    expect((await getAllCards()).map((c) => c.id).sort()).toEqual(['q3', 'q9']);
    expect((await getAllQuestions()).length).toBe(2);
  });

  it('persists a review: the new schedule and a log entry', async () => {
    await seed();
    const card = (await getAllCards()).find((c) => c.id === 'q1')!;
    const next = schedule(card, 'easy', 5000);
    await saveReview(next, {
      id: 'r1',
      cardId: card.id,
      docId: card.docId,
      sectionId: card.sectionId,
      rating: 'easy',
      prevState: card.state,
      at: 5000,
    });

    await closeDb(); // a new session
    const stored = (await getAllCards()).find((c) => c.id === 'q1')!;
    expect(stored).toMatchObject({ ...next, updatedAt: expect.any(Number) });
    expect(stored).toMatchObject({ state: 'review', interval: 4 });
    expect(await getReviewsSince(0)).toMatchObject([{ cardId: 'q1', rating: 'easy', prevState: 'new' }]);
    expect(await getReviewsSince(5001)).toEqual([]);
  });

  it('deletes a document with everything that belongs to it', async () => {
    await seed();
    const card = (await getAllCards()).find((c) => c.id === 'q1')!;
    await saveReview(schedule(card, 'good', 5000), {
      id: 'r1',
      cardId: 'q1',
      docId: 'd1',
      sectionId: 's1',
      rating: 'good',
      prevState: 'new',
      at: 5000,
    });

    await deleteDocument('d1');
    expect((await listDocs()).map((d) => d.id)).toEqual(['d2']);
    expect((await getAllSections()).map((s) => s.id)).toEqual(['s3']);
    expect((await getAllQuestions()).map((q) => q.id)).toEqual(['q3']);
    expect((await getAllCards()).map((c) => c.id)).toEqual(['q3']);
    expect(await getReviewsSince(0)).toEqual([]);
  });

  it('keeps the skipped mark and page data of a section', async () => {
    await seed();
    const [first] = await getSections('d1');
    await putSection({ ...first, skipped: true, pageStarts: [{ page: 2, word: 0 }] });
    await closeDb(); // a new session
    expect((await getSections('d1'))[0]).toMatchObject({ skipped: true, pageStarts: [{ page: 2, word: 0 }] });
    await putSection({ ...(await getSections('d1'))[0], skipped: false });
    expect((await getSections('d1'))[0].skipped).toBe(false);
  });

  it('saves several sections at once', async () => {
    await seed();
    const list = await getSections('d1');
    await putSections(list.map((s) => ({ ...s, skipped: true })));
    expect((await getSections('d1')).map((s) => s.skipped)).toEqual([true, true]);
    expect((await getSections('d2'))[0].skipped).toBeUndefined();
  });

  it('stores the imported original and deletes it with its document', async () => {
    await seed();
    await saveSource({ id: 'd1', kind: 'html', html: '<p>Hello</p>', url: 'https://example.com/' });
    await saveSource({ id: 'd2', kind: 'html', html: '<p>Other</p>', url: 'https://example.org/' });
    expect(await getSource('d1')).toMatchObject({ kind: 'html', html: '<p>Hello</p>' });

    await deleteDocument('d1');
    expect(await getSource('d1')).toBeUndefined();
    expect(await getSource('d2')).toMatchObject({ kind: 'html' });
  });
});
