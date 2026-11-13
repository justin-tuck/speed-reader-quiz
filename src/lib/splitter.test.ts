import { describe, expect, it } from 'vitest';
import { countWords, normalizeText, splitIntoSections, splitTextAt } from './splitter';

/** A paragraph of exactly `n` words made of short sentences. */
function paragraph(n: number, tag = 'word'): string {
  const words: string[] = [];
  for (let i = 0; i < n; i++) {
    const startsSentence = i % 10 === 0;
    const endsSentence = i % 10 === 9 || i === n - 1;
    let w = `${tag}${i}`;
    if (startsSentence) w = w[0].toUpperCase() + w.slice(1);
    if (endsSentence) w += '.';
    words.push(w);
  }
  return words.join(' ');
}

const opts = { minWords: 300, maxWords: 500 };

describe('countWords', () => {
  it('counts whitespace-separated words', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('  one  two\nthree ')).toBe(3);
  });
});

describe('normalizeText', () => {
  it('normalises line endings and collapses blank lines', () => {
    expect(normalizeText('a\r\nb\r\n\r\n\r\n\r\nc  \n')).toBe('a\nb\n\nc');
  });
});

describe('splitIntoSections', () => {
  it('returns nothing for empty input', () => {
    expect(splitIntoSections('   \n\n ', opts)).toEqual([]);
  });

  it('keeps a short text as one section', () => {
    const sections = splitIntoSections(paragraph(120), opts);
    expect(sections).toHaveLength(1);
    expect(sections[0].wordCount).toBe(120);
  });

  it('keeps sections within the word range and breaks only between paragraphs', () => {
    const paragraphs = Array.from({ length: 30 }, (_, i) => paragraph(80, `p${i}w`));
    const sections = splitIntoSections(paragraphs.join('\n\n'), opts);

    expect(sections.length).toBeGreaterThan(3);
    for (const s of sections.slice(0, -1)) {
      expect(s.wordCount).toBeGreaterThanOrEqual(300);
      expect(s.wordCount).toBeLessThanOrEqual(500);
    }
    // Every paragraph survives whole inside exactly one section.
    for (const p of paragraphs) {
      expect(sections.filter((s) => s.text.includes(p))).toHaveLength(1);
    }
  });

  it('loses no words', () => {
    const paragraphs = Array.from({ length: 17 }, (_, i) => paragraph(40 + i * 13, `p${i}w`));
    const sections = splitIntoSections(paragraphs.join('\n\n'), opts);
    const total = sections.reduce((sum, s) => sum + s.wordCount, 0);
    expect(total).toBe(paragraphs.reduce((sum, p) => sum + countWords(p), 0));
  });

  it('starts a new section at a heading once the minimum is reached', () => {
    const text = [
      '# Introduction',
      paragraph(200, 'a'),
      paragraph(150, 'b'),
      '# Methods',
      paragraph(200, 'c'),
      paragraph(150, 'd'),
    ].join('\n\n');
    const sections = splitIntoSections(text, opts);
    expect(sections).toHaveLength(2);
    expect(sections[0].title).toBe('Introduction');
    expect(sections[1].title).toBe('Methods');
    expect(sections[1].text.startsWith('Methods')).toBe(true);
    expect(sections[0].text).not.toContain('#');
  });

  it('does not break at a heading when the section is still too short', () => {
    const text = ['# One', paragraph(100, 'a'), '# Two', paragraph(100, 'b')].join('\n\n');
    expect(splitIntoSections(text, opts)).toHaveLength(1);
  });

  it('never leaves a heading stranded at the end of a section', () => {
    // 280 words is under the minimum, so the heading joins the first group,
    // and the 400-word paragraph then forces a break right after it.
    const text = [paragraph(280, 'a'), 'A Plain Heading', paragraph(400, 'b'), paragraph(200, 'c')].join(
      '\n\n',
    );
    const sections = splitIntoSections(text, opts);
    expect(sections).toHaveLength(3);
    expect(sections[0].text.endsWith('A Plain Heading')).toBe(false);
    expect(sections[1].title).toBe('A Plain Heading');
  });

  it('splits an oversized paragraph at sentence boundaries', () => {
    const sections = splitIntoSections(paragraph(1300), opts);
    expect(sections.length).toBeGreaterThanOrEqual(3);
    for (const s of sections) {
      expect(s.wordCount).toBeLessThanOrEqual(500);
      expect(s.text.endsWith('.')).toBe(true);
    }
    expect(sections.reduce((sum, s) => sum + s.wordCount, 0)).toBe(1300);
  });

  it('splits text with no sentence punctuation by word count', () => {
    const text = Array.from({ length: 1200 }, (_, i) => `w${i}`).join(' ');
    const sections = splitIntoSections(text, opts);
    for (const s of sections) expect(s.wordCount).toBeLessThanOrEqual(500);
    expect(sections.reduce((sum, s) => sum + s.wordCount, 0)).toBe(1200);
  });

  it('merges a tiny final section into the previous one', () => {
    const text = [paragraph(200, 'a'), paragraph(200, 'b'), paragraph(90, 'c'), paragraph(40, 'd')].join(
      '\n\n',
    );
    const sections = splitIntoSections(text, opts);
    expect(sections).toHaveLength(1);
    expect(sections[0].wordCount).toBe(530);
  });

  it('treats long single lines as paragraphs when there are no blank lines', () => {
    const lines = Array.from({ length: 12 }, (_, i) => paragraph(80, `p${i}w`));
    const sections = splitIntoSections(lines.join('\n'), opts);
    expect(sections.length).toBeGreaterThan(1);
    expect(sections[0].text).toContain('\n\n');
  });

  it('joins hard-wrapped lines into one paragraph', () => {
    const sections = splitIntoSections('The quick brown fox\njumps over the lazy dog.\nIt ran away.', opts);
    expect(sections[0].text).toBe('The quick brown fox jumps over the lazy dog. It ran away.');
  });

  it('builds a title from the first words when there is no heading', () => {
    const [section] = splitIntoSections('one two three four five six seven eight nine ten.', opts);
    expect(section.title).toBe('one two three four five six seven eight…');
  });

  it('respects custom sizes', () => {
    const paragraphs = Array.from({ length: 20 }, (_, i) => paragraph(50, `p${i}w`));
    const sections = splitIntoSections(paragraphs.join('\n\n'), { minWords: 100, maxWords: 150 });
    for (const s of sections.slice(0, -1)) {
      expect(s.wordCount).toBeGreaterThanOrEqual(100);
      expect(s.wordCount).toBeLessThanOrEqual(150);
    }
  });
});

describe('splitTextAt', () => {
  it('splits on a word boundary', () => {
    expect(splitTextAt('alpha beta gamma', 8)).toEqual(['alpha beta', 'gamma']);
    expect(splitTextAt('alpha beta gamma', 6)).toEqual(['alpha', 'beta gamma']);
  });

  it('refuses a split that would leave an empty half', () => {
    expect(splitTextAt('alpha', 0)).toBeNull();
    expect(splitTextAt('alpha', 5)).toBeNull();
  });
});
