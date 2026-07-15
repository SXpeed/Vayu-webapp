import path from 'path';
import fs from 'fs';
import { defineConfig, loadEnv, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Plugin to copy static files (sw.js) to the dist folder after build
function copyStaticFiles(): Plugin {
  return {
    name: 'copy-static-files',
    closeBundle() {
      const filesToCopy = ['sw.js', 'icon.png'];
      for (const file of filesToCopy) {
        const src = path.resolve(__dirname, file);
        const dest = path.resolve(__dirname, 'dist', file);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dest);
          console.log(`Copied ${file} to dist/`);
        }
      }

      // PWA install-UI screenshots, referenced by manifest.json as
      // ./screenshots/*.png (the manifest is emitted at the dist root).
      const shotsSrc = path.resolve(__dirname, 'screenshots');
      if (fs.existsSync(shotsSrc)) {
        const shotsDest = path.resolve(__dirname, 'dist', 'screenshots');
        fs.mkdirSync(shotsDest, { recursive: true });
        for (const file of fs.readdirSync(shotsSrc)) {
          fs.copyFileSync(path.resolve(shotsSrc, file), path.resolve(shotsDest, file));
        }
        console.log('Copied screenshots/ to dist/');
      }

      // NOTE: Do NOT delete .wasm files from dist/assets — the ONNX Runtime
      // WASM (ort-wasm-simd-threaded.jsep.wasm) is required at runtime for
      // @imgly/background-removal to perform in-browser inference.
    }
  };
}

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), '');
    return {
      define: {
        // This is just generic value for the GEMINI API key.
        // This is not used at all, and can be ignored!
        'process.env.API_KEY' : JSON.stringify('api-key-this-is-not-used-can-be-ignored!'),
      },
      server: {
        host: true,
        proxy: {
          //Target your Node.js backend
          '/api-proxy': 'http://localhost:5000',
          '/ws-proxy': {target: 'ws://localhost:5000', ws: true},
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
      plugins: [react(), tailwindcss(), copyStaticFiles()],
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
