// ═══════════════════════════════════════════════════════════════
// trainers.js — 🎯 спільна база тренажерів для вчителів.
//
// ЩО ЦЕ. Перелік онлайн-тренажерів (назва + посилання), як підручники, але
// спільний для всієї школи: тренажер, знайдений одним учителем, бачать усі.
// Кожен тренажер прив'язано до одного чи кількох предметів — за ними
// фільтр (теж множинний: «Математика» + «Алгебра» показує обидва).
//
// ДЕ ЛЕЖИТЬ: trainers/{id} = {title, url, subjects:{ключ: назва}, by, byName, ts}
//   Читають і додають усі вчителі (і адміністрація). Правити й видаляти —
//   автор або директор/адміністратор. Родина базу НЕ читає.
//
// ДО ДЗ. Прикріплений тренажер кладеться в саме завдання копією
// {title, url} (поле trainers). Тому батьки бачать його без доступу до
// бази, а видалення з бази не ламає вже задані ДЗ.
//
// Модуль не знає про форми ДЗ: teacher.js питає window.getHwTrainers(ctx)
// і просить window.setHwTrainers(ctx, list). ctx — 'main' (вкладка «Урок»)
// або id рядка «ДЗ на день».
// ═══════════════════════════════════════════════════════════════
import { ref, get, push, update, remove } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, currentUserData, escHtml, escJs, showToast, getUserRoles, safeHttpUrl } from './common.js';

export const TITLE_MAX = 120, URL_MAX = 500;
const seKey = e => String(e || '').replace(/\./g, '_');
// Ключ предмета для фільтра: без регістру й зайвих пробілів, без символів,
// заборонених у ключах бази. «Математика» і «математика » — один предмет.
export const trSubjKey = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.#$[\]/]/g, '_');

// ── ЧИСТА ЛОГІКА (покрита тестами) ─────────────────────────────
export function validTrainerUrl(u){
  const s = String(u || '').trim();
  if(!s || s.length > URL_MAX || /\s/.test(s)) return false;
  try { const p = new URL(s); return (p.protocol === 'http:' || p.protocol === 'https:') && p.hostname.includes('.'); }
  catch(e){ return false; }
}
// Записи бази → масив, найновіші зверху. Биті записи відкидаємо.
export function trainerList(node){
  return Object.entries(node || {})
    .filter(([, t]) => t && typeof t === 'object' && t.title && t.url)
    .map(([id, t]) => ({ id, ...t, subjects: t.subjects || {} }))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
}
// Фільтр: обрані предмети — АБО (будь-який збіг), пошук — у назві/примітці.
export function filterTrainers(list, subjKeys, query){
  const want = new Set(subjKeys || []);
  const q = String(query || '').trim().toLowerCase();
  return (list || []).filter(t => {
    if(want.size && !Object.keys(t.subjects || {}).some(k => want.has(k))) return false;
    if(q && !(`${t.title} ${t.note || ''}`.toLowerCase().includes(q))) return false;
    return true;
  });
}
// Перелік предметів для чипів: каталог школи (усі роки й класи) + те, що
// вже є в тренажерах. Без дублів за ключем, за абеткою.
export function subjectOptions(catalog, list){
  const m = new Map();
  const add = name => { const n = String(name || '').trim(); if(!n) return; const k = trSubjKey(n); if(!m.has(k)) m.set(k, n); };
  for(const y in (catalog || {})) for(const c in (catalog[y] || {})) for(const k in (catalog[y][c] || {})){
    const r = catalog[y][c][k]; add(r && typeof r === 'object' ? r.name : r);
  }
  (list || []).forEach(t => Object.values(t.subjects || {}).forEach(add));
  return [...m.entries()].map(([key, name]) => ({ key, name })).sort((a, b) => a.name.localeCompare(b.name, 'uk'));
}
// Що з ДЗ піде в базу: лише назва й безпечне посилання, без дублів.
export function hwTrainerCopies(list){
  const seen = new Set(), out = [];
  (list || []).forEach(t => {
    const url = String(t && t.url || '').trim();
    if(!validTrainerUrl(url) || seen.has(url)) return;
    seen.add(url); out.push({ title: String(t.title || url).slice(0, TITLE_MAX), url });
  });
  return out;
}

// ── СТАН ───────────────────────────────────────────────────────
let trCache = null, trCatalog = null;
let trSel = new Set(), trQuery = '';
let trPick = null;                 // {ctx, subject} — режим «прикріпити до ДЗ»
let trEdit = null;                 // id запису, що правиться
let trFormSubj = new Set();
const hwTrainers = {};             // ctx → [{title,url}]

const myKey = () => seKey(currentUserData?.email || '');
const isAdmin = () => getUserRoles(currentUserData).some(r => r === 'director' || r === 'administrator');
const canManage = t => t && (t.by === myKey() || isAdmin());

async function loadAll(force){
  if(!trCache || force){
    const [s, c] = await Promise.all([
      get(ref(db, 'trainers')),
      trCatalog ? Promise.resolve(null) : get(ref(db, 'subjects_catalog')).catch(() => null)
    ]);
    trCache = trainerList(s.exists() ? s.val() : {});
    if(c) trCatalog = c.exists() ? c.val() : {};
  }
  return trCache;
}

// ── ВІКНО БАЗИ ─────────────────────────────────────────────────
function ensureModal(){
  let m = document.getElementById('trainers-modal');
  if(m) return m;
  m = document.createElement('div');
  m.id = 'trainers-modal'; m.className = 'modal-overlay tr-modal';
  m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-labelledby', 'tr-title');
  m.innerHTML = `
    <div class="modal-content tr-box">
      <div class="tr-head">
        <h3 id="tr-title">🎯 База тренажерів</h3>
        <button type="button" class="tr-close" onclick="closeTrainers()" aria-label="Закрити">✕</button>
      </div>
      <div id="tr-pick-note" class="tr-pick-note" style="display:none;"></div>
      <input type="search" id="tr-search" placeholder="🔍 Пошук за назвою" oninput="trSearch(this.value)">
      <div class="tr-label">Предмети <span>(можна кілька)</span></div>
      <div id="tr-filter" class="tr-chips"></div>
      <div id="tr-list" class="tr-list"><p class="empty-msg is-loading">Завантаження...</p></div>
      <details id="tr-form-wrap" class="tr-form">
        <summary id="tr-form-sum">➕ Додати тренажер</summary>
        <label for="tr-f-title">Назва</label>
        <input type="text" id="tr-f-title" maxlength="${TITLE_MAX}" placeholder="напр. Таблиця множення — тренажер">
        <label for="tr-f-url">Посилання</label>
        <input type="url" id="tr-f-url" maxlength="${URL_MAX}" placeholder="https://...">
        <label>Предмети</label>
        <div id="tr-f-subj" class="tr-chips"></div>
        <div class="tr-form-actions">
          <button type="button" id="tr-f-save" onclick="saveTrainer()">💾 Зберегти</button>
          <button type="button" id="tr-f-cancel" class="tr-secondary" onclick="cancelTrainerEdit()" style="display:none;">Скасувати</button>
        </div>
      </details>
    </div>`;
  m.addEventListener('click', e => { if(e.target === m) window.closeTrainers(); });
  m.addEventListener('keydown', e => { if(e.key === 'Escape') window.closeTrainers(); });
  document.body.appendChild(m);
  return m;
}

function chip(key, name, on, fn){
  return `<button type="button" class="tr-chip${on ? ' on' : ''}" aria-pressed="${on}" onclick="${fn}('${escJs(key)}')">${escHtml(name)}</button>`;
}

function paintFilter(){
  const box = document.getElementById('tr-filter'); if(!box) return;
  const opts = subjectOptions(trCatalog, trCache);
  // Предмети без жодного тренажера в фільтрі лише заважають — показуємо
  // ті, де щось є, плюс уже обрані.
  const used = new Set(); (trCache || []).forEach(t => Object.keys(t.subjects || {}).forEach(k => used.add(k)));
  const shown = opts.filter(o => used.has(o.key) || trSel.has(o.key));
  box.innerHTML = `<button type="button" class="tr-chip${trSel.size ? '' : ' on'}" aria-pressed="${!trSel.size}" onclick="trClearFilter()">Усі</button>`
    + shown.map(o => chip(o.key, o.name, trSel.has(o.key), 'trToggleFilter')).join('')
    + (shown.length ? '' : '<span class="tr-hint">Предмети з’являться, коли додасте перший тренажер.</span>');
}

function paintFormSubjects(){
  const box = document.getElementById('tr-f-subj'); if(!box) return;
  const opts = subjectOptions(trCatalog, trCache);
  box.innerHTML = opts.length ? opts.map(o => chip(o.key, o.name, trFormSubj.has(o.key), 'trToggleFormSubj')).join('')
    : '<span class="tr-hint">Каталог предметів порожній — його заповнює директор.</span>';
}

function paintList(){
  const box = document.getElementById('tr-list'); if(!box) return;
  const list = filterTrainers(trCache, [...trSel], trQuery);
  const attached = new Set((trPick ? (hwTrainers[trPick.ctx] || []) : []).map(t => t.url));
  if(!(trCache || []).length){ box.innerHTML = '<p class="empty-msg">У базі ще немає тренажерів. Додайте перший нижче.</p>'; return; }
  if(!list.length){ box.innerHTML = '<p class="empty-msg">За цим фільтром нічого немає.</p>'; return; }
  box.innerHTML = list.map(t => {
    const url = safeHttpUrl(t.url);
    const subj = Object.values(t.subjects || {}).map(n => `<span class="tr-tag">${escHtml(n)}</span>`).join('');
    const mine = canManage(t);
    const pickBtn = trPick
      ? (attached.has(t.url)
          ? '<span class="tr-attached">✓ у ДЗ</span>'
          : `<button type="button" class="tr-attach" onclick="trAttach('${escJs(t.id)}')">📎 До ДЗ</button>`)
      : '';
    return `<div class="tr-item">
      <div class="tr-main">
        ${url ? `<a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer" class="tr-link">🎯 ${escHtml(t.title)}</a>` : `<span>🎯 ${escHtml(t.title)}</span>`}
        <div class="tr-tags">${subj}</div>
        <div class="tr-meta">${escHtml(t.byName || '')}</div>
      </div>
      <div class="tr-actions">${pickBtn}
        ${mine ? `<button type="button" class="tr-icon" onclick="editTrainer('${escJs(t.id)}')" aria-label="Редагувати ${escHtml(t.title)}" data-tip="Редагувати">✏️</button>
                 <button type="button" class="tr-icon" onclick="deleteTrainer('${escJs(t.id)}')" aria-label="Видалити ${escHtml(t.title)}" data-tip="Видалити">🗑</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

function paintAll(){ paintFilter(); paintList(); paintFormSubjects(); }

// opts: {pick: {ctx, subject}} — відкрити для прикріплення до ДЗ
window.openTrainers = async function(opts){
  const m = ensureModal();
  trPick = (opts && opts.pick) || null;
  const note = document.getElementById('tr-pick-note');
  if(trPick){
    note.style.display = 'block';
    note.textContent = `📎 Оберіть тренажер для ДЗ${trPick.subject ? ` · ${trPick.subject}` : ''}. Можна кілька.`;
  }else note.style.display = 'none';
  m.style.display = 'flex';
  document.getElementById('tr-list').innerHTML = '<p class="empty-msg is-loading">Завантаження...</p>';
  try{
    await loadAll(true);
  }catch(e){
    document.getElementById('tr-list').innerHTML = `<p class="empty-msg" style="color:var(--danger);">Не вдалося завантажити: ${escHtml(e.message || '')}</p>`;
    return;
  }
  // У режимі ДЗ одразу фільтруємо за предметом уроку — якщо в базі він є.
  trSel = new Set(); trQuery = '';
  const s = document.getElementById('tr-search'); if(s) s.value = '';
  if(trPick && trPick.subject){
    const k = trSubjKey(trPick.subject);
    if((trCache || []).some(t => t.subjects && t.subjects[k])) trSel.add(k);
    if(!trEdit) trFormSubj = new Set([k]);
  }
  paintAll();
  setTimeout(() => document.getElementById('tr-search')?.focus(), 50);
};
window.closeTrainers = function(){
  const m = document.getElementById('trainers-modal'); if(m) m.style.display = 'none';
  trPick = null;
};
window.trSearch = v => { trQuery = v; paintList(); };
window.trClearFilter = () => { trSel.clear(); paintFilter(); paintList(); };
window.trToggleFilter = k => { trSel.has(k) ? trSel.delete(k) : trSel.add(k); paintFilter(); paintList(); };
window.trToggleFormSubj = k => { trFormSubj.has(k) ? trFormSubj.delete(k) : trFormSubj.add(k); paintFormSubjects(); };

window.editTrainer = function(id){
  const t = (trCache || []).find(x => x.id === id); if(!t || !canManage(t)) return;
  trEdit = id; trFormSubj = new Set(Object.keys(t.subjects || {}));
  document.getElementById('tr-f-title').value = t.title || '';
  document.getElementById('tr-f-url').value = t.url || '';
  document.getElementById('tr-form-sum').textContent = '✏️ Редагування тренажера';
  document.getElementById('tr-f-cancel').style.display = 'inline-block';
  const w = document.getElementById('tr-form-wrap'); w.open = true;
  paintFormSubjects();
  w.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};
function resetForm(){
  trEdit = null; trFormSubj = new Set();
  document.getElementById('tr-f-title').value = '';
  document.getElementById('tr-f-url').value = '';
  document.getElementById('tr-form-sum').textContent = '➕ Додати тренажер';
  document.getElementById('tr-f-cancel').style.display = 'none';
  paintFormSubjects();
}
window.cancelTrainerEdit = resetForm;

window.saveTrainer = async function(){
  const title = document.getElementById('tr-f-title').value.trim();
  const url = document.getElementById('tr-f-url').value.trim();
  if(!title) return showToast('⚠️ Вкажіть назву тренажера');
  if(!validTrainerUrl(url)) return showToast('⚠️ Посилання має починатися з https:// або http://');
  if(!trFormSubj.size) return showToast('⚠️ Оберіть хоча б один предмет');
  // Той самий тренажер уже є — не плодимо дублів, а показуємо наявний.
  const dup = (trCache || []).find(t => t.url === url && t.id !== trEdit);
  if(dup) return showToast(`⚠️ Цей тренажер уже є в базі: «${dup.title}»`);
  const names = new Map(subjectOptions(trCatalog, trCache).map(o => [o.key, o.name]));
  const subjects = {}; trFormSubj.forEach(k => { subjects[k] = names.get(k) || k; });
  const btn = document.getElementById('tr-f-save'); if(btn.disabled) return;
  btn.disabled = true;
  try{
    if(trEdit){
      const old = (trCache || []).find(t => t.id === trEdit);
      if(!canManage(old)) throw new Error('Правити може лише автор або директор');
      // subjects — повністю, інакше знятий предмет лишився б у базі
      await update(ref(db, `trainers/${trEdit}`), { title, url, subjects, ts: old.ts || Date.now() });
      showToast('✅ Тренажер оновлено');
    }else{
      await push(ref(db, 'trainers'), { title, url, subjects, by: myKey(),
        byName: String([currentUserData?.firstName, currentUserData?.lastName].filter(Boolean).join(' ') || currentUserData?.email || '').slice(0, 80), ts: Date.now() });
      showToast('🎯 Тренажер додано в базу');
    }
    resetForm();
    document.getElementById('tr-form-wrap').open = false;
    await loadAll(true); paintAll();
  }catch(e){
    showToast(/permission/i.test(e.message || '') ? '⛔ Немає прав на цю дію' : '❌ Не збережено: ' + (e.message || ''));
  }finally{ btn.disabled = false; }
};

window.deleteTrainer = async function(id){
  const t = (trCache || []).find(x => x.id === id); if(!t || !canManage(t)) return;
  // Свій тренажер — «Видалено · Повернути» (undo.js). Чужий (директор
  // прибирає за кимось) — з підтвердженням: правила не дадуть записати
  // його назад від чужого імені, тож і обіцяти «повернути» не можна.
  const own = t.by === myKey() && window.deleteWithUndo;
  if(!own && !confirm(`Видалити «${t.title}» з бази?\n\nУ вже заданих ДЗ посилання залишиться.`)) return;
  try{
    if(own) await window.deleteWithUndo({ paths: { [`trainers/${id}`]: null }, label: `«${t.title}» видалено`,
      onUndo: async () => { await loadAll(true); paintAll(); } });
    else { await remove(ref(db, `trainers/${id}`)); showToast('🗑️ Видалено'); }
    if(trEdit === id) resetForm();
    await loadAll(true); paintAll();
  }catch(e){ showToast('❌ Не видалено: ' + (e.message || '')); }
};

// ── ПРИКРІПЛЕННЯ ДО ДЗ ────────────────────────────────────────
function chipsHtml(ctx){
  const list = hwTrainers[ctx] || [];
  return list.map((t, i) => {
    const u = safeHttpUrl(t.url);
    return `<span class="tr-hw-chip">${u ? `<a href="${escHtml(u)}" target="_blank" rel="noopener noreferrer">🎯 ${escHtml(t.title)}</a>` : `🎯 ${escHtml(t.title)}`}
      <button type="button" onclick="removeHwTrainer('${escJs(ctx)}',${i})" aria-label="Відкріпити ${escHtml(t.title)}">✕</button></span>`;
  }).join('');
}
const boxId = ctx => ctx === 'main' ? 'hw-trainers-main' : `${ctx}-trainers`;
function paintHw(ctx){
  const box = document.getElementById(boxId(ctx)); if(box) box.innerHTML = chipsHtml(ctx);
}
window.getHwTrainers = ctx => hwTrainerCopies(hwTrainers[ctx] || []);
window.setHwTrainers = (ctx, list) => { hwTrainers[ctx] = hwTrainerCopies(list); paintHw(ctx); };
window.removeHwTrainer = (ctx, i) => {
  (hwTrainers[ctx] || []).splice(i, 1); paintHw(ctx);
  if(ctx !== 'main' && window.hwdDirty) window.hwdDirty(ctx);
  showToast('Тренажер відкріплено — збережіть ДЗ');
};
window.pickHwTrainer = (ctx, subject) => window.openTrainers({ pick: { ctx, subject } });
window.trAttach = function(id){
  const t = (trCache || []).find(x => x.id === id); if(!t || !trPick) return;
  const ctx = trPick.ctx;
  hwTrainers[ctx] = hwTrainerCopies([...(hwTrainers[ctx] || []), { title: t.title, url: t.url }]);
  paintHw(ctx); paintList();
  if(ctx !== 'main' && window.hwdDirty) window.hwdDirty(ctx);
  showToast(`📎 «${t.title}» додано до ДЗ — не забудьте зберегти`);
};
