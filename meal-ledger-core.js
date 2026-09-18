// Чистий розрахунок одного закритого дня. Сервер записує результат один раз;
// браузер надалі читає цей запис, а не відновлює минуле з поточного меню.
const money = n => Math.round((Number(n) || 0) * 100) / 100;

function fresher(a, b) {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return (Number(b.ts) || 0) > (Number(a.ts) || 0) ? b : a;
}
function byKeyOrName(map, sid, name) {
  return fresher(map?.[sid], name ? map?.[name] : null);
}
function mealDayByKeyOrName(map,sid,name){
  const a=map?.[sid],b=name?map?.[name]:null;
  const newest=fresher(a,b);
  if(!newest)return {};
  const older=newest===a?b:a;
  const row={...newest};
  if(older){
    if(row.pick===undefined&&row.lunch!==0&&row.lunch!==false&&['a','b'].includes(older.pick))row.pick=older.pick;
    if(row.breakfastPick===undefined&&row.breakfast!==0&&row.breakfast!==false&&['a','b'].includes(older.breakfastPick))row.breakfastPick=older.breakfastPick;
  }
  return row;
}
function optionPlanned(plan, field, weekday) {
  if (!plan || !plan[field] || plan[field] === 'no') return false;
  if (plan[field] === 'all') return true;
  return !!plan[`${field}Days`]?.[weekday];
}
function priceAt(date, current, history) {
  const all = Object.keys(history || {}).sort();
  const keys = all.filter(d => d <= date);
  return keys.length ? (history[keys.at(-1)] || current || {})
    : all.length ? (history[all[0]] || current || {}) : (current || {});
}
function noSchool(date, academicYears) {
  const year = Number(date.slice(0, 4));
  const y = Number(date.slice(5, 7)) >= 8 ? year : year - 1;
  const calendar = academicYears?.[`${y}-${y + 1}`] || {};
  if (Object.values(calendar.holidays || {}).some(h => h?.date === date)) return true;
  return Object.values(calendar.breaks || {}).some(b => b?.startDate <= date && date <= b?.endDate);
}
// ── ВІДСУТНІСТЬ І ДЕДЛАЙН ──
//
// Відсутність сама по собі порції не скасовує — скасовує ВЧАСНЕ
// попередження. Кухня рахує продукти зранку: до дедлайну дитину ще можна
// зняти з переліку, після нього порція вже приготована, і школа її
// оплачує. Ті самі години, що в kitchen.js (MEAL_CUTOFF_HOUR тощо) —
// тримаємо їх поруч, бо файли живуть окремо: цей крутиться на сервері.
//
// СТАРІ ДНІ НЕ ЧІПАЄМО: до ABSENCE_RULE_FROM будь-яка відсутність знімає
// день, як було. Правило заднім числом — це не виправлення, а новий
// рахунок людям, які вже бачили свої числа.
const ABSENCE_RULE_FROM = '2026-09-21';
const CUTOFF_HOUR = { lunch: 9, breakfast: 7, snack: 9 };
// Година ШКОЛИ, а не сервера: Netlify рахує в UTC, і без явної зони
// «до 9:00» означало б 11:00 за Варшавою — тобто зайвий обід кожного разу.
const SCHOOL_TZ = 'Europe/Warsaw';
function schoolMoment(ts) {
  const d = new Date(Number(ts) || 0);
  const p2 = n => String(n).padStart(2, '0');
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: SCHOOL_TZ,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(d);
    const g = k => (parts.find(x => x.type === k) || {}).value;
    const hour = Number(g('hour'));
    return { day: `${g('year')}-${g('month')}-${g('day')}`, hour: hour === 24 ? 0 : hour };
  } catch (e) {
    return { day: `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`, hour: d.getUTCHours() };
  }
}
// Найраніша позначка дня: якщо вранці написали «не буде», а по обіді
// вчитель продублював, попередили все-таки вранці.
function absentOn(day, sid, name) {
  let ts = null, found = false;
  for (const slots of [day?.[sid], name && day?.[name]]) {
    for (const r of Object.values(slots || {})) {
      if (!r || r.status !== 'absent') continue;
      found = true;
      const t = Number(r.ts) || 0;
      if (t && (ts === null || t < ts)) ts = t;
    }
  }
  return found ? { ts: ts || 0 } : null;
}
function absenceRemovesMeal(meal, date, markedTs) {
  if (!date || date < ABSENCE_RULE_FROM) return true;   // старі дні — як було
  const ts = Number(markedTs) || 0;
  if (!ts) return true;                                  // час невідомий — на користь родини
  const at = schoolMoment(ts);
  if (at.day < date) return true;                        // попередили заздалегідь
  if (at.day > date) return false;                       // проставили заднім числом
  return at.hour < (CUTOFF_HOUR[meal] || CUTOFF_HOUR.lunch);
}

function buildDayCharge(date, cls, sid, name, data) {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const schoolDay = weekday >= 1 && weekday <= 5 && !noSchool(date, data.academic_year);
  const menu = data.menu?.[date] || {};
  const plan = byKeyOrName(data.meal_plan?.[cls], sid, name) || {};
  const override = mealDayByKeyOrName(data.meal_day?.[date]?.[cls], sid, name);
  const absence = absentOn(data.attendance?.[cls]?.[date], sid, name);
  const absent = !!absence;
  // Відсутність застосовуємо по кожній страві окремо: у сніданку власний,
  // ранній дедлайн, і буває, що повідомили після нього, але до обіднього.
  const served = meal => !absence || !absenceRemovesMeal(meal, date, absence.ts);
  const lunchMenu = !!(menu.first || menu.second || menu.second2 || menu.side || menu.side2);
  const lunch = schoolDay && served('lunch') && lunchMenu &&
    (override.lunch === undefined ? plan.lunch === true : !!override.lunch);
  const breakfast = schoolDay && served('breakfast') && !!String(menu.breakfast || '').trim() &&
    (override.breakfast === undefined ? optionPlanned(plan, 'breakfast', weekday) : !!override.breakfast);
  const snack = schoolDay && served('snack') && !!String(menu.snack || '').trim() &&
    (override.snack === undefined ? optionPlanned(plan, 'snack', weekday) : !!override.snack);
  const prices = priceAt(date, data.meal_prices, data.meal_price_history);
  for (const [used, key] of [[lunch, 'lunch'], [breakfast, 'breakfast'], [snack, 'snack']]) {
    if (used && (!Number.isFinite(Number(prices[key])) || Number(prices[key]) <= 0))
      throw new Error(`Не задано ціну ${key} на ${date}; день не закрито`);
  }
  const amounts = {
    lunch: money(lunch ? prices.lunch : 0),
    breakfast: money(breakfast ? prices.breakfast : 0),
    snack: money(snack ? prices.snack : 0),
    takeaway: 0
  };
  const order = byKeyOrName(data.takeaway_orders?.[date]?.[cls], sid, name) || {};
  for (const [itemId, qty] of Object.entries(order)) {
    if (!Number.isFinite(Number(qty)) || Number(qty) <= 0) continue;
    const history = data.takeaway_price_history?.[itemId] || {};
    const old = Object.keys(history).filter(d => d <= date).sort();
    const all = Object.keys(history).sort();
    const price = old.length ? history[old.at(-1)]
      : all.length ? history[all[0]] : data.takeaway_items?.[itemId]?.price;
    if (!Number.isFinite(Number(price)) || Number(price) <= 0)
      throw new Error(`Не задано ціну позиції ${itemId} на ${date}; день не закрито`);
    amounts.takeaway = money(amounts.takeaway + Number(qty) * (Number(price) || 0));
  }
  const total = money(Object.values(amounts).reduce((s, v) => s + v, 0));
  const lunchChoice = menu.side && menu.side2 || menu.second && menu.second2
    ? (override.pick === 'b' ? 'Б' : 'А') : '';
  const breakfastChoice = menu.breakfast && menu.breakfast2
    ? (override.breakfastPick === 'b' ? 'Б' : 'А') : '';
  return {
    date, ...amounts, total,
    counts: { lunch: +!!lunch, breakfast: +!!breakfast, snack: +!!snack },
    lunchChoice: lunch ? lunchChoice : '',
    breakfastChoice: breakfast ? breakfastChoice : '',
    absent: !!absent,
    closed: !schoolDay || !(lunchMenu || menu.breakfast || menu.snack)
  };
}

module.exports = { buildDayCharge, money, priceAt, noSchool };
