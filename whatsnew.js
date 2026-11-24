// ═══════════════════════════════════════════════════════════════
// whatsnew.js — ✨ «ЩО НОВОГО»: одна картка поверх кабінету, один раз
//
// НАВІЩО. Про новий розділ (Партнери, адвент…) люди дізнаються випадково.
// Плитка на головному набридає, push — забагато. Тут: директор пише коротку
// новину, кожен із вибраних ролей бачить її ОДИН РАЗ при наступному вході —
// поверх усього, з кнопкою «перейти» в потрібний розділ. І все.
//
// ДАНІ
//   whatsnew/{id}       = {title, text, points:{a,b,c}, icon, deco, image, color,
//                          target, btn, who:{parent,student,teacher,staff},
//                          days, status:'draft'|'live', createdAt, publishedAt}
//   whatsnew_seen/{id}/{uid} = час показу. Пише лише сама людина, один раз.
//                          Директор бачить лише кількість («184 з 312»).
//
// КОЛИ ПОКАЗУЄМО. Людина вже в кабінеті: немає заставки, згоди з
// приватністю, відкритих вікон і шторок; кабінет відкрили не з push
// (?open=…) — тоді чекаємо наступного входу. Новина живе `days` днів від
// публікації; хто зайде пізніше — старе «нове» не побачить. Кілька
// непрочитаних — в одній картці, свайпом; не більше трьох, найновіші.
// Показали — позначили всі показані (і в базі, і на пристрої).
//
// КНОПКА веде в розділ СВОЄЇ ролі: «Партнери» батькам — їхня вкладка,
// директору — вікно «Партнери й моя картка». Немає такого розділу в цієї
// ролі — кнопки немає, лише «Зрозуміло».
// ═══════════════════════════════════════════════════════════════
import { ref, get, set, remove } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, auth, currentUserData, showToast, escHtml, uploadToCloudinary, cldImage } from './common.js';

export const DAY = 86400000;
export const MAX_SHOW = 3;
export const COLORS = ['g0', 'g1', 'g2', 'g3', 'g4', 'g5'];
export const WHO = { parent: 'Батьки', student: 'Учні', teacher: 'Вчителі', staff: 'Персонал' };
const TEACH = ['teacher', 'class_teacher', 'art_school_teacher', 'music_teacher', 'master_class_teacher'];

// ── Розділи порталу, куди може вести кнопка ──
// tab — data-t кнопки вкладки (у кожного кабінету свій набір; чи є розділ
// у людини, вирішує сама сторінка). alt — та сама суть під іншою назвою в
// іншому кабінеті (розклад учителя «sched», директора «rozklad»).
export const TARGETS = [
  { k: 'day',       icon: '☀️', label: 'Сьогодні',        tab: 'day',      grp: 'Батьки й учні' },
  { k: 'hw',        icon: '📚', label: 'ДЗ',              tab: 'hw',       grp: 'Батьки й учні' },
  { k: 'grades',    icon: '📊', label: 'Оцінки',          tab: 'grades',   grp: 'Батьки й учні' },
  { k: 'meals',     icon: '🍽️', label: 'Їжа',             tab: 'meals',    grp: 'Батьки й учні' },
  { k: 'games',     icon: '🎮', label: 'Ігри',            tab: 'games',    grp: 'Батьки й учні' },
  { k: 'news',      icon: '📰', label: 'Новини',          tab: 'news',     grp: 'Батьки й учні' },
  { k: 'school',    icon: '🏫', label: 'Школа',           tab: 'school',   grp: 'Батьки й учні' },
  { k: 'study',     icon: '🎓', label: 'Навчання',        tab: 'study',    grp: 'Батьки й учні' },
  { k: 'pay',       icon: '💳', label: 'Оплата',          tab: 'pay',      grp: 'Батьки й учні' },
  { k: 'profile',   icon: '👤', label: 'Профіль',         tab: 'profile',  grp: 'Батьки й учні' },
  { k: 'partners',  icon: '🤝', label: 'Партнери',        tab: 'partners', grp: 'Для всіх', fn: 'openPartnersSheet' },
  { k: 'card',      icon: '💳', label: 'Моя картка',      fn: 'openPartnerCard', grp: 'Для всіх' },
  { k: 'advent',    icon: '🎄', label: 'Адвент-календар', grp: 'Для всіх' },
  { k: 'ideas',     icon: '💡', label: 'Банк ідей',       grp: 'Для всіх' },
  { k: 'chat',      icon: '💬', label: 'Чат',             fn: 'openChatModal', grp: 'Для всіх' },
  { k: 'lesson',    icon: '📝', label: 'Урок',            tab: 'lesson',   grp: 'Вчителі' },
  { k: 'gradebook', icon: '📖', label: 'Журнал',          tab: 'gradebook', grp: 'Вчителі' },
  { k: 'class',     icon: '👥', label: 'Клас',            tab: 'class',    grp: 'Вчителі' },
  { k: 'sched',     icon: '🗓️', label: 'Розклад',         tab: 'sched', alt: 'rozklad', grp: 'Вчителі' },
  { k: 'ogl',       icon: '🏠', label: 'Огляд',           tab: 'ogl',      grp: 'Адміністрація' },
  { k: 'uchni',     icon: '👨‍👩‍👧', label: 'Учні та батьки', tab: 'uchni',  grp: 'Адміністрація' },
  { k: 'staff',     icon: '🧑‍🏫', label: 'Персонал',       tab: 'staff',    grp: 'Адміністрація' },
  { k: 'control',   icon: '🔍', label: 'Контроль',        tab: 'control',  grp: 'Адміністрація' },
  { k: 'workload',  icon: '⚖️', label: 'Навантаження',    tab: 'workload', grp: 'Адміністрація' },
  { k: 'stat',      icon: '📈', label: 'Аналітика',       tab: 'stat',     grp: 'Адміністрація' },
  { k: 'nalash',    icon: '⚙️', label: 'Налаштування',    tab: 'nalash',   grp: 'Адміністрація' }
];
export const targetOf = k => TARGETS.find(t => t.k === k) || null;
export const btnLabel = (it) => {
  const own = String((it && it.btn) || '').trim();
  if(own) return own;
  const t = targetOf(it && it.target);
  return t ? `Відкрити «${t.label}» →` : '';
};

// ── Чисті функції (tests-whatsnew.mjs) ──
export function audienceOf(role){
  if(!role) return '';
  if(role === 'parent' || role === 'student') return role;
  if(TEACH.includes(role)) return 'teacher';
  return 'staff';
}
export const isLive = (it, now) => !!it && it.status === 'live' && Number(it.publishedAt) > 0
  && now >= it.publishedAt && now < it.publishedAt + clampDays(it.days) * DAY;
export const clampDays = d => { const n = (d === '' || d == null) ? NaN : Number(d); return Number.isFinite(n) ? Math.min(60, Math.max(1, Math.round(n))) : 14; };
// Що показати людині: живі, для її ролі, ще не бачені; найновіші, ≤ MAX_SHOW
export function pending(all, aud, now, seen){
  return Object.entries(all || {})
    .filter(([id, it]) => it && typeof it === 'object' && isLive(it, now) && aud && it.who && it.who[aud] && !(seen && seen[id]))
    .map(([id, it]) => ({ id, ...it }))
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, MAX_SHOW);
}
export const pointsOf = it => ['a', 'b', 'c'].map(k => it && it.points && it.points[k]).filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
// Емодзі «навколо» картинки: до 4 штук із рядка
export function decoOf(s){
  const list = String(s || '').match(/\p{Extended_Pictographic}(\uFE0F|\u200D\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*/gu) || [];
  return list.slice(0, 4);
}
const SPOTS = [['10%', '42%'], ['82%', '44%'], ['17%', '76%'], ['76%', '78%']];

// ── Розмітка картки (спільна для показу й прев'ю) ──
export function slideHtml(it, i, n, canGo){
  const color = COLORS.includes(it.color) ? it.color : 'g0';
  const img = it.image ? cldImage(it.image, 'w_800,h_440,c_fill,g_auto') : '';
  const hero = img
    ? `<img class="wn-img" src="${escHtml(img)}" alt="">`
    : `<span class="wn-glow" aria-hidden="true"></span>${decoOf(it.deco).map((d, j) => `<span class="wn-f" style="left:${SPOTS[j][0]};top:${SPOTS[j][1]};animation-delay:${j * .7}s" aria-hidden="true">${escHtml(d)}</span>`).join('')}<span class="wn-big" aria-hidden="true">${escHtml(it.icon || '✨')}</span>`;
  const pts = pointsOf(it);
  const go = canGo ? btnLabel(it) : '';
  const last = i === n - 1;
  return `<article class="wn-slide" data-i="${i}" aria-roledescription="слайд" aria-label="${i + 1} з ${n}">
    <div class="wn-hero ${color}${img ? ' has-img' : ''}"><span class="wn-badge">✨ ${it._preview ? 'Прев’ю — так побачать' : 'Нове в Push School'}</span>${hero}</div>
    <div class="wn-body">
      <h2 id="wn-t${i}">${escHtml(it.title)}</h2>
      ${it.text ? `<p>${escHtml(it.text)}</p>` : ''}
      ${pts.length ? `<ul class="wn-pts">${pts.map(p => { const d = decoOf(p)[0]; const rest = d && p.startsWith(d) ? p.slice(d.length).trim() : p;
        return `<li><b aria-hidden="true">${escHtml(d && p.startsWith(d) ? d : '✓')}</b><span>${escHtml(rest)}</span></li>`; }).join('')}</ul>` : ''}
      ${go ? `<button type="button" class="ui-btn ui-btn-1 wn-go" data-a="go" data-i="${i}">${escHtml(go)}</button>` : ''}
      <button type="button" class="${go ? 'wn-later' : 'ui-btn ui-btn-1 wn-go'}" data-a="${last ? 'close' : 'next'}">${last ? (go ? 'Пізніше' : 'Зрозуміло') : 'Далі →'}</button>
    </div>
  </article>`;
}

// ── Де людина й що в неї є ──
const SCREENS = ['parent-screen', 'student-screen', 'teacher-screen', 'director-screen', 'admin-screen', 'kitchen-screen', 'organizer-screen'];
function shown(el){
  if(!el || el.hidden) return false;
  const cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
  return !!cs && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
}
export function currentScreen(){ return SCREENS.find(id => shown(document.getElementById(id))) || ''; }
function tabBtn(screenId, t){
  const bar = document.getElementById(screenId === 'director-screen' ? 'dtab-bar' : `${screenId}-tabs`);
  if(!bar || !t) return null;
  return bar.querySelector(`.dtab[data-t="${t.tab}"]`) || (t.alt && bar.querySelector(`.dtab[data-t="${t.alt}"]`)) || null;
}
const ADVENT_BOX = { 'parent-screen': 'p-advent', 'student-screen': 's-advent', 'teacher-screen': 't-advent' };
const isAdmin = () => ['director', 'administrator'].includes(currentUserData && currentUserData.role);
// Повертає функцію «перейти» або null, якщо в цієї ролі такого розділу немає
export function actionFor(k, screenId){
  const t = targetOf(k); if(!t) return null;
  if(k === 'advent'){
    if(isAdmin() && window.openAdventAdmin) return () => window.openAdventAdmin();
    const box = ADVENT_BOX[screenId]; const day = tabBtn(screenId, targetOf('day'));
    if(!box || !day) return null;
    return () => { day.click(); setTimeout(() => { const el = document.getElementById(box); if(el && !el.hidden) try{ el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }catch(e){} }, 250); };
  }
  if(k === 'ideas'){
    const f = isAdmin() ? (window.openIdeaInbox || window.openIdeaBank) : window.openIdeaBank;
    return typeof f === 'function' ? () => f() : null;
  }
  const btn = t.tab ? tabBtn(screenId, t) : null;
  if(btn) return () => { btn.click(); try{ window.scrollTo({ top: 0, behavior: 'instant' }); }catch(e){} };
  if(t.fn && typeof window[t.fn] === 'function') return () => window[t.fn]();
  return null;
}

// ── Показ ──
function busy(){
  if(shown(document.getElementById('boot-splash'))) return true;
  if(shown(document.getElementById('consent-gate'))) return true;
  if([...document.querySelectorAll('.modal-overlay')].some(shown)) return true;
  if([...document.querySelectorAll('.ui-sheet-wrap')].some(shown)) return true;
  if(document.querySelector('.pt-ov,.pt-card-ov,.adv-rev,.wn-ov,.wn-adm-ov')) return true;
  // Людина щось пише (ДЗ, коментар, повідомлення) — не вистрибуємо поверх
  const a = document.activeElement;
  if(a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return true;
  return false;
}
const seenKey = () => `push_wn_seen_${(auth.currentUser && auth.currentUser.uid) || ''}`;
function localSeen(){ try{ return JSON.parse(localStorage.getItem(seenKey()) || '{}') || {}; }catch(e){ return {}; } }
function markLocal(ids){ try{ const s = localSeen(); ids.forEach(id => { s[id] = 1; }); localStorage.setItem(seenKey(), JSON.stringify(s)); }catch(e){} }

export function openDeck(items, { preview = false } = {}){
  document.querySelectorAll('.wn-ov').forEach(x => x.remove());
  const screenId = currentScreen();
  const acts = items.map(it => preview ? (targetOf(it.target) ? () => {} : null) : actionFor(it.target, screenId));
  const ov = document.createElement('div');
  ov.className = 'wn-ov'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-labelledby', 'wn-t0');
  const n = items.length;
  ov.innerHTML = `<div class="wn-card">
    <div class="wn-top">
      ${n > 1 ? `<span class="wn-cnt" aria-live="polite">1 з ${n}</span>` : ''}
      <button type="button" class="wn-x" data-a="close" aria-label="Закрити">✕</button></div>
    <div class="wn-track">${items.map((it, i) => slideHtml(preview ? { ...it, _preview: true } : it, i, n, !!acts[i])).join('')}</div>
    ${n > 1 ? `<div class="wn-dots">${items.map((_, i) => `<button type="button" data-a="dot" data-i="${i}" aria-label="Новина ${i + 1}"${i ? '' : ' class="on"'}></button>`).join('')}</div>` : ''}
  </div>`;
  document.body.appendChild(ov);
  document.body.classList.add('wn-open');
  const track = ov.querySelector('.wn-track');
  let cur = 0;
  const goTo = i => {
    cur = Math.max(0, Math.min(n - 1, i));
    track.style.transform = `translateX(${-cur * 100}%)`;
    ov.querySelectorAll('.wn-dots button').forEach((b, j) => b.classList.toggle('on', j === cur));
    const c = ov.querySelector('.wn-cnt'); if(c) c.textContent = `${cur + 1} з ${n}`;
    ov.setAttribute('aria-labelledby', 'wn-t' + cur);
    ov.querySelectorAll('.wn-slide').forEach((s, j) => { s.inert = j !== cur; s.setAttribute('aria-hidden', j === cur ? 'false' : 'true'); });
  };
  const close = () => { ov.remove(); document.body.classList.remove('wn-open'); };
  ov.addEventListener('click', e => {
    const b = e.target.closest('[data-a]');
    if(!b){ if(e.target === ov) close(); return; }
    const a = b.dataset.a;
    if(a === 'close') close();
    else if(a === 'next') goTo(cur + 1);
    else if(a === 'dot') goTo(Number(b.dataset.i));
    else if(a === 'go'){ const f = acts[Number(b.dataset.i)]; close(); if(f && !preview) setTimeout(() => { try{ f(); }catch(err){ console.warn('[whatsnew]', err && err.message); } }, 60); }
  });
  ov.addEventListener('keydown', e => {
    if(e.key === 'Tab'){
      const f = [...ov.querySelectorAll('button')].filter(b => !b.closest('[inert]'));
      if(f.length){ const i = f.indexOf(document.activeElement);
        if(e.shiftKey && i <= 0){ e.preventDefault(); f[f.length - 1].focus(); }
        else if(!e.shiftKey && i === f.length - 1){ e.preventDefault(); f[0].focus(); } }
      return;
    }
    if(e.key === 'Escape') close();
    else if(e.key === 'ArrowRight') goTo(cur + 1);
    else if(e.key === 'ArrowLeft') goTo(cur - 1);
  });
  // Свайп: горизонтальний рух > 50px і більший за вертикальний
  let sx = null, sy = 0;
  track.addEventListener('pointerdown', e => { sx = e.clientX; sy = e.clientY; });
  track.addEventListener('pointerup', e => {
    if(sx == null) return; const dx = e.clientX - sx, dy = e.clientY - sy; sx = null;
    if(Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) goTo(cur + (dx < 0 ? 1 : -1));
  });
  goTo(0);
  setTimeout(() => { const f = ov.querySelector('.wn-go') || ov.querySelector('.wn-x'); try{ f && f.focus({ preventScroll: true }); }catch(e){} }, 50);
  return { ov, close, goTo };
}

let started = false;
export async function maybeShow(){
  const uid = auth.currentUser && auth.currentUser.uid;
  const aud = audienceOf(currentUserData && currentUserData.role);
  if(!uid || !aud) return;
  const all = await get(ref(db, 'whatsnew')).then(s => s.exists() ? s.val() : null).catch(() => null);
  const now = Date.now(), loc = localSeen();
  let list = pending(all, aud, now, loc);
  if(!list.length) return;
  // Бачене на іншому пристрої
  const remote = await Promise.all(list.map(it => get(ref(db, `whatsnew_seen/${it.id}/${uid}`)).then(s => s.exists()).catch(() => false)));
  markLocal(list.filter((_, i) => remote[i]).map(it => it.id));
  list = list.filter((_, i) => !remote[i]);
  if(!list.length) return;
  // Чекаємо спокійного моменту (до 3 хв), інакше — наступного разу
  for(let i = 0; i < 120 && busy(); i++) await new Promise(r => setTimeout(r, 1500));
  if(busy() || !currentScreen()) return;
  if(!auth.currentUser || auth.currentUser.uid !== uid) return;
  openDeck(list);
  const ids = list.map(it => it.id);
  markLocal(ids);
  ids.forEach(id => set(ref(db, `whatsnew_seen/${id}/${uid}`), Date.now()).catch(e => console.warn('[whatsnew] seen:', e && e.message)));
}
function boot(){
  if(started) return;
  // Відкрили зі сповіщення — людина прийшла по конкретне; не заважаємо
  if(/[?&](open|ideas|go)=/.test(String(location.search || ''))) { started = true; return; }
  // Чекаємо входу скільки завгодно: людина може довго стояти на екрані
  // логіну. Перевірка — дешева (дві змінні раз на секунду).
  const wait = setInterval(() => {
    if(currentUserData && currentUserData.role && auth.currentUser){
      clearInterval(wait); if(started) return; started = true;
      setTimeout(() => maybeShow().catch(e => console.warn('[whatsnew]', e && e.message)), 2500);
    }
  }, 1000);
}
if(typeof document !== 'undefined' && !window.__wnNoBoot) boot();

// ═══════════ ДИРЕКТОР: «✨ Що нового» ═══════════
let adm = null;
const rid = (n = 12) => Array.from(crypto.getRandomValues(new Uint8Array(n)), x => 'abcdefghijklmnopqrstuvwxyz0123456789'[x % 36]).join('');
export const blank = () => ({ _new: true, title: '', text: '', points: {}, icon: '✨', deco: '', image: '', color: 'g0', target: '', btn: '',
  who: { parent: true, student: true, teacher: true, staff: true }, days: 14, status: 'draft' });

// Що з форми потрапить у базу: лише відомі поля, обрізані
export function cleanItem(d, now){
  const s = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const out = { title: s(d.title, 80), text: s(d.text, 400), icon: s(d.icon, 8) || '✨', color: COLORS.includes(d.color) ? d.color : 'g0',
    days: clampDays(d.days), status: d.status === 'live' ? 'live' : 'draft', createdAt: Number(d.createdAt) || now };
  const pts = {}; ['a', 'b', 'c'].forEach(k => { const v = s(d.points && d.points[k], 80); if(v) pts[k] = v; });
  if(Object.keys(pts).length) out.points = pts;
  const deco = decoOf(d.deco).join(' '); if(deco) out.deco = deco;
  if(/^https:\/\/res\.cloudinary\.com\/[^\s<>"']+$/.test(String(d.image || '')) && String(d.image).length <= 300) out.image = d.image;
  if(targetOf(d.target)) out.target = d.target;
  const btn = s(d.btn, 30); if(btn && out.target) out.btn = btn;
  const who = {}; Object.keys(WHO).forEach(k => { if(d.who && d.who[k]) who[k] = true; });
  out.who = who;
  if(out.status === 'live') out.publishedAt = Number(d.publishedAt) || now;
  return out;
}
export function problems(it){
  const p = [];
  if(!it.title) p.push('Заголовок');
  if(!Object.keys(it.who || {}).length) p.push('Кому показати');
  return p;
}
// Кому з вибраних розділ недоступний (для підказки в редакторі)
export function missingFor(k, who){
  const t = targetOf(k); if(!t) return [];
  const has = {
    parent: ['parent-screen'], student: ['student-screen'], teacher: ['teacher-screen'], staff: ['director-screen']
  };
  if(['partners', 'card', 'ideas', 'chat', 'advent'].includes(k)) return [];
  const out = Object.keys(WHO).filter(g => who && who[g] && !has[g].some(id => {
    const bar = document.getElementById(id === 'director-screen' ? 'dtab-bar' : `${id}-tabs`);
    return bar && (bar.querySelector(`.dtab[data-t="${t.tab}"]`) || (t.alt && bar.querySelector(`.dtab[data-t="${t.alt}"]`)));
  })).map(g => WHO[g]);
  // У кухні, організаторів і ролей із конструктора вкладок немає взагалі
  if(who && who.staff && !out.includes(WHO.staff)) out.push('кухня, організатори та інші ролі без вкладок');
  return out;
}

window.openWhatsNewAdmin = async function(){
  document.querySelectorAll('.wn-adm-ov').forEach(x => x.remove());
  const ov = document.createElement('div');
  ov.className = 'modal-overlay wn-adm-ov'; ov.style.display = 'flex'; ov.style.zIndex = '1020';
  ov.innerHTML = '<div class="modal-content wn-adm" role="dialog" aria-modal="true" aria-label="Що нового"><p class="empty-msg is-loading">Завантаження...</p></div>';
  document.body.appendChild(ov);
  ov.addEventListener('click', e => { if(e.target === ov){ ov.remove(); adm = null; } });
  adm = { ov, box: ov.querySelector('.wn-adm'), items: {}, seen: {}, total: {}, edit: null };
  adm.box.addEventListener('click', admClick);
  adm.box.addEventListener('change', admChange);
  adm.box.addEventListener('input', admInput);
  await admLoad();
};
async function admLoad(){
  const st = adm; if(!st) return;
  const [items, users] = await Promise.all([
    get(ref(db, 'whatsnew')).then(s => s.exists() ? s.val() : {}).catch(() => ({})),
    get(ref(db, 'users')).then(s => s.exists() ? s.val() : {}).catch(() => ({}))
  ]);
  // Облік переглядів — по кожній новині окремо (правило бази — на рівні новини)
  const ids = Object.keys(items || {});
  const counts = await Promise.all(ids.map(id => get(ref(db, `whatsnew_seen/${id}`)).then(s => s.exists() ? Object.keys(s.val() || {}).length : 0).catch(() => 0)));
  if(adm !== st) return;
  st.items = items || {};
  st.seen = Object.fromEntries(ids.map((id, i) => [id, counts[i]]));
  st.total = {}; Object.values(users || {}).forEach(u => { const a = audienceOf(u && u.role); if(a) st.total[a] = (st.total[a] || 0) + 1; });
  admPaint();
}
const audTotal = it => Object.keys(it.who || {}).reduce((s, g) => s + (adm.total[g] || 0), 0);
function statusOf(it, now){
  if(it.status !== 'live') return ['чернетка', 'draft'];
  return isLive(it, now) ? ['показується', 'live'] : ['завершено', 'done'];
}
function admPaint(){
  const st = adm; if(!st) return;
  if(st.edit) return editPaint();
  const now = Date.now();
  const list = Object.entries(st.items).map(([id, it]) => ({ id, ...it })).sort((a, b) => (b.publishedAt || b.createdAt || 0) - (a.publishedAt || a.createdAt || 0));
  st.box.innerHTML = `<div class="wn-adm-h"><h3>✨ Що нового</h3><button type="button" class="wn-adm-x" data-a="adm-close" aria-label="Закрити">✕</button></div>
    <p class="wn-note">Спливає <b>один раз</b> поверх кабінету при наступному вході — у кожного з вибраних. На головному не висить, push не надсилається.</p>
    <button type="button" class="ui-btn ui-btn-1" data-a="new">+ Новина</button>
    <div class="wn-list">${list.length ? list.map(it => { const [lbl, cls] = statusOf(it, now);
      const tot = audTotal(it), seen = st.seen[it.id] || 0;
      return `<div class="wn-row" data-id="${escHtml(it.id)}">
        <span class="ic ${COLORS.includes(it.color) ? it.color : 'g0'}" aria-hidden="true">${escHtml(it.icon || '✨')}</span>
        <span class="nm"><b>${escHtml(it.title || '(без заголовка)')}</b><small><i class="st ${cls}">${lbl}</i>${it.status === 'live' ? ` · 👀 ${seen}${tot ? ' з ' + tot : ''}` : ''}${it.publishedAt ? ' · ' + new Date(it.publishedAt).toLocaleDateString('uk-UA') : ''}</small></span>
        <button type="button" class="ui-btn ui-btn-2" data-a="edit">Змінити</button></div>`; }).join('')
      : '<p class="wn-note">Новин ще немає. Наприклад: «Тепер у порталі є Партнери школи» з кнопкою в розділ.</p>'}</div>`;
}
function editPaint(){
  const st = adm, d = st.edit;
  const groups = [...new Set(TARGETS.map(t => t.grp))];
  const miss = missingFor(d.target, d.who);
  st.box.innerHTML = `<div class="wn-adm-h"><h3>${d._new ? 'Нова новина' : 'Новина'}</h3><button type="button" class="wn-adm-x" data-a="adm-close" aria-label="Закрити">✕</button></div>
  <div class="wn-ed">
    <div class="wn-ed-pic">
      <div class="wn-hero mini ${COLORS.includes(d.color) ? d.color : 'g0'}${d.image ? ' has-img' : ''}">${d.image ? `<img class="wn-img" src="${escHtml(cldImage(d.image, 'w_600,h_330,c_fill,g_auto'))}" alt="">` : `<span class="wn-big">${escHtml(d.icon || '✨')}</span>`}</div>
      <div class="wn-ed-picbtns">
        <label class="ui-btn ui-btn-2">${d.image ? 'Замінити картинку' : '🖼 Своя картинка'}<input type="file" accept="image/*" data-e="image-file" hidden></label>
        ${d.image ? '<button type="button" class="ui-btn ui-btn-2" data-a="img-del">Прибрати — повернути значок</button>' : ''}
      </div>
      <p class="wn-hint">Своя картинка займає всю шапку (краще горизонтальна, 2:1). Без неї — великий значок і дрібні значки навколо.</p>
    </div>
    ${d.image ? '' : `<div class="wn-ed-2">
      <label>Значок<input data-e="icon" maxlength="8" value="${escHtml(d.icon || '')}" class="ic"></label>
      <label>Дрібні значки навколо (до 4)<input data-e="deco" maxlength="40" value="${escHtml(d.deco || '')}" placeholder="🏷️ 💳 🩺 🎨"></label>
    </div>`}
    <span class="wn-lbl">Колір шапки</span>
    <div class="wn-sw">${COLORS.map(c => `<button type="button" class="${c}${c === d.color ? ' on' : ''}" data-a="color" data-c="${c}" aria-label="Колір ${c.slice(1)}" aria-pressed="${c === d.color}"></button>`).join('')}</div>
    <label>Заголовок<input data-e="title" maxlength="80" value="${escHtml(d.title || '')}" placeholder="Партнери школи й ваша картка"></label>
    <label>Текст<textarea data-e="text" maxlength="400" rows="3" placeholder="Знижки в гуртках, клініках і кафе для родин нашої школи.">${escHtml(d.text || '')}</textarea></label>
    <span class="wn-lbl">Пункти (до 3; значок на початку — стане іконкою)</span>
    ${['a', 'b', 'c'].map(k => `<input data-p="${k}" maxlength="80" value="${escHtml((d.points && d.points[k]) || '')}" placeholder="${{ a: '💳 Особиста картка в телефоні', b: '🩺 Moja Rodzina — −10%', c: '🗂️ Категорії: спорт, здоровʼя…' }[k]}">`).join('')}
    <span class="wn-lbl">Кнопка веде в</span>
    <div class="wn-targets">
      <button type="button" class="wn-chip${d.target ? '' : ' on'}" data-a="target" data-k="">— без кнопки</button>
      ${groups.map(g => `<div class="wn-tg"><small>${escHtml(g)}</small>${TARGETS.filter(t => t.grp === g).map(t => `<button type="button" class="wn-chip${t.k === d.target ? ' on' : ''}" data-a="target" data-k="${t.k}" aria-pressed="${t.k === d.target}">${t.icon} ${escHtml(t.label)}</button>`).join('')}</div>`).join('')}
    </div>
    ${d.target ? `<label>Напис на кнопці<input data-e="btn" maxlength="30" value="${escHtml(d.btn || '')}" placeholder="${escHtml(btnLabel({ target: d.target }))}"></label>` : ''}
    ${miss.length ? `<p class="wn-warn">У цих ролей розділу «${escHtml(targetOf(d.target).label)}» немає — вони побачать лише «Зрозуміло»: ${escHtml(miss.join(', '))}.</p>` : ''}
    <span class="wn-lbl">Кому</span>
    <div class="wn-who">${Object.entries(WHO).map(([k, v]) => `<button type="button" class="wn-chip${d.who && d.who[k] ? ' on' : ''}" data-a="who" data-k="${k}" aria-pressed="${!!(d.who && d.who[k])}">${v}</button>`).join('')}</div>
    <p class="wn-hint">Персонал — директор, адміністрація, кухня, організатори та інші ролі.</p>
    <label class="sm">Показувати днів після публікації<input data-e="days" type="number" min="1" max="60" value="${clampDays(d.days)}"></label>
    <p class="wn-ed-msg" role="status"></p>
    <div class="wn-ed-btns">
      <button type="button" class="ui-btn ui-btn-2" data-a="preview">👁 Як побачать</button>
      ${d.status === 'live' ? '<button type="button" class="ui-btn ui-btn-1" data-a="save">Зберегти</button><button type="button" class="ui-btn ui-btn-2" data-a="stop">Зняти з показу</button>'
        : '<button type="button" class="ui-btn ui-btn-1" data-a="publish">Опублікувати</button><button type="button" class="ui-btn ui-btn-2" data-a="draft">Зберегти чернетку</button>'}
      <button type="button" class="ui-btn ui-btn-2" data-a="cancel">Назад</button>
      ${d._new ? '' : '<button type="button" class="ui-btn ui-btn-2 danger" data-a="del">Видалити</button>'}
    </div>
  </div>`;
}
function readForm(){
  const d = adm.edit, box = adm.box;
  box.querySelectorAll('[data-e]').forEach(el => { if(el.type !== 'file') d[el.dataset.e] = el.value; });
  d.points = d.points || {};
  box.querySelectorAll('[data-p]').forEach(el => { d.points[el.dataset.p] = el.value; });
  return d;
}
const say = (t, bad) => { const m = adm && adm.box.querySelector('.wn-ed-msg'); if(m){ m.textContent = t; m.classList.toggle('bad', !!bad); } };
async function save(status){
  const d = readForm(), now = Date.now();
  const it = cleanItem({ ...d, status, publishedAt: status === 'live' ? (d.status === 'live' ? d.publishedAt : now) : undefined }, now);
  const bad = problems(it);
  if(bad.length){ say('Заповніть: ' + bad.join(', '), true); return; }
  if(status === 'live' && d.status !== 'live' && !confirm(`Опублікувати? Новина спливе один раз у кожного: ${Object.keys(it.who).map(k => WHO[k]).join(', ')}.`)) return;
  const id = d.id || rid();
  try{
    await set(ref(db, `whatsnew/${id}`), it);
    showToast(status === 'live' ? (d.status === 'live' ? '✅ Збережено' : '✨ Опубліковано — побачать при наступному вході') : '💾 Чернетку збережено');
    adm.edit = null; await admLoad();
  }catch(e){ say('Не вдалося зберегти: ' + (e && e.message || e), true); }
}
async function admClick(e){
  const b = e.target.closest('[data-a]'); if(!b || !adm) return;
  const a = b.dataset.a;
  if(a === 'adm-close'){ adm.ov.remove(); adm = null; return; }
  if(a === 'new'){ adm.edit = blank(); return editPaint(); }
  if(a === 'edit'){ const id = b.closest('[data-id]').dataset.id; adm.edit = { ...JSON.parse(JSON.stringify(adm.items[id])), id }; return editPaint(); }
  if(!adm.edit) return;
  if(a === 'cancel'){ adm.edit = null; return admPaint(); }
  if(a === 'color'){ readForm(); adm.edit.color = b.dataset.c; return editPaint(); }
  if(a === 'target'){ readForm(); adm.edit.target = b.dataset.k; if(!b.dataset.k) adm.edit.btn = ''; return editPaint(); }
  if(a === 'who'){ readForm(); adm.edit.who = { ...(adm.edit.who || {}) }; if(adm.edit.who[b.dataset.k]) delete adm.edit.who[b.dataset.k]; else adm.edit.who[b.dataset.k] = true; return editPaint(); }
  if(a === 'img-del'){ readForm(); adm.edit.image = ''; return editPaint(); }
  if(a === 'preview'){
    const it = cleanItem(readForm(), Date.now());
    if(!it.title){ say('Спершу заголовок', true); return; }
    return openDeck([{ id: 'preview', ...it }], { preview: true });
  }
  if(a === 'publish') return save('live');
  if(a === 'draft') return save('draft');
  if(a === 'save') return save('live');
  if(a === 'stop'){
    if(!confirm('Зняти з показу? Хто ще не бачив — не побачить.')) return;
    readForm(); adm.edit.status = 'draft'; adm.edit.publishedAt = undefined; return save('draft');
  }
  if(a === 'del'){
    if(!confirm('Видалити новину назавжди?')) return;
    try{ await Promise.all([remove(ref(db, `whatsnew/${adm.edit.id}`)), remove(ref(db, `whatsnew_seen/${adm.edit.id}`))]); showToast('🗑 Видалено'); adm.edit = null; await admLoad(); }
    catch(err){ say('Не вдалося видалити: ' + (err && err.message || err), true); }
  }
}
async function admChange(e){
  const t = e.target;
  if(t.dataset.e === 'image-file' && t.files && t.files[0] && adm && adm.edit){
    readForm(); say('Завантажую картинку…');
    try{ adm.edit.image = await uploadToCloudinary(t.files[0]); editPaint(); }
    catch(err){ say('Не вдалося завантажити: ' + (err && err.message || err), true); }
  }
}
function admInput(e){
  // Значок у прев'ю шапки — одразу, без перемальовування форми
  if(e.target.dataset.e === 'icon' && adm){ const big = adm.box.querySelector('.wn-hero.mini .wn-big'); if(big) big.textContent = e.target.value || '✨'; }
}
window.whatsNewMaybeShow = maybeShow;
