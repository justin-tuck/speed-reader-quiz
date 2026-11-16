/**
 * Keeps original PDFs on the backend as well as in this browser. A browser's
 * copy is easily lost: each address the app is opened at (another port,
 * another browser) has its own storage, and browsers may clear storage when
 * the disk fills up. Synced texts come back from the backend in those cases,
 * and with this, so do their PDFs.
 *
 * The local backend keeps them in .local-data/originals/. A backend that
 * does not keep originals answers 501, and the app then keeps them in the
 * browser only, as before.
 */
import type { OriginalsListResponse } from '../../shared/api';
import type { DocSource, SourceOriginal } from '../types';
import { apiFetch, readError } from './api';
import { getDoc, getSource, listSourceIds, saveSource } from './storage';
import { getSyncStatus, subscribeSyncStatus } from './sync';

/** Whether the backend keeps originals; `null` until it has been asked. */
let serverKeeps: boolean | null = null;
/** Docs whose original needs no upload from here: the backend has it, or it is not a PDF of an existing text. */
const settled = new Set<string>();
const downloads = new Map<string, Promise<DocSource | undefined>>();

const originalPath = (docId: string) => `/api/originals/${encodeURIComponent(docId)}`;

/** Asks the backend which PDFs it has. Returns false when it does not keep originals. */
async function listRemote(): Promise<boolean> {
  const response = await apiFetch('/api/originals');
  if (response.status === 501) return (serverKeeps = false);
  if (!response.ok) throw await readError(response);
  const { ids } = (await response.json()) as OriginalsListResponse;
  ids.forEach((id) => settled.add(id));
  return (serverKeeps = true);
}

async function upload(docId: string, file: Blob): Promise<void> {
  const response = await apiFetch(originalPath(docId), {
    method: 'PUT',
    headers: { 'content-type': 'application/pdf' },
    body: file,
  });
  if (response.status === 501) {
    serverKeeps = false;
    return;
  }
  if (!response.ok) throw await readError(response);
  settled.add(docId);
}

async function download(docId: string): Promise<Blob | null> {
  const response = await apiFetch(originalPath(docId));
  if (response.status === 501) {
    serverKeeps = false;
    return null;
  }
  if (response.status === 404) return null;
  if (!response.ok) throw await readError(response);
  serverKeeps = true;
  settled.add(docId);
  return new Blob([await response.arrayBuffer()], { type: 'application/pdf' });
}

/**
 * Stores the original a text was imported from in this browser and, for a
 * PDF, on the backend. The upload runs in the background; if it fails, the
 * next backup after a sync tries again.
 */
export async function keepOriginal(docId: string, original: SourceOriginal): Promise<void> {
  await saveSource({ ...original, id: docId });
  if (original.kind !== 'pdf' || serverKeeps === false) return;
  void (async () => {
    if (serverKeeps ?? (await listRemote())) await upload(docId, original.file);
  })().catch(() => {});
}

/**
 * The original a text was imported from: this browser's copy, or else the
 * backend's copy of the PDF, which is then kept in this browser as well.
 * `undefined` when neither has it.
 */
export async function loadSource(docId: string): Promise<DocSource | undefined> {
  const local = await getSource(docId);
  if (local || serverKeeps === false) return local;
  if ((await getDoc(docId))?.source !== 'pdf') return undefined;

  let pending = downloads.get(docId);
  if (!pending) {
    pending = (async () => {
      const file = await download(docId);
      if (!file) return undefined;
      const source: DocSource = { id: docId, kind: 'pdf', file };
      // Shown even if this browser cannot keep it; it is downloaded again next time.
      await saveSource(source).catch(() => {});
      return source;
    })().finally(() => downloads.delete(docId));
    downloads.set(docId, pending);
  }
  return pending;
}

let backingUp: Promise<void> | null = null;

/**
 * Uploads the PDFs this browser has and the backend does not: ones imported
 * before the backend kept originals, or whose upload failed.
 */
export function backupOriginals(): Promise<void> {
  backingUp ??= (async () => {
    if (serverKeeps === false) return;
    const unsettled = (await listSourceIds()).filter((id) => !settled.has(id));
    if (unsettled.length === 0 || !(await listRemote())) return;
    for (const id of unsettled) {
      if (settled.has(id)) continue;
      const [source, doc] = await Promise.all([getSource(id), getDoc(id)]);
      if (source?.kind === 'pdf' && doc) await upload(id, source.file);
      else settled.add(id);
    }
  })()
    .catch(() => {})
    .finally(() => {
      backingUp = null;
    });
  return backingUp;
}

/** Backs up originals after each successful sync. Returns a function that stops it. */
export function startOriginalBackup(): () => void {
  let syncing = getSyncStatus().state === 'syncing';
  return subscribeSyncStatus(() => {
    const { state } = getSyncStatus();
    if (syncing && state === 'idle') void backupOriginals();
    syncing = state === 'syncing';
  });
}

/** Test helper: forgets what is known about the backend. */
export function resetOriginalsState(): void {
  serverKeeps = null;
  settled.clear();
  downloads.clear();
}
