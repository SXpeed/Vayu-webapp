import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

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
            target: env.VITE_API_PROXY || 'https://vayu-webapp.gulshanprajapati1998.workers.dev',
            changeOrigin: true,
          },
        },
      },
      preview: {
        allowedHosts: true,
      },
      // Separate pages: the organization app (index.html), the provider control
      // centre (admin.html) and the public website, so none ships the others' code.
      build: {
        rollupOptions: {
          input: {
            main: path.resolve(__dirname, 'index.html'),
            admin: path.resolve(__dirname, 'admin.html'),
            // Public website: landing page, sign-up/application, legal.
            welcome: path.resolve(__dirname, 'welcome.html'),
            signup: path.resolve(__dirname, 'signup.html'),
            legal: path.resolve(__dirname, 'legal.html'),
          },
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
