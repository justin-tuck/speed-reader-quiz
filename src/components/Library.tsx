import { useCallback, useEffect, useState } from 'react';
import { deleteDocument, getSections, listDocs } from '../lib/storage';
import type { Doc } from '../types';

interface Item {
  doc: Doc;
  sections: number;
  read: number;
  words: number;
}

interface Props {
  /** Changes when another device's changes arrive, to reload the list. */
  dataVersion: number;
  onOpen: (docId: string) => void;
  onAdd: () => void;
}

const SOURCE_LABEL = { pdf: 'PDF', url: 'Web page', text: 'Pasted text' } as const;

export function Library({ dataVersion, onOpen, onAdd }: Props) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const docs = await listDocs();
      const loaded = await Promise.all(
        docs.map(async (doc) => {
          const sections = await getSections(doc.id);
          return {
            doc,
            sections: sections.length,
            read: sections.filter((s) => s.readAt).length,
            words: sections.reduce((sum, s) => sum + s.wordCount, 0),
          };
        }),
      );
      setItems(loaded);
    } catch {
      setError('Your saved texts could not be loaded. Check that the browser allows this site to store data.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, dataVersion]);

  async function remove(item: Item) {
    const ok = window.confirm(
      `Delete "${item.doc.title}"? This also deletes its quiz questions, flashcards and review history.`,
    );
    if (!ok) return;
    await deleteDocument(item.doc.id);
    await load();
  }

  return (
    <section>
      <div className="row between">
        <h1>Library</h1>
        <button className="primary" onClick={onAdd}>
          Add a text
        </button>
      </div>

      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {items === null && !error && <p className="muted">Loading…</p>}
      {items?.length === 0 && (
        <div className="card empty">
          <p>Nothing here yet. Add a PDF, a web page or pasted text to start reading.</p>
        </div>
      )}

      <ul className="plain-list">
        {items?.map((item) => (
          <li key={item.doc.id} className="card">
            <div className="row between">
              <strong>{item.doc.title}</strong>
              <span className="badge">
                {item.read} of {item.sections} read
              </span>
            </div>
            <p className="muted">
              {SOURCE_LABEL[item.doc.source]} · {item.words.toLocaleString()} words ·{' '}
              {new Date(item.doc.createdAt).toLocaleDateString()}
            </p>
            <div className="row">
              <button className="primary" onClick={() => onOpen(item.doc.id)}>
                Open
              </button>
              <button className="danger" onClick={() => void remove(item)}>
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
