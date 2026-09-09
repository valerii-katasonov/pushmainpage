// ═══════════════════════════════════════════════════════════════
// homework.js — вкладка «Домашні завдання» для батьків і учня.
//
// НАВІЩО ОКРЕМА ВКЛАДКА. Домашка була лише на «Сьогодні», і щоб подивитися
// вчорашню чи завтрашню, доводилося крутити дату вгорі сторінки. Але та
// дата — ЗАГАЛЬНА: разом із домашкою вона перемотує розклад, відвідуваність
// і меню. Людина шукала одне, а зсувала все.
//
// Тут своя навігація по тижнях, і вона нічого більше не чіпає.
//
// «ЗАДАНО … — ЗРОБИТИ ДО …». У ключі запису лежить дата уроку, на якому
// завдання дали. Батькові цього мало: він питає «на коли». Друга дата
// рахується з розкладу — наступний урок того самого предмета
// (nextLessonDate у common.js), з пропуском свят і канікул.
//
// Тиждень читається ОДНИМ запитом діапазону, а не сімома по днях.
// ═══════════════════════════════════════════════════════════════
import { ref, get, child, query, orderByKey, startAt, endAt }
  from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, currentUserData, getActiveClass, escHtml, mondayOf, localDateString,
         renderHwItem, booksForSubject, nextLessonDate, dayNamesUA, dayKeys }
  from './common.js';
import { ACTIVE_YEAR } from './director.js';

export const HW_BUILD = '2026-09-09 · вкладка ДЗ v1';

// Який тиждень зараз показано. Порожньо — ще не відкривали.
let hwWeek = '';
let hwSkipDates = null;   // свята й канікули, читаємо раз на сеанс

// Дата → «Понеділок, 08.09»
function dayTitle(ds){
  const [y,m,d] = ds.split('-').map(Number);
  const name = dayNamesUA[dayKeys[new Date(y,m-1,d).getDay()]] || '';
  return `${name}, ${String(d).padStart(2,'0')}.${String(m).padStart(2,'0')}`;
}
const human = ds => ds ? ds.split('-').reverse().join('.') : '';

// Невчальні дні: свята й канікули з чинного навчального року. Потрібні,
// щоб «зробити до» не показувало дату, коли школа не працює.
async function loadSkipDates(){
  if(hwSkipDates) return hwSkipDates;
  const skip = new Set();
  try{
    const [hSnap,bSnap] = await Promise.all([
      get(ref(db,`academic_year/${ACTIVE_YEAR}/holidays`)),
      get(ref(db,`academic_year/${ACTIVE_YEAR}/breaks`))
    ]);
    if(hSnap.exists()) Object.values(hSnap.val()).forEach(h=>{ if(h&&h.date) skip.add(h.date); });
    if(bSnap.exists()) Object.values(bSnap.val()).forEach(b=>{
      if(!b||!b.startDate||!b.endDate) return;
      // Канікули задані діапазоном — розгортаємо в окремі дні.
      const [y,m,d]=b.startDate.split('-').map(Number);
      const dt=new Date(y,m-1,d), p2=n=>String(n).padStart(2,'0');
      for(let i=0;i<200;i++){
        const ds=`${dt.getFullYear()}-${p2(dt.getMonth()+1)}-${p2(dt.getDate())}`;
        skip.add(ds);
        if(ds>=b.endDate) break;
        dt.setDate(dt.getDate()+1);
      }
    });
  }catch(e){
    // Без свят «зробити до» лишається оптимістичним, але екран працює.
    console.warn('[Push School] Свята й канікули не прочитано:', e.message);
  }
  hwSkipDates = skip;
  return skip;
}

// ── Показ ───────────────────────────────────────────────────────

export async function renderHwWeekView(boxId, weekStart){
  const box = document.getElementById(boxId);
  if(!box) return;
  const cls = getActiveClass();
  if(!cls){ box.innerHTML = '<p class="empty-msg">Клас не визначено.</p>'; return; }

  hwWeek = weekStart || hwWeek || mondayOf(localDateString);
  const days = [];
  {
    const [y,m,d] = hwWeek.split('-').map(Number);
    const dt = new Date(y,m-1,d), p2 = n=>String(n).padStart(2,'0');
    // Показуємо Пн–Пт: у суботу й неділю уроків немає, і порожні заголовки
    // лише розтягують екран.
    for(let i=0;i<5;i++){
      days.push(`${dt.getFullYear()}-${p2(dt.getMonth()+1)}-${p2(dt.getDate())}`);
      dt.setDate(dt.getDate()+1);
    }
  }

  box.innerHTML = '<p class="empty-msg">Завантаження...</p>';
  let byDate = {}, books = {}, skip = new Set();
  try{
    // Один запит на весь тиждень замість п'яти по днях.
    const [hwSnap, tbSnap, sk] = await Promise.all([
      get(query(child(ref(db),`homeworks/${cls}`), orderByKey(),
                startAt(days[0]), endAt(days[4]+''))),
      get(child(ref(db),`textbooks/${cls}`)).catch(()=>null),
      loadSkipDates()
    ]);
    byDate = hwSnap.exists() ? (hwSnap.val()||{}) : {};
    books  = (tbSnap&&tbSnap.exists()) ? tbSnap.val() : {};
    skip   = sk;
  }catch(e){
    console.error('[Push School] ДЗ за тиждень:', e);
    box.innerHTML = `<p class="empty-msg" style="color:var(--red);">Не вдалося завантажити: ${escHtml(e.message||'')}</p>`;
    return;
  }

  const today = localDateString;
  const total = days.reduce((n,d)=>n+Object.keys(byDate[d]||{}).length, 0);
  const hasSchedule = !!(window.schedule && Object.keys(window.schedule).length);

  const nav = `
    <div class="hw-nav">
      <button type="button" onclick="hwShiftWeek(-1)">←</button>
      <div class="hw-nav-mid">
        <b>${escHtml(human(days[0]))} – ${escHtml(human(days[4]))}</b>
        <span>${total ? `завдань: ${total}` : 'завдань немає'}</span>
      </div>
      <button type="button" onclick="hwShiftWeek(1)">→</button>
    </div>
    ${hwWeek!==mondayOf(today)
      ? `<button type="button" class="hw-today" onclick="hwShiftWeek(0)">Повернутися до поточного тижня</button>` : ''}`;

  const dayBlocks = days.map(ds=>{
    const subjects = byDate[ds] || {};
    const names = Object.keys(subjects);
    if(!names.length) return '';          // порожній день не показуємо
    const items = names.sort((a,b)=>a.localeCompare(b,'uk')).map(subj=>{
      const rec = subjects[subj];
      // «Зробити до» — наступний урок цього ж предмета за розкладом.
      //
      // Розклад і його відсутність — різні речі, і плутати їх не можна:
      // «не знайдено» під кожним завданням виглядає як поломка, хоча
      // насправді розклад ще не приїхав.
      const due = hasSchedule ? nextLessonDate(window.schedule, subj, ds, skip) : '';
      const dueTxt = !hasSchedule
        ? '<span class="hw-due none">розклад ще завантажується</span>'
        : (due
            ? `<span class="hw-due">зробити до ${escHtml(human(due))}${due===today?' — сьогодні!':''}</span>`
            : '<span class="hw-due none">наступного уроку в розкладі немає</span>');
      // Дописуємо в кінець <li>, який повернув renderHwItem. Через
      // lastIndexOf, а не replace: якщо колись усередині завдання
      // з'явиться свій список, перший </li> виявиться чужим.
      const li = renderHwItem(subj, rec, booksForSubject(books, subj));
      const cut = li.lastIndexOf('</li>');
      return cut < 0 ? li + dueTxt : li.slice(0,cut) + dueTxt + li.slice(cut);
    }).join('');
    return `<div class="hw-day${ds===today?' today':''}">
        <div class="hw-day-head">${escHtml(dayTitle(ds))}${ds===today?' <span>сьогодні</span>':''}</div>
        <ul class="list-dash hw-day-list">${items}</ul>
      </div>`;
  }).join('');

  box.innerHTML = nav + (dayBlocks ||
    `<p class="empty-msg">На цей тиждень завдань поки немає.</p>`);
}
window.renderHwWeekView = renderHwWeekView;

// Перемикання тижнів. 0 — повернутися до поточного.
window.hwShiftWeek = function(delta){
  if(!delta){ hwWeek = mondayOf(localDateString); }
  else{
    const [y,m,d] = hwWeek.split('-').map(Number);
    const dt = new Date(y,m-1,d);
    dt.setDate(dt.getDate() + delta*7);
    const p2 = n=>String(n).padStart(2,'0');
    hwWeek = `${dt.getFullYear()}-${p2(dt.getMonth()+1)}-${p2(dt.getDate())}`;
  }
  renderHwWeekView(hwBoxId());
};

// Вкладка є і в батьків, і в учня. Обидві панелі лежать у розмітці
// ОДНОЧАСНО — просто одна прихована. Тому «взяти той елемент, що існує»
// не працює: для учня теж знаходився батьківський блок, і малювання
// йшло в приховану панель — учень бачив порожню вкладку.
// Питаємо роль, а не наявність елемента.
function hwBoxId(){
  return (currentUserData && currentUserData.role === 'student')
    ? 's-hw-week' : 'p-hw-week';
}

// Викликається при перемиканні на вкладку: показуємо поточний тиждень.
window.openHwTab = function(){
  hwWeek = hwWeek || mondayOf(localDateString);
  renderHwWeekView(hwBoxId());
};
