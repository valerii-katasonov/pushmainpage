// Щоденне закриття харчування. Після дедлайнів сервер зберігає суму за
// кожну дитину й дату. Повторний запуск лише заповнює відсутні дні:
// Firebase REST if-match:null_etag не дає переписати вже створений запис.
const crypto = require('crypto');
const { buildDayCharge } = require('./lib/meal-ledger-core');
const DB = 'https://test-4eb3e-default-rtdb.europe-west1.firebasedatabase.app';
const DATA_NODES = [
  'meal_plan', 'meal_prices', 'meal_price_history', 'takeaway_items',
  'takeaway_price_history', 'academic_year'
];
// У Netlify заплановані функції мають короткий час виконання, тому
// початкову історію наздоганяємо кількома запусками, а не одним гігантським.
const MAX_WRITES = 400;
const CONCURRENCY = 25;

const b64 = value => Buffer.from(value).toString('base64url');
async function accessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const assertion = `${header}.${payload}.${b64(signer.sign(sa.private_key))}`;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error_description || value.error || 'OAuth');
  return value.access_token;
}
async function readDb(token, path, from, to) {
  const query = new URLSearchParams({ access_token: token });
  if (from && to) {
    query.set('orderBy', JSON.stringify('$key'));
    query.set('startAt', JSON.stringify(from));
    query.set('endAt', JSON.stringify(to));
  }
  const response = await fetch(`${DB}/${path}.json?${query}`);
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Firebase ${path}: ${value?.error || response.status}`);
  return value || {};
}
async function createOnly(token, path, value) {
  const response = await fetch(`${DB}/${path}.json?access_token=${encodeURIComponent(token)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'if-match': 'null_etag' },
    body: JSON.stringify(value)
  });
  if (response.status === 412) return false;
  if (!response.ok) throw new Error(`Firebase ${path}: HTTP ${response.status}`);
  return true;
}
function warsawNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date()).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}
function dayBefore(date) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
function firstDeposit(entries) {
  return Object.values(entries || {}).filter(e => Number(e?.amount) > 0)
    .map(e => String(e.startDate || e.date || '')).filter(Boolean).sort()[0] || '';
}
function dates(from, to) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return [];
  const out = [], d = new Date(`${from}T12:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== from) return [];
  for (; d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    if (out.length >= 10000) throw new Error(`Завеликий період рахунку від ${from}`);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
function candidates(data, through) {
  const out = [];
  for (const [cls, students] of Object.entries(data.meal_accounts || {})) {
    for (const [sid, entries] of Object.entries(students || {})) {
      const start = firstDeposit(entries);
      if (!start || start > through) continue;
      const name = data.students_list?.[cls]?.[sid] || sid;
      for (const date of dates(start, through)) {
        if (data.meal_ledger?.[cls]?.[sid]?.[date]) continue;
        out.push({ date, cls, sid, name });
      }
    }
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || a.cls.localeCompare(b.cls) || a.sid.localeCompare(b.sid));
  return out;
}

exports.handler = async () => {
  try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error('FIREBASE_SERVICE_ACCOUNT не задано');
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    const token = await accessToken(sa);
    const now = warsawNow();
    // Сьогодні закриваємо лише після всіх прийомів їжі й видачі на винос.
    const through = now.hour >= 22 ? now.date : dayBefore(now.date);
    const [accounts, students, ledger] = await Promise.all([
      readDb(token, 'meal_accounts'), readDb(token, 'students_list'), readDb(token, 'meal_ledger')
    ]);
    const all = candidates({ meal_accounts: accounts, students_list: students, meal_ledger: ledger }, through);
    const batch = all.slice(0, MAX_WRITES);
    if (!batch.length) return { statusCode: 200, body: JSON.stringify({ through, created: 0, remaining: 0 }) };
    const first=batch[0].date,last=batch.at(-1).date;
    const classes=[...new Set(batch.map(row=>row.cls))];
    const [values, mealDay, menu, takeawayOrders, attendanceByClass] = await Promise.all([
      Promise.all(DATA_NODES.map(node => readDb(token, node))),
      readDb(token, 'meal_day', first, last),
      readDb(token, 'menu', first, last),
      readDb(token, 'takeaway_orders', first, last),
      Promise.all(classes.map(cls=>readDb(token, `attendance/${cls}`, first, last)))
    ]);
    const data = {
      ...Object.fromEntries(DATA_NODES.map((node, i) => [node, values[i]])),
      meal_day: mealDay, menu, takeaway_orders: takeawayOrders,
      attendance: Object.fromEntries(classes.map((cls,i)=>[cls,attendanceByClass[i]]))
    };
    let created = 0, already = 0;
    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      const group = batch.slice(i, i + CONCURRENCY);
      const results = await Promise.all(group.map(async row => {
        const charge = { ...buildDayCharge(row.date, row.cls, row.sid, row.name, data),
          sealedAt: Date.now(), source: 'nightly' };
        return createOnly(token, `meal_ledger/${row.cls}/${row.sid}/${row.date}`, charge);
      }));
      created += results.filter(Boolean).length;
      already += results.length - results.filter(Boolean).length;
    }
    console.log(`[meal-ledger] through=${through} new=${created} already=${already} remaining=${all.length - batch.length}`);
    return { statusCode: 200, body: JSON.stringify({ through, created, already, remaining: all.length - batch.length }) };
  } catch (error) {
    console.error('[meal-ledger]', error);
    return { statusCode: 500, body: 'Не вдалося зафіксувати харчування; наступний запуск повторить спробу.' };
  }
};

exports._test = { firstDeposit, dates, candidates, dayBefore, createOnly };
