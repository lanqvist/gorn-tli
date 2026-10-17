import type { ConfigBaseId, ProtoKind } from './types.js';

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

/**
 * LevelMgr@:LevelPath, Model = Content/Art/Maps/01SD/SD_YuanGuTongDao201/SD_YuanGuTongDao201.umap
 *
 * Ассет — папка, в которой лежит .umap, а не «второй уровень после Maps»:
 * с SS14 сезонные зоны живут в собственном дереве
 *   Content/Art/Season/S16/Maps/ZhongZuiDiYu/ZhongZuiDiYu.umap
 * и прежний шаблон их не видел — забег показывался как «Зона 235501».
 */
export const LEVEL_PATH_RE = new RegExp(
  CATEGORY +
    String.raw`LevelMgr@:LevelPath,\s*Model\s*=\s*Content/Art/(?:[^\s/]+/)*([^\s/]+)/[^\s/]+\.umap`,
);

export const LEVEL_IDS_RE = new RegExp(
  CATEGORY +
    String.raw`LevelMgr@\s+LevelUid,\s*LevelType,\s*LevelId\s*=\s*(\d+)\s+(\d+)\s+(\d+)`,
);

/**
 * Вход персонажем:
 * PlayerIdTrace@SelectRoleNetMgr:_UserLoginStep3 buildLoginParm
 *   playerId=956082728577617920 saveInfoPlayerId=… userId=…
 *
 * Id захватывается строкой: он не помещается в double.
 */
export const PLAYER_LOGIN_RE = new RegExp(
  CATEGORY +
    String.raw`PlayerIdTrace@SelectRoleNetMgr:_UserLoginStep3\s+buildLoginParm\s+playerId=(\d+)`,
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
  // SS14: всё это происходит в укрытии и к фарму карт не относится —
  // ковка, сезонная доска (ReCostItem тратит Energy Core), плиты талантов,
  // снятие навыка, сундук наград. Перебор аффиксов карты сумку не трогает.
  ChooseForgeItem: 'neutral',
  ReCostItem: 'neutral',
  TalentBlockEquip: 'neutral',
  TalentBlockUnequip: 'neutral',
  TalentBlockEnhance: 'neutral',
  TalentBlockReshape: 'neutral',
  TalentBlockRotate: 'neutral',
  UnequipSkill: 'neutral',
  OpenRewardBox: 'neutral',
  Spv3RefreshAffix: 'neutral',
};

export function protoKind(proto: string): ProtoKind {
  return PROTO_KINDS[proto] ?? 'unknown';
}

/**
 * Типы предметов-ключей от карт по type_cn справочника: компас, сезонный
 * компас, маяк. Ни на что, кроме открытия карт и сезонных зон, они
 * не тратятся.
 */
const MAP_KEY_TYPES_CN = new Set(['罗盘', '赛季罗盘', '信标']);

export function isMapKeyType(typeCn: string | null | undefined): boolean {
  return typeCn != null && MAP_KEY_TYPES_CN.has(typeCn);
}

/** Является ли предмет ключом от карты — знает справочник, а не ядро. */
export type MapKeyLookup = (id: ConfigBaseId) => boolean;

/**
 * Смысл конкретного изменения сумки: протокол плюс то, что изменилось.
 *
 * Push2 — серверная правка сумки — в общем случае нейтрален: им приходят
 * награды за задания и сезонную доску. Но с SS14 им же списываются
 * сезонные компасы («Оковы») при старте сезонной механики: кнопка
 * Btn_S16GamePlay_Start → Push2 «Darkiron Shackles 7 → 4» → через пару
 * минут вход в зону ZhongZuiDiYu. Без этого правила сезонная зона
 * выглядела бесплатной, и её доход был завышен ровно на компасы.
 * Перекладывания компасов Push2 в логах SS14 не встречается ни разу —
 * только списания, поэтому минус по ключу от карты — это вложение.
 */
export function deltaKind(
  proto: string,
  configBaseId: ConfigBaseId,
  qty: number,
  isMapKey?: MapKeyLookup,
): ProtoKind {
  if (proto === 'Push2' && qty < 0 && isMapKey?.(configBaseId)) return 'mapCost';
  return protoKind(proto);
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

/**
 * Зоны-испытания, где каждый вход — новый забег, а не возврат через портал.
 *
 * SS14: сезонная тюрьма (ZhongZuiDiYu, LevelType 28) открывается кнопкой
 * старта — с доски (Btn_S16GamePlay_CheckOut_StartChallenge) или за «Оковы»
 * (Btn_S16GamePlay_Start), — и выход из неё всегда ведёт в укрытие.
 * Портала обратно нет. Заходы с доски бесплатны, и без этого правила
 * два-три подряд в пределах окна возврата склеивались в один забег
 * с суммой добычи: 11 заходов за утро давали 9 забегов.
 */
const CHALLENGE_LEVEL_TYPES = new Set([28]);

export function isChallengeLevel(levelType: number | null): boolean {
  return levelType !== null && CHALLENGE_LEVEL_TYPES.has(levelType);
}
