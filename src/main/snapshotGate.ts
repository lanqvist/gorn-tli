/**
 * Снимки трекера — в главное окно, только пока его видно.
 *
 * Свёрнутое или спрятанное в трей окно на каждый снимок (59 КБ, во время
 * карты — раз в 5 с и на каждое событие) пересобирало React-дерево всего
 * дашборда: ~3,5% ядра на окно, которое никто не видит (замер 19.10).
 * Теперь скрытое окно снимков не получает, а при показе ему уходит
 * последний — экран сразу свежий.
 */
export interface GateTarget<T> {
  /** Окно есть, показано и не свёрнуто. */
  visible(): boolean;
  send(snapshot: T): void;
}

export class SnapshotGate<T> {
  private latest: T | null = null;
  private stale = false;

  constructor(private readonly target: () => GateTarget<T> | null) {}

  push(snapshot: T): void {
    this.latest = snapshot;
    const t = this.target();
    if (t?.visible()) {
      t.send(snapshot);
      this.stale = false;
    } else {
      this.stale = true;
    }
  }

  /** Окно показали или развернули: догнать пропущенное. */
  shown(): void {
    const t = this.target();
    if (!this.stale || this.latest === null || !t?.visible()) return;
    t.send(this.latest);
    this.stale = false;
  }
}
