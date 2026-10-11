import { tr } from './i18n.js';

/**
 * Классы персонажей (HeroId из дампа GetPlayerData).
 *
 * Публичного соответствия id → имя нет: ни tlidb, ни выгрузки данных
 * numeric id героев не публикуют, а pak-файлы игры закрыты изменённым
 * форматом. Поэтому словарь заполняется по мере встречи id в живых логах
 * (свой id видно в шапке как «Герой N» — это сигнал дописать сюда строку).
 *
 * Ник аккаунта и уровень показываются всегда, так что неизвестный id
 * не мешает различать персонажей — он лишь выглядит суше.
 */
const HEROES = new Map<number, [ru: string, en: string]>([
  // Подтверждено владельцем персонажа на живом логе SS13.
  [1700, ['Селена', 'Selena']],
]);

/** Имя класса для показа. Неизвестный id — честное «Герой N». */
export function heroName(heroId: number | null): string | null {
  if (heroId === null) return null;
  const known = HEROES.get(heroId);
  return known ? tr(known[0], known[1]) : tr(`Герой ${heroId}`, `Hero ${heroId}`);
}
