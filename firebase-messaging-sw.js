/* ══════════════════════════════════════════════════════════════════
   Push School — Service Worker для сповіщень (Firebase Cloud Messaging)
   ══════════════════════════════════════════════════════════════════
   ЧОМУ ОКРЕМИЙ ФАЙЛ І САМЕ З ТАКОЮ НАЗВОЮ:
   Firebase Messaging за замовчуванням шукає в корені сайту саме
   /firebase-messaging-sw.js. Перейменуєш — фонові сповіщення зникнуть.

   ЧОМУ importScripts і "compat"-версія SDK:
   у Service Worker не можна використати звичайні ES-модулі так само, як
   на сторінці; compat-збірка Firebase саме для цього і призначена.

   Тут же лишається кешування, яке раніше було в sw-cabinet.js, —
   двох Service Worker'ів на один scope тримати не можна.
*/
importScripts('https://www.gstatic.com/firebasejs/10.8.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyA3OA9pcR1zscUtEPWD8LEKTKonAN5Y90c",
  authDomain: "test-4eb3e.firebaseapp.com",
  databaseURL: "https://test-4eb3e-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "test-4eb3e",
  storageBucket: "test-4eb3e.firebasestorage.app",
  messagingSenderId: "933339787450",
  appId: "1:933339787450:web:cc87b850ed3b4903f41283"
});

const messaging = firebase.messaging();

// Сповіщення, коли вкладку закрито або портал у фоні
messaging.onBackgroundMessage((payload) => {
  const d = payload.data || {};
  self.registration.showNotification(d.title || 'Push School', {
    body: d.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    // tag: сповіщення того самого типу заміняють одне одного, а не
    // накопичуються десятком однакових рядків
    tag: d.tag || 'push-school',
    data: { url: d.url || './cabinet.html' },
    lang: 'uk'
  });
});

// Клік по сповіщенню: піднімаємо вже відкриту вкладку, якщо вона є
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || './cabinet.html';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) if (c.url.includes('cabinet') && 'focus' in c) return c.focus();
      if (clients.openWindow) return clients.openWindow(target);
    })
  );
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));

// Перехоплювач fetch потрібен, щоб браузер вважав сайт повноцінним PWA
// і пропонував встановлення. Кешування навмисно немає: портал показує
// живі дані, і застарілий кеш тут шкідливіший за відсутність офлайну.
self.addEventListener('fetch', (e) => {
  e.respondWith(
    fetch(e.request).catch(() =>
      new Response('Немає підключення до Інтернету. Перевірте мережу.', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      })
    )
  );
});
