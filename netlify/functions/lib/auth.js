// ══════════════════════════════════════════════════════════════════
//  Push School — хто викликає функцію
// ══════════════════════════════════════════════════════════════════
//
// НАВІЩО. notify і ai-assist довго приймали запити без входу й
// перевіряли лише заголовок Origin. Браузер підставляє його сам, але
// curl підробляє одним рядком — і будь-хто в інтернеті міг розіслати
// всім батькам школи push зі своїм текстом («терміново оплатіть на
// рахунок…») або витрачати квоту Gemini школи.
//
// Тепер браузер додає до запиту idToken (Firebase видає його лише після
// входу з паролем), а сервер питає в Google, чий це токен. Самостійна
// реєстрація в проєкті вимкнена, тож будь-який дійсний токен належить
// людині, яку завела школа.
//
// Ключ нижче — публічний веб-ключ Firebase (той самий, що в common.js),
// не секрет: він лише називає проєкт.
const IDT = 'https://identitytoolkit.googleapis.com/v1';
const WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || 'AIzaSyA3OA9pcR1zscUtEPWD8LEKTKonAN5Y90c';

async function verifyIdToken(idToken) {
  if (typeof idToken !== 'string' || idToken.length < 20 || idToken.length > 4096) return null;
  const r = await fetch(`${IDT}/accounts:lookup?key=${WEB_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken })
  });
  const j = await r.json().catch(() => ({}));
  const u = j && j.users && j.users[0];
  if (!r.ok || !u || !u.email || u.disabled) return null;
  return { uid: String(u.localId), email: String(u.email).toLowerCase() };
}

const rolesOf = rec => [...new Set([rec && rec.role,
  ...(Array.isArray(rec && rec.roles) ? rec.roles : Object.values((rec && rec.roles) || {}))]
  .filter(r => typeof r === 'string' && r))];

module.exports = { verifyIdToken, rolesOf };
