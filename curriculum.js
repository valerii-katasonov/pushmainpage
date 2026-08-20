// ═══════════════════════════════════════════════════════════════
// curriculum.js — the whole "CURRICULUM MODULE (v3)" block, moved
// here verbatim from the bottom of the original file: Excel plan
// upload/parsing, the topic selector used by teacher.js's journal
// filling, and Class Teacher Assignment (director-screen UI, but
// kept together with the rest of this module exactly as it was
// physically grouped in the original script).
// XLSX comes from the CDN <script> tag already in <head> (global).
// ═══════════════════════════════════════════════════════════════
import { ref, set, get, update } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, auth, getActiveClass, currentUserData, showToast, localDateString, escHtml } from './common.js';

let parsedCurriculum=null;        // після парсингу xlsx
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
// ═══════ Парсер Excel ═══════
window.handleCurriculumFile=function(e){
  const file=e.target.files[0];if(!file)return;
  const dropEl=document.getElementById('curr-drop-zone-label');
  const txtEl=document.getElementById('curr-drop-text');
  txtEl.innerText=`📄 ${file.name}`;
  dropEl.classList.add('has-file');
  const reader=new FileReader();
  reader.onload=function(evt){
    try{
      const wb=XLSX.read(evt.target.result,{type:'array',cellDates:true});
      parsedCurriculum=parseCurriculumWorkbook(wb);
      renderCurriculumPreview(parsedCurriculum);
    }catch(err){alert("Помилка парсингу: "+err.message);console.error(err);}
  };
  reader.readAsArrayBuffer(file);
};
function parseCurriculumWorkbook(wb){
  const result={sheets:{}};
  wb.SheetNames.forEach(sheetName=>{
    const sheet=wb.Sheets[sheetName];
    const rows=XLSX.utils.sheet_to_json(sheet,{header:1,defval:null});
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
          language:meta['Мова викладання']||''
        },
        topics:topics
      };
    }
  });
  return result;
}
function renderCurriculumPreview(data){
  const container=document.getElementById('curr-preview-content');
  const classSpan=document.getElementById('curr-preview-class');
  const cls=getActiveClass();
  classSpan.innerText=`→ ${cls.replace('class_','')} клас`;
  let html='';
  for(let sheetName in data.sheets){
    const s=data.sheets[sheetName];
    html+=`<div class="topic-preview"><div class="topic-preview-subj">📚 ${s.meta.subject} (${s.topics.length} тем) <span style="font-size:.72rem;color:#888;font-weight:400;">— ${s.meta.year}, ${s.meta.teacher}</span></div>`;
    s.topics.forEach(t=>{
      html+=`<div class="topic-preview-row"><span class="num">${escHtml(t.lessonNum)}</span><span><b>${escHtml(t.title)}</b><br><span style="color:#888;font-size:.7rem;">${escHtml(t.section)}${t.tags?' · '+escHtml(t.tags):''}</span></span><span class="hrs">${escHtml(t.plannedDate||'—')}</span><span class="hrs">${escHtml(t.plannedHours)} год.</span></div>`;
    });
    html+=`</div>`;
  }
  container.innerHTML=html;
  document.getElementById('curr-preview-section').style.display='block';
}
window.saveCurriculumToDb=async function(){
  if(!parsedCurriculum)return alert("Спочатку завантажте файл!");
  const cls=getActiveClass();
  const btn=document.getElementById('btn-save-curr');
  btn.disabled=true;btn.innerText="⏳ Збереження...";
  try{
    // Phase 6: ліміт 5 тем на рік. saveCurriculumToDb() завжди робить повний
    // set() всього /topics (заміна, не додавання) — тож "поточна кількість тем"
    // до завантаження не підсумовується з новими, а просто замінюється ними.
    // Тому ліміт застосовуємо до самого завантаженого списку: перші 5 зберігаємо,
    // решту відкидаємо з попередженням у toast скільки тем не поміщено.
    let trimmedWarnings=[];
    for(let sheetName in parsedCurriculum.sheets){
      const s=parsedCurriculum.sheets[sheetName];
      const sk=window.subjKey(s.meta.subject);
      let topicsToSave=s.topics;
      if(topicsToSave.length>5){
        const cut=topicsToSave.length-5;
        topicsToSave=topicsToSave.slice(0,5);
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
      ?`✅ План збережено! ⚠️ Ліміт 5 тем/рік — не поміщено: ${trimmedWarnings.join(', ')}`
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
  const cls=getActiveClass();
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
  await set(ref(db,`pre_approved_roles/${teacherSE}`),'class_teacher');
  const usersSnap=await get(ref(db,'users'));
  if(usersSnap.exists()){
    const u=usersSnap.val();
    for(let uid in u){
      const email=(u[uid].email||'').toLowerCase();
      if(email===teacher.email.toLowerCase()&&u[uid].role==='teacher'){
        await update(ref(db,`users/${uid}`),{role:'class_teacher'});
      }
      // Demote the previous holder back to plain teacher — but only if they're
      // not still class teacher of some OTHER class.
      if(prevEmail&&email===prevEmail.toLowerCase()&&email!==teacher.email.toLowerCase()&&u[uid].role==='class_teacher'){
        const ctSnap=await get(ref(db,'class_teachers'));
        const stillCT=ctSnap.exists()&&Object.values(ctSnap.val()).some(v=>(v.teacherEmail||'').toLowerCase()===email);
        if(!stillCT){
          await update(ref(db,`users/${uid}`),{role:'teacher'});
          await set(ref(db,`pre_approved_roles/${prevEmail.replace(/\./g,'_')}`),'teacher');
        }
      }
    }
  }
  showToast(`✅ ${teacher.name} призначений кл. керівником ${cls.replace('class_','')} класу!`);
  loadClassTeacherInfo();
};
window.loadClassTeacherInfo=async function(){
  const cls=document.getElementById('ct-class-select')?.value;
  const info=document.getElementById('ct-current-info');
  const tSel=document.getElementById('ct-teacher-select');
  if(!info||!tSel)return;
  // Заповнюємо вчителів
  tSel.innerHTML='<option value="">-- Оберіть вчителя --</option>';
  window.globalTeachersList.forEach(t=>tSel.innerHTML+=`<option value="${t.safeEmail}">${t.name} (${t.email})</option>`);
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
export async function checkCurriculumUploadAccess(){
  const sec=document.getElementById('curriculum-upload-section');
  if(!sec||!currentUserData)return;
  if(currentUserData.role==='director'){sec.style.display='block';loadCurrentCurriculumDisplay();return;}
  if(currentUserData.role!=='teacher'&&currentUserData.role!=='class_teacher'&&currentUserData.role!=='art_school_teacher'){sec.style.display='none';return;}
  const cls=getActiveClass();
  const snap=await get(ref(db,`class_teachers/${cls}`));
  if(snap.exists()&&snap.val().teacherEmail===currentUserData.email){
    sec.style.display='block';
    loadCurrentCurriculumDisplay();
  } else sec.style.display='none';
}
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
