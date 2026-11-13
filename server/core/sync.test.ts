import { describe, expect, it } from 'vitest';
import type { SyncRecord } from '../../shared/api.ts';
import { MemoryStore, SyncError, pull, push } from './sync.ts';

const rec = (id: string, updatedAt: number, data: object = { v: updatedAt }): SyncRecord => ({
  store: 'cards',
  id,
  updatedAt,
  data,
});

async function pullAll(store: MemoryStore, user: string, since: number, now: number) {
  const records: SyncRecord[] = [];
  let pageToken: string | undefined;
  let cursor = 0;
  do {
    const page = await pull(store, user, since, pageToken, now);
    if (!pageToken) cursor = page.cursor;
    records.push(...page.records);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return { records, cursor };
}

describe('sync', () => {
  it('returns pushed records to another device', async () => {
    const store = new MemoryStore();
    expect(await push(store, 'u', [rec('a', 100), rec('b', 100)], 1000)).toEqual({ accepted: 2 });
    const { records, cursor } = await pullAll(store, 'u', 0, 2000);
    expect(records.map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect(cursor).toBe(2000);
  });

  it('keeps the newest change when two devices edit the same record', async () => {
    const store = new MemoryStore();
    await push(store, 'u', [rec('a', 200, { from: 'phone' })], 1000);
    // The laptop's older edit arrives later and must not win.
    expect(await push(store, 'u', [rec('a', 150, { from: 'laptop' })], 2000)).toEqual({ accepted: 0 });
    expect((await pullAll(store, 'u', 0, 3000)).records[0].data).toEqual({ from: 'phone' });
    // A newer edit does win.
    await push(store, 'u', [rec('a', 300, { from: 'laptop' })], 4000);
    expect((await pullAll(store, 'u', 0, 5000)).records[0].data).toEqual({ from: 'laptop' });
  });

  it('passes deletions on and does not let an older edit undo them', async () => {
    const store = new MemoryStore();
    await push(store, 'u', [rec('a', 100)], 1000);
    await push(store, 'u', [{ store: 'cards', id: 'a', updatedAt: 200, deleted: true }], 2000);
    await push(store, 'u', [rec('a', 150)], 3000);
    expect((await pullAll(store, 'u', 0, 4000)).records).toEqual([
      { store: 'cards', id: 'a', updatedAt: 200, deleted: true },
    ]);
  });

  it('only returns what changed since the cursor', async () => {
    const store = new MemoryStore();
    await push(store, 'u', [rec('old', 100)], 10_000);
    const first = await pullAll(store, 'u', 0, 20_000);
    await push(store, 'u', [rec('new', 200)], 30_000);
    const second = await pullAll(store, 'u', first.cursor, 40_000);
    expect(second.records.map((r) => r.id)).toEqual(['new']);
  });

  it('looks back a few seconds so a write during the last pull is not missed', async () => {
    const store = new MemoryStore();
    await push(store, 'u', [rec('late', 100)], 19_000); // stamped just before the cursor
    const next = await pullAll(store, 'u', 20_000, 30_000);
    expect(next.records.map((r) => r.id)).toEqual(['late']);
  });

  it('pages through large pulls without losing or repeating records', async () => {
    const store = new MemoryStore();
    for (let batch = 0; batch < 5; batch++) {
      const records = Array.from({ length: 100 }, (_, i) => rec(`r${batch}-${i}`, 100));
      await push(store, 'u', records, 1000); // all with the same server time
    }
    const { records } = await pullAll(store, 'u', 0, 2000);
    expect(records).toHaveLength(500);
    expect(new Set(records.map((r) => r.id)).size).toBe(500);
  });

  it('keeps users apart', async () => {
    const store = new MemoryStore();
    await push(store, 'alice', [rec('a', 100)], 1000);
    expect((await pullAll(store, 'bob', 0, 2000)).records).toEqual([]);
  });

  it('limits how far ahead a device clock can claim to be', async () => {
    const store = new MemoryStore();
    await push(store, 'u', [rec('a', 9_999_999_999_999, { from: 'wrong clock' })], 1000);
    // Without the limit this record could never be changed again.
    expect(await push(store, 'u', [rec('a', 70_000, { from: 'later' })], 70_000)).toEqual({ accepted: 1 });
  });

  it('rejects malformed records', async () => {
    const store = new MemoryStore();
    const bad: unknown[] = [
      'nope',
      [{ store: 'secrets', id: 'a', updatedAt: 1, data: {} }],
      [{ store: 'cards', id: '', updatedAt: 1, data: {} }],
      [{ store: 'cards', id: 'a', updatedAt: 'now', data: {} }],
      [{ store: 'cards', id: 'a', updatedAt: 1 }],
      [{ store: 'cards', id: 'a', updatedAt: 1, data: { text: 'x'.repeat(400_000) } }],
      Array.from({ length: 101 }, (_, i) => rec(`r${i}`, 1)),
    ];
    for (const records of bad) await expect(push(store, 'u', records, 1000)).rejects.toBeInstanceOf(SyncError);
  });
});
