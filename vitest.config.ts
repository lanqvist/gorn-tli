import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Только свои тесты: без этого vitest находит копии тестов в рабочих
    // деревьях .claude/worktrees и в out/ — прогон вчетверо дольше и с чужими падениями.
    include: ['test/**/*.test.ts'],
  },
});
