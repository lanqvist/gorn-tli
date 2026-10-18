import { describe, expect, it } from 'vitest';

import { findings, splitRuns, summary, type FrameRec } from '../../src/cli/prison-audit-core.js';

const head = (file: string, kind: string, fresh = false) => ({ file, kind, fresh });

function rec(time: string, over: Partial<FrameRec> = {}, mem: Partial<FrameRec['mem']> = {}): FrameRec {
  return {
    file: `${time}-000-board.json`, time, kind: 'board', hasPng: true, logDay: null, live: 'Иди в №3', screen: 'patrol', actionable: true,
    pickUnknown: 0, mine: 'Иди в №3', best: 5, liveGap: null,
    mem: { day: 3, dayLimit: 20, storage: 1, tools: ['coin'], assumed: [], step: 'patrol', start: 'none', ...mem },
    ...over,
  };
}

describe('аудит забегов: разбивка кадров', () => {
  it('забег — с окна цели и выбора орудий в начале; хвост прошлого забега отдельно', () => {
    const runs = splitRuns([
      head('100000', 'board'),
      head('100500', 'objective'),
      head('100503', 'instruments', true),
      head('100506', 'instruments', true), // после «Обновить» — тот же забег
      head('100510', 'board'),
      head('101000', 'theme'),
      head('101003', 'objective'),
      head('101006', 'instruments', true),
      head('101010', 'board'),
    ]);
    expect(runs).toEqual([
      { from: 0, to: 0, start: false },
      { from: 1, to: 4, start: true },
      { from: 5, to: 8, start: true },
    ]);
  });
});

describe('аудит забегов: находки', () => {
  it('подсказка молчала на кадре с ходом; неузнанная карта; иконка «предположительно»', () => {
    const f = findings([
      rec('120000', { live: '', mine: 'Метка добычи: №10', screen: 'manage' }),
      rec('120005', { kind: 'instruments', screen: 'pick', pickUnknown: 1 }),
      rec('120010', {}, { tools: ['coin', 'trap'], assumed: ['trap'] }),
    ]);
    expect(f.map((x) => x.kind)).toEqual(['зависание', 'карта', 'иконка']);
    expect(f[0]!.text).toContain('Метка добычи: №10');
  });

  it('скачок без хода (переподключение), откат хранилища, день не тот, живой совет хуже', () => {
    const f = findings([
      rec('130000', { best: 9.93 }, { storage: 8 }),
      rec('130030', { best: 8.17 }, { storage: 0 }),
      rec('130040', { best: 8.17, logDay: { cur: 5, max: 20 } }, { storage: 8 }),
      rec('130050', { best: 8.17, live: 'Иди в №16', mine: 'Иди в допросную', liveGap: 0.3 }, { storage: 8 }),
    ]);
    expect(f.map((x) => x.kind)).toEqual(['хранилище', 'скачок', 'день', 'расхождение']);
  });

  it('та же находка на кадрах подряд — одна, со счётчиком', () => {
    const f = findings([
      rec('160000', { live: '', mine: 'Метка добычи: №10', screen: 'manage' }),
      rec('160001', { live: '', mine: 'Метка добычи: №10', screen: 'manage' }),
      rec('160002', { live: '', mine: 'Метка добычи: №10', screen: 'manage' }),
    ]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: 'зависание', time: '16:00:00', count: 3 });
  });

  it('обычные переходы и окна выбора — не скачок; одиночный вариант без оценки пропускается', () => {
    const f = findings([
      rec('140000', { best: 5, screen: 'patrol' }),
      rec('140005', { best: 4.2, screen: 'manage', mine: 'Заменить' }),
      rec('140010', { best: 9, screen: 'treasure', mine: 'Взять: Багряное вино' }),
      rec('140015', { best: null, screen: 'chain', mine: 'Остановить цепочку' }),
      rec('140020', { best: 4.3, screen: 'manage', mine: 'Заменить' }),
    ]);
    expect(f).toEqual([]);
  });

  it('сводка: ожидание на первом обходе, итог по хранилищу, дни по логу', () => {
    const s = summary([
      rec('150000', { screen: 'pick', best: 3 }),
      rec('150005', { best: 4.5, logDay: { cur: 1, max: 30 } }, { storage: 0 }),
      rec('150010', { logDay: { cur: 30, max: 30 } }, { storage: 10, start: 'ironlaw' }),
    ]);
    expect(s).toMatchObject({ start: 4.5, prisms: 10, days: '30/30', theme: 'ironlaw' });
  });
});
