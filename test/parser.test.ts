import { describe, expect, it } from 'vitest';

import { EventParser, parseBody, parseTimestamp } from '../src/core/eventParser.js';
import { isHubAsset, protoKind } from '../src/core/patterns.js';
import type { PriceObservationEvent } from '../src/core/types.js';

describe('категория лога не зашита жёстко', () => {
  // Именно на этом сломался ETor: у него зашито `GameLog:`, а с SS12
  // категория переименована в TLLua:/TLShipping:/TLNetGame:.
  const CATEGORIES = ['GameLog', 'TLLua', 'TLShipping', 'TLNetGame', 'TLGameplay'];

  for (const cat of CATEGORIES) {
    it(`распознаёт подбор в категории ${cat}:`, () => {
      const parser = new EventParser();
      const ev = parser.parse(
        `[2026.08.10-10.04.54:717][838]${cat}: Display: [Game] BagMgr@:Modfy BagItem PageId = 102 SlotId = 0 ConfigBaseId = 100300 Num = 6616`,
      );
      expect(ev?.kind).toBe('bagModify');
    });
  }
});

describe('разбор строк', () => {
  it('метка времени читается как UTC', () => {
    const ts = parseTimestamp('[2026.08.10-10.04.54:717][838]TLLua: Display: [Game] x');
    expect(ts).toBe(Date.UTC(2026, 7, 10, 10, 4, 54, 717));
  });

  it('вход в зону', () => {
    const parser = new EventParser();
    const ev = parser.parse(
      '[2026.08.10-10.04.10:790][601]TLLua: Display: [Game] LevelMgr:_EnterLevelSuccess() 5348',
    );
    expect(ev).toMatchObject({ kind: 'enterLevel', areaId: 5348 });
  });

  it('путь карты даёт имя ассета', () => {
    const parser = new EventParser();
    const ev = parser.parse(
      "[2026.08.09-19.34.10:007][495]TLLua: Display: [Game] LevelMgr@:LevelPath, Model = Content/Art/Maps/01SD/SD_YuanGuTongDao201/SD_YuanGuTongDao201.umap World'/Game/...'",
    );
    expect(ev).toMatchObject({ kind: 'levelPath', asset: 'SD_YuanGuTongDao201' });
  });

  it('SS13 переименовал PickItems в PickItem — понимаем оба', () => {
    expect(protoKind('PickItems')).toBe('loot');
    expect(protoKind('PickItem')).toBe('loot');
  });

  it('укрытие распознаётся как хаб', () => {
    expect(isHubAsset('XZ_YuJinZhiXiBiNanSuo200')).toBe(true);
    expect(isHubAsset('YL_MaNeiLaYuLin100')).toBe(false);
  });
});

describe('цены с биржи', () => {
  // Подлинный обмен из UE_game.log: запрос и ответ связаны по SynId.
  const REQUEST = [
    '[2026.08.09-19.58.29:724][248]TLNetGame: Display: [Game] ----Socket SendMessage STT----XchgSearchPrice----SynId = 96',
    '[2026.08.09-19.58.29:724][248]TLNetGame: Display: [Game] ',
    '+typ3 [13]',
    '+filters+1+refer [112410]',
    '|       | +key [16]',
    '[2026.08.09-19.58.29:724][248]TLNetGame: Display: [Game] ----Socket SendMessage End----',
  ];

  const RESPONSE = [
    '[2026.08.09-19.58.29:895][289]TLNetGame: Display: [Game] ----Socket RecvMessage STT----XchgSearchPrice----SynId = 96',
    '[2026.08.09-19.58.29:895][289]TLNetGame: Display: [Game] ',
    '+prices+1+currency [100300]',
    '|      | +unitPrices+1 [12.5]',
    '|      | |          +2 [13.0]',
    '|      | |          +3 [20.0]',
    '[2026.08.09-19.58.29:895][289]TLNetGame: Display: [Game] ----Socket RecvMessage End----',
  ];

  it('связывает запрос и ответ по SynId и достаёт цены', () => {
    const parser = new EventParser();
    let observation: PriceObservationEvent | null = null;
    for (const line of [...REQUEST, ...RESPONSE]) {
      const ev = parser.parse(line);
      if (ev?.kind === 'priceObservation') observation = ev;
    }

    expect(observation).not.toBeNull();
    expect(observation!.configBaseId).toBe(112410);
    expect(observation!.currency).toBe(100300);
    expect(observation!.unitPrices).toEqual([12.5, 13.0, 20.0]);
  });

  it('ответ без парного запроса игнорируется', () => {
    const parser = new EventParser();
    let seen = false;
    for (const line of RESPONSE) {
      if (parser.parse(line)?.kind === 'priceObservation') seen = true;
    }
    expect(seen).toBe(false);
  });

  it('время наблюдения берётся из лога, а не из часов трекера', () => {
    const parser = new EventParser();
    let observation: PriceObservationEvent | null = null;
    for (const line of [...REQUEST, ...RESPONSE]) {
      const ev = parser.parse(line);
      if (ev?.kind === 'priceObservation') observation = ev;
    }
    // Иначе ретро-скан старых логов записал бы всю историю цен сегодняшним числом.
    expect(observation!.ts).toBe(Date.UTC(2026, 7, 9, 19, 58, 29, 895));
  });

  it('отступное тело разворачивается в плоские поля', () => {
    const fields = parseBody(['+prices+1+currency [100300]', '|      | +unitPrices+1 [7.5]']);
    expect(fields.get('currency')).toBe('100300');
    expect([...fields.entries()].some(([k, v]) => k.startsWith('unitPrices') && v === '7.5')).toBe(
      true,
    );
  });
});
