/**
 * Sync between devices. Each device pushes the records it changed and pulls
 * what changed elsewhere. When two devices change the same record, the one
 * with the later `updatedAt` wins. Deletions are kept as "deleted" markers so
 * they reach every device.
 */
import {
  MAX_PUSH_RECORDS,
  SYNC_STORES,
  type PullResponse,
  type PushResponse,
  type SyncRecord,
  type SyncStore,
} from '../../shared/api.ts';

/** Where records are kept: a file locally, DynamoDB in AWS. */
export interface RecordStore {
  /** Saves the record unless a newer one is already stored. `version` is the server time of the write. */
  putIfNewer(userId: string, record: SyncRecord, version: number): Promise<boolean>;
  /** Records written after `sinceVersion`, oldest first. */
  listSince(
    userId: string,
    sinceVersion: number,
    limit: number,
    pageToken?: string,
  ): Promise<{ records: SyncRecord[]; nextPageToken?: string }>;
}

export class SyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncError';
  }
}

/** DynamoDB items are limited to 400 KB. */
const MAX_RECORD_BYTES = 300_000;
const PAGE_SIZE = 200;
/**
 * Pulls look back this far past the cursor. Writes are stamped with the
 * server clock, and this covers writes that were in flight during the last
 * pull. Seeing a record twice is harmless.
 */
const OVERLAP_MS = 5_000;
/** A device whose clock runs ahead must not win every conflict from then on. */
const MAX_CLOCK_SKEW_MS = 60_000;

function validate(raw: unknown, now: number): SyncRecord {
  const r = raw as Partial<SyncRecord> | null;
  if (!r || typeof r !== 'object') throw new SyncError('A record was not an object.');
  if (!SYNC_STORES.includes(r.store as SyncStore)) throw new SyncError('A record had an unknown type.');
  if (typeof r.id !== 'string' || r.id.length === 0 || r.id.length > 100) {
    throw new SyncError('A record had an invalid id.');
  }
  if (typeof r.updatedAt !== 'number' || !Number.isFinite(r.updatedAt) || r.updatedAt < 0) {
    throw new SyncError('A record had an invalid timestamp.');
  }
  const updatedAt = Math.min(r.updatedAt, now + MAX_CLOCK_SKEW_MS);
  if (r.deleted === true) return { store: r.store as SyncStore, id: r.id, updatedAt, deleted: true };
  if (!r.data || typeof r.data !== 'object') throw new SyncError('A record had no data.');
  if (JSON.stringify(r.data).length > MAX_RECORD_BYTES) {
    throw new SyncError('A record is too large to sync. Split very long sections into smaller ones.');
  }
  return { store: r.store as SyncStore, id: r.id, updatedAt, data: r.data };
}

export async function push(
  store: RecordStore,
  userId: string,
  records: unknown,
  now: number,
): Promise<PushResponse> {
  if (!Array.isArray(records)) throw new SyncError('Expected a list of records.');
  if (records.length > MAX_PUSH_RECORDS) throw new SyncError('Too many records in one request.');
  const clean = records.map((r) => validate(r, now));
  const results = await Promise.all(clean.map((r) => store.putIfNewer(userId, r, now)));
  return { accepted: results.filter(Boolean).length };
}

export async function pull(
  store: RecordStore,
  userId: string,
  since: unknown,
  pageToken: unknown,
  now: number,
): Promise<PullResponse> {
  const from = typeof since === 'number' && Number.isFinite(since) && since > 0 ? since : 0;
  const token = typeof pageToken === 'string' && pageToken ? pageToken : undefined;
  const page = await store.listSince(userId, Math.max(0, from - OVERLAP_MS), PAGE_SIZE, token);
  return { ...page, cursor: now };
}

/** Keeps records in memory. Used by the tests and as the base of the local file store. */
export class MemoryStore implements RecordStore {
  protected users = new Map<string, Map<string, SyncRecord & { version: number }>>();

  async putIfNewer(userId: string, record: SyncRecord, version: number): Promise<boolean> {
    let records = this.users.get(userId);
    if (!records) this.users.set(userId, (records = new Map()));
    const key = `${record.store}#${record.id}`;
    const existing = records.get(key);
    if (existing && existing.updatedAt >= record.updatedAt) return false;
    records.set(key, { ...record, version });
    return true;
  }

  async listSince(userId: string, sinceVersion: number, limit: number, pageToken?: string) {
    const all = [...(this.users.get(userId)?.values() ?? [])]
      .filter((r) => r.version > sinceVersion)
      .sort((a, b) => a.version - b.version || a.id.localeCompare(b.id));
    const start = pageToken ? Number(pageToken) || 0 : 0;
    const records = all.slice(start, start + limit).map(({ version: _version, ...record }) => record);
    const next = start + limit < all.length ? String(start + limit) : undefined;
    return { records, nextPageToken: next };
  }
}
