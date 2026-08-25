// ═══════════════════════════════════════════════════════════════
// push-config.js — ключ для web-push. ЄДИНИЙ файл, який правите ВИ.
//
// ЧОМУ ОКРЕМИЙ ФАЙЛ: ключ раніше лежав просто в common.js. Ви вставляли
// його, а наступне оновлення common.js затирало вставлене — і сповіщення
// мовчки переставали працювати. Тут його ніхто не перезапише.
//
// ДЕ ВЗЯТИ: Firebase Console → шестерня → Project settings →
// вкладка Cloud Messaging → Web configuration → Web Push certificates →
// Generate key pair. Рядок ~87 символів, починається з «B».
// Копіюйте кнопкою копіювання: у консолі ключ буває показаний обрізаним.
//
// Це ПУБЛІЧНИЙ ключ — його видно у вихідному коді сторінки, і так і має
// бути. Секретний — це FIREBASE_SERVICE_ACCOUNT у змінних Netlify.
// ═══════════════════════════════════════════════════════════════
window.PUSH_VAPID_KEY = 'BAifnPl3VcvDFpYuE7D2HAyfCzczsxAq3ktk72MgK6a4MY03Krvu4JI6k8pYOrasLdhwW0lLEAqDWs6iLGYEaCo';
