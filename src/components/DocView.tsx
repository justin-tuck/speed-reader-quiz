import { useEffect, useMemo, useRef, useState } from 'react';
import { ExtractError } from '../lib/extract';
import { attachPdfFile, refetchPage } from '../lib/previews';
import { suggestSkip, type SkipReason } from '../lib/skip';
import { getDoc, getProgressForDoc, getSections, putSections } from '../lib/storage';
import type { Doc, Section } from '../types';
import { PagePreview, useDocSource } from './PagePreview';

interface Props {
  docId: string;
  /** Changes when another device's changes arrive, to reload the list. */
  dataVersion: number;
  onRead: (sectionIndex: number) => void;
  onBack: () => void;
}

/** How many suggested sections are named in the notice before "and N more". */
const NAMED_SUGGESTIONS = 6;

function status(section: Section): { label: string; tone: string } {
  if (section.skipped) return { label: 'Skipped · no quiz', tone: 'skip' };
  if (section.lastScore) {
    const { correct, total } = section.lastScore;
    return { label: `Quiz ${correct}/${total}`, tone: correct === total ? 'good' : 'warn' };
  }
  if (section.readAt) return { label: 'Read', tone: '' };
  return { label: 'Not read', tone: 'quiet' };
}

export function DocView({ docId, dataVersion, onRead, onBack }: Props) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [sections, setSections] = useState<Section[] | null>(null);
  const [missing, setMissing] = useState(false);
  /** Section id → share of the section already read, for sections stopped part-way. */
  const [paused, setPaused] = useState<Map<string, number>>(new Map());
  /** Bumped after the original is added, to load the sections and the original again. */
  const [version, setVersion] = useState(0);
  const source = useDocSource(docId, version);
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const attachNotice = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([getDoc(docId), getSections(docId), getProgressForDoc(docId)])
      .then(([d, s, progress]) => {
        if (cancelled) return;
        if (!d) setMissing(true);
        else {
          setDoc(d);
          setSections(s);
          setPaused(new Map(progress.filter((p) => p.index > 0 && p.total > 0).map((p) => [p.id, p.index / p.total])));
        }
      })
      .catch(() => !cancelled && setMissing(true));
    return () => {
      cancelled = true;
    };
  }, [docId, dataVersion, version]);

  // Front matter to suggest skipping, for sections nobody has decided about yet.
  // Texts imported before skipping existed get their suggestions here.
  const suggestions = useMemo(() => {
    const list = sections ?? [];
    return new Map(
      list.flatMap((s): [string, SkipReason][] => {
        if (s.skipped !== undefined) return [];
        const reason = suggestSkip(s.text, s.index, list.length);
        return reason ? [[s.id, reason]] : [];
      }),
    );
  }, [sections]);

  if (missing) {
    return (
      <section>
        <p className="notice error">This text could not be found.</p>
        <button onClick={onBack}>Back to library</button>
      </section>
    );
  }
  if (!doc || !sections) return <p className="muted">Loading…</p>;

  // Prefer a section stopped part-way, then the first unread one. Skipped sections are passed over.
  const included = sections.filter((s) => !s.skipped);
  const resume = included.find((s) => paused.has(s.id));
  const next = resume ?? included.find((s) => !s.readAt);
  const first = included[0] ?? sections[0];
  const skippedCount = sections.length - included.length;
  const suggested = sections.filter((s) => suggestions.has(s.id));

  function save(updated: Section[]) {
    const byId = new Map(updated.map((s) => [s.id, s]));
    setSections((list) => list?.map((s) => byId.get(s.id) ?? s) ?? null);
    void putSections(updated);
  }

  async function addOriginal(work: () => Promise<void>) {
    setAttaching(true);
    setAttachError('');
    try {
      await work();
      setVersion((v) => v + 1);
    } catch (err) {
      setAttachError(err instanceof ExtractError ? err.message : 'The original could not be added. Please try again.');
      // The message is in the notice at the top, which may be scrolled out of view.
      attachNotice.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } finally {
      setAttaching(false);
    }
  }

  /** A PDF text whose file is not in this browser: each row offers to add it, where its thumbnail would be. */
  const needsPdf = source === null && doc.source === 'pdf';

  return (
    <section>
      <button className="link" onClick={onBack}>
        ← Library
      </button>
      <h1>{doc.title}</h1>
      {doc.sourceRef && <p className="muted source">{doc.sourceRef}</p>}

      {sections.length > 0 && (
        <button className="primary" onClick={() => onRead((next ?? first).index)}>
          {resume
            ? `Resume section ${resume.index + 1}`
            : next
              ? next === first
                ? 'Start reading'
                : `Continue with section ${next.index + 1}`
              : 'Read again from the start'}
        </button>
      )}

      {suggested.length > 0 && (
        <div className="notice info">
          <p className="notice-lead">
            {suggested.length === 1 ? 'This section looks' : `These ${suggested.length} sections look`} like front
            matter or a list of references, which is usually not worth a quiz:
          </p>
          <ul className="suggest-list">
            {suggested.slice(0, NAMED_SUGGESTIONS).map((s) => (
              <li key={s.id}>
                {s.index + 1}. {s.title} <span className="muted">· {suggestions.get(s.id)}</span>
              </li>
            ))}
            {suggested.length > NAMED_SUGGESTIONS && (
              <li className="muted">and {suggested.length - NAMED_SUGGESTIONS} more, marked below</li>
            )}
          </ul>
          <div className="row wrap">
            <button className="primary" onClick={() => save(suggested.map((s) => ({ ...s, skipped: true })))}>
              {suggested.length === 1 ? 'Skip it' : `Skip these ${suggested.length}`}
            </button>
            <button onClick={() => save(suggested.map((s) => ({ ...s, skipped: false })))}>
              Keep {suggested.length === 1 ? 'it' : 'them'} in the quiz
            </button>
          </div>
        </div>
      )}

      {needsPdf && (
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void addOriginal(() => attachPdfFile(doc, file));
          }}
        />
      )}

      {source === null && (doc.source === 'pdf' || doc.source === 'url') && (
        <div className="notice info" ref={attachNotice}>
          <p className="notice-lead">
            Page previews need the original {doc.source === 'pdf' ? 'PDF' : 'web page'} in this browser. This text was
            imported before previews existed, or in another browser.
          </p>
          <div className="row wrap">
            {doc.source === 'pdf' ? (
              <button onClick={() => fileInput.current?.click()} disabled={attaching}>
                {attaching ? 'Reading the PDF…' : 'Choose the PDF'}
              </button>
            ) : (
              <button onClick={() => void addOriginal(() => refetchPage(doc))} disabled={attaching}>
                {attaching ? 'Fetching…' : 'Fetch the page again'}
              </button>
            )}
          </div>
          {attachError && (
            <p className="error-text" role="alert">
              {attachError}
            </p>
          )}
        </div>
      )}

      {skippedCount > 0 && (
        <p className="muted">
          {skippedCount} of {sections.length} sections {skippedCount === 1 ? 'is' : 'are'} skipped: you can read them,
          but they get no quiz and their flashcards are left out of Study.
        </p>
      )}

      <ol className="section-list">
        {sections.map((s) => {
          const st = status(s);
          const reason = suggestions.get(s.id);
          return (
            <li key={s.id} className={s.skipped ? 'card skipped with-thumb' : 'card with-thumb'}>
              {/* A thumbnail per row only for PDFs, where a page is cheap to draw. */}
              {source?.kind === 'pdf' && s.pageStarts && (
                <PagePreview doc={doc} section={s} sectionCount={sections.length} source={source} size="small" lazy />
              )}
              {needsPdf && (
                <button
                  className="thumb small"
                  onClick={() => fileInput.current?.click()}
                  disabled={attaching}
                  title="Choose the PDF this text came from, to see its pages here"
                >
                  <span className="thumb-page placeholder">{attaching ? 'Reading…' : 'Add the PDF to see this page'}</span>
                </button>
              )}
              <div className="grow">
                <div className="row between">
                  <strong>
                    {s.index + 1}. {s.title}
                  </strong>
                  <span className={`badge ${st.tone}`}>{st.label}</span>
                </div>
                {reason && <p className="muted section-hint">Looks like a {reason}.</p>}
                <div className="row between wrap">
                  <span className="muted">
                    {s.wordCount} words
                    {paused.has(s.id) && ` · paused at ${Math.round((paused.get(s.id) ?? 0) * 100)}%`}
                  </span>
                  <span className="row">
                    <button aria-pressed={!!s.skipped} onClick={() => save([{ ...s, skipped: !s.skipped }])}>
                      {s.skipped ? 'Include in quiz' : 'Skip in quiz'}
                    </button>
                    <button onClick={() => onRead(s.index)}>
                      {paused.has(s.id) ? 'Resume' : s.readAt ? 'Read again' : 'Read'}
                    </button>
                  </span>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
