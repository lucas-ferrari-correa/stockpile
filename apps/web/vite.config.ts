import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: ['@stockpile/api-client', '@stockpile/shared'],
  },
  build: {
    commonjsOptions: {
      include: [/packages[\\/](api-client|shared)[\\/]dist/, /node_modules/],
    },
  },
  server: {
    port: 5173,
  },
});
