// ═══════════════════════════════════════════════════════════════
// streaks.js — 🔥 серія виконаного ДЗ (підхід 10).
//
// ЩО РАХУЄМО. «Скільки навчальних днів поспіль усе задане ДЗ позначене
// виконаним». День — це дата, на яку ДЗ задали (homeworks/{клас}/{дата}).
// Дні без ДЗ серію не переривають (вихідні, свята, день без завдань).
// Сьогоднішній день, поки не все позначене, теж не перериває — він ще
// триває. Серію бачать учень («Сьогодні») і батьки («Оцінки → Огляд»).
//
// ЧОМУ ЛИШЕ ДЗ. Пропуски й запізнення в серію навмисно не входять: дитина
// хворіла — і «втратила серію»? Це покарання, а не мотивація. Позначку ж
// «виконано» ставить сама родина, і вона повністю в її руках.
// Тон — лише заохочення: без червоного, без «ти зірвав серію».
//
// ДАНІ — лише свої: student_hw_done/{клас}/{учень}/{дата}/{предмет} = ts
// (дзеркало hw_done, пишеться разом із ним) і ДЗ класу за 60 днів.
// ═══════════════════════════════════════════════════════════════
import { ref, get, child, query, orderByKey, startAt } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, currentUserData, getActiveClass, stuId, subjKey, escHtml, showToast } from './common.js';

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

// hw: {дата: {предмет: запис}}, done: {дата: {ключПредмета: ts}}, today 'YYYY-MM-DD'
// → {current, best, today:{done,total}, days:[{date, total, done, full}] (по даті)}
export function computeStreak(hw, done, today){
  const days = Object.keys(hw || {}).filter(d => d <= today).sort().map(date => {
    const subj = Object.keys(hw[date] || {}).filter(s => hasHw(hw[date][s]));
    const marks = (done && done[date]) || {};
    const n = subj.filter(s => marks[subjKey(s)]).length;
    return { date, total: subj.length, done: n, full: subj.length > 0 && n === subj.length };
  }).filter(d => d.total > 0);
  // Поточна: з найновішого дня назад; незавершене «сьогодні» пропускаємо
  let current = 0;
  for(let i = days.length - 1; i >= 0; i--){
    const d = days[i];
    if(d.full){ current++; continue; }
    if(d.date === today) continue;
    break;
  }
  let best = 0, run = 0;
  days.forEach(d => { if(d.full){ run++; best = Math.max(best, run); } else if(d.date !== today) run = 0; });
  best = Math.max(best, current);
  const t = days.find(d => d.date === today);
  return { current, best, today: t ? { done: t.done, total: t.total } : { done: 0, total: 0 }, days };
}

// Пн–Пт поточного тижня: 'full' | 'part' | 'none' | 'nohw' | 'future'
export function weekDots(days, today){
  const d = parse(today), dow = (d.getDay() + 6) % 7;
  const mon = shift(today, -dow);
  const by = Object.fromEntries((days || []).map(x => [x.date, x]));
  return ['Пн', 'Вт', 'Ср', 'Чт', 'Пт'].map((label, i) => {
    const date = shift(mon, i), x = by[date];
    const state = date > today ? 'future' : !x ? 'nohw' : x.full ? 'full' : x.done ? 'part' : 'none';
    return { label, date, state };
  });
}

const plural = (n, one, few, many) => { const a = n % 100, b = n % 10; return (a > 10 && a < 20) ? many : b === 1 ? one : (b >= 2 && b <= 4) ? few : many; };
export const nextMilestone = n => MILESTONES.find(m => m > n) || null;

export function streakHtml(st, today, opts = {}){
  const who = opts.who || '';
  const dots = weekDots(st.days, today).map(d => `<span class="st-dot ${d.state}" title="${escHtml(d.label)}: ${
      { full: 'усе виконано', part: 'частково', none: 'ще не позначено', nohw: 'ДЗ не було', future: 'ще попереду' }[d.state]}"><i></i>${escHtml(d.label)}</span>`).join('');
  const nx = nextMilestone(st.current);
  const head = st.current
    ? `<span class="st-fire" aria-hidden="true">🔥</span><div><b class="st-n">${st.current}</b> <span>${plural(st.current, 'день', 'дні', 'днів')} поспіль усе ДЗ виконано${who ? ` · ${escHtml(who)}` : ''}</span></div>`
    : `<span class="st-fire off" aria-hidden="true">🔥</span><div><b class="st-n">0</b> <span>${opts.student ? 'Познач виконане ДЗ — і почнеться серія' : 'Позначайте виконане ДЗ — і почнеться серія'}</span></div>`;
  const todayLine = st.today.total
    ? (st.today.done === st.today.total ? '✓ Сьогоднішнє — усе позначено' : `Сьогодні: ${st.today.done} з ${st.today.total}`) : '';
  const sub = [todayLine, nx && st.current ? `до ${nx} ${plural(nx, 'дня', 'днів', 'днів')} — ще ${nx - st.current}` : '', st.best > st.current ? `найкраща серія: ${st.best}` : '']
    .filter(Boolean).join(' · ');
  return `<div class="st-top">${head}</div>
    <div class="st-week" aria-label="Цей тиждень">${dots}</div>
    ${sub ? `<p class="st-sub">${escHtml(sub)}</p>` : ''}
    <details class="ui-how"><summary>ℹ️ Як рахується</summary><p>День зараховується, коли все ДЗ, задане цього дня, позначене виконаним
      (кнопка «○ Позначити виконаним» на вкладці «ДЗ»). Дні без ДЗ серію не переривають. Пропуски через хворобу на серію не впливають.</p></details>`;
}

// ── ДАНІ Й МАЛЮВАННЯ ─────────────────────────────────────────────
const range = (p, from) => get(query(child(ref(db), p), orderByKey(), startAt(from))).then(s => s.exists() ? s.val() : {});
let seq = 0;
export async function renderStreaks(){
  const u = currentUserData; if(!u) return;
  const prefix = u.role === 'student' ? 's' : u.role === 'parent' ? 'p' : '';
  const box = prefix && document.getElementById(`${prefix}-streak`);
  if(!box) return;
  const cls = getActiveClass(), sid = stuId(cls, u.studentName) || u.studentId || u.studentName || '';
  if(!cls || !sid){ box.hidden = true; return; }
  const my = ++seq, today = ymd(new Date()), from = shift(today, -LOOKBACK_DAYS);
  let hw, done;
  try{ [hw, done] = await Promise.all([range(`homeworks/${cls}`, from), range(`student_hw_done/${cls}/${sid}`, from)]); }
  catch(e){ box.hidden = true; return; }          // правила ще не опубліковані
  if(my !== seq) return;
  const st = computeStreak(hw, done, today);
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
