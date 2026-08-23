// ═══════════════════════════════════════════════════════════════
// kitchen.js — харчування: меню на тиждень, облік обідів і підвечірків.
//
// МОДЕЛЬ ДАНИХ
//   menu/{дата}                = {first,second,side,drink,dessert,allergens,note,
//                                 snack,snackNote, by, ts, pub}
//        ts  — коли востаннє змінено;  pub — коли вперше опубліковано.
//        Різниця потрібна, щоб відрізнити «меню опубліковано» від «меню змінено».
//
//   meal_plan/{клас}/{ІМʼЯ}    = {lunch:bool, snack:'no'|'all'|'days',
//                                 snackDays:{1..5:true}, by, ts}
//        Постійні налаштування. Відсутність запису = обідає, підвечірок ні.
//        Такий default обраний свідомо: обід — норма, підвечірок — доплата.
//
//   meal_day/{дата}/{клас}/{ІМʼЯ} = {lunch:0|1, snack:0|1, reason, by, ts}
//        Виняток на конкретний день. Пишеться, тільки коли відрізняється
//        від плану, тому в базі десятки записів на місяць, а не тисячі.
//
//   attendance/{клас}/{дата}/{ІМʼЯ}/{слот}.status==='absent'
//        Дитини немає в школі → вона не харчується. Рахуємо автоматично,
//        батькам не треба відмовлятися окремо.
//
// ЧОМУ ДЕДЛАЙН 09:00: після нього кухня вже закупила і почала готувати,
// тож пізня відмова нічого не змінює, лише псує облік.
// ═══════════════════════════════════════════════════════════════
import { ref, set, get, child, update } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, currentUserData, showToast, escHtml, escJs, localDateString, logAction, notifyEvent } from './common.js';

export const MEAL_CUTOFF_HOUR = 9;   // до 09:00 можна відмовитися від сьогоднішнього
const DOW = ['Понеділок','Вівторок','Середа','Четвер','Пʼятниця'];

export const MENU_FIELDS = [
  { k:'first',     label:'Перша страва',  ph:'напр. Борщ український' },
  { k:'second',    label:'Друга страва',  ph:'напр. Котлета з індички' },
  { k:'side',      label:'Гарнір',        ph:'напр. Пюре картопляне' },
  { k:'drink',     label:'Напій',         ph:'напр. Компот із сухофруктів' },
  { k:'dessert',   label:'Десерт',        ph:'необовʼязково' },
  { k:'snack',     label:'🥪 Підвечірок', ph:'окрема позиція, напр. Сирник + какао', snack:true },
  { k:'allergens', label:'⚠️ Алергени',   ph:'напр. містить глютен, молоко', danger:true },
  { k:'note',      label:'Примітка',      ph:'необовʼязково' }
];

// ── ДАТИ ──
const iso = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const human = s => s.split('-').reverse().join('.');
function mondayOf(dateStr){
  const d = new Date(dateStr+'T12:00:00');
  const wd = d.getDay() || 7;              // неділю (0) вважаємо 7-м днем
  d.setDate(d.getDate() - (wd - 1));
  return iso(d);
}
function weekDates(monday){
  const out=[], d=new Date(monday+'T12:00:00');
  for(let i=0;i<5;i++){ out.push(iso(d)); d.setDate(d.getDate()+1); }
  return out;                               // лише робочі дні: Пн–Пт
}
function weekdayIdx(dateStr){ return new Date(dateStr+'T12:00:00').getDay(); } // 1..5

// Чи можна ще змінювати харчування на цю дату
export function mealsEditable(dateStr){
  const today = localDateString;
  if(dateStr > today) return { ok:true };
  if(dateStr < today) return { ok:false, msg:'Цей день уже минув.' };
  const now = new Date();
  if(now.getHours() < MEAL_CUTOFF_HOUR) return { ok:true };
  return { ok:false, msg:`Після ${MEAL_CUTOFF_HOUR}:00 змінити харчування на сьогодні не можна — обіди вже готуються. Зверніться до адміністрації школи.` };
}

// ── ЛОГІКА: хто що їсть ──
function snackPlanned(plan, wd){
  if(!plan || !plan.snack || plan.snack==='no') return false;
  if(plan.snack==='all') return true;
  return !!(plan.snackDays && plan.snackDays[wd]);
}
// Один розрахунок для кухні, для батьків і для статистики — щоб цифри збігалися.
export function effectiveMeals(plan, dayOverride, isAbsent, wd){
  if(isAbsent) return { lunch:false, snack:false, absent:true };
  let lunch = !plan || plan.lunch !== false;
  let snack = snackPlanned(plan, wd);
  if(dayOverride){
    if(dayOverride.lunch !== undefined) lunch = !!dayOverride.lunch;
    if(dayOverride.snack !== undefined) snack = !!dayOverride.snack;
  }
  return { lunch, snack, absent:false };
}
// Відсутність будь-де в межах дня знімає дитину з харчування
function absentSet(attClassDay){
  const out = {};
  if(!attClassDay) return out;
  for(const name in attClassDay){
    const slots = attClassDay[name];
    if(!slots || typeof slots!=='object') continue;
    if(Object.values(slots).some(r=>r && r.status==='absent')) out[name]=true;
  }
  return out;
}

// ═════════ КАБІНЕТ КУХНІ ═════════
function currentMonday(){
  const el = document.getElementById('k-week');
  if(el && el.value) return el.value;
  return mondayOf(localDateString);
}
window.kitchenWeekShift = function(delta){
  const d = new Date(currentMonday()+'T12:00:00');
  d.setDate(d.getDate() + delta*7);
  const el = document.getElementById('k-week');
  if(el) el.value = iso(d);
  refreshKitchen();
};
window.kitchenThisWeek = function(){
  const el = document.getElementById('k-week');
  if(el) el.value = mondayOf(localDateString);
  refreshKitchen();
};

// ── Редактор меню на тиждень ──
export async function loadWeekMenu(){
  const box = document.getElementById('k-menu-week');
  if(!box) return;
  const monday = currentMonday(), dates = weekDates(monday);
  const lbl = document.getElementById('k-week-label');
  if(lbl) lbl.textContent = `${human(dates[0])} — ${human(dates[4])}`;
  box.innerHTML = '<p class="empty-msg">Завантаження...</p>';
  const snaps = await Promise.all(dates.map(d=>get(child(ref(db),`menu/${d}`))));
  box.innerHTML = dates.map((date,i)=>{
    const m = snaps[i].exists() ? snaps[i].val() : {};
    const filled = !!(m.first || m.second);
    const isToday = date === localDateString;
    return `<details class="k-day" ${isToday||i===0?'open':''}>
      <summary>
        <span class="k-day-name">${DOW[i]}</span>
        <span class="k-day-date">${human(date)}</span>
        <span class="k-day-flag ${filled?'ok':'no'}">${filled?'✓ заповнено':'порожньо'}</span>
      </summary>
      <div class="k-day-body">
        ${MENU_FIELDS.map(f=>`
          <label for="km-${date}-${f.k}" ${f.danger?'style="color:var(--red);"':(f.snack?'style="color:#6a1b9a;"':'')}>${escHtml(f.label)}</label>
          <input type="text" id="km-${date}-${f.k}" value="${escHtml(m[f.k]||'')}" placeholder="${escHtml(f.ph)}">`).join('')}
        <p class="k-day-ts">${m.ts?`Оновлено ${new Date(m.ts).toLocaleString('uk-UA')}`:'Ще не публікувалося'}</p>
      </div>
    </details>`;
  }).join('');
}

// Зберігаємо весь тиждень одним рухом, але сповіщаємо лише про ті дні,
// що справді змінилися — інакше батьки отримали б 5 пушів на порожньому місці.
window.saveWeekMenu = async function(){
  const monday = currentMonday(), dates = weekDates(monday);
  const snaps = await Promise.all(dates.map(d=>get(child(ref(db),`menu/${d}`))));
  const changedNew=[], changedUpd=[];
  const updates = {};
  dates.forEach((date,i)=>{
    const old = snaps[i].exists() ? snaps[i].val() : null;
    const data = {};
    let any = false;
    MENU_FIELDS.forEach(f=>{
      const el = document.getElementById(`km-${date}-${f.k}`);
      const v = el ? el.value.trim() : '';
      data[f.k] = v;
      if(v) any = true;
    });
    const same = old && MENU_FIELDS.every(f=>(old[f.k]||'') === data[f.k]);
    if(!any && !old) return;                 // порожній день, якого й не було
    if(same) return;                         // нічого не змінилось
    const wasPublished = !!(old && (old.first || old.second));
    updates[`menu/${date}`] = {
      ...data,
      by: currentUserData?.email || '',
      ts: Date.now(),
      pub: (old && old.pub) || Date.now()
    };
    (wasPublished ? changedUpd : changedNew).push(date);
  });
  if(!Object.keys(updates).length) return showToast('Змін немає');
  await update(ref(db), updates);
  logAction('menu',{ date:`${monday} (тиждень)`, value:`оновлено днів: ${changedNew.length+changedUpd.length}` });
  // Розсилка: одна на кожен змінений день, а не на кожну дитину
  changedNew.forEach(d=>notifyEvent('menu',{ class:'ALL', studentName:'ALL', subject:human(d), value:'new' }));
  changedUpd.forEach(d=>notifyEvent('menu',{ class:'ALL', studentName:'ALL', subject:human(d), value:'upd' }));
  showToast(`✅ Збережено днів: ${changedNew.length+changedUpd.length}`);
  loadWeekMenu(); loadWeekCounts();
};

// Меню часто повторюється — даємо розмножити перший день на весь тиждень
window.copyMondayToWeek = function(){
  const dates = weekDates(currentMonday());
  if(!confirm('Скопіювати меню понеділка на решту днів тижня?\n\nЗаповнені поля інших днів буде замінено. Збережеться після натискання «Опублікувати».')) return;
  MENU_FIELDS.forEach(f=>{
    const src = document.getElementById(`km-${dates[0]}-${f.k}`);
    if(!src) return;
    dates.slice(1).forEach(d=>{
      const el = document.getElementById(`km-${d}-${f.k}`);
      if(el) el.value = src.value;
    });
  });
  showToast('Скопійовано — перевірте і натисніть «Опублікувати»');
};

// ── Скільки готувати ──
export async function loadWeekCounts(){
  const box = document.getElementById('k-counts');
  if(!box) return;
  const dates = weekDates(currentMonday());
  box.innerHTML = '<p class="empty-msg">Обчислення...</p>';
  try{
    const [stSnap, planSnap, attSnap, ...daySnaps] = await Promise.all([
      get(child(ref(db),'students_list')),
      get(child(ref(db),'meal_plan')),
      get(child(ref(db),'attendance')),
      ...dates.map(d=>get(child(ref(db),`meal_day/${d}`)))
    ]);
    const students = stSnap.exists()?stSnap.val():{};
    const plans    = planSnap.exists()?planSnap.val():{};
    const att      = attSnap.exists()?attSnap.val():{};

    const perDay = dates.map((date,di)=>{
      const overrides = daySnaps[di].exists()?daySnaps[di].val():{};
      const wd = weekdayIdx(date);
      let lunch=0, snack=0, absent=0, off=0;
      const classes = {}, skips = [];
      for(let i=1;i<=11;i++){
        const cls = `class_${i}`;
        if(!students[cls]) continue;
        const absentToday = absentSet(att[cls] && att[cls][date]);
        let cl=0, cs=0;
        for(const key in students[cls]){
          const name = students[cls][key];
          const plan = plans[cls] && plans[cls][name];
          const isAbsent = !!absentToday[name];
          const ov = overrides[cls] && overrides[cls][name];
          const e = effectiveMeals(plan, ov, isAbsent, wd);
          if(e.absent){ absent++; continue; }
          const permanentlyOff = plan && plan.lunch === false;
          if(permanentlyOff && !e.snack){ off++; continue; }
          if(e.lunch){ lunch++; cl++; }
          else if(permanentlyOff){ off++; }
          else { skips.push({cls:i,name,reason:(ov&&ov.reason)||''}); }
          if(e.snack){ snack++; cs++; }
        }
        if(cl||cs) classes[i] = { lunch:cl, snack:cs };
      }
      return { date, lunch, snack, absent, off, classes, skips };
    });

    const today = perDay.find(d=>d.date===localDateString) || perDay[0];
    box.innerHTML = `
      <div class="k-total">
        <b>${today.lunch}</b><span>обідів на ${escHtml(human(today.date))}</span>
        <div class="k-total-snack">+ ${today.snack} підвечірків</div>
      </div>
      <div class="k-sub">відсутні: ${today.absent} · не харчуються: ${today.off} · відмови: ${today.skips.length}</div>

      <table class="k-table"><thead><tr><th>День</th><th>Обіди</th><th>Підвеч.</th><th>Відсутні</th></tr></thead><tbody>
        ${perDay.map((d,i)=>`<tr class="${d.date===localDateString?'k-now':''}">
          <td>${DOW[i].slice(0,2)} ${escHtml(human(d.date).slice(0,5))}</td>
          <td><b>${d.lunch}</b></td><td>${d.snack||''}</td><td class="k-off">${d.absent||''}</td></tr>`).join('')}
      </tbody></table>

      <div class="k-skip-title">По класах — ${escHtml(human(today.date))}</div>
      <table class="k-table"><thead><tr><th>Клас</th><th>Обіди</th><th>Підвеч.</th></tr></thead><tbody>
        ${Object.keys(today.classes).length
          ? Object.keys(today.classes).map(c=>`<tr><td>${c}</td><td><b>${today.classes[c].lunch}</b></td><td>${today.classes[c].snack||''}</td></tr>`).join('')
          : '<tr><td colspan="3" class="empty-msg">Немає даних</td></tr>'}
      </tbody></table>

      ${today.skips.length ? `<div class="k-skip-title">Відмови на ${escHtml(human(today.date))}</div>` +
        today.skips.map(s=>`<div class="k-skip">${escHtml(s.name)} <span>${s.cls} кл.${s.reason?' · '+escHtml(s.reason):''}</span></div>`).join('') : ''}`;
  }catch(e){
    box.innerHTML = `<p style="color:red;font-size:.8rem;">Помилка: ${escHtml(e.message)}</p>`;
  }
}

window.refreshKitchen = function(){
  const el = document.getElementById('k-week');
  if(el && !el.value) el.value = mondayOf(localDateString);
  loadWeekMenu(); loadWeekCounts();
};

// ── Хто харчується (кухня / адміністрація) ──
export async function loadMealPlans(){
  const cls = document.getElementById('k-plan-class')?.value;
  const box = document.getElementById('k-plan-list');
  if(!box) return;
  if(!cls){ box.innerHTML = '<p class="empty-msg">Оберіть клас.</p>'; return; }
  box.innerHTML = '<p class="empty-msg">Завантаження...</p>';
  const [stSnap, plSnap] = await Promise.all([
    get(child(ref(db),`students_list/${cls}`)),
    get(child(ref(db),`meal_plan/${cls}`))
  ]);
  if(!stSnap.exists()){ box.innerHTML = '<p class="empty-msg">У класі немає учнів.</p>'; return; }
  const plans = plSnap.exists()?plSnap.val():{};
  box.innerHTML = Object.values(stSnap.val()).sort().map(name=>{
    const p = plans[name] || {};
    const lunch = p.lunch !== false;
    const snack = p.snack || 'no';
    return `<div class="k-plan-row">
      <span class="k-plan-name">${escHtml(name)}</span>
      <label class="k-plan-lunch"><input type="checkbox" ${lunch?'checked':''}
        onchange="setMealPlan('${escJs(cls)}','${escJs(name)}','lunch',this.checked)"> обід</label>
      <select onchange="setMealPlan('${escJs(cls)}','${escJs(name)}','snack',this.value)">
        <option value="no"${snack==='no'?' selected':''}>без підвечірка</option>
        <option value="all"${snack==='all'?' selected':''}>підвечірок щодня</option>
        <option value="days"${snack==='days'?' selected':''}>підвечірок — обрані дні</option>
      </select>
    </div>`;
  }).join('');
}
window.loadMealPlans = loadMealPlans;
window.setMealPlan = async function(cls, name, field, value){
  const snap = await get(child(ref(db),`meal_plan/${cls}/${name}`));
  const plan = snap.exists()?snap.val():{};
  plan[field] = value;
  if(field==='snack' && value!=='days') delete plan.snackDays;
  plan.by = currentUserData?.email || ''; plan.ts = Date.now();
  await set(ref(db,`meal_plan/${cls}/${name}`), plan);
  logAction('meal_plan',{ date:name, value:`${field}=${value}` });
  showToast('✅ Збережено');
  loadWeekCounts();
  if(field==='snack' && value==='days') loadMealPlans();
};

// ── Статистика за період (людино-дні) ──
window.loadMealStats = async function(){
  const from = document.getElementById('k-stat-from')?.value;
  const to   = document.getElementById('k-stat-to')?.value;
  const box  = document.getElementById('k-stats');
  if(!box) return;
  if(!from || !to || from > to) return alert('Оберіть коректний період.');
  box.innerHTML = '<p class="empty-msg">Рахуємо...</p>';
  try{
    const rows = await computeMealStats(from, to);
    if(!rows.length){ box.innerHTML = '<p class="empty-msg">За цей період даних немає.</p>'; return; }
    const tot = rows.reduce((a,r)=>({lunch:a.lunch+r.lunch, snack:a.snack+r.snack}),{lunch:0,snack:0});
    const byClass = {};
    rows.forEach(r=>{ byClass[r.cls] = byClass[r.cls] || {lunch:0,snack:0}; byClass[r.cls].lunch+=r.lunch; byClass[r.cls].snack+=r.snack; });
    box.innerHTML = `
      <div class="k-total"><b>${tot.lunch}</b><span>людино-днів з обідом</span>
        <div class="k-total-snack">+ ${tot.snack} з підвечірком</div></div>
      <div class="k-sub">${escHtml(human(from))} — ${escHtml(human(to))}</div>
      <table class="k-table"><thead><tr><th>Клас</th><th>Обіди</th><th>Підвеч.</th></tr></thead><tbody>
        ${Object.keys(byClass).sort((a,b)=>a-b).map(c=>`<tr><td>${c}</td><td><b>${byClass[c].lunch}</b></td><td>${byClass[c].snack||''}</td></tr>`).join('')}
      </tbody></table>
      <div class="k-skip-title">Поіменно</div>
      <table class="k-table"><thead><tr><th>Учень</th><th>Кл.</th><th>Обіди</th><th>Підвеч.</th></tr></thead><tbody>
        ${rows.sort((a,b)=>b.lunch-a.lunch || a.name.localeCompare(b.name,'uk'))
              .map(r=>`<tr><td>${escHtml(r.name)}</td><td>${r.cls}</td><td><b>${r.lunch}</b></td><td>${r.snack||''}</td></tr>`).join('')}
      </tbody></table>
      <button onclick="exportMealStats()" style="background:#e0f7fa;color:#00838f;border:1px solid #80deea;margin-top:11px;">📄 Вивантажити CSV</button>`;
    window.__mealStats = { from, to, rows };
  }catch(e){
    box.innerHTML = `<p style="color:red;font-size:.8rem;">Помилка: ${escHtml(e.message)}</p>`;
  }
};

// Спільний рахунок для кухні і для батьків. onlyCls/onlyName звужують вибірку.
export async function computeMealStats(from, to, onlyCls, onlyName){
  const [stSnap, planSnap, attSnap, daySnap] = await Promise.all([
    get(child(ref(db),'students_list')),
    get(child(ref(db),'meal_plan')),
    get(child(ref(db),'attendance')),
    get(child(ref(db),'meal_day'))
  ]);
  const students = stSnap.exists()?stSnap.val():{};
  const plans    = planSnap.exists()?planSnap.val():{};
  const att      = attSnap.exists()?attSnap.val():{};
  const days     = daySnap.exists()?daySnap.val():{};

  const dateList = [];
  const d = new Date(from+'T12:00:00'), end = new Date(to+'T12:00:00');
  while(d <= end){
    const wd = d.getDay();
    if(wd>=1 && wd<=5) dateList.push(iso(d));   // вихідні не рахуємо
    d.setDate(d.getDate()+1);
  }
  const out = [];
  for(let i=1;i<=11;i++){
    const cls = `class_${i}`;
    if(!students[cls]) continue;
    if(onlyCls && cls !== onlyCls) continue;
    for(const key in students[cls]){
      const name = students[cls][key];
      if(onlyName && name !== onlyName) continue;
      const plan = plans[cls] && plans[cls][name];
      let lunch=0, snack=0, absent=0;
      dateList.forEach(date=>{
        const isAbsent = !!absentSet(att[cls] && att[cls][date])[name];
        const ov = days[date] && days[date][cls] && days[date][cls][name];
        const e = effectiveMeals(plan, ov, isAbsent, weekdayIdx(date));
        if(e.absent){ absent++; return; }
        if(e.lunch) lunch++;
        if(e.snack) snack++;
      });
      if(lunch || snack) out.push({ cls:i, name, lunch, snack, absent, days:dateList.length });
    }
  }
  return out;
}

window.exportMealStats = function(){
  const s = window.__mealStats;
  if(!s) return;
  const csv = ['Учень;Клас;Обіди;Підвечірки',
    ...s.rows.map(r=>`${r.name};${r.cls};${r.lunch};${r.snack}`)].join('\n');
  const blob = new Blob(['﻿'+csv], {type:'text/csv;charset=utf-8'});   // BOM — щоб Excel не ламав кирилицю
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `harchuvannya_${s.from}_${s.to}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
};

// ═════════ БІК БАТЬКІВ ═════════
export async function renderParentMenu(cls, studentName, date){
  const box = document.getElementById('p-menu');
  if(!box) return;
  try{
    const [mSnap, planSnap, daySnap, attSnap] = await Promise.all([
      get(child(ref(db),`menu/${date}`)),
      get(child(ref(db),`meal_plan/${cls}/${studentName}`)),
      get(child(ref(db),`meal_day/${date}/${cls}/${studentName}`)),
      get(child(ref(db),`attendance/${cls}/${date}/${studentName}`))
    ]);
    const m    = mSnap.exists()?mSnap.val():null;
    const plan = planSnap.exists()?planSnap.val():{};
    const ov   = daySnap.exists()?daySnap.val():null;
    const isAbsent = attSnap.exists() && Object.values(attSnap.val()||{}).some(r=>r && r.status==='absent');
    const eff  = effectiveMeals(plan, ov, isAbsent, weekdayIdx(date));
    const gate = mealsEditable(date);
    const notEating = plan.lunch === false;

    const dishes = ['first','second','side','drink','dessert']
      .filter(k=>m && m[k]).map(k=>`<div class="pm-dish">${escHtml(m[k])}</div>`).join('');

    box.innerHTML = `
      <div class="pm-title">🍽️ Обід на ${escHtml(human(date))}</div>
      ${dishes || '<div class="pm-none">Меню ще не опубліковане</div>'}
      ${m && m.snack ? `<div class="pm-snack"><b>🥪 Підвечірок:</b> ${escHtml(m.snack)}</div>` : ''}
      ${m && m.allergens ? `<div class="pm-allerg">⚠️ ${escHtml(m.allergens)}</div>` : ''}
      ${m && m.note ? `<div class="pm-note">${escHtml(m.note)}</div>` : ''}

      <div class="pm-status">
        ${isAbsent
          ? '<span class="pm-off">Дитина відсутня — харчування цього дня не рахується</span>'
          : `<span class="${eff.lunch?'pm-on':'pm-off'}">${eff.lunch?'✓ Обід':(notEating?'Обіди не замовлені':'✕ Без обіду')}</span>
             <span class="${eff.snack?'pm-on':'pm-dim'}">${eff.snack?'✓ Підвечірок':'без підвечірка'}</span>`}
      </div>

      ${isAbsent ? '' : `
        <div class="pm-act">
          ${gate.ok ? `
            ${notEating ? '' : `<button class="pm-btn ${eff.lunch?'':'back'}" onclick="setMealDay('${escJs(date)}','lunch',${eff.lunch?0:1})">
              ${eff.lunch?'Не буде обідати':'Поверну обід'}</button>`}
            <button class="pm-btn snack" onclick="setMealDay('${escJs(date)}','snack',${eff.snack?0:1})">
              ${eff.snack?'Без підвечірка':'+ Підвечірок'}</button>`
            : `<span class="pm-locked">🔒 ${escHtml(gate.msg)}</span>`}
        </div>`}
      <div class="pm-links">
        <a href="#" onclick="event.preventDefault();openMealSettings();">⚙️ Налаштування харчування</a>
        <a href="#" onclick="event.preventDefault();openMyMealStats();">📊 Моя статистика</a>
      </div>`;
  }catch(e){
    box.innerHTML = `<div class="pm-none">Не вдалося завантажити меню</div>`;
  }
}

window.setMealDay = async function(date, field, value){
  const cls = currentUserData?.class, name = currentUserData?.studentName;
  if(!cls || !name) return;
  const gate = mealsEditable(date);
  if(!gate.ok) return alert(gate.msg);
  let reason = '';
  if(field==='lunch' && !value){
    reason = prompt('Причина (необовʼязково):','') || '';
    if(reason === null) return;
  }
  const path = `meal_day/${date}/${cls}/${name}`;
  const snap = await get(child(ref(db), path));
  const cur = snap.exists()?snap.val():{};
  cur[field] = value ? 1 : 0;
  if(reason) cur.reason = reason.trim().slice(0,120);
  cur.by = currentUserData.email || ''; cur.ts = Date.now();
  await set(ref(db, path), cur);
  showToast(value ? '✓ Записано' : '✕ Відмову зафіксовано');
  renderParentMenu(cls, name, date);
};

// Постійні налаштування дитини — тут батько може зняти її з харчування зовсім
window.openMealSettings = async function(){
  const cls = currentUserData?.class, name = currentUserData?.studentName;
  if(!cls || !name) return;
  const snap = await get(child(ref(db),`meal_plan/${cls}/${name}`));
  const p = snap.exists()?snap.val():{};
  const lunch = p.lunch !== false, snack = p.snack || 'no';
  const sd = p.snackDays || {};
  const box = document.getElementById('meal-settings-body');
  if(!box) return;
  box.innerHTML = `
    <label class="ms-row"><input type="checkbox" id="ms-lunch" ${lunch?'checked':''}>
      <span><b>Дитина харчується в школі</b><br><small>Зніміть галочку, якщо дитина взагалі не бере обіди — вона зникне з підрахунку кухні.</small></span></label>
    <label>🥪 Підвечірок</label>
    <select id="ms-snack" onchange="msToggleDays()">
      <option value="no"${snack==='no'?' selected':''}>Не потрібен</option>
      <option value="all"${snack==='all'?' selected':''}>Щодня</option>
      <option value="days"${snack==='days'?' selected':''}>Лише в обрані дні</option>
    </select>
    <div id="ms-days" style="display:${snack==='days'?'flex':'none'};">
      ${DOW.map((d,i)=>`<label class="ms-day"><input type="checkbox" id="ms-d${i+1}" ${sd[i+1]?'checked':''}><span>${d.slice(0,2)}</span></label>`).join('')}
    </div>
    <p class="ms-note">Зміни діють від наступного дня. Разові відмови робіть кнопками в блоці харчування — до ${MEAL_CUTOFF_HOUR}:00.</p>`;
  document.getElementById('meal-settings-modal').style.display = 'flex';
};
window.msToggleDays = function(){
  const v = document.getElementById('ms-snack').value;
  document.getElementById('ms-days').style.display = v==='days' ? 'flex' : 'none';
};
window.saveMealSettings = async function(){
  const cls = currentUserData?.class, name = currentUserData?.studentName;
  if(!cls || !name) return;
  const snack = document.getElementById('ms-snack').value;
  const plan = {
    lunch: document.getElementById('ms-lunch').checked,
    snack,
    by: currentUserData.email || '', ts: Date.now()
  };
  if(snack === 'days'){
    const d = {};
    for(let i=1;i<=5;i++) if(document.getElementById('ms-d'+i).checked) d[i] = true;
    plan.snackDays = d;
  }
  await set(ref(db,`meal_plan/${cls}/${name}`), plan);
  document.getElementById('meal-settings-modal').style.display = 'none';
  showToast('✅ Налаштування збережено');
  renderParentMenu(cls, name, document.getElementById('global-date').value);
};

window.openMyMealStats = async function(){
  const cls = currentUserData?.class, name = currentUserData?.studentName;
  if(!cls || !name) return;
  const modal = document.getElementById('meal-stats-modal');
  const body  = document.getElementById('meal-stats-body');
  if(!modal || !body) return;
  modal.style.display = 'flex';
  const to = localDateString, from = to.slice(0,8) + '01';
  const f = document.getElementById('pms-from'), t = document.getElementById('pms-to');
  if(f && !f.value) f.value = from;
  if(t && !t.value) t.value = to;
  window.reloadMyMealStats();
};
window.reloadMyMealStats = async function(){
  const cls = currentUserData?.class, name = currentUserData?.studentName;
  const body = document.getElementById('meal-stats-body');
  const from = document.getElementById('pms-from').value;
  const to   = document.getElementById('pms-to').value;
  if(!body || !from || !to) return;
  body.innerHTML = '<p class="empty-msg">Рахуємо...</p>';
  const rows = await computeMealStats(from, to, cls, name);
  const r = rows[0] || { lunch:0, snack:0, absent:0, days:0 };
  body.innerHTML = `
    <div class="pms-grid">
      <div class="pms-cell"><b>${r.lunch}</b><span>днів з обідом</span></div>
      <div class="pms-cell"><b>${r.snack}</b><span>з підвечірком</span></div>
      <div class="pms-cell"><b>${r.absent||0}</b><span>днів відсутності</span></div>
    </div>
    <p class="ms-note">Період: ${escHtml(human(from))} — ${escHtml(human(to))}. Рахуються лише робочі дні.
    Дні, коли дитина була відсутня, до харчування не зараховуються.</p>`;
};
