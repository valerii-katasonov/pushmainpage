self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open('push-school-v1').then((cache) => {
            return cache.addAll([
                '/index-uk.html',
                '/class-2.html',
                '/schedule-class-2.js',
                '/manifest.json',
                'https://i.postimg.cc/WbY9TdDp/PushIco.png',
                'https://i.postimg.cc/5NQjHJ8L/2025-2026.png',
                'https://i.postimg.cc/gcZFYcfn/PL.png',
                'https://zastavki.gas-kvas.com/uploads/posts/2024-09/zastavki-gas-kvas-com-35bo-p-zastavki-pro-shkolu-9.jpg'
            ]);
        })
    );
});

self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request).then((response) => {
            return response || fetch(event.request);
        })
    );
});
