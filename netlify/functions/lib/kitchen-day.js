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

// ЧИ ДИТИНА ВЗАГАЛІ НЕ ПРИЙШЛА, ЧИ ПІШЛА ПІСЛЯ ОБІДУ (19.11.2026).
// «Не прийшли без попередження» — лише ті, кого немає з самого ранку:
// відмітка «увесь день» або пропуск уроку ДО обіду. Пропуск 6-го уроку —
// дитина була, поїла й пішла; для кухні це не новина.
// Уроки до обіду: перед перервою «Обід» у розкладі класу; якщо такої
// перерви немає — ті, що починаються до 12:00; без часу — перші чотири.
// Ключ уроку той самий, що пише вчитель: number або позиція в дні.
function morningLessons(dayLessons){
  if(!dayLessons) return null;
  const flat = [];
  (Array.isArray(dayLessons) ? dayLessons : Object.values(dayLessons)).forEach(slot => {
    if(Array.isArray(slot)) flat.push(...slot);
    else if(slot && typeof slot === 'object' && Object.keys(slot).length) flat.push(slot);
  });
  const txt = it => String((it && it.subject && it.subject.ua !== undefined ? it.subject.ua : it && it.subject) || (it && it.name) || '').toLowerCase();
  const lunchAt = flat.findIndex(it => /обід|обед/.test(txt(it)));
  const out = new Set();
  flat.forEach((it, i) => {
    if(!it || it.type === 'break' || /перерва|обід|обед/.test(txt(it))) return;
    const key = String(it.number || (i + 1)).trim();
    if(!key) return;
    const m = String(it.time || '').match(/(\d{1,2})[:.](\d{2})/);
    const before = lunchAt >= 0 ? i < lunchAt : m ? (+m[1] * 60 + +m[2]) < 12 * 60 : Number(key) <= 4;
    if(before) out.add(key);
  });
  return out;
}
// slots — відмітки дитини за день {слот: {status}}; morning — з morningLessons
// (null — розкладу немає: тоді будь-яка відсутність, як і раніше).
function noShow(slots, morning){
  for(const [k, r] of Object.entries(slots || {})){
    if(!r || r.status !== 'absent') continue;
    if(k === 'all' || !morning || morning.has(String(k))) return true;
  }
  return false;
}

// data: { students_list, meal_plan, meal_day (лише цей день: {cls:{sid:…}}),
//         menu (цей день), attendance ({cls: {sid: слоти}} за цей день), academic_year,
//         schedules ({cls: {lessons:{Monday:[…]}}}, необовʼязково) }
function kitchenDay(date, data) {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (weekday < 1 || weekday > 5 || noSchool(date, data.academic_year)) return { date, closed: true };
  const menu = data.menu || {};
  const hasChoice = !!((String(menu.side || '').trim() && String(menu.side2 || '').trim())
                    || (String(menu.second || '').trim() && String(menu.second2 || '').trim()));
  const hasBrkChoice = !!(String(menu.breakfast || '').trim() && String(menu.breakfast2 || '').trim());
  const out = { date, closed: false, lunch: 0, brk: 0, snack: 0, pa: 0, pb: 0, bpa: 0, bpb: 0,
                absent: 0, late: [], hasChoice, hasBrkChoice };
  const DAY_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  for (const [cls, students] of Object.entries(data.students_list || {})) {
    const morning = data.schedules ? morningLessons(data.schedules[cls]?.lessons?.[DAY_EN[weekday]]) : null;
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
        const daySlots = { ...(name !== sid ? data.attendance?.[cls]?.[name] || {} : {}), ...(data.attendance?.[cls]?.[sid] || {}) };
        if (kept.length && noShow(daySlots, morning)) out.late.push({ cls, sid, name, by: abs.by, byLabel: BY_LABEL[abs.by] || '',
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
    // Не більше восьми імен у тексті: довге сповіщення телефон однаково обріже,
    // а решту кухня побачить у кабінеті. tag — унікальний на кожну пачку:
    // спільний tag тихо заміняв би попередню пачку в шторці телефона.
    : { title: `🚨 Не прийшли без попередження: ${rows.length}`,
        body: rows.slice(0, 8).map(one).join('; ') + (rows.length > 8 ? `; і ще ${rows.length - 8} — у кабінеті` : '') + '. Порції вже готуються.',
        tag: `kitchen-late-${date}-${rows.map(r => r.cls + r.sid).join('').slice(0, 40)}` };
}

module.exports = { kitchenDay, absenceOf, cutoffMessage, lateMessage, warsawParts, morningLessons, noShow };
