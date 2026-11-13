import { describe, expect, it } from 'vitest';
import {
  findFrontMatter,
  looksLikeContents,
  looksLikeCopyright,
  looksLikeReferences,
  planSections,
  referencesStart,
  suggestSkip,
} from './skip';

const body = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ') + '.';
const contents = 'Contents Introduction 1 Getting started 5 Reading faster 12 Remembering more 27 Index 40';
const leaders = 'Introduction ........ 1 Getting started . . . . . 5 Reading faster ..... 12';
/** A contents page without leaders or a heading, as in many books after the first contents page. */
const entries =
  'Relational vs. document databases today 38 Query Languages for Data 42 Declarative queries on the web 43 MapReduce querying 45 Graph-like Data Models 48 Property graphs 49 The Cypher query language 51 Graph queries in SQL 52 Triple-stores 55 Summary 63';

describe('looksLikeContents', () => {
  it('recognises a contents heading followed by page numbers', () => {
    expect(looksLikeContents(contents)).toBe(true);
    expect(looksLikeContents(`Table of ${contents}`)).toBe(true);
  });

  it('recognises dot leaders without a heading', () => {
    expect(looksLikeContents(leaders)).toBe(true);
  });

  it('recognises entries that end in page numbers, without leaders or a heading', () => {
    expect(looksLikeContents(entries)).toBe(true);
  });

  it('does not flag ordinary text', () => {
    expect(looksLikeContents(body(200))).toBe(false);
    expect(looksLikeContents('Contents may settle during shipping, the label said, and so they had.')).toBe(false);
    expect(looksLikeContents('In 2019 there were 3 trials with 40 people each.')).toBe(false);
  });
});

const copyright =
  '978-1-491-90309-4 Designing Things by A. Writer Copyright © 2016 A. Writer. All rights reserved. Printed in the United States of America.';

describe('looksLikeCopyright', () => {
  it('recognises a copyright notice with rights reserved or an ISBN', () => {
    expect(looksLikeCopyright(copyright)).toBe(true);
    expect(looksLikeCopyright('Copyright 2020 by Someone. ISBN 0-12-345678-9')).toBe(true);
  });

  it('does not flag text that only mentions copyright', () => {
    expect(looksLikeCopyright('Copyright law changed a lot in 1976, as this chapter explains.')).toBe(false);
  });
});

describe('suggestSkip', () => {
  it('suggests a copyright page near the start of a long text', () => {
    expect(suggestSkip(`${copyright} ${body(300)}`, 0, 40)).toBe('copyright page');
    expect(suggestSkip(copyright, 3, 40)).toBe('copyright page');
  });

  it('does not suggest a copyright notice later on, or in a short text', () => {
    expect(suggestSkip(copyright, 12, 40)).toBeNull();
    expect(suggestSkip(`${body(300)} ${copyright}`, 2, 5)).toBeNull();
  });

  it('suggests a short first section as a title page', () => {
    expect(suggestSkip('A Short Book By Someone', 0, 5)).toBe('title page');
  });

  it('does not suggest a short section elsewhere, or a text with only one section', () => {
    expect(suggestSkip('A Short Book By Someone', 2, 5)).toBeNull();
    expect(suggestSkip('A Short Book By Someone', 0, 1)).toBeNull();
    expect(suggestSkip('A Short Book By Someone', 20, 40)).toBeNull();
  });

  it('suggests a short section near the start of a long text as a title page', () => {
    expect(suggestSkip('A Short Book By Someone', 2, 40)).toBe('title page');
  });

  it('suggests a table of contents wherever it is', () => {
    expect(suggestSkip(contents, 1, 5)).toBe('table of contents');
  });

  it('suggests nothing for ordinary sections', () => {
    expect(suggestSkip(body(300), 0, 5)).toBeNull();
  });
});

describe('findFrontMatter', () => {
  it('separates a title page and a table of contents from the main text', () => {
    const pages = [['A Short Book', 'By Someone'], [contents], [leaders], [body(300)], [body(300)]];
    const front = findFrontMatter(pages);
    expect(front.bodyStart).toBe(3);
    expect(front.parts).toEqual([
      { pages: [pages[0]], reason: 'title page' },
      { pages: [pages[1], pages[2]], reason: 'table of contents' },
    ]);
  });

  it('separates a copyright page', () => {
    const pages = [['A Short Book'], [copyright], [contents], [body(300)], [body(300)]];
    expect(findFrontMatter(pages).parts.map((p) => p.reason)).toEqual(['title page', 'copyright page', 'table of contents']);
  });

  it('keeps ordinary pages between front matter as their own part', () => {
    const pages = [['A Short Book'], [body(200)], [contents], [body(300)]];
    const front = findFrontMatter(pages);
    expect(front.parts.map((p) => p.reason)).toEqual(['title page', null, 'table of contents']);
    expect(front.bodyStart).toBe(3);
  });

  it('finds nothing in a text that starts straight away', () => {
    expect(findFrontMatter([[body(300)], [body(300)], [body(300)]])).toEqual({ parts: [], bodyStart: 0 });
  });

  it('does not treat a short text as only a title page', () => {
    expect(findFrontMatter([['A note'], ['That is short.']]).parts).toEqual([]);
  });

  it('handles a book with blank pages, a later title page and contents without leaders', () => {
    const pages = [
      [],
      [],
      [copyright],
      [],
      ['A. Writer Boston', 'Designing Things'],
      [],
      [`Table of ${contents}`],
      [entries],
      [],
      ['Fault tolerance 460 Summary 462 x | Table of Contents'],
      ...Array.from({ length: 6 }, () => [body(300)]),
    ];
    const front = findFrontMatter(pages);
    expect(front.parts.map((p) => [p.reason, p.pages.length])).toEqual([
      ['copyright page', 1],
      ['title page', 1],
      ['table of contents', 3],
    ]);
    expect(front.bodyStart).toBe(10);
  });

  it('does not take the short pages of a slide deck for title pages', () => {
    const slides = Array.from({ length: 12 }, (_, i) => [`Slide ${i + 1}`, body(30)]);
    expect(findFrontMatter(slides).parts.map((p) => p.reason)).toEqual(['title page']);
  });
});

const references = (from: number, n: number) =>
  Array.from(
    { length: n },
    (_, i) => `[${from + i}] Jane Author and Sam Writer: “A Paper About Systems ${i},” at Conference on Things, May 2014.`,
  ).join(' ');

describe('reference lists', () => {
  it('recognises a list of numbered references', () => {
    expect(looksLikeReferences(references(1, 10))).toBe(true);
    expect(suggestSkip(references(20, 10), 30, 40)).toBe('reference list');
  });

  it('does not flag prose with citations', () => {
    const cited = `${body(120)} as shown before [12], systems fail [13]. They recover slowly [14] when ${body(120)}`;
    expect(looksLikeReferences(cited)).toBe(false);
    expect(referencesStart(cited)).toBe(-1);
  });

  it('does not flag a section that only ends with references', () => {
    expect(looksLikeReferences(`${body(300)} ${references(1, 6)}`)).toBe(false);
  });

  it('finds where the list starts, including its heading', () => {
    const text = `${body(50)}\n\nReferences\n\n${references(1, 6)}`;
    expect(text.slice(referencesStart(text)).startsWith('References')).toBe(true);
  });
});

describe('planSections', () => {
  const split = { minWords: 300, maxWords: 500 };

  it('splits off a list of references that starts part-way through a section', () => {
    const planned = planSections(`${body(250)}\n\nReferences\n\n${references(1, 8)}`, undefined, split);
    expect(planned.map((p) => [p.title, p.suggestion])).toEqual([
      ['word0 word1 word2 word3 word4 word5 word6 word7…', undefined],
      ['References', 'reference list'],
    ]);
    expect(planned[0].text).toBe(body(250));
  });

  it('makes front matter pages into suggested sections of their own', () => {
    const pages = [['A Short Book'], [copyright], [contents], [body(300)], [body(300)]];
    const planned = planSections('', pages, split);
    expect(planned.map((p) => [p.title, p.suggestion])).toEqual([
      ['Title page', 'title page'],
      ['Copyright page', 'copyright page'],
      ['Table of contents', 'table of contents'],
      ['word0 word1 word2 word3 word4 word5 word6 word7…', undefined],
      ['word0 word1 word2 word3 word4 word5 word6 word7…', undefined],
    ]);
  });

  it('suggests nothing for ordinary text', () => {
    expect(planSections(`${body(400)}\n\n${body(400)}`, undefined, split).every((p) => !p.suggestion)).toBe(true);
  });
});
