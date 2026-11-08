// ═══════════════════════════════════════════════════════════════
// app-reach.js — 📱 «Хто отримує сповіщення».
//
// НАВІЩО. Сповіщення про оцінки, відсутності, оголошення й перездачі
// доходять лише до тих, хто встановив застосунок і дозволив сповіщення.
// Хто цього не зробив — «нічого не отримував», і школа дізнається про це
// постфактум. Тут видно, кому варто нагадати.
//
// ХТО БАЧИТЬ. Директор і адміністрація — персонал і всі родини школи.
// Учитель — батьків і учнів своїх класів (без пошт). Дані збирає сервер
// (netlify/functions/app-reach.js): токени й записи пристроїв клієнтам
// закриті, тож браузер отримує лише готовий звіт.
//
// «ЗАСТОСУНОК ВСТАНОВЛЕНО» — людина хоч раз відкрила портал як
// встановлений застосунок (common.js → reportAppSeen). Позначка
// збирається з 24.10.2026; хто відтоді не заходив — «невідомо».
// ═══════════════════════════════════════════════════════════════
import { auth, currentUserData, escHtml, showToast, isTeacherRole, getActiveClass } from './common.js';

const isAdminRole = r => r === 'director' || r === 'administrator';
export const VERDICTS = {
  ok:     { icon: '✅', label: 'Отримують сповіщення' },
  nopush: { icon: '🔕', label: 'Без сповіщень' },
  never:  { icon: '⛔', label: 'Не заходили' }
};
const APP = { installed: '📱 Застосунок', browser: '🌐 Лише браузер', unknown: '' };
const PR = { mother: 'мама', father: 'тато', guardian: 'опікун' };
const clsLabel = c => `${String(c).replace('class_', '')} клас`;
const ago = ts => {
  if(!ts) return '';
  const d = Math.floor((Date.now() - ts) / 864e5);
  return d <= 0 ? 'сьогодні' : d === 1 ? 'вчора' : d < 30 ? `${d} дн тому` : new Date(ts).toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' });
};

// ── ЧИСТА ЧАСТИНА ───────────────────────────────────────────────
export function counts(list){
  const c = { ok: 0, nopush: 0, never: 0, app: 0, total: list.length };
  list.forEach(x => { c[x.verdict] = (c[x.verdict] || 0) + 1; if(x.app === 'installed') c.app++; });
  return c;
}
export function filterRows(list, { cls = '', only = '' } = {}){
  return list.filter(x => (!cls || (x.kids || []).some(k => k.cls === cls)) && (!only || x.verdict === only));
}
// Текстом — для копіювання списку
function who(x){
  if(x.kind === 'staff') return x.name || x.email;
  const kids = (x.kids || []).map(k => `${k.name}${x.kind === 'parent' && PR[k.pr] ? ` (${PR[k.pr]})` : ''}, ${clsLabel(k.cls)}`).join('; ');
  return x.kind === 'student' ? `🎒 ${kids}` : kids;
}
// Для показу — частини окремими елементами: імʼя дитини не перекладається,
// а «3 клас» і «мама» — так (i18n.js перекладає цілі текстові вузли)
// Рядок: зверху — ХТО (батько чи учень), нижче — чия це дитина й клас
function titleHtml(x){
  if(x.kind === 'staff') return `<span data-no-i18n>${escHtml(x.name || x.email)}</span>`;
  if(x.kind === 'student') return `🎒 <span data-no-i18n>${escHtml((x.kids[0] || {}).name || x.name)}</span>`;
  return x.name ? `<span data-no-i18n>${escHtml(x.name)}</span>` : '<span class="ar-noname">Без ПІБ у профілі</span>';
}
function kidsHtml(x){
  if(x.kind === 'staff') return x.email ? `<span data-no-i18n>${escHtml(x.email)}</span>` : '';
  if(x.kind === 'student') return `<span>учень</span> · <span>${escHtml(clsLabel((x.kids[0] || {}).cls || ''))}</span>`;
  return (x.kids || []).map(k => (PR[k.pr] ? `<span>${escHtml(PR[k.pr])}</span>: ` : '')
    + `<span data-no-i18n>${escHtml(k.name)}</span> · <span>${escHtml(clsLabel(k.cls))}</span>`).join('; ')
    + (x.email ? ` · <span data-no-i18n>${escHtml(x.email)}</span>` : '');
}
export function rowHtml(x){
  const v = VERDICTS[x.verdict] || VERDICTS.never;
  const tags = [];
  if(x.verdict !== 'never'){
    if(APP[x.app]) tags.push(`<span class="ar-tag${x.app === 'installed' ? ' good' : ''}">${escHtml(APP[x.app])}</span>`);
    tags.push(x.push ? `<span class="ar-tag good">🔔 Сповіщення${x.devices > 1 ? ` · ${x.devices} пристр.` : ''}</span>`
      : `<span class="ar-tag warn">🔕 Сповіщення вимкнені</span>`);
    if(!x.push && x.notif === 'denied') tags.push('<span class="ar-tag warn">Заборонено в налаштуваннях телефона</span>');
    if(x.lastAt) tags.push(`<span class="ar-tag">Останній вхід: ${escHtml(ago(x.lastAt))}</span>`);
  } else tags.push('<span class="ar-tag warn">Жодного входу в портал</span>');
  return `<div class="ar-row" data-v="${escHtml(x.verdict)}">
    <span class="ar-ic" aria-label="${escHtml(v.label)}">${v.icon}</span>
    <div class="ar-main"><b>${titleHtml(x)}</b><small>${kidsHtml(x)}</small><div class="ar-tags">${tags.join('')}</div></div>
  </div>`;
}

// ── ВІКНО ───────────────────────────────────────────────────────
let data = null, tab = 'families', cls = '', only = '';
function overlay(){
  let o = document.getElementById('app-reach-modal');
  if(o) return o;
  o = document.createElement('div');
  o.id = 'app-reach-modal'; o.className = 'modal-overlay'; o.style.zIndex = '1012';
  o.innerHTML = '<div class="modal-content ar-modal"></div>';
  o.addEventListener('click', e => {
    if(e.target === o){ o.style.display = 'none'; return; }
    const b = e.target.closest('[data-ar]'); if(!b) return;
    const [k, v] = b.dataset.ar.split(':');
    if(k === 'tab'){ tab = v; only = ''; }
    if(k === 'only') only = only === v ? '' : v;
    if(k === 'copy') return copyList();
    if(k === 'close'){ o.style.display = 'none'; return; }
    paint();
  });
  o.addEventListener('change', e => { if(e.target.id === 'ar-cls'){ cls = e.target.value; paint(); } });
  document.body.appendChild(o);
  return o;
}
const current = () => tab === 'staff' ? (data.staff || []) : (data.families || []);
function paint(){
  const mc = overlay().querySelector('.modal-content');
  if(!data){ mc.innerHTML = '<p class="empty-msg is-loading">Завантаження...</p>'; return; }
  const base = filterRows(current(), { cls: tab === 'staff' ? '' : cls });
  const c = counts(base), rows = filterRows(base, { only });
  const classes = data.classes || [...new Set((data.families || []).flatMap(x => (x.kids || []).map(k => k.cls)))].sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)));
  const tile = (k) => `<button type="button" class="ar-stat${only === k ? ' on' : ''}" data-ar="only:${k}" aria-pressed="${only === k}">
      <b>${c[k] || 0}</b><span>${VERDICTS[k].icon} ${VERDICTS[k].label}</span></button>`;
  mc.innerHTML = `
    <h2 class="ar-h">📱 Хто отримує сповіщення</h2>
    ${data.admin ? `<div class="ar-tabs" role="tablist">
      <button type="button" role="tab" data-ar="tab:families" aria-selected="${tab === 'families'}">👪 Батьки й учні</button>
      <button type="button" role="tab" data-ar="tab:staff" aria-selected="${tab === 'staff'}">🧑‍🏫 Персонал</button></div>` : ''}
    ${tab === 'families' ? `<select id="ar-cls" aria-label="Клас"><option value="">${data.admin ? 'Усі класи' : 'Усі мої класи'}</option>${classes.map(x => `<option value="${escHtml(x)}"${x === cls ? ' selected' : ''}>${escHtml(clsLabel(x))}</option>`).join('')}</select>` : ''}
    <div class="ar-stats">${tile('ok')}${tile('nopush')}${tile('never')}</div>
    <p class="ar-note"><span>📱 Застосунок встановили: ${c.app} з ${c.total}</span>.
      <span>Без застосунку на iPhone сповіщення не приходять узагалі.</span>
      <span>Порадьте встановити застосунок (кнопка «📲 Встановити застосунок» у кабінеті) і ввімкнути сповіщення.</span></p>
    ${rows.length ? `<button type="button" class="ar-copy" data-ar="copy">📋 Скопіювати список (${rows.length})</button>` : ''}
    <div class="ar-list">${rows.map(rowHtml).join('') || '<p class="empty-msg">Тут нікого.</p>'}</div>
    <p class="ar-note small">«Застосунок» видно з 24.10.2026 — хто відтоді не заходив, позначки не має. Сповіщення рахуються, якщо увімкнені хоч на одному пристрої.</p>
    <button type="button" class="ar-close" data-ar="close">Закрити</button>`;
}
async function copyList(){
  const base = filterRows(filterRows(current(), { cls: tab === 'staff' ? '' : cls }), { only });
  const text = base.map(x => `${VERDICTS[x.verdict].icon} ${who(x).replace(/^🎒 /, '')}${x.name && x.kind !== 'staff' ? ` — ${x.name}` : ''}${x.email ? ` <${x.email}>` : ''}`).join('\n');
  try{ await navigator.clipboard.writeText(text); showToast(`📋 Скопійовано: ${base.length}`); }
  catch(e){ const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try{ document.execCommand('copy'); showToast(`📋 Скопійовано: ${base.length}`); }catch(_){} ta.remove(); }
}

export async function openAppReach(){
  const role = currentUserData && currentUserData.role;
  // Мовчки не виходимо: «кнопка не працює» без жодного слова — найгірше,
  // що може побачити людина. Кажемо, чому вікна немає.
  if(!isAdminRole(role) && !isTeacherRole(role)){
    showToast(role ? 'Цей розділ доступний директору, адміністрації та вчителям.' : 'Кабінет ще завантажується — спробуйте за мить.');
    return;
  }
  const o = overlay();
  // Кабінет директора поки не перекладається (i18n.js) — і це вікно теж
  if(isAdminRole(role)) o.setAttribute('data-no-i18n', ''); else o.removeAttribute('data-no-i18n');
  data = null; tab = 'families'; only = '';
  cls = isAdminRole(role) ? '' : (getActiveClass() || '');
  o.style.display = 'flex';
  paint();
  try{
    if(!auth.currentUser) throw new Error('Сеанс завершився. Увійдіть ще раз.');
    const idToken = await auth.currentUser.getIdToken();
    const r = await fetch('/.netlify/functions/app-reach', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) });
    const d = await r.json().catch(() => ({}));
    if(!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    data = d;
    if(cls && data.classes && !data.classes.includes(cls)) cls = '';
    paint();
  }catch(e){
    o.querySelector('.modal-content').innerHTML = `<p class="empty-msg">Не вдалося завантажити: ${escHtml(e.message || '')}</p><button type="button" class="ar-close" data-ar="close">Закрити</button>`;
  }
}
window.openAppReach = openAppReach;
