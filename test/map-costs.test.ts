import { describe, expect, it } from 'vitest';

import { EventParser } from '../src/core/eventParser.js';
import { InventoryTracker } from '../src/core/inventory.js';
import { RunSegmenter } from '../src/core/runSegmenter.js';
import { FE_ID, type Diagnostics, type EnterLevelEvent, type ItemDelta } from '../src/core/types.js';

function diag(): Diagnostics {
  return {
    linesTotal: 0,
    linesMatched: 0,
    unknownProtos: new Map(),
    unknownItemIds: new Map(),
    slotRebases: 0,
  };
}

const T0 = 1_700_000_000_000;

function cost(configBaseId: number, qty: number, ts: number): ItemDelta {
  return {
    ts,
    configBaseId,
    qty: -qty,
    proto: 'Spv3Open',
    kind: 'mapCost',
    pageId: 103,
    slotId: 0,
  };
}

function enter(areaId: number, ts: number): EnterLevelEvent {
  return { kind: 'enterLevel', ts, line: 1, areaId };
}

/**
 * Подлинная последовательность из лога за 10 августа:
 *
 *   12:05:06  Spv3Open → маяк 400033: 23 → 22
 *   12:05:06  ВХОД В ЗОНУ 5348
 *
 * Расход происходит в городе, до входа в карту.
 */
describe('забеги атрибутируются персонажу', () => {
  it('смена персонажа посреди файла делит забеги между ними', () => {
    const seg = new RunSegmenter();

    seg.setPlayer('956082728577617920');
    seg.noteAsset('YL_MaNeiLaYuLin100');
    seg.enterLevel(enter(5348, T0));

    // Перезаход другим персонажем: выбор идёт через хаб-сцены.
    seg.setPlayer('947836609175392256');
    seg.noteAsset('YL_MaNeiLaYuLin100');
    seg.enterLevel(enter(5351, T0 + 600_000));

    const runs = seg.finish(T0 + 700_000);
    expect(runs.find((r) => r.areaId === 5348)!.playerId).toBe('956082728577617920');
    expect(runs.find((r) => r.areaId === 5351)!.playerId).toBe('947836609175392256');
  });

  it('до первого входа персонаж неизвестен', () => {
    const seg = new RunSegmenter();
    seg.noteAsset('YL_MaNeiLaYuLin100');
    seg.enterLevel(enter(5348, T0));
    expect(seg.finish(T0 + 60_000)[0]!.playerId).toBeNull();
  });
});

describe('вложения принадлежат карте, а не городу', () => {
  it('маяк, потраченный в городе, приписывается следующей карте', () => {
    const seg = new RunSegmenter();

    seg.noteAsset('XZ_YuJinZhiXiBiNanSuo200'); // укрытие
    seg.enterLevel(enter(110, T0));

    // Игрок открывает карту, стоя в городе.
    seg.addDelta(cost(400033, 1, T0 + 60_000));

    seg.noteAsset('YL_MaNeiLaYuLin100');
    seg.enterLevel(enter(5348, T0 + 61_000));

    const runs = seg.finish(T0 + 120_000);
    const hub = runs.find((r) => r.areaId === 110)!;
    const map = runs.find((r) => r.areaId === 5348)!;

    expect(hub.costs).toHaveLength(0);
    expect(map.costs).toHaveLength(1);
    expect(map.costs[0]!.configBaseId).toBe(400033);
    expect(map.costs[0]!.qty).toBe(1);
  });

  it('расход внутри карты остаётся в ней', () => {
    const seg = new RunSegmenter();
    seg.noteAsset('YL_MaNeiLaYuLin100');
    seg.enterLevel(enter(5348, T0));
    seg.addDelta(cost(400033, 1, T0 + 5000));

    const runs = seg.finish(T0 + 60_000);
    expect(runs[0]!.costs).toHaveLength(1);
  });

  it('забытое вложение не приклеивается к забегу через полчаса', () => {
    const seg = new RunSegmenter();
    seg.noteAsset('XZ_YuJinZhiXiBiNanSuo200');
    seg.enterLevel(enter(110, T0));
    seg.addDelta(cost(400033, 1, T0 + 1000));

    seg.noteAsset('YL_MaNeiLaYuLin100');
    seg.enterLevel(enter(5348, T0 + 1_800_000)); // полчаса спустя

    const runs = seg.finish(T0 + 1_900_000);
    expect(runs.find((r) => r.areaId === 5348)!.costs).toHaveLength(0);
  });

  it('несколько вложений подряд уходят в одну карту', () => {
    const seg = new RunSegmenter();
    seg.noteAsset('XZ_YuJinZhiXiBiNanSuo200');
    seg.enterLevel(enter(110, T0));
    // Маяк и резонанс списываются одной транзакцией Spv3Open.
    seg.addDelta(cost(400033, 1, T0 + 1000));
    seg.addDelta(cost(5028, 4, T0 + 1000));

    seg.noteAsset('YL_MaNeiLaYuLin100');
    seg.enterLevel(enter(5348, T0 + 2000));

    const map = seg.finish(T0 + 60_000).find((r) => r.areaId === 5348)!;
    expect(map.costs.map((c) => c.configBaseId).sort((a, b) => a - b)).toEqual([5028, 400033]);
  });
});

function loot(configBaseId: number, qty: number, ts: number): ItemDelta {
  return {
    ts,
    configBaseId,
    qty,
    proto: 'PickItem',
    kind: 'loot',
    pageId: 102,
    slotId: 0,
  };
}

/**
 * Портал в город и обратно — один забег, а не два. Без склейки вторая
 * половина карты становилась отдельным забегом без вложений: счётчик
 * забегов раздувался, а стратегия с маяком теряла половину дохода.
 */
describe('возврат в ту же карту продолжает забег', () => {
  it('выход в хаб и возврат склеиваются в один забег', () => {
    const seg = new RunSegmenter();
    seg.noteAsset('XZ_YuJinZhiXiBiNanSuo200');
    seg.enterLevel(enter(110, T0));
    seg.addDelta(cost(400033, 1, T0 + 1000));

    seg.noteAsset('YL_MaNeiLaYuLin100');
    seg.enterLevel(enter(5348, T0 + 2000));
    seg.addDelta(loot(FE_ID, 10, T0 + 30_000));

    // Портал в город: продать добычу.
    seg.noteAsset('XZ_YuJinZhiXiBiNanSuo200');
    seg.enterLevel(enter(110, T0 + 60_000));

    // Возврат в ту же карту.
    seg.noteAsset('YL_MaNeiLaYuLin100');
    seg.enterLevel(enter(5348, T0 + 120_000));
    seg.addDelta(loot(FE_ID, 5, T0 + 150_000));

    const runs = seg.finish(T0 + 200_000);
    const farm = runs.filter((r) => !r.isHub);
    expect(farm).toHaveLength(1);
    expect(farm[0]!.costs).toHaveLength(1);
    expect(farm[0]!.drops.map((d) => d.qty)).toEqual([10, 5]);
    expect(farm[0]!.startedAt).toBe(T0 + 2000);
  });

  it('новая карта того же типа с новым вложением НЕ склеивается', () => {
    const seg = new RunSegmenter();
    seg.noteAsset('YL_MaNeiLaYuLin100');
    seg.enterLevel(enter(5348, T0));

    seg.noteAsset('XZ_YuJinZhiXiBiNanSuo200');
    seg.enterLevel(enter(110, T0 + 60_000));
    // В городе открыта НОВАЯ карта того же типа.
    seg.addDelta(cost(400033, 1, T0 + 65_000));

    seg.noteAsset('YL_MaNeiLaYuLin100');
    seg.enterLevel(enter(5348, T0 + 70_000));

    const farm = seg.finish(T0 + 120_000).filter((r) => !r.isHub);
    expect(farm).toHaveLength(2);
    expect(farm[1]!.costs).toHaveLength(1);
  });

  it('возврат спустя долгое время — новый забег', () => {
    const seg = new RunSegmenter();
    seg.noteAsset('YL_MaNeiLaYuLin100');
    seg.enterLevel(enter(5348, T0));

    seg.noteAsset('XZ_YuJinZhiXiBiNanSuo200');
    seg.enterLevel(enter(110, T0 + 60_000));

    seg.noteAsset('YL_MaNeiLaYuLin100');
    seg.enterLevel(enter(5348, T0 + 60_000 + 600_000)); // десять минут в городе

    const farm = seg.finish(T0 + 800_000).filter((r) => !r.isHub);
    expect(farm).toHaveLength(2);
  });

  it('другая карта между выходом и возвратом отменяет склейку', () => {
    const seg = new RunSegmenter();
    seg.noteAsset('YL_MaNeiLaYuLin100');
    seg.enterLevel(enter(5348, T0));

    seg.noteAsset('SD_YuanGuTongDao201');
    seg.enterLevel(enter(5351, T0 + 30_000));

    seg.noteAsset('YL_MaNeiLaYuLin100');
    seg.enterLevel(enter(5348, T0 + 60_000));

    const farm = seg.finish(T0 + 120_000).filter((r) => !r.isHub);
    expect(farm).toHaveLength(3);
  });
});

/**
 * Ответ биржи на дешёвые материалы приходит без поля currency.
 * Подлинный фрагмент лога для Пламенного песка (100200).
 */
describe('цена принимается и без поля currency', () => {
  const REQUEST = [
    '[2026.08.10-12.01.37:900][300]TLNetGame: Display: [Game] ----Socket SendMessage STT----XchgSearchPrice----SynId = 711',
    '[2026.08.10-12.01.37:900][300]TLNetGame: Display: [Game] ',
    '+filters+1+refer [100200]',
    '[2026.08.10-12.01.37:900][300]TLNetGame: Display: [Game] ----Socket SendMessage End----',
  ];

  const RESPONSE_NO_CURRENCY = [
    '[2026.08.10-12.01.37:968][300]TLNetGame: Display: [Game] ----Socket RecvMessage STT----XchgSearchPrice----SynId = 711',
    '[2026.08.10-12.01.37:968][300]TLNetGame: Display: [Game] ',
    '+prices+1+unitPrices+1 [0.0001000100010001]',
    '|      | |          +2 [0.0001000100010001]',
    '|      | |          +3 [0.0002000200020002]',
    '[2026.08.10-12.01.37:968][300]TLNetGame: Display: [Game] ----Socket RecvMessage End----',
  ];

  it('отсутствие currency означает ФЕ, а не отказ', () => {
    const parser = new EventParser();
    let observed = null;
    for (const line of [...REQUEST, ...RESPONSE_NO_CURRENCY]) {
      const ev = parser.parse(line);
      if (ev?.kind === 'priceObservation') observed = ev;
    }

    expect(observed).not.toBeNull();
    expect(observed!.configBaseId).toBe(100200);
    expect(observed!.currency).toBe(FE_ID);
    expect(observed!.unitPrices).toHaveLength(3);
  });

  it('явно чужая валюта по-прежнему отвергается', () => {
    const parser = new EventParser();
    const withCurrency = [...RESPONSE_NO_CURRENCY];
    withCurrency.splice(2, 0, '+prices+1+currency [999999]');

    let observed = null;
    for (const line of [...REQUEST, ...withCurrency]) {
      const ev = parser.parse(line);
      if (ev?.kind === 'priceObservation') observed = ev;
    }
    expect(observed!.currency).toBe(999999);
  });
});

describe('дельты расхода доходят до сегментатора', () => {
  it('полное списание слота даёт расход с идентификатором предмета', () => {
    const parser = new EventParser();
    const inv = new InventoryTracker(diag());
    const L = (b: string) => `[2026.08.10-12.05.06:000][1]TLLua: Display: [Game] ${b}`;

    inv.beginTransaction('PickItem');
    inv.applyInit(
      parser.parse(
        L('BagMgr@:InitBagData PageId = 103 SlotId = 0 ConfigBaseId = 400033 Num = 23'),
      ) as never,
    );

    inv.beginTransaction('Spv3Open');
    const delta = inv.applyModify(
      parser.parse(
        L('BagMgr@:Modfy BagItem PageId = 103 SlotId = 0 ConfigBaseId = 400033 Num = 22'),
      ) as never,
    );

    expect(delta).not.toBeNull();
    expect(delta!.kind).toBe('mapCost');
    expect(delta!.qty).toBe(-1);
  });
});
