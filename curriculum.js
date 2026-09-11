// ═══════════════════════════════════════════════════════════════
// curriculum.js — the whole "CURRICULUM MODULE (v3)" block, moved
// here verbatim from the bottom of the original file: Excel plan
// upload/parsing, the topic selector used by teacher.js's journal
// filling, and Class Teacher Assignment (director-screen UI, but
// kept together with the rest of this module exactly as it was
// physically grouped in the original script).
// XLSX comes from the CDN <script> tag already in <head> (global).
// ═══════════════════════════════════════════════════════════════
import { ref, set, get, child, update, remove } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, auth, getActiveClass, currentUserData, showToast, localDateString, escHtml, teacherAccessMatrix, withTeachingRole, syncStaffCard, isBreakItem, isTeacherRole, isMasterTeacher, escJs, logAction, subjKey, emailKey } from './common.js';

let parsedCurriculum=null;        // після парсингу xlsx
const MAX_TOPICS=250;             // стеля на предмет: захист від зіпсованого файлу
// availableTopicsCache is reassigned only here (populateTopicSelector)
// and read (property access) from teacher.js (saveLessonTopic) — plain
// export/import.
export let availableTopicsCache={};
let currentClassTeacherEmail=null;
// Helper: безпечний ключ предмету
// Helper: Excel serial → ISO дата
function excelDateToISO(val){
  if(val instanceof Date) return val.toISOString().slice(0,10);
  if(typeof val==='number'){
    const d=new Date(Date.UTC(1899,11,30)+val*86400000);
    return d.toISOString().slice(0,10);
  }
  if(typeof val==='string'&&val.match(/^\d{4}-\d{2}-\d{2}/))return val.slice(0,10);
  return null;
}

// ═══════ ПРОСТИЙ ШАБЛОН КАЛЕНДАРНО-ТЕМАТИЧНОГО ПЛАНУВАННЯ ═══════
// Школа роздає вчителям бланк із трьох колонок:
//     № уроку | Тема | Години
// Номери уроків на кілька годин пишуться діапазоном: «1-4».
// Нижче таблиці в бланку є пояснення й приклад — вони не мають потрапити
// в план, тому читаємо лише до першого порожнього рядка.
//
// ЧОМУ ДВА ФОРМАТИ. Раніше портал приймав інший файл — з блоком
// метаданих і шістьма колонками. У вчителів такі файли лишилися, тож
// формат визначаємо за заголовком, а не ламаємо те, що працює.

// «1-4» → {from:1, to:4};  «5» → {from:5, to:5};  порожньо → null
export function parseLessonRange(v){
  const t = String(v == null ? '' : v).trim();
  if(!t) return null;
  // Тире буває звичайне, довге й нерозривне — люди копіюють із різних місць
  const m = t.replace(/[\u2010-\u2015\u2212]/g, '-').match(/^(\d+)\s*-\s*(\d+)$/);
  if(m){
    const a = parseInt(m[1]), b = parseInt(m[2]);
    if(isNaN(a) || isNaN(b) || b < a) return null;
    return { from:a, to:b };
  }
  const one = t.match(/^(\d+)$/);
  if(one) return { from:parseInt(one[1]), to:parseInt(one[1]) };
  return null;
}

// Ціле число з клітинки Excel або запасне значення.
//
// НАВІЩО ОКРЕМА ФУНКЦІЯ. parseInt('І') і parseInt('1-4') дають NaN, а
// NaN мовчки доїжджає до бази й падає аж там: «value argument contains
// NaN in property ...t_NaN_0.lessonNum». Учитель бачить незрозумілу
// англійську помилку й не знає, який рядок у файлі винен.
export function intOr(v, fallback){
  if(v === null || v === undefined) return fallback;
  const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

// Теми, у яких номер уроку або години не читаються числом.
// Повертає перелік проблемних рядків, щоб сказати про них людині.
export function badTopics(topics){
  const bad = [];
  (topics || []).forEach((t, i) => {
    if(!Number.isFinite(t.lessonNum)) bad.push({ row: i + 1, title: t.title || '', field: 'номер уроку' });
    else if(!Number.isFinite(t.plannedHours) || t.plannedHours < 1)
      bad.push({ row: i + 1, title: t.title || '', field: 'години' });
  });
  return bad;
}

// Полагодити те, що можна полагодити: номер за порядком, години = 1
export function repairTopics(topics){
  return (topics || []).map((t, i) => ({
    ...t,
    lessonNum: Number.isFinite(t.lessonNum) ? t.lessonNum : i + 1,
    plannedHours: (Number.isFinite(t.plannedHours) && t.plannedHours > 0) ? t.plannedHours : 1
  }));
}

// Чи це рядок заголовка простого бланка.
//
// ЧОМУ ПЕРЕВІРКА ТАКА ТЕРПИМА. Спочатку тут вимагалося слово «уроку» саме
// в першій колонці — як у бланку «№ уроку | Тема | Години». Але вчителі
// підписують колонки по-своєму: «№ | Тема уроку | Година». Такий файл не
// впізнавався, провалювався у старий шестиколонковий розбір, і той брав
// сам рядок заголовка за першу тему: parseInt('Тема уроку') давав NaN,
// а Firebase відхиляв увесь план помилкою про 't_NaN_0'.
// Тому дивимося на зміст колонок, а не на точне формулювання.
// Де в цьому заголовку номер, тема й години → {num, title, hours} або null.
//
// ЧОМУ ШУКАЄМО, А НЕ РАХУЄМО ПОЗИЦІЇ. Колонки прив'язувалися до місць
// 0, 1, 2. Поки зайві колонки стояли праворуч, це працювало; варто було
// вставити одну ліворуч або між номером і темою — і файл переставав
// впізнаватися. Учителі роблять таблиці по-різному, тож дивимося на
// підписи колонок, а не на порядок.
// Заголовки КАЛЕНДАРНОГО ПЛАНУ (№ / тема / години). Однойменна функція в
// students-import.js розбирає зовсім іншу таблицю — списки учнів. Назви
// різні навмисно: однакове імʼя для різних речей плутає більше, ніж
// допомагає, і колись хтось «звів би дублікат» до однієї реалізації.
export function planHeaderMap(r){
  if(!r) return null;
  const c = i => String(r[i] == null ? '' : r[i]).toLowerCase().trim();
  let num = -1, title = -1, hours = -1;
  for(let i = 0; i < r.length; i++){
    const v = c(i);
    if(!v) continue;
    if(num < 0 && (v.includes('№') || v.includes('номер') || v.includes('п/п')
                   || (v.includes('уроку') && !v.includes('тема')))) { num = i; continue; }
    if(title < 0 && (v.includes('тема') || v.includes('зміст'))) { title = i; continue; }
    if(hours < 0 && (v.includes('год') || v.includes('к-сть'))) { hours = i; continue; }
  }
  if(num < 0 || title < 0) return null;
  return { num, title, hours };
}

export function isSimpleHeader(r){ return planHeaderMap(r) !== null; }

export function parseSimplePlan(rows){
  let head = -1, map = null;
  for(let i = 0; i < rows.length; i++){
    const m = planHeaderMap(rows[i]);
    if(m){ head = i; map = m; break; }
  }
  if(head < 0) return null;

  const topics = [];
  for(let i = head + 1; i < rows.length; i++){
    const r = rows[i] || [];
    const title = String(r[map.title] == null ? '' : r[map.title]).trim();
    // Порожній рядок зазвичай означає кінець таблиці: далі в бланку йдуть
    // пояснення й приклад із таким самим заголовком, читати їх не можна.
    // Але вчителі лишають і порожній рядок просто для відступу. Тому
    // дивимося на наступний: якщо там є номер уроку — це відступ,
    // продовжуємо; якщо ні — таблиця справді скінчилася.
    if(!title){
      const nxt = rows[i + 1] || [];
      const nxtTitle = String(nxt[map.title] == null ? '' : nxt[map.title]).trim();
      if(nxtTitle && parseLessonRange(nxt[map.num])) continue;
      break;
    }
    const range = parseLessonRange(r[map.num]);
    const hoursCell = map.hours < 0 ? NaN
      : Number(String(r[map.hours] == null ? '' : r[map.hours]).replace(',', '.'));
    const hours = (hoursCell > 0)
      ? Math.round(hoursCell)
      : (range ? (range.to - range.from + 1) : 1);
    topics.push({
      section: '',
      lessonNum: range ? range.from : (topics.length + 1),
      lessonTo:  range ? range.to   : null,
      title,
      plannedDate: null,
      plannedHours: hours,
      tags: ''
    });
  }
  return topics.length ? topics : null;
}

// «matematyka5.xlsx» → {subjectHint:'matematyka', classNum:5}
export function parsePlanFileName(name){
  const base = String(name || '').replace(/\.[^.]+$/, '').trim();
  const m = base.match(/^(.*?)[ _-]*(\d{1,2})$/);
  if(!m) return { subjectHint: base, classNum: null };
  const n = parseInt(m[2]);
  return {
    subjectHint: m[1].replace(/[_-]+/g, ' ').trim(),
    classNum: (n >= 1 && n <= 11) ? n : null
  };
}

// Латиниця з бланка → назва предмета українською. Список неповний
// навмисно: якщо предмета тут немає, учитель обирає його руками, і це
// краще, ніж підставити схоже, але не те.
const SUBJECT_HINTS = {
  matematyka:'Математика', ukrainska:'Українська мова', ukrmova:'Українська мова',
  chytannia:'Читання', literatura:'Література', anglijska:'Англійська мова',
  english:'Англійська мова', polska:'Польська мова', istoria:'Історія',
  pryroda:'Природознавство', biologia:'Біологія', geografia:'Географія',
  fizyka:'Фізика', himia:'Хімія', informatyka:'Інформатика',
  muzyka:'Музичне мистецтво', obrazotvorche:'Образотворче мистецтво',
  fizkultura:'Фізична культура', trudove:'Трудове навчання'
};
export function subjectFromHint(hint){
  const k = String(hint || '').toLowerCase().replace(/[^a-z]/g, '');
  return SUBJECT_HINTS[k] || '';
}

// ═══════ Парсер Excel ═══════
let lastPlanFile='';
window.handleCurriculumFile=function(e){
  const file=e.target.files[0];if(!file)return;
  lastPlanFile=file.name;
  const dropEl=document.getElementById('curr-drop-zone-label');
  const txtEl=document.getElementById('curr-drop-text');
  txtEl.innerText=`📄 ${file.name}`;
  dropEl.classList.add('has-file');
  const reader=new FileReader();
  reader.onload=function(evt){
    try{
      const wb=XLSX.read(evt.target.result,{type:'array',cellDates:true});
      parsedCurriculum=parseCurriculumWorkbook(wb);
      // Предмет із поля має пріоритет над здогадкою за назвою файлу
      applyChosenSubject(parsedCurriculum);
    }catch(err){alert("Помилка парсингу: "+err.message);console.error(err);}
  };
  reader.readAsArrayBuffer(file);
};
function parseCurriculumWorkbook(wb){
  const result={sheets:{}};
  const fromName=parsePlanFileName(lastPlanFile);
  wb.SheetNames.forEach(sheetName=>{
    const sheet=wb.Sheets[sheetName];
    const rows=XLSX.utils.sheet_to_json(sheet,{header:1,defval:null});

    // Спершу простий бланк школи: три колонки й заголовок «№ уроку | Тема».
    // Якщо його немає — читаємо старий формат із блоком метаданих.
    const simple=parseSimplePlan(rows);
    if(simple){
      result.sheets[sheetName]={
        meta:{
          year:'', teacher:'', language:'',
          classNum: fromName.classNum,
          subject: subjectFromHint(fromName.subjectHint) || fromName.subjectHint || sheetName,
          subjectGuessed: !subjectFromHint(fromName.subjectHint),
          format:'simple'
        },
        topics:simple
      };
      return;
    }

    const meta={};let dataStartRow=-1;
    for(let i=0;i<rows.length;i++){
      const r=rows[i];if(!r||!r[0])continue;
      const key=String(r[0]).trim().replace(/:$/,'');
      if(key==='Розділ / блок'){dataStartRow=i+1;break;}
      if(r[1]!==null&&r[1]!==undefined)meta[key]=r[1];
    }
    // Немає маркера «Розділ / блок» — це не старий формат. Раніше тут
    // стояв нуль, і розбір починався з першого рядка, тобто з'їдав
    // заголовок як тему. Мовчазне вгадування гірше за чесну відмову.
    if(dataStartRow < 0) return;
    const topics=[];
    for(let i=dataStartRow;i<rows.length;i++){
      const r=rows[i];if(!r||!r[2])continue;
      topics.push({
        section:r[0]?String(r[0]).trim():'',
        lessonNum:intOr(r[1], topics.length+1),
        title:String(r[2]).trim(),
        plannedDate:excelDateToISO(r[3]),
        plannedHours:intOr(r[4], 1),
        tags:r[5]?String(r[5]).trim():''
      });
    }
    if(topics.length>0){
      result.sheets[sheetName]={
        meta:{
          year:meta['Навчальний рік']||'',
          classNum:meta['Клас']?parseInt(meta['Клас']):null,
          subject:meta['Предмет']||sheetName,
          teacher:meta['Учитель']||'',
          language:meta['Мова викладання']||'',
          format:'legacy'
        },
        topics:topics
      };
    }
  });
  return result;
}
// ═══════ Хто і що має право вантажити ═══════
// Календарний план належить предмету, а не класу: математику веде один
// учитель, історію інший, і кожен складає свій план сам. Тому право на
// завантаження визначається призначенням на предмет, а не посадою.
//
//   директор       — будь-який клас, будь-який предмет
//   класний керівник — будь-який предмет свого класу
//   учитель        — лише предмети, на які його призначено в цьому класі
//
// Джерело істини — teacher_access/{пошта}/{клас} = [перелік предметів],
// той самий вузол, за яким учителя пускають виставляти оцінки. Окремого
// списку не заводимо: два списки неминуче розійдуться.
const DIR_ROLES = ['director', 'administrator'];

// Клас, у який зберігається план. У вчителя — обраний у селекторі зверху,
// у директора власного класу немає, тому він обирає його в самій картці.
export function currClass(){
  if(DIR_ROLES.includes(currentUserData?.role)){
    const sel = document.getElementById('curr-dir-class');
    if(sel && sel.value) return sel.value;
  }
  return getActiveClass();
}

// Предмети, дозволені цьому користувачу в цьому класі.
// null означає «будь-який» — так простіше, ніж перелічувати всі предмети школи.
export function allowedSubjectsFor(cls, role, matrix, isClassTeacher){
  if(DIR_ROLES.includes(role)) return null;
  if(isClassTeacher) return null;
  const raw = (matrix || {})[cls];
  if(!raw) return [];
  const list = (Array.isArray(raw) ? raw : Object.values(raw))
    .map(s => typeof s === 'string' ? s.trim() : '')
    .filter(Boolean);
  if(list.includes('Всі предмети')) return null;
  return list;
}

// Чи можна зберегти план саме з такою назвою предмета.
// Порівнюємо без урахування регістру: учитель напише «математика», а в
// призначеннях стоїть «Математика» — це той самий предмет.
export function subjectAllowedForUpload(subject, allowed){
  if(allowed === null) return true;
  const s = String(subject || '').trim().toLowerCase();
  if(!s) return false;
  return allowed.some(a => a.toLowerCase() === s);
}

// ══════════════════════════════════════════════════════════════════
//  СПІЛЬНИЙ ПЛАН ДЛЯ ДВОХ НАЗВ ПРЕДМЕТА
// ══════════════════════════════════════════════════════════════════
//
// НАВІЩО. Той самий курс у школі має дві назви — «Математика» і
// «Matematyka». У розкладі це різні рядки, тож і плани виходили різні:
// один заповнений, другий порожній. Учитель бачив «теми не
// показуються» на кожному другому уроці й заливав план удруге.
//
// Копію робити не можна: дві копії розходяться з першою ж правкою, і
// вже через місяць ніхто не скаже, яка з них справжня. Тому копії немає
// — є псевдонім. «Matematyka» каже: план шукай у «Математика». Теми,
// заплановані години й витрачені лежать в одному місці, а звідки на них
// подивилися — байдуже.
//
//   curriculum_aliases/{клас}/{ключ псевдоніма} = «Канонічна назва»
//
// ЩО ПСЕВДОНІМ НЕ ЧІПАЄ. Журнал, оцінки й теми проведених уроків
// (lesson_topics) лишаються при своїх назвах: там дві назви — це два
// різні уроки в розкладі, і зливати їх означало б зливати два журнали.
// Якщо школі потрібне й це, хай буде окремим рішенням, а не побічним
// наслідком спільного плану.
let aliasMap = {};
let aliasCls = '';

export async function loadAliases(cls){
  aliasCls = cls || '';
  aliasMap = {};
  if(!cls) return;
  try{
    const snap = await get(ref(db, `curriculum_aliases/${cls}`));
    if(snap.exists()) aliasMap = snap.val() || {};
  }catch(e){
    // Не прочиталися — поводимося як раніше: кожна назва зі своїм планом.
    // Відмова передбачувана: людина побачить порожній план, а не чужий.
    console.warn('curriculum_aliases:', e.message);
  }
}

// Під якою назвою насправді лежить план цього предмета.
//
// Крок рівно один. Якщо А вказує на Б, а Б на В — зупиняємось на Б.
// Ланцюжки тут нікому не потрібні, а зациклити їх випадково легко, і
// тоді сторінка просто повисне.
export function planSubject(cls, subj){
  if(!subj) return subj;
  // Кеш належить одному класу. Якщо питають про інший — не вгадуємо:
  // мовчазна підстановка чужого псевдоніма гірша за його відсутність.
  if(cls && cls !== aliasCls) return subj;
  const target = aliasMap[subjKey(subj)];
  return (target && String(target).trim()) ? String(target).trim() : subj;
}

// Ключ плану в базі: спершу псевдонім, потім очищення під Firebase.
// Усі шляхи curriculum_plans рахуються ЛИШЕ через неї.
export function planKey(cls, subj){ return subjKey(planSubject(cls, subj)); }

// Стан доступу поточного користувача — обчислюється один раз при показі
// картки і використовується і у превʼю, і при збереженні.
let uploadAccess = { allowed: [], isClassTeacher: false, cls: null };

function renderCurriculumPreview(data){
  const container=document.getElementById('curr-preview-content');
  const classSpan=document.getElementById('curr-preview-class');
  const cls=currClass();
  const clsNum=parseInt(String(cls).replace('class_',''));
  classSpan.innerText=`→ ${cls.replace('class_','')} клас`;
  let html='';
  for(let sheetName in data.sheets){
    const s=data.sheets[sheetName];
    const simple = s.meta.format==='simple';
    const hours = s.topics.reduce((a,t)=>a+(t.plannedHours||0),0);
    // Клас із імені файлу проти класу, обраного в кабінеті. Розбіжність —
    // найчастіша помилка: учитель відкрив один клас, а вантажить файл іншого.
    const clsMismatch = simple && s.meta.classNum && clsNum && s.meta.classNum!==clsNum;

    html+=`<div class="topic-preview">
      <div class="topic-preview-subj">📚 ${escHtml(s.meta.subject)}
        <span style="font-size:.72rem;color:#888;font-weight:400;">
          ${s.topics.length} тем · ${hours} год</span></div>`;

    if(simple){
      html+=`<div class="curr-src">Розпізнано простий бланк школи${
        s.meta.classNum?` · клас із назви файлу: ${s.meta.classNum}`:''}</div>`;
    }

    // Предмет: якщо в користувача є перелік дозволених — вибір зі списку,
    // а не вільний текст. Так учитель не помилиться в написанні («Матемтика»
    // створила б окремий предмет-двійник) і не збереже план у чужий предмет.
    const allowed = uploadAccess.allowed;
    const okSubj  = subjectAllowedForUpload(s.meta.subject, allowed);
    // Предмет уже обрано у полі над завантаженням — другий раз не питаємо.
    if(s.meta.subjectChosen){
      /* нічого не показуємо: назва вже у заголовку картки вище */
    } else if(allowed !== null){
      if(!okSubj){
        html+=`<div class="curr-warn danger">Предмет «${escHtml(s.meta.subject)}» вам у цьому
          класі не призначено. Оберіть свій предмет — інакше план не збережеться.</div>`;
      } else if(s.meta.subjectGuessed){
        html+=`<div class="curr-warn">Предмет узятий із назви файлу — перевірте, чи правильно.</div>`;
      }
      html+=`<select class="curr-subj-fix" onchange="fixPlanSubject('${escJsSafe(sheetName)}', this.value)">
        ${!okSubj?'<option value="" selected>— оберіть предмет —</option>':''}
        ${allowed.map(a=>`<option value="${escHtml(a)}"${
          okSubj && a.toLowerCase()===String(s.meta.subject).trim().toLowerCase()?' selected':''
        }>${escHtml(a)}</option>`).join('')}
      </select>`;
    } else if(simple && s.meta.subjectGuessed){
      html+=`<div class="curr-warn">Предмет узятий із назви файлу — перевірте,
        чи він правильний. Виправити можна нижче.</div>
        <input type="text" class="curr-subj-fix" value="${escHtml(s.meta.subject)}"
               oninput="fixPlanSubject('${escJsSafe(sheetName)}', this.value)"
               placeholder="Назва предмета українською">`;
    }

    if(simple){
      if(clsMismatch){
        html+=`<div class="curr-warn danger">У назві файлу клас ${s.meta.classNum},
          а в кабінеті відкрито ${clsNum}. План збережеться в ${clsNum} клас —
          перевірте, чи це те, що потрібно.</div>`;
      }
    }

    s.topics.forEach(t=>{
      const label = t.lessonTo && t.lessonTo!==t.lessonNum
        ? `${t.lessonNum}-${t.lessonTo}` : String(t.lessonNum);
      html+=`<div class="topic-preview-row">
        <span class="num">${escHtml(label)}</span>
        <span><b>${escHtml(t.title)}</b><br>
          <span style="color:#888;font-size:.7rem;">${t.plannedHours} год${
            t.plannedDate?` · ${escHtml(t.plannedDate)}`:''}</span></span></div>`;
    });
    html+=`</div>`;
  }
  // Проблемні рядки показуємо ДО збереження. Раніше файл із нечисловим
  // номером уроку мовчки доходив до бази й падав там незрозумілою
  // англійською помилкою — учитель не знав, який рядок винен.
  const problems = [];
  Object.entries(parsedCurriculum.sheets || {}).forEach(([name, sh]) => {
    badTopics(sh.topics).forEach(b => problems.push(
      `${name}, рядок ${b.row}${b.title ? ` («${b.title}»)` : ''}: не читається ${b.field}`));
  });
  if(problems.length){
    html = `<div class="curr-warn danger" style="display:block;">
      <b>Не всі клітинки читаються числом (${problems.length}).</b><br>
      ${problems.slice(0, 8).map(p => escHtml(p)).join('<br>')}
      ${problems.length > 8 ? `<br>…і ще ${problems.length - 8}` : ''}
      <br><br>Зберегти можна: номер уроку підставимо за порядком, години — 1.
      Але краще виправити файл, бо номери впливають на порядок тем у журналі.
    </div>` + html;
  }
  container.innerHTML=html;
  document.getElementById('curr-preview-section').style.display='block';
}

// Просте екранування для підстановки в onclick/oninput
function escJsSafe(v){ return String(v).replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }

// Учитель виправляє предмет, який портал угадав із назви файлу
window.fixPlanSubject=function(sheetName, value){
  if(!parsedCurriculum || !parsedCurriculum.sheets[sheetName]) return;
  parsedCurriculum.sheets[sheetName].meta.subject = String(value||'').trim();
};
window.saveCurriculumToDb=async function(){
  if(!parsedCurriculum)return alert("Спочатку завантажте файл!");
  const cls=currClass();

  // Перевірка предмета — тут, а не лише у превʼю. Превʼю можна обійти,
  // збереження — ні. Правила бази цього не ловлять: вони дозволяють запис
  // будь-якому вчителю, бо не знають, який предмет усередині файлу.
  // Предмет має бути заданий явно. Раніше він міг лишитися здогадкою за
  // назвою файлу — і план тихо зберігався під назвою на кшталт «matematyka»,
  // якої немає в розкладі. Теми після цього не показувалися ніде.
  const noSubject = Object.values(parsedCurriculum.sheets)
    .filter(sh => !String(sh.meta.subject || '').trim()).length;
  if(noSubject){
    alert('Не вказано предмет. Оберіть його у полі «Предмет, до якого належить план» '
        + 'над завантаженням файлу.');
    return;
  }

  const notMine=[];
  for(const name in parsedCurriculum.sheets){
    const subj=parsedCurriculum.sheets[name].meta.subject;
    if(!subjectAllowedForUpload(subj, uploadAccess.allowed))
      notMine.push(subj || '(без назви)');
  }
  if(notMine.length){
    alert('Не збережено. Ці предмети вам у цьому класі не призначені: '
      + notMine.join(', ')
      + '.\n\nОберіть свій предмет у списку над темами. Якщо предмет справді ваш — '
      + 'попросіть директора призначити вас на нього.');
    return;
  }

  const btn=document.getElementById('btn-save-curr');
  btn.disabled=true;btn.innerText="⏳ Збереження...";
  try{
    // Ліміт тем на предмет. Раніше стояло 5 — значення з часів, коли
    // завантажували пробні файли. Справжнє календарне планування має
    // десятки рядків, і такий ліміт мовчки викидав майже все.
    //
    // Стеля лишається, але розумна: навчальний рік — близько 35 тижнів,
    // при семи уроках предмета на тиждень це 245. MAX_TOPICS захищає базу
    // від зіпсованого файлу на тисячі рядків, а не від нормального плану.
    let trimmedWarnings=[];
    for(let sheetName in parsedCurriculum.sheets){
      const s=parsedCurriculum.sheets[sheetName];
      // planKey, а не subjKey: якщо для цієї назви заведено спільний
      // план, файл має лягти в нього, а не завести третій вузол поруч.
      const sk=planKey(cls, s.meta.subject);
      let topicsToSave=s.topics;
      if(topicsToSave.length>MAX_TOPICS){
        const cut=topicsToSave.length-MAX_TOPICS;
        topicsToSave=topicsToSave.slice(0,MAX_TOPICS);
        trimmedWarnings.push(`${s.meta.subject}: -${cut}`);
      }
      await set(ref(db,`curriculum_plans/${cls}/${sk}/meta`),{
        ...s.meta,
        uploadedBy:auth.currentUser.uid,
        uploadedAt:localDateString
      });
      // ПЕРЕНОСИМО ВИТРАЧЕНІ ГОДИНИ — СПЕРШУ ЗА НАЗВОЮ, ПОТІМ ЗА НОМЕРОМ.
      //
      // Раніше зіставлення йшло ЛИШЕ за номером уроку. Через це найчастіша
      // правка плану — вставити забуту тему в середину — тихо ламала облік:
      // номери всіх наступних тем зсувалися на одиницю, і години сідали на
      // сусідні теми. Учитель бачив, що «Додавання» раптом пройдено на
      // третину, а «Віднімання» — взагалі з нуля.
      //
      // Назва теми зсуву не має. Тому головне зіставлення — за нею, а
      // номер лишається запасним: для перейменованих тем і для планів, де
      // назви повторюються.
      const existSnap=await get(ref(db,`curriculum_plans/${cls}/${sk}/topics`));
      const existing=existSnap.exists()?existSnap.val():{};
      const existByLesson={}, existByTitle={};
      const norm = s => String(s||'').replace(/\s+/g,' ').trim().toLowerCase();
      for(let id in existing){
        const t=existing[id]||{};
        const hu=t.hoursUsed||0;
        existByLesson[t.lessonNum]={id,hoursUsed:hu};
        const key=norm(t.title);
        // Якщо назва повторюється, за нею зіставляти не можна — лишаємо
        // мітку, щоб такі теми пішли запасним шляхом, за номером.
        if(key) existByTitle[key] = (key in existByTitle) ? null : {id,hoursUsed:hu};
      }
      // Останній рубіж: навіть якщо крізь розбір пройшло щось нечислове,
      // до бази воно не потрапить. Firebase відхиляє NaN цілим записом,
      // тож один зіпсований рядок інакше губить увесь план.
      const safeTopics = repairTopics(topicsToSave);
      const newTopics={};
      // Назву використали — більше нікому її не віддаємо: інакше дві теми
      // з однаковим текстом забрали б ті самі години двічі.
      const takenTitles=new Set();
      safeTopics.forEach((t,idx)=>{
        const id=`t_${t.lessonNum}_${idx}`;
        const key=norm(t.title);
        const byTitle=(key && !takenTitles.has(key)) ? existByTitle[key] : null;
        if(byTitle) takenTitles.add(key);
        const prevHU=(byTitle || existByLesson[t.lessonNum])?.hoursUsed||0;
        newTopics[id]={...t,hoursUsed:Math.min(prevHU,t.plannedHours)};
      });
      await set(ref(db,`curriculum_plans/${cls}/${sk}/topics`),newTopics);
    }
    let repaired = 0;
    Object.values(parsedCurriculum.sheets || {}).forEach(sh => { repaired += badTopics(sh.topics).length; });
    showToast(trimmedWarnings.length>0
      ?`✅ План збережено! ⚠️ Перевищено ліміт ${MAX_TOPICS} тем на предмет — не поміщено: ${trimmedWarnings.join(', ')}`
      :(repaired ? `✅ План збережено. ${repaired} рядків мали нечислові клітинки — номери проставлено за порядком.`
                 : "✅ Календарне планування збережено!"));
    parsedCurriculum=null;
    document.getElementById('curr-preview-section').style.display='none';
    document.getElementById('curr-file-input').value='';
    document.getElementById('curr-drop-text').innerText='📤 Натисніть або перетягніть Excel файл сюди';
    document.getElementById('curr-drop-zone-label').classList.remove('has-file');
    loadCurrentCurriculumDisplay();
    populateTopicSelector();
  }catch(e){alert("Помилка: "+e.message);}
  btn.disabled=false;btn.innerText="💾 Зберегти план у систему";
};
async function loadCurrentCurriculumDisplay(){
  const cls=currClass();
  const snap=await get(ref(db,`curriculum_plans/${cls}`));
  const el=document.getElementById('current-curriculum-display');
  if(!el)return;
  if(!snap.exists()){el.innerHTML='<p class="empty-msg">План ще не завантажено.</p>';return;}
  const data=snap.val();let html='';
  for(let sk in data){
    const meta=data[sk].meta||{};
    const topics=data[sk].topics||{};
    const total=Object.keys(topics).length;
    let coveredCount=0;
    for(let id in topics) if((topics[id].hoursUsed||0)>=topics[id].plannedHours) coveredCount++;
    html+=`<div style="padding:7px 0;border-bottom:1px dashed #ccc;"><b>${meta.subject||sk}</b> — ${coveredCount}/${total} тем пройдено <span style="color:#888;font-size:.72rem;">(${meta.year||''})</span></div>`;
  }
  el.innerHTML=html||'<p class="empty-msg">План порожній.</p>';
}
// ═══════ Topic Selector (Phase 6: up to 2 topics/lesson) ═══════
// Native <select> replaced with a custom div-list dropdown per slot (1 and 2) —
// background-color on <option> isn't reliably stylable cross-browser, so each
// topic row is a plain clickable <div> we fully control, same approach as
// .type-btn elsewhere. #t-topic-value-N (hidden input) is the source of truth
// that used to be sel.value; slot 2's wrapper is hidden until the teacher
// clicks "+ Додати другу тему".
window.toggleTopicDropdown=function(slot){
  const list=document.getElementById(`t-topic-list-${slot}`);
  if(!list)return;
  const isOpen=list.style.display==='block';
  document.querySelectorAll('.topic-dropdown-list').forEach(l=>l.style.display='none');
  list.style.display=isOpen?'none':'block';
};
document.addEventListener('click',function(e){
  if(!e.target.closest('.topic-dropdown'))document.querySelectorAll('.topic-dropdown-list').forEach(l=>l.style.display='none');
});
// ПОВТОРНЕ ВИКОРИСТАННЯ ТЕМИ ДОЗВОЛЕНЕ.
//
// Раніше тема, у якої вичерпані години, просто не натискалася. Учителі
// попросили це прибрати, і слушно: план — орієнтир, а не заборона.
// Клас не зрозумів, тему треба повторити; урок випав через свято й
// матеріал доводиться добирати; контрольна показала прогалину. У всіх
// цих випадках заборона змушувала писати тему «вручну», і план
// переставав відповідати тому, що насправді відбувалося на уроках.
//
// Тепер тему можна взяти ще раз, а перевитрата годин видно кольором
// (див. renderTopicOptionsList) — це чесніше, ніж не дати натиснути.
window.selectTopicOption=function(slot,value,reused){
  if(reused) showToast('↻ Тема вже пройдена — використовуємо повторно');
  const valueInput=document.getElementById(`t-topic-value-${slot}`);
  const trigger=document.getElementById(`t-topic-trigger-${slot}`);
  const customInput=document.getElementById(`t-topic-${slot}`);
  if(!valueInput)return;
  valueInput.value=value;
  document.getElementById(`t-topic-list-${slot}`).style.display='none';
  if(value==='__custom__'){
    if(trigger)trigger.innerText='✏️ Власна тема (ввести вручну)';
    if(customInput){customInput.style.display='block';customInput.focus();}
  } else {
    const t=availableTopicsCache[value];
    if(trigger&&t)trigger.innerText=`№ ${t.lessonNum}. ${t.title} (${t.hoursUsed||0}/${t.plannedHours} год.)`;
    if(customInput){customInput.style.display='none';customInput.value='';}
  }
};
window.showSecondTopicSlot=function(){
  const wrap=document.getElementById('t-topic-slot-2-wrap');const btn=document.getElementById('btn-add-second-topic');
  if(wrap)wrap.style.display='block';if(btn)btn.style.display='none';
  // Другий слот відкривається порожнім у ручному режимі — показуємо поле
  // введення одразу, щоб не повторювати ту саму пастку, що й зі слотом 1.
  const v=document.getElementById('t-topic-value-2');
  const ci=document.getElementById('t-topic-2');
  if(v&&v.value==='__custom__'&&ci)ci.style.display='block';
};
window.hideSecondTopicSlot=function(){
  const wrap=document.getElementById('t-topic-slot-2-wrap');const btn=document.getElementById('btn-add-second-topic');
  if(wrap)wrap.style.display='none';if(btn)btn.style.display='block';
  const v=document.getElementById('t-topic-value-2');if(v)v.value='__custom__';
  const ci=document.getElementById('t-topic-2');if(ci)ci.value='';
  const tr=document.getElementById('t-topic-trigger-2');if(tr)tr.innerText='✏️ Власна тема';
  const d=document.getElementById('t-topic-display-2');if(d)d.style.display='none';
};
function renderTopicOptionsList(slot,topicsObj){
  const list=document.getElementById(`t-topic-list-${slot}`);
  if(!list)return;
  let html=`<div class="topic-opt topic-opt-custom" onclick="selectTopicOption(${slot},'__custom__')">✏️ Власна тема (ввести вручну)</div>`;
  const sorted=Object.entries(topicsObj).sort((a,b)=>(a[1].lessonNum||0)-(b[1].lessonNum||0));
  sorted.forEach(([id,t])=>{
    const hu=t.hoursUsed||0;
    const planned=t.plannedHours||0;
    const isCovered=hu>=planned;
    const isReused=hu>planned;          // взяли більше разів, ніж у плані
    // Кольори: зелений — не починали, жовтий — у роботі, червоний —
    // пройдено рівно за планом, БЛАКИТНИЙ — брали повторно. Червоний
    // більше не означає «не можна»: він означає «за планом уже все».
    const colorClass=isReused?'topic-opt-blue'
                    :(isCovered?'topic-opt-red':(hu>0?'topic-opt-yellow':'topic-opt-green'));
    const tag=t.tags?` [${escHtml(t.tags)}]`:'';
    const label=isReused
      ?`↻ № ${escHtml(t.lessonNum)}. ${escHtml(t.title)} — повторно (${hu}/${escHtml(planned)} год.)`
      :(isCovered
        ?`✅ № ${escHtml(t.lessonNum)}. ${escHtml(t.title)} — пройдено (${hu}/${escHtml(planned)} год.)`
        :`№ ${escHtml(t.lessonNum)}. ${escHtml(t.title)} (${hu}/${escHtml(planned)} год.${tag}, залишилось ${planned-hu})`);
    html+=`<div class="topic-opt ${colorClass}" onclick="selectTopicOption(${slot},'${id}',${isCovered})">${label}</div>`;
  });
  list.innerHTML=html;
}
export async function populateTopicSelector(){
  const cls=getActiveClass();
  const subj=document.getElementById('t-subject')?document.getElementById('t-subject').value:'';
  const statusLine=document.getElementById('topic-status-line');
  if(!document.getElementById('t-topic-list-1'))return;
  if(!subj){
    [1,2].forEach(slot=>renderTopicOptionsList(slot,{}));
    if(statusLine)statusLine.style.display='none';
    // Без предмета далі йти нема куди, але стан слотів усе одно треба
    // привести до «власна тема» — інакше в прихованому полі лишається
    // __custom__, а саме поле введення сховане, і вчитель не може ввести
    // тему вручну (саме цей випадок ловився, коли в класу немає розкладу).
    [1,2].forEach(slot=>applyTopicToSlot(slot,null));
    return;
  }
  // Спільний план: урок може називатися «Matematyka», а теми лежати під
  // «Математика». Без цього вчитель польської назви бачив би порожній
  // список тем на уроці, який насправді розписаний.
  const sk=planKey(cls, subj);
  const snap=await get(ref(db,`curriculum_plans/${cls}/${sk}/topics`));
  availableTopicsCache={};
  let totalTopics=0;let coveredTopics=0;
  if(snap.exists()){
    const topics=snap.val();
    const sorted=Object.entries(topics).sort((a,b)=>(a[1].lessonNum||0)-(b[1].lessonNum||0));
    sorted.forEach(([id,t])=>{
      availableTopicsCache[id]=t;totalTopics++;
      if((t.hoursUsed||0)>=t.plannedHours)coveredTopics++;
    });
  }
  [1,2].forEach(slot=>renderTopicOptionsList(slot,availableTopicsCache));
  if(totalTopics>0&&statusLine){
    statusLine.style.display='flex';
    document.getElementById('topic-status-text').innerText=`📚 ${subj}`;
    document.getElementById('topic-status-count').innerText=`${coveredTopics}/${totalTopics} пройдено`;
    // Обмежуємо сотнею: з повторними темами лічильник може перевищити план.
    const pct=totalTopics>0?Math.min(100,(coveredTopics/totalTopics)*100):0;
    document.getElementById('topic-progress-fill').style.width=pct+'%';
  } else if(statusLine) statusLine.style.display='none';
  await loadSavedTopicForLesson();
}
window.populateTopicSelector=populateTopicSelector;
function applyTopicToSlot(slot,entry){
  const valueInput=document.getElementById(`t-topic-value-${slot}`);
  const customInput=document.getElementById(`t-topic-${slot}`);
  const display=document.getElementById(`t-topic-display-${slot}`);
  const trigger=document.getElementById(`t-topic-trigger-${slot}`);
  if(!valueInput)return;
  if(!entry){
    valueInput.value='__custom__';if(customInput){customInput.style.display='block';customInput.value='';}
    if(trigger)trigger.innerText='✏️ Власна тема';
    if(display)display.style.display='none';
    return;
  }
  if(entry.topicId){
    const t=availableTopicsCache[entry.topicId];
    if(t){
      valueInput.value=entry.topicId;if(customInput)customInput.style.display='none';
      if(trigger)trigger.innerText=`№ ${t.lessonNum}. ${t.title} (${t.hoursUsed||0}/${t.plannedHours} год.)`;
      if(display){display.innerText=`№ ${t.lessonNum}. ${t.title}`;display.style.display='block';}
    } else {
      // Тему видалили з плану — повертаємо слот у ручний режим, інакше
      // вчитель бачить «(тема видалена)» і не має куди вписати нову.
      valueInput.value='__custom__';
      if(customInput){customInput.style.display='block';customInput.value='';}
      if(trigger)trigger.innerText='✏️ Власна тема';
      if(display){display.innerText='(тема видалена з плану)';display.style.display='block';}
    }
  } else if(entry.customText){
    valueInput.value='__custom__';if(customInput){customInput.style.display='block';customInput.value=entry.customText;}
    if(trigger)trigger.innerText='✏️ Власна тема';
    if(display){display.innerText=entry.customText;display.style.display='block';}
  }
}
async function loadSavedTopicForLesson(){
  const cls=getActiveClass();
  const subj=document.getElementById('t-subject')?document.getElementById('t-subject').value:'';
  const date=document.getElementById('global-date').value;
  if(!subj)return;
  const sk=subjKey(subj);
  const snap=await get(ref(db,`lesson_topics/${cls}/${sk}/${date}`));
  if(!document.getElementById('t-topic-list-1'))return;
  // Normalize every legacy shape (plain string / single {topicId}|{customText} record)
  // into a topics[] array of up to 2, so this reads correctly regardless of which
  // Phase wrote the record.
  let topicsArr=[];
  if(snap.exists()){
    const v=snap.val();
    if(typeof v==='string')topicsArr=[{customText:v}];
    else if(Array.isArray(v.topics))topicsArr=v.topics.slice(0,2);
    else if(v.topicId||v.customText)topicsArr=[v];
  }
  applyTopicToSlot(1,topicsArr[0]||null);
  if(topicsArr[1]){window.showSecondTopicSlot();applyTopicToSlot(2,topicsArr[1]);}
  else window.hideSecondTopicSlot();
  renderSavedTopicLine(topicsArr, date);
}

// Рядок «що збережено на цю дату».
//
// НАВІЩО ОКРЕМИЙ РЯДОК, ЯКЩО ТЕМА Й ТАК ПІДСТАВЛЯЄТЬСЯ В ПОЛЕ. Учитель
// питає не «яка тема», а «чи вона ЗБЕРЕГЛАСЯ». Поле введення на це не
// відповідає: у ньому текст виглядає однаково і до збереження, і після,
// і після того, як його просто набрали й нікуди не поділи. Тут же —
// прочитане з бази, з датою, і сумніву не лишається.
export function renderSavedTopicLine(topicsArr, date){
  const box = document.getElementById('t-topic-saved');
  if(!box) return;
  const d = String(date||'').split('-').reverse().join('.');
  const names = (topicsArr||[]).map(e => {
    if(!e) return '';
    if(e.customText) return e.customText;
    const t = availableTopicsCache[e.topicId];
    return t ? `№ ${t.lessonNum}. ${t.title}` : '(тема видалена з плану)';
  }).filter(Boolean);
  if(!names.length){
    box.className = 'topic-saved none';
    box.innerHTML = `На <b>${escHtml(d)}</b> тему ще не збережено`;
  }else{
    box.className = 'topic-saved';
    box.innerHTML = `✅ Збережено на <b>${escHtml(d)}</b>: `
      + names.map(n => `<span>${escHtml(n)}</span>`).join(' · ');
  }
  box.style.display = 'block';
}
// ═══════ Class Teacher Assignment ═══════
window.assignClassTeacher=async function(){
  const cls=document.getElementById('ct-class-select').value;
  const teacherSE=document.getElementById('ct-teacher-select').value;
  if(!cls||!teacherSE)return alert("Оберіть клас та вчителя!");
  const teacher=window.globalTeachersList.find(t=>t.safeEmail===teacherSE);
  if(!teacher)return alert("Вчителя не знайдено!");
  // Who held the post before — needed to demote them below.
  const prevSnap=await get(ref(db,`class_teachers/${cls}`));
  const prevEmail=prevSnap.exists()?(prevSnap.val().teacherEmail||''):'';
  await set(ref(db,`class_teachers/${cls}`),{
    teacherEmail:teacher.email,
    teacherName:teacher.name,
    assignedAt:localDateString,
    assignedBy:auth.currentUser.uid
  });
  // Assigning the post used to write ONLY this record — the teacher got no
  // teacher_access entry for the class and kept their old role, so on their next
  // login teacherAccessMatrix was empty and initUserSession bailed out with
  // "Класи не призначено." on a blank screen. A homeroom teacher must actually
  // have access to their own class, so grant it (only if they have nothing for
  // this class yet — never overwrite a narrower, deliberately-set subject list).
  const accSnap=await get(ref(db,`teacher_access/${teacherSE}/${cls}`));
  if(!accSnap.exists())await set(ref(db,`teacher_access/${teacherSE}/${cls}`),["Всі предмети"]);
  // Promote a plain teacher to class_teacher (both in pre_approved_roles, which
  // seeds first logins, and in any existing users/{uid} record, which is what an
  // already-registered account actually reads). Specialist roles
  // (art_school_teacher / music_teacher / director) are left untouched.
  //
  // РОЛЬ ЗМІНЮЄТЬСЯ ЛИШЕ ТУТ, у pre_approved_roles.
  //
  // Раніше код додатково писав роль просто в users/{uid} тієї людини — і
  // саме це давало PERMISSION_DENIED: правило users/$uid дозволяє запис
  // тільки власнику запису ($uid === auth.uid). Це не помилка правила, а
  // його сенс: якби директор (чи будь-хто) міг писати в чужий users, роль
  // можна було б підробити. Тому директор задає роль у списку персоналу,
  // а сам користувач підхоплює її при вході (ROLE SYNC у common.js).
  const curRoles=await get(child(ref(db),`pre_approved_roles/${teacherSE}`));
  await set(ref(db,`pre_approved_roles/${teacherSE}`),
            withTeachingRole(curRoles.exists()?curRoles.val():null,'class_teacher'));

  // Знімаємо посаду з попереднього керівника — але лише якщо він більше
  // не веде жодного іншого класу.
  if(prevEmail && prevEmail.toLowerCase() !== teacher.email.toLowerCase()){
    const ctSnap=await get(ref(db,'class_teachers'));
    const stillCT=ctSnap.exists() &&
      Object.values(ctSnap.val()).some(v=>(v.teacherEmail||'').toLowerCase()===prevEmail.toLowerCase());
    if(!stillCT){
      const prevSE=emailKey(prevEmail);
      const prevRoles=await get(child(ref(db),`pre_approved_roles/${prevSE}`));
      await set(ref(db,`pre_approved_roles/${prevSE}`),
                withTeachingRole(prevRoles.exists()?prevRoles.val():null,'teacher'));
    }
  }

  // Довідник чату оновлюємо одразу за обох: і за нового керівника, і за
  // попереднього. Інакше в батьків підпис змінився б лише після того, як
  // ці двоє наступного разу зайдуть у портал.
  await syncStaffCard(teacherSE);
  if(prevEmail) await syncStaffCard(emailKey(prevEmail));
  showToast(`✅ ${teacher.name} — кл. керівник ${cls.replace('class_','')} класу.`);
  loadClassTeacherInfo();
};
window.loadClassTeacherInfo=async function(){
  const cls=document.getElementById('ct-class-select')?.value;
  const info=document.getElementById('ct-current-info');
  const tSel=document.getElementById('ct-teacher-select');
  if(!info||!tSel)return;
  // Заповнюємо вчителів
  tSel.innerHTML='<option value="">-- Оберіть вчителя --</option>';
  window.globalTeachersList.forEach(t=>tSel.innerHTML+=`<option value="${escHtml(t.safeEmail)}">${escHtml(t.name)} (${escHtml(t.email)})</option>`);
  if(!cls){info.style.display='none';return;}
  const snap=await get(ref(db,`class_teachers/${cls}`));
  if(snap.exists()){
    const d=snap.val();
    info.innerHTML=`🎓 Поточний кл. керівник: <b>${d.teacherName}</b> <span style="color:#888;">(${d.teacherEmail})</span><br><span style="font-size:.72rem;color:#888;">з ${d.assignedAt}</span>`;
    info.style.display='block';
  } else {
    info.innerHTML=`<i style="color:#888;">Кл. керівник ще не призначений.</i>`;
    info.style.display='block';
  }
};
// ═══════ Curriculum Upload Access ═══════
// Чи є в класу розклад.
//
// НАВІЩО ПОПЕРЕДЖАТИ. План сам по собі до уроків не привʼязується — це
// список тем за предметом. Учитель бачить його тоді, коли заповнює
// журнал, а предмет на конкретний день портал бере з РОЗКЛАДУ. Немає
// розкладу — немає предмета в журналі, і список тем нема де показати.
//
// Завантажити план наперед не заважаємо: у серпні плани здають раніше,
// ніж складають розклад. Тому це попередження, а не заборона.
// ═══════ ПРЕДМЕТ ПЛАНУ ═══════
// Предмет тепер обирає людина, а не вгадує портал за назвою файлу.
//
// ЧОМУ ЦЕ ВАЖЛИВІШЕ, НІЖ ЗДАЄТЬСЯ. План зберігається за ключем предмета,
// а журнал шукає теми за назвою предмета З РОЗКЛАДУ. Якщо в плані
// «Математика», а в розкладі «Математика (алгебра)» — це різні ключі, і
// вчитель просто не побачить жодної теми. Причину знайти майже
// неможливо: помилки немає, список порожній.
//
// Тому список береться саме з розкладу класу: обрати можна лише те, що
// там справді є. Вручну вписати теж можна — на випадок, коли розкладу ще
// немає, — але тоді показуємо попередження.
export function subjectsFromSchedule(lessons){
  const out = new Set();
  Object.values(lessons || {}).forEach(day => {
    // День — це список СЛОТІВ. У слоті може стояти або один урок, або
    // МАСИВ паралельних (конструктор зберігає саме масив). Раніше тут
    // слот не розгортався, і в предметах опинявся масив, у якого немає
    // .subject — тому список предметів був порожній для всіх класів,
    // чий розклад складали в конструкторі. Старі файли розкладу
    // зберігали урок прямо в слоті, тож вони працювали, і збій виглядав
    // випадковим.
    const slots = Array.isArray(day) ? day : Object.values(day || {});
    slots.forEach(slot => {
      const items = Array.isArray(slot) ? slot : (slot && slot.subject ? [slot] : []);
      items.forEach(item => {
        // Перерви й обіди — не предмети. Ознака одна на весь застосунок:
        // isBreakItem у common.js.
        if(isBreakItem(item)) return;
        const raw = item.subject && item.subject.ua ? item.subject.ua : item.subject;
        const name = typeof raw === 'string' ? raw.trim() : '';
        if(name) out.add(name);
      });
    });
  });
  return [...out].sort((a, b) => a.localeCompare(b, 'uk'));
}

export function chosenSubject(){
  const sel = document.getElementById('curr-subject');
  if(!sel) return '';
  if(sel.value === '__other__'){
    const inp = document.getElementById('curr-subject-other');
    return inp ? inp.value.trim() : '';
  }
  return sel.value.trim();
}

let scheduleSubjects = [];

async function fillSubjectSelect(cls){
  const sel = document.getElementById('curr-subject');
  if(!sel) return;
  const keep = sel.value;
  scheduleSubjects = [];
  try{
    const snap = await get(ref(db, `schedules/${cls}`));
    if(snap.exists()) scheduleSubjects = subjectsFromSchedule((snap.val() || {}).lessons);
  }catch(e){ console.warn('schedules:', e.message); }

  // Учителю показуємо лише його предмети; директор і класний керівник
  // бачать усі предмети класу (uploadAccess.allowed === null).
  const allowed = uploadAccess.allowed;
  const list = allowed === null
    ? scheduleSubjects
    : scheduleSubjects.filter(s => subjectAllowedForUpload(s, allowed));

  sel.innerHTML = '<option value="">— оберіть предмет —</option>'
    + list.map(s => `<option value="${escHtml(s)}">${escHtml(s)}</option>`).join('')
    + '<option value="__other__">Іншого немає у списку…</option>';
  if(keep && [...sel.options].some(o => o.value === keep)) sel.value = keep;

  // Порожній список — найчастіше не помилка, а те, що розклад склали в
  // чернетці й не опублікували. Кажемо це прямо, інакше людина бачить
  // порожній вибір і не знає, куди дивитися.
  const hint = document.getElementById('curr-access-hint');
  // Рядок стану. Коли предметів немає, він одразу каже, на що дивитися:
  // чи той клас, чи прочитався розклад, чи справа в призначеннях.
  if(hint && list.length){
    hint.textContent = `Клас ${String(cls).replace('class_','')} · предметів у розкладі: `
      + `${scheduleSubjects.length}` + (allowed === null ? '' : `, доступно вам: ${list.length}`);
  }
  if(hint && !list.length){
    hint.textContent = scheduleSubjects.length
      ? 'У чинному розкладі цього класу є уроки, але жоден із предметів вам не призначено. '
        + 'Попросіть директора призначити вас на предмет.'
      : 'У чинному розкладі цього класу немає жодного уроку. Якщо ви складали розклад у '
        + 'чернетці — його треба опублікувати: кабінет директора → Розклад → Опублікувати.';
  }
  onCurrSubjectChange();
}

// Редактор плану оновлюємо ЛИШЕ коли він розгорнутий. Без цього виходив
// той самий узор, на якому портал спотикався вже двічі: людина міняє
// предмет, а на екрані лишається план попереднього. Ознака відкритості —
// видимість вузла, а не окрема змінна: так стан не може розійтися з тим,
// що людина бачить.
function refreshPlanEditorIfOpen(){
  const box=document.getElementById('plan-editor');
  if(!(box && box.offsetParent!==null && window.renderPlanEditor)) return;
  // Переставляння, яке ще не зберегли, зникне разом зі списком. Мовчки
  // викидати роботу не можна: перемкнути предмет мишею легко, а
  // відновити порядок зі 140 тем по пам'яті — ні.
  const pending = window.planOrderPending ? window.planOrderPending() : 0;
  if(pending && !confirm(`Порядок тем змінено, але не збережено (тем на нових місцях: ${pending}).\n\n`
    + 'Перехід до іншого предмета або класу поверне старий порядок.\n\nПродовжити?')) return;
  window.renderPlanEditor();
}

window.onCurrSubjectChange = function(){
  const sel = document.getElementById('curr-subject');
  const other = document.getElementById('curr-subject-other');
  const warn = document.getElementById('curr-subject-warn');
  if(other) other.style.display = (sel && sel.value === '__other__') ? 'block' : 'none';
  const subj = chosenSubject();
  refreshPlanEditorIfOpen();
  if(warn){
    // Назва не з розкладу — найчастіша причина «теми не показуються»
    const off = subj && scheduleSubjects.length
                && !scheduleSubjects.some(s => s.toLowerCase() === subj.toLowerCase());
    warn.style.display = off ? 'block' : 'none';
    if(off) warn.textContent = 'У розкладі класу такого предмета немає. План збережеться, '
      + 'але вчитель не побачить тем, доки назва не збігатиметься з розкладом рівно.';
  }
  renderAliasBox(subj);
  // Уже розібраний файл перечитуємо під новий предмет
  if(parsedCurriculum) applyChosenSubject(parsedCurriculum);
};

// ── ВИБІР СПІЛЬНОГО ПЛАНУ ───────────────────────────────────────
//
// Показуємо лише коли предмет обрано: питання «спільний план з чим»
// без предмета не має сенсу й лише додає шуму в і без того щільну картку.
function renderAliasBox(subj){
  const box  = document.getElementById('curr-alias-box');
  const sel  = document.getElementById('curr-alias');
  const note = document.getElementById('curr-alias-note');
  if(!box || !sel) return;
  if(!subj){ box.style.display = 'none'; return; }

  const cur = aliasMap[subjKey(subj)] || '';
  // У список беремо решту предметів розкладу цього класу. Себе виключаємо:
  // предмет, що вказує сам на себе, — це нескінченна петля в чистому вигляді.
  const others = scheduleSubjects.filter(s => s.toLowerCase() !== subj.toLowerCase());
  sel.innerHTML = '<option value="">— окремий власний план —</option>'
    + others.map(s => `<option value="${escHtml(s)}"${s === cur ? ' selected' : ''}>${escHtml(s)}</option>`).join('');
  // Псевдонім міг лишитися від предмета, якого в розкладі вже немає.
  // Мовчки показати «окремий план» тут не можна: план спільний і далі,
  // а людина вирішить, що ні.
  if(cur && !others.some(s => s === cur))
    sel.innerHTML += `<option value="${escHtml(cur)}" selected>${escHtml(cur)} (немає в розкладі)</option>`;

  note.textContent = cur
    ? `Теми беруться з плану предмета «${cur}». Файл, завантажений тут, ляже туди ж.`
    : 'Якщо цей самий курс є в розкладі під іншою назвою — вкажіть її, і план буде один на двох.';
  box.style.display = 'block';
}

window.saveCurrAlias = async function(){
  const sel = document.getElementById('curr-alias');
  const subj = chosenSubject();
  const cls = currClass();
  if(!sel || !subj || !cls) return;
  const target = sel.value.trim();
  const key = subjKey(subj);

  // ЗАБОРОНА ЛАНЦЮЖКІВ. Якщо предмет, на який вказують, сам кудись
  // указує, вийшло б А→Б→В: план шукали б у Б, а він там лише
  // псевдонімом. Розв'язувати ланцюжки складніше, ніж не давати їх
  // будувати, а користі від них ніякої.
  if(target && aliasMap[subjKey(target)]){
    showToast(`«${target}» сам користується чужим планом. Оберіть предмет, у якого план власний.`);
    renderAliasBox(subj);
    return;
  }

  const prev = aliasMap[key];
  if(target) aliasMap[key] = target; else delete aliasMap[key];
  renderAliasBox(subj);
  try{
    await set(ref(db, `curriculum_aliases/${cls}/${key}`), target || null);
    logAction('curriculum_alias', { cls, subject: subj, target: target || '(знято)' });
    showToast(target ? `План спільний з «${target}»` : 'Повернули власний план');
    loadCurrentCurriculumDisplay();
    refreshPlanEditorIfOpen();
  }catch(e){
    // Відкотити обов'язково: інакше на екрані спільний план, у базі —
    // ні, і наступне завантаження файлу піде не туди, куди показано.
    if(prev) aliasMap[key] = prev; else delete aliasMap[key];
    renderAliasBox(subj);
    showToast('Не вдалося зберегти: ' + e.message);
  }
};

// Проставляє обраний предмет у розібраний файл.
// Якщо аркушів кілька (старий формат із кількома предметами) — не чіпаємо:
// там предмет свій на кожному аркуші.
function applyChosenSubject(data){
  const names = Object.keys(data.sheets || {});
  const subj = chosenSubject();
  if(names.length === 1 && subj){
    data.sheets[names[0]].meta.subject = subj;
    data.sheets[names[0]].meta.subjectGuessed = false;
    data.sheets[names[0]].meta.subjectChosen = true;
  }
  renderCurriculumPreview(data);
}

async function warnIfNoSchedule(cls){
  const box = document.getElementById('curr-sched-warn');
  if(!box) return;
  box.style.display = 'none';
  if(!cls) return;
  try{
    const snap = await get(ref(db, `schedules/${cls}`));
    const v = snap.exists() ? snap.val() : null;
    const hasLessons = v && Object.values(v).some(day =>
      day && typeof day === 'object' && Object.keys(day).length);
    if(hasLessons) return;
    box.style.display = 'block';
    box.textContent = 'У цього класу ще немає розкладу. План збережеться, але вчитель '
      + 'побачить теми лише після того, як зʼявиться розклад: предмет на день портал '
      + 'бере саме звідти.';
  }catch(e){
    // Немає доступу до розкладу — не привід лякати повідомленням
    console.warn('schedules:', e.message);
  }
}

export async function checkCurriculumUploadAccess(){
  const sec=document.getElementById('curriculum-upload-section');
  if(!sec||!currentUserData)return;
  const hint=document.getElementById('curr-access-hint');
  const dirBox=document.getElementById('curr-dir-class-box');
  const role=currentUserData.role;

  // Директор: картка живе в розмітці кабінету вчителя, а його кабінет
  // прихований цілком. Раніше код ставив цій картці display:block усередині
  // невидимого екрана — тобто відкривав доступ, якого не було видно.
  // Тепер картка переїжджає до кабінету директора, у вкладку «Розклад».
  if(DIR_ROLES.includes(role)){
    const slot=document.getElementById('curr-dir-slot');
    if(!slot){
      // Слота немає — отже, у браузері стара розмітка. Мовчати не можна:
      // саме так минулого разу картка «була в коді», але її ніхто не бачив.
      console.warn('curr-dir-slot не знайдено: cabinet.html не оновлено?');
      return;
    }
    if(sec.parentElement!==slot) slot.appendChild(sec);
    if(dirBox) dirBox.style.display='block';
    // Спершу список класів, і лише потім читання плану: інакше клас ще
    // порожній, і показали б план невідомо якого класу.
    await fillDirClassSelect();
    // Псевдоніми читаємо ДО плану: інакше перше читання піде за старою
    // назвою й покаже порожньо саме там, де план якраз є.
    await loadAliases(currClass());
    uploadAccess={allowed:null,isClassTeacher:false,cls:currClass()};
    if(hint) hint.textContent='Ви можете завантажити план за будь-який клас і предмет.';
    sec.style.display='block';
    loadCurrentCurriculumDisplay();
    warnIfNoSchedule(currClass());
    fillSubjectSelect(currClass());
    return;
  }

  if(!isTeacherRole(role)){
    sec.style.display='none'; return;
  }
  if(dirBox) dirBox.style.display='none';

  const cls=getActiveClass();
  // Майстер-роль вважається класним керівником будь-якого класу — заради
  // цього вона й існує. Перевірку в базі при цьому не обходимо: правила
  // дозволяють їй запис окремо й явно.
  let isClassTeacher=isMasterTeacher(role);
  try{
    const snap=await get(ref(db,`class_teachers/${cls}`));
    isClassTeacher=isClassTeacher||(snap.exists()&&snap.val().teacherEmail===currentUserData.email);
  }catch(e){
    // Не змогли перевірити — не мовчимо. Класним керівником не вважаємо,
    // але предметний доступ нижче все одно спрацює.
    console.warn('class_teachers:', e.message);
  }

  await loadAliases(cls);
  const allowed=allowedSubjectsFor(cls, role, teacherAccessMatrix, isClassTeacher);
  uploadAccess={allowed, isClassTeacher, cls};
  // Ким людина є для ЦЬОГО класу — потрібно й іншим карткам (напр. меті
  // наліпок). Тримаємо в одному місці, щоб не питати базу двічі.
  window.__isClassTeacherOf = isClassTeacher ? cls : null;

  // Немає жодного предмета в цьому класі — картку не показуємо взагалі.
  if(allowed !== null && allowed.length===0){ sec.style.display='none'; return; }

  if(hint){
    hint.textContent = isClassTeacher
      ? 'Ви класний керівник цього класу — можете завантажити план за будь-який його предмет.'
      : 'Ваші предмети в цьому класі: ' + allowed.join(', ');
  }
  sec.style.display='block';
  loadCurrentCurriculumDisplay();
  warnIfNoSchedule(cls);
  fillSubjectSelect(cls);
}

// Список класів для директора: беремо ті, що є в розкладі/списках учнів.
async function fillDirClassSelect(){
  const sel=document.getElementById('curr-dir-class');
  if(!sel || sel.dataset.filled==='1') return;
  let classes=[];
  try{
    const snap=await get(ref(db,'students_list'));
    if(snap.exists()) classes=Object.keys(snap.val());
  }catch(e){ console.warn('students_list:', e.message); }
  if(!classes.length) classes=Array.from({length:11},(_,i)=>`class_${i+1}`);
  classes.sort((a,b)=>parseInt(a.replace('class_',''))-parseInt(b.replace('class_','')));
  sel.innerHTML=classes.map(c=>`<option value="${escHtml(c)}">${escHtml(c.replace('class_',''))} клас</option>`).join('');
  sel.dataset.filled='1';
}

// Директор змінив клас — перечитати те, що вже збережено для нового класу.
window.onCurrDirClassChange=async function(){
  const cls=currClass();
  uploadAccess.cls=cls;
  // Псевдоніми в кожного класу свої, і кеш зберігає лише один клас.
  // Без цього рядка після зміни класу шляхи рахувалися б за старими.
  await loadAliases(cls);
  loadCurrentCurriculumDisplay();
  refreshPlanEditorIfOpen();
  warnIfNoSchedule(cls);
  // ЦЬОГО РЯДКА БРАКУВАЛО. Список предметів заповнювався один раз при
  // відкритті картки — для того класу, що стояв першим. Директор обирав
  // інший клас, а перелік лишався від першого: якщо в того класу розкладу
  // немає, вибір виглядав порожнім завжди, хоч би скільки класів перебрав.
  fillSubjectSelect(cls);
  if(parsedCurriculum) renderCurriculumPreview(parsedCurriculum);
};
window.checkCurriculumUploadAccess=checkCurriculumUploadAccess;
// ═══════ Hooks ═══════
// File input handler
const currFileInput=document.getElementById('curr-file-input');
if(currFileInput) currFileInput.addEventListener('change',window.handleCurriculumFile);
// Class selector listener for director
const ctClassSelect=document.getElementById('ct-class-select');
if(ctClassSelect) ctClassSelect.addEventListener('change',window.loadClassTeacherInfo);
// Initial setup: коли директор завантажується, ініціалізуємо teacher list для кл. керівників
const _origInit=window.initUserSession;
// Замість патчити initUserSession, додаємо хук через таймаут після auth
setTimeout(()=>{
  if(currentUserData?.role==='director'&&typeof loadClassTeacherInfo==='function'){
    setTimeout(loadClassTeacherInfo,500);
  }
},1500);

// ══════════════════════════════════════════════════════════════════
//  РЕДАГУВАННЯ КАЛЕНДАРНОГО ПЛАНУ ПО ОДНІЙ ТЕМІ
// ══════════════════════════════════════════════════════════════════
//
// НАВІЩО. Досі план можна було тільки завантажити файлом цілком. Щоб
// виправити описку в назві теми чи додати забуту, доводилося правити
// Excel і заливати наново — на весь предмет. Це довго, а головне ризиковано:
// перезавантаження зачіпає всі теми предмета одразу.
//
// ЩО НЕ ЧІПАЄМО. Витрачені години (hoursUsed) редагуванню не підлягають:
// вони рахуються від реальних уроків, і правити їх руками означало б
// розсинхронити план із журналом. Змінити можна назву, кількість
// запланованих годин і склад тем.
//
// ПРАВА. Ті самі, що на завантаження плану, — картка живе всередині того
// самого блоку, який показується лише тим, кому можна.

// Куди пишемо: клас і «безпечний» ключ предмета.
function planPath(){
  const cls = currClass();
  const subj = chosenSubject();
  if(!cls || !subj) return null;
  // subjKey, а не власна копія регулярки: завантаження плану рахує ключ
  // саме нею. Дві однакові з вигляду регулярки — це те, що рано чи пізно
  // розходиться, і тоді редактор писав би в сусідній вузол, а вчитель
  // бачив би, що правки «не зберігаються».
  return { cls, subj, sk: planKey(cls, subj) };
}

export async function renderPlanEditor(){
  const box = document.getElementById('plan-editor');
  if(!box) return;
  const p = planPath();
  if(!p){ box.innerHTML = '<p class="empty-msg">Спершу оберіть клас і предмет вище.</p>'; return; }
  box.innerHTML = '<p class="empty-msg">Завантаження...</p>';
  try{
    const snap = await get(ref(db, `curriculum_plans/${p.cls}/${p.sk}/topics`));
    const topics = snap.exists() ? (snap.val() || {}) : {};
    const rows = Object.entries(topics)
      .sort((a,b) => (a[1].lessonNum||0) - (b[1].lessonNum||0));

    box.innerHTML = `
      <div class="pe-head">${escHtml(p.subj)} · ${escHtml(String(p.cls).replace('class_',''))} клас
        <span>${rows.length} тем</span></div>
      ${rows.length ? `<div class="pe-list" id="pe-list">` + rows.map(([id,t]) => {
        const hu = t.hoursUsed || 0;
        const num = t.lessonNum || 0, ph = t.plannedHours || 1;
        // data-orig-*: те, що зараз у базі. Потрібне, щоб відрізнити
        // незбережену правку від збереженої перед тим, як перенос
        // перемалює список (інакше правка тихо зникне).
        return `
        <div class="pe-row" id="pe-${escHtml(id)}" data-id="${escHtml(id)}"
             data-orig-num="${escHtml(num)}" data-orig-title="${escHtml(t.title||'')}"
             data-orig-hours="${escHtml(ph)}">
          <span class="pe-grip" aria-hidden="true" title="Перетягніть, щоб змінити порядок">⠿</span>
          <input type="number" class="pe-num" value="${escHtml(num)}" min="1" title="№ уроку">
          <input type="text" class="pe-title" value="${escHtml(t.title||'')}" placeholder="Назва теми">
          <input type="number" class="pe-hours" value="${escHtml(ph)}" min="1" title="Годин за планом">
          <span class="pe-used" title="Витрачено — рахується від уроків, вручну не змінюється">${hu} вик.</span>
          <button type="button" class="pe-save" onclick="savePlanTopic('${escJs(id)}')">💾</button>
          <button type="button" class="pe-del" onclick="deletePlanTopic('${escJs(id)}','${escJs(t.title||'')}',${hu})">✕</button>
        </div>`;
      }).join('') + `</div>` : '<p class="empty-msg">У цього предмета ще немає плану. Завантажте файл вище.</p>'}
      <div class="pe-bar" id="pe-bar" hidden>
        <span id="pe-bar-txt"></span>
        <button type="button" class="pe-bar-save" onclick="savePlanOrder()">💾 Зберегти порядок</button>
        <button type="button" class="pe-bar-undo" onclick="cancelPlanOrder()">↩ Скасувати</button>
      </div>
      <div class="pe-add">
        <input type="number" id="pe-new-num" placeholder="№" min="1" style="width:70px;">
        <input type="text" id="pe-new-title" placeholder="Назва нової теми">
        <input type="number" id="pe-new-hours" placeholder="год." min="1" value="1" style="width:70px;">
        <button type="button" onclick="addPlanTopic()">➕ Додати</button>
      </div>
      <p class="pe-hint">«вик.» — скільки годин теми вже відпрацьовано на уроках.
         Це рахується автоматично й редагуванню не підлягає.<br>
         ⠿ — потягніть за цей значок, щоб посунути тему вище або нижче.
         Номери уроків лишаються на своїх місцях: міняється те, яка тема
         на якому уроці. <b>Само нічого не зберігається</b> — після
         переставляння внизу з'явиться кнопка «Зберегти порядок», поруч
         з нею «Скасувати». Якщо перетягувати незручно, той самий
         результат дає зміна № вручну і 💾 в рядку.</p>`;
    planOrderSnapshot();
  }catch(e){
    console.error('Редактор плану:', e);
    box.innerHTML = `<p class="empty-msg" style="color:var(--red);">Не вдалося завантажити: ${escHtml(e.message||'')}</p>`;
  }
}
window.renderPlanEditor = renderPlanEditor;

// ══════════════════════════════════════════════════════════════════
//  ПЕРЕСТАВЛЯННЯ ТЕМ ПЕРЕТЯГУВАННЯМ
// ══════════════════════════════════════════════════════════════════
//
// ЩО САМЕ РУХАЄТЬСЯ. Не номери уроків, а теми між ними. Послідовність
// номерів лишається такою, якою була: якщо в плані є два записи на урок
// № 7, після переставляння їх так само буде два. Тема, яку перетягнули,
// отримує номер того місця, куди її поклали, а теми між старим і новим
// місцем зсуваються на одну позицію.
//
// НІЧОГО НЕ ЗБЕРІГАЄТЬСЯ САМО. Перетягування лише готує новий порядок;
// у базу він потрапляє тільки після натискання «Зберегти порядок».
// Поки не натиснули — унизу списку висить смужка з кнопкою «Скасувати»,
// яка повертає все як було. Помилитися мишею на списку зі 140 тем надто
// легко, щоб кожен зрив пальця одразу переписував план.
//
// ЩО ВИДНО ПІД ЧАС ПЕРЕТЯГУВАННЯ:
//   • копія рядка їде за пальцем (не сам рядок — його палець накриває);
//   • на місці, куди тема ляже, лишається пунктирна рамка;
//   • номери в списку одразу перераховуються, тож видно результат.
//
// ЧОМУ НЕ HTML5 drag-and-drop. Він не працює на сенсорних екранах, а
// портал відкривають переважно з телефона. Pointer Events — одні й ті
// самі для миші, пальця й стилуса.

let peDrag = null;        // стан поточного перетягування
let peScroll = null;      // таймер автопрокрутки біля краю екрана
let peBase = null;        // {ids, nums} — порядок і номери, які лежать у базі

function peRows(list){ return Array.from(list.querySelectorAll('.pe-row')); }
function peList(){ return document.getElementById('pe-list'); }

// Викликається наприкінці малювання списку: запам'ятовуємо те, що в базі.
// Від цього знімка рахується і «що змінилося», і «скасувати».
function planOrderSnapshot(){
  const list = peList();
  if(!list){ peBase = null; return; }
  const rows = peRows(list);
  peBase = {
    ids:  rows.map(r => r.dataset.id),
    nums: rows.map(r => parseInt(r.dataset.origNum, 10) || 0)
  };
  list.addEventListener('pointerdown', peDown);
  peRefreshBar();
}

// Чи є непідтверджене переставляння. Читають і смужка, і перемикання класу.
export function planOrderPending(){
  const list = peList();
  if(!list || !peBase) return 0;
  const ids = peRows(list).map(r => r.dataset.id);
  let n = 0;
  ids.forEach((id, i) => { if(id !== peBase.ids[i]) n++; });
  return n;
}
window.planOrderPending = planOrderPending;

// Перерахувати номери за поточним порядком і показати/сховати смужку.
// Номери переписуємо одразу: інакше після переставляння в стовпчику «№»
// стояло б 1, 2, 4, 3 — і вчитель не зрозумів би, що саме збережеться.
function peApplyPending(){
  const list = peList();
  if(!list || !peBase) return;
  peRows(list).forEach((r, i) => {
    const want = peBase.nums[i];
    const inp = r.querySelector('.pe-num');
    if(!inp) return;
    if(String(want) !== inp.value) inp.value = want;
    inp.classList.toggle('pe-changed', String(want) !== r.dataset.origNum);
  });
  peRefreshBar();
}

function peRefreshBar(){
  const bar = document.getElementById('pe-bar');
  if(!bar) return;
  const n = planOrderPending();
  bar.hidden = !n;
  const txt = document.getElementById('pe-bar-txt');
  if(txt) txt.textContent = n
    ? `Порядок змінено: тем на нових місцях — ${n}. У базі поки що старий.`
    : '';
}

// Повернути список у той вигляд, який лежить у базі.
window.cancelPlanOrder = function(){
  const list = peList();
  if(!list || !peBase) return;
  const byId = new Map(peRows(list).map(r => [r.dataset.id, r]));
  peBase.ids.forEach(id => { const r = byId.get(id); if(r) list.appendChild(r); });
  peRows(list).forEach(r => {
    const inp = r.querySelector('.pe-num');
    if(inp){ inp.value = r.dataset.origNum; inp.classList.remove('pe-changed'); }
  });
  peRefreshBar();
};

// ── сам жест ──

function peDown(e){
  const grip = e.target.closest && e.target.closest('.pe-grip');
  if(!grip) return;
  if(e.pointerType === 'mouse' && e.button !== 0) return;
  const row  = grip.closest('.pe-row');
  const list = e.currentTarget;
  if(!row || !list || peDrag) return;
  e.preventDefault();
  clearInterval(peScroll); peScroll = null;   // хвіст від обірваного жесту

  const rect = row.getBoundingClientRect();
  peDrag = {
    row, list,
    ids0: peRows(list).map(r => r.dataset.id),   // для скасування самого жесту
    moved: false,
    pid: e.pointerId,
    dx: e.clientX - rect.left,
    dy: e.clientY - rect.top,
    ghost: peMakeGhost(row, rect)
  };
  // Оригінал лишається в списку й далі рухається — але вже як порожня
  // пунктирна рамка. Це і є відповідь на «куди я це тягну».
  row.classList.add('pe-slot');
  list.classList.add('pe-moving');

  // Захоплюємо вказівник списком, а не ручкою: ручка їде разом із рядком,
  // а переміщення вузла в DOM браузер вважає видаленням і захоплення
  // знімає — палець «зривався» б з теми на першому ж кроці.
  try{ list.setPointerCapture(e.pointerId); }catch(_){}
  list.addEventListener('pointermove',   peMove);
  list.addEventListener('pointerup',     peUp);
  list.addEventListener('pointercancel', peCancelGesture);
  window.addEventListener('pointerup',   peUp);   // якщо захоплення загубиться

  peScroll = setInterval(() => {
    if(!peDrag || peDrag.lastY == null) return;
    const y = peDrag.lastY, h = window.innerHeight;
    const was = window.scrollY;
    if(y < 90)        window.scrollBy(0, -12);
    else if(y > h-90) window.scrollBy(0,  12);
    if(window.scrollY !== was) peReposition(peDrag.lastX, y);
  }, 16);
}

// Копія рядка, що їде за пальцем. Сам рядок тягнути не можна: палець
// його накриває, і людина не бачить, що саме несе.
function peMakeGhost(row, rect){
  const g = row.cloneNode(true);
  // У клоні значення полів беруться з атрибутів, а не з того, що зараз
  // на екрані. Переносимо вручну, інакше в копії була б стара назва.
  const src = row.querySelectorAll('input'), dst = g.querySelectorAll('input');
  src.forEach((el, i) => { if(dst[i]) dst[i].value = el.value; });
  g.classList.add('pe-ghost');
  g.classList.remove('pe-slot');
  g.style.width = rect.width + 'px';
  g.style.left  = rect.left + 'px';
  g.style.top   = rect.top + 'px';
  document.body.appendChild(g);
  return g;
}

// Куди покласти рамку при поточному положенні вказівника.
function peReposition(x, y){
  if(!peDrag || x == null || y == null) return;
  const el = document.elementFromPoint(x, y);   // привид не заважає: pointer-events:none
  const over = el && el.closest ? el.closest('.pe-row') : null;
  if(!over || over === peDrag.row || over.parentNode !== peDrag.list) return;
  const r = over.getBoundingClientRect();
  peDrag.list.insertBefore(peDrag.row, (y < r.top + r.height / 2) ? over : over.nextSibling);
  peDrag.moved = true;
}

function peMove(e){
  if(!peDrag) return;
  e.preventDefault();
  peDrag.lastX = e.clientX;
  peDrag.lastY = e.clientY;
  if(peDrag.ghost){
    peDrag.ghost.style.left = (e.clientX - peDrag.dx) + 'px';
    peDrag.ghost.style.top  = (e.clientY - peDrag.dy) + 'px';
  }
  peReposition(e.clientX, e.clientY);
}

// Прибрати слухачі, захоплення, таймер і привида. Повертає стан жесту.
function peFinish(){
  const st = peDrag;
  if(!st) return null;
  const { row, list, pid, ghost } = st;
  list.removeEventListener('pointermove',   peMove);
  list.removeEventListener('pointerup',     peUp);
  list.removeEventListener('pointercancel', peCancelGesture);
  window.removeEventListener('pointerup',   peUp);
  try{ if(list.hasPointerCapture(pid)) list.releasePointerCapture(pid); }catch(_){}
  clearInterval(peScroll); peScroll = null;
  if(ghost) ghost.remove();
  row.classList.remove('pe-slot');
  list.classList.remove('pe-moving');
  peDrag = null;
  return st;
}

// Жест перервала система — вхідний дзвінок, перемикання застосунку.
// Людина нічого не клала, тож повертаємо рядок туди, звідки взяли.
function peCancelGesture(){
  const st = peFinish();
  if(!st || !st.moved) return;
  const byId = new Map(peRows(st.list).map(r => [r.dataset.id, r]));
  st.ids0.forEach(id => { const r = byId.get(id); if(r) st.list.appendChild(r); });
}

function peUp(){
  const st = peFinish();
  if(!st || !st.moved) return;
  if(!st.list.isConnected) return;   // список перемалювали просто під час жесту
  peApplyPending();                  // тільки перерахунок на екрані — не запис
}

// ══════════════════════════════════════════════════════════════════
//  ЗБЕРЕЖЕННЯ НОВОГО ПОРЯДКУ
// ══════════════════════════════════════════════════════════════════

// Чистий перерахунок: що саме треба записати, щоб теми стали в новому
// порядку. Винесено окремо й покрито тестами, бо помилка тут зіпсувала б
// нумерацію всього предмета одним записом, а перевірити її на око в
// списку зі 140 тем неможливо.
//
//   ids0, nums0 — порядок і номери до переставляння (номер nums0[i]
//                 належить темі ids0[i]);
//   ids1        — порядок після.
// Номери лишаються на своїх позиціях: тема, що стала i-ю, дістає nums0[i].
export function reorderTopicNums(ids0, nums0, ids1){
  const was = {};
  ids0.forEach((id,i) => { was[id] = nums0[i]; });
  const updates = {};
  ids1.forEach((id,i) => {
    if(was[id] !== nums0[i]) updates[`${id}/lessonNum`] = nums0[i];
  });
  return updates;
}

// Скільки рядків людина змінила руками й не зберегла кнопкою 💾 у рядку.
// Числа порівнюємо числами: «2» і 2 — те саме значення, і попереджати
// через таку різницю означало б привчити тиснути «Так» не читаючи.
// Поле «№» пропускаємо: його переписує саме переставляння.
function peHandEdits(list){
  return peRows(list).filter(r =>
       r.querySelector('.pe-title').value !== r.dataset.origTitle
    || Number(r.querySelector('.pe-hours').value) !== Number(r.dataset.origHours)
  ).length;
}

window.savePlanOrder = async function(){
  const list = peList();
  const p = planPath();
  if(!list || !peBase || !p) return;
  const ids1 = peRows(list).map(r => r.dataset.id);
  const updates = reorderTopicNums(peBase.ids, peBase.nums, ids1);

  // Порядок на екрані змінився, а писати нічого — значить теми, які
  // помінялися місцями, стоять під одним номером уроку. Між рівними
  // номерами порядок задає база, і зберегти його ніде. Мовчати тут не
  // можна: інакше вчитель побачив би переставлені рядки, які після
  // оновлення сторінки повернуться назад.
  if(!Object.keys(updates).length){
    window.cancelPlanOrder();
    return showToast('ℹ️ У цих тем однаковий № уроку — порядок між ними не зберігається');
  }

  const hand = peHandEdits(list);
  if(hand && !confirm(`У списку є незбережені правки назв або годин (рядків: ${hand}).\n\n`
    + 'Збереження порядку перечитає список із бази, і ці правки зникнуть.\n'
    + 'Спершу збережіть їх кнопкою 💾 у самому рядку.\n\nВсе одно зберегти порядок?')) return;

  list.classList.add('pe-busy');
  try{
    await update(ref(db, `curriculum_plans/${p.cls}/${p.sk}/topics`), updates);
    // У журнал пишемо не лише кількість, а й межі зачепленого проміжку.
    // Запис «змінено порядок тем (3)» через півроку не дасть відповіді на
    // питання «що саме поїхало»; «уроки 12–14» — дає.
    const touched = Object.values(updates).sort((a,b) => a - b);
    logAction('curriculum', { cls:p.cls, subject:p.subj,
      value:`змінено порядок тем: уроки ${touched[0]}–${touched[touched.length-1]}`
            + ` (${touched.length})` });
    showToast('✅ Порядок збережено');
    renderPlanEditor();
    if(window.populateTopicSelector) window.populateTopicSelector();
  }catch(err){
    // Не залишаємо на екрані порядок, якого немає в базі: інакше вчитель
    // піде далі в переконанні, що зміни лягли.
    alert('Не вдалося зберегти порядок: ' + err.message);
    window.cancelPlanOrder();
  }finally{
    list.classList.remove('pe-busy');
  }
};

// Чи є вже тема з таким номером уроку. Не забороняємо — попереджаємо:
// у плані буває два записи на один урок, і рішення тут за вчителем.
// Але мовчки плодити однакові номери теж не можна: список сортується
// саме за ними, і два «№ 3» виглядають як помилка портала.
async function warnDuplicateNum(p, lessonNum, exceptId){
  try{
    const snap = await get(ref(db, `curriculum_plans/${p.cls}/${p.sk}/topics`));
    const all = snap.exists() ? (snap.val() || {}) : {};
    const clash = Object.entries(all)
      .filter(([id,t]) => id !== exceptId && (t.lessonNum|0) === (lessonNum|0))
      .map(([,t]) => t.title);
    if(!clash.length) return true;
    return confirm(`Урок № ${lessonNum} уже зайнятий темою «${clash[0]}».\n\n`
      + 'Це буває, коли на один урок припадає дві теми. Продовжити?');
  }catch(e){ return true; }   // не змогли перевірити — не заважаємо працювати
}

window.savePlanTopic = async function(id){
  const p = planPath(); if(!p) return;
  const row = document.getElementById('pe-' + id); if(!row) return;
  const title = row.querySelector('.pe-title').value.trim();
  // Обмежуємо знизу. HTML min="1" підказує, але не заважає ввести -5
  // вручну чи вставити з буфера, а від'ємні години ламають і сортування,
  // і смужку прогресу.
  const lessonNum = Math.max(1, parseInt(row.querySelector('.pe-num').value, 10) || 1);
  const plannedHours = Math.max(1, parseInt(row.querySelector('.pe-hours').value, 10) || 1);
  if(!title) return showToast('⚠️ Назва теми не може бути порожньою');
  if(!await warnDuplicateNum(p, lessonNum, id)) return;
  try{
    // update, а не set: hoursUsed лишається таким, яким його порахували уроки.
    await update(ref(db, `curriculum_plans/${p.cls}/${p.sk}/topics/${id}`),
      { title, lessonNum, plannedHours });
    logAction('curriculum', { cls:p.cls, subject:p.subj, value:`правка теми: ${title}` });
    showToast('✅ Тему збережено');
    renderPlanEditor();
    if(window.populateTopicSelector) window.populateTopicSelector();
  }catch(e){ alert('Не вдалося зберегти: ' + e.message); }
};

window.deletePlanTopic = async function(id, title, hoursUsed){
  const p = planPath(); if(!p) return;
  // Тема з відпрацьованими годинами — це вже частина історії уроків.
  // Попереджаємо окремо: після видалення теми уроки, де вона стояла,
  // лишаться без назви теми.
  const warn = hoursUsed > 0
    ? `\n\nУВАГА: за цією темою вже відпрацьовано ${hoursUsed} год. Уроки, `
      + `де вона вказана, лишаться без теми.`
    : '';
  if(!confirm(`Видалити тему «${title}»?${warn}`)) return;
  try{
    await remove(ref(db, `curriculum_plans/${p.cls}/${p.sk}/topics/${id}`));
    logAction('curriculum', { cls:p.cls, subject:p.subj, value:`видалено тему: ${title}` });
    showToast('🗑️ Тему видалено');
    renderPlanEditor();
    if(window.populateTopicSelector) window.populateTopicSelector();
  }catch(e){ alert('Не вдалося видалити: ' + e.message); }
};

window.addPlanTopic = async function(){
  const p = planPath(); if(!p) return;
  const title = document.getElementById('pe-new-title').value.trim();
  const lessonNum = Math.max(0, parseInt(document.getElementById('pe-new-num').value, 10) || 0);
  const plannedHours = Math.max(1, parseInt(document.getElementById('pe-new-hours').value, 10) || 1);
  if(!title) return showToast('⚠️ Введіть назву теми');
  if(!lessonNum) return showToast('⚠️ Вкажіть номер уроку');
  if(!await warnDuplicateNum(p, lessonNum, null)) return;
  try{
    // Ключ у тому ж вигляді, що й у завантаженні файлу, — щоб теми з
    // обох джерел виглядали однаково й сортувалися разом.
    const id = `t_${lessonNum}_${Date.now().toString(36)}`;
    await set(ref(db, `curriculum_plans/${p.cls}/${p.sk}/topics/${id}`),
      { title, lessonNum, plannedHours, hoursUsed: 0 });
    logAction('curriculum', { cls:p.cls, subject:p.subj, value:`додано тему: ${title}` });
    showToast('✅ Тему додано');
    document.getElementById('pe-new-title').value = '';
    document.getElementById('pe-new-num').value = '';
    renderPlanEditor();
    if(window.populateTopicSelector) window.populateTopicSelector();
  }catch(e){ alert('Не вдалося додати: ' + e.message); }
};
