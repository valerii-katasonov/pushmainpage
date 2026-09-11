 // ═══════════════════════════════════════════════════════════════
// mastery.js — освоєння тем за тренажерами.
//
// НАВІЩО. Ігри вже пишуть результат кожної дитини, але побачити його
// може лише сама дитина й батько. Учителю з цього не діставалося нічого,
// хоча саме йому цифра корисна: видно, де клас плаває, ще до
// контрольної.
//
// ── ГОЛОВНЕ ПРАВИЛО ЦЬОГО ФАЙЛА: НЕ БРЕХАТИ ЧИСЛОМ ──────────────
//
// Спокуса написати «клас освоїв дроби на 84%» величезна, і саме так це
// й роблять у більшості шкільних панелей. Але 84% — це середній
// результат ТИХ, ХТО ГРАВ, а грають зазвичай сильні. Якщо з 25 учнів
// зайшло шестеро, «клас освоїв 84%» — неправда, і вчитель це зрозуміє
// приблизно на другому тижні, після чого перестане вірити всій панелі.
//
// Тому охоплення показується ПОРУЧ із результатом і завжди першим:
// «грали 6 з 25 · серед них 84%». Два числа замість одного, зате жодне
// з них не вводить в оману.
//
// ── ЧОМУ ГРУПУЄМО ЗА ТРЕНАЖЕРОМ, А НЕ ЗА ТЕМОЮ ──────────────────
//
// Одна гра закриває кілька тем плану (таблиця множення — шість). Її
// результат один, і розкласти його по темах нічим: гра не знає, яке
// завдання з якої теми. Якби ми все одно показали шість рядків із тим
// самим числом, вийшла б точність, якої немає.
//
// Тому рядок — це тренажер, а теми перелічені в ньому. Скільки тем
// плану взагалі має тренажер — окремим рядком зверху: це відповідь на
// питання «а де ще бракує», і вона чесніша за будь-який відсоток.
//
// ── ЗВІДКИ ДАНІ ─────────────────────────────────────────────────
//
//   games_progress/{клас}/{учень}/{гра} = {best, plays, total, lastAt}
//   curriculum_plans/{клас}/{предмет}/topics = {id:{lessonNum,title,…}}
//   students_list/{клас}  — знаменник охоплення
//
// Правила бази дають персоналу читати games_progress свого класу цілком,
// тож це одне читання, а не по запиту на дитину.
// ═══════════════════════════════════════════════════════════════
import { ref, get, child } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, getActiveClass, escHtml, getStudentDir, getClassNum,
         subjKey, planKeyWith } from './common.js';
import { CATALOG } from './games.js';

// Межа, з якої вважаємо тему освоєною. 80% — не наукова величина, а
// домовленість: чотири з пʼяти правильних. Винесено в константу, щоб
// не шукати число по коду, коли вчителі скажуть, що межа не та.
export const MASTERED_AT = 0.8;

// ── ЧИСТА ЧАСТИНА ───────────────────────────────────────────────
//
// Жодного звернення до бази й до DOM: усе приходить аргументами. Через
// це панель перевіряється тестами (tests-logic.mjs) без браузера, а
// підрахунок можна буде перенести на сервер, коли з'явиться потреба.
//
//   topics   — вузол topics плану: { id: {lessonNum, title, …} }
//   progress — games_progress/{клас}: { учень: { гра: {best,total,…} } }
//   roster   — масив ключів учнів класу (знаменник охоплення)
//   classNum — номер класу: гра показується лише «своїм» класам
//   catalog  — перелік ігор; за замовчуванням справжній CATALOG. Окремим
//              аргументом, щоб тести подавали свій і не залежали від
//              того, які саме ігри є в порталі сьогодні.
export function buildMastery({ topics, progress, roster, classNum, area, catalog }){
  const plan = Object.values(topics || {})
    .filter(t => t && Number(t.lessonNum) > 0)
    .sort((a,b) => (a.lessonNum||0) - (b.lessonNum||0));
  const titleByNum = new Map(plan.map(t => [Number(t.lessonNum), String(t.title||'')]));

  const games = (catalog || CATALOG || []).filter(g =>
    (!area || g.area === area) && (g.classes || []).includes(classNum));

  const kids = Array.isArray(roster) ? roster : [];
  const rosterSize = kids.length;
  const covered = new Set();

  const rows = games.map(g => {
    const nums = (g.topics || []).filter(n => titleByNum.has(Number(n))).map(Number);
    nums.forEach(n => covered.add(n));

    let played = 0, mastered = 0, sum = 0, lastAt = 0;
    kids.forEach(sid => {
      const rec = ((progress || {})[sid] || {})[g.id];
      // total — скільки було раундів. Нуля там бути не може, але запис
      // міг прийти зі старої версії гри, і ділення на нуль перетворило б
      // усю панель на NaN.
      const total = Number(rec && rec.total) || 0;
      if(!rec || !total) return;
      const pct = Math.max(0, Math.min(1, (Number(rec.best) || 0) / total));
      played++; sum += pct;
      if(pct >= MASTERED_AT) mastered++;
      if((rec.lastAt || 0) > lastAt) lastAt = rec.lastAt;
    });

    return {
      id: g.id, icon: g.icon || '🎮', title: g.title,
      topicNums: nums,
      topicTitles: nums.map(n => titleByNum.get(n)),
      played, rosterSize, mastered, lastAt,
      // Середнє СЕРЕД ТИХ, ХТО ГРАВ. Коли не грав ніхто — null, а не 0:
      // «нуль відсотків» і «ще ніхто не заходив» — різні речі, і нуль на
      // екрані означав би, що клас усе провалив.
      avgPct: played ? Math.round((sum / played) * 100) : null
    };
  });

  // Теми, до яких тренажера немає. Це не докір, а список, з якого видно,
  // куди має сенс писати наступну гру.
  const gaps = plan.filter(t => !covered.has(Number(t.lessonNum)))
                   .map(t => ({ lessonNum: Number(t.lessonNum), title: String(t.title||'') }));

  return { rows, rosterSize, planTotal: plan.length, coveredTopics: covered.size, gaps };
}

// ── ЧИТАННЯ Й ПОКАЗ ─────────────────────────────────────────────

// Які предмети взагалі має сенс питати: рівно ті, для яких є тренажери.
export function masteryAreas(classNum){
  return [...new Set((CATALOG || [])
    .filter(g => (g.classes || []).includes(classNum))
    .map(g => g.area))];
}

async function readPlanTopics(cls, subject){
  // Псевдоніми читаємо самі, а не через curriculum.js: його кеш
  // наповнюється лише тоді, коли вчитель відкривав картку завантаження
  // плану. Тут вона не відкривалася жодного разу.
  let aliases = {};
  try{
    const al = await get(child(ref(db), `curriculum_aliases/${cls}`));
    if(al.exists()) aliases = al.val() || {};
  }catch(e){ console.warn('[Push School] освоєння: псевдоніми:', e.message); }
  const sk = planKeyWith(aliases, subject) || subjKey(subject);
  const snap = await get(child(ref(db), `curriculum_plans/${cls}/${sk}/topics`));
  return snap.exists() ? (snap.val() || {}) : {};
}

const pctLabel = v => v === null ? '—' : v + '%';
const dateLabel = ts => ts ? new Date(ts).toLocaleDateString('uk-UA',{day:'2-digit',month:'2-digit'}) : '';

function renderRows(box, data, subject, classNum){
  if(!data.rows.length){
    box.innerHTML = `<p class="empty-msg">Для ${escHtml(String(classNum))} класу тренажерів із предмета `
      + `«${escHtml(subject)}» ще немає.</p>`;
    return;
  }
  const head = `<p style="font-size:.8rem;color:#555;margin:0 0 10px 0;">`
    + `У класі <b>${data.rosterSize}</b> ${data.rosterSize === 1 ? 'учень' : 'учнів'} · `
    + `тренажери охоплюють <b>${data.coveredTopics}</b> ${data.coveredTopics === 1 ? 'тему' : 'тем'} `
    + `із ${data.planTotal} у плані</p>`;

  const rows = data.rows.map(r => {
    const topics = r.topicNums.length
      ? `Теми ${r.topicNums.join(', ')}: ${escHtml(r.topicTitles.filter(Boolean).slice(0,3).join('; '))}`
      : 'Теми плану не збігаються з номерами в каталозі';
    // Порожній рядок — теж відповідь. «Ще ніхто не заходив» каже вчителю
    // більше, ніж прочерк у трьох колонках.
    const body = r.played
      ? `<b>${r.played}</b> з ${r.rosterSize} грали · середній кращий <b>${pctLabel(r.avgPct)}</b>`
        + ` · впоралися (≥${Math.round(MASTERED_AT*100)}%) <b>${r.mastered}</b>`
        + (r.lastAt ? ` · востаннє ${dateLabel(r.lastAt)}` : '')
      : `<span style="color:#888;">ще ніхто з класу не заходив</span>`;
    const width = r.played ? Math.round((r.played / Math.max(1, r.rosterSize)) * 100) : 0;
    return `<div style="background:#fff;border:1px solid #e0e0e0;border-radius:10px;padding:11px;margin-bottom:8px;">
      <div style="font-weight:700;font-size:.9rem;">${r.icon} ${escHtml(r.title)}</div>
      <div style="font-size:.74rem;color:#777;margin:2px 0 6px 0;">${topics}</div>
      <div style="font-size:.8rem;color:#333;">${body}</div>
      <div style="height:6px;background:#eee;border-radius:4px;margin-top:7px;overflow:hidden;">
        <div style="height:100%;width:${width}%;background:var(--teal,#26a69a);"></div>
      </div>
    </div>`;
  }).join('');

  const gaps = data.gaps.length
    ? `<details style="margin-top:10px;"><summary style="cursor:pointer;font-size:.8rem;color:#7f8c8d;font-weight:600;">
         Теми без тренажера: ${data.gaps.length}</summary>
       <p style="font-size:.76rem;color:#666;margin:7px 0 0 0;">`
      + data.gaps.slice(0,25).map(t => `${t.lessonNum}. ${escHtml(t.title)}`).join('<br>')
      + (data.gaps.length > 25 ? `<br>…ще ${data.gaps.length - 25}` : '')
      + `</p></details>`
    : '';

  box.innerHTML = head + rows + gaps;
}

// Панель на вкладці «Клас» у кабінеті вчителя.
window.renderMastery = async function(boxId){
  const box = document.getElementById(boxId || 'tm-mastery');
  if(!box) return;
  const cls = getActiveClass();
  const classNum = cls ? getClassNum(cls) : 0;
  if(!cls || !classNum){
    box.innerHTML = '<p class="empty-msg">Спочатку оберіть клас.</p>';
    return;
  }
  const areas = masteryAreas(classNum);
  if(!areas.length){
    box.innerHTML = `<p class="empty-msg">Для ${escHtml(String(classNum))} класу тренажерів ще немає — `
      + 'вони поки що є для 3 і 4 класів (математика).</p>';
    return;
  }
  box.innerHTML = '<p class="empty-msg">Завантаження...</p>';

  const subject = areas[0];           // поки що предмет один; далі буде вибір
  try{
    // Кожне читання окремо: без прав на games_progress панель ще має сенс
    // (видно охоплення плану), а Promise.all уронив би все разом.
    const [topics, progSnap, dir] = await Promise.all([
      readPlanTopics(cls, subject),
      get(child(ref(db), `games_progress/${cls}`)).catch(e => { throw e; }),
      getStudentDir(cls).catch(() => ({ byId:{} }))
    ]);
    const data = buildMastery({
      topics,
      progress: progSnap.exists() ? (progSnap.val() || {}) : {},
      roster: Object.keys((dir && dir.byId) || {}),
      classNum, area: subject
    });
    renderRows(box, data, subject, classNum);
  }catch(e){
    // Мовчазний спінер — головна повторювана вада порталу. Кажемо прямо.
    box.innerHTML = `<p class="empty-msg" style="color:var(--red);">Не вдалося порахувати: `
      + `${escHtml(e.message || 'немає доступу')}</p>`;
  }
};
