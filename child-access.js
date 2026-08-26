// ═══════════════════════════════════════════════════════════════
//  Push School — доступ дитини до порталу
// ═══════════════════════════════════════════════════════════════
// ЩО РОБИТЬ: батько зі свого кабінету створює дитині вхід, змінює їй
// пароль або вимикає доступ. Усе це вимагає адміністративних прав у
// Firebase Authentication, яких у браузера немає й не має бути.
//
// ЧОМУ ОКРЕМА ФУНКЦІЯ, А НЕ КОД У КАБІНЕТІ: створення чужого акаунта і
// зміна чужого пароля — операції службового акаунта. Якби вони робилися
// з браузера, ключ довелося б покласти в код сторінки, і тоді будь-хто
// зміг би змінити пароль будь-кому.
//
// ЧОМУ БЕЗ firebase-admin: та сама причина, що й у notify.js — не тягнемо
// npm-залежність. JWT підписуємо вбудованим crypto, далі ходимо в
// Identity Toolkit і Realtime Database звичайним fetch.
//
// НАЛАШТУВАННЯ: ті самі змінні Netlify, що вже є для сповіщень —
// FIREBASE_SERVICE_ACCOUNT. Додатково потрібен FIREBASE_WEB_API_KEY
// (Firebase Console → Project settings → General → Web API Key); якщо
// його не задати, візьметься ключ, зашитий у порталі.
//
// МОДЕЛЬ ДОВІРИ. Функція нікому не вірить на слово:
//   1. клієнт присилає свій idToken; ми перевіряємо його в Google і
//      дізнаємося справжню пошту того, хто просить;
//   2. читаємо parent_links цієї пошти службовим доступом і звіряємо,
//      що дитина справді його;
//   3. лише після цього чіпаємо акаунт.
// Підмінити чужу дитину в запиті не вийде: перевірка йде по базі, а не
// по тому, що прислав браузер.

const crypto = require('crypto');

const ALLOWED_HOSTS = ['planlekcjipush.netlify.app', 'localhost', '127.0.0.1'];
const DB = 'https://test-4eb3e-default-rtdb.europe-west1.firebasedatabase.app';
const WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || 'AIzaSyA3OA9pcR1zscUtEPWD8LEKTKonAN5Y90c';
const IDT = 'https://identitytoolkit.googleapis.com/v1';

// Технічний домен для входу за нікнеймом. Листи туди не ходять — це
// просто спосіб дати Firebase адресу там, де пошти немає.
const PUPIL_DOMAIN = 'pupil.push.local';
const MIN_PASSWORD = 6;

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8'
  };
}
const fail = (code, msg, origin) =>
  ({ statusCode: code, headers: cors(origin), body: JSON.stringify({ error: msg }) });
const ok = (obj, origin) =>
  ({ statusCode: 200, headers: cors(origin), body: JSON.stringify(Object.assign({ ok: true }, obj)) });

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const safeEmail = (e) => String(e || '').toLowerCase().replace(/\./g, '_');
const normalizeNick = (v) => String(v || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');

// ── Токен службового акаунта ──
let cachedToken = null, cachedUntil = 0;
async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < cachedUntil - 60) return cachedToken;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: [
      'https://www.googleapis.com/auth/firebase.database',
      'https://www.googleapis.com/auth/identitytoolkit',
      'https://www.googleapis.com/auth/userinfo.email'
    ].join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const jwt = `${header}.${claim}.${b64url(signer.sign(sa.private_key))}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt
    })
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('OAuth: ' + (j.error_description || j.error || 'немає токена'));
  cachedToken = j.access_token;
  cachedUntil = now + (j.expires_in || 3600);
  return cachedToken;
}

// ── Realtime Database службовим доступом ──
async function readDb(token, path) {
  const r = await fetch(`${DB}/${path}.json?access_token=${encodeURIComponent(token)}`);
  const t = await r.text();
  if (!r.ok) throw new Error(`База (${path}): ${t.slice(0, 200)}`);
  return t === 'null' ? null : JSON.parse(t);
}
async function patchDb(token, path, obj) {
  const r = await fetch(`${DB}/${path}.json?access_token=${encodeURIComponent(token)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj)
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`Запис (${path}): ${t.slice(0, 200)}`);
}

// ── Identity Toolkit ──
// Перевірка чужого токена: єдиний спосіб дізнатися, хто саме просить.
// Довіряти пошті з тіла запиту не можна — її підставить будь-хто.
async function verifyIdToken(idToken) {
  const r = await fetch(`${IDT}/accounts:lookup?key=${WEB_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken })
  });
  const j = await r.json();
  const u = j.users && j.users[0];
  if (!u || !u.email) throw new Error('Не вдалося підтвердити, хто робить запит. Увійдіть у портал заново.');
  return { uid: u.localId, email: String(u.email).toLowerCase() };
}

async function findUserByEmail(token, email) {
  const r = await fetch(`${IDT}/projects/-/accounts:lookup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ email: [email] })
  });
  const j = await r.json();
  return (j.users && j.users[0]) || null;
}

async function createUser(token, email, password) {
  const r = await fetch(`${IDT}/projects/-/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ email, password, emailVerified: false })
  });
  const j = await r.json();
  if (j.error) throw new Error(idtMessage(j.error.message));
  return j.localId;
}

async function updateUser(token, localId, fields) {
  const r = await fetch(`${IDT}/projects/-/accounts:update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(Object.assign({ localId }, fields))
  });
  const j = await r.json();
  if (j.error) throw new Error(idtMessage(j.error.message));
  return j;
}

// Технічні коди Google — людською мовою
function idtMessage(code) {
  const m = {
    EMAIL_EXISTS: 'Цей нікнейм або пошта вже зайняті — придумайте інші.',
    INVALID_EMAIL: 'Нікнейм містить недопустимі символи.',
    WEAK_PASSWORD: `Пароль занадто простий — мінімум ${MIN_PASSWORD} символів.`,
    'WEAK_PASSWORD : Password should be at least 6 characters':
      `Пароль занадто простий — мінімум ${MIN_PASSWORD} символів.`
  };
  return m[code] || ('Firebase: ' + code);
}

// ── Чи справді ця дитина належить цьому батькові ──
// Джерело істини — parent_links, який веде школа. Те, що прислав
// браузер, тут не враховується взагалі.
function findChild(links, studentId, cls) {
  if (!links) return null;
  const raw = links.children || [];
  const list = Array.isArray(raw) ? raw : Object.values(raw);
  return list.find(k => k && (
    (studentId && k.studentId === studentId) ||
    (!studentId && cls && k.class === cls)
  )) || null;
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(origin), body: '' };
  if (event.httpMethod !== 'POST') return fail(405, 'Тільки POST', origin);

  // Функція міняє паролі, тож приймаємо запити лише зі свого сайту
  if (origin && !ALLOWED_HOSTS.some(h => origin.includes(h)))
    return fail(403, 'Запит не з порталу', origin);

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return fail(400, 'Пошкоджений запит', origin); }

  const action = body.action;
  if (!['create', 'password', 'disable', 'enable'].includes(action))
    return fail(400, 'Невідома дія', origin);
  if (!body.idToken) return fail(401, 'Немає підтвердження входу', origin);

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return fail(500, 'На сервері не задано FIREBASE_SERVICE_ACCOUNT', origin);
  let sa;
  try { sa = JSON.parse(raw); }
  catch (e) { return fail(500, 'FIREBASE_SERVICE_ACCOUNT не читається як JSON', origin); }

  try {
    const token = await getAccessToken(sa);
    const me = await verifyIdToken(body.idToken);
    const parentSe = safeEmail(me.email);

    // 1. Чи це взагалі батько і чи його це дитина
    const links = await readDb(token, `parent_links/${parentSe}`);
    if (!links) return fail(403, 'Ваша пошта не позначена як батьківська. Зверніться до школи.', origin);

    const studentId = String(body.studentId || '');
    const child = findChild(links, studentId, body.class);
    if (!child) return fail(403, 'Ця дитина не привʼязана до вашого акаунта.', origin);

    const cls = child.class;
    const studentName = child.studentName || '';
    // Ключ рядка в child_access. Для старих записів без постійного
    // ідентифікатора беремо клас — так само, як робить кабінет.
    const sid = child.studentId || studentId || ('cls_' + cls);
    if (!cls || !studentName) return fail(400, 'У картці дитини бракує класу або імені.', origin);

    // ── СТВОРЕННЯ ДОСТУПУ ──
    if (action === 'create') {
      const nick = normalizeNick(body.nick);
      const realEmail = String(body.email || '').trim().toLowerCase();
      if (!nick && !realEmail)
        return fail(400, 'Вкажіть нікнейм або пошту дитини.', origin);
      if (nick && nick.length < 3)
        return fail(400, 'Нікнейм — щонайменше 3 символи: латинські літери, цифри, крапка, дефіс.', origin);
      const password = String(body.password || '');
      if (password.length < MIN_PASSWORD)
        return fail(400, `Пароль — щонайменше ${MIN_PASSWORD} символів.`, origin);

      // Пошта, якщо вказана, головніша: за нею працює відновлення пароля.
      // Нікнейм лишається як зручний логін.
      const loginEmail = realEmail || (nick + '@' + PUPIL_DOMAIN);

      const existing = await findUserByEmail(token, loginEmail);
      if (existing) return fail(409, 'Такий нікнейм або пошта вже зайняті — придумайте інші.', origin);

      const uid = await createUser(token, loginEmail, password);

      // student_links — те, з чого портал збирає кабінет учня при вході
      await patchDb(token, `student_links/${safeEmail(loginEmail)}`,
                    { studentName, studentId: sid, class: cls });
      await patchDb(token, `child_access/${parentSe}/${sid}`, {
        nick: nick || '', email: realEmail || '', login: loginEmail,
        uid, studentName, class: cls, disabled: false, ts: Date.now()
      });

      return ok({ login: loginEmail, nick: nick || '', uid }, origin);
    }

    // Далі — дії над уже створеним доступом
    const acc = await readDb(token, `child_access/${parentSe}/${sid}`);
    if (!acc || !acc.login) return fail(404, 'У цієї дитини ще немає доступу до порталу.', origin);
    const user = await findUserByEmail(token, acc.login);
    if (!user) return fail(404, 'Акаунт дитини не знайдено — можливо, його видалили.', origin);

    if (action === 'password') {
      const password = String(body.password || '');
      if (password.length < MIN_PASSWORD)
        return fail(400, `Пароль — щонайменше ${MIN_PASSWORD} символів.`, origin);
      await updateUser(token, user.localId, { password });
      await patchDb(token, `child_access/${parentSe}/${sid}`, { pwdChangedAt: Date.now() });
      return ok({ login: acc.login }, origin);
    }

    if (action === 'disable' || action === 'enable') {
      const off = action === 'disable';
      await updateUser(token, user.localId, { disableUser: off });
      await patchDb(token, `child_access/${parentSe}/${sid}`, { disabled: off, ts: Date.now() });
      return ok({ disabled: off }, origin);
    }

    return fail(400, 'Невідома дія', origin);
  } catch (e) {
    return fail(500, e.message || 'Невідома помилка', origin);
  }
};
