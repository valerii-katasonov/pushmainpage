// ══════════════════════════════════════════════════════════════════
//  Push School — щоранку: учителю про заявки на перездачу без відповіді
// ══════════════════════════════════════════════════════════════════
// ЩО РОБИТЬ. У робочі дні о 8:00 за Варшавою дивиться заявки на
// перездачу (retake_requests), які чекають рішення, і шле КОЖНОМУ вчителю
// один push: «🔄 Чекають рішення: 4 (3 клас — 2, 5 клас — 2)».
//
// ДАВНІ (понад MAX_AGE_DAYS) не нагадуємо — лише свіжі.
// ЩО ЗУПИНЯЄ НАГАДУВАННЯ про заявку:
//   • рішення (дозволено / відхилено) — status уже не 'pending';
//   • кнопка «👁 Бачу» в списку заявок — seenTs у заявці (teacher.js).
// Так учитель, який бачить заявку, але ще не вирішив, не отримує
// щодня те саме.
//
// КОМУ. Учителям цього предмета в класі за матрицею доступу
// (teacher_access); якщо такого немає — класному керівнику. Те саме
// правило, що й у миттєвому push про нову заявку (notify.js).
//
// ЧОМУ РОЗКЛАД ДВІЧІ (netlify.toml: 6:00 і 7:00 UTC). Netlify рахує час
// за Гринвічем, а Варшава то +1, то +2. Функція запускається двічі й
// працює лише тоді, коли у Варшаві саме 8-ма година, — тож 8:00 і взимку,
// і влітку. Позначка retake_reminder_day не дасть надіслати двічі за день.
//
// ЗМІННА ТА САМА, що й для решти сповіщень: FIREBASE_SERVICE_ACCOUNT.
// Код токена свідомо повторює birthday-reminders.js (чому — пояснено там).

const crypto = require('crypto');
const DB = 'https://test-4eb3e-default-rtdb.europe-west1.firebasedatabase.app';
const { SITE_URL: SITE } = require('./lib/site');
const SEND_HOUR = 8;

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: ['https://www.googleapis.com/auth/firebase.messaging', 'https://www.googleapis.com/auth/firebase.database',
            'https://www.googleapis.com/auth/userinfo.email'].join(' '),
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const jwt = `${header}.${claim}.${b64url(signer.sign(sa.private_key))}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt })
  });
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
// Дата, день тижня й година у Варшаві
function warsawNow(d = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(d).map(p => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), weekday: parts.weekday };
}

const emailKey = (e) => String(e || '').trim().toLowerCase().replace(/\./g, '_');
// КОПІЯ sameSubj і subjectTeachers з notify.js — змінюєте там, змініть і тут.
function sameSubj(a, b){
  const nz = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const A = nz(a), B = nz(b);
  if(!A || !B) return false;
  if(A === B) return true;
  const pa = A.split(/\s*\/\s*/).filter(x => x.length >= 3), pb = B.split(/\s*\/\s*/).filter(x => x.length >= 3);
  if(pa.length > 1 || pb.length > 1) return pa.some(x => pb.some(y => sameSubj(x, y)));
  const ta = A.split(/[\s.,()\-]+/).filter(Boolean), tb = B.split(/[\s.,()\-]+/).filter(Boolean);
  if(!ta.length || ta.length !== tb.length) return false;
  return ta.every((x, i) => { const y = tb[i]; if(x === y) return true; const s = x.length < y.length ? x : y, l = x.length < y.length ? y : x; return s.length >= 3 && l.startsWith(s); });
}
function subjectTeachers(access, heads, cls, subject) {
  const out = [];
  for (const [key, row] of Object.entries(access || {})) {
    const raw = row && row[cls];
    const list = (Array.isArray(raw) ? raw : Object.values(raw || {})).filter(v => typeof v === 'string');
    if (list.some(v => v.trim() === 'Всі предмети' || sameSubj(v, subject))) out.push(key);
  }
  if (!out.length && heads && heads[cls] && heads[cls].teacherEmail) out.push(emailKey(heads[cls].teacherEmail));
  return [...new Set(out)];
}

// Давні заявки (минулі місяці, минулий рік) щоранку не нагадуємо: їх
// видно в списку й дзвіночку, а push про них — лише шум. Вік — за часом
// подання, у старих заявках — за датою подання чи датою оцінки.
const MAX_AGE_DAYS = 45;
function ageDays(r, date, now = Date.now()) {
  const at = Number(r.ts) || Date.parse(String(r.requestDate || '') || String(date || '').slice(0, 10));
  return at ? (now - at) / 864e5 : Infinity;
}
// {пошта вчителя: {total, byCls: {class_3: 2}}} — заявки, що чекають і не позначені «Бачу»
function reminderPlan(requests, access, heads, now = Date.now()) {
  const plan = {};
  for (const cls in (requests || {})) for (const subj in (requests[cls] || {}))
    for (const date in (requests[cls][subj] || {})) for (const sid in (requests[cls][subj][date] || {})) {
      const r = requests[cls][subj][date][sid];
      if (!r || typeof r !== 'object' || r.status !== 'pending' || r.seenTs) continue;
      if (ageDays(r, date, now) > MAX_AGE_DAYS) continue;
      for (const se of subjectTeachers(access, heads, cls, subj)) {
        const p = plan[se] || (plan[se] = { total: 0, byCls: {} });
        p.total++; p.byCls[cls] = (p.byCls[cls] || 0) + 1;
      }
    }
  return plan;
}
const plural = (n, one, few, many) => { const a = n % 100, b = n % 10; return (a > 10 && a < 20) ? many : b === 1 ? one : (b >= 2 && b <= 4) ? few : many; };
function messageFor(p) {
  const classes = Object.keys(p.byCls).sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)));
  const where = classes.length > 1 ? ' (' + classes.map(c => `${c.slice(6)} клас — ${p.byCls[c]}`).join(', ') + ')' : ` у ${classes[0].slice(6)} класі`;
  return {
    title: '🔄 Заявки на перездачу',
    body: `Чекають рішення: ${p.total} ${plural(p.total, 'заявка', 'заявки', 'заявок')}${where}. Розгляньте або натисніть «👁 Бачу», щоб не нагадувати.`,
    cls: classes[0]
  };
}
function tokensByEmail(tokens) {
  const out = {};
  for (const uid in (tokens || {})) {
    const t = tokens[uid];
    if (!t || !t.email) continue;
    const dev = (t.devices && typeof t.devices === 'object') ? Object.values(t.devices).map(d => d && d.token).filter(Boolean) : [];
    const list = dev.length ? dev : (t.token ? [t.token] : []);
    if (list.length) (out[emailKey(t.email)] ||= []).push(...list);
  }
  return out;
}

exports.handler = async () => {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) { console.log('FIREBASE_SERVICE_ACCOUNT не задано — нагадування не надсилаються'); return { statusCode: 200, body: 'no service account' }; }
  let sa;
  try { sa = JSON.parse(raw); } catch (e) { return { statusCode: 200, body: 'bad json' }; }
  const now = warsawNow();
  if (now.hour !== SEND_HOUR) return { statusCode: 200, body: `не та година (${now.hour})` };
  if (now.weekday === 'Sat' || now.weekday === 'Sun') return { statusCode: 200, body: 'вихідний' };
  try {
    const token = await getAccessToken(sa);
    const last = await readDb(token, 'retake_reminder_day').catch(() => null);
    if (last === now.day) return { statusCode: 200, body: 'сьогодні вже надіслано' };
    await writeDb(token, 'retake_reminder_day', now.day);
    const [requests, access, heads, tokens] = await Promise.all([
      readDb(token, 'retake_requests'), readDb(token, 'teacher_access'),
      readDb(token, 'class_teachers').catch(() => null), readDb(token, 'push_tokens')]);
    const plan = reminderPlan(requests, access, heads);
    const byEmail = tokensByEmail(tokens);
    let sent = 0, people = 0;
    for (const se in plan) {
      const targets = [...new Set(byEmail[se] || [])];
      if (!targets.length) continue;
      people++;
      const m = messageFor(plan[se]);
      const url = `${SITE}/cabinet?open=retake&cls=${m.cls}`;
      const results = await Promise.allSettled(targets.map(t =>
        fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: { token: t, data: { title: m.title, body: m.body, tag: 'retake-daily', url },
            webpush: { headers: { Urgency: 'normal' }, fcmOptions: { link: url } } } })
        })));
      sent += results.filter(r => r.status === 'fulfilled' && r.value.ok).length;
    }
    const note = `учителів із заявками ${Object.keys(plan).length}, з пристроями ${people}, надіслано ${sent}`;
    console.log('Перездачі: ' + note);
    return { statusCode: 200, body: note };
  } catch (e) {
    console.log('Перездачі — помилка: ' + e.message);
    return { statusCode: 200, body: 'error: ' + e.message };
  }
};

exports._test = { reminderPlan, messageFor, warsawNow, tokensByEmail };
