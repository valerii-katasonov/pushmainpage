// ══════════════════════════════════════════════════════════════════
//  Push School — спільна AI-функція (Gemini)
// ══════════════════════════════════════════════════════════════════
// Замінює окремий ai-homework.js. Усі AI-можливості порталу ходять сюди
// з параметром task — так уся обв'язка (ключ, перевірка джерела, ліміти,
// повтори, обробка помилок) описана один раз, а нова можливість — це
// лише новий блок у PROMPTS нижче.
//
// НАВІЩО СЕРВЕРНА ФУНКЦІЯ: ключ до Gemini не можна тримати в браузері —
// його видно кожному, хто відкриє код сторінки. Тут він живе у змінних
// оточення Netlify і в браузер не потрапляє.
//
// НАЛАШТУВАННЯ (один раз):
//   1. https://aistudio.google.com/apikey → Create API key
//   2. Netlify → Site configuration → Environment variables →
//      GEMINI_API_KEY = <ключ>
//   3. Redeploy
//
// МОДЕЛЬ виносена у GEMINI_MODEL: Google періодично закриває старі моделі,
// і тоді достатньо змінити змінну без правок коду.

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const API = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const ALLOWED_HOSTS = ['planlekcjipush.netlify.app', 'localhost', '127.0.0.1'];

const clean = (v, max) => String(v ?? '').trim().slice(0, max);

// ── Формулювання завдань ──
// ПРАВИЛО ПРИВАТНОСТІ: у жодному промпті не має бути імен учнів, оцінок,
// адрес чи будь-яких персональних даних. Лише предмет, тема, клас і текст,
// який вчитель написав сам.
const PROMPTS = {
  // Чернетка домашнього завдання за темою уроку
  homework: (p) => ({
    valid: p.subject && p.topic && p.classNum >= 1 && p.classNum <= 11,
    error: 'Потрібні предмет, тема уроку та клас',
    text: [
      `Ти — досвідчений український учитель. Склади домашнє завдання для учнів ${p.classNum} класу.`,
      `Предмет: ${p.subject}`,
      `Тема уроку: ${p.topic}`,
      '',
      'Вимоги до відповіді:',
      '- українською мовою;',
      `- складність відповідає ${p.classNum} класу;`,
      '- 2–4 конкретні завдання, кожне з нового рядка, пронумеровані;',
      '- завдання мають бути виконувані вдома без спеціального обладнання;',
      '- обсяг реалістичний: приблизно 20–30 хвилин роботи;',
      '- без вступу, без пояснень і без побажань — лише сам текст завдання;',
      '- не використовуй розмітку Markdown.'
    ].join('\n')
  }),

  // Допомога вчителю сформулювати коментар для батьків
  comment: (p) => ({
    valid: !!p.note,
    error: 'Напишіть чернетку коментаря своїми словами',
    text: [
      'Ти допомагаєш українському вчителю сформулювати коментар для батьків учня.',
      'Учитель нашвидкуруч записав свою думку — переклади її у коректне,',
      'доброзичливе та конструктивне повідомлення.',
      '',
      `Клас: ${p.classNum || '—'}`,
      `Предмет: ${p.subject || '—'}`,
      `Чернетка вчителя: "${p.note}"`,
      '',
      'Вимоги до відповіді:',
      '- українською мовою, 1–3 речення;',
      '- ввічливий, спокійний тон, звертання на «ви»;',
      '- НЕ вигадуй імен і не звертайся до учня на ім\'я — пиши «дитина» або безособово;',
      '- якщо йдеться про проблему — обов\'язково додай, що конкретно варто зробити вдома;',
      '- жодних діагнозів, оцінок особистості та узагальнень на кшталт «завжди», «ніколи»;',
      '- не вигадуй фактів, яких немає в чернетці вчителя;',
      '- лише текст коментаря, без вступу і без лапок;',
      '- не використовуй розмітку Markdown.'
    ].join('\n')
  }),

  // Порада батькам: як допомогти дитині вдома з темою уроку / домашнім
  parentHelp: (p) => ({
    valid: !!(p.subject && (p.topic || p.homework)),
    error: 'Немає теми уроку або домашнього завдання на цей день',
    text: [
      `Ти — доброзичливий український педагог. Поясни батькам учня ${p.classNum || ''} класу,`,
      'як допомогти дитині вдома. Батьки — не вчителі, тож пиши просто й практично.',
      '',
      `Предмет: ${p.subject}`,
      p.topic ? `Тема уроку: ${p.topic}` : '',
      p.homework ? `Що задано додому: ${p.homework}` : '',
      '',
      'Вимоги до відповіді:',
      '- українською мовою;',
      '- 3–4 конкретні поради, пронумеровані, кожна з нового рядка;',
      '- поради практичні: що саме сказати, спитати або зробити разом із дитиною;',
      '- підійде для батьків без педагогічної освіти, без термінів;',
      '- жодних докорів батькам і жодних припущень про дитину;',
      '- не виконуй за дитину домашнє завдання і не давай готових відповідей —',
      '  показуй, як допомогти дитині дійти до відповіді самій;',
      '- без вступу і висновків, лише поради;',
      '- не використовуй розмітку Markdown.'
    ].filter(Boolean).join('\n')
  }),

  // Питання для самоперевірки учня за темою уроку
  selfCheck: (p) => ({
    valid: !!(p.subject && (p.topic || p.homework)),
    error: 'Немає теми уроку на цей день',
    text: [
      `Ти — український учитель. Склади питання для САМОПЕРЕВІРКИ учня ${p.classNum || ''} класу.`,
      '',
      `Предмет: ${p.subject}`,
      p.topic ? `Тема уроку: ${p.topic}` : '',
      p.homework ? `Домашнє завдання: ${p.homework}` : '',
      '',
      'Вимоги до відповіді:',
      '- українською мовою, звертання до учня на «ти»;',
      '- 4–5 коротких питань, пронумерованих, кожне з нового рядка;',
      `- складність відповідає ${p.classNum || ''} класу;`,
      '- питання перевіряють РОЗУМІННЯ теми, а не переказ означень;',
      '- НЕ давай відповідей — учень має відповісти сам;',
      '- не повторюй дослівно домашнє завдання і не виконуй його;',
      '- без вступу, лише питання;',
      '- не використовуй розмітку Markdown.'
    ].filter(Boolean).join('\n')
  }),

  // Чернетка оголошення для батьків (директор)
  announcement: (p) => ({
    valid: !!p.note,
    error: 'Напишіть коротко, про що має бути оголошення',
    text: [
      'Ти допомагаєш директору української школи скласти оголошення для батьків.',
      'Директор коротко записав суть — оформи це у зрозуміле, ввічливе повідомлення.',
      '',
      `Суть: "${p.note}"`,
      '',
      'Вимоги до відповіді:',
      '- українською мовою;',
      '- 3–6 речень, діловий, але теплий тон, звертання «Шановні батьки»;',
      '- якщо в суті є дата, час чи місце — обов\'язково збережи їх точно;',
      '- НЕ вигадуй жодних деталей, яких немає в суті: ні дат, ні сум, ні імен;',
      '- якщо від батьків потрібна дія — сформулюй її окремим чітким реченням;',
      '- без підпису в кінці;',
      '- не використовуй розмітку Markdown.'
    ].join('\n')
  })
};

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8'
  };
}
const fail = (code, msg, origin) => ({
  statusCode: code, headers: cors(origin), body: JSON.stringify({ error: msg })
});

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(origin) };
  if (event.httpMethod !== 'POST') return fail(405, 'Метод не підтримується', origin);

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

  const build = PROMPTS[body.task];
  if (!build) return fail(400, 'Невідомий тип запиту', origin);

  // Обрізаємо вхідні дані — і від помилок, і від спроб «розкрутити» модель
  const params = {
    subject: clean(body.subject, 100),
    topic: clean(body.topic, 300),
    homework: clean(body.homework, 600),
    note: clean(body.note, 600),
    classNum: parseInt(body.classNum, 10) || 0
  };

  const spec = build(params);
  if (!spec.valid) return fail(400, spec.error, origin);

  const callGemini = (cfg) => fetch(`${API}?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: spec.text }] }], generationConfig: cfg })
  });

  try {
    // Спроба 1: з вимкненими роздумами — інакше внутрішні токени моделі
    // з'їдають ліміт виводу і відповідь обривається на півслові.
    let r = await callGemini({ temperature: 0.7, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } });
    let data = await r.json();

    // Спроба 2: не всі моделі приймають thinkingConfig, і Google відповідає
    // загальним «invalid argument». Тому на будь-яку 400 повторюємо без
    // нього, компенсуючи збільшеним лімітом виводу.
    if (!r.ok && r.status === 400) {
      r = await callGemini({ temperature: 0.7, maxOutputTokens: 4096 });
      data = await r.json();
    }

    if (!r.ok) {
      const msg = data?.error?.message || 'Помилка сервісу Gemini';
      if (r.status === 429) return fail(429, 'Ліміт запитів до AI на сьогодні вичерпано. Спробуйте завтра.', origin);
      if (/no longer available|not found|is not supported/i.test(msg))
        return fail(r.status, `Модель «${MODEL}» більше не доступна. Адміністратору: змініть змінну GEMINI_MODEL у Netlify.`, origin);
      return fail(r.status, msg, origin);
    }

    const cand = data?.candidates?.[0];
    const text = (cand?.content?.parts || []).map(p => p?.text || '').join('').trim();
    if (!text) return fail(502, 'AI не повернув відповіді. Спробуйте ще раз.', origin);

    return {
      statusCode: 200,
      headers: cors(origin),
      body: JSON.stringify({ text, truncated: cand?.finishReason === 'MAX_TOKENS' })
    };
  } catch (e) {
    return fail(500, 'Не вдалося звернутися до AI: ' + e.message, origin);
  }
};
