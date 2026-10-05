// ══════════════════════════════════════════════════════════════════
//  Push School — «📅 Зміни в розкладі» ОДРАЗУ після збереження картки уроку
// ══════════════════════════════════════════════════════════════════
// Директор зберігає картку уроку з галочкою «🔔 Одразу повідомити батьків»
// — кабінет кличе цю функцію з класами, які щойно змінилися.
//
// ЩО ПРИХОДИТЬ ВІД КЛІЄНТА: лише idToken входу, перелік класів і режим.
// Текст сповіщення сервер складає сам — порівнянням розкладу зі знімком
// (як і щогодинна schedule-changes). Тому підробити «зміну розкладу» з
// чужим текстом неможливо, а хто кличе — перевіряємо за idToken у Google
// і за роллю в базі.
//
// РЕЖИМИ
//   now    — порівняти й одразу розіслати; знімок оновлюється, тож
//            щогодинна звірка вдруге про те саме не скаже. Уночі (21–7)
//            не шлемо: позначаємо «готове до відправки» — піде о 7:00.
//   silent — галочку знято: це виправлення, родинам не кажемо. Знімок
//            оновлюємо без розсилки.
const { ALLOWED_HOSTS } = require('./lib/site');
const { STABLE_MIN, QUIET_FROM, QUIET_TO, getAccessToken, readDb, writeDb, warsawNow, snapshotOf, hashOf, diffSnapshots,
        summarize, sendToClass, catalogFor } = require('./lib/schedule-core');

const IDT = 'https://identitytoolkit.googleapis.com/v1';
const WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || 'AIzaSyA3OA9pcR1zscUtEPWD8LEKTKonAN5Y90c';
const ADMIN_ROLES = ['director', 'administrator'];

function originAllowed(origin) {
  if (!origin) return false;
  try { return ALLOWED_HOSTS.includes(new URL(origin).hostname); } catch (e) { return false; }
}
const cors = origin => ({ 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8', ...(originAllowed(origin) ? { 'Access-Control-Allow-Origin': origin } : {}) });
const reply = (code, obj, origin) => ({ statusCode: code, headers: cors(origin), body: JSON.stringify(obj) });
const emailKey = e => String(e || '').trim().toLowerCase().replace(/\./g, '_');

async function verifyIdToken(idToken) {
  const r = await fetch(`${IDT}/accounts:lookup?key=${WEB_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) });
  const j = await r.json().catch(() => ({}));
  const u = j.users && j.users[0];
  if (!u || !u.email) throw new Error('Не вдалося підтвердити, хто робить запит');
  return { uid: u.localId, email: String(u.email).toLowerCase() };
}
const rolesOf = rec => [rec && rec.role, ...(Array.isArray(rec && rec.roles) ? rec.roles : Object.values((rec && rec.roles) || {}))].filter(Boolean);

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  if (!originAllowed(origin)) return reply(403, { error: 'Запит не з порталу' }, origin);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(origin), body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Тільки POST' }, origin);
  let body; try { body = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { error: 'Пошкоджений запит' }, origin); }
  const mode = body.mode === 'silent' ? 'silent' : 'now';
  const classes = [...new Set((Array.isArray(body.classes) ? body.classes : []).filter(c => /^class_\d{1,2}$/.test(String(c))))].slice(0, 11);
  if (!body.idToken) return reply(401, { error: 'Немає підтвердження входу' }, origin);
  if (!classes.length) return reply(400, { error: 'Не вказано класи' }, origin);
  let sa; try { sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || ''); } catch (e) { return reply(503, { error: 'Сповіщення не налаштовані' }, origin); }
  try {
    const me = await verifyIdToken(body.idToken);
    const token = await getAccessToken(sa);
    // Хто може: адміністрація — будь-який клас; учитель — лише класи з
    // доступом (так само, як правила бази дозволяють йому писати розклад).
    const [rec, access] = await Promise.all([readDb(token, `users/${me.uid}`), readDb(token, `teacher_access/${emailKey(me.email)}`).catch(() => null)]);
    const isAdmin = rolesOf(rec).some(r => ADMIN_ROLES.includes(r));
    const denied = classes.filter(c => !isAdmin && !(access && access[c]));
    if (denied.length) return reply(403, { error: 'Немає доступу до класу: ' + denied.join(', ') }, origin);

    const now = warsawNow(), quiet = now.hour >= QUIET_FROM || now.hour < QUIET_TO;
    const [catalogs, dir] = await Promise.all([catalogFor(token, now), readDb(token, 'staff_directory').catch(() => null)]);
    const nameOf = e => (dir && dir[e] && dir[e].name) || String(e).replace(/_/g, '.');
    const result = {};
    for (const cls of classes) {
      const [lessons, w] = await Promise.all([readDb(token, `schedules/${cls}/lessons`), readDb(token, `schedule_watch/${cls}`)]);
      const snap = snapshotOf(lessons || {}, catalogs && catalogs[cls]), h = hashOf(snap);
      if (!w || !w.snap) {                         // знімка ще немає — нема з чим порівнювати
        await writeDb(token, `schedule_watch/${cls}`, { snap, hash: h });
        result[cls] = { status: 'baseline' }; continue;
      }
      if (w.hash === h) { result[cls] = { status: 'nochange' }; continue; }
      if (mode === 'silent') {
        await writeDb(token, `schedule_watch/${cls}`, { snap, hash: h });
        result[cls] = { status: 'silent' }; continue;
      }
      const lines = summarize(diffSnapshots(w.snap, snap), nameOf);
      if (!lines.length) {                         // змінилося лише те, що родинам не цікаво (перерви)
        await writeDb(token, `schedule_watch/${cls}`, { snap, hash: h });
        result[cls] = { status: 'nochange' }; continue;
      }
      if (quiet) {                                 // уночі — нехай піде о 7:00 зі щогодинною звіркою
        await writeDb(token, `schedule_watch/${cls}`, { ...w, pendingHash: h, pendingSince: Date.now() - STABLE_MIN * 60e3 });
        result[cls] = { status: 'queued', lines }; continue;
      }
      const sent = await sendToClass(token, sa, cls, lines);
      await writeDb(token, `schedule_watch/${cls}`, { snap, hash: h });
      result[cls] = { status: 'sent', sent, lines };
    }
    return reply(200, { ok: true, result }, origin);
  } catch (e) {
    return reply(500, { error: e.message }, origin);
  }
};
