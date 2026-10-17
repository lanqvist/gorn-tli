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
    // Звуки встроены в бандл как data-URL (~2.7 МБ): страницы грузятся
    // с диска, размер чанка здесь не про скорость сети.
    chunkSizeWarningLimit: 3200,
    rollupOptions: {
      // Три окна — три страницы: дашборд, оверлей и слой всплывающего дохода.
      input: {
        index: resolve(import.meta.dirname, 'src/renderer/index.html'),
        overlay: resolve(import.meta.dirname, 'src/renderer/overlay.html'),
        toasts: resolve(import.meta.dirname, 'src/renderer/toasts.html'),
        prison: resolve(import.meta.dirname, 'src/renderer/prison.html'),
        capture: resolve(import.meta.dirname, 'src/renderer/capture.html'),
      },
    },
  },
  server: {
    port: 5273,
    strictPort: true,
  },
});
