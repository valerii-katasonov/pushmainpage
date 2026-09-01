// ═══════════════════════════════════════════════════════════════
// curriculum.js — the whole "CURRICULUM MODULE (v3)" block, moved
// here verbatim from the bottom of the original file: Excel plan
// upload/parsing, the topic selector used by teacher.js's journal
// filling, and Class Teacher Assignment (director-screen UI, but
// kept together with the rest of this module exactly as it was
// physically grouped in the original script).
// XLSX comes from the CDN <script> tag already in <head> (global).
// ═══════════════════════════════════════════════════════════════
import { ref, set, get, child, update } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, auth, getActiveClass, currentUserData, showToast, localDateString, escHtml, teacherAccessMatrix, withTeachingRole, syncStaffCard, isBreakItem } from './common.js';

let parsedCurriculum=null;        // після парсингу xlsx
const MAX_TOPICS=250;             // стеля на предмет: захист від зіпсованого файлу
// availableTopicsCache is reassigned only here (populateTopicSelector)
// and read (property access) from teacher.js (saveTopicAndHW) — plain
// export/import.
export let availableTopicsCache={};
let currentClassTeacherEmail=null;
// Helper: безпечний ключ предмету
window.subjKey=function(s){return (s||'').replace(/[.#$[\]/]/g,'_').trim();};
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

// Чи це рядок заголовка простого бланка
function isSimpleHeader(r){
  if(!r) return false;
  const a = String(r[0] || '').toLowerCase();
  const b = String(r[1] || '').toLowerCase();
  return a.includes('уроку') && b.includes('тема');
}

export function parseSimplePlan(rows){
  let head = -1;
  for(let i = 0; i < rows.length; i++){
    if(isSimpleHeader(rows[i])){ head = i; break; }
  }
  if(head < 0) return null;

  const topics = [];
  for(let i = head + 1; i < rows.length; i++){
    const r = rows[i] || [];
    const title = String(r[1] == null ? '' : r[1]).trim();
    // Порожній рядок — кінець таблиці. Далі в бланку йдуть пояснення
    // й приклад із таким самим заголовком; читати їх не можна.
    if(!title) break;
    const range = parseLessonRange(r[0]);
    const hoursCell = Number(String(r[2] == null ? '' : r[2]).replace(',', '.'));
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

    const meta={};let dataStartRow=0;
    for(let i=0;i<rows.length;i++){
      const r=rows[i];if(!r||!r[0])continue;
      const key=String(r[0]).trim().replace(/:$/,'');
      if(key==='Розділ / блок'){dataStartRow=i+1;break;}
      if(r[1]!==null&&r[1]!==undefined)meta[key]=r[1];
    }
    const topics=[];
    for(let i=dataStartRow;i<rows.length;i++){
      const r=rows[i];if(!r||!r[2])continue;
      topics.push({
        section:r[0]?String(r[0]).trim():'',
        lessonNum:r[1]?parseInt(r[1]):(topics.length+1),
        title:String(r[2]).trim(),
        plannedDate:excelDateToISO(r[3]),
        plannedHours:r[4]?parseInt(r[4]):1,
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
      const sk=window.subjKey(s.meta.subject);
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
      // Зберігаємо існуючі hoursUsed якщо план перезавантажують
      const existSnap=await get(ref(db,`curriculum_plans/${cls}/${sk}/topics`));
      const existing=existSnap.exists()?existSnap.val():{};
      const existByLesson={};
      for(let id in existing) existByLesson[existing[id].lessonNum]={id,hoursUsed:existing[id].hoursUsed||0};
      const newTopics={};
      topicsToSave.forEach((t,idx)=>{
        const id=`t_${t.lessonNum}_${idx}`;
        const prevHU=existByLesson[t.lessonNum]?.hoursUsed||0;
        newTopics[id]={...t,hoursUsed:Math.min(prevHU,t.plannedHours)};
      });
      await set(ref(db,`curriculum_plans/${cls}/${sk}/topics`),newTopics);
    }
    showToast(trimmedWarnings.length>0
      ?`✅ План збережено! ⚠️ Перевищено ліміт ${MAX_TOPICS} тем на предмет — не поміщено: ${trimmedWarnings.join(', ')}`
      :"✅ Календарне планування збережено!");
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
window.selectTopicOption=function(slot,value,disabled){
  if(disabled){showToast('⚠️ Усі години цієї теми вже використано!');return;}
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
    const isCovered=hu>=t.plannedHours;
    // Phase 6 color rule: green = untouched, yellow = partially used, red = fully used
    const colorClass=isCovered?'topic-opt-red':(hu>0?'topic-opt-yellow':'topic-opt-green');
    const tag=t.tags?` [${escHtml(t.tags)}]`:'';
    const label=isCovered
      ?`✅ № ${escHtml(t.lessonNum)}. ${escHtml(t.title)} — пройдено (${hu}/${escHtml(t.plannedHours)} год.)`
      :`№ ${escHtml(t.lessonNum)}. ${escHtml(t.title)} (${hu}/${escHtml(t.plannedHours)} год.${tag}, залишилось ${t.plannedHours-hu})`;
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
  const sk=window.subjKey(subj);
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
    const pct=totalTopics>0?(coveredTopics/totalTopics)*100:0;
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
  const sk=window.subjKey(subj);
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
      const prevSE=prevEmail.replace(/\./g,'_');
      const prevRoles=await get(child(ref(db),`pre_approved_roles/${prevSE}`));
      await set(ref(db,`pre_approved_roles/${prevSE}`),
                withTeachingRole(prevRoles.exists()?prevRoles.val():null,'teacher'));
    }
  }

  // Довідник чату оновлюємо одразу за обох: і за нового керівника, і за
  // попереднього. Інакше в батьків підпис змінився б лише після того, як
  // ці двоє наступного разу зайдуть у портал.
  await syncStaffCard(teacherSE);
  if(prevEmail) await syncStaffCard(prevEmail.replace(/\./g,'_'));
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
  if(hint && !list.length){
    hint.textContent = scheduleSubjects.length
      ? 'У чинному розкладі цього класу є уроки, але жоден із предметів вам не призначено. '
        + 'Попросіть директора призначити вас на предмет.'
      : 'У чинному розкладі цього класу немає жодного уроку. Якщо ви складали розклад у '
        + 'чернетці — його треба опублікувати: кабінет директора → Розклад → Опублікувати.';
  }
  onCurrSubjectChange();
}

window.onCurrSubjectChange = function(){
  const sel = document.getElementById('curr-subject');
  const other = document.getElementById('curr-subject-other');
  const warn = document.getElementById('curr-subject-warn');
  if(other) other.style.display = (sel && sel.value === '__other__') ? 'block' : 'none';
  const subj = chosenSubject();
  if(warn){
    // Назва не з розкладу — найчастіша причина «теми не показуються»
    const off = subj && scheduleSubjects.length
                && !scheduleSubjects.some(s => s.toLowerCase() === subj.toLowerCase());
    warn.style.display = off ? 'block' : 'none';
    if(off) warn.textContent = 'У розкладі класу такого предмета немає. План збережеться, '
      + 'але вчитель не побачить тем, доки назва не збігатиметься з розкладом рівно.';
  }
  // Уже розібраний файл перечитуємо під новий предмет
  if(parsedCurriculum) applyChosenSubject(parsedCurriculum);
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
    uploadAccess={allowed:null,isClassTeacher:false,cls:currClass()};
    if(hint) hint.textContent='Ви можете завантажити план за будь-який клас і предмет.';
    sec.style.display='block';
    loadCurrentCurriculumDisplay();
    warnIfNoSchedule(currClass());
    fillSubjectSelect(currClass());
    return;
  }

  if(!['teacher','class_teacher','art_school_teacher','music_teacher'].includes(role)){
    sec.style.display='none'; return;
  }
  if(dirBox) dirBox.style.display='none';

  const cls=getActiveClass();
  let isClassTeacher=false;
  try{
    const snap=await get(ref(db,`class_teachers/${cls}`));
    isClassTeacher=snap.exists()&&snap.val().teacherEmail===currentUserData.email;
  }catch(e){
    // Не змогли перевірити — не мовчимо. Класним керівником не вважаємо,
    // але предметний доступ нижче все одно спрацює.
    console.warn('class_teachers:', e.message);
  }

  const allowed=allowedSubjectsFor(cls, role, teacherAccessMatrix, isClassTeacher);
  uploadAccess={allowed, isClassTeacher, cls};

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
window.onCurrDirClassChange=function(){
  uploadAccess.cls=currClass();
  loadCurrentCurriculumDisplay();
  warnIfNoSchedule(currClass());
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
