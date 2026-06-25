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
      const filesToCopy = ['sw.js'];
      for (const file of filesToCopy) {
        const src = path.resolve(__dirname, file);
        const dest = path.resolve(__dirname, 'dist', file);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dest);
          console.log(`Copied ${file} to dist/`);
        }
      }
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
        proxy: {
          //Target your Node.js backend
          '/api-proxy': 'http://localhost:5000',
          '/ws-proxy': {target: 'ws://localhost:5000', ws: true},
        },
      },
      plugins: [react(), tailwindcss(), copyStaticFiles()],
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
