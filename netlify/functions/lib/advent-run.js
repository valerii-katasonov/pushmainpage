// ══════════════════════════════════════════════════════════════════
//  🎄 Адвент — запуск розіграшу (спільне для двох функцій)
// ══════════════════════════════════════════════════════════════════
//
// advent-draw.js     — сам, за розкладом, 22 грудня з 7:00 за Варшавою;
// advent-draw-now.js — кнопка директора «Розіграти зараз», якщо розклад
//                      чомусь не спрацював (Netlify не відкриває функції за
//                      розкладом за адресою, тож запасний вхід — окремий).
//
// Розіграш до 7:00 22 грудня неможливий ні так, ні так: інакше випадкове
// натискання завчасно визначило б призи, поки діти ще збирають ялинку.
//
// Пишемо ОДНИМ запитом (PATCH кількох шляхів — атомарно): або всі призи
// й нові залишки, або нічого. Повторний запуск дорозігрує лише тих, у кого
// призу ще немає (наприклад, учня додали пізніше), і не переграє виданих.
const crypto = require('crypto');
const { startMs, drawAtMs, planDraw } = require('./advent-core');
const DB = 'https://test-4eb3e-default-rtdb.europe-west1.firebasedatabase.app';

const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function accessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: ['https://www.googleapis.com/auth/firebase.database',
            'https://www.googleapis.com/auth/userinfo.email'].join(' '),
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                                assertion: `${header}.${claim}.${b64url(signer.sign(sa.private_key))}` })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error_description || d.error || 'OAuth');
  return d.access_token;
}
const url = (token, path) => `${DB}/${path}.json?access_token=${encodeURIComponent(token)}`;
async function readDb(token, path) {
  const r = await fetch(url(token, path));
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`база недоступна (${path}): ${(d && d.error) || r.status}`);
  return d;
}
// Замок, щоб два запуски (розклад + кнопка) не розіграли одне й те саме
// двічі з різним результатом. Завислий замок (функцію обірвало) старіє за 5 хв.
async function takeLock(token, path) {
  const r = await fetch(url(token, path), { headers: { 'X-Firebase-ETag': 'true' } });
  if (!r.ok) throw new Error(`база недоступна (${path}): ${r.status}`);
  const cur = await r.json().catch(() => null);
  if (typeof cur === 'number' && Date.now() - cur < 5 * 60e3) return false;
  const etag = r.headers.get('ETag');
  const w = await fetch(url(token, path), { method: 'PUT', body: String(Date.now()), headers: etag ? { 'if-match': etag } : {} });
  if (w.status === 412) return false;
  if (!w.ok) throw new Error(`не вдалося записати ${path}: ${w.status}`);
  return true;
}

// rnd(n) — справжній випадок (crypto), а не Math.random
const rnd = n => crypto.randomInt(0, Math.max(1, Math.min(n, 2 ** 47)));

async function runDraw(token, { now = Date.now() } = {}) {
  const cfg = await readDb(token, 'advent_cfg');
  if (!cfg || cfg.enabled !== true || !/^20\d\d$/.test(String(cfg.year || ''))) return { skip: 'адвент вимкнено' };
  const year = String(cfg.year);
  if (now < drawAtMs(year)) return { skip: 'ще рано: розіграш 22 грудня о 7:00' };
  if (now > drawAtMs(year) + 60 * 86400000) return { skip: 'календар уже давно скінчився' };
  if (!(await takeLock(token, `advent/${year}/lock`))) return { skip: 'розіграш уже йде' };
  try {
    const [students, opens, awards, prizes] = await Promise.all([
      readDb(token, 'students_list'), readDb(token, `advent/${year}/open`),
      readDb(token, `advent/${year}/award`), readDb(token, 'advent_prizes')]);
    const plan = planDraw({ students, opens, awards, prizes, tiers: cfg.tiers, rnd, now });
    const patch = { [`advent/${year}/drawnAt`]: now };
    for (const [cls, list] of Object.entries(plan.awards))
      for (const [sid, rec] of Object.entries(list)) patch[`advent/${year}/award/${cls}/${sid}`] = rec;
    for (const [id, left] of Object.entries(plan.left)) patch[`advent_prizes/${id}/left`] = left;
    if (plan.total) {
      const w = await fetch(url(token, ''), { method: 'PATCH', body: JSON.stringify(patch) });
      if (!w.ok) throw new Error(`не вдалося записати розіграш: ${w.status}`);
    }
    return { year, drawn: plan.total, ...plan.stats };
  } finally {
    await fetch(url(token, `advent/${year}/lock`), { method: 'DELETE' }).catch(() => {});
  }
}

module.exports = { accessToken, readDb, runDraw, startMs };
