import { describe, expect, it } from 'vitest';
import { prepareCss } from './snapshot';

describe('prepareCss', () => {
  it('blanks addresses that would load from another site', () => {
    expect(prepareCss('a { background: url(/img/a.png) no-repeat; }')).toBe('a { background: url("data:,") no-repeat; }');
    expect(prepareCss('@font-face { src: url("https://x.test/f.woff2") format("woff2"); }')).toBe(
      '@font-face { src: url("data:,") format("woff2"); }',
    );
  });

  it('keeps embedded images and references inside the page', () => {
    const css = 'a { background: url(data:image/png;base64,AAAA); filter: url(#blur); }';
    expect(prepareCss(css)).toBe(css);
  });

  it('drops @import', () => {
    expect(prepareCss('@import url("other.css") screen;\nb { color: red; }').trim()).toBe('b { color: red; }');
  });
});
