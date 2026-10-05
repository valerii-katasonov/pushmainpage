// ══════════════════════════════════════════════════════════════════
//  Спільне для «📅 Змін у розкладі»: розбір розкладу, порівняння знімків,
//  текст сповіщення, адресати. Використовують schedule-changes.js (кожні
//  20 хв) і schedule-notify.js (одразу після збереження картки уроку).
// ══════════════════════════════════════════════════════════════════
const crypto = require('crypto');
const DB = 'https://test-4eb3e-default-rtdb.europe-west1.firebasedatabase.app';
const { CABINET_URL } = require('./site');

const STABLE_MIN = 20;          // скільки хвилин розклад має не змінюватися
const MAX_LINES = 6;            // більше — шлемо «розклад оновлено» без переліку
const QUIET_FROM = 21, QUIET_TO = 7;

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
const dbUrl = (token, path) => `${DB}/${path}.json?access_token=${encodeURIComponent(token)}`;
async function readDb(token, path) {
  const r = await fetch(dbUrl(token, path));
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`база недоступна (${path}): ${(d && d.error) || r.status}`);
  return d;
}
async function writeDb(token, path, value, method = 'PUT') {
  const r = await fetch(dbUrl(token, path), { method, body: JSON.stringify(value) });
  if (!r.ok) throw new Error(`не вдалося записати ${path}: ${r.status}`);
}

// ── дати ──
const p2 = n => String(n).padStart(2, '0');
function warsawNow() {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false });
  const parts = Object.fromEntries(f.formatToParts(new Date()).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
}
function addDays(ds, n) { const [y, m, d] = ds.split('-').map(Number); const x = new Date(Date.UTC(y, m - 1, d + n)); return `${x.getUTCFullYear()}-${p2(x.getUTCMonth() + 1)}-${p2(x.getUTCDate())}`; }
const WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SCHOOL_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const SHORT = { Monday: 'Пн', Tuesday: 'Вт', Wednesday: 'Ср', Thursday: 'Чт', Friday: 'Пт' };
const dayOf = ds => { const [y, m, d] = ds.split('-').map(Number); return WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]; };
function academicYear(ds) { const [y, m] = ds.split('-').map(Number); return m >= 8 ? `${y}-${y + 1}` : `${y - 1}-${y}`; }

// ── розбір розкладу ── (терпимо, як parseTimeRange у common.js)
const emailKey = (e) => String(e || '').trim().toLowerCase().replace(/\./g, '_');
const TIME_RANGE = /(\d{1,2})\s*[:.]\s*(\d{2})\s*[^\d]{1,3}\s*(\d{1,2})\s*[:.]\s*(\d{2})/;
function timeText(t) {
  const m = TIME_RANGE.exec(String(t || ''));
  return m ? `${p2(m[1])}:${m[2]}–${p2(m[3])}:${m[4]}` : String(t || '').trim();
}
function itemNames(item) {
  const alt = item && item.alt ? (Array.isArray(item.alt) ? item.alt : Object.values(item.alt))
    .map(x => typeof x === 'string' ? x : (x && x.ua) || '').map(s => String(s).trim()).filter(Boolean) : [];
  if (alt.length > 1) return alt;
  const raw = item && (typeof item.subject === 'object' ? (item.subject && item.subject.ua) : item.subject);
  const s = String(raw || '').trim();
  return s ? [s] : [];
}
const isBreak = it => !it || it.type === 'break' || /^(перерва|обід|перекус|break)/i.test(itemNames(it).join(' '));
// Урок у знімку: {s: назва, t: час, e: ключ пошти вчителя}. Підгрупи одного
// слота — через « | ». Нумерація — уроки дня по порядку, без перерв:
// вставлена перерва не має «зсувати» всі уроки в сповіщенні.
function normalizeLessons(lessons) {
  const out = {};
  for (const day of SCHOOL_DAYS) {
    const raw = lessons && lessons[day];
    const slots = Array.isArray(raw) ? Array.from(raw) : (raw && typeof raw === 'object' ? Object.keys(raw).sort((a, b) => a - b).map(k => raw[k]) : []);
    const list = [];
    for (const slot of slots) {
      const items = (Array.isArray(slot) ? slot : (slot && typeof slot === 'object' && Object.keys(slot).length ? [slot] : []))
        .filter(it => it && typeof it === 'object' && it.type !== 'extra' && !isBreak(it) && itemNames(it).length);
      if (!items.length) continue;
      list.push({ s: items.map(it => itemNames(it).join(' / ')).join(' | '), t: timeText(items[0].time),
                  e: items.map(it => emailKey(it.teacherEmail)).filter(Boolean).join(',') });
    }
    if (list.length) out[day] = list;
  }
  return out;
}
// Ординальний номер уроку за індексом слота (для замін)
function lessonNumber(lessons, day, slotIdx) {
  const raw = lessons && lessons[day];
  const slots = Array.isArray(raw) ? Array.from(raw) : [];
  let n = 0;
  for (let i = 0; i < slots.length && i <= slotIdx; i++) {
    const s = slots[i];
    const items = (Array.isArray(s) ? s : (s && typeof s === 'object' && Object.keys(s).length ? [s] : [])).filter(it => it && !isBreak(it) && itemNames(it).length);
    if (items.length) n++;
    if (i === slotIdx) return items.length ? n : 0;
  }
  return 0;
}
function normalizeCatalog(node) {
  const out = {};
  for (const raw of Object.values(node || {})) {
    const name = typeof raw === 'string' ? raw.trim() : String((raw && raw.name) || '').trim();
    if (!name) continue;
    out[name.toLowerCase()] = { n: name, e: emailKey(raw && raw.teacherEmail) };
  }
  return out;
}
const snapshotOf = (lessons, catalog) => ({ d: normalizeLessons(lessons), c: normalizeCatalog(catalog) });
const hashOf = snap => crypto.createHash('sha1').update(JSON.stringify(snap)).digest('hex').slice(0, 16);

// ── що змінилося ──
function diffSnapshots(a, b) {
  const out = [];
  for (const day of SCHOOL_DAYS) {
    const x = (a && a.d && a.d[day]) || [], y = (b && b.d && b.d[day]) || [];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const o = x[i], n = y[i], num = i + 1;
      if (!o) { out.push({ day, num, kind: 'add', s: n.s, to: n.t }); continue; }
      if (!n) { out.push({ day, num, kind: 'del', s: o.s }); continue; }
      if (o.s !== n.s) out.push({ day, num, kind: 'subj', from: o.s, s: n.s, to: n.t !== o.t ? n.t : '' });
      else if (o.t !== n.t && n.t) out.push({ day, num, kind: 'time', s: n.s, from: o.t, to: n.t });
      if (o.s === n.s && n.e && o.e !== n.e) out.push({ day, num, kind: 'teacher', s: n.s, to: n.e });
    }
  }
  for (const [k, n] of Object.entries((b && b.c) || {})) {
    const o = a && a.c && a.c[k];
    if (o && n.e && o.e !== n.e) out.push({ kind: 'cteacher', s: n.n, to: n.e });
  }
  return out;
}
// Однакова зміна в кілька днів — один рядок («Пн–Пт: 1-й урок тепер …»)
function summarize(changes, nameOf) {
  const groups = new Map();
  for (const c of changes) {
    const k = [c.kind, c.num || '', c.s, c.from || '', c.to || ''].join('|');
    const g = groups.get(k) || { ...c, days: [] };
    if (c.day) g.days.push(c.day);
    groups.set(k, g);
  }
  const daysTxt = ds => ds.length === 5 ? 'Пн–Пт' : ds.map(d => SHORT[d]).join(', ');
  const who = e => String(e || '').split(',').filter(Boolean).map(nameOf).join(', ');
  const lines = [];
  for (const g of groups.values()) {
    const d = daysTxt(g.days);
    if (g.kind === 'time') lines.push(`${d}: ${g.num}-й урок (${g.s}) тепер ${g.to}, було ${g.from}`);
    else if (g.kind === 'subj') lines.push(`${d}: ${g.num}-й урок — ${g.s} замість ${g.from}${g.to ? `, ${g.to}` : ''}`);
    else if (g.kind === 'add') lines.push(`${d}: додано ${g.num}-й урок — ${g.s}${g.to ? ` (${g.to})` : ''}`);
    else if (g.kind === 'del') lines.push(`${d}: ${g.num}-й урок (${g.s}) прибрано`);
    else if (g.kind === 'teacher') lines.push(`${d}: ${g.s} — веде ${who(g.to)}`);
    else if (g.kind === 'cteacher') lines.push(`${g.s}: новий учитель — ${who(g.to)}`);
  }
  return lines;
}
// Нові заміни на сьогодні/завтра. seen — {"дата|слот": "учитель|предмет"}
function newSubs(subsByDate, lessons, seen) {
  const lines = [], next = {};
  for (const [date, slots] of Object.entries(subsByDate || {})) {
    for (const [slot, s] of Object.entries(slots || {})) {
      if (!s || !s.subject || !(s.subName || s.subEmail)) continue;
      const key = `${date}|${slot}`, val = `${emailKey(s.subEmail)}|${s.subject}`;
      next[key] = val;
      if (seen && seen[key] === val) continue;
      const n = /^\d+$/.test(slot) ? lessonNumber(lessons, dayOf(date), Number(slot)) : 0;
      lines.push(`${SHORT[dayOf(date)] || ''} ${date.slice(8, 10)}.${date.slice(5, 7)}: ${n ? `${n}-й урок, ` : ''}${s.subject} — заміна, веде ${s.subName || s.subEmail}`);
    }
  }
  return { lines, next };
}
function message(cls, lines) {
  const label = cls.replace('class_', '') + ' клас';
  const body = lines.length > MAX_LINES ? 'Розклад оновлено — перегляньте в кабінеті' : lines.join('; ');
  return { title: `📅 Зміни в розкладі · ${label}`, body: body.length > 230 ? body.slice(0, 228) + '…' : body, tag: `sched-${cls}` };
}

// ── хто отримує ── (як у week-digest: реєстри школи — джерело правди)
function linkedChildren(raw) {
  if (!raw) return [];
  const c = raw.children;
  const list = Array.isArray(c) ? c : (c && typeof c === 'object' ? Object.values(c) : []);
  if (list.length) return list.filter(k => k && k.class);
  return raw.class ? [raw] : [];
}
function familyTokens(tokens, parents, students, cls) {
  const out = [];
  for (const t of Object.values(tokens || {})) {
    if (!t || !t.email) continue;
    const se = emailKey(t.email);
    const kids = linkedChildren(parents && parents[se]);
    const st = students && students[se];
    const all = kids.length ? kids : (st && st.class ? [st] : []);
    if (!all.some(k => k.class === cls)) continue;
    const dev = (t.devices && typeof t.devices === 'object') ? Object.values(t.devices).map(d => d && d.token).filter(Boolean) : [];
    out.push(...(dev.length ? dev : (t.token ? [t.token] : [])));
  }
  return [...new Set(out)];
}


// Розіслати родинам класу й записати в schedule_changes/{клас}
async function sendToClass(token, sa, cls, lines) {
  const msg = message(cls, lines);
  const [tokens, parents, students] = await Promise.all([readDb(token, 'push_tokens'), readDb(token, 'parent_links'), readDb(token, 'student_links')]);
  const targets = familyTokens(tokens, parents, students, cls);
  const url = `${CABINET_URL}?open=day`;
  const res = await Promise.allSettled(targets.map(t => fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { token: t, data: { ...msg, url }, webpush: { headers: { Urgency: 'normal' }, fcmOptions: { link: url } } } }) })));
  await writeDb(token, `schedule_changes/${cls}`, { ts: Date.now(), lines: lines.slice(0, 20) }, 'POST');
  return res.filter(r => r.status === 'fulfilled' && r.value.ok).length;
}
async function catalogFor(token, now) {
  const year = await readDb(token, 'academic_year/current').catch(() => null);
  const yearId = /^\d{4}-\d{4}$/.test(String(year || '')) ? year : academicYear(now.date);
  return readDb(token, `subjects_catalog/${yearId}`).catch(() => null);
}

module.exports = { STABLE_MIN, MAX_LINES, QUIET_FROM, QUIET_TO, getAccessToken, readDb, writeDb, warsawNow, addDays, academicYear,
  emailKey, timeText, itemNames, normalizeLessons, lessonNumber, normalizeCatalog, snapshotOf, hashOf, diffSnapshots, summarize,
  newSubs, message, familyTokens, sendToClass, catalogFor };
