/**
 * В тюрьме ли игрок — по строкам лога игры.
 *
 * Игра пишет текущее окно: «PageStack@ CurRunView = 4150_S16BoardMainCtrl».
 * Окна тюрьмы — S16…Ctrl; другое окно (бой, загрузка) — из тюрьмы вышли.
 * Строки интерфейса тюрьмы (S16Board…, S16GamePlay…, [S16LastDay]) — тоже
 * признак, что в тюрьме: Горн мог запуститься посреди забега, а смена окна
 * в логе уже прошла.
 *
 * «S16» само по себе — не признак: так названы и монстры сезона на обычных
 * картах (MI_ZaiJinELang_S16, …RenYaS16…), и их сундуки (UI_S16_Red_Chest).
 * По любому «S16» поток экрана держался открытым весь фарм (19.10 20:16).
 */

/** Строка интерфейса тюрьмы. */
export const PRISON_UI = /S16Board|S16GamePlay|\[S16LastDay\]/;

/** Смена текущего окна игры (строки «Calling OnLeaveHide» с отступом — не она). */
const VIEW = /PageStack@ CurRunView = \d+_(\w+?)Ctrl\b/;

export type PresenceChange = 'enter' | 'leave' | null;

export class PrisonPresence {
  inside = false;

  /** Строки лога по порядку; что изменилось за пачку. */
  feed(lines: readonly string[]): PresenceChange {
    const was = this.inside;
    for (const l of lines) {
      const m = VIEW.exec(l);
      if (m) this.inside = m[1]!.startsWith('S16');
      else if (PRISON_UI.test(l)) this.inside = true;
    }
    if (this.inside === was) return null;
    return this.inside ? 'enter' : 'leave';
  }
}
