import { describe, expect, it } from 'vitest';
import { PrisonPresence } from '../../src/core/prison/presence.js';

// Строки лога игры 19.10 (забег 20:11 и фарм после него).
const ENTRY = '[2026.10.19-17.11.26:453][250]TLLua: Display: [Game] PageStack@ CurRunView = 4116_S16GamePlayEntryCtrl';
const OPEN = '[2026.10.19-17.11.26:401][249]TLLua: Display: [Game] PageBase@ OpenFlow5! OpenView S16GamePlayEntry';
const BOARD = '[2026.10.19-17.14.43:912][290]TLLua: Display: [Game] PageStack@ CurRunView = 4150_S16BoardMainCtrl';
const DAY = '[2026.10.19-17.15.55:503][555]TLLua: Display: [Game] [S16LastDay] check cur=20 max=20 played=false';
const CHECKOUT = '[2026.10.19-17.14.44:171][341]TLLua: Display: [Game] PageStack@ CurRunView = 4477_S16GamePlayCheckOutCtrl';
const LOADING = '[2026.10.19-17.14.47:359][100]TLLua: Display: [Game] PageStack@ CurRunView = 4503_LoadingCtrl';
const FIGHT = '[2026.10.19-17.15.56:094][610]TLLua: Display: [Game] PageStack@ CurRunView = 6612_FightCtrl';
const FIGHT_HIDE = '[2026.10.19-17.20.52:367][300]TLLua: Display: [Game] PageStack@                  CurRunView = 6355_FightCtrl Calling OnLeaveHide!';
// Сезонные монстры и сундуки на обычной карте: «S16» есть, тюрьмы нет.
const MONSTERS = [
  "[2026.10.19-17.21.37:131][428]TLShipping: Display: [Game] AssetLoad@ AsyncLoadRequest! PathStr = AM_ZaiJinRenYaShou_S16_Skill' LoadingNum = 12",
  "[2026.10.19-17.21.37:139][430]TLShipping: Display: [Game] AssetLoad@ OnEachTaskCompleted! MI_ZaiJinELang_S16'",
  "[2026.10.19-17.21.41:509][349]LogDataTable: Warning: UDataTable::FindRow : 'Play_Monster_Elite_Skill_ZaiJin_RenYaS16_SuoLian_Red' requested row 'Play_Monster_Elite_Skill_ZaiJin_RenYaS16_SuoLian_Red' not in DataTable",
  '[2026.10.19-17.22.40:010][900]TLLua: Display: [Game] AudioMgr@PlayAudio  AudioEnum  == UI_S16_Red_Chest',
];

describe('в тюрьме ли игрок', () => {
  it('монстры и сундуки сезона на карте — не тюрьма (19.10: поток экрана держался весь фарм)', () => {
    const p = new PrisonPresence();
    expect(p.feed([FIGHT, ...MONSTERS])).toBeNull();
    expect(p.inside).toBe(false);
  });

  it('вход, окна тюрьмы, выход в бой', () => {
    const p = new PrisonPresence();
    expect(p.feed([OPEN])).toBe('enter');
    expect(p.feed([ENTRY, BOARD, CHECKOUT])).toBeNull();
    expect(p.inside).toBe(true);
    // Монстры сезона в тюрьме ничего не меняют.
    expect(p.feed(MONSTERS)).toBeNull();
    expect(p.feed([LOADING])).toBe('leave');
    expect(p.feed([FIGHT, ...MONSTERS])).toBeNull();
    expect(p.inside).toBe(false);
  });

  it('выход и возврат в одной пачке — без смены; итог пачки по последней строке', () => {
    const p = new PrisonPresence();
    p.feed([BOARD]);
    expect(p.feed([FIGHT, BOARD])).toBeNull();
    expect(p.feed([CHECKOUT, DAY, FIGHT])).toBe('leave');
  });

  it('Горн запущен посреди забега: тюрьма по строке интерфейса', () => {
    const p = new PrisonPresence();
    expect(p.feed([DAY])).toBe('enter');
  });

  it('строка «Calling OnLeaveHide» — не смена окна', () => {
    const p = new PrisonPresence();
    p.feed([BOARD]);
    expect(p.feed([FIGHT_HIDE])).toBeNull();
    expect(p.inside).toBe(true);
  });
});
