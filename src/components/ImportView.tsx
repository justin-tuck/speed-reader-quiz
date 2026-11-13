import { useState } from 'react';
import {
  ExtractError,
  extractFromPaste,
  extractFromPdfFile,
  extractFromUrl,
  type Extracted,
} from '../lib/extract';
import type { Settings } from '../types';
import { SectionEditor } from './SectionEditor';

type Tab = 'text' | 'pdf' | 'url';

interface Props {
  settings: Settings;
  onSaved: (docId: string) => void;
  onCancel: () => void;
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'text', label: 'Paste text' },
  { id: 'pdf', label: 'PDF' },
  { id: 'url', label: 'Web page' },
];

export function ImportView({ settings, onSaved, onCancel }: Props) {
  const [tab, setTab] = useState<Tab>('text');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [extracted, setExtracted] = useState<Extracted | null>(null);

  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);

  async function load(work: () => Promise<Extracted> | Extracted) {
    setBusy(true);
    setError('');
    try {
      setExtracted(await work());
    } catch (err) {
      setError(
        err instanceof ExtractError ? err.message : 'Something went wrong while loading that text. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (extracted) {
    return (
      <SectionEditor
        extracted={extracted}
        settings={settings}
        onSaved={onSaved}
        onBack={() => setExtracted(null)}
      />
    );
  }

  return (
    <section>
      <h1>Add a text</h1>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? 'tab active' : 'tab'}
            onClick={() => {
              setTab(t.id);
              setError('');
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'text' && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void load(() => extractFromPaste(pasteText, pasteTitle));
          }}
        >
          <label>
            Title <span className="muted">(optional)</span>
            <input type="text" value={pasteTitle} onChange={(e) => setPasteTitle(e.target.value)} />
          </label>
          <label>
            Text
            <textarea
              rows={12}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder="Paste the text you want to read. Leave a blank line between paragraphs."
            />
          </label>
          <div className="row">
            <button className="primary" type="submit" disabled={busy || !pasteText.trim()}>
              Split into sections
            </button>
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {tab === 'pdf' && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (file) void load(() => extractFromPdfFile(file));
          }}
        >
          <label>
            PDF file
            <input type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <p className="muted">The file is read in your browser and is not uploaded anywhere.</p>
          <div className="row">
            <button className="primary" type="submit" disabled={busy || !file}>
              {busy ? 'Reading PDF…' : 'Extract text'}
            </button>
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {tab === 'url' && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void load(() => extractFromUrl(url));
          }}
        >
          <label>
            Page address
            <input
              type="url"
              inputMode="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/article"
            />
          </label>
          <p className="muted">
            The app's server fetches the page and pulls out the article text. If that fails, copy the text from the
            page and use Paste text.
          </p>
          <div className="row">
            <button className="primary" type="submit" disabled={busy || !url.trim()}>
              {busy ? 'Fetching…' : 'Fetch page'}
            </button>
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {error && (
        <div className="notice error" role="alert">
          <p>{error}</p>
          {tab !== 'text' && (
            <button
              onClick={() => {
                setTab('text');
                setError('');
              }}
            >
              Paste the text instead
            </button>
          )}
        </div>
      )}
    </section>
  );
}
