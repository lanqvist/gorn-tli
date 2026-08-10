import type { ProtoKind } from './types.js';

/**
 * Категория лога НЕ фиксирована и меняется от сезона к сезону.
 * До SS12 это было `GameLog:`, с SS12 — `TLLua:` (сумка/предметы),
 * `TLShipping:` (уровни), `TLNetGame:` (сокет).
 *
 * Именно на этом сломался ETor: у него в tor/main.js зашито `GameLog:`,
 * поэтому на текущем клиенте он не видит ни одной строки.
 *
 * Мы матчим любую категорию.
 */
const CATEGORY = String.raw`\w+:\s*Display:\s*\[Game\]\s*`;

/** Метка времени UE: [2026.08.10-10.04.54:717][838] */
export const TIMESTAMP_RE =
  /^\[(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}):(\d{3})\]/;

/**
 * Num — это НОВЫЙ РАЗМЕР СТАКА в слоте, а не прирост.
 * Проверено на логах: 45 → 110 → 235 → 334 → ... для одного слота.
 * Суммирование Num завышает доход в разы.
 */
export const BAG_MODIFY_RE = new RegExp(
  CATEGORY +
    String.raw`BagMgr@:Modfy\s+BagItem\s+PageId\s*=\s*(\d+)\s+SlotId\s*=\s*(\d+)\s+ConfigBaseId\s*=\s*(\d+)\s+Num\s*=\s*(\d+)`,
);

export const BAG_INIT_RE = new RegExp(
  CATEGORY +
    String.raw`BagMgr@:InitBagData\s+PageId\s*=\s*(\d+)\s+SlotId\s*=\s*(\d+)\s+ConfigBaseId\s*=\s*(\d+)\s+Num\s*=\s*(\d+)`,
);

export const BAG_REMOVE_RE = new RegExp(
  CATEGORY + String.raw`BagMgr@:RemoveBagItem\s+PageId\s*=\s*(\d+)\s+SlotId\s*=\s*(\d+)`,
);

export const ITEM_CHANGE_RE = new RegExp(
  CATEGORY + String.raw`ItemChange@\s*ProtoName=(\w+)\s+(start|end)`,
);

/**
 * ItemChange@ Add Id=10321_25b2b109-… BagNum=1 in PageId=103 SlotId=53
 *
 * Игра пишет её, когда НОВЫЙ экземпляр предмета ложится в слот
 * (для роста существующего стака этой строки нет). Это единственный
 * способ увидеть дроп в слот, который был пуст при входе: пустые слоты
 * в InitBagData не попадают, и без этой строки первый предмет в таком
 * слоте выглядел бы как «установка базы», а не добыча.
 */
export const ITEM_ADD_RE = new RegExp(
  CATEGORY +
    String.raw`ItemChange@\s*Add\s+Id=(\d+)_[0-9a-fA-F-]+\s+BagNum=(\d+)\s+in\s+PageId=(\d+)\s+SlotId=(\d+)`,
);

export const ENTER_LEVEL_RE = new RegExp(
  CATEGORY + String.raw`LevelMgr:_EnterLevelSuccess\(\)\s*(\d+)`,
);

/** LevelMgr@:LevelPath, Model = Content/Art/Maps/01SD/SD_YuanGuTongDao201/... */
export const LEVEL_PATH_RE = new RegExp(
  CATEGORY + String.raw`LevelMgr@:LevelPath,\s*Model\s*=\s*Content/Art/Maps/[^/]+/([^/]+)/`,
);

export const LEVEL_IDS_RE = new RegExp(
  CATEGORY +
    String.raw`LevelMgr@\s+LevelUid,\s*LevelType,\s*LevelId\s*=\s*(\d+)\s+(\d+)\s+(\d+)`,
);

/** ----Socket SendMessage STT----XchgSearchPrice----SynId = 96 */
export const SOCKET_START_RE = new RegExp(
  CATEGORY + String.raw`-+Socket\s+(SendMessage|RecvMessage|PushMessage|RecvPushMsg)\s+STT-+([^-]+)-+SynId\s*=\s*(\d+)`,
);

export const SOCKET_END_RE = new RegExp(
  CATEGORY + String.raw`-+Socket\s+(?:SendMessage|RecvMessage|PushMessage|RecvPushMsg)\s+End-+`,
);

/**
 * Классификация ProtoName. От неё зависит, попадёт ли изменение сумки в доход.
 *
 * ⚠️ В SS13 протокол подбора переименован PickItems → PickItem (в логах есть оба).
 */
const PROTO_KINDS: Record<string, ProtoKind> = {
  // доход
  PickItem: 'loot',
  PickItems: 'loot',
  // расход на открытие карты
  Spv3Open: 'mapCost',
  ClimbTowerOpen: 'mapCost',
  // биржа
  XchgForSale: 'trade',
  XchgBuy: 'trade',
  XchgReceive: 'trade',
  XchgRecall: 'trade',
  // Торговец-NPC. Купленное — не дроп: иначе покупка компасов засчиталась бы
  // как добыча и завысила доход. Учёт потраченного у торговца — отдельная
  // задача, сейчас эти операции просто не влияют на цифры.
  BuyVendorGoods: 'neutral',
  RefreshVendorShop: 'neutral',
  // перекладывание и прочее, что нельзя считать доходом — иначе двойной счёт
  Push2: 'neutral',
  PutOn: 'neutral',
  PutOff: 'neutral',
  BuySkill: 'neutral',
  LockOrUnlockItem: 'neutral',
  Evaluate: 'neutral',
  EvaluateOneKey: 'neutral',
  ExchangeItem: 'neutral',
  MoveWareHouseItems2: 'neutral',
  MoveWareHouseItems: 'neutral',
  ResetItemsLayout: 'neutral',
  WashGeniusAllPoint: 'neutral',
};

export function protoKind(proto: string): ProtoKind {
  return PROTO_KINDS[proto] ?? 'unknown';
}

/**
 * Города и укрытия. Забеги в них не считаются фармом.
 * XZ_YuJinZhiXiBiNanSuo200 — Ember's Rest, основное укрытие.
 */
const HUB_ASSET_RE =
  /hideout|town|hub|lobby|social|LoginScene|SelectRole|YuJinZhiXiBiNanSuo|ZhuCheng/i;

export function isHubAsset(asset: string | null): boolean {
  return asset !== null && HUB_ASSET_RE.test(asset);
}
