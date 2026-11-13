import { describe, expect, it } from 'vitest';
import { createPageLocator, joinPages, mapSectionsToPages, matchShare, pageAtWord, paragraphStarts } from './pageMap';

const pages = [
  ['A Short Book', 'By Someone'],
  ['Chapter one begins here. It has two sentences.', 'A paragraph that runs over the page'],
  ['break and ends on the next one.', 'Chapter two is the last chapter.'],
];

describe('joinPages', () => {
  it('joins a paragraph that was cut by a page break', () => {
    expect(joinPages(pages.slice(1))).toBe(
      'Chapter one begins here. It has two sentences.\n\n' +
        'A paragraph that runs over the page break and ends on the next one.\n\n' +
        'Chapter two is the last chapter.',
    );
  });

  it('copes with empty pages', () => {
    expect(joinPages([['One.'], [], ['Two.']])).toBe('One.\n\nTwo.');
  });
});

describe('mapSectionsToPages', () => {
  it('gives each section the page it starts on', () => {
    const map = mapSectionsToPages(pages, [
      'A Short Book\n\nBy Someone',
      'Chapter one begins here. It has two sentences.',
      'Chapter two is the last chapter.',
    ]);
    expect(map.map((starts) => starts[0])).toEqual([
      { page: 1, word: 0 },
      { page: 2, word: 0 },
      { page: 3, word: 0 },
    ]);
  });

  it('records the word where a section crosses onto the next page', () => {
    const [starts] = mapSectionsToPages(pages, [joinPages(pages.slice(1))]);
    // "break" is the 16th word: 8 in the first paragraph, then 7 before it.
    expect(starts).toEqual([
      { page: 2, word: 0 },
      { page: 3, word: 15 },
    ]);
    expect(pageAtWord(starts, 14)).toBe(2);
    expect(pageAtWord(starts, 15)).toBe(3);
  });

  it('finds sections whose spacing and punctuation were edited', () => {
    const map = mapSectionsToPages(pages, ['chapter  TWO is the last chapter']);
    expect(map[0]).toEqual([{ page: 3, word: 0 }]);
  });

  it('finds a section that comes before the previous one', () => {
    const map = mapSectionsToPages(pages, ['Chapter two is the last chapter.', 'A Short Book']);
    expect(map.map((starts) => starts[0].page)).toEqual([3, 1]);
  });

  it('places text it cannot find after the previous section', () => {
    const map = mapSectionsToPages(pages, ['Chapter one begins here. It has two sentences.', 'Words the PDF never had.']);
    expect(map[1][0].page).toBe(2);
  });
});

describe('createPageLocator', () => {
  it('finds the page a passage starts on, however it is spaced', () => {
    const locate = createPageLocator(pages);
    expect(locate('A Short Book')).toBe(1);
    expect(locate('chapter one begins HERE. It has two sentences')).toBe(2);
    expect(locate('Chapter two is the last chapter.')).toBe(3);
  });

  it('is undefined for text that is not in the pages', () => {
    const locate = createPageLocator(pages);
    expect(locate('Words the PDF never had.')).toBeUndefined();
    expect(locate('')).toBeUndefined();
  });
});

describe('matchShare', () => {
  it('is the share of sections found in the pages', () => {
    expect(matchShare(pages, ['Chapter one begins here.', 'Chapter two is the last chapter.'])).toBe(1);
    expect(matchShare(pages, ['Chapter one begins here.', 'Something from another book.'])).toBe(0.5);
    expect(matchShare(pages, [])).toBe(0);
  });
});

describe('pageAtWord', () => {
  it('is undefined without page data', () => {
    expect(pageAtWord(undefined, 3)).toBeUndefined();
    expect(pageAtWord([], 3)).toBeUndefined();
  });
});

describe('paragraphStarts', () => {
  it('gives the word each paragraph starts at', () => {
    expect(paragraphStarts('One two three.\n\nFour five.\n\n\n\nSix.')).toEqual([
      { word: 0, text: 'One two three.' },
      { word: 3, text: 'Four five.' },
      { word: 5, text: 'Six.' },
    ]);
  });
});
