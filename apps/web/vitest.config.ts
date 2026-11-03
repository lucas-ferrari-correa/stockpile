import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.ts'],
      css: false,
      server: {
        deps: {
          inline: [/@tanstack\/react-router/, /@testing-library\/react/],
        },
      },
    },
  }),
);
