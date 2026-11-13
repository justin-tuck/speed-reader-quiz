import fs from 'node:fs';
import path from 'node:path';
import type { SyncRecord } from '../../shared/api.ts';
import { MemoryStore } from '../core/sync.ts';

type Saved = Record<string, (SyncRecord & { version: number })[]>;

/**
 * Local stand-in for the cloud database: keeps everything in memory and
 * writes it to one JSON file, so data survives restarting the dev server.
 */
export class FileStore extends MemoryStore {
  private readonly file: string;
  private writing: Promise<void> = Promise.resolve();

  constructor(file: string) {
    super();
    this.file = file;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Saved;
      for (const [userId, records] of Object.entries(saved)) {
        this.users.set(userId, new Map(records.map((r) => [`${r.store}#${r.id}`, r])));
      }
    } catch {
      // No file yet, or it is unreadable: start empty.
    }
  }

  override async putIfNewer(userId: string, record: SyncRecord, version: number): Promise<boolean> {
    const changed = await super.putIfNewer(userId, record, version);
    if (changed) await this.save();
    return changed;
  }

  private save(): Promise<void> {
    // Writes are queued so two requests never write the file at once.
    this.writing = this.writing
      .then(async () => {
        const data: Saved = {};
        for (const [userId, records] of this.users) data[userId] = [...records.values()];
        await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
        await fs.promises.writeFile(this.file, JSON.stringify(data));
      })
      .catch((err) => console.error('Could not save local sync data', err));
    return this.writing;
  }
}
