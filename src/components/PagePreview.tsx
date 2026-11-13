import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { lettersOnly, pageAtWord, paragraphStarts } from '../lib/pageMap';
import { openPdf, renderPdfPage } from '../lib/pdfRender';
import { getSource } from '../lib/storage';
import type { Doc, DocSource, Section } from '../types';

/**
 * Loads the original a document was imported from. `undefined` while
 * loading, `null` when this device does not have it. A change of `version`
 * loads it again.
 */
export function useDocSource(docId: string, version = 0): DocSource | null | undefined {
  const [state, setState] = useState<{ docId: string; source: DocSource | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getSource(docId)
      .catch(() => undefined)
      .then((source) => !cancelled && setState({ docId, source: source ?? null }));
    return () => {
      cancelled = true;
    };
  }, [docId, version]);
  return state?.docId === docId ? state.source : undefined;
}

// --- PDF pages

interface PdfPageProps {
  docId: string;
  file: Blob;
  page: number;
  /** Width to draw at, in CSS pixels. */
  width: number;
  /** Draw only once the page scrolls into view. */
  lazy?: boolean;
}

function PdfPage({ docId, file, page, width, lazy = false }: PdfPageProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(!lazy);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = canvas.current;
    if (visible || !el) return;
    const observer = new IntersectionObserver(
      (entries) => entries.some((e) => e.isIntersecting) && setVisible(true),
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let gone = false;
    let cancel = () => {};
    openPdf(docId, file)
      .then((pdf) => {
        if (gone || !canvas.current) return;
        cancel = renderPdfPage(pdf, page, canvas.current, width, (ok) => setFailed(!ok));
      })
      .catch(() => !gone && setFailed(true));
    return () => {
      gone = true;
      cancel();
    };
  }, [docId, file, page, width, visible]);

  return (
    <>
      <canvas ref={canvas} className="page-canvas" role="img" aria-label={`Page ${page}`} />
      {failed && <span className="page-failed muted">This page could not be shown.</span>}
    </>
  );
}

function usePageCount(source: DocSource | null | undefined): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (source?.kind !== 'pdf') return;
    let gone = false;
    openPdf(source.id, source.file)
      .then((pdf) => !gone && setCount(pdf.numPages))
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [source]);
  return source?.kind === 'pdf' ? count : null;
}

// --- web page snapshots

const BLOCKS = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,td,dd,figcaption';
const HERE = 'data-srq-here';
const blockCache = new WeakMap<Document, { el: Element; letters: string }[]>();

/** The element of the snapshot whose text starts like `text`. */
function findBlock(doc: Document, text: string): Element | null {
  const head = lettersOnly(text).slice(0, 40);
  if (head.length < 6) return null;
  let blocks = blockCache.get(doc);
  if (!blocks) {
    blocks = [...doc.body.querySelectorAll(BLOCKS)].map((el) => ({ el, letters: lettersOnly(el.textContent ?? '') }));
    blockCache.set(doc, blocks);
  }
  // Prefer the innermost match: a list item rather than the quote around it.
  const matches = blocks.filter((b) => b.letters.startsWith(head));
  const inner = matches.filter((m) => !matches.some((other) => other !== m && m.el.contains(other.el)));
  return (inner[0] ?? blocks.find((b) => b.letters.includes(head)))?.el ?? null;
}

/**
 * Scrolls the snapshot to the first of `anchors` that can be found and marks
 * it. If none is found, scrolls to `fraction` of the way down the page.
 */
function showPlace(doc: Document, anchors: string[], fraction: number) {
  const view = doc.defaultView;
  if (!view || !doc.body) return;
  if (!doc.getElementById('srq-here-style')) {
    const style = doc.createElement('style');
    style.id = 'srq-here-style';
    style.textContent = `[${HERE}]{outline:3px solid #dc3438 !important;outline-offset:6px !important}`;
    doc.head.append(style);
  }
  doc.querySelectorAll(`[${HERE}]`).forEach((el) => el.removeAttribute(HERE));

  let target: Element | null = null;
  for (const anchor of anchors) {
    target = findBlock(doc, anchor);
    if (target) break;
  }
  if (target) {
    target.setAttribute(HERE, '');
    // Not scrollIntoView: that would also scroll the app's own page.
    view.scrollTo(0, Math.max(0, target.getBoundingClientRect().top + view.scrollY - 48));
  } else {
    const root = doc.scrollingElement ?? doc.documentElement;
    view.scrollTo(0, fraction * Math.max(0, root.scrollHeight - view.innerHeight));
  }
}

interface SnapshotProps {
  html: string;
  anchors: string[];
  fraction: number;
  title: string;
  /** Escape pressed while the snapshot has the keyboard focus. */
  onEscape?: () => void;
  interactive: boolean;
}

function SnapshotFrame({ html, anchors, fraction, title, onEscape, interactive }: SnapshotProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [loads, setLoads] = useState(0);
  const anchorKey = anchors.join('\n');

  useEffect(() => {
    const doc = frame.current?.contentDocument;
    if (loads > 0 && doc) showPlace(doc, anchors, fraction);
    // `anchors` is a new array on every render; its content is in anchorKey.
  }, [loads, anchorKey, fraction]);

  useEffect(() => {
    const doc = frame.current?.contentDocument;
    if (loads === 0 || !doc || !onEscape) return;
    const onKeyDown = (e: KeyboardEvent) => e.key === 'Escape' && onEscape();
    doc.addEventListener('keydown', onKeyDown);
    return () => doc.removeEventListener('keydown', onKeyDown);
  }, [loads, onEscape]);

  return (
    <iframe
      ref={frame}
      className="snapshot-frame"
      title={title}
      // No scripts, forms or pop-ups run inside the snapshot. Same-origin
      // access lets this component scroll it to the current section.
      sandbox="allow-same-origin"
      srcDoc={html}
      tabIndex={interactive ? 0 : -1}
      aria-hidden={!interactive}
      onLoad={() => setLoads((n) => n + 1)}
    />
  );
}

// --- plain text, when there is no original to show

function TextPage({ section }: { section: Section }) {
  return (
    <div className="text-page">
      <h2>{section.title}</h2>
      {section.text.split(/\n\s*\n/).map((paragraph, i) => (
        <p key={i}>{paragraph}</p>
      ))}
    </div>
  );
}

// --- the expanded view

interface DialogProps {
  label: string;
  toolbar?: ReactNode;
  onClose: () => void;
  onKey?: (key: string) => void;
  children: ReactNode;
}

function PreviewDialog({ label, toolbar, onClose, onKey, children }: DialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    // showModal gives Escape-to-close, a backdrop and keeps focus inside.
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="preview-dialog"
      aria-label={label}
      onClose={onClose}
      // The dialog itself is only hit by clicks on the backdrop around the box.
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        // Keys must not reach the reader's shortcuts behind the dialog.
        e.stopPropagation();
        onKey?.(e.key);
      }}
      onKeyUp={(e) => e.stopPropagation()}
    >
      <div className="preview-box">
        <div className="preview-head">
          <strong className="preview-title">{label}</strong>
          {toolbar}
          <button onClick={onClose} aria-label="Close preview" title="Close (Esc)" autoFocus>
            ✕ Close
          </button>
        </div>
        <div className="preview-body">{children}</div>
      </div>
    </dialog>
  );
}

// --- thumbnail

const SNAPSHOT_WIDTH = 1000;
const TEXT_WIDTH = 640;
const SIZES = { small: 84, normal: 132 } as const;

interface Props {
  doc: Doc;
  section: Section;
  sectionCount: number;
  /** From useDocSource. */
  source: DocSource | null | undefined;
  /** The word the reader is at, so the preview follows the reading position. */
  word?: number;
  size?: keyof typeof SIZES;
  /** Draw the thumbnail only once it scrolls into view. */
  lazy?: boolean;
  /** Called when the expanded view opens. */
  onOpen?: () => void;
}

/**
 * A thumbnail of the page the section is on, which expands into a full-size
 * view. PDFs are drawn page by page; web pages are shown from the snapshot
 * taken at import, scrolled to the section; anything else shows the section's
 * text laid out as a page.
 */
export function PagePreview({ doc, section, sectionCount, source, word = 0, size = 'normal', lazy, onOpen }: Props) {
  const [open, setOpen] = useState(false);
  /** The page shown in the expanded view, which can be browsed away from the reading position. */
  const [viewPage, setViewPage] = useState(1);
  const pageCount = usePageCount(source);

  const page = pageAtWord(section.pageStarts, word);
  const paragraphs = useMemo(() => paragraphStarts(section.text), [section.text]);
  const anchors = useMemo(() => {
    const current = paragraphs.findLast((p) => p.word <= word) ?? paragraphs[0];
    return [...new Set([current?.text, paragraphs[0]?.text, section.title].filter((t): t is string => !!t))];
  }, [paragraphs, word, section.title]);
  const fraction = sectionCount > 1 ? section.index / (sectionCount - 1) : 0;

  if (source === undefined) return <div className={`thumb ${size} loading`} aria-hidden="true" />;

  const kind = source?.kind === 'pdf' && page ? 'pdf' : source?.kind === 'html' ? 'html' : 'text';
  const width = SIZES[size];
  const caption = kind === 'pdf' ? `Page ${page}` : kind === 'html' ? 'Web page' : 'Text';
  const label =
    kind === 'pdf'
      ? `Page ${viewPage}${pageCount ? ` of ${pageCount}` : ''}`
      : kind === 'html'
        ? doc.title
        : section.title;

  const close = () => setOpen(false);
  const turn = (by: number) => setViewPage((p) => Math.min(pageCount ?? p, Math.max(1, p + by)));

  return (
    <>
      <button
        className={`thumb ${size}`}
        onClick={() => {
          setViewPage(page ?? 1);
          setOpen(true);
          onOpen?.();
        }}
        aria-label={`${caption} preview. Click to enlarge.`}
        title="Click to enlarge"
      >
        <span className="thumb-page">
          {source?.kind === 'pdf' && kind === 'pdf' && (
            <PdfPage docId={source.id} file={source.file} page={page ?? 1} width={width} lazy={lazy} />
          )}
          {source?.kind === 'html' && (
            <span
              className="thumb-scaled"
              style={{ width: SNAPSHOT_WIDTH, height: SNAPSHOT_WIDTH * 1.3, transform: `scale(${width / SNAPSHOT_WIDTH})` }}
            >
              <SnapshotFrame html={source.html} anchors={anchors} fraction={fraction} title="" interactive={false} />
            </span>
          )}
          {kind === 'text' && (
            <span
              className="thumb-scaled"
              style={{ width: TEXT_WIDTH, height: TEXT_WIDTH * 1.3, transform: `scale(${width / TEXT_WIDTH})` }}
            >
              <TextPage section={section} />
            </span>
          )}
        </span>
        {size === 'normal' && <span className="thumb-caption">{caption} · enlarge</span>}
      </button>

      {open && (
        <PreviewDialog
          label={label}
          onClose={close}
          onKey={(key) => {
            if (kind !== 'pdf') return;
            if (key === 'ArrowLeft') turn(-1);
            if (key === 'ArrowRight') turn(1);
          }}
          toolbar={
            kind === 'pdf' ? (
              <span className="row">
                <button onClick={() => turn(-1)} disabled={viewPage <= 1} title="Previous page (←)">
                  ‹ Previous
                </button>
                <button onClick={() => turn(1)} disabled={!pageCount || viewPage >= pageCount} title="Next page (→)">
                  Next ›
                </button>
              </span>
            ) : source?.kind === 'html' ? (
              <a href={source.url} target="_blank" rel="noopener noreferrer">
                Open the live page ↗
              </a>
            ) : null
          }
        >
          {source?.kind === 'pdf' && kind === 'pdf' && (
            <PdfPage
              docId={source.id}
              file={source.file}
              page={viewPage}
              width={Math.min(1000, Math.max(280, window.innerWidth - 48))}
            />
          )}
          {source?.kind === 'html' && (
            <SnapshotFrame
              html={source.html}
              anchors={anchors}
              fraction={fraction}
              title={`Snapshot of ${doc.title}`}
              onEscape={close}
              interactive
            />
          )}
          {kind === 'text' && (
            <>
              {doc.source !== 'text' && (
                <p className="notice info">
                  The original {doc.source === 'pdf' ? 'PDF' : 'page'} is not stored in this browser, so this shows the
                  section's text. To see the real pages, add the original from the text's section list.
                </p>
              )}
              <TextPage section={section} />
            </>
          )}
        </PreviewDialog>
      )}
    </>
  );
}
