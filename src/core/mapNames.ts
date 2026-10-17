/**
 * Игровые названия карт по ассету и LevelId из лога.
 *
 * Ассет — художественная сцена, а не зона: одна сцена переиспользуется
 * в разных зонах, и её пиньинь обманывает (JH_TongKuMiDian — «агония»
 * по слогам, а в игре это Shrine of Punishment). Поэтому названия берутся
 * из справочника data/maps.json (scripts/build-maps.mjs): ассет и LevelId →
 * английское «План - Зона» по данным TITrack, английское → русское по tlidb.
 *
 * Неизвестная карта названия не получает: ошибочное название хуже
 * пиньиня — игрок перестанет верить остальным.
 */

export interface MapCatalogue {
  /** Шаблон ассета → «План - Зона». Шаблон ищется внутри имени ассета. */
  assets: Record<string, string>;
  /** Сцены, общие для нескольких зон: шаблон → {две последние цифры LevelId → название}. */
  ambiguous: Record<string, Record<string, string>>;
  /** Особые зоны (боссы, испытания) — по LevelId целиком. */
  levelIds: Record<string, string>;
  /** Английское название зоны → русское. */
  ru: Record<string, string>;
}

export interface MapName {
  /** Английское название зоны, без плана. */
  en: string;
  /** Русское название; null — перевода в справочнике нет. */
  ru: string | null;
  /** План по-английски («Voidlands»); null — у зоны плана нет. */
  plane: string | null;
}

export class MapNames {
  private readonly ru: Map<string, string>;
  /** Шаблоны от длинных к коротким: DD_ShengTingZhuangYuan000 важнее DD_ShengTingZhuangYuan. */
  private readonly patterns: Array<[string, string]>;
  private readonly cache = new Map<string, MapName | null>();

  constructor(private readonly catalogue: MapCatalogue) {
    // Регистр у источников расходится: «Wall of the Pure» и «Wall of The Pure».
    this.ru = new Map(Object.entries(catalogue.ru).map(([en, ru]) => [en.toLowerCase(), ru]));
    this.patterns = Object.entries(catalogue.assets).sort((a, b) => b[0].length - a[0].length);
  }

  /** Пустой справочник — когда data/maps.json не нашёлся. */
  static empty(): MapNames {
    return new MapNames({ assets: {}, ambiguous: {}, levelIds: {}, ru: {} });
  }

  lookup(asset: string | null, levelId: number): MapName | null {
    const key = `${asset ?? ''}#${levelId}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    const full = this.resolve(asset, levelId);
    const found = full ? this.split(full) : null;
    this.cache.set(key, found);
    return found;
  }

  /** Английское «План - Зона» или null. */
  private resolve(asset: string | null, levelId: number): string | null {
    const exact = this.catalogue.levelIds[String(levelId)];
    if (exact) return exact;
    if (!asset) return null;

    // Сцена, общая для нескольких зон, различается двумя последними
    // цифрами LevelId: 5354 и 506 — один и тот же лес в разных планах.
    for (const [pattern, bySuffix] of Object.entries(this.catalogue.ambiguous)) {
      if (!asset.includes(pattern)) continue;
      const name = bySuffix[String(levelId % 100)];
      if (name) return name;
    }

    for (const [pattern, name] of this.patterns) {
      if (asset.includes(pattern)) return name;
    }
    return null;
  }

  private split(full: string): MapName {
    const at = full.indexOf(' - ');
    const plane = at === -1 ? null : full.slice(0, at);
    const en = at === -1 ? full : full.slice(at + 3);
    return { en, ru: this.ru.get(en.toLowerCase()) ?? null, plane };
  }
}
