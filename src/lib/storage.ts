/**
 * Local storage in IndexedDB. The app always reads and writes here, so it
 * stays fast and works offline. Every change is also noted in an "outbox",
 * which sync.ts sends to the backend so other devices receive it.
 */
import { openDB, type IDBPDatabase, type IDBPTransaction } from 'idb';
import type { SyncRecord, SyncStore } from '../../shared/api';
import type { Card, Doc, DocSource, Progress, Question, ReviewLog, Section } from '../types';

/** A change waiting to be sent to the backend. */
export interface OutboxEntry {
  /** `${store}:${id}` */
  key: string;
  store: SyncStore;
  id: string;
  updatedAt: number;
  deleted: boolean;
}

const DB_NAME = 'speed-reader-quiz';
const DB_VERSION = 3;
const DATA_STORES: SyncStore[] = ['docs', 'sections', 'questions', 'cards', 'reviews', 'progress'];
const ALL_STORES = [...DATA_STORES, 'outbox', 'meta'];
/** Imported originals for page previews. Kept on this device only, so not in DATA_STORES. */
const SOURCES = 'sources';

// The stores hold different record types, so the database is opened untyped
// and each function below states the type it reads or writes.
type Db = IDBPDatabase;
type WriteTx = IDBPTransaction<unknown, string[], 'readwrite'>;
type Stored = { id: string; updatedAt?: number };

let dbPromise: Promise<Db> | null = null;

function db(): Promise<Db> {
  dbPromise ??= openDB(DB_NAME, DB_VERSION, {
    async upgrade(database, oldVersion, _newVersion, tx) {
      const now = Date.now();
      const withIndexes = (name: string, indexes: string[]) => {
        const store = database.createObjectStore(name, { keyPath: 'id' });
        for (const index of indexes) store.createIndex(index, index);
        return store;
      };

      if (oldVersion < 1) {
        withIndexes('docs', []);
        withIndexes('sections', ['docId']);
        withIndexes('questions', ['docId', 'sectionId']);
        withIndexes('cards', ['docId', 'sectionId']);
        withIndexes('reviews', ['docId', 'at']);
      }
      if (oldVersion < 2) {
        withIndexes('progress', ['docId']);
        const outbox = database.createObjectStore('outbox', { keyPath: 'key' });
        database.createObjectStore('meta');

        if (oldVersion === 1) {
          // Data from before sync existed: stamp every record and queue it,
          // so the first sync uploads it. Reviews also move from numeric to
          // globally unique ids.
          const queue = (store: SyncStore, id: string, updatedAt: number) =>
            outbox.put({ key: `${store}:${id}`, store, id, updatedAt, deleted: false } satisfies OutboxEntry);

          const oldReviews = (await tx.objectStore('reviews').getAll()) as (Omit<ReviewLog, 'id'> & { id?: unknown })[];
          database.deleteObjectStore('reviews');
          const reviews = withIndexes('reviews', ['docId', 'at']);
          for (const review of oldReviews) {
            const migrated: ReviewLog = { ...review, id: newId(), updatedAt: review.at };
            await reviews.put(migrated);
            await queue('reviews', migrated.id, review.at);
          }
          for (const name of ['docs', 'sections', 'questions', 'cards'] as const) {
            const store = tx.objectStore(name);
            for (const record of (await store.getAll()) as Stored[]) {
              await store.put({ ...record, updatedAt: now });
              await queue(name, record.id, now);
            }
          }
        }
      }
      if (oldVersion < 3) database.createObjectStore(SOURCES, { keyPath: 'id' });
    },
  });
  return dbPromise;
}

export function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // randomUUID needs HTTPS; this covers opening the dev server from a phone over plain HTTP.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// --- change tracking

const changeListeners = new Set<() => void>();

/** Calls `listener` after every local write. Returns a function that stops it. */
export function onLocalChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

/** Saves a record and queues it for sync, as part of `tx`. */
function put(tx: WriteTx, store: SyncStore, record: Stored, now: number): Promise<unknown>[] {
  const entry: OutboxEntry = { key: `${store}:${record.id}`, store, id: record.id, updatedAt: now, deleted: false };
  return [tx.objectStore(store).put({ ...record, updatedAt: now }), tx.objectStore('outbox').put(entry)];
}

/** Deletes a record and queues the deletion for sync, as part of `tx`. */
function remove(tx: WriteTx, store: SyncStore, id: string, now: number): Promise<unknown>[] {
  const entry: OutboxEntry = { key: `${store}:${id}`, store, id, updatedAt: now, deleted: true };
  return [tx.objectStore(store).delete(id), tx.objectStore('outbox').put(entry)];
}

async function write(stores: SyncStore[], work: (tx: WriteTx, now: number) => Promise<Promise<unknown>[]>) {
  const tx = (await db()).transaction([...stores, 'outbox'], 'readwrite') as unknown as WriteTx;
  const pending = await work(tx, Date.now());
  await Promise.all([...pending, tx.done]);
  changeListeners.forEach((listener) => listener());
}

// --- documents and sections

export async function listDocs(): Promise<Doc[]> {
  const docs = (await (await db()).getAll('docs')) as Doc[];
  return docs.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getDoc(id: string): Promise<Doc | undefined> {
  return (await (await db()).get('docs', id)) as Doc | undefined;
}

export async function getSections(docId: string): Promise<Section[]> {
  const sections = (await (await db()).getAllFromIndex('sections', 'docId', docId)) as Section[];
  return sections.sort((a, b) => a.index - b.index);
}

export async function getAllSections(): Promise<Section[]> {
  return (await (await db()).getAll('sections')) as Section[];
}

export async function createDocument(doc: Doc, sections: Section[]): Promise<void> {
  await write(['docs', 'sections'], async (tx, now) => [
    ...put(tx, 'docs', doc, now),
    ...sections.flatMap((s) => put(tx, 'sections', s, now)),
  ]);
}

export async function putSection(section: Section): Promise<void> {
  await write(['sections'], async (tx, now) => put(tx, 'sections', section, now));
}

/** Saves several sections in one transaction. */
export async function putSections(sections: Section[]): Promise<void> {
  if (sections.length === 0) return;
  await write(['sections'], async (tx, now) => sections.flatMap((s) => put(tx, 'sections', s, now)));
}

/** Deletes a document with its sections, questions, cards, review history and reading positions. */
export async function deleteDocument(docId: string): Promise<void> {
  await write(['docs', 'sections', 'questions', 'cards', 'reviews', 'progress'], async (tx, now) => {
    const work = remove(tx, 'docs', docId, now);
    for (const name of ['sections', 'questions', 'cards', 'reviews', 'progress'] as const) {
      const ids = (await tx.objectStore(name).index('docId').getAllKeys(docId)) as string[];
      for (const id of ids) work.push(...remove(tx, name, id, now));
    }
    return work;
  });
  await (await db()).delete(SOURCES, docId);
}

// --- imported originals, for page previews

export async function saveSource(source: DocSource): Promise<void> {
  await (await db()).put(SOURCES, source);
}

export async function getSource(docId: string): Promise<DocSource | undefined> {
  return (await (await db()).get(SOURCES, docId)) as DocSource | undefined;
}

// --- reading position

export async function getProgress(sectionId: string): Promise<Progress | undefined> {
  return (await (await db()).get('progress', sectionId)) as Progress | undefined;
}

export async function getProgressForDoc(docId: string): Promise<Progress[]> {
  return (await (await db()).getAllFromIndex('progress', 'docId', docId)) as Progress[];
}

export async function saveProgress(progress: Progress): Promise<void> {
  await write(['progress'], async (tx, now) => put(tx, 'progress', progress, now));
}

// --- questions and cards

export async function getQuestions(sectionId: string): Promise<Question[]> {
  const questions = (await (await db()).getAllFromIndex('questions', 'sectionId', sectionId)) as Question[];
  return questions.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export async function getAllQuestions(): Promise<Question[]> {
  return (await (await db()).getAll('questions')) as Question[];
}

/** Saves a section's quiz, replacing any earlier questions and their cards. */
export async function replaceQuestions(sectionId: string, questions: Question[], cards: Card[]): Promise<void> {
  await write(['questions', 'cards'], async (tx, now) => {
    const work: Promise<unknown>[] = [];
    for (const name of ['questions', 'cards'] as const) {
      const ids = (await tx.objectStore(name).index('sectionId').getAllKeys(sectionId)) as string[];
      for (const id of ids) work.push(...remove(tx, name, id, now));
    }
    for (const q of questions) work.push(...put(tx, 'questions', q, now));
    for (const c of cards) work.push(...put(tx, 'cards', c, now));
    return work;
  });
}

export async function getAllCards(): Promise<Card[]> {
  return (await (await db()).getAll('cards')) as Card[];
}

/** Saves a card's new schedule and logs the review in one transaction. */
export async function saveReview(card: Card, log: ReviewLog): Promise<void> {
  await write(['cards', 'reviews'], async (tx, now) => [
    ...put(tx, 'cards', card, now),
    ...put(tx, 'reviews', log, now),
  ]);
}

export async function getReviewsSince(timestamp: number): Promise<ReviewLog[]> {
  return (await (await db()).getAllFromIndex('reviews', 'at', IDBKeyRange.lowerBound(timestamp))) as ReviewLog[];
}

// --- used by sync.ts

export async function getOutbox(limit: number): Promise<OutboxEntry[]> {
  return (await (await db()).getAll('outbox', undefined, limit)) as OutboxEntry[];
}

export async function countOutbox(): Promise<number> {
  return (await db()).count('outbox');
}

/** Turns queued changes into the records to send. */
export async function readOutboxRecords(entries: OutboxEntry[]): Promise<SyncRecord[]> {
  const database = await db();
  return Promise.all(
    entries.map(async (entry): Promise<SyncRecord> => {
      const data = entry.deleted ? undefined : ((await database.get(entry.store, entry.id)) as Stored | undefined);
      if (!data) return { store: entry.store, id: entry.id, updatedAt: entry.updatedAt, deleted: true };
      return { store: entry.store, id: entry.id, updatedAt: data.updatedAt ?? entry.updatedAt, data };
    }),
  );
}

/** Removes sent changes from the outbox, unless the record changed again in the meantime. */
export async function clearOutbox(entries: OutboxEntry[]): Promise<void> {
  const tx = (await db()).transaction('outbox', 'readwrite');
  for (const entry of entries) {
    const current = (await tx.store.get(entry.key)) as OutboxEntry | undefined;
    if (current && current.updatedAt === entry.updatedAt) await tx.store.delete(entry.key);
  }
  await tx.done;
}

/**
 * Applies records that came from the backend. A record is skipped when this
 * device already has the same or a newer version of it. Returns how many
 * records changed something here.
 */
export async function applyRemote(records: SyncRecord[]): Promise<number> {
  if (records.length === 0) return 0;
  const tx = (await db()).transaction(ALL_STORES, 'readwrite');
  let applied = 0;
  for (const record of records) {
    if (!DATA_STORES.includes(record.store)) continue;
    const pending = (await tx.objectStore('outbox').get(`${record.store}:${record.id}`)) as OutboxEntry | undefined;
    if (pending && pending.updatedAt >= record.updatedAt) continue;
    const store = tx.objectStore(record.store);
    const local = (await store.get(record.id)) as Stored | undefined;
    if (local && (local.updatedAt ?? 0) >= record.updatedAt) continue;

    if (record.deleted) {
      if (!local) continue;
      await store.delete(record.id);
    } else {
      await store.put({ ...(record.data as Stored), id: record.id, updatedAt: record.updatedAt });
    }
    // The remote version is newer than anything queued here for this record.
    if (pending) await tx.objectStore('outbox').delete(pending.key);
    applied++;
  }
  await tx.done;
  return applied;
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await (await db()).get('meta', key)) as T | undefined;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await (await db()).put('meta', value, key);
}

/** Test helper: closes the connection so the database can be reset. */
export async function closeDb(): Promise<void> {
  if (dbPromise) (await dbPromise).close();
  dbPromise = null;
}
