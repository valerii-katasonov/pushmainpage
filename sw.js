self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open('push-school-v1').then((cache) => {
            return cache.addAll([
                '/index-uk',
                '/manifest.json',
                'https://i.postimg.cc/WbY9TdDp/PushIco.png',
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
