// ══════════════════════════════════════════════════════════════════
//  Push School — надсилання сповіщень (Firebase Cloud Messaging v1)
// ══════════════════════════════════════════════════════════════════
// НАЛАШТУВАННЯ (один раз):
//   1. Firebase Console → Project settings → Service accounts →
//      Generate new private key → завантажиться JSON
//   2. Netlify → Site configuration → Environment variables →
//      FIREBASE_SERVICE_ACCOUNT = увесь вміст того JSON одним рядком
//   3. Redeploy
//
// ЧОМУ НЕ firebase-admin: щоб не тягнути npm-залежність і не змінювати
// збірку. Токен доступу отримуємо самі — підписуємо JWT вбудованим crypto
// (~30 рядків нижче) і міняємо його на OAuth-токен Google.
//
// ЧОМУ КЛІЄНТ ВИКЛИКАЄ ЦЮ ФУНКЦІЮ, А НЕ ТРИГЕР БАЗИ: оцінки пишуться в
// Realtime Database напряму з браузера, серверного гачка немає. Тригери
// доступні лише через Cloud Functions — це наступний крок, коли дійдуть
// руки до серверної авторизації. Поки що модель довіри така сама, як у
// решті порталу.

const crypto = require('crypto');
// Перелік дозволених джерел — спільний для всіх функцій (lib/site.js).
// Раніше кожна тримала власну копію рядка з доменом, і зміна домену
// означала правку в шести файлах: забути один означає тиху відмову
// «запит із невідомого джерела» рівно в одній функції.
const { ALLOWED_HOSTS, CABINET_URL } = require('./lib/site');
const DB = 'https://test-4eb3e-default-rtdb.europe-west1.firebasedatabase.app';

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8'
  };
}
const fail = (code, msg, origin) => ({ statusCode: code, headers: cors(origin), body: JSON.stringify({ error: msg }) });
const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Кешуємо токен між викликами: Netlify часто перевикористовує процес,
// тож не ганяємо запит до Google на кожне сповіщення.
let cachedToken = null, cachedUntil = 0;
async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < cachedUntil - 60) return cachedToken;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: [
      'https://www.googleapis.com/auth/firebase.messaging',
      'https://www.googleapis.com/auth/firebase.database',
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
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error_description || d.error || 'Не вдалося отримати токен доступу');
  cachedToken = d.access_token; cachedUntil = now + (d.expires_in || 3600);
  return cachedToken;
}

// Кому слати: усі, хто увімкнув сповіщення і кого стосується подія.
// Батьки — за прив'язаною дитиною; учень — за власним іменем.
// Видалення потрібне рівно для одного: прибрати мертвий токен.
async function deleteDb(token, path) {
  const r = await fetch(`${DB}/${path}.json?access_token=${encodeURIComponent(token)}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(`не вдалося прибрати ${path}: ${r.status}`);
}

async function readDb(token, path) {
  const r = await fetch(`${DB}/${path}.json?access_token=${encodeURIComponent(token)}`);
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`база недоступна (${path}): ${(d && d.error) || r.status}`);
  return d;
}

// Старі токени мають одну role/дитину, нові — весь набір. Обидва
// формати читаються одночасно, тому оновлення не вимагає від усіх
// користувачів негайно перевмикати сповіщення.
function roleValues(raw){
  if(typeof raw==='string')return[raw];
  return Array.isArray(raw)?[...raw]:(raw&&typeof raw==='object'?Object.values(raw):[]);
}
function tokenRoles(t) {
  const list = roleValues(t&&t.roles);
  if(t && t.role && !list.includes(t.role)) list.push(t.role);
  return list.filter(Boolean);
}
function tokenHasRole(t, role) { return tokenRoles(t).includes(role); }
function tokenChildren(t) {
  const raw=t&&t.children;
  const list=Array.isArray(raw)?raw:(raw&&typeof raw==='object'?Object.values(raw):[]);
  const good=list.filter(k=>k&&k.class&&(k.studentName||k.studentId));
  if(good.length)return good;
  return t&&t.class&&(t.studentName||t.studentId)
    ?[{class:t.class,studentName:t.studentName||'',studentId:t.studentId||''}]:[];
}
function linkedChildren(raw){
  if(!raw)return[];
  if(typeof raw==='string')return[{studentName:raw,class:'class_2'}];
  const c=raw.children;
  const list=Array.isArray(c)?c:(c&&typeof c==='object'?Object.values(c):[]);
  if(list.length)return list.filter(k=>k&&k.class&&(k.studentName||k.studentId));
  return raw.class&&(raw.studentName||raw.studentId)?[raw]:[];
}
function effectiveChildren(t,parents,students){
  // Якщо сервер прочитав реєстри, вони є джерелом правди. Це одразу
  // припиняє пуші після відв'язки й одразу вмикає їх після прив'язки,
  // навіть якщо інший телефон ще не відкривав портал і токен застарів.
  if((parents&&typeof parents==='object')||(students&&typeof students==='object')){
    const se=emailKey(t&&t.email);
    const fromParent=linkedChildren(parents&&parents[se]);
    if(fromParent.length)return fromParent;
    const st=students&&students[se];
    return st&&st.class&&(st.studentName||st.studentId)?[st]:[];
  }
  return tokenChildren(t);
}

async function findTargets(token, cls, studentName) {
  const [all,parents,students] = await Promise.all([
    readDb(token,'push_tokens'),readDb(token,'parent_links'),readDb(token,'student_links')
  ]);
  if (!all || typeof all !== 'object') return [];
  const out = [];
  for (const uid in all) {
    const t = all[uid];
    if (!t || !t.token) continue;
    const kids=effectiveChildren(t,parents,students);
    if (!kids.some(k=>k.class===cls&&(k.studentName===studentName||k.studentId===studentName))) continue;
    out.push(t.token);
  }
  return [...new Set(out)];
}

// Домашнє завдання адресоване КЛАСУ, а не окремій дитині: імені учня тут
// немає й бути не може. Тому окрема вибірка — усі батьки й учні класу.
async function findClassTargets(token, cls) {
  const [all,parents,students] = await Promise.all([
    readDb(token,'push_tokens'),readDb(token,'parent_links'),readDb(token,'student_links')
  ]);
  if (!all || typeof all !== 'object') return [];
  const out = [];
  for (const uid in all) {
    const t = all[uid];
    if (!t || !t.token) continue;
    if (!effectiveChildren(t,parents,students).some(k=>k.class===cls)) continue;
    out.push(t.token);
  }
  return [...new Set(out)];
}

// Повідомлення адресоване конкретним людям за поштою, а не класом:
// у розмові можуть бути і вчитель, і директор, і кілька батьків.
//
// ЗВІРЯЄМО ЗА КЛЮЧЕМ ПОШТИ, А НЕ ЗА САМОЮ ПОШТОЮ.
//
// Учасники розмови лежать у базі ключами (`emailKey`: крапки замінені на
// підкреслення), і чат довго слав сюди спробу відновити з них адресу —
// заміною ВСІХ підкреслень назад на крапки. Для `ivan_petrov@gmail.com`
// це давало `ivan.petrov@gmail.com`, тобто чужу адресу: жоден токен не
// збігався, сервер відповідав «0 надіслано», і людина просто не
// отримувала сповіщень про повідомлення. Мовчки, без жодної помилки.
//
// Відновити адресу з ключа неможливо в принципі — перетворення однобічне.
// Тому порівнюємо в один бік: обидві сторони зводимо до ключа. Клієнт
// може слати і ключ, і справжню адресу — результат той самий.
const emailKey = (e) => String(e || '').trim().toLowerCase().replace(/\./g, '_');
async function findByEmails(token, emails) {
  const all = await readDb(token, 'push_tokens');
  if (!all || typeof all !== 'object') return [];
  const want = new Set(emails.map(emailKey));
  const out = [];
  for (const uid in all) {
    const t = all[uid];
    if (!t || !t.token || !t.email) continue;
    if (want.has(emailKey(t.email))) out.push(t.token);
  }
  return [...new Set(out)];
}

// Оголошення. Окрема вибірка, хоч і схожа на решту — і ось чому.
//
// Раніше новини йшли тим самим шляхом, що й меню (findMealTargets), і це
// давало ДВІ помилки одночасно.
//
// ПЕРША: клас ігнорувався. Оголошення «завтра 3-А їде в театр» летіло
// всім батькам школи — сотні людей отримували чуже.
//
// ДРУГА: у вибірці меню стоїть відсів «дитина не харчується — не
// турбуємо». Для меню це доречно, для оголошень — ні. Родини, які
// відмовилися від обідів, не отримували шкільних оголошень узагалі, і
// побачити цей звʼязок ззовні було неможливо.
async function findNewsTargets(token, cls) {
  const [all,parents,students] = await Promise.all([
    readDb(token,'push_tokens'),readDb(token,'parent_links'),readDb(token,'student_links')
  ]);
  if (!all || typeof all !== 'object') return [];
  // 'ALL' шле news.js, коли оголошення на всю школу
  const one = cls && cls !== 'ALL' ? cls : '';
  const out = [];
  for (const uid in all) {
    const t = all[uid];
    if (!t || !t.token) continue;
    const kids=effectiveChildren(t,parents,students);
    if (!kids.length) continue;
    if (one&&!kids.some(k=>k.class===one)) continue;
    out.push(t.token);
  }
  return [...new Set(out)];
}

// Меню стосується всіх одразу, тому шлемо однією розсилкою: 165 окремих
// викликів функції поклали б і ліміти Netlify, і квоту FCM.
async function findMealTargets(token) {
  const [all, plansRaw,parents,students] = await Promise.all([
    readDb(token, 'push_tokens'),
    readDb(token, 'meal_plan'),readDb(token,'parent_links'),readDb(token,'student_links')
  ]);
  const plans = plansRaw || {};
  if (!all || typeof all !== 'object') return [];
  const out = [];
  for (const uid in all) {
    const t = all[uid];
    if (!t || !t.token) continue;
    const kids=effectiveChildren(t,parents,students);
    if (!kids.length) continue;
    // Для кількох дітей достатньо, щоб харчувалася хоча б одна. Один токен
    // однаково отримає одне повідомлення, дублювати його по дітях не треба.
    const eats=kids.some(k=>{
      const byClass=plans[k.class]||{};
      const plan=(k.studentId&&byClass[k.studentId])||byClass[k.studentName];
      return !(plan&&plan.lunch===false);
    });
    if(!eats)continue;
    out.push(t.token);
  }
  return [...new Set(out)];
}

// Родина попереджає вчителів свого класу, а не інші родини.
// Клас у токені вчителя не є призначенням: звіряємо реєстр і матрицю.
async function findTeacherTargets(token, cls) {
  const [all, access, heads, approved] = await Promise.all([
    readDb(token, 'push_tokens'), readDb(token, 'teacher_access'),
    readDb(token, 'class_teachers'),readDb(token,'pre_approved_roles')
  ]);
  const head = emailKey(heads?.[cls]?.teacherEmail);
  const roles = ['teacher', 'class_teacher', 'art_school_teacher', 'music_teacher', 'master_class_teacher'];
  return [...new Set(Object.values(all || {}).filter(t => {
    if (!t?.token || !t.email) return false;
    const key = emailKey(t.email);
    const actual=(approved&&typeof approved==='object')?roleValues(approved[key]):tokenRoles(t);
    if(!roles.some(r=>actual.includes(r)))return false;
    const assigned = access?.[key]?.[cls];
    const subjects = Array.isArray(assigned) ? assigned : Object.values(assigned || {});
    return key === head || subjects.some(v => typeof v === 'string' && v.trim());
  }).map(t => t.token))];
}

// Тексти подій. Імена дітей у сповіщення не пишемо: воно з'являється на
// екрані блокування, де його може побачити хто завгодно.
const EVENTS = {
  grade:      (p) => ({ title: '📊 Нова оцінка', body: `${p.subject || 'Предмет'}: ${p.value || ''}`.trim(), tag: 'grade' }),
  absence:    (p) => ({ title: '🚨 Відсутність на уроці', body: `Учитель відмітив відсутність${p.subject ? ' — ' + p.subject : ''}`, tag: 'absence' }),
  late:       (p) => ({ title: '⏰ Запізнення на урок', body: `Учитель відмітив запізнення${p.subject ? ' — ' + p.subject : ''}`, tag: 'late' }),
  attendance_report: (p) => ({ title: p.value === 'late' ? '⏰ Учень запізнюється' : '🚨 Учень буде відсутній', body: `Родина повідомила про ${p.value === 'late' ? 'запізнення' : 'відсутність'}. Подробиці — у відвідуваності класу.`, tag: 'attendance-report' }),
  comment:    (p) => ({ title: '💬 Коментар учителя', body: p.subject ? `Новий коментар: ${p.subject}` : 'Новий коментар у щоденнику', tag: 'comment' }),
  homework:   (p) => ({ title: '📚 Нове завдання', body: `${p.subject || 'Предмет'}: задано домашнє завдання`, tag: 'hw' }),
  chat:       (p) => ({ title: '💬 Нове повідомлення',
                        body: `${p.subject || 'Школа'}: ${p.value || 'Відкрийте портал, щоб прочитати'}`,
                        tag: 'chat' }),
  news:       (p) => ({ title: '📣 Оголошення школи',
                        body: `${p.subject ? p.subject + ': ' : ''}${p.value || 'Нове оголошення в кабінеті'}`,
                        tag: 'news' }),
  menu:       (p) => ({ title: p.value === 'upd' ? '🍽️ Меню змінено' : '🍽️ Меню опубліковано',
                        body: p.value === 'upd' ? `Кухня оновила меню${p.subject ? ' на ' + p.subject : ''}`
                                                : `Меню${p.subject ? ' на ' + p.subject : ''} вже в кабінеті`,
                        tag: 'menu' })
};

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(origin) };
  if (event.httpMethod !== 'POST') return fail(405, 'Метод не підтримується', origin);
  // Origin ОБОВ'ЯЗКОВИЙ. Раніше перевірка стояла під `if (origin)`, тож
  // запит без цього заголовка проходив: браузер його шле завжди, а curl
  // чи бот — ні. Для розсилки сповіщень це особливо неприємно: чужий
  // скрипт міг надіслати push усім батькам школи.
  {
    let host = ''; try { host = new URL(origin || '').hostname; } catch (e) {}
    if (!host || !ALLOWED_HOSTS.includes(host))
      return fail(403, 'Запит із невідомого джерела', origin);
  }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return fail(500, 'Сповіщення не налаштовані: потрібна змінна FIREBASE_SERVICE_ACCOUNT', origin);

  let sa, body;
  try { sa = JSON.parse(raw); } catch (e) { return fail(500, 'FIREBASE_SERVICE_ACCOUNT — некоректний JSON', origin); }
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return fail(400, 'Некоректний запит', origin); }

  const build = EVENTS[body.type];
  if (!build) return fail(400, 'Невідомий тип події', origin);
  // Чат адресується поштами (body.to), меню й новини — усій школі.
  // Ні тим, ні тим клас та імʼя учня не потрібні.
  const isBroadcast = body.type === 'menu' || body.type === 'news' || body.type === 'chat';
  // ДЗ — подія класу: потрібен клас, але не потрібне (і не передається) імʼя учня.
  const isClassWide = body.type === 'homework';
  const cls = String(body.class || '').slice(0, 20);
  const studentName = String(body.studentName || '').slice(0, 120);
  if (isClassWide && !cls) return fail(400, 'Не вказано клас', origin);
  if (!isBroadcast && !isClassWide && (!cls || !studentName))
    return fail(400, 'Не вказано клас або учня', origin);
  if (body.type === 'chat' && !(Array.isArray(body.to) && body.to.length))
    return fail(400, 'Не вказано, кому надсилати', origin);

  const msg = build({
    subject: String(body.subject || '').slice(0, 80),
    // 120, а не 20: ліміт ставився під оцінку («12»), але сюди приходить
    // і текст на кшталт «нове повідомлення» — його різало на півслові.
    value: String(body.value || '').slice(0, 120)
  });

  try {
    const token = await getAccessToken(sa);
    // Діагностика: чи взагалі є кому слати. Без цього «0 надіслано» не
    // відрізнити від зламаних ключів.
    if (body.probe) {
      const all = await readDb(token, 'push_tokens');
      const list = all && typeof all === 'object' ? Object.values(all) : [];
      const eligible = list.filter(t => t && t.token && (t.role === 'parent' || t.role === 'student'));
      return { statusCode: 200, headers: cors(origin), body: JSON.stringify({
        ok: true, project: sa.project_id, tokens: list.length, eligible: eligible.length
      }) };
    }
    const targets = body.type === 'attendance_report'
      ? await findTeacherTargets(token, cls)
      : body.type === 'chat'
      ? await findByEmails(token, Array.isArray(body.to) ? body.to.slice(0, 30) : [])
      : (body.type === 'news' ? await findNewsTargets(token, cls)
      : (isClassWide ? await findClassTargets(token, cls)
      : (isBroadcast ? await findMealTargets(token)
                     : await findTargets(token, cls, studentName))));
    if (targets.length === 0)
      return { statusCode: 200, headers: cors(origin), body: JSON.stringify({ sent: 0, note: 'Немає підписників' }) };

    // data-only: показ бере на себе Service Worker — так вигляд сповіщення
    // однаковий і у фоні, і при відкритому порталі
    // Куди вести з натискання на сповіщення.
    //
    // Раніше посилання завжди вело просто на /cabinet, і портал відкривався
    // на вкладці за замовчуванням. Людина отримувала «Оголошення школи»,
    // натискала — і бачила «Сьогодні», без жодного натяку, де ж оголошення.
    //
    // Тепер у посиланні є підказка, яку вкладку відкрити. Кабінет її читає
    // й перемикається (див. openFromNotification у common.js).
    const TAB_BY_TYPE = {
      news:     'school',   // оголошення — вкладка «Школа»
      grade:    'grades',
      absence:  'day',
      late:     'day',
      attendance_report: 'day',
      menu:     'day',
      homework: 'day',      // ДЗ живе на вкладці «Сьогодні», поруч з уроками
      chat:     'chat'      // особливий випадок: відкриваємо саме листування
    };
    const tab = TAB_BY_TYPE[body.type] || 'day';
    // Адреса кабінету — з lib/site.js, а не з першого елемента списку
    // дозволених джерел: у тому списку тепер є і старий домен, і
    // localhost, і порядок у ньому — не місце вирішувати, куди вести
    // людину зі сповіщення.
    const url = `${CABINET_URL}?open=${tab}`;
    const results = await Promise.allSettled(targets.map(t =>
      fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: t,
            data: { title: msg.title, body: msg.body, tag: msg.tag, url },
            webpush: { headers: { Urgency: 'normal' }, fcmOptions: { link: url } }
          }
        })
      })
    ));
    const sent = results.filter(r => r.status === 'fulfilled' && r.value.ok).length;

    // ── МЕРТВІ ТОКЕНИ ТРЕБА ПРИБИРАТИ ──────────────────────────────
    //
    // FCM відповідає UNREGISTERED, коли підписки браузера більше немає:
    // людина перевстановила застосунок, почистила дані сайту або —
    // найчастіше — портал переїхав на інший домен. Дозвіл на сповіщення
    // і токен привʼязані до АДРЕСИ сайту, а не до акаунта, тож після
    // переїзду всі старі токени стають мертвими одночасно.
    //
    // Раніше такий рядок лишався в базі назавжди. Наслідків два, і обидва
    // кепські: у розсилці щоразу числиться отримувач, якого насправді
    // немає («надіслано 0 з 3»), а батько бачить у кабінеті англійське
    // «Device unregistered» і не розуміє, збереглося щось чи ні.
    //
    // Тепер такий токен видаляємо. Наступного разу людина просто не буде
    // в списку отримувачів — чесно й тихо, — а щойно вона знову натисне
    // «Увімкнути», запис зʼявиться сам.
    const DEAD = /UNREGISTERED|NOT_FOUND|INVALID_ARGUMENT|Requested entity was not found/i;
    let firstError = '', cleaned = 0;
    if (sent < targets.length) {
      const problems = [];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === 'rejected') { problems.push({ i, msg: r.reason && r.reason.message || 'мережева помилка', dead: false }); continue; }
        if (r.value.ok) continue;
        const d = await r.value.json().catch(() => null);
        const msg = (d && d.error && (d.error.message || d.error.status)) || `HTTP ${r.value.status}`;
        const code = (d && d.error && d.error.details || []).map(x => x && x.errorCode).join(' ');
        problems.push({ i, msg, dead: DEAD.test(msg) || DEAD.test(code) || r.value.status === 404 });
      }
      const deadTokens = new Set(problems.filter(p => p.dead).map(p => targets[p.i]));
      if (deadTokens.size) {
        // Токен не знає свого власника — шукаємо його в тому ж вузлі,
        // з якого щойно брали адресатів.
        try {
          const all = await readDb(token, 'push_tokens') || {};
          for (const uid in all) {
            if (all[uid] && deadTokens.has(all[uid].token)) {
              await deleteDb(token, `push_tokens/${uid}`).then(() => { cleaned++; }).catch(() => {});
            }
          }
        } catch (e) { /* прибирання не має зривати саму розсилку */ }
      }
      // Про мертві токени окремо не звітуємо: для того, хто натиснув
      // кнопку, це не помилка. Показуємо лише справжні збої.
      const real = problems.find(p => !p.dead);
      firstError = real ? real.msg : '';
    }
    return { statusCode: 200, headers: cors(origin),
             body: JSON.stringify({ sent, total: targets.length, firstError,
                                    stale: cleaned || undefined }) };
  } catch (e) {
    return fail(500, 'Не вдалося надіслати: ' + e.message, origin);
  }
};
