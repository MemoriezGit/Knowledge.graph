import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  publicDir: false,
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.PORT || 8787}`,
        changeOrigin: true,
      },
    },
  },
});
