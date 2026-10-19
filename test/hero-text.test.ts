import { describe, expect, it } from 'vitest';

import { spreadText } from '../src/renderer/heroText.js';

describe('пояснение к широкому разбросу', () => {
  it('обещает устойчивость, только пока забегов меньше порога', () => {
    expect(spreadText(10, true)).toMatch(/после 15 забегов/);
    expect(spreadText(23, true)).toMatch(/после 50 забегов/);
  });

  it('при 627 забегах не обещает «после 50»', () => {
    const text = spreadText(627, true);
    expect(text).not.toMatch(/после/);
    expect(text).toMatch(/стратегиях и картах/);
  });

  it('узкий разброс или нет забегов — без пояснения', () => {
    expect(spreadText(627, false)).toBeNull();
    expect(spreadText(0, true)).toBeNull();
  });
});
