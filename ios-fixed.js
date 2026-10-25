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

export function fixOnce(win = window, doc = document){
  const vv = win.visualViewport;
  if(vv && Math.abs((vv.scale || 1) - 1) > 0.01) return;      // збільшено пальцями
  if(editing(doc)) return;                                      // відкрита клавіатура
  const target = targetBottom(win);
  doc.querySelectorAll(SEL).forEach(el => {
    const r = el.getBoundingClientRect();
    if(!r.height) return;
    const cur = Number(el.dataset.iosShift || 0);
    const next = nextShift(cur, r.bottom, target);
    if(next === cur) return;
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
