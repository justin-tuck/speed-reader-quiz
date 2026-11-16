/**
 * The original PDFs texts were imported from, kept by the backend so that
 * page previews survive the browser losing its copy and work in every
 * browser. Each file belongs to one user and one doc.
 */
import { MAX_PDF_BYTES } from '../../shared/api.ts';

/** Where originals are kept: files in .local-data locally. */
export interface OriginalStore {
  list(userId: string): Promise<string[]>;
  get(userId: string, docId: string): Promise<Uint8Array | null>;
  put(userId: string, docId: string, data: Uint8Array): Promise<void>;
  /** Does nothing when there is no such original. */
  delete(userId: string, docId: string): Promise<void>;
}

export class OriginalError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'OriginalError';
    this.status = status;
  }
}

/** Ids become file names, so only plain characters are allowed. Doc ids and user ids are UUIDs. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;

export function isSafeId(id: string): boolean {
  return SAFE_ID.test(id);
}

export function checkDocId(docId: string): void {
  if (!isSafeId(docId)) throw new OriginalError(400, 'That is not a valid text id.');
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

/** Checks an upload before it is stored: it must be a PDF of an importable size. */
export function checkPdf(data: Uint8Array | null | undefined): Uint8Array {
  if (!data || data.length === 0) throw new OriginalError(400, 'The upload was empty.');
  if (data.length > MAX_PDF_BYTES) throw new OriginalError(413, 'This PDF is larger than 100 MB.');
  if (!PDF_MAGIC.every((byte, i) => data[i] === byte)) throw new OriginalError(415, 'Only PDF files can be stored.');
  return data;
}

/** Keeps originals in memory. Used by the tests. */
export class MemoryOriginalStore implements OriginalStore {
  private readonly files = new Map<string, Uint8Array>();

  async list(userId: string): Promise<string[]> {
    const prefix = `${userId}/`;
    return [...this.files.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
  }

  async get(userId: string, docId: string): Promise<Uint8Array | null> {
    return this.files.get(`${userId}/${docId}`) ?? null;
  }

  async put(userId: string, docId: string, data: Uint8Array): Promise<void> {
    this.files.set(`${userId}/${docId}`, data);
  }

  async delete(userId: string, docId: string): Promise<void> {
    this.files.delete(`${userId}/${docId}`);
  }
}
