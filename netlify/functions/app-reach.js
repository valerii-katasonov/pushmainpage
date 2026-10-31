// ══════════════════════════════════════════════════════════════════
//  Push School — хто встановив застосунок і отримує сповіщення
// ══════════════════════════════════════════════════════════════════
//
// НАВІЩО. Школа шле сповіщення про оцінки, відсутність, оголошення,
// перездачі — але частина батьків і вчителів їх просто не отримує: не
// встановили застосунок, не дали дозволу або жодного разу не заходили.
// Ззовні цього не видно, і «я нічого не отримував» дізнаються вже після.
//
// ЩО ПОКАЗУЄ про кожну людину:
//   • чи заходила взагалі (є запис users з цією поштою);
//   • чи відкривала портал як ВСТАНОВЛЕНИЙ застосунок (app_seen.standaloneAt,
//     пише сам кабінет при вході — common.js → reportAppSeen);
//   • чи увімкнені сповіщення хоч на одному пристрої (push_tokens);
//   • дозвіл браузера на сповіщення й коли востаннє заходила.
//
// ХТО ЩО БАЧИТЬ:
//   • директор і адміністрація — персонал і всі родини школи;
//   • учитель — лише родини (і учнів) СВОЇХ класів: де має доступ у
//     teacher_access або є класним керівником. Персоналу не бачить.
// Самих токенів і технічних даних пристроїв назовні не віддаємо.
//
// НАЛАШТУВАННЯ: FIREBASE_SERVICE_ACCOUNT — та сама змінна, що вже є.

const crypto = require('crypto');
const { ALLOWED_HOSTS } = require('./lib/site');
const DB = 'https://test-4eb3e-default-rtdb.europe-west1.firebasedatabase.app';
const IDT = 'https://identitytoolkit.googleapis.com/v1';
const WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || 'AIzaSyA3OA9pcR1zscUtEPWD8LEKTKonAN5Y90c';
const TEACH_ROLES = ['teacher', 'class_teacher', 'art_school_teacher', 'music_teacher', 'master_class_teacher'];
const ADMIN_ROLES = ['director', 'administrator'];

function originAllowed(origin){
  let host; try{ host = new URL(origin || '').hostname; }catch(e){ return false; }
  return ALLOWED_HOSTS.includes(host);
}
function cors(origin){
  const h = { 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
              'Content-Type': 'application/json; charset=utf-8' };
  if(originAllowed(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}
const fail = (code, msg, origin) => ({ statusCode: code, headers: cors(origin), body: JSON.stringify({ error: msg }) });
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const emailKey = (e) => String(e || '').trim().toLowerCase().replace(/\./g, '_');

let cachedToken = null, cachedUntil = 0;
async function getAccessToken(sa){
  const now = Math.floor(Date.now() / 1000);
  if(cachedToken && now < cachedUntil - 60) return cachedToken;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({ iss: sa.client_email,
    scope: ['https://www.googleapis.com/auth/firebase.database', 'https://www.googleapis.com/auth/userinfo.email'].join(' '),
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const jwt = `${header}.${claim}.${b64url(signer.sign(sa.private_key))}`;
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }) });
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
  const r = await fetch(`${IDT}/accounts:lookup?key=${WEB_API_KEY}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) });
  const j = await r.json();
  const u = j.users && j.users[0];
  if(!u || !u.email) throw new Error('Не вдалося підтвердити, хто робить запит.');
  return { uid: u.localId, email: String(u.email).toLowerCase() };
}

const roleList = raw => typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw.filter(x => typeof x === 'string')
  : (raw && typeof raw === 'object' ? Object.values(raw).filter(x => typeof x === 'string') : []);
function childrenOf(link){
  if(!link || typeof link !== 'object') return [];
  const c = link.children;
  const list = Array.isArray(c) ? c : (c && typeof c === 'object' ? Object.values(c) : []);
  return list.filter(k => k && k.class && (k.studentName || k.studentId)).map(k => ({ name: String(k.studentName || k.studentId), cls: String(k.class), pr: k.role || '' }));
}
const parentName = link => {
  const p = (link && link.profile) || {};
  return [p.lastName, p.firstName].filter(Boolean).join(' ').trim();
};

// ── ЧИСТА ЧАСТИНА: стан кожної людини ──────────────────────────────
// Пошта → {logged, app ('installed'|'browser'|'unknown'), push, devices, notif, lastAt, platform}
function reachIndex(users, tokens, seen){
  const idx = {};
  const get = se => idx[se] || (idx[se] = { logged: false, app: 'unknown', push: false, devices: 0, notif: '', lastAt: 0, platform: '' });
  for(const uid in (users || {})){
    const u = users[uid];
    if(!u || !u.email) continue;
    const x = get(emailKey(u.email));
    x.logged = true;
    const t = tokens && tokens[uid];
    if(t){
      const n = (t.devices && typeof t.devices === 'object') ? Object.values(t.devices).filter(d => d && d.token).length : (t.token ? 1 : 0);
      if(n){ x.push = true; x.devices += n; }
    }
    const s = seen && seen[uid];
    if(s && typeof s === 'object'){
      if(s.standaloneAt) x.app = 'installed';
      else if(x.app === 'unknown' && (s.browserAt || s.lastAt)) x.app = 'browser';
      if(Number(s.lastAt) > x.lastAt){ x.lastAt = Number(s.lastAt); x.notif = String(s.notif || ''); x.platform = String(s.platform || ''); }
    }
  }
  return idx;
}
// Загальний підсумок: усе гаразд / без сповіщень / не заходили
function verdict(x){
  if(!x || !x.logged) return 'never';
  if(x.push) return 'ok';
  return 'nopush';
}
const blank = { logged: false, app: 'unknown', push: false, devices: 0, notif: '', lastAt: 0, platform: '' };

// Класи вчителя: доступ у матриці + класне керівництво
function teacherClasses(se, access, heads){
  const out = new Set(Object.keys((access && access[se]) || {}).filter(c => /^class_\d{1,2}$/.test(c)));
  for(const cls in (heads || {})) if(heads[cls] && emailKey(heads[cls].teacherEmail) === se) out.add(cls);
  return out;
}

function buildReport({ me, role, users, tokens, seen, parents, students, pre, dir, access, heads }){
  const admin = ADMIN_ROLES.includes(role);
  const idx = reachIndex(users, tokens, seen);
  // Справжня пошта за ключем: ключ (крапки → «_») назад однозначно не
  // відновити — «john_doe@gmail.com» перетворився б на «john.doe@…».
  // Беремо з users; хто не заходив — найкраща здогадка з ключа.
  const realMail = {};
  for(const uid in (users || {})){ const e = users[uid] && users[uid].email; if(e) realMail[emailKey(e)] = String(e).toLowerCase(); }
  const guess = se => realMail[se.toLowerCase()] || se.replace(/_/g, '.');
  // Учителю — ні пошт, ні ключів (ключ — це та сама пошта): лише номер рядка
  let n = 0;
  const keyOf = se => admin ? se : `r${++n}`;
  const st = se => ({ ...(idx[se] || blank), verdict: verdict(idx[se]) });
  const classes = admin ? null : teacherClasses(me, access, heads);
  const inScope = cls => !classes || classes.has(cls);
  // Пошти батьків учителю не віддаємо — йому досить імені й дитини
  const mail = se => admin ? guess(se) : '';
  const families = [];
  for(const se in (parents || {})){
    const kids = childrenOf(parents[se]).filter(k => inScope(k.cls));
    if(!kids.length) continue;
    families.push({ key: keyOf(se), kind: 'parent', name: parentName(parents[se]), email: mail(se), kids, ...st(se.toLowerCase()) });
  }
  for(const se in (students || {})){
    const s = students[se];
    if(!s || !s.class || !inScope(String(s.class))) continue;
    families.push({ key: keyOf(se), kind: 'student', name: String(s.studentName || ''), email: mail(se),
                    kids: [{ name: String(s.studentName || s.studentId || ''), cls: String(s.class) }], ...st(se.toLowerCase()) });
  }
  const staff = [];
  if(admin){
    for(const se in (pre || {})){
      const roles = roleList(pre[se]).filter(r => r !== 'parent' && r !== 'student');
      if(!roles.length) continue;
      const d = (dir && dir[se.toLowerCase()]) || (dir && dir[se]) || {};
      staff.push({ key: se, kind: 'staff', name: String(d.name || ''), email: guess(se), roles, ...st(se.toLowerCase()) });
    }
  }
  const byName = (a, b) => (a.name || a.key).localeCompare(b.name || b.key, 'uk');
  families.sort((a, b) => Number(a.kids[0].cls.slice(6)) - Number(b.kids[0].cls.slice(6)) || a.kids[0].name.localeCompare(b.kids[0].name, 'uk') || byName(a, b));
  staff.sort(byName);
  return { admin, classes: classes ? [...classes].sort((a, b) => Number(a.slice(6)) - Number(b.slice(6))) : null, families, staff };
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  if(!originAllowed(origin)) return fail(403, 'Запит не з порталу', origin);
  if(event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(origin), body: '' };
  if(event.httpMethod !== 'POST') return fail(405, 'Тільки POST', origin);
  let body; try{ body = JSON.parse(event.body || '{}'); }catch(e){ return fail(400, 'Пошкоджений запит', origin); }
  if(!body.idToken) return fail(401, 'Немає підтвердження входу', origin);
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if(!raw) return fail(503, 'На сервері не задано FIREBASE_SERVICE_ACCOUNT', origin);
  let sa; try{ sa = JSON.parse(raw); }catch(e){ return fail(503, 'FIREBASE_SERVICE_ACCOUNT не читається як JSON', origin); }
  try{
    let who;
    try{ who = await verifyIdToken(body.idToken); }
    catch(e){ return fail(401, 'Сеанс завершився. Оновіть сторінку й увійдіть ще раз.', origin); }
    const token = await getAccessToken(sa);
    // Роль — з бази, а не зі слів браузера
    const meRec = await readDb(token, `users/${encodeURIComponent(who.uid)}`);
    const role = meRec && meRec.role;
    if(!ADMIN_ROLES.includes(role) && !TEACH_ROLES.includes(role))
      return fail(403, 'Цей розділ доступний директору, адміністрації та вчителям.', origin);
    const admin = ADMIN_ROLES.includes(role);
    const [users, tokens, seen, parents, students, access, heads, pre, dir] = await Promise.all([
      readDb(token, 'users'), readDb(token, 'push_tokens'), readDb(token, 'app_seen'),
      readDb(token, 'parent_links'), readDb(token, 'student_links'),
      readDb(token, 'teacher_access'), readDb(token, 'class_teachers'),
      admin ? readDb(token, 'pre_approved_roles') : null, admin ? readDb(token, 'staff_directory') : null]);
    const rep = buildReport({ me: emailKey(who.email), role, users, tokens, seen, parents, students, pre, dir, access, heads });
    return { statusCode: 200, headers: cors(origin), body: JSON.stringify({ ok: true, ...rep }) };
  }catch(e){
    console.error('[app-reach]', e && e.message);
    return fail(500, 'Не вдалося зібрати дані: ' + (e && e.message || ''), origin);
  }
};
exports._test = { reachIndex, verdict, buildReport, teacherClasses };
