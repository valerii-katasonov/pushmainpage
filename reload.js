// ═══════════════════════════════════════════════════════════════
// reload.js — «⟳ Оновити» завжди під рукою.
//
// НАВІЩО. Портал часто відкритий як застосунок (з іконки на екрані):
// там немає ні адресного рядка, ні кнопки браузера «оновити», а жест
// «потягнути вниз» спрацьовує не скрізь. Учителеві лишалося закривати й
// відкривати застосунок.
//
// ЩО Є
//   1. Кнопка ⟳ у шапці поруч із 🔔 — завжди. Якщо у відкритому полі є
//      ненадісланий текст (коментар, ДЗ, повідомлення), спершу питаємо.
//   2. Плашка вгорі «Вийшла нова версія порталу · Оновити» — коли ми
//      викладаємо оновлення, а сторінка відкрита з учора. Перевіряємо
//      заголовок cabinet.html (ETag) раз на 10 хв і при поверненні на
//      вкладку. Нічого не перезавантажуємо самі: учитель може бути
//      посеред журналу.
//   3. Та сама плашка з текстом «Сторінка відкрита давно», якщо вкладка
//      пролежала у фоні понад 3 години.
// ═══════════════════════════════════════════════════════════════
const CHECK_EVERY = 10 * 60 * 1000;
const STALE_AFTER = 3 * 60 * 60 * 1000;
let baseTag = null, hiddenAt = 0, bannerShown = false;

// Чи є у видимих полях текст, який ще не збережено
export function hasDraft(root = document){
  return [...root.querySelectorAll('textarea, input[type="text"], input:not([type])')].some(el => {
    if(!el.value || !el.value.trim() || el.value === el.defaultValue) return false;
    if(el.closest('.ui-cmd-wrap, #login-screen, #first-login-screen, #reset-password-screen')) return false;
    return !!(el.offsetParent || el.getClientRects().length);
  });
}
export function reloadNow(force){
  if(!force && hasDraft() && !confirm('Є ненадісланий текст. Після оновлення він зникне.\n\nОновити сторінку?')) return false;
  const b = document.getElementById('pb-reload');
  if(b){ b.classList.add('is-spin'); b.disabled = true; }
  location.reload();
  return true;
}
window.reloadPortal = () => reloadNow(false);

function banner(text){
  if(bannerShown) return;
  bannerShown = true;
  const el = document.createElement('div');
  el.id = 'reload-banner'; el.className = 'rl-banner'; el.setAttribute('role', 'status');
  el.innerHTML = `<span>${text}</span><button type="button" class="rl-go">⟳ Оновити</button>`
    + `<button type="button" class="rl-x" aria-label="Пізніше">✕</button>`;
  el.querySelector('.rl-go').onclick = () => reloadNow(false);
  el.querySelector('.rl-x').onclick = () => { el.remove(); };
  document.body.appendChild(el);
}
async function versionTag(){
  try{
    const r = await fetch('cabinet.html', { method: 'HEAD', cache: 'no-store' });
    if(!r.ok) return null;
    return r.headers.get('etag') || r.headers.get('last-modified') || null;
  }catch(e){ return null; }
}
async function checkVersion(){
  if(document.visibilityState !== 'visible' || bannerShown) return;
  const tag = await versionTag();
  if(!tag) return;
  if(baseTag === null){ baseTag = tag; return; }
  if(tag !== baseTag) banner('🆕 Вийшла нова версія порталу');
}
function init(){
  const bell = document.getElementById('pb-bell');
  if(bell && !document.getElementById('pb-reload')){
    const b = document.createElement('button');
    b.type = 'button'; b.id = 'pb-reload';
    b.setAttribute('aria-label', 'Оновити сторінку'); b.title = 'Оновити сторінку';
    b.innerHTML = '<span aria-hidden="true">⟳</span>';
    b.onclick = () => reloadNow(false);
    bell.parentNode.insertBefore(b, bell);
  }
  checkVersion();
  setInterval(checkVersion, CHECK_EVERY);
  document.addEventListener('visibilitychange', () => {
    if(document.visibilityState === 'hidden'){ hiddenAt = Date.now(); return; }
    if(hiddenAt && Date.now() - hiddenAt > STALE_AFTER) banner('⏰ Сторінка відкрита давно — оновіть, щоб побачити свіже');
    checkVersion();
  });
}
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
