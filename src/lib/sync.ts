/**
 * Keeps this device's data in step with the backend: sends local changes,
 * then fetches what changed on other devices. The rules for which copy of a
 * record wins are in storage.applyRemote and server/core/sync.ts.
 */
import type { PullRequest, PullResponse, PushRequest, PushResponse } from '../../shared/api';
import { ApiError, apiPost } from './api';
import {
  applyRemote,
  clearOutbox,
  countOutbox,
  getMeta,
  getOutbox,
  onLocalChange,
  readOutboxRecords,
  setMeta,
} from './storage';

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'offline' | 'error';
  /** When the last successful sync finished. */
  lastSyncedAt: number | null;
  /** Local changes not yet sent. */
  pending: number;
  message?: string;
}

const PUSH_BATCH = 50;
const CURSOR_KEY = 'syncCursor';
const LOCAL_CHANGE_DELAY_MS = 1500;
const INTERVAL_MS = 60_000;

let status: SyncStatus = { state: 'idle', lastSyncedAt: null, pending: 0 };
const statusListeners = new Set<() => void>();
const remoteListeners = new Set<() => void>();

function setStatus(patch: Partial<SyncStatus>) {
  status = { ...status, ...patch };
  statusListeners.forEach((l) => l());
}

export const getSyncStatus = (): SyncStatus => status;

export function subscribeSyncStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

/** Calls `listener` when a sync brought in changes made on another device. */
export function onRemoteChange(listener: () => void): () => void {
  remoteListeners.add(listener);
  return () => remoteListeners.delete(listener);
}

async function pushAll(): Promise<void> {
  for (;;) {
    const entries = await getOutbox(PUSH_BATCH);
    if (entries.length === 0) return;
    const records = await readOutboxRecords(entries);
    await apiPost<PushResponse>('/api/sync/push', { records } satisfies PushRequest);
    await clearOutbox(entries);
  }
}

async function pullAll(): Promise<number> {
  const since = (await getMeta<number>(CURSOR_KEY)) ?? 0;
  let applied = 0;
  let pageToken: string | undefined;
  let cursor: number | null = null;
  do {
    const page = await apiPost<PullResponse>('/api/sync/pull', { since, pageToken } satisfies PullRequest);
    // The cursor from the first page marks where the next sync starts.
    cursor ??= page.cursor;
    applied += await applyRemote(page.records);
    pageToken = page.nextPageToken;
  } while (pageToken);
  if (cursor !== null) await setMeta(CURSOR_KEY, cursor);
  return applied;
}

let running: Promise<void> | null = null;
let runAgain = false;

/** Runs one sync. If one is already running, another starts right after it. */
export function syncNow(): Promise<void> {
  if (running) {
    runAgain = true;
    return running;
  }
  running = (async () => {
    do {
      runAgain = false;
      setStatus({ state: 'syncing', message: undefined });
      try {
        await pushAll();
        const applied = await pullAll();
        setStatus({ state: 'idle', lastSyncedAt: Date.now(), pending: await countOutbox() });
        if (applied > 0) remoteListeners.forEach((l) => l());
      } catch (err) {
        const pending = await countOutbox().catch(() => status.pending);
        if (err instanceof ApiError && err.status === 0) {
          setStatus({ state: 'offline', pending, message: 'Offline. Changes are saved on this device and will sync later.' });
        } else {
          const message = err instanceof ApiError ? err.message : 'Sync failed unexpectedly.';
          setStatus({ state: 'error', pending, message });
        }
        return;
      }
    } while (runAgain);
  })().finally(() => {
    running = null;
  });
  return running;
}

/** Starts background syncing. Returns a function that stops it. */
export function startSync(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const soon = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void syncNow(), LOCAL_CHANGE_DELAY_MS);
  };
  const whenVisible = () => {
    if (document.visibilityState === 'visible') void syncNow();
  };

  const stopListening = onLocalChange(() => {
    setStatus({ pending: status.pending + 1 });
    soon();
  });
  const interval = setInterval(whenVisible, INTERVAL_MS);
  document.addEventListener('visibilitychange', whenVisible);
  window.addEventListener('online', whenVisible);
  void syncNow();

  return () => {
    stopListening();
    if (timer) clearTimeout(timer);
    clearInterval(interval);
    document.removeEventListener('visibilitychange', whenVisible);
    window.removeEventListener('online', whenVisible);
  };
}
