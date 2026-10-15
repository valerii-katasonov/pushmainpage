// ═══════════════════════════════════════════════════════════════
// streaks.js — 🔥 серія виконаного ДЗ (підхід 10).
//
// ЩО РАХУЄМО. «Скільки навчальних днів поспіль усе ДЗ, яке треба було
// зробити НА цей день, позначене виконаним». День — це дата, ДО якої
// завдання треба зробити: наступний урок цього предмета за розкладом
// (nextLessonDate, з пропуском свят і канікул), а не дата, коли його
// задали. Раніше бралася дата видачі — і ДЗ, задане сьогодні на наступний
// тиждень, «псувало» сьогоднішній день, хоча робити його ще рано.
//
// ЯКІ ДНІ ВЖЕ РАХУЮТЬСЯ: усі до найближчого навчального дня включно
// (завтра, а в пʼятницю — понеділок). Завдання на пізніші дати чекають
// свого дня й серію не чіпають. Незавершений сьогоднішній і завтрашній
// день серію не переривають — ще можна встигнути позначити.
// Дні без ДЗ серію не переривають (вихідні, свята, день без завдань).
// Серію бачать учень («Сьогодні») і батьки («Оцінки → Огляд»).
//
// ЧОМУ ЛИШЕ ДЗ. Пропуски й запізнення в серію навмисно не входять: дитина
// хворіла — і «втратила серію»? Це покарання, а не мотивація. Позначку ж
// «виконано» ставить сама родина, і вона повністю в її руках.
// Тон — лише заохочення: без червоного, без «ти зірвав серію».
//
// ДАНІ — лише свої: student_hw_done/{клас}/{учень}/{дата}/{предмет} = ts
// (дзеркало hw_done, пишеться разом із ним), ДЗ класу за 60 днів,
// розклад класу і свята/канікули (щоб знати, на коли кожне завдання).
// ═══════════════════════════════════════════════════════════════
import { ref, get, child, query, orderByKey, startAt } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, currentUserData, getActiveClass, sidOf, subjKey, escHtml, showToast, nextLessonDate } from './common.js';
import { loadSkipDates } from './homework.js';

export const LOOKBACK_DAYS = 60;
export const MILESTONES = [3, 5, 10, 15, 20, 30, 50];
const pad = n => String(n).padStart(2, '0');
export const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const shift = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };

// Чи є в записі ДЗ хоч щось (текст, фото, тренажер)
export function hasHw(v){
  if(!v) return false;
  if(typeof v === 'string') return !!v.trim();
  return !!((v.text && String(v.text).trim()) || (v.images && v.images.length) || (v.trainers && Object.keys(v.trainers).length) || (v.files && v.files.length));
}

// Наступний навчальний день після ds: без вихідних і без свят/канікул
export function nextSchoolDay(ds, skip){
  const sk = skip instanceof Set ? skip : new Set(skip || []);
  let d = ds;
  for(let i = 0; i < 30; i++){
    d = shift(d, 1);
    const wd = parse(d).getDay();
    if(wd === 0 || wd === 6 || sk.has(d)) continue;
    return d;
  }
  return shift(ds, 1);
}

// hw: {датаВидачі: {предмет: запис}}, done: {датаВидачі: {ключПредмета: ts}},
// today 'YYYY-MM-DD'. opts.skip — свята/канікули, opts.dueOf(предмет, датаВидачі)
// → дата, на яку треба зробити ('' — невідомо: тоді наступний навчальний день).
// → {current, best, next:{date, done, total}, days:[{date, total, done, full}]}
//   days — по ДАТІ ЗДАЧІ, лише до найближчого навчального дня включно.
export function computeStreak(hw, done, today, opts = {}){
  const skip = opts.skip instanceof Set ? opts.skip : new Set(opts.skip || []);
  const dueOf = opts.dueOf || (() => '');
  const target = nextSchoolDay(today, skip);
  const by = {};
  Object.keys(hw || {}).filter(d => d <= today).forEach(given => {
    const marks = (done && done[given]) || {};
    Object.keys(hw[given] || {}).filter(s => hasHw(hw[given][s])).forEach(s => {
      const due = dueOf(s, given) || nextSchoolDay(given, skip);
      if(due > target) return;                 // ще не час — чекає свого дня
      const x = by[due] || (by[due] = { date: due, total: 0, done: 0 });
      x.total++;
      if(marks[subjKey(s)]) x.done++;
    });
  });
  const days = Object.values(by).sort((a, b) => a.date < b.date ? -1 : 1)
    .map(x => ({ ...x, full: x.done === x.total }));
  // Ще можна встигнути: сьогоднішнє й завтрашнє (до target) не переривають
  const open = d => d.date >= today;
  let current = 0;
  for(let i = days.length - 1; i >= 0; i--){
    const d = days[i];
    if(d.full){ current++; continue; }
    if(open(d)) continue;
    break;
  }
  let best = 0, run = 0;
  days.forEach(d => { if(d.full){ run++; best = Math.max(best, run); } else if(!open(d)) run = 0; });
  best = Math.max(best, current);
  const t = by[target];
  return { current, best, next: { date: target, done: t ? t.done : 0, total: t ? t.total : 0 }, days };
}

// «На завтра» / «На понеділок» — на коли найближче ДЗ
const ON_DAY = ['На неділю', 'На понеділок', 'На вівторок', 'На середу', 'На четвер', 'На пʼятницю', 'На суботу'];
export const dueLabel = (date, today) => date === shift(today, 1) ? 'На завтра' : ON_DAY[parse(date).getDay()];

// Пн–Пт поточного тижня (за датою здачі): 'full' | 'part' | 'none' | 'nohw' | 'future'
export function weekDots(days, today, target){
  const d = parse(today), dow = (d.getDay() + 6) % 7;
  const mon = shift(today, -dow);
  const last = target || today;
  const by = Object.fromEntries((days || []).map(x => [x.date, x]));
  return ['Пн', 'Вт', 'Ср', 'Чт', 'Пт'].map((label, i) => {
    const date = shift(mon, i), x = by[date];
    const state = date > last ? 'future' : !x ? (date > today ? 'future' : 'nohw') : x.full ? 'full' : x.done ? 'part' : 'none';
    return { label, date, state };
  });
}

const plural = (n, one, few, many) => { const a = n % 100, b = n % 10; return (a > 10 && a < 20) ? many : b === 1 ? one : (b >= 2 && b <= 4) ? few : many; };
export const nextMilestone = n => MILESTONES.find(m => m > n) || null;

export function streakHtml(st, today, opts = {}){
  const who = opts.who || '';
  const dots = weekDots(st.days, today, st.next && st.next.date).map(d => `<span class="st-dot ${d.state}" title="${escHtml(d.label)}: ${
      { full: 'усе виконано', part: 'частково', none: 'ще не позначено', nohw: 'ДЗ не було', future: 'ще попереду' }[d.state]}"><i></i>${escHtml(d.label)}</span>`).join('');
  const nx = nextMilestone(st.current);
  const head = st.current
    ? `<span class="st-fire" aria-hidden="true">🔥</span><div><b class="st-n">${st.current}</b> <span>${plural(st.current, 'день', 'дні', 'днів')} поспіль усе ДЗ виконано${who ? ` · ${escHtml(who)}` : ''}</span></div>`
    : `<span class="st-fire off" aria-hidden="true">🔥</span><div><b class="st-n">0</b> <span>${opts.student ? 'Познач виконане ДЗ — і почнеться серія' : 'Позначайте виконане ДЗ — і почнеться серія'}</span></div>`;
  const nx0 = st.next || { total: 0 };
  const lbl = nx0.total ? dueLabel(nx0.date, today) : '';
  const todayLine = nx0.total
    ? (nx0.done === nx0.total ? `✓ ${lbl} — усе позначено` : `${lbl}: ${nx0.done} з ${nx0.total}`) : '';
  const sub = [todayLine, nx && st.current ? `до ${nx} ${plural(nx, 'дня', 'днів', 'днів')} — ще ${nx - st.current}` : '', st.best > st.current ? `найкраща серія: ${st.best}` : '']
    .filter(Boolean).join(' · ');
  return `<div class="st-top">${head}</div>
    <div class="st-week" aria-label="Цей тиждень">${dots}</div>
    ${sub ? `<p class="st-sub">${escHtml(sub)}</p>` : ''}
    <details class="ui-how"><summary>ℹ️ Як рахується</summary><p>День зараховується, коли все ДЗ, яке треба було зробити до уроків цього дня, позначене виконаним
      (кнопка «○ Позначити виконаним» на вкладці «ДЗ»). Завдання на наступний тиждень рахуються у свій день, а не в день, коли їх задали. Дні без ДЗ серію не переривають. Пропуски через хворобу на серію не впливають.</p></details>`;
}

// ── ДАНІ Й МАЛЮВАННЯ ─────────────────────────────────────────────
const range = (p, from) => get(query(child(ref(db), p), orderByKey(), startAt(from))).then(s => s.exists() ? s.val() : {});
let seq = 0;
export async function renderStreaks(){
  const u = currentUserData; if(!u) return;
  const prefix = u.role === 'student' ? 's' : u.role === 'parent' ? 'p' : '';
  const box = prefix && document.getElementById(`${prefix}-streak`);
  if(!box) return;
  const cls = getActiveClass(), sid = (await sidOf(cls, u.studentName).catch(() => null)) || u.studentId || u.studentName || '';
  if(!cls || !sid){ box.hidden = true; return; }
  const my = ++seq, today = ymd(new Date()), from = shift(today, -LOOKBACK_DAYS);
  let hw, done, sch, skip;
  try{ [hw, done] = await Promise.all([range(`homeworks/${cls}`, from), range(`student_hw_done/${cls}/${sid}`, from)]); }
  catch(e){ box.hidden = true; return; }          // правила ще не опубліковані
  // Розклад і свята — щоб знати, НА КОЛИ кожне завдання. Без них — на
  // наступний навчальний день після видачі (як «ДЗ на завтра» без розкладу).
  [sch, skip] = await Promise.all([
    get(child(ref(db), `schedules/${cls}/lessons`)).then(s => s.exists() ? s.val() : {}).catch(() => ({})),
    Promise.resolve().then(() => loadSkipDates()).catch(() => new Set())
  ]);
  if(my !== seq) return;
  const hasSch = !!(sch && Object.keys(sch).length);
  const dueOf = (subj, given) => hasSch ? nextLessonDate(sch, subj, given, skip) : '';
  const st = computeStreak(hw, done, today, { skip, dueOf });
  // Ще жодної позначки за два місяці й ДЗ немає — блоку немає
  if(!st.days.length){ box.hidden = true; return; }
  box.hidden = false;
  const first = String(u.studentName || '').trim().split(/\s+/).pop();
  box.innerHTML = streakHtml(st, today, { student: prefix === 's', who: prefix === 'p' ? first : '' });
  celebrate(st.current, `${cls}|${sid}`, prefix === 's');
}
// Святкуємо кожну віху один раз (на цьому пристрої)
function celebrate(n, key, student){
  if(!MILESTONES.includes(n)) return;
  const k = `push_streak_${key}_${n}`;
  try{ if(localStorage.getItem(k)) return; localStorage.setItem(k, '1'); }catch(e){ return; }
  if(typeof window.confetti === 'function') window.confetti({ particleCount: 120, spread: 75, origin: { y: 0.6 } });
  showToast(student ? `🔥 ${n} днів поспіль! Так тримати!` : `🔥 ${n} днів поспіль усе ДЗ виконано!`);
}
window.renderStreaks = renderStreaks;
