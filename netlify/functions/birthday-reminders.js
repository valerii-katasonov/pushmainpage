// ══════════════════════════════════════════════════════════════════
//  Push School — нагадування про дні народження класному керівнику
// ══════════════════════════════════════════════════════════════════
// ЩО РОБИТЬ. Раз на добу дивиться, у кого з учнів день народження рівно
// через 7 днів, і шле push класному керівнику цього класу.
//
// ЧОМУ ОКРЕМА ЗАПЛАНОВАНА ФУНКЦІЯ. Усе інше в порталі шле сповіщення з
// браузера: учитель поставив оцінку — браузер попросив надіслати. Тут
// слати нема кому: ніхто нічого не робить, просто настав певний день.
// Розклад задано в netlify.toml ([functions."birthday-reminders"]).
//
// ЩОБ ПРАЦЮВАЛО, потрібна та сама змінна, що й для решти сповіщень:
//   Netlify → Site configuration → Environment variables →
//   FIREBASE_SERVICE_ACCOUNT = вміст сервісного ключа Firebase одним рядком
// Якщо змінної немає, функція просто нічого не робить і каже про це в лог.
//
// ЧОМУ КОД ОТРИМАННЯ ТОКЕНА ПОВТОРЮЄТЬСЯ З notify.js. Спільний файл довелося
// б класти в підтеку functions, а Netlify по-різному ставиться до підтек у
// цій теці. Ціна помилки — мовчазно зламані сповіщення про оцінки, тож тут
// свідомо обрано повтор тридцяти рядків замість спільного модуля.
//
// ЧИ МОЖНА ЦЕ СМИКНУТИ ЗЗОВНІ. Функція не приймає жодних параметрів, а
// позначка про надіслане (birthday_notices) робить її ідемпотентною:
// повторний виклик того самого дня нікому нічого не надішле.

const crypto = require('crypto');
const DB = 'https://test-4eb3e-default-rtdb.europe-west1.firebasedatabase.app';
const SITE = 'https://planlekcjipush.netlify.app';
// За скільки днів нагадувати. НЕ дорівнює вікну списку в кабінеті
// (BIRTHDAY_WINDOW_DAYS у common.js — місяць), і це навмисно: список
// показує, що попереду, а сповіщення каже, що пора діяти. Якщо колись
// зводитимете ці числа — зводьте свідомо, а не «щоб було однаково».
const DAYS_BEFORE = 7;

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
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
  return d.access_token;
}

async function readDb(token, path) {
  const r = await fetch(`${DB}/${path}.json?access_token=${encodeURIComponent(token)}`);
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`база недоступна (${path}): ${(d && d.error) || r.status}`);
  return d;
}
async function writeDb(token, path, value) {
  const r = await fetch(`${DB}/${path}.json?access_token=${encodeURIComponent(token)}`,
    { method: 'PUT', body: JSON.stringify(value) });
  if (!r.ok) throw new Error(`не вдалося записати ${path}: ${r.status}`);
}

// Дата у Варшаві, а не в UTC.
//
// Функція крутиться на сервері Netlify за Гринвічем. Якщо рахувати «сьогодні»
// звідти, то з жовтня по березень о першій ночі за Варшавою день ще вчорашній,
// і нагадування приїхало б на добу пізніше.
function warsawToday() {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return f.format(new Date());               // «YYYY-MM-DD»
}

// Дата через N днів і її «MM-DD»
function targetDay(todayStr, days) {
  const p = todayStr.split('-');
  const d = new Date(+p[0], +p[1] - 1, +p[2] + days);
  const p2 = (n) => String(n).padStart(2, '0');
  const iso = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  return { iso, md: iso.slice(5) };
}

// 29 лютого у невисокосний рік вважаємо 1 березня — так само, як показує
// список у кабінеті. Інакше така дитина випадала б раз на чотири роки.
function matchesBirthday(md, target, year) {
  if (md === target.md) return true;
  const leap = new Date(year, 1, 29).getDate() === 29;
  return md === '02-29' && target.md === '03-01' && !leap;
}

const CLASS_LABEL = (cls) => {
  const m = /class_(\d+)/.exec(cls || '');
  return m ? `${m[1]} клас` : (cls || 'клас');
};

exports.handler = async () => {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.log('FIREBASE_SERVICE_ACCOUNT не задано — нагадування не надсилаються');
    return { statusCode: 200, body: 'no service account' };
  }
  let sa;
  try { sa = JSON.parse(raw); }
  catch (e) { console.log('FIREBASE_SERVICE_ACCOUNT — некоректний JSON'); return { statusCode: 200, body: 'bad json' }; }

  try {
    const token = await getAccessToken(sa);
    const today = warsawToday();
    const target = targetDay(today, DAYS_BEFORE);
    const year = +today.slice(0, 4);

    const [teachers, bdays, tokens, notices] = await Promise.all([
      readDb(token, 'class_teachers'),
      readDb(token, 'student_birthdays'),
      readDb(token, 'push_tokens'),
      readDb(token, 'birthday_notices').catch(() => null)
    ]);
    if (!teachers || !bdays) return { statusCode: 200, body: 'нічого перевіряти' };

    let sent = 0, skipped = 0;
    for (const cls in bdays) {
      const ct = teachers[cls];
      if (!ct || !ct.teacherEmail) continue;         // класного керівника не призначено

      // Кого вітати через тиждень
      const due = [];
      for (const key in bdays[cls]) {
        const md = String(bdays[cls][key] || '');
        if (md.length !== 5) continue;
        if (!matchesBirthday(md, target, year)) continue;
        // Позначка зберігає дату свята, тож наступного року нагадаємо знову
        const already = notices && notices[cls] && notices[cls][key];
        if (already === target.iso) { skipped++; continue; }
        due.push(key);
      }
      if (!due.length) continue;

      // Кому слати: пристрої класного керівника
      const want = String(ct.teacherEmail).toLowerCase();
      const targets = [];
      for (const uid in (tokens || {})) {
        const t = tokens[uid];
        if (!t || !t.token || !t.email) continue;
        if (String(t.email).toLowerCase() === want) targets.push(t.token);
      }

      // Імен дітей у сповіщенні немає навмисно: воно з'являється на екрані
      // блокування, де його може побачити хто завгодно — у вчительській,
      // у транспорті. Хто саме іменинник, видно у списку в кабінеті.
      const dd = target.iso.slice(8), mm = target.iso.slice(5, 7);
      const body = due.length === 1
        ? `${CLASS_LABEL(cls)}: за тиждень, ${+dd}.${mm}, день народження в одного учня`
        : `${CLASS_LABEL(cls)}: за тиждень, ${+dd}.${mm}, іменинників — ${due.length}`;
      const url = `${SITE}/cabinet?open=class`;

      if (targets.length) {
        const results = await Promise.allSettled([...new Set(targets)].map(t =>
          fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: {
                token: t,
                data: { title: '🎂 Скоро день народження', body, tag: 'birthday', url },
                webpush: { headers: { Urgency: 'normal' }, fcmOptions: { link: url } }
              }
            })
          })
        ));
        sent += results.filter(r => r.status === 'fulfilled' && r.value.ok).length;
      }

      // Позначку ставимо навіть тоді, коли слати не було кому: інакше
      // функція щодня безуспішно ходила б по тих самих учнях. Список у
      // кабінеті все одно покаже іменинника — push тут не єдиний шлях.
      for (const key of due) await writeDb(token, `birthday_notices/${cls}/${key}`, target.iso);
    }

    const note = `дата ${target.iso}, надіслано ${sent}, вже було ${skipped}`;
    console.log('Нагадування про дні народження: ' + note);
    return { statusCode: 200, body: note };
  } catch (e) {
    console.log('Нагадування про дні народження — помилка: ' + e.message);
    return { statusCode: 200, body: 'error: ' + e.message };
  }
};
