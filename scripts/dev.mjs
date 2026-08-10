/**
 * Разработка: поднимает Vite для интерфейса, собирает main/preload в режиме
 * слежения и запускает Electron, указав ему адрес dev-сервера.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import { context } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  sourcemap: true,
  external: ['electron'],
  logLevel: 'warning',
};

const mainCtx = await context({
  ...common,
  entryPoints: ['src/main/index.ts'],
  outfile: 'dist/main/index.js',
  format: 'esm',
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
const preloadCtx = await context({
  ...common,
  entryPoints: ['src/preload/index.ts'],
  outfile: 'dist/preload/index.cjs',
  format: 'cjs',
});

await mainCtx.rebuild();
await preloadCtx.rebuild();
await mainCtx.watch();
await preloadCtx.watch();

const server = await createServer();
await server.listen();
const url = server.resolvedUrls?.local?.[0];
if (!url) throw new Error('Vite не сообщил адрес dev-сервера');
console.log(`интерфейс: ${url}`);

const electronPath = (await import('electron')).default;
const child = spawn(electronPath, ['dist/main/index.js'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url, NODE_ENV: 'development' },
});

const shutdown = async () => {
  await Promise.all([mainCtx.dispose(), preloadCtx.dispose(), server.close()]);
  process.exit(0);
};

child.on('close', shutdown);
process.on('SIGINT', shutdown);
