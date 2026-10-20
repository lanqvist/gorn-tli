/**
 * Пул решателя без сборки — для замеров (npx tsx) и тестов: поток грузит
 * poolWorker.ts через tsx. В приложении пул запускает worker.ts по
 * собранному dist/main/prisonSolver.cjs.
 */
import { startSolvePool, type SolvePool } from './pool.js';

export function startDevSolvePool(threads: number): SolvePool | null {
  return startSolvePool({ threads, entry: new URL('./poolWorker.ts', import.meta.url), execArgv: ['--import', 'tsx'] });
}
