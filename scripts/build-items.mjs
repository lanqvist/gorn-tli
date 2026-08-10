/**
 * Собирает data/items.json — справочник предметов для трекера.
 *
 *   node scripts/build-items.mjs <seed.json> [translations.json]
 *
 *   seed.json         — выгрузка tlidb: id, name_en, name_cn, type_cn, img
 *   translations.json — словарь ETor кит.→англ., нужен для перевода типов
 *
 * Русские названия берутся из словаря локализации tlidb, который скачивается
 * при сборке. Первоисточник — pak-файлы игры — недоступен: формат изменён
 * разработчиком, стандартной магии UE4 в них нет.
 *
 * Связка идёт по английскому названию, а не по слагу: у части предметов
 * слага в выгрузке нет, и по нему покрытие всего 27% против 96% по названию.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const TLIDB_RU = 'https://tlidb.com/i18n/autocomplete_ru.json';
const TLIDB_EN = 'https://tlidb.com/i18n/autocomplete_en.json';

const [seedPath, translationsPath] = process.argv.slice(2);
if (!seedPath) {
  console.error('Использование: node scripts/build-items.mjs <seed.json> [translations.json]');
  process.exit(1);
}

const seedRaw = JSON.parse(readFileSync(seedPath, 'utf8'));
const seed = Array.isArray(seedRaw)
  ? seedRaw
  : (seedRaw.items ?? Object.values(seedRaw).find(Array.isArray));
if (!Array.isArray(seed)) {
  console.error('Не нашёл массив предметов в', seedPath);
  process.exit(1);
}

// Словарь ETor вложенный по секциям — расплющиваем в одну мапу.
const cnToEn = new Map();
if (translationsPath) {
  const flatten = (obj) => {
    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (value && typeof value === 'object') flatten(value);
      else cnToEn.set(key, value);
    }
  };
  flatten(JSON.parse(readFileSync(translationsPath, 'utf8')));
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  return response.json();
}

console.log('Скачиваю словарь локализации tlidb…');
const [ru, en] = await Promise.all([fetchJson(TLIDB_RU), fetchJson(TLIDB_EN)]);
console.log(`  русских записей: ${ru.length}, английских: ${en.length}`);

const normalize = (s) => String(s).toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '');

const ruBySlug = new Map();
for (const entry of ru) if (!ruBySlug.has(entry.value)) ruBySlug.set(entry.value, entry);

const slugByEnName = new Map();
for (const entry of en) {
  const key = normalize(entry.label);
  if (!slugByEnName.has(key)) slugByEnName.set(key, entry.value);
}

/** Ручные правки для того, чего в словаре нет. Никогда не перезаписываются. */
const manual = existsSync('data/names-ru.json')
  ? JSON.parse(readFileSync('data/names-ru.json', 'utf8'))
  : {};

function lookupRu(nameEn) {
  const slug = slugByEnName.get(normalize(nameEn));
  return slug ? (ruBySlug.get(slug) ?? null) : null;
}

const items = seed.map((it) => ({
  id: Number(it.id),
  name: it.name_en || cnToEn.get(it.name_cn) || it.name_cn,
  nameCn: it.name_cn ?? null,
  type: cnToEn.get(it.type_cn) || it.type_cn || 'Unknown',
  typeCn: it.type_cn ?? null,
  icon: it.img ?? null,
  nameRu: null,
  typeRu: null,
}));

const byId = new Map(items.map((i) => [i.id, i]));

for (const item of items) {
  const manualEntry = manual[String(item.id)];
  if (manualEntry) {
    item.nameRu = manualEntry.name ?? null;
    item.typeRu = manualEntry.type ?? null;
    continue;
  }
  const found = lookupRu(item.name);
  if (found) {
    item.nameRu = found.label;
    // desc — это категория предмета на русском, если она не осталась английской.
    item.typeRu = /[а-яё]/i.test(found.desc ?? '') ? found.desc : null;
  }
}

// Связанные варианты (id базового + 1000) в словаре отсутствуют, но выводятся
// из базового: продать их нельзя, и в интерфейсе они должны быть узнаваемы.
let derived = 0;
for (const item of items) {
  if (item.nameRu) continue;
  if (!/^Bound /i.test(item.name)) continue;
  const base = byId.get(item.id - 1000);
  if (!base?.nameRu) continue;
  item.nameRu = `Связанный: ${base.nameRu}`;
  item.typeRu = base.typeRu;
  derived++;
}

items.sort((a, b) => a.id - b.id);

mkdirSync('data', { recursive: true });
writeFileSync('data/items.json', JSON.stringify(items, null, 1), 'utf8');

const withRu = items.filter((i) => i.nameRu).length;
const withTypeRu = items.filter((i) => i.typeRu).length;
console.log(`\nпредметов: ${items.length}`);
console.log(`с иконкой: ${items.filter((i) => i.icon).length}`);
console.log(
  `с русским названием: ${withRu} (${Math.round((withRu / items.length) * 100)}%), ` +
    `из них выведено от базового: ${derived}, вручную: ${Object.keys(manual).length - 1}`,
);
console.log(`с русским типом: ${withTypeRu}`);

const missing = items.filter((i) => !i.nameRu);
if (missing.length > 0) {
  console.log(`\nбез русского названия: ${missing.length}. Первые:`);
  for (const m of missing.slice(0, 10)) console.log(`  ${m.id}  ${m.name}`);
  console.log('Добавляйте их в data/names-ru.json.');
}
