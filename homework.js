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
import { db, currentUserData, getActiveClass, escHtml, escJs, mondayOf, localDateString,
         renderHwItem, booksForSubject, nextLessonDate, dayNamesUA, dayKeys }
  from './common.js';
import { topicNames } from './parent-student.js';
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
  let byDate = {}, books = {}, topics = {}, plans = {}, skip = new Set();
  try{
    // Один запит на весь тиждень замість п'яти по днях.
    const [hwSnap, tbSnap, topSnap, planSnap, sk] = await Promise.all([
      get(query(child(ref(db),`homeworks/${cls}`), orderByKey(),
                startAt(days[0]), endAt(days[4]+''))),
      get(child(ref(db),`textbooks/${cls}`)).catch(()=>null),
      // Теми уроків лежать інакше: спершу предмет, потім дата. Тижневим
      // діапазоном їх не візьмеш, тож читаємо вузол класу цілком — одним
      // запитом на весь показ, а не по запиту на кожен предмет.
      get(child(ref(db),`lesson_topics/${cls}`)).catch(()=>null),
      get(child(ref(db),`curriculum_plans/${cls}`)).catch(()=>null),
      loadSkipDates()
    ]);
    byDate = hwSnap.exists() ? (hwSnap.val()||{}) : {};
    books  = (tbSnap&&tbSnap.exists()) ? tbSnap.val() : {};
    topics = (topSnap&&topSnap.exists()) ? topSnap.val() : {};
    plans  = (planSnap&&planSnap.exists()) ? planSnap.val() : {};
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
    const items = names.sort((a,b)=>a.localeCompare(b,'uk')).map((subj,idx)=>{
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
      // ТЕМА УРОКУ поруч із завданням. Батько питає не лише «що робити»,
      // а й «що вони проходили» — без цього допомогти важко.
      // Ключ предмета в lesson_topics «безпечний»: крапки й слеші замінені.
      const sk2 = String(subj).replace(/[.#$[\]/]/g,'_').trim();
      const topic = topicNames((topics[sk2]||{})[ds], plans[sk2]);
      const topicTxt = topic
        ? `<div class="hw-topic"><b>Тема уроку:</b> ${escHtml(topic)}</div>` : '';

      // ПОМІЧНИК ПРИ КОЖНОМУ ЗАВДАННІ, а не один на всю вкладку.
      // Раніше внизу сторінки стояла випадайка предметів: батько мусив
      // обрати те, що й так бачить перед собою. Тепер предмет, тема й
      // текст завдання беруться з цього самого рядка.
      // Ідентифікатор — за НОМЕРОМ, а не за назвою предмета. Назви в нас
      // кирилицею, а в id безпечні лише латиниця й цифри: після заміни
      // «Математика» і «Читання» перетворювалися на однакові рядки з
      // підкреслень, і помічник писав відповідь у чужий блок.
      const hid = 'hwai-' + ds.replace(/-/g,'') + '-' + idx;
      const helpTxt = `
        <div class="hw-help">
          <button type="button" class="hw-help-btn" id="${hid}-btn"
            onclick="hwHelp('${escJs(subj)}','${escJs(topic)}','${escJs(String((rec&&rec.text)||''))}','${hid}')">
            💡 Як допомогти</button>
          <div class="hw-help-out" id="${hid}-out" style="display:none;"></div>
        </div>`;

      const li = renderHwItem(subj, rec, booksForSubject(books, subj));
      const extra = topicTxt + dueTxt + helpTxt;
      const cut = li.lastIndexOf('</li>');
      return cut < 0 ? li + extra : li.slice(0,cut) + extra + li.slice(cut);
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

// ── ОНОВЛЕННЯ ПРИ ЗМІНІ КОНТЕКСТУ ───────────────────────────────
//
// Вкладка малювалася ЛИШЕ при натисканні на неї. Тож коли батько з двома
// дітьми перемикав дитину, залишаючись на цій вкладці, на екрані висіла
// домашка попередньої: доводилося піти на іншу вкладку й повернутися.
// Так само було б і з будь-якою іншою зміною класу.
//
// Тепер вкладка сама перемальовується — але тільки якщо її ВИДНО.
// Інакше кожне перемикання дитини тягло б зайве читання тижня в фоні.
function hwVisible(){
  const b = document.getElementById(hwBoxId());
  return !!(b && b.offsetParent !== null);
}
window.refreshHwTabIfOpen = function(){
  if(hwVisible()) renderHwWeekView(hwBoxId());
};

// ── «ЯК ДОПОМОГТИ» ПРИ КОЖНОМУ ЗАВДАННІ ─────────────────────────
//
// Раніше помічник жив унизу вкладки «Сьогодні»: випадайка предметів плюс
// кнопка. Батько мусив обрати предмет, який і так бачив перед собою, —
// зайвий крок рівно там, де людина вже знає, чого хоче.
//
// Тепер кнопка стоїть під кожним завданням, а предмет, тема й текст
// беруться з того самого рядка. Відповідь розгортається тут же.
//
// ПРИВАТНІСТЬ. У сервіс іде лише предмет, тема, текст завдання й номер
// класу — так само, як було. Імені дитини не передаємо й не передавали.
window.hwHelp = async function(subject, topic, homework, id){
  const btn = document.getElementById(id+'-btn');
  const out = document.getElementById(id+'-out');
  if(!btn || !out) return;

  // Друге натискання згортає — щоб не питати те саме двічі.
  if(out.style.display === 'block'){ out.style.display = 'none'; return; }
  if(out.dataset.done === '1'){ out.style.display = 'block'; return; }

  if(!topic && !homework){
    out.textContent = 'Учитель ще не вказав ні теми, ні завдання — підказати нема з чого.';
    out.style.display = 'block';
    return;
  }

  const classNum = parseInt(String(getActiveClass()||'').replace('class_',''), 10);
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = '⏳ Хвилинку...';
  out.style.display = 'block';
  out.textContent = '';
  try{
    const r = await fetch('/.netlify/functions/ai-assist', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ task:'parentHelp', subject, topic, homework, classNum })
    });
    const data = await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(data.error || `Помилка ${r.status}`);
    out.textContent = (data.text||'') + '\n\n💡 Це загальні поради — орієнтуйтесь на свою дитину.';
    out.dataset.done = '1';
  }catch(e){
    // Помилку показуємо на місці, а не тостом: людина дивиться сюди.
    out.textContent = 'Не вдалося отримати відповідь: ' + (e.message||'');
  }finally{
    btn.disabled = false; btn.textContent = label;
  }
};
