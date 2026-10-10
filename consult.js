// ═══════════════════════════════════════════════════════════════
// consult.js — 🗓 запис на консультацію до вчителя (підхід 9).
//
// ЯК ЦЕ ПРАЦЮЄ
//   Учитель відкриває час: дата, початок, тривалість однієї розмови й
//   скільки їх підряд (напр. 15:00, по 15 хв, 4 → 15:00–15:15 … 15:45–16:00),
//   у школі чи онлайн, для яких класів. Батьки цих класів у вкладці
//   «Школа» бачать вільний час і записуються одним натисканням, можна з
//   темою. Учитель бачить, хто й навіщо записався; батько може скасувати.
//
// ДАНІ (правила — database.rules.gen.py, розділ «Консультації»)
//   consult_slots/{пошта вчителя}/{id}    — час; бачать усі, пише вчитель
//   consult_bookings/{пошта вчителя}/{id} — хто записався; бачать лише цей
//                                           учитель і сам батько
//   consult_taken/{пошта вчителя}/{id}    — «зайнято» без імені для інших
// Запис і «зайнято» пишуться одним update: якщо хтось встиг раніше,
// правила відхилять обидва, і батько побачить «цей час щойно зайняли».
// ═══════════════════════════════════════════════════════════════
import { ref, get, child, update, push } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, auth, currentUserData, getActiveClass, stuId, emailKey, escHtml, escJs, showToast, localDateString } from './common.js';

const pad = n => String(n).padStart(2, '0');
export const toMin = t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
export const toHHMM = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const DAYS = ['неділя', 'понеділок', 'вівторок', 'середа', 'четвер', 'пʼятниця', 'субота'];
export function dayLabel(ds){
  const [y, m, d] = ds.split('-').map(Number);
  return `${DAYS[new Date(y, m - 1, d).getDay()]}, ${pad(d)}.${pad(m)}`;
}
const mySe = () => emailKey((auth.currentUser && auth.currentUser.email) || (currentUserData && currentUserData.email) || '');
const classLabel = cls => {
  const o = document.querySelector(`#t-class-selector option[value="${cls}"]`);
  return o ? o.textContent.trim() : String(cls).replace('class_', '') + ' клас';
};

// ── ЧИСТА ЛОГІКА ─────────────────────────────────────────────────
// Ряд проміжків підряд: start 'HH:MM', len хв, count штук → [{start,end}]
export function makeSlots(start, len, count){
  const s = toMin(start), out = [];
  len = Math.max(5, Math.min(120, Number(len) || 15));
  count = Math.max(1, Math.min(12, Number(count) || 1));
  for(let i = 0; i < count; i++){
    const a = s + i * len, b = a + len;
    if(b > 23 * 60 + 59) break;
    out.push({ start: toHHMM(a), end: toHHMM(b) });
  }
  return out;
}
// Чи ще попереду (сьогодні — лише якщо ще не почалося)
export function isUpcoming(slot, now = new Date()){
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  if(slot.date > today) return true;
  if(slot.date < today) return false;
  return toMin(slot.start) > now.getHours() * 60 + now.getMinutes();
}
// Вільний час для класу: усі вчителі, лише майбутній, без зайнятого
export function freeFor(slots, taken, cls, now = new Date()){
  const out = [];
  for(const se in (slots || {})) for(const id in (slots[se] || {})){
    const s = slots[se][id];
    if(!s || !s.classes || !s.classes[cls] || !isUpcoming(s, now)) continue;
    if(taken && taken[se] && taken[se][id]) continue;
    out.push({ se, id, ...s });
  }
  return out.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}
// Згрупувати за вчителем: [{se, name, subject, slots:[…]}]
export function byTeacher(list){
  const m = new Map();
  list.forEach(s => {
    if(!m.has(s.se)) m.set(s.se, { se: s.se, name: s.name, subject: s.subject || '', slots: [] });
    m.get(s.se).slots.push(s);
  });
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name, 'uk'));
}

const val = p => get(child(ref(db), p)).then(s => s.exists() ? s.val() : null);

// ══ БАТЬКИ: блок у вкладці «Школа» ═══════════════════════════════
let pState = { slots: {}, taken: {}, mine: [] };

export async function renderParentConsult(boxId = 'p-consult'){
  const box = document.getElementById(boxId);
  if(!box || !currentUserData || currentUserData.role !== 'parent') return;
  const head = document.getElementById(boxId + '-h');
  const show = on => { box.hidden = !on; if(head) head.hidden = !on; };
  const cls = getActiveClass(), se = mySe();
  let slots = {}, taken = {};
  try{ [slots, taken] = await Promise.all([val('consult_slots'), val('consult_taken')]); }
  catch(e){ show(false); return; }              // правила ще не опубліковані — тихо ховаємо
  slots = slots || {}; taken = taken || {};
  // Мої записи: перевіряємо лише зайняті слоти свого класу (чужі прочитати
  // правила не дадуть — і не треба)
  const cand = [];
  for(const s in taken) for(const id in taken[s]){ const sl = slots[s] && slots[s][id]; if(sl && sl.classes && sl.classes[cls] && isUpcoming(sl)) cand.push({ se: s, id, ...sl }); }
  const got = await Promise.all(cand.map(c => val(`consult_bookings/${c.se}/${c.id}`).then(b => b && b.by === se ? { ...c, booking: b } : null).catch(() => null)));
  const mine = got.filter(Boolean).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  const free = freeFor(slots, taken, cls);
  pState = { slots, taken, mine };
  if(!free.length && !mine.length){ show(false); box.innerHTML = ''; return; }
  show(true);
  const mineHtml = mine.length ? `<div class="kn-mine">${mine.map(m => `
      <div class="kn-booked"><div><b>${escHtml(dayLabel(m.date))}, ${escHtml(m.start)}–${escHtml(m.end)}</b>
        <small>${escHtml(m.name)}${m.subject ? ' · ' + escHtml(m.subject) : ''} · ${m.mode === 'online' ? 'онлайн' : 'у школі'}${m.place ? ' · ' + escHtml(m.place) : ''}</small>
        ${m.booking.topic ? `<small>Тема: ${escHtml(m.booking.topic)}</small>` : ''}</div>
        <button type="button" class="ui-btn ui-btn-q" onclick="cancelConsult('${escJs(m.se)}','${escJs(m.id)}',this)">Скасувати</button></div>`).join('')}</div>` : '';
  const freeHtml = byTeacher(free).map(t => `
      <div class="kn-teacher"><div class="kn-t-head"><b>${escHtml(t.name)}</b>${t.subject ? `<small>${escHtml(t.subject)}</small>` : ''}</div>
        <div class="kn-times">${t.slots.slice(0, 24).map(s => `<button type="button" class="kn-time" onclick="openBookConsult('${escJs(s.se)}','${escJs(s.id)}')">
          <b>${escHtml(s.start)}</b><span>${escHtml(dayLabel(s.date))}${s.mode === 'online' ? ' · онлайн' : ''}</span></button>`).join('')}</div></div>`).join('');
  box.innerHTML = `${mine.length ? '<h4 class="ui-card-h">Ви записані</h4>' + mineHtml : ''}
    ${free.length ? `<h4 class="ui-card-h"${mine.length ? ' style="margin-top:14px"' : ''}>Вільний час учителів</h4>${freeHtml}` : ''}
    <details class="ui-how"><summary>ℹ️ Як це працює</summary><p>Учителі відкривають час для розмови з батьками. Оберіть зручний — учитель побачить ваш запис і тему.
      Скасувати можна тут же. Інші батьки бачать лише, що час зайнятий, — не хто записався.</p></details>`;
}
window.renderParentConsult = renderParentConsult;

let bookTarget = null;
window.openBookConsult = function(se, id){
  const s = pState.slots[se] && pState.slots[se][id]; if(!s) return;
  bookTarget = { se, id, s };
  let w = document.getElementById('kn-book-sheet');
  if(!w){
    w = document.createElement('div');
    w.id = 'kn-book-sheet'; w.className = 'ui-sheet-wrap'; w.hidden = true;
    w.setAttribute('role', 'dialog'); w.setAttribute('aria-modal', 'true'); w.setAttribute('aria-labelledby', 'kn-book-title');
    w.innerHTML = `<div class="ui-sheet-bg" onclick="closeSheet('kn-book-sheet')"></div><div class="ui-sheet">
      <div class="ui-sheet-grab" aria-hidden="true"></div>
      <button type="button" class="ui-sheet-x" onclick="closeSheet('kn-book-sheet')" aria-label="Закрити">✕</button>
      <h4 id="kn-book-title">Запис на консультацію</h4><p class="kn-when" id="kn-book-when"></p>
      <label class="ui-field"><span>Про що хочете поговорити (необовʼязково)</span>
        <textarea id="kn-book-topic" rows="3" maxlength="300" placeholder="Напр.: оцінки з математики, поведінка на перервах…"></textarea></label>
      <button type="button" class="ui-btn ui-btn-1 ui-wide" id="kn-book-btn" onclick="bookConsult(this)">Записатися</button></div>`;
    document.body.appendChild(w);
  }
  document.getElementById('kn-book-when').textContent =
    `${s.name}${s.subject ? ' (' + s.subject + ')' : ''} · ${dayLabel(s.date)}, ${s.start}–${s.end} · ${s.mode === 'online' ? 'онлайн' : 'у школі'}${s.place ? ' · ' + s.place : ''}`;
  document.getElementById('kn-book-topic').value = '';
  window.openSheet && window.openSheet('kn-book-sheet');
};

window.bookConsult = async function(btn){
  if(!bookTarget) return;
  const { se, id } = bookTarget, cls = getActiveClass(), u = currentUserData || {};
  const rec = { by: mySe(), cls, child: stuId(cls, u.studentName) || u.studentId || u.studentName || '', childName: String(u.studentName || '').slice(0, 120),
    byName: [u.firstName, u.lastName].filter(Boolean).join(' ').slice(0, 120), topic: String(document.getElementById('kn-book-topic').value || '').trim().slice(0, 300), ts: Date.now() };
  if(!rec.topic) delete rec.topic;
  if(!rec.byName) delete rec.byName;
  if(btn){ btn.disabled = true; btn.textContent = 'Записуємо…'; }
  try{
    await update(ref(db), { [`consult_bookings/${se}/${id}`]: rec, [`consult_taken/${se}/${id}`]: true });
    window.closeSheet && window.closeSheet('kn-book-sheet');
    showToast('✅ Ви записані — учитель це побачить');
  }catch(e){
    showToast(/permission/i.test(e.message || '') ? '⚠️ Цей час щойно зайняли — оберіть інший' : '❌ Не вдалося записатися: ' + (e.message || ''));
  }finally{ if(btn){ btn.disabled = false; btn.textContent = 'Записатися'; } }
  renderParentConsult();
};

window.cancelConsult = async function(se, id, btn){
  if(!confirm('Скасувати запис на консультацію?')) return;
  if(btn) btn.disabled = true;
  try{
    await update(ref(db), { [`consult_bookings/${se}/${id}`]: null, [`consult_taken/${se}/${id}`]: null });
    showToast('Запис скасовано');
  }catch(e){ showToast('❌ Не вдалося скасувати: ' + (e.message || '')); }
  renderParentConsult();
};

// ══ УЧИТЕЛЬ: вікно «Консультації» ════════════════════════════════
function ensureTeacherModal(){
  let m = document.getElementById('consult-modal');
  if(m) return m;
  m = document.createElement('div');
  m.id = 'consult-modal'; m.className = 'modal-overlay';
  m.addEventListener('click', e => { if(e.target === m) m.style.display = 'none'; });
  m.innerHTML = `<div class="modal-content kn-modal" role="dialog" aria-modal="true" aria-labelledby="kn-t-title">
    <button type="button" class="ui-sheet-x kn-x" onclick="document.getElementById('consult-modal').style.display='none'" aria-label="Закрити">✕</button>
    <h3 id="kn-t-title" style="margin-top:0">🗓 Консультації для батьків</h3>
    <div class="ui-card kn-form">
      <h4 class="ui-card-h">Відкрити час</h4>
      <div class="kn-grid">
        <label class="ui-field"><span>Дата</span><input type="date" id="kn-date"></label>
        <label class="ui-field"><span>Початок</span><input type="time" id="kn-start" value="15:00" step="300"></label>
        <label class="ui-field"><span>Одна розмова</span><select id="kn-len"><option value="10">10 хв</option><option value="15" selected>15 хв</option><option value="20">20 хв</option><option value="30">30 хв</option></select></label>
        <label class="ui-field"><span>Скільки підряд</span><select id="kn-count">${[1,2,3,4,5,6,8,10,12].map(n => `<option${n === 4 ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
        <label class="ui-field"><span>Де</span><select id="kn-mode"><option value="school">У школі</option><option value="online">Онлайн</option></select></label>
        <label class="ui-field"><span>Кабінет або посилання</span><input type="text" id="kn-place" maxlength="200" placeholder="каб. 12 / посилання на зустріч"></label>
      </div>
      <label class="ui-field"><span>Предмет (необовʼязково)</span><input type="text" id="kn-subject" maxlength="80" placeholder="напр. Математика"></label>
      <div class="ui-field"><span>Для батьків класів</span><div class="kn-classes" id="kn-classes"></div></div>
      <p class="ui-note" id="kn-preview"></p>
      <button type="button" class="ui-btn ui-btn-1" id="kn-add-btn" onclick="addConsultSlots(this)">Відкрити час</button>
    </div>
    <h4 class="ui-card-h">Найближчі консультації</h4>
    <div id="kn-list"><p class="empty-msg is-loading">Завантаження...</p></div>
  </div>`;
  document.body.appendChild(m);
  ['kn-start', 'kn-len', 'kn-count'].forEach(id => m.querySelector('#' + id).addEventListener('change', previewSlots));
  return m;
}
function previewSlots(){
  const list = makeSlots(document.getElementById('kn-start').value || '15:00', document.getElementById('kn-len').value, document.getElementById('kn-count').value);
  const el = document.getElementById('kn-preview');
  if(el) el.textContent = list.length ? `Буде ${list.length}: ${list.map(x => x.start).join(', ')} (до ${list[list.length - 1].end})` : '';
}

window.openConsultTeacher = async function(){
  const m = ensureTeacherModal();
  m.style.display = 'flex';
  const d = document.getElementById('kn-date');
  if(!d.value) d.value = (document.getElementById('global-date') || {}).value || localDateString;
  const sel = document.getElementById('t-class-selector');
  const cur = getActiveClass();
  document.getElementById('kn-classes').innerHTML = (sel ? [...sel.options] : []).filter(o => o.value).map(o =>
    `<label class="kn-cls"><input type="checkbox" value="${escHtml(o.value)}"${o.value === cur ? ' checked' : ''}> ${escHtml(o.textContent.trim())}</label>`).join('')
    || '<p class="ui-note">Немає класів у списку.</p>';
  previewSlots();
  await renderTeacherConsult();
};

window.addConsultSlots = async function(btn){
  const date = document.getElementById('kn-date').value;
  const list = makeSlots(document.getElementById('kn-start').value, document.getElementById('kn-len').value, document.getElementById('kn-count').value);
  const classes = {};
  [...document.getElementById('kn-classes').querySelectorAll('input')].filter(i => i.checked).forEach(i => { classes[i.value] = true; });
  if(!date || !list.length) return showToast('⚠️ Вкажіть дату й час');
  if(!Object.keys(classes).length) return showToast('⚠️ Оберіть хоча б один клас');
  if(!isUpcoming({ date, start: list[0].start })) return showToast('⚠️ Цей час уже минув');
  const u = currentUserData || {};
  const name = ([u.firstName, u.lastName].filter(Boolean).join(' ') || String(u.email || '').split('@')[0]).slice(0, 80);
  const subject = String(document.getElementById('kn-subject').value || '').trim().slice(0, 80);
  const place = String(document.getElementById('kn-place').value || '').trim().slice(0, 200);
  const mode = document.getElementById('kn-mode').value === 'online' ? 'online' : 'school';
  const se = mySe(), patch = {};
  list.forEach(x => {
    const id = push(child(ref(db), `consult_slots/${se}`)).key;
    const rec = { date, start: x.start, end: x.end, name, mode, classes, ts: Date.now() };
    if(subject) rec.subject = subject;
    if(place) rec.place = place;
    patch[`consult_slots/${se}/${id}`] = rec;
  });
  if(btn) btn.disabled = true;
  try{
    await update(ref(db), patch);
    showToast(`✅ Відкрито ${list.length} ${list.length === 1 ? 'проміжок' : 'проміжків'} часу`);
  }catch(e){ showToast('❌ Не збережено: ' + (e.message || '')); }
  finally{ if(btn) btn.disabled = false; }
  await renderTeacherConsult();
};

export function teacherListHtml(slots, bookings, now = new Date()){
  const rows = Object.keys(slots || {}).map(id => ({ id, ...slots[id] })).filter(s => isUpcoming(s, now))
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  if(!rows.length) return '<div class="ui-empty"><b>Відкритого часу немає</b>Додайте час вище — батьки обраних класів побачать його у вкладці «Школа».</div>';
  let html = '', day = '';
  rows.forEach(s => {
    if(s.date !== day){ html += `<div class="kn-day">${escHtml(dayLabel(s.date))}</div>`; day = s.date; }
    const b = bookings && bookings[s.id];
    const cls = Object.keys(s.classes || {}).map(classLabel).join(', ');
    html += `<div class="kn-row${b ? ' booked' : ''}"><b class="kn-hm">${escHtml(s.start)}–${escHtml(s.end)}</b>
      <div class="kn-who">${b ? `<b>${escHtml(b.childName || 'Учень')}</b> <small>${escHtml(classLabel(b.cls))}${b.byName ? ' · ' + escHtml(b.byName) : ''} · ${escHtml(String(b.by || '').replace(/_/g, '.'))}</small>${b.topic ? `<small>Тема: ${escHtml(b.topic)}</small>` : ''}`
        : `<span class="kn-free">вільно</span> <small>${escHtml(cls)}${s.mode === 'online' ? ' · онлайн' : ''}${s.place ? ' · ' + escHtml(s.place) : ''}</small>`}</div>
      <button type="button" class="ui-btn ui-btn-q" onclick="removeConsultSlot('${escJs(s.id)}',${b ? 'true' : 'false'})" aria-label="Прибрати ${escHtml(s.start)}">Прибрати</button></div>`;
  });
  return html;
}
let tState = { slots: {}, bookings: {} };
async function renderTeacherConsult(){
  const box = document.getElementById('kn-list'); if(!box) return;
  const se = mySe();
  try{
    const [slots, bookings] = await Promise.all([val(`consult_slots/${se}`), val(`consult_bookings/${se}`)]);
    tState = { slots: slots || {}, bookings: bookings || {} };
    // Прибираємо свої проміжки, старші за 30 днів: батьки читають усі
    // consult_slots, і без прибирання вузол ріс би весь рік
    const old = new Date(); old.setDate(old.getDate() - 30);
    const cut = `${old.getFullYear()}-${pad(old.getMonth() + 1)}-${pad(old.getDate())}`;
    const stale = Object.keys(tState.slots).filter(id => (tState.slots[id] || {}).date < cut);
    if(stale.length){
      const patch = {};
      stale.forEach(id => { patch[`consult_slots/${se}/${id}`] = null; patch[`consult_bookings/${se}/${id}`] = null; patch[`consult_taken/${se}/${id}`] = null; delete tState.slots[id]; });
      update(ref(db), patch).catch(() => {});
    }
    box.innerHTML = teacherListHtml(tState.slots, tState.bookings);
  }catch(e){ box.innerHTML = `<p class="empty-msg">Не вдалося завантажити: ${escHtml(e.message || '')}</p>`; }
}
window.renderTeacherConsult = renderTeacherConsult;

window.removeConsultSlot = async function(id, bookedShown){
  const se = mySe();
  // Перечитуємо запис: батьки могли записатися, поки список був відкритий
  // (інакше прибрали б лише час, а «ви записані» в батька лишилося б)
  let booked = bookedShown;
  try{ booked = !!(await val(`consult_bookings/${se}/${id}`)) || !!(await val(`consult_taken/${se}/${id}`)); }catch(e){}
  const paths = { [`consult_slots/${se}/${id}`]: null, [`consult_bookings/${se}/${id}`]: null, [`consult_taken/${se}/${id}`]: null };
  try{
    if(booked){
      // На цей час уже записалися батьки — повертати мовчки не можна: вони
      // вже бачили «ви записані». Тож питаємо й радимо попередити.
      if(!confirm('На цей час уже записалися батьки. Прибрати разом із записом?\n\nПопередьте їх, будь ласка, в повідомленнях.')) return;
      await update(ref(db), paths);
      showToast('Прибрано');
    } else if(window.deleteWithUndo){
      await window.deleteWithUndo({ paths: { [`consult_slots/${se}/${id}`]: null }, label: 'Час консультації прибрано', onUndo: renderTeacherConsult });
    } else await update(ref(db), paths);
  }catch(e){ showToast('❌ Не вдалося: ' + (e.message || '')); }
  renderTeacherConsult();
};
