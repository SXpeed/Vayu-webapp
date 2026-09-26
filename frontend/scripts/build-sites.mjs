// Builds each site Worker's files on its own (see docs/HOSTING.md):
//   dist/app      app.ateliersupport.com    the organization app
//   dist/admin    admin.ateliersupport.com  the control centre, at /
//   dist/welcome  ateliersupport.com        the website, landing page at /
//
//   node scripts/build-sites.mjs   (npm run build)
import { appendFileSync, copyFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const frontend = fileURLToPath(new URL('..', import.meta.url));
const dist = (site, file = '') => join(frontend, 'dist', site, file);

for (const site of ['app', 'admin', 'welcome']) {
    // vite.config.ts reads SITE to pick the pages and the output folder.
    process.env.SITE = site;
    await build({ root: frontend, configFile: join(frontend, 'vite.config.ts') });
}

// Each site's main page is the root of its address.
renameSync(dist('admin', 'admin.html'), dist('admin', 'index.html'));
renameSync(dist('welcome', 'welcome.html'), dist('welcome', 'index.html'));

// Only the app is installable. The website gets a service worker that
// retires the app's old one from when the app lived at ateliersupport.com.
for (const site of ['admin', 'welcome']) {
    rmSync(dist(site, 'screenshots'), { recursive: true, force: true });
}
rmSync(dist('admin', 'sw.js'), { force: true });

// The app is cross-origin isolated, so the catalog generator's background
// removal can run on every CPU core (WebAssembly threads need
// SharedArrayBuffer) — which phones rely on, as they don't use the GPU for
// it. `require-corp` rather than `credentialless`: Safari (every iPhone
// browser) supports only this one. It is safe because the app loads nothing
// from other sites but the model itself, which is fetched with CORS; every
// image it shows is a stored file served from its own address. Anything
// embedded from another site in future must send CORP/CORS headers.
appendFileSync(dist('app', '_headers'), `
# Cross-origin isolation: multi-core background removal (scripts/build-sites.mjs).
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
`);
copyFileSync(join(frontend, 'hosts', 'welcome', 'sw.js'), dist('welcome', 'sw.js'));
