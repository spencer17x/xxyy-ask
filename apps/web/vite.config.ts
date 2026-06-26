import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    assetsDir: 'web-assets',
    rollupOptions: {
      output: {
        assetFileNames: 'web-assets/[name][extname]',
        chunkFileNames: 'web-assets/[name].js',
        entryFileNames: 'web-assets/[name].js',
      },
    },
  },
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/assets': 'http://localhost:3000',
    },
  },
});
