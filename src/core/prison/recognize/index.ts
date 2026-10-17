/**
 * Распознавание экрана тюрьмы: кадр → ScreenView. Чистый TypeScript без
 * Electron и нативных модулей — для потока подсказок и тестов.
 *
 * Геометрию (где доска) ищет `calibrate` — редко: первая доска, смена
 * разрешения. `read` принимает найденную раньше геометрию и возвращает ту,
 * что стоит хранить дальше.
 */
import type { ScreenView } from '../view.js';
import { readBoard } from './board.js';
import type { BoardTemplates } from './board.js';
import { boardScore, calibrate, defaultGeometry } from './geometry.js';
import { pickHeader, readPick, readTreasure } from './pick.js';
import { boardTemplate, cellsTemplate, digitsTemplate, screensTemplate } from './templates.js';
import type { Frame, Geometry } from './types.js';

export { calibrate } from './geometry.js';
export type { Frame, Geometry } from './types.js';

/** Доля подписей номеров, при которой экран считается доской. */
const BOARD_MIN = 0.6;

let templates: BoardTemplates | null = null;

function boardTemplates(): BoardTemplates {
  templates ??= { cells: cellsTemplate(), screens: screensTemplate(), digits: digitsTemplate() };
  return templates;
}

/**
 * Что на кадре. geo — геометрия с прошлых кадров (или null). Возвращает
 * экран и геометрию для следующих кадров: найденную доску или прежнюю.
 */
export function read(frame: Frame, geo: Geometry | null): { view: ScreenView; geo: Geometry | null } {
  const t = boardTemplates();
  const bt = boardTemplate();
  const known = geo && geo.width === frame.width && geo.height === frame.height ? geo : null;

  if (known && boardScore(frame, known, bt) >= BOARD_MIN) {
    return { view: { screen: 'board', board: readBoard(frame, known, t) }, geo: known };
  }

  // Экраны без доски — в том же масштабе интерфейса, что и доска.
  const plain = known ?? defaultGeometry(frame);
  // Сокровищница раньше выбора: её заголовок стоит там же.
  const gifts = readTreasure(frame, plain, t.screens);
  if (gifts) return { view: { screen: 'treasure', gifts }, geo: known };
  const kind = pickHeader(frame, plain, t.screens);
  if (kind) return { view: { screen: 'pick', pick: readPick(frame, plain, t.screens, kind) }, geo: known };

  // При том же размере кадра доска стоит на месте: раз подписей нет, это
  // другой экран (событие, бунт). Калибровка — только без геометрии.
  if (known) return { view: { screen: 'other' }, geo: known };
  const found = calibrate(frame, bt);
  if (found && found.score >= BOARD_MIN) {
    return { view: { screen: 'board', board: readBoard(frame, found, t) }, geo: found };
  }
  return { view: { screen: 'other' }, geo: null };
}
