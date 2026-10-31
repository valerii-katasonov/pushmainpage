// ═══════════════════════════════════════════════════════════════
// mirror-audit.js — 📒 «Звірка оцінок для батьків» (директор, адміністрація).
//
// НАВІЩО. Батьки бачать оцінки не з журналу (grades/{клас} — там увесь
// клас, родині він закритий), а з дзеркала своєї дитини:
//   student_grades/{клас}/{учень}/{місяць}/{предмет}/{дата} = {v, t, ts}.
// Журнал пише обидва місця разом (common.js → gradeWritePaths). Але якщо
// оцінку поставили до появи дзеркала, зі старої (закешованої) сторінки,
// або під ключем учня, якого вже немає в списку класу, — у журналі вона
// є, а в кабінеті батьків предмета просто немає. Ззовні цього не видно:
// учитель бачить оцінки, батьки — ні.
//
// ЩО РОБИТЬ для обраного класу:
//   1. НЕМАЄ В ДЗЕРКАЛІ — оцінка в журналі є, у дзеркалі учня немає чи
//      інша. Кнопка «Відновити» дописує дзеркало (журнал не чіпає).
//   2. ЧУЖИЙ КЛЮЧ — оцінки записані під ключем, якого немає в списку класу
//      (імʼя замість ідентифікатора, перезаведений учень). Якщо за іменем
//      учня знайдено в списку — кнопка «Перенести»: оцінки переходять до
//      нього (і в журналі, і в дзеркалі); де на ту саму дату вже є оцінка —
//      не переписуємо, лишаємо як є й показуємо.
// ═══════════════════════════════════════════════════════════════
import { ref, get, child, update } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, currentUserData, escHtml, showToast, logAction, getStudentDir, matchSid, journalBaseDate } from './common.js';

const isAdmin = r => r === 'director' || r === 'administrator';
const has = v => v !== undefined && v !== null && v !== '';
const CHUNK = 400;
// Час для відновленої клітинки — полудень дня уроку: інакше центр
// сповіщень показав би батькам давні оцінки як «нові»
const noon = d => { const [y, m, dd] = String(d).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, dd, 12).getTime(); };

// ── ЧИСТА ЧАСТИНА ───────────────────────────────────────────────
// grades/types: {місяць: {предмет: {дата: {учень: v}}}}; mirror: {учень: {місяць: {предмет: {дата: {v,t}}}}}
// dirIds: {sid: імʼя}; match(імʼя) → sid зі списку або null
export function auditMirror({ grades, types, mirror, dirIds, match, left }){
  const missing = [], foreign = {};
  for(const ym in (grades || {})) for(const subj in (grades[ym] || {})) for(const date in (grades[ym][subj] || {})){
    const cells = grades[ym][subj][date] || {};
    for(const sid in cells){
      const v = cells[sid];
      if(!has(v)) continue;
      const t = (types && types[ym] && types[ym][subj] && types[ym][subj][date] && types[ym][subj][date][sid]) || '';
      if(!(sid in (dirIds || {}))){
        // Учень вибув (dir.left) — його оцінки в журналі лишаються законно
        if(left && sid in left) continue;
        const f = foreign[sid] || (foreign[sid] = { key: sid, to: match ? match(sid) : null, cells: [] });
        f.cells.push({ ym, subj, date, v, t });
        continue;
      }
      const m = mirror && mirror[sid] && mirror[sid][ym] && mirror[sid][ym][subj] && mirror[sid][ym][subj][date];
      // Інша оцінка або інший тип (контрольна/поточна — від типу залежить вага)
      if(!m || String(m.v) !== String(v) || (t && String(m.t || '') !== String(t))) missing.push({ sid, ym, subj, date, v, t });
    }
  }
  return { missing, foreign: Object.values(foreign) };
}
export const bySubject = list => list.reduce((o, x) => { o[x.subj] = (o[x.subj] || 0) + 1; return o; }, {});

// Шляхи для відновлення дзеркала (журнал не чіпаємо)
export function repairPaths(cls, missing){
  const p = {};
  missing.forEach(x => {
    const b = `student_grades/${cls}/${x.sid}/${x.ym}/${x.subj}/${x.date}`;
    p[`${b}/v`] = x.v; p[`${b}/t`] = x.t || ''; p[`${b}/ts`] = noon(journalBaseDate(x.date));
  });
  return p;
}
// Перенесення з чужого ключа на учня зі списку. Де в учня на ту саму дату
// вже є оцінка — не чіпаємо (conflicts).
export function movePaths(cls, f, grades, mirror){
  const p = {}, conflicts = [];
  if(!f.to) return { paths: p, conflicts: f.cells };
  f.cells.forEach(x => {
    const target = grades && grades[x.ym] && grades[x.ym][x.subj] && grades[x.ym][x.subj][x.date] && grades[x.ym][x.subj][x.date][f.to];
    if(has(target)){ conflicts.push(x); return; }
    const g = `${cls}/${x.ym}/${x.subj}/${x.date}`;
    p[`grades/${g}/${f.to}`] = x.v; p[`grade_types/${g}/${f.to}`] = x.t || null;
    p[`grades/${g}/${f.key}`] = null; p[`grade_types/${g}/${f.key}`] = null;
    const mb = `student_grades/${cls}/${f.to}/${x.ym}/${x.subj}/${x.date}`;
    p[`${mb}/v`] = x.v; p[`${mb}/t`] = x.t || ''; p[`${mb}/ts`] = noon(journalBaseDate(x.date));
    // Фото роботи лежать у тій самій клітинці дзеркала — переносимо й їх,
    // а не стираємо разом зі старим ключем
    const old = mirror && mirror[f.key] && mirror[f.key][x.ym] && mirror[f.key][x.ym][x.subj] && mirror[f.key][x.ym][x.subj][x.date];
    if(old && old.workPhotos) p[`${mb}/workPhotos`] = old.workPhotos;
    p[`student_grades/${cls}/${f.key}/${x.ym}/${x.subj}/${x.date}`] = null;
  });
  return { paths: p, conflicts };
}
async function writeChunks(paths){
  const keys = Object.keys(paths);
  for(let i = 0; i < keys.length; i += CHUNK){
    const part = {}; keys.slice(i, i + CHUNK).forEach(k => { part[k] = paths[k]; });
    await update(ref(db), part);
  }
  return keys.length;
}

// ── ЕКРАН ───────────────────────────────────────────────────────
let last = null;
const val = p => get(child(ref(db), p)).then(s => s.exists() ? s.val() : null);
export async function runMirrorAudit(){
  if(!isAdmin(currentUserData && currentUserData.role)) return;
  const out = document.getElementById('ma-out'), cls = (document.getElementById('ma-class') || {}).value;
  if(!out || !cls) return;
  out.innerHTML = '<p class="empty-msg is-loading">Звіряємо…</p>';
  try{
    const [grades, types, mirror, dir] = await Promise.all([val(`grades/${cls}`), val(`grade_types/${cls}`), val(`student_grades/${cls}`), getStudentDir(cls, true)]);
    const res = auditMirror({ grades, types, mirror, dirIds: dir.byId, match: name => matchSid(dir, name), left: dir.left || {} });
    last = { cls, grades, mirror, dir, ...res };
    paint();
  }catch(e){ out.innerHTML = `<p class="empty-msg">Не вдалося звірити: ${escHtml(e.message || '')}</p>`; }
}
function paint(){
  const out = document.getElementById('ma-out');
  if(!out || !last) return;
  const { missing, foreign, dir } = last;
  const subjList = o => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([s, n]) => `<li><b>${escHtml(s)}</b> — ${n}</li>`).join('');
  const byStu = {}; missing.forEach(x => { (byStu[x.sid] ||= new Set()).add(x.subj); });
  let html = '';
  if(!missing.length && !foreign.length) html = '<p class="ma-ok">✅ Усі оцінки класу батьки бачать.</p>';
  if(missing.length) html += `<div class="ma-block"><b>🙈 Батьки не бачать: ${missing.length} оцінок</b>
      <p class="cal-hint">У журналі є, у кабінеті батьків — ні (немає в «дзеркалі» дитини). Найчастіше — оцінки поставлені зі старої сторінки, яку давно не оновлювали.</p>
      <ul>${subjList(bySubject(missing))}</ul>
      <details><summary>Учні (${Object.keys(byStu).length})</summary><ul>${Object.entries(byStu).map(([sid, s]) => `<li>${escHtml(dir.byId[sid] || sid)}: ${escHtml([...s].join(', '))}</li>`).join('')}</ul></details>
      <button type="button" class="ma-btn" onclick="repairMirror()">🔧 Відновити для батьків (${missing.length})</button></div>`;
  foreign.forEach((f, i) => {
    html += `<div class="ma-block warn"><b>🔑 Оцінки під ключем «${escHtml(f.key)}» — такого учня немає в списку класу (${f.cells.length})</b>
      <ul>${subjList(bySubject(f.cells))}</ul>
      ${f.to ? `<p class="cal-hint">Схоже, це <b>${escHtml(dir.byId[f.to])}</b>. Перенесення додасть ці оцінки йому (у журнал і батькам) і прибере зі старого ключа. Де на ту саму дату в нього вже є оцінка — не чіпаємо.</p>
        <button type="button" class="ma-btn" onclick="moveForeignGrades(${i})">↪️ Перенести до ${escHtml(dir.byId[f.to])}</button>`
        : '<p class="cal-hint">Учня з таким іменем у списку класу не знайдено (вибув або імʼя записане інакше). Перевірте вручну в журналі.</p>'}
    </div>`;
  });
  out.innerHTML = html;
}
window.repairMirror = async function(){
  if(!last || !last.missing.length) return;
  if(!confirm(`Дописати ${last.missing.length} оцінок у кабінети батьків ${last.cls.replace('class_', '')} класу? Журнал не змінюється.`)) return;
  try{
    await writeChunks(repairPaths(last.cls, last.missing));
    logAction('grades_mirror', { value: `${last.cls}: відновлено ${last.missing.length}` });
    showToast(`✅ Відновлено: ${last.missing.length}`);
    runMirrorAudit();
  }catch(e){ alert('Не вдалося: ' + e.message); }
};
window.moveForeignGrades = async function(i){
  const f = last && last.foreign[i];
  if(!f || !f.to) return;
  const { paths, conflicts } = movePaths(last.cls, f, last.grades, last.mirror);
  const n = f.cells.length - conflicts.length;
  if(!n) return alert('Усі ці дати в учня вже мають оцінки — переносити нічого.');
  if(!confirm(`Перенести ${n} оцінок з ключа «${f.key}» до ${last.dir.byId[f.to]}?${conflicts.length ? `\n${conflicts.length} не переносимо: на ці дати в учня вже є оцінка.` : ''}`)) return;
  try{
    await writeChunks(paths);
    logAction('grades_mirror', { value: `${last.cls}: перенесено ${n} з «${f.key}» до ${f.to}` });
    showToast(`✅ Перенесено: ${n}`);
    runMirrorAudit();
  }catch(e){ alert('Не вдалося: ' + e.message); }
};
window.runMirrorAudit = runMirrorAudit;
