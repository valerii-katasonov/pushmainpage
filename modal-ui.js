// ═══════════════════════════════════════════════════════════════
// modal-ui.js — шапка й кнопки вікон завжди під рукою.
//
// БУЛО. У кожному вікні (профіль, картка учня, швидкий журнал, контакти
// батьків…) «Зберегти» і «Закрити» стояли в самому низу вмісту. На
// телефоні, щоб просто закрити вікно, доводилося гортати донизу.
//
// СТАЛО — без переписування двох десятків вікон по одному:
//   • ШАПКА: заголовок вікна + ✕ праворуч. Прилипає до верху, поки
//     вміст гортається. ✕ натискає ту саму кнопку «Закрити/Скасувати»,
//     що вже є у вікні (з усіма її перевірками), а якщо такої немає —
//     просто ховає вікно.
//   • НИЗ: кнопки дій із кінця вікна («💾 Зберегти», «Скасувати»…)
//     збираються в один ряд, що прилипає до низу. Головна дія — праворуч
//     і ширша. Якщо внизу була лише «Закрити», рядок не показуємо: її
//     замінює ✕ угорі.
//
// ЯК. Вузли не створюються заново — наявні елементи лише ПЕРЕНОСЯТЬСЯ в
// обгортки .mc-head / .mc-foot. Ідентифікатори й onclick лишаються ті
// самі, тож логіка вікон не змінюється. Вікна, які вже мають власну
// шапку з ✕ (картка 360°, коментарі, консультації…), не чіпаємо.
// Журнал (свій повноекранний режим) і листування — теж поза цим.
// ═══════════════════════════════════════════════════════════════

const SKIP = new Set(['journal-modal', 'inbox-modal']);
// \b у JS не бачить меж кириличних слів — тому (?!\p{L}) з прапорцем u
const CLOSE_RE = /^\s*(✕|×|❌)?\s*(закрити|скасувати|назад|дякую|відмінити|не зараз|готово)(?!\p{L})/iu;
const label = el => (el.textContent || '').replace(/\s+/g, ' ').trim();
const isBtn = el => el && el.tagName === 'BUTTON';
// «Ряд кнопок»: div, у якому лише кнопки (і порожні вузли)
const isBtnRow = el => el && el.tagName === 'DIV' && el.children.length > 0
  && [...el.children].every(c => isBtn(c)) && !el.classList.contains('journal-actions');
export const isCloseBtn = b => isBtn(b) && CLOSE_RE.test(label(b));

// Чи вже є у вікні власна кнопка закриття згори (✕ / aria-label)
function hasOwnTopClose(mc){
  const head = [...mc.children].slice(0, 3);
  return head.some(el => el.matches && (el.matches('[aria-label="Закрити"], .cv-close, .ui-sheet-x, .s3-close')
    || el.querySelector?.('[aria-label="Закрити"], .cv-close, .ui-sheet-x, .s3-close')));
}

// Хвіст вікна: останні кнопки / ряди кнопок поспіль
export function trailingActions(mc){
  const kids = [...mc.children];
  const out = [];
  for(let i = kids.length - 1; i >= 0; i--){
    const el = kids[i];
    if(el.tagName === 'SCRIPT' || (el.nodeType === 1 && getComputedStyle(el).display === 'none' && !isBtn(el) && !isBtnRow(el))) continue;
    if(isBtn(el) || isBtnRow(el)) out.unshift(el); else break;
  }
  return out;
}

export function enhanceModal(ov){
  if(!ov || SKIP.has(ov.id) || ov.dataset.mcDone) return;
  const mc = ov.querySelector(':scope > .modal-content');
  if(!mc) return;
  ov.dataset.mcDone = '1';
  // Нові вікна з власною шапкою (картка 360°, коментарі, консультації…)
  // уже зроблені як треба — їх не чіпаємо зовсім
  if(hasOwnTopClose(mc)) return;
  mc.classList.add('mc-enh');

  // ── Низ: кнопки дій ──
  const acts = trailingActions(mc);
  const btns = acts.flatMap(el => isBtn(el) ? [el] : [...el.children]);
  let closeBtn = btns.slice().reverse().find(isCloseBtn) || null;
  if(acts.length){
    const foot = document.createElement('div');
    foot.className = 'mc-foot';
    acts.forEach(el => foot.appendChild(el));
    // Головна дія — остання справа; «Скасувати/Закрити» — ліворуч
    const fb = [...foot.querySelectorAll(':scope > button, :scope > div > button')];
    fb.filter(isCloseBtn).forEach(b => b.classList.add('mc-sec'));
    fb.filter(b => !isCloseBtn(b)).forEach(b => b.classList.add('mc-pri'));
    if(fb.length && fb.every(isCloseBtn)) foot.classList.add('only-close');
    mc.appendChild(foot);
  }

  // ── Шапка: заголовок + ✕ ──
  {
    const h = [...mc.children].find(el => /^H[1-4]$/.test(el.tagName));
    const head = document.createElement('div');
    head.className = 'mc-head';
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'mc-x'; x.setAttribute('aria-label', 'Закрити'); x.textContent = '✕';
    x.addEventListener('click', () => {
      // Кнопку шукаємо щоразу: деякі вікна перемальовують свій вміст
      const cb = closeBtn && closeBtn.isConnected ? closeBtn
        : [...mc.querySelectorAll('.mc-foot button, :scope > button')].reverse().find(isCloseBtn);
      if(cb) cb.click(); else ov.style.display = 'none';
    });
    if(h){ mc.insertBefore(head, h); head.appendChild(h); } else mc.insertBefore(head, mc.firstChild);
    head.appendChild(x);
  }
}

// Вікна бувають у розмітці й створюються скриптами пізніше — стежимо за
// появою нових і доводимо до ладу при першому показі
function scan(root = document){
  root.querySelectorAll?.('.modal-overlay').forEach(ov => {
    if(ov.dataset.mcWatch) return;
    ov.dataset.mcWatch = '1';
    const shown = () => ov.style.display && ov.style.display !== 'none';
    if(shown()) enhanceModal(ov);
    new MutationObserver(() => { if(shown()) enhanceModal(ov); }).observe(ov, { attributes: true, attributeFilter: ['style'] });
  });
}
function init(){
  scan();
  new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => {
    if(n.nodeType !== 1) return;
    if(n.classList?.contains('modal-overlay')) scan(n.parentNode || document); else scan(n);
  }))).observe(document.body, { childList: true });
}
window.enhanceModal = enhanceModal;
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
