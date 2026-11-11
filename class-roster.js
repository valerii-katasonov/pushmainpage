// ═══════════════════════════════════════════════════════════════
// class-roster.js — 👦 «Учні» у вкладці «Клас» учителя: спершу учень,
// потім дія.
//
// ЩО БУЛО. Три окремі форми — коментар, наліпка, поведінка — і в кожній
// учня обирали заново зі списку. Щоб дати наліпку й написати коментар
// тій самій дитині, її шукали двічі.
//
// ЯК ТЕПЕР. Список класу; натиснули ім'я — вікно учня: «👤 Усе про учня»
// (картка 360°) і три дії перемикачем. Форми ті самі (teacher.js:
// saveComment, giveStickerToStudent, saveBehaviorGrade) — лише живуть у
// вікні, а поле «Учень» у них заповнюється саме й сховане.
//
// ЗВІДКИ СПИСОК. Нічого не читаємо з бази: беремо опції поля «Учень»,
// які вже наповнює loadStudentsList (teacher.js) при зміні класу. Поруч
// з іменем — позначка відсутності за день з поля відвідуваності
// (annotateAbsentSelect: «⛔ увесь день», «⏰ запізнення…»).
// ═══════════════════════════════════════════════════════════════
import { getActiveClass } from './common.js';
import { setPickedDate, mountDatePicks } from './date-pick.js';

let cur = { sid: '', name: '' };
let tab = 'comment';
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const norm = s => String(s || '').toLowerCase().replace(/[ʼ'’`]/g, '');

// [{sid, name, mark}] з поля «Учень» (+ позначки з поля відвідуваності)
export function rosterFrom(selectEl, absentSel){
  const marks = {};
  [...((absentSel && absentSel.options) || [])].forEach(o => {
    const m = /\s—\s(.+)$/.exec(o.textContent || '');
    if(o.value && m) marks[o.value] = m[1];
  });
  return [...((selectEl && selectEl.options) || [])].filter(o => o.value)
    .map(o => ({ sid: o.value, name: (o.textContent || '').trim(), mark: marks[o.value] || '' }));
}

export function renderClassRoster(){
  const list = document.getElementById('ts-list');
  if(!list) return;
  const all = rosterFrom(document.getElementById('t-student'), document.getElementById('t-mark-absent-student'));
  const q = norm(document.getElementById('ts-filter')?.value);
  const rows = q ? all.filter(r => norm(r.name).includes(q)) : all;
  if(!all.length){ list.innerHTML = '<li class="empty-msg">У класі ще немає учнів.</li>'; return; }
  if(!rows.length){ list.innerHTML = '<li class="empty-msg">Нікого не знайдено.</li>'; return; }
  list.innerHTML = rows.map(r => `<li><button type="button" class="ts-row" data-sid="${esc(r.sid)}">
      <span class="ts-n">${all.indexOf(r) + 1}</span><span class="ts-nm">${esc(r.name)}</span>
      ${r.mark ? `<span class="ts-mark">${esc(r.mark)}</span>` : ''}<span class="ts-go" aria-hidden="true">›</span></button></li>`).join('');
}
window.renderClassRoster = renderClassRoster;

// Клік по рядку — через делегування: імена можуть містити апострофи
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('#ts-list .ts-row');
  if(b) window.openStudentSheet(b.dataset.sid);
});

window.tsTab = function(t){
  tab = ['comment', 'sticker', 'behavior'].includes(t) ? t : 'comment';
  document.querySelectorAll('#t-stu-sheet [data-ts]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.ts === tab)));
  document.querySelectorAll('#t-stu-sheet [data-ts-pane]').forEach(p => { p.hidden = p.dataset.tsPane !== tab; });
  const focus = { comment: 't-comment', sticker: 't-sticker-count', behavior: 't-behavior-grade' }[tab];
  setTimeout(() => { const el = document.getElementById(focus); if(el) try{ el.focus({ preventScroll: true }); }catch(e){} }, 60);
};

// Відкрити вікно учня. Поле «Учень» у всіх трьох формах — цей учень.
window.openStudentSheet = function(sid, which){
  const sel = document.getElementById('t-student');
  const opt = sel && [...sel.options].find(o => o.value === sid);
  if(!opt) return;
  cur = { sid, name: opt.textContent.trim() };
  ['t-student', 't-sticker-student', 't-behavior-student'].forEach(id => {
    const el = document.getElementById(id);
    if(el && [...el.options].some(o => o.value === sid)) el.value = sid;
  });
  document.getElementById('ts-name').textContent = cur.name;
  const cls = getActiveClass();
  document.getElementById('ts-sub').textContent = cls ? `${String(cls).replace('class_', '')} клас` : '';
  // Предмети для коментаря й наліпки — з каталогу класу. Обране раніше
  // зберігається (refreshClassTabPickers тримає поточне значення)
  if(window.refreshClassTabPickers) window.refreshClassTabPickers();
  // Дата запису — своя у вікна учня; кожне відкриття починає з сьогодні
  const sheet = document.getElementById('t-stu-sheet');
  setPickedDate('stu', '', {silent:true});
  mountDatePicks(sheet);
  sheet.style.display = 'flex';
  window.tsTab(which || tab);
};
window.closeStudentSheet = function(){ const m = document.getElementById('t-stu-sheet'); if(m) m.style.display = 'none'; };
// «Усі коментарі учня» — вікно коментарів, відфільтроване на цього учня.
// Вікно учня спершу закриваємо: інакше коментарі відкривалися ПІД ним.
window.tsOpenComments = function(){
  const cls = getActiveClass();
  window.closeStudentSheet();
  if(window.openCommentsView) window.openCommentsView({ cls, sid: cur.sid });
};
window.tsOpen360 = function(){
  const cls = getActiveClass();
  if(!cur.sid || !cls || !window.openStudent360) return;
  window.closeStudentSheet();
  window.openStudent360(cls, cur.sid);
};

function boot(){
  const sheet = document.getElementById('t-stu-sheet');
  if(sheet) sheet.addEventListener('click', e => { if(e.target === sheet) window.closeStudentSheet(); });
  // Список класу міняється разом із полем «Учень» (зміна класу) і з поміткою
  // відсутності (відвідуваність за день) — перемальовуємо слідом
  const mo = new MutationObserver(() => renderClassRoster());
  ['t-student', 't-mark-absent-student'].forEach(id => {
    const el = document.getElementById(id);
    if(el) mo.observe(el, { childList: true, subtree: true, characterData: true });
  });
  renderClassRoster();
}
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
