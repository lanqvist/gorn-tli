/**
 * Сборка main- и preload-процессов.
 *
 * Preload обязан быть CommonJS: Electron грузит ESM-preload только при
 * выключенной песочнице, а выключать её ради формата модулей незачем.
 * Main собирается в ESM — его Electron 43 поддерживает штатно.
 */
import { build } from 'esbuild';

const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  sourcemap: true,
  // Electron предоставляется рантаймом, встроенные модули Node тоже.
  // electron-updater остаётся внешним: это пакет CommonJS с динамическими
  // зависимостями, его кладёт в сборку electron-builder как обычную зависимость.
  external: ['electron', 'electron-updater'],
  logLevel: 'info',
};

const configs = [
  {
    ...common,
    entryPoints: ['src/main/index.ts'],
    outfile: 'dist/main/index.js',
    format: 'esm',
    // Нужно, чтобы бандл в формате ESM мог пользоваться createRequire.
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
  },
  {
    ...common,
    entryPoints: ['src/preload/index.ts'],
    outfile: 'dist/preload/index.cjs',
    format: 'cjs',
  },
  // Процесс подсказок в тюрьме (utilityProcess): распознавание кадра и
  // расчёт хода.
  {
    ...common,
    entryPoints: ['src/main/prison/worker.ts'],
    outfile: 'dist/main/prisonWorker.cjs',
    format: 'cjs',
  },
  // Потоки решателя внутри процесса подсказок (worker_threads).
  {
    ...common,
    entryPoints: ['src/core/prison/solver/poolWorker.ts'],
    outfile: 'dist/main/prisonSolver.cjs',
    format: 'cjs',
  },
];

if (watch) {
  const { context } = await import('esbuild');
  for (const config of configs) {
    const ctx = await context(config);
    await ctx.watch();
  }
  console.log('esbuild следит за изменениями main и preload');
} else {
  await Promise.all(configs.map((config) => build(config)));
  console.log('main и preload собраны');
}
