// 🎄 Кнопка директора «Розіграти зараз» — запасний вхід, якщо розіграш
// за розкладом (advent-draw.js) не відбувся. Лише адміністрація, лише після
// 22 грудня 7:00 (це перевіряє сам runDraw).
const { ALLOWED_HOSTS } = require('./lib/site');
const { verifyIdToken, rolesOf } = require('./lib/auth');
const { accessToken, readDb, runDraw } = require('./lib/advent-run');

const cors = origin => ({ 'Access-Control-Allow-Origin': origin || '*', 'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json; charset=utf-8' });
const reply = (code, obj, origin) => ({ statusCode: code, headers: cors(origin), body: JSON.stringify(obj) });

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(origin) };
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Метод не підтримується' }, origin);
  let host = ''; try { host = new URL(origin).hostname; } catch (e) {}
  if (!ALLOWED_HOSTS.includes(host)) return reply(403, { error: 'Запит із невідомого джерела' }, origin);
  let body; try { body = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { error: 'Некоректний запит' }, origin); }
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) return reply(503, { error: 'Сервер не налаштовано' }, origin);
  try {
    const me = await verifyIdToken(body.idToken);
    if (!me) return reply(401, { error: 'Вхід не підтверджено — оновіть сторінку й увійдіть знову' }, origin);
    const token = await accessToken(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
    const roles = rolesOf(await readDb(token, `users/${me.uid}`));
    if (!roles.some(r => r === 'director' || r === 'administrator')) return reply(403, { error: 'Лише для адміністрації' }, origin);
    const res = await runDraw(token);
    console.log('[advent-draw-now]', JSON.stringify(res));
    return reply(200, res, origin);
  } catch (e) {
    console.error('[advent-draw-now]', e.message);
    return reply(500, { error: 'Не вдалося: ' + e.message }, origin);
  }
};
