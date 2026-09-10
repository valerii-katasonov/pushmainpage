// ═══════════════════════════════════════════════════════════════
// news.js — новинна стрічка школи.
//
// МОДЕЛЬ ДАНИХ
//   announcements/{id} = {
//     title, text,
//     scope: 'school' | 'class',
//     class: 'class_2' | null,     // лише для scope==='class'
//     important: bool,             // true → надсилаємо push
//     author, authorName, role,
//     ts
//   }
//
// ЧОМУ ОДИН ПЛОСКИЙ ВУЗОЛ, А НЕ РОЗБИВКА ПО КЛАСАХ: оголошень небагато
// (одиниці на тиждень), а стрічка має змішувати шкільні й класні в одному
// хронологічному потоці. Розбивка змусила б читати кілька гілок і зшивати
// їх у браузері заради економії, якої тут немає.
//
// ЧОМУ PUSH ЛИШЕ ЗА ГАЛОЧКОЮ: якщо дзвеніти на кожне оголошення, батьки
// вимкнуть сповіщення взагалі — і пропустять те, що справді терміново.
// ═══════════════════════════════════════════════════════════════
import { ref, set, get, child, push, remove, query, orderByKey, limitToLast }
  from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, auth, currentUserData, showToast, escHtml, escJs, logAction,
         notifyEvent, isTeacherRole, getActiveClass } from './common.js';

const FEED_LIMIT = 30;
const SEEN_KEY = 'push_school_news_seen';

// ── Хто що може публікувати ──
export function canPostSchoolWide(){
  const r = currentUserData?.role;
  return r === 'director' || r === 'administrator';
}
export function canPostAtAll(){
  return canPostSchoolWide() || isTeacherRole(currentUserData?.role);
}

const lastSeen = () => { try{ return Number(localStorage.getItem(SEEN_KEY)) || 0; }catch(e){ return 0; } };
const markSeen = () => { try{ localStorage.setItem(SEEN_KEY, String(Date.now())); }catch(e){} };

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
  return Object.keys(v).map(id => ({ id, ...v[id] }))
    .filter(a => a && a.text)
    .sort((a,b) => (b.ts||0) - (a.ts||0));
}

// Родині показуємо шкільні оголошення й оголошення свого класу.
// Персоналу — усе: директор має бачити, що пишуть учителі.
function visibleTo(a, role, cls){
  if(a.scope === 'school') return true;
  if(role === 'director' || role === 'administrator') return true;
  return a.class === cls;
}

export async function renderNewsFeed(containerId){
  const box = document.getElementById(containerId);
  if(!box) return;
  box.innerHTML = '<p class="empty-msg">Завантаження...</p>';
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
      const canDel = mine || canPostSchoolWide();
      const badge  = a.scope === 'school'
        ? '<span class="nw-tag school">Вся школа</span>'
        : `<span class="nw-tag cls">${escHtml(String(a.class||'').replace('class_',''))} клас</span>`;
      return `<article class="nw-item${a.important?' imp':''}${isNew?' new':''}">
        <div class="nw-head">
          ${badge}
          ${a.important ? '<span class="nw-tag imp">Важливе</span>' : ''}
          ${isNew ? '<span class="nw-dot" data-tip="Нове"></span>' : ''}
          <span class="nw-time">${escHtml(timeAgo(a.ts||0))}</span>
        </div>
        ${a.title ? `<h4 class="nw-title">${escHtml(a.title)}</h4>` : ''}
        <div class="nw-text">${escHtml(a.text).replace(/\n/g,'<br>')}</div>
        <div class="nw-foot">
          <span class="nw-author">${escHtml(a.authorName || 'Школа')}</span>
          ${canDel ? `<button class="nw-del" onclick="deleteNews('${escJs(a.id)}')">Видалити</button>` : ''}
        </div>
      </article>`;
    }).join('');
    markSeen();
  }catch(e){
    box.innerHTML = `<p class="empty-msg" style="color:var(--red);">Не вдалося завантажити: ${escHtml(e.message)}</p>`;
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
  return (now - ts) < FRESH_DAYS * 24 * 60 * 60 * 1000;
}

// Скільки днів лишилося висіти. Показуємо це автору й директору: інакше
// незрозуміло, чому оголошення зникло з головної, хоча його не чіпали.
export function daysLeft(a, now){
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
      const badge = a.scope === 'school'
        ? '<span class="nw-tag school">Вся школа</span>'
        : `<span class="nw-tag cls">${escHtml(String(a.class||'').replace('class_',''))} клас</span>`;
      return `<article class="fn-item${a.important?' imp':''}">
        <div class="nw-head">
          ${badge}
          ${a.important ? '<span class="nw-tag imp">Важливе</span>' : ''}
          <span class="nw-time">${escHtml(timeAgo(a.ts||0))}</span>
        </div>
        ${a.title ? `<h4 class="nw-title">${escHtml(a.title)}</h4>` : ''}
        <div class="nw-text">${escHtml(a.text).replace(/\n/g,'<br>')}</div>
        <div class="fn-foot">
          <span>${escHtml(a.authorName || 'Школа')}</span>
          <span class="fn-left" data-tip="Далі оголошення лишиться у вкладці «Школа»">${
            left === 1 ? 'зникне звідси завтра' : `ще ${left} дн тут`}</span>
        </div>
      </article>`;
    }).join('')
    + `<button type="button" class="fn-all" onclick="goToNewsFeed()">Усі оголошення →</button>`;
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
window.openNewsComposer = function(){
  if(!canPostAtAll()) return;
  const modal = document.getElementById('news-modal');
  const scope = document.getElementById('nw-scope');
  if(!modal || !scope) return;
  // Учитель пише лише своєму класу — вибір адресата йому не потрібен
  const schoolWide = canPostSchoolWide();
  document.getElementById('nw-scope-row').style.display = schoolWide ? 'block' : 'none';
  document.getElementById('nw-scope-note').textContent = schoolWide
    ? '' : `Оголошення побачать батьки та учні ${String(getActiveClass()||'').replace('class_','')} класу.`;
  scope.value = schoolWide ? 'school' : 'class';
  window.nwScopeChanged();
  document.getElementById('nw-title').value = '';
  document.getElementById('nw-text').value  = '';
  document.getElementById('nw-important').checked = false;
  modal.style.display = 'flex';
};
window.nwScopeChanged = function(){
  const v = document.getElementById('nw-scope').value;
  const row = document.getElementById('nw-class-row');
  if(row) row.style.display = v === 'class' ? 'block' : 'none';
};

window.publishNews = async function(){
  const title = document.getElementById('nw-title').value.trim();
  const text  = document.getElementById('nw-text').value.trim();
  if(!text) return alert('Напишіть текст оголошення.');

  const schoolWide = canPostSchoolWide();
  const scope = schoolWide ? document.getElementById('nw-scope').value : 'class';
  let cls = null;
  if(scope === 'class'){
    cls = schoolWide ? document.getElementById('nw-class').value : getActiveClass();
    if(!cls) return alert('Оберіть клас.');
  }
  const important = document.getElementById('nw-important').checked;
  const btn = document.getElementById('nw-publish');
  btn.disabled = true; btn.textContent = '⏳ Публікую...';
  try{
    const rec = {
      title, text, scope, class: cls, important,
      author: auth.currentUser?.uid || '',
      authorName: [currentUserData?.firstName, currentUserData?.lastName].filter(Boolean).join(' ')
                  || currentUserData?.email || 'Школа',
      role: currentUserData?.role || '',
      ts: Date.now()
    };
    await push(ref(db,'announcements'), rec);
    logAction('announcement', { value: `${scope === 'school' ? 'вся школа' : cls} · ${title || text.slice(0,40)}` });

    if(important){
      // Сповіщення шле серверна функція одним запитом на всіх підписників
      const r = await notifyEvent('news', {
        class: cls || 'ALL', studentName: 'ALL',
        subject: scope === 'school' ? 'Вся школа' : String(cls).replace('class_','') + ' клас',
        value: title || text.slice(0, 40)
      });
      showToast(r && r.ok ? `✅ Опубліковано, сповіщень: ${r.sent||0}` : '✅ Опубліковано (сповіщення не надіслані)');
    } else {
      showToast('✅ Опубліковано');
    }
    document.getElementById('news-modal').style.display = 'none';
    renderNewsFeed('d-news-feed');
    renderNewsFeed('t-news-feed');
  }catch(e){
    alert('Помилка: ' + e.message);
  }finally{
    btn.disabled = false; btn.textContent = '📢 Опублікувати';
  }
};

window.deleteNews = async function(id){
  if(!confirm('Видалити це оголошення?')) return;
  try{
    await remove(ref(db,`announcements/${id}`));
    logAction('announcement', { value: 'видалено' });
    showToast('🗑️ Видалено');
    renderNewsFeed('d-news-feed');
    renderNewsFeed('t-news-feed');
  }catch(e){ alert('Помилка: ' + e.message); }
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
