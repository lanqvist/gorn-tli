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

  it('покупка у торговца не является добычей', () => {
    // Найдено самодиагностикой на реальной сессии: без этого купленные
    // компасы засчитались бы в доход.
    expect(protoKind('BuyVendorGoods')).toBe('neutral');
    expect(protoKind('RefreshVendorShop')).toBe('neutral');
  });

  it('незнакомый протокол не считается добычей по умолчанию', () => {
    expect(protoKind('SomethingFromNextSeason')).toBe('unknown');
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

  it('отступное тело разворачивается в дерево по колонкам', () => {
    const body = parseBody(['+prices+1+currency [100300]', '|      | +unitPrices+1 [7.5]']);
    const prices = body.get('prices') as Map<string, unknown>;
    const group = prices.get('1') as Map<string, unknown>;
    expect(group.get('currency')).toBe('100300');
    expect((group.get('unitPrices') as Map<string, unknown>).get('1')).toBe('7.5');
  });

  /**
   * Подлинный ответ по Пламенному песку: две ценовые группы, вторая
   * в Пламенном песке. Плоский разбор сваливал цены обеих групп в кучу
   * и брал последнюю валюту, из-за чего цена в ФЕ терялась полностью.
   */
  const MULTI_CURRENCY = [
    '[2026.08.10-12.01.37:968][300]TLNetGame: Display: [Game] ----Socket RecvMessage STT----XchgSearchPrice----SynId = 711',
    '[2026.08.10-12.01.37:968][300]TLNetGame: Display: [Game] ',
    '+prices+1+unitPrices+1 [0.0001000100010001]',
    '|      | |          +2 [0.0002000200020002]',
    '|      | +currency [100300]',
    '|      +2+unitPrices+1 [55]',
    '|      | |          +2 [60]',
    '|      | +currency [100200]',
    '[2026.08.10-12.01.37:968][300]TLNetGame: Display: [Game] ----Socket RecvMessage End----',
  ];

  const REQUEST_SAND = [
    '[2026.08.10-12.01.37:900][300]TLNetGame: Display: [Game] ----Socket SendMessage STT----XchgSearchPrice----SynId = 711',
    '[2026.08.10-12.01.37:900][300]TLNetGame: Display: [Game] ',
    '+filters+1+refer [100200]',
    '[2026.08.10-12.01.37:900][300]TLNetGame: Display: [Game] ----Socket SendMessage End----',
  ];

  it('из нескольких валют берётся группа в ФЕ', () => {
    const parser = new EventParser();
    let observed: PriceObservationEvent | null = null;
    for (const line of [...REQUEST_SAND, ...MULTI_CURRENCY]) {
      const ev = parser.parse(line);
      if (ev?.kind === 'priceObservation') observed = ev;
    }

    expect(observed).not.toBeNull();
    expect(observed!.configBaseId).toBe(100200);
    expect(observed!.currency).toBe(100300);
    // Цены из группы за Пламенный песок (55, 60) не должны примешиваться.
    expect(observed!.unitPrices).toEqual([0.0001000100010001, 0.0002000200020002]);
  });

  it('потерянный маркер End не глушит парсер до конца сессии', () => {
    // Обрыв дампа (ротация, краш) раньше оставлял парсер в режиме
    // «копим тело» навсегда: все последующие события молча глотались.
    const parser = new EventParser();
    parser.parse(
      '[2026.08.09-19.58.29:724][248]TLNetGame: Display: [Game] ----Socket SendMessage STT----XchgSearchPrice----SynId = 96',
    );
    parser.parse('+filters+1+refer [112410]');
    // End потерян; приходит обычное событие сумки.
    const ev = parser.parse(
      '[2026.08.10-10.04.54:717][838]TLLua: Display: [Game] BagMgr@:Modfy BagItem PageId = 102 SlotId = 0 ConfigBaseId = 100300 Num = 6616',
    );
    expect(ev?.kind).toBe('bagModify');
  });

  it('новый дамп сбрасывает недописанный, а не приклеивается к нему', () => {
    const parser = new EventParser();
    let observed: PriceObservationEvent | null = null;
    const lines = [
      // Запрос по предмету 111111 — без End.
      '[2026.08.09-19.58.29:724][248]TLNetGame: Display: [Game] ----Socket SendMessage STT----XchgSearchPrice----SynId = 1',
      '+filters+1+refer [111111]',
      // Полный обмен по предмету 222222.
      '[2026.08.09-19.58.30:000][249]TLNetGame: Display: [Game] ----Socket SendMessage STT----XchgSearchPrice----SynId = 2',
      '+filters+1+refer [222222]',
      '[2026.08.09-19.58.30:000][249]TLNetGame: Display: [Game] ----Socket SendMessage End----',
      '[2026.08.09-19.58.30:100][250]TLNetGame: Display: [Game] ----Socket RecvMessage STT----XchgSearchPrice----SynId = 2',
      '+prices+1+currency [100300]',
      '|      | +unitPrices+1 [9999]',
      '[2026.08.09-19.58.30:100][250]TLNetGame: Display: [Game] ----Socket RecvMessage End----',
    ];
    for (const line of lines) {
      const ev = parser.parse(line);
      if (ev?.kind === 'priceObservation') observed = ev;
    }
    // Цены достались предмету 222222, а не зависшему 111111.
    expect(observed!.configBaseId).toBe(222222);
  });

  it('строки тела, приклеенные к префиксу лога, разбираются по тем же колонкам', () => {
    // Игра пишет часть тела через логгер: перед `+` стоит префикс с датой
    // и номером кадра, и колонки сдвинуты на его длину.
    const body = parseBody([
      '[2026.08.10-12.01.37:968][300]TLNetGame: Display: [Game] +prices+1+currency [100300]',
      '|      | +unitPrices+1 [7.5]',
    ]);
    const prices = body.get('prices') as Map<string, unknown>;
    const group = prices.get('1') as Map<string, unknown>;
    expect(group.get('currency')).toBe('100300');
    expect((group.get('unitPrices') as Map<string, unknown>).get('1')).toBe('7.5');
  });

  it('плюс внутри значения не ломает дерево', () => {
    // Экспоненциальная запись числа содержит `+` — это значение, а не ключ.
    const body = parseBody(['+unitPrices+1 [1e+06]']);
    const prices = body.get('unitPrices') as Map<string, unknown>;
    expect(prices.get('1')).toBe('1e+06');
  });

  it('если группы в ФЕ нет, валюта не подменяется на ФЕ', () => {
    // Иначе цена в песке была бы записана как цена в ФЕ — ошибка
    // в тысячи раз, причём в сторону завышения.
    const parser = new EventParser();
    const onlySand = [
      '[2026.08.10-12.01.37:968][300]TLNetGame: Display: [Game] ----Socket RecvMessage STT----XchgSearchPrice----SynId = 711',
      '[2026.08.10-12.01.37:968][300]TLNetGame: Display: [Game] ',
      '+prices+1+unitPrices+1 [55]',
      '|      | |          +2 [60]',
      '|      | +currency [100200]',
      '[2026.08.10-12.01.37:968][300]TLNetGame: Display: [Game] ----Socket RecvMessage End----',
    ];

    let observed: PriceObservationEvent | null = null;
    for (const line of [...REQUEST_SAND, ...onlySand]) {
      const ev = parser.parse(line);
      if (ev?.kind === 'priceObservation') observed = ev;
    }
    expect(observed!.currency).toBe(100200);
    expect(observed!.unitPrices).toEqual([55, 60]);
  });
});
