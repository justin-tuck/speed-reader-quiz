/**
 * Works out which page of a PDF each part of a section is on, by finding the
 * section's text in the text of the pages. Sections can be edited, merged and
 * split before saving, so the match ignores spacing, case and punctuation.
 */
import type { PageStart } from '../types';
import { tokenize } from './rsvp';

const ENDS_SENTENCE = /[.!?:]["'”’)\]]*$/;

/** Joins the paragraphs of consecutive pages into one text. */
export function joinPages(pages: string[][]): string {
  const paragraphs: string[] = [];
  for (const page of pages) {
    const pageParagraphs = [...page];
    // A paragraph cut by the page break continues on the next page.
    const last = paragraphs[paragraphs.length - 1];
    if (last && pageParagraphs.length > 0 && !ENDS_SENTENCE.test(last)) {
      paragraphs[paragraphs.length - 1] = `${last} ${pageParagraphs.shift()}`;
    }
    paragraphs.push(...pageParagraphs);
  }
  return paragraphs.join('\n\n').trim();
}

/** Letters and digits only, so texts compare equal however they are spaced or punctuated. */
export function lettersOnly(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

const HEAD_CHARS = 48;

/** The opening letters of a text, used to find it in the pages. Reads only as much of the text as it needs. */
function headOf(text: string): string {
  const head = lettersOnly(text.slice(0, 400));
  return (head.length >= HEAD_CHARS ? head : lettersOnly(text)).slice(0, HEAD_CHARS);
}

/** All the pages' letters in one string, and a way to tell which page an offset in it falls on. */
function pageIndex(pages: string[][]) {
  const pageLetters = pages.map((p) => lettersOnly(p.join(' ')));
  const pageEnds: number[] = [];
  let end = 0;
  for (const letters of pageLetters) pageEnds.push((end += letters.length));

  // The first page that ends after `offset`, by binary search: books have hundreds of pages.
  const pageAt = (offset: number): number => {
    let low = 0;
    let high = pageEnds.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (offset < pageEnds[mid]) high = mid;
      else low = mid + 1;
    }
    return Math.min(low, Math.max(0, pages.length - 1)) + 1;
  };
  return { all: pageLetters.join(''), pageAt };
}

/**
 * Returns a function that tells which page a passage starts on, or undefined
 * if it is not found. Answers are remembered by the passage's opening, so it
 * can be asked again for every section on every change, as the editor does.
 */
export function createPageLocator(pages: string[][]): (text: string) => number | undefined {
  const { all, pageAt } = pageIndex(pages);
  const known = new Map<string, number | undefined>();
  return (text) => {
    const head = headOf(text);
    if (!head) return undefined;
    if (!known.has(head)) {
      const at = all.indexOf(head);
      known.set(head, at < 0 ? undefined : pageAt(at));
    }
    return known.get(head);
  };
}

/**
 * For each section, in reading order, the pages it covers. `pages` holds the
 * paragraphs of each page of the document the sections came from.
 */
export function mapSectionsToPages(pages: string[][], sectionTexts: string[]): PageStart[][] {
  const { all, pageAt } = pageIndex(pages);

  // Sections follow each other in the document, so each search starts where
  // the previous section ended. A section that was moved is searched for
  // everywhere; one that cannot be found is assumed to follow the previous one.
  let cursor = 0;
  return sectionTexts.map((text) => {
    const tokens = tokenize(text);
    const head = headOf(text);
    let start = head ? all.indexOf(head, cursor) : -1;
    if (start < 0 && head) start = all.indexOf(head);
    if (start < 0) start = Math.min(cursor, all.length);

    const starts: PageStart[] = [];
    let offset = start;
    tokens.forEach((token, word) => {
      const page = pageAt(offset);
      if (starts.length === 0 || starts[starts.length - 1].page !== page) starts.push({ page, word });
      offset += lettersOnly(token.text).length;
    });
    cursor = offset;
    return starts.length > 0 ? starts : [{ page: pageAt(start), word: 0 }];
  });
}

/** The share of the sections whose opening words are found in the pages, to check a PDF is the right one. */
export function matchShare(pages: string[][], sectionTexts: string[]): number {
  if (sectionTexts.length === 0) return 0;
  const { all } = pageIndex(pages);
  const found = sectionTexts.filter((text) => {
    const head = headOf(text);
    return head.length > 0 && all.includes(head);
  });
  return found.length / sectionTexts.length;
}

/** The page the reader's word `index` is on, or undefined when the section has no page data. */
export function pageAtWord(starts: PageStart[] | undefined, index: number): number | undefined {
  if (!starts || starts.length === 0) return undefined;
  let page = starts[0].page;
  for (const start of starts) {
    if (start.word > index) break;
    page = start.page;
  }
  return page;
}

/** The paragraphs of a section with the reader's word index each one starts at. */
export function paragraphStarts(text: string): { word: number; text: string }[] {
  const out: { word: number; text: string }[] = [];
  let word = 0;
  for (const paragraph of text.split(/\n\s*\n/)) {
    const count = tokenize(paragraph).length;
    if (count === 0) continue;
    out.push({ word, text: paragraph });
    word += count;
  }
  return out;
}
