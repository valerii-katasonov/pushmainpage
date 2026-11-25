// ══════════════════════════════════════════════════════════════════
//  🤝 Моя PUSH School Card — видати або оновити (лише після входу)
// ══════════════════════════════════════════════════════════════════
// Номер видає сервер, а не браузер: інакше будь-хто міг би записати собі
// «картку» з чужим імʼям. Імʼя й групи беремо з бази, не з запиту.
const { ALLOWED_HOSTS } = require('./lib/site');
const { verifyIdToken } = require('./lib/auth');
const { newNumber, formatNumber, shortName, untilOf, GROUP_LABEL } = require('./lib/partner-card-core');
const { accessToken, readDb, writeDb, putIfAbsent, personOf, dropCard } = require('./lib/partner-person');

const cors = origin => ({ 'Access-Control-Allow-Origin': origin || '*', 'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json; charset=utf-8' });
const reply = (code, obj, origin) => ({ statusCode: code, headers: cors(origin), body: JSON.stringify(obj) });
const warsawDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date());

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
    const p = await personOf(token, me.uid);
    if (!p.groups.length) {
      // Була картка, а людина вже не зі школою — прибираємо її
      const old = await readDb(token, `partner_card_of/${me.uid}`).catch(() => null);
      if (typeof old === 'string' && /^\d{12}$/.test(old)) await dropCard(token, old, me.uid).catch(() => {});
      return reply(403, { error: 'Картка є в учнів, батьків і працівників школи' }, origin);
    }
    if (!p.name) return reply(400, { error: 'Вкажіть імʼя та прізвище в профілі — вони будуть на картці' }, origin);
    const card = { uid: me.uid, name: p.name, short: shortName(p.name), groups: Object.fromEntries(p.groups.map(g => [g, true])),
                   until: untilOf(warsawDate()) };
    let no = await readDb(token, `partner_card_of/${me.uid}`);
    if (typeof no === 'string' && /^\d{12}$/.test(no)) {
      // Заблокована адміністрацією — не оновлюємо й нову не видаємо. Без
      // .catch: якщо базу не прочитали, краще помилка, ніж показати
      // заблоковану картку як робочу.
      const blocked = await readDb(token, `partner_cards/${no}/blocked`);
      if (blocked === true) return reply(403, { error: 'Картку заблоковано адміністрацією школи. Зверніться до школи.', blocked: true }, origin);
      await writeDb(token, `partner_cards/${no}`, card, 'PATCH');         // імʼя, групи, термін — актуальні
    } else {
      no = '';
      for (let i = 0; i < 5 && !no; i++) { const n = newNumber(); if (await putIfAbsent(token, `partner_cards/${n}`, { ...card, issuedAt: Date.now() })) no = n; }
      if (!no) throw new Error('не вдалося видати номер');
      await writeDb(token, `partner_card_of/${me.uid}`, no);
    }
    return reply(200, { no, display: formatNumber(no), name: card.name, groups: p.groups,
                        labels: p.groups.map(g => GROUP_LABEL[g]), until: card.until }, origin);
  } catch (e) {
    console.error('[partner-card]', e.message);
    return reply(500, { error: 'Не вдалося: ' + e.message }, origin);
  }
};
