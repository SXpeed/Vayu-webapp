const CACHE_NAME = 'vayu-design-v14';
// Small records shared with the app, kept across updates (see activate):
// who is signed in (pushService.setIdentity) and a notification tap the app
// has yet to act on.
const IDENTITY_CACHE = 'push-identity';
const IDENTITY_URL = '/__push-identity';
const NAV_CACHE = 'push-nav';
const NAV_URL = '/__push-nav';
const KEEP_CACHES = [IDENTITY_CACHE, NAV_CACHE];
const ASSETS_TO_CACHE = [
  './',
  './index.html',
];

globalThis.addEventListener('install', (event) => {
  // Skip waiting to activate immediately
  globalThis.skipWaiting();
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

globalThis.addEventListener('fetch', (event) => {
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
  if (url.origin === globalThis.location.origin && url.pathname.startsWith('/assets/')) {
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

// ── Background Sync & Periodic Background Sync ─────────────────────────────

// Ask any open app windows to re-fetch data from the API. The app listens on
// this channel in useEntityData and reloads all entities on SYNC_REQUIRED.
const broadcastSyncRequired = () => {
  try {
    const channel = new BroadcastChannel('vayu_cloud_sync');
    channel.postMessage({ type: 'SYNC_REQUIRED' });
    channel.close();
  } catch (err) {
    console.warn('SW: sync broadcast failed:', err);
  }
};

// Re-fetch the app shell into the cache so the next cold launch is fresh.
const refreshAppShell = async () => {
  try {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(ASSETS_TO_CACHE.map(async (asset) => {
      const response = await fetch(asset, { cache: 'no-cache' });
      if (response?.ok) {
        await cache.put(asset, response);
      }
    }));
  } catch (err) {
    console.warn('SW: app shell refresh failed:', err);
  }
};

// One-off Background Sync: queued by the app when it goes offline; the
// browser fires it as soon as connectivity returns, even if the tab is
// backgrounded, so data refreshes the moment we're back online.
globalThis.addEventListener('sync', (event) => {
  if (event.tag === 'vayu-sync') {
    event.waitUntil(
      refreshAppShell().then(() => broadcastSyncRequired())
    );
  }
});

// Periodic Background Sync: browser-scheduled refresh for installed PWAs
// (Chromium only; the interval is ultimately decided by the browser).
globalThis.addEventListener('periodicsync', (event) => {
  if (event.tag === 'vayu-periodic-sync') {
    event.waitUntil(
      refreshAppShell().then(() => broadcastSyncRequired())
    );
  }
});

// ── Web Push notifications ─────────────────────────────────────────────────

/** Who the app says is signed in here: { userId } (null while signed out), or null if it never said. */
function signedInIdentity() {
  return caches.open(IDENTITY_CACHE)
    .then(cache => cache.match(IDENTITY_URL))
    .then(res => (res ? res.json() : null))
    .catch(() => null);
}

globalThis.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = { title: 'ateliersupport', body: event.data ? event.data.text() : '' };
  }
  const title = payload.title || 'ateliersupport';
  const data = payload.data || {};
  const options = {
    body: payload.body || '',
    tag: payload.tag || undefined,
    renotify: !!payload.tag,
    data,
  };
  // A notification names its person. One for someone else (the device has
  // changed hands) or arriving while signed out stays hidden: its words
  // belong to that person. Devices the app never told (older versions)
  // show everything, as before.
  event.waitUntil(
    signedInIdentity().then((identity) => {
      const hidden = identity && (identity.userId === null || (data.to && identity.userId !== data.to));
      // A push means something changed server-side: open tabs catch up now
      // instead of waiting for their next scheduled refresh.
      if (hidden) return broadcastSyncRequired();
      return globalThis.registration.showNotification(title, options).then(() => broadcastSyncRequired());
    })
  );
});

globalThis.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  // Where to go: the page, and the chat or inquiry on it.
  const target = {
    view: data.view,
    conversationId: data.conversationId,
    inquiryId: data.inquiryId,
    chat: data.chat === true,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };
  const params = new URLSearchParams();
  if (target.view) params.set('view', target.view);
  if (target.conversationId) params.set('conversation', target.conversationId);
  if (target.inquiryId) params.set('inquiry', target.inquiryId);
  if (target.chat) params.set('chat', '1');
  event.waitUntil(
    // Also left where the app looks when it comes to the front: on iPhone
    // the message below can be lost while the app wakes up, which is why
    // some taps used to open the app without going anywhere.
    caches.open(NAV_CACHE)
      .then(cache => cache.put(NAV_URL, new Response(JSON.stringify({ ...target, at: Date.now() }))))
      .catch(() => undefined)
      .then(() => globalThis.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then((windowClients) => {
        // The app's own window (not the website or control centre, which
        // can share this origin during development).
        const app = windowClients.find(c => !/^\/(admin|welcome|signup|legal)(\.html)?$/.test(new URL(c.url).pathname));
        if (app) {
          app.postMessage({ type: 'PUSH_NAVIGATE', ...target });
          return 'focus' in app ? app.focus() : undefined;
        }
        // No window open: launch the app with the target in the URL.
        const query = params.toString();
        return globalThis.clients.openWindow(query ? `./?${query}` : './');
      })
  );
});

globalThis.addEventListener('activate', (event) => {
  // Clean up old caches
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((cacheName) => cacheName !== CACHE_NAME && !KEEP_CACHES.includes(cacheName))
          .map((cacheName) => caches.delete(cacheName))
      );
    }).then(() => {
      // Take control of all clients immediately
      return globalThis.clients.claim();
    })
  );
});
