// ══════════════════════════════════════════════════════════════════
//  Скільки готувати сьогодні — серверна копія підрахунку кухні
// ══════════════════════════════════════════════════════════════════
// Потрібна сповіщенням кухні (kitchen-notify.js): о 09:00 — «замовлення
// закрито, стільки-то порцій», і далі — хто не прийшов без попередження.
// Правила ТІ САМІ, що в кабінеті кухні (kitchen.js → loadWeekCounts,
// effectiveMealsAt) і в журналі списань (meal-ledger-core.js):
//   • обід — лише за явною згодою (plan.lunch === true) або разовим вибором;
//   • сніданок і підвечірок — за планом на день тижня або разовим вибором;
//   • відсутність знімає страву, лише якщо про неї повідомили до дедлайну
//     САМЕ ЦІЄЇ страви (сніданок 07:00, обід і підвечірок 09:00).
// Рахуємо ЛИШЕ день date. Відмітки, поставлені заздалегідь (учора на
// сьогодні), — вчасні; відмітки на інші дні сюди не потрапляють взагалі.
const { absenceRemovesMeal, optionPlanned, byKeyOrName, mealDayByKeyOrName, noSchool } = require('./meal-ledger-core');

const BY_LABEL = { teacher: 'учитель', class_teacher: 'учитель', parent: 'батьки', student: 'учень',
                   administrator: 'адміністратор', director: 'директор' };

function warsawParts(ts = Date.now()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(ts)).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour),
           minute: Number(parts.minute), hm: `${parts.hour}:${parts.minute}` };
}

// Найраніша відмітка відсутності дитини цього дня — і хто її поставив
function absenceOf(day, sid, name) {
  let ts = null, found = false, by = '';
  for (const slots of [day?.[sid], name && name !== sid ? day?.[name] : null]) {
    for (const r of Object.values(slots || {})) {
      if (!r || r.status !== 'absent') continue;
      if (!found) by = r.markedBy || '';
      found = true;
      const t = Number(r.ts) || 0;
      if (t && (ts === null || t < ts)) { ts = t; by = r.markedBy || ''; }
    }
  }
  return found ? { ts: ts || 0, by } : null;
}

// data: { students_list, meal_plan, meal_day (лише цей день: {cls:{sid:…}}),
//         menu (цей день), attendance ({cls: {sid: слоти}} за цей день), academic_year }
function kitchenDay(date, data) {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (weekday < 1 || weekday > 5 || noSchool(date, data.academic_year)) return { date, closed: true };
  const menu = data.menu || {};
  const hasChoice = !!((String(menu.side || '').trim() && String(menu.side2 || '').trim())
                    || (String(menu.second || '').trim() && String(menu.second2 || '').trim()));
  const hasBrkChoice = !!(String(menu.breakfast || '').trim() && String(menu.breakfast2 || '').trim());
  const out = { date, closed: false, lunch: 0, brk: 0, snack: 0, pa: 0, pb: 0, bpa: 0, bpb: 0,
                absent: 0, late: [], hasChoice, hasBrkChoice };
  for (const [cls, students] of Object.entries(data.students_list || {})) {
    for (const [sid, nameRaw] of Object.entries(students || {})) {
      const name = String(nameRaw || sid);
      const plan = byKeyOrName(data.meal_plan?.[cls], sid, name) || {};
      const ov = mealDayByKeyOrName(data.meal_day?.[cls], sid, name);
      let lunch = ov.lunch === undefined ? plan.lunch === true : !!ov.lunch;
      let breakfast = ov.breakfast === undefined ? optionPlanned(plan, 'breakfast', weekday) : !!ov.breakfast;
      let snack = ov.snack === undefined ? optionPlanned(plan, 'snack', weekday) : !!ov.snack;
      const abs = absenceOf(data.attendance?.[cls], sid, name);
      if (abs) {
        const gone = m => absenceRemovesMeal(m, date, abs.ts);
        const kept = [[breakfast, 'breakfast', 'сніданок'], [lunch, 'lunch', 'обід'], [snack, 'snack', 'підвечірок']]
          .filter(([on, m]) => on && !gone(m)).map(x => x[2]);
        if (gone('lunch')) out.absent++;
        if (kept.length) out.late.push({ cls, sid, name, by: abs.by, byLabel: BY_LABEL[abs.by] || '',
                                         hm: abs.ts ? warsawParts(abs.ts).hm : '', meals: kept });
        lunch = lunch && !gone('lunch'); breakfast = breakfast && !gone('breakfast'); snack = snack && !gone('snack');
      }
      if (lunch) { out.lunch++; if (hasChoice) (ov.pick === 'b' ? out.pb++ : out.pa++); }
      if (breakfast) { out.brk++; if (hasBrkChoice) (ov.breakfastPick === 'b' ? out.bpb++ : out.bpa++); }
      if (snack) out.snack++;
    }
  }
  return out;
}

const clsNum = c => String(c).replace('class_', '');
function cutoffMessage(day) {
  const lunch = `обідів ${day.lunch}${day.hasChoice ? ` (А ${day.pa} / Б ${day.pb})` : ''}`;
  const brk = `сніданків ${day.brk}${day.hasBrkChoice ? ` (А ${day.bpa} / Б ${day.bpb})` : ''}`;
  const late = day.late.length ? ` Не прийшли без попередження: ${day.late.length} (порції готуються).` : '';
  return { title: '🍽️ Замовлення на сьогодні закрито',
           body: `${lunch} · ${brk} · підвечірків ${day.snack}.${late}`, tag: `kitchen-cutoff-${day.date}` };
}
function lateMessage(rows, date) {
  const one = r => `${r.name}, ${clsNum(r.cls)} кл. — ${r.meals.join(', ')}${r.byLabel || r.hm ? ` (${[r.byLabel, r.hm && 'о ' + r.hm].filter(Boolean).join(' ')})` : ''}`;
  return rows.length === 1
    ? { title: '🚨 Не прийде без попередження', body: `${one(rows[0])}. Порція вже готується.`, tag: `kitchen-late-${date}-${rows[0].cls}-${rows[0].sid}` }
    : { title: `🚨 Не прийшли без попередження: ${rows.length}`, body: rows.map(one).join('; ') + '. Порції вже готуються.', tag: `kitchen-late-${date}-${rows.length}` };
}

module.exports = { kitchenDay, absenceOf, cutoffMessage, lateMessage, warsawParts };
