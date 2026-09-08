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
         logAction, mondayOf, localDateString } from './common.js';

export const ACT_BUILD = '2026-09-08 · басейн і автобус v1';
// Рядок у консолі — щоб на питання «а нова версія взагалі виїхала?»
// можна було відповісти за секунду, а не здогадуватися.
console.info('[Push School] activities.js —', ACT_BUILD);

// Ключ дитини в базі. Скрізь у порталі перевага в studentId — імена
// повторюються й міняються (заміжжя, зміна документів), ідентифікатор ні.
function myKid(){
  const d = currentUserData || {};
  return { cls: d.class || getActiveClass(), sid: d.studentId || d.studentName || '' };
}

// Понеділок тижня, до якого належить дата. Тиждень позначаємо саме
// понеділком: так «цей тиждень» однаково рахується і в батьків, і в
// директора, незалежно від того, коли хто відкрив портал.
export function weekKey(dateStr){
  return mondayOf(dateStr || localDateString(new Date()));
}

// Людський підпис тижня: «8–14 вересня». Дата в форматі 2026-09-08 нічого
// не каже батькові, який відкрив портал у четвер.
const MONTHS_UA = ['січня','лютого','березня','квітня','травня','червня',
                   'липня','серпня','вересня','жовтня','листопада','грудня'];
export function weekLabel(monday){
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
  const { cls, sid } = myKid();
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
  box.innerHTML = '<p class="empty-msg">Завантаження...</p>';

  const wk = weekKey();
  try{
    const [pSnap, wSnap] = await Promise.all([
      get(child(ref(db), `activity_plan/${cls}/${sid}`)),
      get(child(ref(db), `pool_week/${cls}/${wk}/${sid}`))
    ]);
    actPlan = pSnap.exists() ? (pSnap.val()||{}) : null;
    actWeek = wSnap.exists() ? (wSnap.val()||{}) : null;
  }catch(e){
    box.innerHTML = `<div class="act-warn">Не вдалося прочитати: ${escHtml(e.message)}</div>`;
    return;
  }
  drawActivities(box, wk);
}
window.renderActivities = renderActivities;

function drawActivities(box, wk){
  const poolAnswered = actPlan && typeof actPlan.pool === 'boolean';
  const busAnswered  = actPlan && typeof actPlan.bus  === 'boolean';
  const goes = goesThisWeek(actWeek ? { me:actWeek } : null, 'me');

  // Поки не відповіли — питання помітне, а не рядок у налаштуваннях:
  // саме на цьому спотикалося харчування, поки не зробили так само.
  const ask = (key, title, note, yes, no) => `
    <div class="pm-ask">
      <b>${title}</b>
      <span>${note}</span>
      <div class="pm-ask-btns">
        <button type="button" class="pm-ask-yes" onclick="setActivityPlan('${key}',1)">${yes}</button>
        <button type="button" class="pm-ask-no"  onclick="setActivityPlan('${key}',0)">${no}</button>
      </div>
      <small>Відповідь можна змінити будь-коли — тут же.</small>
    </div>`;

  // Уже відповіли — показуємо стан і одну кнопку «змінити на протилежне».
  const row = (key, icon, label, on, onText, offText, flip) => `
    <div class="act-row">
      <div class="act-state ${on?'yes':'no'}">${icon} <b>${label}</b>
        <span>${on ? onText : offText}</span></div>
      <button type="button" class="pm-btn ${on?'':'back'}"
              onclick="setActivityPlan('${key}',${on?0:1})">${flip}</button>
    </div>`;

  const poolBlock = !poolAnswered
    ? ask('pool','🏊 Дитина ходить на басейн?',
          'Поки ви не відповіли, школа не знає, чи рахувати дитину.',
          'Так, ходить','Ні, не ходить')
    : row('pool','🏊','Басейн', actPlan.pool,
          'ходить', 'не ходить',
          actPlan.pool ? 'Більше не ходить' : 'Буде ходити');

  const busBlock = !busAnswered
    ? ask('bus','🚌 Дитина їздить шкільним автобусом?',
          'Потрібно, щоб школа знала, кого чекає автобус, а кого забирають батьки.',
          'Так, шкільним автобусом','Ні, привозимо самі')
    : row('bus','🚌','Шкільний автобус', actPlan.bus,
          'їздить автобусом', 'привозять батьки',
          actPlan.bus ? 'Возитимемо самі' : 'Пересадити на автобус');

  // Тижнева відмітка з'являється лише тим, хто взагалі ходить на басейн:
  // питати «чи буде цього тижня» в того, хто не ходить, безглуздо.
  const weekBlock = (poolAnswered && actPlan.pool) ? `
    <div class="act-week ${goes?'':'off'}">
      <div class="act-week-head">🗓️ Басейн цього тижня <span>${escHtml(weekLabel(wk))}</span></div>
      <div class="act-week-state">${goes
        ? 'Дитина <b>буде</b> на басейні — окремо підтверджувати не треба.'
        : 'Ви попередили, що дитини <b>не буде</b> на басейні цього тижня.'}</div>
      <button type="button" class="pm-btn ${goes?'':'back'}"
              onclick="setPoolWeek(${goes?0:1})">${goes
                ? 'Цього тижня не буде' : 'Скасувати — буде'}</button>
      <small>Питання оновлюється щопонеділка. Змінити відповідь можна в будь-який день тижня.</small>
    </div>` : '';

  box.innerHTML = `<h4 class="act-title">🏊 Басейн і 🚌 автобус</h4>${poolBlock}${busBlock}${weekBlock}
    <div class="act-build">${escHtml(ACT_BUILD)}</div>`;
}

// Постійна відповідь. update, а не set: два питання живуть в одному вузлі,
// і відповідь на друге не має стирати перше.
window.setActivityPlan = async function(key, val){
  const { cls, sid } = myKid();
  if(!cls || !sid) return;
  try{
    await update(ref(db, `activity_plan/${cls}/${sid}`),
      { [key]: !!val, ts: Date.now(), by: (currentUserData&&currentUserData.email)||'' });
    actPlan = Object.assign({}, actPlan, { [key]: !!val });
    logAction('activity', { cls, value:`${key}: ${val?'так':'ні'}` });
    showToast(val ? '✅ Записали: так' : '✅ Записали: ні');
    drawActivities(document.getElementById('p-activities'), weekKey());
  }catch(e){
    alert('Не вдалося зберегти: ' + e.message);
  }
};

// Тижнева відмітка. «Буде» — це ВИДАЛЕННЯ запису, а не запис true:
// див. пояснення вгорі файлу, у базі живуть тільки відмови.
window.setPoolWeek = async function(going){
  const { cls, sid } = myKid();
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
    drawActivities(document.getElementById('p-activities'), wk);
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
export function summarize(classes, plans, weeks, names){
  const out = { pool:0, noPool:0, bus:0, noBus:0, unanswered:0,
                skipping:[], busList:[], byClass:{} };
  for(const cls of classes){
    const plan = (plans||{})[cls] || {};
    const week = (weeks||{})[cls] || {};
    const roster = (names||{})[cls] || {};
    const c = { pool:0, noPool:0, bus:0, noBus:0, unanswered:0, skipping:[], busList:[] };
    // Ідемо по СПИСКУ КЛАСУ, а не по відповідях: інакше ті, хто не
    // відповів, просто зникли б зі зведення — а це найважливіші люди.
    for(const sid in roster){
      const nm = roster[sid];
      const p = plan[sid];
      if(!p || typeof p.pool !== 'boolean'){ c.unanswered++; }
      else if(p.pool){
        c.pool++;
        if(!goesThisWeek(week, sid)) c.skipping.push({ cls, sid, name:nm });
      }
      else c.noPool++;
      if(p && typeof p.bus === 'boolean'){
        if(p.bus){ c.bus++; c.busList.push({ cls, sid, name:nm }); }
        else c.noBus++;
      }
    }
    out.byClass[cls] = c;
    out.pool += c.pool; out.noPool += c.noPool;
    out.bus  += c.bus;  out.noBus  += c.noBus;
    out.unanswered += c.unanswered;
    out.skipping.push(...c.skipping);
    out.busList.push(...c.busList);
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

  const s = summarize(classes, plans, weeks, names);
  const list = (items, empty) => items.length
    ? `<ul class="act-list">${items
        .sort((a,b)=>clsNum(a.cls)-clsNum(b.cls)||String(a.name).localeCompare(String(b.name)))
        .map(x=>`<li>${scope==='school'
          ? `<span class="act-cls">${escHtml(String(clsNum(x.cls)))} кл</span> `:''}${escHtml(x.name)}</li>`)
        .join('')}</ul>`
    : `<p class="empty-msg">${empty}</p>`;

  box.innerHTML = `
    <div class="act-sum">
      <div class="act-num"><b>${s.pool}</b><span>ходять на басейн</span></div>
      <div class="act-num"><b>${s.skipping.length}</b><span>не буде цього тижня</span></div>
      <div class="act-num"><b>${s.bus}</b><span>їздять автобусом</span></div>
      ${s.unanswered?`<div class="act-num warn"><b>${s.unanswered}</b><span>без відповіді</span></div>`:''}
    </div>
    <div class="act-week-cap">Тиждень ${escHtml(weekLabel(wk))}</div>
    <h5 class="act-h">🏊 Не буде на басейні цього тижня</h5>
    ${list(s.skipping,'Усі, хто ходить, будуть на басейні.')}
    <h5 class="act-h">🚌 Їздять шкільним автобусом</h5>
    ${list(s.busList,'Автобусом ніхто не їздить.')}
    ${s.unanswered?`<p class="act-hint">${s.unanswered} батьків ще не відповіли —
      поки відповіді немає, дитина не потрапляє в жоден зі списків.</p>`:''}`;
}
window.renderActivitySummary = renderActivitySummary;
