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

// КОЛИ ДИТИНА ЇСТЬ — З РОЗКЛАДУ КЛАСУ (19.11.2026).
// «Не було без попередження» має сенс лише для їжі, яку дитина пропустила.
// Сніданок і обід — перерви в розкладі («Сніданок» о 09:40, «Обід» о 12:40):
//   • сніданок пропущено, якщо дитини не було на уроках ДО перерви «Сніданок»;
//   • обід (і підвечірок) — якщо не було на ОСТАННЬОМУ уроці перед «Обідом»:
//     або не прийшла, або пішла раніше. Пропуск 5-го чи 6-го уроку — дитина
//     поїла й пішла; запізнилася на 1-й урок, але була на 4-му — теж поїла.
// Немає перерви «Сніданок» — рахуємо перший урок; немає «Обіду» — останній
// урок, що починається до 12:00 (без часу — 4-й). Ключ уроку той самий, що
// пише вчитель: number або позиція в дні.
function mealLessons(dayLessons){
  if(!dayLessons) return null;
  const flat = [];
  (Array.isArray(dayLessons) ? dayLessons : Object.values(dayLessons)).forEach(slot => {
    if(Array.isArray(slot)) flat.push(...slot);
    else if(slot && typeof slot === 'object' && Object.keys(slot).length) flat.push(slot);
  });
  const txt = it => String((it && it.subject && it.subject.ua !== undefined ? it.subject.ua : it && it.subject) || (it && it.name) || '').toLowerCase();
  const lessons = [];
  flat.forEach((it, i) => {
    if(!it || it.type === 'break' || /перерва|обід|обед|сніданок/.test(txt(it))) return;
    const key = String(it.number || (i + 1)).trim();
    if(!key) return;
    const m = String(it.time || '').match(/(\d{1,2})[:.](\d{2})/);
    lessons.push({ i, key, start: m ? (+m[1] * 60 + +m[2]) : null });
  });
  const brkAt = flat.findIndex(it => it && /сніданок/.test(txt(it)));
  const lunchAt = flat.findIndex(it => it && /обід|обед/.test(txt(it)));
  // Сніданок стоїть перед першим уроком — тоді його пропускає той, хто не був
  // на першому уроці (прийшов пізніше). Так само, якщо перерви немає зовсім.
  let breakfast = brkAt >= 0 ? lessons.filter(l => l.i < brkAt) : [];
  if(!breakfast.length) breakfast = lessons.slice(0, 1);
  const beforeLunch = lunchAt >= 0 ? lessons.filter(l => l.i < lunchAt)
    : lessons.filter(l => l.start !== null ? l.start < 12 * 60 : Number(l.key) <= 4);
  return { breakfast: new Set(breakfast.map(l => l.key)),
           lunch: new Set(beforeLunch.length ? [beforeLunch[beforeLunch.length - 1].key] : []) };
}
// Які з порцій, що лишилися в замовленні, дитина справді пропустила.
// kept — підписи ('сніданок','обід','підвечірок'); ml — з mealLessons
// (null — розкладу немає: будь-яка відмітка, як раніше).
function missedMeals(slots, kept, ml){
  const keys = Object.entries(slots || {}).filter(([, r]) => r && r.status === 'absent').map(([k]) => String(k));
  if(!keys.length) return [];
  if(keys.includes('all') || !ml) return (kept || []).slice();
  return (kept || []).filter(l => {
    const set = l === 'сніданок' ? ml.breakfast : ml.lunch;
    return keys.some(k => set.has(k));
  });
}
// Що саме відмічено: «увесь день» або перший пропущений урок
function noShowWhat(slots){
  let all = false, first = null;
  for(const [k, r] of Object.entries(slots || {})){
    if(!r || r.status !== 'absent') continue;
    if(k === 'all'){ all = true; continue; }
    const n = Number(k);
    if(Number.isFinite(n) && (first === null || n < first)) first = n;
  }
  return all ? 'увесь день' : first !== null ? `${first}-й урок` : '';
}
// «учитель відмітив о 14:40», «батьки повідомили о 09:20»
const BY_VERB = { teacher:'учитель відмітив', class_teacher:'учитель відмітив', parent:'батьки повідомили',
                  student:'учень повідомив', administrator:'адміністратор відмітив', director:'директор відмітив' };
function lateDetail(r){
  const who = BY_VERB[r.by] || (r.hm ? 'відмічено' : '');
  return [ (r.meals || []).length ? `порція: ${(r.meals || []).join(', ')}` : '',
           r.what ? `не було: ${r.what}` : '',
           who ? `${who}${r.hm ? ' о ' + r.hm : ''}` : '' ].filter(Boolean).join(' · ');
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
    const ml = data.schedules ? mealLessons(data.schedules[cls]?.lessons?.[DAY_EN[weekday]]) : null;
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
        const missed = missedMeals(daySlots, kept, ml);
        if (missed.length) out.late.push({ cls, sid, name, by: abs.by, byLabel: BY_LABEL[abs.by] || '',
                                         what: noShowWhat(daySlots),
                                         hm: abs.ts ? warsawParts(abs.ts).hm : '', meals: missed });
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
  const late = day.late.length ? ` Не було без попередження: ${day.late.length} (їхні порції враховано).` : '';
  return { title: '🍽️ Замовлення на сьогодні закрито',
           body: `${lunch} · ${brk} · підвечірків ${day.snack}.${late}`, tag: `kitchen-cutoff-${day.date}` };
}
function lateMessage(rows, date) {
  const one = r => `${r.name}, ${clsNum(r.cls)} кл. (${lateDetail(r)})`;
  return rows.length === 1
    ? { title: '🚨 Не було без попередження', body: `${one(rows[0])}.`, tag: `kitchen-late-${date}-${rows[0].cls}-${rows[0].sid}` }
    // Не більше восьми імен у тексті: довге сповіщення телефон однаково обріже,
    // а решту кухня побачить у кабінеті. tag — унікальний на кожну пачку:
    // спільний tag тихо заміняв би попередню пачку в шторці телефона.
    : { title: `🚨 Не було без попередження: ${rows.length}`,
        body: rows.slice(0, 8).map(one).join('; ') + (rows.length > 8 ? `; і ще ${rows.length - 8} — у кабінеті` : '') + '.',
        tag: `kitchen-late-${date}-${rows.map(r => r.cls + r.sid).join('').slice(0, 40)}` };
}

module.exports = { kitchenDay, absenceOf, cutoffMessage, lateMessage, warsawParts, mealLessons, missedMeals, noShowWhat, lateDetail };
