import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { MapNames, type MapCatalogue } from '../src/core/mapNames.js';

const catalogue: MapCatalogue = {
  assets: {
    DD_ShengTingZhuangYuan: 'Hideout - Sacred Court Manor',
    DD_ShengTingZhuangYuan000: 'Voidlands - Mundane Palace',
    YL_BeiFengLinDi: 'Grimwind Woods',
    JH_TongKuMiDian: 'Steel Forge - Shrine of Punishment',
    SD_JiangShengChao: 'Steel Forge - Wall of the Pure',
  },
  ambiguous: {
    YL_BeiFengLinDi: { '6': 'Glacial Abyss - Grimwind Woods', '54': 'Voidlands - Grimwind Woods' },
  },
  levelIds: { '3026': 'Steel Forge - Imaginary Monument' },
  ru: {
    'Mundane Palace': 'Царские покои',
    'Grimwind Woods': 'Лес ветров скорби',
    'Shrine of Punishment': 'Храм горестей',
    'Wall of The Pure': 'Стена беспорочности',
  },
};

describe('названия карт', () => {
  const names = new MapNames(catalogue);

  it('ассет с номером экземпляра опознаётся по шаблону внутри имени', () => {
    expect(names.lookup('JH_TongKuMiDian000', 5035)).toEqual({
      en: 'Shrine of Punishment',
      ru: 'Храм горестей',
      plane: 'Steel Forge',
    });
  });

  it('длинный шаблон важнее короткого: карта Инобытия — не убежище', () => {
    // Короткий шаблон тоже входит в имя ассета; без приоритета длинного
    // карта называлась бы «Hideout - Sacred Court Manor».
    expect(names.lookup('DD_ShengTingZhuangYuan000', 5057)?.en).toBe('Mundane Palace');
  });

  it('общая для двух планов сцена различается двумя последними цифрами LevelId', () => {
    expect(names.lookup('YL_BeiFengLinDi201', 5006)?.plane).toBe('Glacial Abyss');
    expect(names.lookup('YL_BeiFengLinDi201', 5354)?.plane).toBe('Voidlands');
    // Неизвестный суффикс — общее название без плана, а не догадка.
    expect(names.lookup('YL_BeiFengLinDi201', 5099)).toEqual({
      en: 'Grimwind Woods',
      ru: 'Лес ветров скорби',
      plane: null,
    });
  });

  it('босс и особые зоны — по LevelId, даже без ассета', () => {
    expect(names.lookup(null, 3026)?.en).toBe('Imaginary Monument');
  });

  it('русское название ищется без учёта регистра', () => {
    expect(names.lookup('SD_JiangShengChao000', 5028)?.ru).toBe('Стена беспорочности');
  });

  it('неизвестная карта не получает выдуманного названия', () => {
    expect(names.lookup('JH_YWMD_00002', 5055)).toBeNull();
    expect(names.lookup(null, 5348)).toBeNull();
  });
});

describe('собранный справочник data/maps.json', () => {
  const names = new MapNames(
    JSON.parse(readFileSync(new URL('../data/maps.json', import.meta.url), 'utf8')) as MapCatalogue,
  );

  it('называет фарм-карты по-русски — пары ассет и LevelId из живых логов', () => {
    // Пиньинь сцены обманывает: «TongKu» — «агония», а зона — Shrine of Punishment.
    expect(names.lookup('JH_TongKuMiDian000', 5035)?.en).toBe('Shrine of Punishment');
    expect(names.lookup('JH_YiWangMiDian000', 5050)?.en).toBe('Shrine of Agony');
    expect(names.lookup('YL_MaNeiLaYuLin100', 5348)?.ru).toBeTruthy();
    expect(names.lookup('KD_YuanSuKuangDong000', 5355)?.plane).toBe('Voidlands');
    expect(names.lookup('KD_YuanSuKuangDong000', 5012)?.plane).toBe('Blistering Lava Sea');
  });
});
