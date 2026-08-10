import feIcon from '../assets/fe.webp';

/**
 * Число в ФЕ вместе с иконкой валюты.
 *
 * Иконка масштабируется от размера шрифта (1em), поэтому один и тот же
 * компонент одинаково хорошо выглядит и в заголовке 48px, и в строке
 * таблицы 13px — без отдельных вариантов на каждый размер.
 *
 * Иконка лежит в репозитории, а не тянется из CDN: приложение должно
 * работать без интернета и не зависеть от чужого хостинга.
 */

interface FeProps {
  value: number;
  /** Знак «+» для положительных значений — для дельт. */
  signed?: boolean;
  fractionDigits?: number;
  className?: string;
}

const NBSP = ' ';

function format(value: number, fractionDigits: number): string {
  return new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })
    .format(value)
    .replace(/\s/g, NBSP);
}

export function Fe({ value, signed = false, fractionDigits = 0, className }: FeProps) {
  const rounded = fractionDigits === 0 ? Math.round(value) : value;
  const sign = signed && rounded > 0 ? '+' : '';
  const text = rounded < 0 ? `−${format(Math.abs(rounded), fractionDigits)}` : format(rounded, fractionDigits);

  return (
    <span className={`fe ${className ?? ''}`}>
      {sign}
      {text}
      <FeIcon />
    </span>
  );
}

/** Иконка отдельно — для заголовков колонок и подписей без числа. */
export function FeIcon() {
  return (
    <img
      className="fe-icon"
      src={feIcon}
      alt="ФЕ"
      title="Элементиевое пламя (Flame Elementium)"
      draggable={false}
      onError={(e) => {
        // Если ассет не загрузился, показываем искру, а не голый текст «ФЕ».
        const img = e.currentTarget;
        img.replaceWith(createFallback());
      }}
    />
  );
}

function createFallback(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'fe-icon');
  svg.setAttribute('aria-label', 'ФЕ');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute(
    'd',
    'M12 2c1.2 3.6 4.8 5.2 4.8 9.2A4.8 4.8 0 0 1 12 16a4.8 4.8 0 0 1-4.8-4.8C7.2 7.2 10.8 5.6 12 2Z',
  );
  path.setAttribute('fill', 'currentColor');
  svg.appendChild(path);
  return svg;
}
