// ══════════════════════════════════════════════════════════════════
//  Push School — генерація домашнього завдання через Gemini
// ══════════════════════════════════════════════════════════════════
// НАВІЩО ЦЕ СЕРВЕРНА ФУНКЦІЯ, А НЕ ВИКЛИК З БРАУЗЕРА:
// ключ до Gemini не можна тримати в клієнтському JS — його видно кожному,
// хто відкриє вихідний код сторінки. Тут ключ живе у змінних оточення
// Netlify (Site settings → Environment variables → GEMINI_API_KEY) і
// в браузер ніколи не потрапляє.
//
// НАЛАШТУВАННЯ (один раз):
//   1. https://aistudio.google.com → Get API key → скопіювати
//   2. Netlify → Site configuration → Environment variables →
//      Add: GEMINI_API_KEY = <ключ>
//   3. Redeploy сайту
//
// Безкоштовний тариф Gemini обмежений кількістю запитів на хвилину та на добу.
// Для школи з ~20 вчителями цього вистачає із запасом.
//
// МОДЕЛЬ. Google час від часу припиняє підтримку старих моделей для нових
// проєктів (так сталося з gemini-2.5-flash). Тому назва винесена в змінну
// оточення: якщо колись знову прийде повідомлення «model is no longer
// available», достатньо змінити GEMINI_MODEL у Netlify і зробити redeploy —
// без правок коду.
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const API = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// Домени, з яких приймаємо запити. Проста перешкода для чужих сайтів, які
// могли б витрачати нашу квоту. Це не повноцінна автентифікація — за потреби
// пізніше додамо перевірку Firebase-токена вчителя.
const ALLOWED_HOSTS = ['planlekcjipush.netlify.app', 'localhost', '127.0.0.1'];

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8'
  };
}
const fail = (code, msg, origin) => ({
  statusCode: code,
  headers: cors(origin),
  body: JSON.stringify({ error: msg })
});

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(origin) };
  if (event.httpMethod !== 'POST') return fail(405, 'Метод не підтримується', origin);

  // Перевірка джерела запиту
  if (origin) {
    let host = '';
    try { host = new URL(origin).hostname; } catch (e) { /* ignore */ }
    if (!ALLOWED_HOSTS.includes(host)) return fail(403, 'Запит із невідомого джерела', origin);
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) return fail(500, 'AI не налаштовано: адміністратору потрібно додати GEMINI_API_KEY у Netlify', origin);

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return fail(400, 'Некоректний запит', origin); }

  // Обрізаємо вхідні дані — і від помилок, і від спроб «розкрутити» модель
  const subject = String(body.subject || '').trim().slice(0, 100);
  const topic   = String(body.topic   || '').trim().slice(0, 300);
  const classNum = parseInt(body.classNum, 10);

  if (!subject) return fail(400, 'Не вказано предмет', origin);
  if (!topic)   return fail(400, 'Не вказано тему уроку', origin);
  if (!(classNum >= 1 && classNum <= 11)) return fail(400, 'Некоректний клас', origin);

  // ВАЖЛИВО: жодних персональних даних учнів сюди не передаємо — лише
  // предмет, тема і номер класу.
  const prompt = [
    `Ти — досвідчений український учитель. Склади домашнє завдання для учнів ${classNum} класу.`,
    `Предмет: ${subject}`,
    `Тема уроку: ${topic}`,
    '',
    'Вимоги до відповіді:',
    '- українською мовою;',
    `- складність відповідає ${classNum} класу;`,
    '- 2–4 конкретні завдання, кожне з нового рядка, пронумеровані;',
    '- завдання мають бути виконувані вдома без спеціального обладнання;',
    '- обсяг реалістичний: приблизно 20–30 хвилин роботи;',
    '- без вступу, без пояснень і без побажань — лише сам текст завдання;',
    '- не використовуй розмітку Markdown (ні зірочок, ні решіток).'
  ].join('\n');

  try {
    const r = await fetch(`${API}?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 800 }
      })
    });

    const data = await r.json();

    if (!r.ok) {
      const msg = data?.error?.message || 'Помилка сервісу Gemini';
      // 429 — вичерпано безкоштовну квоту; повідомляємо зрозуміло
      if (r.status === 429) return fail(429, 'Ліміт запитів до AI на сьогодні вичерпано. Спробуйте завтра.', origin);
      // Модель припинили підтримувати — підказуємо адміністратору, що робити
      if (/no longer available|not found|is not supported/i.test(msg))
        return fail(r.status, `Модель «${MODEL}» більше не доступна. Адміністратору: змініть змінну GEMINI_MODEL у Netlify. Відповідь Google: ${msg}`, origin);
      return fail(r.status, msg, origin);
    }

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) return fail(502, 'AI не повернув відповіді. Спробуйте ще раз.', origin);

    return { statusCode: 200, headers: cors(origin), body: JSON.stringify({ text }) };
  } catch (e) {
    return fail(500, 'Не вдалося звернутися до AI: ' + e.message, origin);
  }
};
