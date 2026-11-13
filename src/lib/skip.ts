/**
 * Suggests parts of a text that are not worth a quiz: a title page, a
 * copyright page, a table of contents or a list of references. These are only
 * suggestions: the section editor and the section list show them and the
 * user decides.
 */
import { joinPages } from './pageMap';
import { countWords, splitIntoSections, type SplitOptions } from './splitter';

export type SkipReason = 'title page' | 'copyright page' | 'table of contents' | 'reference list';

const TITLE_PAGE_MAX_WORDS = 60;
/** Front matter is only looked for in the first pages, or the first sections of a long text. */
const FRONT_PAGES = 30;
const FRONT_SECTIONS = 5;
/** A short page this early in a PDF of full pages is a title or half-title page. */
const TITLE_PAGES = 8;
const PROSE_PAGE_WORDS = 150;
/** Shorter texts, such as articles, have no front matter worth skipping beyond a title. */
const MIN_SECTIONS_FOR_FRONT_MATTER = 10;

/** Entries like "Introduction ..... 3" or "Methods . . . . 12". */
const LEADERS = /(?:\.\s?){3,}\s*(?:\d+|[ivxlc]+)\b/gi;
/** Entries without leaders, like "Query Languages for Data 42 Declarative queries 43": words, a page number, the next entry. */
const ENTRY_END = /[\p{L})’'"?]\s+\d{1,4}(?=\s+[\p{Lu}\d•"“(]|\s*$)/gu;
const CONTENTS_HEADING = /^\W*(?:table\s+of\s+)?contents\b/i;
const COPYRIGHT = /(?:copyright|©|\(c\))\s*(?:©\s*)?\d{4}/i;
const RIGHTS = /all rights reserved|\bISBN\b|\b97[89][-‐–\s]?\d{1,5}[-‐–\s]?\d/i;
/** Numbered references like "[12] Jay Kreps: …". Citations in running text are followed by punctuation or lower case. */
const REFERENCE_ENTRY = /(?:^|\s)\[\d{1,3}\]\s+[\p{Lu}“"‘(]/gu;
/** A list starts where an entry is followed by at least this many more within REFERENCE_WINDOW characters. */
const REFERENCE_RUN = 3;
const REFERENCE_WINDOW = 1200;
/** A section counts as a reference list if the list starts within this share of its text. */
const REFERENCES_FROM = 0.15;
/** Prose before a reference list is kept as a section of its own only if it has at least this many words. */
const MIN_PROSE_WORDS = 40;
const REFERENCES_HEADING = /^\W*(?:references|bibliography|works cited)\b/i;
const YEAR = /\b(?:1[89]|20)\d{2}\b/g;

const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length;

function numberShare(text: string): number {
  const words = text.match(/\S+/g) ?? [];
  if (words.length === 0) return 0;
  return words.filter((w) => /^\d{1,4}[.,;]?$/.test(w)).length / words.length;
}

export function looksLikeContents(text: string): boolean {
  if (count(text, LEADERS) >= 3) return true;
  const words = countWords(text);
  // A heading "Contents" followed by entries that end in page numbers.
  if (CONTENTS_HEADING.test(text) && words >= 8 && numberShare(text) >= 0.08) return true;
  // Entries without leaders: one page number every dozen words or so, which running text never has.
  const entries = count(text, ENTRY_END);
  return entries >= 8 && entries / words >= 0.08;
}

/** A copyright notice with "All rights reserved" or an ISBN, as on the back of a book's title page. */
export function looksLikeCopyright(text: string): boolean {
  return COPYRIGHT.test(text) && RIGHTS.test(text);
}

/**
 * Where a list of numbered references starts in `text`, including a
 * "References" heading just before it, or -1 if there is none.
 */
export function referencesStart(text: string): number {
  for (const match of text.matchAll(REFERENCE_ENTRY)) {
    const at = match.index + match[0].indexOf('[');
    if (count(text.slice(at, at + REFERENCE_WINDOW), REFERENCE_ENTRY) < REFERENCE_RUN) continue;
    const before = text.slice(Math.max(0, at - 40), at);
    const heading = /(?:references|bibliography)\s*$/i.exec(before);
    return heading ? at - before.length + heading.index : at;
  }
  return -1;
}

/** Mostly a list of references, such as the end of a chapter or a bibliography. */
export function looksLikeReferences(text: string): boolean {
  const words = countWords(text);
  if (words === 0) return false;
  const start = referencesStart(text);
  if (start >= 0) return start <= text.length * REFERENCES_FROM && count(text, REFERENCE_ENTRY) / words >= 0.02;
  return REFERENCES_HEADING.test(text) && count(text, YEAR) / words >= 0.02;
}

/** Splits a section where a list of references starts part-way, so the prose before it can still be quizzed. */
function splitOffReferences(section: PlannedSection): PlannedSection[] {
  if (section.suggestion) return [section];
  const at = referencesStart(section.text);
  if (at <= 0) return [section];
  const prose = section.text.slice(0, at).trim();
  const references = section.text.slice(at).trim();
  if (countWords(prose) < MIN_PROSE_WORDS || !looksLikeReferences(references)) return [section];
  // The section may have been named after a heading inside the references, such as "References".
  return [
    { ...section, title: prose.includes(section.title) ? section.title : firstWords(prose), text: prose },
    { title: 'References', text: references },
  ];
}

function firstWords(text: string): string {
  const words = text.split(/\s+/);
  return words.slice(0, 8).join(' ').replace(/[,;:]$/, '') + (words.length > 8 ? '…' : '');
}

/** A page after a table of contents that carries on the list, without its own heading. */
function continuesContents(text: string): boolean {
  return looksLikeContents(text) || (countWords(text) >= 8 && numberShare(text) >= 0.15);
}

/** For a section of any text: a reason to suggest skipping it, or null. */
export function suggestSkip(text: string, index: number, sectionCount: number): SkipReason | null {
  if (looksLikeReferences(text)) return 'reference list';
  if (looksLikeContents(text)) return 'table of contents';
  // The rest only near the start of a long text, so a notice or a short
  // passage later on, or in an article, is not taken for front matter.
  const front = index < FRONT_SECTIONS && sectionCount >= MIN_SECTIONS_FOR_FRONT_MATTER;
  if (front && looksLikeCopyright(text.slice(0, 1500))) return 'copyright page';
  const short = countWords(text) <= TITLE_PAGE_MAX_WORDS;
  if (short && ((index === 0 && sectionCount > 1) || front)) return 'title page';
  return null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}

export interface FrontMatter {
  /** Runs of pages before the main text, in order. `reason` is null for ordinary pages in between. */
  parts: { pages: string[][]; reason: SkipReason | null }[];
  /** Index of the first page of the main text. */
  bodyStart: number;
}

/**
 * Finds a title page, copyright page and table of contents at the start of a
 * PDF, so they can become sections of their own instead of being merged into
 * the first chapter.
 */
export function findFrontMatter(pages: string[][]): FrontMatter {
  const words = pages.map((p) => countWords(p.join(' ')));
  const typical = median(words.filter((w) => w > 0));
  const reasons: (SkipReason | null)[] = [];
  /** The reason for the last page that had text, so a blank page does not end a table of contents. */
  let previous: SkipReason | null = null;
  // The last page is never front matter: there must be some main text.
  const limit = Math.min(FRONT_PAGES, pages.length - 1);
  for (let i = 0; i < limit; i++) {
    const text = pages[i].join(' ');
    const short = words[i] > 0 && words[i] <= TITLE_PAGE_MAX_WORDS;
    let reason: SkipReason | null = null;
    if (looksLikeContents(text) || (previous === 'table of contents' && continuesContents(text))) {
      reason = 'table of contents';
    } else if (looksLikeCopyright(text)) {
      reason = 'copyright page';
    } else if (short && (i === 0 ? pages.length >= 3 : i < TITLE_PAGES && typical >= PROSE_PAGE_WORDS)) {
      reason = 'title page';
    }
    reasons.push(reason);
    if (words[i] > 0) previous = reason;
  }

  const bodyStart = reasons.findLastIndex((r) => r !== null) + 1;
  const parts: FrontMatter['parts'] = [];
  for (let i = 0; i < bodyStart; i++) {
    if (pages[i].length === 0) continue;
    const last = parts[parts.length - 1];
    if (last && last.reason === reasons[i]) last.pages.push(pages[i]);
    else parts.push({ pages: [pages[i]], reason: reasons[i] });
  }
  return { parts, bodyStart };
}

export interface PlannedSection {
  title: string;
  text: string;
  /** Why skipping this section is suggested, if it is. */
  suggestion?: SkipReason;
}

const SUGGESTED_TITLE: Record<SkipReason, string> = {
  'title page': 'Title page',
  'copyright page': 'Copyright page',
  'table of contents': 'Table of contents',
  'reference list': 'References',
};

/**
 * The first split of an imported text into sections, with skip suggestions.
 * A PDF's front pages become sections of their own, so they are not merged
 * into the first chapter, and so does a list of references that starts
 * part-way through a section.
 */
export function planSections(text: string, pages: string[][] | undefined, options: SplitOptions): PlannedSection[] {
  const plain = (t: string): PlannedSection[] =>
    splitIntoSections(t, options).map((s) => ({ title: s.title, text: s.text }));
  const front = pages ? findFrontMatter(pages) : null;
  const split =
    pages && front && front.parts.length > 0
      ? [
          ...front.parts.flatMap((part): PlannedSection[] => {
            const partText = joinPages(part.pages);
            return part.reason
              ? [{ title: SUGGESTED_TITLE[part.reason], text: partText, suggestion: part.reason }]
              : plain(partText);
          }),
          ...plain(joinPages(pages.slice(front.bodyStart))),
        ]
      : plain(text);
  const planned = split.flatMap(splitOffReferences);
  return planned.map((p, index) => {
    if (p.suggestion) return p;
    const suggestion = suggestSkip(p.text, index, planned.length);
    return suggestion ? { ...p, suggestion } : p;
  });
}
