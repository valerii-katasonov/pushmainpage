// ══════════════════════════════════════════════════════════════════
//  🤝 Оновити дані PUSH School Card (лише директор / адміністратор)
// ══════════════════════════════════════════════════════════════════
// Імʼя й групи на картці записуються при видачі й оновлюються, коли
// власник сам відкриває «Моя картка». Якщо школа виправила імʼя учня або
// прибрала самовписане — у «💳 Видані картки» лишалося б старе. Ця
// функція перераховує картки вказаних людей із бази (імʼя з тих самих
// джерел, що й при видачі; вибулих — прибирає). Писати імена в картки
// клієнт не може (правила бази), тому — сервер.
//
// Запит: { idToken, uids: [до 25 uid] }. Відповідь: { results: {uid: стан} }.
const { ALLOWED_HOSTS } = require('./lib/site');
const { verifyIdToken, rolesOf } = require('./lib/auth');
const { accessToken, readDb, refreshCard } = require('./lib/partner-person');

const MAX = 25;
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
  const uids = Array.isArray(body.uids) ? [...new Set(body.uids.filter(u => typeof u === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(u)))] : [];
  if (!uids.length || uids.length > MAX) return reply(400, { error: `Потрібно від 1 до ${MAX} людей за раз` }, origin);
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) return reply(503, { error: 'Сервер не налаштовано' }, origin);
  try {
    const me = await verifyIdToken(body.idToken);
    if (!me) return reply(401, { error: 'Вхід не підтверджено — оновіть сторінку й увійдіть знову' }, origin);
    const token = await accessToken(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
    const rec = await readDb(token, `users/${me.uid}`);
    if (!rolesOf(rec).some(r => r === 'director' || r === 'administrator') || !['director', 'administrator'].includes(rec && rec.role))
      return reply(403, { error: 'Лише для адміністрації школи' }, origin);
    const results = {};
    // По 5 паралельно: швидко, але без шквалу запитів до бази
    for (let i = 0; i < uids.length; i += 5) {
      await Promise.all(uids.slice(i, i + 5).map(async uid => {
        try { results[uid] = await refreshCard(token, uid); } catch (e) { results[uid] = 'error'; console.error('[partner-cards-sync]', uid, e.message); }
      }));
    }
    console.log(`[partner-cards-sync] ${me.email}: ${JSON.stringify(Object.values(results).reduce((a, s) => (a[s] = (a[s] || 0) + 1, a), {}))}`);
    return reply(200, { results }, origin);
  } catch (e) {
    console.error('[partner-cards-sync]', e.message);
    return reply(500, { error: 'Не вдалося: ' + e.message }, origin);
  }
};
