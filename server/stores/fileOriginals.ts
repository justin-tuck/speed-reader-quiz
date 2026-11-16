import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isSafeId, type OriginalStore } from '../core/originals.ts';

const EXT = '.pdf';

/**
 * Keeps original PDFs as files on this machine:
 *   <dir>/<user id>/<doc id>.pdf
 * The router checks doc ids before they get here; they are checked again
 * because they become file names.
 */
export class FileOriginalStore implements OriginalStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private file(userId: string, docId: string): string {
    if (!isSafeId(userId) || !isSafeId(docId)) throw new Error('Unsafe id for a file name');
    return path.join(this.dir, userId, docId + EXT);
  }

  async list(userId: string): Promise<string[]> {
    if (!isSafeId(userId)) return [];
    try {
      const names = await fs.promises.readdir(path.join(this.dir, userId));
      return names.filter((name) => name.endsWith(EXT)).map((name) => name.slice(0, -EXT.length));
    } catch {
      return [];
    }
  }

  async get(userId: string, docId: string): Promise<Uint8Array | null> {
    try {
      return await fs.promises.readFile(this.file(userId, docId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async put(userId: string, docId: string, data: Uint8Array): Promise<void> {
    const target = this.file(userId, docId);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    // Written to a temporary file first, so a failed write never leaves half a PDF.
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(temp, data);
      await fs.promises.rename(temp, target);
    } catch (err) {
      await fs.promises.rm(temp, { force: true });
      throw err;
    }
  }

  async delete(userId: string, docId: string): Promise<void> {
    await fs.promises.rm(this.file(userId, docId), { force: true });
  }
}
