// ═══════════════════════════════════════════════════════════════
// theme.js — світла / темна тема порталу.
//
// html[data-theme] = 'auto' | 'light' | 'dark'. Початкове значення ставить
// маленький скрипт у <head> (до стилів — щоб не блимало), тут — перемикач у
// профілі, колір рядка стану телефона і «світлий режим» для знімків
// (табель, вивантаження журналу): їх друкують на білому папері.
// Вибір — на пристрої (localStorage): телефон і комп'ютер можуть різнитися.
// ═══════════════════════════════════════════════════════════════
(function(){
  var KEY = 'push_theme';
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function effective(t){ return t === 'auto' ? (mq && mq.matches ? 'dark' : 'light') : t; }
  function current(){ return document.documentElement.dataset.theme || 'auto'; }
  function paint(){
    var t = current();
    var meta = document.querySelector('meta[name="theme-color"]');
    if(meta) meta.setAttribute('content', effective(t) === 'dark' ? '#0E181D' : '#F4F8F9');
    var btns = document.querySelectorAll('[data-theme-pick]');
    for(var i = 0; i < btns.length; i++){
      var on = btns[i].getAttribute('data-theme-pick') === t;
      btns[i].classList.toggle('on', on);
      btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }
  window.setTheme = function(t){
    if(t !== 'light' && t !== 'dark') t = 'auto';
    document.documentElement.dataset.theme = t;
    try{ localStorage.setItem(KEY, t); }catch(e){}
    paint();
  };
  window.effectiveTheme = function(){ return effective(current()); };
  // Знімок сторінки (html2canvas) — завжди у світлій темі, потім повертаємо
  window.withLightTheme = async function(fn){
    var prev = current();
    if(effective(prev) === 'light') return fn();
    document.documentElement.dataset.theme = 'light';
    try{ return await fn(); }
    finally{ document.documentElement.dataset.theme = prev; paint(); }
  };
  if(mq && mq.addEventListener) mq.addEventListener('change', paint);
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint); else paint();
})();
