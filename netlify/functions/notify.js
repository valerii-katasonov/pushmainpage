// ══════════════════════════════════════════════════════════════════
//  Push School — надсилання сповіщень (Firebase Cloud Messaging v1)
// ══════════════════════════════════════════════════════════════════
// НАЛАШТУВАННЯ (один раз):
//   1. Firebase Console → Project settings → Service accounts →
//      Generate new private key → завантажиться JSON
//   2. Netlify → Site configuration → Environment variables →
//      FIREBASE_SERVICE_ACCOUNT = увесь вміст того JSON одним рядком
//   3. Redeploy
//
// ЧОМУ НЕ firebase-admin: щоб не тягнути npm-залежність і не змінювати
// збірку. Токен доступу отримуємо самі — підписуємо JWT вбудованим crypto
// (~30 рядків нижче) і міняємо його на OAuth-токен Google.
//
// ЧОМУ КЛІЄНТ ВИКЛИКАЄ ЦЮ ФУНКЦІЮ, А НЕ ТРИГЕР БАЗИ: оцінки пишуться в
// Realtime Database напряму з браузера, серверного гачка немає. Тригери
// доступні лише через Cloud Functions — це наступний крок, коли дійдуть
// руки до серверної авторизації. Поки що модель довіри така сама, як у
// решті порталу.

const crypto = require('crypto');
const ALLOWED_HOSTS = ['planlekcjipush.netlify.app', 'localhost', '127.0.0.1'];
const DB = 'https://test-4eb3e-default-rtdb.europe-west1.firebasedatabase.app';

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8'
  };
}
const fail = (code, msg, origin) => ({ statusCode: code, headers: cors(origin), body: JSON.stringify({ error: msg }) });
const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Кешуємо токен між викликами: Netlify часто перевикористовує процес,
// тож не ганяємо запит до Google на кожне сповіщення.
let cachedToken = null, cachedUntil = 0;
async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < cachedUntil - 60) return cachedToken;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const jwt = `${header}.${claim}.${b64url(signer.sign(sa.private_key))}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error_description || d.error || 'Не вдалося отримати токен доступу');
  cachedToken = d.access_token; cachedUntil = now + (d.expires_in || 3600);
  return cachedToken;
}

// Кому слати: усі, хто увімкнув сповіщення і кого стосується подія.
// Батьки — за прив'язаною дитиною; учень — за власним іменем.
async function findTargets(token, cls, studentName) {
  const r = await fetch(`${DB}/push_tokens.json?access_token=${encodeURIComponent(token)}`);
  const all = await r.json();
  if (!all || typeof all !== 'object') return [];
  const out = [];
  for (const uid in all) {
    const t = all[uid];
    if (!t || !t.token) continue;
    const isParent = t.role === 'parent', isStudent = t.role === 'student';
    if (!isParent && !isStudent) continue;
    if (t.class !== cls || t.studentName !== studentName) continue;
    out.push(t.token);
  }
  return [...new Set(out)];
}

// Меню стосується всіх одразу, тому шлемо однією розсилкою: 165 окремих
// викликів функції поклали б і ліміти Netlify, і квоту FCM.
async function findMealTargets(token) {
  const [rt, rp] = await Promise.all([
    fetch(`${DB}/push_tokens.json?access_token=${encodeURIComponent(token)}`),
    fetch(`${DB}/meal_plan.json?access_token=${encodeURIComponent(token)}`)
  ]);
  const all = await rt.json();
  const plans = (await rp.json()) || {};
  if (!all || typeof all !== 'object') return [];
  const out = [];
  for (const uid in all) {
    const t = all[uid];
    if (!t || !t.token) continue;
    if (t.role !== 'parent' && t.role !== 'student') continue;
    const plan = plans[t.class] && plans[t.class][t.studentName];
    if (plan && plan.lunch === false) continue; // не харчується — не турбуємо
    out.push(t.token);
  }
  return [...new Set(out)];
}

// Тексти подій. Імена дітей у сповіщення не пишемо: воно з'являється на
// екрані блокування, де його може побачити хто завгодно.
const EVENTS = {
  grade:      (p) => ({ title: '📊 Нова оцінка', body: `${p.subject || 'Предмет'}: ${p.value || ''}`.trim(), tag: 'grade' }),
  absence:    (p) => ({ title: '🚨 Відсутність на уроці', body: `Учитель відмітив відсутність${p.subject ? ' — ' + p.subject : ''}`, tag: 'absence' }),
  comment:    (p) => ({ title: '💬 Коментар учителя', body: p.subject ? `Новий коментар: ${p.subject}` : 'Новий коментар у щоденнику', tag: 'comment' }),
  homework:   (p) => ({ title: '📚 Нове завдання', body: `${p.subject || 'Предмет'}: задано домашнє завдання`, tag: 'hw' }),
  menu:       (p) => ({ title: p.value === 'upd' ? '🍽️ Меню змінено' : '🍽️ Меню опубліковано',
                        body: p.value === 'upd' ? `Кухня оновила меню${p.subject ? ' на ' + p.subject : ''}`
                                                : `Меню${p.subject ? ' на ' + p.subject : ''} вже в кабінеті`,
                        tag: 'menu' })
};

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(origin) };
  if (event.httpMethod !== 'POST') return fail(405, 'Метод не підтримується', origin);
  if (origin) {
    let host = ''; try { host = new URL(origin).hostname; } catch (e) {}
    if (!ALLOWED_HOSTS.includes(host)) return fail(403, 'Запит із невідомого джерела', origin);
  }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return fail(500, 'Сповіщення не налаштовані: потрібна змінна FIREBASE_SERVICE_ACCOUNT', origin);

  let sa, body;
  try { sa = JSON.parse(raw); } catch (e) { return fail(500, 'FIREBASE_SERVICE_ACCOUNT — некоректний JSON', origin); }
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return fail(400, 'Некоректний запит', origin); }

  const build = EVENTS[body.type];
  if (!build) return fail(400, 'Невідомий тип події', origin);
  const isBroadcast = body.type === 'menu';
  const cls = String(body.class || '').slice(0, 20);
  const studentName = String(body.studentName || '').slice(0, 120);
  if (!isBroadcast && (!cls || !studentName)) return fail(400, 'Не вказано клас або учня', origin);

  const msg = build({
    subject: String(body.subject || '').slice(0, 80),
    value: String(body.value || '').slice(0, 20)
  });

  try {
    const token = await getAccessToken(sa);
    const targets = isBroadcast ? await findMealTargets(token)
                                : await findTargets(token, cls, studentName);
    if (targets.length === 0)
      return { statusCode: 200, headers: cors(origin), body: JSON.stringify({ sent: 0, note: 'Немає підписників' }) };

    // data-only: показ бере на себе Service Worker — так вигляд сповіщення
    // однаковий і у фоні, і при відкритому порталі
    const url = `https://${ALLOWED_HOSTS[0]}/cabinet`;
    const results = await Promise.allSettled(targets.map(t =>
      fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: t,
            data: { title: msg.title, body: msg.body, tag: msg.tag, url },
            webpush: { headers: { Urgency: 'normal' }, fcmOptions: { link: url } }
          }
        })
      })
    ));
    const sent = results.filter(r => r.status === 'fulfilled' && r.value.ok).length;
    return { statusCode: 200, headers: cors(origin), body: JSON.stringify({ sent, total: targets.length }) };
  } catch (e) {
    return fail(500, 'Не вдалося надіслати: ' + e.message, origin);
  }
};
