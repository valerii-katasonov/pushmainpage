// ═══════════════════════════════════════════════════════════════
// teacher.js — everything specific to teacher-screen: journal
// filling (topic + homework), behavior grades, textbooks, the
// legacy curriculum topic checklist, teacher-side retake request
// review, class/attendance management, teacher dashboard counters,
// exams calendar, and reactions/weekly-wrapped.
// ═══════════════════════════════════════════════════════════════
import { ref, set, get, child, push, remove, onValue } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, auth, CLOUDINARY_URL, UPLOAD_PRESET, getActiveClass, currentUserData, showToast, displayGrade, renderHwItem, dayKeys, formatAttendanceSlotLabel, STICKER_GOAL } from './common.js';
import { populateTopicSelector, availableTopicsCache } from './curriculum.js';

let currentHwImages=[];
// teacherAttendanceListener is reassigned only here and read/invoked from
// common.js's logoutUser — plain export/import.
export let teacherAttendanceListener=null;
window.myDetailedReactions=[];

// ══════════ TEACHER: TOPIC & HW ══════════
window.handleSubjectChange=function(){
  loadCurrentTopicAndHW();
  const subj=document.getElementById('t-subject').value;
  ['t-subject-for-comment'].forEach(id=>{const el=document.getElementById(id);if(el)Array.from(el.options).forEach(o=>o.selected=(o.value===subj));});
  loadTextbooksForTeacher();loadCurriculumTopics();
  populateTopicSelector(); /* CURRICULUM v3 */
};
export function loadCurrentTopicAndHW(){
  const date=document.getElementById('global-date').value;const subject=document.getElementById('t-subject').value;const cls=getActiveClass();
  if(!subject)return;
  if(document.getElementById('t-hw'))document.getElementById('t-hw').value='';
  if(document.getElementById('existing-image-info'))document.getElementById('existing-image-info').style.display='none';
  currentHwImages=[];
  /* Topic loading is now handled by populateTopicSelector() → loadSavedTopicForLesson() */
  get(ref(db,`homeworks/${cls}/${date}/${subject}`)).then(snap=>{
    if(snap.exists()){const val=snap.val();if(typeof val==='string'&&document.getElementById('t-hw'))document.getElementById('t-hw').value=val;else{if(document.getElementById('t-hw'))document.getElementById('t-hw').value=val.text||'';if(val.images&&Array.isArray(val.images))currentHwImages=val.images;else if(val.image)currentHwImages=[val.image];if(currentHwImages.length>0&&document.getElementById('existing-image-info')){document.getElementById('existing-image-info').innerText=`📎 Фото: ${currentHwImages.length} шт.`;document.getElementById('existing-image-info').style.display='block';}}}
  });
}
window.loadCurrentTopicAndHW=loadCurrentTopicAndHW;
// Phase 6: up to 2 topics per lesson. lesson_topics/{cls}/{sk}/{date} is now
// {topics:[{topicId|customText}, {topicId|customText}?]} (slot 2 optional).
// hoursUsed inc/dec now compares prev vs new PER ARRAY POSITION (slot 1 vs
// slot 1, slot 2 vs slot 2) instead of the old single prevTopicId/newTopicId pair.
window.saveTopicAndHW=async function(){
  const date=document.getElementById('global-date').value;
  const subject=document.getElementById('t-subject').value;
  const sk=subjKey(subject);
  const hwText=document.getElementById('t-hw')?document.getElementById('t-hw').value.trim():'';
  const fileInput=document.getElementById('t-image');
  const cls=getActiveClass();
  const btn=document.getElementById('btn-save-hw');
  const sm=document.getElementById('status-msg');
  const uid=auth.currentUser.uid;
  if(!subject){alert("Оберіть предмет!");return;}
  btn.disabled=true;btn.innerText="⏳ Збереження...";

  // 1. Прочитати вибір з обох слотів (слот 2 тільки якщо його блок відкритий)
  const slot2Active=document.getElementById('t-topic-slot-2-wrap')&&document.getElementById('t-topic-slot-2-wrap').style.display!=='none';
  const slotInputs=[1,...(slot2Active?[2]:[])].map(n=>({
    selectedId:document.getElementById(`t-topic-value-${n}`)?document.getElementById(`t-topic-value-${n}`).value:'__custom__',
    customText:document.getElementById(`t-topic-${n}`)?document.getElementById(`t-topic-${n}`).value.trim():''
  }));

  // 2. Прочитати попередній стан (нормалізуємо будь-яку стару форму запису до масиву)
  const prevSnap=await get(ref(db,`lesson_topics/${cls}/${sk}/${date}`));
  let prevTopics=[];
  if(prevSnap.exists()){
    const v=prevSnap.val();
    if(typeof v==='string')prevTopics=[{customText:v}];
    else if(Array.isArray(v.topics))prevTopics=v.topics;
    else if(v.topicId||v.customText)prevTopics=[v];
  }

  // 3. Сформувати новий масив тем, перевіряючи ліміт годин для КОЖНОЇ нової теми окремо
  let newTopics=[];
  for(let i=0;i<slotInputs.length;i++){
    const {selectedId,customText}=slotInputs[i];
    if(selectedId==='__custom__'){
      if(customText)newTopics.push({customText});
      continue;
    }
    const prevTopicId=prevTopics[i]?.topicId||null;
    if(selectedId!==prevTopicId){
      const newTSnap=await get(ref(db,`curriculum_plans/${cls}/${sk}/topics/${selectedId}`));
      if(newTSnap.exists()){
        const t=newTSnap.val();
        if((t.hoursUsed||0)>=t.plannedHours){
          showToast(`⚠️ Усі години теми "${t.title}" вже використано!`);
          btn.disabled=false;btn.innerText="💾 Зберегти тему та ДЗ";return;
        }
      }
    }
    newTopics.push({topicId:selectedId});
  }
  if(newTopics.length===2&&newTopics[0].topicId&&newTopics[0].topicId===newTopics[1].topicId){
    showToast('⚠️ Тема 1 і Тема 2 не можуть збігатися!');
    btn.disabled=false;btn.innerText="💾 Зберегти тему та ДЗ";return;
  }

  // 4. Зберегти / видалити lesson_topic
  if(newTopics.length>0) await set(ref(db,`lesson_topics/${cls}/${sk}/${date}`),{topics:newTopics});
  else await remove(ref(db,`lesson_topics/${cls}/${sk}/${date}`));

  // 5. Декремент/інкремент hoursUsed — окремо для кожної позиції масиву (слот 1
  //    порівнюється лише зі слотом 1, слот 2 — лише зі слотом 2)
  const maxLen=Math.max(prevTopics.length,newTopics.length);
  for(let i=0;i<maxLen;i++){
    const prevId=prevTopics[i]?.topicId||null;
    const newId=newTopics[i]?.topicId||null;
    if(prevId===newId)continue;
    if(prevId){
      const pSnap=await get(ref(db,`curriculum_plans/${cls}/${sk}/topics/${prevId}`));
      if(pSnap.exists()){
        const t=pSnap.val();
        const newHU=Math.max(0,(t.hoursUsed||0)-1);
        await set(ref(db,`curriculum_plans/${cls}/${sk}/topics/${prevId}/hoursUsed`),newHU);
      }
    }
    if(newId){
      const nSnap=await get(ref(db,`curriculum_plans/${cls}/${sk}/topics/${newId}`));
      if(nSnap.exists()){
        const t=nSnap.val();
        await set(ref(db,`curriculum_plans/${cls}/${sk}/topics/${newId}/hoursUsed`),(t.hoursUsed||0)+1);
      }
    }
  }

  // 6. Author + HW (без змін)
  await set(ref(db,`authors/${cls}/${date}/${subject}`),uid);
  let finalImageUrls=[...currentHwImages];
  if(fileInput&&fileInput.files.length>0){
    sm.style.display='block';sm.innerText='⏳ Завантаження фото...';sm.style.color='#f39c12';sm.style.background='#fff8e1';finalImageUrls=[];
    try{finalImageUrls=await Promise.all(Array.from(fileInput.files).map(async file=>{const fd=new FormData();fd.append('file',file);fd.append('upload_preset',UPLOAD_PRESET);const r=await fetch(CLOUDINARY_URL,{method:'POST',body:fd});const d=await r.json();return d.secure_url;}));}
    catch(e){alert("Помилка фото: "+e.message);btn.disabled=false;btn.innerText="💾 Зберегти тему та ДЗ";return;}
  }
  if(hwText||finalImageUrls.length>0)await set(ref(db,`homeworks/${cls}/${date}/${subject}`),{text:hwText,images:finalImageUrls});
  // 7. UI feedback — displays for both slots are refreshed by populateTopicSelector()
  //    below (→ loadSavedTopicForLesson() → applyTopicToSlot()), so no manual per-slot
  //    display update is needed here anymore.
  sm.style.color='#1a7d3a';sm.innerText='✅ Збережено!';sm.style.display='block';sm.style.background='#e8f5e9';
  btn.disabled=false;btn.innerText="💾 Зберегти тему та ДЗ";
  if(fileInput)fileInput.value='';
  populateTopicSelector(); /* refresh both dropdowns — covered topics will disable */
  setTimeout(()=>{sm.style.display='none';loadTeacherDashboard();},2500);
};
// ══════════ BEHAVIOR GRADE ══════════
window.saveBehaviorGrade=async function(){
  const student=document.getElementById('t-behavior-student').value;
  const val=document.getElementById('t-behavior-grade').value.trim();
  const date=document.getElementById('global-date').value;const cls=getActiveClass();
  const yMonth=date.substring(0,7);
  if(!student||!val){showToast("⚠️ Оберіть учня та введіть оцінку (1-6)!");return;}
  const n=parseInt(val);if(isNaN(n)||n<1||n>6){showToast("⚠️ Оцінка поведінки: від 1 до 6!");return;}
  await set(ref(db,`behavior_grades/${cls}/${yMonth}/${date}/${student}`),n);
  showToast(`✅ Поведінка ${student}: ${displayGrade(n,cls)}`);
  document.getElementById('t-behavior-grade').value='';
};
// ══════════ TEXTBOOKS (teacher side) ══════════
async function loadTextbooksForTeacher(){
  const cls=getActiveClass();const subj=document.getElementById('t-subject').value;
  if(!subj)return;
  const snap=await get(ref(db,`textbooks/${cls}/${subj.replace(/[.#$[\]]/g,'_')}`));
  const container=document.getElementById('t-textbooks-list');container.innerHTML='';
  if(snap.exists()){const data=snap.val();for(let k in data){const tb=data[k];container.innerHTML+=`<div class="textbook-item">📘 <a href="${tb.url}" target="_blank">${tb.title||tb.url}</a><button onclick="removeTextbook('${cls}','${subj}','${k}')" style="background:none;border:none;color:var(--red);cursor:pointer;padding:0;width:auto;margin:0;font-size:1rem;">✖</button></div>`;}}
  else container.innerHTML='<p class="empty-msg" style="font-size:.8rem;">Підручників ще не додано.</p>';
}
window.saveTextbook=async function(){
  const cls=getActiveClass();const subj=document.getElementById('t-subject').value;
  const title=document.getElementById('t-tb-title').value.trim();const url=document.getElementById('t-tb-url').value.trim();
  if(!subj||!url){showToast("⚠️ Оберіть предмет та введіть посилання!");return;}
  if(!url.startsWith('http')){showToast("⚠️ URL має починатись з http!");return;}
  await push(ref(db,`textbooks/${cls}/${subj.replace(/[.#$[\]]/g,'_')}`),{title:title||url,url,addedBy:auth.currentUser.uid});
  document.getElementById('t-tb-title').value='';document.getElementById('t-tb-url').value='';
  showToast("📘 Підручник додано!");loadTextbooksForTeacher();
};
window.removeTextbook=async function(cls,subj,key){
  await remove(ref(db,`textbooks/${cls}/${subj.replace(/[.#$[\]]/g,'_')}/${key}`));
  showToast("🗑️ Видалено");loadTextbooksForTeacher();
};
// ══════════ CURRICULUM PLAN (legacy checklist) ══════════
async function loadCurriculumTopics(){
  const cls=getActiveClass();const subj=document.getElementById('t-subject').value;if(!subj)return;
  const snap=await get(ref(db,`curriculum_plans/${cls}/${subj.replace(/[.#$[\]]/g,'_')}`));
  const container=document.getElementById('curriculum-topics');container.innerHTML='';
  let topics=snap.exists()?snap.val():{};let totalHours=0;let coveredHours=0;let topicCount=0;let coveredCount=0;
  for(let k in topics){
    const t=topics[k];totalHours+=t.hours||1;topicCount++;
    if(t.covered){coveredHours+=t.hours||1;coveredCount++;}
    const c=t.covered?'covered':'';
    container.innerHTML+=`<div class="topic-row ${c}">
      <input type="checkbox" ${t.covered?'checked':''} onchange="toggleTopicCovered('${cls}','${subj}','${k}',this.checked)">
      <span style="flex:1;${t.covered?'text-decoration:line-through;color:#aaa;':''}">${t.title}</span>
      <span style="font-size:.75rem;color:#888;flex-shrink:0;">${t.hours||1} год.</span>
    </div>`;
  }
  if(topicCount===0)container.innerHTML='<p class="empty-msg" style="font-size:.8rem;">Тем ще не додано.</p>';
  // Smart alert: remaining hours >> remaining topics
  const remainingHours=totalHours-coveredHours;const remainingTopics=topicCount-coveredCount;
  const alertEl=document.getElementById('curriculum-smart-alert');
  if(remainingHours>remainingTopics+4&&topicCount>0){alertEl.style.display='block';alertEl.innerHTML=`⚠️ <b>Увага!</b> Залишок годин (<b>${remainingHours}</b>) перевищує кількість тем (<b>${remainingTopics}</b>) на ${remainingHours-remainingTopics}. Перевірте план або додайте теми.`;}
  else alertEl.style.display='none';
}
// Phase 6: ліміт 5 тем на рік для цього вчителя+предмета+класу. Це legacy-чеклист
// (curriculum_plans/{cls}/{subj}/{pushId} — плоска схема, без вкладеного /topics/,
// на відміну від v3-плану з Excel), тож рахуємо існуючі записи саме за ЦИМ шляхом.
window.addCurriculumTopic=async function(){
  const cls=getActiveClass();const subj=document.getElementById('t-subject').value;
  const title=document.getElementById('new-topic-title').value.trim();const hours=parseInt(document.getElementById('new-topic-hours').value)||1;
  if(!subj||!title){showToast("⚠️ Оберіть предмет і введіть тему!");return;}
  const existSnap=await get(ref(db,`curriculum_plans/${cls}/${subj.replace(/[.#$[\]]/g,'_')}`));
  const existCount=existSnap.exists()?Object.keys(existSnap.val()).length:0;
  if(existCount>=5){showToast(`⚠️ Ліміт 5 тем на рік для "${subj}" вже досягнуто!`);return;}
  await push(ref(db,`curriculum_plans/${cls}/${subj.replace(/[.#$[\]]/g,'_')}`),{title,hours,covered:false});
  document.getElementById('new-topic-title').value='';document.getElementById('new-topic-hours').value='';
  showToast("✅ Тему додано!");loadCurriculumTopics();
};
window.toggleTopicCovered=async function(cls,subj,key,val){
  await set(ref(db,`curriculum_plans/${cls}/${subj.replace(/[.#$[\]]/g,'_')}/${key}/covered`),val);
  loadCurriculumTopics();
};
// ══════════ RETAKE REQUESTS (teacher review side) ══════════
window.openRetakeRequestsModal=async function(){
  document.getElementById('retake-modal').style.display='flex';
  const cls=getActiveClass();const snap=await get(ref(db,`retake_requests/${cls}`));
  const list=document.getElementById('retake-list');list.innerHTML='';
  if(!snap.exists()){list.innerHTML='<p class="empty-msg">Запитів немає.</p>';return;}
  const data=snap.val();let html='';
  for(let subj in data){
    for(let date in data[subj]){
      for(let student in data[subj][date]){
        const req=data[subj][date][student];
        const statusColor=req.status==='approved'?'var(--green)':req.status==='rejected'?'var(--red)':'var(--orange)';
        const statusLabel=req.status==='approved'?'✅ Схвалено':req.status==='rejected'?'❌ Відхилено':'⏳ Очікує';
        html+=`<div style="background:#fafafa;border:1px solid #eee;border-radius:9px;padding:11px;margin-bottom:9px;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div><b>${student}</b> | ${subj} | ${date.split('-').reverse().join('.')}</div>
            <span style="color:${statusColor};font-size:.8rem;font-weight:700;">${statusLabel}</span>
          </div>
          <div style="font-size:.8rem;color:#888;margin-top:5px;">Поточна оцінка: <b>${req.grade||'—'}</b></div>
          ${req.status==='pending'?`<div style="display:flex;gap:7px;margin-top:8px;">
            <button onclick="processRetake('${cls}','${subj}','${date}','${student}','approved')" style="flex:1;background:var(--green);color:#fff;padding:7px;border-radius:8px;border:none;cursor:pointer;font-weight:700;font-size:.82rem;margin:0;">✅ Дозволити</button>
            <button onclick="processRetake('${cls}','${subj}','${date}','${student}','rejected')" style="flex:1;background:var(--red);color:#fff;padding:7px;border-radius:8px;border:none;cursor:pointer;font-weight:700;font-size:.82rem;margin:0;">❌ Відхилити</button>
          </div>`:''}
        </div>`;
      }
    }
  }
  list.innerHTML=html||'<p class="empty-msg">Запитів немає.</p>';
};
window.processRetake=async function(cls,subj,date,student,status){
  await set(ref(db,`retake_requests/${cls}/${subj}/${date}/${student}/status`),status);
  showToast(status==='approved'?`✅ Перездачу дозволено: ${student}`:`❌ Перездачу відхилено`);
  window.openRetakeRequestsModal();
};
window.closeRetakeModal=function(){document.getElementById('retake-modal').style.display='none';};
// ══════════ ATTENDANCE / CLASS MANAGEMENT ══════════
window.loadStudentsList=function(){get(child(ref(db),`students_list/${getActiveClass()}`)).then(snap=>{const els=['t-student','t-mark-absent-student','t-sticker-student','t-behavior-student','t-student-for-parent'];els.forEach(id=>{const el=document.getElementById(id);if(el)el.innerHTML='<option value="">Учень...</option>';});if(snap.exists())Object.values(snap.val()).sort().forEach(name=>{els.forEach(id=>{const el=document.getElementById(id);if(el){const o=document.createElement('option');o.value=name;o.innerText=name;el.appendChild(o.cloneNode(true));}});});});};
// Populates #t-mark-absent-lesson with this day's lessons (position in
// getTodayLessonsFlattened is the slotKey), so the teacher marks absence
// for their own lesson instead of the whole day. Falls back to the
// currently selected subject (or a generic "all") when no schedule is
// loaded for the date.
function buildMarkAbsentLessonOptions(){
  const sel=document.getElementById('t-mark-absent-lesson');
  if(!sel)return;
  const dateStr=document.getElementById('global-date').value;
  const [y,m,d]=dateStr.split('-');const dv=new Date(y,m-1,d);const dn=dayKeys[dv.getDay()];
  const flat=window.getTodayLessonsFlattened(dn);
  sel.innerHTML='';
  if(flat.length>0){
    flat.forEach((l,i)=>{
      const sn=window.getValidSubjectName(l)||'Урок';
      sel.innerHTML+=`<option value="${i+1}">${l.number||(i+1)}. ${sn}</option>`;
    });
  } else {
    const fallbackSubj=document.getElementById('t-subject')?.value;
    const val=fallbackSubj||'all';
    sel.innerHTML=`<option value="${val}">${fallbackSubj?fallbackSubj+' (розклад не знайдено)':'Увесь день'}</option>`;
  }
}
window.teacherMarkAbsent=function(){
  const st=document.getElementById('t-mark-absent-student').value;
  const rs=document.getElementById('t-mark-absent-reason').value;
  const slotKey=document.getElementById('t-mark-absent-lesson')?.value||'all';
  const date=document.getElementById('global-date').value;
  if(!st)return alert('Оберіть учня!');
  const status=rs==='запізнення'?'late':'absent';
  set(ref(db,`attendance/${getActiveClass()}/${date}/${st}/${slotKey}`),{status,reason:rs,markedBy:'teacher'}).then(()=>{
    showToast(`✅ ${st} відмічений.`);
    document.getElementById('t-mark-absent-student').value='';
  });
};
window.addStudent=function(){const name=document.getElementById('new-student-name').value.trim();const emailEl=document.getElementById('new-student-email');const email=emailEl?emailEl.value.trim().replace(/\./g,'_'):'';if(name){push(ref(db,`students_list/${getActiveClass()}`),name).then(()=>{if(email)set(ref(db,`student_links/${email}`),{studentName:name,class:getActiveClass()});alert("Учня додано!");loadStudentsList();document.getElementById('new-student-name').value='';if(emailEl)emailEl.value='';});}};
window.linkParent=function(){const e=document.getElementById('parent-email').value.trim().replace(/\./g,'_');const st=document.getElementById('t-student-for-parent').value;const cls=getActiveClass();const role=document.getElementById('t-parent-role').value;if(e&&st){set(ref(db,`parent_links/${e}`),{studentName:st,class:cls,role}).then(()=>{alert(`✅ Email прив'язано!`);document.getElementById('parent-email').value='';});}else alert("Оберіть учня та Email");};
export function listenTeacherAttendance(){
  const date=document.getElementById('global-date').value;const list=document.getElementById('t-attendance-list');
  if(teacherAttendanceListener)teacherAttendanceListener();
  buildMarkAbsentLessonOptions();
  if(currentUserData.role==='art_school_teacher'){
    document.getElementById('t-att-header').innerText="🚨 Відсутні (Вся школа):";
    teacherAttendanceListener=onValue(ref(db,'attendance'),snap=>{list.innerHTML='';if(snap.exists()){const d=snap.val();let h='';for(let i=1;i<=11;i++){const c=`class_${i}`;if(d[c]&&d[c][date])for(let st in d[c][date]){const slots=d[c][date][st];for(let sk in slots){const r=slots[sk];if(!r?.status)continue;const bc=r.status==='late'?'badge-late':'badge-absent';const lb=r.status==='late'?'Запізнення':'Відсутність';const markerIcon=r.markedBy==='teacher'?'👨‍🏫':(r.markedBy==='student'?'🎒':'👪');h+=`<li style="margin-bottom:7px;border-bottom:1px dashed #eee;padding-bottom:4px;"><span style="font-size:.72rem;background:var(--teal);color:#fff;padding:2px 5px;border-radius:4px;margin-right:4px;">${i} Кл</span> <b>${st}</b> <span class="badge ${bc}">${lb}</span> <span style="font-size:.72rem;color:#888;">${formatAttendanceSlotLabel(sk)} ${markerIcon}</span></li>`;}}}list.innerHTML=h||'<li class="empty-msg">Усі на місці.</li>';}else list.innerHTML='<li class="empty-msg">Усі на місці.</li>';});
  }else{
    const cls=getActiveClass();document.getElementById('t-att-header').innerText="🚨 Відвідуваність сьогодні:";
    teacherAttendanceListener=onValue(ref(db,`attendance/${cls}/${date}`),snap=>{list.innerHTML='';if(snap.exists()){const d=snap.val();let h='';for(let st in d){const slots=d[st];for(let sk in slots){const r=slots[sk];if(!r?.status)continue;const bc=r.status==='late'?'badge-late':'badge-absent';const lb=r.status==='late'?'Запізнення':'Відсутність';const markerIcon=r.markedBy==='teacher'?'👨‍🏫':(r.markedBy==='student'?'🎒':'👪');h+=`<li style="margin-bottom:7px;border-bottom:1px dashed #eee;padding-bottom:4px;"><b>${st}</b> <span class="badge ${bc}">${lb}</span> <span style="font-size:.72rem;color:#888;">${formatAttendanceSlotLabel(sk)} ${markerIcon}</span> <i style="font-size:.78rem;color:#666;">(${r.reason})</i></li>`;}}list.innerHTML=h||'<li class="empty-msg">Усі на місці.</li>';}else list.innerHTML='<li class="empty-msg">Усі на місці.</li>';});
  }
}
window.listenTeacherAttendance=listenTeacherAttendance;
// ══════════ TEACHER DASHBOARD ══════════
export function loadTeacherDashboard(){
  const cls=getActiveClass();const uid=auth.currentUser.uid;
  // Retake counter
  get(ref(db,`retake_requests/${cls}`)).then(snap=>{if(snap.exists()){const d=snap.val();let cnt=0;for(let s in d)for(let dt in d[s])for(let st in d[s][dt])if(d[s][dt][st].status==='pending')cnt++;document.getElementById('t-retake-counter').innerText=cnt;}else document.getElementById('t-retake-counter').innerText=0;});
  Promise.all([get(child(ref(db),`reactions/${cls}`)),get(child(ref(db),`authors/${cls}`)),get(child(ref(db),`comments/${cls}`))]).then(([rs,as,cs])=>{
    let cnt=0;window.myDetailedReactions=[];
    if(rs.exists()&&as.exists()){const reactions=rs.val();const authors=as.val();const comments=cs.exists()?cs.val():{};for(let d in reactions)for(let s in reactions[d])if(authors[d]&&authors[d][s]===uid)for(let st in reactions[d][s]){cnt++;let emoji=reactions[d][s][st];let cm=(comments[d]&&comments[d][s]&&comments[d][s][st])?comments[d][s][st]:'Без коментаря';window.myDetailedReactions.push({date:d,subject:s,student:st,emoji,comment:cm});}window.myDetailedReactions.sort((a,b)=>new Date(b.date)-new Date(a.date));}
    document.getElementById('t-karma-counter').innerText=cnt;
  });
  if(currentUserData.role!=='art_school_teacher'){const date=document.getElementById('global-date').value;get(child(ref(db),`homeworks/${cls}/${date}`)).then(snap=>{const hl=document.getElementById('t-daily-hw-list');hl.innerHTML='';if(snap.exists()){const d=snap.val();for(let s in d)hl.innerHTML+=renderHwItem(s,d[s]);}else hl.innerHTML='<li class="empty-msg">ДЗ не задано.</li>';});}
  listenTeacherAttendance();
}
window.loadTeacherDashboard=loadTeacherDashboard;
window.giveStickerToStudent=async function(){const st=document.getElementById('t-sticker-student').value;const subj=document.getElementById('t-subject').value;const date=document.getElementById('global-date').value;const cls=getActiveClass();if(!st||!subj){showToast("⚠️ Оберіть учня та переконайтесь що обрано предмет!");return;}await set(ref(db,`stickers/${cls}/${st}/${date}_${subj}`),true);showToast(`🌟 Наліпка: ${st}!`);};
window.saveComment=async function(){const st=document.getElementById('t-student').value;const subj=document.getElementById('t-subject-for-comment').value;const cm=document.getElementById('t-comment').value.trim();const date=document.getElementById('global-date').value;const cls=getActiveClass();if(!st||!subj){showToast("⚠️ Оберіть учня та предмет!");return;}if(!cm){showToast("⚠️ Введіть коментар!");return;}await set(ref(db,`comments/${cls}/${date}/${subj}/${st}`),cm);document.getElementById('t-comment').value='';showToast(`💬 Коментар збережено: ${st}`);};
// ══════════ EXAMS ══════════
window.openExamsCalendar=function(){document.getElementById('exams-modal').style.display='flex';document.getElementById('exam-class-label').innerText=document.getElementById('t-class-selector').options[document.getElementById('t-class-selector').selectedIndex].text;document.getElementById('exams-day-details').style.display='none';const mi=document.getElementById('exam-month-select');const dp=document.getElementById('global-date').value.split('-');mi.value=`${dp[0]}-${dp[1]}`;renderExamsCalendar();};
window.closeExamsModal=function(){document.getElementById('exams-modal').style.display='none';};
window.renderExamsCalendar=function(){const cls=getActiveClass();const ym=document.getElementById('exam-month-select').value;if(!ym)return;const[y,m]=ym.split('-');get(child(ref(db),`exams/${cls}/${y}-${m}`)).then(snap=>{const d=snap.exists()?snap.val():{};let h='<div class="cal-grid">';['Пн','Вт','Ср','Чт','Пт','Сб','Нд'].forEach(d2=>h+=`<div class="cal-header">${d2}</div>`);const dim=new Date(y,parseInt(m),0).getDate();let fd=new Date(y,parseInt(m)-1,1).getDay();if(fd===0)fd=7;for(let i=1;i<fd;i++)h+=`<div></div>`;for(let i=1;i<=dim;i++){const cd=`${y}-${m}-${String(i).padStart(2,'0')}`;const cnt=d[cd]?Object.keys(d[cd]).length:0;const cc=cnt===1?'has-1':cnt>=2?'has-2':'';h+=`<div class="cal-day ${cc}" onclick="manageDayExams('${cd}')">${i}<br><small style="font-size:.68rem;">${cnt>0?cnt+' к.р.':''}</small></div>`;}h+='</div>';document.getElementById('exams-cal-container').innerHTML=h;});};
window.manageDayExams=function(ds){const cls=getActiveClass();const dd=document.getElementById('exams-day-details');dd.style.display='block';get(child(ref(db),`exams/${cls}/${ds.substring(0,7)}/${ds}`)).then(snap=>{let ex=snap.exists()?snap.val():{};let lh='';for(let s in ex){const me=ex[s]===auth.currentUser.uid;const db2=me?`<button onclick="deleteExam('${ds}','${s}')" style="background:none;border:none;color:var(--red);cursor:pointer;font-weight:700;padding:0 4px;width:auto;margin:0;font-size:1.1rem;">✖</button>`:'';lh+=`<li style="margin-bottom:7px;display:flex;justify-content:space-between;align-items:center;background:#fff;padding:7px 11px;border-radius:8px;border:1px solid #eee;"><span><b>${s}</b></span>${db2}</li>`;}let h=`<h4 style="margin-top:0;color:#d35400;border-bottom:1px dashed var(--orange);padding-bottom:9px;">Контрольні: ${ds.split('-').reverse().join('.')}</h4>`;h+=`<ul style="padding-left:0;list-style:none;margin-bottom:13px;">${lh||'<li class="empty-msg">Жодної</li>'}</ul>`;const[yy,mm,dd2]=ds.split('-');const dn=dayKeys[new Date(yy,mm-1,dd2).getDay()];let ds2=new Set();window.getTodayLessonsFlattened(dn).forEach(item=>{const sn=window.getValidSubjectName(item);if(sn)ds2.add(sn);});let fe=currentUserData.role==='teacher'?[...ds2].filter(s=>window.isSubjectAllowed(cls,s)).sort():[...ds2].sort();let so=fe.map(s=>`<option value="${s}">${s}</option>`).join('');if(!so){so='<option disabled>Немає предметів</option>';}h+=`<div style="display:flex;gap:9px;"><select id="exam-add-subj" style="flex:1;margin:0;">${so}</select><button style="background:var(--green);color:#fff;width:auto;padding:9px 13px;margin:0;" onclick="addExam('${ds}')">Додати</button></div>`;dd.innerHTML=h;});};
window.addExam=function(ds){const s=document.getElementById('exam-add-subj').value;if(!s)return;const cls=getActiveClass();const ym=ds.substring(0,7);get(child(ref(db),`exams/${cls}/${ym}/${ds}`)).then(snap=>{let cnt=snap.exists()?Object.keys(snap.val()).length:0;if(cnt>=2)return alert('❌ Ліміт: більше 2 контрольних не можна!');set(ref(db,`exams/${cls}/${ym}/${ds}/${s}`),auth.currentUser.uid).then(()=>{renderExamsCalendar();manageDayExams(ds);});});};
window.deleteExam=function(ds,s){const cls=getActiveClass();remove(ref(db,`exams/${cls}/${ds.substring(0,7)}/${ds}/${s}`)).then(()=>{renderExamsCalendar();manageDayExams(ds);});};
// ══════════ REACTIONS & WRAPPED (teacher side) ══════════
window.showReactionsDetails=function(){document.getElementById('reactions-modal').style.display='flex';const list=document.getElementById('reactions-list');list.innerHTML='';if(!window.myDetailedReactions?.length){list.innerHTML='<p class="empty-msg" style="text-align:center;">Немає реакцій.</p>';return;}let h='<ul style="list-style:none;padding:0;margin:0;">';window.myDetailedReactions.forEach(r=>{const[y,m,d]=r.date.split('-');h+=`<li style="background:#fdfbfb;border:1px solid #eee;border-radius:8px;padding:11px;margin-bottom:9px;"><div style="display:flex;justify-content:space-between;border-bottom:1px dashed #ddd;padding-bottom:4px;margin-bottom:7px;"><span style="font-weight:700;color:var(--teal);">${r.student}</span><span style="font-size:1.3rem;">${r.emoji}</span></div><div style="font-size:.78rem;color:#888;margin-bottom:4px;">📅 ${d}.${m}.${y} | 📚 ${r.subject}</div><div style="font-size:.88rem;color:#444;background:#f0f8ff;padding:7px;border-radius:6px;font-style:italic;">"${r.comment}"</div></li>`;});h+='</ul>';list.innerHTML=h;};
window.closeReactionsModal=function(){document.getElementById('reactions-modal').style.display='none';};
window.showWeeklyWrapped=function(){confetti({particleCount:200,spread:90,origin:{y:0.6},zIndex:2000});document.getElementById('wrapped-modal').style.display='flex';document.body.style.overflow='hidden';const uid=auth.currentUser.uid;const cls=getActiveClass();Promise.all([get(child(ref(db),`homeworks/${cls}`)),get(child(ref(db),`comments/${cls}`)),get(child(ref(db),`stickers/${cls}`)),get(child(ref(db),`authors/${cls}`))]).then(([hs,cs,ss,as])=>{const a=as.exists()?as.val():{};let hw=0;if(hs.exists()){const d=hs.val();for(let dt in d)for(let s in d[dt])if(a[dt]&&a[dt][s]===uid)hw++;}document.getElementById('w-hw').innerText=hw;let com=0;if(cs.exists()){const d=cs.val();for(let dt in d)for(let s in d[dt])if(a[dt]&&a[dt][s]===uid)com+=Object.keys(d[dt][s]).length;}document.getElementById('w-com').innerText=com;let st=0;if(ss.exists()){const d=ss.val();for(let student in d)for(let k in d[student]){const[dt,s]=k.split('_');if(a[dt]&&a[dt][s]===uid)st++;}}document.getElementById('w-st').innerText=st;});};
window.closeModal=function(){document.getElementById('wrapped-modal').style.display='none';document.body.style.overflow='';};
// ══════════ PHASE 7: STICKER STATS ══════════
// Reuses #reactions-modal's markup/structure (new modal id: sticker-stats-modal,
// new list id: sticker-stats-list). One get() on the whole stickers/{cls} subtree
// instead of per-student calls — Object.keys(stickersData[student]||{}).length is
// the same "count all keys" the prompt asks for, just batched.
window.openStickerStatsModal=async function(){
  document.getElementById('sticker-stats-modal').style.display='flex';
  const list=document.getElementById('sticker-stats-list');
  list.innerHTML='<p class="empty-msg" style="text-align:center;">⏳ Завантаження...</p>';
  const cls=getActiveClass();
  const [stuSnap,stSnap]=await Promise.all([
    get(child(ref(db),`students_list/${cls}`)),
    get(child(ref(db),`stickers/${cls}`))
  ]);
  const students=stuSnap.exists()?Object.values(stuSnap.val()):[];
  const stickersData=stSnap.exists()?stSnap.val():{};
  if(students.length===0){list.innerHTML='<p class="empty-msg" style="text-align:center;">Учнів немає.</p>';return;}
  const stats=students.map(name=>({name,count:stickersData[name]?Object.keys(stickersData[name]).length:0}));
  stats.sort((a,b)=>b.count-a.count);
  let h='<ul style="list-style:none;padding:0;margin:0;">';
  stats.forEach((s,i)=>{
    const pct=Math.min((s.count/STICKER_GOAL)*100,100);
    const medal=i===0?'🥇 ':i===1?'🥈 ':i===2?'🥉 ':'';
    h+=`<li style="background:#fdfbfb;border:1px solid #eee;border-radius:8px;padding:11px;margin-bottom:9px;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="font-weight:700;color:var(--teal);">${medal}${s.name}</span>
        <span style="font-size:1.05rem;font-weight:800;color:#f39c12;">🌟 ${s.count}</span>
      </div>
      <div style="background:#eee;border-radius:6px;height:8px;margin-top:7px;overflow:hidden;">
        <div style="background:linear-gradient(90deg,#f39c12,#f1c40f);height:100%;width:${pct}%;"></div>
      </div>
      <div style="font-size:.72rem;color:#888;margin-top:3px;text-align:right;">${s.count}/${STICKER_GOAL} до призу</div>
    </li>`;
  });
  h+='</ul>';
  list.innerHTML=h;
};
window.closeStickerStatsModal=function(){document.getElementById('sticker-stats-modal').style.display='none';};
