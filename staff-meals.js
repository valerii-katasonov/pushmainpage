// ═══════════════════════════════════════════════════════════════
// staff-meals.js — харчування персоналу: обід і винос.
//
// НАВІЩО. Учителі й директор їдять у тій самій їдальні, але замовляти
// могли тільки усно: кухня тримала їхні обіди в голові або на папірці.
// Тепер вони роблять це так само, як батьки — і потрапляють у той самий
// підрахунок.
//
// ── ЩО ТУТ ІНАКШЕ, НІЖ У ДІТЕЙ ─────────────────────────────────
//
// У дитини є клас і постійний ключ у списку класу; у вчителя немає ні
// того, ні іншого — його ключ це пошта. Тому дані лежать окремо:
//
//   staff_meals/{пошта}            = {lunch:bool, ts}
//   staff_meal_day/{дата}/{пошта}  = {lunch:0|1, pick:'a'|'b', ts}
//   takeaway_orders/{дата}/staff/{пошта}/{позиція} = кількість
//
// Винос свідомо лежить у ТІЙ САМІЙ гілці, що й у родин, під
// псевдокласом 'staff': кухня перебирає замовлення по класах, і так
// персонал з'являється в її списку сам, без другого підрахунку. А ось
// обіди рознесено — правила харчування дітей звіряють клас і ключ учня,
// і домішувати туди людину без класу означало б у кожному рядку тих
// правил дописувати «або персонал».
//
// ── ЩО ТУТ ПРОСТІШЕ ────────────────────────────────────────────
//
// Ні сніданків, ні підвечірків: це дитячі позиції, і кухня персоналу їх
// не пропонує. Ні відсутностей: учитель, який не прийшов, скасовує обід
// сам. Лишається обід, вибір А/Б і винос.
//
// ── ПРО ЦІНУ ───────────────────────────────────────────────────
//
// Дітям портал вартості не рахує — це справа школи й батьків. Персонал
// платить сам, тож ціна обіду потрібна, і її ставить кухня
// (meal_prices/staff). Поки вона не задана, суми просто не
// показуємо: нуль на екрані означав би «безкоштовно», а це не так.
// ═══════════════════════════════════════════════════════════════
import { ref, get, child, update, set } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, auth, currentUserData, escHtml, escJs, showToast, localDateString,
         logAction, emailKey } from './common.js';
import { mealsEditable, choicePair, takeawayDay, takeawayEditable,
         menuAnchor, loadMealPrices } from './kitchen.js';

// Ключ співробітника — його пошта, тим самим способом, що й усюди в базі.
const myKey = () => emailKey(currentUserData?.email || auth.currentUser?.email || '');

// Хто взагалі бачить цей блок. Кухня не бачить: вона готує, а не замовляє
// через портал, і власний рядок у своєму ж підрахунку її тільки заплутає.
export function staffEats(role){
  return ['director','administrator','teacher','class_teacher','art_school_teacher',
          'music_teacher','master_class_teacher','psychologist','nurse','secretary'].includes(role);
}

const money = v => (Math.round(Number(v||0)*100)/100).toFixed(2).replace('.00','');
const human = ds => { const [,m,d] = String(ds).split('-'); return `${d}.${m}`; };
const DOW = ['Неділя','Понеділок','Вівторок','Середа','Четвер','Пʼятниця','Субота'];
const dowOf = ds => DOW[new Date(ds+'T12:00:00').getDay()] || '';

let smDate = null;           // день, який показано
let smPrice = null;          // ціна обіду, прочитана разом із рештою

// ── ЧИСТА ЧАСТИНА ───────────────────────────────────────────────
//
// Що саме замовлено на цей день: постійна відповідь плюс виняток дня.
// Відсутність запису означає «не замовляв»: на відміну від дітей, де
// обід — норма за замовчуванням, тут людина сама вирішує щодня, і
// мовчання не можна читати як «так» — інакше кухня приготує на всіх
// учителів школи, а прийдуть троє.
export function staffLunchOn(plan, dayRec){
  if(dayRec && dayRec.lunch !== undefined) return !!Number(dayRec.lunch);
  return !!(plan && plan.lunch);
}

// Сума за день: обід (якщо ціна задана) плюс винос.
export function staffDaySum({ lunchOn, price, order, items }){
  let sum = lunchOn && price ? Number(price) : 0;
  for(const id in (order || {})){
    const q = Number(order[id]) || 0;
    if(q <= 0) continue;
    sum += q * Number((items && items[id] && items[id].price) || 0);
  }
  return Math.round(sum * 100) / 100;
}

// ── ПОКАЗ ───────────────────────────────────────────────────────

window.smShowDay = function(d){ smDate = d; renderStaffMeals(); };

export async function renderStaffMeals(){
  // Кабінети всіх ролей лежать у розмітці одночасно, тож блок шукаємо за
  // класом і наповнюємо ВСІ: у директора з другою роллю вчителя видимий
  // кабінет може змінитися без перезавантаження сторінки.
  const boxes = [...document.querySelectorAll('.stm-box')];
  if(!boxes.length) return;
  const box = { set innerHTML(v){ boxes.forEach(b => b.innerHTML = v); } };
  if(!staffEats(currentUserData?.role)){ box.innerHTML = ''; return; }
  const se = myKey();
  if(!se){ box.innerHTML = '<div class="pm-none">Не вдалося визначити вашу пошту.</div>'; return; }

  // Після 17:00 показуємо вже завтрашній день — з тієї ж причини, що й
  // батькам: сьогоднішній обід давно з'їдено.
  const day = smDate || menuAnchor(localDateString, new Date().getHours());
  box.innerHTML = '<p class="empty-msg">Завантаження...</p>';

  try{
    const [menuSnap, planSnap, daySnap, priceSnap, itSnap, ordSnap] = await Promise.all([
      get(child(ref(db), `menu/${day}`)),
      get(child(ref(db), `staff_meals/${se}`)),
      get(child(ref(db), `staff_meal_day/${day}/${se}`)),
      loadMealPrices(true),
      get(child(ref(db), 'takeaway_items')),
      get(child(ref(db), `takeaway_orders/${day}/staff/${se}`))
    ]);
    const m     = menuSnap.exists() ? menuSnap.val() : null;
    const plan  = planSnap.exists() ? planSnap.val() : {};
    const dayR  = daySnap.exists() ? daySnap.val() : null;
    // Ціна обіду для персоналу — з того самого вузла, що й дитячі:
    // одна форма в кухні, одне джерело, нічому розходитися.
    smPrice     = Number((priceSnap||{}).staff) || 0;
    const items = itSnap.exists() ? itSnap.val() : {};
    const order = ordSnap.exists() ? ordSnap.val() : {};

    const lunchOn = staffLunchOn(plan, dayR);
    const gate = mealsEditable(day);
    const choice = m ? choicePair(m) : null;
    const pick = dayR && dayR.pick ? dayR.pick : 'a';

    const dish = m ? [
      m.first  ? `<div class="stm-dish"><span>Перше</span><b>${escHtml(m.first)}</b></div>` : '',
      choice
        ? `<div class="stm-choice">
             <button type="button" class="stm-ab${pick==='a'?' on':''}"
               ${gate.ok?`onclick="smPick('${escJs(day)}','a')"`:'disabled'}>А · ${escHtml(choice.a)}</button>
             <button type="button" class="stm-ab${pick==='b'?' on':''}"
               ${gate.ok?`onclick="smPick('${escJs(day)}','b')"`:'disabled'}>Б · ${escHtml(choice.b)}</button>
           </div>`
        : (m.second ? `<div class="stm-dish"><span>Друге</span><b>${escHtml(m.second)}</b></div>` : ''),
      m.side   ? `<div class="stm-dish"><span>Гарнір</span><b>${escHtml(m.side)}</b></div>` : '',
      m.drink  ? `<div class="stm-dish"><span>Напій</span><b>${escHtml(m.drink)}</b></div>` : ''
    ].join('') : '';

    // Кнопка одна, з двома станами: «беру» і «не беру». Два окремі
    // перемикачі тут зайві — у персоналу немає постійного плану за
    // замовчуванням, є рішення на день.
    const btn = gate.ok
      ? `<button type="button" class="stm-take${lunchOn?' on':''}"
           onclick="smSetLunch('${escJs(day)}',${lunchOn?0:1})">
           ${lunchOn ? '✓ Обід замовлено — скасувати' : '🍽 Беру обід цього дня'}
         </button>`
      : `<span class="pm-locked">🔒 ${escHtml(gate.msg)}</span>`;

    // Винос — ті самі позиції, що й у батьків, і та сама гілка в базі.
    const taIds = Object.keys(items).filter(id => items[id] && items[id].active !== false);
    const taGateDay = (() => { const f = takeawayDay(); return day > f ? day : f; })();
    const taGate = takeawayEditable(taGateDay);
    const taRows = taIds.map(id => {
      const it = items[id], q = Number(order[id]) || 0;
      return `<div class="ta-row${q?' on':''}">
        <div class="ta-row-main"><b>${escHtml(it.title||'')}</b>
          ${it.note?`<span class="ta-item-note">${escHtml(it.note)}</span>`:''}</div>
        <span class="ta-price">${money(it.price)} zł</span>
        ${taGate.ok ? `<div class="ta-qty">
          <button onclick="smTakeaway('${escJs(taGateDay)}','${escJs(id)}',${q-1})" ${q?'':'disabled'}>−</button>
          <span>${q}</span>
          <button onclick="smTakeaway('${escJs(taGateDay)}','${escJs(id)}',${q+1})" ${q>=9?'disabled':''}>+</button>
        </div>` : `<span class="ta-qty-locked">${q||0}</span>`}
      </div>`;
    }).join('');

    const sum = staffDaySum({ lunchOn, price: smPrice, order, items });
    // Ціни немає — сум не показуємо взагалі. Нуль читався б як
    // «безкоштовно», а це рішення школи, а не порталу.
    const sumLine = (smPrice || Object.keys(order).length)
      ? `<div class="ta-sum">${sum>0?`До сплати: <b>${money(sum)} zł</b>`:'Нічого не замовлено'}
           <span>Оплата — у школі</span></div>`
      : '';

    box.innerHTML = `
      <div class="stm-nav">
        <button type="button" onclick="smShiftDay(-1)">←</button>
        <div class="stm-day"><b>${escHtml(dowOf(day))}, ${escHtml(human(day))}</b>
          ${day===localDateString?'<span>сьогодні</span>':''}</div>
        <button type="button" onclick="smShiftDay(1)">→</button>
      </div>
      ${m ? (dish || '<div class="pm-none">Меню на цей день порожнє</div>')
          : '<div class="pm-none">Меню на цей день ще не опубліковане</div>'}
      ${m && m.allergens ? `<div class="pm-allerg">⚠️ ${escHtml(m.allergens)}</div>` : ''}
      <div class="stm-act">${btn}</div>
      ${plan && plan.lunch
        ? `<div class="stm-plan">Ви обідаєте щодня. <a href="#" onclick="event.preventDefault();smSetPlan(0)">Скасувати постійне замовлення</a></div>`
        : `<div class="stm-plan">Обідаєте щодня? <a href="#" onclick="event.preventDefault();smSetPlan(1)">Замовляти автоматично</a></div>`}
      ${taIds.length ? `<div class="stm-ta">
        <div class="ta-head">🥡 На винос <span>${escHtml(human(taGateDay))}</span></div>
        ${taRows}
      </div>` : ''}
      ${sumLine}`;
  }catch(e){
    // Мовчазний спінер — головна повторювана вада порталу.
    box.innerHTML = `<div class="pm-none">Не вдалося завантажити: ${escHtml(e.message||'')}</div>`;
  }
}
window.renderStaffMeals = renderStaffMeals;

window.smShiftDay = function(delta){
  const base = smDate || menuAnchor(localDateString, new Date().getHours());
  const d = new Date(base + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  // Вихідні пропускаємо: школа в суботу не годує, і два порожні екрани
  // поспіль виглядають як поламаний портал.
  while(d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + (delta >= 0 ? 1 : -1));
  const p2 = n => String(n).padStart(2,'0');
  smDate = `${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())}`;
  renderStaffMeals();
};

window.smSetLunch = async function(day, value){
  const se = myKey();
  const gate = mealsEditable(day);
  if(!gate.ok) return alert(gate.msg);
  try{
    await update(ref(db, `staff_meal_day/${day}/${se}`), { lunch: value ? 1 : 0, ts: Date.now() });
    logAction('staff_meal', { value: `${day}: ${value ? 'обід' : 'відмова'}` });
    showToast(value ? '🍽 Обід замовлено' : 'Обід скасовано');
  }catch(e){ alert('Не вдалося зберегти: ' + e.message); }
  renderStaffMeals();
};

window.smPick = async function(day, which){
  const se = myKey();
  const gate = mealsEditable(day);
  if(!gate.ok) return alert(gate.msg);
  try{
    // Вибір страви сам по собі означає «беру обід»: інакше людина тисне
    // «Б» і не розуміє, чому її немає в замовленні.
    await update(ref(db, `staff_meal_day/${day}/${se}`), { pick: which, lunch: 1, ts: Date.now() });
  }catch(e){ alert('Не вдалося зберегти: ' + e.message); }
  renderStaffMeals();
};

window.smSetPlan = async function(value){
  const se = myKey();
  try{
    await update(ref(db, `staff_meals/${se}`), { lunch: !!value, ts: Date.now() });
    logAction('staff_meal', { value: value ? 'постійне замовлення' : 'постійне замовлення скасовано' });
    showToast(value ? '✓ Обід замовлятиметься щодня' : 'Постійне замовлення скасовано');
  }catch(e){ alert('Не вдалося зберегти: ' + e.message); }
  renderStaffMeals();
};

window.smTakeaway = async function(day, itemId, qty){
  const se = myKey();
  const gate = takeawayEditable(day);
  if(!gate.ok) return alert(gate.msg);
  const q = Math.max(0, Math.min(9, Number(qty) || 0));
  try{
    await set(ref(db, `takeaway_orders/${day}/staff/${se}/${itemId}`), q > 0 ? q : null);
  }catch(e){ alert('Не вдалося зберегти: ' + e.message); }
  renderStaffMeals();
};
