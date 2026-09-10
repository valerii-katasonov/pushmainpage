// ══════════════════════════════════════════════════════════════════
//  Push School — власні листи
// ══════════════════════════════════════════════════════════════════
//
// НАВІЩО ЦЕ ЗʼЯВИЛОСЯ. Firebase заблокував редагування шаблонів для
// нашого проєкту: «Email template updates are currently unavailable for
// this project». Разом із шаблоном заблокований і Custom action URL —
// тобто ні перекласти лист, ні відправити людину на портал замість
// firebaseapp.com через консоль уже не можна.
//
// Тому лист складаємо й надсилаємо самі. Firebase лишається тільки
// джерелом одноразового коду; людина його не бачить і на сторінки
// Firebase не потрапляє взагалі.
//
// ЩО ПОТРІБНО НАЛАШТУВАТИ (один раз):
//   1. brevo.com → безкоштовний акаунт (300 листів на добу).
//   2. Senders → Add a sender → підтвердити поштову адресу школи.
//      Свій домен не обовʼязковий: Brevo підтверджує окрему адресу.
//   3. SMTP & API → API keys → Create a new API key.
//   4. Netlify → Site configuration → Environment variables:
//        BREVO_API_KEY   — ключ із кроку 3
//        MAIL_FROM       — підтверджена адреса з кроку 2
//        MAIL_FROM_NAME  — необовʼязково, типово «Push School Warsaw»
//
// ЯКЩО КЛЮЧА НЕМАЄ — не падаємо. Виклик поверне {sent:false}, і той, хто
// його зробив, відступить на звичайний лист Firebase. Англійський і
// негарний, але вхід працює. Порядок такий навмисно: викласти можна
// зараз, а Brevo під'єднати коли завгодно, нічого не переламавши.

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
const DEFAULT_FROM_NAME = 'Push School Warsaw';

function mailConfigured() {
  return !!(process.env.BREVO_API_KEY && process.env.MAIL_FROM);
}

// Мінімальне екранування. У лист потрапляє лише адреса й посилання, але
// адреса приходить ззовні, і вставляти її в HTML як є не можна.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── ЛИСТ ПРО ВСТАНОВЛЕННЯ ПАРОЛЯ ──
//
// mode:
//   'first' — людина входить уперше, пароля ще не було;
//   'reset' — пароль був, його скидають.
// Різниця тільки в словах. Дія та сама, і плутати їх не можна: людині,
// яка ніколи не заходила, «скидання пароля» нічого не пояснює.
function passwordLetter(link, mode, to) {
  const first = mode !== 'reset';
  const title = first ? 'Ваш перший вхід у Push School' : 'Новий пароль до Push School';
  const lead = first
    ? 'Школа додала вашу адресу до порталу. Лишилося задати собі пароль — '
      + 'натисніть кнопку нижче.'
    : 'Ви (або адміністрація школи) попросили встановити новий пароль. '
      + 'Натисніть кнопку нижче.';
  const after = first
    ? 'Далі входитимете на портал із цим паролем.'
    : 'Після цього старий пароль перестане діяти.';

  // Верстка навмисно проста: таблиці й вбудовані стилі. Поштові клієнти
  // (особливо Outlook) не розуміють ні flex, ні grid, ні зовнішній CSS.
  const html = `<!doctype html>
<html lang="uk"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f5f9;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
       style="background:#f4f5f9;padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;
                  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
      <tr><td style="background:#5c6bc0;padding:22px 26px;">
        <div style="color:#ffffff;font-size:19px;font-weight:600;">Push School Warsaw</div>
        <div style="color:#c5cae9;font-size:13px;margin-top:2px;">Шкільний портал</div>
      </td></tr>
      <tr><td style="padding:26px 26px 8px;">
        <h1 style="margin:0 0 12px;font-size:19px;color:#263238;font-weight:600;">${esc(title)}</h1>
        <p style="margin:0 0 18px;font-size:15px;line-height:1.55;color:#455a64;">${esc(lead)}</p>
      </td></tr>
      <tr><td align="center" style="padding:0 26px 20px;">
        <a href="${esc(link)}"
           style="display:inline-block;background:#5c6bc0;color:#ffffff;text-decoration:none;
                  font-size:16px;font-weight:600;padding:13px 30px;border-radius:10px;">
          Задати пароль
        </a>
      </td></tr>
      <tr><td style="padding:0 26px 22px;">
        <p style="margin:0 0 14px;font-size:13px;line-height:1.55;color:#78909c;">${esc(after)}
           Посилання діє обмежений час — якщо не встигнете, просто попросіть новий лист на порталі.</p>
        <p style="margin:0 0 6px;font-size:12px;color:#90a4ae;">Кнопка не працює? Скопіюйте адресу:</p>
        <p style="margin:0;font-size:12px;color:#5c6bc0;word-break:break-all;">${esc(link)}</p>
      </td></tr>
      <tr><td style="background:#fafafa;padding:16px 26px;border-top:1px solid #eceff1;">
        <p style="margin:0 0 8px;font-size:12px;line-height:1.5;color:#90a4ae;">
          Логін — ця сама адреса: <b style="color:#78909c;">${esc(to)}</b>
        </p>
        <p style="margin:0;font-size:12px;line-height:1.5;color:#90a4ae;">
          Якщо ви не просили цей лист — просто видаліть його. Без переходу за
          посиланням пароль не зміниться.
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

  // Текстова версія обовʼязкова: без неї частина фільтрів вважає лист
  // підозрілим, а деякі клієнти показують порожнечу.
  const text = [
    title, '', lead, '', link, '', after,
    'Посилання діє обмежений час.', '',
    'Логін — ця сама адреса: ' + String(to || ''), '',
    'Якщо ви не просили цей лист — видаліть його.',
    'Push School Warsaw'
  ].join('\n');

  return { subject: title, html, text };
}

// Надсилання. Повертає {sent:true} або {sent:false, why} — не кидає:
// виклик має вміти відступити на запасний шлях, а не впасти.
async function sendMail(to, letter) {
  if (!mailConfigured()) return { sent: false, why: 'no-mailer' };
  try {
    const r = await fetch(BREVO_URL, {
      method: 'POST',
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        sender: { email: process.env.MAIL_FROM,
                  name: process.env.MAIL_FROM_NAME || DEFAULT_FROM_NAME },
        to: [{ email: to }],
        subject: letter.subject,
        htmlContent: letter.html,
        textContent: letter.text
      })
    });
    if (r.ok) return { sent: true };
    const body = await r.text().catch(() => '');
    // Код віддаємо окремо від тексту. Текст іде лише в лог функції —
    // у ньому буває адреса відправника, — а голий номер відповіді можна
    // показати й у консолі порталу: він нічого не розкриває, зате
    // одразу каже, що саме лагодити.
    return { sent: false, status: r.status, why: `brevo ${r.status}: ${body.slice(0, 200)}` };
  } catch (e) {
    return { sent: false, status: 0, why: 'brevo: ' + (e && e.message || 'немає звʼязку') };
  }
}

module.exports = { mailConfigured, passwordLetter, sendMail };
