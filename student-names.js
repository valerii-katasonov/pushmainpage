// ═══════════════════════════════════════════════════════════════
// student-names.js — 🧹 САМОВПИСАНІ ІМЕНА УЧНІВ (директор, разово)
//
// Відтепер імʼя учня веде лише школа (список класу), а правила бази не
// дають учню вписати собі інше. Але дехто встиг раніше: у users/{uid}
// лишилися firstName/lastName, які учень придумав сам. Тут директор:
//   1) бачить список: клас, що вписав учень, яке імʼя в списку класу;
//   2) може зберегти список (CSV) — для себе, до чистки;
//   3) прибирає вибрані самовписані імена. Картку учня в чаті
//      (class_parents) одразу переписуємо на імʼя зі списку класу.
// Нічого не видаляється без підтвердження й без позначки в рядку.
// ═══════════════════════════════════════════════════════════════
import { ref, get, update } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, escHtml, showToast, getUsersSnap, invalidateUsersCache, logAction, childDisplayName, emailKey } from './common.js';

// ── Чисті функції (tests-student-names.mjs) ──
const norm = s => String(s || '').toLowerCase().replace(/[ʼ'’`]/g, "'").split(/\s+/).filter(Boolean).sort().join(' ');
// Хто з учнів має самовписане імʼя і яке імʼя в нього за списком класу
export function selfNamed(users, lists, display = childDisplayName){
  return Object.entries(users || {})
    .filter(([, u]) => u && typeof u === 'object' && u.role === 'student')
    .map(([uid, u]) => {
      const own = [u.firstName, u.lastName].filter(x => typeof x === 'string' && x.trim()).join(' ').trim();
      if(!own) return null;
      const cls = typeof u.class === 'string' ? u.class : '';
      const roster = cls && u.studentId && lists && lists[cls] && typeof lists[cls][u.studentId] === 'string' ? lists[cls][u.studentId] : '';
      const school = display(roster || u.studentName || '');
      return { uid, email: String(u.email || ''), cls, own, school, same: !!school && norm(own) === norm(school) };
    })
    .filter(Boolean)
    .sort((a, b) => (a.same - b.same) || (!a.cls - !b.cls) || a.cls.localeCompare(b.cls, 'uk', { numeric: true }) || a.school.localeCompare(b.school, 'uk'));
}
// CSV для Excel: ; як роздільник, захист від формул (=, +, -, @)
export function namesCsv(rows){
  const cell = v => { let s = String(v == null ? '' : v); if(/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const head = ['Клас', 'Вписав сам', 'Імʼя в списку класу', 'Збігається', 'Пошта входу'];
  return '﻿' + [head, ...rows.map(r => [clsLabel(r.cls), r.own, r.school || '—', r.same ? 'так' : 'ні', r.email])]
    .map(l => l.map(cell).join(';')).join('\r\n');
}
export const clsLabel = c => /^class_\d+$/.test(c) ? c.replace('class_', '') + ' клас' : (c || 'без класу');

// ── Вікно ──
let st = null;
window.openStudentNamesClean = async function(){
  document.querySelectorAll('.sn-ov').forEach(x => x.remove());
  const ov = document.createElement('div');
  ov.className = 'modal-overlay sn-ov'; ov.style.display = 'flex'; ov.style.zIndex = '1030';
  ov.innerHTML = '<div class="modal-content sn" role="dialog" aria-modal="true" aria-label="Самовписані імена учнів"><p class="empty-msg is-loading">Шукаю…</p></div>';
  document.body.appendChild(ov);
  const box = ov.querySelector('.sn');
  st = { ov, box, rows: [], pick: {}, done: null };
  ov.addEventListener('click', e => { if(e.target === ov){ ov.remove(); st = null; } });
  box.addEventListener('click', click);
  box.addEventListener('change', e => { if(e.target.dataset.uid && st){ st.pick[e.target.dataset.uid] = e.target.checked; count(); } });
  try{
    const [us, ls] = await Promise.all([getUsersSnap(), get(ref(db, 'students_list'))]);
    if(!st) return;
    st.rows = selfNamed(us.exists() ? us.val() : {}, ls.exists() ? ls.val() : {});
    st.rows.forEach(r => { st.pick[r.uid] = true; });
    paint();
  }catch(e){ box.innerHTML = `<p class="empty-msg">Не вдалося прочитати: ${escHtml(e.message || e)}</p>`; }
};
function paint(){
  const { box, rows, done } = st;
  const diff = rows.filter(r => !r.same).length;
  box.innerHTML = `<div class="sn-h"><h3>🧹 Самовписані імена учнів</h3><button type="button" class="sn-x" data-a="close" aria-label="Закрити">✕</button></div>
    ${done ? `<p class="sn-ok">✅ Прибрано: ${done.ok}${done.fail ? ` · не вдалося: ${done.fail}` : ''}. Тепер у шапці, чаті й на PUSH School Card — імʼя зі списку класу.</p>` : ''}
    ${rows.length ? `
    <p class="sn-note">Учні, які раніше самі вписали собі імʼя в профілі. Відтепер усюди показується імʼя зі списку класу, а змінити його може лише школа. Перевірте список, за потреби збережіть його й приберіть самовписане.</p>
    <p class="sn-sum"><b>${rows.length}</b> учн. · відрізняється від списку класу: <b>${diff}</b> · збігається: <b>${rows.length - diff}</b></p>
    <div class="sn-list" role="list">${rows.map(r => `<label class="sn-row${r.same ? ' same' : ''}" role="listitem">
        <input type="checkbox" data-uid="${escHtml(r.uid)}" ${st.pick[r.uid] ? 'checked' : ''} aria-label="Прибрати самовписане імʼя ${escHtml(r.own)}">
        <span class="sn-cls">${escHtml(clsLabel(r.cls))}</span>
        <span class="sn-names"><span class="sn-own" data-no-i18n><small>вписав сам</small><span class="sn-v">${escHtml(r.own)}</span></span>
          <span class="sn-arrow" aria-hidden="true">→</span>
          <span class="sn-school" data-no-i18n><small>у списку класу</small>${r.school ? escHtml(r.school) : '<i>немає в списку</i>'}</span></span>
        ${r.same ? '<span class="sn-tag">збігається</span>' : ''}
      </label>`).join('')}</div>
    <div class="sn-btns">
      <button type="button" class="ui-btn ui-btn-2" data-a="csv">⬇️ Зберегти список (CSV)</button>
      <button type="button" class="ui-btn ui-btn-1" data-a="clean"></button>
    </div>` : `<p class="sn-note">${done ? 'Більше самовписаних імен немає.' : 'Учнів із самовписаним імʼям немає — нічого прибирати.'}</p>`}`;
  count();
}
function count(){
  const b = st && st.box.querySelector('[data-a="clean"]'); if(!b) return;
  const n = st.rows.filter(r => st.pick[r.uid]).length;
  b.textContent = `Прибрати вибрані (${n})`; b.disabled = !n;
}
async function click(e){
  const b = e.target.closest('[data-a]'); if(!b || !st) return;
  const a = b.dataset.a;
  if(a === 'close'){ st.ov.remove(); st = null; return; }
  if(a === 'csv'){
    const url = URL.createObjectURL(new Blob([namesCsv(st.rows)], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `samovpysani-imena-uchniv-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  if(a === 'clean'){
    const pick = st.rows.filter(r => st.pick[r.uid]);
    if(!pick.length) return;
    if(!confirm(`Прибрати самовписані імена в ${pick.length} учн.?\n\nУ шапці, чаті й на PUSH School Card буде імʼя зі списку класу. Самовписане зникне — якщо потрібна копія, спершу натисніть «Зберегти список».`)) return;
    b.disabled = true; b.textContent = 'Прибираю…';
    let ok = 0, fail = 0;
    for(const r of pick){
      try{
        await update(ref(db, `users/${r.uid}`), { firstName: null, lastName: null });
        ok++;
        // Картка в чаті — одразу на імʼя зі списку класу (інакше лише після входу учня)
        if(r.cls && r.email && r.school){
          const path = `class_parents/${r.cls}/${emailKey(r.email)}`;
          const card = await get(ref(db, path)).then(s => s.exists()).catch(() => false);
          if(card) await update(ref(db, path), { name: r.school.slice(0, 120), ts: Date.now() }).catch(() => {});
        }
      }catch(err){ fail++; console.warn('[student-names]', r.uid, err && err.message); }
    }
    invalidateUsersCache();
    // PUSH School Card цих учнів — одразу на імʼя зі списку класу (картки
    // пише лише сервер). Немає модуля партнерів — оновляться при відкритті.
    if(ok && typeof window.syncPartnerCards === 'function'){
      b.textContent = 'Оновлюю картки…';
      const sum = await window.syncPartnerCards(pick.map(r => r.uid)).catch(() => null);
      if(sum && sum.error) console.warn('[student-names] картки:', sum.msg);
    }
    logAction('student_names_clean', { value: `прибрано ${ok}${fail ? `, помилок ${fail}` : ''}` });
    const cleaned = new Set(pick.map(r => r.uid));
    st.rows = st.rows.filter(r => !cleaned.has(r.uid));
    st.done = { ok, fail };
    showToast(fail ? `Прибрано ${ok}, не вдалося ${fail}` : `✅ Прибрано ${ok}`);
    // Ті, кого не вдалося, лишаються в списку — перечитуємо
    if(fail){ const us = await getUsersSnap().catch(() => null); const ls = await get(ref(db, 'students_list')).catch(() => null);
      if(us && st){ st.rows = selfNamed(us.exists() ? us.val() : {}, ls && ls.exists() ? ls.val() : {}); st.rows.forEach(r => { st.pick[r.uid] = true; }); } }
    if(st) paint();
  }
}
