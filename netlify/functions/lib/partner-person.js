// 🤝 Дані людини для PUSH School Card — спільне для partner-card.js і card-check.js
const crypto = require('crypto');
const { emailKey, groupsOf, fullNameOf, rolesOf } = require('./partner-card-core');
const DB = 'https://test-4eb3e-default-rtdb.europe-west1.firebasedatabase.app';

const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function accessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({ iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const signer = crypto.createSign('RSA-SHA256'); signer.update(`${header}.${claim}`);
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claim}.${b64url(signer.sign(sa.private_key))}` }) });
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
async function writeDb(token, path, value, method = 'PUT') {
  const r = await fetch(url(token, path), { method, body: JSON.stringify(value) });
  if (!r.ok) throw new Error(`не вдалося записати ${path}: ${r.status}`);
}
// Записати, лише якщо там порожньо (номер картки не має перетертися)
async function putIfAbsent(token, path, value) {
  const r = await fetch(url(token, path), { headers: { 'X-Firebase-ETag': 'true' } });
  if (!r.ok) throw new Error(`база недоступна (${path}): ${r.status}`);
  if (await r.json().catch(() => null)) return false;
  const etag = r.headers.get('ETag');
  const w = await fetch(url(token, path), { method: 'PUT', body: JSON.stringify(value), headers: etag ? { 'if-match': etag } : {} });
  if (w.status === 412) return false;
  if (!w.ok) throw new Error(`не вдалося записати ${path}: ${w.status}`);
  return true;
}
// Хто ця людина зараз: групи й повне імʼя
async function personOf(token, uid) {
  const user = await readDb(token, `users/${uid}`);
  if (!user || typeof user !== 'object') return { groups: [], name: '' };
  const se = emailKey(user.email), roles = rolesOf(user);
  const [parentLink, staffRole, staffDir, cls] = await Promise.all([
    roles.includes('parent') && se ? readDb(token, `parent_links/${se}`).catch(() => null) : null,
    se ? readDb(token, `pre_approved_roles/${se}`).catch(() => null) : null,
    se ? readDb(token, `staff_directory/${se}/name`).catch(() => null) : null,
    roles.includes('student') && /^class_\d{1,2}$/.test(String(user.class || '')) ? readDb(token, `students_list/${user.class}`).catch(() => null) : null
  ]);
  const studentListed = !!(cls && ((user.studentId && cls[user.studentId]) || Object.values(cls).includes(user.studentName)));
  const groups = groupsOf(user, { parentLink, studentListed, staffRole });
  const name = fullNameOf(user, { parentProfile: parentLink && parentLink.profile, staffName: staffDir });
  return { groups, name };
}
// Прибрати картку людини, яка вже не повʼязана зі школою
async function dropCard(token, no, uid) {
  await fetch(url(token, `partner_cards/${no}`), { method: 'DELETE' });
  if (uid) {
    const mine = await readDb(token, `partner_card_of/${uid}`).catch(() => null);
    if (mine === no) await fetch(url(token, `partner_card_of/${uid}`), { method: 'DELETE' });
  }
}
module.exports = { accessToken, readDb, writeDb, putIfAbsent, personOf, dropCard };
