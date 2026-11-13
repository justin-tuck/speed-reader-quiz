import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleRequest } from '../../server/core/router.ts';
import { MemoryStore } from '../../server/core/sync.ts';
import type { Doc, Question, Section } from '../types';
import { newCard, schedule } from './scheduler';
import {
  closeDb,
  countOutbox,
  createDocument,
  deleteDocument,
  getAllCards,
  getAllQuestions,
  getProgress,
  getReviewsSince,
  getSections,
  listDocs,
  putSection,
  replaceQuestions,
  saveProgress,
  saveReview,
} from './storage';
import { getSyncStatus, onRemoteChange, syncNow } from './sync';

/**
 * Two "devices" are two separate browser databases. Both talk to the real
 * backend router, backed by an in-memory store.
 */
let server: MemoryStore;
let devices: Record<'laptop' | 'phone', IDBFactory>;
let online = true;
let clock = 1_000_000;

async function use(device: 'laptop' | 'phone') {
  await closeDb();
  globalThis.indexedDB = devices[device];
}

beforeEach(async () => {
  await closeDb();
  server = new MemoryStore();
  devices = { laptop: new IDBFactory(), phone: new IDBFactory() };
  online = true;
  // Every reading of the clock is later than the one before, on any device.
  vi.spyOn(Date, 'now').mockImplementation(() => (clock += 10));
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    if (!online) throw new TypeError('Failed to fetch');
    const url = new URL(path, 'http://app.test');
    const res = await handleRequest(
      { method: init.method ?? 'GET', path: url.pathname, query: url.searchParams, body: init.body as string, userId: 'me' },
      { store: server, getApiKey: async () => '' },
    );
    return new Response(res.body as string, { status: res.status, headers: res.headers });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const doc: Doc = { id: 'd1', title: 'Mars', source: 'text', createdAt: 1 };
const sections: Section[] = [
  { id: 's1', docId: 'd1', index: 0, title: 'One', text: 'First section.', wordCount: 2 },
  { id: 's2', docId: 'd1', index: 1, title: 'Two', text: 'Second section.', wordCount: 2 },
];
const questions: Question[] = ['q1', 'q2'].map((id, i) => ({
  id,
  docId: 'd1',
  sectionId: 's1',
  question: `Question ${id}?`,
  options: ['a', 'b', 'c', 'd'],
  correctIndex: 0,
  explanation: 'Because.',
  createdAt: i,
}));

async function seedLaptop() {
  await use('laptop');
  await createDocument(doc, sections);
  await replaceQuestions('s1', questions, questions.map((q) => newCard(q, 500)));
  await syncNow();
}

describe('sync between two devices', () => {
  it('brings a text, its sections, questions and cards to a second device', async () => {
    await seedLaptop();
    expect(await countOutbox()).toBe(0);
    expect(getSyncStatus()).toMatchObject({ state: 'idle', pending: 0 });

    await use('phone');
    const changed = vi.fn();
    const stop = onRemoteChange(changed);
    await syncNow();
    stop();

    expect((await listDocs()).map((d) => d.title)).toEqual(['Mars']);
    expect((await getSections('d1')).map((s) => s.text)).toEqual(['First section.', 'Second section.']);
    expect((await getAllQuestions()).map((q) => q.id).sort()).toEqual(['q1', 'q2']);
    expect((await getAllCards()).map((c) => c.state)).toEqual(['new', 'new']);
    expect(changed).toHaveBeenCalledTimes(1);
    // Receiving records must not queue them to be sent straight back.
    expect(await countOutbox()).toBe(0);
  });

  it('carries reviews and the reading position from the phone back to the laptop', async () => {
    await seedLaptop();
    await use('phone');
    await syncNow();

    const card = (await getAllCards()).find((c) => c.id === 'q1')!;
    const rated = schedule(card, 'easy', 9000);
    await saveReview(rated, { id: 'r1', cardId: 'q1', docId: 'd1', sectionId: 's1', rating: 'easy', prevState: 'new', at: 9000 });
    await saveProgress({ id: 's2', docId: 'd1', index: 137, total: 400 });
    await syncNow();

    await use('laptop');
    await syncNow();
    expect((await getAllCards()).find((c) => c.id === 'q1')).toMatchObject({ state: 'review', interval: 4 });
    expect((await getAllCards()).find((c) => c.id === 'q2')).toMatchObject({ state: 'new' });
    expect(await getReviewsSince(0)).toMatchObject([{ id: 'r1', rating: 'easy' }]);
    expect(await getProgress('s2')).toMatchObject({ index: 137, total: 400 });
  });

  it('keeps the later change when both devices edit the same record', async () => {
    await seedLaptop();
    await use('phone');
    await syncNow();

    // Offline on both: the laptop edits first, the phone edits later.
    await use('laptop');
    await putSection({ ...(await getSections('d1'))[0], title: 'Laptop title' });
    await use('phone');
    await putSection({ ...(await getSections('d1'))[0], title: 'Phone title' });

    // The laptop syncs last, but its change is older and must lose.
    await syncNow();
    await use('laptop');
    await syncNow();
    expect((await getSections('d1'))[0].title).toBe('Phone title');
    expect(await countOutbox()).toBe(0);

    await use('phone');
    await syncNow();
    expect((await getSections('d1'))[0].title).toBe('Phone title');
  });

  it('merges reviews done on both devices', async () => {
    await seedLaptop();
    await use('phone');
    await syncNow();

    const review = async (id: string, cardId: string) => {
      const card = (await getAllCards()).find((c) => c.id === cardId)!;
      await saveReview(schedule(card, 'good', 9000), { id, cardId, docId: 'd1', sectionId: 's1', rating: 'good', prevState: 'new', at: 9000 });
    };
    await review('r-phone', 'q1');
    await use('laptop');
    await review('r-laptop', 'q2');
    await syncNow();
    await use('phone');
    await syncNow();
    await use('laptop');
    await syncNow();

    for (const device of ['laptop', 'phone'] as const) {
      await use(device);
      expect((await getReviewsSince(0)).map((r) => r.id).sort()).toEqual(['r-laptop', 'r-phone']);
      expect((await getAllCards()).map((c) => c.state)).toEqual(['learning', 'learning']);
    }
  });

  it('removes a deleted text from the other device', async () => {
    await seedLaptop();
    await use('phone');
    await syncNow();
    await saveProgress({ id: 's1', docId: 'd1', index: 3, total: 2 });
    await syncNow();

    await use('laptop');
    await syncNow();
    await deleteDocument('d1');
    await syncNow();

    await use('phone');
    await syncNow();
    expect(await listDocs()).toEqual([]);
    expect(await getSections('d1')).toEqual([]);
    expect(await getAllCards()).toEqual([]);
    expect(await getAllQuestions()).toEqual([]);
    expect(await getProgress('s1')).toBeUndefined();
    expect(await countOutbox()).toBe(0);
  });

  it('keeps changes made offline and sends them once back online', async () => {
    await seedLaptop();
    online = false;
    await putSection({ ...(await getSections('d1'))[0], readAt: 5 });
    await syncNow();
    expect(getSyncStatus().state).toBe('offline');
    expect(getSyncStatus().pending).toBe(1);

    online = true;
    await syncNow();
    expect(getSyncStatus()).toMatchObject({ state: 'idle', pending: 0 });

    await use('phone');
    await syncNow();
    expect((await getSections('d1'))[0].readAt).toBe(5);
  });

  it('sends more records than fit in one request', async () => {
    await use('laptop');
    const many: Section[] = Array.from({ length: 130 }, (_, i) => ({
      id: `m${i}`,
      docId: 'big',
      index: i,
      title: `S${i}`,
      text: 'Text.',
      wordCount: 1,
    }));
    await createDocument({ id: 'big', title: 'Big', source: 'text', createdAt: 1 }, many);
    await syncNow();
    expect(await countOutbox()).toBe(0);

    await use('phone');
    await syncNow();
    expect(await getSections('big')).toHaveLength(130);
  });
});

describe('upgrading data saved before sync existed', () => {
  it('keeps everything, gives reviews unique ids and queues it all for the first sync', async () => {
    await use('laptop');
    // A database as version 1 of the app created it.
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('speed-reader-quiz', 1);
      open.onupgradeneeded = () => {
        const db = open.result;
        db.createObjectStore('docs', { keyPath: 'id' }).put(doc);
        db.createObjectStore('sections', { keyPath: 'id' }).createIndex('docId', 'docId');
        db.createObjectStore('questions', { keyPath: 'id' }).createIndex('sectionId', 'sectionId');
        const cards = db.createObjectStore('cards', { keyPath: 'id' });
        cards.createIndex('docId', 'docId');
        cards.put(newCard(questions[0], 500));
        const reviews = db.createObjectStore('reviews', { keyPath: 'id', autoIncrement: true });
        reviews.createIndex('docId', 'docId');
        reviews.createIndex('at', 'at');
        reviews.put({ cardId: 'q1', docId: 'd1', sectionId: 's1', rating: 'good', prevState: 'new', at: 700 });
        reviews.put({ cardId: 'q1', docId: 'd1', sectionId: 's1', rating: 'good', prevState: 'learning', at: 800 });
      };
      open.onsuccess = () => {
        open.result.close();
        resolve();
      };
      open.onerror = () => reject(open.error);
    });

    expect((await listDocs())[0]).toMatchObject({ title: 'Mars' });
    const reviews = await getReviewsSince(0);
    expect(reviews.map((r) => r.at)).toEqual([700, 800]);
    expect(reviews.every((r) => typeof r.id === 'string' && r.id.length > 10)).toBe(true);
    expect(await countOutbox()).toBe(4); // 1 text, 1 card, 2 reviews

    await syncNow();
    await use('phone');
    await syncNow();
    expect(await listDocs()).toHaveLength(1);
    expect(await getReviewsSince(0)).toHaveLength(2);
  });
});
