// Served as /sw.js on ateliersupport.com, replacing the app's service worker
// from when the app lived at this address. Browsers that still have the old
// one pick this up on their next visit: it deletes the app's cached copy and
// removes itself, so the address shows the website (or passes app visits on
// to app.ateliersupport.com) instead of a stale offline copy of the app.
// Open pages are not reloaded, so nobody loses what they were typing.
globalThis.addEventListener('install', () => globalThis.skipWaiting());
globalThis.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) await caches.delete(key);
    await globalThis.registration.unregister();
  })());
});
