import { useMemo, useRef, useState } from 'react';
import type { Extracted } from '../lib/extract';
import { createPageLocator, mapSectionsToPages } from '../lib/pageMap';
import { planSections, type SkipReason } from '../lib/skip';
import { countWords, splitIntoSections, splitTextAt } from '../lib/splitter';
import { createDocument, newId, saveSource } from '../lib/storage';
import type { Doc, DocSource, Section, Settings } from '../types';
import { PagePreview } from './PagePreview';

interface Draft {
  key: string;
  title: string;
  text: string;
  /** Left out of the quiz. Starts as true for suggested sections. */
  skipped: boolean;
  /** Why skipping was suggested, if it was. */
  suggestion?: SkipReason;
}

interface Props {
  extracted: Extracted;
  settings: Settings;
  onSaved: (docId: string) => void;
  onBack: () => void;
}

function splitDrafts(text: string, minWords: number, maxWords: number): Draft[] {
  return splitIntoSections(text, { minWords, maxWords }).map((s) => ({
    key: newId(),
    title: s.title,
    text: s.text,
    skipped: false,
  }));
}

/**
 * The first split of an imported text. Suggested sections, such as a title
 * page or table of contents, start as skipped, which the editor shows and
 * the user can undo.
 */
function firstDrafts(extracted: Extracted, minWords: number, maxWords: number): Draft[] {
  return planSections(extracted.text, extracted.pages, { minWords, maxWords }).map((p) => ({
    key: newId(),
    title: p.title,
    text: p.text,
    skipped: !!p.suggestion,
    suggestion: p.suggestion,
  }));
}

function shortTitle(text: string): string {
  const words = text.split(/\s+/);
  return words.slice(0, 8).join(' ') + (words.length > 8 ? '…' : '');
}

export function SectionEditor({ extracted, settings, onSaved, onBack }: Props) {
  const [title, setTitle] = useState(extracted.title);
  const [minWords, setMinWords] = useState(settings.minWords);
  const [maxWords, setMaxWords] = useState(settings.maxWords);
  const [drafts, setDrafts] = useState<Draft[]>(() => firstDrafts(extracted, settings.minWords, settings.maxWords));
  // Page thumbnails while reviewing a PDF, drawn from the file before it is saved.
  const preview = useMemo(() => {
    const original = extracted.original;
    if (original?.kind !== 'pdf' || !extracted.pages) return null;
    const source: DocSource = { ...original, id: `import:${newId()}` };
    return { source, locate: createPageLocator(extracted.pages) };
  }, [extracted]);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const textareas = useRef(new Map<string, HTMLTextAreaElement>());

  const totalWords = drafts.reduce((sum, d) => sum + countWords(d.text), 0);
  const skippedCount = drafts.filter((d) => d.skipped).length;
  const suggestedCount = drafts.filter((d) => d.skipped && d.suggestion).length;
  const sizesValid = minWords >= 20 && maxWords >= minWords;

  function update(key: string, patch: Partial<Draft>) {
    setDrafts((list) => list.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  }

  function mergeWithNext(index: number) {
    setDrafts((list) => {
      const next = list[index + 1];
      if (!next) return list;
      // The merged section is skipped only if both halves were.
      const merged = {
        ...list[index],
        text: `${list[index].text}\n\n${next.text}`,
        skipped: list[index].skipped && next.skipped,
      };
      return [...list.slice(0, index), merged, ...list.slice(index + 2)];
    });
  }

  function splitAtCursor(index: number) {
    const draft = drafts[index];
    const cursor = textareas.current.get(draft.key)?.selectionStart ?? 0;
    const parts = splitTextAt(draft.text, cursor);
    if (!parts) {
      setError('Click inside the text where the new section should start, then choose Split at cursor.');
      return;
    }
    setError('');
    const second: Draft = { key: newId(), title: shortTitle(parts[1]), text: parts[1], skipped: draft.skipped };
    setDrafts((list) => [
      ...list.slice(0, index),
      { ...draft, text: parts[0] },
      second,
      ...list.slice(index + 1),
    ]);
  }

  function resplit() {
    // Skipped sections stay as they are; the text between them is split again.
    const next: Draft[] = [];
    let run: string[] = [];
    const flush = () => {
      if (run.length > 0) next.push(...splitDrafts(run.join('\n\n'), minWords, maxWords));
      run = [];
    };
    for (const draft of drafts) {
      if (draft.skipped) {
        flush();
        next.push(draft);
      } else run.push(draft.text);
    }
    flush();
    setDrafts(next);
    setOpenKey(null);
    setError('');
  }

  async function save() {
    const kept = drafts.filter((d) => d.text.trim());
    if (kept.length === 0) {
      setError('There is no text to save.');
      return;
    }
    setSaving(true);
    try {
      const doc: Doc = {
        id: newId(),
        title: title.trim() || 'Untitled',
        source: extracted.source,
        sourceRef: extracted.sourceRef,
        createdAt: Date.now(),
      };
      const pageStarts = extracted.pages
        ? mapSectionsToPages(
            extracted.pages,
            kept.map((d) => d.text.trim()),
          )
        : [];
      const sections: Section[] = kept.map((d, index) => ({
        id: newId(),
        docId: doc.id,
        index,
        title: d.title.trim() || `Section ${index + 1}`,
        text: d.text.trim(),
        wordCount: countWords(d.text),
        // Saved as false too when a suggestion was turned down, so it is not suggested again.
        ...((d.skipped || d.suggestion) && { skipped: d.skipped }),
        ...(pageStarts[index] && { pageStarts: pageStarts[index] }),
      }));
      await createDocument(doc, sections);
      // The original is only for page previews; the text is usable without it.
      if (extracted.original) await saveSource({ ...extracted.original, id: doc.id }).catch(() => {});
      onSaved(doc.id);
    } catch {
      setError('The text could not be saved. Your browser may be out of storage space or blocking storage.');
      setSaving(false);
    }
  }

  return (
    <section>
      <h1>Review sections</h1>
      <p className="muted">
        {drafts.length} {drafts.length === 1 ? 'section' : 'sections'}, {totalWords.toLocaleString()} words
        {skippedCount > 0 && `, ${skippedCount} skipped in the quiz`}. Adjust them here before you start reading.
      </p>
      {suggestedCount > 0 && (
        <p className="notice info">
          {suggestedCount === 1 ? 'One section looks' : `${suggestedCount} sections look`} like front matter (a
          title, copyright or contents page) or a list of references, and {suggestedCount === 1 ? 'is' : 'are'} marked{' '}
          <strong>Skipped</strong> below. Skipped sections
          can still be read but get no quiz. Choose <strong>Include in quiz</strong> on a section to change that.
        </p>
      )}

      <div className="stack">
        <label>
          Title
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div className="row wrap end">
          <label className="narrow">
            Min words
            <input type="number" min={20} step={10} value={minWords} onChange={(e) => setMinWords(Number(e.target.value))} />
          </label>
          <label className="narrow">
            Max words
            <input type="number" min={20} step={10} value={maxWords} onChange={(e) => setMaxWords(Number(e.target.value))} />
          </label>
          <button onClick={resplit} disabled={!sizesValid} title="Splits all the text again with these sizes">
            Re-split all
          </button>
        </div>
        {!sizesValid && <p className="error-text">Max words must be at least as large as min words (20 or more).</p>}
      </div>

      <ol className="section-list">
        {drafts.map((draft, index) => {
          const words = countWords(draft.text);
          const open = openKey === draft.key;
          const sizeNote = words > maxWords * 1.25 ? 'long' : words < minWords / 2 ? 'short' : '';
          const page = preview?.locate(draft.text);
          return (
            <li key={draft.key} className={draft.skipped ? 'card skipped with-thumb' : 'card with-thumb'}>
              {preview &&
                (page ? (
                  <PagePreview
                    doc={{ id: 'import', title: title || extracted.title, source: extracted.source, createdAt: 0 }}
                    section={{
                      id: draft.key,
                      docId: 'import',
                      index,
                      title: draft.title,
                      text: draft.text,
                      wordCount: words,
                      pageStarts: [{ page, word: 0 }],
                    }}
                    sectionCount={drafts.length}
                    source={preview.source}
                    size="small"
                    lazy
                  />
                ) : (
                  // The opening of the text was edited, so it no longer matches a page.
                  <span className="thumb small">
                    <span className="thumb-page placeholder static">No matching page</span>
                  </span>
                ))}
              <div className="grow">
                <div className="row between">
                  <strong>
                    {index + 1}. {draft.title || `Section ${index + 1}`}
                  </strong>
                  <span className="row">
                    {draft.skipped && <span className="badge skip">Skipped · no quiz</span>}
                    <span className={sizeNote && !draft.skipped ? 'badge warn' : 'badge'}>
                      {words} words{sizeNote && !draft.skipped && ` · ${sizeNote}`}
                    </span>
                  </span>
                </div>
                {draft.suggestion && (
                  <p className="muted">
                    {draft.skipped ? 'Skipped because it looks' : 'Looks'} like a {draft.suggestion}.
                  </p>
                )}

                {open ? (
                  <div className="stack">
                    <label>
                      Section title
                      <input type="text" value={draft.title} onChange={(e) => update(draft.key, { title: e.target.value })} />
                    </label>
                    <label>
                      Text
                      <textarea
                        rows={10}
                        value={draft.text}
                        ref={(el) => {
                          if (el) textareas.current.set(draft.key, el);
                          else textareas.current.delete(draft.key);
                        }}
                        onChange={(e) => update(draft.key, { text: e.target.value })}
                      />
                    </label>
                  </div>
                ) : (
                  <p className="preview">{draft.text.slice(0, 220)}{draft.text.length > 220 && '…'}</p>
                )}

                <div className="row wrap">
                  <button onClick={() => setOpenKey(open ? null : draft.key)}>{open ? 'Done' : 'Edit'}</button>
                  {open && <button onClick={() => splitAtCursor(index)}>Split at cursor</button>}
                  {index < drafts.length - 1 && <button onClick={() => mergeWithNext(index)}>Merge with next</button>}
                  <button aria-pressed={draft.skipped} onClick={() => update(draft.key, { skipped: !draft.skipped })}>
                    {draft.skipped ? 'Include in quiz' : 'Skip in quiz'}
                  </button>
                  {drafts.length > 1 && (
                    <button className="danger" onClick={() => setDrafts((list) => list.filter((d) => d.key !== draft.key))}>
                      Remove
                    </button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}

      <div className="row sticky-actions">
        <button className="primary" onClick={() => void save()} disabled={saving || drafts.length === 0}>
          {saving ? 'Saving…' : 'Save and start reading'}
        </button>
        <button onClick={onBack}>Back</button>
      </div>
    </section>
  );
}
