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
