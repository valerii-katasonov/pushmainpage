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

async function patchDb(token, path, value) {
  const r = await fetch(`${DB}/${path}.json?access_token=${encodeURIComponent(token)}`, { method: 'PATCH', body: JSON.stringify(value) });
  if (!r.ok) throw new Error(`не вдалося записати ${path}: ${r.status}`);
}

// ── «💬 Хочу обговорити» (talk-requests.js) ──────────────────────
// Клієнт передає лише АДРЕСУ запису (клас, пошта батька, id). Текст
// сповіщення складаємо тут із самого запису: функція приймає запити без
// входу, і вільний текст звідти дозволив би писати вчителям що завгодно.
// Позначка notified / replyNotified робить повторний виклик порожнім.
const TALK_REASONS = { grades: 'оцінки знизились', topic: 'не розуміє тему', hw: 'забагато чи заскладне ДЗ',
                       behavior: 'поведінка чи стосунки в класі', other: 'інше' };
const normSubj = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
// Учителі предмета в класі за матрицею доступу; немає — класний керівник
function subjectTeachers(access, heads, cls, subject) {
  const want = normSubj(subject), out = [];
  for (const [key, row] of Object.entries(access || {})) {
    const raw = row && row[cls];
    const list = (Array.isArray(raw) ? raw : Object.values(raw || {})).filter(v => typeof v === 'string');
    if (list.some(v => v.trim() === 'Всі предмети' || normSubj(v) === want)) out.push(key);
  }
  if (!out.length && heads && heads[cls] && heads[cls].teacherEmail) out.push(emailKey(heads[cls].teacherEmail));
  return [...new Set(out)];
}
async function talkPlan(token, type, cls, who, id) {
  const base = `talk_requests/${cls}/${who}/${id}`;
  const meta = await readDb(token, base);
  if (!meta || typeof meta !== 'object') return { note: 'Запиту немає' };
  const done = type === 'talk' ? (meta.notified || meta.status !== 'open') : (meta.replyNotified || meta.status !== 'answered');
  if (done) return { note: 'Уже надіслано' };
  const at = Number(type === 'talk' ? meta.ts : meta.replyTs) || 0;
  if (Date.now() - at > 24 * 3600e3) return { note: 'Запит застарий' };
  const subject = String(meta.subject || '').slice(0, 80);
  if (type === 'talk') {
    // Не більше п'яти сповіщень від однієї родини в класі за добу
    const mine = await readDb(token, `talk_requests/${cls}/${who}`).catch(() => null) || {};
    if (Object.values(mine).filter(r => r && r.notified && Date.now() - Number(r.ts || 0) < 24 * 3600e3).length >= 5)
      return { note: 'Забагато запитів за добу' };
    await patchDb(token, base, { notified: true });
    const [text, access, heads] = await Promise.all([
      readDb(token, `talk_text/${cls}/${who}/${id}`).catch(() => null), readDb(token, 'teacher_access'), readDb(token, 'class_teachers')]);
    return { emails: subjectTeachers(access, heads, cls, subject), params: { subject, ref: id, reason: TALK_REASONS[text && text.reason] || '' } };
  }
  await patchDb(token, base, { replyNotified: true });
  return { emails: [meta.byEmail].filter(Boolean), params: { subject, ref: id } };
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

// ── ТОКЕНИ ВСІХ ПРИСТРОЇВ ЛЮДИНИ ────────────────────────────────────
//
// push_tokens/{uid} колись тримав ОДИН токен. Учитель, що увімкнув
// сповіщення на телефоні, заходив у портал зі шкільного компʼютера — і при
// вході токен компʼютера затирав телефонний: на телефон більше нічого не
// приходило. А вихід на будь-якому пристрої видаляв запис цілком.
//
// Тепер пристрої лежать у devices/{ключ} = {token}. Старі записи (одне
// поле token) читаються як раніше, поки людина не зайде з новою версією.
function tokensOf(t){
  if(!t || typeof t !== 'object') return [];
  const dev = (t.devices && typeof t.devices === 'object')
    ? Object.values(t.devices).map(d => d && d.token).filter(Boolean) : [];
  return dev.length ? dev : (t.token ? [t.token] : []);
}

async function findTargets(token, cls, studentName) {
  const [all,parents,students] = await Promise.all([
    readDb(token,'push_tokens'),readDb(token,'parent_links'),readDb(token,'student_links')
  ]);
  if (!all || typeof all !== 'object') return [];
  const out = [];
  for (const uid in all) {
    const t = all[uid];
    if (!tokensOf(t).length) continue;
    const kids=effectiveChildren(t,parents,students);
    if (!kids.some(k=>k.class===cls&&(k.studentName===studentName||k.studentId===studentName))) continue;
    out.push(...tokensOf(t));
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
    if (!tokensOf(t).length) continue;
    if (!effectiveChildren(t,parents,students).some(k=>k.class===cls)) continue;
    out.push(...tokensOf(t));
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
// Сьогодні за Варшавою (сервер Netlify живе в UTC)
function warsawToday(){
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
async function findByEmails(token, emails) {
  const all = await readDb(token, 'push_tokens');
  if (!all || typeof all !== 'object') return [];
  const want = new Set(emails.map(emailKey));
  const out = [];
  for (const uid in all) {
    const t = all[uid];
    if (!t || !t.email || !tokensOf(t).length) continue;
    if (want.has(emailKey(t.email))) out.push(...tokensOf(t));
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
    if (!tokensOf(t).length) continue;
    const kids=effectiveChildren(t,parents,students);
    if (!kids.length) continue;
    if (one&&!kids.some(k=>k.class===one)) continue;
    out.push(...tokensOf(t));
  }
  return [...new Set(out)];
}

// Меню стосується всіх одразу, тому шлемо однією розсилкою: 165 окремих
// викликів функції поклали б і ліміти Netlify, і квоту FCM.
// ХАРЧУВАННЯ — ЦЕ НЕ ЛИШЕ ОБІД.
//
// Тут стояла одна перевірка: plan.lunch === false — значить не харчується,
// не турбуємо. Але дитина може не обідати й при цьому щодня брати
// підвечірок або сніданок. Такі родини не отримували жодного сповіщення
// про оновлення меню — хоча підвечірок у тому меню теж є.
//
// Мовчання тут особливо підступне: ніхто не скаржиться на сповіщення,
// які не прийшли. Тому відсіюємо лише тих, хто не бере НІЧОГО.
function takesAnyMeal(plan){
  if(!plan) return true;                 // не відповідали — не наша справа вирішувати за них
  if(plan.lunch !== false) return true;
  return ['snack','breakfast'].some(k => plan[k] && plan[k] !== 'no');
}

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
    if (!tokensOf(t).length) continue;
    const kids=effectiveChildren(t,parents,students);
    if (!kids.length) continue;
    // Для кількох дітей достатньо, щоб харчувалася хоча б одна. Один токен
    // однаково отримає одне повідомлення, дублювати його по дітях не треба.
    const eats=kids.some(k=>{
      const byClass=plans[k.class]||{};
      const plan=(k.studentId&&byClass[k.studentId])||byClass[k.studentName];
      return takesAnyMeal(plan);
    });
    if(!eats)continue;
    out.push(...tokensOf(t));
  }
  return [...new Set(out)];
}

// ── Хто цього дня веде уроки в класі ──
// КОПІЯ lessonTeachersOn з access.js (сервер не імпортує модулі браузера).
// Змінюєте тут — змініть і там; tests-access.mjs звіряє обидві.
const NO_NOTIFY_RE = /басейн|плаванн/i;
const WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ALL_SUBJECTS = 'Всі предмети';
function itemNames(item){
  const alt = item && item.alt ? (Array.isArray(item.alt) ? item.alt : Object.values(item.alt))
    .map(x => typeof x === 'string' ? x : (x && x.ua) || '').map(s => String(s).trim()).filter(Boolean) : [];
  if(alt.length > 1) return alt;
  const raw = item && (typeof item.subject === 'object' ? (item.subject && item.subject.ua) : item.subject);
  const s = String(raw || '').trim();
  if(!s) return [];
  const p = s.split(/\s+\/\s+/).map(x => x.trim()).filter(Boolean);
  return p.length > 1 ? p : [s];
}
function lessonTeachersOn({ lessons, access, heads, subs, cls, weekday, keyOf }){
  const out = new Set();
  const head = heads && heads[cls] && heads[cls].teacherEmail;
  if(head) out.add(keyOf(head));
  if(!lessons || typeof lessons !== 'object' || !Object.keys(lessons).length) return { keys: out, known: false };
  const raw = lessons[WEEK[weekday]] || [];
  const slots = Array.isArray(raw) ? raw.map((s, i) => [String(i), s]) : Object.entries(raw);
  const nm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const holders = name => Object.entries(access || {}).filter(([, row]) => {
    const l = row && row[cls];
    return (Array.isArray(l) ? l : Object.values(l || {})).some(v => typeof v === 'string' && (v.trim() === ALL_SUBJECTS || nm(v) === nm(name)));
  }).map(([k]) => k);
  for(const [idx, slot] of slots){
    const items = Array.isArray(slot) ? slot : (slot && typeof slot === 'object' && Object.keys(slot).length ? [slot] : []);
    for(const it of items){
      if(!it || typeof it !== 'object' || it.type === 'break' || it.type === 'extra') continue;
      for(const name of itemNames(it)){
        if(NO_NOTIFY_RE.test(name)) continue;
        const s = subs || {};
        const cover = (s[idx] && nm(s[idx].subject) === nm(name)) ? s[idx] : (s.any && nm(s.any.subject) === nm(name)) ? s.any : null;
        if(cover && cover.subEmail){ out.add(keyOf(cover.subEmail)); continue; }
        if(it.teacherEmail){ out.add(keyOf(it.teacherEmail)); continue; }
        holders(name).forEach(k => out.add(k));
      }
    }
  }
  return { keys: out, known: true };
}

// Родина попереджає вчителів свого класу, а не інші родини.
// Клас у токені вчителя не є призначенням: звіряємо реєстр і матрицю.
//
// І НЕ ВСІХ УЧИТЕЛІВ КЛАСУ, А ТИХ, ХТО ЦЬОГО ДНЯ ТАМ ВЕДЕ УРОК. Учитель з
// одним уроком у пʼятницю отримував сповіщення про клас щоранку, а супровід
// на басейн — узагалі ні до чого. Класний керівник — завжди. Якщо розкладу
// класу немає, лишається старе правило «усім з доступом» — краще зайве
// сповіщення, ніж жодного.
async function findTeacherTargets(token, cls, date) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : warsawToday();
  const [all, access, heads, approved, lessons, subs] = await Promise.all([
    readDb(token, 'push_tokens'), readDb(token, 'teacher_access'),
    readDb(token, 'class_teachers'),readDb(token,'pre_approved_roles'),
    readDb(token, `schedules/${cls}/lessons`).catch(() => null),
    readDb(token, `substitutions/${day}/${cls}`).catch(() => null)
  ]);
  const [y, m, d] = day.split('-').map(Number);
  const plan = lessonTeachersOn({ lessons, access, heads, subs, cls, weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay(), keyOf: emailKey });
  const head = emailKey(heads?.[cls]?.teacherEmail);
  const roles = ['teacher', 'class_teacher', 'art_school_teacher', 'music_teacher', 'master_class_teacher'];
  return [...new Set(Object.values(all || {}).filter(t => {
    if (!tokensOf(t).length || !t.email) return false;
    const key = emailKey(t.email);
    const actual=(approved&&typeof approved==='object')?roleValues(approved[key]):tokenRoles(t);
    if(!roles.some(r=>actual.includes(r)))return false;
    if(plan.known) return plan.keys.has(key);
    const assigned = access?.[key]?.[cls];
    const subjects = Array.isArray(assigned) ? assigned : Object.values(assigned || {});
    return key === head || subjects.some(v => typeof v === 'string' && v.trim());
  }).flatMap(tokensOf))];
}

// Тексти подій. Імена дітей у сповіщення не пишемо: воно з'являється на
// екрані блокування, де його може побачити хто завгодно.
const EVENTS = {
  grade:      (p) => ({ title: '📊 Нова оцінка', body: `${p.subject || 'Предмет'}: ${p.value || ''}`.trim(), tag: 'grade' }),
  absence:    (p) => ({ title: '🚨 Відсутність на уроці', body: `Учитель відмітив відсутність${p.subject ? ' — ' + p.subject : ''}`, tag: 'absence' }),
  late:       (p) => ({ title: '⏰ Запізнення на урок', body: `Учитель відмітив запізнення${p.subject ? ' — ' + p.subject : ''}`, tag: 'late' }),
  // СПЕРШУ — ХТО, ПОТІМ — ЩО. Учитель на уроці бачить сповіщення краєм ока:
  // «Учень запізнюється» змушувало відкривати портал, щоб дізнатися, хто
  // саме. Тепер у заголовку дитина і клас, у тексті — що сталося.
  // Причину відсутності («через хворобу») не пишемо: сповіщення видно на
  // екрані блокування. Хвилини запізнення — пишемо, вони нічого не
  // розкривають і саме їх учитель хоче знати.
  // tag — окремий на кожну дитину: раніше тег був спільний, і друге
  // сповіщення тихо заміняло перше.
  attendance_report: (p) => ({
    title: [p.student, p.clsLabel].filter(Boolean).join(', ') || 'Учень',
    body: (p.value === 'late' ? `⏰ Запізнюється${p.reason ? ' ' + p.reason : ''}` : '🚨 Не буде на уроках')
          + (p.day ? ` · ${p.day}` : ''),
    tag: 'attendance-report-' + (p.tagKey || 'x') }),
  comment:    (p) => ({ title: '💬 Коментар учителя', body: p.subject ? `Новий коментар: ${p.subject}` : 'Новий коментар у щоденнику', tag: 'comment' }),
  homework:   (p) => ({ title: '📚 Нове завдання', body: `${p.subject || 'Предмет'}: задано домашнє завдання`, tag: 'hw' }),
  chat:       (p) => ({ title: '💬 Нове повідомлення',
                        body: `${p.subject || 'Школа'}: ${p.value || 'Відкрийте портал, щоб прочитати'}`,
                        tag: 'chat' }),
  // Сповіщення йде на КОЖНЕ оголошення. Важливе відрізняється заголовком,
  // нагадування (кнопка «🔔 Нагадати» під оголошенням) — теж. tag свій на
  // кожне оголошення: інакше друге тихо заміняло б перше в шторці.
  news:       (p) => ({ title: p.remind ? '🔔 Нагадування про оголошення'
                               : p.important ? '❗ Важливе оголошення' : '📣 Оголошення школи',
                        body: `${p.subject ? p.subject + ': ' : ''}${p.value || 'Нове оголошення в кабінеті'}`,
                        tag: 'news' + (p.ref ? '-' + p.ref : '') }),
  // Нагадування директора вчителю про незаповнений журнал. Текст складаємо
  // ТУТ і лише з чисел: функція приймає запити без входу, тож вільний текст
  // «від директора» дозволив би будь-кому розсилати вчителям що завгодно.
  reminder:   (p) => ({ title: '📝 Нагадування про журнал',
                        body: 'Не заповнено: ' + ([p.topics && `тем — ${p.topics}`, p.hw && `ДЗ — ${p.hw}`,
                                                   p.grades && `класів без оцінок — ${p.grades}`].filter(Boolean).join(', ') || 'записи')
                              + '. Відкрийте портал і допишіть.',
                        tag: 'reminder' }),
  // Імені дитини немає: сповіщення видно на заблокованому екрані
  talk:       (p) => ({ title: '💬 Батьки просять звʼязатися',
                        body: `${p.clsLabel ? p.clsLabel + ' · ' : ''}${p.subject || 'Предмет'}${p.reason ? ': ' + p.reason : ''}`,
                        tag: 'talk' + (p.ref ? '-' + p.ref : '') }),
  talk_reply: (p) => ({ title: '💬 Учитель відповів',
                        body: `${p.subject || 'Предмет'}: відповідь на ваш запит — у кабінеті`,
                        tag: 'talk-reply' + (p.ref ? '-' + p.ref : '') }),
  menu:       (p) => ({ title: p.value === 'upd' ? '🍽️ Меню змінено' : '🍽️ Меню опубліковано',
                        body: p.value === 'upd' ? `Кухня оновила меню${p.subject ? ' на ' + p.subject : ''}`
                                                : `Меню${p.subject ? ' на ' + p.subject : ''} вже в кабінеті`,
                        tag: 'menu' })
};

exports._test = { lessonTeachersOn };

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
  const isBroadcast = body.type === 'menu' || body.type === 'news' || body.type === 'chat' || body.type === 'reminder';
  // ДЗ — подія класу: потрібен клас, але не потрібне (і не передається) імʼя учня.
  const isClassWide = body.type === 'homework';
  // Запит батька вчителю / відповідь: лише адреса запису в базі
  const isTalk = body.type === 'talk' || body.type === 'talk_reply';
  const talkWho = String(body.who || ''), talkId = String(body.ref || '');
  const cls = String(body.class || '').slice(0, 20);
  const studentName = String(body.studentName || '').slice(0, 120);
  if (isClassWide && !cls) return fail(400, 'Не вказано клас', origin);
  if (isTalk && !(/^class_\d{1,2}$/.test(cls) && /^[^.#$\[\]\/]{3,200}$/.test(talkWho) && /^[-_A-Za-z0-9]{1,40}$/.test(talkId)))
    return fail(400, 'Некоректна адреса запиту', origin);
  if (!isBroadcast && !isClassWide && !isTalk && (!cls || !studentName))
    return fail(400, 'Не вказано клас або учня', origin);
  if ((body.type === 'chat' || body.type === 'reminder') && !(Array.isArray(body.to) && body.to.length))
    return fail(400, 'Не вказано, кому надсилати', origin);

  // Для повідомлення про відсутність/запізнення: дата й хвилини — лише
  // у відомому вигляді. Функція приймає запити без входу, тож вільний
  // текст сюди не пускаємо.
  const reportDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) ? String(body.date) : '';
  const lateReason = String(body.reason || '');
  let msg = build({
    subject: String(body.subject || '').slice(0, 80),
    // Лічильники для нагадування — лише цілі числа 0…999
    topics: /^\d{1,3}$/.test(String(body.topics ?? '')) ? Number(body.topics) : 0,
    hw:     /^\d{1,3}$/.test(String(body.hw ?? '')) ? Number(body.hw) : 0,
    grades: /^\d{1,3}$/.test(String(body.grades ?? '')) ? Number(body.grades) : 0,
    // Лише прапорці й id у відомому вигляді: функція приймає запити без входу
    important: body.important === true,
    remind: body.remind === true,
    ref: /^[-_A-Za-z0-9]{1,40}$/.test(String(body.ref || '')) ? String(body.ref) : '',
    // 120, а не 20: ліміт ставився під оцінку («12»), але сюди приходить
    // і текст на кшталт «нове повідомлення» — його різало на півслові.
    value: String(body.value || '').slice(0, 120),
    student: studentName,
    clsLabel: /^class_\d{1,2}$/.test(cls) ? cls.replace('class_', '') + ' клас' : '',
    reason: /^(на \d{1,2} хвилин|до \d{1,2}-го уроку)$/.test(lateReason) ? lateReason : '',
    // Сьогоднішню дату не пишемо — «· 24.09» у день самого уроку лише
    // заважає; інший день (зазвичай завтра) показуємо.
    day: reportDate && reportDate !== warsawToday()
      ? reportDate.slice(8, 10) + '.' + reportDate.slice(5, 7) : '',
    tagKey: crypto.createHash('sha1').update(cls + '|' + studentName).digest('hex').slice(0, 12)
  });

  try {
    const token = await getAccessToken(sa);
    // Діагностика: чи взагалі є кому слати. Без цього «0 надіслано» не
    // відрізнити від зламаних ключів.
    if (body.probe) {
      const all = await readDb(token, 'push_tokens');
      const list = all && typeof all === 'object' ? Object.values(all) : [];
      const eligible = list.filter(t => tokensOf(t).length && (t.role === 'parent' || t.role === 'student'));
      return { statusCode: 200, headers: cors(origin), body: JSON.stringify({
        ok: true, project: sa.project_id, tokens: list.length, eligible: eligible.length
      }) };
    }
    let talk = null;
    if (isTalk) {
      talk = await talkPlan(token, body.type, cls, talkWho, talkId);
      if (!talk.emails) return { statusCode: 200, headers: cors(origin), body: JSON.stringify({ sent: 0, note: talk.note }) };
      msg = build({ ...talk.params, clsLabel: cls.replace('class_', '') + ' клас' });
    }
    const targets = isTalk ? await findByEmails(token, talk.emails)
      : body.type === 'attendance_report'
      ? await findTeacherTargets(token, cls, reportDate)
      : body.type === 'chat'
      ? await findByEmails(token, Array.isArray(body.to) ? body.to.slice(0, 30) : [])
      // Нагадування — лише одному вчителю за раз
      : body.type === 'reminder'
      ? await findByEmails(token, Array.isArray(body.to) ? body.to.slice(0, 1) : [])
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
      attendance_report: 'att',   // «Сьогодні» і одразу до блоку відвідуваності
      // МЕНЮ Й ДЗ МАЮТЬ ВЛАСНІ ВКЛАДКИ. Обидва вели на «Сьогодні» — так
      // було, коли окремих вкладок не існувало. Тепер батько зі сповіщення
      // «оновлено меню» потрапляв на розклад і шукав меню сам.
      menu:     'meals',
      homework: 'hw',
      chat:     'chat',     // особливий випадок: відкриваємо саме листування
      reminder: 'lesson',   // учитель — одразу на вкладку уроку
      talk:       'talk',   // «Сьогодні» і прокрутка до блоку запитів
      talk_reply: 'talk'
    };
    const tab = TAB_BY_TYPE[body.type] || 'day';
    // Адреса кабінету — з lib/site.js, а не з першого елемента списку
    // дозволених джерел: у тому списку тепер є і старий домен, і
    // localhost, і порядок у ньому — не місце вирішувати, куди вести
    // людину зі сповіщення.
    // Для відвідуваності в адресі ще клас і дата: учитель може дивитися
    // інший свій клас або інший день, а відмітка стоїть саме тут.
    const extra = body.type === 'attendance_report'
      ? (/^class_\d{1,2}$/.test(cls) ? `&cls=${cls}` : '') + (reportDate ? `&date=${reportDate}` : '')
      : '';
    const url = `${CABINET_URL}?open=${tab}${extra}`;
    const URGENT = new Set(['attendance_report', 'chat']);
    const results = await Promise.allSettled(targets.map(t =>
      fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: t,
            data: { title: msg.title, body: msg.body, tag: msg.tag, url },
            // Відсутність/запізнення і чат — термінові: з Urgency normal Android
            // у режимі сну (телефон лежить із вимкненим екраном) відкладає
            // доставку до пробудження, і вчитель бачить сповіщення з запізненням
            // або не бачить зовсім. Решта (оцінки, меню) лишається normal.
            webpush: { headers: { Urgency: URGENT.has(body.type) ? 'high' : 'normal' }, fcmOptions: { link: url } }
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
            const rec = all[uid];
            if (!rec) continue;
            const devs = (rec.devices && typeof rec.devices === 'object') ? rec.devices : null;
            if (devs && Object.keys(devs).length) {
              // Прибираємо лише мертвий пристрій — решта пристроїв людини лишаються
              for (const k of Object.keys(devs)) {
                if (devs[k] && deadTokens.has(devs[k].token))
                  await deleteDb(token, `push_tokens/${uid}/devices/${k}`).then(() => { cleaned++; }).catch(() => {});
              }
            } else if (deadTokens.has(rec.token)) {
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
