import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileOriginalStore } from './fileOriginals.ts';

let dir: string;
const pdf = new TextEncoder().encode('%PDF-1.7 a small file');

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'srq-originals-'));
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

describe('FileOriginalStore', () => {
  it('keeps PDFs as files per user, and survives being created again', async () => {
    await new FileOriginalStore(dir).put('local', 'd1', pdf);
    expect(fs.existsSync(path.join(dir, 'local', 'd1.pdf'))).toBe(true);

    const again = new FileOriginalStore(dir);
    expect(await again.list('local')).toEqual(['d1']);
    expect(new Uint8Array((await again.get('local', 'd1'))!)).toEqual(pdf);
    expect(await again.get('local', 'missing')).toBeNull();
    expect(await again.list('someone-else')).toEqual([]);
  });

  it('replaces a PDF and leaves no temporary files', async () => {
    const store = new FileOriginalStore(dir);
    await store.put('local', 'd1', pdf);
    await store.put('local', 'd1', new TextEncoder().encode('%PDF-2.0 newer'));
    expect(new TextDecoder().decode((await store.get('local', 'd1'))!)).toBe('%PDF-2.0 newer');
    expect(await fs.promises.readdir(path.join(dir, 'local'))).toEqual(['d1.pdf']);
  });

  it('deletes a PDF, and deleting a missing one is fine', async () => {
    const store = new FileOriginalStore(dir);
    await store.put('local', 'd1', pdf);
    await store.delete('local', 'd1');
    await store.delete('local', 'd1');
    expect(await store.list('local')).toEqual([]);
  });

  it('never turns an unsafe id into a path', async () => {
    const store = new FileOriginalStore(dir);
    await expect(store.put('local', '../escape', pdf)).rejects.toThrow();
    await expect(store.put('..', 'd1', pdf)).rejects.toThrow();
    await expect(store.get('local', '..\sync')).rejects.toThrow();
    expect(fs.existsSync(path.join(dir, 'escape.pdf'))).toBe(false);
  });
});
