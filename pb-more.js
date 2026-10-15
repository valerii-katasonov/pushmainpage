// ═══════════════════════════════════════════════════════════════
// pb-more.js — шапка на телефоні: «🔔  ⋯» замість п'яти кнопок.
//
// На вузькому екрані в рядку з аватаркою стояли 🌐 ⟳ 🔔 🔍 ⚙️ — і
// імʼя батька стискалося до «Вал…». Тепер там лише 🔔 (лічильник
// сповіщень має бути видно одразу) і ⋯ — меню з рештою:
//   🔍 Пошук · ⟳ Оновити сторінку · 🌐 Мова · ⚙️ Профіль.
// Тап по аватарці чи імені теж відкриває профіль.
// На комп'ютері (ширше 640px) шапка лишається як була.
// ═══════════════════════════════════════════════════════════════

const NARROW = '(max-width: 640px)';
const isNarrow = () => window.matchMedia(NARROW).matches;

const ITEMS = [
  { id: 'search',  ic: '🔍', label: 'Пошук',             run: () => window.openSearch?.() },
  { id: 'reload',  ic: '⟳',  label: 'Оновити сторінку',  run: () => window.reloadPortal ? window.reloadPortal() : location.reload() },
  { id: 'lang',    ic: '🌐', label: 'Мова',              run: btn => window.I18N?.menu?.(btn), keep: true },
  { id: 'profile', ic: '⚙️', label: 'Профіль',           run: () => window.openProfileModal?.() },
];

let menu = null;

function close(){
  if(!menu) return;
  menu._off();
  menu.remove();
  menu = null;
  document.getElementById('pb-more')?.setAttribute('aria-expanded', 'false');
}

export function openMore(btn){
  if(menu){ close(); return; }
  const code = (window.I18N && window.I18N.short && window.I18N.short[window.I18N.lang]) || 'UA';
  menu = document.createElement('div');
  menu.id = 'pb-more-menu';
  menu.className = 'lang-menu pb-more-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = ITEMS.map(it =>
    `<button type="button" role="menuitem" data-act="${it.id}"><span class="pm-ic" aria-hidden="true">${it.ic}</span><span>${it.label}</span>` +
    (it.id === 'lang' ? `<span class="pm-val" data-no-i18n>${code} ›</span>` : '') + `</button>`).join('');
  document.body.appendChild(menu);
  const r = btn.getBoundingClientRect(), mw = menu.offsetWidth;
  menu.style.top = (r.bottom + window.scrollY + 6) + 'px';
  menu.style.left = (Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8)) + window.scrollX) + 'px';
  btn.setAttribute('aria-expanded', 'true');

  const items = [...menu.querySelectorAll('button')];
  menu.addEventListener('click', ev => {
    const b = ev.target.closest('[data-act]');
    if(!b) return;
    ev.stopPropagation();
    const it = ITEMS.find(x => x.id === b.dataset.act);
    close();
    // Мова відкривається своїм меню під тією ж кнопкою ⋯
    it?.run(btn);
  });
  const off = e => { if(menu && !menu.contains(e.target)) close(); };
  const key = e => {
    const i = items.indexOf(document.activeElement);
    if(e.key === 'Escape' || e.key === 'Tab'){ close(); if(e.key === 'Escape') btn.focus(); }
    else if(e.key === 'ArrowDown'){ e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if(e.key === 'ArrowUp'){ e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  };
  document.addEventListener('click', off);
  document.addEventListener('keydown', key);
  window.addEventListener('resize', close);
  menu._off = () => {
    document.removeEventListener('click', off);
    document.removeEventListener('keydown', key);
    window.removeEventListener('resize', close);
  };
  items[0].focus();
}

function init(){
  const bar = document.getElementById('profile-bar');
  const btn = document.getElementById('pb-more');
  if(!bar || !btn || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', ev => { ev.stopPropagation(); openMore(btn); });
  // Аватарка й імʼя — вхід у профіль (на телефоні ⚙️ схована в ⋯)
  const who = [document.getElementById('pb-avatar'), document.getElementById('pb-name')?.parentElement].filter(Boolean);
  who.forEach(el => {
    el.classList.add('pb-who');
    el.addEventListener('click', () => { if(isNarrow()) window.openProfileModal?.(); });
  });
}

if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
