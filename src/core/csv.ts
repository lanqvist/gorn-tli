/**
 * CSV для русского Excel.
 *
 * Excel с русской локалью ждёт «;» между полями и запятую в дробях,
 * а без BOM читает UTF-8 как cp1251 и превращает кириллицу в кракозябры.
 * Стандартный «,»-CSV открылся бы одной колонкой.
 */

export type CsvCell = string | number | null;

const SEPARATOR = ';';

function cell(value: CsvCell): string {
  if (value === null) return '';
  const text =
    typeof value === 'number'
      ? // Без разделителя тысяч: Excel принял бы «1 234» за текст.
        (Math.round(value * 100) / 100).toString().replace('.', ',')
      : value;
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: string[], rows: CsvCell[][]): string {
  const lines = [header, ...rows].map((r) => r.map(cell).join(SEPARATOR));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
