const CACHE_NAME = 'push-school-cabinet-v1';

self.addEventListener('install', (e) => {
  self.skipWaiting(); // Змушує Service Worker оновитися відразу
});

self.addEventListener('activate', (e) => {
  e.waitUntil(clients.claim());
});

// Перехоплювач запитів, необхідний для роботи PWA (щоб Chrome дозволив встановлення)
self.addEventListener('fetch', (e) => {
  e.respondWith(
    fetch(e.request).catch(() => {
      // Заглушка, якщо немає інтернету
      return new Response("Немає підключення до Інтернету. Перевірте мережу.");
    })
  );
});
