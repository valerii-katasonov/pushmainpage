// ═══════════════════════════════════════════════════════════════
// ui-search.js — швидкий пошук по порталу (підхід 7). Ctrl+K / ⌘K / «/».
//
// ЩО ШУКАЄ
//   • Розділи — вкладки відкритого кабінету («Журнал», «Оцінки», «Їжа»…).
//   • Дії — видимі кнопки швидких дій кабінету (.qa-btn): «Контрольні»,
//     «Коментарі учням», «Статистика класу»…
//   • Учні — лише для вчителів і адміністрації: усі учні класів зі списку
//     класів учителя; вибір відкриває картку учня 360°.
// Нічого не дублюємо: розділ — це натискання тієї самої вкладки, дія —
// тієї самої кнопки. Тому пошук не може «знати більше», ніж кабінет.
//
// Учнів читаємо лише при першому відкритті пошуку (students_list класів
// учителя — ті самі дані, що й у журналі) і тримаємо до перезавантаження.
// ═══════════════════════════════════════════════════════════════
import { getStudentDir, currentUserData, isTeacherRole, escHtml } from './common.js';

// Нормалізація: регістр, апострофи (ʼ ' ’), ё/е, зайві пробіли
export function norm(s){
  return String(s || '').toLowerCase().replace(/[ʼ'’`]/g, '').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}
// Оцінка збігу: кожне слово запиту має бути в тексті. Початок слова — краще.
export function score(text, q){
  const t = norm(text), words = norm(q).split(' ').filter(Boolean);
  if(!words.length) return 0;
  let s = 0;
  for(const w of words){
    const i = t.indexOf(w);
    if(i < 0) return 0;
    s += (i === 0 ? 30 : (t[i - 1] === ' ' || t[i - 1] === '-') ? 20 : 5) + Math.min(w.length, 10);
  }
  return s;
}
export function rank(items, q, limit = 8){
  return items.map(it => ({ it, s: score(it.text, q) }))
    .filter(x => x.s > 0).sort((a, b) => b.s - a.s || a.it.text.localeCompare(b.it.text, 'uk'))
    .slice(0, limit).map(x => x.it);
}

const isStaff = () => !!(currentUserData && (isTeacherRole(currentUserData.role)
  || ['director', 'administrator', 'admin'].includes(currentUserData.role)));

function visibleScreen(){
  return [...document.querySelectorAll('.panel')].find(p => p.offsetParent !== null || getComputedStyle(p).display !== 'none') || null;
}
const cleanLabel = el => {
  const c = el.cloneNode(true);
  c.querySelectorAll('.chat-dot,.dtab-badge,.ui-bnav-dot').forEach(e => e.remove());
  return c.textContent.replace(/\s+/g, ' ').trim();
};

// Розділи й дії відкритого кабінету
export function screenItems(scr){
  if(!scr) return [];
  const out = [];
  const bar = scr.querySelector('.dtab-bar') || document.getElementById('dtab-bar');
  if(bar) bar.querySelectorAll('.dtab[data-t]').forEach(b => {
    const label = cleanLabel(b);
    if(label) out.push({ kind: 'tab', text: label, sub: 'розділ', run: () => { b.click(); window.scrollTo?.({ top: 0 }); } });
  });
  scr.querySelectorAll('.qa-btn').forEach(b => {
    if(b.offsetParent === null && b.style.display === 'none') return;
    if(b.closest('[style*="display: none"],[style*="display:none"]')) return;
    const label = cleanLabel(b);
    if(label && !out.some(x => x.text === label)) out.push({ kind: 'act', text: label, sub: 'дія', run: () => b.click() });
  });
  return out;
}

let stuCache = null;
async function studentItems(){
  if(!isStaff()) return [];
  if(stuCache) return stuCache;
  const sel = document.getElementById('t-class-selector');
  const classes = sel ? [...sel.options].map(o => ({ cls: o.value, label: o.textContent.trim() })).filter(c => c.cls) : [];
  const lists = await Promise.all(classes.map(c => getStudentDir(c.cls).then(d => ({ c, d })).catch(() => null)));
  const out = [];
  lists.filter(Boolean).forEach(({ c, d }) => {
    for(const sid in (d.byId || {})){
      out.push({ kind: 'stu', text: d.byId[sid], sub: c.label, run: () => window.openStudent360 && window.openStudent360(c.cls, sid) });
    }
  });
  stuCache = out;
  return out;
}

// ── ВІКНО ────────────────────────────────────────────────────────
let wrap = null, results = [], sel = 0, loadingStudents = false;
const KIND = { tab: 'Розділи', act: 'Дії', stu: 'Учні' };

function ensureUi(){
  if(wrap) return wrap;
  wrap = document.createElement('div');
  wrap.className = 'ui-cmd-wrap'; wrap.hidden = true;
  wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true'); wrap.setAttribute('aria-label', 'Пошук');
  wrap.innerHTML = `<div class="ui-cmd-bg"></div><div class="ui-cmd">
      <div class="ui-cmd-top"><span aria-hidden="true">🔍</span>
        <input type="search" class="ui-cmd-in" role="combobox" aria-expanded="true" aria-controls="ui-cmd-list" aria-autocomplete="list"
               placeholder="${isStaff() ? 'Учень, розділ або дія…' : 'Розділ або дія…'}" autocomplete="off" spellcheck="false">
        <button type="button" class="ui-cmd-x" aria-label="Закрити">Esc</button></div>
      <div class="ui-cmd-list" id="ui-cmd-list" role="listbox"></div>
      <div class="ui-cmd-foot">↑↓ — вибрати · Enter — відкрити · Ctrl+K — відкрити пошук будь-де</div></div>`;
  document.body.appendChild(wrap);
  const inp = wrap.querySelector('input');
  inp.addEventListener('input', () => { sel = 0; paint(); });
  inp.addEventListener('keydown', e => {
    if(e.key === 'ArrowDown'){ e.preventDefault(); sel = Math.min(sel + 1, results.length - 1); paint(false); }
    else if(e.key === 'ArrowUp'){ e.preventDefault(); sel = Math.max(sel - 1, 0); paint(false); }
    else if(e.key === 'Enter'){ e.preventDefault(); choose(sel); }
    // stopPropagation: інакше той самий Esc закрив би й шторку під пошуком
    else if(e.key === 'Escape'){ e.preventDefault(); e.stopPropagation(); closeSearch(); }
  });
  wrap.querySelector('.ui-cmd-bg').addEventListener('click', closeSearch);
  wrap.querySelector('.ui-cmd-x').addEventListener('click', closeSearch);
  wrap.querySelector('.ui-cmd-list').addEventListener('click', e => {
    const o = e.target.closest('[data-i]'); if(o) choose(Number(o.dataset.i));
  });
  return wrap;
}

let base = [];
function paint(recompute = true){
  const list = wrap.querySelector('.ui-cmd-list');
  const q = wrap.querySelector('input').value;
  if(recompute){
    if(!q.trim()){
      // Порожній запит — розділи й дії кабінету, без учнів
      results = base.filter(x => x.kind !== 'stu').slice(0, 12);
    } else {
      results = [...rank(base.filter(x => x.kind !== 'stu'), q, 6), ...rank(base.filter(x => x.kind === 'stu'), q, 8)];
    }
  }
  if(!results.length){
    list.innerHTML = `<div class="ui-cmd-empty">${loadingStudents ? 'Завантажуємо список учнів…' : 'Нічого не знайдено'}</div>`;
    return;
  }
  let html = '', prev = '';
  results.forEach((r, i) => {
    if(r.kind !== prev){ html += `<div class="ui-cmd-group" role="presentation">${KIND[r.kind]}</div>`; prev = r.kind; }
    html += `<div class="ui-cmd-opt" role="option" id="ui-cmd-o${i}" data-i="${i}" aria-selected="${i === sel}">`
      + `<span>${escHtml(r.text)}</span><small>${escHtml(r.sub || '')}</small></div>`;
  });
  list.innerHTML = html;
  wrap.querySelector('input').setAttribute('aria-activedescendant', `ui-cmd-o${sel}`);
  const cur = list.querySelector('[aria-selected="true"]');
  if(cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
}

function choose(i){
  const r = results[i]; if(!r) return;
  closeSearch();
  try{ r.run(); }catch(e){ console.warn('Пошук:', e); }
}

let returnFocus = null;
export async function openSearch(){
  ensureUi();
  returnFocus = document.activeElement;
  base = screenItems(visibleScreen());
  wrap.hidden = false;
  document.body.classList.add('ui-sheet-lock');
  const inp = wrap.querySelector('input');
  inp.value = ''; sel = 0; paint();
  setTimeout(() => inp.focus(), 30);
  if(isStaff() && !stuCache){
    loadingStudents = true;
    try{ base = base.concat(await studentItems()); }catch(e){ console.warn('Пошук учнів:', e); }
    loadingStudents = false;
    if(!wrap.hidden) paint();
  } else if(stuCache && isStaff()) base = base.concat(stuCache);
}
export function closeSearch(){
  if(!wrap || wrap.hidden) return;
  wrap.hidden = true;
  // Під пошуком може бути відкрита шторка — тоді прокрутку не відпускаємо
  if(!document.querySelector('.ui-sheet-wrap.open')) document.body.classList.remove('ui-sheet-lock');
  if(returnFocus && returnFocus.focus) returnFocus.focus();
}
window.openSearch = openSearch;
window.closeSearch = closeSearch;
// Нові учні / інший кабінет — список учнів перечитати при наступному пошуку
window.resetSearchCache = () => { stuCache = null; };
window.addEventListener('push:context', () => { stuCache = null; closeSearch(); });

document.addEventListener('keydown', e => {
  const k = (e.key || '').toLowerCase();
  // Поверх згоди при вході (.cg-back) чи редактора оцінки пошук відкрився б
  // ПІД ними — невидимий, але з фокусом і замкненою прокруткою
  const shown = el => !!el && el.style.display !== 'none' && getComputedStyle(el).display !== 'none';
  if([...document.querySelectorAll('.cg-back')].some(shown) || shown(document.getElementById('grade-editor-popup'))) return;
  const typing = (() => { const a = document.activeElement; return a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)); })();
  if((e.ctrlKey || e.metaKey) && k === 'k'){ e.preventDefault(); wrap && !wrap.hidden ? closeSearch() : openSearch(); return; }
  if(k === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey && currentUserData){ e.preventDefault(); openSearch(); }
});
