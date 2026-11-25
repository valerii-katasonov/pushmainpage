// ═══════════════════════════════════════════════════════════════
// awards.js — «Огляд» → «📈 Середні оцінки»: режим «по учню»,
// 🏅 хто йде на відзнаку (клас) і 🎓 відмінники школи за класами
//
// ПРАВИЛА (перевірено 25.11.2026)
//  🇺🇦 Похвальний лист «За високі досягнення у навчанні» — учні 2–8 і
//     10 класів, які мають високий рівень (10–12 балів) з УСІХ предметів
//     за навчальний рік. Положення МОН №579 (2000) зі змінами наказу
//     №115 від 07.02.2012. Рішення — педрада, наказ директора.
//  🇺🇦 Похвальна грамота «За особливі досягнення у вивченні окремих
//     предметів» — випускники (9, 11 кл.) з 12 балами з предмета;
//     перевага — переможцям олімпіад і конкурсів (це вирішує школа).
//  🇵🇱 Świadectwo z wyróżnieniem («з паском») — klasy IV–VIII: średnia
//     ocen rocznych z obowiązkowych zajęć ≥ 4,75 i zachowanie co najmniej
//     bardzo dobre. Похвальних листів у Польщі немає — це їхній аналог.
//
// ЯК РАХУЄМО
//  • Оцінка з предмета: виставлена семестрова (semester_grades) за
//    обраний семестр — «остаточна»; для року — семестрова останнього
//    семестру; немає — прогноз так само, як пропонується семестрова
//    (subjectAvg: тематичні, інакше середньозважений поточних),
//    округлений до цілого.
//  • Шкали: «високий рівень» = 10 з 12, 5 з 6, рівень «В» у 1–4 класах;
//    інша шкала — 10/12 максимуму. Для 🇵🇱 середнє перераховуємо в 1–6.
//  • Поведінка (🇵🇱): середнє щоденних оцінок поведінки за період,
//    округлене: 6 — wzorowe, 5 — bardzo dobre. Немає оцінок — пишемо
//    «перевірте вручну».
//  Це підказка для педради, а не рішення.
// ═══════════════════════════════════════════════════════════════
import { ref, get, child } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, escHtml, getClassNum, LEVEL_MAX_CLASS, levelNum, displayGrade } from './common.js';
import { loadPeriods, pickPeriod, periodControl, subjectAvg, monthsIn } from './class-stats.js';

// ── Чиста логіка (tests-awards.mjs) ──
export const RULES = {
  list:  { k: 'list',  icon: '🇺🇦', t: 'Похвальний лист', sub: '«За високі досягнення у навчанні» · 2–8, 10 кл.' },
  gram:  { k: 'gram',  icon: '🇺🇦', t: 'Похвальна грамота', sub: '«За особливі досягнення у вивченні окремих предметів» · випускники 9, 11 кл.' },
  pl:    { k: 'pl',    icon: '🇵🇱', t: 'Świadectwo z wyróżnieniem', sub: 'klasy IV–VIII · średnia ≥ 4,75 + zachowanie ≥ bardzo dobre' }
};
export function ruleFits(rule, n){
  if(rule === 'list') return (n >= 2 && n <= 8) || n === 10;
  if(rule === 'gram') return n === 9 || n === 11;
  if(rule === 'pl') return n >= 4 && n <= 8;
  return false;
}
export const defaultRule = n => ruleFits('list', n) ? 'list' : ruleFits('gram', n) ? 'gram' : ruleFits('pl', n) ? 'pl' : 'list';
// Поріг «високого рівня» на шкалі
export const highOf = (max, junior) => junior ? 5 : max === 12 ? 10 : max === 6 ? 5 : Math.ceil(max * 10 / 12 - 1e-9);
// Оцінка з предмета: остаточна (виставлена) або округлений прогноз
export function subjResult(subj, { final, avg, max = 6, junior = false }){
  const f = final == null || final === '' ? null : levelNum(final);
  if(f == null && (avg == null || !Number.isFinite(avg))) return null;
  const val = f != null ? f : Math.round(avg);
  const m = junior ? 6 : (Number(max) || 6);
  return { subj, val, max: m, final: f != null, avg: f != null ? f : avg, six: junior || m === 6 ? val : val / m * 6 };
}
export const behWord = v => v == null ? null : v >= 6 ? 'wzorowe' : v >= 5 ? 'bardzo dobre' : v >= 4 ? 'dobre' : v >= 3 ? 'poprawne' : v >= 2 ? 'nieodpowiednie' : 'naganne';
// Статус учня за правилом. subjs — масив subjResult; beh — середнє поведінки або null
export function award(rule, subjs, beh, junior){
  const list = (subjs || []).filter(Boolean);
  if(!list.length) return { st: 'none', why: 'немає оцінок за період' };
  if(rule === 'list'){
    const low = list.filter(s => s.val < highOf(s.max, junior)).map(s => ({ ...s, need: highOf(s.max, junior) }));
    if(!low.length) return { st: 'yes', why: 'високий рівень з усіх предметів' };
    // «На межі»: до листа бракує одного-двох предметів — їх і показуємо
    if(low.length <= 2) return { st: 'near', why: `бракує ${low.length === 1 ? 'одного предмета' : 'двох предметів'}: ${low.map(x => x.subj).join(', ')}`, low };
    return { st: 'no', why: `нижче високого: ${low.length} предм.`, low };
  }
  if(rule === 'gram'){
    const top = list.filter(s => !junior && s.val >= s.max);
    if(top.length) return { st: 'yes', why: `максимум з: ${top.map(s => s.subj).join(', ')}`, top };
    const near = list.filter(s => !junior && s.max - s.val === 1);
    return near.length ? { st: 'near', why: `на 1 бал нижче максимуму: ${near.map(s => s.subj).join(', ')}` } : { st: 'no', why: 'немає предметів із максимальною оцінкою' };
  }
  // pl
  const avg = list.reduce((a, s) => a + s.six, 0) / list.length;
  const b = beh == null ? null : Math.round(beh);
  const avgOk = avg >= 4.75 - 1e-9, behOk = b == null ? null : b >= 5;
  const out = { avg, beh: b };
  if(avgOk && behOk) return { ...out, st: 'yes', why: `średnia ${avg.toFixed(2)}, zachowanie ${behWord(b)}` };
  if(avgOk && behOk === null) return { ...out, st: 'check', why: `średnia ${avg.toFixed(2)} — поведінку перевірте вручну` };
  if(avgOk) return { ...out, st: 'near', why: `średnia ${avg.toFixed(2)}, але поведінка ${behWord(b)} (потрібно bardzo dobre)` };
  if(avg >= 4.5 && behOk !== false) return { ...out, st: 'near', why: `średnia ${avg.toFixed(2)} — бракує ${(4.75 - avg).toFixed(2)}` };
  return { ...out, st: 'no', why: `średnia ${avg.toFixed(2)}` };
}
export const ORDER = { yes: 0, check: 1, near: 2, no: 3, none: 4 };

// ── Хто веде предмет у класі (teacher_access + довідник персоналу) ──
export const ALL_SUBJ = 'Всі предмети';
export function sameSubj(a, b){
  const nz = x => String(x || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const A = nz(a), B = nz(b);
  if(!A || !B) return false;
  if(A === B) return true;
  const pa = A.split(/\s*\/\s*/).filter(x => x.length >= 3), pb = B.split(/\s*\/\s*/).filter(x => x.length >= 3);
  return (pa.length > 1 || pb.length > 1) && pa.some(x => pb.some(y => sameSubj(x, y)));
}
// access: {пошта_ключ: {клас: [предмети]}}; names: {пошта_ключ: імʼя} → subj → [імена]
export function teachersOf(access, names, cls){
  const rows = Object.entries(access || {}).map(([se, byCls]) => {
    const l = byCls && byCls[cls];
    return { se, subs: (Array.isArray(l) ? l : Object.values(l || {})).filter(v => typeof v === 'string' && v.trim()) };
  }).filter(r => r.subs.length);
  const nm = se => (names && names[se]) || String(se).replace(/_/g, '.');
  return subj => {
    const own = rows.filter(r => r.subs.some(x => x !== ALL_SUBJ && sameSubj(x, subj))).map(r => nm(r.se));
    return own.length ? own : rows.filter(r => r.subs.includes(ALL_SUBJ)).map(r => nm(r.se));
  };
}
let staffCache = null;
async function staffData(){
  if(staffCache) return staffCache;
  const [a, d] = await Promise.all([get(child(ref(db), 'teacher_access')).catch(() => null), get(child(ref(db), 'staff_directory')).catch(() => null)]);
  const dir = d && d.exists() ? d.val() : {};
  staffCache = { access: a && a.exists() ? a.val() : {}, names: Object.fromEntries(Object.entries(dir).map(([se, x]) => [se, x && x.name ? String(x.name) : ''])) };
  return staffCache;
}
// «Фізика — 4, потрібно 5 · 👩‍🏫 Олена Петренко»
function lowHtml(low, junior, cls, who){
  return `<ul class="aw-low">${low.map(x => { const t = who(x.subj);
    return `<li><b>${escHtml(x.subj)}</b> — ${escHtml(gradeTxt(x, junior, cls))}${x.final ? '' : ' ✳️'}, потрібно ${escHtml(junior ? 'В' : String(x.need) + (x.max !== 6 ? '/' + x.max : ''))}
      <span class="aw-t">👩‍🏫 ${t.length ? escHtml(t.join(', ')) : 'учителя не призначено'}</span></li>`; }).join('')}</ul>`;
}

// ── Відмінник: високий рівень з усіх предметів (як для похвального листа) ──
export function isHonor(subjs, junior){
  const list = (subjs || []).filter(Boolean);
  return list.length > 0 && list.every(s => s.val >= highOf(s.max, junior));
}
// Яка відзнака личить відміннику цього класу
export const honorAward = n => ruleFits('list', n) ? '🇺🇦 похвальний лист' : ruleFits('gram', n) ? '🇺🇦 похвальна грамота (з предметів на 12)' : '';

// ── Дані класу за період (одне читання на всі три екрани) ──
async function classData(cls, p, sel, P, { behavior = false } = {}){
  const n = getClassNum(cls), junior = n <= LEVEL_MAX_CLASS;
  const today = new Date().toISOString().slice(0, 10);
  const end = p.end < today ? p.end : today, months = monthsIn(p.start, end);
  const semId = sel.kind === 'semester' ? p.id : sel.kind === 'year' && P.semesters.length ? P.semesters[P.semesters.length - 1].id : '';
  const [stSnap, scSnap, semSnap, ...per] = await Promise.all([
    get(child(ref(db), `students_list/${cls}`)),
    get(child(ref(db), `grade_scales/${cls}`)).catch(() => null),
    semId ? get(child(ref(db), `semester_grades/${cls}/${semId}`)).catch(() => null) : null,
    ...months.flatMap(ym => [get(child(ref(db), `grades/${cls}/${ym}`)).catch(() => null), get(child(ref(db), `grade_types/${cls}/${ym}`)).catch(() => null),
                            behavior ? get(child(ref(db), `behavior_grades/${cls}/${ym}`)).catch(() => null) : null])
  ]);
  const scales = scSnap && scSnap.exists() ? scSnap.val() : {};
  const maxOf = s => Number(scales[s] && (scales[s].max || scales[s])) || 6;
  const sem = semSnap && semSnap.exists() ? semSnap.val() : {};
  const students = Object.entries(stSnap && stSnap.exists() ? stSnap.val() : {}).map(([sid, nm]) => ({ sid, nm: String(nm) })).sort((a, b) => a.nm.localeCompare(b.nm, 'uk'));
  const by = {}, beh = {}, cnt = {}; students.forEach(s => { by[s.sid] = {}; beh[s.sid] = []; });
  const val = x => x && x.exists() ? x.val() : null;
  months.forEach((ym, i) => {
    const g = val(per[i * 3]) || {}, t = val(per[i * 3 + 1]) || {};
    for(const subj in g) for(const key in (g[subj] || {})){
      const d = key.slice(0, 10); if(d < p.start || d > end) continue;
      for(const sid in (g[subj][key] || {})){
        if(!by[sid]) continue; const v = g[subj][key][sid]; if(v === '' || v == null) continue;
        const slot = (by[sid][subj] ||= { g: {}, t: {} }); slot.g[key] = v; slot.t[key] = (t[subj] && t[subj][key] && t[subj][key][sid]) || 'П';
      }
    }
    const bg = val(per[i * 3 + 2]);
    if(bg) for(const d in bg){ if(d < p.start || d > end) continue; for(const sid in (bg[d] || {})){ const v = Number(bg[d][sid]); if(beh[sid] && v >= 1 && v <= 6) beh[sid].push(v); } }
  });
  const subjects = new Set(); Object.values(by).forEach(x => Object.keys(x).forEach(s => subjects.add(s))); Object.keys(sem).forEach(s => subjects.add(s));
  const subjsOf = s => [...subjects].map(subj => {
    const fin = sem[subj] && (sem[subj][s.sid] || sem[subj][s.nm]);
    const slot = by[s.sid][subj];
    const r = subjResult(subj, { final: fin && fin.value, avg: slot ? subjectAvg(slot.g, slot.t).avg : null, max: maxOf(subj), junior });
    if(r) r.n = slot ? Object.keys(slot.g).length : 0;
    return r;
  }).filter(Boolean).sort((a, c) => a.subj.localeCompare(c.subj, 'uk'));
  const behOf = s => beh[s.sid].length ? beh[s.sid].reduce((a, c) => a + c, 0) / beh[s.sid].length : null;
  return { n, junior, students, subjsOf, behOf };
}
const gradeTxt = (x, junior, cls) => junior ? displayGrade(String(Math.max(2, Math.min(5, x.val))), cls) : `${x.val}${x.max !== 6 ? '/' + x.max : ''}`;
const LBL = { yes: ['✅', 'так'], check: ['🟡', 'перевірити'], near: ['⚠️', 'на межі'], no: ['—', 'ні'], none: ['—', 'немає оцінок'] };

// ── Періоди (спільні) ──
let P = null;
async function periods(){ if(!P) P = await loadPeriods(); return P; }
const yearSel = () => ({ kind: 'year', id: 'year' });
const nextSel = (kind, id) => ({ kind, id: id || (kind === 'semester' ? (P.semesters[P.semesters.length - 1] || {}).id : kind === 'month' ? (P.months[P.months.length - 1] || {}).id : 'year') });

// ═══ 🏅 Хто йде на відзнаку (обраний клас) ═══
let aSel = null, rule = '', seq = 0;
const abox = () => document.getElementById('d-award-results');
window.setAwardPeriod = (kind, id) => { aSel = nextSel(kind, id); renderAwards(); };
window.setAwardRule = k => { rule = k; renderAwards(); };
window.openAwards = async function(){
  const b = abox(); if(!b) return;
  const cls = document.getElementById('d-stat-class')?.value;
  b.hidden = false;
  if(!cls){ b.innerHTML = '<p class="empty-msg">Спершу оберіть клас.</p>'; return; }
  try{ await periods(); }catch(e){ b.innerHTML = `<p class="empty-msg">Не вдалося прочитати семестри: ${escHtml(e.message || e)}</p>`; return; }
  if(!aSel) aSel = yearSel();   // відзнаки — за рік; поки рік іде — прогноз
  rule = rule && ruleFits(rule, getClassNum(cls)) ? rule : defaultRule(getClassNum(cls));
  return renderAwards();
};
async function renderAwards(){
  const req = ++seq, b = abox(); if(!b || b.hidden) return;
  const cls = document.getElementById('d-stat-class')?.value; if(!cls || !P) return;
  const n = getClassNum(cls), p = pickPeriod(P, aSel);
  const ruleChips = Object.values(RULES).map(r => `<button type="button" class="aw-rule${r.k === rule ? ' on' : ''}${ruleFits(r.k, n) ? '' : ' off'}" aria-pressed="${r.k === rule}" onclick="setAwardRule('${r.k}')">${r.icon} ${escHtml(r.t)}</button>`).join('');
  const head = `<div class="aw-h"><h4>🏅 Хто йде на відзнаку · ${n} клас</h4>
      <div class="aw-rules" role="group" aria-label="Відзнака">${ruleChips}</div>
      <p class="aw-sub">${escHtml(RULES[rule].sub)}</p>${periodControl(P, aSel, 'setAwardPeriod')}</div>`;
  if(!ruleFits(rule, n)){ b.innerHTML = head + `<p class="empty-msg">Для ${n} класу ця відзнака не передбачена${rule === 'gram' ? ' — лише випускникам 9 і 11 класів' : rule === 'pl' ? ' — лише klasy IV–VIII' : n === 1 ? ' — у 1 класі відзнак немає' : ''}.</p>`; return; }
  b.innerHTML = head + '<p class="empty-msg is-loading">Рахую...</p>';
  try{
    const [D, staff] = await Promise.all([classData(cls, p, aSel, P, { behavior: rule === 'pl' }), staffData()]);
    if(req !== seq) return;
    const who = teachersOf(staff.access, staff.names, cls);
    if(!D.students.length){ b.innerHTML = head + '<p class="empty-msg">У класі немає учнів.</p>'; return; }
    const rows = D.students.map(s => { const subjs = D.subjsOf(s); return { s, subjs, r: award(rule, subjs, D.behOf(s), D.junior), forecast: subjs.some(x => !x.final) }; })
      .sort((a, c) => (ORDER[a.r.st] - ORDER[c.r.st]) || a.s.nm.localeCompare(c.s.nm, 'uk'));
    const cnt = k => rows.filter(x => x.r.st === k).length;
    b.innerHTML = head + `<div class="aw-sum"><div><b>${cnt('yes')}</b><span>${rule === 'gram' ? 'кандидатів' : 'на відзнаку'}</span></div>${rule === 'pl' ? `<div><b>${cnt('check')}</b><span>перевірити поведінку</span></div>` : ''}<div><b>${cnt('near')}</b><span>на межі</span></div><div><b>${D.students.length}</b><span>учнів</span></div></div>
      ${rows.some(x => x.forecast) ? `<p class="aw-note">✳️ Де семестрову ще не виставлено — <b>прогноз</b> за поточними оцінками. Остаточно вирішує педрада.</p>` : '<p class="aw-note">Остаточно вирішує педрада — це підказка за виставленими оцінками.</p>'}
      <div class="aw-list">${rows.map(x => `<details class="aw-row st-${x.r.st}">
        <summary><span class="aw-st" title="${LBL[x.r.st][1]}">${LBL[x.r.st][0]}</span><b class="aw-nm" data-no-i18n>${escHtml(x.s.nm)}</b><span class="aw-why">${escHtml(x.r.why)}</span></summary>
        <div class="aw-subjs">${x.subjs.map(sj => {
          const hi = rule === 'gram' ? sj.val >= sj.max : sj.val >= highOf(sj.max, D.junior);
          return `<span class="aw-sj${hi ? ' hi' : ' lo'}">${escHtml(sj.subj)} <b>${escHtml(gradeTxt(sj, D.junior, cls))}</b>${sj.final ? '' : ' <i title="прогноз">✳️</i>'}</span>`; }).join('') || '<span class="aw-sj">немає оцінок</span>'}
          ${rule === 'pl' ? `<span class="aw-sj${x.r.beh >= 5 ? ' hi' : x.r.beh == null ? '' : ' lo'}">Поведінка <b>${x.r.beh == null ? '—' : x.r.beh + ' · ' + behWord(x.r.beh)}</b></span>` : ''}</div>
        ${x.r.st === 'near' && x.r.low ? lowHtml(x.r.low, D.junior, cls, who) : ''}
      </details>`).join('')}</div>`;
  }catch(e){ if(req === seq) b.innerHTML = head + `<p class="empty-msg" style="color:var(--danger);">Не вдалося порахувати: ${escHtml(e.message || e)}</p>`; }
}

// ═══ 📈 Середні оцінки: «по предмету» (як було) або «по учню» ═══
let mode = 'subj', sSel = null, sSeq = 0;
window.setAvgMode = function(m){
  mode = m === 'stu' ? 'stu' : 'subj';
  document.querySelectorAll('.avg-mode button').forEach(b => { const on = b.dataset.m === mode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  const subjSel = document.getElementById('d-stat-subj'), stuSel = document.getElementById('d-stat-stu');
  if(subjSel) subjSel.hidden = mode !== 'subj';
  if(stuSel) stuSel.hidden = mode !== 'stu';
  if(mode === 'subj'){ if(window.renderDirectorStats) window.renderDirectorStats(); }
  else renderStudentAvgs();
};
// Клас змінився — оновити список учнів і відкриті панелі
window.avgClassChanged = async function(){
  const cls = document.getElementById('d-stat-class')?.value, sel = document.getElementById('d-stat-stu');
  if(sel){
    sel.innerHTML = cls ? '<option value="">Завантаження...</option>' : '<option value="">Спершу клас</option>';
    if(cls){
      const s = await get(child(ref(db), `students_list/${cls}`)).catch(() => null);
      const list = Object.entries(s && s.exists() ? s.val() : {}).map(([sid, nm]) => ({ sid, nm: String(nm) })).sort((a, b) => a.nm.localeCompare(b.nm, 'uk'));
      sel.innerHTML = '<option value="">Оберіть учня...</option>' + list.map(x => `<option value="${escHtml(x.sid)}">${escHtml(x.nm)}</option>`).join('');
    }
  }
  if(mode === 'stu') renderStudentAvgs();
  const ab = abox(); if(ab && !ab.hidden) window.openAwards();
};
window.setStuAvgPeriod = (kind, id) => { sSel = nextSel(kind, id); renderStudentAvgs(); };
window.renderStudentAvgs = renderStudentAvgs;
async function renderStudentAvgs(){
  const req = ++sSeq, out = document.getElementById('d-stat-results'); if(!out || mode !== 'stu') return;
  const cls = document.getElementById('d-stat-class')?.value, sid = document.getElementById('d-stat-stu')?.value;
  if(!cls || !sid){ out.innerHTML = '<p class="empty-msg">Оберіть клас та учня.</p>'; return; }
  try{ await periods(); }catch(e){}
  if(!P){ out.innerHTML = '<p class="empty-msg">Не вдалося прочитати семестри.</p>'; return; }
  if(!sSel) sSel = { ...P.cur };
  const p = pickPeriod(P, sSel);
  const ctl = periodControl(P, sSel, 'setStuAvgPeriod');
  out.innerHTML = ctl + '<p class="empty-msg is-loading">Рахую...</p>';
  try{
    const D = await classData(cls, p, sSel, P);
    if(req !== sSeq) return;
    const s = D.students.find(x => x.sid === sid); if(!s){ out.innerHTML = ctl + '<p class="empty-msg">Учня немає в списку класу.</p>'; return; }
    const subjs = D.subjsOf(s);
    if(!subjs.length){ out.innerHTML = ctl + '<p class="empty-msg">За цей період оцінок немає.</p>'; return; }
    const six = subjs.reduce((a, x) => a + (D.junior ? x.val : x.six), 0) / subjs.length;
    const honor = D.n >= 2 && isHonor(subjs, D.junior);
    out.innerHTML = ctl + `<table class="avg-stu"><thead><tr><th>Предмет</th><th>Середній</th><th>Підсумок</th><th>Оцінок</th></tr></thead><tbody>${subjs.map(x => {
        const hi = x.val >= highOf(x.max, D.junior);
        return `<tr><td>${escHtml(x.subj)}</td><td>${x.final ? '—' : (D.junior ? escHtml(displayGrade(String(Math.max(2, Math.round(x.avg))), cls)) + ` <small>${x.avg.toFixed(2)}</small>` : x.avg.toFixed(2))}</td>
          <td class="${hi ? 'hi' : ''}">${escHtml(gradeTxt(x, D.junior, cls))}${x.final ? ' <small>виставлено</small>' : ' <small>✳️ прогноз</small>'}</td><td>${x.n || '—'}</td></tr>`; }).join('')}</tbody></table>
      <div class="avg-stu-sum">Середнє з усіх предметів: <b>${six.toFixed(2)}</b>${D.junior ? '' : ' <small>(шкала 1–6)</small>'}${honor ? ` · 🎓 <b>відмінник</b>${honorAward(D.n) ? ` — ${escHtml(honorAward(D.n))}` : ''}` : ''}</div>`;
  }catch(e){ if(req === sSeq) out.innerHTML = ctl + `<p class="empty-msg" style="color:var(--danger);">Не вдалося порахувати: ${escHtml(e.message || e)}</p>`; }
}

// ═══ 🎓 Відмінники школи за класами (згорнуто; рахуємо, лише коли відкрили) ═══
let hSel = null, hSeq = 0;
window.setHonorPeriod = (kind, id) => { hSel = nextSel(kind, id); loadHonors(); };
window.loadHonors = loadHonors;
async function loadHonors(){
  const req = ++hSeq, out = document.getElementById('d-honors-body'); if(!out) return;
  try{ await periods(); }catch(e){ out.innerHTML = `<p class="empty-msg">Не вдалося прочитати семестри: ${escHtml(e.message || e)}</p>`; return; }
  if(!hSel) hSel = yearSel();
  const p = pickPeriod(P, hSel), ctl = periodControl(P, hSel, 'setHonorPeriod');
  out.innerHTML = ctl + '<p class="empty-msg is-loading">Рахую по всіх класах...</p>';
  try{
    // 1 клас — без оцінок (вербальне оцінювання), відзнак немає
    const classes = Array.from({ length: 10 }, (_, i) => `class_${i + 2}`);
    const [res, staff] = await Promise.all([Promise.all(classes.map(cls => classData(cls, p, hSel, P).then(D => ({ cls, D })).catch(() => ({ cls, D: null })))), staffData()]);
    if(req !== hSeq) return;
    let total = 0, totalNear = 0, forecast = false;
    const blocks = res.map(({ cls, D }) => {
      if(!D || !D.students.length) return '';
      const all = D.students.map(s => { const subjs = D.subjsOf(s); return { s, subjs, r: award('list', subjs, null, D.junior) }; });
      const honors = all.filter(x => x.r.st === 'yes'), near = all.filter(x => x.r.st === 'near');
      total += honors.length; totalNear += near.length; if(honors.some(x => x.subjs.some(y => !y.final))) forecast = true;
      const who = teachersOf(staff.access, staff.names, cls);
      const cn = `class_${D.n}`;
      return `<details class="hon-cls${honors.length || near.length ? '' : ' zero'}"><summary><b>${D.n} клас</b> <span class="hon-n">${honors.length}</span>${near.length ? `<span class="hon-near">⚠️ майже ${near.length}</span>` : ''}${honorAward(D.n) ? `<small>${escHtml(honorAward(D.n))}</small>` : ''}</summary>
        ${honors.length ? `<ul class="hon-list">${honors.map(x => `<li><b data-no-i18n>${escHtml(x.s.nm)}</b> <span>${x.subjs.length} предм.${x.subjs.some(y => !y.final) ? ' ✳️' : ''}</span></li>`).join('')}</ul>` : '<p class="empty-msg">Відмінників немає.</p>'}
        ${near.length ? `<div class="hon-nearh">⚠️ Бракує 1–2 предметів</div><ul class="hon-list hon-nl">${near.map(x => `<li><div><b data-no-i18n>${escHtml(x.s.nm)}</b>${lowHtml(x.r.low, D.junior, cn, who)}</div></li>`).join('')}</ul>` : ''}</details>`;
    }).join('');
    out.innerHTML = ctl + `<p class="hon-total">Усього відмінників: <b>${total}</b>${totalNear ? ` · ⚠️ бракує 1–2 предметів: <b>${totalNear}</b>` : ''}</p>${forecast ? '<p class="aw-note">✳️ — частина оцінок ще прогноз (семестрову не виставлено).</p>' : ''}${blocks || '<p class="empty-msg">Даних немає.</p>'}`;
  }catch(e){ if(req === hSeq) out.innerHTML = ctl + `<p class="empty-msg" style="color:var(--danger);">Не вдалося порахувати: ${escHtml(e.message || e)}</p>`; }
}
