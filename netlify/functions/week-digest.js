// ══════════════════════════════════════════════════════════════════
//  Push School — «Тиждень коротко»: пʼятничний підсумок для родин
// ══════════════════════════════════════════════════════════════════
// ЩО РОБИТЬ. Щопʼятниці по обіді кожній родині з увімкненими сповіщеннями —
// ОДИН push на всіх її дітей: скільки оцінок цього тижня, пропуски й
// запізнення, контрольні наступного тижня. Натискання відкриває кабінет на
// «Сьогодні», де той самий підсумок розписано докладно (family-week.js).
//
// ЧОГО В СПОВІЩЕННІ НЕМАЄ. Самих оцінок: сповіщення видно на заблокованому
// екрані. Лише кількість. Спокійний тиждень без жодної події — не шлемо.
//
// РОЗКЛАД — у netlify.toml ([functions."week-digest"]). Позначка
// digest_sent/{понеділок} робить повторний запуск того самого тижня
// безпечним: нікому нічого вдруге не прийде.
//
// Отримання токена повторює birthday-reminders.js свідомо — див. коментар там.

const crypto = require('crypto');
const DB = 'https://test-4eb3e-default-rtdb.europe-west1.firebasedatabase.app';
const { CABINET_URL } = require('./lib/site');

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
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

// ── дати ──
const p2 = n => String(n).padStart(2, '0');
function warsawToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function addDays(ds, n) { const [y, m, d] = ds.split('-').map(Number); const x = new Date(Date.UTC(y, m - 1, d + n)); return `${x.getUTCFullYear()}-${p2(x.getUTCMonth() + 1)}-${p2(x.getUTCDate())}`; }
function mondayOf(ds) { const [y, m, d] = ds.split('-').map(Number); const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); return addDays(ds, -((w + 6) % 7)); }
const WD = ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const wdOf = ds => { const [y, m, d] = ds.split('-').map(Number); return WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]; };

// ── хто в родині ── (як у notify.js: реєстри школи — джерело правди)
const emailKey = (e) => String(e || '').trim().toLowerCase().replace(/\./g, '_');
function linkedChildren(raw) {
  if (!raw) return [];
  const c = raw.children;
  const list = Array.isArray(c) ? c : (c && typeof c === 'object' ? Object.values(c) : []);
  if (list.length) return list.filter(k => k && k.class && (k.studentName || k.studentId));
  return raw.class && (raw.studentName || raw.studentId) ? [raw] : [];
}
function childrenOf(t, parents, students) {
  const se = emailKey(t && t.email);
  const fromParent = linkedChildren(parents && parents[se]);
  if (fromParent.length) return fromParent;
  const st = students && students[se];
  return st && st.class && (st.studentName || st.studentId) ? [st] : [];
}
function tokensOf(t) {
  if (!t || typeof t !== 'object') return [];
  const dev = (t.devices && typeof t.devices === 'object') ? Object.values(t.devices).map(d => d && d.token).filter(Boolean) : [];
  return dev.length ? dev : (t.token ? [t.token] : []);
}
// Ключ дитини в базі: id, а якщо його немає — пошук у списку класу за імʼям
function keyOf(kid, roster) {
  const list = (roster && roster[kid.class]) || {};
  if (kid.studentId && list[kid.studentId] !== undefined) return kid.studentId;
  const found = Object.keys(list).find(k => String(list[k]).trim().toLowerCase() === String(kid.studentName || '').trim().toLowerCase());
  return found || kid.studentId || kid.studentName;
}

// ── підсумок однієї дитини ── (чисто: усе приходить аргументом)
//   mirror — student_grades/{клас}/{учень}: {місяць: {предмет: {ключ дня: {v}}}}
//   attDays — {дата: {учень: {слот: {status}}}} цього класу
//   exams — exams/{клас}: {місяць: {дата: {предмет: …}}}
function childDigest({ mirror, attDays, exams, key, name, from, to, nextFrom, nextTo }) {
  let grades = 0;
  for (const subs of Object.values(mirror || {}))
    for (const days of Object.values(subs || {}))
      for (const [k, g] of Object.entries(days || {})) {
        const d = String(k).slice(0, 10), v = g && typeof g === 'object' ? g.v : g;
        if (d >= from && d <= to && v !== undefined && v !== null && v !== '') grades++;
      }
  let absent = 0, late = 0;
  for (const [d, day] of Object.entries(attDays || {})) {
    if (d < from || d > to) continue;
    const rec = (day && (day[key] || (name ? day[name] : null))) || null;
    const st = Object.values(rec || {}).map(r => r && r.status);
    if (st.includes('absent')) absent++;
    else if (st.includes('late')) late++;
  }
  const upcoming = [];
  for (const days of Object.values(exams || {}))
    for (const [d, subs] of Object.entries(days || {}))
      if (d >= nextFrom && d <= nextTo) for (const s of Object.keys(subs || {})) upcoming.push({ date: d, subject: s });
  upcoming.sort((a, b) => a.date.localeCompare(b.date));
  return { grades, absent, late, exams: upcoming };
}
function digestLine(name, dg) {
  const parts = [];
  if (dg.grades) parts.push(`оцінок ${dg.grades}`);
  if (dg.absent) parts.push(`днів із пропусками ${dg.absent}`);
  if (dg.late) parts.push(`запізнень ${dg.late}`);
  if (dg.exams.length) parts.push('контрольні: ' + dg.exams.slice(0, 3).map(e => `${e.subject} (${wdOf(e.date)})`).join(', ') + (dg.exams.length > 3 ? '…' : ''));
  if (!parts.length) return '';
  const first = String(name || '').trim().split(/\s+/)[0];
  return (first ? first + ': ' : '') + parts.join(', ');
}
function digestMessage(lines) {
  const l = lines.filter(Boolean);
  if (!l.length) return null;
  const body = l.join(' · ');
  return { title: '📊 Тиждень коротко', body: body.length > 230 ? body.slice(0, 228) + '…' : body, tag: 'week-digest' };
}

exports.handler = async () => {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) { console.log('FIREBASE_SERVICE_ACCOUNT не задано — підсумки не надсилаються'); return { statusCode: 200, body: 'no service account' }; }
  let sa;
  try { sa = JSON.parse(raw); } catch (e) { return { statusCode: 200, body: 'bad json' }; }
  try {
    const token = await getAccessToken(sa);
    const today = warsawToday(), monday = mondayOf(today), friday = addDays(monday, 4);
    // Лише пʼятниця або субота (запасний день, якщо пʼятничний запуск
    // зірвався). Запуск «Run now» у понеділок надіслав би підсумок неповного
    // тижня і позначив тиждень надісланим — пʼятничного вже не було б.
    if (today !== friday && today !== addDays(monday, 5))
      return { statusCode: 200, body: `сьогодні ${today} — не пʼятниця, нічого не шлемо` };
    const nextFrom = addDays(monday, 7), nextTo = addDays(monday, 11);
    const sentMark = await readDb(token, `digest_sent/${monday}`).catch(() => null);
    if (sentMark) return { statusCode: 200, body: `тиждень ${monday} уже надіслано` };

    const [tokens, parents, students, roster] = await Promise.all([
      readDb(token, 'push_tokens'), readDb(token, 'parent_links'), readDb(token, 'student_links'), readDb(token, 'students_list')]);
    // Кого стосується: родини з увімкненими сповіщеннями та їхні діти
    const families = [];
    const classes = new Set();
    for (const t of Object.values(tokens || {})) {
      const toks = tokensOf(t); if (!toks.length || !t.email) continue;
      const kids = childrenOf(t, parents, students); if (!kids.length) continue;
      families.push({ toks, kids }); kids.forEach(k => classes.add(k.class));
    }
    // Дані по класах — один раз на клас, не на кожну родину
    const dates = []; for (let d = monday; d <= friday; d = addDays(d, 1)) dates.push(d);
    const months = [...new Set([monday.slice(0, 7), friday.slice(0, 7)])];
    const perClass = {};
    await Promise.all([...classes].map(async cls => {
      const [att, exams] = await Promise.all([
        Promise.all(dates.map(d => readDb(token, `attendance/${cls}/${d}`).catch(() => null))),
        readDb(token, `exams/${cls}`).catch(() => null)]);
      const attDays = {}; dates.forEach((d, i) => { if (att[i]) attDays[d] = att[i]; });
      perClass[cls] = { attDays, exams };
    }));
    // Оцінки кожної дитини — паралельно пачками: у запланованої функції
    // обмежений час, а послідовні сотні запитів у нього не вкладуться.
    const mirrors = {};
    const need = [...new Map(families.flatMap(f => f.kids).map(k => { const key = keyOf(k, roster); return [`${k.class}|${key}`, { cls: k.class, key }]; })).entries()];
    for (let i = 0; i < need.length; i += 25) {
      await Promise.all(need.slice(i, i + 25).map(async ([mk, k]) => {
        const parts = await Promise.all(months.map(m => readDb(token, `student_grades/${k.cls}/${k.key}/${m}`).catch(() => null)));
        mirrors[mk] = {}; months.forEach((m, j) => { if (parts[j]) mirrors[mk][m] = parts[j]; });
      }));
    }
    let sent = 0, quiet = 0;
    const url = `${CABINET_URL}?open=day`;
    await Promise.all(families.map(async f => {
      const lines = f.kids.map(kid => {
        const key = keyOf(kid, roster), pc = perClass[kid.class] || {};
        return digestLine(kid.studentName, childDigest({ mirror: mirrors[`${kid.class}|${key}`], attDays: pc.attDays, exams: pc.exams, key,
          name: kid.studentName, from: monday, to: friday, nextFrom, nextTo }));
      });
      const msg = digestMessage(lines);
      if (!msg) { quiet++; return; }
      const results = await Promise.allSettled([...new Set(f.toks)].map(t => fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { token: t, data: { ...msg, url }, webpush: { headers: { Urgency: 'normal' }, fcmOptions: { link: url } } } }) })));
      sent += results.filter(r => r.status === 'fulfilled' && r.value.ok).length;
    }));
    await writeDb(token, `digest_sent/${monday}`, { ts: Date.now(), sent, quiet });
    const note = `тиждень ${monday}: надіслано ${sent}, спокійних родин ${quiet}`;
    console.log('Тиждень коротко: ' + note);
    return { statusCode: 200, body: note };
  } catch (e) {
    console.log('Тиждень коротко — помилка: ' + e.message);
    return { statusCode: 200, body: 'error: ' + e.message };
  }
};
// Для тестів
exports._test = { childDigest, digestLine, digestMessage, keyOf, childrenOf, mondayOf, addDays };
