// ══════════════════════════════════════════════════════════════════
//  Push School — звірка доступів
// ══════════════════════════════════════════════════════════════════
//
// ЩО РОБИТЬ: порівнює список акаунтів у Firebase Authentication зі
// списками школи й показує, де вони розходяться.
//
// НАВІЩО. Цілий день пішов на розбір випадку, який видно було б за
// секунду: людину внесли в Authentication, а в порталі не завели. Ні
// директор, ні вчитель не могли цього побачити — портал знає лише свої
// списки, консоль Firebase лише свої, і зіставити їх не було чим.
//
// Дві колонки, дві різні біди:
//
//   • НЕМАЄ АКАУНТА — людина в списках школи є, але жодного разу не
//     заходила. Найчастіше просто не знає, що портал існує. Це список
//     тих, кому варто нагадати.
//
//   • НЕМАЄ В СПИСКАХ — акаунт є, а в жодному зі списків школи цієї
//     пошти немає. Такий акаунт нічого не бачить (портал не пустить),
//     але й узятися нізвідки не мав: або людину видалили зі школи й
//     забули про акаунт, або вона створила його сама, коли це ще було
//     можливо.
//
// ХТО МОЖЕ: лише директор і адміністратор. Тут видно всі пошти школи
// разом, і це не той список, який має бачити вчитель.
//
// НАЛАШТУВАННЯ: FIREBASE_SERVICE_ACCOUNT — та сама змінна, що вже є.

const crypto = require('crypto');

const ALLOWED_HOSTS = ['planlekcjipush.netlify.app', 'localhost', '127.0.0.1'];
const DB = 'https://test-4eb3e-default-rtdb.europe-west1.firebasedatabase.app';
const IDT = 'https://identitytoolkit.googleapis.com/v1';
const WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || 'AIzaSyA3OA9pcR1zscUtEPWD8LEKTKonAN5Y90c';
const PUPIL_DOMAIN = 'pupil.push.local';
const PAGE = 1000;          // скільки акаунтів за один запит
const MAX_PAGES = 20;       // стеля: 20 000 акаунтів вистачить будь-якій школі

function originAllowed(origin){
  if(!origin) return false;
  let host;
  try{ host = new URL(origin).hostname; }catch(e){ return false; }
  return ALLOWED_HOSTS.includes(host);
}
function cors(origin){
  const h = {
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8'
  };
  if(originAllowed(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}
const fail = (code, msg, origin) =>
  ({ statusCode: code, headers: cors(origin), body: JSON.stringify({ error: msg }) });
const ok = (obj, origin) =>
  ({ statusCode: 200, headers: cors(origin), body: JSON.stringify(Object.assign({ ok: true }, obj)) });

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const emailKey = (e) => String(e || '').trim().toLowerCase().replace(/\./g, '_');

let cachedToken = null, cachedUntil = 0;
async function getAccessToken(sa){
  const now = Math.floor(Date.now() / 1000);
  if(cachedToken && now < cachedUntil - 60) return cachedToken;
  const header = b64url(JSON.stringify({ alg:'RS256', typ:'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: ['https://www.googleapis.com/auth/firebase.database',
            'https://www.googleapis.com/auth/identitytoolkit',
            'https://www.googleapis.com/auth/userinfo.email'].join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const jwt = `${header}.${claim}.${b64url(signer.sign(sa.private_key))}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt })
  });
  const j = await r.json();
  if(!j.access_token) throw new Error('OAuth: ' + (j.error_description || j.error || 'немає токена'));
  cachedToken = j.access_token; cachedUntil = now + (j.expires_in || 3600);
  return cachedToken;
}

async function readDb(token, path){
  const r = await fetch(`${DB}/${path}.json?access_token=${encodeURIComponent(token)}`);
  const t = await r.text();
  if(!r.ok) throw new Error(`База (${path})`);
  return t === 'null' ? null : JSON.parse(t);
}

async function verifyIdToken(idToken){
  const r = await fetch(`${IDT}/accounts:lookup?key=${WEB_API_KEY}`, {
    method:'POST', headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ idToken })
  });
  const j = await r.json();
  const u = j.users && j.users[0];
  if(!u || !u.email) throw new Error('Не вдалося підтвердити, хто робить запит.');
  return { uid: u.localId, email: String(u.email).toLowerCase() };
}

// Усі акаунти проєкту, посторінково.
async function listAllUsers(token){
  const out = [];
  let pageToken = '';
  for(let i = 0; i < MAX_PAGES; i++){
    const r = await fetch(`${IDT}/projects/-/accounts:batchGet?maxResults=${PAGE}`
      + (pageToken ? `&nextPageToken=${encodeURIComponent(pageToken)}` : ''), {
      headers: { Authorization: 'Bearer ' + token }
    });
    const j = await r.json();
    if(j.error) throw new Error(j.error.message || 'не вдалося прочитати список акаунтів');
    (j.users || []).forEach(u => {
      if(u.email) out.push({ email: String(u.email).toLowerCase(),
                             createdAt: Number(u.createdAt) || 0,
                             lastLoginAt: Number(u.lastLoginAt) || 0,
                             disabled: !!u.disabled });
    });
    pageToken = j.nextPageToken || '';
    if(!pageToken) break;
  }
  return out;
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  if(!originAllowed(origin)) return fail(403, 'Запит не з порталу', origin);
  if(event.httpMethod === 'OPTIONS') return { statusCode:204, headers:cors(origin), body:'' };
  if(event.httpMethod !== 'POST') return fail(405, 'Тільки POST', origin);

  let body;
  try{ body = JSON.parse(event.body || '{}'); }
  catch(e){ return fail(400, 'Пошкоджений запит', origin); }
  if(!body.idToken) return fail(401, 'Немає підтвердження входу', origin);

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if(!raw) return fail(503, 'На сервері не задано FIREBASE_SERVICE_ACCOUNT', origin);
  let sa;
  try{ sa = JSON.parse(raw); }
  catch(e){ return fail(503, 'FIREBASE_SERVICE_ACCOUNT не читається як JSON', origin); }

  try{
    const me = await verifyIdToken(body.idToken);
    const token = await getAccessToken(sa);

    // Роль беремо з бази, а не зі слів браузера.
    const meRec = await readDb(token, `users/${me.uid}`);
    const role = meRec && meRec.role;
    if(role !== 'director' && role !== 'administrator')
      return fail(403, 'Цей розділ доступний лише директору та адміністрації.', origin);

    const [staff, parents, students] = await Promise.all([
      readDb(token, 'pre_approved_roles'),
      readDb(token, 'parent_links'),
      readDb(token, 'student_links')
    ]);

    // Ключ → чим людина є в школі. Один ключ може бути в кількох списках.
    const school = new Map();
    const add = (obj, what) => {
      for(const rawKey in (obj || {})) {
        // Ключ зі списку теж зводимо до нижнього регістру.
        //
        // Firebase зберігає пошту завжди малими, а в списках школи через
        // Excel трапляється «Kateryna_Norkina@gmail_com». Якби порівнювали
        // як є, одна й та сама людина потрапила б ОДРАЗУ В ОБИДВІ колонки:
        // «немає акаунта» і «немає у списках». Саме та плутанина, заради
        // якої цей розділ і робився.
        const k = rawKey.toLowerCase();
        const cur = school.get(k) || [];
        cur.push(what);
        school.set(k, cur);
      }
    };
    add(staff, 'персонал');
    add(parents, 'батьки');
    add(students, 'учень');

    const users = await listAllUsers(token);
    const haveAccount = new Set(users.map(u => emailKey(u.email)));

    // 1. У списках є, акаунта немає.
    const noAccount = [];
    for(const [key, roles] of school){
      if(haveAccount.has(key)) continue;
      noAccount.push({ email: key.replace(/_/g, '.'), key, where: roles.join(', ') });
    }

    // 2. Акаунт є, у списках немає.
    const orphan = [];
    for(const u of users){
      // Нікнейми учнів — технічні адреси, у списках школи їх і не має
      // бути в цьому вигляді. Вони живуть у student_links під власним
      // ключем, тож перевіряємо так само, але не лякаємо директора
      // тим, чого він не замовляв.
      if(u.email.endsWith('@' + PUPIL_DOMAIN)){
        if(school.has(emailKey(u.email))) continue;
        orphan.push({ email: u.email, kind: 'нікнейм учня',
                      createdAt: u.createdAt, lastLoginAt: u.lastLoginAt });
        continue;
      }
      if(school.has(emailKey(u.email))) continue;
      orphan.push({ email: u.email, kind: 'пошта',
                    createdAt: u.createdAt, lastLoginAt: u.lastLoginAt });
    }

    const byEmail = (a, b) => a.email.localeCompare(b.email, 'uk');
    return ok({
      total: { school: school.size, accounts: users.length },
      noAccount: noAccount.sort(byEmail),
      orphan: orphan.sort(byEmail)
    }, origin);
  }catch(e){
    console.error('[access-audit]', e && e.message);
    return fail(500, 'Не вдалося звірити доступи: ' + (e && e.message || ''), origin);
  }
};
