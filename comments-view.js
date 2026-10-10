// ═══════════════════════════════════════════════════════════════
// comments-view.js — 💬 усі коментарі учням: хто написав, чи переглянули
// батьки, хто й коли поставив реакцію.
//
// ЩО БАЧИТЬ УЧИТЕЛЬ («Швидкі дії» → «💬 Коментарі»)
//   • Предметник — коментарі зі своїх предметів у класі (за матрицею
//     доступу) і все, що написав сам (зокрема «Перерва», «ГПД»).
//   • Класний керівник свого класу, директор, адміністрація — усі.
//   Фільтри: клас, період (місяць · семестр · рік), учень, предмет, стан
//   (усі / не переглянуті / з реакцією).
//
// ДЕ ЛЕЖИТЬ
//   comments/{клас}/{дата}/{предмет}/{учень}      = текст (як і було)
//   comment_meta/{клас}/{дата}/{предмет}/{учень}  = {by, se, name, ts}
//       хто написав. Пишеться разом із коментарем; у старих коментарів
//       його немає — тоді «автор невідомий».
//   comment_seen/{клас}/{дата}/{предмет}/{учень}/{uid} = {ts, se, role, pr, r?, rts?}
//       хто з родини переглянув (коментар був на екрані хоча б секунду)
//       і яку реакцію поставив і коли. Читає лише персонал.
//   reactions/{клас}/{дата}/{предмет}/{учень}     = емодзі (як і було — одна
//       на дитину; хто саме її поставив — з comment_seen).
// ═══════════════════════════════════════════════════════════════
import { ref, get, set, update, child } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, auth, currentUserData, escHtml, escJs, getActiveClass, getDateRange, teacherAccessMatrix,
         isHeadOf, COMMENT_REACTS, commentReactLabel, childDisplayName, getParentProfile, getStudentDir, stuName,
         localDateString } from './common.js';
import { periodControl, loadPeriods, pickPeriod } from './class-stats.js';
import { pName, parentLabel } from './news-reactions.js';

const seKey = e => String(e || '').replace(/\./g, '_');
const role = () => currentUserData?.role;
const isFamily = () => role() === 'parent' || role() === 'student';
const isAdminRole = r => r === 'director' || r === 'administrator';
const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const ALL = 'Всі предмети';

// ── ЧИСТА ЛОГІКА ─────────────────────────────────────────────────
// Плоский список коментарів за діапазоном дат.
//   comments/meta/seen/reacts — вузли класу {дата: {предмет: {учень: ...}}}
// alias(ключ) — інший ключ того самого учня. Старі коментарі лежать під
// ІМЕНЕМ, а родина (через дзеркало) ставить реакцію й «переглянуто» під
// ідентифікатором — без цього вчитель їх не бачив.
export function flattenComments(comments, meta, seen, reacts, alias = () => null){
  const out = [];
  for(const d in (comments || {})) for(const s in (comments[d] || {})) for(const sid in (comments[d][s] || {})){
    const text = comments[d][s][sid];
    if(typeof text !== 'string' || !text.trim()) continue;
    const m = meta?.[d]?.[s]?.[sid] || null;
    const alt = alias(sid);
    const sn = { ...((alt && seen?.[d]?.[s]?.[alt]) || {}), ...(seen?.[d]?.[s]?.[sid] || {}) };
    // Перегляди, старіші за останню правку тексту, — про попередній коментар
    const since = (m && m.ts) || 0;
    const viewers = Object.entries(sn).filter(([, v]) => v && typeof v === 'object' && (v.ts || 0) >= since)
      .map(([uid, v]) => ({ uid, ...v })).sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const reaction = reacts?.[d]?.[s]?.[sid] || (alt && reacts?.[d]?.[s]?.[alt]) || null;
    // Хто поставив реакцію: той, у кого в перегляді записана саме вона;
    // якщо таких кілька — останній за часом.
    const by = viewers.filter(v => v.r && v.r === reaction).sort((a, b) => (b.rts || 0) - (a.rts || 0))[0] || null;
    out.push({ date: d, subj: s, sid, text, meta: m, viewers, reaction, reactBy: by });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || a.subj.localeCompare(b.subj, 'uk'));
}
// Які коментарі бачить цей працівник.
//   allowed — перелік предметів із матриці (або ALL), head — класний/адмін
export function canSeeComment(c, { head, allowed, uid }){
  if(head) return true;
  if(c.meta && c.meta.by === uid) return true;
  const list = (allowed || []).map(norm);
  if(list.includes(norm(ALL))) return true;
  return list.includes(norm(c.subj));
}
export function filterComments(list, f){
  return list.filter(c =>
    (!f.sid || c.sid === f.sid) &&
    (!f.subj || c.subj === f.subj) &&
    (f.state !== 'unseen' || !c.viewers.length) &&
    (f.state !== 'reacted' || !!c.reaction) &&
    (f.state !== 'mine' || (c.meta && c.meta.by === f.uid)));
}

// ── РОДИНА: «ПЕРЕГЛЯНУТО» І РЕАКЦІЯ ─────────────────────────────
function familyRec(){
  const u = currentUserData || {};
  const rec = { se: seKey(auth.currentUser?.email || u.email), role: u.role };
  if(u.role === 'parent' && u.parentRole) rec.pr = String(u.parentRole).slice(0, 20);
  return rec;
}
const SEEN_LS = 'push_school_comment_seen';
let seenLocal = null;
const seenSet = () => { if(seenLocal) return seenLocal; try{ seenLocal = new Set(JSON.parse(localStorage.getItem(SEEN_LS) || '[]')); }catch(e){ seenLocal = new Set(); } return seenLocal; };
async function markCommentSeen(cls, date, subj, sid){
  const uid = auth.currentUser?.uid; if(!uid || !isFamily()) return;
  const key = `${uid}|${cls}|${date}|${subj}|${sid}`, s = seenSet();
  if(s.has(key)) return;
  s.add(key); try{ localStorage.setItem(SEEN_LS, JSON.stringify([...s].slice(-600))); }catch(e){}
  const base = `comment_seen/${cls}/${date}/${subj}/${sid}/${uid}`;
  try{
    // ts — лише перший перегляд: якщо запис уже є, не переписуємо
    const cur = await get(child(ref(db), `${base}/ts`)).catch(() => null);
    if(cur && cur.exists()) return;
    await update(ref(db, base), { ...familyRec(), ts: Date.now() });
  }catch(e){ s.delete(key); console.warn('comment_seen:', e.message); }
}
// Реакцію parent-student.js пише в reactions, а тут — хто й коли
window.markCommentReact = async function(cls, date, subj, sid, emoji){
  const uid = auth.currentUser?.uid; if(!uid || !isFamily()) return;
  const base = `comment_seen/${cls}/${date}/${subj}/${sid}/${uid}`;
  try{
    const cur = await get(child(ref(db), `${base}/ts`)).catch(() => null);
    await update(ref(db, base), { ...familyRec(), ...(cur && cur.exists() ? {} : { ts: Date.now() }),
      r: emoji || null, rts: emoji ? Date.now() : null });
  }catch(e){ console.warn('comment react meta:', e.message); }
};
let obs = null;
window.observeCommentsSeen = function(container){
  if(!container || !isFamily()) return;
  const els = container.querySelectorAll('[data-cm-sid]');
  const go = el => markCommentSeen(el.dataset.cmCls, el.dataset.cmDate, el.dataset.cmSubj, el.dataset.cmSid);
  if(!('IntersectionObserver' in window)){ els.forEach(go); return; }
  if(!obs){
    const timers = new Map();
    obs = new IntersectionObserver(entries => entries.forEach(en => {
      const el = en.target;
      if(en.isIntersecting) timers.set(el, setTimeout(() => { go(el); obs.unobserve(el); timers.delete(el); }, 1000));
      else if(timers.has(el)){ clearTimeout(timers.get(el)); timers.delete(el); }
    }), { threshold: 0.6 });
  }
  els.forEach(el => obs.observe(el));
};

// ── ПЕРСОНАЛ: ВІКНО КОМЕНТАРІВ ──────────────────────────────────
let cvP = null, cvSel = null, cvSeq = 0;
const cvF = { cls: '', sid: '', subj: '', state: '' };
function ensureModal(){
  let m = document.getElementById('comments-view-modal'); if(m) return m;
  m = document.createElement('div');
  m.id = 'comments-view-modal'; m.className = 'modal-overlay';
  m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-labelledby', 'cv-title');
  m.innerHTML = `<div class="modal-content cv-box">
      <div class="cv-head"><h3 id="cv-title">💬 Коментарі учням</h3>
        <button type="button" class="cv-close" onclick="closeCommentsView()" aria-label="Закрити">✕</button></div>
      <div id="cv-period"></div>
      <div class="cv-filters">
        <label>Клас<select id="cv-cls" onchange="cvSet('cls',this.value)"></select></label>
        <label>Учень<select id="cv-sid" onchange="cvSet('sid',this.value)"></select></label>
        <label>Предмет<select id="cv-subj" onchange="cvSet('subj',this.value)"></select></label>
        <label>Показати<select id="cv-state" onchange="cvSet('state',this.value)">
          <option value="">Усі</option><option value="unseen">Не переглянуті</option>
          <option value="reacted">З реакцією</option><option value="mine">Лише мої</option></select></label>
      </div>
      <div id="cv-body"><p class="empty-msg is-loading">Завантаження...</p></div>
    </div>`;
  m.addEventListener('click', e => { if(e.target === m) window.closeCommentsView(); });
  m.addEventListener('keydown', e => { if(e.key === 'Escape') window.closeCommentsView(); });
  document.body.appendChild(m);
  return m;
}
window.closeCommentsView = () => { const m = document.getElementById('comments-view-modal'); if(m) m.style.display = 'none'; };
function myClasses(){
  if(isAdminRole(role())) return Array.from({ length: 11 }, (_, i) => `class_${i + 1}`);
  return Object.keys(teacherAccessMatrix || {}).filter(c => /^class_\d+$/.test(c))
    .sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)));
}
window.openCommentsView = async function(opts){
  const m = ensureModal(); m.style.display = 'flex';
  const classes = myClasses();
  cvF.cls = (opts && opts.cls) || (classes.includes(getActiveClass()) ? getActiveClass() : classes[0] || getActiveClass());
  cvF.sid = (opts && opts.sid) || ''; cvF.subj = ''; cvF.state = '';
  document.getElementById('cv-cls').innerHTML = classes.map(c => `<option value="${c}"${c === cvF.cls ? ' selected' : ''}>${c.replace('class_', '')} клас</option>`).join('');
  document.getElementById('cv-state').value = '';
  try{ if(!cvP){ cvP = await loadPeriods(); cvSel = { ...cvP.cur }; } }catch(e){}
  paintPeriod(); render();
};
function paintPeriod(){ const b = document.getElementById('cv-period'); if(b && cvP) b.innerHTML = periodControl(cvP, cvSel, 'cvSetPeriod'); }
window.cvSetPeriod = (kind, id) => {
  if(!cvP) return;
  const list = kind === 'semester' ? cvP.semesters : cvP.months;
  const keep = cvSel && cvSel.kind === kind ? cvSel.id : null;
  cvSel = { kind, id: id || keep || (kind === 'year' ? 'year' : (kind === cvP.cur.kind ? cvP.cur.id : list[list.length - 1]?.id)) };
  paintPeriod(); render();
};
window.cvSet = (k, v) => { cvF[k] = v; if(k === 'cls'){ cvF.sid = ''; cvF.subj = ''; } render(k !== 'cls'); };

let cvData = null;   // {key, list, names, students}
const human = ds => ds.split('-').reverse().join('.');
const fmt = ts => ts ? new Date(ts).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
function viewerLabel(v, names, childName){
  if(v.role === 'student') return `${childDisplayName(childName) || 'Учень'} (учень)`;
  return parentLabel(names[v.se], v.se, v.pr);
}
async function render(keepData){
  const req = ++cvSeq;
  const body = document.getElementById('cv-body'); if(!body) return;
  const cls = cvF.cls, p = cvP && pickPeriod(cvP, cvSel);
  if(!cls || !p){ body.innerHTML = '<p class="empty-msg">Немає класів.</p>'; return; }
  const end = p.end < localDateString ? p.end : localDateString;
  const key = `${cls}|${p.start}|${end}`;
  try{
    if(!keepData || !cvData || cvData.key !== key){
      body.innerHTML = '<p class="empty-msg is-loading">Завантаження...</p>';
      const [cm, meta, seen, rx, links, head] = await Promise.all([
        getDateRange(`comments/${cls}`, p.start, end, true),
        getDateRange(`comment_meta/${cls}`, p.start, end),
        getDateRange(`comment_seen/${cls}`, p.start, end),
        getDateRange(`reactions/${cls}`, p.start, end),
        get(child(ref(db), 'parent_links')).catch(() => null),
        isHeadOf(cls),
        getStudentDir(cls).catch(() => null)
      ]);
      if(req !== cvSeq) return;
      const names = {}; const L = links && links.exists() ? links.val() : {};
      for(const se in L){ const n = pName(getParentProfile(L[se])); if(n) names[se] = n; }
      const raw = (teacherAccessMatrix || {})[cls];
      const allowed = Array.isArray(raw) ? raw : Object.values(raw || {});
      const ctx = { head: head || isAdminRole(role()), allowed, uid: auth.currentUser?.uid || '' };
      const list = flattenComments(cm, meta, seen, rx, k => (window.stuId && window.stuId(cls, k)) || null).filter(c => canSeeComment(c, ctx));
      cvData = { key, list, names, head: ctx.head };
    }
    const { list, names } = cvData;
    // Фільтри «учень» і «предмет» — з того, що реально є
    const sids = [...new Set(list.map(c => c.sid))].map(sid => ({ sid, nm: stuName(cls, sid) }))
      .sort((a, b) => a.nm.localeCompare(b.nm, 'uk'));
    const subjs = [...new Set(list.map(c => c.subj))].sort((a, b) => a.localeCompare(b, 'uk'));
    document.getElementById('cv-sid').innerHTML = '<option value="">Усі учні</option>' + sids.map(x =>
      `<option value="${escHtml(x.sid)}"${x.sid === cvF.sid ? ' selected' : ''}>${escHtml(x.nm)}</option>`).join('');
    document.getElementById('cv-subj').innerHTML = '<option value="">Усі предмети</option>' + subjs.map(s =>
      `<option value="${escHtml(s)}"${s === cvF.subj ? ' selected' : ''}>${escHtml(s)}</option>`).join('');
    const shown = filterComments(list, { ...cvF, uid: auth.currentUser?.uid || '' });
    const seenN = shown.filter(c => c.viewers.length).length, rN = shown.filter(c => c.reaction).length;
    const note = cvData.head ? '' : '<p class="cv-note">Показано коментарі з ваших предметів у цьому класі й ті, що ви написали самі.</p>';
    body.innerHTML = note + `<p class="cv-sum">Коментарів: <b>${shown.length}</b> · переглянули батьки: <b>${seenN}</b> · з реакцією: <b>${rN}</b></p>`
      + (shown.length ? shown.map(c => {
        const nm = stuName(cls, c.sid);
        const author = c.meta ? escHtml(c.meta.name || 'учитель') : '<span class="cv-mute">автор невідомий</span>';
        const views = c.viewers.length
          ? `<div class="cv-seen">👁 ${c.viewers.map(v => `${escHtml(viewerLabel(v, names, nm))} <span class="cv-mute">${escHtml(fmt(v.ts))}</span>`).join(' · ')}</div>`
          : '<div class="cv-seen cv-no">👁 Ще не переглянуто</div>';
        const lbl = c.reaction ? commentReactLabel(c.reaction) : '';
        const react = c.reaction
          ? `<div class="cv-react${c.reaction === '😔' || c.reaction === '🤔' ? ' warn' : ''}">${escHtml(c.reaction)} ${escHtml(lbl)} — ${
              c.reactBy ? `${escHtml(viewerLabel(c.reactBy, names, nm))}, ${escHtml(fmt(c.reactBy.rts))}` : '<span class="cv-mute">хто й коли — невідомо (поставлено до оновлення)</span>'}</div>` : '';
        return `<article class="cv-item">
          <div class="cv-top"><button type="button" class="sn-link" onclick="openStudent360('${escJs(cls)}','${escJs(c.sid)}',event)">${escHtml(nm)}</button><span>${escHtml(c.subj)}</span><span class="cv-mute">${escHtml(human(c.date))}</span></div>
          <div class="cv-text">${escHtml(c.text)}</div>
          <div class="cv-author">✍️ ${author}</div>${views}${react}
        </article>`;
      }).join('') : '<p class="empty-msg">Коментарів за цими умовами немає.</p>');
  }catch(e){
    if(req === cvSeq) body.innerHTML = `<p class="empty-msg" style="color:var(--danger);">Не вдалося завантажити: ${escHtml(e.message || '')}</p>`;
  }
}
