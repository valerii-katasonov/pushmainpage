// ═══════════════════════════════════════════════════════════════
// activities.js — басейн і шкільний автобус.
//
// НАВІЩО. Досі це жило в месенджерах: класна керівниця збирала «хто йде на
// басейн» повідомленнями, а список автобуса лежав у неї в зошиті. Кожен
// тиждень заново, і кожен раз хтось губився. Тут те саме, але одним
// натисканням і одразу в зведенні для директора.
//
// ДВА РІЗНІ ЗА ПРИРОДОЮ ПИТАННЯ — і зберігаються вони по-різному.
//
//   1. ПОСТІЙНА ВІДПОВІДЬ (activity_plan). «Дитина ходить на басейн?»,
//      «Їздить шкільним автобусом?» — питаємо ОДИН раз, далі відповідь
//      просто живе. Змінити можна будь-коли: дитина може почати їздити
//      автобусом із листопада, і це нормально.
//
//   2. ТИЖНЕВИЙ ВИНЯТОК (pool_week). «Цього тижня на басейн не буде» —
//      разова відмова, яка сама зникає з новим тижнем.
//
// ЧОМУ ЗБЕРІГАЄМО ЛИШЕ ВІДМОВИ. Типова відповідь — «йде». Якби ми писали
// в базу і «так», щотижня з'являлося б по рядку на кожного учня школи —
// сотні записів, які лише підтверджують очікуване. Тому запис означає
// рівно одне: цього тижня дитини не буде. Немає запису — йде.
//
//   activity_plan/{клас}/{учень} = {pool:bool, bus:bool, ts, by}
//   pool_week/{клас}/{понеділок}/{учень} = {going:false, ts, by}
// ═══════════════════════════════════════════════════════════════
import { ref, set, get, child, update } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, currentUserData, getActiveClass, showToast, escHtml,
         logAction, mondayOf, localDateString,
         getStudentDir, resolveStudentKey } from './common.js';

export const ACT_BUILD = '2026-09-08 · басейн і автобус v3';
// Рядок у консолі — щоб на питання «а нова версія взагалі виїхала?»
// можна було відповісти за секунду, а не здогадуватися.
console.info('[Push School] activities.js —', ACT_BUILD);

// Ключ дитини в базі. Перевага в studentId: імена повторюються й
// міняються, ідентифікатор — ні.
//
// ОДНА ДИТИНА — ОДИН КЛЮЧ, НЕЗАЛЕЖНО ВІД ТОГО, ХТО З БАТЬКІВ ВІДКРИВ.
//
// Раніше тут стояло `d.studentId || d.studentName` — сирий запасний
// варіант із профілю того, хто зайшов. А профілі в батьків різні: у
// матері при прив'язці записався ідентифікатор, у батька — ні, у нього
// лише ім'я. Виходило два різні шляхи для однієї дитини:
//   activity_plan/class_3/-Nx7...    ← відповідь матері
//   activity_plan/class_3/Іван Ковальчук  ← відповідь батька
// Мати відповідала, батько відкривав портал — і питання про басейн
// поставало перед ним заново, ніби ніхто нічого не вирішував. А в
// класного керівника та сама дитина рахувалася двічі.
//
// Ця сама вада вже ловилася на харчуванні; лікується вона там
// resolveStudentKey — звіркою зі списком класу, а не довірою до копії в
// профілі. Тут тепер те саме, тією ж функцією.
//
// Асинхронна: список класу читається з бази (з кешем усередині).
async function myKid(){
  const d = currentUserData || {};
  const cls = d.class || getActiveClass();
  if(!cls) return { cls:'', sid:'' };
  let dir = null;
  try{ dir = await getStudentDir(cls); }
  catch(e){ console.warn('[Push School] довідник класу:', e.message); }
  const res = resolveStudentKey(dir, d.studentId, d.studentName);
  if(res.stale)
    console.warn('[Push School] studentId із профілю не знайдено у списку класу — шукаю за імʼям');
  // Ключа немає в списку зовсім — лишається ім'я. Це гірше за
  // ідентифікатор, але краще, ніж не показати питання взагалі.
  return { cls, sid: res.key || d.studentId || d.studentName || '' };
}

// Понеділок тижня, до якого належить дата. Тиждень позначаємо саме
// понеділком: так «цей тиждень» однаково рахується і в батьків, і в
// директора, незалежно від того, коли хто відкрив портал.
export function weekKey(dateStr){
  // localDateString — це РЯДОК «2026-09-08», а не функція. Виклик його як
  // функції кидав TypeError, і оскільки weekKey() стоїть поза try, помилка
  // вилітала з renderActivities назовні: блок так і лишався порожнім, без
  // жодного повідомлення. Саме через це він «не з'являвся».
  return mondayOf(dateStr || localDateString);
}

// Людський підпис тижня: «8–14 вересня». Дата в форматі 2026-09-08 нічого
// не каже батькові, який відкрив портал у четвер.
const MONTHS_UA = ['січня','лютого','березня','квітня','травня','червня',
                   'липня','серпня','вересня','жовтня','листопада','грудня'];
// Понеділок–неділя: тижнева відмітка басейну діє на весь тиждень.
export function fullWeekLabel(monday){
  const [y,m,d] = String(monday).split('-').map(Number);
  if(!y) return '';
  const a = new Date(y, m-1, d), b = new Date(y, m-1, d+6);
  const sameMonth = a.getMonth() === b.getMonth();
  return sameMonth
    ? `${a.getDate()}–${b.getDate()} ${MONTHS_UA[a.getMonth()]}`
    : `${a.getDate()} ${MONTHS_UA[a.getMonth()]} – ${b.getDate()} ${MONTHS_UA[b.getMonth()]}`;
}

// Чи йде дитина на басейн цього тижня. Головне правило файлу — саме тут:
// відсутність запису означає «йде».
export function goesThisWeek(weekNode, sid){
  const rec = (weekNode || {})[sid];
  return !(rec && rec.going === false);
}

// ── КАБІНЕТ БАТЬКІВ ─────────────────────────────────────────────

let actPlan = null;      // {pool, bus} цієї дитини
let actWeek = null;      // запис тижня цієї дитини

export async function renderActivities(boxId){
  const box = document.getElementById(boxId);
  if(!box) return;
  // Питання адресоване дорослому: рішення про басейн і про те, хто везе
  // дитину, приймає він. Учень бачить результат у розкладі, але не змінює.
  if(!currentUserData || currentUserData.role !== 'parent'){ box.style.display='none'; return; }
  const { cls, sid } = await myKid();
  // Дитина не визначена — мовчки ховати не можна: батько вирішив би, що
  // так і має бути, і питання про басейн просто не дійшло б до нього.
  if(!cls || !sid){
    box.style.display='block';
    box.innerHTML = `<div class="act-warn">Не вдалося визначити дитину, тож питання про
      басейн і автобус не показані. Зверніться до класного керівника —
      можливо, дитину ще не прив'язано до вашої пошти.</div>`;
    return;
  }
  box.style.display = 'block';

  const wk = weekKey();
  if(!wk){
    box.innerHTML = `<div class="act-warn">Не вдалося визначити тиждень. Перевірте дату вгорі сторінки.</div>`;
    return;
  }

  // НІЧОГО НЕ МАЛЮЄМО, ПОКИ НЕ ПРОЧИТАЛИ.
  //
  // У розмітці вже лежать обидва питання з робочими кнопками — саме те,
  // що треба показати людині, яка ще не відповідала. Тому чіпати блок до
  // приходу даних не потрібно й шкідливо: будь-яка помилка тут лишила б
  // порожню смужку замість готового вмісту. Замінюємо його лише тоді,
  // коли справді є що показати.
  try{
    const [pSnap, wSnap] = await Promise.all([
      get(child(ref(db), `activity_plan/${cls}/${sid}`)),
      get(child(ref(db), `pool_week/${cls}/${wk}/${sid}`))
    ]);
    actPlan = pSnap.exists() ? (pSnap.val()||{}) : null;
    actWeek = wSnap.exists() ? (wSnap.val()||{}) : null;
    safeDraw(box, wk);
  }catch(e){
    // Читання не вдалося — питання лишаються на екрані, бо відповісти на
    // них людина може й так. Просто чесно попереджаємо, що збереження
    // може не пройти, і не ховаємо блок.
    console.error('[Push School] Басейн/автобус — читання:', e);
    const note = document.createElement('div');
    note.className = 'act-warn';
    note.style.marginTop = '9px';
    note.textContent = /permission[_ ]denied/i.test((e&&e.message)||'')
      ? 'Збережені раніше відповіді прочитати не вдалося: немає прав. Адміністратор має опублікувати правила бази.'
      : 'Збережені раніше відповіді прочитати не вдалося: ' + ((e&&e.message)||'невідома помилка');
    box.appendChild(note);
  }
}

// Малювання не має права залишити екран порожнім. Готуємо розмітку в
// рядку й підставляємо ЛИШЕ якщо вона справді щось містить — інакше
// краще лишити те, що вже стоїть у сторінці, ніж стерти його на порожнє.
function safeDraw(box, wk){
  try{
    const html = buildActivitiesHtml(wk);
    // Порожньо буває законно: на все відповіли, на басейн дитина не ходить.
    // Тоді ховаємо блок цілком, а не лишаємо порожню рамку.
    if(html && html.trim()){ box.innerHTML = html; box.style.display='block'; }
    else { box.innerHTML = ''; box.style.display='none'; }
  }catch(e){
    console.error('[Push School] Басейн/автобус — показ:', e);
  }
}
window.renderActivities = renderActivities;

function buildActivitiesHtml(wk){
  const poolAnswered = actPlan && typeof actPlan.pool === 'boolean';
  const busAnswered  = actPlan && typeof actPlan.bus  === 'boolean';
  const goes = goesThisWeek(actWeek ? { me:actWeek } : null, 'me');

  // ПИТАННЯ БЕЗ ПІДКАЗАНОЇ ВІДПОВІДІ. Обидві кнопки однакові на вигляд:
  // варіант, підсвічений кольором, читається як «правильний», і батько
  // тисне його не думаючи. Тут потрібна саме свідома відповідь.
  const ask = (key, title, note, a, b) => `
    <div class="pm-ask">
      <b>${title}</b>
      <span>${note}</span>
      <div class="act-choice">
        <button type="button" onclick="setActivityPlan('${key}',1)">${a}</button>
        <button type="button" onclick="setActivityPlan('${key}',0)">${b}</button>
      </div>
    </div>`;

  const poolBlock = poolAnswered ? '' : ask('pool',
    '🏊 Чи буде дитина ходити на басейн?',
    'Поки ви не відповіли, школа не знає, чи рахувати дитину.',
    'Так, буде', 'Ні, не буде');

  // ПРО АВТОБУС ПИТАЄМО ЛИШЕ ТИХ, ХТО ХОДИТЬ. Автобус возить саме на
  // басейн, тож родині, яка на басейн не ходить, це питання ні до чого —
  // і відповідь на нього нічого не означала б.
  const busBlock = (!poolAnswered || !actPlan.pool || busAnswered) ? '' : ask('bus',
    '🚌 Як дитина добиратиметься на басейн?',
    'Школа має знати, кого чекає автобус, а кого привозять батьки.',
    'Шкільним автобусом', 'Привозимо самі');

  // ВІДПОВІЛИ — ПИТАННЯ ЗНИКАЄ. Далі воно живе в налаштуваннях, як і
  // харчування: щодня бачити «дитина ходить на басейн» немає потреби,
  // а змінити відповідь треба мати змогу будь-коли.
  const opt = (key, val, on, text) =>
    `<button type="button" class="act-opt${on?' on':''}"
             onclick="setActivityPlan('${key}',${val})">${text}</button>`;
  const settings = poolAnswered ? `
    <details class="act-more">
      <summary>⚙️ Налаштування басейну й автобуса</summary>
      ${poolAnswered ? `<div class="act-set">
        <b>🏊 Басейн</b>
        <div class="act-choice">${opt('pool',1,actPlan.pool,'Ходить')}${opt('pool',0,!actPlan.pool,'Не ходить')}</div>
      </div>` : ''}
      ${(busAnswered && actPlan.pool) ? `<div class="act-set">
        <b>🚌 Дорога на басейн</b>
        <div class="act-choice">${opt('bus',1,actPlan.bus,'Шкільний автобус')}${opt('bus',0,!actPlan.bus,'Привозимо самі')}</div>
      </div>` : ''}
      <p class="act-hint">Зміни діють одразу. Школа побачить їх у своєму зведенні.</p>
    </details>` : '';

  // Тижнева відмітка з'являється лише тим, хто взагалі ходить на басейн:
  // питати «чи буде цього тижня» в того, хто не ходить, безглуздо.
  const weekBlock = (poolAnswered && actPlan.pool) ? `
    <div class="act-week ${goes?'':'off'}">
      <div class="act-week-head">🗓️ Басейн цього тижня <span>${escHtml(fullWeekLabel(wk))}</span></div>
      <div class="act-week-state">${goes
        ? 'Дитина <b>буде</b> на басейні — окремо підтверджувати не треба.'
        : 'Ви попередили, що дитини <b>не буде</b> на басейні цього тижня.'}</div>
      <button type="button" class="pm-btn ${goes?'':'back'}"
              onclick="setPoolWeek(${goes?0:1})">${goes
                ? 'Цього тижня не буде' : 'Скасувати — буде'}</button>
      <small>Питання оновлюється щопонеділка. Змінити відповідь можна в будь-який день тижня.</small>
    </div>` : '';

  const body = `${poolBlock}${busBlock}${weekBlock}${settings}`;
  // Показувати нема чого — на басейн не ходить, на все відповіли. Віддаємо
  // порожній рядок: renderActivities сховає блок, щоб не висіла смужка ні
  // з чим. Заголовок теж не потрібен, якщо всередині лише налаштування.
  if(!poolBlock && !busBlock && !weekBlock) return settings ? `${settings}` : '';
  return `<h4 class="act-title">🏊 Басейн і 🚌 автобус</h4>${body}`;
}

// Постійна відповідь. update, а не set: два питання живуть в одному вузлі,
// і відповідь на друге не має стирати перше.
window.setActivityPlan = async function(key, val){
  const { cls, sid } = await myKid();
  if(!cls || !sid) return;
  try{
    const patch = { [key]: !!val, ts: Date.now(),
                    by: (currentUserData&&currentUserData.email)||'' };
    // ВІДМОВИЛИСЯ ВІД БАСЕЙНУ — ПРИБИРАЄМО Й ВІДПОВІДЬ ПРО АВТОБУС.
    // Автобус возить саме на басейн, тож без басейну ця відповідь ні про
    // що. Якщо її лишити, дитина й далі рахувалася б у списку автобуса —
    // водій чекав би на того, хто вже не їздить.
    if(key === 'pool' && !val) patch.bus = null;
    await update(ref(db, `activity_plan/${cls}/${sid}`), patch);
    actPlan = Object.assign({}, actPlan, { [key]: !!val });
    if(key === 'pool' && !val) delete actPlan.bus;
    logAction('activity', { cls, value:`${key}: ${val?'так':'ні'}` });
    showToast(val ? '✅ Записали: так' : '✅ Записали: ні');
    safeDraw(document.getElementById('p-activities'), weekKey());
  }catch(e){
    alert('Не вдалося зберегти: ' + e.message);
  }
};

// Тижнева відмітка. «Буде» — це ВИДАЛЕННЯ запису, а не запис true:
// див. пояснення вгорі файлу, у базі живуть тільки відмови.
window.setPoolWeek = async function(going){
  const { cls, sid } = await myKid();
  if(!cls || !sid) return;
  const wk = weekKey();
  try{
    if(going){
      await set(ref(db, `pool_week/${cls}/${wk}/${sid}`), null);
      actWeek = null;
    }else{
      const rec = { going:false, ts:Date.now(),
                    by:(currentUserData&&currentUserData.email)||'' };
      await set(ref(db, `pool_week/${cls}/${wk}/${sid}`), rec);
      actWeek = rec;
    }
    logAction('activity', { cls, value:`басейн ${wk}: ${going?'буде':'не буде'}` });
    showToast(going ? '✅ Буде на басейні' : '✅ Попередили про пропуск');
    safeDraw(document.getElementById('p-activities'), wk);
  }catch(e){
    alert('Не вдалося зберегти: ' + e.message);
  }
};

// ── ЗВЕДЕННЯ ДЛЯ ШКОЛИ ──────────────────────────────────────────
//
// Директор бачить усю школу, класний керівник — лише свій клас. Розділення
// не тільки в тому, що показати: правила бази теж пускають класного
// керівника лише до свого класу, тож зайвий запит просто впаде.

// Зводимо сирі вузли в числа й списки. Чиста функція — її перевіряють тести.
// Кожна цифра має за собою СПИСОК. Раніше числа були просто числами, і
// на питання «а хто саме?» доводилося йти в базу. Тепер збираємо імена
// одразу — рахувати їх однаково доводиться, а показати можна за кліком.
export const ACT_GROUPS = {
  // Дві РІЗНІ відмови, і плутати їх не можна:
  //   noPool   — «дитина на басейн не ходить» узагалі, постійна відповідь;
  //   skipping — ходить, але саме цього тижня не буде.
  // Перше потрібне при формуванні груп, друге — тренерові в п'ятницю.
  pool:       'Ходять на басейн',
  noPool:     'Не ходять на басейн (відмовилися)',
  skipping:   'Ходять, але цього тижня не буде',
  bus:        'Їдуть автобусом на басейн',
  noBus:      'На басейн привозять батьки',
  unanswered: 'Батьки ще не відповіли'
};

export function summarize(classes, plans, weeks, names){
  const empty = () => ({ pool:[], noPool:[], bus:[], noBus:[], unanswered:[], skipping:[] });
  const out = Object.assign(empty(), { byClass:{} });
  for(const cls of classes){
    const plan = (plans||{})[cls] || {};
    const week = (weeks||{})[cls] || {};
    const roster = (names||{})[cls] || {};
    const c = empty();
    // Ідемо по СПИСКУ КЛАСУ, а не по відповідях: інакше ті, хто не
    // відповів, просто зникли б зі зведення — а це найважливіші люди.
    for(const sid in roster){
      const who = { cls, sid, name:roster[sid] };
      const p = plan[sid];
      if(!p || typeof p.pool !== 'boolean') c.unanswered.push(who);
      else if(p.pool){
        c.pool.push(who);
        if(!goesThisWeek(week, sid)) c.skipping.push(who);
      }
      else c.noPool.push(who);
      // Автобус рахуємо ЛИШЕ серед тих, хто ходить на басейн: він і возить
      // саме туди. Стара відповідь у того, хто вже не ходить, до списку
      // не потрапляє — інакше водій чекав би на зайвих.
      if(p && p.pool === true && typeof p.bus === 'boolean')
        (p.bus ? c.bus : c.noBus).push(who);
    }
    out.byClass[cls] = c;
    for(const k in ACT_GROUPS) out[k].push(...c[k]);
  }
  return out;
}

const clsNum = c => parseInt(String(c).replace('class_',''),10) || 0;

// scope: 'school' — директор, 'class' — класний керівник.
export async function renderActivitySummary(boxId, scope){
  const box = document.getElementById(boxId);
  if(!box) return;
  const wk = weekKey();
  const classes = scope === 'class'
    ? [getActiveClass()]
    : Array.from({length:11}, (_,i)=>`class_${i+1}`);
  box.innerHTML = '<p class="empty-msg">Рахую...</p>';

  const plans={}, weeks={}, names={};
  await Promise.all(classes.map(async cls=>{
    // Кожен клас окремо й тихо: у класного керівника немає прав на чужі,
    // і одна відмова не має обнуляти все зведення.
    const [p,w,n] = await Promise.all([
      get(child(ref(db),`activity_plan/${cls}`)).catch(()=>null),
      get(child(ref(db),`pool_week/${cls}/${wk}`)).catch(()=>null),
      get(child(ref(db),`students_list/${cls}`)).catch(()=>null)
    ]);
    if(p&&p.exists()) plans[cls]=p.val();
    if(w&&w.exists()) weeks[cls]=w.val();
    if(n&&n.exists()) names[cls]=n.val();
  }));

  actSummary = summarize(classes, plans, weeks, names);
  actScope = scope;
  actBoxId = boxId;
  actOpen = 'skipping';   // одразу розгорнуто найпотрібніше — хто не йде
  drawSummary();
}
window.renderActivitySummary = renderActivitySummary;

// Стан зведення тримаємо тут: перемикання групи не має ходити в базу
// вдруге — усі списки вже пораховані.
let actSummary=null, actScope='school', actBoxId='', actOpen='skipping';

// Натиснули на цифру. Та сама група вдруге — згортаємо.
window.actShowList = function(key){
  actOpen = (actOpen === key) ? '' : key;
  drawSummary();
};

function drawSummary(){
  const box = document.getElementById(actBoxId);
  if(!box || !actSummary) return;
  const s = actSummary, wk = weekKey();

  // Цифра — це кнопка. Раніше числа були мертві, і на питання «а хто саме?»
  // відповіді на екрані не було: два списки показувалися завжди, решта
  // груп не показувалася ніяк.
  const num = (key, label, warn) => `
    <button type="button" class="act-num${warn?' warn':''}${actOpen===key?' open':''}"
            onclick="actShowList('${key}')">
      <b>${s[key].length}</b><span>${label}</span></button>`;

  const items = actOpen ? (s[actOpen]||[]) : [];
  const listHtml = !actOpen ? '' : (items.length
    ? `<ul class="act-list">${items
        .slice()
        .sort((a,b)=>clsNum(a.cls)-clsNum(b.cls)||String(a.name).localeCompare(String(b.name),'uk'))
        .map(x=>`<li>${actScope==='school'
          ? `<span class="act-cls">${escHtml(String(clsNum(x.cls)))} кл</span> `:''}${escHtml(x.name)}</li>`)
        .join('')}</ul>`
    : `<p class="empty-msg">Порожньо.</p>`);

  box.innerHTML = `
    <div class="act-sum">
      ${num('pool','ходять на басейн')}
      ${num('noPool','не ходять')}
      ${num('skipping','не буде цього тижня')}
      ${num('bus','їдуть автобусом')}
      ${num('noBus','привозять батьки')}
      ${s.unanswered.length ? num('unanswered','без відповіді', true) : ''}
    </div>
    <div class="act-week-cap">Тиждень ${escHtml(fullWeekLabel(wk))} · натисніть на цифру, щоб побачити список</div>
    ${actOpen ? `<h5 class="act-h">${escHtml(ACT_GROUPS[actOpen]||'')} — ${items.length}</h5>${listHtml}` : ''}
    ${s.unanswered.length?`<p class="act-hint">Поки батьки не відповіли, дитина не потрапляє
      ні в список басейну, ні в список автобуса.</p>`:''}`;
}
