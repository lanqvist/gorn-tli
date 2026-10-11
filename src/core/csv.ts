/**
 * CSV, который Excel открывает без мастера импорта.
 *
 * Excel берёт разделители из региональных настроек: русский ждёт «;»
 * между полями и запятую в дробях, английский — «,» и точку. Не угадали —
 * файл открывается одной колонкой. Без BOM Excel читает UTF-8 как cp1251
 * и превращает кириллицу в кракозябры.
 */

export type CsvCell = string | number | null;

export type CsvDialect = 'ru' | 'en';

const DIALECTS: Record<CsvDialect, { separator: string; decimal: string }> = {
  ru: { separator: ';', decimal: ',' },
  en: { separator: ',', decimal: '.' },
};

function cell(value: CsvCell, dialect: { separator: string; decimal: string }): string {
  if (value === null) return '';
  const text =
    typeof value === 'number'
      ? // Без разделителя тысяч: Excel принял бы «1 234» за текст.
        (Math.round(value * 100) / 100).toString().replace('.', dialect.decimal)
      : value;
  const needsQuotes = text.includes(dialect.separator) || /["\r\n]/.test(text);
  return needsQuotes ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: string[], rows: CsvCell[][], dialect: CsvDialect = 'ru'): string {
  const d = DIALECTS[dialect];
  const lines = [header, ...rows].map((r) => r.map((v) => cell(v, d)).join(d.separator));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
