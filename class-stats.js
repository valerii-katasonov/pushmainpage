// ═══════════════════════════════════════════════════════════════
// class-stats.js — 📊 статистика учнів: пропуски, запізнення й предмети
// з низьким середнім балом.
//
// ДЕ ВИДНО
//   • Класний керівник (і директор/адміністрація): «Швидкі дії» →
//     «📊 Статистика класу» — таблиця всіх учнів класу; рядок розгортається
//     й показує предмети з низьким балом та дати пропусків.
//   • Батьки й учень: вкладка «Оцінки», картка над «За предметом» — те саме
//     про свою дитину.
//
// ЯК РАХУЄМО (за обраний період; за замовчуванням — поточний семестр)
//   Пропущено днів  — дні з відміткою «відсутній» на ВЕСЬ ДЕНЬ.
//   Пропущено уроків — УСІ пропущені уроки без подвійного рахунку:
//                      • за пропущений день — стільки, скільки уроків у
//                        класу цього дня тижня за розкладом (без перерв і
//                        гуртків/факультативів); окремі відмітки на уроках
//                        цього ж дня вже не додаються;
//                      • в інші дні — кожен урок, відмічений «відсутній».
//   За предметами    — ті самі уроки, розкладені за розкладом: пропущений
//                      день дає по уроку кожному предмету цього дня, окремий
//                      урок — своєму предмету (за номером уроку).
//   Запізнень       — дні, коли було хоч одне запізнення.
//   Середній з предмета — так само, як пропонується семестрова: середнє
//                      арифметичне тематичних, якщо вони вже є; інакше —
//                      середньозважений поточних.
//   Низький бал     — шкала 1–12: менше 4; шкала 1–6 і рівні 1–4 класів
//                      (П/С/Д/В): менше 3 (тобто нижче «С»); інша шкала —
//                      менше третини максимуму.
//
// ПРАВА. Нічого нового: персонал читає вузли класу, родина — дзеркало
// оцінок своєї дитини і власну гілку відвідуваності.
// ═══════════════════════════════════════════════════════════════
import { ref, get, child } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, escHtml, escJs, getClassNum, LEVEL_MAX_CLASS, topicBreakdown, calculateStudentWeightedAvg,
         childAttendanceRange, getDateRange, getActiveClass, academicYearId, displayGrade, getStudentDir,
         stuName, formatAttendanceSlotLabel, localDateString, isBreakItem, dayKeys } from './common.js';

// ── ЧИСТА ЛОГІКА (покрита тестами) ─────────────────────────────
export function lowThreshold(max, junior){
  if(junior) return 3;
  const m = Number(max) || 6;
  if(m === 6) return 3;
  if(m === 12) return 4;
  return m / 3;
}
// Середній з предмета за період — як для семестрової.
export function subjectAvg(grades, types){
  const th = topicBreakdown(grades, types).thematic.map(x => x.n).filter(n => n !== null);
  if(th.length) return { avg: th.reduce((a, b) => a + b, 0) / th.length, by: 'thematic', n: th.length };
  const avg = calculateStudentWeightedAvg(grades, types);
  const n = Object.keys(grades || {}).length;
  return { avg, by: 'weighted', n };
}
// perSubj: {предмет: {g:{ключ:знач}, t:{ключ:тип}}}; scaleOf(предмет) → максимум
export function lowSubjects(perSubj, scaleOf, junior){
  const out = [];
  for(const subj in (perSubj || {})){
    const { g, t } = perSubj[subj] || {};
    // Старі бали понад 6 у молодших класах — не рівні, у середнє не йдуть
    const gg = junior ? Object.fromEntries(Object.entries(g || {}).filter(([, v]) => !(Number(v) > 6))) : (g || {});
    const r = subjectAvg(gg, t || {});
    if(r.avg === null || r.avg === undefined) continue;
    const max = junior ? 6 : (scaleOf ? scaleOf(subj) : 6);
    const thr = lowThreshold(max, junior);
    if(r.avg < thr) out.push({ subj, avg: r.avg, by: r.by, n: r.n, max, thr });
  }
  return out.sort((a, b) => a.avg - b.avg || a.subj.localeCompare(b.subj, 'uk'));
}
// Скільки уроків у класу кожного дня тижня за розкладом:
//   lessons: schedules/{клас}/lessons = {Monday: [рядок, ...], ...}
// Рядок — урок або кілька паралельних (групи) — рахується ОДИН раз.
// Перерви не рахуємо; гуртки й факультативи (type 'extra') теж — їх
// відвідують не всі, і «пропущений день» не означає пропущений гурток.
const subjName = x => { const sj = x && x.subject; const n = typeof sj === 'string' ? sj : (sj && (sj.ua || sj.pl)) || '';
  return String(n || (x && Array.isArray(x.alt) ? x.alt.map(a => typeof a === 'string' ? a : (a && (a.ua || a.pl)) || '').filter(Boolean).join(' / ') : '')).trim(); };
// Уроки кожного дня тижня: {Monday: [{num, label}]}. num — номер уроку
// (саме під ним лежить відмітка на окремому уроці), label — предмет; для
// паралельних груп з різними предметами — «А / Б».
export function lessonRows(lessons){
  const out = {};
  for(const day in (lessons || {})){
    const rows = Array.isArray(lessons[day]) ? lessons[day] : Object.values(lessons[day] || {});
    out[day] = [];
    rows.forEach(r => {
      const items = (Array.isArray(r) ? r : (r ? [r] : [])).filter(x => x && (x.subject || x.alt) && !isBreakItem(x) && x.type !== 'extra');
      if(!items.length) return;
      const names = [...new Set(items.map(subjName).filter(Boolean))];
      out[day].push({ num: String(items.find(x => x.number)?.number || ''), label: names.join(' / ') || 'Урок' });
    });
  }
  return out;
}
export function lessonsPerWeekday(lessons){
  const rows = lessonRows(lessons), out = {};
  for(const d in rows) out[d] = rows[d].length;
  return out;
}
const weekdayOf = ds => { const [y, m, d] = ds.split('-').map(Number); return dayKeys[new Date(y, m - 1, d).getDay()]; };
// byDate: {дата: {урок|'all': {status, reason}}} — відмітки ОДНІЄЇ дитини
// perDay: результат lessonsPerWeekday — скільки уроків за пропущений день
// rows:   результат lessonRows — щоб розкласти пропуски ЗА ПРЕДМЕТАМИ
//         (bySubj: {предмет: скільки уроків пропущено}). Без нього — лише числа.
export function attendanceSummary(byDate, perDay, rows){
  const days = [], lessons = [], late = [];
  let lessonCount = 0, inDays = 0;
  const bySubj = {};
  const addS = (label, n = 1) => { if(n > 0) bySubj[label] = (bySubj[label] || 0) + n; };
  for(const d of Object.keys(byDate || {}).sort()){
    const slots = byDate[d] || {};
    const all = slots.all && slots.all.status === 'absent';
    let wasLate = false;
    const missed = new Set();
    for(const k in slots){
      const r = slots[k]; if(!r || !r.status) continue;
      if(r.status === 'late') wasLate = true;
      else if(r.status === 'absent' && k !== 'all') missed.add(k);
    }
    if(all){
      // Увесь день: уроки дня за розкладом. Відмітки на окремих уроках
      // цього дня — ті самі уроки, тож не додаються. Якщо розкладу на цей
      // день немає, беремо хоча б відмічені уроки.
      const n = Math.max((perDay && perDay[weekdayOf(d)]) || 0, missed.size);
      days.push({ date: d, reason: slots.all.reason || '', lessons: n });
      lessonCount += n; inDays += n;
      if(rows){
        const dayRows = rows[weekdayOf(d)] || [];
        dayRows.forEach(r => addS(r.label));
        // Відмічених уроків більше, ніж у розкладі (розкладу на день немає)
        if(n > dayRows.length){
          const known = new Set(dayRows.map(r => r.num));
          const extra = [...missed].filter(k => !known.has(String(k)));
          extra.slice(0, n - dayRows.length).forEach(k => addS(`Урок ${k}`));
          addS('Предмет не визначено', n - dayRows.length - Math.min(extra.length, n - dayRows.length));
        }
      }
    }else{
      const dayRows = (rows && rows[weekdayOf(d)]) || [];
      [...missed].sort((a, b) => Number(a) - Number(b) || String(a).localeCompare(String(b)))
        .forEach(k => {
          const row = dayRows.find(r => r.num && r.num === String(k));
          lessons.push({ date: d, slot: k, subj: row ? row.label : '', reason: slots[k].reason || '' });
          if(rows) addS(row ? row.label : `Урок ${k}`);
        });
      lessonCount += missed.size;
    }
    if(wasLate) late.push({ date: d });
  }
  const subjects = Object.entries(bySubj).map(([subj, n]) => ({ subj, n }))
    .sort((a, b) => b.n - a.n || a.subj.localeCompare(b.subj, 'uk'));
  return { days, lessons, late, lessonCount, inDays, subjects };
}
// Відмітки могли лягти під ключем учня і (старі) під імʼям — зливаємо.
export function mergeKeys(attRange, keys){
  const out = {};
  for(const d in (attRange || {})){
    for(const k of keys){
      const s = attRange[d] && attRange[d][k];
      if(s && typeof s === 'object') out[d] = { ...(out[d] || {}), ...s };
    }
  }
  return out;
}
// ПЕРІОДИ: місяць, семестр або рік.
//   months    — місяці навчального року від вересня до поточного;
//   semesters — семестри з налаштувань року;
//   year      — увесь навчальний рік.
// За замовчуванням — поточний семестр; якщо семестрів не задано — поточний місяць.
const MONTHS_UA = ['Січень','Лютий','Березень','Квітень','Травень','Червень','Липень','Серпень','Вересень','Жовтень','Листопад','Грудень'];
export function periodsFrom(semesters, year, today){
  const y0 = Number(String(year).slice(0, 4)) || Number(String(today).slice(0, 4));
  const semList = Object.entries(semesters || {})
    .filter(([, s]) => s && s.startDate && s.endDate)
    .map(([id, s]) => ({ id, name: s.name || id, start: s.startDate, end: s.endDate }))
    .sort((a, b) => a.start.localeCompare(b.start));
  const months = [];
  for(let i = 0; i < 12; i++){
    const y = i < 4 ? y0 : y0 + 1, m = ((8 + i) % 12) + 1;
    const id = `${y}-${String(m).padStart(2, '0')}`;
    if(`${id}-01` > today) break;
    const last = new Date(y, m, 0).getDate();
    months.push({ id, name: `${MONTHS_UA[m - 1]} ${y}`, start: `${id}-01`, end: `${id}-${String(last).padStart(2, '0')}` });
  }
  if(!months.length) months.push({ id: `${y0}-09`, name: `Вересень ${y0}`, start: `${y0}-09-01`, end: `${y0}-09-30` });
  const yearP = { id: 'year', name: `${y0}–${y0 + 1} н.р.`, start: `${y0}-09-01`, end: `${y0 + 1}-08-31` };
  const curSem = semList.find(p => p.start <= today && today <= p.end)
    || [...semList].reverse().find(p => p.start <= today);
  const curMonth = months[months.length - 1];
  const cur = curSem ? { kind: 'semester', id: curSem.id } : { kind: 'month', id: curMonth.id };
  return { months, semesters: semList, year: yearP, cur };
}
export function pickPeriod(P, sel){
  if(!P) return null;
  if(sel.kind === 'year') return P.year;
  const list = sel.kind === 'semester' ? P.semesters : P.months;
  return list.find(x => x.id === sel.id) || list[list.length - 1] || P.year;
}
// Перемикач «Місяць · Семестр · Рік» + вибір конкретного місяця/семестру
export function periodControl(P, sel, fn){
  const kinds = [['month', 'Місяць'], ...(P.semesters.length ? [['semester', 'Семестр']] : []), ['year', 'Рік']];
  const seg = `<div class="pst-seg" role="group" aria-label="Період">${kinds.map(([k, l]) =>
    `<button type="button" class="pst-k${sel.kind === k ? ' on' : ''}" aria-pressed="${sel.kind === k}" onclick="${fn}('${k}')">${l}</button>`).join('')}</div>`;
  const list = sel.kind === 'semester' ? P.semesters : sel.kind === 'month' ? P.months : null;
  const cur = pickPeriod(P, sel);
  const pick = list ? `<select class="pst-pick" aria-label="Оберіть ${sel.kind === 'month' ? 'місяць' : 'семестр'}" onchange="${fn}('${sel.kind}',this.value)">${
      list.map(x => `<option value="${escHtml(x.id)}"${x.id === cur.id ? ' selected' : ''}>${escHtml(x.name)}</option>`).join('')}</select>`
    : `<span class="pst-range">${escHtml(human(cur.start))}.${cur.start.slice(0, 4)} – ${escHtml(human(cur.end))}.${cur.end.slice(0, 4)}</span>`;
  return `<div class="pst">${seg}${pick}</div>`;
}
export function monthsIn(start, end){
  const out = []; let [y, m] = start.slice(0, 7).split('-').map(Number); const [ey, em] = end.slice(0, 7).split('-').map(Number);
  while(y < ey || (y === ey && m <= em)){ out.push(`${y}-${String(m).padStart(2, '0')}`); if(++m > 12){ m = 1; y++; } }
  return out;
}
// Будні дні періоду до сьогодні включно — по них родина читає відмітки
export function schoolDays(start, end){
  const out = []; const [y, m, d] = start.split('-').map(Number); const dt = new Date(y, m - 1, d);
  for(let i = 0; i < 400; i++){
    const s = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    if(s > end) break;
    const w = dt.getDay(); if(w !== 0 && w !== 6) out.push(s);
    dt.setDate(dt.getDate() + 1);
  }
  return out;
}
const human = ds => ds.split('-').reverse().slice(0, 2).join('.');
const plural = (n, f) => { const a = n % 100, b = a % 10; return f[a > 10 && a < 20 ? 2 : b === 1 ? 0 : b > 1 && b < 5 ? 1 : 2]; };

// ── СПІЛЬНИЙ ПОКАЗ ─────────────────────────────────────────────
function avgText(x, cls){
  const r = x.avg.toFixed(2);
  const junior = getClassNum(cls) <= LEVEL_MAX_CLASS;
  const lvl = junior ? ` (${displayGrade(String(Math.max(2, Math.round(x.avg))), cls)})` : '';
  return `${r}${lvl}`;
}
function lowListHtml(low, cls){
  if(!low.length) return '<p class="cst-none">✅ Предметів із низьким середнім балом немає.</p>';
  return `<ul class="cst-low">${low.map(x => `<li><b>${escHtml(x.subj)}</b> — ${avgText(x, cls)}
      <span>${x.by === 'thematic' ? `середнє ${x.n} ${plural(x.n, ['тематичної', 'тематичних', 'тематичних'])}` : `${x.n} ${plural(x.n, ['оцінка', 'оцінки', 'оцінок'])}`} · поріг ${Number.isInteger(x.thr) ? x.thr : x.thr.toFixed(1)}</span></li>`).join('')}</ul>`;
}
// Пропуски за предметами: «Математика — 4 · Англійська — 2»
function subjAbsHtml(a){
  if(!a || !a.subjects || !a.subjects.length) return '';
  return `<div class="cst-subj"><b>Пропущено за предметами:</b> ${a.subjects.map(x =>
    `<span class="cst-sj">${escHtml(x.subj)} — <b>${x.n}</b></span>`).join('')}</div>`;
}
function attListHtml(a){
  const parts = [];
  if(a.days.length) parts.push(`<div><b>Пропущені дні:</b> ${a.days.map(x => escHtml(human(x.date)) + ` <span class="cst-r">(${x.lessons} ${plural(x.lessons, ['урок', 'уроки', 'уроків'])}${x.reason ? `, ${escHtml(x.reason)}` : ''})</span>`).join(', ')}</div>`);
  if(a.lessons.length) parts.push(`<div><b>Окремі уроки:</b> ${a.lessons.map(x => `${escHtml(human(x.date))} ${escHtml(formatAttendanceSlotLabel(x.slot).replace('Урок ', 'ур.'))}${x.subj ? ` <span class="cst-r">${escHtml(x.subj)}</span>` : ''}`).join(', ')}</div>`);
  if(a.late.length) parts.push(`<div><b>Запізнення:</b> ${a.late.map(x => escHtml(human(x.date))).join(', ')}</div>`);
  return parts.join('') || '<p class="cst-none">Пропусків і запізнень немає.</p>';
}
export async function loadPeriods(){
  const year = academicYearId();
  const s = await get(child(ref(db), `academic_year/${year}/semesters`)).catch(() => null);
  return periodsFrom(s && s.exists() ? s.val() : {}, year, localDateString);
}
// Розклад класу → уроків на день тижня. Раз на клас за сеанс.
const perDayCache = {};
async function perDayOf(cls){
  if(perDayCache[cls]) return perDayCache[cls];
  const s = await get(child(ref(db), `schedules/${cls}/lessons`)).catch(() => null);
  const v = s && s.exists() ? s.val() : {};
  return (perDayCache[cls] = { perDay: lessonsPerWeekday(v), rows: lessonRows(v) });
}
const clampEnd = p => (p.end < localDateString ? p.end : localDateString);

// ══ КЛАСНИЙ КЕРІВНИК ════════════════════════════════════════════
let csP = null, csSel = null, csSeq = 0, csSubj = '';
function ensureClassModal(){
  let m = document.getElementById('class-stats-modal'); if(m) return m;
  m = document.createElement('div');
  m.id = 'class-stats-modal'; m.className = 'modal-overlay';
  m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-labelledby', 'cst-title');
  m.innerHTML = `<div class="modal-content cst-box">
      <div class="cst-head"><h3 id="cst-title">📊 Статистика класу <span id="cst-cls"></span></h3>
        <button type="button" class="cst-close" onclick="closeClassStats()" aria-label="Закрити">✕</button></div>
      <div id="cst-period"></div>
      <p class="cst-note">«Пропущ. уроків» — усі пропущені уроки: за пропущений день — уроки цього дня за розкладом (без гуртків), плюс окремі уроки в інші дні; один урок двічі не рахується.
        Низький бал: менше 4 за шкалою 1–12, менше 3 за шкалою 1–6 (у 1–4 класах — нижче рівня «С»).
        Середній — як для семестрової: з тематичних, а поки їх немає — середньозважений поточних. Натисніть на учня, щоб побачити подробиці.</p>
      <div id="cst-body"><p class="empty-msg">Завантаження...</p></div>
    </div>`;
  m.addEventListener('click', e => { if(e.target === m) window.closeClassStats(); });
  m.addEventListener('keydown', e => { if(e.key === 'Escape') window.closeClassStats(); });
  document.body.appendChild(m);
  return m;
}
window.closeClassStats = () => { const m = document.getElementById('class-stats-modal'); if(m) m.style.display = 'none'; };
// kind — 'month' | 'semester' | 'year'; id — конкретний місяць/семестр (якщо обрали зі списку)
window.setClassStatsPeriod = (kind, id) => {
  if(!csP) return;
  const list = kind === 'semester' ? csP.semesters : csP.months;
  const keep = csSel && csSel.kind === kind ? csSel.id : null;
  csSel = { kind, id: id || keep || (kind === 'year' ? 'year' : (kind === csP.cur.kind ? csP.cur.id : list[list.length - 1]?.id)) };
  paintClassPeriod(); renderClassStats();
};
function paintClassPeriod(){ const b = document.getElementById('cst-period'); if(b && csP) b.innerHTML = periodControl(csP, csSel, 'setClassStatsPeriod'); }
window.openClassStats = async function(){
  const m = ensureClassModal(); m.style.display = 'flex';
  const cls = getActiveClass();
  document.getElementById('cst-cls').textContent = cls ? `· ${cls.replace('class_', '')} клас` : '';
  try{
    if(!csP){ csP = await loadPeriods(); csSel = { ...csP.cur }; }
    paintClassPeriod();
  }catch(e){}
  renderClassStats();
};
async function renderClassStats(){
  const req = ++csSeq;
  const box = document.getElementById('cst-body'); if(!box) return;
  const cls = getActiveClass();
  const p = csP && pickPeriod(csP, csSel);
  if(!cls || !p){ box.innerHTML = '<p class="empty-msg">Оберіть клас.</p>'; return; }
  box.innerHTML = '<p class="empty-msg">Рахую...</p>';
  try{
    const end = clampEnd(p), months = monthsIn(p.start, end);
    const junior = getClassNum(cls) <= LEVEL_MAX_CLASS;
    const [stSnap, scSnap, att, perDay, ...per] = await Promise.all([
      get(child(ref(db), `students_list/${cls}`)),
      get(child(ref(db), `grade_scales/${cls}`)).catch(() => null),
      getDateRange(`attendance/${cls}`, p.start, end, true),
      perDayOf(cls),
      ...months.flatMap(ym => [get(child(ref(db), `grades/${cls}/${ym}`)), get(child(ref(db), `grade_types/${cls}/${ym}`))])
    ]);
    if(req !== csSeq) return;
    const scales = scSnap && scSnap.exists() ? scSnap.val() : {};
    const scaleOf = s => Number(scales[s] && (scales[s].max || scales[s])) || 6;
    const students = Object.entries(stSnap.exists() ? stSnap.val() : {})
      .map(([sid, nm]) => ({ sid, nm: String(nm) })).sort((a, b) => a.nm.localeCompare(b.nm, 'uk'));
    if(!students.length){ box.innerHTML = '<p class="empty-msg">У класі немає учнів.</p>'; return; }
    // {sid: {предмет: {g, t}}}
    const by = {}; students.forEach(s => by[s.sid] = {});
    months.forEach((ym, i) => {
      const g = per[i * 2].exists() ? per[i * 2].val() : {}, t = per[i * 2 + 1].exists() ? per[i * 2 + 1].val() : {};
      for(const subj in g) for(const key in (g[subj] || {})){
        const d = key.slice(0, 10); if(d < p.start || d > end) continue;
        for(const sid in (g[subj][key] || {})){
          if(!by[sid]) continue;
          const v = g[subj][key][sid]; if(v === '' || v == null) continue;
          const slot = (by[sid][subj] ||= { g: {}, t: {} });
          slot.g[key] = v; slot.t[key] = (t[subj] && t[subj][key] && t[subj][key][sid]) || 'П';
        }
      }
    });
    let tDays = 0, tLessons = 0, tLate = 0, tLow = 0;
    // Фільтр «пропуски з предмета»: стовпець уроків показує лише цей предмет
    const subjOpts = [...new Set(Object.values(perDay.rows).flat().map(r => r.label))].sort((a, b) => a.localeCompare(b, 'uk'));
    if(csSubj && !subjOpts.includes(csSubj)) csSubj = '';
    const stats = students.map(s => ({ s, a: attendanceSummary(mergeKeys(att, [s.sid, s.nm]), perDay.perDay, perDay.rows) }));
    const lessonsOf = a => csSubj ? ((a.subjects.find(x => x.subj === csSubj) || {}).n || 0) : a.lessonCount;
    const rows = stats.map(({ s, a }, i) => {
      const low = lowSubjects(by[s.sid], scaleOf, junior);
      tDays += a.days.length; tLessons += lessonsOf(a); tLate += a.late.length; if(low.length) tLow++;
      const id = `cst-r${i}`;
      const n = (v, cls2) => `<td class="cst-n${v ? ' ' + cls2 : ''}">${v}</td>`;
      return `<tr class="cst-row" tabindex="0" role="button" aria-expanded="false" aria-controls="${id}"
          onclick="toggleClassStatsRow(this,'${id}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click()}">
          <td class="cst-name">${escHtml(s.nm)}</td>${n(a.days.length, 'bad')}${n(lessonsOf(a), 'warn')}${n(a.late.length, 'warn')}
          <td class="cst-n${low.length ? ' bad' : ''}">${low.length ? `${low.length} ▾` : '0'}</td></tr>
        <tr id="${id}" class="cst-detail" hidden><td colspan="5">${lowListHtml(low, cls)}${subjAbsHtml(a)}${attListHtml(a)}</td></tr>`;
    }).join('');
    const subjSel = subjOpts.length ? `<label class="cst-lbl" for="cst-subj">Пропуски з предмета</label>
      <select id="cst-subj" onchange="setClassStatsSubj(this.value)"><option value="">Усі предмети</option>${subjOpts.map(o =>
        `<option value="${escHtml(o)}"${o === csSubj ? ' selected' : ''}>${escHtml(o)}</option>`).join('')}</select>` : '';
    box.innerHTML = subjSel + `<p class="cst-sum">Разом: пропущено <b>${tDays}</b> ${plural(tDays, ['день', 'дні', 'днів'])} і <b>${tLessons}</b> ${plural(tLessons, ['урок', 'уроки', 'уроків'])}${csSubj ? ` з предмета «${escHtml(csSubj)}»` : ''} (з уроками пропущених днів),
        запізнень — <b>${tLate}</b>. Учнів із низьким балом хоча б з одного предмета: <b>${tLow}</b> з ${students.length}.</p>
      <div class="cst-wrap"><table class="cst-table"><thead><tr><th>Учень</th><th>Пропущ.<br>днів</th><th>${csSubj ? `Пропущ.<br>${escHtml(csSubj)}` : 'Пропущ.<br>уроків'}</th><th>Запіз-<br>нень</th><th data-tip="Предметів із низьким середнім балом">Низький<br>бал</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }catch(e){
    if(req === csSeq) box.innerHTML = `<p class="empty-msg" style="color:var(--danger);">Не вдалося порахувати: ${escHtml(e.message || '')}</p>`;
  }
}
window.setClassStatsSubj = v => { csSubj = v; renderClassStats(); };
window.toggleClassStatsRow = function(tr, id){
  const d = document.getElementById(id); if(!d) return;
  d.hidden = !d.hidden; tr.setAttribute('aria-expanded', String(!d.hidden)); tr.classList.toggle('open', !d.hidden);
};

// ══ БАТЬКИ Й УЧЕНЬ ══════════════════════════════════════════════
// Кличе grades-view.js щоразу, як малює «За предметом»: оцінки беремо з
// уже підписаного дзеркала, відвідуваність читаємо раз на дитину й період.
let fsP = null, fsSel = null, fsAtt = {}, fsSeq = 0, fsLast = null;
window.renderFamilyStats = async function(prefix, cls, sid, name, mirror, scales){
  fsLast = { prefix, cls, sid, name, mirror, scales };
  const box = document.getElementById(`${prefix}-family-stats`); if(!box || !cls || !sid) return;
  const req = ++fsSeq;
  try{
    if(!fsP){ fsP = await loadPeriods(); fsSel = { ...fsP.cur }; }
  }catch(e){ return; }
  if(req !== fsSeq) return;
  const p = pickPeriod(fsP, fsSel);
  const end = clampEnd(p), junior = getClassNum(cls) <= LEVEL_MAX_CLASS;
  // Оцінки з дзеркала: {місяць: {предмет: {ключ: {v, t}}}}
  const perSubj = {};
  for(const ym in (mirror || {})) for(const subj in (mirror[ym] || {})) for(const key in (mirror[ym][subj] || {})){
    const c = mirror[ym][subj][key] || {}, d = key.slice(0, 10);
    if(d < p.start || d > end || c.v === '' || c.v == null) continue;
    const s = (perSubj[subj] ||= { g: {}, t: {} }); s.g[key] = c.v; s.t[key] = c.t || 'П';
  }
  const low = lowSubjects(perSubj, subj => Number(scales && scales[subj] && (scales[subj].max || scales[subj])) || 6, junior);
  const attKey = `${cls}|${sid}|${p.id}|${end}`;
  const paint = a => {
    const tile = (v, label, cls2) => `<div class="fst-tile${v ? ' ' + cls2 : ''}"><b>${v === null ? '…' : v}</b><span>${label}</span></div>`;
    box.innerHTML = `<div class="fst-head"><b>📊 Підсумок</b></div>${periodControl(fsP, fsSel, 'setFamilyStatsPeriod')}
      <div class="fst-tiles">
        ${tile(a ? a.days.length : null, 'пропущено днів', 'bad')}${tile(a ? a.lessonCount : null, 'пропущено уроків', 'warn')}${tile(a ? a.late.length : null, 'запізнень', 'warn')}
      </div>
      <details class="fst-low">
        <summary>${low.length ? `⚠️ Предметів із низьким середнім балом: <b>${low.length}</b>` : '✅ Предметів із низьким середнім балом немає'}</summary>
        ${lowListHtml(low, cls)}
        <p class="cst-note">Поріг: менше 4 за шкалою 1–12, менше 3 за шкалою 1–6 (у 1–4 класах — нижче рівня «С»). Середній — як для семестрової: з тематичних, а поки їх немає — середньозважений поточних. Підсумкову виставляє вчитель.</p>
      </details>
      ${a && a.days.length && a.inDays ? `<p class="cst-note" style="margin:0 0 4px;">У т.ч. ${a.inDays} ${plural(a.inDays, ['урок', 'уроки', 'уроків'])} у пропущені дні (за розкладом) і ${a.lessonCount - a.inDays} окремо.</p>` : ''}
      ${a && a.subjects && a.subjects.length ? `<details class="fst-low"><summary>Пропущені уроки за предметами</summary>${subjAbsHtml(a)}</details>` : ''}
      ${a && (a.days.length || a.lessons.length || a.late.length) ? `<details class="fst-low"><summary>Дати пропусків і запізнень</summary>${attListHtml(a)}</details>` : ''}`;
  };
  if(fsAtt[attKey]){ paint(fsAtt[attKey]); return; }
  paint(null);
  try{
    const [raw, perDay] = await Promise.all([childAttendanceRange(cls, [sid, name], schoolDays(p.start, end)), perDayOf(cls)]);
    fsAtt[attKey] = attendanceSummary(mergeKeys(raw, [sid, name]), perDay.perDay, perDay.rows);
    if(req === fsSeq) paint(fsAtt[attKey]);
  }catch(e){
    if(req === fsSeq){ const t = box.querySelector('.fst-tiles'); if(t) t.innerHTML = '<p class="empty-msg">Відвідуваність не вдалося завантажити.</p>'; }
  }
};
window.setFamilyStatsPeriod = (kind, id) => {
  if(!fsP) return;
  const list = kind === 'semester' ? fsP.semesters : fsP.months;
  const keep = fsSel && fsSel.kind === kind ? fsSel.id : null;
  fsSel = { kind, id: id || keep || (kind === 'year' ? 'year' : (kind === fsP.cur.kind ? fsP.cur.id : list[list.length - 1]?.id)) };
  if(fsLast) window.renderFamilyStats(fsLast.prefix, fsLast.cls, fsLast.sid, fsLast.name, fsLast.mirror, fsLast.scales); };
