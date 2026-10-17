import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { deltaKind, isMapKeyType } from '../src/core/patterns.js';
import { analyzeLogFile } from '../src/core/pipeline.js';
import { FE_ID } from '../src/core/types.js';

const SHACKLES = 10330; // Darkiron Shackles, сезонный компас SS14

const dir = mkdtempSync(join(tmpdir(), 'gorn-ss14-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function logFile(lines: string[]): string {
  const path = join(dir, `UE_game-${Math.random().toString(36).slice(2)}.log`);
  writeFileSync(path, lines.join('\n'), 'utf8');
  return path;
}

const L = (time: string, body: string) =>
  `[2026.10.16-${time}:000][ 1]TLLua: Display: [Game] ${body}`;

/**
 * Подлинная последовательность SS14 (16 октября, 18:35–18:38), сокращённая
 * до строк, которые читает трекер: старт сезонной механики списывает
 * три «Оковы» серверным Push2, через две минуты — вход в сезонную зону.
 */
const SEASON_ENTRY = [
  L('18.30.00', 'LevelMgr@ LevelUid, LevelType, LevelId = 111000 0 110'),
  L('18.30.00', 'LevelMgr@:LevelPath, Model = Content/Art/Maps/01SD/XZ_YuJinZhiXiBiNanSuo200/XZ_YuJinZhiXiBiNanSuo200.umap'),
  L('18.30.00', 'LevelMgr:_EnterLevelSuccess() 110'),
  L('18.30.01', `BagMgr@:InitBagData PageId = 103 SlotId = 11 ConfigBaseId = ${SHACKLES} Num = 7`),
  L('18.30.01', `BagMgr@:InitBagData PageId = 102 SlotId = 0 ConfigBaseId = ${FE_ID} Num = 1000`),
  L('18.35.45', 'ItemChange@ ProtoName=Push2 start'),
  L('18.35.45', `BagMgr@:Modfy BagItem PageId = 103 SlotId = 11 ConfigBaseId = ${SHACKLES} Num = 4`),
  L('18.35.45', 'ItemChange@ ProtoName=Push2 end'),
  L('18.37.43', 'LevelMgr@ LevelUid, LevelType, LevelId = 344 28 235501'),
  L('18.37.43', "LevelMgr@:LevelPath, Model = Content/Art/Season/S16/Maps/ZhongZuiDiYu/ZhongZuiDiYu.umap World'/Game/Art/Season/S16/Maps/ZhongZuiDiYu/ZhongZuiDiYu.ZhongZuiDiYu'"),
  L('18.37.43', 'LevelMgr:_EnterLevelSuccess() 235501'),
  L('18.38.10', 'ItemChange@ ProtoName=PickItems start'),
  L('18.38.10', `BagMgr@:Modfy BagItem PageId = 102 SlotId = 0 ConfigBaseId = ${FE_ID} Num = 1026`),
  L('18.38.10', 'ItemChange@ ProtoName=PickItems end'),
  L('18.38.46', 'LevelMgr@ LevelUid, LevelType, LevelId = 111000 0 110'),
  L('18.38.46', 'LevelMgr@:LevelPath, Model = Content/Art/Maps/01SD/XZ_YuJinZhiXiBiNanSuo200/XZ_YuJinZhiXiBiNanSuo200.umap'),
  L('18.38.46', 'LevelMgr:_EnterLevelSuccess() 110'),
];

describe('SS14: вход в сезонную зону стоит компасов', () => {
  it('списание «Оков» через Push2 становится вложением сезонной зоны', async () => {
    const result = await analyzeLogFile(logFile(SEASON_ENTRY), {
      isMapKey: (id) => id === SHACKLES,
    });
    const zone = result.runs.find((r) => r.areaId === 235501)!;

    expect(zone.asset).toBe('ZhongZuiDiYu');
    expect(zone.costs.map((c) => [c.configBaseId, c.qty])).toEqual([[SHACKLES, 3]]);
    expect(zone.drops.map((d) => [d.configBaseId, d.qty])).toEqual([[FE_ID, 26]]);
  });

  it('без справочника ключей поведение прежнее — Push2 нейтрален', async () => {
    const result = await analyzeLogFile(logFile(SEASON_ENTRY));
    expect(result.runs.find((r) => r.areaId === 235501)!.costs).toEqual([]);
  });

  it('заходы в тюрьму подряд — отдельные забеги, а не возврат через портал', async () => {
    // Подлинный ритм 17 октября: заходы с ежедневной доски в 10:28, 10:31
    // и 10:36, между ними — укрытие. Бесплатные, поэтому расход склейку
    // не остановит; раньше все три сливались в один забег с суммой добычи.
    const prison = (enter: string, pick: string, fe: number, leave: string) => [
      L(enter, 'LevelMgr@ LevelUid, LevelType, LevelId = 344 28 235501'),
      L(enter, "LevelMgr@:LevelPath, Model = Content/Art/Season/S16/Maps/ZhongZuiDiYu/ZhongZuiDiYu.umap World'/Game/Art/Season/S16/Maps/ZhongZuiDiYu/ZhongZuiDiYu.ZhongZuiDiYu'"),
      L(enter, 'LevelMgr:_EnterLevelSuccess() 235501'),
      L(pick, 'ItemChange@ ProtoName=PickItems start'),
      L(pick, `BagMgr@:Modfy BagItem PageId = 102 SlotId = 0 ConfigBaseId = ${FE_ID} Num = ${fe}`),
      L(pick, 'ItemChange@ ProtoName=PickItems end'),
      L(leave, 'LevelMgr@ LevelUid, LevelType, LevelId = 111000 0 110'),
      L(leave, 'LevelMgr@:LevelPath, Model = Content/Art/Maps/01SD/XZ_YuJinZhiXiBiNanSuo200/XZ_YuJinZhiXiBiNanSuo200.umap'),
      L(leave, 'LevelMgr:_EnterLevelSuccess() 110'),
    ];
    const result = await analyzeLogFile(
      logFile([
        L('10.20.00', 'LevelMgr@ LevelUid, LevelType, LevelId = 111000 0 110'),
        L('10.20.00', 'LevelMgr@:LevelPath, Model = Content/Art/Maps/01SD/XZ_YuJinZhiXiBiNanSuo200/XZ_YuJinZhiXiBiNanSuo200.umap'),
        L('10.20.00', 'LevelMgr:_EnterLevelSuccess() 110'),
        L('10.20.01', `BagMgr@:InitBagData PageId = 102 SlotId = 0 ConfigBaseId = ${FE_ID} Num = 1000`),
        ...prison('10.28.02', '10.29.00', 1030, '10.29.56'),
        ...prison('10.31.49', '10.32.30', 1050, '10.33.00'),
        ...prison('10.36.07', '10.37.40', 1066, '10.38.11'),
      ]),
    );
    const zones = result.runs.filter((r) => r.areaId === 235501);
    expect(zones.map((r) => r.drops.reduce((a, d) => a + d.qty, 0))).toEqual([30, 20, 16]);
  });

  it('обычная карта после похода в город по-прежнему один забег', async () => {
    const map = [
      L('11.00.00', 'LevelMgr@ LevelUid, LevelType, LevelId = 1091407 3 5055'),
      L('11.00.00', 'LevelMgr@:LevelPath, Model = Content/Art/Maps/05JH/JH_YWMD_00002/JH_YWMD_00002.umap'),
      L('11.00.00', 'LevelMgr:_EnterLevelSuccess() 5055'),
    ];
    const hub = (t: string) => [
      L(t, 'LevelMgr@ LevelUid, LevelType, LevelId = 111000 0 110'),
      L(t, 'LevelMgr@:LevelPath, Model = Content/Art/Maps/01SD/XZ_YuJinZhiXiBiNanSuo200/XZ_YuJinZhiXiBiNanSuo200.umap'),
      L(t, 'LevelMgr:_EnterLevelSuccess() 110'),
    ];
    const result = await analyzeLogFile(
      logFile([...hub('10.59.00'), ...map, ...hub('11.02.00'), ...map.map((l) => l.replace('11.00.00', '11.03.00')), ...hub('11.05.00')]),
    );
    expect(result.runs.filter((r) => r.areaId === 5055)).toHaveLength(1);
  });

  it('Push2 в плюс — награда, а не добыча и не вложение', () => {
    // В укрытии Push2 приносит маяки за задания: +10 Steel Forge Beacon.
    expect(deltaKind('Push2', 400021, 10, () => true)).toBe('neutral');
    // Минус по предмету, который ключом от карты не является, — тоже не вложение.
    expect(deltaKind('Push2', 100200, -2734, () => false)).toBe('neutral');
    expect(deltaKind('Push2', SHACKLES, -3, () => true)).toBe('mapCost');
  });

  it('ключи от карт — компас, сезонный компас и маяк', () => {
    expect(isMapKeyType('罗盘')).toBe(true);
    expect(isMapKeyType('赛季罗盘')).toBe(true);
    expect(isMapKeyType('信标')).toBe(true);
    expect(isMapKeyType('通用道具')).toBe(false);
    expect(isMapKeyType(null)).toBe(false);
  });
});
