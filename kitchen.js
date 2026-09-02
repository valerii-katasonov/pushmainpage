// ═══════════════════════════════════════════════════════════════
// kitchen.js — харчування: меню на тиждень, облік обідів і підвечірків.
//
// МОДЕЛЬ ДАНИХ
//   menu/{дата}                = {first,second,second2,side,drink,dessert,
//                                 allergens,note, snack,snackNote,
//                                 breakfast, by, ts, pub}
//        second2 — другий варіант основної страви. Порожнє поле означає,
//        що вибору того дня немає: кухня готує одне.
//        breakfast — сніданок. Порожнє поле = того дня сніданків немає.
//        ts  — коли востаннє змінено;  pub — коли вперше опубліковано.
//        Різниця потрібна, щоб відрізнити «меню опубліковано» від «меню змінено».
//
//   meal_plan/{клас}/{ID}      = {lunch:bool,
//                                 snack:'no'|'all'|'days', snackDays:{1..5},
//                                 breakfast:'no'|'all'|'days', breakfastDays:{1..5},
//                                 by, ts}
//        Постійні налаштування. Відсутність запису = обідає, підвечірок ні.
//        Такий default обраний свідомо: обід — норма, підвечірок — доплата.
//
//   meal_day/{дата}/{клас}/{ID}   = {lunch:0|1, snack:0|1, breakfast:0|1,
//                                    pick:'a'|'b', reason, by, ts}
//        pick — обраний варіант основної страви на цей день.
//
//   takeaway_items/{id}        = {title, price, active, note, by, ts}
//        Позиції на винос, які кухня продає окремо від меню.
//   takeaway_orders/{дата}/{клас}/{ID}/{itemId} = кількість
//        Замовлення сімʼї. Оплата поза порталом — портал лише рахує.
//        Виняток на конкретний день. Пишеться, тільки коли відрізняється
//        від плану, тому в базі десятки записів на місяць, а не тисячі.
//
//   attendance/{клас}/{дата}/{ID}/{слот}.status==='absent'
//        Дитини немає в школі → вона не харчується. Рахуємо автоматично,
//        батькам не треба відмовлятися окремо.
//
// ЧОМУ ДЕДЛАЙН 09:00: після нього кухня вже закупила і почала готувати,
// тож пізня відмова нічого не змінює, лише псує облік.
//   {ID} — постійний ключ учня зі students_list, а не імʼя. Імʼя показуємо
//   через stuName(): воно може змінитися, ключ — ні.
// ═══════════════════════════════════════════════════════════════
import { ref, set, get, child, update } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, currentUserData, showToast, escHtml, escJs, localDateString, logAction, notifyEvent, pushConfigured, renderPushWarning, getSchoolRange, getDateRange, stuName } from './common.js';

export const MEAL_CUTOFF_HOUR = 9;   // до 09:00 можна відмовитися від сьогоднішнього
// Сніданок їдять до уроків, тож дедлайн 09:00 для нього безглуздий — його
// вже зʼїли. Замовлення й відмова закриваються напередодні о 18:00.
export const BREAKFAST_CUTOFF_HOUR = 18;
const DOW = ['Понеділок','Вівторок','Середа','Четвер','Пʼятниця'];
// Не slice(0,2) від повної назви: так виходило «По», «Ві», «Пʼ».
const DOW_SHORT = ['Пн','Вт','Ср','Чт','Пт'];

export const MENU_FIELDS = [
  { k:'first',     label:'Перша страва',  ph:'напр. Борщ український' },
  { k:'second',    label:'Друга страва — варіант А', ph:'напр. Котлета з індички' },
  { k:'second2',   label:'Друга страва — варіант Б', ph:'необовʼязково; заповніть, щоб дати вибір', choice:true },
  { k:'side',      label:'Гарнір',        ph:'напр. Пюре картопляне' },
  { k:'drink',     label:'Напій',         ph:'напр. Компот із сухофруктів' },
  { k:'dessert',   label:'Десерт',        ph:'необовʼязково' },
  { k:'breakfast', label:'🌅 Сніданок',   ph:'окрема позиція; порожньо — сніданків цього дня немає', meal:true },
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
function nextWorkday(dateStr){
  const d = new Date(dateStr+'T12:00:00');
  do { d.setDate(d.getDate()+1); } while(d.getDay()===0 || d.getDay()===6);
  return iso(d);
}
// У суботу й неділю «поточний тиждень» для кухні — це той, що починається
// завтра-післязавтра. Інакше в неділю відкривався тиждень, який уже минув,
// і меню публікувалося в нікуди.
function planningMonday(){
  const d = new Date(localDateString+'T12:00:00');
  const wd = d.getDay();
  if(wd === 0) d.setDate(d.getDate() + 1);        // неділя → завтрашній понеділок
  else if(wd === 6) d.setDate(d.getDate() + 2);   // субота  → післязавтрашній
  return mondayOf(iso(d));
}
// Підпис, щоб не було сумнівів, який саме тиждень зараз на екрані
function weekHint(monday){
  const cur = planningMonday();
  if(monday === cur) return new Date(localDateString+'T12:00:00').getDay() % 6 === 0
    ? 'найближчий робочий тиждень' : 'поточний тиждень';
  return monday < cur ? 'минулий тиждень' : 'майбутній тиждень';
}

// Чи можна ще змінювати харчування на цю дату
export function mealsEditable(dateStr){
  const today = localDateString;
  if(dateStr > today) return { ok:true };
  if(dateStr < today) return { ok:false, msg:'Цей день уже минув.' };
  const now = new Date();
  if(now.getHours() < MEAL_CUTOFF_HOUR) return { ok:true };
  return { ok:false, msg:`Після ${MEAL_CUTOFF_HOUR}:00 змінити харчування на сьогодні не можна — обіди вже готуються. Зверніться до адміністрації школи.` };
}

// ── ДЕДЛАЙН СНІДАНКУ ──
// Напередодні до 18:00. Окремо від обіду, бо сніданок готують до уроків.
export function prevDay(dateStr){
  const d = new Date(dateStr+'T12:00:00');
  d.setDate(d.getDate()-1);
  return iso(d);
}
export function breakfastEditable(dateStr, now = new Date(), today = localDateString){
  if(dateStr <= today)
    return { ok:false, msg:'Сніданок на сьогодні вже приготували — змінити не можна.' };
  const eve = prevDay(dateStr);
  if(today < eve) return { ok:true };                 // більш ніж за добу
  // сьогодні — напередодні: дивимося на годину
  return now.getHours() < BREAKFAST_CUTOFF_HOUR
    ? { ok:true }
    : { ok:false, msg:`Замовлення сніданків на завтра закрилося о ${BREAKFAST_CUTOFF_HOUR}:00.` };
}

// ── ЛОГІКА: хто що їсть ──
// Один розрахунок для підвечірка і сніданку: обидва вмикаються за
// бажанням, за замовчуванням вимкнені. Обід навпаки — норма.
function optionPlanned(plan, key, wd){
  if(!plan) return false;
  const mode = plan[key];
  if(!mode || mode === 'no') return false;
  if(mode === 'all') return true;
  const days = plan[key+'Days'];
  return !!(days && days[wd]);
}
function snackPlanned(plan, wd){ return optionPlanned(plan, 'snack', wd); }

// Один розрахунок для кухні, для батьків і для статистики — щоб цифри збігалися.
// Чи батько взагалі відповів на питання «дитина обідає в школі?».
//
// НАВІЩО ОКРЕМИЙ СТАН. Раніше обід вважався замовленим за замовчуванням:
// немає запису — значить обідає. Через це в кухні всі 165 дітей були
// «на обіді», зокрема ті, кого ніхто не записував. Порахувати справжню
// кількість порцій було неможливо.
//
// Тепер три стани, а не два: обідає, не обідає, і — не обрано. Останній
// не рахується як замовлення, але й не мовчить: батько бачить питання.
export function lunchChosen(plan){
  return !!(plan && typeof plan.lunch === 'boolean');
}

export function effectiveMeals(plan, dayOverride, isAbsent, wd){
  if(isAbsent) return { lunch:false, snack:false, breakfast:false, absent:true };
  // Обід лише за явною згодою батьків. Мовчання — не замовлення.
  let lunch = !!(plan && plan.lunch === true);
  let snack = optionPlanned(plan, 'snack', wd);
  let breakfast = optionPlanned(plan, 'breakfast', wd);
  if(dayOverride){
    if(dayOverride.lunch !== undefined) lunch = !!dayOverride.lunch;
    if(dayOverride.snack !== undefined) snack = !!dayOverride.snack;
    if(dayOverride.breakfast !== undefined) breakfast = !!dayOverride.breakfast;
  }
  return { lunch, snack, breakfast, absent:false };
}

// Який варіант основної страви їсть дитина цього дня.
// null означає, що вибору немає: кухня не заповнила другий варіант.
// За замовчуванням — «А»: хто не обирав, отримує те, що готують усім.
export function pickedSecond(menuDay, dayOverride){
  if(!menuDay || !String(menuDay.second2 || '').trim()) return null;
  return (dayOverride && dayOverride.pick === 'b') ? 'b' : 'a';
}
// Відсутність будь-де в межах дня знімає дитину з харчування
function absentSet(attClassDay){
  const out = {};
  if(!attClassDay) return out;
  for(const sid in attClassDay){
    const slots = attClassDay[sid];
    if(!slots || typeof slots!=='object') continue;
    if(Object.values(slots).some(r=>r && r.status==='absent')) out[sid]=true;
  }
  return out;
}

// ═════════ КАБІНЕТ КУХНІ ═════════
function currentMonday(){
  const el = document.getElementById('k-week');
  if(el && el.value) return el.value;
  return planningMonday();
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
  if(el) el.value = planningMonday();
  refreshKitchen();
};

// ── Редактор меню на тиждень ──
export async function loadWeekMenu(){
  const box = document.getElementById('k-menu-week');
  if(!box) return;
  const monday = currentMonday(), dates = weekDates(monday);
  const lbl = document.getElementById('k-week-label');
  if(lbl) lbl.innerHTML = `${human(dates[0])} — ${human(dates[4])}<br><small class="k-week-hint">${escHtml(weekHint(monday))}</small>`;
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
          <label for="km-${date}-${f.k}" ${f.danger?'style="color:var(--red);"':(f.snack?'style="color:#6a1b9a;"':(f.meal?'style="color:#e65100;"':(f.choice?'style="color:#8e44ad;"':'')))}>${escHtml(f.label)}</label>
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
  const savedCount = changedNew.length + changedUpd.length;
  showToast(`✅ Збережено днів: ${savedCount}`);
  // Розсилка: одна на кожен змінений день, а не на кожну дитину.
  // Чекаємо на відповідь — інакше помилка розсилки лишиться непоміченою
  // і кухня буде думати, що батьки повідомлені.
  // Про минулі дні не сповіщаємо: батькам це вже ні до чого, а виглядало б
  // як помилка. Кухня іноді заповнює минулий тиждень заднім числом для обліку.
  const future = d => d >= localDateString;
  const toSend = [
    ...changedNew.filter(future).map(d=>['new',d]),
    ...changedUpd.filter(future).map(d=>['upd',d])
  ];
  const skippedPast = (changedNew.length + changedUpd.length) - toSend.length;
  const results = await Promise.all(
    toSend.map(([v,d])=>notifyEvent('menu',{ class:'ALL', studentName:'ALL', subject:human(d), value:v }))
  );
  const failed = results.find(r=>!r.ok);
  const sent = results.reduce((a,r)=>a+(r.sent||0),0);
  const info = document.getElementById('k-notify-info');
  if(info){
    info.style.display='block';
    info.className = failed ? 'k-notify bad' : 'k-notify ok';
    const past = skippedPast ? ` Днів у минулому (${skippedPast}) — без сповіщення.` : '';
    info.textContent = failed
      ? `Меню збережено, але сповіщення не відправлені: ${failed.error}`
      : !toSend.length
        ? `Меню збережено.${past || ' Сповіщати нема про що.'}`
        : (sent ? `Сповіщення надіслано: ${sent}.${past}`
                : `Сповіщення нікому не надіслані — жоден з батьків ще не увімкнув їх у своєму кабінеті.${past}`);
  }
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
    // Відвідуваність беремо лише за цей тиждень, а не за весь рік
    const [stSnap, planSnap, att, daySnaps, menuSnaps] = await Promise.all([
      get(child(ref(db),'students_list')),
      get(child(ref(db),'meal_plan')),
      getSchoolRange('attendance', dates[0], dates[4]),
      Promise.all(dates.map(d=>get(child(ref(db),`meal_day/${d}`)))),
      // Меню потрібне, щоб знати, чи є того дня вибір основної страви
      Promise.all(dates.map(d=>get(child(ref(db),`menu/${d}`))))
    ]);
    const students = stSnap.exists()?stSnap.val():{};
    const plans    = planSnap.exists()?planSnap.val():{};

    const perDay = dates.map((date,di)=>{
      const overrides = daySnaps[di].exists()?daySnaps[di].val():{};
      const menuDay = menuSnaps[di].exists()?menuSnaps[di].val():{};
      const hasChoice = !!String(menuDay.second2||'').trim();
      const hasBrkMenu = !!String(menuDay.breakfast||'').trim();
      const wd = weekdayIdx(date);
      let lunch=0, snack=0, brk=0, pa=0, pb=0, absent=0, off=0, unset=0;
      const classes = {}, skips = [];
      for(let i=1;i<=11;i++){
        const cls = `class_${i}`;
        if(!students[cls]) continue;
        const absentToday = absentSet(att[cls] && att[cls][date]);
        let cl=0, cs=0, cb=0, ca=0, cbb=0;
        for(const key in students[cls]){
          const name = students[cls][key];
          const plan = plans[cls] && plans[cls][key];
          const isAbsent = !!absentToday[key];
          const ov = overrides[cls] && overrides[cls][key];
          const e = effectiveMeals(plan, ov, isAbsent, wd);
          if(e.absent){ absent++; continue; }
          const permanentlyOff = plan && plan.lunch === false;
          if(permanentlyOff && !e.snack){ off++; continue; }
          if(e.lunch){
            lunch++; cl++;
            // Розподіл за варіантами — лише в дні, коли вибір справді є
            if(hasChoice){
              const p = pickedSecond(menuDay, ov);
              if(p === 'b'){ pb++; cbb++; } else { pa++; ca++; }
            }
          }
          else if(permanentlyOff){ off++; }
          // За цю дитину батьки ще не відповіли про обіди. Це не відмова
          // і не разовий пропуск — окремий стан, і кухня має його бачити,
          // інакше дитина просто зникає з підрахунку без пояснення.
          else if(!lunchChosen(plan)){ unset++; }
          else { skips.push({cls:i,name,reason:(ov&&ov.reason)||''}); }
          if(e.snack){ snack++; cs++; }
          if(e.breakfast && hasBrkMenu){ brk++; cb++; }
        }
        if(cl||cs||cb) classes[i] = { lunch:cl, snack:cs, brk:cb, a:ca, b:cbb };
      }
      return { date, lunch, snack, brk, pa, pb, hasChoice, hasBrkMenu,
               menuA:menuDay.second||'', menuB:menuDay.second2||'',
               absent, off, unset, classes, skips };
    });

    const today = perDay.find(d=>d.date===localDateString) || perDay[0];
    box.innerHTML = `
      <div class="k-total">
        <b>${today.lunch}</b><span>обідів на ${escHtml(human(today.date))}</span>
        <div class="k-total-snack">+ ${today.snack} підвечірків</div>
      </div>
      <div class="k-sub">відсутні: ${today.absent} · не харчуються: ${today.off} · відмови: ${today.skips.length}${today.unset ? ` · <b style="color:var(--orange);">батьки не відповіли: ${today.unset}</b>` : ''}</div>

      <table class="k-table"><thead><tr><th>День</th><th>Обіди</th><th>Підвеч.</th><th>Відсутні</th></tr></thead><tbody>
        ${perDay.map((d,i)=>`<tr class="${d.date===localDateString?'k-now':''}">
          <td>${DOW_SHORT[i]} ${escHtml(human(d.date).slice(0,5))}</td>
          <td><b>${d.lunch}</b></td><td>${d.snack||''}</td><td class="k-off">${d.absent||''}</td></tr>`).join('')}
      </tbody></table>

      <div class="k-skip-title">По класах — ${escHtml(human(today.date))}</div>
      <table class="k-table"><thead><tr><th>Клас</th><th>Снід.</th><th>Обіди</th>${today.hasChoice?'<th>А / Б</th>':''}<th>Підвеч.</th></tr></thead><tbody>
        ${Object.keys(today.classes).length
          ? Object.keys(today.classes).map(c=>`<tr><td>${c}</td><td>${today.classes[c].brk||''}</td><td><b>${today.classes[c].lunch}</b></td>${today.hasChoice?`<td>${today.classes[c].a||0} / ${today.classes[c].b||0}</td>`:''}<td>${today.classes[c].snack||''}</td></tr>`).join('')
          : `<tr><td colspan="${today.hasChoice?5:4}" class="empty-msg">Немає даних</td></tr>`}
      </tbody></table>

      ${today.skips.length ? `<div class="k-skip-title">Відмови на ${escHtml(human(today.date))}</div>` +
        today.skips.map(s=>`<div class="k-skip">${escHtml(s.name)} <span>${s.cls} кл.${s.reason?' · '+escHtml(s.reason):''}</span></div>`).join('') : ''}`;
  }catch(e){
    box.innerHTML = `<p style="color:red;font-size:.8rem;">Помилка: ${escHtml(e.message)}</p>`;
  }
}

window.refreshKitchen = function(){
  const el = document.getElementById('k-week');
  if(el && !el.value) el.value = planningMonday();
  renderPushWarning('k-push-warn');
  const od = document.getElementById('k-order-date');
  if(od && !od.value){
    const wd = weekdayIdx(localDateString);
    od.value = (wd===0||wd===6) ? nextWorkday(localDateString) : localDateString;
  }
  const info = document.getElementById('k-notify-info');
  if(info) info.style.display='none';
  const td = document.getElementById('k-ta-date');
  if(td && !td.value){
    const wd = weekdayIdx(localDateString);
    td.value = (wd===0||wd===6) ? nextWorkday(localDateString) : localDateString;
    loadTakeawayOrders();
  }
  loadWeekMenu(); loadWeekCounts();
  loadTakeawayItems();
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
  box.innerHTML = Object.entries(stSnap.val()).sort((a,b)=>String(a[1]).localeCompare(String(b[1]),'uk')).map(([sid,name])=>{
    const p = plans[sid] || {};
    // Галочка показує РЕАЛЬНИЙ стан. Раніше вона стояла увімкненою і в
    // тих, за кого батьки нічого не обирали, — і персонал бачив клас,
    // де «обідають усі», хоча насправді не відповів ніхто.
    const lunch = p.lunch === true;
    const noAnswer = !lunchChosen(p);
    const snack = p.snack || 'no';
    return `<div class="k-plan-row${noAnswer?' k-plan-unset':''}">
      <span class="k-plan-name">${escHtml(name)}${noAnswer?' <i class="k-plan-note">батьки не відповіли</i>':''}</span>
      <label class="k-plan-lunch"><input type="checkbox" ${lunch?'checked':''}
        onchange="setMealPlan('${escJs(cls)}','${escJs(sid)}','lunch',this.checked)"> обід</label>
      <select onchange="setMealPlan('${escJs(cls)}','${escJs(sid)}','snack',this.value)">
        <option value="no"${snack==='no'?' selected':''}>без підвечірка</option>
        <option value="all"${snack==='all'?' selected':''}>підвечірок щодня</option>
        <option value="days"${snack==='days'?' selected':''}>підвечірок — обрані дні</option>
      </select>
    </div>`;
  }).join('');
}
window.loadMealPlans = loadMealPlans;
window.setMealPlan = async function(cls, sid, field, value){
  const snap = await get(child(ref(db),`meal_plan/${cls}/${sid}`));
  const plan = snap.exists()?snap.val():{};
  plan[field] = value;
  if(field==='snack' && value!=='days') delete plan.snackDays;
  plan.by = currentUserData?.email || ''; plan.ts = Date.now();
  await set(ref(db,`meal_plan/${cls}/${sid}`), plan);
  logAction('meal_plan',{ date:stuName(cls,sid), value:`${field}=${value}` });
  showToast('✅ Збережено');
  loadWeekCounts();
  if(field==='snack' && value==='days') loadMealPlans();
};

// ── Хто що замовив: поіменний список по класу на конкретний день ──
// Кухні потрібен не лише підсумок, а й список, з яким можна вийти на роздачу:
// хто сьогодні обідає, хто бере підвечірок, кого немає і хто відмовився.
window.loadClassOrders = async function(){
  const cls  = document.getElementById('k-order-class')?.value;
  const date = document.getElementById('k-order-date')?.value;
  const box  = document.getElementById('k-orders');
  if(!box) return;
  if(!cls || !date){ box.innerHTML = '<p class="empty-msg">Оберіть клас і дату.</p>'; return; }
  box.innerHTML = '<p class="empty-msg">Завантаження...</p>';
  try{
    const [stSnap, plSnap, daySnap, attSnap, menuSnap] = await Promise.all([
      get(child(ref(db),`students_list/${cls}`)),
      get(child(ref(db),`meal_plan/${cls}`)),
      get(child(ref(db),`meal_day/${date}/${cls}`)),
      get(child(ref(db),`attendance/${cls}/${date}`)),
      get(child(ref(db),`menu/${date}`))
    ]);
    const menuDay = menuSnap.exists()?menuSnap.val():{};
    const hasChoice = !!String(menuDay.second2||'').trim();
    const hasBrkMenu = !!String(menuDay.breakfast||'').trim();
    if(!stSnap.exists()){ box.innerHTML = '<p class="empty-msg">У класі немає учнів.</p>'; return; }
    const plans = plSnap.exists()?plSnap.val():{};
    const overrides = daySnap.exists()?daySnap.val():{};
    const absent = absentSet(attSnap.exists()?attSnap.val():null);
    const wd = weekdayIdx(date);

    const rows = Object.entries(stSnap.val()).sort((a,b)=>String(a[1]).localeCompare(String(b[1]),'uk')).map(([sid,name])=>{
      const plan = plans[sid] || {};
      const ov = overrides[sid];
      const e = effectiveMeals(plan, ov, !!absent[sid], wd);
      const pick = (e.lunch && hasChoice) ? pickedSecond(menuDay, ov) : null;
      let note = '';
      if(e.absent) note = 'відсутній';
      else if(plan.lunch === false) note = 'не харчується';
      else if(ov && ov.lunch === 0) note = ov.reason ? `відмова · ${ov.reason}` : 'відмова';
      else if(ov && ov.snack !== undefined) note = ov.snack ? 'підвечірок разово' : 'без підвечірка сьогодні';
      return { name, ...e, pick, note };
    });
    const lunch = rows.filter(r=>r.lunch).length;
    const snack = rows.filter(r=>r.snack).length;
    const brk   = hasBrkMenu ? rows.filter(r=>r.breakfast).length : 0;
    const pa    = rows.filter(r=>r.pick==='a').length;
    const pb    = rows.filter(r=>r.pick==='b').length;
    window.__classOrders = { cls, date, rows };

    box.innerHTML = `
      <div class="k-ord-sum">${hasBrkMenu?`<b>${brk}</b> сніданків · `:''}<b>${lunch}</b> обідів${hasChoice?` <span class="k-ord-ab">А ${pa} / Б ${pb}</span>`:''} · <b>${snack}</b> підвечірків
        <span>${escHtml(cls.replace('class_',''))} клас, ${escHtml(human(date))}</span></div>
      ${hasChoice?`<div class="k-ord-menu">А — ${escHtml(menuDay.second||'')} · Б — ${escHtml(menuDay.second2||'')}</div>`:''}
      <table class="k-table k-ord"><thead><tr>
        <th>Учень</th>${hasBrkMenu?'<th>Снід.</th>':''}<th>Обід</th>${hasChoice?'<th>Варіант</th>':''}<th>Підвеч.</th><th>Примітка</th></tr></thead><tbody>
        ${rows.map(r=>`<tr class="${r.absent?'k-ord-abs':''}">
          <td>${escHtml(r.name)}</td>
          ${hasBrkMenu?`<td>${r.breakfast?'<span class="k-yes">✓</span>':'<span class="k-no">—</span>'}</td>`:''}
          <td>${r.lunch?'<span class="k-yes">✓</span>':'<span class="k-no">—</span>'}</td>
          ${hasChoice?`<td>${r.pick?`<span class="k-ab ${r.pick}">${r.pick.toUpperCase()}</span>`:'<span class="k-no">—</span>'}</td>`:''}
          <td>${r.snack?'<span class="k-yes">✓</span>':'<span class="k-no">—</span>'}</td>
          <td class="k-ord-note">${escHtml(r.note)}</td></tr>`).join('')}
      </tbody></table>
      <button onclick="exportClassOrders()" style="background:#e0f7fa;color:#00838f;border:1px solid #80deea;margin-top:11px;">📄 Вивантажити CSV</button>`;
  }catch(e){
    box.innerHTML = `<p style="color:red;font-size:.8rem;">Помилка: ${escHtml(e.message)}</p>`;
  }
};
window.exportClassOrders = function(){
  const o = window.__classOrders;
  if(!o) return;
  const csv = ['Учень;Сніданок;Обід;Варіант;Підвечірок;Примітка',
    ...o.rows.map(r=>`${r.name};${r.breakfast?'так':'ні'};${r.lunch?'так':'ні'};${r.pick?r.pick.toUpperCase():'—'};${r.snack?'так':'ні'};${r.note}`)].join('\n');
  const blob = new Blob(['\ufeff'+csv], {type:'text/csv;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `zamovlennya_${o.cls}_${o.date}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
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
    const tot = rows.reduce((a,r)=>({lunch:a.lunch+r.lunch, snack:a.snack+r.snack, brk:a.brk+(r.brk||0)}),{lunch:0,snack:0,brk:0});
    const byClass = {};
    rows.forEach(r=>{ byClass[r.cls] = byClass[r.cls] || {lunch:0,snack:0,brk:0}; byClass[r.cls].lunch+=r.lunch; byClass[r.cls].snack+=r.snack; byClass[r.cls].brk+=(r.brk||0); });
    box.innerHTML = `
      <div class="k-total"><b>${tot.lunch}</b><span>людино-днів з обідом</span>
        <div class="k-total-snack">${tot.brk?`${tot.brk} зі сніданком · `:''}+ ${tot.snack} з підвечірком</div></div>
      <div class="k-sub">${escHtml(human(from))} — ${escHtml(human(to))}</div>
      <table class="k-table"><thead><tr><th>Клас</th><th>Снід.</th><th>Обіди</th><th>Підвеч.</th></tr></thead><tbody>
        ${Object.keys(byClass).sort((a,b)=>a-b).map(c=>`<tr><td>${c}</td><td>${byClass[c].brk||''}</td><td><b>${byClass[c].lunch}</b></td><td>${byClass[c].snack||''}</td></tr>`).join('')}
      </tbody></table>
      <div class="k-skip-title">Поіменно</div>
      <table class="k-table"><thead><tr><th>Учень</th><th>Кл.</th><th>Снід.</th><th>Обіди</th><th>Підвеч.</th></tr></thead><tbody>
        ${rows.sort((a,b)=>b.lunch-a.lunch || a.name.localeCompare(b.name,'uk'))
              .map(r=>`<tr><td>${escHtml(r.name)}</td><td>${r.cls}</td><td>${r.brk||''}</td><td><b>${r.lunch}</b></td><td>${r.snack||''}</td></tr>`).join('')}
      </tbody></table>
      <button onclick="exportMealStats()" style="background:#e0f7fa;color:#00838f;border:1px solid #80deea;margin-top:11px;">📄 Вивантажити CSV</button>`;
    window.__mealStats = { from, to, rows };
  }catch(e){
    box.innerHTML = `<p style="color:red;font-size:.8rem;">Помилка: ${escHtml(e.message)}</p>`;
  }
};

// Спільний рахунок для кухні і для батьків. onlyCls/onlyName звужують вибірку.
export async function computeMealStats(from, to, onlyCls, onlyName){
  // Обидва вузли ключуються датою, тож просимо лише обраний період.
  // Раніше статистика за тиждень качала весь навчальний рік.
  const [stSnap, planSnap, att, days] = await Promise.all([
    get(child(ref(db),'students_list')),
    get(child(ref(db),'meal_plan')),
    getSchoolRange('attendance', from, to),
    getDateRange('meal_day', from, to)
  ]);
  const students = stSnap.exists()?stSnap.val():{};
  const plans    = planSnap.exists()?planSnap.val():{};

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
      if(onlyName && name !== onlyName && key !== onlyName) continue;
      const plan = plans[cls] && plans[cls][key];
      let lunch=0, snack=0, brk=0, absent=0;
      dateList.forEach(date=>{
        const isAbsent = !!absentSet(att[cls] && att[cls][date])[key];
        const ov = days[date] && days[date][cls] && days[date][cls][key];
        const e = effectiveMeals(plan, ov, isAbsent, weekdayIdx(date));
        if(e.absent){ absent++; return; }
        if(e.lunch) lunch++;
        if(e.snack) snack++;
        if(e.breakfast) brk++;
      });
      if(lunch || snack || brk) out.push({ cls:i, name, lunch, snack, brk, absent, days:dateList.length });
    }
  }
  return out;
}

window.exportMealStats = function(){
  const s = window.__mealStats;
  if(!s) return;
  const csv = ['Учень;Клас;Сніданки;Обіди;Підвечірки',
    ...s.rows.map(r=>`${r.name};${r.cls};${r.brk||0};${r.lunch};${r.snack}`)].join('\n');
  const blob = new Blob(['﻿'+csv], {type:'text/csv;charset=utf-8'});   // BOM — щоб Excel не ламав кирилицю
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `harchuvannya_${s.from}_${s.to}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
};

// Перевірка налаштувань: показує, на якому саме кроці рветься ланцюжок,
// замість того щоб мовчки надіслати нуль сповіщень.
window.checkNotifySetup = async function(){
  // Кнопка є і в кухні, і в кабінеті директора — беремо той блок,
  // який зараз на екрані
  const box = ['k-notify-info-2','k-notify-info']
    .map(id => document.getElementById(id))
    .find(el => el && el.closest('.panel') && el.closest('.panel').style.display !== 'none')
    || document.getElementById('k-notify-info');
  if(!box) return;
  box.style.display = 'block';
  box.className = 'k-notify';
  box.textContent = 'Перевіряю...';
  const steps = [];
  // 1. Ключ у браузері
  if(!pushConfigured){
    box.className = 'k-notify bad';
    box.textContent = '1️⃣ VAPID-ключ не вставлено у common.js — підписатися не може ніхто. Решту перевіряти немає сенсу.';
    return;
  }
  steps.push('1️⃣ VAPID-ключ на місці');
  // 2. Сервер, ключі Netlify і доступ до бази
  let r;
  try{
    const res = await fetch('/.netlify/functions/notify',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ type:'menu', probe:true })
    });
    r = await res.json();
    if(!res.ok) throw new Error(r.error || `HTTP ${res.status}`);
  }catch(e){
    box.className = 'k-notify bad';
    box.textContent = `${steps.join(' · ')}\n2️⃣ Сервер сповіщень: ${e.message}`;
    return;
  }
  steps.push(`2️⃣ Сервер і база відповідають (проєкт ${r.project})`);
  // 3. Чи є кому слати
  if(!r.eligible){
    box.className = 'k-notify bad';
    box.textContent = `${steps.join(' · ')}\n3️⃣ Підписників немає: ${r.tokens} записів усього, з них батьків та учнів — 0. Хтось із батьків має зайти у свій кабінет і увімкнути сповіщення.`;
    return;
  }
  steps.push(`3️⃣ Підписників: ${r.eligible}`);

  // 4. Найголовніше — реальна відправка собі. Усі попередні кроки можуть
  //    бути зеленими, а сповіщення не дійти: наприклад, ключ не той, або
  //    цей браузер не підписаний.
  const mine = currentUserData?.email;
  if(!mine){
    box.className='k-notify ok'; box.textContent = steps.join(' · '); return;
  }
  const t = await notifyEvent('chat', { to:[mine], subject:'Перевірка', value:'тестове сповіщення' });
  if(!t || !t.ok){
    box.className='k-notify bad';
    box.textContent = `${steps.join(' · ')}\n4️⃣ Тестове сповіщення не надіслане: ${t && t.error || 'невідома помилка'}`;
    return;
  }
  if(!t.sent){
    box.className='k-notify bad';
    box.textContent = `${steps.join(' · ')}\n4️⃣ Сервер прийняв запит, але жоден пристрій не підписаний саме на цю пошту.\n`
      + 'Натисніть у своєму кабінеті кнопку увімкнення сповіщень і дозвольте їх у браузері.'
      + (t.firstError ? `\nВідповідь FCM: ${t.firstError}` : '');
    return;
  }
  box.className='k-notify ok';
  box.textContent = `${steps.join(' · ')}\n4️⃣ Тестове надіслано на ${t.sent} пристр. `
    + 'Якщо воно не зʼявилося — згорніть портал: коли вкладка відкрита, браузер показує не системне вікно, а спливаючу підказку всередині сторінки.';
};

// ═════════ БІК БАТЬКІВ ═════════
// Батьки бачили лише обрану дату. У вихідний або в день без меню це давало
// порожній блок і враження, що кухня нічого не опублікувала. Тепер показуємо
// смужку робочих днів тижня і самі перемикаємось на найближчий день із меню.
let pmDate = null;   // який день зараз відкритий у блоці харчування
window.pmShowDay = function(d){ pmDate = d; renderParentMenu(); renderTakeaway(d); };

// Другий аргумент — КЛЮЧ учня (постійний ідентифікатор), а не імʼя
export async function renderParentMenu(cls, studentKey, date){
  const box = document.getElementById('p-menu');
  if(!box) return;
  cls = cls || currentUserData?.class;
  studentKey = studentKey || currentUserData?.studentId || currentUserData?.studentName;
  if(!cls || !studentKey) return;

  try{
    // Явно передана дата (зміна дати в кабінеті) скидає ручний вибір дня
    if(date) pmDate = null;
    // Вихідний зсуваємо на найближчий робочий день, інакше тижня просто немає
    const anchor = date || pmDate || localDateString;
    const wda = weekdayIdx(anchor);
    const monday = mondayOf(wda===0 || wda===6 ? nextWorkday(anchor) : anchor);
    const week = weekDates(monday);
    const menus = await Promise.all(week.map(d=>get(child(ref(db),`menu/${d}`))));
    // День вважаємо заповненим, якщо є хоч одна страва. Раніше тут
    // перевірялися лише перша й друга — день, у якому кухня вписала
    // тільки сніданок чи підвечірок, вважався порожнім.
    const has = week.map((d,i)=>{
      if(!menus[i].exists()) return false;
      const v = menus[i].val() || {};
      return !!(v.first || v.second || v.second2 || v.breakfast || v.snack);
    });

    // Якщо день не обирали вручну — відкриваємо сьогоднішній, а як його
    // немає в цьому тижні або він порожній, то перший день із меню.
    // ЯКИЙ ДЕНЬ ВІДКРИВАТИ.
    //
    // Останнім варіантом раніше стояв week[0] — понеділок. Через це, поки
    // кухня не заповнила меню на тиждень, блок харчування завжди відкривався
    // на понеділку, хоч би який був день. Виглядало як «застряг».
    //
    // Тепер запасний варіант — СЬОГОДНІ (а на вихідних найближчий робочий
    // день), бо саме сьогоднішній день людині й потрібен.
    const todayInWeek = week.includes(localDateString) ? localDateString : null;
    const fallback = todayInWeek || week.find(d => d >= localDateString) || week[0];
    let cur = pmDate && week.includes(pmDate) ? pmDate
            : (todayInWeek && has[week.indexOf(todayInWeek)] ? todayInWeek
            : (week.find((d,i)=>has[i] && d >= localDateString) || week.find((d,i)=>has[i]) || fallback));
    pmDate = cur;
    const ci = week.indexOf(cur);
    const m = menus[ci].exists() ? menus[ci].val() : null;

    const [planSnap, daySnap, attSnap] = await Promise.all([
      get(child(ref(db),`meal_plan/${cls}/${studentKey}`)),
      get(child(ref(db),`meal_day/${cur}/${cls}/${studentKey}`)),
      get(child(ref(db),`attendance/${cls}/${cur}/${studentKey}`))
    ]);
    const plan = planSnap.exists()?planSnap.val():{};
    const ov   = daySnap.exists()?daySnap.val():null;
    const isAbsent = attSnap.exists() && Object.values(attSnap.val()||{}).some(r=>r && r.status==='absent');
    const eff  = effectiveMeals(plan, ov, isAbsent, weekdayIdx(cur));
    const gate = mealsEditable(cur);
    const notEating = plan.lunch === false;
    const noAnswer  = !lunchChosen(plan);   // батько ще не відповів про обіди

    const strip = week.map((d,i)=>`<button type="button" class="pm-tab${d===cur?' on':''}${has[i]?'':' empty'}"
        onclick="pmShowDay('${escJs(d)}')">
        <span>${DOW_SHORT[i]}</span><b>${escHtml(human(d).slice(0,5))}</b></button>`).join('');

    const pick = pickedSecond(m, ov);              // 'a' | 'b' | null
    const bGate = breakfastEditable(cur);
    const hasBrk = !!(m && String(m.breakfast||'').trim());

    // Друге виводимо окремо: коли є варіант Б, це вже не рядок меню,
    // а вибір, і виглядати він має інакше.
    const dishes = ['first','side','drink','dessert']
      .filter(k=>m && m[k]).map(k=>`<div class="pm-dish">${escHtml(m[k])}</div>`).join('');
    const secondBlock = !m ? '' : (pick
      ? `<div class="pm-choice">
           <div class="pm-choice-title">Оберіть основну страву${gate.ok?'':' — вибір закрито'}</div>
           ${['a','b'].map(v=>`
             <button type="button" class="pm-opt${pick===v?' on':''}"
                     ${gate.ok?`onclick="setMealDay('${escJs(cur)}','pick','${v}')"`:'disabled'}>
               <span class="pm-opt-mark">${v.toUpperCase()}</span>
               <span class="pm-opt-name">${escHtml(v==='a'?m.second:m.second2)}</span>
               ${pick===v?'<span class="pm-opt-on">обрано</span>':''}
             </button>`).join('')}
         </div>`
      : (m.second ? `<div class="pm-dish">${escHtml(m.second)}</div>` : ''));

    // Збираємо рядок стану й кнопки заздалегідь: три рівні вкладених
    // шаблонів у розмітці нечитабельні й ламаються при першій же правці.
    const chip = (on, textOn, textOff, cls='pm-dim') =>
      `<span class="${on?'pm-on':cls}">${on?textOn:textOff}</span>`;
    const statusLine =
      (hasBrk ? chip(eff.breakfast, '✓ Сніданок', 'без сніданку') : '') +
      chip(eff.lunch, '✓ Обід',
           noAnswer ? 'Обіди не підтверджені' : (notEating ? 'Обіди не замовлені' : '✕ Без обіду'),
           'pm-off') +
      chip(eff.snack, '✓ Підвечірок', 'без підвечірка');

    const lunchBtns = gate.ok
      ? ((notEating || noAnswer) ? '' : `<button class="pm-btn ${eff.lunch?'':'back'}" onclick="setMealDay('${escJs(cur)}','lunch',${eff.lunch?0:1})">${eff.lunch?'Не буде обідати':'Поверну обід'}</button>`)
        + `<button class="pm-btn snack" onclick="setMealDay('${escJs(cur)}','snack',${eff.snack?0:1})">${eff.snack?'Без підвечірка':'+ Підвечірок'}</button>`
      : `<span class="pm-locked">🔒 ${escHtml(gate.msg)}</span>`;
    const brkBtn = !hasBrk ? ''
      : (bGate.ok
          ? `<button class="pm-btn brk" onclick="setMealDay('${escJs(cur)}','breakfast',${eff.breakfast?0:1})">${eff.breakfast?'Без сніданку':'+ Сніданок'}</button>`
          : `<span class="pm-locked small">🔒 ${escHtml(bGate.msg)}</span>`);
    const actions = lunchBtns + brkBtn;

    // ПИТАННЯ ПРО ОБІДИ. Поки батько не відповів, кухня цю дитину не
    // рахує — тож питання має бути помітним, а не рядком у налаштуваннях.
    const askLunch = !noAnswer ? '' : `
      <div class="pm-ask">
        <b>Ваша дитина обідає в школі?</b>
        <span>Поки ви не відповіли, обіди на неї не замовляються.</span>
        <div class="pm-ask-btns">
          <button type="button" class="pm-ask-yes" onclick="setLunchPlan(1)">Так, обідає</button>
          <button type="button" class="pm-ask-no"  onclick="setLunchPlan(0)">Ні, не обідає</button>
        </div>
        <small>Відповідь можна змінити будь-коли в налаштуваннях харчування.</small>
      </div>`;

    box.innerHTML = `
      ${askLunch}
      <div class="pm-tabs">${strip}</div>
      <div class="pm-title">${escHtml(DOW[ci])}, ${escHtml(human(cur))}${cur===localDateString?' — сьогодні':''}</div>
      ${(dishes || secondBlock) ? dishes + secondBlock : '<div class="pm-none">Меню на цей день ще не опубліковане</div>'}
      ${hasBrk ? `<div class="pm-snack"><b>🌅 Сніданок:</b> ${escHtml(m.breakfast)}</div>` : ''}
      ${m && m.snack ? `<div class="pm-snack"><b>🥪 Підвечірок:</b> ${escHtml(m.snack)}</div>` : ''}
      ${m && m.allergens ? `<div class="pm-allerg">⚠️ ${escHtml(m.allergens)}</div>` : ''}
      ${m && m.note ? `<div class="pm-note">${escHtml(m.note)}</div>` : ''}

      <div class="pm-status">
        ${isAbsent
          ? '<span class="pm-off">Дитина відсутня — харчування цього дня не рахується</span>'
          : statusLine}
      </div>

      ${isAbsent ? '' : `<div class="pm-act">${actions}</div>`}

      <div class="pm-links">
        <a href="#" onclick="event.preventDefault();openMealSettings();">⚙️ Налаштування харчування</a>
        <a href="#" onclick="event.preventDefault();openMyMealStats();">📊 Моя статистика</a>
      </div>`;
    renderTakeaway(cur);
  }catch(e){
    box.innerHTML = `<div class="pm-none">Не вдалося завантажити меню: ${escHtml(e.message)}</div>`;
  }
}

window.setMealDay = async function(date, field, value){
  const cls = currentUserData?.class, sid = currentUserData?.studentId || currentUserData?.studentName;
  if(!cls || !sid) return;
  // У сніданку власний дедлайн: його готують до уроків, тож 09:00 не годиться
  const gate = field === 'breakfast' ? breakfastEditable(date) : mealsEditable(date);
  if(!gate.ok) return alert(gate.msg);
  let reason = '';
  if(field==='lunch' && !value){
    reason = prompt('Причина (необовʼязково):','') || '';
    if(reason === null) return;
  }
  const path = `meal_day/${date}/${cls}/${sid}`;
  const snap = await get(child(ref(db), path));
  const cur = snap.exists()?snap.val():{};
  // pick зберігає літеру варіанта, решта полів — 0/1
  if(field === 'pick') cur.pick = (value === 'b') ? 'b' : 'a';
  else cur[field] = value ? 1 : 0;
  if(reason) cur.reason = reason.trim().slice(0,120);
  cur.by = currentUserData.email || ''; cur.ts = Date.now();
  await set(ref(db, path), cur);
  showToast(field === 'pick'
    ? `✓ Обрано варіант ${String(value).toUpperCase()}`
    : (value ? '✓ Записано' : '✕ Відмову зафіксовано'));
  renderParentMenu();
};

// Постійні налаштування дитини — тут батько може зняти її з харчування зовсім
window.openMealSettings = async function(){
  const cls = currentUserData?.class, sid = currentUserData?.studentId || currentUserData?.studentName;
  if(!cls || !sid) return;
  const snap = await get(child(ref(db),`meal_plan/${cls}/${sid}`));
  const p = snap.exists()?snap.val():{};
  // Галочка відображає РЕАЛЬНИЙ стан. Раніше вона стояла увімкненою
  // навіть тоді, коли батько нічого не обирав, — і виглядало це так,
  // ніби обіди вже замовлені.
  const lunch = p.lunch === true, snack = p.snack || 'no';
  const sd = p.snackDays || {};
  const brk = p.breakfast || 'no';          // за замовчуванням сніданків немає
  const bd = p.breakfastDays || {};
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
      ${DOW.map((d,i)=>`<label class="ms-day"><input type="checkbox" id="ms-d${i+1}" ${sd[i+1]?'checked':''}><span>${DOW_SHORT[i]}</span></label>`).join('')}
    </div>
    <label>🌅 Сніданок</label>
    <select id="ms-brk" onchange="msToggleDays()">
      <option value="no"${brk==='no'?' selected':''}>Не потрібен</option>
      <option value="all"${brk==='all'?' selected':''}>Щодня</option>
      <option value="days"${brk==='days'?' selected':''}>Лише в обрані дні</option>
    </select>
    <div id="ms-bdays" style="display:${brk==='days'?'flex':'none'};">
      ${DOW.map((d,i)=>`<label class="ms-day"><input type="checkbox" id="ms-b${i+1}" ${bd[i+1]?'checked':''}><span>${DOW_SHORT[i]}</span></label>`).join('')}
    </div>
    <p class="ms-note">Сніданок замовляють напередодні до ${BREAKFAST_CUTOFF_HOUR}:00 — його готують до уроків.</p>
    <p class="ms-note">Зміни діють від наступного дня. Разові відмови робіть кнопками в блоці харчування — до ${MEAL_CUTOFF_HOUR}:00.</p>`;
  document.getElementById('meal-settings-modal').style.display = 'flex';
};
window.msToggleDays = function(){
  const set = (selId, boxId) => {
    const sel = document.getElementById(selId), box = document.getElementById(boxId);
    if(sel && box) box.style.display = sel.value === 'days' ? 'flex' : 'none';
  };
  set('ms-snack','ms-days');
  set('ms-brk','ms-bdays');
};
window.saveMealSettings = async function(){
  const cls = currentUserData?.class, sid = currentUserData?.studentId || currentUserData?.studentName;
  if(!cls || !sid) return;
  const snack = document.getElementById('ms-snack').value;
  const brk   = document.getElementById('ms-brk')?.value || 'no';
  const plan = {
    lunch: document.getElementById('ms-lunch').checked,
    snack, breakfast: brk,
    by: currentUserData.email || '', ts: Date.now()
  };
  const days = (prefix) => {
    const d = {};
    for(let i=1;i<=5;i++){
      const el = document.getElementById(prefix+i);
      if(el && el.checked) d[i] = true;
    }
    return d;
  };
  if(snack === 'days') plan.snackDays = days('ms-d');
  if(brk   === 'days') plan.breakfastDays = days('ms-b');
  await set(ref(db,`meal_plan/${cls}/${sid}`), plan);
  document.getElementById('meal-settings-modal').style.display = 'none';
  showToast('✅ Налаштування збережено');
  renderParentMenu();
};

window.openMyMealStats = async function(){
  const cls = currentUserData?.class, sid = currentUserData?.studentId || currentUserData?.studentName;
  if(!cls || !sid) return;
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
  const cls = currentUserData?.class, sid = currentUserData?.studentId || currentUserData?.studentName;
  const body = document.getElementById('meal-stats-body');
  const from = document.getElementById('pms-from').value;
  const to   = document.getElementById('pms-to').value;
  if(!body || !from || !to) return;
  body.innerHTML = '<p class="empty-msg">Рахуємо...</p>';
  const rows = await computeMealStats(from, to, cls, sid);
  const r = rows[0] || { lunch:0, snack:0, brk:0, absent:0, days:0 };
  body.innerHTML = `
    <div class="pms-grid">
      <div class="pms-cell"><b>${r.lunch}</b><span>днів з обідом</span></div>
      <div class="pms-cell"><b>${r.snack}</b><span>з підвечірком</span></div>
      <div class="pms-cell"><b>${r.brk||0}</b><span>зі сніданком</span></div>
      <div class="pms-cell"><b>${r.absent||0}</b><span>днів відсутності</span></div>
    </div>
    <p class="ms-note">Період: ${escHtml(human(from))} — ${escHtml(human(to))}. Рахуються лише робочі дні.
    Дні, коли дитина була відсутня, до харчування не зараховуються.</p>`;
};

// ═══════════ ПОЗИЦІЇ НА ВИНОС ═══════════
// ЩО ЦЕ. Окремий від меню асортимент: випічка, салати, супи в контейнері.
// Кухня веде список, батьки замовляють на конкретний день, кухня бачить
// зведення й пакує.
//
// ЧОМУ ЦІНА Є, А ОПЛАТИ НЕМАЄ. Ціну треба показати — інакше батько не
// розуміє, на що погоджується. Але гроші приймає школа, як і раніше:
// портал лише рахує суму. Вводити платежі заради буфету — зайве.
//
// ДЕДЛАЙН той самий, що й для обіду: пакують разом із ним.
//
//   takeaway_items/{id}  = {title, price, active, note, by, ts}
//   takeaway_orders/{дата}/{клас}/{ID}/{itemId} = кількість
const TA_MAX_QTY = 9;   // більше — це вже опт, домовляються окремо

const taMoney = (v) => (Math.round(Number(v||0)*100)/100).toFixed(2);

// ── Кабінет кухні: список позицій ──
export async function loadTakeawayItems(){
  const box = document.getElementById('k-ta-items');
  if(!box) return;
  box.innerHTML = '<p class="empty-msg">Завантаження...</p>';
  try{
    const snap = await get(child(ref(db),'takeaway_items'));
    const items = snap.exists() ? snap.val() : {};
    const ids = Object.keys(items);
    box.innerHTML = ids.length ? ids.map(id=>{
      const it = items[id] || {};
      return `<div class="ta-item${it.active===false?' off':''}">
        <div class="ta-item-main">
          <b>${escHtml(it.title||'')}</b>
          ${it.note?`<span class="ta-item-note">${escHtml(it.note)}</span>`:''}
        </div>
        <span class="ta-price">${taMoney(it.price)} zł</span>
        <button class="ta-mini" onclick="toggleTakeawayItem('${escJs(id)}',${it.active===false})">
          ${it.active===false?'Увімкнути':'Вимкнути'}</button>
        <button class="ta-mini del" onclick="removeTakeawayItem('${escJs(id)}')">✕</button>
      </div>`;
    }).join('') : '<p class="empty-msg">Позицій ще немає.</p>';
  }catch(e){
    box.innerHTML = `<p class="empty-msg" style="color:var(--red);">Не вдалося завантажити: ${escHtml(e.message)}</p>`;
  }
}
window.loadTakeawayItems = loadTakeawayItems;

window.addTakeawayItem = async function(){
  const t = document.getElementById('k-ta-title');
  const p = document.getElementById('k-ta-price');
  const n = document.getElementById('k-ta-note');
  const title = (t?.value||'').trim();
  const price = Number(String(p?.value||'').replace(',','.'));
  if(!title) return alert('Напишіть назву позиції.');
  if(!(price >= 0)) return alert('Ціна має бути числом.');
  try{
    const id = 'ta_' + Date.now().toString(36);
    await set(ref(db,`takeaway_items/${id}`), {
      title: title.slice(0,80),
      price: Math.round(price*100)/100,
      note: (n?.value||'').trim().slice(0,120),
      active: true,
      by: currentUserData?.email || '', ts: Date.now()
    });
    if(t) t.value=''; if(p) p.value=''; if(n) n.value='';
    showToast('✅ Позицію додано');
    loadTakeawayItems();
  }catch(e){ alert('Не вдалося додати: ' + e.message); }
};

window.toggleTakeawayItem = async function(id, on){
  try{
    await update(ref(db,`takeaway_items/${id}`), { active: !!on, ts: Date.now() });
    loadTakeawayItems();
  }catch(e){ alert('Не вдалося змінити: ' + e.message); }
};

window.removeTakeawayItem = async function(id){
  if(!confirm('Прибрати позицію зі списку?\n\nВже зроблені замовлення лишаться в зведенні.')) return;
  try{
    await set(ref(db,`takeaway_items/${id}`), null);
    loadTakeawayItems();
  }catch(e){ alert('Не вдалося прибрати: ' + e.message); }
};

// ── Кабінет кухні: що замовили на день ──
window.loadTakeawayOrders = async function(){
  const date = document.getElementById('k-ta-date')?.value || localDateString;
  const box  = document.getElementById('k-ta-orders');
  if(!box) return;
  box.innerHTML = '<p class="empty-msg">Завантаження...</p>';
  try{
    const [itSnap, ordSnap, stSnap] = await Promise.all([
      get(child(ref(db),'takeaway_items')),
      get(child(ref(db),`takeaway_orders/${date}`)),
      get(child(ref(db),'students_list'))
    ]);
    const items = itSnap.exists()?itSnap.val():{};
    const orders = ordSnap.exists()?ordSnap.val():{};
    const students = stSnap.exists()?stSnap.val():{};

    const totals = {};          // itemId → кількість
    const rows = [];            // рядки «хто що замовив»
    let sum = 0;
    for(const cls in orders){
      for(const sid in orders[cls]){
        const picks = orders[cls][sid] || {};
        const list = [];
        for(const itemId in picks){
          const qty = Number(picks[itemId]) || 0;
          if(qty <= 0) continue;
          totals[itemId] = (totals[itemId]||0) + qty;
          const it = items[itemId] || {};
          sum += qty * Number(it.price||0);
          list.push(`${escHtml(it.title||itemId)}${qty>1?` ×${qty}`:''}`);
        }
        if(list.length) rows.push({
          cls: cls.replace('class_',''),
          name: (students[cls] && students[cls][sid]) || sid,
          what: list.join(', ')
        });
      }
    }
    rows.sort((a,b)=> (a.cls-b.cls) || String(a.name).localeCompare(String(b.name),'uk'));
    const tKeys = Object.keys(totals);

    box.innerHTML = !tKeys.length
      ? '<p class="empty-msg">На цей день замовлень немає.</p>'
      : `<div class="k-ord-sum"><b>${tKeys.reduce((a,k)=>a+totals[k],0)}</b> позицій · ${taMoney(sum)} zł
           <span>${escHtml(human(date))}</span></div>
         <table class="k-table"><thead><tr><th>Позиція</th><th>К-сть</th><th>Сума</th></tr></thead><tbody>
           ${tKeys.map(k=>`<tr><td>${escHtml((items[k]||{}).title||k)}</td><td><b>${totals[k]}</b></td>
             <td>${taMoney(totals[k]*Number((items[k]||{}).price||0))} zł</td></tr>`).join('')}
         </tbody></table>
         <div class="k-skip-title">Хто замовив</div>
         <table class="k-table"><thead><tr><th>Учень</th><th>Кл.</th><th>Замовлення</th></tr></thead><tbody>
           ${rows.map(r=>`<tr><td>${escHtml(r.name)}</td><td>${escHtml(String(r.cls))}</td><td>${r.what}</td></tr>`).join('')}
         </tbody></table>`;
  }catch(e){
    box.innerHTML = `<p class="empty-msg" style="color:var(--red);">Не вдалося завантажити: ${escHtml(e.message)}</p>`;
  }
};

// ── Кабінет батьків: замовлення на обраний день ──
export async function renderTakeaway(date){
  const box = document.getElementById('p-takeaway');
  if(!box) return;
  const cls = currentUserData?.class;
  const sid = currentUserData?.studentId || currentUserData?.studentName;
  if(!cls || !sid){ box.innerHTML = ''; return; }
  const day = date || pmDate || localDateString;
  try{
    const [itSnap, ordSnap] = await Promise.all([
      get(child(ref(db),'takeaway_items')),
      get(child(ref(db),`takeaway_orders/${day}/${cls}/${sid}`))
    ]);
    const items = itSnap.exists()?itSnap.val():{};
    const mine  = ordSnap.exists()?ordSnap.val():{};
    const ids = Object.keys(items).filter(id => items[id] && items[id].active !== false);
    if(!ids.length){ box.innerHTML = ''; return; }     // кухня нічого не продає — розділу немає

    const gate = mealsEditable(day);
    let sum = 0;
    ids.forEach(id=>{ sum += (Number(mine[id])||0) * Number(items[id].price||0); });

    box.innerHTML = `
      <div class="ta-head">🥡 Замовити на винос <span>${escHtml(human(day))}</span></div>
      ${ids.map(id=>{
        const it = items[id], q = Number(mine[id])||0;
        return `<div class="ta-row${q?' on':''}">
          <div class="ta-row-main">
            <b>${escHtml(it.title||'')}</b>
            ${it.note?`<span class="ta-item-note">${escHtml(it.note)}</span>`:''}
          </div>
          <span class="ta-price">${taMoney(it.price)} zł</span>
          ${gate.ok ? `<div class="ta-qty">
            <button onclick="setTakeaway('${escJs(day)}','${escJs(id)}',${q-1})" ${q?'':'disabled'}>−</button>
            <span>${q}</span>
            <button onclick="setTakeaway('${escJs(day)}','${escJs(id)}',${q+1})" ${q>=TA_MAX_QTY?'disabled':''}>+</button>
          </div>` : `<span class="ta-qty-locked">${q||0}</span>`}
        </div>`;
      }).join('')}
      <div class="ta-sum">${sum>0?`До сплати: <b>${taMoney(sum)} zł</b>`:'Нічого не замовлено'}
        <span>Оплата — у школі, як завжди</span></div>
      ${gate.ok ? '' : `<div class="ta-locked">🔒 ${escHtml(gate.msg)}</div>`}`;
  }catch(e){
    box.innerHTML = `<div class="pm-none">Не вдалося завантажити позиції: ${escHtml(e.message)}</div>`;
  }
}
window.renderTakeaway = renderTakeaway;

window.setTakeaway = async function(date, itemId, qty){
  const cls = currentUserData?.class;
  const sid = currentUserData?.studentId || currentUserData?.studentName;
  if(!cls || !sid) return;
  const gate = mealsEditable(date);
  if(!gate.ok) return alert(gate.msg);
  const q = Math.max(0, Math.min(TA_MAX_QTY, Number(qty)||0));
  try{
    // 0 прибирає запис зовсім, щоб у базі не накопичувалися нулі
    await set(ref(db,`takeaway_orders/${date}/${cls}/${sid}/${itemId}`), q>0 ? q : null);
    renderTakeaway(date);
  }catch(e){ alert('Не вдалося зберегти: ' + e.message); }
};

// Відповідь на питання «дитина обідає в школі». Пишемо лише поле lunch,
// не чіпаючи налаштування сніданків і підвечірків, які батько міг уже
// задати: set перезаписав би весь вузол.
window.setLunchPlan = async function(yes){
  const cls = currentUserData?.class;
  const sid = currentUserData?.studentId || currentUserData?.studentName;
  if(!cls || !sid) return;
  try{
    await update(ref(db, `meal_plan/${cls}/${sid}`), {
      lunch: !!yes, by: currentUserData.email || '', ts: Date.now()
    });
    showToast(yes ? '✅ Обіди замовлено' : 'Обіди не замовляються');
    renderParentMenu();
  }catch(e){
    alert('Не вдалося зберегти: ' + e.message);
  }
};
