// ═══════════════════════════════════════════════════════════════
// ideas.js — 💡 Банк ідей: анонімні ідеї, скарги й подяки школі.
//
// ХТО ПИШЕ. Батьки, учні й працівники школи — з кабінету.
// ХТО ЧИТАЄ. Лише директор і адміністрація (ideas/ — правило ADMIN).
//
// ЧОМУ ЦЕ СПРАВДІ АНОНІМНО — і чого саме ми НЕ зберігаємо:
//   • ні uid, ні пошти, ні імені, ні класу, ні дитини;
//   • ключ запису — випадковий (crypto), а НЕ push(): push-ключ Firebase
//     містить мілісекунди створення, і за ним можна було б зіставити
//     запис із тим, хто саме тоді був у порталі;
//   • замість часу — лише дата (день);
//   • «Хто я» — необовʼязково й лише загально (батьки / учень / працівник),
//     за замовчуванням «не вказувати»; правила не дадуть вказати чужу групу;
//   • не викликаємо logAction — журнал дій знав би, хто надіслав;
//   • push директору (notifyEvent 'idea') несе ЛИШЕ випадковий ключ:
//     сервер сам читає з бази вид звернення й шле «💡 Нова скарга».
//     Ні тексту, ні автора в запиті немає. Наслідок, про який школа
//     знає: директор бачить, КОЛИ прийшло звернення (момент push).
// Номер звернення (той самий випадковий ключ) лишається ЛИШЕ на цьому
// пристрої (localStorage) — щоб автор бачив статус і відповідь школи.
// Без номера прочитати запис не може ніхто, крім адміністрації.
//
// ЧЕСНО ПРО МЕЖІ. Портал не знає автора, але текст — знає: якщо людина
// напише «я мама Марка з 3-А», анонімності не буде (підказку про це у
// вікні прибрали на прохання школи — текст і так очевидний).
//
// СПОВІЩЕННЯ (дзвіночок, notif-center.js):
//   • автору — «школа відповіла / змінила статус»: його пристрій сам
//     перевіряє свої квитанції; сервер не знає, кому що належить;
//   • директору й адміністрації — «нове звернення» (статус 'new', якого
//     вони ще не бачили на цьому пристрої).
// Час відповіді й зміни статусу (replyTs, statusTs) — це дії школи, а не
// автора, тож їх зберігаємо точно: інакше «нове» в дзвіночку не працює.
// Захисту від флуду на сервері немає (без автора його не збудувати):
// лише ліміт на пристрої (5 на день) і довжина тексту в правилах.
// ═══════════════════════════════════════════════════════════════
import { ref, get, set, update, remove } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, currentUserData, escHtml, showToast, isTeacherRole, notifyEvent } from './common.js';

export const KINDS = { idea: '💡 Ідея', complaint: '😟 Скарга', thanks: '💛 Подяка' };
export const TOPICS = { learning: 'Навчання', food: 'Харчування', safety: 'Безпека', events: 'Заходи й гуртки', portal: 'Портал', other: 'Інше' };
export const STATUSES = { new: 'Нове', seen: 'Переглянуто', planned: 'Заплановано', done: 'Зроблено', declined: 'Не плануємо' };
export const WHO = { parent: 'Батьки', student: 'Учень / учениця', staff: 'Працівник школи' };
export const MAX_TEXT = 2000, MIN_TEXT = 5, DAY_LIMIT = 5;
const RKEY = 'push_idea_receipts';

const pad = n => String(n).padStart(2, '0');
export const today = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const human = ds => ds ? ds.split('-').reverse().join('.') : '';

// Випадковий ключ: 24 знаки [a-z0-9], ~124 біти — вгадати неможливо
export function randomId(n = 24){
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const a = new Uint8Array(n);
  (globalThis.crypto || window.crypto).getRandomValues(a);
  return Array.from(a, x => abc[x % 36]).join('');
}

// До якої загальної групи належить роль (для «Хто я»)
export function whoGroup(role){
  if(role === 'parent') return 'parent';
  if(role === 'student') return 'student';
  if(role && (isTeacherRole(role) || ['director', 'administrator', 'kitchen', 'organizer'].includes(role) || /^cr_/.test(role))) return 'staff';
  return '';
}
export const isAdmin = role => role === 'director' || role === 'administrator';

// Запис — рівно ці поля і нічого більше (правила теж не пропустять зайвого)
export function buildIdea({ kind, topic, who, text }, role, day = today()){
  const t = String(text || '').trim();
  if(!KINDS[kind]) throw new Error('kind');
  if(t.length < MIN_TEXT) throw new Error('short');
  if(t.length > MAX_TEXT) throw new Error('long');
  const w = who && who === whoGroup(role) ? who : '';
  return { kind, topic: TOPICS[topic] ? topic : 'other', who: w, text: t, day, status: 'new' };
}

// ── квитанції на пристрої ──
function receipts(){ try{ return JSON.parse(localStorage.getItem(RKEY) || '[]') || []; }catch(e){ return []; } }
function saveReceipts(a){ try{ localStorage.setItem(RKEY, JSON.stringify(a.slice(-30))); }catch(e){} }
export const sentToday = (list = receipts(), day = today()) => list.filter(r => r.day === day).length;

// ── вікно надсилання ──
let ov = null;
function overlay(id){
  let o = document.getElementById(id);
  if(o) return o;
  o = document.createElement('div');
  o.id = id; o.className = 'modal-overlay ib-overlay'; o.style.zIndex = '1015';
  o.innerHTML = '<div class="modal-content ib-modal"></div>';
  o.addEventListener('click', e => { if(e.target === o) o.style.display = 'none'; });
  document.body.appendChild(o);
  return o;
}
const opts = (obj, sel) => Object.entries(obj).map(([k, v]) => `<option value="${k}"${k === sel ? ' selected' : ''}>${escHtml(v)}</option>`).join('');

export const ANON_NOTE = `<div class="ib-anon" role="note">
  <b>🔒 Повністю анонімно</b>
  <p>Портал не записує, хто надіслав: ні імені, ні пошти, ні класу — лише сам текст.
  Школа не може дізнатися автора — ні директор, ні адміністратор, ні розробник порталу.</p>
</div>`;

export async function openIdeaBank(){
  const role = currentUserData && currentUserData.role;
  const grp = whoGroup(role);
  ov = overlay('idea-bank-modal');
  const mc = ov.querySelector('.modal-content');
  mc.innerHTML = `
    <h2 class="ib-h">💡 Банк ідей</h2>
    <p class="ib-sub">Ідея, як зробити школу кращою, скарга чи подяка — школа прочитає кожне звернення.</p>
    ${ANON_NOTE}
    <div class="ib-kinds" role="radiogroup" aria-label="Що надсилаєте">
      ${Object.entries(KINDS).map(([k, v], i) => `<label class="ib-kind"><input type="radio" name="ib-kind" value="${k}"${i ? '' : ' checked'}><span>${escHtml(v)}</span></label>`).join('')}
    </div>
    <div class="ib-row">
      <label>Тема<select id="ib-topic">${opts(TOPICS, 'other')}</select></label>
      <label>Хто я <small>(необовʼязково)</small><select id="ib-who"><option value="">Не вказувати</option>${grp ? `<option value="${grp}">${escHtml(WHO[grp])}</option>` : ''}</select></label>
    </div>
    <label for="ib-text">Текст</label>
    <textarea id="ib-text" rows="5" maxlength="${MAX_TEXT}" placeholder="Напишіть, що варто змінити або що вам сподобалось"></textarea>
    <div class="ib-count"><span id="ib-n">0</span> / ${MAX_TEXT}</div>
    <p id="ib-msg" class="ib-msg" role="status"></p>
    <button type="button" id="ib-send" class="ib-send">📨 Надіслати анонімно</button>
    <button type="button" class="ib-cancel" onclick="document.getElementById('idea-bank-modal').style.display='none'">Закрити</button>
    <div id="ib-mine"></div>`;
  const ta = mc.querySelector('#ib-text');
  ta.addEventListener('input', () => { mc.querySelector('#ib-n').textContent = ta.value.length; });
  mc.querySelector('#ib-send').onclick = () => sendIdea(mc, role);
  ov.style.display = 'flex';
  renderMine(mc.querySelector('#ib-mine'));
  setTimeout(() => ta.focus(), 50);
}

async function sendIdea(mc, role){
  const msg = mc.querySelector('#ib-msg'), btn = mc.querySelector('#ib-send');
  const say = (t, bad) => { msg.textContent = t; msg.classList.toggle('bad', !!bad); };
  if(sentToday() >= DAY_LIMIT) return say(`Сьогодні з цього пристрою вже надіслано ${DAY_LIMIT} звернень. Спробуйте завтра.`, true);
  let rec;
  try{
    rec = buildIdea({
      kind: (mc.querySelector('input[name="ib-kind"]:checked') || {}).value,
      topic: mc.querySelector('#ib-topic').value,
      who: mc.querySelector('#ib-who').value,
      text: mc.querySelector('#ib-text').value
    }, role);
  }catch(e){
    return say(e.message === 'short' ? 'Напишіть хоча б кілька слів.' : e.message === 'long' ? `Не більше ${MAX_TEXT} знаків.` : 'Оберіть, що надсилаєте.', true);
  }
  btn.disabled = true;
  const id = randomId();
  try{
    await set(ref(db, `ideas/${id}`), rec);
    const list = receipts(); list.push({ id, day: rec.day, kind: rec.kind }); saveReceipts(list);
    // Push директору — лише ключ запису; сервер сам дізнається вид із бази
    Promise.resolve().then(() => notifyEvent('idea', { ref: id })).catch(() => {});
    mc.querySelector('#ib-text').value = ''; mc.querySelector('#ib-n').textContent = '0';
    say('✓ Надіслано анонімно. Дякуємо! Статус і відповідь школи — нижче, у «Мої звернення».');
    renderMine(mc.querySelector('#ib-mine'));
  }catch(e){
    say('❌ Не надіслано: ' + (e.message || ''), true);
  }finally{ btn.disabled = false; }
}

// Мої звернення — лише з квитанцій цього пристрою
async function renderMine(box){
  if(!box) return;
  const list = receipts().slice().reverse();
  if(!list.length){ box.innerHTML = ''; return; }
  const rows = await Promise.all(list.slice(0, 10).map(r =>
    get(ref(db, `ideas/${r.id}`)).then(s => s.exists() ? { ...s.val(), id: r.id } : { ...r, gone: true }).catch(() => ({ ...r, gone: true }))));
  box.innerHTML = `<h4 class="ib-mine-h">Мої звернення <small>(видно лише на цьому пристрої)</small></h4>` + rows.map(x => `
    <div class="ib-mine-it">
      <div class="ib-meta"><span>${escHtml(KINDS[x.kind] || '')}</span><span>${escHtml(human(x.day))}</span>
        <span class="ib-st ib-st-${x.gone ? 'gone' : escHtml(x.status || 'new')}">${x.gone ? 'Закрито' : escHtml(STATUSES[x.status] || STATUSES.new)}</span></div>
      ${x.text ? `<p class="ib-text" data-no-i18n>${escHtml(x.text.length > 160 ? x.text.slice(0, 160) + '…' : x.text)}</p>` : ''}
      ${x.reply ? `<div class="ib-reply"><b>Відповідь школи${x.replyDay ? ` · ${escHtml(human(x.replyDay))}` : ''}:</b><p data-no-i18n>${escHtml(x.reply)}</p></div>` : ''}
    </div>`).join('');
}

// ── адміністрація: скринька ──
let all = {}, filt = 'open';
export function sortIdeas(obj){
  return Object.entries(obj || {}).map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => (b.day || '').localeCompare(a.day || '') || a.id.localeCompare(b.id));
}
export function filterIdeas(list, f){
  if(f === 'open') return list.filter(x => x.status === 'new' || x.status === 'seen' || x.status === 'planned' || !x.status);
  if(f === 'new') return list.filter(x => !x.status || x.status === 'new');
  if(KINDS[f]) return list.filter(x => x.kind === f);
  return list;
}

export async function openIdeaInbox(){
  if(!isAdmin(currentUserData && currentUserData.role)) return;
  const o = overlay('idea-inbox-modal');
  // Кабінет директора поки не перекладається (i18n.js) — скринька теж
  o.setAttribute('data-no-i18n', '');
  const mc = o.querySelector('.modal-content');
  mc.classList.add('ib-wide');
  mc.innerHTML = `<h2 class="ib-h">💡 Банк ідей</h2>
    <p class="ib-sub">Анонімні звернення батьків, учнів і працівників. Автора не знає ніхто — відповідь побачить лише він сам, у своєму вікні «Банк ідей».</p>
    <div class="ib-filters" role="tablist">
      ${[['open', 'Відкриті'], ['new', 'Нові'], ['idea', '💡 Ідеї'], ['complaint', '😟 Скарги'], ['thanks', '💛 Подяки'], ['all', 'Усі']]
        .map(([k, v]) => `<button type="button" data-f="${k}" class="${k === filt ? 'on' : ''}">${escHtml(v)}</button>`).join('')}
    </div>
    <div id="ib-list"><p class="empty-msg is-loading">Завантаження...</p></div>
    <button type="button" class="ib-cancel" onclick="document.getElementById('idea-inbox-modal').style.display='none'">Закрити</button>`;
  mc.querySelector('.ib-filters').addEventListener('click', e => {
    const b = e.target.closest('[data-f]'); if(!b) return;
    filt = b.dataset.f;
    mc.querySelectorAll('.ib-filters button').forEach(x => x.classList.toggle('on', x === b));
    paintInbox(mc);
  });
  mc.addEventListener('click', e => onInboxClick(e, mc));
  o.style.display = 'flex';
  try{ const s = await get(ref(db, 'ideas')); all = s.exists() ? s.val() : {}; }
  catch(e){ mc.querySelector('#ib-list').innerHTML = `<p class="empty-msg">Не вдалося завантажити: ${escHtml(e.message || '')}</p>`; return; }
  paintInbox(mc); paintBadge();
  markIdeasSeen(adminItems(all, new Set()));
  if(window.refreshNotifs) window.refreshNotifs();
}

function paintInbox(mc){
  const list = filterIdeas(sortIdeas(all), filt);
  const box = mc.querySelector('#ib-list');
  if(!list.length){ box.innerHTML = '<p class="empty-msg">Звернень немає.</p>'; return; }
  box.innerHTML = list.map(x => `
    <article class="ib-item ib-k-${escHtml(x.kind)}" data-id="${escHtml(x.id)}">
      <div class="ib-meta"><b>${escHtml(KINDS[x.kind] || '')}</b><span>${escHtml(TOPICS[x.topic] || TOPICS.other)}</span>
        ${x.who ? `<span>${escHtml(WHO[x.who] || '')}</span>` : '<span>Анонімно</span>'}<span>${escHtml(human(x.day))}</span></div>
      <p class="ib-text" data-no-i18n>${escHtml(x.text || '')}</p>
      <div class="ib-ctl">
        <select data-act="status" aria-label="Статус">${opts(STATUSES, x.status || 'new')}</select>
        <button type="button" data-act="del" class="ib-del" title="Видалити">🗑</button>
      </div>
      <details class="ib-ans"${x.reply ? ' open' : ''}><summary>${x.reply ? 'Відповідь школи' : '✍️ Відповісти автору'}</summary>
        <textarea rows="3" maxlength="1000" data-no-i18n placeholder="Відповідь побачить лише автор">${escHtml(x.reply || '')}</textarea>
        <button type="button" data-act="reply">Зберегти відповідь</button>
      </details>
    </article>`).join('');
  box.querySelectorAll('select[data-act="status"]').forEach(s => s.addEventListener('change', () => setStatus(s.closest('[data-id]').dataset.id, s.value)));
}

async function setStatus(id, st){
  try{ const u = { status: st, statusTs: Date.now() }; await update(ref(db, `ideas/${id}`), u); Object.assign(all[id], u); showToast('✓ Статус змінено'); paintBadge(); }
  catch(e){ showToast('❌ Не збережено: ' + (e.message || '')); }
}
async function onInboxClick(e, mc){
  const b = e.target.closest('button[data-act]'); if(!b) return;
  const id = b.closest('[data-id]') && b.closest('[data-id]').dataset.id; if(!id) return;
  if(b.dataset.act === 'del'){
    if(!confirm('Видалити це звернення назавжди?')) return;
    try{ await remove(ref(db, `ideas/${id}`)); delete all[id]; paintInbox(mc); paintBadge(); }
    catch(err){ showToast('❌ Не видалено: ' + (err.message || '')); }
  }
  if(b.dataset.act === 'reply'){
    const t = b.parentElement.querySelector('textarea').value.trim();
    const upd = t ? { reply: t, replyDay: today(), replyTs: Date.now(), status: all[id].status === 'new' ? 'seen' : all[id].status, statusTs: Date.now() }
                  : { reply: null, replyDay: null, replyTs: null };
    try{ await update(ref(db, `ideas/${id}`), upd); Object.assign(all[id], upd); showToast(t ? '✓ Відповідь збережено — її побачить автор' : '✓ Відповідь прибрано'); paintInbox(mc); paintBadge(); }
    catch(err){ showToast('❌ Не збережено: ' + (err.message || '')); }
  }
}

// ── Для центру сповіщень (notif-center.js) ──
const cutTxt = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const SEEN_KEY = 'push_ideas_seen';
const seenSet = () => { try{ return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')); }catch(e){ return new Set(); } };
// Автору: відповіді й зміни статусу на його звернення (лише з квитанцій)
export function authorItems(recs, from){
  const out = [];
  (recs || []).forEach(x => {
    if(!x || x.gone) return;
    if(x.reply && Number(x.replyTs) >= from)
      out.push({ id: `ia:${x.id}:r`, kind: 'idea', icon: '💡', ts: Number(x.replyTs),
        title: 'Школа відповіла на ваше звернення', sub: cutTxt(x.reply, 90), go: { ideas: 'mine' } });
    else if(x.status && x.status !== 'new' && Number(x.statusTs) >= from)
      out.push({ id: `ia:${x.id}:s`, kind: 'idea', icon: '💡', ts: Number(x.statusTs),
        title: `Ваше звернення: ${STATUSES[x.status] || ''}`, sub: cutTxt(x.text, 90), go: { ideas: 'mine' } });
  });
  return out;
}
// Адміністрації: нові звернення, яких ще не бачили на цьому пристрої.
// Час — лише день (так зберігаємо), тому «нове» визначає не час, а fresh.
export function adminItems(obj, seen = new Set()){
  return sortIdeas(obj).filter(x => !x.status || x.status === 'new').map(x => ({
    id: `in:${x.id}`, kind: 'idea', icon: '💡', ts: Math.min(Date.now(), new Date(`${x.day}T12:00:00`).getTime() || Date.now()),
    fresh: !seen.has(x.id), title: `Банк ідей: ${KINDS[x.kind] || ''}`.trim(), sub: cutTxt(x.text, 90), go: { ideas: 'inbox' } }));
}
export async function loadIdeaItems(role, from){
  if(isAdmin(role)){
    try{ const s = await get(ref(db, 'ideas')); all = s.exists() ? s.val() : {}; paintBadge(); }catch(e){ return []; }
    return adminItems(all, seenSet());
  }
  const list = receipts();
  if(!list.length) return [];
  const recs = await Promise.all(list.slice(-15).map(r =>
    get(ref(db, `ideas/${r.id}`)).then(s => s.exists() ? { ...s.val(), id: r.id } : null).catch(() => null)));
  return authorItems(recs.filter(Boolean), from);
}
// Директор відкрив список сповіщень — нові звернення вже «побачені»
export function markIdeasSeen(items){
  const s = seenSet(); let ch = false;
  (items || []).forEach(it => { if(it.fresh && /^in:/.test(it.id)){ s.add(it.id.slice(3)); ch = true; } });
  if(ch) try{ localStorage.setItem(SEEN_KEY, JSON.stringify([...s].slice(-500))); }catch(e){}
}

// Лічильник нових на кнопці «Банк ідей» у директора / адміністрації
export const countNew = obj => Object.values(obj || {}).filter(x => x && (!x.status || x.status === 'new')).length;
function paintBadge(){
  const n = countNew(all);
  document.querySelectorAll('.ib-badge').forEach(b => { b.textContent = n; b.hidden = !n; });
}
async function refreshBadge(){
  if(!isAdmin(currentUserData && currentUserData.role)) return;
  try{ const s = await get(ref(db, 'ideas')); all = s.exists() ? s.val() : {}; paintBadge(); }catch(e){}
}
// Кабінет визначає роль після входу — дочекаємося й оновимо лічильник
let tries = 0;
const wait = setInterval(() => {
  if(currentUserData || ++tries > 60){ clearInterval(wait); refreshBadge(); openFromPush(); }
}, 1000);
document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible') refreshBadge(); });
// Директор натиснув push «💡 Банк ідей» (netlify/functions/notify.js,
// тип 'idea', веде на ?open=ideas) — одразу відкриваємо скриньку
function openFromPush(){
  if(!/[?&]open=ideas\b/.test(location.search) || !isAdmin(currentUserData && currentUserData.role)) return;
  setTimeout(() => openIdeaInbox(), 600);
  try{ history.replaceState(null, '', location.pathname + location.search.replace(/([?&])open=ideas\b&?/, '$1').replace(/[?&]$/, '') + location.hash); }catch(e){}
}

window.openIdeaBank = openIdeaBank;
window.ideasForNotifs = loadIdeaItems;
window.markIdeasSeen = markIdeasSeen;
window.openIdeaInbox = openIdeaInbox;
