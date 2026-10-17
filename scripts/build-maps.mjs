/**
 * Собирает data/maps.json — справочник названий карт.
 *
 *   node scripts/build-maps.mjs
 *
 * В логе у карты есть имя ассета (YL_MaNeiLaYuLin100) и LevelId (5348).
 * Ассет — это художественная сцена, а не зона: одна сцена переиспользуется
 * в разных зонах и планах, а её пиньинь часто обманывает — сцена
 * JH_TongKuMiDian («痛苦», «агония») на деле «Shrine of Punishment»,
 * тогда как «Shrine of Agony» — это JH_YiWangMiDian. Поэтому название
 * по слогам не угадываем, а берём из двух источников:
 *
 *  - TITrack (MIT, github.com/astockman99/TITrack, src/titrack/data/zones.py):
 *    ассет → английское «План - Зона», для неоднозначных сцен — по двум
 *    последним цифрам LevelId, для боссов и особых зон — по LevelId целиком.
 *    Его сопровождают по ходу сезонов, и он сверен с живыми логами игроков;
 *  - tlidb: списки зон каждого плана на английском и русском — по
 *    английскому названию из TITrack находится русское;
 *  - data/maps-manual.json — ручные записи поверх обоих (сезонные зоны,
 *    которых в источниках ещё нет). Его сборка только читает.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const TITRACK_ZONES =
  'https://raw.githubusercontent.com/astockman99/TITrack/master/src/titrack/data/zones.py';
/** Планы Инобытия и Дальний космос — слаги страниц tlidb. */
const PLANES = [
  'Glacial_Abyss',
  'Blistering_Lava_Sea',
  'Steel_Forge',
  'Thunder_Wastes',
  'Voidlands',
  'Deep_Space',
];

async function fetchText(url, check = () => true) {
  // tlidb изредка отдаёт пустую страницу под нагрузкой — несколько попыток
  // с паузой, а не одна: иначе справочник молча собирается дырявым.
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const text = await response.text();
        if (check(text)) return text;
      }
    } catch {
      // Сеть моргнула — повторяем.
    }
    await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
  }
  throw new Error(`${url}: не получилось скачать после четырёх попыток`);
}

// ── tlidb: зоны планов на двух языках ─────────────────────────────

const AREA_TAB = /id="[^"]*-Area" class=.tab-pane/;

/** Зоны плана со страницы: вкладка «…-Area», ссылки внутри её таблицы. */
function areaLinks(html) {
  const start = html.search(AREA_TAB);
  const end = html.indexOf('tab-pane', start + 40);
  const section = html.slice(start, end === -1 ? undefined : end);
  return [...section.matchAll(/<a href="([^"#]+)">([^<]+)<\/a>/g)].map((m) => ({
    slug: m[1],
    name: m[2].trim(),
  }));
}

const bySlug = new Map();
for (const plane of PLANES) {
  for (const lang of ['en', 'ru']) {
    const html = await fetchText(`https://tlidb.com/${lang}/${plane}`, (t) => AREA_TAB.test(t));
    for (const { slug, name } of areaLinks(html)) {
      const zone = bySlug.get(slug) ?? { slug };
      zone[lang] = name;
      bySlug.set(slug, zone);
    }
    // Вежливая пауза: чужой хобби-проект, не нагружаем его залпом.
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

/** Английское название → русское. Одна зона бывает в нескольких планах. */
const ru = {};
for (const zone of bySlug.values()) {
  if (zone.en && zone.ru) ru[zone.en] = zone.ru;
}

// ── TITrack: ассет и LevelId → английское название ───────────────

const source = await fetchText(TITRACK_ZONES, (t) => t.includes('ZONE_NAMES'));

/** Тело словаря Python `NAME = { ... }` — до закрывающей скобки в начале строки. */
function pyDict(name) {
  const start = source.indexOf(`${name} = {`);
  if (start === -1) throw new Error(`В zones.py нет ${name} — формат TITrack изменился`);
  const end = source.indexOf('\n}', start);
  return source.slice(start, end);
}

// Порядок записей сохраняется: он нужен лишь для отчёта, сопоставление
// в движке выбирает самый длинный подходящий шаблон.
const assets = Object.fromEntries(
  [...pyDict('ZONE_NAMES').matchAll(/^\s*"([^"]+)":\s*"([^"]+)"/gm)].map((m) => [m[1], m[2]]),
);

const ambiguous = {};
for (const block of pyDict('AMBIGUOUS_ZONES').matchAll(/"([^"]+)":\s*\{([^}]*)\}/g)) {
  ambiguous[block[1]] = Object.fromEntries(
    [...block[2].matchAll(/(\d+):\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]),
  );
}

const levelIds = Object.fromEntries(
  [...pyDict('LEVEL_ID_ZONES').matchAll(/^\s*(\d+):\s*"([^"]+)"/gm)].map((m) => [m[1], m[2]]),
);

// ── ручные записи ─────────────────────────────────────────────────

if (existsSync('data/maps-manual.json')) {
  const manual = JSON.parse(readFileSync('data/maps-manual.json', 'utf8'));
  Object.assign(assets, manual.assets ?? {});
  Object.assign(ru, manual.ru ?? {});
}

// ── отчёт и запись ────────────────────────────────────────────────

const zoneOf = (full) => (full.includes(' - ') ? full.split(' - ').slice(1).join(' - ') : full);
const names = new Set([
  ...Object.values(assets),
  ...Object.values(ambiguous).flatMap((m) => Object.values(m)),
  ...Object.values(levelIds),
]);
// Регистр у источников расходится («Wall of the Pure» и «Wall of The Pure»),
// движок сравнивает без него — отчёт тоже.
const ruLower = new Set(Object.keys(ru).map((k) => k.toLowerCase()));
const withoutRu = [...names].filter((n) => !ruLower.has(zoneOf(n).toLowerCase()));

writeFileSync(
  'data/maps.json',
  `${JSON.stringify(
    {
      _источники:
        'Ассеты и LevelId — TITrack (MIT, astockman99/TITrack, zones.py). Русские названия — tlidb.com по английскому. Собирается scripts/build-maps.mjs.',
      assets,
      ambiguous,
      levelIds,
      ru,
    },
    null,
    1,
  )}\n`,
);

console.log(
  `data/maps.json: ассетов ${Object.keys(assets).length}, неоднозначных ${
    Object.keys(ambiguous).length
  }, по LevelId ${Object.keys(levelIds).length}, русских названий ${Object.keys(ru).length}`,
);
if (withoutRu.length > 0) {
  console.log(`Без русского названия (останутся английскими): ${withoutRu.join('; ')}`);
}
