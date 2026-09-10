// ══════════════════════════════════════════════════════════════════
//  Push School — перший вхід: створення пароля
// ══════════════════════════════════════════════════════════════════
//
// ЩО РОБИТЬ: перевіряє, чи є ця пошта в списках школи, і надсилає на неї
// лист із посиланням, за яким людина задає собі пароль.
//
// ЧОМУ ЛИСТ, А НЕ ПОЛЕ «ПРИДУМАЙТЕ ПАРОЛЬ». Доти пароль до адреси зі
// списку школи міг задати будь-хто, хто цю адресу ЗНАЄ. А адреса
// вчителя не таємниця: вона в листуванні, у класних чатах, на сайті.
// Хто перший натиснув «Перший вхід» — той і отримував кабінет: журнал,
// оцінки, контакти родин. Тепер пароль задає лише той, хто читає цю
// скриньку.
//
// КУДИ ВЕДЕ ПОСИЛАННЯ. У Firebase Console → Authentication → Templates
// має бути заданий Custom action URL на сторінку порталу — тоді лист
// веде на портал, а не на firebaseapp.com, і людина взагалі не бачить
// сторонніх сторінок. Портал такі посилання вже обробляє
// (hasPendingAuthAction → екран встановлення пароля).
//
// НАВІЩО. Досі акаунт створював браузер напряму
// (createUserWithEmailAndPassword), а перевірка «чи є така людина в
// школі» відбувалася ПІСЛЯ — бо списки читаються тільки після входу.
// Порядок був вивернутий, і з нього виростало три біди:
//
//   1. Будь-хто в інтернеті міг створити акаунт у нашому проєкті на
//      будь-яку адресу. Квоти наші, акаунти чужі.
//   2. Authentication заростав сміттям. Реальний випадок: людина
//      з'явилася там за два тижні до того, як її завели в порталі, —
//      і потім цілий день ніхто не міг зрозуміти, чому портал каже
//      «акаунт існує», а зайти вона не може.
//   3. Відповідь «email-already-in-use» повідомляла сторонньому, чи є
//      в школи акаунт із такою адресою.
//
// Тепер порядок правильний: спершу перевірка по базі службовим ключем,
// потім лист. Немає в списках — ні акаунта, ні листа.
//
// Акаунт усе ж створюється — з випадковим паролем, якого не знає ніхто:
// Identity Toolkit не надішле лист відновлення на адресу, для якої
// акаунта не існує. Пароль людина задає вже з листа.
//
// ПАРА ДО НАЛАШТУВАННЯ. Сама по собі функція дірку не закриває: браузер
// і далі вміє створювати акаунти напряму. Щоб заборонити це остаточно:
//   Firebase Console → Authentication → Settings → User actions →
//   зняти «Enable create (sign-up)».
// Тоді createUserWithEmailAndPassword з браузера відповідатиме
// auth/admin-restricted-operation, і єдиним шляхом лишиться ця функція.
//
// ПОРЯДОК УПРОВАДЖЕННЯ: спершу викласти функцію, переконатися, що
// перший вхід працює, і лише потім знімати галочку. Навпаки — і вхід
// зламається у всіх одразу.
//
// НАЛАШТУВАННЯ: та сама змінна, що вже є, — FIREBASE_SERVICE_ACCOUNT.

const crypto = require('crypto');
const { mailConfigured, passwordLetter, sendMail } = require('./lib/mail');

const ALLOWED_HOSTS = ['planlekcjipush.netlify.app', 'localhost', '127.0.0.1'];

// ПОРІВНЮЄМО ІМʼЯ ВУЗЛА ЦІЛКОМ, А НЕ ПІДРЯДОК.
//
// Сусідні функції перевіряють походження через origin.includes(host).
// Так робити не можна: рядок «planlekcjipush.netlify.app» міститься і в
// «planlekcjipush.netlify.app.evil.com», а «localhost» — у
// «evil-localhost.attacker.io». Обидва проходили б перевірку.
//
// І друге: умова там має вигляд `origin && !дозволено`. Коли заголовка
// Origin немає взагалі — а curl його не надсилає — перевірка просто
// не спрацьовує. Тому тут Origin обовʼязковий.
function originAllowed(origin){
  if(!origin) return false;
  let host;
  try{ host = new URL(origin).hostname; }catch(e){ return false; }
  return ALLOWED_HOSTS.includes(host);
}
const PROJECT_ID = 'test-4eb3e';
const DB = 'https://test-4eb3e-default-rtdb.europe-west1.firebasedatabase.app';
const IDT = 'https://identitytoolkit.googleapis.com/v1';
const WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || 'AIzaSyA3OA9pcR1zscUtEPWD8LEKTKonAN5Y90c';
// Куди повернути людину після встановлення пароля.
const PORTAL_URL = 'https://planlekcjipush.netlify.app/cabinet.html';
const PUPIL_DOMAIN = 'pupil.push.local';

// Дозвіл віддаємо ЛИШЕ дозволеному джерелу.
//
// Було `origin || '*'` — тобто відхиленому домену ми все одно
// відповідали «тобі можна». Сам запит потім падав на 403, тож витоку не
// було, але виходило дивно: браузер чужого сайту отримував дозвіл
// читати нашу відповідь. Заголовок має казати те саме, що й перевірка.
function cors(origin) {
  const h = {
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8'
  };
  if (originAllowed(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}
const fail = (code, msg, origin, extra) =>
  ({ statusCode: code, headers: cors(origin),
     body: JSON.stringify(Object.assign({ error: msg }, extra || {})) });
const ok = (obj, origin) =>
  ({ statusCode: 200, headers: cors(origin), body: JSON.stringify(Object.assign({ ok: true }, obj)) });

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Той самий ключ, що й у порталі: нижній регістр, крапки в підкреслення.
const emailKey = (e) => String(e || '').trim().toLowerCase().replace(/\./g, '_');

let cachedToken = null, cachedUntil = 0;
async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < cachedUntil - 60) return cachedToken;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: [
      'https://www.googleapis.com/auth/firebase.database',
      'https://www.googleapis.com/auth/identitytoolkit',
      'https://www.googleapis.com/auth/userinfo.email'
    ].join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const jwt = `${header}.${claim}.${b64url(signer.sign(sa.private_key))}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt
    })
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('OAuth: ' + (j.error_description || j.error || 'немає токена'));
  cachedToken = j.access_token;
  cachedUntil = now + (j.expires_in || 3600);
  return cachedToken;
}

async function readDb(token, path) {
  const r = await fetch(`${DB}/${path}.json?access_token=${encodeURIComponent(token)}`);
  const t = await r.text();
  if (!r.ok) throw new Error(`База (${path}): ${t.slice(0, 200)}`);
  return t === 'null' ? null : JSON.parse(t);
}

// ПРОЄКТ У ШЛЯХУ НАЗИВАЄМО ЯВНО.
//
// Тут стояло `projects/-`. Так пишуть для емулятора, і в документації
// Identity Platform такого варіанта немає: шлях — projects/{projectId}.
// Живий сервіс на «-» відповідає помилкою.
//
// Помітити це на стенді було неможливо: мережа підмінена, і підміна
// однаково відповідала на будь-який шлях. Тому нижче в тестах тепер
// перевіряється сама адреса запиту, а не лише результат.
async function findUserByEmail(token, email) {
  const r = await fetch(`${IDT}/projects/${PROJECT_ID}/accounts:lookup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ email: [email] })
  });
  const j = await r.json();
  // Помилку не ковтаємо. Раніше будь-яка відмова виглядала як «акаунта
  // немає», і функція йшла створювати другий — а справжня причина
  // (немає прав, не той проєкт) не з'являлася ніде.
  if (j.error) throw new Error('lookup: ' + (j.error.message || 'відмова'));
  return (j.users && j.users[0]) || null;
}

async function createUser(token, email, password) {
  const r = await fetch(`${IDT}/projects/${PROJECT_ID}/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ email, password, emailVerified: false })
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'не вдалося створити акаунт');
  return j.localId;
}

// ── ПОСИЛАННЯ НА ВСТАНОВЛЕННЯ ПАРОЛЯ ──
//
// Просимо Firebase не надсилати лист, а ПОВЕРНУТИ посилання
// (returnOobLink). Далі беремо з нього лише одноразовий код і будуємо
// свою адресу — на портал.
//
// Так довелося зробити, бо Firebase заблокував редагування шаблонів для
// цього проєкту, а разом із ними й Custom action URL. Через консоль ні
// перекласти лист, ні відправити людину на портал уже не можна.
//
// Вийшло навіть краще, ніж планувалося: сторінок Firebase людина не
// бачить взагалі — ні англійського листа, ні firebaseapp.com у рядку
// адреси. Портал такі посилання вже вміє обробляти: hasPendingAuthAction
// шукає рівно ці два параметри.
//
// Запит іде на проєктний вузол і зі службовим ключем: анонімний
// (?key=API_KEY) повертати посилання не вміє — він тільки надсилає лист.
async function getPasswordLink(token, email) {
  const r = await fetch(`${IDT}/projects/${PROJECT_ID}/accounts:sendOobCode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ requestType: 'PASSWORD_RESET', email, returnOobLink: true })
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'не вдалося створити посилання');
  if (!j.oobLink) throw new Error('Firebase не повернув посилання');
  let code = '';
  try { code = new URL(j.oobLink).searchParams.get('oobCode') || ''; } catch (e) {}
  if (!code) throw new Error('у посиланні немає коду');
  return `${PORTAL_URL}?mode=resetPassword&oobCode=${encodeURIComponent(code)}`;
}

// Запасний шлях: звичайний лист від Firebase. Англійський, із переходом
// на firebaseapp.com — але вхід працює. Потрібен доти, доки не заданий
// BREVO_API_KEY, щоб функцію можна було викласти вже зараз.
async function sendFirebaseLetter(email) {
  const body = { requestType: 'PASSWORD_RESET', email, continueUrl: PORTAL_URL };
  let r = await fetch(`${IDT}/accounts:sendOobCode?key=${WEB_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  let j = await r.json();
  if (j.error && /UNAUTHORIZED_CONTINUE_URI|INVALID_CONTINUE_URI/i.test(j.error.message || '')) {
    delete body.continueUrl;
    r = await fetch(`${IDT}/accounts:sendOobCode?key=${WEB_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    j = await r.json();
  }
  if (j.error) throw new Error(j.error.message || 'лист не надіслано');
  return 'firebase';
}

// Спершу свій лист, і лише якщо надіслати не вдалося — Firebase.
//
// Мовчазний відступ тут доречний: людині потрібен вхід, а не наші
// проблеми з поштовим сервісом. Причина йде в лог функції, і те, яким
// шляхом пішов лист, повертається нагору — щоб було видно в логах, що
// Brevo мовчить.
async function sendPasswordLetter(token, email, mode) {
  // ЧОМУ ВІДСТУПИЛИ — коротким кодом у відповідь.
  //
  // Перший же лист після налаштування прийшов від Firebase, і зрозуміти
  // чому можна було лише з логів. Причин рівно три, вони не таємні й не
  // про конкретну людину, тож нехай будуть видні одразу:
  //   mailer-off  — немає BREVO_API_KEY або MAIL_FROM (чи не перезібрано
  //                 сайт після додавання змінних);
  //   link-failed — Firebase не віддав посилання;
  //   send-failed — Brevo не прийняв лист (найчастіше відправника не
  //                 підтверджено).
  let why = 'mailer-off';
  if (mailConfigured()) {
    try {
      const link = await getPasswordLink(token, email);
      const res = await sendMail(email, passwordLetter(link, mode, email));
      if (res.sent) return { via: 'brevo' };
      why = 'send-failed';
      console.error('[first-login] свій лист не пішов:', res.why);
    } catch (e) {
      why = 'link-failed';
      console.error('[first-login] посилання не отримали:', e && e.message);
    }
  }
  await sendFirebaseLetter(email);
  return { via: 'firebase', why };
}

// Пароль, якого ніхто не знає й не побачить: потрібен лише щоб акаунт
// існував — інакше нема на що надсилати лист.
function throwawayPassword() {
  return 'A9' + crypto.randomBytes(24).toString('base64url') + '!z';
}

// Пошта є в школі, якщо вона є хоч в одному зі списків: персонал,
// привʼязки батьків, привʼязки учнів. Рівно ті самі три вузли перевіряє
// кабінет при вході — інакше функція пускала б туди, куди портал потім
// не пустить.
async function knownToSchool(token, key) {
  for (const node of ['pre_approved_roles', 'parent_links', 'student_links']) {
    let v = null;
    try { v = await readDb(token, `${node}/${key}`); }
    catch (e) { throw new Error(`Не вдалося перевірити списки школи: ${e.message}`); }
    if (v !== null && v !== undefined) return node;
  }
  return null;
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  // Джерело перевіряємо ПЕРШИМ, ще до preflight: інакше чужий сайт
  // отримував успішний OPTIONS і лише потім упирався в 403.
  if (!originAllowed(origin)) return fail(403, 'Запит не з порталу', origin);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(origin), body: '' };
  if (event.httpMethod !== 'POST') return fail(405, 'Тільки POST', origin);

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return fail(400, 'Пошкоджений запит', origin); }

  const email = String(body.email || '').trim().toLowerCase();
  // 'first' — пароля ще не було, 'reset' — його скидають. Різниця лише в
  // словах листа; дія однакова, і саме тому вона тут одна.
  const mode = body.mode === 'reset' ? 'reset' : 'first';

  if (!email.includes('@'))
    return fail(400, 'Схоже, це нікнейм, а не email. Учням пароль задають батьки '
      + 'у своєму кабінеті, розділ «Доступ дитини до порталу».', origin);
  if (email.endsWith('@' + PUPIL_DOMAIN))
    return fail(400, 'Це технічна адреса нікнейма. Пароль дитині задають батьки.', origin);
  // Межа згори — щоб не ганяти в Identity Toolkit явне сміття.
  if (email.length > 254) return fail(400, 'Задовга адреса.', origin);

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  // Ключа немає — кажемо про це кодом, а не текстом: портал за ним
  // зрозуміє, що можна спробувати старим шляхом, і людина не побачить
  // технічної помилки замість входу.
  if (!raw) return fail(503, 'Перевірка списків недоступна', origin, { code: 'no-service-account' });
  let sa;
  try { sa = JSON.parse(raw); }
  catch (e) { return fail(503, 'Перевірка списків недоступна', origin, { code: 'no-service-account' }); }

  // НА ЯКОМУ КРОЦІ ЗЛАМАЛОСЯ.
  //
  // Текст помилки людині показуємо загальний — і правильно. Але сьогодні
  // це вилізло боком: «Не вдалося перевірити списки школи» бачили і тоді,
  // коли списки якраз прочиталися, а впав наступний крок. Довелося
  // здогадуватися.
  //
  // Тому поруч із загальним текстом віддаємо назву кроку. Це не таємниця
  // (сюди доходить лише той, кого школа вже внесла) і не про конкретну
  // людину — зате видно одразу, куди дивитися.
  let stage = 'token';
  try {
    const token = await getAccessToken(sa);
    stage = 'school-lists';
    const where = await knownToSchool(token, emailKey(email));

    // НЕ РОЗКРИВАЄМО ЗАЙВОГО. Якщо пошти в школі немає, відповідь одна
    // й та сама незалежно від того, чи існує десь такий акаунт. Інакше
    // форму першого входу можна було б використати як перевірку
    // «чи вчиться в цій школі така родина».
    if (!where)
      return fail(403, 'Цей email ще не додано школою. Зверніться до класного керівника '
        + 'або директора.', origin, { code: 'not-in-school' });

    // Пошта в школі є — тут уже можна говорити прямо: людина своя.
    stage = 'lookup';
    const existing = await findUserByEmail(token, email);
    let hadAccount = !!existing;
    if (!existing) {
      stage = 'create';
      try {
        await createUser(token, email, throwawayPassword());
      } catch (e) {
        // Дві вкладки або подвійне натискання: акаунт зʼявився між
        // перевіркою і створенням. Не помилка — лист однаково піде.
        if (!/EMAIL_EXISTS/i.test(e && e.message || '')) throw e;
        hadAccount = true;
      }
    }
    stage = 'letter';
    const sentBy = await sendPasswordLetter(token, email, mode);
    return ok({ sent: true, hadAccount, via: sentBy.via, why: sentBy.why }, origin);
  } catch (e) {
    // Подробиці — у лог функції, людині загальний текст. У повідомленні
    // помилки бази трапляється шлях вузла, і показувати його назовні
    // немає жодної причини.
    console.error(`[first-login] крок ${stage}:`, e && e.message);
    // Текст залежить від кроку: сказати «не вдалося перевірити списки»
    // там, де списки вже прочитані, — гірше, ніж не сказати нічого.
    const msg = stage === 'school-lists' || stage === 'token'
      ? 'Не вдалося перевірити списки школи. Спробуйте за хвилину або зверніться до адміністрації.'
      : 'Списки школи прочитано, але надіслати лист не вдалося. Спробуйте за хвилину '
        + 'або зверніться до адміністрації.';
    return fail(500, msg, origin, { code: 'check-failed', stage });
  }
};
