// ══════════════════════════════════════════════════════════════════
//  Сповіщення кухні на телефон (19.11.2026)
// ══════════════════════════════════════════════════════════════════
// Запускається сама кожні 5 хвилин у будні (netlify.toml) і шле працівникам
// кухні (ролі kitchen і kitchen_admin, у кого увімкнені сповіщення):
//
//   1. Після 09:00 за Варшавою — один раз на день: «Замовлення закрито»
//      з числами обідів (А/Б), сніданків, підвечірків.
//   2. Щойно когось відмітили відсутнім ПІСЛЯ дедлайну його страви
//      (сніданок — 07:00, обід і підвечірок — 09:00) — хто, клас, яка порція
//      готується, хто відмітив і о котрій. Кожну дитину — один раз на день.
//
// Числа рахує lib/kitchen-day.js за тими самими правилами, що й кабінет
// кухні та журнал списань.
//
// ЩО НЕ ПЛУТАЄТЬСЯ:
//   • рахуємо лише сьогоднішній день за Варшавою;
//   • відмітки, поставлені заздалегідь (учора на сьогодні, у п'ятницю на
//     понеділок), — вчасні, про них не сповіщаємо;
//   • відмітки на завтра й інші дні сюди не потрапляють узагалі;
//   • свята, канікули, вихідні — нічого не шлемо.
//
// Позначки «вже сповіщено» — kitchen_notice/{дата}/… Пише лише сервер
// (корінь бази закритий правилами), старші за 14 днів прибираються самі.
const crypto = require('crypto');
const { CABINET_URL } = require('./lib/site');
const { kitchenDay, cutoffMessage, lateMessage, warsawParts } = require('./lib/kitchen-day');
const DB = 'https://test-4eb3e-default-rtdb.europe-west1.firebasedatabase.app';
const KITCHEN_ROLES = ['kitchen', 'kitchen_admin'];

const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function accessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: ['https://www.googleapis.com/auth/firebase.messaging',
            'https://www.googleapis.com/auth/firebase.database',
            'https://www.googleapis.com/auth/userinfo.email'].join(' '),
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                                assertion: `${header}.${claim}.${b64url(signer.sign(sa.private_key))}` })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error_description || d.error || 'OAuth');
  return d.access_token;
}
async function readDb(token, path, shallow) {
  const r = await fetch(`${DB}/${path}.json?access_token=${encodeURIComponent(token)}${shallow ? '&shallow=true' : ''}`);
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`база недоступна (${path}): ${(d && d.error) || r.status}`);
  return d;
}
// Рівно один раз, навіть якщо два запуски збіглися (умовний запис з ETag)
async function claimFlag(token, path) {
  const url = `${DB}/${path}.json?access_token=${encodeURIComponent(token)}`;
  const r = await fetch(url, { headers: { 'X-Firebase-ETag': 'true' } });
  if (!r.ok) throw new Error(`база недоступна (${path}): ${r.status}`);
  if (await r.json().catch(() => null)) return false;
  const etag = r.headers.get('ETag');
  const w = await fetch(url, { method: 'PUT', body: String(Date.now()), headers: etag ? { 'if-match': etag } : {} });
  if (w.status === 412) return false;
  if (!w.ok) throw new Error(`не вдалося записати ${path}: ${w.status}`);
  return true;
}
const roleList = t => {
  const raw = t && t.roles;
  const list = Array.isArray(raw) ? [...raw] : (raw && typeof raw === 'object' ? Object.values(raw) : []);
  if (t && t.role) list.push(t.role);
  return list;
};
const tokensOf = t => {
  if (!t || typeof t !== 'object') return [];
  const dev = t.devices && typeof t.devices === 'object' ? Object.values(t.devices).map(d => d && d.token).filter(Boolean) : [];
  return dev.length ? dev : (t.token ? [t.token] : []);
};
function kitchenTargets(all) {
  const out = [];
  for (const t of Object.values(all || {})) if (roleList(t).some(r => KITCHEN_ROLES.includes(r))) out.push(...tokensOf(t));
  return [...new Set(out)];
}
async function send(token, sa, targets, msg, urgent) {
  const res = await Promise.allSettled(targets.map(t => fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { token: t,
      data: { title: msg.title, body: msg.body, tag: msg.tag, url: CABINET_URL },
      webpush: { headers: { Urgency: urgent ? 'high' : 'normal' }, fcmOptions: { link: CABINET_URL } } } })
  })));
  return res.filter(r => r.status === 'fulfilled' && r.value.ok).length;
}
const ok = body => ({ statusCode: 200, body: JSON.stringify(body) });
const p2 = n => String(n).padStart(2, '0');

exports.handler = async () => {
  try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error('FIREBASE_SERVICE_ACCOUNT не задано');
    const now = warsawParts();
    // Вікно роботи: від сніданкового дедлайну до кінця обідів
    if (now.hour < 7 || now.hour >= 16) return ok({ skip: 'поза вікном', at: now.hm });
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    const token = await accessToken(sa);
    const date = now.date;
    const [students, tokens] = await Promise.all([readDb(token, 'students_list'), readDb(token, 'push_tokens')]);
    const targets = kitchenTargets(tokens);
    if (!targets.length) return ok({ skip: 'на кухні ніхто не увімкнув сповіщення' });
    const classes = Object.keys(students || {});
    const [plans, mealDay, menu, years, schedules, ...att] = await Promise.all([
      readDb(token, 'meal_plan'), readDb(token, `meal_day/${date}`), readDb(token, `menu/${date}`),
      readDb(token, 'academic_year'), readDb(token, 'schedules').catch(() => null),
      ...classes.map(c => readDb(token, `attendance/${c}/${date}`))]);
    const day = kitchenDay(date, { students_list: students, meal_plan: plans, meal_day: mealDay, menu, schedules,
      academic_year: years, attendance: Object.fromEntries(classes.map((c, i) => [c, att[i]])) });
    if (day.closed) return ok({ skip: 'школа сьогодні не годує', date });

    let sent = 0;
    // Підсумок — лише зранку: якщо запуски чомусь пропали, о 15:00 «замовлення
    // закрито» вже нікому не допоможе, а лише заплутає
    if (now.hour >= 9 && now.hour < 11 && await claimFlag(token, `kitchen_notice/${date}/cutoff`)) {
      sent += await send(token, sa, targets, cutoffMessage(day), false);
      // Раз на день прибираємо старі позначки (старші за 14 днів)
      try {
        const keys = Object.keys(await readDb(token, 'kitchen_notice', true) || {});
        const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 14);
        const edge = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
        await Promise.all(keys.filter(k => k < edge).map(k =>
          fetch(`${DB}/kitchen_notice/${k}.json?access_token=${encodeURIComponent(token)}`, { method: 'DELETE' })));
      } catch (e) { /* прибирання не має зривати сповіщення */ }
    }
    const fresh = [];
    for (const r of day.late) {
      const key = `${r.cls}__${String(r.sid).replace(/[.#$\[\]\/]/g, '_')}`;
      if (await claimFlag(token, `kitchen_notice/${date}/late/${key}`)) fresh.push(r);
    }
    if (fresh.length) sent += await send(token, sa, targets, lateMessage(fresh, date), true);
    return ok({ date, at: now.hm, sent, late: fresh.length });
  } catch (e) {
    console.error('[kitchen-notify]', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
exports._test = { kitchenTargets };
