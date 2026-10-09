// ═══════════════════════════════════════════════════════════════
// news-reactions.js — реакції родин на оголошення і «хто переглянув».
//
// ЩО БАЧИТЬ РОДИНА. Під кожним оголошенням — шість реакцій: 👍 ❤️ 🎉 🙏 😮 😢.
// Одна реакція на людину: натиснути ще раз — зняти, іншу — замінити.
// Видно, скільки людей поставили кожну, але не хто саме.
//
// ЩО БАЧИТЬ ПЕРСОНАЛ (учитель, директор, адміністрація). Кількість реакцій
// і переглядів, а кнопка «👁 Переглянули: N» відкриває, ХТО поставив яку
// реакцію і хто переглянув (за класами). Для оголошення класу — ще й хто
// з родин класу його ще не відкривав.
//
// ДЕ ЛЕЖИТЬ
//   news_reactions/{оголошення}/{uid} = 'like' | 'love' | ...
//       Читають усі, хто увійшов (для лічильників). Ключ — uid: за ним
//       інша родина не впізнає, хто це. Пише лише сама людина, свій ключ.
//   news_seen/{оголошення}/{uid} = {ts, se, cls, child, role, pr}
//       «Переглянуто»: оголошення з'явилося на екрані родини. Читає лише
//       персонал. Імені батька тут немає — його береться з parent_links у
//       момент перегляду списку, тож воно завжди актуальне.
//
// «ПЕРЕГЛЯНУТО» — це оголошення, яке було на екрані хоча б секунду (не
// просто завантажилося десь унизу сторінки). Записується раз на пристрій.
// ═══════════════════════════════════════════════════════════════
import { ref, get, set, child } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, auth, currentUserData, escHtml, escJs, showToast, isTeacherRole, getParentProfile, parentFullName,
         childDisplayName } from './common.js';

export const NEWS_REACTS = [
  { k: 'like',   e: '👍', t: 'Подобається' },
  { k: 'love',   e: '❤️', t: 'Чудово' },
  { k: 'party',  e: '🎉', t: 'Ура!' },
  { k: 'thanks', e: '🙏', t: 'Дякуємо' },
  { k: 'wow',    e: '😮', t: 'Ого' },
  { k: 'sad',    e: '😢', t: 'Сумно' }
];
const REACT_KEYS = NEWS_REACTS.map(r => r.k);
const SEEN_LS = 'push_school_news_seen_ids';
const seKey = e => String(e || '').replace(/\./g, '_');

// ── ЧИСТА ЛОГІКА ─────────────────────────────────────────────────
export function reactCounts(node, myUid){
  const counts = {}; let mine = null, total = 0;
  for(const uid in (node || {})){
    const k = node[uid];
    if(!REACT_KEYS.includes(k)) continue;
    counts[k] = (counts[k] || 0) + 1; total++;
    if(uid === myUid) mine = k;
  }
  return { counts, mine, total };
}
// Хто переглянув / відреагував — для вікна персоналу.
//   seen: news_seen/{id}, reacts: news_reactions/{id}, links: parent_links
//   names: {se: «ПІБ»} — з профілів батьків
export function whoList(seen, reacts, names){
  const people = [];
  const uids = new Set([...Object.keys(seen || {}), ...Object.keys(reacts || {})]);
  uids.forEach(uid => {
    const s = (seen || {})[uid] || {};
    const r = (reacts || {})[uid];
    const child = s.child ? childDisplayName(s.child) : '';
    const who = s.role === 'student'
      ? (child || 'Учень')
      : (s.se || s.pr ? parentLabel(names && names[s.se], s.se, s.pr) : 'Батьки');
    const label = s.role === 'student' ? `${who} (учень)` : (child ? `${who} — ${child}` : who);
    people.push({ uid, se: s.se || '', cls: s.cls || '', label, ts: s.ts || 0, react: REACT_KEYS.includes(r) ? r : null });
  });
  return people.sort((a, b) => (a.cls || 'z').localeCompare(b.cls || 'z', 'uk', { numeric: true }) || a.label.localeCompare(b.label, 'uk'));
}
// ПІБ батька з профілю; порожньо, якщо не заповнено (parentFullName дає «—»)
export const pName = prof => { const n = parentFullName(prof, ''); return n && n !== '—' ? n : ''; };
const PR = { mother: 'мати', father: 'батько', guardian: 'опікун' };
// Ключ пошти назад у пошту: у ключі крапки замінені на «_». Підкреслення
// в самій адресі трапляються рідко, тож для показу цього досить.
export const seToEmail = se => String(se || '').replace(/_/g, '.');
// Як підписати батька, що не заповнив ПІБ: пошта + хто він дитині. Інакше
// в списку стоїть лише ім'я дитини — і мама з татом виглядають дублями.
export const parentLabel = (name, se, pr) => name || `${seToEmail(se) || 'без пошти'}${PR[pr] ? ` (${PR[pr]})` : ''}`;
// Родини класу, які ще не переглянули (для оголошення класу)
export function notSeenInClass(links, cls, seenSe){
  const out = [];
  for(const se in (links || {})){
    const kids = Array.isArray(links[se]?.children) ? links[se].children : Object.values(links[se]?.children || {});
    const mine = kids.filter(k => k && k.class === cls);
    if(!mine.length || seenSe.has(se)) continue;
    const prof = getParentProfile(links[se]);
    const kids2 = mine.map(k => childDisplayName(k.studentName)).join(', ');
    out.push({ kid: kids2, text: `${parentLabel(pName(prof), se, mine[0].role)} — ${kids2}` });
  }
  // За дитиною: мама й тато однієї дитини стоять поруч
  return out.sort((a, b) => a.kid.localeCompare(b.kid, 'uk') || a.text.localeCompare(b.text, 'uk')).map(x => x.text);
}

// ── ХТО ЩО МОЖЕ ─────────────────────────────────────────────────
const role = () => currentUserData?.role;
const isFamily = () => role() === 'parent' || role() === 'student';
const isStaffViewer = () => { const r = role(); return r === 'director' || r === 'administrator' || isTeacherRole(r); };

// ── ПЕРЕГЛЯНУТО ─────────────────────────────────────────────────
let seenIds = null;
function seenSet(){
  if(seenIds) return seenIds;
  try{ seenIds = new Set(JSON.parse(localStorage.getItem(SEEN_LS) || '[]')); }catch(e){ seenIds = new Set(); }
  return seenIds;
}
async function markSeen(id){
  const uid = auth.currentUser?.uid; if(!uid || !isFamily()) return;
  const s = seenSet(); const key = `${uid}|${id}`;
  if(s.has(key)) return;
  s.add(key);
  try{ localStorage.setItem(SEEN_LS, JSON.stringify([...s].slice(-400))); }catch(e){}
  const u = currentUserData || {};
  const rec = { ts: Date.now(), se: seKey(auth.currentUser.email || u.email), role: u.role };
  if(u.class) rec.cls = String(u.class);
  if(u.studentName) rec.child = String(u.studentName).slice(0, 80);
  if(u.role === 'parent' && u.parentRole) rec.pr = String(u.parentRole).slice(0, 20);
  try{ await set(ref(db, `news_seen/${id}/${uid}`), rec); }
  catch(e){ s.delete(key); console.warn('news_seen:', e.message); }
}
let observer = null;
function observe(el){
  if(!('IntersectionObserver' in window)){ markSeen(el.dataset.nid); return; }
  if(!observer){
    const timers = new Map();
    observer = new IntersectionObserver(entries => entries.forEach(en => {
      const el2 = en.target;
      if(en.isIntersecting){
        // Хоча б секунду на екрані — інакше прогорнуте повз не рахується
        timers.set(el2, setTimeout(() => { markSeen(el2.dataset.nid); observer.unobserve(el2); timers.delete(el2); }, 1000));
      }else if(timers.has(el2)){ clearTimeout(timers.get(el2)); timers.delete(el2); }
    }), { threshold: 0.5 });
  }
  observer.observe(el);
}

// ── ПОКАЗ ПІД ОГОЛОШЕННЯМ ───────────────────────────────────────
function barHtml(id, rc, seenN){
  const uid = auth.currentUser?.uid || '';
  if(isFamily()){
    return NEWS_REACTS.map(r => {
      const n = rc.counts[r.k] || 0, on = rc.mine === r.k;
      return `<button type="button" class="nr-btn${on ? ' on' : ''}" aria-pressed="${on}" aria-label="${r.t}${n ? `: ${n}` : ''}"
        data-tip="${r.t}" onclick="reactNews('${escJs(id)}','${r.k}')">${r.e}${n ? `<span>${n}</span>` : ''}</button>`;
    }).join('');
  }
  const chips = NEWS_REACTS.filter(r => rc.counts[r.k]).map(r => `<span class="nr-chip" data-tip="${r.t}">${r.e} ${rc.counts[r.k]}</span>`).join('');
  const who = isStaffViewer()
    ? `<button type="button" class="nr-who" onclick="openNewsWho('${escJs(id)}')">👁 Переглянули: ${seenN ?? '…'}</button>` : '';
  return (chips || (uid ? '<span class="nr-none">Реакцій поки немає</span>' : '')) + who;
}
const cache = {};   // id → {reacts, seenN}
async function hydrateOne(box, id){
  try{
    const [r, s] = await Promise.all([
      get(child(ref(db), `news_reactions/${id}`)),
      isStaffViewer() ? get(child(ref(db), `news_seen/${id}`)).catch(() => null) : Promise.resolve(null)
    ]);
    cache[id] = { reacts: r.exists() ? r.val() : {}, seenN: s ? (s.exists() ? Object.keys(s.val()).length : 0) : null };
    paint(id);
  }catch(e){ box.innerHTML = ''; }
}
function paint(id){
  const c = cache[id]; if(!c) return;
  const rc = reactCounts(c.reacts, auth.currentUser?.uid || '');
  document.querySelectorAll(`.nr-bar[data-nid="${String(id).replace(/["\\]/g, '')}"]`).forEach(b => { b.innerHTML = barHtml(id, rc, c.seenN); });
}
// news.js кличе після кожного малювання стрічки чи блоку «свіжих»
window.hydrateNewsReactions = function(container){
  if(!container) return;
  container.querySelectorAll('.nr-bar[data-nid]').forEach(b => {
    const id = b.dataset.nid;
    if(cache[id]) paint(id); else hydrateOne(b, id);
    if(isFamily()){ const art = b.closest('article') || b; art.dataset.nid = id; observe(art); }
  });
};
window.reactNews = async function(id, k){
  const uid = auth.currentUser?.uid; if(!uid || !isFamily() || !REACT_KEYS.includes(k)) return;
  const c = cache[id] || (cache[id] = { reacts: {}, seenN: null });
  const prev = c.reacts[uid] || null, next = prev === k ? null : k;
  c.reacts = { ...c.reacts }; if(next) c.reacts[uid] = next; else delete c.reacts[uid];
  paint(id);                                   // одразу — без очікування бази
  try{
    await set(ref(db, `news_reactions/${id}/${uid}`), next);
    markSeen(id);                              // хто відреагував, той точно бачив
  }catch(e){
    if(prev) c.reacts[uid] = prev; else delete c.reacts[uid];
    paint(id);
    showToast('❌ Реакцію не збережено: ' + (e.message || ''));
  }
};

// ── ВІКНО «ХТО ПЕРЕГЛЯНУВ» (персонал) ───────────────────────────
function ensureModal(){
  let m = document.getElementById('news-who-modal'); if(m) return m;
  m = document.createElement('div');
  m.id = 'news-who-modal'; m.className = 'modal-overlay';
  m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-labelledby', 'nwho-title');
  m.innerHTML = `<div class="modal-content nwho-box">
      <div class="nwho-head"><h3 id="nwho-title">👁 Хто переглянув</h3>
        <button type="button" class="nwho-close" onclick="closeNewsWho()" aria-label="Закрити">✕</button></div>
      <div id="nwho-sub" class="nwho-sub"></div>
      <div id="nwho-body"><p class="empty-msg">Завантаження...</p></div>
    </div>`;
  m.addEventListener('click', e => { if(e.target === m) window.closeNewsWho(); });
  m.addEventListener('keydown', e => { if(e.key === 'Escape') window.closeNewsWho(); });
  document.body.appendChild(m);
  return m;
}
window.closeNewsWho = () => { const m = document.getElementById('news-who-modal'); if(m) m.style.display = 'none'; };
window.openNewsWho = async function(id){
  if(!isStaffViewer()) return;
  const m = ensureModal(); m.style.display = 'flex';
  const body = document.getElementById('nwho-body'), sub = document.getElementById('nwho-sub');
  body.innerHTML = '<p class="empty-msg">Завантаження...</p>'; sub.textContent = '';
  try{
    const [a, s, r, l] = await Promise.all([
      get(child(ref(db), `announcements/${id}`)),
      get(child(ref(db), `news_seen/${id}`)),
      get(child(ref(db), `news_reactions/${id}`)),
      get(child(ref(db), 'parent_links')).catch(() => null)
    ]);
    const ann = a.exists() ? a.val() : {};
    const links = l && l.exists() ? l.val() : {};
    const names = {}; for(const se in links){ const n = pName(getParentProfile(links[se])); if(n) names[se] = n; }
    const people = whoList(s.exists() ? s.val() : {}, r.exists() ? r.val() : {}, names);
    const rc = reactCounts(r.exists() ? r.val() : {}, '');
    sub.textContent = ann.title || String(ann.text || '').slice(0, 80);
    const reactBlock = rc.total ? `<div class="nwho-sec"><b>Реакції: ${rc.total}</b>${NEWS_REACTS.filter(x => rc.counts[x.k]).map(x =>
      `<div class="nwho-r"><span class="nwho-e">${x.e} ${rc.counts[x.k]}</span> ${people.filter(p => p.react === x.k).map(p => escHtml(p.label)).join(', ')}</div>`).join('')}</div>` : '';
    const seenP = people.filter(p => p.ts);
    const byCls = {}; seenP.forEach(p => (byCls[p.cls || ''] ||= []).push(p));
    const fmt = ts => new Date(ts).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const seenBlock = `<div class="nwho-sec"><b>Переглянули: ${seenP.length}</b>${seenP.length ? Object.keys(byCls).sort((x, y) => x.localeCompare(y, 'uk', { numeric: true })).map(c =>
      `<details class="nwho-cls"${Object.keys(byCls).length < 3 ? ' open' : ''}><summary>${c ? `${escHtml(c.replace('class_', ''))} клас` : 'Без класу'} — ${byCls[c].length}</summary>
        <ul>${byCls[c].map(p => `<li>${escHtml(p.label)}${p.react ? ` ${NEWS_REACTS.find(x => x.k === p.react).e}` : ''} <span>${escHtml(fmt(p.ts))}</span></li>`).join('')}</ul></details>`).join('')
      : '<p class="empty-msg">Ще ніхто не переглянув.</p>'}</div>`;
    let notBlock = '';
    if(ann.scope === 'class' && ann.class){
      const seenSe = new Set(seenP.map(p => p.se).filter(Boolean));
      const not = notSeenInClass(links, ann.class, seenSe);
      notBlock = `<div class="nwho-sec"><b>Ще не переглянули (${escHtml(String(ann.class).replace('class_', ''))} клас): ${not.length}</b>${
        not.length ? `<ul>${not.map(n => `<li>${escHtml(n)}</li>`).join('')}</ul>` : '<p class="nwho-ok">✅ Переглянули всі родини класу.</p>'}</div>`;
    }
    body.innerHTML = reactBlock + seenBlock + notBlock
      + '<p class="nwho-note">«Переглянули» — оголошення було на екрані родини хоча б секунду. Хто читав лише сповіщення на телефоні, тут не з’явиться, доки не відкриє портал.</p>';
  }catch(e){
    body.innerHTML = `<p class="empty-msg" style="color:var(--danger);">Не вдалося завантажити: ${escHtml(e.message || '')}</p>`;
  }
};
