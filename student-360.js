// ═══════════════════════════════════════════════════════════════
// student-360.js — 👤 картка учня «360°»: усе про дитину в одному вікні.
//
// ЯК ВІДКРИТИ. Натиснути ім'я учня: у журналі (стовпець «Учень»), у
// «📊 Статистиці класу», у «💬 Коментарях учням». window.openStudent360(клас, ключ).
//
// ЩО ВСЕРЕДИНІ (за обраний період: місяць · семестр · рік)
//   Огляд        — пропуски, запізнення, предмети з низьким балом, коментарі
//                  без перегляду, наліпки.
//   Оцінки       — кожен предмет: середній поточної теми, тематичні, «для
//                  семестрової», останні оцінки.
//   Відвідуваність — дні, уроки, запізнення, за предметами, дати.
//   Коментарі    — з автором, «переглянуто» й реакціями (як у «Коментарях
//                  учням»; предметник бачить свої предмети й свої коментарі).
//   Батьки       — ПІБ, хто дитині, телефони, Telegram, пошта.
//
// ПРАВА. Нічого нового: лише те, що персонал і так читає (вузли класу,
// parent_links). Медична картка — окремою кнопкою, лише класному
// керівнику й адміністрації (openStudentCard перевіряє сам).
// ═══════════════════════════════════════════════════════════════
import { ref, get, child } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, auth, currentUserData, escHtml, escJs, getDateRange, getClassNum, LEVEL_MAX_CLASS, topicBreakdown,
         displayGrade, gradeClass6, getStudentDir, stuName, childDisplayName, getParentProfile, parentFullName,
         telegramHandle, normalizeChildren, isHeadOf, teacherAccessMatrix, localDateString, THEMATIC,
         commentReactLabel } from './common.js';
import { attendanceSummary, mergeKeys, lowSubjects, subjectAvg, lowThreshold, lessonRows, lessonsPerWeekday,
         periodControl, loadPeriods, pickPeriod, monthsIn, lowListHtml, attListHtml, subjAbsHtml } from './class-stats.js';
import { flattenComments, canSeeComment } from './comments-view.js';
import { monthlySeries, trendInfo, sparkSVG, trendBadge } from './grade-trend.js';

const human = ds => ds.split('-').reverse().slice(0, 2).join('.');
const fmt = ts => ts ? new Date(ts).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
const isAdminRole = r => r === 'director' || r === 'administrator';
const PR = { mother: 'мати', father: 'батько', guardian: 'опікун' };

// ── ЧИСТА ЛОГІКА ─────────────────────────────────────────────────
// Оцінки однієї дитини з вузлів класу за місяці:
//   perMonth: [{g: grades/{клас}/{місяць}, t: grade_types/{клас}/{місяць}}]
// → {предмет: {g:{ключ: оцінка}, t:{ключ: тип}}} у межах [start, end]
export function gradesOfStudent(perMonth, sid, start, end){
  const out = {};
  (perMonth || []).forEach(({ g, t }) => {
    for(const subj in (g || {})) for(const key in (g[subj] || {})){
      const d = key.slice(0, 10); if(d < start || d > end) continue;
      const v = g[subj][key] && g[subj][key][sid];
      if(v === undefined || v === null || v === '') continue;
      const s = (out[subj] ||= { g: {}, t: {} });
      s.g[key] = v; s.t[key] = (t && t[subj] && t[subj][key] && t[subj][key][sid]) || 'П';
    }
  });
  return out;
}
// Рядок на предмет: середній поточної теми, тематичні, «для семестрової», останні оцінки
export function subjectRows(perSubj, scaleOf, junior){
  return Object.keys(perSubj || {}).sort((a, b) => a.localeCompare(b, 'uk')).map(subj => {
    const { g, t } = perSubj[subj];
    const gg = junior ? Object.fromEntries(Object.entries(g).filter(([, v]) => !(Number(v) > 6))) : g;
    const tb = topicBreakdown(gg, t);
    const sem = subjectAvg(gg, t);
    const max = junior ? 6 : scaleOf(subj);
    const keys = Object.keys(g).sort();
    const series = monthlySeries(gg, t);
    return { subj, n: keys.length, current: tb.current.avg, thematic: tb.thematic.map(x => x.v), series, trend: trendInfo(series, max), max,
             sem: sem.avg, semBy: sem.by, low: sem.avg !== null && sem.avg !== undefined && sem.avg < lowThreshold(max, junior),
             last: keys.slice(-8).map(k => ({ key: k, v: g[k], t: t[k] })) };
  });
}
// Батьки цієї дитини з parent_links
export function parentsOf(links, cls, sid, name){
  const out = [];
  const nm = String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();
  for(const se in (links || {})){
    const kids = normalizeChildren(links[se]);
    const k = kids.find(c => c && c.class === cls && (c.studentId === sid || String(c.studentName || '').replace(/\s+/g, ' ').trim().toLowerCase() === nm));
    if(!k) continue;
    const prof = getParentProfile(links[se]);
    const full = parentFullName(prof, '');
    out.push({ se, email: se.replace(/_/g, '.'), name: full && full !== '—' ? full : '', role: k.role || '',
               phonePL: prof.phonePL || '', phoneUA: prof.phoneUA || '', telegram: prof.telegram || '' });
  }
  return out.sort((a, b) => (a.role === 'mother' ? 0 : a.role === 'father' ? 1 : 2) - (b.role === 'mother' ? 0 : b.role === 'father' ? 1 : 2));
}

// ── ВІКНО ────────────────────────────────────────────────────────
let s3 = { cls: '', sid: '', tab: 'overview', P: null, sel: null, seq: 0, data: null };
function ensureModal(){
  let m = document.getElementById('student-360-modal'); if(m) return m;
  m = document.createElement('div');
  m.id = 'student-360-modal'; m.className = 'modal-overlay';
  m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-labelledby', 's3-title');
  m.innerHTML = `<div class="modal-content s3-box">
      <div class="s3-head">
        <div><h3 id="s3-title">👤 Учень</h3><div id="s3-sub" class="s3-sub"></div></div>
        <button type="button" class="s3-close" onclick="closeStudent360()" aria-label="Закрити">✕</button>
      </div>
      <div id="s3-period"></div>
      <div class="s3-tabs" role="tablist">
        ${[['overview', 'Огляд'], ['grades', 'Оцінки'], ['att', 'Відвідуваність'], ['comments', 'Коментарі'], ['parents', 'Батьки']]
          .map(([k, l]) => `<button type="button" role="tab" data-s3tab="${k}" onclick="s3Tab('${k}')">${l}</button>`).join('')}
      </div>
      <div id="s3-body" role="tabpanel"><p class="empty-msg is-loading">Завантаження...</p></div>
    </div>`;
  m.addEventListener('click', e => { if(e.target === m) window.closeStudent360(); });
  m.addEventListener('keydown', e => { if(e.key === 'Escape') window.closeStudent360(); });
  document.body.appendChild(m);
  return m;
}
window.closeStudent360 = () => { const m = document.getElementById('student-360-modal'); if(m) m.style.display = 'none'; };
window.openStudent360 = async function(cls, sid, ev){
  if(ev && ev.stopPropagation) ev.stopPropagation();
  if(!cls || !sid) return;
  const m = ensureModal(); m.style.display = 'flex';
  s3.cls = cls; s3.sid = sid; s3.tab = 'overview'; s3.data = null;
  await getStudentDir(cls).catch(() => {});
  document.getElementById('s3-title').textContent = `👤 ${stuName(cls, sid)}`;
  document.getElementById('s3-sub').textContent = `${cls.replace('class_', '')} клас`;
  try{ if(!s3.P){ s3.P = await loadPeriods(); s3.sel = { ...s3.P.cur }; } }catch(e){}
  paintPeriod(); paintTabs(); load();
};
function paintPeriod(){ const b = document.getElementById('s3-period'); if(b && s3.P) b.innerHTML = periodControl(s3.P, s3.sel, 's3SetPeriod'); }
function paintTabs(){ document.querySelectorAll('[data-s3tab]').forEach(b => { const on = b.dataset.s3tab === s3.tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); }); }
window.s3SetPeriod = (kind, id) => {
  const P = s3.P; if(!P) return;
  const list = kind === 'semester' ? P.semesters : P.months;
  const keep = s3.sel && s3.sel.kind === kind ? s3.sel.id : null;
  s3.sel = { kind, id: id || keep || (kind === 'year' ? 'year' : (kind === P.cur.kind ? P.cur.id : list[list.length - 1]?.id)) };
  paintPeriod(); load();
};
window.s3Tab = k => { s3.tab = k; paintTabs(); paint(); };

async function load(){
  const req = ++s3.seq;
  const body = document.getElementById('s3-body'); if(!body) return;
  body.innerHTML = '<p class="empty-msg is-loading">Завантаження...</p>';
  const { cls, sid } = s3;
  const p = s3.P ? pickPeriod(s3.P, s3.sel) : { start: `${localDateString.slice(0, 4)}-09-01`, end: localDateString };
  const end = p.end < localDateString ? p.end : localDateString;
  const months = monthsIn(p.start, end);
  try{
    const name = stuName(cls, sid);
    const [scSnap, sched, att, cm, meta, seen, rx, links, stick, head, ...per] = await Promise.all([
      get(child(ref(db), `grade_scales/${cls}`)).catch(() => null),
      get(child(ref(db), `schedules/${cls}/lessons`)).catch(() => null),
      getDateRange(`attendance/${cls}`, p.start, end),
      getDateRange(`comments/${cls}`, p.start, end),
      getDateRange(`comment_meta/${cls}`, p.start, end),
      getDateRange(`comment_seen/${cls}`, p.start, end),
      getDateRange(`reactions/${cls}`, p.start, end),
      get(child(ref(db), 'parent_links')).catch(() => null),
      get(child(ref(db), `stickers/${cls}/${sid}`)).catch(() => null),
      isHeadOf(cls),
      ...months.flatMap(ym => [get(child(ref(db), `grades/${cls}/${ym}`)).catch(() => null), get(child(ref(db), `grade_types/${cls}/${ym}`)).catch(() => null)])
    ]);
    if(req !== s3.seq) return;
    const val = x => x && x.exists() ? x.val() : {};
    const scales = val(scSnap), junior = getClassNum(cls) <= LEVEL_MAX_CLASS;
    const scaleOf = s => Number(scales[s] && (scales[s].max || scales[s])) || 6;
    const perMonth = months.map((_, i) => ({ g: val(per[i * 2]), t: val(per[i * 2 + 1]) }));
    const perSubj = gradesOfStudent(perMonth, sid, p.start, end);
    const lessons = val(sched);
    const a = attendanceSummary(mergeKeys(att, [sid, name]), lessonsPerWeekday(lessons), lessonRows(lessons));
    const raw = (teacherAccessMatrix || {})[cls];
    const ctx = { head: head || isAdminRole(currentUserData?.role), allowed: Array.isArray(raw) ? raw : Object.values(raw || {}), uid: auth.currentUser?.uid || '' };
    const comments = flattenComments(cm, meta, seen, rx, k => (window.stuId && window.stuId(cls, k)) || null).filter(c => c.sid === sid && canSeeComment(c, ctx));
    const L = val(links), names = {};
    for(const se in L){ const n = parentFullName(getParentProfile(L[se]), ''); if(n && n !== '—') names[se] = n; }
    const stickers = Object.values(val(stick)).filter(x => x && typeof x === 'object');
    s3.data = { cls, sid, name, junior, scaleOf, rows: subjectRows(perSubj, scaleOf, junior),
                low: lowSubjects(perSubj, scaleOf, junior), a, comments, names, head: ctx.head,
                parents: parentsOf(L, cls, sid, name), stickers, period: p };
    paint();
  }catch(e){
    if(req === s3.seq) body.innerHTML = `<p class="empty-msg" style="color:var(--danger);">Не вдалося завантажити: ${escHtml(e.message || '')}</p>`;
  }
}

function gradeChip(v, t, cls, scale){
  return `<span class="g-cell ${scale && scale !== 6 ? 'g-scale' : gradeClass6(v)}${t === THEMATIC ? ' g-thematic' : ''}" title="${escHtml(t || '')}"><span class="g-val">${escHtml(displayGrade(v, cls, scale && scale !== 6))}</span></span>`;
}
const num = (x, junior, cls) => x === null || x === undefined ? '—'
  : `${x.toFixed(2)}${junior ? ` <span class="s3-mute">(${escHtml(displayGrade(String(Math.max(2, Math.round(x))), cls))})</span>` : ''}`;
function viewer(v, names){
  if(v.role === 'student') return 'учень';
  return names[v.se] || `${String(v.se || '').replace(/_/g, '.')}${PR[v.pr] ? ` (${PR[v.pr]})` : ''}`;
}
function paint(){
  const body = document.getElementById('s3-body'); const d = s3.data;
  if(!body || !d) return;
  const { cls, a } = d;
  if(s3.tab === 'overview'){
    const unseen = d.comments.filter(c => !c.viewers.length).length;
    const tile = (v, l, k, tab) => `<button type="button" class="s3-tile${v ? ' ' + k : ''}" onclick="s3Tab('${tab}')"><b>${v}</b><span>${l}</span></button>`;
    body.innerHTML = `<div class="s3-tiles">
        ${tile(a.days.length, 'пропущено днів', 'bad', 'att')}${tile(a.lessonCount, 'пропущено уроків', 'warn', 'att')}${tile(a.late.length, 'запізнень', 'warn', 'att')}
        ${tile(d.low.length, 'предметів з низьким балом', 'bad', 'grades')}${tile(d.comments.length, `коментарів${unseen ? ` · ${unseen} без перегляду` : ''}`, unseen ? 'warn' : '', 'comments')}${tile(d.stickers.length, 'наліпок', '', 'overview')}
      </div>
      <h4 class="s3-h">Предмети з низьким балом</h4>${lowListHtml(d.low, cls)}
      ${d.head ? `<button type="button" class="s3-btn" onclick="openStudentCard('${escJs(cls)}','${escJs(d.sid)}','${escJs(d.name)}')">📋 Картка учня (медичні дані, документи)</button>` : ''}`;
  }else if(s3.tab === 'grades'){
    body.innerHTML = d.rows.length ? `<div class="s3-wrap"><table class="s3-table"><thead><tr><th>Предмет</th><th>Оцінок</th><th>Поточна<br>тема</th><th>Тематичні</th><th>Для<br>семестру</th><th>Динаміка</th><th>Останні</th></tr></thead><tbody>
      ${d.rows.map(r => `<tr class="${r.low ? 's3-low' : ''}"><td><b>${escHtml(r.subj)}</b></td><td class="s3-c">${r.n}</td>
        <td class="s3-c">${num(r.current, d.junior, cls)}</td>
        <td>${r.thematic.length ? r.thematic.map(v => gradeChip(v, THEMATIC, cls, d.scaleOf(r.subj))).join(' ') : '<span class="s3-mute">—</span>'}</td>
        <td class="s3-c">${num(r.sem, d.junior, cls)}${r.sem !== null && r.sem !== undefined ? `<br><span class="s3-mute">${r.semBy === 'thematic' ? 'з тематичних' : 'зважений'}</span>` : ''}</td>
        <td class="s3-trend">${sparkSVG(r.series, d.junior ? 5 : r.max, d.junior ? 2 : 1)}<br>${trendBadge(r.trend, r.max)}</td>
        <td class="s3-last">${r.last.map(x => gradeChip(x.v, x.t, cls, d.scaleOf(r.subj))).join(' ')}</td></tr>`).join('')}
      </tbody></table></div><p class="cst-note">Червоним — середній нижче порогу (1–12: менше 4; 1–6 і рівні: менше 3). «Для семестру» — як рахується пропозиція семестрової.</p>`
      : '<p class="empty-msg">За цей період оцінок немає.</p>';
  }else if(s3.tab === 'att'){
    body.innerHTML = `<p class="s3-line">Пропущено <b>${a.days.length}</b> дн. і <b>${a.lessonCount}</b> уроків (${a.inDays} — у пропущені дні, ${a.lessonCount - a.inDays} окремо), запізнень — <b>${a.late.length}</b>.</p>
      ${subjAbsHtml(a)}${attListHtml(a)}`;
  }else if(s3.tab === 'comments'){
    body.innerHTML = (d.head ? '' : '<p class="cst-note">Коментарі з ваших предметів і ті, що ви написали самі.</p>')
      + (d.comments.length ? d.comments.map(c => `<article class="cv-item">
        <div class="cv-top"><b>${escHtml(c.subj)}</b><span class="cv-mute">${escHtml(human(c.date))}</span>${c.meta ? `<span class="cv-mute">✍️ ${escHtml(c.meta.name || '')}</span>` : ''}</div>
        <div class="cv-text">${escHtml(c.text)}</div>
        ${c.viewers.length ? `<div class="cv-seen">👁 ${c.viewers.map(v => `${escHtml(viewer(v, d.names))} <span class="cv-mute">${escHtml(fmt(v.ts))}</span>`).join(' · ')}</div>` : '<div class="cv-seen cv-no">👁 Ще не переглянуто</div>'}
        ${c.reaction ? `<div class="cv-react${c.reaction === '😔' || c.reaction === '🤔' ? ' warn' : ''}">${escHtml(c.reaction)} ${escHtml(commentReactLabel(c.reaction))}${c.reactBy ? ` — ${escHtml(viewer(c.reactBy, d.names))}, ${escHtml(fmt(c.reactBy.rts))}` : ''}</div>` : ''}
      </article>`).join('') : '<p class="empty-msg">За цей період коментарів немає.</p>')
      + `<button type="button" class="s3-btn" onclick="closeStudent360();openCommentsView({cls:'${escJs(cls)}',sid:'${escJs(d.sid)}'})">💬 Відкрити в «Коментарях учням»</button>`;
  }else if(s3.tab === 'parents'){
    body.innerHTML = d.parents.length ? d.parents.map(pa => {
      const tg = telegramHandle(pa.telegram);
      const tel = n => n ? `<a href="tel:${escHtml(n.replace(/[^+\d]/g, ''))}">${escHtml(n)}</a>` : '';
      return `<div class="s3-parent"><b>${escHtml(pa.name || pa.email)}</b> <span class="s3-mute">${escHtml(PR[pa.role] || 'батьки')}</span>
        <div class="s3-contacts">${[tel(pa.phonePL), tel(pa.phoneUA), tg ? `<a href="${escHtml(tg.url)}" target="_blank" rel="noopener noreferrer">✈️ ${escHtml(tg.handle)}</a>` : '',
          `<a href="mailto:${escHtml(pa.email)}">${escHtml(pa.email)}</a>`].filter(Boolean).join(' · ')}</div></div>`;
    }).join('') : '<p class="empty-msg">До цієї дитини ще не прив’язано жодного акаунта батьків.</p>';
  }
}
