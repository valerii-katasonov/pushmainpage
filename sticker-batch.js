// ═══════════════════════════════════════════════════════════════
// sticker-batch.js — 🌟 «Наліпки класу»: швидкий журнал для наліпок.
//
// НАВІЩО. Наліпка видавалася по одному учню: відкрити учня → наліпка →
// «Дати». Після вдалого уроку, коли наліпку заслужили п'ятеро, це п'ять
// кругів. Тут — увесь клас списком, у кожного − / число / +, предмет (або
// «Інше» з причиною) один на всіх, і одне «Видати».
//
// ДАНІ — ті самі, що в одиночної наліпки (teacher.js → giveStickerToStudent):
// stickers/{клас}/{учень}/{ключ} = stickerRecord(...). Кілька наліпок одному
// учню — з міткою пачки (batch), щоб родина бачила «×3» одним рядком.
// Усе — ОДНИМ записом у базу: обірветься зв'язок — не буде половини класу.
// ═══════════════════════════════════════════════════════════════
import { ref, child, push, update } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, auth, currentUserData, getActiveClass, showToast, escHtml, stuName } from './common.js';
import { fillActionSubject, actionSubject, stickerRecord, stickerWord, STICKER_BATCH_MAX } from './teacher.js';

// ── ЧИСТА ЧАСТИНА ───────────────────────────────────────────────
// counts {sid: n} → шляхи для update. newKey() — ключ нового запису.
export function batchPaths(cls, counts, base, newKey, now = Date.now()){
  const paths = {};
  let students = 0, total = 0;
  for(const sid in counts){
    const n = Math.max(0, Math.min(STICKER_BATCH_MAX, Number(counts[sid]) || 0));
    if(!n) continue;
    students++; total += n;
    const rec = { ...base };
    if(n > 1) rec.batch = `${now.toString(36)}${Math.random().toString(36).slice(2, 7)}${students}`;
    for(let i = 0; i < n; i++) paths[`stickers/${cls}/${sid}/${newKey(sid)}`] = rec;
  }
  return { paths, students, total };
}

// ── ВІКНО ───────────────────────────────────────────────────────
let counts = {}, saving = false;
function overlay(){
  let o = document.getElementById('sticker-batch-modal');
  if(o) return o;
  o = document.createElement('div');
  o.id = 'sticker-batch-modal'; o.className = 'modal-overlay'; o.style.zIndex = '1012';
  o.innerHTML = `<div class="modal-content sb2-modal">
    <h2 class="sb2-h">🌟 Наліпки класу</h2>
    <p class="sb2-sub">Кому скільки — плюсом. Предмет один на всіх. Видається одним натиском.</p>
    <label class="sb2-fld">За що<select id="sb2-subject"></select></label>
    <label class="sb2-fld" id="sb2-other-wrap" hidden>Причина<input type="text" id="sb2-other" maxlength="160" placeholder="Наприклад, допомогли прибрати клас"></label>
    <div class="sb2-tools"><button type="button" data-sb2="all">+1 усім</button><button type="button" data-sb2="clear">Скинути</button></div>
    <div id="sb2-list" class="sb2-list"></div>
    <p id="sb2-msg" class="sb2-msg" role="status"></p>
    <button type="button" id="sb2-save" class="sb2-save">🌟 Видати</button>
    <button type="button" class="sb2-cancel" data-sb2="close">Скасувати</button>
  </div>`;
  o.addEventListener('click', e => {
    if(e.target === o) return close();
    const b = e.target.closest('[data-sb2]'); if(!b) return;
    const act = b.dataset.sb2, sid = b.dataset.sid;
    if(act === 'close') return close();
    if(act === 'all') document.querySelectorAll('#sb2-list .sb2-row').forEach(r => { counts[r.dataset.sid] = Math.min(STICKER_BATCH_MAX, (counts[r.dataset.sid] || 0) + 1); });
    if(act === 'clear') counts = {};
    if(act === 'plus') counts[sid] = Math.min(STICKER_BATCH_MAX, (counts[sid] || 0) + 1);
    if(act === 'minus') counts[sid] = Math.max(0, (counts[sid] || 0) - 1);
    paint();
  });
  o.querySelector('#sb2-subject').addEventListener('change', syncOther);
  o.querySelector('#sb2-save').addEventListener('click', save);
  document.body.appendChild(o);
  return o;
}
function close(){ const o = document.getElementById('sticker-batch-modal'); if(o) o.style.display = 'none'; }
function syncOther(){
  const other = document.getElementById('sb2-subject').value === 'Інше';
  document.getElementById('sb2-other-wrap').hidden = !other;
}
// Учні — з поля «Учень» (наповнює loadStudentsList), як і список у «Класі»
function students(){
  const sel = document.getElementById('t-student');
  return [...((sel && sel.options) || [])].filter(o => o.value).map(o => ({ sid: o.value, name: o.textContent.trim() }));
}
function paint(){
  const box = document.getElementById('sb2-list');
  const list = students();
  if(!list.length){ box.innerHTML = '<p class="empty-msg">У класі ще немає учнів.</p>'; return; }
  box.innerHTML = list.map((s, i) => {
    const n = counts[s.sid] || 0;
    return `<div class="sb2-row${n ? ' on' : ''}" data-sid="${escHtml(s.sid)}">
      <span class="sb2-n">${i + 1}</span><span class="sb2-name">${escHtml(s.name)}</span>
      <button type="button" class="sb2-b" data-sb2="minus" data-sid="${escHtml(s.sid)}" aria-label="Мінус наліпка: ${escHtml(s.name)}" ${n ? '' : 'disabled'}>−</button>
      <b class="sb2-c">${n ? n : '·'}</b>
      <button type="button" class="sb2-b plus" data-sb2="plus" data-sid="${escHtml(s.sid)}" aria-label="Плюс наліпка: ${escHtml(s.name)}" ${n >= STICKER_BATCH_MAX ? 'disabled' : ''}>+</button>
    </div>`;
  }).join('');
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const who = Object.values(counts).filter(Boolean).length;
  const btn = document.getElementById('sb2-save');
  btn.textContent = total ? `🌟 Видати: ${total} ${stickerWord(total)} · учнів ${who}` : '🌟 Видати';
  btn.disabled = !total || saving;
}

export async function openStickerBatch(){
  const o = overlay();
  counts = {};
  document.getElementById('sb2-msg').textContent = '';
  document.getElementById('sb2-other').value = '';
  // Предмети — як у наліпки учня: каталог класу + «Інше»
  const sel = document.getElementById('sb2-subject');
  await fillActionSubject('sb2-subject', actionSubject('t-sticker-subject'));
  if(![...sel.options].some(x => x.value === 'Інше')) sel.insertAdjacentHTML('beforeend', '<option value="Інше">Інше — вказати причину</option>');
  syncOther();
  o.style.display = 'flex';
  paint();
}
window.openStickerBatch = openStickerBatch;

async function save(){
  if(saving) return;
  const cls = getActiveClass(), msg = document.getElementById('sb2-msg');
  const date = (document.getElementById('global-date') || {}).value;
  let base;
  try{
    base = stickerRecord(document.getElementById('sb2-subject').value, document.getElementById('sb2-other').value, date, auth.currentUser?.uid || '');
    base.byName = ([currentUserData?.firstName, currentUserData?.lastName].filter(Boolean).join(' ').trim()
      || auth.currentUser?.displayName || currentUserData?.email || auth.currentUser?.email || 'Учитель').slice(0, 120);
  }catch(e){ msg.textContent = '⚠️ ' + e.message; return; }
  const { paths, students: who, total } = batchPaths(cls, counts, base, sid => push(child(ref(db), `stickers/${cls}/${sid}`)).key);
  if(!total){ msg.textContent = 'Нікому не додано жодної наліпки.'; return; }
  const big = Object.entries(counts).filter(([, n]) => n >= 5);
  if(big.length && !confirm(`Багато наліпок одному учню: ${big.map(([sid, n]) => `${stuName(cls, sid)} — ${n}`).join(', ')}. Видати?`)) return;
  saving = true; paint();
  const btn = document.getElementById('sb2-save'); btn.textContent = '⏳ Видаю...';
  try{
    await update(ref(db), paths);
    showToast(`🌟 Видано ${total} ${stickerWord(total)} · учнів: ${who}`);
    close();
  }catch(e){
    msg.textContent = /permission[_ ]denied/i.test(e.message || '') ? '⛔ Немає прав видавати наліпки в цьому класі' : '❌ Не видано: ' + (e.message || '');
  }finally{ saving = false; if(document.getElementById('sticker-batch-modal')?.style.display === 'flex') paint(); }
}
