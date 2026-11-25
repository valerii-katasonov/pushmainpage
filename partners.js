// ═══════════════════════════════════════════════════════════════
// partners.js — 🤝 ПАРТНЕРИ ШКОЛИ й PUSH School Card
//
// ХТО БАЧИТЬ
//   • батьки — знижки для батьків і для дітей (платять же батьки);
//   • учні — знижки для учнів;
//   • персонал (учителі й інші працівники) — знижки для персоналу.
//   Партнер, у якого для людини немає жодної чинної пропозиції, їй не
//   показується. Пропозиції з минулим терміном зникають самі.
//
// КАТЕГОРІЇ (partner_cats) — директор додає свої, перейменовує, ховає й
// упорядковує. Поки вузла немає, діють стандартні (DEFAULT_CATS). Порожні
// категорії людям не показуємо.
//
// КАРТКА — особиста, видає її сервер (netlify/functions/partner-card.js):
// номер, повне імʼя, групи, термін. На екрані — «жива»: іде годинник і
// переливається фон, тож скріншот не видати за справжню. Партнер може
// перевірити номер на push.school/card (card.html → card-check.js): побачить
// лише «Марія К.», групу й термін.
//
// ДИРЕКТОР — «Налаштування» → «🤝 Партнери школи»: партнери, послуги
// (для кого, до коли), логотип, «рекомендуємо», «сховати», категорії.
// ═══════════════════════════════════════════════════════════════
import { ref, get, set, remove, update } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, auth, currentUserData, showToast, escHtml, uploadToCloudinary, cldImage } from './common.js';

export const DAY = 86400000;
export const DEFAULT_CATS = {
  sport:   { name: 'Гуртки й спорт',      icon: '🎨', order: 1 },
  study:   { name: 'Навчання',            icon: '📚', order: 2 },
  health:  { name: 'Здоровʼя',            icon: '🩺', order: 3 },
  party:   { name: 'Свята й смаколики',   icon: '🎂', order: 4 },
  leisure: { name: 'Дозвілля й табори',   icon: '🎢', order: 5 },
  shop:    { name: 'Покупки',             icon: '🛍️', order: 6 },
  parents: { name: 'Для батьків',         icon: '🧾', order: 7 },
  staff:   { name: 'Для персоналу',       icon: '💼', order: 8 }
};
export const WHO = { student: 'Учні', parent: 'Батьки', staff: 'Персонал' };
export const COLORS = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'];

// ── Чисті функції (tests-partners.mjs) ──
export function viewerGroups(role){
  if(role === 'parent') return ['parent', 'student'];
  if(role === 'student') return ['student'];
  return role ? ['staff'] : [];
}
export const warsawToday = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(d);
export function liveOffers(p, groups, day){
  return Object.entries((p && p.offers) || {})
    .filter(([, o]) => o && typeof o === 'object' && (!o.until || o.until >= day))
    .filter(([, o]) => groups.some(g => o.who && o.who[g]))
    .map(([id, o]) => ({ id, ...o }));
}
export const isNew = (p, now) => !!p.createdAt && now - p.createdAt < 30 * DAY;
export function visiblePartners(partners, groups, day, now){
  return Object.entries(partners || {})
    .filter(([, p]) => p && typeof p === 'object' && !p.hidden)
    .map(([id, p]) => ({ id, ...p, live: liveOffers(p, groups, day) }))
    .filter(p => p.live.length)
    .sort((a, b) => (!!b.recommended - !!a.recommended) || (isNew(b, now) - isNew(a, now)) || String(a.name).localeCompare(String(b.name), 'uk'));
}
export function catList(cats){
  return Object.entries(cats || {}).filter(([, c]) => c && c.name)
    .map(([id, c]) => ({ id, name: c.name, icon: c.icon || '', order: Number(c.order) || 0, hidden: !!c.hidden }))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'uk'));
}
export function chips(cats, list, now){
  const by = {}; list.forEach(p => { by[p.cat] = (by[p.cat] || 0) + 1; });
  const out = [{ id: 'all', name: 'Усі', count: list.length }];
  const rec = list.filter(p => p.recommended).length, fresh = list.filter(p => isNew(p, now)).length;
  if(rec) out.push({ id: 'rec', name: '⭐ Рекомендуємо', count: rec });
  if(fresh) out.push({ id: 'new', name: '🆕 Нові', count: fresh });
  catList(cats).filter(c => !c.hidden && by[c.id]).forEach(c => out.push({ id: 'c:' + c.id, name: `${c.icon} ${c.name}`.trim(), count: by[c.id] }));
  return out;
}
export function filterBy(list, chip, now){
  if(chip === 'rec') return list.filter(p => p.recommended);
  if(chip === 'new') return list.filter(p => isNew(p, now));
  if(chip && chip.startsWith('c:')) return list.filter(p => p.cat === chip.slice(2));
  return list;
}
export const safeUrl = u => /^https?:\/\/[^\s<>"']+$/.test(String(u || '')) ? String(u) : '';
export const telHref = t => { const d = String(t || '').replace(/[^\d+]/g, ''); return d.length >= 6 ? 'tel:' + d : ''; };
export const mapHref = a => a ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(a) : '';
const human = d => String(d || '').split('-').reverse().join('.');
const initial = n => (String(n || '?').trim()[0] || '?').toUpperCase();

// ── Дані ──
const val = async path => { const s = await get(ref(db, path)); return s.exists() ? s.val() : null; };
async function loadAll(){
  const [cats, partners] = await Promise.all([val('partner_cats').catch(() => null), val('partners').catch(() => null)]);
  return { cats: cats || DEFAULT_CATS, catsStored: !!cats, partners: partners || {} };
}
function tileHtml(p, cls = ''){
  const logo = p.logo ? cldImage(p.logo, 'w_160,h_160,c_fill') : '';
  return logo ? `<span class="pt-tile ${cls}"><img src="${escHtml(logo)}" alt="" loading="lazy"></span>`
              : `<span class="pt-tile ${COLORS.includes(p.color) ? p.color : 'c0'} ${cls}" aria-hidden="true">${escHtml(initial(p.name))}</span>`;
}

// ═══════════ ВКЛАДКА «ПАРТНЕРИ» ═══════════
const state = { chip: 'all', data: null, prefix: '' };
window.openPartnersTab = async function(prefix){
  const box = document.getElementById(`${prefix}-partners`); if(!box) return;
  state.prefix = prefix;
  return renderInto(box);
};
async function renderInto(box){
  if(!box.innerHTML.trim()) box.innerHTML = '<p class="empty-msg is-loading">Завантаження...</p>';
  try{ state.data = await loadAll(); }catch(e){ box.innerHTML = '<p class="empty-msg">Не вдалося завантажити партнерів.</p>'; return; }
  paintTab(box);
  box.onclick = onTabClick;
}
// Кабінети без вкладок (директор, адміністратор, кухня, ролі з конструктора):
// той самий список і картка — у вікні на весь екран, кнопкою «🤝 Партнери й моя картка»
window.openPartnersSheet = async function(){
  const { ov } = overlay('pt-full pt-ov pt-ov-full', 'Партнери школи');
  ov.innerHTML = `<div class="pt-sheet pt-sheet-full">
    <div class="pt-full-h"><h3>🤝 Партнери школи</h3><button type="button" class="pt-x" data-a="close" aria-label="Закрити">✕</button></div>
    <div class="pt-box"></div></div>`;
  ov.querySelector('.pt-x').focus();
  await renderInto(ov.querySelector('.pt-box'));
};
function paintTab(box){
  const now = Date.now(), groups = viewerGroups(currentUserData && currentUserData.role);
  const list = visiblePartners(state.data.partners, groups, warsawToday(), now);
  const ch = chips(state.data.cats, list, now);
  if(!ch.some(c => c.id === state.chip)) state.chip = 'all';
  const shown = filterBy(list, state.chip, now);
  const catName = id => { const c = state.data.cats[id]; return c ? `${c.icon || ''} ${c.name}`.trim() : ''; };
  box.innerHTML = `
    <button type="button" class="pt-mycard" data-a="card">
      <img src="/icon-192.png" alt="" class="pt-mycard-logo">
      <span><b>PUSH School Card</b><small>Покажіть партнеру — і отримайте знижку</small></span>
      <em>Показати</em>
    </button>
    ${list.length ? `<div class="pt-chips" role="group" aria-label="Категорії">${ch.map(c =>
      `<button type="button" class="pt-chip${c.id === state.chip ? ' on' : ''}" aria-pressed="${c.id === state.chip}" data-chip="${escHtml(c.id)}">${escHtml(c.name)} <i>${c.count}</i></button>`).join('')}</div>
    <div class="pt-list">${shown.map(p => `<button type="button" class="pt-row" data-pid="${escHtml(p.id)}">
      ${tileHtml(p)}
      <span class="pt-row-txt"><b>${escHtml(p.name)}</b><small>${escHtml(catName(p.cat))}${p.recommended ? ' · ⭐ рекомендуємо' : ''}${isNew(p, now) ? ' · нове' : ''}</small></span>
      <em class="pt-deal">${escHtml(p.live[0].deal)}</em>
    </button>`).join('')}</div>`
    : '<div class="pt-empty"><b>Партнерів поки немає</b><span>Школа саме домовляється про знижки — зазирніть згодом.</span></div>'}`;
}
async function onTabClick(e){
  const box = e.currentTarget;
  const c = e.target.closest('[data-chip]');
  if(c){ state.chip = c.dataset.chip; return paintTab(box); }
  if(e.target.closest('[data-a="card"]')) return openCard();
  const r = e.target.closest('[data-pid]');
  if(r) openPartner(r.dataset.pid);
}
// Немає імені в профілі — ведемо туди, де його вписати
function profileButton(){
  return typeof window.openProfileModal === 'function'
    ? '<button type="button" class="pt-show" data-a="profile">Заповнити профіль</button>' : '';
}

// ── Сторінка партнера ──
function overlay(cls, label){
  // Повторне відкриття замінює попереднє вікно того ж роду, але сторінка
  // партнера не закриває список «Партнери» (pt-full), відкритий під нею
  const first = cls.split(' ')[0];
  document.querySelectorAll('.' + first).forEach(x => { if(first === 'pt-full' || !x.classList.contains('pt-full')) x.remove(); });
  const ov = document.createElement('div');
  ov.className = cls; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-label', label);
  document.body.appendChild(ov);
  document.body.classList.add('pt-open');
  const close = () => { ov.remove(); if(!document.querySelector('.pt-ov,.pt-card-ov')) document.body.classList.remove('pt-open'); };
  ov.addEventListener('keydown', e => { if(e.key === 'Escape') close(); });
  ov.addEventListener('click', e => { if(e.target === ov || e.target.closest('[data-a="close"]')) close(); });
  return { ov, close };
}
function openPartner(id){
  const p = state.data && state.data.partners[id]; if(!p) return;
  const groups = viewerGroups(currentUserData && currentUserData.role);
  const offers = liveOffers(p, groups, warsawToday());
  const c = state.data.cats[p.cat];
  const site = safeUrl(p.site), tel = telHref(p.phone), map = mapHref(p.address);
  const { ov } = overlay('pt-ov', p.name);
  ov.innerHTML = `<div class="pt-sheet">
    <div class="pt-head ${COLORS.includes(p.color) ? p.color : 'c0'}">
      <button type="button" class="pt-x" data-a="close" aria-label="Закрити">✕</button>
      <div class="pt-head-row">${tileHtml(p, 'big')}<span><h3>${escHtml(p.name)}</h3><small>${escHtml(c ? `${c.icon || ''} ${c.name}`.trim() : '')}</small></span></div>
      ${p.about ? `<p>${escHtml(p.about)}</p>` : ''}
    </div>
    <h4 class="pt-h">ПОСЛУГИ ТА ЗНИЖКИ</h4>
    ${offers.map(o => `<div class="pt-offer">
      <div class="pt-offer-top"><b>${escHtml(o.title)}</b><em>${escHtml(o.deal)}</em></div>
      ${o.terms ? `<span class="pt-terms">${escHtml(o.terms)}</span>` : ''}
      <div class="pt-offer-meta">${Object.keys(WHO).filter(w => o.who && o.who[w]).map(w => `<span class="pt-who">${WHO[w]}</span>`).join('')}${o.until ? `<span class="pt-until">до ${escHtml(human(o.until))}</span>` : ''}</div>
    </div>`).join('')}
    <div class="pt-how"><b>Як скористатися</b><span>Покажіть PUSH School Card перед оплатою. Знижки не сумуються з іншими акціями, якщо партнер не каже інакше.</span></div>
    ${(map || tel || site) ? `<h4 class="pt-h">КОНТАКТИ</h4><div class="pt-contacts">
      ${map ? `<a href="${escHtml(map)}" target="_blank" rel="noopener"><span>📍 ${escHtml(p.address)}</span><em>На карті</em></a>` : ''}
      ${tel ? `<a href="${escHtml(tel)}"><span>📞 ${escHtml(p.phone)}</span><em>Подзвонити</em></a>` : ''}
      ${site ? `<a href="${escHtml(site)}" target="_blank" rel="noopener"><span>🌐 ${escHtml(site.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</span><em>Відкрити</em></a>` : ''}
    </div>` : ''}
    <button type="button" class="pt-show" data-a="card">Показати картку</button>
  </div>`;
  ov.querySelector('[data-a="card"]').addEventListener('click', () => openCard());
  ov.querySelector('.pt-x').focus();
}

// ═══════════ КАРТКА НА ВЕСЬ ЕКРАН ═══════════
const cardKey = () => `push_card_${(auth.currentUser && auth.currentUser.uid) || ''}`;
let clockTimer = null, wake = null;
async function fetchCard(){
  const idToken = await window.authIdToken();
  const r = await fetch('/.netlify/functions/partner-card', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) });
  const d = await r.json().catch(() => ({}));
  if(!r.ok){ const e = new Error(d.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
  try{ localStorage.setItem(cardKey(), JSON.stringify(d)); }catch(e){}
  return d;
}
// Фон картки за групою: персонал — голограма, батьки — аврора, учні — шкільний
// візерунок. Кілька груп (вчитель із дитиною в школі) — пріоритет у персоналу.
export function cardTheme(c){
  const g = (c && Array.isArray(c.groups)) ? c.groups : [];
  return g.includes('staff') ? 'holo' : g.includes('parent') ? 'aurora' : 'school';
}
const DOODLES = ['✏️', '📚', '⭐', '🎨', '🎵', '⚽', '🔬', '🧮', '🌍', '🎒', '📐', '🏆'];
function cardFx(v){
  if(v === 'holo') return '<div class="pt-card-fx pt-foil"></div><div class="pt-card-fx pt-lines"></div><div class="pt-card-fx pt-ring"></div>';
  if(v === 'aurora') return ['b1', 'b2', 'b3', 'b4'].map(b => `<div class="pt-card-fx pt-blob ${b}"></div>`).join('') + '<div class="pt-card-fx pt-grain"></div>';
  let s = '';
  for(let i = 0; i < 84; i++) s += `<span>${DOODLES[(i * 5 + Math.floor(i / 6)) % DOODLES.length]}</span>`;
  const sparks = [[18, 22, 0], [78, 14, .6], [60, 46, 1.2], [28, 70, 1.8], [86, 64, .9], [46, 86, 1.5]]
    .map(([x, y, d]) => `<div class="pt-card-fx pt-spark" style="left:${x}%;top:${y}%;animation-delay:${d}s"></div>`).join('');
  return `<div class="pt-card-fx pt-doodles" aria-hidden="true">${s}</div>${sparks}`;
}
// Нахил і відблиск за пальцем; за 1,2 с без руху картка знову «плаває» сама.
function tilt(card){
  if(!card) return;
  let t = null;
  card.addEventListener('pointermove', e => {
    const r = card.getBoundingClientRect(); if(!r.width) return;
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    card.classList.remove('is-idle');
    card.style.setProperty('--pt-ry', ((x - .5) * 16).toFixed(1) + 'deg'); card.style.setProperty('--pt-rx', ((.5 - y) * 12).toFixed(1) + 'deg');
    card.style.setProperty('--pt-gx', (x * 100).toFixed(0) + '%'); card.style.setProperty('--pt-gy', (y * 100).toFixed(0) + '%');
    clearTimeout(t);
    t = setTimeout(() => { card.style.removeProperty('--pt-rx'); card.style.removeProperty('--pt-ry'); card.classList.add('is-idle'); }, 1200);
  });
}
export async function openCard(){
  let cached = null;
  try{ cached = JSON.parse(localStorage.getItem(cardKey()) || 'null'); }catch(e){}
  const { ov, close } = overlay('pt-card-ov', 'PUSH School Card');
  const paint = (c, err) => {
    ov.innerHTML = `<div class="pt-card-wrap">
      <div class="pt-card-top"><span>Покажіть цей екран партнеру</span><button type="button" class="pt-x" data-a="close" aria-label="Закрити">✕</button></div>
      ${c ? `<div class="pt-card-stage"><div class="pt-card pt-v-${cardTheme(c)} is-idle">
        ${cardFx(cardTheme(c))}
        <div class="pt-card-fx pt-card-sheen"></div><div class="pt-card-fx pt-card-glare"></div>
        <div class="pt-card-row"><img src="/icon-192.png" alt="PUSH School" class="pt-card-logo" onerror="this.onerror=null;this.src='/logo.png'"><span class="pt-card-chip" aria-hidden="true"></span></div>
        <div><small>PARTNER CARD</small><b class="pt-card-no" data-no-i18n>${escHtml(c.display)}</b></div>
        <div><small>ВЛАСНИК</small><b class="pt-card-name" data-no-i18n>${escHtml(c.name)}</b><span class="pt-card-who">${escHtml((c.labels || []).join(' · '))}</span></div>
        <div class="pt-card-foot"><span class="pt-card-valid">Дійсна до ${escHtml(human(c.until))}</span><span class="pt-card-live"><i class="pt-card-dot" aria-hidden="true"></i><span class="pt-card-clock" aria-live="off"></span></span></div>
      </div></div>` : `<div class="pt-card-err">${err ? escHtml(err) : 'Завантаження картки…'}${err && /імʼя/.test(err) ? profileButton() : ''}</div>`}
      <p class="pt-card-note">${c ? 'Годинник іде, а фон переливається — так партнер бачить, що це живий екран, а не знімок. Номер можна перевірити на push.school/card.' : ''}</p>
    </div>`;
    tick(); tilt(ov.querySelector('.pt-card'));
  };
  const tick = () => {
    const el = ov.querySelector('.pt-card-clock'); if(!el) return;
    const d = new Date();
    el.textContent = d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' · ' + d.toLocaleDateString('uk-UA');
  };
  paint(cached);
  ov.addEventListener('click', e => { if(e.target.closest('[data-a="profile"]')){ close(); document.querySelectorAll('.pt-ov').forEach(x => x.remove()); document.body.classList.remove('pt-open'); window.openProfileModal(); } });
  clearInterval(clockTimer); clockTimer = setInterval(() => { if(!document.body.contains(ov)){ clearInterval(clockTimer); release(); return; } tick(); }, 1000);
  try{ if(navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); }catch(e){ wake = null; }
  ov.querySelector('.pt-x')?.focus();
  try{ paint(await fetchCard()); ov.querySelector('.pt-x')?.focus(); }
  catch(e){
    // Сервер сказав «картки немає / немає імені» — збережену на пристрої
    // більше не показуємо (людина могла вибути зі школи). Немає звʼязку —
    // показуємо збережену: картка має працювати й без інтернету.
    if(e.status === 400 || e.status === 403){ try{ localStorage.removeItem(cardKey()); }catch(x){} paint(null, e.message); }
    else if(!cached) paint(null, e.message || 'Не вдалося завантажити картку');
  }
  return close;
}
function release(){ try{ wake && wake.release(); }catch(e){} wake = null; }
window.openPartnerCard = openCard;

// ═══════════ ДИРЕКТОР: ПАРТНЕРИ Й КАТЕГОРІЇ ═══════════
let adm = null;
const rid = (n = 10) => Array.from(crypto.getRandomValues(new Uint8Array(n)), x => 'abcdefghijklmnopqrstuvwxyz0123456789'[x % 36]).join('');
window.openPartnersAdmin = async function(){
  document.querySelectorAll('.pt-adm-ov').forEach(x => x.remove());
  const ov = document.createElement('div');
  ov.className = 'modal-overlay pt-adm-ov'; ov.style.display = 'flex'; ov.style.zIndex = '1020';
  ov.innerHTML = '<div class="modal-content pt-adm" role="dialog" aria-modal="true" aria-label="Партнери школи"><p class="empty-msg is-loading">Завантаження...</p></div>';
  document.body.appendChild(ov);
  ov.addEventListener('click', e => { if(e.target === ov){ ov.remove(); adm = null; } });
  adm = { ov, edit: null };
  await admLoad();
};
async function admLoad(){
  const st = adm; if(!st) return;
  Object.assign(st, await loadAll());
  if(adm !== st) return;
  admPaint();
}
function admPaint(){
  const st = adm, box = st.ov.querySelector('.pt-adm');
  const cats = catList(st.cats), day = warsawToday();
  const list = Object.entries(st.partners).map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'uk'));
  const used = {}; list.forEach(p => { used[p.cat] = (used[p.cat] || 0) + 1; });
  const catName = id => { const c = st.cats[id]; return c ? `${c.icon || ''} ${c.name}`.trim() : '— без категорії'; };
  box.innerHTML = `
  <div class="pt-adm-h"><h3>🤝 Партнери школи</h3><button type="button" class="pt-adm-x" data-a="close" aria-label="Закрити">✕</button></div>
  <p class="pt-adm-note">Учні бачать знижки «для учнів», батьки — «для батьків» і «для учнів», працівники — «для персоналу». Партнер без чинних знижок для людини їй не показується.</p>
  ${st.edit ? editorHtml(st.edit, cats) : `
  <button type="button" class="ui-btn ui-btn-2 pt-adm-cards" data-a="cards">💳 Видані картки</button>
  <section class="pt-adm-sec"><div class="pt-adm-sec-h"><h4>Партнери (${list.length})</h4><button type="button" class="ui-btn" data-a="new">+ Партнер</button></div>
    ${list.length ? list.map(p => {
      const all = Object.values(p.offers || {}), live = all.filter(o => !o.until || o.until >= day);
      return `<div class="pt-adm-row${p.hidden ? ' off' : ''}" data-pid="${escHtml(p.id)}">${tileHtml(p)}
        <span class="nm"><b>${escHtml(p.name)}</b><small>${escHtml(catName(p.cat))} · ${live.length} ${live.length === 1 ? 'послуга' : 'послуг'}${all.length > live.length ? ` · ${all.length - live.length} закінчилась` : ''}${p.recommended ? ' · ⭐' : ''}</small></span>
        <label class="vis"><input type="checkbox" data-a="vis" ${p.hidden ? '' : 'checked'}> ${p.hidden ? 'Сховано' : 'Видно'}</label>
        <button type="button" class="ui-btn ui-btn-2" data-a="edit">Змінити</button></div>`; }).join('')
      : '<p class="pt-adm-note">Партнерів ще немає. Додайте першого — назва, категорія й хоча б одна послуга.</p>'}
  </section>
  <section class="pt-adm-sec"><div class="pt-adm-sec-h"><h4>Категорії</h4><button type="button" class="ui-btn ui-btn-2" data-a="cat-add">+ Категорія</button></div>
    <p class="pt-adm-note">Порожні й сховані категорії людям не показуються. Видалити можна лише порожню.</p>
    ${cats.map((c, i) => `<div class="pt-cat-row" data-cid="${escHtml(c.id)}">
      <input data-f="icon" value="${escHtml(c.icon)}" maxlength="8" aria-label="Значок категорії" class="ic">
      <input data-f="name" value="${escHtml(c.name)}" maxlength="40" aria-label="Назва категорії" class="nm">
      <span class="cnt">${used[c.id] || 0}</span>
      <button type="button" data-a="up" aria-label="Вище" ${i ? '' : 'disabled'}>↑</button>
      <button type="button" data-a="down" aria-label="Нижче" ${i < cats.length - 1 ? '' : 'disabled'}>↓</button>
      <label class="vis"><input type="checkbox" data-f="hidden" ${c.hidden ? 'checked' : ''}> сховати</label>
      <button type="button" data-a="cat-del" aria-label="Видалити категорію ${escHtml(c.name)}" ${used[c.id] ? 'disabled title="У категорії є партнери"' : ''}>✕</button>
    </div>`).join('')}
  </section>`}`;
  box.onclick = admClick; box.onchange = admChange;
}
function editorHtml(p, cats){
  const offers = Object.entries(p.offers || {});
  return `<section class="pt-adm-sec pt-ed">
    <h4>${p._new ? 'Новий партнер' : 'Партнер'}</h4>
    <label>Назва<input data-e="name" maxlength="80" value="${escHtml(p.name || '')}"></label>
    <div class="pt-ed-2">
      <label>Категорія<select data-e="cat">${cats.map(c => `<option value="${escHtml(c.id)}" ${c.id === p.cat ? 'selected' : ''}>${escHtml(`${c.icon} ${c.name}`.trim())}</option>`).join('')}</select></label>
      <label>Колір плитки<select data-e="color">${COLORS.map((c, i) => `<option value="${c}" ${c === (p.color || 'c0') ? 'selected' : ''}>Колір ${i + 1}</option>`).join('')}</select></label>
    </div>
    <label>Коротко про партнера<textarea data-e="about" maxlength="600" rows="3">${escHtml(p.about || '')}</textarea></label>
    <div class="pt-ed-2">
      <label>Адреса<input data-e="address" maxlength="160" value="${escHtml(p.address || '')}"></label>
      <label>Телефон<input data-e="phone" maxlength="40" inputmode="tel" value="${escHtml(p.phone || '')}"></label>
    </div>
    <label>Сайт або Instagram (https://…)<input data-e="site" maxlength="200" inputmode="url" value="${escHtml(p.site || '')}"></label>
    <div class="pt-ed-logo">${tileHtml(p, 'big')}<label class="ui-btn ui-btn-2">Завантажити логотип<input type="file" accept="image/*" data-e="logo-file" hidden></label>${p.logo ? '<button type="button" class="ui-btn ui-btn-2" data-a="logo-del">Прибрати</button>' : ''}</div>
    <h4>Послуги та знижки</h4>
    ${offers.map(([oid, o]) => `<div class="pt-ed-offer" data-oid="${escHtml(oid)}">
      <div class="pt-ed-2"><label>Що<input data-o="title" maxlength="100" value="${escHtml(o.title || '')}" placeholder="Абонемент на місяць"></label>
        <label class="sm">Знижка<input data-o="deal" maxlength="30" value="${escHtml(o.deal || '')}" placeholder="−15%"></label></div>
      <label>Умови<input data-o="terms" maxlength="300" value="${escHtml(o.terms || '')}" placeholder="8 занять, будь-який напрям"></label>
      <div class="pt-ed-who"><span>Для кого:</span>${Object.entries(WHO).map(([k, v]) => `<label><input type="checkbox" data-w="${k}" ${o.who && o.who[k] ? 'checked' : ''}> ${v}</label>`).join('')}
        <label class="sm">до <input type="date" data-o="until" value="${escHtml(o.until || '')}"></label>
        <button type="button" data-a="offer-del" aria-label="Видалити послугу">✕</button></div>
    </div>`).join('')}
    <button type="button" class="ui-btn ui-btn-2" data-a="offer-add">+ Послуга</button>
    <label class="pt-ed-chk"><input type="checkbox" data-e="recommended" ${p.recommended ? 'checked' : ''}> Рекомендуємо — показувати першим</label>
    <label class="pt-ed-chk"><input type="checkbox" data-e="hidden" ${p.hidden ? 'checked' : ''}> Сховати (не показувати нікому)</label>
    <p class="pt-ed-msg" role="status"></p>
    <div class="pt-ed-btns"><button type="button" class="ui-btn" data-a="save">Зберегти</button><button type="button" class="ui-btn ui-btn-2" data-a="cancel">Скасувати</button>
      ${p._new ? '' : '<button type="button" class="ui-btn ui-btn-2 danger" data-a="del">Видалити партнера</button>'}</div>
  </section>`;
}
// Зібрати партнера з форми (перевірки — тут і в правилах бази)
export function readEditor(root, base){
  const g = k => (root.querySelector(`[data-e="${k}"]`) || {}).value || '';
  const p = { name: g('name').trim().slice(0, 80), cat: g('cat'), color: g('color') || 'c0',
    recommended: !!root.querySelector('[data-e="recommended"]')?.checked, hidden: !!root.querySelector('[data-e="hidden"]')?.checked,
    createdAt: base.createdAt || Date.now(), offers: {} };
  for(const k of ['about', 'address', 'phone']){ const v = g(k).trim(); if(v) p[k] = v.slice(0, k === 'about' ? 600 : k === 'address' ? 160 : 40); }
  const site = g('site').trim();
  if(site){ if(!safeUrl(site)) throw new Error('Сайт має починатися з https://'); p.site = site; }
  if(base.logo) p.logo = base.logo;
  for(const el of root.querySelectorAll('.pt-ed-offer')){
    const o = k => (el.querySelector(`[data-o="${k}"]`) || {}).value || '';
    const title = o('title').trim(), deal = o('deal').trim();
    if(!title && !deal) continue;
    if(!title || !deal) throw new Error('У кожної послуги має бути назва й знижка');
    const who = {}; el.querySelectorAll('[data-w]').forEach(c => { if(c.checked) who[c.dataset.w] = true; });
    if(!Object.keys(who).length) throw new Error(`Оберіть, для кого послуга «${title}»`);
    const off = { title: title.slice(0, 100), deal: deal.slice(0, 30), who };
    if(o('terms').trim()) off.terms = o('terms').trim().slice(0, 300);
    if(/^\d{4}-\d{2}-\d{2}$/.test(o('until'))) off.until = o('until');
    p.offers[el.dataset.oid] = off;
  }
  if(!p.name) throw new Error('Вкажіть назву партнера');
  if(!Object.keys(p.offers).length) throw new Error('Додайте хоча б одну послугу');
  return p;
}
function catsFrom(){ return Object.fromEntries(catList(adm.cats).map(c => [c.id, { name: c.name, icon: c.icon, order: c.order, ...(c.hidden ? { hidden: true } : {}) }])); }
async function saveCats(cats){
  await set(ref(db, 'partner_cats'), cats);
  adm.cats = cats; adm.catsStored = true;
}
async function admClick(e){
  const st = adm; if(!st) return;
  const b = e.target.closest('[data-a]'); if(!b || b.tagName === 'INPUT') return;
  const a = b.dataset.a, box = st.ov.querySelector('.pt-adm');
  try{
    if(a === 'close'){ st.ov.remove(); adm = null; return; }
    if(a === 'cards') return window.openPartnerCardsAdmin();
    if(a === 'new'){ st.edit = { _new: true, id: rid(), cat: catList(st.cats)[0]?.id || 'sport', color: COLORS[Math.floor(Math.random() * 8)], offers: { [rid(8)]: { who: { student: true } } } }; return admPaint(); }
    if(a === 'edit'){ const id = b.closest('[data-pid]').dataset.pid; st.edit = { id, ...JSON.parse(JSON.stringify(st.partners[id])) }; return admPaint(); }
    if(a === 'cancel'){ st.edit = null; return admPaint(); }
    if(a === 'offer-add' || a === 'offer-del' || a === 'logo-del'){
      // Спершу зберігаємо введене в формі, щоб перемальовування не стерло його
      const cur = draft(box);
      if(a === 'offer-add') cur.offers[rid(8)] = { who: {} };
      if(a === 'offer-del') delete cur.offers[b.closest('[data-oid]').dataset.oid];
      if(a === 'logo-del') delete cur.logo;
      st.edit = cur; return admPaint();
    }
    if(a === 'save'){
      const msg = box.querySelector('.pt-ed-msg');
      let p; try{ p = readEditor(box, st.edit); }catch(err){ msg.textContent = err.message; return; }
      b.disabled = true;
      await set(ref(db, `partners/${st.edit.id}`), p);
      showToast('Збережено'); st.edit = null; return admLoad();
    }
    if(a === 'del'){
      if(!confirm(`Видалити партнера «${st.edit.name || ''}»?`)) return;
      await remove(ref(db, `partners/${st.edit.id}`)); st.edit = null; showToast('Видалено'); return admLoad();
    }
    if(a === 'cat-add'){
      const cats = catsFrom(); const max = Math.max(0, ...Object.values(cats).map(c => c.order || 0));
      cats['c' + rid(6)] = { name: 'Нова категорія', icon: '✨', order: max + 1 };
      await saveCats(cats); return admPaint();
    }
    const cid = b.closest('[data-cid]') && b.closest('[data-cid]').dataset.cid;
    if(cid && (a === 'up' || a === 'down')){
      const list = catList(st.cats), i = list.findIndex(c => c.id === cid), j = a === 'up' ? i - 1 : i + 1;
      if(j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      const cats = catsFrom(); list.forEach((c, k) => { cats[c.id].order = k + 1; });
      await saveCats(cats); return admPaint();
    }
    if(cid && a === 'cat-del'){
      if(Object.values(st.partners).some(p => p.cat === cid)) return showToast('У категорії є партнери — спершу перенесіть їх');
      const cats = catsFrom(); delete cats[cid]; await saveCats(cats); return admPaint();
    }
  }catch(err){ b.disabled = false; showToast('Не вдалося: ' + (err.message || '')); }
}
// Поточний стан форми без перевірок — для перемальовування
function draft(box){
  const cur = { ...adm.edit, offers: {} };
  const g = k => (box.querySelector(`[data-e="${k}"]`) || {}).value;
  ['name', 'cat', 'color', 'about', 'address', 'phone', 'site'].forEach(k => { const v = g(k); if(v !== undefined) cur[k] = v; });
  cur.recommended = !!box.querySelector('[data-e="recommended"]')?.checked; cur.hidden = !!box.querySelector('[data-e="hidden"]')?.checked;
  box.querySelectorAll('.pt-ed-offer').forEach(el => {
    const o = k => (el.querySelector(`[data-o="${k}"]`) || {}).value || '';
    const who = {}; el.querySelectorAll('[data-w]').forEach(c => { if(c.checked) who[c.dataset.w] = true; });
    cur.offers[el.dataset.oid] = { title: o('title'), deal: o('deal'), terms: o('terms'), until: o('until'), who };
  });
  return cur;
}
async function admChange(e){
  const st = adm; if(!st) return;
  const t = e.target, box = st.ov.querySelector('.pt-adm');
  try{
    if(t.dataset.a === 'vis'){
      const id = t.closest('[data-pid]').dataset.pid;
      await set(ref(db, `partners/${id}/hidden`), !t.checked);
      st.partners[id].hidden = !t.checked; return admPaint();
    }
    if(t.dataset.e === 'logo-file' && t.files && t.files[0]){
      const cur = draft(box);
      showToast('Завантажую логотип…');
      cur.logo = await uploadToCloudinary(t.files[0]);
      st.edit = cur; return admPaint();
    }
    const cid = t.closest('[data-cid]') && t.closest('[data-cid]').dataset.cid;
    if(cid && t.dataset.f){
      const cats = catsFrom();
      if(t.dataset.f === 'hidden') { if(t.checked) cats[cid].hidden = true; else delete cats[cid].hidden; }
      else{
        const v = t.value.trim();
        if(t.dataset.f === 'name' && !v){ t.value = cats[cid].name; return showToast('Назва не може бути порожньою'); }
        cats[cid][t.dataset.f] = v.slice(0, t.dataset.f === 'name' ? 40 : 8);
      }
      await saveCats(cats); showToast('Категорію збережено');
    }
  }catch(err){ showToast('Не вдалося: ' + (err.message || '')); }
}

// ═══════════ ДИРЕКТОР: 💳 ВИДАНІ КАРТКИ ═══════════
// Список карток, які сервер уже видав (картку видають, коли людина вперше
// відкриє «Моя картка»). Тут: хто, група, до коли, скільки разів партнери
// її перевіряли — і кнопка «Заблокувати». Заблокована картка в партнера
// показується недійсною, а нову власнику сервер не видасть, доки не
// розблокують. Картки вибулих зникають самі (card-check / partner-card).
export const CARD_GROUPS = { parent: 'Батьки', student: 'Учні', staff: 'Персонал' };
export function cardStatus(c, today){
  if(c && c.blocked) return 'blocked';
  return String((c && c.until) || '') >= today ? 'active' : 'expired';
}
export function cardRows(cards, today){
  return Object.entries(cards || {})
    .filter(([no, c]) => /^\d{12}$/.test(no) && c && typeof c === 'object' && c.uid)
    .map(([no, c]) => ({ no, uid: String(c.uid), name: String(c.name || ''), groups: Object.keys(c.groups || {}).filter(g => CARD_GROUPS[g]),
      until: c.until || '', issuedAt: Number(c.issuedAt) || 0, checks: Number(c.checks) || 0, lastCheck: Number(c.lastCheck) || 0,
      blocked: !!c.blocked, blockedAt: Number(c.blockedAt) || 0, blockedBy: c.blockedBy || '', status: cardStatus(c, today) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'uk') || a.no.localeCompare(b.no));
}
export function cardStats(rows){
  const s = { all: rows.length, active: 0, blocked: 0, expired: 0, checks: 0, parent: 0, student: 0, staff: 0 };
  rows.forEach(r => { s[r.status]++; s.checks += r.checks; r.groups.forEach(g => { s[g]++; }); });
  return s;
}
export function filterCards(rows, q, f){
  const needle = String(q || '').trim().toLowerCase(), dig = needle.replace(/\D/g, '');
  return rows.filter(r => {
    if(f === 'blocked' && !r.blocked) return false;
    if(f === 'expired' && r.status !== 'expired') return false;
    if(CARD_GROUPS[f] && !r.groups.includes(f)) return false;
    if(!needle) return true;
    return r.name.toLowerCase().includes(needle) || (dig.length >= 3 && r.no.includes(dig));
  });
}
const fmtNo = no => 'PS ' + String(no).replace(/(\d{4})(?=\d)/g, '$1 ');
const fmtDay = ts => ts ? new Date(ts).toLocaleDateString('uk-UA') : '';
// Перерахувати картки на сервері (імʼя й групи з бази; вибулих — прибрати).
// По 25 людей за запит. Повертає зведення {updated, same, dropped, …, error}.
export async function syncCards(uids, onProgress){
  const list = [...new Set((uids || []).filter(Boolean))], sum = {};
  for(let i = 0; i < list.length; i += 25){
    const part = list.slice(i, i + 25);
    try{
      const idToken = await window.authIdToken();
      const r = await fetch('/.netlify/functions/partner-cards-sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken, uids: part }) });
      const d = await r.json().catch(() => ({}));
      if(!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      Object.values(d.results || {}).forEach(st => { sum[st] = (sum[st] || 0) + 1; });
    }catch(e){ sum.error = (sum.error || 0) + part.length; sum.msg = e.message || String(e); }
    if(onProgress) onProgress(Math.min(i + 25, list.length), list.length);
  }
  return sum;
}
window.syncPartnerCards = syncCards;
let cadm = null;
window.openPartnerCardsAdmin = async function(){
  document.querySelectorAll('.pt-cards-ov').forEach(x => x.remove());
  const ov = document.createElement('div');
  ov.className = 'modal-overlay pt-cards-ov'; ov.style.display = 'flex'; ov.style.zIndex = '1030';
  ov.innerHTML = '<div class="modal-content pt-adm pt-cards" role="dialog" aria-modal="true" aria-label="Видані картки"><p class="empty-msg is-loading">Завантаження...</p></div>';
  document.body.appendChild(ov);
  const box = ov.querySelector('.pt-cards');
  cadm = { ov, box, rows: [], q: '', f: 'all' };
  ov.addEventListener('click', e => { if(e.target === ov){ ov.remove(); cadm = null; } });
  box.addEventListener('click', cardsClick);
  box.addEventListener('input', e => { if(e.target.dataset.c === 'q' && cadm){ cadm.q = e.target.value; cardsList(); } });
  await cardsLoad();
};
async function cardsLoad(){
  const st = cadm; if(!st) return;
  let cards = null;
  try{ cards = await val('partner_cards'); }
  catch(e){ st.box.innerHTML = `<p class="empty-msg">Не вдалося завантажити картки: ${escHtml(e.message || e)}</p>`; return; }
  if(cadm !== st) return;
  st.rows = cardRows(cards, warsawToday());
  cardsPaint();
}
function cardsPaint(){
  const st = cadm, s = cardStats(st.rows);
  const chip = (k, label, n) => `<button type="button" class="pt-chip${st.f === k ? ' on' : ''}" data-c="f" data-k="${k}" aria-pressed="${st.f === k}">${label}${n != null ? ` <b>${n}</b>` : ''}</button>`;
  st.box.innerHTML = `<div class="pt-adm-h"><h3>💳 Видані картки</h3><button type="button" class="pt-adm-x" data-c="close" aria-label="Закрити">✕</button></div>
    <div class="pt-cs">
      <div><b>${s.all}</b><small>видано</small></div><div><b>${s.active}</b><small>діють</small></div>
      <div><b>${s.blocked}</b><small>заблоковано</small></div><div><b>${s.checks}</b><small>перевірок у партнерів</small></div>
    </div>
    <p class="pt-adm-note">Картку видає портал, коли людина вперше відкриє «Моя картка». Хто вибув зі школи — його картка зникає сама. Заблокована картка в партнера показується недійсною, і нову власнику не видадуть, доки не розблокуєте.</p>
    ${st.synced ? `<p class="pt-adm-note pt-cards-synced">🔄 Оновлено: ${st.synced.updated || 0}${st.synced.dropped ? ` · прибрано вибулих: ${st.synced.dropped}` : ''}${st.synced.error ? ` · не вдалося: ${st.synced.error} (${escHtml(st.synced.msg || '')})` : ''}</p>` : ''}
    <button type="button" class="ui-btn ui-btn-2 pt-cards-sync" data-c="sync">🔄 Оновити дані карток</button>
    <input type="search" class="pt-cards-q" data-c="q" value="${escHtml(st.q)}" placeholder="Пошук: імʼя або номер" aria-label="Пошук картки">
    <div class="pt-chips pt-cards-f">${chip('all', 'Усі', s.all)}${chip('parent', 'Батьки', s.parent)}${chip('student', 'Учні', s.student)}${chip('staff', 'Персонал', s.staff)}${chip('blocked', '⛔ Заблоковані', s.blocked)}${s.expired ? chip('expired', 'Минув термін', s.expired) : ''}</div>
    <div class="pt-cards-list"></div>`;
  cardsList();
}
function cardsList(){
  const st = cadm; if(!st) return;
  const list = st.box.querySelector('.pt-cards-list'); if(!list) return;
  const rows = filterCards(st.rows, st.q, st.f);
  const LBL = { active: ['діє', 'ok'], expired: ['минув термін', 'exp'], blocked: ['заблоковано', 'bad'] };
  list.innerHTML = rows.length ? rows.map(r => `<div class="pt-crow${r.blocked ? ' off' : ''}" data-no="${r.no}">
      <span class="nm"><b data-no-i18n>${escHtml(r.name || '—')}</b>
        <small><span data-no-i18n>${fmtNo(r.no)}</span> · ${escHtml(r.groups.map(g => CARD_GROUPS[g]).join(', ') || '—')}</small>
        <small><i class="st ${LBL[r.status][1]}">${LBL[r.status][0]}</i>${r.until ? ` · до ${escHtml(human(r.until))}` : ''}${r.issuedAt ? ` · видано ${fmtDay(r.issuedAt)}` : ''}</small>
        <small>${r.checks ? `🔎 перевірок: ${r.checks}${r.lastCheck ? ` · остання ${fmtDay(r.lastCheck)}` : ''}` : 'партнери ще не перевіряли'}${r.blocked && r.blockedAt ? ` · заблоковано ${fmtDay(r.blockedAt)}` : ''}</small></span>
      <button type="button" class="ui-btn ui-btn-2${r.blocked ? '' : ' danger'}" data-c="${r.blocked ? 'unblock' : 'block'}">${r.blocked ? 'Розблокувати' : 'Заблокувати'}</button>
    </div>`).join('')
    : `<p class="pt-adm-note">${st.rows.length ? 'Нічого не знайдено.' : 'Карток ще не видано — вони зʼявляться, коли люди відкриють «Моя картка».'}</p>`;
}
async function cardsClick(e){
  const b = e.target.closest('[data-c]'); if(!b || !cadm) return;
  const c = b.dataset.c;
  if(c === 'close'){ cadm.ov.remove(); cadm = null; return; }
  if(c === 'f'){ cadm.f = b.dataset.k; return cardsPaint(); }
  if(c === 'sync'){
    // Імена й групи з бази (школа могла виправити імʼя учня) — на сервері
    const st = cadm; b.disabled = true;
    const sum = await syncCards(st.rows.map(r => r.uid), (d, n) => { b.textContent = `🔄 Оновлюю… ${d} з ${n}`; });
    if(cadm !== st) return;
    st.synced = sum; await cardsLoad(); return;
  }
  if(c === 'block' || c === 'unblock'){
    const no = b.closest('[data-no]').dataset.no, r = cadm.rows.find(x => x.no === no); if(!r) return;
    const yes = c === 'block'
      ? confirm(`Заблокувати картку ${fmtNo(no)} (${r.name})?\n\nУ партнерів вона стане недійсною, а нову власнику не видадуть, доки не розблокуєте.`)
      : confirm(`Розблокувати картку ${fmtNo(no)} (${r.name})?`);
    if(!yes) return;
    b.disabled = true;
    try{
      // Одним записом: або всі три поля, або жодного
      await update(ref(db, `partner_cards/${no}`), c === 'block'
        ? { blocked: true, blockedAt: Date.now(), blockedBy: (auth.currentUser && auth.currentUser.email) || '' }
        : { blocked: null, blockedAt: null, blockedBy: null });
      showToast(c === 'block' ? '⛔ Картку заблоковано' : '✅ Картку розблоковано');
      Object.assign(r, c === 'block' ? { blocked: true, blockedAt: Date.now(), status: 'blocked' } : { blocked: false, blockedAt: 0, status: cardStatus({ until: r.until }, warsawToday()) });
      cardsPaint();
    }catch(err){ b.disabled = false; showToast('Не вдалося: ' + (err && err.message || err)); }
  }
}
