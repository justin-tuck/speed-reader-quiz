import { joinPages } from '../pageMap';
import { loadPdfjs } from '../pdfjs';
import { ExtractError } from './errors';

interface Line {
  y: number;
  text: string;
}

function joinLines(lines: Line[]): string[] {
  if (lines.length === 0) return [];
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i - 1].y - lines[i].y;
    if (gap > 0) gaps.push(gap);
  }
  gaps.sort((a, b) => a - b);
  const typicalGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;

  const paragraphs: string[] = [];
  let current = lines[0].text;
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i - 1].y - lines[i].y;
    // A bigger gap than usual, or a jump back up the page (new column),
    // starts a new paragraph.
    const newParagraph = gap < 0 || (typicalGap > 0 && gap > typicalGap * 1.4);
    const next = lines[i].text;
    if (newParagraph) {
      paragraphs.push(current);
      current = next;
    } else if (/\p{L}-$/u.test(current) && /^\p{Ll}/u.test(next)) {
      current = current.slice(0, -1) + next; // word hyphenated across lines
    } else {
      current += ` ${next}`;
    }
  }
  paragraphs.push(current);
  return paragraphs;
}

export interface PdfText {
  text: string;
  title?: string;
  /** The paragraphs found on each page, in page order. */
  pages: string[][];
}

export async function extractPdfText(data: ArrayBuffer): Promise<PdfText> {
  const pdfjs = await loadPdfjs();

  const task = pdfjs.getDocument({ data: new Uint8Array(data) });
  let pdf;
  try {
    pdf = await task.promise;
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'PasswordException') {
      throw new ExtractError('This PDF is password protected. Remove the password and try again.');
    }
    throw new ExtractError('This file could not be read as a PDF. It may be damaged or not a PDF.');
  }

  try {
    const pages: string[][] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();

      const lines: Line[] = [];
      let text = '';
      let lineY: number | null = null;
      const endLine = () => {
        const clean = text.replace(/\s+/g, ' ').trim();
        // Lines that are only a number are almost always page numbers.
        if (clean && lineY !== null && !/^\d{1,4}$/.test(clean)) lines.push({ y: lineY, text: clean });
        text = '';
        lineY = null;
      };
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const y = item.transform[5] as number;
        if (lineY !== null && Math.abs(y - lineY) > Math.max(2, item.height * 0.5)) endLine();
        if (lineY === null) lineY = y;
        text += item.str;
        if (item.hasEOL) endLine();
      }
      endLine();

      pages.push(joinLines(lines));
    }

    const text = joinPages(pages);
    if (text.replace(/\s/g, '').length < 20) {
      throw new ExtractError(
        'No text was found in this PDF. It is probably a scan (images of pages), which cannot be read without OCR.',
      );
    }

    let title: string | undefined;
    try {
      const meta = await pdf.getMetadata();
      const info = meta.info as { Title?: unknown };
      if (typeof info.Title === 'string' && info.Title.trim()) title = info.Title.trim();
    } catch {
      // Metadata is optional.
    }
    return { text, title, pages };
  } catch (err) {
    if (err instanceof ExtractError) throw err;
    throw new ExtractError('The text could not be extracted from this PDF.');
  } finally {
    void task.destroy();
  }
}
