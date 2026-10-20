import { describe, expect, expectTypeOf, it } from 'vitest';

import * as model from '../../src/core/prison/model.js';
import * as view from '../../src/core/prison/view.js';

// view.ts (договор распознавания) и model.ts (движок) объявляют общие имена
// каждый у себя: разойдутся — распознанное орудие или зверь не найдётся в движке.
describe('общие имена распознавания и движка', () => {
  it('TOOL_IDS — те же и в том же порядке', () => {
    expect([...view.TOOL_IDS]).toEqual([...model.TOOL_IDS]);
  });

  it('Beast, Tier, ToolId, GiftId совпадают', () => {
    expectTypeOf<view.Beast>().toEqualTypeOf<model.Beast>();
    expectTypeOf<view.Tier>().toEqualTypeOf<model.Tier>();
    expectTypeOf<view.ToolId>().toEqualTypeOf<model.ToolId>();
    expectTypeOf<view.GiftId>().toEqualTypeOf<model.GiftId>();
    // Те же значения в рантайме: звери по порядку BEASTS.
    const beasts: view.Beast[] = ['mammoth', 'lion', 'wolf', 'rat'];
    expect(beasts).toEqual([...model.BEASTS]);
  });
});
