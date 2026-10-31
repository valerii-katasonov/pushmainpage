// ═══════════════════════════════════════════════════════════════
// ios-fixed.js — нижнє меню на iPhone тримається внизу екрана.
//
// ПРОБЛЕМА. У Safari на iOS 26 є помилка (WebKit 297779): елементи з
// position:fixed після прокрутки, зміни її напрямку, появи/зникнення
// панелі Safari чи клавіатури зсуваються — нижнє меню порталу їхало
// вгору разом зі сторінкою й зависало посеред екрана. «Плаває»: то є,
// то немає; залежить від версії iOS (на 26.5 було, на 26.6 — ні).
// Зачепити її можна, але не вимкнути — це помилка браузера.
//
// ЩО РОБИМО. Самовідновлення: під час і після прокрутки, після зміни
// розміру видимої області (панель Safari, клавіатура, поворот) звіряємо,
// чи нижній край меню там, де нижній край видимого екрана. Якщо меню
// з'їхало — зсуваємо його назад transform'ом на рівно ту різницю. Коли
// браузер знову рахує правильно, поправка сама сходить до нуля.
//
// «ПРУЖИНА» НА КРАЯХ (25.10.2026). Коли сторінку тягнуть за самий верх
// чи низ, iOS відтягує її пружиною, і на ці частки секунди виміри вікна
// «брешуть». Перша версія слухалась їх — і меню підскакувало вгору саме
// там, де раніше було на місці. Тепер: (1) під час пружини нічого не
// змінюємо; (2) виправляємо лише стійкий зсув — однаковий два кадри
// поспіль; короткі стрибки пружини такими не бувають.
//
// БЕЗПЕЧНІСТЬ. Лише iPhone/iPad. Нічого не робимо, поки відкрита
// клавіатура (фокус у полі вводу) чи сторінку збільшено пальцями — там
// «нижній край видимого» не той, до якого меню має прилипати. На справних
// пристроях різниця 0, і transform лишається порожнім.
// ═══════════════════════════════════════════════════════════════
const SEL = '.ui-bnav:not([hidden])';
const TOL = 2;          // px — менше не виправляємо (округлення)

export const isIOSDevice = (nav = typeof navigator !== 'undefined' ? navigator : {}) =>
  /iphone|ipad|ipod/i.test(nav.userAgent || '') || (/macintosh/i.test(nav.userAgent || '') && nav.maxTouchPoints > 1);

const editing = doc => {
  const a = doc.activeElement;
  return !!(a && (a.isContentEditable || /^(input|textarea|select)$/i.test(a.tagName)) && !/^(button|checkbox|radio|submit|reset|range|color|file)$/i.test(a.type || ''));
};

// Де має бути нижній край: низ видимої області (у координатах вікна)
export function targetBottom(win){
  const vv = win.visualViewport;
  if(vv && vv.height) return vv.offsetTop + vv.height;
  return win.innerHeight;
}
// Нова поправка для одного елемента: поточна + різниця до цілі
export function nextShift(cur, bottom, target){
  const d = Math.round(cur + (target - bottom));
  return Math.abs(d) <= TOL ? 0 : d;
}

// Сторінку відтягнуто пружиною за верх чи низ
export function overscrolled(win, doc){
  const y = win.scrollY || win.pageYOffset || 0;
  const se = doc.scrollingElement || doc.documentElement;
  const max = Math.max(0, (se ? se.scrollHeight : 0) - win.innerHeight);
  return y < 0 || y > max + 1;
}
const reset = el => { delete el.dataset.iosShift; delete el.dataset.iosPend; el.style.transform = ''; };
export function fixOnce(win = window, doc = document){
  // Сховане меню не тримає старої поправки — інакше з'явиться зсунутим
  doc.querySelectorAll('.ui-bnav[hidden][data-ios-shift]').forEach(reset);
  const vv = win.visualViewport;
  // Збільшено пальцями або відкрита клавіатура: поправку знімаємо (там
  // «низ видимого» інший) і нічого не міряємо, доки не повернеться норма
  if((vv && Math.abs((vv.scale || 1) - 1) > 0.01) || editing(doc)){ doc.querySelectorAll(SEL).forEach(el => { if(Number(el.dataset.iosShift || 0)) reset(el); }); return; }
  if(overscrolled(win, doc)) return;                            // пружина на краю
  const target = targetBottom(win);
  doc.querySelectorAll(SEL).forEach(el => {
    const r = el.getBoundingClientRect();
    if(!r.height) return;
    const cur = Number(el.dataset.iosShift || 0);
    const next = nextShift(cur, r.bottom, target);
    if(next === cur){ delete el.dataset.iosPend; return; }
    // Лише стійкий зсув: той самий результат два виміри поспіль
    const pend = el.dataset.iosPend;
    if(pend === undefined || Math.abs(Number(pend) - next) > TOL){ el.dataset.iosPend = String(next); return; }
    delete el.dataset.iosPend;
    el.dataset.iosShift = String(next);
    el.style.transform = next ? `translate3d(0,${next}px,0)` : '';
  });
}

export function startIosFixed(win = window, doc = document){
  if(!isIOSDevice(win.navigator)) return false;
  let raf = 0, until = 0;
  // Під час прокрутки — щокадру (одне вимірювання на кадр), ще 400 мс
  // після останньої події: інерційна прокрутка й «пружина» на краях
  const loop = () => {
    raf = 0;
    fixOnce(win, doc);
    if(Date.now() < until) raf = win.requestAnimationFrame(loop);
  };
  const kick = () => { until = Date.now() + 400; if(!raf) raf = win.requestAnimationFrame(loop); };
  win.addEventListener('scroll', kick, { passive: true });
  win.addEventListener('resize', kick);
  win.addEventListener('orientationchange', kick);
  win.addEventListener('pageshow', kick);
  win.addEventListener('scrollend', kick);
  doc.addEventListener('focusout', () => win.setTimeout(kick, 300));   // клавіатура сховалась
  doc.addEventListener('visibilitychange', () => { if(!doc.hidden) kick(); });
  doc.addEventListener('touchend', kick, { passive: true });
  if(win.visualViewport){ win.visualViewport.addEventListener('resize', kick); win.visualViewport.addEventListener('scroll', kick); }
  kick();
  return true;
}
if(typeof window !== 'undefined' && !window.__iosFixed) window.__iosFixed = startIosFixed();
