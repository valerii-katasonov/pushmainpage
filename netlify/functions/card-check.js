// ══════════════════════════════════════════════════════════════════
//  🤝 Перевірка PUSH School Card для партнерів (push.school/card)
// ══════════════════════════════════════════════════════════════════
// Без входу: партнер вводить номер з екрана клієнта. Відповідь мінімальна —
// «дійсна / ні», імʼя з першою літерою прізвища, група, термін. Ні пошти,
// ні класу, ні дітей. Чи дійсна — рахуємо з бази щоразу: вибув, відвʼязали
// чи звільнили — картка сама стає недійсною.
const { ALLOWED_HOSTS } = require('./lib/site');
const { digits, formatNumber, GROUP_LABEL } = require('./lib/partner-card-core');
const { accessToken, readDb, writeDb, personOf, dropCard } = require('./lib/partner-person');

const headers = origin => {
  let host = ''; try { host = new URL(origin).hostname; } catch (e) {}
  return { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    ...(ALLOWED_HOSTS.includes(host) ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' } : {}) };
};
const reply = (code, obj, origin) => ({ statusCode: code, headers: headers(origin), body: JSON.stringify(obj) });
const warsawDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date());
const human = d => String(d || '').split('-').reverse().join('.');

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: headers(origin) };
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Метод не підтримується' }, origin);
  let body; try { body = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { error: 'Некоректний запит' }, origin); }
  const no = digits(body.no);
  if (no.length !== 12) return reply(400, { error: 'Номер картки — 12 цифр' }, origin);
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) return reply(503, { error: 'Сервер не налаштовано' }, origin);
  try {
    const token = await accessToken(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
    const card = await readDb(token, `partner_cards/${no}`);
    if (!card || typeof card !== 'object' || !card.uid) return reply(200, { valid: false, no: formatNumber(no) }, origin);
    // Облік для адміністрації: скільки разів і коли партнери перевіряли
    // картку. Не впливає на відповідь — помилка запису не заважає перевірці.
    // Не частіше разу на хвилину: подвійне натискання партнера — одна
    // перевірка, а сторінка без входу не стає «кнопкою запису» в базу.
    const now = Date.now();
    if (!(Number(card.lastCheck) > now - 60000))
      await writeDb(token, `partner_cards/${no}`, { checks: (Number(card.checks) || 0) + 1, lastCheck: now }, 'PATCH').catch(() => {});
    // Заблокована адміністрацією — недійсна. Причину партнеру не пояснюємо.
    if (card.blocked === true) return reply(200, { valid: false, no: formatNumber(no) }, origin);
    const p = await personOf(token, card.uid);
    const valid = p.groups.length > 0 && String(card.until || '') >= warsawDate();
    if (!valid) {
      // Людина вже не зі школою — картку з імʼям не тримаємо (мінімізація
      // даних, privacy.pdf). Минув лише термін — лишаємо: власник відкриє
      // картку, і сервер продовжить її на новий навчальний рік.
      if (!p.groups.length) await dropCard(token, no, card.uid).catch(() => {});
      return reply(200, { valid: false, no: formatNumber(no) }, origin);
    }
    return reply(200, { valid: true, no: formatNumber(no), short: card.short || '', labels: p.groups.map(g => GROUP_LABEL[g]),
                        until: human(card.until) }, origin);
  } catch (e) {
    console.error('[card-check]', e.message);
    return reply(500, { error: 'Не вдалося перевірити, спробуйте ще раз' }, origin);
  }
};
