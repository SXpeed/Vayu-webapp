const CACHE_NAME = 'vayu-design-v12';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
];

self.addEventListener('install', (event) => {
  // Skip waiting to activate immediately
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        return cache.addAll(ASSETS_TO_CACHE);
      })
      .catch((err) => {
        console.warn('SW: cache addAll failed, continuing without cache:', err);
      })
  );
});

self.addEventListener('fetch', (event) => {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Never cache API calls — always go to network to prevent stale data
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Cache-first for Vite's content-hashed build assets: the filename changes
  // whenever the content does, so a cached copy can never be stale. This makes
  // repeat launches load instantly instead of re-downloading over the network.
  if (url.origin === self.location.origin && url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response?.ok) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return response;
        });
      })
    );
    return;
  }

  // Network-first strategy for everything else (index.html, sw.js, manifest)
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (!response?.ok) { return response; }
        // Clone the response and cache it
        const responseClone = response.clone();
        if (event.request.url.startsWith('http') && responseClone.ok) {
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        // Network failed, try cache
        return caches.match(event.request);
      })
  );
});

// ── Web Push notifications ─────────────────────────────────────────────────

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = { title: 'Vayu Design', body: event.data ? event.data.text() : '' };
  }
  const title = payload.title || 'Vayu Design';
  const options = {
    body: payload.body || '',
    tag: payload.tag || undefined,
    renotify: !!payload.tag,
    data: payload.data || {},
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const view = event.notification.data && event.notification.data.view;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Focus an existing app window and let the app navigate itself.
      for (const client of windowClients) {
        if ('focus' in client) {
          client.postMessage({ type: 'PUSH_NAVIGATE', view });
          return client.focus();
        }
      }
      // No window open: launch the app with the target view in the URL.
      const url = view ? `./?view=${encodeURIComponent(view)}` : './';
      return self.clients.openWindow(url);
    })
  );
});

self.addEventListener('activate', (event) => {
  // Clean up old caches
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      // Take control of all clients immediately
      return self.clients.claim();
    })
  );
});
