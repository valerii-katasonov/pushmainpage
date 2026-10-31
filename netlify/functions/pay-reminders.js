// ══════════════════════════════════════════════════════════════════
//  Push School — нагадування батькам про оплату за навчання
// ══════════════════════════════════════════════════════════════════
// ЩО РОБИТЬ. З вересня по червень, 1-го і 10-го числа о 9:00 за Варшавою,
// шле push усім батькам (учням — ні):
//   • 1-го — «нагадуємо про оплату за навчання до 10 числа»;
//   • 10-го — м'яке нагадування, що сьогодні останній день, і що тим, хто
//     вже сплатив, — дякуємо (портал не знає, хто заплатив: звірка оплат
//     ручна, тож текст не має звучати як докір).
// Натискання відкриває вкладку «💳 Оплата» (?open=pay).
//
// ОПЛАТА НА МІСЯЦЬ НАПЕРЕД (рішення школи): у листопаді платять за
// грудень. Літні місяці пропускаються — у червні платять уже за вересень.
// Тому в тексті — НАСТУПНИЙ навчальний місяць (payMonth).
//
// ВИМКНУТИ: директор знімає галочку в налаштуваннях оплати
// (payment_details.remind === false).
//
// ЧОМУ РОЗКЛАД ДВІЧІ (netlify.toml: 7:00 і 8:00 UTC). Netlify живе за
// Гринвічем, Варшава — то +1, то +2. Працює лише запуск, коли у Варшаві
// 9-та. Позначка pay_reminder_sent/{дата} не дасть надіслати двічі.
//
// ЗМІННА ТА САМА: FIREBASE_SERVICE_ACCOUNT. Код токена свідомо повторює
// birthday-reminders.js (чому — пояснено там).

const crypto = require('crypto');
const DB = 'https://test-4eb3e-default-rtdb.europe-west1.firebasedatabase.app';
const { SITE_URL: SITE } = require('./lib/site');
const SEND_HOUR = 9;
const SCHOOL_MONTHS = [9, 10, 11, 12, 1, 2, 3, 4, 5, 6];
const MONTH_NAME = ['січень', 'лютий', 'березень', 'квітень', 'травень', 'червень', 'липень', 'серпень', 'вересень', 'жовтень', 'листопад', 'грудень'];

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({ iss: sa.client_email,
    scope: ['https://www.googleapis.com/auth/firebase.messaging', 'https://www.googleapis.com/auth/firebase.database',
            'https://www.googleapis.com/auth/userinfo.email'].join(' '),
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const jwt = `${header}.${claim}.${b64url(signer.sign(sa.private_key))}`;
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error_description || d.error || 'Не вдалося отримати токен доступу');
  return d.access_token;
}
async function readDb(token, path) {
  const r = await fetch(`${DB}/${path}.json?access_token=${encodeURIComponent(token)}`);
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`база недоступна (${path}): ${(d && d.error) || r.status}`);
  return d;
}
async function writeDb(token, path, value) {
  const r = await fetch(`${DB}/${path}.json?access_token=${encodeURIComponent(token)}`, { method: 'PUT', body: JSON.stringify(value) });
  if (!r.ok) throw new Error(`не вдалося записати ${path}: ${r.status}`);
}
function warsawNow(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, month: Number(p.month), day: Number(p.day), hour: Number(p.hour) };
}
const emailKey = (e) => String(e || '').trim().toLowerCase().replace(/\./g, '_');

// За який місяць платимо: наступний навчальний (червень → вересень)
function payMonth(month){
  const i = SCHOOL_MONTHS.indexOf(month);
  return i < 0 ? month : SCHOOL_MONTHS[(i + 1) % SCHOOL_MONTHS.length];
}
// Яке нагадування сьогодні: 'first' | 'last' | null
function kindFor(now){
  if (!SCHOOL_MONTHS.includes(now.month)) return null;
  return now.day === 1 ? 'first' : now.day === 10 ? 'last' : null;
}
function messageFor(kind, month){
  const m = MONTH_NAME[payMonth(month) - 1];
  if (kind === 'first') return {
    title: '💳 Оплата за навчання',
    body: `Дорогі батьки, нагадуємо про оплату за навчання за ${m} — до 10 числа. Реквізити — у розділі «Оплата».`
  };
  return {
    title: '💳 Сьогодні — останній день оплати',
    body: `Дорогі батьки, сьогодні останній день оплати за навчання за ${m}. Якщо ви вже сплатили — щиро дякуємо, це повідомлення можна не брати до уваги. Реквізити — у розділі «Оплата».`
  };
}
// Класи, за які є рахунок «Навчання» (payment.js: kind 'tuition' або
// старий запис без виду; старий формат одним набором — усі класи).
// Немає жодного — нагадувати нема про що: батьки відкрили б «Оплату» й
// побачили «школа ще не додала».
function tuitionClasses(pd){
  const out = new Set();
  if (!pd || typeof pd !== 'object') return out;
  if (pd.accounts && typeof pd.accounts === 'object') {
    for (const id in pd.accounts) {
      const a = pd.accounts[id];
      if (!a || !a.iban || (a.kind && a.kind !== 'tuition')) continue;
      const f = Number.isInteger(a.from) ? a.from : 0, t = Number.isInteger(a.to) ? a.to : 11;
      for (let n = Math.min(f, t); n <= Math.max(f, t); n++) out.add(n);
    }
  } else if (pd.iban) for (let n = 0; n <= 11; n++) out.add(n);
  return out;
}
const kidsOf = link => {
  const c = link && link.children;
  return (Array.isArray(c) ? c : (c && typeof c === 'object' ? Object.values(c) : [])).filter(k => k && k.class);
};
// Пристрої батьків, у чиєї дитини клас із рахунком «Навчання» (учням — ні).
// Пошту беремо з users (її пише вхід), запасний шлях — з самого запису токена.
function parentTokens(tokens, parents, classes, users){
  const want = new Set(Object.keys(parents || {}).filter(se => !classes || kidsOf(parents[se]).some(k => {
    const m = /^class_(\d{1,2})$/.exec(String(k.class)); return m && classes.has(Number(m[1]));
  })).map(k => k.toLowerCase()));
  const out = [];
  for (const uid in (tokens || {})) {
    const t = tokens[uid];
    const mail = (users && users[uid] && users[uid].email) || (t && t.email);
    if (!t || !mail || !want.has(emailKey(mail))) continue;
    const dev = (t.devices && typeof t.devices === 'object') ? Object.values(t.devices).map(d => d && d.token).filter(Boolean) : [];
    out.push(...(dev.length ? dev : (t.token ? [t.token] : [])));
  }
  return [...new Set(out)];
}

exports.handler = async () => {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) { console.log('FIREBASE_SERVICE_ACCOUNT не задано — нагадування не надсилаються'); return { statusCode: 200, body: 'no service account' }; }
  let sa; try { sa = JSON.parse(raw); } catch (e) { return { statusCode: 200, body: 'bad json' }; }
  const now = warsawNow();
  if (now.hour !== SEND_HOUR) return { statusCode: 200, body: `не та година (${now.hour})` };
  const kind = kindFor(now);
  if (!kind) return { statusCode: 200, body: 'сьогодні нагадування немає' };
  try {
    const token = await getAccessToken(sa);
    // Налаштування без «тихого» запасного шляху: якщо база не відповіла,
    // краще не надіслати, ніж проігнорувати вимкнені директором нагадування
    const settings = await readDb(token, 'payment_details');
    if (settings && settings.remind === false) return { statusCode: 200, body: 'нагадування вимкнено' };
    const classes = tuitionClasses(settings);
    if (!classes.size) return { statusCode: 200, body: 'немає рахунку «Навчання» — нагадувати нема про що' };
    const done = await readDb(token, `pay_reminder_sent/${now.date}`).catch(() => null);
    if (done) return { statusCode: 200, body: 'сьогодні вже надіслано' };
    const [tokens, parents, users] = await Promise.all([readDb(token, 'push_tokens'), readDb(token, 'parent_links'), readDb(token, 'users')]);
    const targets = parentTokens(tokens, parents, classes, users);
    // Позначку ставимо ПІСЛЯ читання: якщо база не віддала списки, день не
    // «згорає» (другий запуск того ранку — не 9-та, тож повтору все одно немає,
    // але й фальшивої позначки «надіслано» теж)
    await writeDb(token, `pay_reminder_sent/${now.date}`, kind);
    const m = messageFor(kind, now.month);
    const url = `${SITE}/cabinet?open=pay`;
    const results = await Promise.allSettled(targets.map(t =>
      fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { token: t, data: { title: m.title, body: m.body, tag: `pay-${now.date}`, url },
          webpush: { headers: { Urgency: 'normal' }, fcmOptions: { link: url } } } })
      })));
    const sent = results.filter(r => r.status === 'fulfilled' && r.value.ok).length;
    const note = `${kind}: пристроїв ${targets.length}, надіслано ${sent}`;
    console.log('Оплата: ' + note);
    return { statusCode: 200, body: note };
  } catch (e) {
    console.log('Оплата — помилка: ' + e.message);
    return { statusCode: 200, body: 'error: ' + e.message };
  }
};
exports._test = { kindFor, messageFor, parentTokens, warsawNow, payMonth, tuitionClasses };
