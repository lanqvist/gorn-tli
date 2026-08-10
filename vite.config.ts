import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * Конфигурация только для renderer. Main и preload собираются esbuild-ом
 * (scripts/build.mjs) — так меньше движущихся частей, чем у связок вроде
 * electron-vite, и нет конфликтов версий Vite.
 */
export default defineConfig({
  root: resolve(import.meta.dirname, 'src/renderer'),
  // Пути должны быть относительными: в собранном приложении страница
  // грузится с file://, а не с сервера.
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome130',
  },
  server: {
    port: 5273,
    strictPort: true,
  },
});
