/** Идентификатор предмета в игре. Совпадает с ConfigBaseId в логе и с id в Rt-data.json. */
export type ConfigBaseId = number;

/** Flame Elementium — основная торговая валюта. Проверено на логах: PageId 102, SlotId 0. */
export const FE_ID: ConfigBaseId = 100300;

/** Flame Sand — низшая ступень топлива. */
export const FLAME_SAND_ID: ConfigBaseId = 100200;

/**
 * Связанные (непередаваемые) варианты предметов имеют id = базовый + 1000
 * и всегда стоят 0 ФЭ, потому что их нельзя продать.
 */
export const BOUND_ID_OFFSET = 1000;

/** Смысл транзакции. Определяется по ItemChange@ ProtoName. */
export type ProtoKind =
  | 'loot' // доход: подобрано с земли
  | 'mapCost' // расход: открытие карты
  | 'trade' // операции с биржей
  | 'neutral' // перекладывание, надевание, оценка — не доход и не расход
  | 'unknown'; // незнакомый протокол, попадает в самодиагностику

export interface LogEventBase {
  /** Момент события из метки лога, в миллисекундах epoch. */
  ts: number;
  /** Номер строки в файле — для диагностики и воспроизведения. */
  line: number;
}

/** BagMgr@:Modfy — слот сумки получил новое СОВОКУПНОЕ количество (не прирост). */
export interface BagModifyEvent extends LogEventBase {
  kind: 'bagModify';
  pageId: number;
  slotId: number;
  configBaseId: ConfigBaseId;
  /** Новый размер стака в слоте целиком. */
  num: number;
}

/** BagMgr@:InitBagData — снимок слота при полной синхронизации страницы. */
export interface BagInitEvent extends LogEventBase {
  kind: 'bagInit';
  pageId: number;
  slotId: number;
  configBaseId: ConfigBaseId;
  num: number;
}

/** BagMgr@:RemoveBagItem — слот очищен. */
export interface BagRemoveEvent extends LogEventBase {
  kind: 'bagRemove';
  pageId: number;
  slotId: number;
}

/** ItemChange@ ProtoName=X start|end — рамка транзакции вокруг изменений сумки. */
export interface ItemChangeEvent extends LogEventBase {
  kind: 'itemChange';
  proto: string;
  phase: 'start' | 'end';
}

/** LevelMgr:_EnterLevelSuccess(N) — вход в зону. */
export interface EnterLevelEvent extends LogEventBase {
  kind: 'enterLevel';
  areaId: number;
}

/** LevelMgr@:LevelPath — путь ассета карты, даёт человекочитаемое имя. */
export interface LevelPathEvent extends LogEventBase {
  kind: 'levelPath';
  /** Например SD_YuanGuTongDao201 */
  asset: string;
}

/** LevelMgr@ LevelUid, LevelType, LevelId — уточнение типа зоны. */
export interface LevelIdsEvent extends LogEventBase {
  kind: 'levelIds';
  levelUid: number;
  levelType: number;
  levelId: number;
}

/** Ответ биржи на пробивку цены: наблюдённые цены активных лотов. */
export interface PriceObservationEvent extends LogEventBase {
  kind: 'priceObservation';
  /** Предмет, который пробивали (из +filters+1+refer запроса). */
  configBaseId: ConfigBaseId;
  /** Валюта лотов, обычно FE_ID. */
  currency: ConfigBaseId;
  /** Цены за единицу по активным лотам. */
  unitPrices: number[];
  synId: number;
}

/** Имя персонажа и сезон — для скоупинга всех данных. */
export interface PlayerInfoEvent extends LogEventBase {
  kind: 'playerInfo';
  name?: string;
  seasonId?: number;
}

export type LogEvent =
  | BagModifyEvent
  | BagInitEvent
  | BagRemoveEvent
  | ItemChangeEvent
  | EnterLevelEvent
  | LevelPathEvent
  | LevelIdsEvent
  | PriceObservationEvent
  | PlayerInfoEvent;

/** Прирост или расход конкретного предмета, вычисленный из дельт слотов. */
export interface ItemDelta {
  ts: number;
  configBaseId: ConfigBaseId;
  /** Положительное — получено, отрицательное — израсходовано. */
  qty: number;
  proto: string;
  kind: ProtoKind;
  pageId: number;
  slotId: number;
}

/** Забег: отрезок между входом в зону и выходом из неё. */
export interface Run {
  areaId: number;
  asset: string | null;
  levelType: number | null;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  isHub: boolean;
  drops: ItemDelta[];
  costs: ItemDelta[];
}

/** Счётчики для экрана самодиагностики. */
export interface Diagnostics {
  linesTotal: number;
  linesMatched: number;
  unknownProtos: Map<string, number>;
  unknownItemIds: Map<ConfigBaseId, number>;
  /** Дельты, отброшенные из-за смены предмета в слоте. */
  slotRebases: number;
}
