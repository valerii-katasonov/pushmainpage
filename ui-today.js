// ═══════════════════════════════════════════════════════════════
// ui-today.js — вкладка «Сьогодні» на єдиних компонентах (підхід 5).
//
// ЩО ТУТ
//   • Блок «Зараз»: який урок іде, скільки до кінця, що далі. Його малює
//     renderDynamicSchedule (parent-student.js) — передає сюди готовий
//     список уроків, а тут лише рахуємо стан і робимо розмітку.
//   • Плитки «що нового»: ДЗ, задане в обраний день; оцінки й коментарі
//     за останні 7 днів. Кожна плитка веде у свою вкладку.
//   • Шторка знизу (openSheet/closeSheet): форма запізнення відкривається
//     нею, а не висить на екрані щодня. Поля й кнопка — ті самі, що й
//     раніше (p-att-type, p-att-reason, submitAttendance), тож логіка
//     відправки не змінилася.
//
// ДАНІ ПЛИТОК — лише з дзеркал своєї дитини (student_grades,
// student_comments) і з homeworks класу. Вузли класу родині закриті.
// ═══════════════════════════════════════════════════════════════
import { ref, get, child } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, currentUserData, escHtml, showToast } from './common.js';

const pad = n => String(n).padStart(2, '0');
const hhmm = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const minsWord = n => {
  const a = Math.abs(n) % 100, b = a % 10;
  if(a > 10 && a < 20) return 'хвилин';
  if(b === 1) return 'хвилина';
  if(b >= 2 && b <= 4) return 'хвилини';
  return 'хвилин';
};

// ── ЧИСТА ЛОГІКА ─────────────────────────────────────────────────
// items: уроки дня [{subj, start, end, num, classHour}] — лише з часом,
// по порядку. mins — хвилини від півночі. Повертає, що зараз:
//   {kind:'lesson', cur, next, progress, left}
//   {kind:'break',  next, left}          — між уроками
//   {kind:'before', next, left, count}   — до першого уроку
//   {kind:'over'}                        — уроки скінчилися
//   null                                 — уроків із часом немає
export function nowState(items, mins){
  const list = (items || []).filter(l => l && l.start != null && l.end != null)
    .sort((a, b) => a.start - b.start);
  if(!list.length) return null;
  const i = list.findIndex(l => mins >= l.start && mins < l.end);
  if(i >= 0){
    const cur = list[i];
    return { kind: 'lesson', cur, next: list[i + 1] || null,
      progress: Math.round((mins - cur.start) / ((cur.end - cur.start) || 1) * 100),
      left: cur.end - mins };
  }
  if(mins < list[0].start) return { kind: 'before', next: list[0], left: list[0].start - mins, count: list.length };
  const n = list.find(l => l.start > mins);
  if(n) return { kind: 'break', next: n, left: n.start - mins };
  return { kind: 'over' };
}

const lessonName = l => l.classHour ? 'Класна година' : l.subj;
const lessonNo = l => l.classHour ? '' : (l.num ? `${l.num}-й урок` : '');

// st — результат nowState; opts.nextDay {label, first} — коли сьогодні
// уроків уже немає, показуємо перший урок наступного навчального дня.
export function nowCardHtml(st, opts = {}){
  const nd = opts.nextDay;
  if((!st || st.kind === 'over') && nd && nd.first){
    return `<div class="ui-now ui-now-calm">
      <small>${escHtml(st && st.kind === 'over' ? 'Уроки на сьогодні закінчилися' : 'Сьогодні уроків немає')}</small>
      <div class="ui-now-l">${escHtml(nd.label)}: ${escHtml(lessonName(nd.first))}</div>
      <div class="ui-now-m">перший урок о ${hhmm(nd.first.start)}${nd.count ? ` · усього ${nd.count}` : ''}</div>
    </div>`;
  }
  if(!st || st.kind === 'over') return '';
  if(st.kind === 'lesson'){
    const c = st.cur, n = st.next;
    const head = ['Зараз', lessonNo(c)].filter(Boolean).join(' · ');
    return `<div class="ui-now" role="status">
      <small>${escHtml(head)}</small>
      <div class="ui-now-l">${escHtml(lessonName(c))}${c.sub ? ' <span class="ui-chip ui-chip-on">заміна</span>' : ''}</div>
      <div class="ui-now-m">${hhmm(c.start)}–${hhmm(c.end)}${c.sub ? ` · ${escHtml(c.sub)}` : ''} · ще ${st.left} ${minsWord(st.left)}</div>
      <div class="ui-now-bar" aria-hidden="true"><i style="width:${Math.max(0, Math.min(100, st.progress))}%"></i></div>
      <div class="ui-now-next">${n ? `Далі: ${escHtml(lessonName(n))} о ${hhmm(n.start)}` : 'Це останній урок сьогодні'}</div>
    </div>`;
  }
  const n = st.next;
  const head = st.kind === 'break' ? 'Зараз перерва' : 'Сьогодні';
  const line = st.kind === 'break'
    ? `Далі: ${lessonName(n)}`
    : `Перший урок: ${lessonName(n)}`;
  const meta = st.kind === 'break'
    ? `о ${hhmm(n.start)} · ще ${st.left} ${minsWord(st.left)}`
    : `о ${hhmm(n.start)}${st.count ? ` · усього уроків: ${st.count}` : ''}`;
  return `<div class="ui-now${st.kind === 'before' ? ' ui-now-calm' : ''}" role="status">
    <small>${escHtml(head)}</small>
    <div class="ui-now-l">${escHtml(line)}</div>
    <div class="ui-now-m">${escHtml(meta)}</div>
  </div>`;
}

export function renderNowCard(prefix, items, mins, opts){
  const el = document.getElementById(`${prefix}-now`);
  if(!el) return;
  const o = opts || {};
  // Коли показуємо наступний день, стан «сьогодні» вже відомий викликачу:
  // уроки або скінчилися (over), або їх не було зовсім.
  const st = o.nextDay ? (o.over ? { kind: 'over' } : null) : nowState(items, mins);
  const html = nowCardHtml(st, o);
  el.innerHTML = html;
  el.style.display = html ? '' : 'none';
}

// Дата N днів тому від YYYY-MM-DD (локально, без зсуву поясу)
export function daysBefore(date, n){
  const [y, m, d] = String(date).split('-').map(Number);
  const t = new Date(y, m - 1, d - n);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}
// Дзеркало оцінок {місяць: {предмет: {дата: {v,t}}}} → скільки оцінок за [from..to]
export function countGrades(mirror, from, to){
  let n = 0;
  for(const m in (mirror || {})) for(const s in (mirror[m] || {})) for(const k in (mirror[m][s] || {})){
    const d = String(k).slice(0, 10);
    const c = mirror[m][s][k];
    if(d >= from && d <= to && c != null && (typeof c !== 'object' || (c.v != null && c.v !== ''))) n++;
  }
  return n;
}
// Коментарі {дата: {предмет: {t, r}}} → {n, unanswered}
export function countComments(mirror, from, to){
  let n = 0, unanswered = 0;
  for(const d in (mirror || {})){
    const day = String(d).slice(0, 10);
    if(day < from || day > to) continue;
    for(const s in (mirror[d] || {})){
      const c = mirror[d][s];
      if(!c || !(typeof c === 'string' ? c : c.t)) continue;
      n++;
      if(!(c && typeof c === 'object' && c.r)) unanswered++;
    }
  }
  return { n, unanswered };
}
export function countHomework(day){
  let n = 0;
  for(const s in (day || {})){
    const v = day[s];
    const txt = typeof v === 'string' ? v : (v && (v.text || (v.trainers && 'т') || (v.files && 'ф')));
    if(txt && String(txt).trim()) n++;
  }
  return n;
}
const plural = (n, one, few, many) => {
  const a = n % 100, b = n % 10;
  if(a > 10 && a < 20) return many;
  return b === 1 ? one : (b >= 2 && b <= 4 ? few : many);
};
export function tilesHtml({ hw, grades, comments }, prefix = 'p'){
  const tile = (cls, val, label, tab, title) =>
    `<button type="button" class="ui-tile ${cls}" onclick="goTodayTab('${prefix}','${tab}')" title="${escHtml(title)}">`
    + `<b>${val == null ? '—' : val}</b><span>${escHtml(label)}</span></button>`;
  const c = comments || { n: 0, unanswered: 0 };
  return tile('info', hw, hw == null ? 'ДЗ' : plural(hw, 'предмет з ДЗ', 'предмети з ДЗ', 'предметів з ДЗ'), 'hw', 'Домашнє завдання, задане в цей день')
    + tile(grades ? 'ok' : '', grades, grades == null ? 'оцінки' : plural(grades, 'оцінка за 7 днів', 'оцінки за 7 днів', 'оцінок за 7 днів'), 'grades', 'Оцінки за останній тиждень')
    + tile(c.unanswered ? 'warn' : '', comments ? c.n : null,
        comments == null ? 'коментарі' : (c.unanswered ? `${plural(c.n, 'коментар', 'коментарі', 'коментарів')}, ${c.unanswered} без реакції` : plural(c.n, 'коментар за 7 днів', 'коментарі за 7 днів', 'коментарів за 7 днів')),
        'grades', 'Коментарі вчителів за останній тиждень');
}

// ── ДАНІ ─────────────────────────────────────────────────────────
let tilesSeq = 0;
export async function renderTodayTiles(prefix, cls, sid, date){
  const el = document.getElementById(`${prefix}-tiles`);
  if(!el || !cls) return;
  const my = ++tilesSeq;
  el.innerHTML = tilesHtml({ hw: null, grades: null, comments: null }, prefix);
  el.classList.add('is-loading');
  const from = daysBefore(date, 6);
  const safe = p => get(child(ref(db), p)).then(s => s.exists() ? s.val() : {}).catch(() => null);
  const [hwDay, gm, cm] = await Promise.all([
    safe(`homeworks/${cls}/${date}`),
    sid ? safe(`student_grades/${cls}/${sid}`) : Promise.resolve(null),
    sid ? safe(`student_comments/${cls}/${sid}`) : Promise.resolve(null)
  ]);
  if(my !== tilesSeq) return;             // поки читали, змінили дитину чи дату
  el.classList.remove('is-loading');
  el.innerHTML = tilesHtml({
    hw: hwDay ? countHomework(hwDay) : null,
    grades: gm ? countGrades(gm, from, date) : null,
    comments: cm ? countComments(cm, from, date) : null
  }, prefix);
}

// ── ВЗАЄМОДІЯ ────────────────────────────────────────────────────
window.goTodayTab = function(prefix, tab){
  const screen = prefix === 's' ? 'student-screen' : 'parent-screen';
  const btn = document.querySelector(`#${screen}-tabs [data-t="${tab}"]`);
  if(btn) btn.click();
  // Оцінки й коментарі за тиждень — у панелі «Тиждень». Запамʼятована
  // панель могла бути «Предмет» чи «Огляд», де їх не видно.
  if(tab === 'grades') grPane(prefix, 'week');
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

let sheetReturn = null;
export function openSheet(id){
  const w = document.getElementById(id);
  if(!w) return;
  sheetReturn = document.activeElement;
  // Шторка має бути прямо в <body>: у .container є backdrop-filter, а
  // такий предок робить position:fixed відносним до себе — і шторка
  // опинялася внизу всієї сторінки, а не внизу екрана.
  if(w.parentElement !== document.body) document.body.appendChild(w);
  // Відкрили знову, поки ще не доїхала анімація закриття, — скасовуємо
  // відкладене «сховати», інакше шторка зникла б із замкненою прокруткою
  clearTimeout(w._hideTimer);
  w.hidden = false;
  requestAnimationFrame(() => w.classList.add('open'));
  document.body.classList.add('ui-sheet-lock');
  const f = w.querySelector('textarea,select,input,button:not(.ui-sheet-x)');
  if(f) setTimeout(() => f.focus(), 60);
}
export function closeSheet(id){
  const list = id ? [document.getElementById(id)] : [...document.querySelectorAll('.ui-sheet-wrap.open')];
  list.filter(Boolean).forEach(w => {
    w.classList.remove('open');
    clearTimeout(w._hideTimer);
    w._hideTimer = setTimeout(() => { if(!w.classList.contains('open')) w.hidden = true; }, 200);
  });
  // Прокрутку відпускаємо, лише коли не лишилося жодної відкритої шторки й пошуку
  const cmd = document.querySelector('.ui-cmd-wrap');
  if(!document.querySelector('.ui-sheet-wrap.open') && !(cmd && !cmd.hidden)) document.body.classList.remove('ui-sheet-lock');
  if(sheetReturn && sheetReturn.focus) sheetReturn.focus();
  sheetReturn = null;
}
window.openSheet = openSheet;
window.closeSheet = closeSheet;
document.addEventListener('keydown', e => { if(e.key === 'Escape' && document.querySelector('.ui-sheet-wrap.open')) closeSheet(); });

// Запізнення / відсутність: та сама форма, лише відкривається шторкою.
// prefix 'p' — батьки (про дитину), 's' — учень (про себе).
window.openAttSheet = function(type, prefix = 'p'){
  const t = document.getElementById(`${prefix}-att-type`);
  if(t){ t.value = type === 'absent' ? 'absent' : 'late'; if(window.fillAttReasons) window.fillAttReasons(prefix); }
  const h = document.getElementById(`${prefix}-att-sheet-title`);
  if(h){
    if(prefix === 's') h.textContent = type === 'absent' ? 'Я не прийду' : 'Я запізнююсь';
    else {
      const first = String((currentUserData && currentUserData.studentName) || '').trim().split(/\s+/).pop() || 'Дитина';
      h.textContent = type === 'absent' ? `${first} не прийде` : `${first} запізнюється`;
    }
  }
  openSheet(`${prefix}-att-sheet`);
};
window.sendAttFromSheet = async function(btn, prefix = 'p'){
  if(btn){ btn.disabled = true; btn.textContent = 'Надсилаємо…'; }
  let sent = false;
  try{ sent = await window.submitAttendance(prefix === 's' ? 'student' : 'parent'); }
  finally{ if(btn){ btn.disabled = false; btn.textContent = 'Повідомити вчителів'; } }
  // Лише явний успіх. Раніше дивилися, чи видно статус, — а він міг
  // лишитися від ранкового повідомлення, і невдала спроба закривала
  // шторку з «✅».
  if(sent === true){
    closeSheet(`${prefix}-att-sheet`);
    if(showToast) showToast(prefix === 's' ? '✅ Учитель бачить твоє повідомлення' : '✅ Школа бачить ваше повідомлення');
  }
};

// ── «ОЦІНКИ»: перемикач Тиждень · Предмет · Огляд ───────────────
// Перемикає вкладені панелі однієї секції. Вибір пам'ятаємо на цьому
// пристрої — батько, який завжди дивиться «Огляд», не клацатиме щоразу.
const GR_KEY = 'push_gr_pane';
export function grPane(prefix, pane){
  const seg = document.getElementById(`${prefix}-gr-seg`);
  if(!seg) return false;
  const sec = seg.parentElement;
  const panes = [...sec.querySelectorAll(':scope > .ui-pane')];
  if(!panes.some(p => p.dataset.pane === pane)) pane = 'week';
  panes.forEach(p => { p.hidden = p.dataset.pane !== pane; });
  seg.querySelectorAll('[data-pane]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.pane === pane)));
  try{ localStorage.setItem(GR_KEY, pane); }catch(e){}
  return true;
}
window.grPane = grPane;
function restoreGrPane(){
  let v = '';
  try{ v = localStorage.getItem(GR_KEY) || ''; }catch(e){}
  if(v) ['p', 's'].forEach(px => grPane(px, v));
}
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', restoreGrPane); else restoreGrPane();

// Назва предмета в «Тижні» чи в «Динаміці» → «Предмет» з цим предметом
window.gvOpenSubject = function(subj){
  if(!subj) return;
  const prefix = currentUserData && currentUserData.role === 'student' ? 's' : 'p';
  grPane(prefix, 'subject');
  if(window.renderGradesSubject) window.renderGradesSubject(subj);
  const box = document.getElementById(`${prefix}-grades-subject`);
  const seg = document.getElementById(`${prefix}-gr-seg`);
  const target = seg || box;
  if(target && target.scrollIntoView){ try{ target.scrollIntoView({ behavior: 'smooth', block: 'start' }); }catch(e){ target.scrollIntoView(); } }
};

window.renderNowCard = renderNowCard;
window.renderTodayTiles = renderTodayTiles;
