/**
 * Splits a long text into reading sections of roughly minWords..maxWords,
 * breaking at headings and paragraph boundaries where possible.
 */

export interface SplitOptions {
  minWords: number;
  maxWords: number;
}

export interface SectionDraft {
  title: string;
  text: string;
  wordCount: number;
}

interface Block {
  text: string;
  words: number;
  heading: boolean;
}

export const DEFAULT_SPLIT: SplitOptions = { minWords: 300, maxWords: 500 };

/** A section may run this far past maxWords to avoid leaving a tiny fragment. */
const OVERFLOW = 1.25;

export function countWords(text: string): number {
  const matches = text.match(/\S+/g);
  return matches ? matches.length : 0;
}

export function normalizeText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[   ]/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const MD_HEADING = /^#{1,6}\s+(\S.*)$/;

function looksLikeHeading(line: string): boolean {
  if (MD_HEADING.test(line)) return true;
  if (line.length > 80 || countWords(line) > 10) return false;
  if (/[.!?,;:]$/.test(line)) return false;
  return /^[\p{Lu}\d"“(]/u.test(line);
}

/** Breaks the text into paragraph and heading blocks. */
function parseBlocks(text: string): Block[] {
  let paragraphs = text.split(/\n\s*\n/);

  // Text with no blank lines: decide whether each line is its own paragraph
  // (long lines) or the lines are just hard-wrapped (short lines).
  if (paragraphs.length === 1 && text.includes('\n')) {
    const lines = text.split('\n').filter((l) => l.trim());
    const average = lines.reduce((sum, l) => sum + l.length, 0) / lines.length;
    if (average > 100) paragraphs = lines;
  }

  const blocks: Block[] = [];
  const push = (blockText: string, heading: boolean) => {
    const clean = blockText.replace(/\s+/g, ' ').trim();
    if (clean) blocks.push({ text: clean, words: countWords(clean), heading });
  };

  paragraphs.forEach((paragraph, i) => {
    const lines = paragraph
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return;

    const md = MD_HEADING.exec(lines[0]);
    if (md) {
      push(md[1].replace(/\s+#+$/, ''), true);
      if (lines.length > 1) push(lines.slice(1).join(' '), false);
      return;
    }
    const isLast = i === paragraphs.length - 1;
    if (lines.length === 1 && !isLast && looksLikeHeading(lines[0])) {
      push(lines[0], true);
      return;
    }
    push(lines.join(' '), false);
  });
  return blocks;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?]["'”’)\]]?)\s+(?=["'“‘(\[]?[\p{Lu}\d])/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Splits a paragraph that is longer than maxWords into sentence groups. */
function splitLongBlock(block: Block, maxWords: number): Block[] {
  // Sentences that are themselves too long are cut by word count.
  const pieces: string[] = [];
  for (const sentence of splitSentences(block.text)) {
    const words = sentence.split(/\s+/);
    if (words.length <= maxWords) {
      pieces.push(sentence);
    } else {
      for (let i = 0; i < words.length; i += maxWords) {
        pieces.push(words.slice(i, i + maxWords).join(' '));
      }
    }
  }

  // Aim for evenly sized chunks rather than one full chunk and a remainder.
  const chunkCount = Math.ceil(block.words / maxWords);
  const target = Math.ceil(block.words / chunkCount);
  const chunks: Block[] = [];
  let current: string[] = [];
  let currentWords = 0;
  const flush = () => {
    if (current.length === 0) return;
    chunks.push({ text: current.join(' '), words: currentWords, heading: false });
    current = [];
    currentWords = 0;
  };
  for (const piece of pieces) {
    const words = countWords(piece);
    if (currentWords > 0 && (currentWords + words > maxWords || currentWords >= target)) flush();
    current.push(piece);
    currentWords += words;
  }
  flush();
  return chunks;
}

function makeTitle(blocks: Block[]): string {
  const heading = blocks.find((b) => b.heading);
  if (heading) return heading.text;
  const words = (blocks[0]?.text ?? '').split(/\s+/);
  const title = words.slice(0, 8).join(' ').replace(/[,;:]$/, '');
  return words.length > 8 ? `${title}…` : title;
}

function toDraft(blocks: Block[]): SectionDraft {
  const text = blocks.map((b) => b.text).join('\n\n');
  return { title: makeTitle(blocks), text, wordCount: countWords(text) };
}

export function splitIntoSections(raw: string, options: SplitOptions = DEFAULT_SPLIT): SectionDraft[] {
  const maxWords = Math.max(20, Math.floor(options.maxWords));
  const minWords = Math.max(1, Math.min(Math.floor(options.minWords), maxWords));

  const blocks = parseBlocks(normalizeText(raw)).flatMap((b) =>
    !b.heading && b.words > maxWords ? splitLongBlock(b, maxWords) : [b],
  );
  if (blocks.length === 0) return [];

  const groups: Block[][] = [];
  let current: Block[] = [];
  let currentWords = 0;

  const flush = () => {
    // A heading at the very end belongs to the text that follows it.
    const carried: Block[] = [];
    while (current.length > 0 && current[current.length - 1].heading) {
      carried.unshift(current.pop()!);
    }
    if (current.length > 0) groups.push(current);
    current = carried;
    currentWords = carried.reduce((sum, b) => sum + b.words, 0);
  };

  for (const block of blocks) {
    if (block.heading) {
      if (currentWords >= minWords) flush();
    } else if (currentWords > 0 && currentWords + block.words > maxWords) {
      const bigEnough = currentWords >= minWords;
      const overflowTooFar = currentWords + block.words > maxWords * OVERFLOW;
      if (bigEnough || overflowTooFar) flush();
    }
    current.push(block);
    currentWords += block.words;
  }
  if (current.length > 0) groups.push(current);

  // Fold a short tail (or a group that is only headings) into its neighbour.
  for (let i = groups.length - 1; i > 0; i--) {
    const words = groups[i].reduce((sum, b) => sum + b.words, 0);
    const previousWords = groups[i - 1].reduce((sum, b) => sum + b.words, 0);
    const headingsOnly = groups[i].every((b) => b.heading);
    const isShortTail = i === groups.length - 1 && words < minWords / 2;
    if (headingsOnly || (isShortTail && words + previousWords <= maxWords * OVERFLOW)) {
      groups[i - 1].push(...groups[i]);
      groups.splice(i, 1);
    }
  }

  return groups.map(toDraft);
}

/** Splits one section's text in two at a character offset, on a word boundary. */
export function splitTextAt(text: string, offset: number): [string, string] | null {
  let cut = Math.max(0, Math.min(offset, text.length));
  while (cut < text.length && /\S/.test(text[cut]) && cut > 0 && /\S/.test(text[cut - 1])) cut++;
  const first = text.slice(0, cut).trim();
  const second = text.slice(cut).trim();
  return first && second ? [first, second] : null;
}
