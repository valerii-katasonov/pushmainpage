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
import { ref, get, child, query, orderByKey, startAt, endAt, onValue }
  from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, currentUserData, getActiveClass, escHtml, escJs, mondayOf,
         localDateString, displayGrade, gradeClass6, levelNum, getGradeWeight,
         calculateStudentWeightedAvg, renderGradeFormulaInfo, dayNamesUA, dayKeys, journalBaseDate, journalSlot,
         stuId, hasStudentDir, getStudentDir }
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

// ═══════════════════════════════════════════════════════════════
//  ЧОМУ ТУТ ПІДПИСКА, А НЕ ЧИТАННЯ
//
// Спершу оцінки читалися один раз — get() на вході в кабінет. Потім, щоб
// бачити щойно виставлену оцінку, читання додали ще й на кожне відкриття
// вкладки. Обидва рази блок лишався порожнім, і обидва рази з тієї самої
// причини: get() при старті сторінки встигає відповісти ПОРОЖНЬО, поки
// зʼєднання з базою ще піднімається. Відповідь формально успішна —
// помилки немає, показувати нічого. А другого разу читати нікому, бо
// перший «вдався». Батько бачив «Цього тижня оцінок і коментарів немає»
// над днем, у якому вчитель залишив коментар.
//
// Лікувати це повторами означало гадати, скільки чекати. Тому замість
// разового питання — постійна підписка: база сама надсилає дані, коли
// вони є, і надсилає ще раз, коли вчитель щось змінив. Звідси три
// наслідки, заради яких усе й переписано:
//   • при вході блок заповнюється сам, щойно дані доїхали;
//   • повернення на вкладку нічого не перечитує — дані вже тут, малюємо
//     миттєво, без спінера й без походу в мережу;
//   • нова оцінка зʼявляється у відкритому кабінеті сама, без кнопки.
// Кнопку «Оновити» прибрано: оновлювати вручну більше нічого.
//
// ПІДПИСКИ ТРЕБА ЗНІМАТИ. Їх три, і живуть вони, доки людина в кабінеті.
// При перемиканні дитини їх перевстановлює resetGradesCache, при виході —
// stopGradesListeners через загальний реєстр stopAllListeners у common.js.
// Без цього після виходу база сипле permission_denied у консоль.
// ═══════════════════════════════════════════════════════════════
let gvWeek = null;        // понеділок показаного тижня
let gvSubject = '';       // обраний предмет

// Дані, які приносять підписки. null означає «ще не приходило» — це не те
// саме, що порожньо, і плутати їх не можна: саме на цій різниці й
// трималася помилка з порожнім блоком.
let gvMirror=null, gvComments=null, gvReactions=null, gvScales=null;
let gvError='';
// Хто зараз у кабінеті — потрібно для пошуку своїх записів у спільних вузлах
let gvCls='', gvSid='', gvName='', gvProfileSid='';
// Остання намальована розмітка: при зміні тижня показуємо її, поки їдуть
// нові дані, замість того щоб гасити екран.
let gvLastWeekHtml='', gvLastSubjHtml='';

let offMirror=null, offComments=null, offReactions=null, offScales=null;
let subKeyMirror='', subKeyWeek='', subKeyScales='';

function drop(fn){ if(fn){ try{ fn(); }catch(e){} } return null; }

export function stopGradesListeners(){
  offMirror=drop(offMirror); offComments=drop(offComments);
  offReactions=drop(offReactions); offScales=drop(offScales);
  subKeyMirror=subKeyWeek=subKeyScales='';
  gvMirror=gvComments=gvReactions=gvScales=null;
}
window.stopGradesListeners = stopGradesListeners;

function subscribeMirror(cls,sid){
  const key=`${cls}/${sid}`;
  if(subKeyMirror===key && offMirror) return;
  offMirror=drop(offMirror); subKeyMirror=key; gvMirror=null;
  offMirror=onValue(ref(db,`student_grades/${cls}/${sid}`),
    snap=>{ gvMirror=snap.exists()?(snap.val()||{}):{}; gvError=''; paintWeek(); paintSubject(); },
    err=>{ gvError=err&&err.message||'база відмовила'; paintWeek(); paintSubject(); });
}

function subscribeWeek(cls,days){
  const key=`${cls}|${days[0]}`;
  if(subKeyWeek===key && offComments) return;
  offComments=drop(offComments); offReactions=drop(offReactions);
  subKeyWeek=key; gvComments=null; gvReactions=null;
  const rangeOf = node => query(child(ref(db),`${node}/${cls}`), orderByKey(), startAt(days[0]), endAt(days[4]));
  // Коментарі й реакції лежать у вузлах класу, тож беремо лише пʼять
  // ключів показаного тижня, а не весь рік.
  offComments=onValue(rangeOf('comments'),
    snap=>{ gvComments=snap.exists()?(snap.val()||{}):{}; paintWeek(); },
    ()=>{ gvComments={}; paintWeek(); });
  offReactions=onValue(rangeOf('reactions'),
    snap=>{ gvReactions=snap.exists()?(snap.val()||{}):{}; paintWeek(); },
    ()=>{ gvReactions={}; paintWeek(); });
}

function subscribeScales(cls){
  if(subKeyScales===cls && offScales) return;
  offScales=drop(offScales); subKeyScales=cls; gvScales=null;
  offScales=onValue(ref(db,`grade_scales/${cls}`),
    snap=>{ gvScales=snap.exists()?(snap.val()||{}):{}; paintWeek(); paintSubject(); },
    ()=>{ gvScales={}; paintWeek(); paintSubject(); });
}

// ПРОФІЛЬ ГОТОВИЙ НЕ ОДРАЗУ. При вході кабінет малює все підряд, а клас і
// ключ дитини в цю мить ще дочитуються. Підписуватися нема на що — тому
// чекаємо на дитину й пробуємо знову. Недовго: якщо її справді немає,
// чесне «не визначено» краще за вічний спінер.
let gvRetry=null;
const RETRY_LIMIT=14;

// ЧОМУ МАЛО ЗНАТИ КЛАС І ДИТИНУ.
//
// Коментарі й реакції лежать у вузлах класу під КЛЮЧЕМ учня зі списку
// класу (-P-K75Gb…), а не під іменем. Цей ключ дає stuId() — із довідника
// класу, який кабінет дочитує окремо й пізніше, ніж малює екран.
//
// Поки довідника немає, stuId() повертає null, і mySid() відкочується на
// ідентифікатор із профілю або взагалі на імʼя. Дані при цьому приходять
// правильні — просто свій рядок у них шукається під чужим ключем, і
// батько бачить «Цього тижня оцінок і коментарів немає» над днем, у
// якому вчитель залишив коментар. Саме це й було видно при перезавантаженні
// сторінки на вкладці «Оцінки»: заходиш на вкладку — все на місці (довідник
// уже дочитано), перезавантажуєш — порожньо.
//
// Тому не малюємо, доки довідник не приїхав. getStudentDir() або віддасть
// уже прочитане, або дочитає — і тоді малюємо один раз, з правильним ключем.
function waitForDir(cls, attempt, again){
  if(hasStudentDir(cls)) return true;
  if(attempt>=RETRY_LIMIT) return true;   // довше не чекаємо: краще показати з тим, що є
  getStudentDir(cls).then(()=>again(attempt+1)).catch(()=>{ planRetry(attempt, again); });
  return false;
}

function planRetry(attempt, run){
  if(attempt>=RETRY_LIMIT) return false;
  clearTimeout(gvRetry);
  gvRetry=setTimeout(()=>run(attempt+1), attempt<4?250:600);
  return true;
}
function stopRetry(){ clearTimeout(gvRetry); gvRetry=null; }

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
  sid=sid??gvSid; name=name??gvName; profileSid=profileSid??gvProfileSid;
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

// Вхідна точка: прив'язати підписки до поточної дитини й намалювати те,
// що вже прийшло. Викликається дашбордом, перемиканням вкладки та
// стрілками тижнів — усі три випадки тепер дешеві, бо мережі тут немає.
export function renderGradesWeek(weekStart, attempt=0){
  const box = document.getElementById(boxWeek());
  if(!box) return;
  const cls = getActiveClass();
  const sid = cls ? mySid(cls) : '';
  if(!cls || !sid){
    if(planRetry(attempt, n=>renderGradesWeek(weekStart,n))){
      if(!(box.innerHTML||'').trim()) box.innerHTML='<p class="empty-msg">Завантаження...</p>';
      return;
    }
    box.innerHTML = '<p class="empty-msg">Дитину не визначено.</p>'; return;
  }
  if(!waitForDir(cls, attempt, n=>renderGradesWeek(weekStart,n))){
    if(!(box.innerHTML||'').trim()) box.innerHTML='<p class="empty-msg">Завантаження...</p>';
    return;
  }
  stopRetry();
  gvCls=cls; gvSid=mySid(cls); gvName=currentUserData?.studentName||'';
  gvProfileSid=currentUserData?.studentId||'';
  gvWeek = weekStart || gvWeek || mondayOf(localDateString);
  subscribeScales(cls);
  subscribeMirror(cls,gvSid);
  subscribeWeek(cls,weekDays(gvWeek));
  paintWeek();
}

function paintWeek(){
  const box = document.getElementById(boxWeek());
  if(!box || !gvWeek || !gvCls) return;
  if(gvError){
    box.innerHTML = `<p class="empty-msg" style="color:var(--red);">Не вдалося завантажити оцінки: ${escHtml(gvError)}</p>`;
    return;
  }
  // Ще не все приїхало. Малювати половину не можна: батько побачить
  // «коментарів немає» там, де вони просто ще в дорозі.
  if(gvMirror===null || gvComments===null || gvReactions===null){
    box.innerHTML = gvLastWeekHtml || '<p class="empty-msg">Завантаження...</p>';
    return;
  }
  const days = weekDays(gvWeek), cls = gvCls;
  const byDay = gradesByDay(gvMirror, days);
  const total = days.reduce((n,d) => n + (byDay[d] ? byDay[d].length : 0), 0);

  const nav = `<div class="hw-nav">
      <button type="button" onclick="gvShiftWeek(-1)">←</button>
      <div class="hw-nav-mid"><b>${escHtml(human(days[0]))} – ${escHtml(human(days[4]))}</b>
        <span>${total ? `оцінок: ${total}` : 'оцінок немає'}</span></div>
      <button type="button" onclick="gvShiftWeek(1)">→</button>
    </div>
    ${gvWeek !== mondayOf(localDateString)
      ? `<button type="button" class="hw-today" onclick="gvShiftWeek(0)">Повернутися до поточного тижня</button>` : ''}`;

  const blocks = days.map(ds => {
    const items = byDay[ds] || [];
    const cmDay = (gvComments||{})[ds] || {};
    // Предмети дня: ті, де є оцінка, плюс ті, де є лише коментар —
    // коментар без оцінки теж адресований батькам.
    const subjs = [...new Set([...items.map(i=>i.subj),
      ...Object.keys(cmDay).filter(s => mineOf(cmDay[s]))])].sort((a,b)=>a.localeCompare(b,'uk'));
    if(!subjs.length) return '';
    const rows = subjs.map(s => {
      const grades=items.filter(i => i.subj === s);
      const cm = mineOf(cmDay[s]) || '';
      const rx = mineOf(((gvReactions||{})[ds]||{})[s]) || null;
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

  gvLastWeekHtml = nav + (blocks || '<p class="empty-msg">Цього тижня оцінок і коментарів немає.</p>');
  box.innerHTML = gvLastWeekHtml;
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
export function renderGradesSubject(subj, attempt=0){
  const box = document.getElementById(boxSubj());
  if(!box) return;
  const cls = getActiveClass();
  const sid = cls ? mySid(cls) : '';
  if(!cls || !sid){
    if(planRetry(attempt, n=>renderGradesSubject(subj,n))){
      if(!(box.innerHTML||'').trim()) box.innerHTML='<p class="empty-msg">Завантаження...</p>';
      return;
    }
    box.innerHTML = '<p class="empty-msg">Дитину не визначено.</p>'; return;
  }
  if(!waitForDir(cls, attempt, n=>renderGradesSubject(subj,n))){
    if(!(box.innerHTML||'').trim()) box.innerHTML='<p class="empty-msg">Завантаження...</p>';
    return;
  }
  stopRetry();
  gvCls=cls; gvSid=mySid(cls); gvName=currentUserData?.studentName||'';
  gvProfileSid=currentUserData?.studentId||'';
  if(subj) gvSubject = subj;
  subscribeScales(cls);
  subscribeMirror(cls,gvSid);
  paintSubject();
}

function paintSubject(){
  const box = document.getElementById(boxSubj());
  if(!box || !gvCls) return;
  if(gvError){
    box.innerHTML = `<p class="empty-msg" style="color:var(--red);">Не вдалося завантажити: ${escHtml(gvError)}</p>`;
    return;
  }
  if(gvMirror===null){
    box.innerHTML = gvLastSubjHtml || '<p class="empty-msg">Завантаження...</p>';
    return;
  }
  const cls = gvCls, scales = gvScales || {};
  const subjects = subjectsWithGrades(gvMirror);
  if(!subjects.length){ gvLastSubjHtml=''; box.innerHTML = '<p class="empty-msg">Оцінок ще немає.</p>'; return; }
  gvSubject = gvSubject || subjects[0];
  if(!subjects.includes(gvSubject)) gvSubject = subjects[0];

  const sel = `<select onchange="renderGradesSubject(this.value)" style="width:100%;margin-bottom:9px;">`
    + subjects.map(s => `<option value="${escHtml(s)}"${s===gvSubject?' selected':''}>${escHtml(s)}</option>`).join('')
    + `</select>`;

  const { rows, avg, counted } = subjectStats(gvMirror, gvSubject);
  const scaleMax=scales?.[gvSubject]?.max||null;
  const avgTxt = avg === null ? '—' : avg.toFixed(2);
  // Підпис під числом обовʼязковий. Батьки читають будь-яке середнє як
  // «яка буде оцінка в табелі», а підсумкову ставить учитель — і має
  // ставити її сам, а не підтверджувати пораховане порталом.
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

  gvLastSubjHtml = sel + head + `<ul class="list-dash" style="margin:0 0 9px 0;">${renderGradeFormulaInfo()}</ul>` + list;
  box.innerHTML = gvLastSubjHtml;
}
window.renderGradesSubject = renderGradesSubject;

// Завершення старих запитів після перемикання дитини не має перемалювати
// екран нової дитини, навіть якщо відповідь із бази прийшла пізніше.
// Перемкнули дитину — підписки вели до попередньої. Знімаємо всі, чистимо
// показане й малюємо заново вже під нову.
export function resetGradesCache(){
  stopRetry();
  stopGradesListeners();
  gvSubject=''; gvWeek=null; gvError='';
  gvLastWeekHtml=''; gvLastSubjHtml='';
  gvCls=gvSid=gvName=gvProfileSid='';
}
window.resetGradesCache = resetGradesCache;
