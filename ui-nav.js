// ═══════════════════════════════════════════════════════════════
// ui-nav.js — нижня панель вкладок на телефоні (підхід 6).
//
// НАВІЩО. Сім вкладок угорі не влазять у ширину телефона: смуга
// гортається вбік, і половини розділів батько просто не бачить. Унизу —
// чотири головні розділи під великим пальцем і «Ще» зі шторкою для решти.
//
// ЯК УЛАШТОВАНО. Нічого не дублюємо: панель лише натискає ті самі кнопки
// .dtab, що й раніше (switchTab, openHwTab тощо лишаються єдиним шляхом),
// а стан — яка вкладка відкрита, де є непрочитане — читає з них через
// MutationObserver. Тому openTabByKey, сповіщення й збережена вкладка
// працюють як були. Якщо цей файл не завантажиться, лишиться верхня смуга:
// її ховає лише клас html.bnav-on, який ставить цей скрипт.
//
// ДЕ. Лише кабінети батьків і учня й лише на вузькому екрані (≤ 767 px).
// Панель і шторка «Ще» живуть прямо в <body>: у .container є
// backdrop-filter, і position:fixed усередині нього прилипав би не до
// екрана, а до контейнера.
// ═══════════════════════════════════════════════════════════════

// Персонал (10.10.2026): учителю — день, урок, ДЗ, клас; директору —
// огляд, новини, учні, контроль. Решта — у «Ще».
export const BARS = { 'director-screen': 'dtab-bar' };
export const MAIN = {
  'teacher-screen':  ['day', 'lesson', 'hwday', 'class'],
  'director-screen': ['ogl', 'news', 'uchni', 'control'],
  // «Їжа» — щоденна (замовлення обідів), «Школа» — рідше: вона в «Ще»
  'parent-screen':  ['day', 'hw', 'grades', 'meals'],
  'student-screen': ['day', 'hw', 'grades', 'study']
};
const MQ_TEXT = '(max-width: 767px)';
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Іконка й підпис беремо з самої кнопки вкладки — одне джерело назв
export function tabParts(btn){
  const ic = btn.querySelector('.dtab-icon');
  const icon = ic ? ic.textContent.trim() : '';
  const clone = btn.cloneNode(true);
  clone.querySelectorAll('.dtab-icon,.chat-dot,.dtab-badge').forEach(e => e.remove());
  return { t: btn.dataset.t, icon, label: clone.textContent.replace(/\s+/g, ' ').trim() };
}
// Чи є на кнопці позначка непрочитаного
export function hasBadge(btn){
  return !!btn.querySelector('.chat-dot.show, .dtab-badge.show');
}

const navs = {};
const mq = () => (typeof window.matchMedia === 'function' ? window.matchMedia(MQ_TEXT) : { matches: false });

function itemHtml(p, cls){
  return `<button type="button" class="${cls}" data-t="${esc(p.t)}">`
    + `<span class="ui-bnav-ic" aria-hidden="true">${esc(p.icon)}</span>`
    + `<span class="ui-bnav-l">${esc(p.label)}</span><i class="ui-bnav-dot" hidden></i></button>`;
}

export function buildNav(screenId){
  if(navs[screenId]) return navs[screenId];
  const scr = document.getElementById(screenId);
  const bar = document.getElementById(BARS[screenId] || `${screenId}-tabs`);
  if(!scr || !bar || !MAIN[screenId]) return null;
  const tabs = [...bar.querySelectorAll('.dtab[data-t]')].map(b => ({ btn: b, ...tabParts(b) }));
  const main = MAIN[screenId].map(t => tabs.find(x => x.t === t)).filter(Boolean);
  const rest = tabs.filter(x => !main.includes(x));

  const nav = document.createElement('nav');
  nav.className = 'ui-bnav'; nav.id = `${screenId}-bnav`; nav.hidden = true;
  nav.setAttribute('aria-label', 'Розділи');
  nav.innerHTML = main.map(p => itemHtml(p, 'ui-bnav-i')).join('')
    + (rest.length ? itemHtml({ t: '__more', icon: '☰', label: 'Ще' }, 'ui-bnav-i') : '');
  nav.querySelector('[data-t="__more"]')?.setAttribute('aria-haspopup', 'dialog');

  const sheet = document.createElement('div');
  sheet.className = 'ui-sheet-wrap'; sheet.id = `${screenId}-more`; sheet.hidden = true;
  sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-labelledby', `${screenId}-more-title`);
  sheet.innerHTML = `<div class="ui-sheet-bg" data-close="1"></div><div class="ui-sheet">
      <div class="ui-sheet-grab" aria-hidden="true"></div>
      <button type="button" class="ui-sheet-x" data-close="1" aria-label="Закрити">✕</button>
      <h4 id="${screenId}-more-title">Інші розділи</h4>
      <div class="ui-more-list">${rest.map(p => itemHtml(p, 'ui-more-i')).join('')}</div></div>`;

  nav.addEventListener('click', e => {
    const b = e.target.closest('button[data-t]'); if(!b) return;
    if(b.dataset.t === '__more'){ window.openSheet ? window.openSheet(sheet.id) : null; return; }
    goTab(screenId, b.dataset.t);
  });
  sheet.addEventListener('click', e => {
    if(e.target.closest('[data-close]')){ window.closeSheet && window.closeSheet(sheet.id); return; }
    const b = e.target.closest('button[data-t]'); if(!b) return;
    window.closeSheet && window.closeSheet(sheet.id);
    goTab(screenId, b.dataset.t);
  });
  document.body.appendChild(nav);
  document.body.appendChild(sheet);

  const n = navs[screenId] = { scr, bar, nav, sheet, main: main.map(x => x.t), rest: rest.map(x => x.t) };
  if(typeof MutationObserver === 'function'){
    const mo = new MutationObserver(() => syncNav(screenId));
    mo.observe(bar, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style'] });
    mo.observe(scr, { attributes: true, attributeFilter: ['class', 'style'] });
    n.mo = mo;
  }
  syncNav(screenId);
  return n;
}

export function goTab(screenId, t){
  const n = navs[screenId]; if(!n) return;
  const b = n.bar.querySelector(`.dtab[data-t="${t}"]`);
  if(!b) return;
  b.click();                                   // той самий шлях, що й раніше
  try{ window.scrollTo({ top: 0, behavior: 'instant' }); }catch(e){ try{ window.scrollTo(0, 0); }catch(_){} }
}

function screenVisible(scr){
  if(!scr) return false;
  const cs = window.getComputedStyle ? window.getComputedStyle(scr) : null;
  return !!cs && cs.display !== 'none' && cs.visibility !== 'hidden';
}

export function syncNav(screenId){
  const n = navs[screenId]; if(!n) return;
  n.nav.hidden = !(mq().matches && screenVisible(n.scr));
  const on = n.bar.querySelector('.dtab.on');
  const cur = on ? on.dataset.t : '';
  const badges = {};
  n.bar.querySelectorAll('.dtab[data-t]').forEach(b => { badges[b.dataset.t] = hasBadge(b); });
  n.nav.querySelectorAll('button[data-t]').forEach(b => {
    const t = b.dataset.t;
    const isCur = t === '__more' ? n.rest.includes(cur) : t === cur;
    if(isCur) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    const dot = b.querySelector('.ui-bnav-dot');
    if(dot) dot.hidden = !(t === '__more' ? n.rest.some(r => badges[r]) : badges[t]);
  });
  // У «Ще» підпис кнопки — назва відкритого розділу: видно, де ти зараз
  const more = n.nav.querySelector('[data-t="__more"]');
  if(more){
    const curBtn = n.rest.includes(cur) && n.bar.querySelector(`.dtab[data-t="${cur}"]`);
    const p = curBtn ? tabParts(curBtn) : { icon: '☰', label: 'Ще' };
    more.querySelector('.ui-bnav-ic').textContent = p.icon || '☰';
    more.querySelector('.ui-bnav-l').textContent = p.label;
  }
  n.sheet.querySelectorAll('button[data-t]').forEach(b => {
    if(b.dataset.t === cur) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    const dot = b.querySelector('.ui-bnav-dot'); if(dot) dot.hidden = !badges[b.dataset.t];
  });
  const anyOn = Object.values(navs).some(x => !x.nav.hidden);
  document.documentElement.classList.toggle('bnav-on', anyOn);
}
export function syncAll(){ Object.keys(navs).forEach(syncNav); }

export function initNav(){
  Object.keys(MAIN).forEach(buildNav);
  const m = mq();
  if(m.addEventListener) m.addEventListener('change', syncAll);
  else if(m.addListener) m.addListener(syncAll);
  window.addEventListener('resize', syncAll);
}
window.syncBottomNav = syncAll;
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initNav); else initNav();
