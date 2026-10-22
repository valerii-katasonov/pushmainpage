// ═══════════════════════════════════════════════════════════════
// news.js — новинна стрічка школи.
//
// МОДЕЛЬ ДАНИХ
//   announcements/{id} = {
//     title, text,
//     scope: 'school' | 'class' | 'classes',
//     class: 'class_2' | null,     // лише для scope==='class' (один клас)
//     classes: {class_1:true, …},  // лише для scope==='classes' (кілька класів,
//                                  //   «Молодша школа» = 1–5, «Старша» = 6–11)
//     important: bool,             // true → червоне виділення і «❗ Важливе»
//     color: '' | 'blue' | ...,    // колір картки (NEWS_COLORS), обирає автор
//     author, authorName, role,
//     ts, remindedAt?              // remindedAt — коли востаннє нагадали
//   }
//
// ЧОМУ ОДИН ПЛОСКИЙ ВУЗОЛ, А НЕ РОЗБИВКА ПО КЛАСАХ: оголошень небагато
// (одиниці на тиждень), а стрічка має змішувати шкільні й класні в одному
// хронологічному потоці. Розбивка змусила б читати кілька гілок і зшивати
// їх у браузері заради економії, якої тут немає.
//
// СПОВІЩЕННЯ — НА КОЖНЕ ОГОЛОШЕННЯ (рішення школи, 25.09.2026). Раніше
// push ішов лише за галочкою «Важливе», і батьки пропускали звичайні
// оголошення. Тепер галочка лише виділяє оголошення червоним у стрічці й
// міняє заголовок сповіщення. Під кожним опублікованим оголошенням автор
// (і директор) має кнопку «🔔 Нагадати» — надіслати сповіщення ще раз.
// ═══════════════════════════════════════════════════════════════
import { ref, set, get, child, push, remove, update, query, orderByKey, limitToLast }
  from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, auth, currentUserData, showToast, escHtml, escJs, logAction,
         notifyEvent, isTeacherRole, getActiveClass, teacherAccessMatrix } from './common.js';

const FEED_LIMIT = 30;

// Кольори карток — лише з палітри порталу (токени в cabinet.html).
// Червоний навмисно не пропонуємо: він означає «Важливе».
export const NEWS_COLORS = {
  '':     { label: 'Без кольору', dot: '⚪' },
  blue:   { label: 'Блакитний',   dot: '🔵' },
  green:  { label: 'Зелений',     dot: '🟢' },
  yellow: { label: 'Жовтий',      dot: '🟡' },
  pink:   { label: 'Рожевий',     dot: '🩷' },
  gray:   { label: 'Сірий',       dot: '🩶' }
};
export function newsColorClass(a){
  const c = a && typeof a.color === 'string' ? a.color : '';
  return c && Object.prototype.hasOwnProperty.call(NEWS_COLORS, c) ? ' nw-c-' + c : '';
}
const IMP_TAG = '<span class="nw-tag imp">❗ Важливе</span>';

// ── КОМУ АДРЕСОВАНО ──
// Один клас пишемо по-старому (scope 'class' + class) — так оголошення
// однаково читають і нові, і ще не оновлені сторінки. Кілька класів —
// scope 'classes' і мапа classes. Стара сторінка такого оголошення
// родині просто не покаже (а не покаже чуже) — безпечний бік.
export const ALL_CLASSES = Array.from({ length: 11 }, (_, i) => `class_${i + 1}`);
export const CLASS_GROUPS = {
  junior: { label: 'Молодша школа', range: '1–5', classes: ALL_CLASSES.slice(0, 5) },
  senior: { label: 'Старша школа',  range: '6–11', classes: ALL_CLASSES.slice(5) }
};
const CLS_RE = /^class_([1-9]|1[01])$/;
const clsNum = c => Number(String(c).replace('class_', ''));
const byNum = (x, y) => clsNum(x) - clsNum(y);
export function annClasses(a){
  if(!a || a.scope === 'school') return [];
  if(a.scope === 'classes') return Object.keys(a.classes && typeof a.classes === 'object' ? a.classes : {})
    .filter(c => a.classes[c] === true && CLS_RE.test(c)).sort(byNum);
  return a.class ? [a.class] : [];
}
export const annForClass = (a, cls) => !!a && (a.scope === 'school' || (!!cls && annClasses(a).includes(cls)));
const sameSet = (l, m) => l.length === m.length && l.every((x, i) => x === m[i]);
const groupOf = l => Object.keys(CLASS_GROUPS).find(g => sameSet(l, CLASS_GROUPS[g].classes)) || '';
export function scopeLabel(a){
  if(a.scope === 'school') return 'Вся школа';
  const l = annClasses(a), g = groupOf(l);
  if(g) return CLASS_GROUPS[g].label;
  if(sameSet(l, ALL_CLASSES)) return 'Усі класи';
  if(l.length <= 1) return `${clsNum(l[0] || '')} клас`;
  return 'Класи: ' + l.map(clsNum).join(', ');
}
// «Надіслати … родинам 3 класу?»
function whoLabel(a){
  if(a.scope === 'school') return 'усім родинам школи';
  const l = annClasses(a), g = groupOf(l);
  if(g === 'junior') return 'родинам молодшої школи (1–5 класи)';
  if(g === 'senior') return 'родинам старшої школи (6–11 класи)';
  if(l.length === 1) return `родинам ${clsNum(l[0])} класу`;
  return `родинам ${l.map(clsNum).join(', ')} класів`;
}
const badgeHtml = a => a.scope === 'school'
  ? '<span class="nw-tag school">Вся школа</span>'
  : `<span class="nw-tag cls">${escHtml(scopeLabel(a))}</span>`;

// Одне місце, звідки йде сповіщення про оголошення — і при публікації,
// і з кнопки «Нагадати». Повертає відповідь notifyEvent.
export function sendNewsPush(a, id, remind){
  // Кільком класам: class 'MULTI' + список. Сервер усе одно бере адресатів
  // із самого оголошення (за ref), а 'MULTI' без списку нікому не дійде —
  // помилка тут не має перетворитися на розсилку всій школі.
  const l = annClasses(a);
  return notifyEvent('news', {
    class: a.scope === 'school' ? 'ALL' : (l.length === 1 ? l[0] : 'MULTI'),
    ...(l.length > 1 ? { classes: l.join(',') } : {}), studentName: 'ALL',
    subject: scopeLabel(a), value: a.title || String(a.text || '').slice(0, 60),
    important: !!a.important, remind: !!remind, ref: id || ''
  });
}
function pushToast(prefix, r){
  if(r && r.ok && r.sent) return showToast(`${prefix}, сповіщень: ${r.sent}`);
  if(r && r.ok) return showToast(`${prefix} (підписаних на сповіщення поки немає)`);
  console.warn('Оголошення: push не надіслано:', r && r.error);
  showToast(`${prefix}, але сповіщення не надіслано — спробуйте «🔔 Нагадати»`);
}
const SEEN_KEY = 'push_school_news_seen';
const human = ds => ds ? ds.split('-').reverse().join('.') : '';

// ── Хто що може публікувати ──
// Педагог-організатор пише школі й будь-якому класу, як директор. Але
// видаляє лише своє (правила бази) — тому «адміністрація» окремо.
export function isSchoolAdmin(){
  const r = currentUserData?.role;
  return r === 'director' || r === 'administrator';
}
// Роль із конструктора з галочкою «Оголошення» (педагог-організатор — теж)
export function canPostSchoolWide(){
  return isSchoolAdmin() || !!(window.hasPerm && window.hasPerm('news'));
}
export function canPostAtAll(){
  return canPostSchoolWide() || isTeacherRole(currentUserData?.role);
}

// Хто може нагадати про оголошення. Ширше, ніж «видалити»: автор, директор
// і БУДЬ-ЯКИЙ учитель класу, якому воно адресоване — навіть якщо писав
// директор чи інший учитель. Правила бази пускають такого вчителя і
// позначку remindedAt записати. Раніше кнопка стояла на умові «видалити»,
// і на старих оголошеннях від інших авторів її не було.
function hasClassAccess(cls){ return !!(cls && teacherAccessMatrix && teacherAccessMatrix[cls]); }
export function canRemind(a, role, uid){
  if(!a) return false;
  if(a.author && a.author === uid) return true;
  if(canPostSchoolWide()) return true;
  return isTeacherRole(role) && a.scope !== 'school' && annClasses(a).some(hasClassAccess);
}

const lastSeen = () => { try{ return Number(localStorage.getItem(SEEN_KEY)) || 0; }catch(e){ return 0; } };
const markSeen = () => { try{ localStorage.setItem(SEEN_KEY, String(Date.now())); }catch(e){} };
// Коли людина ВОСТАННЄ відкривала стрічку — до цього входу. Беремо один
// раз при завантаженні: стрічка під час входу оновлює позначку, і без
// цього все стало б «старим» ще до того, як людина це побачила.
const SEEN_AT_START = lastSeen();
// Згорнути: усе, що вже було в стрічці минулого разу, і все, що людина
// прочитала (news-reactions.js) у попередній візит. Раніше дивилися лише
// на «прочитано» — а воно зараховується, коли оголошення секунду було на
// екрані, тож старі оголошення, до яких не догортали, лишались розгорнуті.
const isFolded = a => (SEEN_AT_START > 0 && (a.ts || 0) <= SEEN_AT_START) || !!window.isNewsReadBefore?.(a.id);

function timeAgo(ts){
  const min = Math.round((Date.now() - ts) / 60000);
  if(min < 1)  return 'щойно';
  if(min < 60) return `${min} хв тому`;
  const h = Math.round(min / 60);
  if(h < 24)   return `${h} год тому`;
  const d = Math.round(h / 24);
  if(d === 1)  return 'вчора';
  if(d < 7)    return `${d} дн тому`;
  return new Date(ts).toLocaleDateString('uk-UA', { day:'numeric', month:'long' });
}

// ── ЧИТАННЯ СТРІЧКИ ──
// Ключі push хронологічні, тож limitToLast без сортування віддає найновіші.
export async function loadNews(){
  const snap = await get(query(ref(db,'announcements'), orderByKey(), limitToLast(FEED_LIMIT)));
  if(!snap.exists()) return [];
  const v = snap.val();
  const now = Date.now();
  const role = currentUserData?.role;
  // isTeacherRole, а не лише 'teacher': класний керівник теж має бачити прострочені
  const isPoster = role === 'director' || role === 'administrator' || canPostSchoolWide() || isTeacherRole(role);
  return Object.keys(v).map(id => ({ id, ...v[id] }))
    .filter(a => a && a.text)
    .filter(a => isPoster || !a.expTs || now < a.expTs)
    .sort((a,b) => (b.ts||0) - (a.ts||0));
}

// Родині показуємо шкільні оголошення й оголошення свого класу.
// Персоналу — усе: директор має бачити, що пишуть учителі.
function visibleTo(a, role, cls){
  if(a.scope === 'school') return true;
  if(role === 'director' || role === 'administrator' || canPostSchoolWide()) return true;
  // Інші ролі з конструктора класу не мають — бачать шкільні оголошення
  if(window.isCustomRole && window.isCustomRole(role)) return false;
  return annForClass(a, cls);
}

export async function renderNewsFeed(containerId){
  const box = document.getElementById(containerId);
  if(!box) return;
  box.innerHTML = '<p class="empty-msg is-loading">Завантаження...</p>';
  try{
    const all = await loadNews();
    const role = currentUserData?.role;
    const cls  = currentUserData?.class || getActiveClass?.();
    const list = all.filter(a => visibleTo(a, role, cls));
    const seen = lastSeen();

    if(!list.length){
      box.innerHTML = '<p class="empty-msg">Оголошень поки немає.</p>';
      markSeen();
      return;
    }
    box.innerHTML = list.map(a => {
      const isNew  = (a.ts||0) > seen;
      const mine   = a.author === (auth.currentUser?.uid || '');
      const isClassTeacher = (role === 'teacher' && a.class && window.__isClassTeacherOf === a.class);
      const remindOk = canRemind(a, role, auth.currentUser?.uid || '');
      const canDel = mine || isSchoolAdmin() || isClassTeacher;
      const badge  = badgeHtml(a);
      const isExpired = a.expTs && Date.now() > a.expTs;
      const expiredTag = isExpired ? '<span class="nw-tag" style="background:var(--danger-soft);color:var(--danger);font-weight:bold;">Термін минув</span>' : '';
      const expDateTxt = a.expTs
        ? `<span class="nw-time" style="margin-left:8px;color:var(--ink-3);" title="Дата закінчення публікації">⏰ до ${escHtml(human(new Date(a.expTs).toISOString().slice(0,10)))} ${new Date(a.expTs).toTimeString().slice(0,5)}</span>`
        : '';
      const reminded = a.remindedAt
        ? `<span class="nw-time" style="margin-left:0;" title="Коли востаннє надіслано нагадування">🔔 ${escHtml(new Date(a.remindedAt).toLocaleString('uk-UA',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}))}</span>` : '';
      // Прочитане в минулий візит — згорнуте (news-reactions.js)
      const folded = isFolded(a);
      return `<article class="nw-item${a.important?' imp':''}${newsColorClass(a)}${isNew?' new':''}${folded?' is-collapsed':''}">
        <div class="nw-head">
          ${badge}
          ${a.important ? IMP_TAG : ''}
          ${isNew ? '<span class="nw-dot" data-tip="Нове"></span>' : ''}
          ${expiredTag}
          <span class="nw-time">${escHtml(timeAgo(a.ts||0))}</span>
          ${expDateTxt}
        </div>
        ${a.title ? `<h4 class="nw-title">${escHtml(a.title)}</h4>` : ''}
        <div class="nw-text">${escHtml(a.text).replace(/\n/g,'<br>')}</div>
        ${folded?'<button type="button" class="nw-more" aria-expanded="false" onclick="toggleNewsItem(this)">Розгорнути</button>':''}
        <div class="nr-bar" data-nid="${escHtml(a.id)}"></div>
        <div class="nw-foot">
          <span class="nw-author">${escHtml(a.authorName || 'Школа')}</span>
          <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;align-items:center;margin-left:auto;">
            ${remindOk ? reminded : ''}
            ${remindOk && !isExpired ? `<button class="nw-del nw-remind" onclick="remindNews('${escJs(a.id)}')" title="Надіслати батькам сповіщення про це оголошення ще раз">🔔 Нагадати</button>` : ''}
            ${canDel ? `<button class="nw-del" style="background:var(--brand-soft);color:var(--brand-ink);border:1px solid var(--brand-line);padding:2px 8px;border-radius:4px;font-size:0.72rem;cursor:pointer;" onclick="setNewsExpiry('${escJs(a.id)}', ${a.expTs || 'null'})">⏰ Термін</button>` : ''}
            ${canDel ? `<button class="nw-del" onclick="deleteNews('${escJs(a.id)}')">Видалити</button>` : ''}
          </div>
        </div>
      </article>`;
    }).join('');
    window.hydrateNewsReactions?.(box);   // реакції й «хто переглянув» (news-reactions.js)
    markSeen();
  }catch(e){
    box.innerHTML = `<p class="empty-msg" style="color:var(--danger);">Не вдалося завантажити: ${escHtml(e.message)}</p>`;
  }
}
window.renderNewsFeed = renderNewsFeed;

// ══════════════════════════════════════════════════════════════════
//  СВІЖІ ОГОЛОШЕННЯ НАГОРІ ВКЛАДКИ «СЬОГОДНІ»
// ══════════════════════════════════════════════════════════════════
//
// НАВІЩО ОКРЕМО ВІД СТРІЧКИ. Стрічка у вкладці «Школа» — це архів: туди
// заходять, коли шукають щось конкретне. А оголошення на кшталт «завтра
// урочиста лінійка о 9:00» має потрапити на очі тому, хто просто відкрив
// портал уранці. Тому нагорі — короткий блок, і лише те, що ще актуальне.
//
// ЧОМУ ТИЖДЕНЬ. Оголошення в школі живе рівно доти, доки подія не минула;
// тиждень — розумна межа, після якої напис перетворюється на шум і його
// перестають читати разом з усім блоком.
//
// НІЧОГО НЕ ВИДАЛЯЄМО. Стрічка у «Школа» показує все як показувала, у базі
// теж усе лишається: сховати з очей і стерти — різні речі, і друга
// незворотна.
export const FRESH_DAYS = 7;
export function isFresh(a, now){
  const ts = (a && a.ts) || 0;
  if(!ts) return false;                       // без дати — не вгадуємо
  if(a.expTs) return now < a.expTs;           // якщо є термін — показуємо до його закінчення
  return (now - ts) < FRESH_DAYS * 24 * 60 * 60 * 1000;
}

// Скільки днів лишилося висіти. Показуємо це автору й директору: інакше
// незрозуміло, чому оголошення зникло з головної, хоча його не чіпали.
export function daysLeft(a, now){
  if(a.expTs){
    const left = a.expTs - now;
    return left <= 0 ? 0 : Math.ceil(left / (24*60*60*1000));
  }
  const ts = (a && a.ts) || 0;
  if(!ts) return 0;
  const left = FRESH_DAYS * 24*60*60*1000 - (now - ts);
  return left <= 0 ? 0 : Math.ceil(left / (24*60*60*1000));
}

export async function renderFreshNews(containerId){
  const box = document.getElementById(containerId);
  if(!box) return;
  try{
    const all  = await loadNews();
    const role = currentUserData?.role;
    const cls  = currentUserData?.class || getActiveClass?.();
    const now  = Date.now();
    const list = all.filter(a => visibleTo(a, role, cls) && isFresh(a, now));

    // Немає свіжих — блок ховаємо цілком. Порожня рамка з написом
    // «оголошень немає» щодня нагорі кабінету — це шум, а не інформація.
    if(!list.length){ box.style.display = 'none'; box.innerHTML = ''; return; }
    box.style.display = 'block';

    box.innerHTML = `<div class="fn-head">📣 Оголошення школи</div>` + list.map(a => {
      const left = daysLeft(a, now);
      const badge = badgeHtml(a);
      const folded = isFolded(a);
      return `<article class="fn-item${a.important?' imp':''}${newsColorClass(a)}${folded?' is-collapsed':''}">
        <div class="nw-head">
          ${badge}
          ${a.important ? IMP_TAG : ''}
          <span class="nw-time">${escHtml(timeAgo(a.ts||0))}</span>
        </div>
        ${a.title ? `<h4 class="nw-title">${escHtml(a.title)}</h4>` : ''}
        <div class="nw-text">${escHtml(a.text).replace(/\n/g,'<br>')}</div>
        ${folded?'<button type="button" class="nw-more" aria-expanded="false" onclick="toggleNewsItem(this)">Розгорнути</button>':''}
        <div class="nr-bar" data-nid="${escHtml(a.id)}"></div>
        <div class="fn-foot">
          <span>${escHtml(a.authorName || 'Школа')}</span>
          <span class="fn-left" data-tip="Далі оголошення лишиться у вкладці «Школа»">${
            left === 1 ? 'зникне звідси завтра' : `ще ${left} дн тут`}</span>
        </div>
      </article>`;
    }).join('')
    + `<button type="button" class="fn-all" onclick="goToNewsFeed()">Усі оголошення →</button>`;
    window.hydrateNewsReactions?.(box);
  }catch(e){
    // Оголошення — не те, заради чого варто лякати людину червоним
    // написом на головній. Мовчки ховаємо; повна стрічка у «Школа»
    // покаже ту саму помилку тому, хто справді по неї прийшов.
    console.warn('[Push School] свіжі оголошення:', e.message);
    box.style.display = 'none';
  }
}
window.renderFreshNews = renderFreshNews;

// «Усі оголошення →» веде до повної стрічки. Вкладку шукаємо кнопкою в
// панелі, а не смикаємо switchTab з зашитою назвою екрана: у кабінеті
// три різні екрани (батько, учень, персонал), і зашите ім'я тут уже
// колись відправляло людину не туди.
window.goToNewsFeed = function(){
  const btn = document.querySelector('.dtab[data-t="school"]');
  if(btn){ btn.click(); return; }
  const feed = document.getElementById('p-news-feed') || document.getElementById('s-news-feed');
  if(feed) feed.scrollIntoView({ behavior:'smooth', block:'start' });
};

// Скільки непрочитаних — для значка на вкладці
export async function countUnreadNews(){
  try{
    const all = await loadNews();
    const role = currentUserData?.role, cls = currentUserData?.class || getActiveClass?.();
    const seen = lastSeen();
    return all.filter(a => visibleTo(a, role, cls) && (a.ts||0) > seen).length;
  }catch(e){ return 0; }
}
window.countUnreadNews = countUnreadNews;

// ── СТВОРЕННЯ ──
// Кому: уся школа, молодша (1–5), старша (6–11) або вибрані класи
// галочками. Учитель обирає лише серед класів, до яких має доступ;
// якщо такий клас один — вибору немає, як і раніше.
const teacherClasses = () => Object.keys(teacherAccessMatrix || {}).filter(c => CLS_RE.test(c)).sort(byNum);
function fillClassGrid(allowed, checked){
  const box = document.getElementById('nw-classes');
  if(!box) return;
  box.innerHTML = allowed.map(c => `<label class="nw-cls"><input type="checkbox" value="${c}"${checked.includes(c) ? ' checked' : ''}><span>${clsNum(c)}</span></label>`).join('');
}
const pickedClasses = () => [...document.querySelectorAll('#nw-classes input:checked')].map(i => i.value).filter(c => CLS_RE.test(c)).sort(byNum);
window.nwPickClasses = function(which){
  const want = which === 'none' ? [] : (CLASS_GROUPS[which] ? CLASS_GROUPS[which].classes : []);
  document.querySelectorAll('#nw-classes input').forEach(i => { i.checked = want.includes(i.value); });
};
window.openNewsComposer = function(){
  if(!canPostAtAll()) return;
  const modal = document.getElementById('news-modal');
  const scope = document.getElementById('nw-scope');
  if(!modal || !scope) return;
  const schoolWide = canPostSchoolWide();
  const presets = document.getElementById('nw-cls-presets');
  document.getElementById('nw-scope-row').style.display = schoolWide ? 'block' : 'none';
  if(presets) presets.style.display = schoolWide ? '' : 'none';
  scope.value = schoolWide ? 'school' : 'class';
  if(schoolWide) fillClassGrid(ALL_CLASSES, []);
  else {
    const mine = teacherClasses(), act = getActiveClass();
    fillClassGrid(mine.length > 1 ? mine : [], act ? [act] : []);
  }
  window.nwScopeChanged();
  document.getElementById('nw-title').value = '';
  document.getElementById('nw-text').value  = '';
  const expField = document.getElementById('nw-exp');
  if(expField) expField.value = '';
  document.getElementById('nw-important').checked = false;
  window.pickNewsColor('');
  modal.style.display = 'flex';
};
// Вибір кольору: кружечки в модалці, вибране — у data-атрибуті
window.pickNewsColor = function(c){
  const box = document.getElementById('nw-colors');
  if(!box) return;
  if(!Object.prototype.hasOwnProperty.call(NEWS_COLORS, c)) c = '';
  box.dataset.color = c;
  box.querySelectorAll('[data-c]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.c === c)));
  const prev = document.getElementById('nw-preview');
  if(prev) prev.className = 'nw-item nw-preview' + (document.getElementById('nw-important').checked ? ' imp' : '') + newsColorClass({ color: c });
};
window.nwImportantChanged = () => window.pickNewsColor(document.getElementById('nw-colors')?.dataset.color || '');
window.nwScopeChanged = function(){
  const schoolWide = canPostSchoolWide();
  const v = schoolWide ? document.getElementById('nw-scope').value : 'class';
  const grid = !!document.querySelector('#nw-classes input');
  const row = document.getElementById('nw-class-row');
  if(row) row.style.display = v === 'class' && grid ? 'block' : 'none';
  const note = document.getElementById('nw-scope-note');
  if(note) note.textContent = CLASS_GROUPS[v]
    ? `Оголошення побачать батьки та учні ${CLASS_GROUPS[v].range} класів.`
    : schoolWide ? ''
    : grid ? 'Оголошення побачать батьки та учні вибраних класів.'
    : getActiveClass() ? `Оголошення побачать батьки та учні ${clsNum(getActiveClass())} класу.` : '';
};
// Що обрано в модалці → поля запису {scope, class, classes}
function pickedTarget(){
  const schoolWide = canPostSchoolWide();
  const v = schoolWide ? document.getElementById('nw-scope').value : 'class';
  if(v === 'school') return { scope: 'school', class: null };
  let list = CLASS_GROUPS[v] ? CLASS_GROUPS[v].classes.slice()
    : document.querySelector('#nw-classes input') ? pickedClasses()
    : [getActiveClass()].filter(Boolean);
  // Учитель — лише свої класи (правила бази однаково не пустять чужий)
  if(!schoolWide && !CLASS_GROUPS[v] && document.querySelector('#nw-classes input')){ const mine = teacherClasses(); list = list.filter(c => mine.includes(c)); }
  if(!list.length) return null;
  if(list.length === 1) return { scope: 'class', class: list[0] };
  return { scope: 'classes', class: null, classes: Object.fromEntries(list.map(c => [c, true])) };
}

window.publishNews = async function(){
  const title = document.getElementById('nw-title').value.trim();
  const text  = document.getElementById('nw-text').value.trim();
  if(!text) return alert('Напишіть текст оголошення.');

  const target = pickedTarget();
  if(!target) return alert('Оберіть хоча б один клас.');
  const expVal = document.getElementById('nw-exp')?.value;
  const expTs = expVal ? new Date(expVal).getTime() : null;
  const important = document.getElementById('nw-important').checked;
  const color = document.getElementById('nw-colors')?.dataset.color || '';
  const btn = document.getElementById('nw-publish');
  btn.disabled = true; btn.textContent = '⏳ Публікую...';
  try{
    const rec = {
      title, text, ...target, important,
      author: auth.currentUser?.uid || '',
      authorName: [currentUserData?.firstName, currentUserData?.lastName].filter(Boolean).join(' ')
                  || currentUserData?.email || 'Школа',
      role: currentUserData?.role || '',
      ts: Date.now()
    };
    if(expTs) rec.expTs = expTs;
    if(color && NEWS_COLORS[color]) rec.color = color;
    const newRef = await push(ref(db,'announcements'), rec);
    logAction('announcement', { value: `${scopeLabel(rec).toLowerCase()} · ${title || text.slice(0,40)}` });

    // Сповіщення — на кожне оголошення (див. шапку файлу)
    pushToast('✅ Опубліковано', await sendNewsPush(rec, newRef.key, false));
    document.getElementById('news-modal').style.display = 'none';
    renderNewsFeed('d-news-feed');
    renderNewsFeed('t-news-feed');
    renderNewsFeed('o-news-feed');
  }catch(e){
    alert('Помилка: ' + e.message);
  }finally{
    btn.disabled = false; btn.textContent = '📢 Опублікувати';
  }
};

window.deleteNews = async function(id){
  // Без «Ви впевнені?»: видаляємо одразу й 10 секунд даємо повернути
  // (undo.js). Реакції й «прочитали» лежать окремо й не чіпаються.
  const redraw = () => { renderNewsFeed('d-news-feed'); renderNewsFeed('t-news-feed'); renderNewsFeed('o-news-feed'); };
  try{
    if(window.deleteWithUndo){
      await window.deleteWithUndo({ paths: { [`announcements/${id}`]: null }, label: 'Оголошення видалено',
        onUndo: () => { logAction('announcement', { value: 'повернуто' }); redraw(); } });
    } else {
      if(!confirm('Видалити це оголошення?')) return;
      await remove(ref(db,`announcements/${id}`));
      showToast('🗑️ Видалено');
    }
    logAction('announcement', { value: 'видалено' });
    redraw();
  }catch(e){ alert('Помилка: ' + e.message); }
};

// ── НАГАДАТИ ──
// Та сама розсилка, що й при публікації, із заголовком «Нагадування».
// Час останнього нагадування зберігаємо в оголошенні: автор бачить, що вже
// нагадував, і випадкове подвійне натискання не шле батькам два push.
const REMIND_GAP = 10 * 60 * 1000;
let remindBusy = false;
window.remindNews = async function(id){
  if(remindBusy) return;
  remindBusy = true;
  try{
    const snap = await get(child(ref(db), `announcements/${id}`));
    if(!snap.exists()) return alert('Оголошення вже видалено.');
    const a = snap.val();
    if(a.expTs && Date.now() > a.expTs) return alert('Термін цього оголошення минув — нагадувати про нього не варто.');
    const who = whoLabel(a);
    const recent = a.remindedAt && Date.now() - a.remindedAt < REMIND_GAP
      ? `\n\n⚠️ Нагадування вже надсилали о ${new Date(a.remindedAt).toLocaleTimeString('uk-UA',{hour:'2-digit',minute:'2-digit'})}. Надіслати ще раз?` : '';
    if(!confirm(`Надіслати сповіщення про «${a.title || String(a.text||'').slice(0,40)}» ${who}?${recent}`)) return;
    const r = await sendNewsPush(a, id, true);
    // Позначка — не головне: якщо правила її не пустять, сповіщення вже пішло
    await update(ref(db, `announcements/${id}`), { remindedAt: Date.now() }).catch(e => console.warn('remindedAt:', e.message));
    pushToast('🔔 Нагадування', r);
    renderNewsFeed('d-news-feed');
    renderNewsFeed('t-news-feed');
    renderNewsFeed('o-news-feed');
  }catch(e){
    alert('Не вдалося нагадати: ' + e.message);
  }finally{ remindBusy = false; }
};

// ── ЧЕРНЕТКА ВІД AI ──
// Учитель диктує суть у двох словах, AI розгортає у ввічливий текст.
// Готове НЕ публікуємо: людина має прочитати й виправити.
window.newsDraftAI = async function(){
  const note = document.getElementById('nw-text').value.trim();
  if(!note) return alert('Напишіть коротко, про що оголошення — AI розгорне його у текст.');
  const btn = document.getElementById('nw-ai');
  btn.disabled = true; btn.textContent = '⏳ Складаю...';
  try{
    const r = await fetch('/.netlify/functions/ai-assist', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ task:'announcement', note })
    });
    const d = await r.json();
    if(!r.ok) throw new Error(d.error || 'Помилка сервера');
    document.getElementById('nw-text').value = d.text || note;
    showToast('✨ Чернетку складено — перевірте і виправте');
  }catch(e){
    alert('Не вдалося скласти: ' + e.message);
  }finally{
    btn.disabled = false; btn.textContent = '✨ Скласти чернетку';
  }
};

window.setNewsExpiry = function(id, expTs){
  document.getElementById('nwe-id').value = id;
  const input = document.getElementById('nwe-exp');
  if(expTs){
    const dt = new Date(expTs);
    const p2 = n => String(n).padStart(2, '0');
    input.value = `${dt.getFullYear()}-${p2(dt.getMonth()+1)}-${p2(dt.getDate())}T${p2(dt.getHours())}:${p2(dt.getMinutes())}`;
  } else {
    input.value = '';
  }
  document.getElementById('news-expiry-modal').style.display = 'flex';
};

window.saveNewsExpiry = async function(){
  const id = document.getElementById('nwe-id').value;
  const val = document.getElementById('nwe-exp').value;
  if(!id) return;
  const expTs = val ? new Date(val).getTime() : null;
  try{
    await update(ref(db, `announcements/${id}`), { expTs: expTs || null });
    showToast('✅ Термін оновлено');
    document.getElementById('news-expiry-modal').style.display = 'none';
    renderNewsFeed('d-news-feed');
    renderNewsFeed('t-news-feed');
    renderNewsFeed('o-news-feed');
  }catch(e){
    alert('Помилка: ' + e.message);
  }
};

window.clearNewsExpiry = async function(){
  const id = document.getElementById('nwe-id').value;
  if(!id) return;
  try{
    await update(ref(db, `announcements/${id}`), { expTs: null });
    showToast('✅ Термін прибрано');
    document.getElementById('news-expiry-modal').style.display = 'none';
    renderNewsFeed('d-news-feed');
    renderNewsFeed('t-news-feed');
    renderNewsFeed('o-news-feed');
  }catch(e){
    alert('Помилка: ' + e.message);
  }
};
