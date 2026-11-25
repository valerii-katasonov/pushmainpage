// ═══════════════════════════════════════════════════════════════
// att-stats.js — 📉 СТАТИСТИКА ВІДСУТНОСТІ («Аналітика» директора)
//
// Було: число пропусків по класах і 12 «лідерів» за місяць. Не видно,
// ХТО з конкретного класу скільки пропустив і ЧОМУ. Тепер:
//   • період — місяць або весь навчальний рік;
//   • фільтр по класу, пошук по імені;
//   • по кожному учню: днів відсутності, запізнень, причини з
//     кількістю (хвороба, сімейні обставини, без причини, хвилини
//     запізнення) і хто повідомив (батьки / учень / учитель);
//   • розгорнути — список дат; вивантаження в CSV.
// Рахунок — «учень × день», як на картці «Огляд» (countAttendanceDays):
// кілька уроків одного дня — один день.
// ═══════════════════════════════════════════════════════════════
import { escHtml, getSchoolRange, stuName, localDateString } from './common.js';

// ── Чисті функції (tests-att-stats.mjs) ──
const WD = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
export const dayLabel = ds => { const [y, m, d] = String(ds).split('-').map(Number); return `${WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}`; };
// Причина відмітки → категорія для підсумку
export function reasonOf(status, reason){
  const r = String(reason || '').trim().toLowerCase();
  if(status === 'late'){
    const m = r.match(/на\s+(\d+)\s*хв/); if(m) return { k: `late_${m[1]}`, t: `⏰ на ${m[1]} хв` };
    const u = r.match(/до\s+(\d+)/);      if(u) return { k: `late_l${u[1]}`, t: `⏰ до ${u[1]}-го уроку` };
    return { k: 'late_x', t: '⏰ без деталей' };
  }
  if(/хвор/.test(r)) return { k: 'ill', t: '🤒 хвороба' };
  if(/сімей/.test(r)) return { k: 'family', t: '👪 сімейні обставини' };
  if(!r || r === 'відмічено вчителем') return { k: 'none', t: '❔ без причини' };
  return { k: 'other:' + r.slice(0, 40), t: '📝 ' + String(reason).trim().slice(0, 40) };
}
export const WHO = { parent: 'батьки', student: 'учень', teacher: 'учитель' };
// Навчальний рік, у якому лежить дата: 1 вересня … 31 серпня
export function schoolYearOf(ds){
  const [y, m] = String(ds).split('-').map(Number);
  const start = m >= 9 ? y : y - 1;
  return { from: `${start}-09-01`, to: `${start + 1}-08-31`, label: `${start}/${String(start + 1).slice(2)}` };
}
// att: {class_N: {date: {studentKey: {slot: {status, reason, markedBy}}}}}
export function buildStats(att, from, to, nameOf = (c, st) => st){
  const byStu = {}, byCls = {}, reasons = {};
  let abs = 0, late = 0;
  for(const cls of Object.keys(att || {})){
    const dates = att[cls] || {};
    for(const ds of Object.keys(dates)){
      if(ds < from || ds > to) continue;
      const day = dates[ds] || {};
      for(const st of Object.keys(day)){
        const slots = day[st];
        if(!slots || typeof slots !== 'object') continue;
        const marks = Object.entries(slots).filter(([, r]) => r && (r.status === 'absent' || r.status === 'late'));
        if(!marks.length) continue;
        const key = `${cls}|${st}`;
        const s = byStu[key] = byStu[key] || { cls, st, name: nameOf(cls, st) || st, abs: 0, late: 0, reasons: {}, days: [] };
        const c = byCls[cls] = byCls[cls] || { abs: 0, late: 0, kids: 0 };
        const a = marks.find(([, r]) => r.status === 'absent'), l = marks.find(([, r]) => r.status === 'late');
        const day1 = { date: ds, items: [] };
        for(const [status, hit] of [['absent', a], ['late', l]]){
          if(!hit) continue;
          // Причина дня — з першої відмітки, де вона є (батьки пишуть причину, вчитель — «Відмічено вчителем»)
          const withReason = marks.filter(([, r]) => r.status === status).find(([, r]) => reasonOf(status, r.reason).k !== 'none' && reasonOf(status, r.reason).k !== 'late_x') || hit;
          const rs = reasonOf(status, withReason[1].reason);
          if(status === 'absent'){ s.abs++; c.abs++; abs++; } else { s.late++; c.late++; late++; }
          s.reasons[rs.k] = s.reasons[rs.k] || { t: rs.t, n: 0 }; s.reasons[rs.k].n++;
          reasons[rs.k] = reasons[rs.k] || { t: rs.t, n: 0 }; reasons[rs.k].n++;
          const slotsOf = marks.filter(([, r]) => r.status === status).map(([sk]) => sk)
            .sort((x, y) => (x === 'all' ? -1 : y === 'all' ? 1 : (Number(x) || 99) - (Number(y) || 99)));
          day1.items.push({ status, reason: rs.t, slots: slotsOf, who: WHO[withReason[1].markedBy] || '' });
        }
        s.days.push(day1);
      }
    }
  }
  Object.values(byStu).forEach(s => { s.days.sort((x, y) => x.date < y.date ? 1 : -1); byCls[s.cls].kids++; });
  const rows = Object.values(byStu).sort((x, y) => (y.abs - x.abs) || (y.late - x.late) || String(x.name).localeCompare(String(y.name), 'uk'));
  return { rows, byCls, reasons, abs, late };
}
export const clsNum = c => Number(String(c).replace('class_', '')) || 0;
export function statsCsv(rows){
  const cell = v => { let s = String(v == null ? '' : v); if(/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const head = ['Клас', 'Учень', 'Днів відсутності', 'Запізнень', 'Причини', 'Дати'];
  return '﻿' + [head, ...rows.map(r => [clsNum(r.cls), r.name, r.abs, r.late,
    Object.values(r.reasons).map(x => `${x.t.replace(/^\S+\s/, '')} ×${x.n}`).join('; '),
    r.days.map(d => `${d.date}: ${d.items.map(i => (i.status === 'absent' ? 'відсутність' : 'запізнення') + ' (' + i.reason.replace(/^\S+\s/, '') + ')').join(', ')}`).join(' | ')])]
    .map(l => l.map(cell).join(';')).join('\r\n');
}

// ── Екран ──
const st = { period: 'month', month: '', cls: 'all', q: '', data: null, key: '' };
function slotText(sl){ return sl.map(k => k === 'all' ? 'увесь день' : /^\d+$/.test(k) ? `урок ${k}` : k).join(', '); }
function controls(box){
  if(box.querySelector('.ast-ctl')) return;
  box.innerHTML = `<div class="ast-ctl">
      <select data-s="period" aria-label="Період"><option value="month">За місяць</option><option value="year">Увесь навчальний рік</option></select>
      <input type="month" data-s="month" aria-label="Місяць">
      <select data-s="cls" aria-label="Клас"></select>
      <input type="search" data-s="q" placeholder="Пошук учня" aria-label="Пошук учня">
    </div><div class="ast-out"><p class="empty-msg is-loading">Завантаження...</p></div>`;
  box.querySelector('[data-s="cls"]').innerHTML = '<option value="all">Усі класи</option>' + Array.from({ length: 11 }, (_, i) => `<option value="class_${i + 1}">${i + 1} клас</option>`).join('');
  box.addEventListener('change', e => { const k = e.target.dataset.s; if(!k || k === 'q') return; st[k] = e.target.value; if(k === 'cls') return paint(box); load(box); });
  box.addEventListener('input', e => { if(e.target.dataset.s === 'q'){ st.q = e.target.value; paint(box); } });
  box.addEventListener('click', e => {
    const c = e.target.closest('[data-cls]'); if(c){ st.cls = c.dataset.cls; box.querySelector('[data-s="cls"]').value = st.cls; paint(box); return; }
    if(e.target.closest('[data-a="csv"]')) csv();
  });
}
function range(){
  if(st.period === 'year'){ const y = schoolYearOf(localDateString); return { from: y.from, to: localDateString < y.to ? localDateString : y.to, label: `навчальний рік ${y.label}` }; }
  const ym = st.month || localDateString.slice(0, 7);
  return { from: `${ym}-01`, to: `${ym}-31`, label: new Date(ym + '-01T12:00:00').toLocaleDateString('uk-UA', { month: 'long', year: 'numeric' }) };
}
async function load(box){
  const out = box.querySelector('.ast-out'); const r = range();
  const key = `${r.from}|${r.to}`;
  out.innerHTML = '<p class="empty-msg is-loading">Обчислення...</p>';
  try{
    const att = await getSchoolRange('attendance', r.from, r.to);
    st.data = buildStats(att, r.from, r.to, stuName); st.key = key; st.label = r.label;
    paint(box);
  }catch(e){ out.innerHTML = `<p class="empty-msg" style="color:var(--danger);">Помилка: ${escHtml(e.message || e)}</p>`; }
}
function paint(box){
  const out = box.querySelector('.ast-out'); const d = st.data; if(!out || !d) return;
  const q = st.q.trim().toLowerCase();
  const rows = d.rows.filter(r => (st.cls === 'all' || r.cls === st.cls) && (!q || String(r.name).toLowerCase().includes(q)));
  const sum = st.cls === 'all' ? { abs: d.abs, late: d.late, kids: d.rows.length } : (d.byCls[st.cls] || { abs: 0, late: 0, kids: 0 });
  const rsn = {}; rows.forEach(r => Object.entries(r.reasons).forEach(([k, x]) => { rsn[k] = rsn[k] || { t: x.t, n: 0 }; rsn[k].n += x.n; }));
  const clsChips = Array.from({ length: 11 }, (_, i) => { const c = `class_${i + 1}`, v = d.byCls[c];
    return `<button type="button" class="as-cls${v && v.abs ? '' : ' zero'}${st.cls === c ? ' on' : ''}" data-cls="${c}" aria-pressed="${st.cls === c}">${i + 1} кл: <b>${v ? v.abs : 0}</b>${v && v.late ? ` +${v.late}з` : ''}</button>`; }).join('');
  out.innerHTML = `<p class="ast-period">${escHtml(st.label)}${st.cls !== 'all' ? ` · ${clsNum(st.cls)} клас <button type="button" class="ast-all" data-cls="all">усі класи</button>` : ''}</p>
    <div class="as-sum"><div><b>${sum.abs}</b><span>днів відсутності</span></div><div><b>${sum.late}</b><span>запізнень</span></div><div><b>${sum.kids}</b><span>учнів із відмітками</span></div></div>
    ${Object.keys(rsn).length ? `<div class="as-title">Причини</div><div class="ast-reasons">${Object.values(rsn).sort((a, b) => b.n - a.n).map(x => `<span>${escHtml(x.t)} <b>${x.n}</b></span>`).join('')}</div>` : ''}
    <div class="as-title">По класах <small>(натисніть клас — список учнів)</small></div><div class="as-classes">${clsChips}</div>
    <div class="as-title ast-h">Учні${rows.length ? ` (${rows.length})` : ''}${rows.length ? '<button type="button" class="ui-btn ui-btn-2 ast-csv" data-a="csv">⬇️ CSV</button>' : ''}</div>
    ${rows.length ? `<div class="ast-list">${rows.map(r => `<details class="ast-row">
        <summary><span class="ast-name"><b data-no-i18n>${escHtml(r.name)}</b><span class="as-c">${clsNum(r.cls)} кл.</span></span>
          <span class="ast-nums">${r.abs ? `<span class="badge badge-absent">${r.abs} дн.</span>` : ''}${r.late ? ` <span class="badge badge-late">${r.late} зап.</span>` : ''}</span>
          <span class="ast-rs">${Object.values(r.reasons).sort((a, b) => b.n - a.n).map(x => `<i>${escHtml(x.t)}${x.n > 1 ? ` ×${x.n}` : ''}</i>`).join('')}</span></summary>
        <ul class="ast-days">${r.days.map(dd => `<li><b>${escHtml(dayLabel(dd.date))}</b> ${dd.items.map(i => `<span class="badge ${i.status === 'absent' ? 'badge-absent' : 'badge-late'}">${i.status === 'absent' ? 'Відсутність' : 'Запізнення'}</span> ${escHtml(slotText(i.slots))} · ${escHtml(i.reason)}${i.who ? ` · <span class="ast-who">повідомив(ла): ${escHtml(i.who)}</span>` : ''}`).join('<br>')}</li>`).join('')}</ul>
      </details>`).join('')}</div>` : `<p class="empty-msg">${q ? 'Нікого не знайдено.' : 'Відміток за цей період немає.'}</p>`}`;
}
function csv(){
  const d = st.data; if(!d) return;
  const rows = d.rows.filter(r => st.cls === 'all' || r.cls === st.cls);
  const url = URL.createObjectURL(new Blob([statsCsv(rows)], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = `vidsutnist-${st.cls === 'all' ? 'shkola' : clsNum(st.cls) + '-klas'}-${st.key.split('|')[0]}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
window.loadAttendanceStats = function(opts = {}){
  const box = document.getElementById('att-stats'); if(!box) return;
  controls(box);
  if(opts.cls){ st.cls = opts.cls; }
  if(!st.month) st.month = localDateString.slice(0, 7);
  box.querySelector('[data-s="period"]').value = st.period;
  box.querySelector('[data-s="month"]').value = st.month;
  box.querySelector('[data-s="month"]').hidden = st.period !== 'month';
  box.querySelector('[data-s="cls"]').value = st.cls;
  return load(box);
};
// Огляд → «📉 Статистика відсутності»: вкладка «Аналітика», блок розгорнутий
window.openAttStats = function(){
  const btn = document.querySelector('#dtab-bar .dtab[data-t="stat"]');
  if(btn) btn.click();
  const det = document.getElementById('att-stats-det');
  setTimeout(() => {
    if(det){ if(!det.open) det.open = true; else window.loadAttendanceStats(); try{ det.scrollIntoView({ behavior: 'smooth', block: 'start' }); }catch(e){} }
  }, 80);
};

// ── Огляд: згортання блоку «Відсутні» ──
const COLL = 'push_dir_att_collapsed';
function applyColl(on){
  const card = document.querySelector('.d-att-card'), tog = document.getElementById('d-att-tog'); if(!card || !tog) return;
  card.classList.toggle('is-collapsed', on);
  tog.setAttribute('aria-expanded', String(!on));
}
window.toggleDirAtt = function(){
  const on = !document.querySelector('.d-att-card')?.classList.contains('is-collapsed');
  applyColl(on);
  try{ localStorage.setItem(COLL, on ? '1' : ''); }catch(e){}
};
window.expandDirAtt = function(){ applyColl(false); };
function initOverview(){
  let on = false; try{ on = localStorage.getItem(COLL) === '1'; }catch(e){}
  applyColl(on);
  // Лічильник у заголовку — щоб і в згорнутому вигляді було видно, скільки
  const list = document.getElementById('d-unified-att-list'), cnt = document.getElementById('d-att-count');
  if(!list || !cnt || typeof MutationObserver !== 'function') return;
  const upd = () => {
    const items = [...list.querySelectorAll('.att-item')];
    const a = items.filter(li => li.querySelector('.badge-absent')).length, l = items.filter(li => li.querySelector('.badge-late')).length;
    cnt.innerHTML = items.length ? `${a ? `<span class="badge badge-absent">${a} відс.</span>` : ''}${l ? ` <span class="badge badge-late">${l} зап.</span>` : ''}` : (list.querySelector('.is-loading') ? '' : '<span class="d-att-ok">✓</span>');
  };
  new MutationObserver(upd).observe(list, { childList: true, subtree: true }); upd();
}
if(typeof document !== 'undefined'){
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initOverview); else initOverview();
}
