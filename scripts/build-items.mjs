/**
 * Собирает data/items.json — справочник предметов для трекера.
 *
 * Входные данные не хранятся в репозитории (это выгрузки из сторонних
 * источников), путь передаётся аргументами:
 *
 *   node scripts/build-items.mjs <seed.json> <translations.json>
 *
 *   seed.json         — выгрузка tlidb: id, name_en, name_cn, type_cn, img
 *   translations.json — словарь ETor кит.→англ., нужен для перевода типов
 *
 * На выходе — плоский массив { id, name, nameCn, type, icon }.
 * Русские названия появятся на следующем этапе (глоссарий), пока английские.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const [seedPath, translationsPath] = process.argv.slice(2);
if (!seedPath) {
  console.error('Использование: node scripts/build-items.mjs <seed.json> [translations.json]');
  process.exit(1);
}

const seedRaw = JSON.parse(readFileSync(seedPath, 'utf8'));
// Выгрузка бывает и голым массивом, и объектом-обёрткой.
const seed = Array.isArray(seedRaw)
  ? seedRaw
  : (seedRaw.items ?? Object.values(seedRaw).find(Array.isArray));
if (!Array.isArray(seed)) {
  console.error('Не нашёл массив предметов в', seedPath);
  process.exit(1);
}

// Словарь ETor вложенный по секциям — расплющиваем в одну мапу.
const dict = new Map();
if (translationsPath) {
  const flatten = (obj) => {
    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (value && typeof value === 'object') flatten(value);
      else dict.set(key, value);
    }
  };
  flatten(JSON.parse(readFileSync(translationsPath, 'utf8')));
}

const items = seed.map((it) => ({
  id: Number(it.id),
  name: it.name_en || dict.get(it.name_cn) || it.name_cn,
  nameCn: it.name_cn ?? null,
  type: dict.get(it.type_cn) || it.type_cn || 'Unknown',
  typeCn: it.type_cn ?? null,
  icon: it.img ?? null,
}));

items.sort((a, b) => a.id - b.id);

mkdirSync('data', { recursive: true });
writeFileSync('data/items.json', JSON.stringify(items, null, 1), 'utf8');

const withEnglish = items.filter((i) => /[A-Za-z]/.test(i.name)).length;
console.log(`предметов: ${items.length}`);
console.log(`с английским названием: ${withEnglish}`);
console.log(`с иконкой: ${items.filter((i) => i.icon).length}`);
