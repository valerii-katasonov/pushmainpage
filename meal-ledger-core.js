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
function absentOn(day, sid, name) {
  return [day?.[sid], name && day?.[name]].some(slots =>
    slots && Object.values(slots).some(r => r?.status === 'absent'));
}

function buildDayCharge(date, cls, sid, name, data) {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const schoolDay = weekday >= 1 && weekday <= 5 && !noSchool(date, data.academic_year);
  const menu = data.menu?.[date] || {};
  const plan = byKeyOrName(data.meal_plan?.[cls], sid, name) || {};
  const override = mealDayByKeyOrName(data.meal_day?.[date]?.[cls], sid, name);
  const absent = absentOn(data.attendance?.[cls]?.[date], sid, name);
  const lunchMenu = !!(menu.first || menu.second || menu.second2 || menu.side || menu.side2);
  const lunch = schoolDay && !absent && lunchMenu &&
    (override.lunch === undefined ? plan.lunch === true : !!override.lunch);
  const breakfast = schoolDay && !absent && !!String(menu.breakfast || '').trim() &&
    (override.breakfast === undefined ? optionPlanned(plan, 'breakfast', weekday) : !!override.breakfast);
  const snack = schoolDay && !absent && !!String(menu.snack || '').trim() &&
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
