/**
 * ГСЧ движка тюрьмы: одно uint32-состояние (mulberry32), детерминированный.
 *
 * Потоки по метке: stream('doors') даёт независимый генератор, чьё зерно
 * выведено из зерна родителя и метки. Так решатель может дать двум ходам
 * одни и те же «кости» для дверей, не завися от того, сколько чисел
 * съели события.
 */

/** Перемешивание 32 бит (финализатор murmur3). */
function mix32(x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

/** FNV-1a по строке. */
function hashLabel(label: string | number): number {
  if (typeof label === 'number') return mix32(label >>> 0);
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) h = Math.imul(h ^ label.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const TWO30 = 1073741824;
const INV30 = 1 / TWO30;

export class Rng {
  /**
   * Состояние — в типизированном массиве, а не в поле объекта: int32 вне
   * диапазона Smi в поле V8 упаковывает в кучу на каждой записи.
   */
  private readonly st = new Int32Array(2);

  constructor(seed = 1) {
    this.seed(seed);
  }

  /** Текущее состояние; можно сохранять и восстанавливать. */
  get s(): number {
    return this.st[0]! >>> 0;
  }
  set s(v: number) {
    this.st[0] = v;
  }

  /** Начать заново с зерна (без аллокаций). */
  seed(seed: number): this {
    this.st[0] = seed;
    this.st[1] = seed;
    return this;
  }

  /** Следующее uint32. */
  next(): number {
    const st = this.st;
    let t = (st[0] = (st[0]! + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /**
   * Следующие 30 бит. Внутренние броски берут их, а не next(): число до 2^30
   * V8 держит без упаковки в кучу, uint32 — нет, а горячий цикл не должен
   * аллоцировать.
   */
  bits30(): number {
    return this.next() >>> 2;
  }

  /** [0, 1), шаг 2^-30. */
  float(): number {
    return this.bits30() * INV30;
  }

  /** Целое [0, n), n ≤ 2^30. */
  int(n: number): number {
    return Math.floor(this.bits30() * INV30 * n);
  }

  /** true с вероятностью p. */
  chance(p: number): boolean {
    return this.bits30() < p * TWO30;
  }

  /** Независимый поток по метке: тот же родитель и метка → те же числа. */
  stream(label: string | number): Rng {
    return new Rng(mix32(this.st[1]! ^ hashLabel(label)));
  }

  /** Перезаправить существующий объект как поток родителя (без аллокаций). */
  streamInto(label: string | number, into: Rng): Rng {
    return into.seed(mix32(this.st[1]! ^ hashLabel(label)));
  }
}
