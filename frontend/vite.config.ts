import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

const PAGES: Record<string, string> = {
    main: 'index.html',
    admin: 'admin.html',
    // Public website: landing page, sign-up/application, legal.
    welcome: 'welcome.html',
    signup: 'signup.html',
    legal: 'legal.html',
};
/** Which pages each Worker serves (frontend/hosts/<site>). */
const SITES: Record<string, string[]> = {
    app: ['main'],
    admin: ['admin'],
    welcome: ['welcome', 'signup', 'legal'],
};
const pick = (names: string[]) =>
    Object.fromEntries(names.map(n => [n, path.resolve(__dirname, PAGES[n])]));

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), '');
    // HTTPS dev mode (VITE_HTTPS=1, see `npm run dev:phone`): serves the dev
    // server over self-signed HTTPS so the PWA can be installed on a phone
    // over the LAN — browsers only offer "Install app" on secure origins.
    const useHttps = !!env.VITE_HTTPS;
    return {
      server: {
        // This computer only. `npm run dev:phone` passes --host to open it
        // to the local network on purpose.
        ...(useHttps ? { https: {} } : {}),
        proxy: {
          // Dev API target: the deployed Worker by default, so `npm run dev`
          // works without running `wrangler dev`. Set VITE_API_PROXY in .env
          // (e.g. http://127.0.0.1:8787) to use a local worker instead.
          '/api': {
            target: env.VITE_API_PROXY || 'https://app.ateliersupport.com',
            changeOrigin: true,
          },
        },
      },
      preview: {
        allowedHosts: true,
      },
      // Separate pages: the organization app (index.html), the provider control
      // centre (admin.html) and the public website, so none ships the others' code.
      // Each is also its own Worker on its own address: scripts/build-sites.mjs
      // sets SITE and builds each one into dist/<site> on its own.
      build: {
        ...(SITES[process.env.SITE ?? ''] ? { outDir: `dist/${process.env.SITE}`, emptyOutDir: true } : {}),
        rollupOptions: {
          input: pick(SITES[process.env.SITE ?? ''] ?? Object.keys(PAGES)),
        },
      },
      // The catalog PDF generator runs in a module worker that code-splits
      // (jsPDF's lazy plugins, background removal, onnxruntime). Vite's default
      // worker format, iife, can't code-split and fails the build.
      worker: {
        format: 'es',
      },
      // Static files (sw.js, icon.png, PWA screenshots) live in public/ and are
      // copied to the dist root as-is. Do NOT strip .wasm files from
      // dist/assets: @imgly/background-removal needs the ONNX Runtime WASM.
      plugins: [react(), tailwindcss(), ...(useHttps ? [basicSsl()] : [])],
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
