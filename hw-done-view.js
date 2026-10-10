// ═══════════════════════════════════════════════════════════════
// hw-done-view.js — «✓ Виконання ДЗ» для вчителя.
//
// ЩО ЦЕ. Родина (батько чи сам учень) позначає ДЗ «виконаним» у своїй
// вкладці «ДЗ» (homework.js → hw_done). Учитель бачить це ТУТ, коли сам
// захоче: за останні два тижні по кожному заданню — скільки позначили,
// хто саме й коли, і хто ще ні.
//
// СПОВІЩЕНЬ НЕ НАДСИЛАЄМО — свідомо. Позначка «виконано» — щоденна дрібниця
// від кожної дитини з кожного предмета; push на кожну означав би десятки
// повідомлень щодня, і вчитель просто вимкнув би всі сповіщення порталу.
//
// ЩО БАЧИТЬ ХТО. Предметник — свої предмети в класі (матриця доступу),
// класний керівник і адміністрація — усі предмети класу.
// Позначка — слово родини, а не перевірка: так і підписано у вікні.
// ═══════════════════════════════════════════════════════════════
import { db, auth, currentUserData, escHtml, escJs, getActiveClass, getDateRange, teacherAccessMatrix,
         isHeadOf, getStudentDir, subjKey, localDateString, canonSid } from './common.js';

export const WINDOW_DAYS = 14;
const ALL = 'Всі предмети';
const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const isAdminRole = r => r === 'director' || r === 'administrator';
const pad = n => String(n).padStart(2, '0');
const human = ds => ds.slice(0, 10).split('-').reverse().slice(0, 2).join('.');
const daysAgo = (ds, n) => { const [y, m, d] = ds.split('-').map(Number); const t = new Date(y, m - 1, d - n); return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`; };
const fmt = ts => ts ? new Date(ts).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';

// Чи є в записі ДЗ хоч щось
const hasHw = v => !!v && (typeof v === 'string' ? !!v.trim()
  : !!((v.text && String(v.text).trim()) || (v.images && v.images.length) || (v.trainers && Object.keys(v.trainers).length)));

// Що саме задано: текст + скільки фото й тренажерів. Без цього вчитель
// бачив лише «Математика, задано 08.10» — і мусив згадувати, що там було.
export function hwInfo(v){
  if(!v) return { text: '', photos: 0, trainers: 0 };
  if(typeof v === 'string') return { text: v.trim(), photos: 0, trainers: 0 };
  return { text: String(v.text || '').trim(),
           photos: Array.isArray(v.images) ? v.images.length : Object.keys(v.images || {}).length,
           trainers: Object.keys(v.trainers || {}).length };
}
const PREVIEW = 90;
export function hwPreview(info){
  const t = info.text.replace(/\s+/g, ' ');
  const extra = [info.photos ? `📷 ${info.photos}` : '', info.trainers ? `🎯 ${info.trainers}` : ''].filter(Boolean).join(' · ');
  const short = t.length > PREVIEW ? t.slice(0, PREVIEW).replace(/\s+\S*$/, '') + '…' : t;
  return [short, extra].filter(Boolean).join(' · ');
}

// hw {дата: {предмет: запис}}, done {дата: {ключПредмета: {учень: {ts, by}}}},
// names {учень: імʼя} → [{date, subj, total, done:[…], notDone:[…]}], нові згори
export function buildRows(hw, done, names, { head = false, allowed = [], canon = k => k } = {}){
  const all = head || (allowed || []).map(norm).includes(norm(ALL));
  const mine = new Set((allowed || []).map(norm));
  const roster = Object.keys(names || {});
  const rows = [];
  for(const date of Object.keys(hw || {}).sort().reverse()){
    for(const subj of Object.keys(hw[date] || {}).sort((a, b) => a.localeCompare(b, 'uk'))){
      if(!hasHw(hw[date][subj])) continue;
      if(!all && !mine.has(norm(subj))) continue;
      // Одна дитина — один рядок: позначки під імʼям і під ідентифікатором
      // зводимо до ідентифікатора зі списку класу, лишаючи найсвіжішу
      const raw = (done && done[date] && done[date][subjKey(subj)]) || {};
      const marks = {};
      for(const k of Object.keys(raw)){
        const id = canon(k), v = raw[k] || {};
        if(!marks[id] || (Number(v.ts) || 0) > (Number(marks[id].ts) || 0)) marks[id] = v;
      }
      const doneList = Object.keys(marks).map(sid => ({ sid, name: names[sid] || sid, ts: Number(marks[sid] && marks[sid].ts) || 0, by: (marks[sid] && marks[sid].by) || '' }))
        .sort((a, b) => a.name.localeCompare(b.name, 'uk'));
      const notDone = roster.filter(sid => !marks[sid]).map(sid => ({ sid, name: names[sid] })).sort((a, b) => a.name.localeCompare(b.name, 'uk'));
      rows.push({ date, subj, hw: hwInfo(hw[date][subj]), total: roster.length, done: doneList, notDone });
    }
  }
  return rows;
}

export function rowsHtml(rows, open = {}){
  if(!rows.length) return `<div class="ui-empty"><b>За два тижні ДЗ з ваших предметів не задавали</b>Щойно ДЗ зʼявиться, тут буде видно, хто позначив його виконаним.</div>`;
  return rows.map(r => {
    const n = r.done.length, pct = r.total ? Math.round(n / r.total * 100) : 0;
    const isOpen = open.date === r.date && (!open.subj || open.subj === r.subj);
    const who = r.done.map(d => `<li><span>${escHtml(d.name)}</span><small>${d.by === 'student' ? 'учень' : 'батьки'}${d.ts ? ' · ' + escHtml(fmt(d.ts)) : ''}</small></li>`).join('');
    const not = r.notDone.map(d => `<li><span>${escHtml(d.name)}</span></li>`).join('');
    const info = r.hw || { text: '', photos: 0, trainers: 0 };
    const prev = hwPreview(info);
    const extra = [info.photos ? `📷 фото: ${info.photos}` : '', info.trainers ? `🎯 тренажерів: ${info.trainers}` : ''].filter(Boolean).join(' · ');
    const full = (info.text || extra) ? `<div class="hdv-task"><h5>📚 Що задано</h5>${info.text ? `<p>${escHtml(info.text)}</p>` : ''}${extra ? `<small>${escHtml(extra)}</small>` : ''}</div>` : '';
    return `<details class="hdv-row" data-date="${escHtml(r.date)}" data-subj="${escHtml(r.subj)}"${isOpen ? ' open' : ''}>
      <summary><span class="hdv-what"><b>${escHtml(r.subj)}</b><small>задано ${escHtml(human(r.date))}</small>${prev ? `<span class="hdv-prev">${escHtml(prev)}</span>` : ''}</span>
        <span class="hdv-count"><b>${n}</b>${r.total ? ` з ${r.total}` : ''}</span>
        <span class="hdv-bar" aria-hidden="true"><i style="width:${pct}%"></i></span></summary>
      ${full}<div class="hdv-lists">
        <div><h5>✓ Позначили (${n})</h5>${n ? `<ul>${who}</ul>` : '<p class="ui-note">Ще ніхто.</p>'}</div>
        <div><h5>○ Ще не позначили (${r.notDone.length})</h5>${r.notDone.length ? `<ul>${not}</ul>` : '<p class="ui-note">Усі позначили 🎉</p>'}</div>
      </div></details>`;
  }).join('');
}

// ── ВІКНО ────────────────────────────────────────────────────────
function myClasses(){
  const role = currentUserData && currentUserData.role;
  if(isAdminRole(role)) return Array.from({ length: 11 }, (_, i) => `class_${i + 1}`);
  return Object.keys(teacherAccessMatrix || {}).filter(c => /^class_\d+$/.test(c)).sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)));
}
function ensureModal(){
  let m = document.getElementById('hdv-modal'); if(m) return m;
  m = document.createElement('div');
  m.id = 'hdv-modal'; m.className = 'modal-overlay';
  m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-labelledby', 'hdv-title');
  m.innerHTML = `<div class="modal-content hdv-box">
      <button type="button" class="ui-sheet-x hdv-x" onclick="closeHwDoneView()" aria-label="Закрити">✕</button>
      <h3 id="hdv-title" style="margin-top:0">✓ Виконання ДЗ</h3>
      <label class="ui-field"><span>Клас</span><select id="hdv-cls" onchange="hdvSetClass(this.value)"></select></label>
      <div id="hdv-body"><p class="empty-msg is-loading">Завантаження...</p></div>
      <details class="ui-how"><summary>ℹ️ Звідки ці позначки</summary><p>Батьки або сам учень натискають «○ Позначити виконаним»
        біля завдання у своїй вкладці «ДЗ». Це слово родини, а не перевірка роботи. Сповіщень про кожну позначку вам не надходить —
        інакше їх були б десятки щодня; дивіться тут, коли зручно (наприклад, перед уроком). Показано останні ${WINDOW_DAYS} днів.</p></details>
    </div>`;
  m.addEventListener('click', e => { if(e.target === m) window.closeHwDoneView(); });
  m.addEventListener('keydown', e => { if(e.key === 'Escape') window.closeHwDoneView(); });
  document.body.appendChild(m);
  return m;
}
let seq = 0, cur = { cls: '', open: {} };
async function render(){
  const my = ++seq, body = document.getElementById('hdv-body'); if(!body) return;
  const cls = cur.cls, to = localDateString, from = daysAgo(to, WINDOW_DAYS);
  body.innerHTML = '<p class="empty-msg is-loading">Завантаження...</p>';
  try{
    const [hw, done, dir, head] = await Promise.all([
      getDateRange(`homeworks/${cls}`, from, to, true),
      getDateRange(`hw_done/${cls}`, from, to),
      getStudentDir(cls).catch(() => null),
      Promise.resolve().then(() => isHeadOf(cls)).catch(() => false)]);
    if(my !== seq) return;
    const raw = (teacherAccessMatrix || {})[cls];
    const allowed = Array.isArray(raw) ? raw : Object.values(raw || {});
    const rows = buildRows(hw, done, (dir && dir.byId) || {}, { head: head || isAdminRole(currentUserData && currentUserData.role), allowed, canon: k => canonSid(dir, k) });
    body.innerHTML = rowsHtml(rows, cur.open);
    const opened = body.querySelector('details[open]');
    if(opened && opened.scrollIntoView) opened.scrollIntoView({ block: 'nearest' });
  }catch(e){
    if(my === seq) body.innerHTML = `<p class="empty-msg">Не вдалося завантажити: ${escHtml(e.message || '')}</p>`;
  }
}
// opts: {cls, date, subj} — відкрити одразу потрібне завдання
window.openHwDoneView = function(opts = {}){
  const m = ensureModal(); m.style.display = 'flex';
  const classes = myClasses(), act = getActiveClass();
  cur = { cls: opts.cls || (classes.includes(act) ? act : classes[0] || act), open: { date: opts.date || '', subj: opts.subj || '' } };
  const sel = document.getElementById('hdv-cls');
  sel.innerHTML = (classes.length ? classes : [cur.cls]).map(c => `<option value="${escHtml(c)}"${c === cur.cls ? ' selected' : ''}>${escHtml(c.replace('class_', ''))} клас</option>`).join('');
  render();
};
window.hdvSetClass = cls => { cur = { cls, open: {} }; render(); };
window.closeHwDoneView = () => { const m = document.getElementById('hdv-modal'); if(m) m.style.display = 'none'; };
