import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';

// Cross-origin isolation headers (COOP/COEP).
// Required so SharedArrayBuffer / threaded fallbacks (e.g. ffmpeg.wasm) work.
// WebCodecs itself does not strictly need this, but we enable it from day 1
// so adding the fallback path later does not break the hosting contract.
const crossOriginIsolation: Plugin = {
  name: 'cross-origin-isolation',
  configureServer(server) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
      next();
    });
  },
  configurePreviewServer(server) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
      next();
    });
  },
};

export default defineConfig({
  plugins: [
    react(),
    crossOriginIsolation,
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['icons/apple-touch-icon.png'],
      manifest: {
        name: 'Editor de Video Web',
        short_name: 'VideoEditor',
        description: 'Editor de video en el navegador (WebCodecs + IA on-device).',
        lang: 'es',
        theme_color: '#0e0e12',
        background_color: '#0e0e12',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Precache the app shell only. Skip the huge ONNX wasm (~23 MB) — the AI
        // model needs the network on first use anyway, so don't bloat install.
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallbackDenylist: [/^\/api/],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    port: 3000,
  },
  // Mediabunny is a large pure-TS lib; let Vite pre-bundle it.
  // Transformers.js + onnxruntime-web must NOT be pre-bundled (they load wasm /
  // run inside a worker), so exclude them.
  optimizeDeps: {
    include: ['mediabunny'],
    exclude: ['@huggingface/transformers', '@mediapipe/tasks-vision'],
  },
});
