// ═══════════════════════════════════════════════════════════════
// kitchen.js — харчування: меню на тиждень, облік обідів і підвечірків.
//
// МОДЕЛЬ ДАНИХ
//   menu/{дата}                = {first,second,side,side2,drink,dessert,
//                                 allergens,note, snack,snackNote,
//                                 breakfast, breakfast2, by, ts, pub}
//        side2 — другий варіант гарніру. Порожнє поле означає,
//        що вибору того дня немає: кухня готує одне.
//        breakfast/breakfast2 — варіанти сніданку А/Б. breakfast2 необов’язковий.
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
//                                    pick:'a'|'b', breakfastPick:'a'|'b', reason, by, ts}
//        pick — варіант обіду; breakfastPick — незалежний варіант сніданку.
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
import { ref, set, get, child, update, remove, onValue } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, auth, currentUserData, showToast, escHtml, escJs, localDateString, logAction, notifyEvent, pushConfigured, renderPushWarning, getSchoolRange, sidOf, getStudentDir, resolveStudentKey, getDateRange, stuName, mondayOf } from './common.js';
import {renderMealOrphanList} from './meal-orphans.js';

export const MEAL_CUTOFF_HOUR = 9;   // до 09:00 можна відмовитися від сьогоднішнього
// Сніданок їдять до уроків, тож обідня межа для нього безглузда — його
// вже зʼїли. Приймаємо о годині нижче, тій самій, що й для позицій на
// винос. Обід лишається з власною, пізнішою межею: його готують із уже
// закупленого, і відмова за хвилину до неї нікому не шкодить.
export const BREAKFAST_CUTOFF_HOUR = 7;
// ПІДВЕЧІРОК — ВЛАСНА ГОДИНА, ХОЧ ЗАРАЗ ВОНА ЗБІГАЄТЬСЯ З ОБІДНЬОЮ.
//
// Правило школи: продукти на день кухня рахує один раз зранку, тож межа
// в підвечірка та сама, що в обіду.
//
// Стала все одно окрема, і навмисно. Раніше кнопка підвечірка жила під
// дедлайном ОБІДУ: зникала разом з обідньою, а замість неї ставав замок
// із текстом про обіди — до підвечірка він стосунку не мав, і виглядало
// це як «кнопка не працює». Поки година спільна, різниці не видно; щойно
// кухня їх розведе — тут одне число, а не пошук по всьому файлу, де саме
// підвечірок сплутали з обідом.
export const SNACK_CUTOFF_HOUR = 9;

// О КОТРІЙ БАТЬКАМ ПОКАЗУВАТИ ВЖЕ ЗАВТРАШНЄ МЕНЮ.
//
// Після сімнадцятої сьогоднішній обід давно з'їдено, і питання в батька
// одне: що буде завтра й чи треба щось замовити. Показувати йому меню
// дня, який скінчився, — марно займати екран.
//
// Це стосується ЛИШЕ того, який день відкривається за замовчуванням.
// Дедлайни замовлення живуть окремо (див. BREAKFAST_CUTOFF_HOUR вище) —
// плутати одне з одним не можна.
export const MENU_NEXT_DAY_HOUR = 17;
const DOW = ['Понеділок','Вівторок','Середа','Четвер','Пʼятниця'];
// Не slice(0,2) від повної назви: так виходило «По», «Ві», «Пʼ».
const DOW_SHORT = ['Пн','Вт','Ср','Чт','Пт'];

export const MENU_FIELDS = [
  // Збережено оригінальні ключі в базі даних: 'side' та 'side2' відповідають за Основна страва варіанти А та Б.
  // Це запобігає втраті вибору батьків (поле 'pick' у базі посилається на А чи Б у межах цієї пари).
  // Стару пару 'second'/'second2' прибрано, щоб розвантажити меню.
  { k:'first',     label:'Перша страва',  ph:'суп, напр. Борщ український' },
  { k:'side',      label:'Основна страва — варіант А', ph:'мʼясо/риба + гарнір, напр. Котлета з індички + рис' },
  { k:'side2',     label:'Основна страва — варіант Б', ph:'необовʼязково; заповніть, щоб дати вибір', choice:true },
  { k:'drink',     label:'Напій',         ph:'напр. Компот із сухофруктів' },
  { k:'breakfast',  label:'🌅 Сніданок — варіант А', ph:'окрема позиція; порожньо — сніданків цього дня немає', meal:true },
  { k:'breakfast2', label:'🌅 Сніданок — варіант Б', ph:'необов’язково; заповніть, щоб дати вибір', meal:true, choice:true },
  { k:'snack',     label:'🥪 Підвечірок', ph:'окрема позиція, напр. Сирник + какао', snack:true },
  { k:'allergens', label:'⚠️ Алергени',   ph:'напр. містить глютен, молоко', danger:true },
  { k:'note',      label:'Примітка',      ph:'необовʼязково' }
];

export function menuHasFood(menuDay){
  const m = menuDay || {};
  return !!(m.first || m.second || m.second2 || m.side || m.side2 ||
            m.breakfast || m.breakfast2 || m.snack);
}

// ── ДАТИ ──
const iso = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const human = s => s.split('-').reverse().join('.');
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
export function mealsEditable(dateStr, now = new Date(), today = localDateString){
  if(dateStr > today) return { ok:true };
  if(dateStr < today) return { ok:false, msg:'Цей день уже минув.' };
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
// ПРАВИЛО ШКОЛИ: сніданок на СЬОГОДНІ приймається до BREAKFAST_CUTOFF_HOUR.
//
// Раніше сніданок на сьогодні був неможливий узагалі: замовити його можна
// було лише напередодні, і то до вечора. На практиці це означало, що
// дитина, яка вранці передумала, лишалася без сніданку, а батьки — з
// незрозумілим «на сьогодні вже приготували» о сьомій ранку.
//
// Тепер межа одна й та сама, що й у позицій на винос, і того самого дня.
// Кухня готує сніданок до уроків, тож пізніше вже нема сенсу — але встигає.
//
// Майбутні дні відкриті без обмежень: замовити на завтра чи на понеділок
// можна коли завгодно.
export function breakfastEditable(dateStr, now = new Date(), today = localDateString){
  if(dateStr > today) return { ok:true };
  if(dateStr < today) return { ok:false, msg:'Цей день уже минув.' };
  return now.getHours() < BREAKFAST_CUTOFF_HOUR
    ? { ok:true }
    : { ok:false, msg:`Сніданки на сьогодні приймалися до ${BREAKFAST_CUTOFF_HOUR}:00 — його вже готують. Можна замовити на завтра.` };
}

// ЖОДНА КНОПКА ХАРЧУВАННЯ НЕ МАЄ ПРАВА МОВЧАТИ.
//
// У пʼяти місцях стояло просто `return`, коли дитину не вдалося знайти в
// списку класу: зберегти налаштування, відповісти на питання про обіди,
// зняти підвечірок, замовити на винос, відкрити статистику. Для людини це
// виглядало однаково — натиснув, і нічого. Ні запису, ні пояснення, ні
// приводу комусь поскаржитися; вона просто тисне ще раз завтра.
function mealNoChild(){
  const msg = 'Не вдалося підтвердити дитину у списку класу. Замовлення не збережено, '
            + 'бо кухня не побачила б його. Покажіть це повідомлення класному керівнику.';
  // mealMsg сам віддає це тостом, якщо картки меню на екрані немає.
  try{ mealMsg('⚠️ ' + msg, true); }catch(e){ try{ showToast('⚠️ ' + msg); }catch(e2){} }
  return false;
}

export function snackEditable(dateStr, now = new Date(), today = localDateString){
  if(dateStr > today) return { ok:true };
  if(dateStr < today) return { ok:false, msg:'Цей день уже минув.' };
  return now.getHours() < SNACK_CUTOFF_HOUR
    ? { ok:true }
    : { ok:false, msg:`Підвечірок на сьогодні приймався до ${SNACK_CUTOFF_HOUR}:00 — кухня вже порахувала продукти на день. Можна змінити на завтра.` };
}

// ══════════════════════════════════════════════════════════════════
//  ЩО З ХАРЧУВАННЯМ, КОЛИ ВІДМІТКУ ПРО ВІДСУТНІСТЬ ЗНІМАЮТЬ
// ══════════════════════════════════════════════════════════════════
//
// Відсутність знімає харчування на день. Зняли відмітку — у кабінеті обід
// знову зʼявляється, бо рахунок іде від плану. Але кухня свій підрахунок
// уже зробила — кожен прийом їжі має власну годину (див. сталі
// *_CUTOFF_HOUR вище). Після неї порції на цю дитину просто немає,
// скільки б галочок не було на екрані. Дитина приходить до школи й
// лишається без обіду — а всі впевнені, що все гаразд.
//
// Годин у тексті навмисно немає: вони змінюються, а коментар — ні.
//
// ЧАС ВІДМІТКИ ВАЖЛИВИЙ. Якщо відсутність поставили ВЖЕ ПІСЛЯ дедлайну,
// кухня порахувала дитину як таку, що їсть, — і зняття відмітки нічого не
// ламає. Попереджати тут означало б лякати дарма. Тому дивимося на ts
// запису; у старих записів його немає, і тоді попереджаємо (краще зайва
// обережність, ніж дитина без обіду).
export function mealsAfterAbsenceCleared(date, markedTs, now = new Date(), today = localDateString){
  const cutoffs = [
    ['сніданок',   BREAKFAST_CUTOFF_HOUR, breakfastEditable(date, now, today)],
    ['обід',       MEAL_CUTOFF_HOUR,      mealsEditable(date, now, today)],
    ['підвечірок', SNACK_CUTOFF_HOUR,     snackEditable(date, now, today)]
  ];
  const back = [], gone = [];
  for(const [label, hour, gate] of cutoffs){
    if(gate.ok){ back.push(label); continue; }
    // Відмітку поставили після дедлайну — з підрахунку кухні вона не
    // випала, отже й повертати нема чого.
    const ts = Number(markedTs) || 0;
    if(ts){
      const at = new Date(ts);
      const sameDay = `${at.getFullYear()}-${String(at.getMonth()+1).padStart(2,'0')}-${String(at.getDate()).padStart(2,'0')}`;
      if(sameDay === date && at.getHours() >= hour){ back.push(label); continue; }
      if(sameDay > date){ back.push(label); continue; }
    }
    gone.push(label);
  }
  return { back, gone };
}
// ══════════════════════════════════════════════════════════════════
//  ЧИ ЗНІМАЄ ВІДСУТНІСТЬ ПОРЦІЮ З РАХУНКУ
// ══════════════════════════════════════════════════════════════════
//
// Відсутність сама по собі порції не скасовує — скасовує ВЧАСНЕ
// попередження. Кухня рахує продукти зранку: до дедлайну (обід і
// підвечірок — MEAL_CUTOFF_HOUR/SNACK_CUTOFF_HOUR, сніданок —
// BREAKFAST_CUTOFF_HOUR) дитину ще можна зняти з переліку; після нього
// порція вже приготована, і день рахується.
//
// Портал давно каже це батькам в іншому місці: коли помилкову відмітку
// знімають, mealsAfterAbsenceCleared перевіряє рівно ті самі години й
// попереджає, що обід уже не замовлено. А підрахунок жив за іншим
// правилом — будь-яка відсутність стирала день, навіть та, яку вчитель
// проставив через тиждень. Через це «Моя статистика» показувала батькам
// одні числа, кухня готувала на інші, і сходилося воно випадково.
//
// СТАРІ ДНІ НЕ ЧІПАЄМО. Правило не можна вмикати заднім числом: люди вже
// бачили свої числа, частина днів запечатана в журналі, і несподіваний
// перерахунок за минуле — це не виправлення, а новий рахунок. Тому до
// ABSENCE_RULE_FROM усе рахується як раніше: будь-яка відсутність знімає
// день, коли б про неї не повідомили.
export const ABSENCE_RULE_FROM = '2026-09-21';

// Дедлайн — це година ШКОЛИ, а не пристрою. Батько може відкрити портал
// із іншого поясу, а нічний журнал рахується на сервері в UTC: без явної
// зони «до 9:00» означало б різне в трьох місцях, і різниця в дві години
// — це і є той самий обід.
const SCHOOL_TZ = 'Europe/Warsaw';
export function schoolMoment(ts){
  const d = new Date(Number(ts) || 0);
  const p2 = n => String(n).padStart(2,'0');
  try{
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone:SCHOOL_TZ,
      year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false }).formatToParts(d);
    const g = k => (parts.find(x=>x.type===k)||{}).value;
    const hour = (Number(g('hour')) === 24 ? 0 : Number(g('hour')));
    const minute = Number(g('minute')) || 0;
    return { day:`${g('year')}-${g('month')}-${g('day')}`, hour, minute, hm:`${p2(hour)}:${p2(minute)}` };
  }catch(e){
    // Немає повної бази часових поясів — краще місцевий час, ніж нічого.
    return { day:`${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())}`,
             hour:d.getHours(), minute:d.getMinutes(),
             hm:`${p2(d.getHours())}:${p2(d.getMinutes())}` };
  }
}

// Час, коли про відсутність повідомили: найраніша позначка того дня.
// Саме найраніша, а не остання: якщо вранці написали «не буде», а по обіді
// вчитель продублював відмітку, попередили все-таки вранці.
export function absenceAt(slots){
  let ts = null, found = false;
  for(const r of Object.values(slots || {})){
    if(!r || r.status !== 'absent') continue;
    found = true;
    const t = Number(r.ts) || 0;
    if(t && (ts === null || t < ts)) ts = t;
  }
  return found ? { ts: ts || 0 } : null;
}

export function absenceRemovesMeal(meal, date, markedTs){
  if(!date || date < ABSENCE_RULE_FROM) return true;      // старі дні — як було
  const hour = meal === 'breakfast' ? BREAKFAST_CUTOFF_HOUR
             : meal === 'snack'     ? SNACK_CUTOFF_HOUR
             : MEAL_CUTOFF_HOUR;
  const ts = Number(markedTs) || 0;
  // Запис без часу (є такі, старі) — не знаємо, коли попередили.
  // Тлумачимо на користь родини: знімаємо, як і раніше.
  if(!ts) return true;
  const at = schoolMoment(ts);
  if(at.day < date) return true;        // попередили заздалегідь
  if(at.day > date) return false;       // проставили заднім числом
  return at.hour < hour;                // того самого дня — встигли чи ні
}

// Один текст на всі три місця, де відмітку знімають.
export function absenceClearedMealNote(date, markedTs, now = new Date(), today = localDateString){
  const { gone } = mealsAfterAbsenceCleared(date, markedTs, now, today);
  if(!gone.length) return '';
  return `Увага: кухня вже порахувала цей день — ${gone.join(', ')} на дитину не замовлено. `
       + `Щоб додати порцію, зверніться до адміністрації школи.`;
}
window.absenceClearedMealNote = absenceClearedMealNote;

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

// Що дає постійний план для цього поля в цей день тижня
export function plannedValue(plan, field, wd){
  if(field === 'lunch') return !!(plan && plan.lunch === true);
  return optionPlanned(plan, field, wd);
}

// Яку поправку записати на день. null означає «прибрати поправку» —
// день повертається до постійного плану.
//
// НАВІЩО ПРИБИРАТИ, А НЕ ПИСАТИ НУЛЬ. Дитина, яка зазвичай не обідає,
// разово взяла обід і передумала. Якщо лишити явний нуль, у базі
// назавжди осяде поправка, яка нічого не змінює, а кухня в звітах
// побачить «відмову» там, де відмовлятися не було від чого.
// Запис дитини міг лягти або під постійним ідентифікатором, або під імʼям.
//
// ЗВІДКИ ДВА КЛЮЧІ. Донедавна кабінет батьків підставляв імʼя, коли в
// профілі не було ідентифікатора. Ті записи в базі лишилися — і поки вони
// там, кухня мусить уміти їх знайти.
//
// ЧОМУ ЦЕ КОШТУВАЛО ВАРІАНТА ГАРНІРУ. Постійні плани кухня шукала за обома
// ключами, а поправки на день (обід/сніданок/вибір А-Б) — лише за
// ідентифікатором. Тому «дитина обідає» кухня бачила, а «батьки обрали Б» —
// ні, і в звіті стояв варіант А за замовчуванням. Один довідник у двох
// місцях, і тільки в одному з них є запасний ключ, — це те, що обовʼязково
// розійдеться. Тепер пошук один на всіх.
export function byKeyOrName(map, key, name){
  if(!map) return null;
  const a = map[key];
  const b = (name != null) ? map[name] : undefined;
  return pickFresher(a, b);
}

// З двох копій однієї відповіді беремо СВІЖІШУ, а не «ту, що за
// ідентифікатором».
//
// ЧОМУ НЕ ЗА ПРІОРИТЕТОМ КЛЮЧА. Через це й вийшла найдовша плутанина:
// кухня раніше поставила варіант Б вручну — запис ліг під ідентифікатором.
// Потім батько обрав А, і його відповідь через права лягла під імʼям.
// Записів стало два. Хто читав «спершу за ідентифікатором», бачив Б —
// і батько, і кухня, — хоча остання людська дія була «А».
//
// Свіжість визначає ts, який пишеться при кожному збереженні. Запис без ts
// вважаємо найстарішим: він з тих часів, коли поля ще не було.
export function pickFresher(a, b){
  const ok = (x) => x !== undefined && x !== null;
  if(!ok(a)) return ok(b) ? b : null;
  if(!ok(b)) return a;
  const ta = Number(a && a.ts) || 0, tb = Number(b && b.ts) || 0;
  return tb > ta ? b : a;
}

// Старі відповіді можуть жити під ім'ям, нові — під ID. Пізніший запис
// іноді містить лише змінене поле; зберігаємо інший вибір А/Б, якщо його
// явно не скасували разом із відповідним прийомом їжі.
export function mealDayFresher(a,b){
  const newest=pickFresher(a,b);
  if(!newest)return null;
  const older=newest===a?b:a;
  const row={...newest};
  if(older){
    if(row.pick===undefined && row.lunch!==0 && row.lunch!==false && ['a','b'].includes(older.pick))row.pick=older.pick;
    if(row.breakfastPick===undefined && row.breakfast!==0 && row.breakfast!==false && ['a','b'].includes(older.breakfastPick))row.breakfastPick=older.breakfastPick;
  }
  return row;
}

export function takeawayPriceAt(id,date,items,history){
  const prices=history?.[id]||{},all=Object.keys(prices).sort();
  const past=all.filter(d=>d<=date);
  return Number(past.length?prices[past.at(-1)]
    :all.length?prices[all[0]]:items?.[id]?.price)||0;
}

async function readMealCopies(base,sid,name){
  const read=async key=>{
    if(!key)return null;
    const snap=await get(child(ref(db),`${base}/${key}`));
    return snap.exists()?snap.val():null;
  };
  const keys=name&&name!==sid?[sid,name]:[sid];
  const copies=await Promise.all(keys.map(read));
  return base.startsWith('meal_day/') ? mealDayFresher(copies[0],copies[1])
    : pickFresher(copies[0],copies[1]);
}

export function dayFieldPatch(plan, field, value, wd){
  const want = !!value;
  return want === plannedValue(plan, field, wd) ? null : (want ? 1 : 0);
}

// Де саме цього дня є вибір із двох страв.
//
// СПОЧАТКУ ГАРНІР — так школа працює насправді: друга страва одна, а от
// каша буває гречана або вівсяна. Але меню, опубліковані раніше, ставили
// вибір на другу страву, і ті дні мають показуватися як були — інакше
// журнал замовлень за минулий місяць почне брехати.
export function choicePair(menuDay){
  if(!menuDay) return null;
  const side = String(menuDay.side || '').trim();
  const side2 = String(menuDay.side2 || '').trim();
  if(side && side2) return { field:'side', a:side, b:side2, label:'основну страву' };
  const sec = String(menuDay.second || '').trim();
  const sec2 = String(menuDay.second2 || '').trim();
  if(sec && sec2) return { field:'second', a:sec, b:sec2, label:'основну страву' };
  return null;
}

export function pickedSecond(menuDay, dayOverride){
  if(!choicePair(menuDay)) return null;
  return (dayOverride && dayOverride.pick === 'b') ? 'b' : 'a';
}

export function breakfastChoicePair(menuDay){
  if(!menuDay) return null;
  const a = String(menuDay.breakfast || '').trim();
  const b = String(menuDay.breakfast2 || '').trim();
  return a && b ? { a, b, label:'сніданок' } : null;
}

export function pickedBreakfast(menuDay, dayOverride){
  if(!breakfastChoicePair(menuDay)) return null;
  return dayOverride && dayOverride.breakfastPick === 'b' ? 'b' : 'a';
}

// Поіменний список у кабінеті кухні. Згорнутий, бо в школі таких імен
// може бути півтори сотні, і розгорнутий список ховає під собою все інше.
// Те, за чим кухар мусить діяти сьогодні (разові обіди, відмови), лишаємо
// розгорнутим — його зазвичай кілька рядків.
function nameList(kind, title, rows, note, open){
  if(!rows || !rows.length) return '';
  return `<details class="k-names" ${open ? 'open' : ''}>
    <summary class="k-skip-title ${kind}">${escHtml(title)}</summary>
    ${note ? `<div class="k-skip-note">${escHtml(note)}</div>` : ''}
    ${rows.map(r => `<div class="k-skip ${kind}">${escHtml(r.name)} <span>${escHtml(String(r.cls))} кл.${
      r.reason ? ' · ' + escHtml(r.reason) : ''}</span></div>`).join('')}
  </details>`;
}

// Відсутність будь-де в межах дня знімає дитину з харчування.
// Значення — не просто «так», а {ts}: коли про відсутність повідомили.
// Від цього залежить, чи встигла кухня зняти порцію (див.
// absenceRemovesMeal). Обʼєкт завжди істинний, тож усі старі перевірки
// виду !!absentSet[sid] працюють як раніше.
function absentSet(attClassDay){
  const out = {};
  if(!attClassDay) return out;
  for(const sid in attClassDay){
    const rec = absenceAt(attClassDay[sid]);
    if(rec) out[sid] = rec;
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
  try{
  const box = document.getElementById('k-menu-week');
  if(!box) return;
  const monday = currentMonday(), dates = weekDates(monday);
  const lbl = document.getElementById('k-week-label');
  if(lbl) lbl.innerHTML = `${human(dates[0])} — ${human(dates[4])}<br><small class="k-week-hint">${escHtml(weekHint(monday))}</small>`;
  box.innerHTML = '<p class="empty-msg">Завантаження...</p>';
  const snaps = await Promise.all(dates.map(d=>get(child(ref(db),`menu/${d}`))));
  box.innerHTML = dates.map((date,i)=>{
    const m = snaps[i].exists() ? snaps[i].val() : {};
    const filled = menuHasFood(m);
    const isToday = date === localDateString;
    return `<details class="k-day" ${isToday||i===0?'open':''}>
      <summary>
        <span class="k-day-name">${DOW[i]}</span>
        <span class="k-day-date">${human(date)}</span>
        <span class="k-day-flag ${filled?'ok':'no'}">${filled?'✓ заповнено':'порожньо'}</span>
      </summary>
      <div class="k-day-body">
        ${MENU_FIELDS.map(f=>`
          <label for="km-${date}-${f.k}" ${f.danger?'style="color:var(--danger);"':(f.snack?'style="color:var(--brand-deep);"':(f.meal?'style="color:var(--warn);"':(f.choice?'style="color:var(--brand-deep);"':'')))}>${escHtml(f.label)}</label>
          <input type="text" id="km-${date}-${f.k}" value="${escHtml(m[f.k]||'')}" placeholder="${escHtml(f.ph)}">`).join('')}
        <p class="k-day-ts">${m.ts?`Оновлено ${new Date(m.ts).toLocaleString('uk-UA')}`:'Ще не публікувалося'}</p>
        ${snaps[i].exists() ? `<button type="button" class="k-day-clear" onclick="clearMenuDay('${escJs(date)}')">🗑 Прибрати меню цього дня</button>` : ''}
      </div>
    </details>`;
  }).join('');
  }catch(err){
    // Читання не вдалося. Без цього блоку на екрані назавжди лишався б
    // напис-заглушка, і людина не знала б, зламалося чи просто повільно.
    console.error("kitchen.js → k-menu-week", err);
    const _b=document.getElementById("k-menu-week");
    if(_b)_b.innerHTML='<p class="empty-msg" style="color:var(--danger);">Не вдалося завантажити: '+((err&&err.message)||'невідома помилка')+'</p>';
  }
}

// Зберігаємо весь тиждень одним рухом, але сповіщаємо лише про ті дні,
// що справді змінилися — інакше батьки отримали б 5 пушів на порожньому місці.
// ── ЧИ МОЖНА МІНЯТИ ПАРУ А/Б ──
//
// Літера А/Б означає конкретну страву. Якщо родини вже відповіли,
// перестановка чи заміна пари тихо змінила б зміст їхньої відповіді:
// людина обрала «Б — гречка», а після правки Б це вже омлет.
//
// АЛЕ «ЗМІНИТИ ПАРУ» І «ВІДНОВИТИ ЗНИКЛЕ МЕНЮ» — РІЗНІ РЕЧІ.
//
// Коли меню дня видалили заднім числом, пари немає взагалі, а відповіді
// родин лишилися. Спроба вписати страви назад виглядала для цієї
// перевірки як «зміна пари» — і заборона намертво блокувала єдиний
// спосіб виправити помилку кухні. Виходило замкнене коло: день випав з
// обліку, бо меню немає, а меню не вписати, бо є вибори.
//
// Тому: якщо пари НЕ БУЛО — це відновлення, і ми не забороняємо, а
// попереджаємо. Порядок страв має збігатися з тим, що був, інакше літери
// в уже наданих відповідях поміняють зміст; перевірити це може лише
// людина, бо в базі старої пари вже немає.
export function abPairGate(before, after, chosen){
  const rows = chosen || [];
  const picked = key => rows.some(v => v && (v[key] === 'a' || v[key] === 'b'));
  const cases = [
    ['обіду',    choicePair(before),          choicePair(after),          'pick'],
    ['сніданку', breakfastChoicePair(before), breakfastChoicePair(after), 'breakfastPick']
  ];
  const blocks = [], confirms = [];
  for(const [label, was, now, key] of cases){
    if(JSON.stringify(was) === JSON.stringify(now)) continue;   // пара не змінилася
    if(!picked(key)) continue;                                  // ніхто ще не обирав
    if(was) blocks.push(label);                                 // пара була — і її міняють
    else confirms.push(label);                                  // пари не було — це відновлення
  }
  if(blocks.length) return { block:
    `вже є вибори А/Б ${blocks.join(' і ')}. Страви цієї пари не можна міняти місцями `
    + 'або видаляти: спочатку узгодьте зміну з родинами.' };
  if(confirms.length) return { confirm:
    `на цей день уже є вибори А/Б ${confirms.join(' і ')}, зроблені за меню, якого в базі вже немає.\n\n`
    + 'Впишіть страви в тому самому порядку, у якому вони були того дня: літери А і Б '
    + 'у відповідях родин лишилися, і якщо переставити страви місцями, кожна відповідь '
    + 'означатиме протилежне.\n\nПорядок правильний?' };
  return { ok:true };
}

window.saveWeekMenu = async function(){
  const monday = currentMonday(), dates = weekDates(monday);
  for(const date of dates){
    for(const [first,second,label] of [
      ['breakfast','breakfast2','сніданку'],
      ['side','side2','основної страви']
    ]){
      const a = document.getElementById(`km-${date}-${first}`)?.value.trim() || '';
      const b = document.getElementById(`km-${date}-${second}`)?.value.trim() || '';
      if(b && !a){
        document.getElementById(`km-${date}-${first}`)?.focus();
        return alert(`Спочатку заповніть варіант А ${label} на ${human(date)}.`);
      }
    }
  }
  const snaps = await Promise.all(dates.map(d=>get(child(ref(db),`menu/${d}`))));
  const changedNew=[], changedUpd=[], blockedPast=[];
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
    // Усі поля стерли, а запис був — прибираємо його зовсім. Порожній
    // запис лишався б у базі й виглядав як «меню опубліковане, але без
    // страв»; саме так і виходило, коли день заповнювали помилково.
    //
    // Але НЕ для минулого дня: тут те саме, що з кнопкою «🗑» — стерти
    // страви за день, коли діти вже поїли, означає прибрати сам день із
    // обліку. Саме цим шляхом, а не кнопкою, меню зазвичай і зникає:
    // поля чистять «щоб не заважали» і натискають «Зберегти».
    if(!any && old){
      if(!menuDeletable(date).ok){ blockedPast.push(date); return; }
      updates[`menu/${date}`] = null; return;
    }
    const wasPublished = menuHasFood(old);
    updates[`menu/${date}`] = {
      ...data,
      by: currentUserData?.email || '',
      ts: Date.now(),
      pub: (old && old.pub) || Date.now()
    };
    (wasPublished ? changedUpd : changedNew).push(date);
  });
  if(blockedPast.length) return alert(menuDeletable(blockedPast[0]).msg);
  if(!Object.keys(updates).length) return showToast('Змін немає');
  // Пари А/Б: що можна міняти, а що ні — див. abPairGate.
  for(let i=0;i<dates.length;i++){
    const date=dates[i],path=`menu/${date}`;
    if(!Object.prototype.hasOwnProperty.call(updates,path))continue;
    const before=snaps[i].exists()?snaps[i].val():null,after=updates[path];
    if(JSON.stringify(choicePair(before))===JSON.stringify(choicePair(after))
      &&JSON.stringify(breakfastChoicePair(before))===JSON.stringify(breakfastChoicePair(after)))continue;
    let daySnap,staffSnap;
    try{[daySnap,staffSnap]=await Promise.all([
      get(child(ref(db),`meal_day/${date}`)),
      get(child(ref(db),`staff_meal_day/${date}`))
    ]);}catch(e){return alert(`Не вдалося перевірити вибори на ${human(date)}: ${e.message}`);}
    const day=daySnap.exists()?daySnap.val():{},staff=staffSnap.exists()?staffSnap.val():{};
    const chosen=Object.values(day).flatMap(cls=>Object.values(cls||{})).concat(Object.values(staff));
    const gate=abPairGate(before,after,chosen);
    if(gate.block) return alert(`На ${human(date)} ${gate.block}`);
    if(gate.confirm && !confirm(`${human(date)}: ${gate.confirm}`)) return;
  }
  try{
    await update(ref(db), updates);
  }catch(e){ return alert('Не вдалося зберегти меню: ' + e.message); }
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

// ── Скільки готувати ──
// Дні, коли школа не годує: канікули та свята з навчального року.
//
// НАВІЩО. Підрахунок порцій будується на постійних планах батьків, а не
// на меню. Тому на канікулах кухня бачила ті самі 80 обідів, що й у
// звичайний вівторок. Тепер такі дні позначені й у підрахунок не йдуть.
async function loadNoSchoolDays(dates, strict=false){
  const out = {};
  if(!dates.length) return out;
  try{
    const years=[...new Set(dates.map(date=>{
      const y=Number(date.slice(0,4)),mo=Number(date.slice(5,7));
      return mo>=8?`${y}-${y+1}`:`${y-1}-${y}`;
    }))];
    for(const year of years){
      const [hSnap, bSnap] = await Promise.all([
        get(child(ref(db), `academic_year/${year}/holidays`)),
        get(child(ref(db), `academic_year/${year}/breaks`))
      ]);
      if(hSnap.exists()) Object.values(hSnap.val()).forEach(h => {
        if(h && h.date && dates.includes(h.date)) out[h.date] = h.title || 'Свято';
      });
      if(bSnap.exists()) Object.values(bSnap.val()).forEach(b => {
        if(!b || !b.startDate || !b.endDate) return;
        dates.forEach(d => { if(d >= b.startDate && d <= b.endDate) out[d] = b.title || 'Канікули'; });
      });
    }
  }catch(e){
    if(strict) throw e;
    console.warn('academic_year:', e.message);
  }
  return out;
}

export async function loadWeekCounts(){
  const box = document.getElementById('k-counts');
  if(!box) return;
  const dates = weekDates(currentMonday());
  box.innerHTML = '<p class="empty-msg">Обчислення...</p>';
  try{
    // Відвідуваність беремо лише за цей тиждень, а не за весь рік
    const [stSnap, planSnap, att, daySnaps, menuSnaps, resolutionSnap] = await Promise.all([
      get(child(ref(db),'students_list')),
      get(child(ref(db),'meal_plan')),
      getSchoolRange('attendance', dates[0], dates[4], true),
      Promise.all(dates.map(d=>get(child(ref(db),`meal_day/${d}`)))),
      // Меню потрібне, щоб знати, чи є того дня вибір основної страви
      Promise.all(dates.map(d=>get(child(ref(db),`menu/${d}`)))),
      get(child(ref(db),'meal_orphan_resolutions')).catch(e=>({val:()=>({}),readError:e.message}))
    ]);
    const noSchool = await loadNoSchoolDays(dates,true);
    const students = stSnap.exists()?stSnap.val():{};
    const plans    = planSnap.exists()?planSnap.val():{};

    const perDay = dates.map((date,di)=>{
      // Канікули чи свято — школа не годує, рахувати нічого
      if(noSchool[date]) return { date, closed: noSchool[date],
        lunch:0, snack:0, brk:0, pa:0, pb:0, bpa:0, bpb:0, absent:0, off:0, unset:0, classes:{}, skips:[], extras:[], unanswered:[] };
      const overrides = daySnaps[di].exists()?daySnaps[di].val():{};
      const menuDay = menuSnaps[di].exists()?menuSnaps[di].val():{};
      const choice = choicePair(menuDay);
      const hasChoice = !!choice;
      const hasBrkMenu = !!String(menuDay.breakfast||'').trim();
      const brkChoice = breakfastChoicePair(menuDay);
      const hasBrkChoice = !!brkChoice;
      const wd = weekdayIdx(date);
      let lunch=0, snack=0, brk=0, pa=0, pb=0, bpa=0, bpb=0, absent=0, off=0, unset=0;
      const classes = {}, skips = [], extras = [], unanswered = [], orphans=[];
      for(let i=1;i<=11;i++){
        const cls = `class_${i}`;
        orphans.push(...orphanKeys(overrides[cls],plans[cls],students[cls])
          .map(o=>({...o,cls,kind:o.what==='постійні налаштування'?'plan':'day'})));
        if(!students[cls]) continue;
        const absentToday = absentSet(att[cls] && att[cls][date]);
        let cl=0, cs=0, cb=0, ca=0, cbb=0, cba=0, cbbb=0;
        for(const key in students[cls]){
          const name = students[cls][key];
          const plan = byKeyOrName(plans[cls], key, name);
          const isAbsent = !!(absentToday[key] || absentToday[name]);
          const ov = mealDayFresher(overrides[cls]?.[key],overrides[cls]?.[name]);
          const e = effectiveMeals(plan, ov, isAbsent, wd);
          if(e.absent){ absent++; continue; }
          const permanentlyOff = plan && plan.lunch === false;
          // Дитина «не обідає» — але саме сьогодні батьки взяли обід.
          // Раніше цей рядок обривав підрахунок раніше, ніж доходило до
          // e.lunch, і разова порція просто не потрапляла на кухню.
          if(permanentlyOff && !e.lunch && !e.snack && !e.breakfast){ off++; continue; }
          if(permanentlyOff && e.lunch) extras.push({cls:i, name});
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
          else if(!lunchChosen(plan)){ unset++; unanswered.push({cls:i, name}); }
          else { skips.push({cls:i,name,reason:(ov&&ov.reason)||''}); }
          if(e.snack){ snack++; cs++; }
          if(e.breakfast){
            brk++; cb++;
            if(hasBrkChoice){
              const bp = pickedBreakfast(menuDay, ov);
              if(bp === 'b'){ bpb++; cbbb++; } else { bpa++; cba++; }
            }
          }
        }
        if(cl||cs||cb) classes[i] = { lunch:cl, snack:cs, brk:cb, a:ca, b:cbb, ba:cba, bb:cbbb };
      }
      return { date, lunch, snack, brk, pa, pb, bpa, bpb, hasChoice, hasBrkMenu, hasBrkChoice,
               menuA:choice?choice.a:'', menuB:choice?choice.b:'',
               breakfastA:brkChoice?brkChoice.a:'', breakfastB:brkChoice?brkChoice.b:'',
               absent, off, unset, classes, skips, extras, unanswered, orphans };
    });

    const today = perDay.find(d=>d.date===localDateString) || perDay[0];
    box.innerHTML = `
      <div class="k-total">
        ${today.closed
          ? `<b>—</b><span>${escHtml(human(today.date))}: ${escHtml(today.closed)}</span>
             <div class="k-total-snack">школа не годує цього дня</div>`
          : `<b>${today.lunch}</b><span class="k-meal-summary">обідів на ${escHtml(human(today.date))}</span>
             ${today.hasChoice?`<span class="k-meal-split">А <strong>${today.pa}</strong><i>/</i> Б <strong>${today.pb}</strong></span>`:''}
             <div class="k-total-snack">${today.brk} сніданків${today.hasBrkChoice?` (А ${today.bpa} / Б ${today.bpb})`:''}${!today.hasBrkMenu&&today.brk?' (меню ще немає)':''} · ${today.snack} підвечірків</div>`}
      </div>
      <div class="k-sub">відсутні: ${today.absent} · не харчуються: ${today.off} · відмови: ${today.skips.length}${today.extras.length ? ` · <b style="color:var(--ok);">разові обіди: ${today.extras.length}</b>` : ''}${today.unset ? ` · <b style="color:var(--warn);">батьки не відповіли: ${today.unset}</b>` : ''}</div>
      ${renderMealOrphanList(today.orphans||[],resolutionSnap.val()||{},!resolutionSnap.readError)}

      <!-- Сніданок у тижневій таблиці нарівні з обідом: його теж треба
           готувати, і кухня планувала його наосліп — число було лише
           в розрізі класів нижче. -->
      <div class="k-scroll"><table class="k-table"><thead><tr><th>День</th><th>Снід.</th><th>Снід. А / Б</th><th>Обіди</th><th>Обід А / Б</th><th>Підвеч.</th><th>Відсутні</th></tr></thead><tbody>
        ${perDay.map((d,i)=>`<tr class="${d.date===localDateString?'k-now':''}${d.closed?' k-closed':''}">
          <td>${DOW_SHORT[i]} ${escHtml(human(d.date).slice(0,5))}</td>
          ${d.closed
            ? `<td colspan="6" class="k-closed-cell">${escHtml(d.closed)}</td>`
            : `<td>${d.brk||0}${!d.hasBrkMenu&&d.brk?' (меню ще немає)':''}</td>
               <td>${d.hasBrkChoice?`А ${d.bpa} / Б ${d.bpb}`:'—'}</td>
               <td><b>${d.lunch}</b></td><td>${d.hasChoice?`А ${d.pa} / Б ${d.pb}`:'—'}</td>
               <td>${d.snack||''}</td><td class="k-off">${d.absent||''}</td>`}
          </tr>`).join('')}
      </tbody></table></div>

      <div class="k-skip-title">По класах — ${escHtml(human(today.date))}</div>
      <div class="k-scroll"><table class="k-table"><thead><tr><th>Клас</th><th>Снід.</th>${today.hasBrkChoice?'<th>Снід. А / Б</th>':''}<th>Обіди</th>${today.hasChoice?'<th>Обід А / Б</th>':''}<th>Підвеч.</th></tr></thead><tbody>
        ${Object.keys(today.classes).length
          ? Object.keys(today.classes).map(c=>`<tr><td>${c}</td><td>${today.classes[c].brk||''}</td>${today.hasBrkChoice?`<td>${today.classes[c].ba||0} / ${today.classes[c].bb||0}</td>`:''}<td><b>${today.classes[c].lunch}</b></td>${today.hasChoice?`<td>${today.classes[c].a||0} / ${today.classes[c].b||0}</td>`:''}<td>${today.classes[c].snack||''}</td></tr>`).join('')
          : `<tr><td colspan="${4+(today.hasChoice?1:0)+(today.hasBrkChoice?1:0)}" class="empty-msg">Немає даних</td></tr>`}
      </tbody></table></div>

      ${nameList('warn', `Батьки ще не відповіли про обіди (${today.unanswered.length})`, today.unanswered,
          'Ці діти не потрапляють у замовлення, доки батьки не натиснуть «Так, обідає» або «Ні, не обідає».', false)}
      ${nameList('extra', `Разові обіди на ${human(today.date)} — діти, які зазвичай не обідають (${today.extras.length})`,
          today.extras, '', true)}
      ${nameList('', `Відмови на ${human(today.date)} (${today.skips.length})`, today.skips, '', true)}`;
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
  // Персонал: ціна обіду й список на обрану дату
  if(window.loadMealPricesForm) window.loadMealPricesForm();
  if(window.loadStaffOrders) window.loadStaffOrders();
};

// ── Хто харчується (кухня / адміністрація) ──
export async function loadMealPlans(){
  try{
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
    const p = byKeyOrName(plans,sid,name) || {};
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
  }catch(err){
    // Читання не вдалося. Без цього блоку на екрані назавжди лишався б
    // напис-заглушка, і людина не знала б, зламалося чи просто повільно.
    console.error("kitchen.js → k-plan-list", err);
    const _b=document.getElementById("k-plan-list");
    if(_b)_b.innerHTML='<p class="empty-msg" style="color:var(--danger);">Не вдалося завантажити: '+((err&&err.message)||'невідома помилка')+'</p>';
  }
}
window.loadMealPlans = loadMealPlans;
window.setMealPlan = async function(cls, sid, field, value){
  try{
    const dir=await getStudentDir(cls),name=dir.byId[sid]||sid;
    const plan={...(await readMealCopies(`meal_plan/${cls}`,sid,name)||{})};
    plan[field] = value;
    if(field==='snack' && value!=='days') delete plan.snackDays;
    plan.by = currentUserData?.email || ''; plan.ts = Date.now();
    const patch={[`meal_plan/${cls}/${sid}`]:plan};
    await update(ref(db),patch);
  }catch(e){ return alert('Не вдалося зберегти: ' + e.message); }
  logAction('meal_plan',{ date:stuName(cls,sid), value:`${field}=${value}` });
  showToast('✅ Збережено');
  loadWeekCounts();
  if(field==='snack' && value==='days') loadMealPlans();
};

// ── Хто що замовив: поіменний список по класу на конкретний день ──
// Кухні потрібен не лише підсумок, а й список, з яким можна вийти на роздачу:
// хто сьогодні обідає, хто бере підвечірок, кого немає і хто відмовився.
// Персонал живе на тій самій даті, тож оновлюємо обидва списки разом:
// інакше кухня міняє дату, бачить оновлений клас і СТАРИЙ персонал.
window.loadOrdersForDay = function(){
  window.loadClassOrders();
  window.loadStaffOrders();
};

// ── Замовлення по класу ──
// Кухня годує школу, а не клас: щоб зібрати денну потребу, кухарю
// доводилося відкривати одинадцять екранів підряд і складати цифри на
// папірці. Тому є режим «Усі класи» — один суцільний список на всю школу,
// впорядкований за класом, а всередині класу за прізвищем.
export const ALL_CLASSES = '__all';
export function classNum(cls){
  const n = parseInt(String(cls||'').replace('class_',''), 10);
  return Number.isFinite(n) ? n : 999;
}
// Порядок рядків задано тут, а не в шаблоні друку: екран, аркуш і CSV
// мають збігатися рядок у рядок, інакше кухня звіряє два різні списки.
export function sortOrderRows(rows){
  return (rows||[]).slice().sort((a,b)=>
    classNum(a.cls) - classNum(b.cls) ||
    String(a.name||'').localeCompare(String(b.name||''),'uk'));
}
// Підсумок — те, що кухня переписує в накладну. Рахується один раз і
// однаково для екрана, аркуша й CSV.
export function orderTotals(rows){
  const n = f => (rows||[]).filter(f).length;
  return { total:(rows||[]).length,
           brk:n(r=>r.breakfast), lunch:n(r=>r.lunch), snack:n(r=>r.snack),
           bpa:n(r=>r.breakfastPick==='a'), bpb:n(r=>r.breakfastPick==='b'),
           pa:n(r=>r.pick==='a'),  pb:n(r=>r.pick==='b'),
           noReply:n(r=>r.noReply), absent:n(r=>r.absent) };
}
// Розбивка на блоки класів для суцільної таблиці. Групуємо ВЖЕ
// відсортоване, тож клас не може розпастися на два шматки списку.
export function groupByClass(rows){
  const out = [];
  sortOrderRows(rows).forEach(r=>{
    let g = out[out.length-1];
    if(!g || g.cls !== r.cls){ g = { cls:r.cls, rows:[] }; out.push(g); }
    g.rows.push(r);
  });
  return out.map(g=>({ cls:g.cls, rows:g.rows, totals:orderTotals(g.rows) }));
}

// Один рядок = одна дитина. Винесено з loadClassOrders, бо той самий
// розрахунок потрібен і для одного класу, і для всіх одразу.
export function buildOrderRows(cls, students, plans, overrides, absent, wd, menuDay, hasChoice, hasBrkChoice){
  return Object.entries(students||{})
    .sort((a,b)=>String(a[1]).localeCompare(String(b[1]),'uk'))
    .map(([sid,name])=>{
      const plan = byKeyOrName(plans, sid, name) || {};
      const ov = mealDayFresher(overrides?.[sid],overrides?.[name]);
      const e = effectiveMeals(plan, ov, !!(absent[sid] || absent[name]), wd);
      const pick = (e.lunch && hasChoice) ? pickedSecond(menuDay, ov) : null;
      const breakfastPick = (e.breakfast && hasBrkChoice) ? pickedBreakfast(menuDay, ov) : null;
      let note = '';
      if(e.absent) note = 'відсутній';
      else if(plan.lunch === false) note = 'не харчується';
      else if(ov && ov.lunch === 0) note = ov.reason ? `відмова · ${ov.reason}` : 'відмова';
      else if(ov && ov.snack !== undefined) note = ov.snack ? 'підвечірок разово' : 'без підвечірка сьогодні';
      if(ov && ov.manual) note = (note ? note + ' · ' : '') + 'додано вручну';
      // Батьки взагалі не відповіли про обіди — це не «не харчується» і не
      // «відмова», а окремий стан: дитини просто немає в замовленні, і ніхто
      // цього не вирішував. Кухня має бачити його першим, тому окремо й
      // помітно.
      const noReply = !e.absent && !lunchChosen(plan);
      // ЯВНИЙ ВИБІР І ВИБІР ЗА ЗАМОВЧУВАННЯМ — РІЗНІ РЕЧІ.
      // pickedSecond віддає 'a' і тоді, коли ніхто нічого не натискав: А діє
      // сама собою. Для кухні різниця важлива — саме вона відповідає на
      // питання «коли батько відмітив варіант». Якщо не відмічав, часу
      // немає, і вигадувати його не можна.
      return { cls, sid, name, ...e, pick, breakfastPick, note, noReply,
               pickExplicit: !!(ov && (ov.pick === 'a' || ov.pick === 'b')),
               brkPickExplicit: !!(ov && (ov.breakfastPick === 'a' || ov.breakfastPick === 'b')),
               pickTs: ov && ov.pickTs, breakfastPickTs: ov && ov.breakfastPickTs,
               ts: ov && ov.ts, by: ov && ov.by, manual: !!(ov && ov.manual) };
    });
}

window.loadClassOrders = async function(){
  const cls  = document.getElementById('k-order-class')?.value;
  const date = document.getElementById('k-order-date')?.value;
  const box  = document.getElementById('k-orders');
  if(!box) return;
  if(!cls || !date){ box.innerHTML = '<p class="empty-msg">Оберіть клас і дату.</p>'; return; }
  const allMode = cls === ALL_CLASSES;
  box.innerHTML = '<p class="empty-msg">Завантаження...</p>';
  try{
    // Для одного класу читаємо рівно його вузли. Читати всю школу заради
    // двадцяти дітей — зайвий трафік на кожне перемикання дати.
    const [stSnap, plSnap, daySnap, attRaw, menuSnap, resolutionSnap] = await Promise.all([
      get(child(ref(db), allMode ? 'students_list' : `students_list/${cls}`)),
      get(child(ref(db), allMode ? 'meal_plan'     : `meal_plan/${cls}`)),
      get(child(ref(db), allMode ? `meal_day/${date}` : `meal_day/${date}/${cls}`)),
      allMode ? getSchoolRange('attendance', date, date, true)
              : get(child(ref(db),`attendance/${cls}/${date}`)),
      get(child(ref(db),`menu/${date}`)),
      get(child(ref(db), allMode ? 'meal_orphan_resolutions' : `meal_orphan_resolutions/${cls}`))
        .catch(e=>({val:()=>({}),readError:e.message}))
    ]);
    const menuDay = menuSnap.exists()?menuSnap.val():{};
    const choice = choicePair(menuDay);
    const hasChoice = !!choice;
    const hasBrkMenu = !!String(menuDay.breakfast||'').trim();
    const brkChoice = breakfastChoicePair(menuDay);
    const hasBrkChoice = !!brkChoice;
    if(!stSnap.exists()){ box.innerHTML = `<p class="empty-msg">${allMode?'У школі немає учнів.':'У класі немає учнів.'}</p>`; return; }
    const wd = weekdayIdx(date);

    // Далі все однакове для обох режимів: набір класів різний, логіка —
    // ні. Один клас — це просто список із одного елемента.
    const clsList = allMode
      ? Array.from({length:11},(_,i)=>`class_${i+1}`).filter(c=>stSnap.val()[c])
      : [cls];
    const studentsOf = c => allMode ? (stSnap.val()[c]||{}) : stSnap.val();
    const plansOf    = c => allMode ? ((plSnap.exists()?plSnap.val():{})[c]||{}) : (plSnap.exists()?plSnap.val():{});
    const dayOf      = c => allMode ? ((daySnap.exists()?daySnap.val():{})[c]||{}) : (daySnap.exists()?daySnap.val():{});
    const attOf      = c => allMode ? ((attRaw[c]||{})[date]||null) : (attRaw.exists()?attRaw.val():null);
    const resOf      = c => allMode ? ((resolutionSnap.val()||{})[c]||{}) : (resolutionSnap.val()||{});

    let rows = [];
    const orphans = [];
    clsList.forEach(c=>{
      const students = studentsOf(c), plans = plansOf(c), overrides = dayOf(c);
      rows = rows.concat(buildOrderRows(c, students, plans, overrides,
        absentSet(attOf(c)), wd, menuDay, hasChoice, hasBrkChoice));
      orphans.push(...orphanKeys(overrides, plans, students)
        .map(o=>({...o, cls:c, kind:o.what==='постійні налаштування'?'plan':'day'})));
    });
    rows = sortOrderRows(rows);
    const groups = groupByClass(rows);
    const t = orderTotals(rows);
    const showBrk = hasBrkMenu || t.brk > 0;
    const resolutions = {}; clsList.forEach(c=>{ resolutions[c] = resOf(c); });
    window.__classOrders = { cls, date, rows, menu: menuDay, all: allMode };

    // Колонок стало на одну більше, ніж було, тож ширину рядка-роздільника
    // рахуємо, а не пишемо числом: інакше при зміні меню роздільник
    // обривається посеред таблиці.
    const cols = 2 + (showBrk?1:0) + (hasBrkChoice?1:0) + 1 + (hasChoice?1:0) + 1 + (allMode?1:0);
    const clsCell = r => allMode ? `<td data-l="Клас" class="k-ord-cl">${escHtml(String(classNum(r.cls)))}</td>` : '';
    const rowHtml = r => `<tr class="${r.absent?'k-ord-abs':''}">
          ${clsCell(r)}
          <td data-l="Учень">${escHtml(r.name)}</td>
          ${showBrk?`<td data-l="Сніданок">${mealCell(r.cls,r.sid,date,'breakfast',r.breakfast)}</td>`:''}
          ${hasBrkChoice?`<td data-l="Сніданок А/Б">${breakfastPickCell(r.cls,r.sid,date,r.breakfastPick)}</td>`:''}
          <td data-l="Обід">${mealCell(r.cls,r.sid,date,'lunch',r.lunch)}</td>
          ${hasChoice?`<td data-l="Варіант">${pickCell(r.cls,r.sid,date,r.pick)}</td>`:''}
          <td data-l="Підвечірок">${mealCell(r.cls,r.sid,date,'snack',r.snack)}</td>
          <td class="k-ord-note" data-l="Примітка">${r.noReply
            ? `<b class="k-noreply">Нема відповіді від батьків</b>${r.note?` · ${escHtml(r.note)}`:''}`
            : escHtml(r.note)}</td></tr>`;
    const groupHead = g => `<tr class="k-ord-clsrow"><td colspan="${cols}">
          <b>${escHtml(String(classNum(g.cls)))} клас</b>
          ${showBrk?`· ${g.totals.brk} сніданків${hasBrkChoice?` (А ${g.totals.bpa} / Б ${g.totals.bpb})`:''} `:''}
          · ${g.totals.lunch} обідів${hasChoice?` (А ${g.totals.pa} / Б ${g.totals.pb})`:''}
          · ${g.totals.snack} підвечірків</td></tr>`;

    box.innerHTML = `
      <div class="k-ord-sum">${showBrk?`<b>${t.brk}</b> сніданків${!hasBrkMenu?' (меню ще немає)':''}${hasBrkChoice?` <span class="k-ord-ab">А ${t.bpa} / Б ${t.bpb}</span>`:''} · `:''}<b>${t.lunch}</b> обідів${hasChoice?` <span class="k-ord-ab">А ${t.pa} / Б ${t.pb}</span>`:''} · <b>${t.snack}</b> підвечірків
        <span>${allMode?`усі класи (${clsList.length})`:`${escHtml(cls.replace('class_',''))} клас`}, ${escHtml(human(date))}</span></div>
      ${hasBrkChoice?`<div class="k-ord-menu">Сніданок: А — ${escHtml(brkChoice.a)} · Б — ${escHtml(brkChoice.b)}</div>`:''}
      ${hasChoice?`<div class="k-ord-menu">Вибір на ${escHtml(choice.label)}: А — ${escHtml(choice.a)} · Б — ${escHtml(choice.b)}. Якщо варіант не змінювали, діє А.</div>`:''}
      <!-- data-l на кожній клітинці — це підпис колонки. Коли шрифт великий,
           таблиця розкладається на картки (див. @media у cabinet.html), шапка
           ховається, і без цих підписів не було б зрозуміло, де обід, а де
           підвечірок. У звичайному вигляді атрибут просто не використовується. -->
      <div class="k-scroll">
      <table class="k-table k-ord"><thead><tr>
        ${allMode?'<th>Клас</th>':''}<th>Учень</th>${showBrk?'<th>Снід.</th>':''}${hasBrkChoice?'<th>Снід. А/Б</th>':''}<th>Обід</th>${hasChoice?'<th>Обід А/Б</th>':''}<th>Підвеч.</th><th>Примітка</th></tr></thead><tbody>
        ${allMode
          ? groups.map(g=>groupHead(g) + g.rows.map(rowHtml).join('')).join('')
          : rows.map(rowHtml).join('')}
      </tbody></table>
      </div>
      ${renderMealOrphanList(orphans, resolutions, !resolutionSnap.readError)}
      <p class="k-ord-hint">Натисніть ✓ або —, щоб додати чи зняти порцію вручну; кожна колонка А/Б перемикає свій варіант.
        Це для тих, хто звернувся вже після дедлайну; дію буде записано в журнал.</p>
      <div class="k-ord-actions">
        <button onclick="printClassOrders()" class="k-ord-print">🖨️ Аркуш на друк</button>
        <button onclick="printClassOrders('pdf')" class="k-ord-pdf">📕 Зберегти PDF</button>
        <button onclick="exportClassOrders()" class="k-ord-csv">📄 CSV</button>
      </div>
      <p class="k-ord-hint">PDF зберігається через те саме вікно друку: у полі «Принтер» оберіть «Зберегти як PDF».
        Файл вийде такий самий, як на папері, і називатиметься за днем і класом.</p>`;
  }catch(e){
    box.innerHTML = `<p style="color:red;font-size:.8rem;">Помилка: ${escHtml(e.message)}</p>`;
  }
};

// ══════════════════════════════════════════════════════════════════
//  ЗАМОВЛЕННЯ ПЕРСОНАЛУ
// ══════════════════════════════════════════════════════════════════
//
// Учителі й директор замовляють обід так само, як родини, але живуть
// їхні відповіді окремо (staff_meals / staff_meal_day) — у персоналу
// немає ні класу, ні ключа в списку класу, тож у дитячі вузли їх не
// покласти. Через це й показ окремий, рівно як просила школа: свій
// список із іменами та сумою.
//
// Ціна обіду для персоналу — meal_prices/staff. Поки її не задано,
// суму не показуємо: нуль на екрані читався б як «безкоштовно».
window.loadStaffOrders = async function(){
  const box  = document.getElementById('k-staff-orders');
  if(!box) return;
  const date = document.getElementById('k-order-date')?.value || localDateString;
  box.innerHTML = '<p class="empty-msg">Завантаження...</p>';
  try{
    const [planSnap, daySnap, priceSnap, dirSnap, menuSnap, historySnap] = await Promise.all([
      get(child(ref(db),'staff_meals')),
      get(child(ref(db),`staff_meal_day/${date}`)),
      loadMealPrices(true),
      // Імена беремо з довідника персоналу: пошта в списку кухні нічого
      // не каже, а вузол users кухні закритий.
      get(child(ref(db),'staff_directory')).catch(()=>null),
      get(child(ref(db),`menu/${date}`)),
      get(child(ref(db),'meal_price_history'))
    ]);
    const plans  = planSnap.exists()?planSnap.val():{};
    const days   = daySnap.exists()?daySnap.val():{};
    const price  = Number(mealPriceAt(date,priceSnap,historySnap.exists()?historySnap.val():{}).staff) || 0;
    const dir    = (dirSnap && dirSnap.exists())?dirSnap.val():{};
    const menuDay= menuSnap.exists()?menuSnap.val():{};
    const choice = choicePair(menuDay);

    // Хто рахується. Постійна відповідь дає обід щодня; запис дня його
    // скасовує або, навпаки, додає тому, хто зазвичай не обідає.
    const keys = [...new Set([...Object.keys(plans), ...Object.keys(days)])];
    const rows = keys.map(se => {
      const plan = plans[se] || {};
      const ov   = days[se] || null;
      const on   = (ov && ov.lunch !== undefined) ? !!Number(ov.lunch) : !!plan.lunch;
      const nm   = (dir[se] && dir[se].name) || String(se).replace(/_/g,'.');
      const role = (dir[se] && dir[se].role) || '';
      return { se, name: nm, role, on, pick: (ov && ov.pick) || 'a',
               permanent: !!plan.lunch, once: !!(ov && ov.lunch !== undefined) };
    }).filter(r => r.on).sort((a,b)=>String(a.name).localeCompare(String(b.name),'uk'));

    const pa = rows.filter(r=>r.pick==='a').length;
    const pb = rows.filter(r=>r.pick==='b').length;
    const sum = price ? rows.length * price : 0;

    if(!rows.length){
      box.innerHTML = `<div class="k-ord-sum"><b>0</b> обідів для персоналу
        <span>${escHtml(human(date))}</span></div>
        <p class="empty-msg">На цей день ніхто з персоналу обід не замовляв.</p>`;
      return;
    }

    box.innerHTML = `
      <div class="k-ord-sum"><b>${rows.length}</b> обідів для персоналу${
        choice?` <span class="k-ord-ab">А ${pa} / Б ${pb}</span>`:''}
        <span>${escHtml(human(date))}${price?` · на суму ${taMoney(sum)} zł`:''}</span></div>
      ${price ? '' : '<p class="k-ord-hint">Ціну обіду для персоналу ще не задано — сума не рахується.</p>'}
      <div class="k-scroll">
      <table class="k-table k-ord"><thead><tr>
        <th>Співробітник</th>${choice?'<th>Варіант</th>':''}<th>Замовлення</th>${price?'<th>Сума</th>':''}
      </tr></thead><tbody>
        ${rows.map(r=>`<tr>
          <td data-l="Співробітник">${escHtml(r.name)}</td>
          ${choice?`<td data-l="Варіант">${r.pick==='b'?'Б':'А'}</td>`:''}
          <td data-l="Замовлення">${r.once && !r.permanent ? 'разово' : 'щодня'}</td>
          ${price?`<td data-l="Сума">${taMoney(price)} zł</td>`:''}
        </tr>`).join('')}
      </tbody></table></div>`;
  }catch(e){
    box.innerHTML = `<p style="color:red;font-size:.8rem;">Помилка: ${escHtml(e.message)}</p>`;
  }
};

// Ціна обіду для персоналу. Одне число, тому й форма одна.
// Усі чотири ціни — однією формою: обід, сніданок, підвечірок і обід
// персоналу. Окремі кнопки «зберегти» біля кожного поля дали б чотири
// нагоди зберегти половину.
window.saveMealPrices = async function(){
  const num = (id) => {
    const el = document.getElementById(id);
    if(!el) return null;
    const raw = String(el.value||'').trim().replace(',','.');
    if(!raw) return 0;                       // порожнє поле = ціни немає
    const v = Number(raw);
    return (!/^\d+(?:\.\d{1,2})?$/.test(raw) || v < 0 || v > 999) ? null : v;
  };
  const vals = { lunch:num('k-price-lunch'), breakfast:num('k-price-brk'),
                 snack:num('k-price-snack'), staff:num('k-price-staff') };
  if(Object.values(vals).some(v => v === null))
    return alert('Ціна має бути від 0 до 999 і містити не більше двох знаків після коми.');
  try{
    const effectiveDate = new Date().getHours() >= BREAKFAST_CUTOFF_HOUR
      ? nextWorkday(localDateString) : localDateString;
    const [previous, todayHistory] = await Promise.all([
      loadMealPrices(true,true), get(child(ref(db),`meal_price_history/${localDateString}`))
    ]);
    const changes = {
      meal_prices: vals,
      [`meal_price_history/${effectiveDate}`]: {...vals,ts:Date.now()}
    };
    if(effectiveDate!==localDateString && !todayHistory.exists())
      changes[`meal_price_history/${localDateString}`]={...previous,ts:Date.now()};
    await update(ref(db), changes);
    invalidateMealPrices();
    logAction('meal_price', { value:`обід ${vals.lunch} · сніданок ${vals.breakfast} · `
      + `підвечірок ${vals.snack} · персонал ${vals.staff}` });
    showToast(`✅ Нові ціни діють з ${human(effectiveDate)}`);
    window.loadStaffOrders();
    if(document.getElementById('k-stats')) window.loadMealStats();
  }catch(e){ alert('Не вдалося зберегти: ' + e.message); }
};

window.loadMealPricesForm = async function(){
  const p = await loadMealPrices(true);
  const put = (id, v) => { const el = document.getElementById(id); if(el) el.value = v || ''; };
  put('k-price-lunch', p.lunch); put('k-price-brk', p.breakfast);
  put('k-price-snack', p.snack); put('k-price-staff', p.staff);
};

// Підтвердження, яке працює і на планшеті.
//
// ЧОМУ НЕ ПРОСТО confirm(). Коли портал відкрито як застосунок з головного
// екрана (а на кухні це саме планшет), у ряді версій iOS вікна confirm()
// не показуються — виклик повертає false, і дія тихо не відбувається.
// Кнопка «додати обід» просто перестає працювати, без жодного пояснення.
//
// Усі дії кухні тут зворотні одним натисканням, тож у цьому режимі
// виконуємо одразу, а що саме сталося — кажемо повідомленням після.
function askConfirm(msg){
  const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
    || window.navigator.standalone === true;
  if(standalone) return true;
  return confirm(msg);
}

// ── Ручна порція від кухні ──────────────────────────────────────
//
// НАВІЩО. Дитина спізнилася, батьки забули, хтось підійшов до адміністрації
// вже після дедлайну — і на це не було жодної відповіді в порталі, крім
// «домовтеся усно». Тепер кухня може дописати чи зняти порцію сама.
//
// ДЕДЛАЙНУ ТУТ НЕМАЄ СВІДОМО. 09:00 існує, щоб кухня встигла закупити й
// порахувати. Кухня — саме той, хто знає, чи ще можна додати; забороняти
// це їй означало б забороняти саме те, заради чого дедлайн і був.
//
// ЗАПИС ІДЕ В ТУ САМУ ГІЛКУ, що й у батьків: meal_day/{дата}/{клас}/{ID}.
// Друге джерело правди тут завело б облік у безвихідь. Позначка manual
// лише каже, звідки взялася порція, а не міняє її суть.
window.kitchenSetMeal = async function(cls, sid, date, field, value){
  if(!cls || !sid || !date) return;
  const LABEL = { lunch:'обід', breakfast:'сніданок', snack:'підвечірок' };
  let name=stuName(cls,sid);
  if(!askConfirm(`${value ? 'Додати' : 'Зняти'} ${LABEL[field] || field}: ${name}, ${human(date)}?`)) return;
  try{
    const closed=await get(child(ref(db),`meal_ledger/${cls}/${sid}/${date}`));
    if(closed.exists())return alert('Цей день уже зафіксований у журналі списань. Змініть суму через «Корекція списання» в балансі харчування — інакше замовлення та гроші розійдуться.');
    const dir=await getStudentDir(cls);name=dir.byId[sid]||name;
    const plan = await readMealCopies(`meal_plan/${cls}`,sid,name)||{};
    const path = `meal_day/${date}/${cls}/${sid}`;
    const cur = {...(await readMealCopies(`meal_day/${date}/${cls}`,sid,name)||{})};
    const patch = dayFieldPatch(plan, field, value, weekdayIdx(date));
    // null означає «збігається з постійним планом» — тоді поправка не
    // потрібна взагалі, і зайвий запис у базі був би сміттям у звітах
    if(patch === null) delete cur[field]; else cur[field] = patch;
    if(field === 'breakfast' && !value) delete cur.breakfastPick;
    if(field === 'lunch' && !value) delete cur.pick;
    cur.by = currentUserData?.email || '';
    cur.ts = Date.now();
    cur.manual = true;
    const writes={[path]:cur};
    await update(ref(db),writes);
    logAction('meal_day', { date, target:name,
      value:`кухня: ${LABEL[field]||field} ${value ? 'додано' : 'знято'}` });
    showToast(value ? `✓ ${LABEL[field]||field} додано` : `✕ ${LABEL[field]||field} знято`);
    loadClassOrders();
    // Загальний підрахунок теж міняється — інакше кухня побачила б старе число
    if(window.refreshKitchen) window.refreshKitchen();
  }catch(e){
    alert('Не вдалося змінити: ' + e.message);
  }
};

// ── Записи, які не звелися з жодним учнем класу ─────────────────
//
// НАВІЩО ЦЕ ПОКАЗУВАТИ. Відповідь батьків лежить у базі під якимось
// ключем. Кухня перебирає список класу і шукає запис за ідентифікатором
// або за імʼям учня. Якщо ключ не збігається ні з тим, ні з тим — запис
// існує, але його ніхто не бачить: у звіті стоїть варіант за замовчуванням,
// і всі впевнені, що батьки нічого не обирали.
//
// Досі це було невидимо, і причину доводилося вгадувати. Тепер кухня
// бачить сам ключ — і по ньому одразу зрозуміло, що не так: чуже написання
// імені, дитина зі старого списку, запис не того класу.
export function orphanKeys(overrides, plans, students){
  const known = new Set();
  for(const sid in (students || {})){
    known.add(sid);
    known.add(String(students[sid]));
  }
  const out = [];
  const collect = (node, what) => {
    for(const k in (node || {})){
      if(known.has(k)) continue;
      out.push({ key:k, what, data:node[k] });
    }
  };
  collect(overrides, 'поправка на день');
  collect(plans, 'постійні налаштування');
  return out;
}

function orphanBlock(overrides, plans, students){
  const list = orphanKeys(overrides, plans, students);
  if(!list.length) return '';
  const describe = (o) => {
    const d = o.data || {};
    const bits = [];
    if(d.pick) bits.push(`варіант обіду ${String(d.pick).toUpperCase()}`);
    if(d.breakfastPick) bits.push(`варіант сніданку ${String(d.breakfastPick).toUpperCase()}`);
    if(d.lunch !== undefined) bits.push(d.lunch ? 'обід' : 'без обіду');
    if(d.breakfast !== undefined) bits.push(d.breakfast ? 'сніданок' : 'без сніданку');
    if(d.snack !== undefined) bits.push(d.snack ? 'підвечірок' : 'без підвечірка');
    if(d.lunch === false) bits.push('не харчується');
    return bits.join(', ') || '—';
  };
  return `<div class="k-orphan">
    <b>⚠️ Записи, які не звелися з учнями класу: ${list.length}</b>
    <p>Ці відповіді батьків збережені, але кухня їх НЕ рахує: ключ запису не
       збігається ні з ідентифікатором учня, ні з його імʼям у списку класу.
       Найчастіша причина — імʼя дитини записане в списку класу інакше, ніж
       у прив'язці батьків. Покажіть це класному керівнику.</p>
    <ul>${list.map(o=>`<li><code>${escHtml(o.key)}</code> — ${escHtml(describe(o))}
      <span>(${escHtml(o.what)})</span></li>`).join('')}</ul>
  </div>`;
}

// Варіант А/Б — кухня може перемкнути.
//
// НАВІЩО. Дитина підійшла і сказала, що хоче гречку, а не рис; батьки
// помилилися кнопкою; хтось передумав уже на роздачі. Досі це можна було
// тільки запамʼятати.
// ЯКЩО ОБІДУ НЕМАЄ — НЕ ПІДСВІЧУЄМО НІЧОГО.
//
// Раніше порожній вибір показувався як А: у коді стояло `pick || 'a'`.
// Для дитини, яка взагалі не обідає, кухня бачила підсвічену А — так,
// ніби хтось справді обрав рис. Порція від цього не зʼявлялася, але в
// таблиці, за якою готують, стояла неправда.
//
// Тепер А підсвічується лише тоді, коли обід є: або дитина обідає
// постійно, або взяла обід саме на цей день. Інакше обидві кнопки сірі —
// і кухня одразу бачить, що вибирати нема кому.
function pickCell(cls, sid, date, pick){
  const cur = pick || '';
  if(!canEditMeals())
    return cur ? `<span class="k-ab ${cur}">${cur.toUpperCase()}</span>`
               : '<span class="k-no">—</span>';
  return ['a','b'].map(v => `<button type="button" class="k-ab-btn${v===cur?' on '+v:''}"
    onclick="kitchenSetPick('${escJs(cls)}','${escJs(sid)}','${escJs(date)}','${v}')"
    data-tip="Обрати варіант ${v.toUpperCase()}">${v.toUpperCase()}</button>`).join('');
}

function breakfastPickCell(cls, sid, date, pick){
  const cur = pick || '';
  if(!canEditMeals())
    return cur ? `<span class="k-ab ${cur}">${cur.toUpperCase()}</span>`
               : '<span class="k-no">—</span>';
  return ['a','b'].map(v => `<button type="button" class="k-ab-btn${v===cur?' on '+v:''}"
    onclick="kitchenSetBreakfastPick('${escJs(cls)}','${escJs(sid)}','${escJs(date)}','${v}')"
    data-tip="Обрати варіант сніданку ${v.toUpperCase()}">${v.toUpperCase()}</button>`).join('');
}

window.kitchenSetPick = async function(cls, sid, date, value){
  let name = stuName(cls, sid);
  const v = value === 'b' ? 'b' : 'a';
  if(!askConfirm(`Варіант ${v.toUpperCase()} для ${name}, ${human(date)}?`)) return;
  try{
    if((await get(child(ref(db),`meal_ledger/${cls}/${sid}/${date}`))).exists())
      return alert('День уже зафіксовано. Вибір у журналі змінити не можна.');
    const dir=await getStudentDir(cls);name=dir.byId[sid]||name;
    const path = `meal_day/${date}/${cls}/${sid}`;
    const cur = {...(await readMealCopies(`meal_day/${date}/${cls}`,sid,name)||{})};
    cur.pick = v;
    cur.pickTs = Date.now();   // хто саме поставив — видно з cur.by нижче
    cur.by = currentUserData?.email || '';
    cur.ts = Date.now();
    cur.manual = true;
    const writes={[path]:cur};
    await update(ref(db),writes);
    logAction('meal_day', { date, target:name, value:`кухня: варіант ${v.toUpperCase()}` });
    showToast(`✓ Варіант ${v.toUpperCase()}`);
    loadClassOrders();
    if(window.refreshKitchen) window.refreshKitchen();
  }catch(e){ alert('Не вдалося змінити: ' + e.message); }
};

window.kitchenSetBreakfastPick = async function(cls, sid, date, value){
  let name = stuName(cls, sid);
  const v = value === 'b' ? 'b' : 'a';
  if(!askConfirm(`Сніданок ${v.toUpperCase()} для ${name}, ${human(date)}?`)) return;
  try{
    if((await get(child(ref(db),`meal_ledger/${cls}/${sid}/${date}`))).exists())
      return alert('День уже зафіксовано. Вибір у журналі змінити не можна.');
    const dir=await getStudentDir(cls);name=dir.byId[sid]||name;
    const path = `meal_day/${date}/${cls}/${sid}`;
    const cur = {...(await readMealCopies(`meal_day/${date}/${cls}`,sid,name)||{})};
    cur.breakfastPick = v;
    cur.by = currentUserData?.email || '';
    cur.ts = Date.now();
    cur.manual = true;
    const writes={[path]:cur};
    await update(ref(db),writes);
    logAction('meal_day', { date, target:name, value:`кухня: сніданок ${v.toUpperCase()}` });
    showToast(`✓ Сніданок ${v.toUpperCase()}`);
    loadClassOrders();
    if(window.refreshKitchen) window.refreshKitchen();
  }catch(e){ alert('Не вдалося змінити: ' + e.message); }
};

function canEditMeals(){
  const r = currentUserData?.role;
  return r === 'kitchen' || r === 'director' || r === 'administrator';
}

// Клітинка обліку: для кухні це кнопка, для решти — просто позначка
function mealCell(cls, sid, date, field, on){
  const mark = on ? '<span class="k-yes">✓</span>' : '<span class="k-no">—</span>';
  if(!canEditMeals()) return mark;
  return `<button type="button" class="k-cell-btn" data-tip="Змінити вручну"
    onclick="kitchenSetMeal('${escJs(cls)}','${escJs(sid)}','${escJs(date)}','${field}',${on?0:1})">${mark}</button>`;
}

// ══════════════════════════════════════════════════════════════════
//  АРКУШ ЗАМОВЛЕНЬ НА ДРУК
// ══════════════════════════════════════════════════════════════════
//
// CSV годиться для обліку, але кухня з ним не працює: за ним не стати до
// плити. Потрібен аркуш, який видно з відстані витягнутої руки й на якому
// одразу написано, ЩО саме означають А і Б цього дня.
//
// ЧОМУ АЛЬБОМНА ОРІЄНТАЦІЯ Й ОДНА СТОРІНКА. Колонок вісім, а клас — до
// тридцяти дітей. У книжковій орієнтації таблиця або лізе на другий
// аркуш, або стискається до нечитабельного. Другий аркуш на кухні
// губиться, і половина класу лишається без порцій.
//
// ЧОМУ ДАТА ВЕЛИКИМИ ЛІТЕРАМИ В ШАПЦІ. Аркуші друкують щодня і кладуть
// поруч. Без дати вчорашній від сьогоднішнього не відрізнити, а різниця
// між ними — це чиїсь обіди.
const WD_UA = ['неділя','понеділок','вівторок','середа','четвер','пʼятниця','субота'];
const MON_UA = ['січня','лютого','березня','квітня','травня','червня',
                'липня','серпня','вересня','жовтня','листопада','грудня'];
export function longDate(iso){
  const [y,m,d] = String(iso||'').split('-').map(Number);
  if(!y||!m||!d) return String(iso||'');
  const dt = new Date(y, m-1, d, 12);
  return `${WD_UA[dt.getDay()]}, ${d} ${MON_UA[m-1]} ${y}`;
}

// Коли обрано варіант. Береться позначка самого вибору; у записів,
// зроблених до того, як вона зʼявилася, лишається тільки час останньої
// зміни — його й показуємо, але окремим виглядом, щоб кухня не читала
// його як точний.
//
// ЧОМУ НЕ САМА ЛИШЕ ГОДИНА. Замовлення на день можна зробити заздалегідь:
// батько відкриває меню на тиждень і розставляє варіанти в неділю. Тоді
// «07:12» на аркуші за середу — це неправда, у якій ніхто не зізнається:
// виглядає як ранок того самого дня. Тому день додаємо щоразу, коли вибір
// зроблено НЕ в день замовлення, — і в минуле, і в майбутнє (кухня теж
// править записи заднім числом).
export function pickTimeLabel(row, which, orderDate){
  // НЕМАЄ ПОРЦІЇ — НЕМАЄ Й ВИБОРУ. Дитина, яка сьогодні не обідає
  // (відмова, «не харчується», батьки не відповіли), не може мати
  // «обрано о 06:50». Позначка вибору лишається в записі назавжди, тож
  // без цієї перевірки в порожньому рядку світився час, і кухня читала
  // його як чинне замовлення.
  const val = which === 'breakfast' ? row.breakfastPick : row.pick;
  if(!val) return { text:'—', exact:false, none:true, sameDay:true };
  const explicit = which === 'breakfast' ? row.brkPickExplicit : row.pickExplicit;
  if(!explicit) return { text:'—', exact:false, none:true, sameDay:true };
  const own = which === 'breakfast' ? row.breakfastPickTs : row.pickTs;
  const t = own || row.ts;
  if(!t) return { text:'—', exact:false, none:true, sameDay:true };
  const d = new Date(t);
  const p2 = n => String(n).padStart(2,'0');
  const iso = `${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())}`;
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const sameDay = !orderDate || iso === orderDate;
  return { text: sameDay ? hm : `${p2(d.getDate())}.${p2(d.getMonth()+1)} ${hm}`,
           exact: !!own, none:false, sameDay };
}

// mode === 'pdf' — та сама дія, але з підказкою.
//
// ЧОМУ НЕ ОКРЕМИЙ ГЕНЕРАТОР PDF. Зробити PDF у браузері можна двома
// шляхами. Бібліотека на кшталт html2pdf малює сторінку в картинку: текст
// перестає бути текстом (не шукається, не копіюється), кирилиця летить
// разом зі шрифтом, три сторінки таблиці важать мегабайти, а розриви
// сторінок лягають посеред рядків. Друк самого браузера дає справжній
// векторний PDF із тим самим Nunito, розривами, які ми описали в CSS, і
// вагою в сотню кілобайтів. Тож кнопка одна й та сама — різниця лише в
// тому, що людині кажуть, що саме обрати у вікні.
window.printClassOrders = function(mode){
  const o = window.__classOrders;
  const holder = document.getElementById('print-area');
  if(!o || !holder) return;
  const { cls, date, rows, menu } = o;
  const allMode = !!o.all;
  const choice = choicePair(menu||{});
  const brkChoice = breakfastChoicePair(menu||{});
  const showBrk = !!String((menu||{}).breakfast||'').trim() || rows.some(r=>r.breakfast);
  const t = orderTotals(rows);
  const groups = groupByClass(rows);

  // Щільність рядків підбираємо під клас: 30 дітей і 12 дітей не мають
  // друкуватися однаково дрібно. У режимі «всі класи» аркуш усе одно
  // багатосторінковий, тож тиснути шрифт до нечитаного немає сенсу —
  // беремо середню щільність.
  const dens = allMode ? 'ko-s' : rows.length > 26 ? 'ko-xs' : rows.length > 18 ? 'ko-s' : '';

  const cellMark = on => on ? '<span class="ko-y">✓</span>' : '<span class="ko-n">—</span>';
  // Кольоровий значок = батьки справді натиснули. Блідий «А» = ніхто не
  // обирав, працює правило «якщо не змінювали — діє А». Кухні це видно
  // з одного погляду, і питання «а він точно обрав?» відпадає.
  // «Б» за замовчуванням не буває: правило замовчування — завжди А. Тож
  // навіть якщо позначка явності десь загубилася, Б лишається кольоровим.
  const ab = (v, explicit) => !v ? '<span class="ko-n">—</span>'
    : `<span class="ko-ab ko-${v}${(explicit||v==='b')?'':' ko-def'}">${v.toUpperCase()}</span>`;
  const tm = (r, which, has) => {
    if(!has) return '';
    const t2 = pickTimeLabel(r, which, date);
    // Вибір з іншого дня позначаємо й кольором: у стовпчику однакових годин
    // самої лише дати легко не помітити.
    return `<td class="ko-t${t2.exact?'':' ko-approx'}${t2.sameDay?'':' ko-other'}">${t2.none?'—':escHtml(t2.text)}</td>`;
  };
  const cols = 2 + (allMode?1:0) + (showBrk?1:0) + (brkChoice?2:0) + 1 + (choice?2:0) + 1 + 1;
  // Нумерація в суцільному списку починається заново в кожному класі:
  // кухня рахує порції класами, і «учень №137» їй ні про що не говорить.
  const line = (r,i)=>`<tr class="${r.absent?'ko-abs':''}${r.noReply?' ko-nore':''}">
        <td class="ko-num">${i+1}</td>
        ${allMode?`<td class="ko-cl">${escHtml(String(classNum(r.cls)))}</td>`:''}
        <td class="ko-name">${escHtml(r.name)}</td>
        ${showBrk?`<td>${cellMark(r.breakfast)}</td>`:''}
        ${brkChoice?`<td>${ab(r.breakfastPick,r.brkPickExplicit)}</td>${tm(r,'breakfast',true)}`:''}
        <td>${cellMark(r.lunch)}</td>
        ${choice?`<td>${ab(r.pick,r.pickExplicit)}</td>${tm(r,'lunch',true)}`:''}
        <td>${cellMark(r.snack)}</td>
        <td class="ko-note">${r.noReply?'<b>нема відповіді</b>':''}${r.noReply&&r.note?' · ':''}${escHtml(r.note||'')}</td>
      </tr>`;
  // Роздільник класу несе власний підсумок: без нього, щоб дізнатися,
  // скільки порцій нести в 4-й, довелося б рахувати галочки очима.
  const sep = g=>`<tr class="ko-clsrow"><td colspan="${cols}">
        <b>${escHtml(String(classNum(g.cls)))} клас</b> · ${g.totals.total} учнів
        ${showBrk?` · ${g.totals.brk} сніданків${brkChoice?` (А ${g.totals.bpa} / Б ${g.totals.bpb})`:''}`:''}
        · ${g.totals.lunch} обідів${choice?` (А ${g.totals.pa} / Б ${g.totals.pb})`:''}
        · ${g.totals.snack} підвечірків
        ${g.totals.noReply?` · <span class="ko-cw">${g.totals.noReply} без відповіді</span>`:''}</td></tr>`;

  holder.innerHTML = `<div class="ps-sheet ko-sheet ${dens}${allMode?' ko-all':''}">
    <div class="ko-head">
      <div class="ko-brand"><span class="ko-logo">PUSH<small>school</small></span></div>
      <div class="ko-mid">
        <div class="ko-title">Замовлення харчування</div>
        <div class="ko-cls">${allMode?`усі класи · ${groups.length} ${groups.length===1?'клас':'класів'} · ${t.total} учнів`:`${escHtml(cls.replace('class_',''))} клас`}</div>
      </div>
      <div class="ko-date"><b>${escHtml(longDate(date))}</b><span>${escHtml(human(date))}</span></div>
    </div>

    <div class="ko-sum">
      ${showBrk?`<span><b>${t.brk}</b> сніданків${brkChoice?` · А ${t.bpa} / Б ${t.bpb}`:''}</span>`:''}
      <span><b>${t.lunch}</b> обідів${choice?` · А ${t.pa} / Б ${t.pb}`:''}</span>
      <span><b>${t.snack}</b> підвечірків</span>
      ${t.noReply?`<span class="ko-warn"><b>${t.noReply}</b> без відповіді</span>`:''}
      ${t.absent?`<span class="ko-warn"><b>${t.absent}</b> відсутніх</span>`:''}
    </div>

    ${(brkChoice||choice)?`<div class="ko-menu">
      ${brkChoice?`<div><b>Сніданок</b> А — ${escHtml(brkChoice.a)} · Б — ${escHtml(brkChoice.b)}</div>`:''}
      ${choice?`<div><b>Вибір на ${escHtml(choice.label)}</b> А — ${escHtml(choice.a)} · Б — ${escHtml(choice.b)}</div>`:''}
    </div>`:''}

    <table class="ko-table"><thead><tr>
      <th class="ko-num">№</th>${allMode?'<th class="ko-cl">Клас</th>':''}<th class="ko-name">Учень</th>
      ${showBrk?'<th>Сніданок</th>':''}${brkChoice?'<th>А/Б</th><th>Коли обрано</th>':''}
      <th>Обід</th>${choice?'<th>А/Б</th><th>Коли обрано</th>':''}
      <th>Підвечірок</th><th class="ko-note">Примітка</th>
    </tr></thead><tbody>
      ${allMode
        ? groups.map(g=>sep(g) + g.rows.map(line).join('')).join('')
        : rows.map(line).join('')}
    </tbody></table>

    <div class="ko-foot">
      <span>Блідий <span class="ko-ab ko-a ko-def">А</span> — варіант не обирали, діє за замовчуванням. Курсивний час — остання зміна запису, а не сам вибір. Із датою — обрано в інший день.</span>
      <span>Push School Warsaw · надруковано ${escHtml(new Date().toLocaleString('uk-UA',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}))}</span>
    </div>
  </div>`;
  // НАЗВА ДОКУМЕНТА СТАЄ ІМЕНЕМ ФАЙЛУ. Саме її браузер підставляє в
  // «Зберегти як PDF». Без цього на диску зʼявляється «Push School» або
  // «cabinet.html», і за тиждень уже не зрозуміло, чий це день і клас.
  const prevTitle = document.title;
  document.title = `Замовлення харчування ${human(date)} — ${allMode?'усі класи':cls.replace('class_','')+' клас'}`;
  const go = ()=>{
    document.body.classList.add('printing');
    window.print();
    setTimeout(()=>{
      document.body.classList.remove('printing');
      holder.innerHTML='';
      document.title = prevTitle;
    },600);
  };
  // Друк блокує сторінку, тож підказці треба дати мить намалюватися —
  // інакше людина побачить її вже після того, як закриє вікно друку.
  if(mode === 'pdf'){ showToast('У вікні друку оберіть «Зберегти як PDF»'); setTimeout(go, 400); }
  else go();
};

window.exportClassOrders = function(){
  const o = window.__classOrders;
  if(!o) return;
  const allMode = !!o.all;
  const rows = sortOrderRows(o.rows);
  // Дата — першим рядком, а не лише в назві файлу: назву при пересиланні
  // часто втрачають, а таблиця без дня нічого не варта.
  const csv = [`Замовлення харчування;${allMode?'усі класи':`${o.cls.replace('class_','')} клас`};${longDate(o.date)}`, '',
    // Клас окремою колонкою — щоб у таблиці можна було відсортувати й
    // порахувати зведення, не розрізаючи файл руками.
    `${allMode?'Клас;':''}Учень;Сніданок;Варіант сніданку;Коли обрано;Обід;Варіант обіду;Коли обрано;Підвечірок;Примітка`,
    // У вивантаженні той самий стан, що й на екрані: інакше кухня друкує
    // список, у якому «нема відповіді» виглядає порожнім рядком
    ...rows.map(r=>{
      const bt=pickTimeLabel(r,'breakfast',o.date), lt=pickTimeLabel(r,'lunch',o.date);
      return `${allMode?classNum(r.cls)+';':''}${r.name};${r.breakfast?'так':'ні'};${r.breakfastPick?r.breakfastPick.toUpperCase():'—'};${bt.text}${bt.exact?'':'*'};${r.lunch?'так':'ні'};${r.pick?r.pick.toUpperCase():'—'};${lt.text}${lt.exact?'':'*'};${r.snack?'так':'ні'};${r.noReply?('НЕМА ВІДПОВІДІ ВІД БАТЬКІВ'+(r.note?' · '+r.note:'')):r.note}`;
    }),
    '', '* — час останньої зміни запису, а не самого вибору варіанта',
    'Якщо вказано дату — варіант обрано не в день замовлення'].join('\n');
  const blob = new Blob(['﻿'+csv], {type:'text/csv;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `zamovlennya_${allMode?'usi-klasy':o.cls}_${o.date}.csv`;
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
    const rows = await computeMealStats(from, to, null, null, true);
    if(!rows.length){ box.innerHTML = '<p class="empty-msg">За цей період даних немає.</p>'; return; }
    const tot = rows.reduce((a,r)=>({lunch:a.lunch+r.lunch, snack:a.snack+r.snack, brk:a.brk+(r.brk||0)}),{lunch:0,snack:0,brk:0});
    const byClass = {};
    rows.forEach(r=>{
      byClass[r.cls] = byClass[r.cls] || {lunch:0,snack:0,brk:0,cost:0};
      byClass[r.cls].lunch+=r.lunch; byClass[r.cls].snack+=r.snack;
      byClass[r.cls].brk+=(r.brk||0);
      byClass[r.cls].cost=Math.round((byClass[r.cls].cost+r.cost.total)*100)/100;
    });
    // Гроші показуємо, лише якщо ціни задані: колонка з нулями в кожному
    // рядку виглядає як «усе безкоштовно», а це не так — це «ціну ще не
    // внесли», і сплутати їх дорожче, ніж не показати колонку.
    const prices = await loadMealPrices();
    const sumAll = rows.reduce((a,r)=>{
      for(const k of ['lunch','brk','snack','takeaway','adjustments','total']) a[k]=Math.round((a[k]+r.cost[k])*100)/100;
      return a;
    },{lunch:0,brk:0,snack:0,takeaway:0,adjustments:0,total:0});
    const money$ = hasPrices(prices) || sumAll.total !== 0;
    const warnings=rows.flatMap(r=>r.flags||[]);
    box.innerHTML = `
      <div class="k-total"><b>${tot.lunch}</b><span>людино-днів з обідом</span>
        <div class="k-total-snack">${tot.brk?`${tot.brk} зі сніданком · `:''}+ ${tot.snack} з підвечірком</div></div>
      ${money$ ? `<div class="k-total k-total-money"><b>${taMoney(sumAll.total)} zł</b><span>разом за період за цінами відповідних днів</span>
        <div class="k-total-snack">обіди ${taMoney(sumAll.lunch)}${
          sumAll.brk?` · сніданки ${taMoney(sumAll.brk)}`:''}${
          sumAll.snack?` · підвечірки ${taMoney(sumAll.snack)}`:''}${
          sumAll.takeaway?` · на винос ${taMoney(sumAll.takeaway)}`:''}${
          sumAll.adjustments?` · корекції ${taMoney(sumAll.adjustments)}`:''}</div></div>` : ''}
      <div class="k-sub">${escHtml(human(from))} — ${escHtml(human(to))}</div>
      ${warnings.length?`<div class="k-orphan"><b>⚠️ Після закриття дня виявлено ${warnings.length} змін відвідуваності або замовлень.</b><p>Зафіксована сума не змінюється автоматично. Перевірте особовий рахунок і внесіть корекцію списання, якщо потрібно.</p><ul>${warnings.map(w=>`<li>${escHtml(w)}</li>`).join('')}</ul></div>`:''}
      <div class="k-scroll"><table class="k-table"><thead><tr><th>Клас</th><th>Снід.</th><th>Обіди</th><th>Підвеч.</th>${money$?'<th>Сума</th>':''}</tr></thead><tbody>
        ${Object.keys(byClass).sort((a,b)=>a-b).map(c=>`<tr><td>${c}</td><td>${byClass[c].brk||''}</td><td><b>${byClass[c].lunch}</b></td><td>${byClass[c].snack||''}</td>${
          money$?`<td>${taMoney(byClass[c].cost)} zł</td>`:''}</tr>`).join('')}
      </tbody></table></div>
      <div class="k-skip-title">Поіменно</div>
      <div class="k-scroll"><table class="k-table"><thead><tr><th>Учень</th><th>Кл.</th><th>Снід.</th><th>Обіди</th><th>Підвеч.</th>${money$?'<th>Сума</th>':''}</tr></thead><tbody>
        ${rows.sort((a,b)=>b.lunch-a.lunch || a.name.localeCompare(b.name,'uk'))
              .map(r=>`<tr><td>${escHtml(r.name)}</td><td>${r.cls}</td><td>${r.brk||''}</td><td><b>${r.lunch}</b></td><td>${r.snack||''}</td>${
                money$?`<td>${taMoney(r.cost.total)} zł</td>`:''}</tr>`).join('')}
      </tbody></table></div>
      <button onclick="exportMealStats()" style="background:var(--brand-soft);color:var(--brand-ink);border:1px solid var(--brand-line);margin-top:11px;">📄 Вивантажити CSV</button>`;
    window.__mealStats = { from, to, rows };
  }catch(e){
    box.innerHTML = `<p style="color:red;font-size:.8rem;">Помилка: ${escHtml(e.message)}</p>`;
  }
};

// ══════════════════════════════════════════════════════════════════
//  ЦІНИ НА ХАРЧУВАННЯ
// ══════════════════════════════════════════════════════════════════
//
//   meal_prices = {lunch, breakfast, snack, staff}
//
// ОДНА АРИФМЕТИКА НА ВСІХ. Суму бачать троє: кухня у звіті, батько у
// своїй статистиці й співробітник у власному блоці. Якби кожен рахував
// сам, перше ж розходження в копійку перетворилося б на розмову «а в
// мене інша цифра», у якій правих немає. Тому рахунок тут, один.
//
// ЦІНИ, ЯКОЇ НЕМАЄ, НЕ ІСНУЄ. Незаданa ціна — це нуль, але нуль у сумі
// й «безкоштовно» — різні речі, тому показ вирішує окремо: там, де
// жодної ціни не задано, сум не показуємо взагалі.
let pricesCache = null;
export async function loadMealPrices(force, strict=false){
  if(pricesCache && !force) return pricesCache;
  try{
    const snap = await get(child(ref(db),'meal_prices'));
    const v = snap.exists() ? (snap.val()||{}) : {};
    pricesCache = { lunch: Number(v.lunch)||0, breakfast: Number(v.breakfast)||0,
                    snack: Number(v.snack)||0, staff: Number(v.staff)||0 };
  }catch(e){
    if(strict) throw e;
    // Ціни — прикраса звіту, а не умова його роботи: без них показуємо
    // кількості, як і раніше.
    console.warn('[Push School] ціни харчування:', e.message);
    pricesCache = { lunch:0, breakfast:0, snack:0, staff:0 };
  }
  return pricesCache;
}
export function invalidateMealPrices(){ pricesCache = null; }

// Скільки коштує набір «стільки обідів, стільки сніданків, стільки
// підвечірків». Чиста функція: жодної бази, жодного DOM.
export function mealCost(counts, prices){
  const p = prices || {};
  const n = k => Number((counts||{})[k]) || 0;
  const lunch = n('lunch') * (Number(p.lunch)||0);
  const brk   = n('brk')   * (Number(p.breakfast)||0);
  const snack = n('snack') * (Number(p.snack)||0);
  const r = v => Math.round(v*100)/100;
  return { lunch:r(lunch), brk:r(brk), snack:r(snack), total:r(lunch+brk+snack) };
}
export function mealPriceAt(date,current,history){
  const all=Object.keys(history||{}).sort(),keys=all.filter(d=>d<=date);
  return keys.length ? (history[keys[keys.length-1]]||current||{})
       : all.length ? (history[all[0]]||current||{}) : (current||{});
}
// Чи є сенс показувати гроші взагалі
export function hasPrices(prices){
  const p = prices || {};
  return !!(Number(p.lunch) || Number(p.breakfast) || Number(p.snack) || Number(p.staff));
}

// Для звітів і балансу рахуємо тільки страви, які справді були в меню.
// Вибір А/Б впливає на кухонний розподіл порцій, але не подвоює їхню ціну.
export function servedMeals(e, menuDay){
  const m=menuDay||{};
  if(!menuHasFood(m)) return {lunch:false, snack:false, breakfast:false};
  return {
    lunch:!!e.lunch && !!(m.first || m.second || m.second2 || m.side || m.side2),
    snack:!!e.snack && !!m.snack,
    breakfast:!!e.breakfast && !!String(m.breakfast||'').trim()
  };
}

// Спільний рахунок для кухні і для батьків. onlyCls/onlyName звужують вибірку.
export async function computeMealStats(from, to, onlyCls, onlyName, withCost=false){
  // Обидва вузли ключуються датою, тож просимо лише обраний період.
  // Раніше статистика за тиждень качала весь навчальний рік.
  const [stSnap, planSnap, att, days] = await Promise.all([
    get(child(ref(db),'students_list')),
    get(child(ref(db),'meal_plan')),
    getSchoolRange('attendance', from, to, withCost),
    getDateRange('meal_day', from, to, withCost)
  ]);
  const students = stSnap.exists()?stSnap.val():{};
  const plans    = planSnap.exists()?planSnap.val():{};
  const [currentPrices, priceHistory, ledgerAll, takeawayDays, takeawayItems, takeawayHistory, adjustmentsAll] = withCost ? await Promise.all([
    loadMealPrices(true,true),
    get(child(ref(db),'meal_price_history')).then(s=>s.exists()?s.val():{}),
    get(child(ref(db),'meal_ledger')).then(s=>s.exists()?s.val():{}),
    getDateRange('takeaway_orders',from,to,true),
    get(child(ref(db),'takeaway_items')).then(s=>s.exists()?s.val():{}),
    get(child(ref(db),'takeaway_price_history')).then(s=>s.exists()?s.val():{}),
    get(child(ref(db),'meal_ledger_adjustments')).then(s=>s.exists()?s.val():{})
  ]) : [{},{},{},{},{},{},{}];

  const dateList = [];
  const d = new Date(from+'T12:00:00'), end = new Date(to+'T12:00:00');
  while(d <= end){
    const wd = d.getDay();
    if(wd>=1 && wd<=5) dateList.push(iso(d));   // вихідні не рахуємо
    d.setDate(d.getDate()+1);
  }
  const noSchool = await loadNoSchoolDays(dateList, true);
  const menus = {};
  for(let i=0;i<dateList.length;i+=30){
    const chunk=dateList.slice(i,i+30);
    const snaps=await Promise.all(chunk.map(date=>get(child(ref(db),`menu/${date}`))));
    chunk.forEach((date,j)=>{ menus[date]=snaps[j].exists()?snaps[j].val():null; });
  }
  // Закритий день лишається робочим у звіті, навіть якщо згодом меню
  // видалили або заднім числом змінили навчальний календар.
  const ledgerServiceDays=new Set();
  if(withCost){
    for(const [cls, classRows] of Object.entries(ledgerAll||{})){
      if(onlyCls&&cls!==onlyCls)continue;
      for(const studentRows of Object.values(classRows||{})){
        for(const [date, row] of Object.entries(studentRows||{})){
          if(row&&!row.closed)ledgerServiceDays.add(date);
        }
      }
    }
  }
  const serviceDays=dateList.filter(date=>ledgerServiceDays.has(date) ||
    (!noSchool[date]&&menuHasFood(menus[date]))).length;
  const out = [];
  for(let i=1;i<=11;i++){
    const cls = `class_${i}`;
    if(!students[cls]) continue;
    if(onlyCls && cls !== onlyCls) continue;
    for(const key in students[cls]){
      const name = students[cls][key];
      if(onlyName && name !== onlyName && key !== onlyName) continue;
      const plan = byKeyOrName(plans[cls],key,name);
      let lunch=0, snack=0, brk=0, absent=0, lateAbsent=0;
      const cost={lunch:0,brk:0,snack:0,takeaway:0,adjustments:0,total:0};
      const flags=[];
      dateList.forEach(date=>{
        const fixed=withCost&&ledgerAll?.[cls]?.[key]?.[date];
        if(fixed&&Number.isFinite(Number(fixed.total))){
          if(Number(fixed.total)===0 && (Number(fixed.counts?.lunch)||Number(fixed.counts?.breakfast)||Number(fixed.counts?.snack)
            || Object.keys(byKeyOrName(takeawayDays[date]?.[cls],key,name)||{}).length))
            flags.push(`${name} · ${human(date)}: у журналі нульова сума при замовленні — перевірте тариф і корекцію`);
          const nowAbsent=absentSet(att[cls]?.[date]);
          if(!!(nowAbsent[key]||nowAbsent[name])!==!!fixed.absent)
            flags.push(`${name} · ${human(date)}: відвідуваність змінена після закриття`);
          const nowOverride=mealDayFresher(days[date]?.[cls]?.[key],days[date]?.[cls]?.[name]);
          if(Number(nowOverride?.ts)>Number(fixed.sealedAt||Infinity))
            flags.push(`${name} · ${human(date)}: замовлення змінене після закриття`);
          lunch+=Number(fixed.counts?.lunch)||0;
          brk+=Number(fixed.counts?.breakfast)||0;
          snack+=Number(fixed.counts?.snack)||0;
          if(fixed.absent)absent++;
          cost.lunch=Math.round((cost.lunch+Number(fixed.lunch||0))*100)/100;
          cost.brk=Math.round((cost.brk+Number(fixed.breakfast||0))*100)/100;
          cost.snack=Math.round((cost.snack+Number(fixed.snack||0))*100)/100;
          cost.takeaway=Math.round((cost.takeaway+Number(fixed.takeaway||0))*100)/100;
          cost.total=Math.round((cost.total+Number(fixed.total||0))*100)/100;
          return;
        }
        // Відсутність скасовує страви, але не замовлення на винос.
        if(withCost){
          const order=byKeyOrName(takeawayDays[date]?.[cls],key,name)||{};
          const ta=Object.entries(order).reduce((sum,[id,q])=>sum+(Number(q)||0)*takeawayPriceAt(id,date,takeawayItems,takeawayHistory),0);
          cost.takeaway=Math.round((cost.takeaway+ta)*100)/100;
          cost.total=Math.round((cost.total+ta)*100)/100;
        }
        if(noSchool[date])return;
        const absentToday=absentSet(att[cls] && att[cls][date]);
        const abs = absentToday[key] || absentToday[name] || null;
        const ov = mealDayFresher(days[date]?.[cls]?.[key],days[date]?.[cls]?.[name]);
        // Рахуємо від плану, а відсутність застосовуємо по кожній страві
        // окремо: у сніданку власний, ранній дедлайн, і буває, що про
        // дитину повідомили після нього, але до обіднього.
        const e = effectiveMeals(plan, ov, false, weekdayIdx(date));
        const planned=servedMeals(e,menus[date]);
        const keep = m => !abs || !absenceRemovesMeal(m, date, abs.ts);
        const served={ lunch: planned.lunch && keep('lunch'),
                       snack: planned.snack && keep('snack'),
                       breakfast: planned.breakfast && keep('breakfast') };
        if(abs){
          absent++;
          if(served.lunch||served.snack||served.breakfast) lateAbsent++;
        }
        if(served.lunch) lunch++;
        if(served.snack) snack++;
        if(served.breakfast) brk++;
        if(withCost){
          const daily=mealCost({lunch:+served.lunch,brk:+served.breakfast,snack:+served.snack},
            mealPriceAt(date,currentPrices,priceHistory));
          for(const k of ['lunch','brk','snack','total']) cost[k]=Math.round((cost[k]+daily[k])*100)/100;
        }
      });
      if(withCost){
        for(const adj of Object.values(adjustmentsAll?.[cls]?.[key]||{})){
          if(!adj||adj.date<from||adj.date>to)continue;
          const amount=Number(adj.amount)||0;
          cost.adjustments=Math.round((cost.adjustments+amount)*100)/100;
          cost.total=Math.round((cost.total+amount)*100)/100;
        }
      }
      if(lunch || snack || brk || (withCost && (cost.takeaway || cost.adjustments || flags.length)))
        out.push({ cls:i, name, lunch, snack, brk, absent, lateAbsent, days:serviceDays, cost, flags });
    }
  }
  return out;
}

window.exportMealStats = function(){
  const s = window.__mealStats;
  if(!s) return;
  const csv = ['Учень;Клас;Сніданки;Обіди;Підвечірки;Страви zł;На винос zł;Корекції zł;Разом zł',
    ...s.rows.map(r=>`${r.name};${r.cls};${r.brk||0};${r.lunch};${r.snack};${taMoney(r.cost.lunch+r.cost.brk+r.cost.snack)};${taMoney(r.cost.takeaway)};${taMoney(r.cost.adjustments)};${taMoney(r.cost.total)}`)].join('\n');
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
// Чи цей день ОБРАЛА ЛЮДИНА, чи його підставив розрахунок.
//
// Різниця важлива вночі. pmDate раніше зберігався й тоді, коли його
// вибрав сам портал, — а вкладку з телефона не закривають тижнями.
// О пів на восьму ранку блок і далі показував учорашній день (він у
// тому ж тижні, тож перевірка week.includes його пропускала), і все
// замикалося написом «Цей день уже минув».
//
// Тепер збережений вибір поважаємо лише тоді, коли по ньому справді
// клацнули: подивитися минулий понеділок — законне бажання, а от
// застрягти у вчора без жодної дії — ні.
let pmPicked = false;

// Який день показати батькам за замовчуванням. Чиста функція від дати й
// години — щоб її можна було перевірити тестами, а не чекати вечора.
export function menuAnchor(dateStr, hour){
  return hour >= MENU_NEXT_DAY_HOUR ? nextWorkday(dateStr) : dateStr;
}
function menuAnchorDay(){
  return menuAnchor(localDateString, new Date().getHours());
}
window.pmShowDay = function(d){ pmDate = d; pmPicked = true; renderParentMenu(); renderTakeaway(d); };

// Другий аргумент — КЛЮЧ учня (постійний ідентифікатор), а не імʼя
export async function renderParentMenu(cls, studentKey, date){
  const isStudent = currentUserData?.role === 'student';
  const boxId = isStudent ? 's-menu' : 'p-menu';
  const box = document.getElementById(boxId);
  if(!box) return;
  cls = cls || currentUserData?.class;
  studentKey = studentKey || await mealKey(cls);
  if(!cls || !studentKey) return;

  try{
    // Явно передана дата (зміна дати в кабінеті) скидає ручний вибір дня
    if(date){ pmDate = null; pmPicked = false; }
    // Який день показати.
    //
    // Вихідний зсуваємо на найближчий робочий день, інакше тижня немає.
    // Після 17:00 так само зсуваємо на завтра: сьогоднішній обід позаду.
    // У пʼятницю ввечері nextWorkday сам перестрибне вихідні на понеділок.
    //
    // ВАЖЛИВО, ЧОМУ ТУТ ПОРІВНЯННЯ З СЬОГОДНІ. Кабінет батьків завжди
    // передає дату явно — `renderParentMenu(cls, null, date)`. Через це
    // вечірній зсув спершу не спрацьовував узагалі: явна дата перебивала
    // розрахунок. Але просто ігнорувати її не можна — якщо людина сама
    // обрала понеділок, їй треба показати понеділок, а не завтра.
    // Тому зсуваємо лише те, що і є «сьогодні».
    const anchor = date
      ? (date === localDateString ? menuAnchorDay() : date)
      : (pmDate || menuAnchorDay());
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
      return menuHasFood(v);
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
    // ОРІЄНТИР — anchor, а не «сьогодні».
    //
    // Тут була справжня причина, чому вечірній зсув не працював: anchor
    // визначав лише, який ТИЖДЕНЬ завантажити, а день нижче обирався
    // окремо й завжди тягнувся до localDateString. О 23:00 середи людина
    // й далі бачила середу, хоч anchor уже вказував на четвер.
    //
    // Тепер обидва рішення спираються на одне значення. Усе, що в ньому
    // враховано — вихідні, вечір після 17:00, вручну обрана дата, —
    // автоматично діє й на вибір дня.
    const wantDay = week.includes(anchor) ? anchor : null;
    const fallback = wantDay || week.find(d => d >= anchor) || week[0];
    // САМІ НАЗАД У ЧАСІ НЕ ХОДИМО.
    //
    // Тут останнім варіантом стояв week.find((d,i)=>has[i]) — «перший
    // день тижня, де є меню». У п'ятницю вранці, поки кухня ще не
    // виклала сьогоднішнє меню, він знаходив понеділок. Блок відкривався
    // на понеділку, mealsEditable бачив минулу дату й замикав усе
    // написом «Цей день уже минув».
    //
    // Наслідок був не косметичний: батько о 7:30 не міг відмовитися від
    // СЬОГОДНІШНЬОГО обіду, хоча до дедлайну лишалося півтори години.
    // Кнопок просто не було на екрані.
    //
    // Причина глибша за один рядок: відмова від обіду не має жодного
    // стосунку до того, чи кухня вже надрукувала меню. Меню — це «що
    // дадуть», а відмова — це meal_plan, окремий запис. Прив'язувати
    // друге до першого не можна було з самого початку.
    //
    // Тепер, якщо попереду немає дня з меню, лишаємось на сьогодні:
    // хай без переліку страв, зате з робочими кнопками.
    let cur = (pmPicked && pmDate && week.includes(pmDate)) ? pmDate
            : (wantDay && has[week.indexOf(wantDay)] ? wantDay
            : (week.find((d,i)=>has[i] && d >= anchor) || fallback));
    pmDate = cur;
    const ci = week.indexOf(cur);
    const m = menus[ci].exists() ? menus[ci].val() : null;

    // ЧИТАЄМО ЗА ДВОМА КЛЮЧАМИ — так само, як пишемо.
    //
    // Частина відповідей лежить під імʼям: або старі записи, або зроблені
    // запасним шляхом, коли правила ще не пускають запис за ідентифікатором.
    // Якщо читати лише за ідентифікатором, батько не побачить власного
    // щойно збереженого вибору — і це виглядає як «натиснув Б, лишилося А».
    const altKey = currentUserData?.studentName || '';
    // ВІДМОВА В ЧИТАННІ БІЛЬШЕ НЕ ВИГЛЯДАЄ ЯК «НІЧОГО НЕ ОБРАНО».
    //
    // Правила бази пускають сімʼю до запису лише під тим ключем, що лежить
    // у профілі. Якщо відповідь збережена під ІНШИМ ключем — а так буває,
    // коли її зробив другий з батьків, чий профіль заповнений інакше, —
    // читання відхиляється. Раніше помилка ковталася, і кабінет показував
    // варіант за замовчуванням: «у чоловіка Б, у дружини А».
    //
    // Тепер такий випадок видно, і в ньому не залишається сумніву, що це
    // саме права, а не «батьки нічого не обирали».
    let readDenied = false;
    const both = async (base) => {
      const tryGet = async (k) => {
        if(!k) return null;
        try{ return await get(child(ref(db), `${base}/${k}`)); }
        catch(e){ if(/permission/i.test(e.message||'')) readDenied = true; return null; }
      };
      const [a, b] = await Promise.all([
        tryGet(studentKey),
        (altKey && altKey !== studentKey) ? tryGet(altKey) : null
      ]);
      // Свіжіша з двох — те саме правило, що й у кухні. Інакше батько
      // й кухня дивилися б на різні копії однієї відповіді.
      return base.startsWith('meal_day/')
        ? mealDayFresher(a && a.exists() ? a.val() : null,b && b.exists() ? b.val() : null)
        : pickFresher(a && a.exists() ? a.val() : null,b && b.exists() ? b.val() : null);
    };
    const [planV, dayV, attSnap] = await Promise.all([
      both(`meal_plan/${cls}`),
      both(`meal_day/${cur}/${cls}`),
      get(child(ref(db),`attendance/${cls}/${cur}/${studentKey}`))
    ]);
    const plan = planV || {};
    const ov   = dayV;
    const isAbsent = attSnap.exists() && Object.values(attSnap.val()||{}).some(r=>r && r.status==='absent');
    const eff  = effectiveMeals(plan, ov, isAbsent, weekdayIdx(cur));
    const gate = mealsEditable(cur);
    const sGate = snackEditable(cur);
    if (isStudent) {
      gate.ok = false;
      gate.msg = 'Перегляд замовлення';
      sGate.ok = false;
      sGate.msg = 'Перегляд замовлення';
    }
    const notEating = plan.lunch === false;
    const noAnswer  = !lunchChosen(plan);   // батько ще не відповів про обіди

    const strip = week.map((d,i)=>`<button type="button" class="pm-tab${d===cur?' on':''}${has[i]?'':' empty'}"
        onclick="pmShowDay('${escJs(d)}')">
        <span>${DOW_SHORT[i]}</span><b>${escHtml(human(d).slice(0,5))}</b></button>`).join('');

    const pick = pickedSecond(m, ov);
    const bGate = breakfastEditable(cur);
    if (isStudent) {
      bGate.ok = false;
      bGate.msg = 'Перегляд замовлення';
    }
    const hasBrk = !!(m && String(m.breakfast||'').trim());
    const brkPair = breakfastChoicePair(m);
    const brkPick = pickedBreakfast(m, ov);

    // Друге виводимо окремо: коли є варіант Б, це вже не рядок меню,
    // а вибір, і виглядати він має інакше.
    // Страву, на якій цього дня стоїть вибір, зі звичайного переліку
    // прибираємо — інакше гарнір показався б двічі: рядком і кнопкою
    const ch = choicePair(m);
    const dishes = ['first','second','side','drink','dessert']
      .filter(k => !(ch && k === ch.field))
      .filter(k=>m && m[k]).map(k=>`<div class="pm-dish">${escHtml(m[k])}</div>`).join('');
    const secondBlock = (!m || !ch || !eff.lunch || noAnswer) ? '' :
      `<div class="pm-choice">
         <div class="pm-choice-title">Оберіть ${escHtml(ch.label)}${gate.ok?'':' — вибір закрито'}</div>
         ${['a','b'].map(v=>`
           <button type="button" class="pm-opt${pick===v?' on':''}"
                   ${gate.ok?`onclick="setMealDay('${escJs(cur)}','pick','${v}')"`:'disabled'}>
             <span class="pm-opt-mark">${v.toUpperCase()}</span>
             <span class="pm-opt-name">${escHtml(v==='a'?ch.a:ch.b)}</span>
             ${pick===v?'<span class="pm-opt-on">обрано</span>':''}
           </button>`).join('')}
       </div>`;

    const breakfastBlock = !hasBrk ? '' : (!brkPair
      ? `<div class="pm-snack"><b>🌅 Сніданок:</b> ${escHtml(m.breakfast)}</div>`
      : `<div class="pm-choice">
          <div class="pm-choice-title">🌅 Оберіть сніданок${eff.breakfast?'':' — спочатку додайте сніданок'}${bGate.ok?'':' — вибір закрито'}</div>
          ${['a','b'].map(v=>`<button type="button" class="pm-opt${brkPick===v&&eff.breakfast?' on':''}"
              ${(bGate.ok&&eff.breakfast)?`onclick="setMealDay('${escJs(cur)}','breakfastPick','${v}')"`:'disabled'}>
            <span class="pm-opt-mark">${v.toUpperCase()}</span>
            <span class="pm-opt-name">${escHtml(v==='a'?brkPair.a:brkPair.b)}</span>
            ${brkPick===v&&eff.breakfast?'<span class="pm-opt-on">обрано</span>':''}
          </button>`).join('')}
        </div>`);

    // Збираємо рядок стану й кнопки заздалегідь: три рівні вкладених
    // шаблонів у розмітці нечитабельні й ламаються при першій же правці.
    const chip = (on, textOn, textOff, cls='pm-dim') =>
      `<span class="${on?'pm-on':cls}">${on?textOn:textOff}</span>`;
    const statusLine =
      (hasBrk ? chip(eff.breakfast, '✓ Сніданок', 'без сніданку') : '') +
      chip(eff.lunch, notEating ? '✓ Обід (разово)' : '✓ Обід',
           noAnswer ? 'Обіди не підтверджені' : (notEating ? 'Обіди не замовлені' : '✕ Без обіду'),
           'pm-off') +
      chip(eff.snack, '✓ Підвечірок', 'без підвечірка');

    // Дитина не обідає постійно — але сьогодні може взяти обід. Без цієї
    // кнопки батькам лишалося б або вмикати постійні обіди й відмовлятися
    // щодня, або писати адміністрації. І те, й те — зайва робота для всіх.
    const oneOff = notEating && !!m
      ? `<button class="pm-btn ${eff.lunch?'back':'once'}" onclick="setMealDay('${escJs(cur)}','lunch',${eff.lunch?0:1})">${eff.lunch?'Скасувати обід на цей день':'🍽 Беру обід цього дня'}</button>`
      : '';
    // Обід і підвечірок розведено: у кожного свій дедлайн, і закритий обід
    // більше не забирає із собою кнопку підвечірка.
    const lunchBtns = gate.ok
      ? (noAnswer ? '' : (notEating ? oneOff
          : `<button class="pm-btn ${eff.lunch?'':'back'}" onclick="setMealDay('${escJs(cur)}','lunch',${eff.lunch?0:1})">${eff.lunch?'Не буде обідати':'Поверну обід'}</button>`))
      : `<span class="pm-locked">🔒 ${escHtml(gate.msg)}</span>`;
    const snackBtn = sGate.ok
      ? `<button class="pm-btn snack" onclick="setMealDay('${escJs(cur)}','snack',${eff.snack?0:1})">${eff.snack?'Без підвечірка':'+ Підвечірок'}</button>`
      : `<span class="pm-locked small">🔒 ${escHtml(sGate.msg)}</span>`;
    const brkBtn = !hasBrk ? ''
      : (bGate.ok
          ? `<button class="pm-btn brk" onclick="setMealDay('${escJs(cur)}','breakfast',${eff.breakfast?0:1})">${eff.breakfast?'Без сніданку':'+ Сніданок'}</button>`
          : `<span class="pm-locked small">🔒 ${escHtml(bGate.msg)}</span>`);
    const actions = isStudent ? '' : (lunchBtns + snackBtn + brkBtn);

    // ПИТАННЯ ПРО ОБІДИ. Поки батько не відповів, кухня цю дитину не
    // рахує — тож питання має бути помітним, а не рядком у налаштуваннях.
    const askLunch = (isStudent || !noAnswer) ? '' : `
      <div class="pm-ask">
        <b>Ваша дитина обідає в школі?</b>
        <span>Поки ви не відповіли, обіди на неї не замовляються.</span>
        <div class="pm-ask-btns">
          <button type="button" class="pm-ask-yes" onclick="setLunchPlan(1)">Так, обідає</button>
          <button type="button" class="pm-ask-no"  onclick="setLunchPlan(0)">Ні, не обідає</button>
        </div>
        <small>Відповідь можна змінити будь-коли в налаштуваннях харчування.</small>
      </div>`;

    // Дитину не знайдено в списку класу — попереджаємо ЯВНО.
    // Замовлення тоді лягають під імʼям, а кухня рахує за ідентифікаторами,
    // тож дитини в її списку немає взагалі. Мовчазний збій тут коштує обіду.
    const readWarn = !readDenied ? '' : `
      <div class="pm-warn">⚠️ <b>Портал не може прочитати частину відповідей по цій дитині.</b>
        Те, що показано нижче, може бути неповним: наприклад, вибір, зроблений
        другим із батьків, вам не видно. Це не помилка вашого телефона —
        школі потрібно оновити правила доступу до бази. Покажіть це повідомлення школі.</div>`;

    const keyWarn = !mealKeyIsName() ? '' : `
      <div class="pm-warn">⚠️ <b>Дитину не впізнано у списку класу.</b>
        Нові замовлення тимчасово заблоковані, щоб кухня їх не пропустила.
        Покажіть це повідомлення класному керівнику — ймовірно,
        імʼя дитини у списку класу й у вашій прив'язці записані по-різному.</div>`;

    box.innerHTML = `
      ${readWarn}
      ${keyWarn}
      ${askLunch}
      <div class="pm-tabs">${strip}</div>
      <div class="pm-title">${escHtml(DOW[ci])}, ${escHtml(human(cur))}${cur===localDateString?' — сьогодні':''}</div>
      ${(dishes || secondBlock) ? dishes + secondBlock : '<div class="pm-none">Меню на цей день ще не опубліковане</div>'}
      ${breakfastBlock}
      ${m && m.snack ? `<div class="pm-snack"><b>🥪 Підвечірок:</b> ${escHtml(m.snack)}</div>` : ''}
      ${m && m.allergens ? `<div class="pm-allerg">⚠️ ${escHtml(m.allergens)}</div>` : ''}
      ${m && m.note ? `<div class="pm-note">${escHtml(m.note)}</div>` : ''}

      <div class="pm-status">
        ${isAbsent
          ? '<span class="pm-off">Дитина відсутня — харчування цього дня не рахується</span>'
          : statusLine}
      </div>
      ${(ov && ov.manual && !isAbsent)
        ? '<div class="pm-manual">Цього дня харчування змінила кухня — напевно, за вашим зверненням.</div>'
        : ''}

      ${isAbsent ? '' : `<div class="pm-act">${actions}</div>`}

      <div id="pm-msg" class="pm-msg" style="display:none;"></div>

      <div class="pm-links">
        ${isStudent ? '' : `<a href="#" onclick="event.preventDefault();openMealSettings();">⚙️ Налаштування харчування</a>`}
        <a href="#" onclick="event.preventDefault();openMyMealStats();">📊 Моя статистика</a>
      </div>
      <!-- Позначка версії. Айфон уміє тримати стару сторінку днями, і
           «нічого не змінилося» найчастіше означає саме це. За рядком видно,
           який код зараз працює. -->`;
    renderTakeaway(cur);
    if(window.loadFamilyMealBalance) window.loadFamilyMealBalance();
  }catch(e){
    box.innerHTML = `<div class="pm-none">Не вдалося завантажити меню: ${escHtml(e.message)}</div>`;
  }
}

window.setMealDay = async function(date, field, value){
  const cls = currentUserData?.class, sid = await mealKey(cls);
  // МОВЧАЗНОГО ВИХОДУ ТУТ БУТИ НЕ МОЖЕ.
  //
  // Раніше стояло просто `return`. Якщо дитину не вдалося знайти у списку
  // класу, кнопка не робила рівно нічого: ні запису, ні повідомлення. Для
  // людини це «кнопка не працює», і поскаржиться вона в кращому разі через
  // тиждень — а до того щодня тиснутиме її знову.
  if(!cls || !sid) return mealNoChild();
  if(mealKeyIsName())return mealNoChild();
  // У сніданку власний дедлайн: його готують до уроків, тож 09:00 не годиться
  const gate = (field === 'breakfast' || field === 'breakfastPick') ? breakfastEditable(date)
             : (field === 'snack') ? snackEditable(date)
             : mealsEditable(date);
  if(!gate.ok) return alert(gate.msg);
  const fallbackKey = currentUserData?.studentName || '';
  let plan,cur;
  try{
    plan=await readMealCopies(`meal_plan/${cls}`,sid,fallbackKey)||{};
    cur={...(await readMealCopies(`meal_day/${date}/${cls}`,sid,fallbackKey)||{})};
  }catch(e){return mealMsg('Не вдалося прочитати попередній вибір: '+e.message,true);}
  const wd = weekdayIdx(date);
  let reason = '';
  // Причину питаємо лише в того, хто обідає постійно: там відмова — подія,
  // яку кухні корисно розуміти. У дитини, яка зазвичай не обідає, скасування
  // разового обіду — це просто повернення до звичного стану.
  if(field === 'lunch' && !value && plannedValue(plan, 'lunch', wd)){
    const answer=prompt('Причина (необовʼязково):','');
    if(answer===null)return;
    reason=answer;
  }
  const path = `meal_day/${date}/${cls}/${sid}`;
  // pick і breakfastPick зберігають літери незалежних варіантів, решта — 0/1
  //
  // ЧОМУ В А/Б СВОЯ ПОЗНАЧКА ЧАСУ. Кухня друкує аркуш замовлень і питає:
  // «коли батько обрав саме цей варіант». Спільний ts на це не відповідає —
  // він оновлюється від будь-якої дії із записом. Батько обрав Б о 07:10, а
  // о 08:40 скасував підвечірок — і ts став 08:40, хоча варіант не чіпали.
  // Тому в вибору варіанта власний час, а ts лишається «останньою зміною».
  if(field === 'pick'){ cur.pick = (value === 'b') ? 'b' : 'a'; cur.pickTs = Date.now(); }
  else if(field === 'breakfastPick'){ cur.breakfastPick = (value === 'b') ? 'b' : 'a'; cur.breakfastPickTs = Date.now(); }
  else {
    const patch = dayFieldPatch(plan, field, value, wd);
    if(patch === null) delete cur[field];
    else cur[field] = patch;
    if(field === 'breakfast' && !value) delete cur.breakfastPick;
    if(field === 'lunch' && !value) delete cur.pick;
  }
  if(reason) cur.reason = reason.trim().slice(0,120);
  cur.by = currentUserData.email || ''; cur.ts = Date.now();
  // Навіть якщо поправку скасували, лишаємо запис із новим ts: старіша
  // копія під ім'ям не має знову стати чинною. Її саму не видаляємо.
  // ЗБІЙ ЗАПИСУ БІЛЬШЕ НЕ МОВЧИТЬ.
  //
  // Раніше тут не було жодного try. Якщо база відмовляла в правах, помилка
  // просто зникала: кнопка не давала ніякого відгуку, вибір лишався
  // попереднім, і людина тиснула ще раз. Саме так виглядало «обираю Б,
  // а лишається А» — портал не показував НІЧОГО.
  //
  // Відмова тут майже завжди означає одне: у профілі users/{uid} записана
  // інша дитина, ніж та, за яку зараз натиснули. Правила бази звіряють
  // саме профіль, тож про це й кажемо прямо.
  // ЗАПАСНИЙ КЛЮЧ, ЯКЩО ПРАВИЛА ЩЕ НЕ ОПУБЛІКОВАНІ.
  //
  // Правильний ключ — постійний ідентифікатор учня. Але старі правила бази
  // дозволяють сімʼї писати лише під тим ключем, що лежить у її ПРОФІЛІ, а
  // профіль у частини батьків без ідентифікатора — і дописати його туди теж
  // не виходить. Для таких батьків будь-яке збереження просто відхиляється.
  //
  // Замість того щоб лишати людину ні з чим, пробуємо ще раз під імʼям:
  // цей шлях старі правила приймають. Кухня вміє читати обидва ключі, тож
  // відповідь не загубиться. Коли школа опублікує нові правила, перша
  // спроба почне проходити й запасна більше не знадобиться.
  const writeAt = async (key) => set(ref(db,`meal_day/${date}/${cls}/${key}`),cur);
  try{
    try{
      await writeAt(sid);
    }catch(e1){
      if(!/permission/i.test(e1.message || '') || !fallbackKey || fallbackKey === sid) throw e1;
      console.warn('meal_day: запис за ідентифікатором відхилено, пробую за імʼям');
      await writeAt(fallbackKey);
    }
  }catch(e){
    const denied = /permission/i.test(e.message || '');
    // Спершу — у саму сторінку: на айфоні alert() з домашнього екрана
    // може не показатися зовсім
    mealMsg('Не вдалося зберегти: ' + e.message
      + (denied ? ' Схоже, у профілі записана інша дитина — оновіть сторінку.' : ''), true);
    alert('Не вдалося зберегти: ' + e.message + (denied
      ? (_mealKeyProfileErr
          ? '\n\nПортал не зміг записати дитину у ваш профіль (' + _mealKeyProfileErr
            + '), а база звіряє саме його. Оновіть сторінку; якщо не мине — '
            + 'покажіть це повідомлення школі.'
          : '\n\nСхоже, у вашому профілі записана інша дитина. Перемкніть дитину '
            + 'угорі сторінки (або оновіть сторінку) і спробуйте ще раз.')
      : ''));
    return;
  }
  mealMsg('');
  showToast(field === 'pick' || field === 'breakfastPick'
    ? `✓ Обрано ${field==='breakfastPick'?'сніданок ':'варіант '}${String(value).toUpperCase()}`
    : (value ? '✓ Записано'
             : (plannedValue(plan, field, wd) ? '✕ Відмову зафіксовано' : '✓ Скасовано')));
  if(window.invalidateMealBalance) window.invalidateMealBalance();
  renderParentMenu();
};

// Під яким ключем зберігати харчування дитини.
//
// ПРОБЛЕМА. students_list заповнюється через push(), тож ключ учня — це
// згенерований ідентифікатор, а не імʼя. Кабінет батька брав
// studentId, а якщо його не було — підставляв ІМʼЯ. Кухня ж перебирає
// students_list за ідентифікаторами. У результаті запис «дитина обідає»
// лягав під імʼям, кухня його не знаходила, і в підрахунку стояв нуль.
//
// Тепер ключ шукаємо в довіднику класу за імʼям і кешуємо. Імʼя лишається
// запасним варіантом — краще записати хоч кудись, ніж втратити відповідь.
// КЕШ ПАМʼЯТАЄ ДИТИНУ, А НЕ ЛИШЕ КЛАС.
//
// Раніше ключем кешу був клас. У батьків двох дітей в ОДНОМУ класі це
// означало, що після перемикання дитини повертався ключ попередньої — і
// обидві відповіді лягали на одну дитину. У мами й тата виходили різні
// картини: у кого коли перемкнулося.
let _mealKey = null, _mealKeyFor = null, _mealKeyIsName = false, _mealKeyProfileErr = '';
export function invalidateMealKey(){ _mealKey = null; _mealKeyFor = null; }
window.invalidateMealKey = invalidateMealKey;
export async function mealKey(cls){
  const c = cls || currentUserData?.class;
  if(!c) return null;
  // Дитину впізнаємо за класом РАЗОМ з імʼям: імена в межах класу унікальні,
  // а ідентифікатора в профілі може ще не бути — саме його ми й шукаємо.
  const who = `${c}|${currentUserData?.studentId || ''}|${currentUserData?.studentName || ''}`;
  if(_mealKey && _mealKeyFor === who) return _mealKey;
  // ІДЕНТИФІКАТОР ІЗ ПРОФІЛЮ ПЕРЕВІРЯЄМО ПО СПИСКУ КЛАСУ.
  //
  // Це і є причина найдовшої плутанини: у профілі лежить КОПІЯ
  // ідентифікатора, зроблена колись при прив'язці. Якщо учня потім
  // перезавели в списку класу (видалили й додали, перевели з іншого класу),
  // у списку зʼявився НОВИЙ ключ, а копія в профілі лишилася старою.
  //
  // Далі все виглядає справним: правила бази звіряють ключ саме з профілем,
  // тож ні відмови, ні помилки немає — портал спокійно читає й пише за
  // ключем, якого в списку класу вже не існує. Батько бачить «нічого не
  // обрано», кухня не бачить його відповіді, а другий із батьків, у чиєму
  // профілі ключ правильний, бачить усе як слід. Саме так у чоловіка був
  // варіант Б, а в дружини на тій самій дитині — А.
  //
  // Тому: копії довіряємо лише тоді, коли такий ключ справді є в списку
  // класу. Інакше шукаємо заново за імʼям.
  let dir = null;
  try{ dir = await getStudentDir(c); }catch(e){ console.warn('довідник класу:', e.message); }
  const res = resolveStudentKey(dir, currentUserData?.studentId, currentUserData?.studentName);
  if(res.stale) console.warn('studentId із профілю не знайдено у списку класу — шукаю за імʼям');
  let key = res.key;
  // ЗАПИСУЄМО ЗНАЙДЕНИЙ ІДЕНТИФІКАТОР У ПРОФІЛЬ.
  //
  // Без цього кроку виходить пастка: правила доступу звіряють ключ із
  // users/{uid}.studentId, а ми почали передавати справжній ідентифікатор
  // зі списку класу. Якщо в профілі його немає, база відповідає
  // «Permission denied» — саме це й ламало налаштування харчування та
  // позиції на винос.
  _mealKeyProfileErr = '';
  if(key && currentUserData && currentUserData.studentId !== key && auth?.currentUser){
    try{
      await update(ref(db, `users/${auth.currentUser.uid}`), { studentId: key });
      currentUserData.studentId = key;
    }catch(e){
      // Профіль не оновився — а правила бази звіряють саме його. Далі
      // будь-яке збереження харчування отримає відмову, тож памʼятаємо
      // причину, щоб сказати про неї людині, а не показувати голе
      // «Permission denied».
      _mealKeyProfileErr = e.message || 'не вдалося оновити профіль';
      console.warn('studentId у профіль:', e.message);
    }
  }
  // ЧИ ЦЕ СПРАВЖНІЙ ІДЕНТИФІКАТОР.
  //
  // Коли дитину не вдалося знайти в списку класу, ключем стає імʼя. Запис
  // тоді хоч кудись потрапляє — але кухня перебирає список за
  // ідентифікаторами, тож у підрахунку цієї дитини НЕМАЄ. Мовчати про це
  // не можна: наслідок — дитина без обіду. Тому позначаємо стан і кажемо
  // про нього в кабінеті.
  _mealKeyIsName = !key;
  _mealKey = key || currentUserData?.studentName || null;
  _mealKeyFor = who;
  return _mealKey;
}
export function mealKeyIsName(){ return _mealKeyIsName; }

// ── Живе оновлення для другого з батьків ────────────────────────
//
// НАВІЩО. У дитини двоє батьків, і обидва заходять у портал. Тато обирає
// гарнір Б — у мами, якщо кабінет уже відкритий, лишається те, що було на
// момент відкриття. Вона бачить варіант А і вирішує, що вибір не зберігся.
//
// Слухаємо рівно дві гілки цієї дитини: постійні налаштування й поправки
// на дні. Тижневих поправок за раз небагато, тож слухати весь meal_day
// класу не треба — беремо лише свою дитину.
let mealUnsub = [];
export function stopMyMeals(){
  mealUnsub.forEach(f => { try{ f(); }catch(e){} });
  mealUnsub = [];
}
window.stopMyMeals = stopMyMeals;

// ЛІЧИЛЬНИК ПОКОЛІНЬ. Між зняттям старих підписок і створенням нових є
// await: ключ дитини читається з бази. Батько з двома дітьми смикає
// перемикач туди-сюди — і два виклики переплітаються так, що обидва
// встигають «прибрати» порожній список, а потім обидва наповнюють його
// своїми підписками. У кабінеті лишаються слухачі на харчування дитини,
// яку вже не показують.
//
// Виправляється не блокуванням, а перевіркою: якщо поки ми читали ключ,
// почався новіший виклик — цей мовчки виходить, нічого не підписавши.
let mealGen = 0;
export async function listenMyMeals(){
  const gen = ++mealGen;
  stopMyMeals();
  const cls = currentUserData?.class;
  if(!cls) return;
  const sid = await mealKey(cls);
  if(!sid || gen !== mealGen) return;
  const keys=[...new Set([sid,currentUserData?.studentName].filter(Boolean))];
  const redraw = () => {
    if(window.invalidateMealBalance) window.invalidateMealBalance();
    try{ renderParentMenu(); }catch(e){}
  };
  keys.map(key=>`meal_plan/${cls}/${key}`).forEach(path => {
    try{ mealUnsub.push(onValue(ref(db, path), redraw,
      err => console.warn('meal listen:', err.message))); }
    catch(e){ console.warn('meal listen:', e.message); }
  });
  // Поправки на дні лежать під датою, тож слухаємо поточний тиждень
  try{
    const monday = mondayOf(localDateString);
    weekDates(monday).forEach(d => {
      keys.forEach(key=>mealUnsub.push(onValue(ref(db, `meal_day/${d}/${cls}/${key}`), redraw,
        err => console.warn('meal listen:', err.message))));
    });
  }catch(e){ console.warn('meal listen:', e.message); }
}
window.listenMyMeals = listenMyMeals;

// Постійні налаштування дитини — тут батько може зняти її з харчування зовсім
window.openMealSettings = async function(){
  // Жодних тихих виходів: раніше будь-яка перешкода — не знайшли клас,
  // відмовила база — просто нічого не робила, і виглядало це як мертва
  // кнопка. Тепер кожен випадок каже про себе.
  const box0 = document.getElementById('meal-settings-body');
  const modal = document.getElementById('meal-settings-modal');
  if(!box0 || !modal){ alert('Розділ налаштувань не завантажено — оновіть сторінку.'); return; }
  const cls = currentUserData?.class;
  let sid;
  try{ sid = await mealKey(cls); }
  catch(e){ alert('Не вдалося визначити дитину: ' + e.message); return; }
  if(!cls || !sid){ alert('Не вдалося визначити клас або дитину. Оновіть сторінку.'); return; }
  let p;
  try{
    p = await readMealCopies(`meal_plan/${cls}`,sid,currentUserData?.studentName)||{};
  }catch(e){
    alert('Не вдалося прочитати налаштування: ' + e.message
      + '\n\nЯкщо написано Permission denied — оновіть сторінку: портал допише '
      + 'ідентифікатор дитини у ваш профіль і доступ зʼявиться.');
    return;
  }
  box0.dataset.loadedTs=String(Number(p.ts)||0);
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
  // Не set: у цьому файлі set — це запис у базу
  const toggle = (selId, boxId) => {
    const sel = document.getElementById(selId), box = document.getElementById(boxId);
    if(sel && box) box.style.display = sel.value === 'days' ? 'flex' : 'none';
  };
  toggle('ms-snack','ms-days');
  toggle('ms-brk','ms-bdays');
};
window.saveMealSettings = async function(){
  const cls = currentUserData?.class, sid = await mealKey(cls);
  if(!cls || !sid) return mealNoChild();
  if(mealKeyIsName())return mealNoChild();
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
  // Мовчазний збій тут особливо злий: вікно закривалося, зʼявлявся
  // «✅ Збережено», а в базі не мінялося нічого.
  try{
    const name=currentUserData?.studentName||'';
    const latest=await readMealCopies(`meal_plan/${cls}`,sid,name)||{};
    const loaded=Number(document.getElementById('meal-settings-body')?.dataset.loadedTs)||0;
    if((Number(latest.ts)||0)!==loaded)
      return alert('Харчування змінили з іншого кабінету. Закрийте налаштування і відкрийте їх знову, щоб не стерти новий вибір.');
    const patch={[`meal_plan/${cls}/${sid}`]:plan};
    await update(ref(db),patch);
  }catch(e){
    alert('Не вдалося зберегти налаштування: ' + e.message
      + (/permission/i.test(e.message||'')
         ? '\n\nСхоже, у профілі записана інша дитина. Оновіть сторінку і спробуйте ще раз.'
         : ''));
    return;
  }
  document.getElementById('meal-settings-modal').style.display = 'none';
  showToast('✅ Налаштування збережено');
  if(window.invalidateMealBalance) window.invalidateMealBalance();
  renderParentMenu();
};

// Статистика для ОДНОЇ дитини — окремим шляхом.
//
// ЧОМУ НЕ СПІЛЬНА ФУНКЦІЯ. computeMealStats читає корені students_list,
// meal_plan, meal_day й відвідуваність усієї школи — це правильно для
// кухні, але батькам ці вузли закриті цілком. Тому виклик із кабінету
// батька щоразу падав на Permission denied, а без обробки помилки напис
// «Рахуємо...» лишався назавжди. Тут читаємо рівно те, що дозволено:
// свій клас і свою дитину.
export async function computeMyMealStats(from, to, cls, sid, withCost=false){
  const [nameSnap, attRange] = await Promise.all([
    get(child(ref(db), `students_list/${cls}/${sid}`)),
    getDateRange(`attendance/${cls}`, from, to, true)
  ]);
  const name=nameSnap.exists()?String(nameSnap.val()||''):String(currentUserData?.studentName||'');
  const [planSnap, altPlanSnap] = await Promise.all([
    get(child(ref(db), `meal_plan/${cls}/${sid}`)),
    name&&name!==sid?get(child(ref(db), `meal_plan/${cls}/${name}`)):null
  ]);
  const plan = pickFresher(planSnap.exists()?planSnap.val():null,
    altPlanSnap&&altPlanSnap.exists()?altPlanSnap.val():null);

  const dates = [];
  const d = new Date(from + 'T12:00:00'), end = new Date(to + 'T12:00:00');
  while(d <= end){
    const wd = d.getDay();
    if(wd >= 1 && wd <= 5) dates.push(iso(d));   // вихідні не рахуємо
    d.setDate(d.getDate() + 1);
  }

  // Дні, коли школи немає: канікули та свята. Раніше статистика їх не
  // знала й рахувала обіди за постійним планом навіть тоді, коли кухня
  // не працювала.
  const noSchool = await loadNoSchoolDays(dates, true);
  const [currentPrices, priceHistory, ledger] = withCost ? await Promise.all([
    loadMealPrices(true,true),
    get(child(ref(db),'meal_price_history')).then(s=>s.exists()?s.val():{}),
    get(child(ref(db),`meal_ledger/${cls}/${sid}`)).then(s=>s.exists()?s.val():{})
  ]) : [{},{},{}];

  // Разові зміни на день лежать у meal_day, а меню — у menu/{дата}.
  // Корінь meal_day родині закритий, тож читаємо поденно. Баланс викликає
  // цю функцію відрізками до 60 днів, щоб врахувати кожну разову зміну.
  // Дуже довгий звіт у вікні статистики поки показує тільки постійний план.
  const OVERRIDE_LIMIT = 70;
  const withOverrides = withCost || dates.length <= OVERRIDE_LIMIT;
  const ovByDate = {}, menuByDate = {};
  if(withOverrides){
    for(let i=0;i<dates.length;i+=30){
      const chunk=dates.slice(i,i+30);
      const [ovs, altOvs, menus] = await Promise.all([
        Promise.all(chunk.map(date => get(child(ref(db), `meal_day/${date}/${cls}/${sid}`)))),
        name&&name!==sid?Promise.all(chunk.map(date=>get(child(ref(db), `meal_day/${date}/${cls}/${name}`)))):null,
        Promise.all(chunk.map(date => get(child(ref(db), `menu/${date}`))))
      ]);
      chunk.forEach((date,j)=>{
        const ov=mealDayFresher(ovs[j].exists()?ovs[j].val():null,
          altOvs&&altOvs[j].exists()?altOvs[j].val():null);
        if(ov) ovByDate[date]=ov;
        menuByDate[date]=menus[j].exists()?(menus[j].val()||{}):null;
      });
    }
  }

  let lunch = 0, snack = 0, brk = 0, absent = 0, lateAbsent = 0, skipped = 0;
  const cost={lunch:0,brk:0,snack:0,total:0};
  // Розклад по днях. Це не налагоджувальний слід, а відповідь на питання,
  // яке ставлять щоразу: «дитини не було, чому рахують». Підсумок його не
  // дає — з чотирьох цифр неможливо зрозуміти, який саме день ліг не так.
  const byDay = [];
  dates.forEach(date => {
    // ВІДСУТНІСТЬ ЧИТАЄМО ПЕРШОЮ, ДО ВСІХ «ЦЕЙ ДЕНЬ НЕ РАХУЄМО».
    //
    // Раніше перевірка стояла після відсіву днів без меню, і будь-який
    // день, на який кухня не опублікувала меню, вилітав разом із
    // відміткою про відсутність. Для батька це виглядало найгірше з
    // можливого: дитини не було, попередили зранку, а у вікні «днів
    // відсутності: 0». Кухня меню не публікує — дитина ніби ходила.
    const att = (attRange && attRange[date] &&
      (attRange[date][sid] || attRange[date][name])) || null;
    const abs = absenceAt(att);
    const row = { date, lunch:0, brk:0, snack:0,
                  absent: !!abs, absentAt: (abs && abs.ts) || 0, note:'' };
    byDay.push(row);

    const fixed=withCost&&ledger?.[date];
    if(fixed&&Number.isFinite(Number(fixed.total))){
      if(fixed.closed)skipped++;
      const fl=Number(fixed.counts?.lunch)||0, fb=Number(fixed.counts?.breakfast)||0, fs=Number(fixed.counts?.snack)||0;
      row.sealed = true;
      row.lunch = fl; row.brk = fb; row.snack = fs;
      row.note = fixed.closed ? 'журнал закрив день як неробочий' : 'день закрито журналом';
      // Запечатаний день перераховувати не можна — журнал і є рахунок.
      // Але відсутність могли проставити вже ПІСЛЯ закриття, і тоді в
      // журналі її немає, а в журналі відвідуваності — є. Для лічильника
      // «днів відсутності» це той самий пропуск, тож беремо обидва
      // джерела; на гроші це не впливає, їх журнал уже порахував.
      const wasAbsent = !!fixed.absent || !!abs;
      row.absent = wasAbsent;
      if(wasAbsent){ absent++; if(fl||fb||fs) lateAbsent++; }
      lunch+=fl;
      brk+=fb;
      snack+=fs;
      cost.lunch=Math.round((cost.lunch+Number(fixed.lunch||0))*100)/100;
      cost.brk=Math.round((cost.brk+Number(fixed.breakfast||0))*100)/100;
      cost.snack=Math.round((cost.snack+Number(fixed.snack||0))*100)/100;
      cost.total=Math.round((cost.lunch+cost.brk+cost.snack)*100)/100;
      return;
    }
    // Канікули та свята: школи немає, відсутності теж — нема від чого бути
    // відсутнім.
    if(noSchool[date]){ row.note='канікули або свято'; row.absent=false; skipped++; return; }
    // Меню не опубліковано — кухня не готувала, харчування рахувати нічого.
    // Але дитини того дня могло не бути, і це окремий факт.
    if(withOverrides && !menuHasFood(menuByDate[date])){
      row.note='меню не публікувалося';
      skipped++;
      if(abs) absent++;
      return;
    }
    const ov = ovByDate[date] || null;
    const e = effectiveMeals(plan, ov, false, weekdayIdx(date));
    const planned = withOverrides ? servedMeals(e,menuByDate[date]) : e;
    // Відсутність застосовуємо по кожній страві окремо: у сніданку власний,
    // ранній дедлайн, і буває, що повідомили після нього, але до обіднього.
    const keep = m => !abs || !absenceRemovesMeal(m, date, abs.ts);
    const served = { lunch: planned.lunch && keep('lunch'),
                     snack: planned.snack && keep('snack'),
                     breakfast: planned.breakfast && keep('breakfast') };
    row.lunch = +served.lunch; row.brk = +served.breakfast; row.snack = +served.snack;
    if(abs){
      absent++;
      // День, у який дитини не було, а харчування однаково пораховано:
      // попередили вже після дедлайну, кухня встигла приготувати. Саме
      // через ці дні числа батька й кухні не сходяться, тож рахуємо їх
      // окремо і показуємо прямо у вікні.
      if(served.lunch || served.snack || served.breakfast){ lateAbsent++; row.late = true; }
    }
    if(served.lunch) lunch++;
    if(served.snack) snack++;
    if(served.breakfast) brk++;
    if(withCost){
      const daily=mealCost({lunch:+served.lunch,brk:+served.breakfast,snack:+served.snack},
        mealPriceAt(date,currentPrices,priceHistory));
      for(const k of Object.keys(cost)) cost[k]=Math.round((cost[k]+daily[k])*100)/100;
    }
  });
  return [{ lunch, snack, brk, absent, lateAbsent, byDay,
            days: dates.length - skipped, skipped, withOverrides, cost }];
}

window.openMyMealStats = async function(){
  const cls = currentUserData?.class, sid = await mealKey(cls);
  if(!cls || !sid) return mealNoChild();
  const modal = document.getElementById('meal-stats-modal');
  const body  = document.getElementById('meal-stats-body');
  if(!modal || !body) return;
  modal.style.display = 'flex';
  const to = localDateString, from = to.slice(0,8) + '01';
  const f = document.getElementById('pms-from'), t = document.getElementById('pms-to');
  // Верхню межу ставимо тут, а не в розмітці: «сьогодні» змінюється щодня
  if(f){ f.max = localDateString; if(!f.value) f.value = from; }
  if(t){ t.max = localDateString; if(!t.value) t.value = to; }
  window.reloadMyMealStats();
};
// Тиждень і місяць — двома кнопками. Батько не має вираховувати, яким
// числом був понеділок: саме на цьому кроці люди й кидають звіт.
window.myMealPeriod = function(kind){
  const f = document.getElementById('pms-from'), t = document.getElementById('pms-to');
  if(!f || !t) return;
  const today = localDateString;
  if(kind === 'month'){ f.value = today.slice(0,8) + '01'; t.value = today; }
  else {
    f.value = mondayOf(today);
    t.value = today;
  }
  window.reloadMyMealStats();
};

// ── РОЗКЛАД ПО ДНЯХ ──
//
// Підсумок із чотирьох цифр не дає відповіді на єдине питання, яке
// справді ставлять: «дитини не було цього дня — чому це не видно».
// Причин, чому день не потрапив у підрахунок, кілька (канікули, меню не
// опубліковано, день уже закрито журналом), і жодна з них із цифри не
// читається. Тому — список днів із тим, що портал про кожен знає.
export function mealDaysTable(byDay){
  const WD_SHORT = ['нд','пн','вт','ср','чт','пт','сб'];
  const dayLabel = iso => {
    const [y,m,d] = String(iso).split('-').map(Number);
    return `${String(d).padStart(2,'0')}.${String(m).padStart(2,'0')} <i>${WD_SHORT[new Date(y,m-1,d,12).getDay()]}</i>`;
  };
  const mark = n => n ? '<b class="pms-y">✓</b>' : '<span class="pms-n">—</span>';
  const dayState = d => {
    if(d.absent){
      const at = d.absentAt ? schoolMoment(d.absentAt) : null;
      const when = at ? (at.day === d.date ? `о ${at.hm}` : `${at.day.slice(8,10)}.${at.day.slice(5,7)} о ${at.hm}`) : 'час невідомий';
      return `<span class="pms-abs">не було</span> · повідомлено ${escHtml(when)}${
        d.late ? ' · <span class="pms-warn">після дедлайну, порцію приготували</span>' : ''}${
        d.note ? ` · ${escHtml(d.note)}` : ''}`;
    }
    return d.note ? escHtml(d.note) : '';
  };
  const dayRows = byDay || [];
  return dayRows.length ? `
    <details class="pms-days">
      <summary>Показати по днях (${dayRows.length})</summary>
      <table class="pms-tab"><thead><tr>
        <th>День</th><th>Сн.</th><th>Об.</th><th>Пв.</th><th>Стан</th>
      </tr></thead><tbody>
        ${dayRows.map(d=>`<tr class="${d.absent?'pms-r-abs':''}${d.note&&!d.absent?' pms-r-skip':''}">
          <td class="pms-d">${dayLabel(d.date)}</td>
          <td>${mark(d.brk)}</td><td>${mark(d.lunch)}</td><td>${mark(d.snack)}</td>
          <td class="pms-s">${dayState(d)}</td></tr>`).join('')}
      </tbody></table>
    </details>` : '';
}

window.reloadMyMealStats = async function(){
  const body = document.getElementById('meal-stats-body');
  if(!body) return;
  const cls = currentUserData?.class, sid = await mealKey(cls);
  let from = document.getElementById('pms-from').value;
  let to   = document.getElementById('pms-to').value;
  if(!from || !to){ body.innerHTML = '<p class="empty-msg">Оберіть обидві дати.</p>'; return; }

  // ПЕРЕВІРКА ПЕРІОДУ.
  //
  // Поле дати дозволяє прокрутити рік до чого завгодно — у полі опинявся
  // 1234-й. Для Firebase це означає startAt більше за endAt: запит падає,
  // а через відсутність обробки помилки напис «Рахуємо...» лишався назавжди.
  if(from > to){ const x = from; from = to; to = x; }   // переплутали місцями — виправляємо мовчки
  const MIN = '2020-01-01', MAX = localDateString;
  if(from < MIN || to > MAX){
    body.innerHTML = `<p class="empty-msg">Період має бути між ${escHtml(human(MIN))} і сьогоднішнім днем.</p>`;
    return;
  }
  // Півтора року вистачає на будь-який навчальний рік, а більше — це вже
  // сотні читань із бази заради цифри, яку ніхто не попросить.
  const days = Math.round((new Date(to) - new Date(from)) / 86400000);
  if(days > 550){
    body.innerHTML = '<p class="empty-msg">Забагато: оберіть період до півтора року.</p>';
    return;
  }

  body.innerHTML = '<p class="empty-msg">Рахуємо...</p>';
  let rows;
  try{
    rows = await computeMyMealStats(from, to, cls, sid, true);
  }catch(e){
    body.innerHTML = `<p class="empty-msg" style="color:var(--danger);">Не вдалося порахувати: ${escHtml(e.message||'відмова')}</p>`;
    return;
  }
  const r = rows[0] || { lunch:0, snack:0, brk:0, absent:0, days:0 };
  // Та сама арифметика, що й у кухні — саме тому вона й винесена в
  // mealCost(): дві копії розійшлися б у першому ж місяці, і батько
  // побачив би не те число, яке назве кухня.
  const prices = await loadMealPrices();
  const cost = r.cost || mealCost(r, prices);
  const moneyBlock = (hasPrices(prices) || cost.total !== 0) ? `
    <div class="pms-money">
      <b>${taMoney(cost.total)} zł</b>
      <span>за період${cost.lunch?` · обіди ${taMoney(cost.lunch)}`:''}${
        cost.brk?` · сніданки ${taMoney(cost.brk)}`:''}${
        cost.snack?` · підвечірки ${taMoney(cost.snack)}`:''}</span>
      <small>Сума за харчування за період за цінами відповідних днів, без урахування поповнень.</small>
    </div>` : '';
  const daysBlock = mealDaysTable(r.byDay);

  body.innerHTML = `
    <div class="pms-grid">
      <div class="pms-cell"><b>${r.lunch}</b><span>днів з обідом</span></div>
      <div class="pms-cell"><b>${r.snack}</b><span>з підвечірком</span></div>
      <div class="pms-cell"><b>${r.brk||0}</b><span>зі сніданком</span></div>
      <div class="pms-cell"><b>${r.absent||0}</b><span>днів відсутності</span></div>
    </div>
    ${r.lateAbsent ? `<p class="pms-late">З них <b>${r.lateAbsent}</b> ${
      r.lateAbsent===1?'день':'дн.'} пораховано: про відсутність повідомили вже після того,
      як кухня порахувала продукти, і порцію приготували.</p>` : ''}
    ${moneyBlock}
    <p class="ms-note">Період: ${escHtml(human(from))} — ${escHtml(human(to))}. Рахуються лише робочі дні,
    коли кухня працювала.${r.skipped ? ` Не враховано днів (канікули, свята або меню не публікувалося): ${r.skipped}.` : ''}
    Відсутність знімає харчування, якщо про неї повідомили до дедлайну: обід і підвечірок —
    до ${MEAL_CUTOFF_HOUR}:00, сніданок — до ${BREAKFAST_CUTOFF_HOUR}:00. Пізніше кухня вже
    порахувала продукти й приготувала порцію, тож день зараховується.
    ${r.withOverrides === false
      ? '<br>Для такого довгого періоду разові відмови на окремі дні не враховано — '
        + 'оберіть до трьох місяців, щоб побачити точні числа.'
      : ''}</p>
    ${daysBlock}`;
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

// ── На який день іде замовлення на винос ────────────────────────
//
// ПРАВИЛО ШКОЛИ: приймаємо до 07:00. Замовив о 07:01 — це вже на
// наступний навчальний день. У вихідні замовлення йде на понеділок.
//
// ЧОМУ ПЕРЕВОДИМО, А НЕ ЗАБОРОНЯЄМО. Заборона о 07:00 виглядала б як
// поломка: людина відкриває портал о восьмій, тисне «+» — нічого не
// відбувається. Переведення на наступний день — це те, що вона й так
// зробила б наступною дією, тільки без здогадок.
//
// ЧОМУ ОКРЕМИЙ ДЕДЛАЙН, А НЕ 09:00 ВІД ОБІДІВ. Обід готують із того, що
// вже закуплено, і відмова о 08:59 нікому не шкодить. Позиції на винос
// пакують до початку уроків, тож для них 09:00 — надто пізно.
export const TA_CUTOFF_HOUR = 7;

export function takeawayDay(now = new Date(), today = localDateString){
  const wd = new Date(today + 'T12:00:00').getDay();
  const weekend = (wd === 0 || wd === 6);
  return (weekend || now.getHours() >= TA_CUTOFF_HOUR) ? nextWorkday(today) : today;
}

// Чи можна ще замовляти на цей день
export function takeawayEditable(dateStr, now = new Date(), today = localDateString){
  const first = takeawayDay(now, today);
  if(dateStr >= first) return { ok:true };
  return { ok:false, msg: dateStr < today
    ? 'Цей день уже минув.'
    : `Замовлення на сьогодні приймалися до ${TA_CUTOFF_HOUR}:00. Наступне можливе — на ${human(first)}.` };
}

const taMoney = (v) => (Math.round(Number(v||0)*100)/100).toFixed(2);

// ── Повідомлення просто в блоці харчування ──────────────────────
//
// НАВІЩО, ЯКЩО Є alert(). На айфоні портал часто відкривають як застосунок
// з головного екрана. У цьому режимі alert(), confirm() і prompt() у ряді
// версій iOS не показуються взагалі — виклик просто нічого не робить.
// Через це помилка збереження, яку ми щойно навчилися ловити, лишалася
// невидимою саме там, де на неї найчастіше й натикаються: «натискаю Б —
// нічого не змінюється».
//
// Тому все, що батько має побачити, малюємо в самій сторінці.
export function mealMsg(text, bad){
  const box = document.getElementById('pm-msg');
  if(!box){ if(text) showToast(text); return; }
  box.className = 'pm-msg' + (bad ? ' bad' : '');
  box.textContent = text || '';
  box.style.display = text ? 'block' : 'none';
}

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
        <button class="ta-mini" onclick="editTakeawayItem('${escJs(id)}')">✏️</button>
        <button class="ta-mini" onclick="toggleTakeawayItem('${escJs(id)}',${it.active===false})">
          ${it.active===false?'Увімкнути':'Вимкнути'}</button>
        ${it.active===false?'':`<button class="ta-mini del" onclick="removeTakeawayItem('${escJs(id)}')">Архів</button>`}
      </div>
      <div class="ta-edit" id="ta-edit-${escHtml(id)}" style="display:none;">
        <input type="text" id="ta-e-title-${escHtml(id)}" value="${escHtml(it.title||'')}" placeholder="Назва" maxlength="80">
        <input type="text" id="ta-e-price-${escHtml(id)}" value="${taMoney(it.price)}" placeholder="Ціна" inputmode="decimal">
        <input type="text" id="ta-e-note-${escHtml(id)}" value="${escHtml(it.note||'')}" placeholder="Примітка (склад, вага)" maxlength="120">
        <div class="ta-edit-btns">
          <button class="ta-mini save" onclick="saveTakeawayItem('${escJs(id)}')">Зберегти</button>
          <button class="ta-mini" onclick="editTakeawayItem('${escJs(id)}')">Скасувати</button>
        </div>
      </div>`;
    }).join('') : '<p class="empty-msg">Позицій ще немає.</p>';
  }catch(e){
    box.innerHTML = `<p class="empty-msg" style="color:var(--danger);">Не вдалося завантажити: ${escHtml(e.message)}</p>`;
  }
}
window.loadTakeawayItems = loadTakeawayItems;

// Правка позиції: назва, ціна, примітка.
//
// ЧОМУ ОНОВЛЕННЯ, А НЕ «ВИДАЛИТИ Й ДОДАТИ ЗАНОВО». Ідентифікатор позиції
// стоїть у вже зроблених замовленнях (takeaway_orders/.../{itemId}). Нова
// позиція отримала б новий ідентифікатор, і всі замовлення на неї
// перетворилися б на рядки без назви. Тому правимо на місці.
window.editTakeawayItem = function(id){
  const box = document.getElementById('ta-edit-' + id);
  if(box) box.style.display = box.style.display === 'none' ? 'flex' : 'none';
};

window.saveTakeawayItem = async function(id){
  const title = (document.getElementById('ta-e-title-'+id)?.value || '').trim();
  const priceRaw = String(document.getElementById('ta-e-price-'+id)?.value || '').replace(',','.');
  const note = (document.getElementById('ta-e-note-'+id)?.value || '').trim();
  const price = Number(priceRaw);
  if(!title) return alert('Назва не може бути порожньою.');
  if(!/^\d+(?:\.\d{1,2})?$/.test(priceRaw)||price>999) return alert('Ціна має містити не більше двох знаків після коми.');
  try{
    // update, а не set: active, by і ts лишаються як були
    const rounded=Math.round(price*100)/100;
    const effectiveDate=new Date().getHours()>=TA_CUTOFF_HOUR?nextWorkday(localDateString):localDateString;
    const [oldSnap,oldHistory]=await Promise.all([
      get(child(ref(db),`takeaway_items/${id}`)),
      get(child(ref(db),`takeaway_price_history/${id}/${localDateString}`))
    ]);
    const changes={
      [`takeaway_items/${id}/title`]: title.slice(0,80),
      [`takeaway_items/${id}/price`]: rounded,
      [`takeaway_items/${id}/note`]: note.slice(0,120),
      [`takeaway_items/${id}/by`]: currentUserData?.email || '',
      [`takeaway_items/${id}/ts`]: Date.now(),
      [`takeaway_price_history/${id}/${effectiveDate}`]: rounded
    };
    if(effectiveDate!==localDateString&&!oldHistory.exists())
      changes[`takeaway_price_history/${id}/${localDateString}`]=Number(oldSnap.val()?.price)||0;
    await update(ref(db),changes);
    logAction('takeaway', { value:`позицію змінено: ${title} · ${taMoney(price)} zł` });
    showToast(`✅ Позицію змінено; нова ціна діє з ${human(effectiveDate)}`);
    loadTakeawayItems();
  }catch(e){ alert('Не вдалося зберегти: ' + e.message); }
};

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
    const rounded=Math.round(price*100)/100;
    await update(ref(db), {
      [`takeaway_items/${id}`]: {
      title: title.slice(0,80),
      price: rounded,
      note: (n?.value||'').trim().slice(0,120),
      active: true,
      by: currentUserData?.email || '', ts: Date.now()
      },
      [`takeaway_price_history/${id}/${localDateString}`]: rounded
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
  if(!confirm('Перенести позицію в архів? Історія замовлень і назва збережуться.')) return;
  try{
    await update(ref(db,`takeaway_items/${id}`),{active:false,ts:Date.now()});
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
    const [itSnap, ordSnap, stSnap, histSnap] = await Promise.all([
      get(child(ref(db),'takeaway_items')),
      get(child(ref(db),`takeaway_orders/${date}`)),
      get(child(ref(db),'students_list')),
      get(child(ref(db),'takeaway_price_history'))
    ]);
    const items = itSnap.exists()?itSnap.val():{};
    const priceHistory=histSnap.exists()?histSnap.val():{};
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
          sum += qty * takeawayPriceAt(itemId,date,items,priceHistory);
          list.push(`${escHtml(it.title||itemId)}${qty>1?` ×${qty}`:''}`);
        }
        if(list.length) rows.push({
          cls: cls.replace('class_',''),
          clsId: cls, sid,
          name: (students[cls] && students[cls][sid]) || sid,
          picks,
          what: list.join(', ')
        });
      }
    }
    rows.sort((a,b)=> (a.cls-b.cls) || String(a.name).localeCompare(String(b.name),'uk'));
    const tKeys = Object.keys(totals);

    // Дані для форми «додати замовлення»: список активних позицій і класи
    window.__taEdit = { date, items, students };

    const activeIds = Object.keys(items).filter(id => items[id] && items[id].active !== false);
    // Рядок правки: мінус · кількість · плюс для кожної позиції учня.
    // Кухня редагує вже після дедлайну — це і є сенс правки.
    const editRow = (r) => Object.keys(r.picks)
      .filter(id => (Number(r.picks[id])||0) > 0)
      .map(id => {
        const q = Number(r.picks[id])||0;
        const title = escHtml((items[id]||{}).title || id);
        return `<span class="k-ta-pick">${title}
          <button onclick="kitchenSetTakeaway('${escJs(r.clsId)}','${escJs(r.sid)}','${escJs(id)}',${q-1})">−</button>
          <b>${q}</b>
          <button onclick="kitchenSetTakeaway('${escJs(r.clsId)}','${escJs(r.sid)}','${escJs(id)}',${q+1})" ${q>=TA_MAX_QTY?'disabled':''}>+</button>
        </span>`;
      }).join(' ');

    const addForm = !activeIds.length ? '' : `
      <div class="k-ta-add">
        <b>Додати замовлення</b>
        <div class="k-ta-add-row">
          <select id="k-ta-cls" onchange="kitchenTaStudents()">
            <option value="">Клас…</option>
            ${Object.keys(students).sort((a,b)=>parseInt(a.replace('class_',''))-parseInt(b.replace('class_','')))
              .map(c=>`<option value="${escHtml(c)}">${escHtml(c.replace('class_',''))} клас</option>`).join('')}
          </select>
          <select id="k-ta-stu"><option value="">Спершу оберіть клас</option></select>
          <select id="k-ta-item">
            ${activeIds.map(id=>`<option value="${escHtml(id)}">${escHtml(items[id].title||id)} · ${taMoney(items[id].price)} zł</option>`).join('')}
          </select>
          <button class="k-ta-add-btn" onclick="kitchenAddTakeaway()">Додати</button>
        </div>
        <span class="k-ta-note">Дедлайн 07:00 тут не діє: кухня додає те, про що з нею домовилися особисто.</span>
      </div>`;

    box.innerHTML = (!tKeys.length
      ? '<p class="empty-msg">На цей день замовлень немає.</p>'
      : `<div class="k-ord-sum"><b>${tKeys.reduce((a,k)=>a+totals[k],0)}</b> позицій · ${taMoney(sum)} zł
           <span>${escHtml(human(date))}</span></div>
         <div class="k-scroll"><table class="k-table"><thead><tr><th>Позиція</th><th>К-сть</th><th>Сума</th></tr></thead><tbody>
           ${tKeys.map(k=>`<tr><td>${escHtml((items[k]||{}).title||k)}</td><td><b>${totals[k]}</b></td>
             <td>${taMoney(totals[k]*Number((items[k]||{}).price||0))} zł</td></tr>`).join('')}
         </tbody></table></div>
         <div class="k-skip-title">Хто замовив</div>
         <div class="k-scroll"><table class="k-table"><thead><tr><th>Учень</th><th>Кл.</th><th>Замовлення</th></tr></thead><tbody>
           ${rows.map(r=>`<tr><td>${escHtml(r.name)}</td><td>${escHtml(String(r.cls))}</td>
             <td class="k-ta-cell">${editRow(r)}</td></tr>`).join('')}
         </tbody></table></div>`) + addForm;
  }catch(e){
    box.innerHTML = `<p class="empty-msg" style="color:var(--danger);">Не вдалося завантажити: ${escHtml(e.message)}</p>`;
  }
};

// ── Правка замовлень на винос кухнею ────────────────────────────
//
// НАВІЩО. Дедлайн 07:00 закриває замовлення для батьків, і це правильно:
// після нього кухня вже знає, скільки чого пакувати. Але життя триває —
// хтось підійшов особисто, хтось передумав, комусь не потрібно. Раніше
// кухня могла лише дивитися на список, а домовленості жили в записнику.
//
// ПИШЕМО В ТУ САМУ ГІЛКУ, що й батьки: takeaway_orders/{дата}/{клас}/{ID}.
// Окреме «кухонне» сховище означало б два різні числа на одну булку.
window.kitchenSetTakeaway = async function(cls, sid, itemId, qty){
  const st = window.__taEdit;
  if(!st) return;
  const q = Math.max(0, Math.min(TA_MAX_QTY, Number(qty)||0));
  const name = (st.students[cls] && st.students[cls][sid]) || sid;
  const title = (st.items[itemId] || {}).title || itemId;
  if(q === 0 && !askConfirm(`Прибрати «${title}» у ${name}?`)) return;
  try{
    await set(ref(db, `takeaway_orders/${st.date}/${cls}/${sid}/${itemId}`), q > 0 ? q : null);
    logAction('takeaway', { date: st.date, target: name,
      value: `кухня: ${title} → ${q || 'прибрано'}` });
    showToast(q ? `✓ ${title}: ${q}` : `✕ ${title} прибрано`);
    loadTakeawayOrders();
  }catch(e){ alert('Не вдалося зберегти: ' + e.message); }
};

// Список учнів обраного класу для форми «додати замовлення»
window.kitchenTaStudents = function(){
  const st = window.__taEdit;
  const cls = document.getElementById('k-ta-cls')?.value;
  const sel = document.getElementById('k-ta-stu');
  if(!st || !sel) return;
  const list = (cls && st.students[cls]) || {};
  const keys = Object.keys(list).sort((a,b)=>String(list[a]).localeCompare(String(list[b]),'uk'));
  sel.innerHTML = keys.length
    ? keys.map(k=>`<option value="${escHtml(k)}">${escHtml(list[k])}</option>`).join('')
    : '<option value="">У класі немає учнів</option>';
};

window.kitchenAddTakeaway = async function(){
  const st = window.__taEdit;
  const cls = document.getElementById('k-ta-cls')?.value;
  const sid = document.getElementById('k-ta-stu')?.value;
  const itemId = document.getElementById('k-ta-item')?.value;
  if(!st || !cls || !sid || !itemId) return alert('Оберіть клас, учня і позицію.');
  try{
    // Додаємо до вже наявної кількості, а не замінюємо: кухня натискає
    // «Додати» двічі саме тоді, коли треба дві штуки.
    const cur = await get(child(ref(db), `takeaway_orders/${st.date}/${cls}/${sid}/${itemId}`));
    const was = cur.exists() ? (Number(cur.val())||0) : 0;
    const q = Math.min(TA_MAX_QTY, was + 1);
    await set(ref(db, `takeaway_orders/${st.date}/${cls}/${sid}/${itemId}`), q);
    const name = (st.students[cls] && st.students[cls][sid]) || sid;
    const title = (st.items[itemId] || {}).title || itemId;
    logAction('takeaway', { date: st.date, target: name, value: `кухня додала: ${title} → ${q}` });
    showToast(`✓ ${title} для ${name}: ${q}`);
    loadTakeawayOrders();
  }catch(e){ alert('Не вдалося додати: ' + e.message); }
};

// ── Кабінет батьків: замовлення на обраний день ──
export async function renderTakeaway(date){
  const isStudent = currentUserData?.role === 'student';
  const boxId = isStudent ? 's-takeaway' : 'p-takeaway';
  const box = document.getElementById(boxId);
  if(!box) return;
  const cls = currentUserData?.class;
  const sid = await mealKey(currentUserData?.class);
  if(!cls || !sid){ box.innerHTML = ''; return; }
  // День беремо не менший за перший доступний. Людина гортає меню й може
  // стояти на сьогоднішньому дні о десятій ранку — замовлення туди вже не
  // приймаються, тож показуємо найближчий, куди приймаються.
  const asked = date || pmDate || localDateString;
  const first = takeawayDay();
  const day = asked > first ? asked : first;
  const shifted = day !== asked;
  try{
    const [itSnap, ordSnap, histSnap] = await Promise.all([
      get(child(ref(db),'takeaway_items')),
      get(child(ref(db),`takeaway_orders/${day}/${cls}/${sid}`)),
      get(child(ref(db),'takeaway_price_history'))
    ]);
    const items = itSnap.exists()?itSnap.val():{};
    const mine  = ordSnap.exists()?ordSnap.val():{};
    const priceHistory=histSnap.exists()?histSnap.val():{};
    const ids = [...new Set([...Object.keys(items).filter(id=>items[id]&&items[id].active!==false),
      ...Object.keys(mine).filter(id=>Number(mine[id])>0)])];
    if(!ids.length){ box.innerHTML = ''; return; }     // кухня нічого не продає — розділу немає

    const gate = isStudent ? { ok: false, msg: 'Редагування доступне тільки для батьків' } : takeawayEditable(day);
    let sum = 0;
    ids.forEach(id=>{sum+=(Number(mine[id])||0)*takeawayPriceAt(id,day,items,priceHistory);});

    box.innerHTML = `
      <div class="ta-head">🥡 Замовити на винос <span>${escHtml(human(day))}</span></div>
      ${shifted ? `<div class="ta-shift">Замовлення приймаємо до ${TA_CUTOFF_HOUR}:00.
        ${asked < localDateString ? 'Той день уже минув.'
          : (asked === localDateString ? 'На сьогодні вже пізно.' : '')}
        Це замовлення піде на <b>${escHtml(human(day))}</b>.</div>` : ''}
      ${ids.map(id=>{
        const it = items[id]||{}, q = Number(mine[id])||0, active=it.active!==false&&!!items[id];
        return `<div class="ta-row${q?' on':''}">
          <div class="ta-row-main">
            <b>${escHtml(it.title||id)}</b>${active?'':' <small>позицію вимкнено</small>'}
            ${it.note?`<span class="ta-item-note">${escHtml(it.note)}</span>`:''}
          </div>
          <span class="ta-price">${taMoney(takeawayPriceAt(id,day,items,priceHistory))} zł</span>
          ${gate.ok ? `<div class="ta-qty">
            <button onclick="setTakeaway('${escJs(day)}','${escJs(id)}',${q-1})" ${q?'':'disabled'}>−</button>
            <span>${q}</span>
            <button onclick="setTakeaway('${escJs(day)}','${escJs(id)}',${q+1})" ${!active||q>=TA_MAX_QTY?'disabled':''}>+</button>
          </div>` : `<span class="ta-qty-locked">${q||0}</span>`}
        </div>`;
      }).join('')}
      <div class="ta-sum">${sum>0?`До сплати: <b>${taMoney(sum)} zł</b>`:'Нічого не замовлено'}
        <span>Оплата — у школі, як завжди</span></div>
      ${gate.ok
        ? `<div class="ta-rule">Замовлення на день приймаємо до ${TA_CUTOFF_HOUR}:00. Пізніше — вже на наступний навчальний день.</div>`
        : `<div class="ta-locked">🔒 ${escHtml(gate.msg)}</div>`}`;
  }catch(e){
    box.innerHTML = `<div class="pm-none">Не вдалося завантажити позиції: ${escHtml(e.message)}`
      + (/permission/i.test(e.message||'') ? ' — оновіть сторінку, портал допише ідентифікатор дитини у профіль' : '')
      + `</div>`;
  }
}
window.renderTakeaway = renderTakeaway;

window.setTakeaway = async function(date, itemId, qty){
  const cls = currentUserData?.class;
  const sid = await mealKey(currentUserData?.class);
  if(!cls || !sid) return mealNoChild();
  if(mealKeyIsName())return mealNoChild();
  // Перевіряємо ще раз тут, а не лише при показі: між відкриттям сторінки
  // і натисканням могло минути пів дня, і 07:00 уже позаду.
  const gate = takeawayEditable(date);
  if(!gate.ok){ alert(gate.msg); return renderTakeaway(); }
  const q = Math.max(0, Math.min(TA_MAX_QTY, Number(qty)||0));
  try{
    const [itemSnap,oldSnap]=await Promise.all([
      get(child(ref(db),`takeaway_items/${itemId}`)),
      get(child(ref(db),`takeaway_orders/${date}/${cls}/${sid}/${itemId}`))
    ]);
    if(q>(Number(oldSnap.val())||0)&&(!itemSnap.exists()||itemSnap.val()?.active===false))
      return alert('Цю позицію вже вимкнено. Можна лише зменшити або скасувати попереднє замовлення.');
    // 0 прибирає запис зовсім, щоб у базі не накопичувалися нулі
    await set(ref(db,`takeaway_orders/${date}/${cls}/${sid}/${itemId}`), q>0 ? q : null);
    if(window.invalidateMealBalance) window.invalidateMealBalance();
    renderTakeaway(date);
    if(window.loadFamilyMealBalance) window.loadFamilyMealBalance();
  }catch(e){ alert('Не вдалося зберегти: ' + e.message); }
};

// Відповідь на питання «дитина обідає в школі». Пишемо лише поле lunch,
// не чіпаючи налаштування сніданків і підвечірків, які батько міг уже
// задати: set перезаписав би весь вузол.
window.setLunchPlan = async function(yes){
  const cls = currentUserData?.class;
  const sid = await mealKey(cls);
  if(!cls || !sid) return mealNoChild();
  if(mealKeyIsName())return mealNoChild();
  try{
    const name=currentUserData?.studentName||'';
    const plan={...(await readMealCopies(`meal_plan/${cls}`,sid,name)||{}),
      lunch:!!yes,by:currentUserData.email||'',ts:Date.now()};
    const patch={[`meal_plan/${cls}/${sid}`]:plan};
    await update(ref(db),patch);
    showToast(yes ? '✅ Обіди замовлено' : 'Обіди не замовляються');
    if(window.invalidateMealBalance) window.invalidateMealBalance();
    renderParentMenu();
  }catch(e){
    alert('Не вдалося зберегти: ' + e.message);
  }
};

// ══════════════════════════════════════════════════════════════════
//  МЕНЮ МИНУЛОГО ДНЯ — ЦЕ ІСТОРІЯ, А НЕ ПЛАН
// ══════════════════════════════════════════════════════════════════
//
// За наявністю меню портал визначає головне: чи кухня того дня взагалі
// працювала. Від цього залежить підрахунок порцій, статистика батьків і
// нарахування. Тому видалене заднім числом меню — не «прибрали зайвий
// запис», а «дня не було»: діти їли, а в порталі порожньо, і ніхто не
// розуміє, куди подівся тиждень.
//
// Так і сталося: меню за 14 і 15 вересня прибрали помилково, і в обох
// днях зникло харчування разом із відмітками про відсутність.
//
// Майбутній день прибирати можна скільки завгодно — там ще нічого не
// відбулося. Сьогоднішній теж, але з попередженням: хтось міг уже поїсти.
export function menuDeletable(date, today = localDateString){
  if(!date) return { ok:false, msg:'Немає дати.' };
  if(date < today) return { ok:false, msg:
      `Меню на ${human(date)} прибрати не можна: цей день уже минув.\n\n`
    + 'За меню портал визначає, чи кухня того дня працювала. Якщо прибрати його '
    + 'заднім числом, день зникне з підрахунку порцій, зі статистики батьків і '
    + 'з нарахувань — хоча діти їли.\n\n'
    + 'Помилку в стравах можна виправити: відредагуйте поля й збережіть. '
    + 'Якщо день справді треба закрити, зверніться до директора.' };
  return { ok:true, today: date === today };
}

// Прибрати меню одного дня.
//
// НАВІЩО ОКРЕМА КНОПКА. Стерти поля руками й натиснути «Опублікувати»
// теж спрацює, але це п'ять полів і жодного підтвердження — а день
// заповнюють помилково саме тоді, коли поспішають (канікули, свято).
window.clearMenuDay = async function(date){
  const gate = menuDeletable(date);
  if(!gate.ok) return alert(gate.msg);
  if(!confirm(`Прибрати меню на ${human(date)}?\n\n`
    + 'День стане порожнім: батьки побачать «меню не опубліковане», '
    + 'а в підрахунку порцій цей день не враховуватиметься.'
    + (gate.today ? '\n\nЦе сьогоднішній день — якщо дітей уже годували, '
        + 'він зникне з підрахунку разом із їхніми порціями.' : ''))) return;
  try{
    await set(ref(db, `menu/${date}`), null);
    logAction('menu', { date, value: 'прибрано' });
    showToast('🗑 Меню прибрано');
    loadWeekMenu(); loadWeekCounts();
  }catch(e){
    alert('Не вдалося прибрати: ' + e.message);
  }
};

window.openStudentMealsTab = function(){
  renderParentMenu();
};
