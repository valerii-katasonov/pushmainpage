// ═══════════════════════════════════════════════════════════════
// games.js — навчальні ігри в кабінеті батьків і учня.
//
// НАВІЩО. Тренування рахунку зараз відбувається або в зошиті, або в
// випадковому застосунку з реклами. Тут те саме, але за темами, які клас
// РЕАЛЬНО проходить, і з прогресом, який видно батькові.
//
// ── ЩО ТУТ ЗА «ДВИГУН» ──────────────────────────────────────────
//
// Майже кожна навчальна гра — це один і той самий цикл: видати завдання,
// прийняти відповідь, перевірити, порахувати, зберегти. Відрізняються
// ігри лише тим, ЯК народжується завдання.
//
// Тому цикл живе тут, один на всіх, а кожна гра — це маленький файл у
// games/, який експортує рівно дві речі:
//
//   export const meta = { id, title, rounds, hint };
//   export function task(rnd){ return { question, answer, options }; }
//
// І все. Гра не знає ні про базу, ні про DOM, ні про ролі. Через це нова
// гра коштує півгодини, а не тиждень, і зламати в ній нічого.
//
// options === null → поле для введення; масив рядків → кнопки вибору.
//
// ── ЧОМУ ГЕНЕРАТОР ВИПАДКОВИХ ПРИХОДИТЬ ЗЗОВНІ ──────────────────
//
// task() отримує rnd, а не бере Math.random сам. rnd — це генератор із
// зерном: за тим самим зерном виходить та сама послідовність завдань.
// Поки нагороди косметичні, це просто не заважає. Але щойно за очки
// почнуть щось давати — накрутку через консоль браузера доведеться
// перевіряти на сервері, і тоді функція за збереженим зерном відтворить
// ті самі завдання й перерахує відповіді. Закладено зараз, щоб потім не
// переписувати всі ігри.
//
// ── ЧОМУ ІГРИ ВАНТАЖАТЬСЯ ЧЕРЕЗ import() ────────────────────────
//
// У cabinet.html вже шістнадцять модулів, і всі вони вантажаться одразу.
// Для шістнадцяти це терпимо. Якби кожна гра стала таким самим тегом,
// кабінет відкривався б повільніше в УСІХ — включно з учителями, які в
// ігри не заходять узагалі.
//
// Тому в каталозі лежить лише опис (назва, клас, шлях), а код гри
// підвантажується в мить, коли дитина її відкрила. Третьокласник
// завантажує одну гру, а не тридцять.
//
// ── ДЕ ЛЕЖИТЬ ПРОГРЕС ───────────────────────────────────────────
//
//   games_progress/{клас}/{учень}/{гра} = {best, plays, lastAt, by}
//
// Той самий вигляд, що й у activity_plan: клас зверху, дитина під ним.
// Так учителю дістається його клас одним читанням, а правила бази
// пишуться тим самим способом, що вже працює.
// ═══════════════════════════════════════════════════════════════
import { ref, get, child, update } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
// escJs і escHtml — різні інструменти, і потрібні обидва: escJs береже
// рядковий літерал усередині onclick="fn('…')", escHtml — сам текст
// сторінки. Апостроф у варіанті відповіді (а українські слова їх повні)
// без escJs ламає обробник цілком.
import { db, currentUserData, getActiveClass, showToast, escHtml, escJs,
         logAction, getStudentDir, resolveStudentKey, getClassNum } from './common.js';

// ── КАТАЛОГ ─────────────────────────────────────────────────────
//
// classes — для яких класів гра має сенс. Не «з якого», а перелік:
// таблиця множення потрібна і третьому, і четвертому, але не сьомому,
// де вона давно в пальцях.
//
// topics — номери тем із календарного плану. Поки що довідково, щоб було
// видно, звідки гра взялася, і щоб потім можна було показувати ігри
// прямо біля теми уроку.
//
// Каталог експортується: панель освоєння тем (mastery.js) звіряє номери
// тем саме з ним. Другої копії переліку в проєкті бути не повинно — на
// розбіжних копіях того самого списку тут уже обпікалися (РЕВІЗІЯ-4).
export const CATALOG = [
  { id:'mult-table',   icon:'✖️', title:'Таблиця множення',  subtitle:'Множення й ділення в межах 100',
    classes:[3,4], area:'Математика', topics:[8,9,10,12,13,14], file:'./games/mult-table.js' },
  { id:'missing-part', icon:'❓', title:'Знайди невідоме',    subtitle:'Невідомий доданок, множник, дільник',
    classes:[3,4], area:'Математика', topics:[26,28],          file:'./games/missing-part.js' }
];

// ── ГЕНЕРАТОР ВИПАДКОВИХ ІЗ ЗЕРНОМ ──────────────────────────────
//
// mulberry32: коротко, швидко, і головне — відтворювано. Math.random
// відтворити не можна ніяк, а нам це знадобиться (див. шапку).
function makeRnd(seed){
  let s = seed >>> 0;
  return function(n){
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return Math.floor(r * n);
  };
}

// ── ХТО ГРАЄ ────────────────────────────────────────────────────
//
// Вкладка є і в батьків, і в учня, і панелі обох лежать у розмітці
// ОДНОЧАСНО — просто одна прихована. Тому «взяти той елемент, що
// існує» тут не працює: для учня знайшовся б і батьківський блок, і
// малювання пішло б у приховану панель. Питаємо роль, як у homework.js.
function isPupil(){
  return !!(currentUserData && currentUserData.role === 'student');
}
function boxId(){ return isPupil() ? 's-games' : 'p-games'; }

// Ключ дитини — той самий, що в усьому порталі: звірка зі списком класу,
// а не довіра до копії в профілі. Причина докладно описана в activities.js:
// у різних батьків однієї дитини в профілі лежать різні речі, і без
// звірки та сама дитина роздвоюється в базі.
async function whoseProgress(){
  const d = currentUserData || {};
  const cls = d.class || getActiveClass();
  if(!cls) return { cls:'', sid:'' };
  let dir = null;
  try{ dir = await getStudentDir(cls); }
  catch(e){ console.warn('[Push School] ігри: довідник класу:', e.message); }
  const res = resolveStudentKey(dir, d.studentId, d.studentName);
  return { cls, sid: res.key || d.studentId || d.studentName || '' };
}

// Номер класу — спільною getClassNum, а не власною регуляркою. Своя
// копія тут уже була написана, і це рівно та вада, через яку в порталі
// колись розійшлися чотири різні способи почистити назву предмета.
//
// Одне застереження: getClassNum на порожньому значенні повертає 1 —
// зручний типовий клас для решти порталу, але не для нас. «Клас
// невідомий» тут має означати «ігор не показуємо», а не «показуємо
// першокласні». Тому порожнечу відсікаємо до виклику.
function classNumber(cls){ return cls ? getClassNum(cls) : 0; }

// ── ПРОГРЕС ─────────────────────────────────────────────────────
let progressCache = null;

async function loadProgress(){
  const { cls, sid } = await whoseProgress();
  if(!cls || !sid) return {};
  try{
    const snap = await get(child(ref(db), `games_progress/${cls}/${sid}`));
    progressCache = snap.exists() ? snap.val() : {};
  }catch(e){
    // Прогрес — прикраса, а не умова гри. Не змогли прочитати — граємо
    // без нього, але мовчки ковтати причину не можна: саме так свого
    // часу шукали «Permission denied» по всьому порталу.
    console.warn('[Push School] ігри: прогрес не прочитано:', e.message);
    progressCache = {};
  }
  return progressCache;
}

// ЗАПИСУЄМО Й ТОДІ, КОЛИ ГРАЄ БАТЬКО.
//
// Спокуса була рахувати лише гру дитини — щоб статистика лишалася
// чистою. Але половина сімей грає разом і з батьківського телефона:
// дитина натискає, батько підказує. Якби ті спроби нікуди не йшли,
// прогрес виглядав би порожнім рівно там, де займалися найбільше.
//
// Тому пишемо завжди, а поле by каже, з чийого кабінету зайшли.
async function saveResult(gameId, score, total){
  const { cls, sid } = await whoseProgress();
  if(!cls || !sid) return;
  const prev = (progressCache && progressCache[gameId]) || {};
  const best = Math.max(Number(prev.best) || 0, score);
  const rec = {
    best,
    plays: (Number(prev.plays) || 0) + 1,
    last: score,
    total,
    lastAt: Date.now(),
    by: isPupil() ? 'student' : 'parent'
  };
  try{
    await update(ref(db, `games_progress/${cls}/${sid}/${gameId}`), rec);
    progressCache = progressCache || {};
    progressCache[gameId] = rec;
    logAction('game_played', { game: gameId, score, total });
  }catch(e){
    console.warn('[Push School] ігри: прогрес не збережено:', e.message);
    showToast('Результат не зберігся, але гра зарахована');
  }
}

// ── НАГОРОДИ ────────────────────────────────────────────────────
//
// Свідомо косметичні. Поки за них нічого не дають, накручувати їх через
// консоль немає сенсу — зіпсуєш тільки собі. Щойно з'явиться щось
// справжнє (приз від школи, рейтинг класу), доведеться перевіряти на
// сервері; про це в шапці.
//
// Три сходинки, а не десять: дитині має бути видно наступну.
function medal(score, total){
  if(!total) return null;
  const part = score / total;
  if(part === 1)    return { icon:'🏆', label:'Бездоганно' };
  if(part >= 0.8)   return { icon:'🥈', label:'Майже все' };
  if(part >= 0.5)   return { icon:'🥉', label:'Непогано' };
  return null;
}

// ── КАТАЛОГ НА ЕКРАНІ ───────────────────────────────────────────
function catalogHtml(cls, progress){
  const n = classNumber(cls);
  const list = CATALOG.filter(g => g.classes.includes(n));

  if(!list.length){
    return `<div class="data-card"><p style="margin:0;color:#78909c;font-size:.9rem;">
      Для цього класу ігор поки немає — вони з'являються за темами, які клас проходить.
    </p></div>`;
  }

  return `<div class="gm-grid">` + list.map(g => {
    const p = progress[g.id] || {};
    const best = Number(p.best) || 0;
    const done = Number(p.plays) || 0;
    // Підпис про минулі спроби показуємо, лише якщо вони були: порожнє
    // «0 спроб» під кожною грою — це шум, а не інформація.
    const note = done
      ? `<span class="gm-best">Найкраще: ${best} · спроб: ${done}</span>`
      : `<span class="gm-best gm-new">Ще не грали</span>`;
    return `<button class="gm-card" onclick="openGame('${escJs(g.id)}')">
      <span class="gm-icon">${g.icon}</span>
      <span class="gm-body">
        <b>${escHtml(g.title)}</b>
        <span class="gm-sub">${escHtml(g.subtitle)}</span>
        ${note}
      </span>
    </button>`;
  }).join('') + `</div>`;
}

// ── ЦИКЛ ГРИ ────────────────────────────────────────────────────
//
// Один стан на весь модуль: одночасно відкрита рівно одна гра, тримати
// їх список немає навіщо.
let session = null;

function paintRound(){
  const box = document.getElementById(boxId());
  if(!box || !session) return;
  const t = session.tasks[session.i];
  const done = session.i;
  const pct = Math.round(done / session.tasks.length * 100);

  // Варіанти або поле — вирішує сама гра, повернувши options.
  const answerHtml = t.options
    ? `<div class="gm-opts">` + t.options.map(o =>
        `<button class="gm-opt" onclick="answerGame('${escJs(String(o))}')">${escHtml(String(o))}</button>`
      ).join('') + `</div>`
    : `<form class="gm-form" onsubmit="submitGameAnswer(event)">
         <input id="gm-input" type="text" inputmode="numeric" autocomplete="off"
                placeholder="?" aria-label="Відповідь">
         <button type="submit">Відповісти</button>
       </form>`;

  box.innerHTML = `
    <div class="gm-play">
      <div class="gm-top">
        <button class="gm-back" onclick="closeGame()">← Ігри</button>
        <span class="gm-count">${done + 1} / ${session.tasks.length}</span>
      </div>
      <div class="gm-bar"><i style="width:${pct}%"></i></div>
      <div class="gm-q">${escHtml(String(t.question))}</div>
      ${answerHtml}
      <div id="gm-feed" class="gm-feed"></div>
    </div>`;

  const inp = document.getElementById('gm-input');
  // Фокус — щоб на комп'ютері можна було грати з клавіатури не
  // торкаючись миші. На телефоні це заразом підіймає цифрову клавіатуру.
  if(inp) inp.focus();
}

function paintResult(){
  const box = document.getElementById(boxId());
  if(!box || !session) return;
  const total = session.tasks.length;
  const m = medal(session.score, total);
  const wrong = session.wrong;

  // Помилки показуємо списком — це найкорисніша частина всієї гри.
  // Дитина бачить не «7 з 10», а рівно ті три приклади, які не вийшли.
  const wrongHtml = wrong.length
    ? `<div class="gm-wrong"><b>Варто повторити:</b>` + wrong.map(w =>
        `<span>${escHtml(String(w.question))} = ${escHtml(String(w.answer))}</span>`
      ).join('') + `</div>`
    : `<p class="gm-allright">Жодної помилки.</p>`;

  box.innerHTML = `
    <div class="gm-play gm-done">
      <div class="gm-medal">${m ? m.icon : '🙂'}</div>
      <h4>${m ? escHtml(m.label) : 'Ще потренуємось'}</h4>
      <p class="gm-score">${session.score} з ${total}</p>
      ${wrongHtml}
      <div class="gm-again">
        <button onclick="startGame('${escJs(session.id)}')">Ще раз</button>
        <button class="gm-ghost" onclick="closeGame()">До списку</button>
      </div>
    </div>`;
}

// Перевірка відповіді. Порівнюємо рядки після trim: гра повертає
// відповідь рядком, і «56 » з пробілом від дитини має зараховуватись.
function check(given){
  if(!session) return;
  // ПОДВІЙНА ВІДПОВІДЬ.
  //
  // Між відповіддю й наступним завданням є пауза (див. нижче), і всі
  // цієї паузи кнопки лишалися живими. Дитина, яка тицяє швидко — а вони
  // всі тицяють швидко, — встигала відповісти двічі на те саме завдання:
  // очко нараховувалося двічі, session.i зростав на два, і одне завдання
  // просто зникало. У підсумку «13 з 12».
  //
  // Замок знімається там само, де малюється наступний раунд.
  if(session.locked) return;
  session.locked = true;
  const t = session.tasks[session.i];
  const okAnswer = String(t.answer).trim() === String(given).trim();
  if(okAnswer) session.score++;
  else session.wrong.push(t);

  const feed = document.getElementById('gm-feed');
  if(feed){
    feed.className = 'gm-feed ' + (okAnswer ? 'gm-ok' : 'gm-no');
    feed.textContent = okAnswer ? '✓ Правильно' : `✗ Правильно: ${t.answer}`;
  }

  session.i++;
  // Пауза перед наступним завданням. Коротка на правильній відповіді й
  // довша на помилковій: правильну дитина не читає, а на помилку треба
  // встигнути подивитися, інакше вона проскакує непоміченою.
  const pause = okAnswer ? 450 : 1200;
  const at = session.i;
  setTimeout(() => {
    // Могли встигнути вийти з гри або почати нову — тоді нічого не робимо.
    // Замок при цьому не знімаємо: він належить тій сесії, якої вже немає,
    // а в нової свій власний.
    if(!session || session.i !== at) return;
    session.locked = false;
    if(session.i >= session.tasks.length){
      paintResult();
      saveResult(session.id, session.score, session.tasks.length);
    } else {
      paintRound();
    }
  }, pause);
}

// ── ЗАПУСК ──────────────────────────────────────────────────────
window.startGame = async function(id){
  const item = CATALOG.find(g => g.id === id);
  const box = document.getElementById(boxId());
  if(!item || !box) return;

  box.innerHTML = `<p class="gm-load">Завантажую гру…</p>`;
  let mod;
  try{
    mod = await import(item.file);
  }catch(e){
    // Мережа зникла або файл не виклався. Кажемо прямо й лишаємо шлях
    // назад — порожній екран без кнопки був би глухим кутом.
    console.error('[Push School] гра не завантажилась:', id, e && e.message);
    box.innerHTML = `<div class="data-card"><p style="margin:0 0 10px;">Не вдалося завантажити гру.
      Перевірте зв'язок і спробуйте ще раз.</p>
      <button onclick="closeGame()">До списку</button></div>`;
    return;
  }

  const rounds = (mod.meta && mod.meta.rounds) || 10;
  const seed = (Date.now() ^ Math.floor(Math.random() * 0xFFFFFF)) >>> 0;
  const rnd = makeRnd(seed);

  // Не даємо двом однаковим завданням поспіль: у грі на десять раундів
  // повтор «6 × 7» двічі підряд виглядає як зависання, а не як випадковість.
  const tasks = [];
  let guard = 0;
  while(tasks.length < rounds && guard < rounds * 20){
    guard++;
    const t = mod.task(rnd);
    if(!t || t.question == null) continue;
    if(tasks.length && tasks[tasks.length - 1].question === t.question) continue;
    tasks.push(t);
  }
  if(!tasks.length){
    box.innerHTML = `<div class="data-card"><p style="margin:0 0 10px;">Гра не змогла скласти завдання.</p>
      <button onclick="closeGame()">До списку</button></div>`;
    return;
  }

  session = { id, seed, tasks, i:0, score:0, wrong:[], locked:false };
  paintRound();
};

window.openGame = function(id){ window.startGame(id); };

window.answerGame = function(v){ check(v); };

window.submitGameAnswer = function(ev){
  ev.preventDefault();
  const inp = document.getElementById('gm-input');
  if(!inp) return;
  const v = inp.value;
  // Порожнє поле — не відповідь і не помилка: просто нічого не робимо,
  // інакше випадковий Enter з'їдав би завдання.
  if(!String(v).trim()) return;
  check(v);
};

window.closeGame = function(){
  session = null;
  window.openGamesTab();
};

// ── ВКЛАДКА ─────────────────────────────────────────────────────
//
// Викликається з onclick на кнопці вкладки — так само, як openHwTab.
window.openGamesTab = async function(){
  const box = document.getElementById(boxId());
  if(!box) return;
  box.innerHTML = `<p class="gm-load">Хвилинку…</p>`;

  // ВІЧНЕ «ЗАВАНТАЖЕННЯ» — НАЙЧАСТІША ВАДА ЦЬОГО ПОРТАЛУ.
  //
  // Варто чомусь усередині кинути виключення, і напис «Хвилинку…»
  // лишається назавжди: людина бачить, що щось вантажиться, і чекає
  // того, чого вже не буде. Тому все, що між написом і результатом,
  // загорнуте, а відмова перетворюється на видимий текст із кнопкою.
  try{
    const { cls } = await whoseProgress();
    const progress = await loadProgress();

    const hint = isPupil()
      ? 'Обери гру. Це тренування, а не оцінка — помилятися можна скільки завгодно.'
      : 'Ігри за темами, які клас зараз проходить. Можна грати разом — спроби з вашого кабінету теж зараховуються.';

    box.innerHTML = `<p class="gm-hint">${escHtml(hint)}</p>` + catalogHtml(cls, progress);
  }catch(e){
    console.error('[Push School] вкладка ігор:', e && e.message);
    box.innerHTML = `<div class="data-card"><p style="margin:0 0 10px;">Не вдалося показати список ігор.</p>`
      + `<button onclick="openGamesTab()">Спробувати ще раз</button></div>`;
  }
};

// ── ОНОВЛЕННЯ ПРИ ЗМІНІ ДИТИНИ ──────────────────────────────────
//
// У батька з двома дітьми клас змінюється без перезавантаження сторінки.
// Без цього на вкладці лишався б каталог для класу попередньої дитини.
// Перемальовуємо тільки якщо вкладку видно — інакше кожне перемикання
// тягло б зайве читання бази у фон.
window.refreshGamesTabIfOpen = function(){
  const b = document.getElementById(boxId());
  if(b && b.offsetParent !== null && !session) window.openGamesTab();
};
