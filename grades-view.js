// ═══════════════════════════════════════════════════════════════
// grades-view.js — оцінки в кабінеті родини: тиждень і предмет.
//
// НАВІЩО. Оцінки показувалися лише за ОДИН обраний день. Щоб побачити
// тиждень, батько мусив сім разів клацнути дату, і жодного разу не бачив
// картини цілком: чи це одна невдала контрольна, чи так увесь місяць.
// Домашні завдання цю проблему вже пройшли — там є тижневий показ
// (homework.js), і зроблено це тут так само, щоб дві вкладки поводилися
// однаково.
//
// ── ДВА ПОГЛЯДИ НА ТІ САМІ ДАНІ ────────────────────────────────
//
// ЗА ТИЖДЕНЬ — «що сталося останнім часом»: по днях, разом із
// коментарями вчителя, реакціями й кнопкою «Покращити».
// ЗА ПРЕДМЕТОМ — «як справи з математикою взагалі»: усі оцінки за рік
// і середній бал.
//
// ── ПРО СЕРЕДНІЙ БАЛ ───────────────────────────────────────────
//
// Рахується НАЯВНОЮ формулою порталу — Σ(оцінка × коефіцієнт) /
// Σ(коефіцієнт), тією самою, яку вже показує довідка над списком
// (renderGradeFormulaInfo) і якою користується вчитель. Своєї
// арифметики тут немає свідомо: два різні способи порахувати середнє
// дали б батькові й учителю різні числа, і суперечку, у якої немає
// правильної сторони.
//
// І окремо, великими літерами в інтерфейсі: середній бал — НЕ підсумкова
// оцінка й не прогноз. У порталі є тверде правило не показувати родині
// розрахунків, яких учитель не підтвердив (див. renderFinalGrades), і
// підпис під числом існує саме для того, щоб це правило не обійшли
// мовчки.
//
// ── ЗВІДКИ ДАНІ ────────────────────────────────────────────────
//
//   student_grades/{клас}/{учень}/{місяць}/{предмет}/{дата} = {v, t}
//     — дзеркало СВОЄЇ дитини: клас цілком родині читати не можна.
//     v — оцінка, t — тип роботи (від нього залежить коефіцієнт).
//   comments/{клас}/{дата}/{предмет}/{учень}
//   reactions/{клас}/{дата}/{предмет}/{учень}
//
// Вузол дзеркала читаємо ЦІЛКОМ, за рік: це дані однієї дитини, вони
// маленькі, і з них одразу виходять обидва погляди. Паралельні читання
// об'єднуємо, але після відкриття вкладки читаємо знову: оцінка могла
// змінитися на іншому пристрої, поки кабінет був відкритий.
// ═══════════════════════════════════════════════════════════════
import { renderWorkPhotos } from './grade-work.js';
import { ref, get, child, query, orderByKey, startAt, endAt }
  from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, currentUserData, getActiveClass, escHtml, escJs, mondayOf,
         localDateString, displayGrade, gradeClass6, levelNum, getGradeWeight,
         calculateStudentWeightedAvg, renderGradeFormulaInfo, dayNamesUA, dayKeys, journalBaseDate, journalSlot, stuId }
  from './common.js';

// Кабінети батьків і учня лежать у розмітці ОДНОЧАСНО, тож «взяти той
// елемент, що існує» тут не працює — питаємо роль (як у games.js).
const isPupil = () => currentUserData?.role === 'student';
// Профіль може ще містити старий studentId після повторного заведення учня.
// Довідник класу (завантажений до відкриття кабінету) — джерело чинного ключа.
const mySid   = cls => stuId(cls,currentUserData?.studentName)
  || currentUserData?.studentId || currentUserData?.studentName || '';
const boxWeek = () => isPupil() ? 's-grades-week' : 'p-grades-week';
const boxSubj = () => isPupil() ? 's-grades-subject' : 'p-grades-subject';

let gvWeek = null;        // понеділок показаного тижня
let gvSubject = '';       // обраний предмет
let gvScales = null;
let gvGeneration=0, gvWeekRequest=0, gvSubjectRequest=0;
let gvMirrorPending=null;

// Два блоки на екрані стартують одночасно: ділимо лише запит, який ще йде.
// Наступне відкриття вкладки перечитує базу, щоб нові/видалені оцінки
// іншого пристрою не залишалися в старому кеші до виходу з кабінету.
function readGradesMirror(cls,sid){
  const key=`${cls}/${sid}`;
  if(gvMirrorPending?.key===key)return gvMirrorPending.promise;
  const pending={key,promise:null};
  pending.promise=get(child(ref(db),`student_grades/${cls}/${sid}`))
    .then(snap=>snap.exists()?(snap.val()||{}):{})
    .finally(()=>{if(gvMirrorPending===pending)gvMirrorPending=null;});
  gvMirrorPending=pending;
  return pending.promise;
}
function stillViewing(cls,sid,role,generation,request,kind){
  return generation===gvGeneration
    &&request===(kind==='week'?gvWeekRequest:gvSubjectRequest)
    &&getActiveClass()===cls&&mySid(cls)===sid&&currentUserData?.role===role;
}

// ── ЧИСТА ЧАСТИНА ───────────────────────────────────────────────
// Усе нижче — без бази й без DOM, щоб перевірялося тестами.

// Дзеркало: {місяць: {предмет: {дата: {v,t}}}} → пласкі записи.
export function flatGrades(mirror){
  const out = [];
  for(const ym in (mirror || {})){
    for(const subj in (mirror[ym] || {})){
      for(const date in (mirror[ym][subj] || {})){
        const cell = mirror[ym][subj][date] || {};
        // Порожня клітинка лишається в дзеркалі після видалення оцінки.
        // Якщо її не відсіяти, у тижні з'являться рядки-привиди: предмет
        // є, оцінки немає.
        if(cell.v === undefined || cell.v === null || cell.v === '') continue;
        out.push({ date, day:journalBaseDate(date), slot:journalSlot(date),
          subj, v: cell.v, t: cell.t || '', workPhotos:cell.workPhotos||[] });
      }
    }
  }
  return out;
}

// Оцінки за тиждень, згруповані по днях. Дні подаються списком, щоб
// функція не знала нічого про календар і вихідні.
export function gradesByDay(mirror, days){
  const want = new Set(days || []);
  const byDay = {};
  flatGrades(mirror).forEach(g => {
    if(!want.has(g.day)) return;
    (byDay[g.day] ||= []).push(g);
  });
  for(const d in byDay) byDay[d].sort((a,b) => a.subj.localeCompare(b.subj,'uk'));
  return byDay;
}

// Перелік предметів, де взагалі є оцінки. Порожній селектор кращий за
// селектор із предметами, у яких нічого немає.
export function subjectsWithGrades(mirror){
  return [...new Set(flatGrades(mirror).map(g => g.subj))].sort((a,b)=>a.localeCompare(b,'uk'));
}

// Усі оцінки з предмета + середній бал.
//
// Середнє рахує calculateStudentWeightedAvg із common.js — та сама
// функція, якою користується вчитель. Їй потрібні дві мапи «ключ →
// значення», тож складаємо їх із дат.
export function subjectStats(mirror, subj){
  const rows = flatGrades(mirror).filter(g => g.subj === subj)
                 .sort((a,b) => a.date.localeCompare(b.date));
  const vals = {}, types = {};
  rows.forEach(r => { vals[r.date] = r.v; types[r.date] = r.t || 'П'; });
  const avg = calculateStudentWeightedAvg(vals, types);
  // Скільки оцінок реально лягло в розрахунок: літера без числового
  // відповідника (щось нестандартне) у середнє не потрапляє, і мовчати
  // про це не можна — інакше «3 оцінки, середній 5.0» виглядає як помилка.
  const counted = rows.filter(r => levelNum(r.v) !== null).length;
  return { rows, avg, counted };
}

// ── ПОКАЗ ───────────────────────────────────────────────────────

const p2 = n => String(n).padStart(2,'0');
function weekDays(monday){
  const [y,m,d] = String(monday).split('-').map(Number);
  const dt = new Date(y, m-1, d), out = [];
  // Пн–Пт: у вихідні уроків немає, а порожні заголовки лише розтягують екран.
  for(let i=0;i<5;i++){
    out.push(`${dt.getFullYear()}-${p2(dt.getMonth()+1)}-${p2(dt.getDate())}`);
    dt.setDate(dt.getDate()+1);
  }
  return out;
}
const human = ds => { const [,m,d] = ds.split('-'); return `${d}.${m}`; };
// dayNamesUA — мапа за англійською назвою, а не масив за номером: індекс
// із getDay() треба спершу перекласти через dayKeys. Так само це робить
// homework.js — другого способу в проєкті бути не повинно.
const dayName = ds => {
  const [y,m,d] = ds.split('-').map(Number);
  return dayNamesUA[dayKeys[new Date(y, m-1, d).getDay()]] || '';
};

// Своє значення з вузла «{учень: значення}»: запис міг лягти і під
// ідентифікатором, і під імʼям — так само, як у решті кабінету.
function mineOf(map,sid,name,profileSid){
  if(!map) return undefined;
  if(sid && map[sid] !== undefined) return map[sid];
  if(profileSid && map[profileSid] !== undefined) return map[profileSid];
  return (name && map[name] !== undefined) ? map[name] : undefined;
}

function gradeChip(v, t, cls, numericScale){
  return `<span class="g-cell ${numericScale?'g-scale':gradeClass6(v)}" style="display:inline-flex;padding:4px 9px;border-radius:8px;gap:5px;">`
    + `<span class="g-val">${escHtml(displayGrade(v, cls, numericScale))}</span>`
    + (t ? `<span class="g-type">${escHtml(t)}</span>` : '') + `</span>`;
}

// Кнопка перездачі — лише там, де вона доречна: оцінка низька й це
// цифра. Для літер (1–4 класи) перездача не пропонується: у рівнях її
// сенс інший, і вчителі про неї не просили.
function retakeBtn(cls, subj, date, v, numericScale){
  if(numericScale&&numericScale!==6)return '';
  const n = parseInt(v, 10);
  if(isNaN(n) || n > 3) return '';
  const who = currentUserData?.studentId || currentUserData?.studentName || '';
  return `<button class="retake-btn" style="margin-left:6px;"
     onclick="sendRetakeRequest('${escJs(cls)}','${escJs(subj)}','${escJs(date)}','${escJs(who)}',${n})">🔄 Покращити</button>`;
}

function reactionRow(date, subj, mine){
  const btn = (em) => `<button style="background:none;border:none;font-size:1.2rem;cursor:pointer;`
    + `filter:${mine===em?'none':'grayscale(100%)'};opacity:${mine===em?'1':'.5'};padding:3px;width:auto;margin:0;"`
    + ` onclick="sendReaction('${escJs(date)}','${escJs(subj)}','${em}')">${em}</button>`;
  return `<div style="display:flex;gap:6px;margin-top:6px;padding-top:6px;border-top:1px dashed #eee;align-items:center;">`
    + btn('👍') + btn('❤️') + btn('🔥') + `</div>`;
}

export async function renderGradesWeek(weekStart){
  const box = document.getElementById(boxWeek());
  if(!box) return;
  const cls = getActiveClass();
  const sid = mySid(cls), name=currentUserData?.studentName, profileSid=currentUserData?.studentId, role=currentUserData?.role;
  const generation=gvGeneration, request=++gvWeekRequest;
  if(!cls || !sid){ box.innerHTML = '<p class="empty-msg">Дитину не визначено.</p>'; return; }

  gvWeek = weekStart || gvWeek || mondayOf(localDateString);
  const week=gvWeek, days = weekDays(week);
  box.innerHTML = '<p class="empty-msg">Завантаження...</p>';

  let comments = {}, reactions = {}, mirror={}, commentsError=null;
  try{
    const [mirSnap, cmSnap, rxSnap, scaleSnap] = await Promise.all([
      readGradesMirror(cls,sid),
      get(query(child(ref(db),`comments/${cls}`), orderByKey(), startAt(days[0]), endAt(days[4]))).catch(e=>{commentsError=e;return null;}),
      get(query(child(ref(db),`reactions/${cls}`), orderByKey(), startAt(days[0]), endAt(days[4]))).catch(()=>null),
      gvScales?Promise.resolve(null):get(child(ref(db),`grade_scales/${cls}`)).catch(()=>null)
    ]);
    if(!stillViewing(cls,sid,role,generation,request,'week'))return;
    mirror=mirSnap;
    if(scaleSnap)gvScales=scaleSnap.exists()?scaleSnap.val():{};
    comments  = (cmSnap && cmSnap.exists()) ? (cmSnap.val() || {}) : {};
    reactions = (rxSnap && rxSnap.exists()) ? (rxSnap.val() || {}) : {};
  }catch(e){
    if(!stillViewing(cls,sid,role,generation,request,'week'))return;
    // Мовчазний спінер — головна повторювана вада порталу.
    box.innerHTML = `<p class="empty-msg" style="color:var(--red);">Не вдалося завантажити оцінки: ${escHtml(e.message||'')}</p>`;
    return;
  }

  const byDay = gradesByDay(mirror, days);
  const total = days.reduce((n,d) => n + (byDay[d] ? byDay[d].length : 0), 0);

  const nav = `<div class="hw-nav">
      <button type="button" onclick="gvShiftWeek(-1)">←</button>
      <div class="hw-nav-mid"><b>${escHtml(human(days[0]))} – ${escHtml(human(days[4]))}</b>
        <span>${total ? `оцінок: ${total}` : 'оцінок немає'}</span></div>
      <button type="button" onclick="gvShiftWeek(1)">→</button>
    </div>
    <button type="button" class="hw-today" onclick="renderGradesWeek();renderGradesSubject()">↻ Оновити оцінки й коментарі</button>
    ${week !== mondayOf(localDateString)
      ? `<button type="button" class="hw-today" onclick="gvShiftWeek(0)">Повернутися до поточного тижня</button>` : ''}`;

  const blocks = days.map(ds => {
    const items = byDay[ds] || [];
    const cmDay = comments[ds] || {};
    // Предмети дня: ті, де є оцінка, плюс ті, де є лише коментар —
    // коментар без оцінки теж адресований батькам.
    const subjs = [...new Set([...items.map(i=>i.subj),
      ...Object.keys(cmDay).filter(s => mineOf(cmDay[s],sid,name,profileSid))])].sort((a,b)=>a.localeCompare(b,'uk'));
    if(!subjs.length) return '';
    const rows = subjs.map(s => {
      const grades=items.filter(i => i.subj === s);
      const cm = mineOf(cmDay[s],sid,name,profileSid) || '';
      const rx = mineOf((reactions[ds]||{})[s],sid,name,profileSid) || null;
      return `<li style="margin-bottom:9px;"><b>${escHtml(s)}</b><br>`
        + grades.map(g=>gradeChip(g.v,g.t,cls,gvScales?.[s]?.max)
          +retakeBtn(cls,s,g.date,g.v,gvScales?.[s]?.max)+renderWorkPhotos(g.workPhotos)).join(' ')
        + (cm ? `<div style="background:#f0f8ff;padding:5px 9px;border-radius:6px;font-style:italic;font-size:.88rem;margin-top:4px;">${escHtml(cm)}</div>`
                + reactionRow(ds, s, rx) : '')
        + `</li>`;
    }).join('');
    return `<div class="gv-day"><div class="gv-day-head">${escHtml(dayName(ds))}, ${escHtml(human(ds))}</div>
      <ul class="list-dash" style="margin:0;">${rows}</ul></div>`;
  }).join('');

  const commentWarning=commentsError
    ? '<p class="empty-msg" style="color:var(--red);">Не вдалося завантажити коментарі. <button type="button" onclick="renderGradesWeek()">Повторити</button></p>' : '';
  box.innerHTML = nav + commentWarning + (blocks || (commentsError
    ? '<p class="empty-msg">Оцінок цього тижня немає.</p>'
    : '<p class="empty-msg">Цього тижня оцінок і коментарів немає.</p>'));
}
window.renderGradesWeek = renderGradesWeek;

window.gvShiftWeek = function(delta){
  const base = delta === 0 ? mondayOf(localDateString) : (gvWeek || mondayOf(localDateString));
  if(delta === 0) { gvWeek = base; }
  else {
    const [y,m,d] = base.split('-').map(Number);
    const dt = new Date(y, m-1, d); dt.setDate(dt.getDate() + delta*7);
    gvWeek = `${dt.getFullYear()}-${p2(dt.getMonth()+1)}-${p2(dt.getDate())}`;
  }
  renderGradesWeek(gvWeek);
};

// ── ЗА ПРЕДМЕТОМ ────────────────────────────────────────────────
export async function renderGradesSubject(subj){
  const box = document.getElementById(boxSubj());
  if(!box) return;
  const cls = getActiveClass();
  const sid = mySid(cls), role=currentUserData?.role;
  const generation=gvGeneration, request=++gvSubjectRequest;
  if(!cls || !sid){ box.innerHTML = '<p class="empty-msg">Дитину не визначено.</p>'; return; }

  box.innerHTML = '<p class="empty-msg">Завантаження...</p>';
  let mirror;
  try{mirror=await readGradesMirror(cls,sid);}
  catch(e){
    if(stillViewing(cls,sid,role,generation,request,'subject'))
      box.innerHTML = `<p class="empty-msg" style="color:var(--red);">Не вдалося завантажити: ${escHtml(e.message||'')}</p>`;
    return;
  }
  if(!stillViewing(cls,sid,role,generation,request,'subject'))return;
  let scales=gvScales;
  if(!scales){
    try{const snap=await get(child(ref(db),`grade_scales/${cls}`));scales=snap.exists()?snap.val():{};}
    catch(e){scales={};}
  }
  if(!stillViewing(cls,sid,role,generation,request,'subject'))return;
  gvScales=scales;

  const subjects = subjectsWithGrades(mirror);
  if(!subjects.length){ box.innerHTML = '<p class="empty-msg">Оцінок ще немає.</p>'; return; }
  gvSubject = subj || gvSubject || subjects[0];
  if(!subjects.includes(gvSubject)) gvSubject = subjects[0];

  const sel = `<select id="gv-subject-select" onchange="renderGradesSubject(this.value)" style="margin:0 0 11px 0;">`
    + subjects.map(s => `<option value="${escHtml(s)}"${s===gvSubject?' selected':''}>${escHtml(s)}</option>`).join('')
    + `</select>`;

  const { rows, avg, counted } = subjectStats(mirror, gvSubject);
  const scaleMax=scales?.[gvSubject]?.max||null;
  const avgTxt = avg === null ? '—' : avg.toFixed(2);
  // Підпис під числом обовʼязковий. Батьки читають будь-яке середнє як
  // «яка буде оцінка в табелі», а підсумкову ставить учитель — і має
  // право поставити інше.
  const head = `<div style="background:#fff;border:1px solid #d1c4e9;border-radius:12px;padding:12px;margin-bottom:11px;text-align:center;">
      <div style="font-size:1.9rem;font-weight:800;color:var(--purple,#7b1fa2);line-height:1.1;">${escHtml(avgTxt)}</div>
      <div style="font-size:.78rem;color:#555;margin-top:3px;">середній бал з предмета «${escHtml(gvSubject)}»
        · оцінок: ${counted} · шкала: 1–${scaleMax||6}</div>
      <div style="font-size:.72rem;color:#888;margin-top:5px;">Це не підсумкова оцінка й не прогноз:
        підсумкову виставляє вчитель.</div>
    </div>`;

  const list = rows.length
    ? `<ul class="list-dash" style="margin:0;">` + rows.slice().reverse().map(r =>
        `<li style="display:flex;align-items:center;gap:9px;padding:5px 0;flex-wrap:wrap;">
           <span style="color:#888;font-size:.82rem;min-width:52px;">${escHtml(human(r.day))}${r.slot>1?` · ${r.slot}`:''}</span>
           ${gradeChip(r.v, r.t, cls, scaleMax)}${renderWorkPhotos(r.workPhotos)}
           <span style="font-size:.74rem;color:#999;">${r.t ? `вага ×${escHtml(String(getGradeWeight(r.t)))}` : ''}</span>
         </li>`).join('') + `</ul>`
    : '<p class="empty-msg">З цього предмета оцінок ще немає.</p>';

  box.innerHTML = sel + head + `<ul class="list-dash" style="margin:0 0 9px 0;">${renderGradeFormulaInfo()}</ul>` + list;
}
window.renderGradesSubject = renderGradesSubject;

// Завершення старих запитів після перемикання дитини не має перемалювати
// екран нової дитини, навіть якщо відповідь із бази прийшла пізніше.
export function resetGradesCache(){
  gvGeneration++;gvWeekRequest++;gvSubjectRequest++;
  gvMirrorPending=null;gvSubject='';gvScales=null;gvWeek=null;
}
window.resetGradesCache = resetGradesCache;
