import type { SourceKind, SourceOriginal } from '../../types';
import { ExtractError } from './errors';
import { extractPdfText } from './pdf';
import { fetchUrlText } from './url';

export { ExtractError };

export interface Extracted {
  title: string;
  text: string;
  source: SourceKind;
  sourceRef?: string;
  /** For PDFs: the paragraphs on each page, used to tell which page a section is on. */
  pages?: string[][];
  /** The PDF file or page snapshot, kept on this device for page previews. */
  original?: SourceOriginal;
}

const MAX_PDF_BYTES = 100 * 1024 * 1024;

export async function extractFromPdfFile(file: File): Promise<Extracted> {
  if (file.size > MAX_PDF_BYTES) throw new ExtractError('This PDF is larger than 100 MB.');
  const { text, title, pages } = await extractPdfText(await file.arrayBuffer());
  return {
    title: title || file.name.replace(/\.pdf$/i, ''),
    text,
    source: 'pdf',
    sourceRef: file.name,
    pages,
    original: { kind: 'pdf', file },
  };
}

export async function extractFromUrl(url: string): Promise<Extracted> {
  const result = await fetchUrlText(url);
  return {
    title: result.title || new URL(result.url).hostname,
    text: result.text,
    source: 'url',
    sourceRef: result.url,
    pages: result.pages,
    original: result.original,
  };
}

export function extractFromPaste(text: string, title: string): Extracted {
  if (!text.trim()) throw new ExtractError('Paste some text first.');
  const firstLine = text.trim().split('\n')[0].replace(/^#+\s*/, '').trim();
  const fallback = firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
  return { title: title.trim() || fallback || 'Untitled', text, source: 'text' };
}
