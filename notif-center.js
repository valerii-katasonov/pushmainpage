// ═══════════════════════════════════════════════════════════════
// notif-center.js — 🔔 центр сповіщень (підхід 8).
//
// ЩО ЦЕ. Дзвіночок у шапці кабінету з числом нового і список за два
// тижні: оцінки, коментарі, ДЗ, оголошення, запити школи, відповіді
// вчителя — для родини; оголошення, «батьки просять звʼязатися» і реакції
// батьків на свої коментарі — для вчителя й адміністрації. Кожен рядок
// веде туди, де це видно в кабінеті.
//
// ЗВІДКИ ДАНІ. Окремої «скриньки» в базі немає — центр збирає список із
// того, що людина й так має право читати (дзеркала своєї дитини, ДЗ класу,
// оголошення, запити). Тому він працює й без увімкнених push, не може
// показати більше, ніж кабінет, і не потребує сервера. Свій лише один
// запис: notif_seen/{uid} = {ts} — коли людина востаннє переглянула
// список (так «нове» однакове на телефоні й компʼютері). Поки правила з
// цим вузлом не опубліковані, позначка живе в localStorage.
//
// ЧАС ПОДІЇ. Оцінки й коментарі мають ts (коли поставили — дописується з
// 10.10.2026). Для старіших записів беремо полудень дня уроку.
// ═══════════════════════════════════════════════════════════════
import { ref, get, set, child, query, orderByKey, startAt, limitToLast } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, auth, currentUserData, getActiveClass, isTeacherRole, stuId, displayGrade, emailKey, escHtml, openTabByKey, screenIdForRole } from './common.js';

export const WINDOW_DAYS = 14;
const DAY = 86400000;
const pad = n => String(n).padStart(2, '0');
export const dateStr = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
// Полудень дня уроку — для записів без власного часу
export const noonOf = ds => { const [y, m, d] = String(ds).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d, 12).getTime(); };
const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const isFamily = r => r === 'parent' || r === 'student';
const isStaffRole = r => isTeacherRole(r) || r === 'director' || r === 'administrator';

export function relTime(ts, now = Date.now()){
  const min = Math.round((now - ts) / 60000);
  if(min < 1) return 'щойно';
  if(min < 60) return `${min} хв тому`;
  const h = Math.round(min / 60);
  if(h < 24) return `${h} год тому`;
  const d = Math.round(h / 24);
  if(d === 1) return 'вчора';
  if(d < 7) return `${d} дн тому`;
  return new Date(ts).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' });
}

// ── РОДИНА: дані → рядки ────────────────────────────────────────
// d = {grades, comments, hw, news, consents, consentResp, talks}
// o = {cls, sid, from (мс), role, se}
export function familyItems(d, o){
  const out = [], from = o.from;
  // Оцінки: {місяць: {предмет: {ключ: {v, t, ts}}}}
  for(const ym in (d.grades || {})) for(const subj in (d.grades[ym] || {})) for(const key in (d.grades[ym][subj] || {})){
    const c = d.grades[ym][subj][key] || {};
    if(c.v == null || c.v === '') continue;
    const ts = Number(c.ts) || noonOf(key);
    if(ts < from) continue;
    out.push({ id: `g:${subj}:${key}`, kind: 'grade', icon: '📊', ts,
      title: `${subj}: ${displayGrade(c.v, o.cls)}${c.t === 'ТО' ? ' (тематична)' : ''}`, sub: 'нова оцінка', go: { tab: 'grades' } });
  }
  // Коментарі: {дата: {предмет: {t, r, ts}}}
  for(const date in (d.comments || {})) for(const subj in (d.comments[date] || {})){
    const c = d.comments[date][subj] || {};
    if(!c.t) continue;
    const ts = Number(c.ts) || noonOf(date);
    if(ts < from) continue;
    out.push({ id: `c:${date}:${subj}`, kind: 'comment', icon: '💬', ts,
      title: `Коментар: ${subj}`, sub: cut(c.t, 90), flag: c.r ? '' : 'без реакції', go: { tab: 'grades' } });
  }
  // ДЗ: {дата: {предмет: {text, ts} | рядок}}
  for(const date in (d.hw || {})) for(const subj in (d.hw[date] || {})){
    const v = d.hw[date][subj];
    const text = typeof v === 'string' ? v : (v && v.text) || '';
    const has = text.trim() || (v && ((v.images && v.images.length) || (v.trainers && Object.keys(v.trainers).length)));
    if(!has) continue;
    const ts = (v && Number(v.ts)) || noonOf(date);
    if(ts < from) continue;
    out.push({ id: `h:${date}:${subj}`, kind: 'hw', icon: '📚', ts, title: `ДЗ: ${subj}`, sub: cut(text, 90) || 'з вкладенням', go: { tab: 'hw' } });
  }
  // Оголошення школи й свого класу, ще чинні
  newsItems(d.news, a => a.scope === 'school' || a.class === o.cls, from)
    .forEach(x => out.push({ ...x, go: { tab: o.role === 'student' ? 'news' : 'school' } }));
  // Запити школи без відповіді (лише батьки)
  if(o.role === 'parent'){
    for(const id in (d.consents || {})){
      const c = d.consents[id] || {};
      const list = Array.isArray(c.classes) ? c.classes : Object.values(c.classes || {});
      if(!list.includes(o.cls)) continue;
      const answered = d.consentResp && d.consentResp[id] && d.consentResp[id][o.cls]
        && (d.consentResp[id][o.cls][o.sid] || (o.name && d.consentResp[id][o.cls][o.name]));
      if(answered) continue;
      const ts = Number(c.createdAt) || 0;
      if(ts < from && !(c.deadline && c.deadline >= dateStr(Date.now()))) continue;
      out.push({ id: `q:${id}`, kind: 'consent', icon: '📋', ts: ts || from, title: `Школа просить відповісти: ${cut(c.title, 60)}`,
        sub: c.deadline ? `до ${c.deadline.split('-').reverse().join('.')}` : '', flag: 'чекає відповіді', go: { tab: 'school' } });
    }
  }
  // Відповіді вчителя на «хочу обговорити»
  for(const id in (d.talks || {})){
    const t = d.talks[id] || {};
    if(!t.replyTs || t.replyTs < from) continue;
    out.push({ id: `t:${id}`, kind: 'talk', icon: '🙋', ts: t.replyTs, title: `Учитель відповів: ${t.subject || ''}`.trim(),
      sub: 'на ваш запит «обговорити»', go: { key: 'talk' } });
  }
  return sortItems(out);
}

export function newsItems(news, visible, from){
  const now = Date.now(), out = [];
  for(const id in (news || {})){
    const a = news[id];
    if(!a || !a.text || !visible(a)) continue;
    if(a.expTs && now >= a.expTs) continue;
    const ts = Number(a.ts) || 0;
    if(ts < from) continue;
    out.push({ id: `n:${id}`, kind: 'news', icon: a.important ? '❗' : '📣', ts,
      title: cut(a.title || a.text, 70), sub: a.title ? cut(a.text, 90) : 'оголошення', go: { tab: 'news' } });
  }
  return out;
}

// ── ПЕРСОНАЛ ─────────────────────────────────────────────────────
// d = {news, talks: [{cls, label, se, id, rec}], reacts: [{cls, label, date, subj, sid, child, r, rts}]}
export function staffItems(d, o){
  const out = newsItems(d.news, () => true, o.from).map(x => ({ ...x, go: { tab: 'news' } }));
  (d.talks || []).forEach(t => {
    const r = t.rec || {};
    if(r.status !== 'open' || !r.ts) return;
    out.push({ id: `t:${t.cls}:${t.se}:${t.id}`, kind: 'talk', icon: '🙋', ts: r.ts,
      title: `Батьки просять звʼязатися: ${r.childName || r.child || ''}`.trim(), sub: [r.subject, t.label].filter(Boolean).join(' · '),
      flag: 'чекає відповіді', go: { key: 'talk' } });
  });
  (d.reacts || []).forEach(x => {
    if(!x.rts || x.rts < o.from) return;
    out.push({ id: `r:${x.cls}:${x.date}:${x.subj}:${x.sid}:${x.uid || ''}`, kind: 'react', icon: x.r, ts: x.rts,
      title: `${x.child || 'Учень'}: реакція на ваш коментар`, sub: [x.subj, x.label].filter(Boolean).join(' · '),
      go: { comments: x.cls } });
  });
  // Записи батьків на консультацію до мене (consult.js)
  (d.bookings || []).forEach(x => {
    const b = x.b || {}, s = x.s || {};
    if(!b.ts || b.ts < o.from) return;
    out.push({ id: `k:${x.id}`, kind: 'consult', icon: '🗓', ts: b.ts,
      title: `Запис на консультацію: ${b.childName || 'учень'}`,
      sub: [s.date ? `${s.date.split('-').reverse().slice(0, 2).join('.')} о ${s.start || ''}` : '', b.topic].filter(Boolean).join(' · '),
      go: { consult: true } });
  });
  return sortItems(out);
}

export const sortItems = list => list.sort((a, b) => b.ts - a.ts || a.id.localeCompare(b.id));
export const countNew = (items, seen) => items.filter(x => x.ts > seen).length;

// ── ЧИТАННЯ ДАНИХ ────────────────────────────────────────────────
const val = p => get(child(ref(db), p)).then(s => s.exists() ? s.val() : null).catch(() => null);
const range = (p, fromDate) => get(query(child(ref(db), p), orderByKey(), startAt(fromDate))).then(s => s.exists() ? s.val() : null).catch(() => null);
const recentNews = () => get(query(ref(db, 'announcements'), orderByKey(), limitToLast(40))).then(s => s.exists() ? s.val() : null).catch(() => null);

async function loadFamily(from){
  const cls = getActiveClass(), u = currentUserData || {};
  const sid = stuId(cls, u.studentName) || u.studentId || u.studentName || '';
  const fd = dateStr(from), se = emailKey(u.email || (auth.currentUser && auth.currentUser.email) || '');
  const [grades, comments, hw, news, consents, consentResp, talks] = await Promise.all([
    sid ? val(`student_grades/${cls}/${sid}`) : null,
    sid ? range(`student_comments/${cls}/${sid}`, fd) : null,
    range(`homeworks/${cls}`, fd),
    recentNews(),
    u.role === 'parent' ? val('consents') : null,
    null,   // відповіді на запити — нижче, лише свої листки (весь вузол родині закритий)
    u.role === 'parent' && se ? val(`talk_requests/${cls}/${se}`) : null
  ]);
  const resp = {};
  if(u.role === 'parent' && consents){
    const ids = Object.keys(consents).filter(id => { const c = consents[id] || {}; const l = Array.isArray(c.classes) ? c.classes : Object.values(c.classes || {}); return l.includes(cls); });
    // Ключ — той самий, яким пише answerConsent (parent-student.js)
    const csid = u.studentId || u.studentName || sid;
    await Promise.all(ids.map(id => val(`consent_responses/${id}/${cls}/${csid}`).then(v => { if(v) resp[id] = { [cls]: { [sid]: v } }; })));
  }
  return familyItems({ grades, comments, hw, news, consents, consentResp: resp, talks }, { cls, sid, name: u.studentName, from, role: u.role });
}

async function loadStaff(from){
  const uid = auth.currentUser && auth.currentUser.uid;
  const sel = document.getElementById('t-class-selector');
  const classes = sel ? [...sel.options].map(o => ({ cls: o.value, label: o.textContent.trim() })).filter(c => c.cls) : [];
  const fd = dateStr(from);
  const se = emailKey((auth.currentUser && auth.currentUser.email) || '');
  const [news, cBook, cSlots, ...per] = await Promise.all([recentNews(),
    se ? val(`consult_bookings/${se}`) : null, se ? val(`consult_slots/${se}`) : null, ...classes.map(async c => {
    const [talks, meta, seen, names] = await Promise.all([
      val(`talk_requests/${c.cls}`), range(`comment_meta/${c.cls}`, fd), range(`comment_seen/${c.cls}`, fd),
      val(`students_list/${c.cls}`)]);
    return { c, talks, meta, seen, names: names || {} };
  })]);
  const talks = [], reacts = [];
  per.forEach(({ c, talks: t, meta, seen, names }) => {
    for(const se in (t || {})) for(const id in (t[se] || {})) talks.push({ cls: c.cls, label: c.label, se, id, rec: t[se][id] });
    for(const date in (seen || {})) for(const subj in (seen[date] || {})) for(const sid in (seen[date][subj] || {})){
      const m = meta && meta[date] && meta[date][subj] && meta[date][subj][sid];
      if(!m || m.by !== uid) continue;                 // лише реакції на МОЇ коментарі
      for(const who in (seen[date][subj][sid] || {})){
        const s = seen[date][subj][sid][who] || {};
        if(s.r) reacts.push({ cls: c.cls, label: c.label, date, subj, sid, uid: who, child: names[sid] || '', r: s.r, rts: Number(s.rts) || 0 });
      }
    }
  });
  const bookings = Object.keys(cBook || {}).map(id => ({ id, b: cBook[id], s: (cSlots || {})[id] || {} }));
  return staffItems({ news, talks, reacts, bookings }, { from });
}

// ── «ПЕРЕГЛЯНУТО» ────────────────────────────────────────────────
const LS = () => `push_notif_seen_${(auth.currentUser && auth.currentUser.uid) || ''}`;
async function readSeen(){
  const uid = auth.currentUser && auth.currentUser.uid;
  let ls = 0; try{ ls = Number(localStorage.getItem(LS())) || 0; }catch(e){}
  if(!uid) return ls;
  const v = await val(`notif_seen/${uid}`);
  return Math.max(ls, Number(v && v.ts) || 0);
}
async function writeSeen(ts){
  try{ localStorage.setItem(LS(), String(ts)); }catch(e){}
  const uid = auth.currentUser && auth.currentUser.uid;
  if(uid) await set(ref(db, `notif_seen/${uid}`), { ts }).catch(() => {});   // правила ще не опубліковані — вистачить localStorage
}

// ── ІНТЕРФЕЙС ────────────────────────────────────────────────────
let items = [], seen = 0, seenShown = 0, loading = null, wrap = null;

function badge(){
  const b = document.getElementById('pb-bell'); if(!b) return;
  const n = countNew(items, seen);
  const el = b.querySelector('.pb-bell-n');
  if(el){ el.hidden = !n; el.textContent = n > 99 ? '99+' : String(n); }
  b.setAttribute('aria-label', n ? `Сповіщення: нових ${n}` : 'Сповіщення');
}

export async function refreshNotifs(){
  const role = currentUserData && currentUserData.role;
  const covered = !!role && (isFamily(role) || isStaffRole(role));
  // Кухня, ролі з конструктора — їм центр нічого не збирає, тож і
  // дзвіночок не показуємо, щоб не обіцяти порожнього списку.
  const bell = document.getElementById('pb-bell');
  if(bell) bell.style.display = covered ? '' : 'none';
  if(!covered) return [];
  if(loading) return loading;
  const from = Date.now() - WINDOW_DAYS * DAY;
  // Ключ контексту: якщо поки читали, перемкнули дитину чи кабінет —
  // результат чужий, його не показуємо
  const ctxKey = ctxOf();
  loading = (async () => {
    try{
      const [list, s] = await Promise.all([isFamily(role) ? loadFamily(from) : loadStaff(from), readSeen()]);
      if(ctxKey !== ctxOf()) return items;
      items = list; seen = s;
      badge();
      if(wrap && !wrap.hidden) paint();
      return items;
    } finally { loading = null; }
  })();
  return loading;
}

function ensureUi(){
  if(wrap) return wrap;
  wrap = document.createElement('div');
  wrap.className = 'ui-sheet-wrap'; wrap.id = 'notif-sheet'; wrap.hidden = true;
  wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true'); wrap.setAttribute('aria-labelledby', 'notif-title');
  wrap.innerHTML = `<div class="ui-sheet-bg" data-close="1"></div><div class="ui-sheet nc-sheet">
      <div class="ui-sheet-grab" aria-hidden="true"></div>
      <button type="button" class="ui-sheet-x" data-close="1" aria-label="Закрити">✕</button>
      <h4 id="notif-title">Сповіщення</h4>
      <div class="nc-list" role="list"></div>
      <details class="ui-how"><summary>ℹ️ Звідки це</summary><p>Тут усе, що зʼявилося за останні два тижні:
        те саме, що приходить сповіщеннями на телефон, але зібране в одному місці — навіть якщо сповіщення вимкнені.
        Нове позначене крапкою; щойно ви відкрили список, лічильник на дзвіночку обнуляється.</p></details></div>`;
  wrap.addEventListener('click', e => {
    if(e.target.closest('[data-close]')){ window.closeSheet ? window.closeSheet('notif-sheet') : (wrap.hidden = true); return; }
    const b = e.target.closest('[data-i]'); if(!b) return;
    const it = items[Number(b.dataset.i)]; if(!it) return;
    window.closeSheet ? window.closeSheet('notif-sheet') : (wrap.hidden = true);
    goTo(it.go);
  });
  document.body.appendChild(wrap);
  return wrap;
}

export function itemsHtml(list, seenTs, now = Date.now()){
  if(!list.length) return `<div class="ui-empty"><b>Нічого нового за два тижні</b>Коли зʼявляться оцінки, коментарі чи оголошення — вони будуть тут.</div>`;
  let html = '', grp = '';
  list.forEach((it, i) => {
    const g = it.ts > seenTs ? 'Нове' : 'Раніше';
    if(g !== grp){ html += `<div class="nc-group" role="presentation">${g}</div>`; grp = g; }
    // role=listitem — на обгортці: на самій кнопці він стер би роль «кнопка»
    html += `<div role="listitem"><button type="button" class="nc-item${it.ts > seenTs ? ' is-new' : ''}" data-i="${i}">`
      + `<span class="nc-ic" aria-hidden="true">${escHtml(it.icon)}</span>`
      + `<span class="nc-body"><b>${escHtml(it.title)}</b>${it.sub ? `<small>${escHtml(it.sub)}</small>` : ''}</span>`
      + `<span class="nc-meta"><time>${escHtml(relTime(it.ts, now))}</time>${it.flag ? `<em>${escHtml(it.flag)}</em>` : ''}</span></button></div>`;
  });
  return html;
}

function paint(){
  const list = wrap.querySelector('.nc-list');
  list.innerHTML = loading && !items.length ? '<p class="empty-msg is-loading">Завантаження...</p>' : itemsHtml(items, seenShown);
}

export async function openNotifs(){
  ensureUi();
  seenShown = seen;                    // «нове» лишається підсвіченим, поки список відкритий
  paint();
  if(window.openSheet) window.openSheet('notif-sheet'); else wrap.hidden = false;
  await refreshNotifs();
  seenShown = Math.min(seenShown, seen);
  paint();
  const top = items.length ? items[0].ts : 0;
  if(top > seen){ seen = Date.now(); badge(); await writeSeen(seen); }
}

function goTo(go){
  if(!go) return;
  const role = currentUserData && currentUserData.role;
  const screen = screenIdForRole(role);
  if(go.comments){ if(window.openCommentsView) window.openCommentsView({ cls: go.comments }); return; }
  if(go.consult){ if(window.openConsultTeacher) window.openConsultTeacher(); return; }
  openTabByKey(screen, go.key || go.tab);
  // Оцінки й коментарі — у панелі «Тиждень» (ui-today.js)
  if(go.tab === 'grades' && window.grPane) window.grPane(role === 'student' ? 's' : 'p', 'week');
  try{ window.scrollTo({ top: 0, behavior: 'smooth' }); }catch(e){}
}

const ctxOf = () => { const u = currentUserData || {}; return `${u.role || ''}|${u.class || ''}|${u.studentName || ''}`; };
// Інша дитина / кабінет / вихід (common.js) — старий список не показуємо
window.addEventListener('push:context', () => {
  items = []; badge();
  if(wrap && !wrap.hidden && window.closeSheet) window.closeSheet('notif-sheet');
  setTimeout(() => { loading = null; refreshNotifs(); }, 1500);
});
window.openNotifs = openNotifs;
window.refreshNotifs = refreshNotifs;

// Перше оновлення — щойно відомо, хто увійшов; далі — раз на 5 хвилин і
// при поверненні на вкладку (телефон дістали з кишені).
let tries = 0;
const boot = setInterval(() => {
  if(currentUserData && auth.currentUser){ clearInterval(boot); refreshNotifs(); }
  else if(++tries > 120) clearInterval(boot);
}, 1000);
setInterval(() => { if(document.visibilityState === 'visible') refreshNotifs(); }, 5 * 60000);
document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible') refreshNotifs(); });
