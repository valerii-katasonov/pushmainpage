/* Push School — мова інтерфейсу (UA / PL / EN).
 *
 * Перекладаємо лише ІНТЕРФЕЙС: написи кнопок, заголовки, підказки,
 * діалоги. Те, що пишуть люди (чат, новини, коментарі, ДЗ, імена),
 * лишається як є.
 *
 * Як працює: сторінка, як і раніше, будується українською. Цей скрипт
 * стежить за DOM (MutationObserver) і підміняє відомі українські рядки
 * перекладом зі словника i18n-<мова>.json — ще до того, як браузер
 * намалює кадр, тож «блимання» українського тексту немає.
 * Для української нічого не завантажується і нічого не змінюється.
 *
 * Звичайний (не module) скрипт у <head>: має обгорнути alert/confirm
 * і дати до того, як їх почнуть викликати інші модулі. */
(function(){
  'use strict';
  var KEY = 'push_lang';
  var LANGS = { uk: 'Українська', pl: 'Polski', en: 'English' };
  var SHORT = { uk: 'UA', pl: 'PL', en: 'EN' };
  var LOCALE = { uk: 'uk-UA', pl: 'pl-PL', en: 'en-GB' };

  function getLang(){
    try { var v = localStorage.getItem(KEY); if (v && LANGS[v]) return v; } catch (e) {}
    return 'uk';
  }
  var lang = getLang();
  var de = document.documentElement;
  de.lang = lang === 'uk' ? 'uk' : lang;
  if (lang !== 'uk') de.classList.add('i18n-pending');

  var api = window.I18N = {
    lang: lang, langs: LANGS, short: SHORT,
    set: setLang, t: function(s){ return s; }, ready: Promise.resolve(),
    orig: function(node){ return orig.get(node); }
  };

  function setLang(l){
    if (!LANGS[l] || l === lang) return;
    try { localStorage.setItem(KEY, l); } catch (e) {}
    location.reload();
  }

  // Перемикачі (у шапці й на екрані входу) працюють для будь-якої мови,
  // тому підключаємо їх ще до перевірки «чи треба перекладати».
  wireSwitchers();

  if (lang === 'uk') { de.classList.remove('i18n-pending'); return; }

  /* ---------- нормалізація: має збігатися з _i18n-work/extract.py ---------- */
  var CYR = /[А-Яа-яЇїІіЄєҐґ]/;
  var LEAD = /^[^\p{L}\p{N}_{]+/u;
  var TRAIL = /[^\p{L}\p{N}_}]+$/u;
  var NUM = /\d+(?:[.,:]\d+)*/g;
  var PH = /\{(#?)(\d+)\}/g;

  var D = null;            // словник: український ключ → переклад
  var PATS = [];           // ключі з {n}: регулярні вирази
  var memo = new Map();
  var orig = new WeakMap(); // текстовий вузол → український оригінал
  var done = new WeakMap(); // вузол → текст, який ми вже обробили

  function esc(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function compile(dict){
    D = dict; PATS = [];
    Object.keys(dict).forEach(function(k){
      if (!/\{\d+\}/.test(k)) return;          // лише числа — шукаємо точним збігом
      var lit = k.replace(PH, '\x00');
      if (!CYR.test(lit)) return;               // «{0} {1}» ловило б усе підряд
      var idx = [], re = '', last = 0, m;
      PH.lastIndex = 0;
      while ((m = PH.exec(k))) {
        re += esc(k.slice(last, m.index));
        re += m[1] ? '(\\d+(?:[.,:]\\d+)*)' : '(.+?)';
        idx.push({ n: +m[2], num: !!m[1] });
        last = PH.lastIndex;
      }
      re += esc(k.slice(last));
      var parts = lit.split('\x00').sort(function(a, b){ return b.length - a.length; });
      // «Слабкий» шаблон: незмінного тексту ледь кілька літер («{0} з {1}»,
      // «{0} і»). Такий зловив би будь-яке речення з прийменником — і
      // переклав би шматок того, що написала людина. Для нього вимагаємо,
      // щоб підстановки були короткими або самі були відомими рядками.
      var weak = (lit.match(/[А-Яа-яЇїІіЄєҐґ]/g) || []).length <= 5;
      PATS.push({ re: new RegExp('^' + re + '$', 'u'), idx: idx, val: dict[k], need: parts[0], len: lit.length, weak: weak });
    });
    // Конкретніші (довший незмінний текст) — першими
    PATS.sort(function(a, b){ return b.len - a.len; });
  }

  function cyrLen(s){ return (s.match(/[А-Яа-яЇїІіЄєҐґ]/g) || []).length; }
  function words(s){ return s.trim().split(/\s+/).filter(function(w){ return CYR.test(w); }).length; }

  function fill(val, get){
    return val.replace(PH, function(_, h, n){ var v = get(+n); return v == null ? '' : v; });
  }

  function core(s, depth){
    if (memo.has(s)) return memo.get(s);
    var r = D[s];
    if (r == null) {
      var nums = [];
      var k = s.replace(NUM, function(m){ nums.push(m); return '{#' + (nums.length - 1) + '}'; });
      if (nums.length && D[k] != null) r = fill(D[k], function(i){ return nums[i]; });
    }
    if (r == null) {
      for (var i = 0; i < PATS.length; i++) {
        var p = PATS[i];
        if (p.need && s.indexOf(p.need) < 0) continue;
        var m = p.re.exec(s);
        if (!m) continue;
        var vals = {}, okk = true;
        for (var j = 0; j < p.idx.length; j++) {
          var o = p.idx[j], v = m[j + 1];
          var tv = (o.num || depth > 2) ? v : text(v, depth + 1);
          if (p.weak && !o.num && tv === v && cyrLen(v) > 4) { okk = false; break; }
          vals[o.n] = tv;
        }
        if (!okk) continue;
        r = fill(p.val, function(n){ return vals[n]; });
        break;
      }
    }
    // «Відсутній» при ключі «відсутній» (і навпаки) — та сама фраза
    if (r == null) {
      var f = s.charAt(0), sw = f === f.toLowerCase() ? f.toUpperCase() : f.toLowerCase();
      if (sw !== f && D[sw + s.slice(1)] != null) {
        var v0 = D[sw + s.slice(1)];
        r = (f === f.toUpperCase() ? v0.charAt(0).toUpperCase() : v0.charAt(0).toLowerCase()) + v0.slice(1);
      }
    }
    // «Учень 5», «3 уроки»: число з краю, а ключ — без нього
    if (r == null && depth < 3) {
      var me = /^(.*?\S)\s+(\d+(?:[.,:]\d+)*)$/.exec(s) || /^(\d+(?:[.,:]\d+)*)\s+(\S.*)$/.exec(s);
      if (me) {
        var numFirst = /^\d/.test(me[1]), word = numFirst ? me[2] : me[1];
        var tw = core(word, depth + 1);
        if (tw != null) r = numFirst ? me[1] + ' ' + tw : tw + ' ' + me[2];
      }
    }
    // Дати, які код складає сам: «15 січня», «Вт, 15 січ.»
    if (r == null) r = dateWords(s);
    if (memo.size > 30000) memo.clear();
    memo.set(s, r == null ? null : r);
    return r;
  }

  /* Місяці й дні тижня. Частина коду складає дату з власних масивів
     (MONTHS_UA, ['Пн','Вт',…]), а не через toLocaleDateString — такі
     рядки перекладаємо по словах, але лише коли КОЖНЕ слово в рядку —
     назва місяця чи дня (інакше це вже не дата, а текст). */
  var DW = (function(){
    var ua = {
      gen: ['січня','лютого','березня','квітня','травня','червня','липня','серпня','вересня','жовтня','листопада','грудня'],
      nom: ['січень','лютий','березень','квітень','травень','червень','липень','серпень','вересень','жовтень','листопад','грудень'],
      sh:  ['січ','лют','бер','квіт','трав','черв','лип','серп','вер','жовт','лист','груд'],
      sh3: ['січ','лют','бер','кві','тра','чер','лип','сер','вер','жов','лис','гру'],
      dl:  ['неділя','понеділок','вівторок','середа','четвер','пʼятниця','субота'],
      ds:  ['нд','пн','вт','ср','чт','пт','сб']
    };
    var T = {
      pl: {
        gen: ['stycznia','lutego','marca','kwietnia','maja','czerwca','lipca','sierpnia','września','października','listopada','grudnia'],
        nom: ['styczeń','luty','marzec','kwiecień','maj','czerwiec','lipiec','sierpień','wrzesień','październik','listopad','grudzień'],
        sh:  ['sty','lut','mar','kwi','maj','cze','lip','sie','wrz','paź','lis','gru'],
        dl:  ['niedziela','poniedziałek','wtorek','środa','czwartek','piątek','sobota'],
        ds:  ['nd','pn','wt','śr','cz','pt','sb']
      },
      en: {
        gen: ['January','February','March','April','May','June','July','August','September','October','November','December'],
        nom: ['January','February','March','April','May','June','July','August','September','October','November','December'],
        sh:  ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],
        dl:  ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'],
        ds:  ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
      }
    }[lang];
    var m = {};
    ['gen','nom','sh','dl','ds'].forEach(function(g){ ua[g].forEach(function(w, i){ m[w] = { t: T[g][i], sh: g === 'sh' }; }); });
    // Тризначні («січ», «кві» — підписи осі в графіку оцінок) — і без числа:
    // звичайними словами вони не бувають. «лист», «трав» — лише з числом.
    ua.sh3.forEach(function(w, i){ m[w] = { t: T.sh[i], sh: false }; });
    return m;
  })();
  function dateWords(s){
    // Скорочення місяців («лист», «бер») — лише поруч із числом:
    // «Лист» без дати — це лист, а не листопад
    var any = false, bad = false, digit = /\d/.test(s);
    var out = s.replace(/[А-Яа-яЇїІіЄєҐґʼ'’]+/g, function(w){
      var k = w.toLowerCase().replace(/['’]/g, 'ʼ'), e = DW[k];
      if (e == null || (e.sh && !digit)) { bad = true; return w; }
      var t = e.t;
      any = true;
      return w.charAt(0) === w.charAt(0).toUpperCase() ? t.charAt(0).toUpperCase() + t.slice(1) : t;
    });
    return (any && !bad) ? out : null;
  }

  var SEP = /(\s*(?::|—|–|·|\||•|\/)\s+|\.\s+|\s+\(|\)\s*)/;

  // Переклад будь-якого рядка з інтерфейсу. Невідоме лишається як є.
  function text(raw, depth){
    depth = depth || 0;
    if (!raw || !D || !CYR.test(raw)) return raw;
    var lw = raw.match(/^\s*/)[0], tw = raw.match(/\s*$/)[0];
    var s = raw.replace(/\s+/g, ' ').trim();
    var lead = (s.match(LEAD) || [''])[0];
    var rest = s.slice(lead.length);
    var trail = (rest.match(TRAIL) || [''])[0];
    var c = rest.slice(0, rest.length - trail.length);
    if (c) {
      var r = core(c, depth);
      if (r != null) return lw + lead + r + trail + tw;
      // «{0} учнів» і подібні — іноді на початку стоїть емодзі чи знак
      if (lead) { r = core(s, depth); if (r != null) return lw + r + tw; }
    }
    if (depth < 3 && SEP.test(s)) {
      // Складений напис «Оцінки · Зберегти» ділимо на частини. Але якщо
      // після цього лишається неперекладене речення (понад 3 слова) — це,
      // найпевніше, текст людини: не чіпаємо його зовсім, щоб не вийшла
      // мішанина мов.
      var bits = s.split(SEP), changed = false, prose = false;
      for (var i = 0; i < bits.length; i += 2) {
        var t = text(bits[i], depth + 1);
        if (t !== bits[i]) { bits[i] = t; changed = true; }
        else if (words(bits[i]) > 3) prose = true;
      }
      if (changed && !prose) return lw + bits.join('') + tw;
    }
    return raw;
  }
  function multi(s){
    return String(s).split('\n').map(function(l){ return text(l); }).join('\n');
  }

  /* ---------- DOM ---------- */
  var SKIP_TAG = { SCRIPT:1, STYLE:1, TEXTAREA:1, NOSCRIPT:1, CODE:1, TEMPLATE:1 };
  // Те, що пишуть люди: чат, новини, коментарі, картки подій, ДЗ.
  var SKIP_SEL = '[data-no-i18n],[contenteditable="true"],' +
    '.ms-text,.nw-title,.nw-text,.cv-text,.pc-text,.pc-title,.ev-title,.ev-extra,' +
    '.hwb-text,.hdv-task p,.hdv-task small,.ta-item-note,.tk-reply,.pm-note,.hw-saved-note,' +
    '.k-skip-note,.sa-reason,.cs-text,.topics-what,' +
    // Екрани директора, адміністрації й кухні ще не перекладені. Краще
    // повністю українською, ніж наполовину.
    '#director-screen,#admin-screen,#kitchen-screen,#organizer-screen';
  var ATTRS = ['placeholder', 'title', 'aria-label', 'data-tip', 'alt'];

  function skipEl(el){
    return SKIP_TAG[el.nodeName] === 1 || (el.matches && el.matches(SKIP_SEL));
  }
  function doText(n){
    var v = n.data;
    if (done.get(n) === v || !CYR.test(v)) return;
    var t = text(v);
    if (t !== v) { orig.set(n, v); n.data = t; }
    done.set(n, n.data);
  }
  function doAttrs(el){
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i], v = el.getAttribute(a);
      if (v && CYR.test(v)) { var t = text(v); if (t !== v) el.setAttribute(a, t); }
    }
    if (el.nodeName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type) && CYR.test(el.value)) {
      var tv = text(el.value); if (tv !== el.value) el.value = tv;
    }
  }
  var FILTER = { acceptNode: function(n){
    if (n.nodeType === 1) return skipEl(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    return NodeFilter.FILTER_ACCEPT;
  } };
  function walk(root){
    if (!root) return;
    if (root.nodeType === 3) {
      var p = root.parentElement;
      if (p && !inSkip(p)) doText(root);
      return;
    }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1 && inSkip(root)) return;
    if (root.nodeType === 1) doAttrs(root);
    var w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, FILTER), n;
    while ((n = w.nextNode())) { if (n.nodeType === 3) doText(n); else doAttrs(n); }
  }
  function inSkip(el){
    for (var e = el; e && e.nodeType === 1; e = e.parentElement) if (skipEl(e)) return true;
    return false;
  }
  var mo = new MutationObserver(function(recs){
    for (var i = 0; i < recs.length; i++) {
      var r = recs[i];
      if (r.type === 'childList') { for (var j = 0; j < r.addedNodes.length; j++) walk(r.addedNodes[j]); }
      else if (r.type === 'characterData') walk(r.target);
      else if (r.type === 'attributes') { if (!inSkip(r.target)) doAttrs(r.target); }
    }
  });

  /* ---------- те, що код читає назад ---------- */
  // option.text: код бере назву уроку/класу з <option> і пише її в
  // сповіщення та журнал. Віддаємо йому український оригінал, щоб у
  // базі й у сповіщеннях інших батьків не з'являлася польська.
  try {
    var od = Object.getOwnPropertyDescriptor(HTMLOptionElement.prototype, 'text');
    Object.defineProperty(HTMLOptionElement.prototype, 'text', {
      configurable: true,
      get: function(){
        var s = '', hit = false, c = this.childNodes;
        for (var i = 0; i < c.length; i++) {
          if (c[i].nodeType !== 3) { s += c[i].textContent; continue; }
          var o = orig.get(c[i]);
          if (o != null && done.get(c[i]) === c[i].data) { s += o; hit = true; } else s += c[i].data;
        }
        return hit ? s.replace(/\s+/g, ' ').trim() : od.get.call(this);
      },
      set: function(v){ od.set.call(this, v); }
    });
  } catch (e) {}

  // Діалоги браузера
  ['alert', 'confirm', 'prompt'].forEach(function(fn){
    var o = window[fn];
    if (typeof o !== 'function') return;
    window[fn] = function(msg){
      var a = Array.prototype.slice.call(arguments);
      if (a.length && a[0] != null && D) a[0] = multi(a[0]);
      return o.apply(window, a);
    };
  });

  // Дати й час: код просить 'uk' / 'uk-UA' — віддаємо мову інтерфейсу
  var LOC = LOCALE[lang];
  function mapLoc(l){
    if (typeof l === 'string') return /^uk\b/i.test(l) ? LOC : l;
    if (Array.isArray(l)) return l.map(mapLoc);
    return l;
  }
  ['toLocaleDateString', 'toLocaleTimeString', 'toLocaleString'].forEach(function(m){
    var o = Date.prototype[m];
    Date.prototype[m] = function(l, opt){ return o.call(this, mapLoc(l), opt); };
  });
  ['DateTimeFormat', 'RelativeTimeFormat', 'ListFormat'].forEach(function(name){
    var O = Intl[name];
    if (!O) return;
    var W = function(l, opt){ return new O(mapLoc(l), opt); };
    W.prototype = O.prototype;
    W.supportedLocalesOf = O.supportedLocalesOf;
    try { Intl[name] = W; } catch (e) {}
  });

  /* ---------- завантаження словника ---------- */
  api.t = function(s){ return D ? multi(s) : s; };
  var started = false;
  function start(){
    if (started || !D) return;
    if (!document.body) return;
    started = true;
    walk(document.body);
    if (document.title) document.title = text(document.title);
    mo.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ATTRS
    });
    de.classList.remove('i18n-pending');
  }
  // Запобіжник: якщо словник не прийшов — показуємо сторінку українською
  setTimeout(function(){ de.classList.remove('i18n-pending'); }, 2500);

  api.ready = fetch('i18n-' + lang + '.json', { cache: 'no-cache' })
    .then(function(r){ if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function(dict){
      compile(dict);
      if (document.body) start();
      else document.addEventListener('DOMContentLoaded', start);
    })
    .catch(function(e){
      try { console.warn('[i18n] словник не завантажився', e); } catch (_) {}
      de.classList.remove('i18n-pending');
    });

  // Для тестів
  api._text = function(s){ return text(s); };
  api._compile = compile;

  /* ---------- перемикачі ---------- */
  function wireSwitchers(){
    // Обидва перемикачі — одна кнопка «🌐 UA ▾» і випадне меню:
    // у шапці й на екранах входу / першого входу / відновлення пароля.
    function wire(b, withCaret){
      if (!b || b.dataset.wired) return;
      b.dataset.wired = '1';
      b.type = 'button';
      b.setAttribute('data-no-i18n', '');
      b.setAttribute('aria-haspopup', 'menu');
      b.setAttribute('aria-expanded', 'false');
      b.setAttribute('aria-label', 'Мова / Język / Language: ' + LANGS[lang]);
      b.title = LANGS[lang];
      b.innerHTML = '<span aria-hidden="true">🌐</span><span class="lang-code">' + SHORT[lang] + '</span>' +
        (withCaret ? '<span class="lang-caret" aria-hidden="true">▾</span>' : '');
      b.addEventListener('click', function(ev){ ev.stopPropagation(); toggleMenu(b); });
    }
    function paint(){
      wire(document.getElementById('pb-lang'), false);
      document.querySelectorAll('.lang-pills').forEach(function(box){
        if (box.dataset.wired) return;
        box.dataset.wired = '1';
        box.setAttribute('data-no-i18n', '');
        var b = document.createElement('button');
        b.className = 'lang-pick';
        box.appendChild(b);
        wire(b, true);
      });
    }
    function toggleMenu(btn){
      var m = document.getElementById('lang-menu');
      if (m) { var same = m._btn === btn; m._close(); if (same) return; }
      m = document.createElement('div');
      m.id = 'lang-menu'; m.className = 'lang-menu'; m.setAttribute('role', 'menu');
      m.setAttribute('data-no-i18n', '');
      m.innerHTML = Object.keys(LANGS).map(function(l){
        return '<button type="button" role="menuitemradio" aria-checked="' + (l === lang) + '" data-lang="' + l + '"' +
          (l === lang ? ' class="is-on"' : '') + '><b>' + SHORT[l] + '</b> ' + LANGS[l] +
          (l === lang ? '<span class="lang-tick" aria-hidden="true">✓</span>' : '') + '</button>';
      }).join('');
      document.body.appendChild(m);
      // Під кнопкою, правим краєм по кнопці (обидві кнопки стоять справа)
      var r = btn.getBoundingClientRect(), mw = m.offsetWidth;
      m.style.top = (r.bottom + window.scrollY + 6) + 'px';
      m.style.left = (Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8)) + window.scrollX) + 'px';
      btn.setAttribute('aria-expanded', 'true');
      m._btn = btn;
      m.addEventListener('click', function(ev){
        var t = ev.target.closest('[data-lang]');
        if (!t) return;
        if (t.dataset.lang === lang) { close(); btn.focus(); } else setLang(t.dataset.lang);
      });
      var items = [].slice.call(m.querySelectorAll('button'));
      function close(){
        m.remove(); btn.setAttribute('aria-expanded', 'false');
        document.removeEventListener('click', off); document.removeEventListener('keydown', key);
        window.removeEventListener('resize', close);
      }
      m._close = close;
      function off(e){ if (!m.contains(e.target)) close(); }
      function key(e){
        var i = items.indexOf(document.activeElement);
        if (e.key === 'Escape' || e.key === 'Tab') { close(); if (e.key === 'Escape') btn.focus(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      }
      // Одразу, без setTimeout: клік, що відкрив меню, сюди не дійде —
      // кнопка зупиняє його (stopPropagation)
      document.addEventListener('click', off); document.addEventListener('keydown', key);
      window.addEventListener('resize', close);
      (m.querySelector('.is-on') || items[0]).focus();
    }
    // Меню мови для інших кнопок (⋯ у шапці на телефоні — pb-more.js)
    api.menu = toggleMenu;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint);
    else paint();
  }
})();
