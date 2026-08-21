// ═══════════════════════════════════════════════════════════════
// common.js — Firebase init, constants, auth, shared grade/date
// utilities, Profile modal, unified Chat/Inbox, Admin dashboard,
// and date/class-change orchestration (dispatches to role dashboards
// defined in the other modules).
//
// NOTE on shared mutable state across modules:
// A few variables are written to from more than one file (e.g. the
// list of teachers, or teacher access rules loaded while building the
// visual schedule matrix). For those we keep the existing window.*
// pattern the app already used (window.schedule, window.clubSchedule,
// window.myDetailedReactions) instead of fighting ES-module live
// bindings. Everything else uses normal export/import.
// ═══════════════════════════════════════════════════════════════
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, updatePassword, sendPasswordResetEmail, verifyPasswordResetCode, confirmPasswordReset, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getDatabase, ref, set, get, child, push, onValue, remove, update } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";

import { loadTeacherDashboard, loadCurrentTopicAndHW, listenTeacherAttendance, teacherAttendanceListener } from './teacher.js';
import { loadDirectorDashboard, loadTeachersListForDirector, loadDirectorTeacherSkillsList, loadDrafts } from './director.js';
import { loadParentDashboard, loadStudentDashboard, loadTextbooksForParent, renderPaymentsMockup, parentLessonInterval } from './parent-student.js';
import { globalTeacherAccess } from './journal.js';
import { checkCurriculumUploadAccess } from './curriculum.js';

export const CLOUD_NAME='duy1qwsqv'; export const UPLOAD_PRESET='ml_default'; export const CLOUDINARY_URL=`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`;
const firebaseConfig={apiKey:"AIzaSyA3OA9pcR1zscUtEPWD8LEKTKonAN5Y90c",authDomain:"test-4eb3e.firebaseapp.com",databaseURL:"https://test-4eb3e-default-rtdb.europe-west1.firebasedatabase.app",projectId:"test-4eb3e",storageBucket:"test-4eb3e.firebasestorage.app",messagingSenderId:"933339787450",appId:"1:933339787450:web:cc87b850ed3b4903f41283"};
export const app=initializeApp(firebaseConfig); export const auth=getAuth(app); export const db=getDatabase(app);

// ══════════ CONSTANTS ══════════
// Phase 5: GRADE_WEIGHTS stays as the fallback/default and as the one-time
// migration seed source — the actual source of truth is now Firebase
// (grade_type_defs/{code}={label,shortLabel,weight}), cached in gradeTypesCache
// below. NOTE: deliberately NOT called "grade_types" — that name is already used
// by a separate, pre-existing collection (per-cell grade type values,
// grade_types/{cls}/{yMonth}/{subj}/{date}/{student}) written by journal.js's
// confirmGrade()/deleteGrade(). Naming them the same caused real data to
// collide (see loadGradeTypesCache below for the incident this fixed).
export const GRADE_WEIGHTS={'П':1.0,'У':1.0,'ДЗ':0.5,'СР':1.5,'ДК':1.5,'ПР':1.5,'ПЗ':1.5,'К':2.0};
// Best-guess full Ukrainian labels used only to seed grade_type_defs on first run —
// director can rename via delete+recreate in the new "🎯 Типи оцінок" panel if wrong.
const GRADE_TYPE_LABELS={'П':'Поточна','У':'Усна відповідь','ДЗ':'Домашнє завдання','СР':'Самостійна робота','ДК':'Диктант','ПР':'Практична робота','ПЗ':'Проектне завдання','К':'Контрольна робота'};
export const STICKER_GOAL=30;
export const dayKeys=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
export const dayNamesUA={Monday:"Понеділок",Tuesday:"Вівторок",Wednesday:"Середа",Thursday:"Четвер",Friday:"П'ятниця"};
// ══════════ MULTI-ROLE SUPPORT ══════════
// Історично роль була одним рядком: users/{uid}/role = "teacher".
// Тепер одна особа може мати кілька ролей (напр. вчитель + адміністратор):
//   users/{uid}/roles = ["teacher","administrator"]   ← повний список
//   users/{uid}/role  = "teacher"                     ← АКТИВНА роль (та, в якій
//                                                        людина працює зараз)
// Поле role залишається, щоб уся наявна логіка (getActiveClass, initUserSession,
// підписи в чаті тощо) працювала без змін. pre_approved_roles/{email} тепер може
// містити або рядок (як раніше), або масив ролей — normalizeRoles() розбирає обидва.
export const ROLE_LABELS={
  director:'👔 Директор', administrator:'🛡️ Секретар (Адміністратор)',
  teacher:'👨‍🏫 Вчитель', class_teacher:'🎓 Класний керівник',
  art_school_teacher:'🎨 Вчитель школи мистецтв', music_teacher:'🎵 Вчитель музики',
  parent:'👪 Батьки', student:'🎒 Учень'
};
// Ролі, для яких потрібна матриця доступу до класів (teacherAccessMatrix)
export const TEACHER_ROLES=['teacher','class_teacher','art_school_teacher','music_teacher'];
export function isTeacherRole(r){return TEACHER_ROLES.includes(r);}
// Приводить будь-яке представлення (рядок / масив / об'єкт з Firebase) до масиву
export function normalizeRoles(raw){
  if(!raw)return[];
  if(typeof raw==='string')return[raw];
  if(Array.isArray(raw))return raw.filter(Boolean);
  return Object.values(raw).filter(v=>typeof v==='string');
}
// Усі ролі користувача (roles, а якщо його ще немає — одиночний role)
export function getUserRoles(u){
  if(!u)return[];
  const list=normalizeRoles(u.roles);
  if(list.length>0)return list;
  return u.role?[u.role]:[];
}
// ══════════ КІЛЬКА ДІТЕЙ В ОДНИХ БАТЬКІВ ══════════
// Історично parent_links/{email} = {studentName, class, role} — один запис,
// тож прив'язка другої дитини мовчки затирала першу. Тепер запис може бути:
//   {children:[{studentName,class,role}, ...]}   ← нова форма
//   {studentName, class, role}                   ← стара (одна дитина)
//   "Прізвище Ім'я"                              ← найдавніша (рядок)
// normalizeChildren() зводить будь-яку з них до масиву, тому старі записи
// продовжують працювати без міграції.
export function normalizeChildren(raw){
  if(!raw)return[];
  if(typeof raw==='string')return[{studentName:raw,class:'class_2',role:'guardian'}];
  if(Array.isArray(raw.children))return raw.children.filter(c=>c&&c.studentName);
  if(raw.children&&typeof raw.children==='object')
    return Object.values(raw.children).filter(c=>c&&c.studentName);
  if(raw.studentName)return[{studentName:raw.studentName,class:raw.class||'class_2',role:raw.role||'guardian'}];
  return[];
}
// Діти, прив'язані до профілю (children, інакше — активна дитина)
export function getUserChildren(u){
  if(!u)return[];
  const list=normalizeChildren(u);
  if(list.length>0)return list;
  return u.studentName?[{studentName:u.studentName,class:u.class,role:u.parentRole}]:[];
}

// ══════════ STATE ══════════
// currentUserData is reassigned only here (onAuthStateChanged); every
// other module imports it read-only (they may still mutate its
// properties, e.g. saveProfile() below, which is fine with live bindings).
export let currentUserData=null;
// teacherAccessMatrix is reassigned only here (fetchTeacherAccess) and
// read here + in director.js (findSubstitute) — plain export/import.
export let teacherAccessMatrix={};
// Phase 5: gradeTypesCache is reassigned only here (loadGradeTypesCache) and
// read from director.js (types management panel) + journal.js (dynamic grade-
// type buttons/legend) + parent-student.js (formula info block) — same
// single-owner export/import pattern as teacherAccessMatrix above.
export let gradeTypesCache={};
let mySkillsTemp=[]; // for profile modal
// Chat/Inbox local state
let inboxMessagesListener = null;
let chatListListener = null;
let currentChatId = null;

const today=new Date();
export const localDateString=today.getFullYear()+'-'+String(today.getMonth()+1).padStart(2,'0')+'-'+String(today.getDate()).padStart(2,'0');
document.getElementById('global-date').value=localDateString;

// ══════════ GRADE SYSTEM ══════════
// 6-бальна шкала. Маскування для 1-5 класу
export function getClassNum(clsId){return parseInt((clsId||'class_1').replace('class_',''));}
export function displayGrade(val,clsId){
  if(!val&&val!==0) return '';
  const n=parseInt(val);
  const cn=getClassNum(clsId||getActiveClass());
  if(cn<=5){
    // маскуємо цифри літерами
    if(n>=5) return 'В';
    if(n===4) return 'Д';
    if(n===3) return 'С';
    return 'П';
  }
  return String(val);
}
export function gradeClass6(val){
  const n=parseInt(val);
  if(isNaN(n)) return 'g-letter';
  if(n>=6) return 'g6';
  if(n===5) return 'g5';
  if(n===4) return 'g4';
  if(n===3) return 'g3';
  if(n===2) return 'g2';
  return 'g1';
}
export function gradeColorInline(val){
  const n=parseInt(val);
  if(isNaN(n)) return '#8e44ad';
  if(n>=5) return '#1565c0';
  if(n===4) return '#2e7d32';
  if(n===3) return '#f57f17';
  return '#b71c1c';
}
// Phase 5: weight now comes from the Firebase-backed grade_types cache
// (getGradeWeight below), with GRADE_WEIGHTS only as a fallback default for
// codes missing from — or before — that cache loads.
export function getGradeWeight(code){
  if(gradeTypesCache&&gradeTypesCache[code]&&typeof gradeTypesCache[code].weight==='number')return gradeTypesCache[code].weight;
  return GRADE_WEIGHTS[code]||1.0;
}
// One-time load (+ one-time migration seed) of grade type CONFIG from Firebase
// into gradeTypesCache. Called during auth/session init (see onAuthStateChanged
// below) for every role, since parent/student also need it (formula info
// block) and teacher/director need it for calculations + the type buttons.
//
// IMPORTANT: this lives at `grade_type_defs/{code}` (config: {label,shortLabel,
// weight}) — NOT at `grade_types`. `grade_types/{cls}/{yMonth}/{subj}/{date}/
// {student}` is a *different*, pre-existing collection (the actual per-cell
// grade-type VALUE a teacher picks for one student's one grade, written by
// confirmGrade()/deleteGrade() in journal.js — this predates Phase 5 entirely).
// An earlier version of this function read/wrote the config at `grade_types`
// directly, which collided with that collection: e.g. grading any student in
// class_2 creates `grade_types/class_2/...`, which then got misread as a bogus
// "class_2" grade-type code (label "class_2", weight defaulting to 1) by every
// function that iterates Object.keys(gradeTypesCache) — that's the "class_2 —
// class_2 (×1)" line that showed up in the journal legend. Renamed to a
// separate root to make the two collections structurally impossible to collide.
export async function loadGradeTypesCache(){
  const snap=await get(ref(db,'grade_type_defs'));
  if(snap.exists()){gradeTypesCache=snap.val();return;}
  gradeTypesCache={};
  // Only the director performs the one-time seed write, so concurrently
  // logging-in teachers/parents/students don't race to create the node —
  // they just fall back to GRADE_WEIGHTS via getGradeWeight() until the
  // director's next login seeds grade_type_defs for everyone.
  if(currentUserData?.role==='director'){
    const seed={};
    for(let code in GRADE_WEIGHTS)seed[code]={label:GRADE_TYPE_LABELS[code]||code,shortLabel:code,weight:GRADE_WEIGHTS[code]};
    await set(ref(db,'grade_type_defs'),seed);
    gradeTypesCache=seed;
  }
}
export function calculateWeightedAverage(grades,types){
  // grades: {date: {student: val}}, types: {date: {student: type}}
  let totalWeight=0; let totalScore=0;
  for(let date in grades){
    for(let student in grades[date]){
      const val=parseFloat(grades[date][student]);
      if(isNaN(val)) continue;
      const type=(types&&types[date]&&types[date][student])||'П';
      const weight=getGradeWeight(type);
      totalScore+=val*weight; totalWeight+=weight;
    }
  }
  if(totalWeight===0) return null;
  return totalScore/totalWeight;
}
export function calculateStudentWeightedAvg(studentGrades,studentTypes){
  let totalW=0; let totalS=0;
  for(let key in studentGrades){
    const val=parseFloat(studentGrades[key]); if(isNaN(val)) continue;
    const type=studentTypes?.[key]||'П'; const w=getGradeWeight(type);
    totalS+=val*w; totalW+=w;
  }
  return totalW>0?totalS/totalW:null;
}
// Phase 5: compact "how the average is calculated" info block for parent/student
// grade cards (#p-daily-comments-list / #s-daily-comments-list). Returned as a
// <li style="list-style:none"> so it's valid to prepend inside those <ul> lists.
export function renderGradeFormulaInfo(){
  const codes=Object.keys(gradeTypesCache).length>0?Object.keys(gradeTypesCache):Object.keys(GRADE_WEIGHTS);
  const items=codes.map(code=>{
    const w=getGradeWeight(code);
    const label=(gradeTypesCache[code]&&gradeTypesCache[code].label)||code;
    return `<span style="display:inline-block;background:#fff;border:1px solid #d1c4e9;border-radius:6px;padding:2px 7px;margin:2px 3px 2px 0;font-size:.72rem;"><b>${code}</b> ${label} ×${w}</span>`;
  }).join('');
  return `<li style="list-style:none;background:#f4ecf7;border:1px solid #d2b4de;border-radius:8px;padding:8px 10px;margin-bottom:9px;font-size:.78rem;color:#555;">
    <b style="color:var(--purple);">ℹ️ Як рахується середній бал:</b> Σ(оцінка × коефіцієнт) / Σ(коефіцієнт)
    <div style="margin-top:5px;">${items}</div>
  </li>`;
}
// ══════════ UTILITIES ══════════
// Toast messages routinely embed user-sourced values (student names, subjects),
// so the whole message is escaped — no caller passes intentional HTML.
export function showToast(msg){const c=document.getElementById('toast-container');const t=document.createElement('div');t.className='toast';t.innerHTML=`<span>🔔 ${escHtml(msg)}</span>`;c.appendChild(t);setTimeout(()=>{t.style.opacity='0';setTimeout(()=>t.remove(),300);},4000);}
// Escapes a value for interpolation into a single-quoted JS string inside an
// inline onclick="fn('...')" attribute. Ukrainian names and subjects routinely
// contain apostrophes (Дем'яненко, Комп'ютерні науки, Мар'яна) — unescaped,
// one of those breaks the inline handler's string literal and the whole
// onclick dies with a SyntaxError. Backslashes escaped first, then quotes.
export function escJs(s){return String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'&quot;');}
// Escapes a value for interpolation into HTML BODY content (innerHTML template
// strings). Complements — does not replace — escJs above: escJs protects a JS
// string literal inside an onclick attribute, escHtml protects the HTML text
// itself. User/Firebase-sourced text (chat messages, comments, names, topics,
// HW text...) rendered via innerHTML without this is an XSS hole: a message like
// <img src=x onerror=alert(document.cookie)> would execute for everyone.
// Безпечне посилання: escHtml сам по собі НЕ рятує від href="javascript:...",
// бо там немає символів < > " '. Тому окремо перевіряємо протокол і повертаємо
// '#' для всього, що не http(s). Використовувати скрізь, де url від користувача.
export function safeUrl(u){
  const s=String(u??'').trim();
  return /^https?:\/\//i.test(s)?escHtml(s):'#';
}
export function escHtml(s){
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
// Only http(s) URLs are allowed to be rendered as href targets — same principle
// as the save-side check in saveTextbook(), applied at RENDER time too so a
// javascript:-URL already sitting in Firebase can't become a live link.
export function safeHttpUrl(u){
  const s=String(u ?? '').trim();
  return /^https?:\/\//i.test(s)?s:'';
}
export function getActiveClass(){if(currentUserData&&(currentUserData.role==='teacher'||currentUserData.role==='class_teacher'||currentUserData.role==='art_school_teacher'||currentUserData.role==='music_teacher'))return document.getElementById('t-class-selector').value;return currentUserData?currentUserData.class:'class_2';}
window.getTodayLessonsFlattened=function(dayName){if(!window.schedule||!window.schedule[dayName])return[];let flat=[];window.schedule[dayName].forEach(slot=>{if(Array.isArray(slot))flat.push(...slot);else if(slot&&Object.keys(slot).length>0)flat.push(slot);});return flat;};
window.getValidSubjectName=function(item){if(!item)return null;let sName=item.subject&&item.subject.ua?item.subject.ua:item.subject;if(sName&&typeof sName==='string'&&sName.trim()!=="Перерва"&&item.number!==" ")return sName.trim();return null;};
window.isSubjectAllowed=function(cls,subjectName){if(!subjectName)return false;let raw=teacherAccessMatrix[cls]||[];let allowed=Array.isArray(raw)?raw:Object.values(raw);let normAllowed=allowed.map(s=>typeof s==='string'?s.trim():'');if(normAllowed.includes("Всі предмети"))return true;return normAllowed.includes(subjectName.trim());};
window.getDefaultTeacher=function(clsId,subjName){if(!subjName||!globalTeacherAccess)return null;let nt=subjName.trim().toLowerCase();for(let se in globalTeacherAccess){if(globalTeacherAccess[se][clsId]){let a=globalTeacherAccess[se][clsId];let ok=false;if(Array.isArray(a))ok=a.some(s=>s.trim().toLowerCase()==="всі предмети"||s.trim().toLowerCase()===nt);else ok=Object.values(a).some(s=>s.trim().toLowerCase()==="всі предмети"||s.trim().toLowerCase()===nt);if(ok){let t=window.globalTeachersList.find(t=>t.safeEmail===se);if(t)return{email:t.email,name:t.name};}}}return null;};
window.loadScheduleScript=function(classId,callback){if(!classId)return;get(child(ref(db),`schedules/${classId}`)).then(snap=>{if(snap.exists()){window.schedule=snap.val().lessons||{};window.clubSchedule=snap.val().clubs||{};}else{window.schedule={};window.clubSchedule={};}if(callback)callback();}).catch(()=>{window.schedule={};window.clubSchedule={};if(callback)callback();});};
// Pure helper shared by director stats/dashboard and parent/student weekly behavior view
export function getWeekDates(ds){if(!ds)return[];let[y,m,d]=ds.split('-');let dt=new Date(y,m-1,d);let day=dt.getDay()||7;dt.setDate(dt.getDate()-day+1);let dates=[];for(let i=0;i<7;i++){const yy=dt.getFullYear(),mm=String(dt.getMonth()+1).padStart(2,'0'),dd=String(dt.getDate()).padStart(2,'0');dates.push(`${yy}-${mm}-${dd}`);dt.setDate(dt.getDate()+1);}return dates;}
// Pure helper shared by teacher daily HW list and parent/student daily HW lists
export function renderHwItem(subject,data){let text=typeof data==='string'?data:data.text;let img='';if(typeof data==='object'){img+='<div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:7px;">';const addImg=u=>{const su=safeHttpUrl(u);if(su)img+=`<a href="${escHtml(su)}" target="_blank"><img src="${escHtml(su)}" style="width:90px;height:90px;object-fit:cover;border-radius:7px;"></a>`;};if(data.image)addImg(data.image);if(data.images&&Array.isArray(data.images))data.images.forEach(addImg);img+='</div>';}return `<li><b>${escHtml(subject)}:</b> ${escHtml(text)} ${img}</li>`;}
// ══════════ ATTENDANCE (per-lesson schema) ══════════
// Since attendance/{cls}/{date}/{student} is now {slotKey:{status,reason,markedBy}}
// instead of a single flat {status,reason} record, these two helpers are shared
// by every screen that reads attendance (journal, admin/director dashboards,
// teacher live list, parent/student dashboards).
// "all" is the reserved slotKey parent/student self-reports are written under
// (submitAttendance() in parent-student.js) — it represents "the whole day".
export function formatAttendanceSlotLabel(slotKey){
  if(slotKey==='all')return 'Увесь день';
  if(/^\d+$/.test(String(slotKey)))return `Урок ${slotKey}`;
  return slotKey;
}
// Collapses a student's slot-map for one day into a single {status,reason}
// summary (absent takes priority over late) — used where UI space only
// allows one badge per day (e.g. the journal table cell).
export function summarizeAttendanceSlots(slotsObj){
  if(!slotsObj)return null;
  const entries=Object.values(slotsObj).filter(r=>r&&r.status);
  if(entries.length===0)return null;
  const chosen=entries.find(r=>r.status==='absent')||entries[0];
  const reasons=[...new Set(entries.map(r=>r.reason).filter(Boolean))];
  return {status:chosen.status,reason:reasons.join('; ')};
}
// ══════════ PROFILE ══════════
function updateProfileBar(){
  if(!currentUserData)return;document.getElementById('profile-bar').style.display='flex';
  const src=currentUserData.photoURL||"https://cdn-icons-png.flaticon.com/512/149/149071.png";
  document.getElementById('pb-avatar').src=src;document.getElementById('modal-avatar-preview').src=src;
  let n="Користувач";if(currentUserData.firstName||currentUserData.lastName)n=`${currentUserData.firstName||''} ${currentUserData.lastName||''}`.trim();else if(currentUserData.studentName)n=`Батьки (${currentUserData.studentName})`;else if(currentUserData.email)n=currentUserData.email;
  let r="";if(currentUserData.role==='teacher')r="Вчитель";if(currentUserData.role==='class_teacher')r="🎓 Класний керівник";if(currentUserData.role==='art_school_teacher'||currentUserData.role==='music_teacher')r="Вчитель школи мистецтв";if(currentUserData.role==='director')r="Директор";if(currentUserData.role==='administrator')r="🛡️ Секретар (Адміністратор)";if(currentUserData.role==='student')r="🎒 Учень";if(currentUserData.role==='parent'){if(currentUserData.parentRole==='mother')r="Мати";else if(currentUserData.parentRole==='father')r="Батько";else r="Опекун";}
  document.getElementById('pb-name').innerText=n;document.getElementById('pb-role').innerText=r;
  renderRoleSwitcher();
  renderChildSwitcher();
}
// Перемикач дітей — показується батькам, у яких у школі більше однієї дитини.
function renderChildSwitcher(){
  const box=document.getElementById('pb-child-switcher');
  if(!box)return;
  const kids=currentUserData?.role==='parent'?getUserChildren(currentUserData):[];
  if(kids.length<2){box.style.display='none';box.innerHTML='';return;}
  box.style.display='block';
  box.innerHTML=`<select id="pb-child-select" title="Переключити дитину">
    ${kids.map((k,i)=>`<option value="${i}" ${k.studentName===currentUserData.studentName&&k.class===currentUserData.class?'selected':''}>👶 ${escHtml(k.studentName)} (${escHtml(String(k.class||'').replace('class_',''))} кл.)</option>`).join('')}
  </select>`;
  document.getElementById('pb-child-select').addEventListener('change',e=>window.switchChild(parseInt(e.target.value,10)));
}
// Активна дитина зберігається в users/{uid}, тож після перезаходу батьки
// потрапляють до тієї самої дитини, яку дивилися востаннє.
window.switchChild=async function(idx){
  if(!currentUserData)return;
  const kids=getUserChildren(currentUserData);
  const k=kids[idx];
  if(!k)return;
  if(k.studentName===currentUserData.studentName&&k.class===currentUserData.class)return;
  // Знімаємо таймер розкладу попередньої дитини
  if(parentLessonInterval)clearInterval(parentLessonInterval);
  currentUserData.studentName=k.studentName;
  currentUserData.class=k.class;
  currentUserData.parentRole=k.role||currentUserData.parentRole||'guardian';
  try{await update(ref(db,`users/${auth.currentUser.uid}`),{studentName:k.studentName,class:k.class,parentRole:currentUserData.parentRole});}catch(e){console.error(e);}
  // Розклад прив'язаний до класу — перечитуємо під нову дитину
  loadScheduleScript(k.class,()=>{initUserSession();});
  showToast(`👶 Дитина: ${k.studentName}`);
};
// Перемикач кабінетів — показується лише тим, у кого призначено >1 ролі.
function renderRoleSwitcher(){
  const box=document.getElementById('pb-role-switcher');
  if(!box)return;
  const roles=getUserRoles(currentUserData);
  if(roles.length<2){box.style.display='none';box.innerHTML='';return;}
  box.style.display='block';
  box.innerHTML=`<select id="pb-role-select" title="Переключити кабінет">
    ${roles.map(r=>`<option value="${escHtml(r)}" ${r===currentUserData.role?'selected':''}>${escHtml(ROLE_LABELS[r]||r)}</option>`).join('')}
  </select>`;
  document.getElementById('pb-role-select').addEventListener('change',e=>window.switchRole(e.target.value));
}
// ══════════ ПЕРЕКЛЮЧЕННЯ РОЛІ ══════════
// Активна роль зберігається в users/{uid}/role, тому після перезаходу людина
// опиняється в тому ж кабінеті, де працювала останній раз.
window.switchRole=async function(newRole){
  if(!currentUserData)return;
  const roles=getUserRoles(currentUserData);
  if(!roles.includes(newRole)){showToast('⚠️ Ця роль вам не призначена');return;}
  if(newRole===currentUserData.role)return;
  // Знімаємо слухачі/таймери попереднього кабінету, щоб вони не продовжували
  // писати у DOM, якого вже немає на екрані.
  if(teacherAttendanceListener)teacherAttendanceListener();
  if(parentLessonInterval)clearInterval(parentLessonInterval);
  currentUserData.role=newRole;
  try{await update(ref(db,`users/${auth.currentUser.uid}`),{role:newRole});}catch(e){console.error(e);}
  if(isTeacherRole(newRole))await fetchTeacherAccess(currentUserData.email.replace(/\./g,'_'));
  initUserSession();
  showToast(`🔄 Кабінет: ${ROLE_LABELS[newRole]||newRole}`);
};
window.openProfileModal=async function(){
  document.getElementById('profile-modal').style.display='flex';
  document.getElementById('profile-first-name').value=currentUserData.firstName||'';
  document.getElementById('profile-last-name').value=currentUserData.lastName||'';
  document.getElementById('profile-photo').value='';document.getElementById('profile-new-pass').value='';
  const isTeacher=currentUserData.role==='teacher'||currentUserData.role==='art_school_teacher';
  document.getElementById('t-skills-section').style.display=isTeacher?'block':'none';
  if(isTeacher){
    const se=currentUserData.email?.replace(/\./g,'_');
    const snap=await get(ref(db,`teacher_skills/${se}/subjects`));
    mySkillsTemp=snap.exists()?Object.values(snap.val()):[];renderMySkillsTags();
  }
};
window.closeProfileModal=function(){document.getElementById('profile-modal').style.display='none';};
document.getElementById('profile-photo').addEventListener('change',function(e){if(e.target.files&&e.target.files[0]){const r=new FileReader();r.onload=function(e){document.getElementById('modal-avatar-preview').src=e.target.result;};r.readAsDataURL(e.target.files[0]);}});
window.saveProfile=async function(){
  const fName=document.getElementById('profile-first-name').value.trim();const lName=document.getElementById('profile-last-name').value.trim();
  const fileInput=document.getElementById('profile-photo');const newPass=document.getElementById('profile-new-pass').value.trim();
  const btn=document.getElementById('btn-save-profile');btn.disabled=true;btn.innerText="⏳ Збереження...";
  if(newPass){if(newPass.length<6){alert("Пароль мінімум 6 символів!");btn.disabled=false;btn.innerText="💾 Зберегти";return;}try{await updatePassword(auth.currentUser,newPass);document.getElementById('profile-new-pass').value='';}catch(e){if(e.code==='auth/requires-recent-login')alert("Для зміни пароля потрібно переввійти.");else alert("Помилка: "+e.message);btn.disabled=false;btn.innerText="💾 Зберегти";return;}}
  let photoURL=currentUserData.photoURL||"https://cdn-icons-png.flaticon.com/512/149/149071.png";
  if(fileInput.files.length>0){const fd=new FormData();fd.append('file',fileInput.files[0]);fd.append('upload_preset',UPLOAD_PRESET);try{const rs=await fetch(CLOUDINARY_URL,{method:'POST',body:fd});const dt=await rs.json();photoURL=dt.secure_url;}catch(e){alert("Помилка фото!");btn.disabled=false;btn.innerText="💾 Зберегти";return;}}
  try{
    await update(ref(db,`users/${auth.currentUser.uid}`),{firstName:fName,lastName:lName,photoURL});
    currentUserData.firstName=fName;currentUserData.lastName=lName;currentUserData.photoURL=photoURL;
    // Save skills
    const isTeacher=currentUserData.role==='teacher'||currentUserData.role==='art_school_teacher';
    if(isTeacher){const se=currentUserData.email?.replace(/\./g,'_');await set(ref(db,`teacher_skills/${se}/subjects`),mySkillsTemp);}
    updateProfileBar();closeProfileModal();showToast("✅ Профіль оновлено!");
  }catch(e){alert("Помилка: "+e.message);}
  btn.disabled=false;btn.innerText="💾 Зберегти";
};
// My skills in profile
window.addMySkill=function(){const v=document.getElementById('t-skill-add-input').value.trim();if(!v)return;if(!mySkillsTemp.includes(v))mySkillsTemp.push(v);document.getElementById('t-skill-add-input').value='';renderMySkillsTags();};
function renderMySkillsTags(){const c=document.getElementById('t-my-skills-tags');c.innerHTML='';mySkillsTemp.forEach((s,i)=>c.innerHTML+=`<span class="skill-tag remove" onclick="removeMySkill(${i})">✖ ${escHtml(s)}</span>`);if(mySkillsTemp.length===0)c.innerHTML='<p class="empty-msg" style="font-size:.8rem;">Скілів немає.</p>';}
window.removeMySkill=function(i){mySkillsTemp.splice(i,1);renderMySkillsTags();};
// ══════════ DATE / CLASS CHANGE ══════════
window.handleDateChange=function(){
  if(!currentUserData)return;
  if(currentUserData.role==='teacher'||currentUserData.role==='class_teacher'||currentUserData.role==='art_school_teacher'||currentUserData.role==='music_teacher'){updateSubjectList();loadTeacherDashboard();loadCurrentTopicAndHW();listenTeacherAttendance();}
  else if(currentUserData.role==='director'){loadDirectorDashboard();document.getElementById('d-detail-hw-class')&&(document.getElementById('d-detail-hw-class').value='');}
  else if(currentUserData.role==='administrator'){loadAdminDashboard();}
  else if(currentUserData.role==='student'){loadStudentDashboard();}
  else{loadParentDashboard();}
};
window.handleClassChange=function(){
  const ac=getActiveClass();if(!ac)return;
  const sel=document.getElementById('t-class-selector');const label=sel.options[sel.selectedIndex].text;
  document.getElementById('teacher-dashboard-title').innerText=`👨‍🏫 Журнал: ${label}`;
  loadStudentsList();loadScheduleScript(ac,()=>handleDateChange());
  checkCurriculumUploadAccess(); /* CURRICULUM v3 */
};
// Предмети НЕ зберігаються окремим списком — вони беруться з РОЗКЛАДУ класу
// (schedules/{clas}/lessons/{день}) і додатково фільтруються матрицею доступу
// вчителя. Тому «порожньо» означає одне з трьох, і раніше всі три випадки
// показувались однаковим текстом «Немає предметів на цей день», через що
// незрозуміло, що робити. Тепер розрізняємо.
function updateSubjectList(){
  const cls=getActiveClass();const dateStr=document.getElementById('global-date').value;
  const [y,m,d]=dateStr.split('-');const dv=new Date(y,m-1,d);const dn=dayKeys[dv.getDay()];
  const flat=window.getTodayLessonsFlattened(dn);
  const allSubjs=[...new Set(flat.map(window.getValidSubjectName).filter(Boolean))];
  const subjs=allSubjs.filter(s=>window.isSubjectAllowed(cls,s));
  const sel=document.getElementById('t-subject');sel.innerHTML='';
  const sc=document.getElementById('t-subject-for-comment');if(sc)sc.innerHTML='';
  subjs.forEach(s=>{
    [sel,sc].forEach(el=>{if(el){const o=document.createElement('option');o.value=s;o.innerText=s;el.appendChild(o.cloneNode(true));}});
  });
  if(subjs.length===0){
    // Чи є взагалі розклад у цього класу (хоч на якийсь день тижня)?
    const hasAnySchedule=window.schedule&&Object.keys(window.schedule).length>0&&
      dayKeys.some(k=>(window.getTodayLessonsFlattened(k)||[]).some(i=>window.getValidSubjectName(i)));
    let msg;
    if(!hasAnySchedule)msg='⚠️ Розклад класу не заповнено — додайте уроки в «🗓️ Розклад»';
    else if(allSubjs.length===0)msg='На цей день у розкладі уроків немає';
    else msg='⛔ Вам не надано доступ до предметів цього дня';
    sel.innerHTML=`<option value="" disabled>${msg}</option>`;
  }
}
// ══════════ AUTH ══════════
onAuthStateChanged(auth,async user=>{
  // Людина перейшла за посиланням із листа відновлення пароля — показуємо
  // сторінку встановлення нового пароля і не чіпаємо звичайний вхід.
  if(hasPendingAuthAction()){initPasswordResetScreen();return;}
  document.querySelectorAll('.panel').forEach(p=>p.style.display='none');document.getElementById('calendar-block').style.display='none';document.getElementById('profile-bar').style.display='none';
  if(user){
    const se=user.email.replace(/\./g,'_');
    const snap=await get(child(ref(db),`users/${user.uid}`));
    if(snap.exists()){
      currentUserData=snap.val();
      // Доступ відкликано директором — не пускаємо, навіть якщо акаунт існує.
      // (Видалити сам акаунт Firebase Auth з браузера неможливо — лише через
      //  Admin SDK, тому "видалення співробітника" = відкликання доступу.)
      if(currentUserData.disabled){alert("Ваш доступ до системи закрито. Зверніться до адміністрації.");signOut(auth);return;}
      if(!currentUserData.email){currentUserData.email=user.email;update(ref(db,`users/${user.uid}`),{email:user.email});}
      // CHILD SYNC: список дітей веде вчитель у parent_links, тож звіряємо його
      // при кожному вході — інакше друга дитина, прив'язана пізніше, не
      // з'явилася б у батьків, які вже колись заходили.
      if(currentUserData.role==='parent'){
        try{
          const pl=await get(child(ref(db),`parent_links/${se}`));
          if(pl.exists()){
            const kids=normalizeChildren(pl.val());
            const known=getUserChildren(currentUserData);
            const same=kids.length===known.length&&kids.every((k,i)=>k.studentName===known[i]?.studentName&&k.class===known[i]?.class);
            if(kids.length>0&&!same){
              currentUserData.children=kids;
              // Активну дитину зберігаємо, якщо вона ще прив'язана
              const still=kids.find(k=>k.studentName===currentUserData.studentName&&k.class===currentUserData.class);
              const act=still||kids[0];
              currentUserData.studentName=act.studentName;currentUserData.class=act.class;
              currentUserData.parentRole=act.role||currentUserData.parentRole||'guardian';
              await update(ref(db,`users/${user.uid}`),{children:kids,studentName:act.studentName,class:act.class,parentRole:currentUserData.parentRole});
            }
          }
        }catch(e){console.warn('Child sync skipped:',e.message);}
      }
      // ROLE SYNC: pre_approved_roles is the director-controlled source of truth for
      // STAFF roles, but it used to be read only when users/{uid} didn't exist yet
      // (i.e. on the very first login ever). That meant a later role change —
      // whether via "Управління персоналом" or edited by hand in the Firebase
      // console — never reached an account that had already logged in once: the
      // stale role in users/{uid} won forever (this is why re-assigning "Директор"
      // to an existing account kept opening the administrator panel).
      // Now every login reconciles the two. Parent/student roles are derived from
      // parent_links/student_links, never from pre_approved_roles, so they're left
      // alone unless an entry explicitly exists for that email.
      // Тепер синхронізуємо ВЕСЬ набір ролей, а не одну: директор міг додати
      // другу роль (напр. вчитель + адміністратор) вже після першого входу.
      try{
        const prs=await get(child(ref(db),`pre_approved_roles/${se}`));
        if(prs.exists()){
          const approved=normalizeRoles(prs.val());
          const known=getUserRoles(currentUserData);
          const same=approved.length===known.length&&approved.every(r=>known.includes(r));
          if(approved.length>0&&!same){
            currentUserData.roles=approved;
            // Активну роль зберігаємо, якщо вона ще дозволена; інакше беремо першу.
            if(!approved.includes(currentUserData.role))currentUserData.role=approved[0];
            await update(ref(db,`users/${user.uid}`),{roles:approved,role:currentUserData.role});
          }
        }
      }catch(e){console.warn('Role sync skipped:',e.message);}
      if(isTeacherRole(currentUserData.role))await fetchTeacherAccess(se);
      await loadGradeTypesCache();initUserSession();
    }
    else{const rs=await get(child(ref(db),`pre_approved_roles/${se}`));if(rs.exists()){const roles=normalizeRoles(rs.val());const primary=roles[0];const nd={role:primary,roles,email:user.email};if(isTeacherRole(primary))await fetchTeacherAccess(se);await set(ref(db,`users/${user.uid}`),nd);currentUserData=nd;await loadGradeTypesCache();initUserSession();}
    else{const ls=await get(child(ref(db),`parent_links/${se}`));if(ls.exists()){
      // Дітей може бути кілька; studentName/class зберігаємо як АКТИВНУ дитину,
      // щоб уся наявна логіка (getActiveClass, дашборди) працювала без змін.
      const kids=normalizeChildren(ls.val());
      const first=kids[0]||{studentName:'',class:'class_2',role:'guardian'};
      const nd={role:"parent",children:kids,studentName:first.studentName,class:first.class,parentRole:first.role||'guardian',email:user.email};
      await set(ref(db,`users/${user.uid}`),nd);currentUserData=nd;await loadGradeTypesCache();initUserSession();}else{const sls=await get(child(ref(db),`student_links/${se}`));if(sls.exists()){const sd=sls.val();const nd={role:"student",studentName:sd.studentName,class:sd.class,email:user.email};await set(ref(db,`users/${user.uid}`),nd);currentUserData=nd;await loadGradeTypesCache();initUserSession();}else{alert("Ваш Email не зареєстровано.");signOut(auth);}}}}
  }else document.getElementById('login-screen').style.display='block';
});
async function fetchTeacherAccess(se){const s=await get(child(ref(db),`teacher_access/${se}`));teacherAccessMatrix=s.exists()?s.val():{};}
function initUserSession(){
  // Приховуємо всі кабінети перед відкриттям потрібного — обов'язково для
  // switchRole(), інакше попередній кабінет залишиться на екрані поверх нового.
  document.querySelectorAll('.panel').forEach(p=>p.style.display='none');
  document.getElementById('calendar-block').style.display='block';updateProfileBar();
  const r=currentUserData.role;
  if(r==='director'){document.getElementById('director-screen').style.display='block';document.getElementById('teacher-class-selector-box').style.display='none';loadTeachersListForDirector();loadDirectorTeacherSkillsList();handleDateChange();loadDrafts();if(window.loadBellCoverage)window.loadBellCoverage();}
  else if(r==='administrator'){document.getElementById('admin-screen').style.display='block';document.getElementById('teacher-class-selector-box').style.display='none';handleDateChange();}
  else if(r==='teacher'||r==='class_teacher'||r==='art_school_teacher'||r==='music_teacher'){
    document.getElementById('teacher-screen').style.display='block';document.getElementById('teacher-class-selector-box').style.display='block';
    const isArt=r==='art_school_teacher';
    document.getElementById('t-matrix-btn-wrapper').style.display=isArt?'block':'none';
    document.getElementById('t-mark-absent-block').style.display=isArt?'none':'flex';
    document.getElementById('t-exams-journal-btns').style.display=isArt?'none':'flex';
    document.getElementById('t-wrapped-btn').style.display=isArt?'none':'block';
    document.getElementById('t-hw-list-wrapper').style.display=isArt?'none':'block';
    document.getElementById('t-hw-input-wrapper').style.display=isArt?'none':'block';
    document.getElementById('t-topic-card').style.display=isArt?'none':'block';
    const cs=document.getElementById('t-class-selector');cs.innerHTML='';
    Object.keys(teacherAccessMatrix).forEach(c=>cs.innerHTML+=`<option value="${c}">${c.replace('class_','')} Клас</option>`);
    if(cs.options.length===0){
      if(isArt)cs.innerHTML='<option value="class_1">1 Клас</option>';
      else{
        // No teacher_access entries at all. Previously this fired a bare
        // "Класи не призначено." alert and returned, leaving a blank screen with
        // no explanation of what to do. Now the screen itself explains it.
        cs.innerHTML='<option value="" disabled>Класи не призначено</option>';
        const banner=document.createElement('div');
        banner.className='data-card';
        banner.style.cssText='border-left-color:var(--orange);background:#fff8e1;';
        banner.innerHTML='<h4 style="margin-top:0;color:#e65100;">⚠️ Класи ще не призначено</h4><p style="font-size:.85rem;color:#555;margin:0;">Директор має надати вам доступ до класу (Кабінет директора → «Матриця доступу вчителів»). Якщо ви класний керівник — доступ призначається автоматично при призначенні на клас.</p>';
        const screen=document.getElementById('teacher-screen');
        screen.insertBefore(banner,screen.querySelector('.screen-section'));
        return;
      }
    }
    window.handleClassChange();
  }
  else if(r==='student'){
    document.getElementById('student-screen').style.display='block';
    const cn=currentUserData.class.replace('class_','');document.getElementById('s-schedule-link').href=`https://planlekcjipush.netlify.app/class-${cn}`;
    loadScheduleScript(currentUserData.class,()=>handleDateChange());
    loadTextbooksForParent('student');
  }
  else{
    document.getElementById('parent-screen').style.display='block';
    const cn=currentUserData.class.replace('class_','');document.getElementById('p-schedule-link').href=`https://planlekcjipush.netlify.app/class-${cn}`;
    loadScheduleScript(currentUserData.class,()=>handleDateChange());
    renderPaymentsMockup();loadTextbooksForParent();
  }
}
// ══════════ ЕКРАНИ ВХОДУ ══════════
// Два ОКРЕМІ екрани, а не один з режимом:
//   #login-screen        — звичайний вхід
//   #first-login-screen  — створення пароля при першому вході
// Обробники submit навішені атрибутом onsubmit прямо в HTML (див. cabinet.html),
// тому форма фізично не може піти звичайним GET-запитом навіть якщо цей модуль
// не виконався — інакше пароль потрапляє в адресний рядок.
// email скрізь у нижньому регістрі: директор зберігає pre_approved_roles через
// .toLowerCase(), тож "Ivan@School.com" інакше не знаходив свій дозвіл.
const emailKey=e=>String(e||'').trim().toLowerCase().replace(/\./g,'_');
function setBusy(btnId,on,label){
  const b=document.getElementById(btnId);
  if(!b)return;
  b.disabled=on;
  if(on){b.dataset.label=b.innerText;b.innerText='⏳ Зачекайте...';}
  else b.innerText=label||b.dataset.label||b.innerText;
}
function setMsg(id,msg,cls){
  const el=document.getElementById(id);
  if(!el)return;
  el.innerHTML=msg||'';
  if(cls!==undefined)el.className=cls;
  el.style.display=msg?'block':'none';
}
// ── перемикання екранів ──
window.showFirstLoginScreen=function(prefillEmail,hint){
  document.getElementById('login-screen').style.display='none';
  document.getElementById('first-login-screen').style.display='block';
  const em=document.getElementById('fl-email');
  const src=prefillEmail||document.getElementById('email').value;
  if(em&&src)em.value=String(src).trim().toLowerCase();
  setMsg('fl-error','');
  setMsg('fl-hint',hint||'','login-hint');
  (em&&!em.value?em:document.getElementById('fl-pass'))?.focus();
};
window.showLoginScreen=function(prefillEmail,hint){
  document.getElementById('first-login-screen').style.display='none';
  document.getElementById('login-screen').style.display='block';
  const em=document.getElementById('email');
  if(em&&prefillEmail)em.value=String(prefillEmail).trim().toLowerCase();
  setMsg('login-error','');
  setMsg('login-hint',hint||'','login-hint');
  (em&&!em.value?em:document.getElementById('pass'))?.focus();
};
window.togglePassVisibility=function(inputId,btnId){
  const p=document.getElementById(inputId||'pass');
  const b=document.getElementById(btnId||'pass-toggle');
  if(!p)return;
  const show=p.type==='password';
  p.type=show?'text':'password';
  if(b){b.innerText=show?'🙈':'👁';b.setAttribute('aria-label',show?'Сховати пароль':'Показати пароль');}
};
// Чи додала школа цей email (три можливі джерела дозволу)
async function isEmailApproved(rawEmail){
  const se=emailKey(rawEmail);
  if(!se)return false;
  const [rs,ls,sls]=await Promise.all([
    get(child(ref(db),`pre_approved_roles/${se}`)),
    get(child(ref(db),`parent_links/${se}`)),
    get(child(ref(db),`student_links/${se}`))
  ]);
  return rs.exists()||ls.exists()||sls.exists();
}
const AUTH_ERRORS={
  'auth/invalid-email':'Невірний формат email.',
  'auth/too-many-requests':'Забагато спроб. Спробуйте за кілька хвилин.',
  'auth/network-request-failed':"Немає зв'язку із сервером. Перевірте інтернет.",
  'auth/user-disabled':'Цей акаунт відключено. Зверніться до адміністрації.',
  'auth/weak-password':'Пароль занадто простий (мінімум 6 символів).'
};
// ── ЗВИЧАЙНИЙ ВХІД ──
window.submitLogin=async function(ev){
  if(ev&&ev.preventDefault)ev.preventDefault();
  const email=document.getElementById('email').value.trim().toLowerCase();
  const pass=document.getElementById('pass').value;
  setMsg('login-error','');setMsg('login-hint','','login-hint');
  if(!email||!pass){setMsg('login-error','Введіть email і пароль.','login-err');return false;}
  setBusy('btn-login-submit',true);
  try{
    await signInWithEmailAndPassword(auth,email,pass);
    // Успіх — onAuthStateChanged сам відкриє потрібний кабінет.
  }catch(err){
    setBusy('btn-login-submit',false,'Увійти');
    const code=err&&err.code||'';
    if(code==='auth/user-not-found'){
      if(await isEmailApproved(email))
        window.showFirstLoginScreen(email,'Схоже, це ваш <b>перший вхід</b> — акаунта ще немає. Придумайте пароль нижче.');
      else
        setMsg('login-error','Цей email не зареєстровано у школі.','login-err');
      return false;
    }
    if(code==='auth/invalid-credential'||code==='auth/wrong-password'){
      // Firebase із захистом від перебору не розрізняє "немає акаунта" і
      // "невірний пароль", тому підказуємо обидва варіанти.
      setMsg('login-error','Невірний email або пароль.','login-err');
      if(await isEmailApproved(email))
        setMsg('login-hint','Якщо ви входите <b>вперше</b> — натисніть «Перший вхід? Встановити пароль» внизу.','login-hint warn');
      return false;
    }
    setMsg('login-error',AUTH_ERRORS[code]||('Помилка входу: '+(err.message||code)),'login-err');
  }
  return false;
};
// ── ПЕРШИЙ ВХІД (створення пароля) ──
window.submitFirstLogin=async function(ev){
  if(ev&&ev.preventDefault)ev.preventDefault();
  const email=document.getElementById('fl-email').value.trim().toLowerCase();
  const p1=document.getElementById('fl-pass').value;
  const p2=document.getElementById('fl-pass2').value;
  setMsg('fl-error','');
  if(!email||!p1){setMsg('fl-error','Заповніть email і пароль.','login-err');return false;}
  if(p1.length<6){setMsg('fl-error','Пароль має бути не коротшим за 6 символів.','login-err');return false;}
  if(p1!==p2){setMsg('fl-error','Паролі не збігаються.','login-err');return false;}
  setBusy('btn-fl-submit',true);
  try{
    if(!await isEmailApproved(email)){
      setBusy('btn-fl-submit',false,'Встановити пароль і увійти');
      setMsg('fl-error','Цей email ще не додано школою. Зверніться до класного керівника або директора.','login-err');
      return false;
    }
    await createUserWithEmailAndPassword(auth,email,p1);
  }catch(err){
    setBusy('btn-fl-submit',false,'Встановити пароль і увійти');
    const code=err&&err.code||'';
    if(code==='auth/email-already-in-use'){
      window.showLoginScreen(email,'Акаунт із таким email вже існує — увійдіть своїм паролем.');
      return false;
    }
    setMsg('fl-error',AUTH_ERRORS[code]||('Помилка: '+(err.message||code)),'login-err');
  }
  return false;
};
// ── ВІДНОВЛЕННЯ ПАРОЛЯ ──
// Пароль зберігається у Firebase Auth, а НЕ в базі даних порталу. Тому
// видалення й повторне створення email+ролі в «Управлінні персоналом» пароль
// не змінює — акаунт лишається зі старим паролем. Єдиний коректний шлях —
// лист для відновлення (або скидання вручну у Firebase Console).
export async function sendPasswordReset(rawEmail){
  const email=String(rawEmail||'').trim().toLowerCase();
  if(!email)throw new Error('Вкажіть email.');
  // continueUrl додає в лист кнопку «Продовжити», яка повертає людину на
  // портал. Але Firebase приймає його ЛИШЕ якщо домен є в
  // Authentication → Settings → Authorized domains, інакше кидає
  // auth/unauthorized-continue-uri і лист не надсилається взагалі.
  // Тому: пробуємо з кнопкою повернення, а якщо домен не дозволений —
  // мовчки надсилаємо звичайний лист. Відновлення пароля важливіше за
  // зручність повернення і не має залежати від налаштувань консолі.
  const origin=window.location.origin;
  const canUseContinue=/^https?:/i.test(origin); // file:// не підходить
  if(canUseContinue){
    try{
      await sendPasswordResetEmail(auth,email,{url:origin+window.location.pathname,handleCodeInApp:false});
      return email;
    }catch(err){
      if(!err||err.code!=='auth/unauthorized-continue-uri')throw err;
      console.warn(
        `[Push School] Домен ${origin} не дозволений у Firebase.\n`+
        `Лист надіслано БЕЗ кнопки повернення на портал.\n`+
        `Щоб додати кнопку: Firebase Console → Authentication → Settings →\n`+
        `Authorized domains → Add domain → ${location.hostname}`);
    }
  }
  await sendPasswordResetEmail(auth,email);
  return email;
}
// ══════════ СТОРІНКА ВСТАНОВЛЕННЯ НОВОГО ПАРОЛЯ ══════════
// Працює, коли у Firebase Console → Authentication → Templates задано
// "Customize action URL" на адресу цієї сторінки. Тоді посилання з листа веде
// СЮДИ (з параметрами ?mode=resetPassword&oobCode=...), і людина взагалі не
// потрапляє на сторінку Firebase — усе відбувається на порталі, українською.
// Поки custom action URL не налаштований, цей код просто не спрацьовує.
let resetOobCode=null;
export function hasPendingAuthAction(){
  const p=new URLSearchParams(window.location.search);
  return p.get('mode')==='resetPassword'&&!!p.get('oobCode');
}
async function initPasswordResetScreen(){
  const p=new URLSearchParams(window.location.search);
  resetOobCode=p.get('oobCode');
  document.querySelectorAll('.panel').forEach(el=>el.style.display='none');
  const scr=document.getElementById('reset-password-screen');
  if(!scr)return;
  scr.style.display='block';
  try{
    // Перевіряємо код і показуємо, для якої адреси змінюється пароль
    const email=await verifyPasswordResetCode(auth,resetOobCode);
    const box=document.getElementById('rp-email');
    if(box)box.innerHTML=`Встановлення нового пароля для <b>${escHtml(email)}</b>`;
  }catch(err){
    setMsg('rp-error','Посилання недійсне або застаріле. Запросіть новий лист для відновлення пароля.','login-err');
    const form=document.getElementById('reset-password-form');
    if(form)form.style.display='none';
  }
}
window.submitNewPassword=async function(ev){
  if(ev&&ev.preventDefault)ev.preventDefault();
  const p1=document.getElementById('rp-pass').value;
  const p2=document.getElementById('rp-pass2').value;
  setMsg('rp-error','');
  if(p1.length<6){setMsg('rp-error','Пароль має бути не коротшим за 6 символів.','login-err');return false;}
  if(p1!==p2){setMsg('rp-error','Паролі не збігаються.','login-err');return false;}
  setBusy('btn-rp-submit',true);
  try{
    await confirmPasswordReset(auth,resetOobCode,p1);
    // Прибираємо oobCode з адреси, щоб при перезавантаженні не спрацював знову
    window.history.replaceState({},'',window.location.pathname);
    document.getElementById('reset-password-screen').style.display='none';
    window.showLoginScreen('','✅ Пароль змінено. Тепер увійдіть із новим паролем.');
  }catch(err){
    setBusy('btn-rp-submit',false,'Зберегти новий пароль');
    setMsg('rp-error',AUTH_ERRORS[err&&err.code]||('Не вдалося змінити пароль: '+(err.message||'')),'login-err');
  }
  return false;
};
window.requestPasswordReset=async function(){
  const email=document.getElementById('email').value.trim().toLowerCase();
  setMsg('login-error','');
  if(!email){
    setMsg('login-hint','Спочатку введіть свій email у поле вище — і натисніть «Забули пароль?» ще раз.','login-hint warn');
    document.getElementById('email').focus();
    return;
  }
  try{
    await sendPasswordReset(email);
    // Нейтральне формулювання: Firebase із захистом від перебору не повідомляє,
    // чи існує акаунт, тому не стверджуємо це і ми.
    setMsg('login-hint',`📧 Якщо акаунт із адресою <b>${escHtml(email)}</b> існує, ми надіслали на неї лист для встановлення нового пароля.<br><span style="font-size:.76rem;">Перевірте також папку «Спам». Лист дійсний обмежений час.</span>`,'login-hint');
  }catch(err){
    const code=err&&err.code||'';
    setMsg('login-error',AUTH_ERRORS[code]||('Не вдалося надіслати лист: '+(err.message||code)),'login-err');
  }
};
// Сумісність зі старими викликами
window.loginUser=()=>window.submitLogin();
window.registerUser=()=>window.showFirstLoginScreen();
window.logoutUser=function(){if(teacherAttendanceListener)teacherAttendanceListener();if(parentLessonInterval)clearInterval(parentLessonInterval);document.getElementById('profile-bar').style.display='none';signOut(auth);};
// ══════════ ADMIN DASHBOARD ══════════
window.loadAdminDashboard=async function(){try{const date=document.getElementById('global-date').value;document.getElementById('a-att-header').innerText=`🚨 Відсутні (${date.split('-').reverse().slice(0,2).join('.')})`;const wd=getWeekDates(date);let wl=0,wa=0,hw=0,com=0;const[s,hwS,comS]=await Promise.all([get(child(ref(db),'attendance')),get(child(ref(db),'homeworks')),get(child(ref(db),'comments'))]);let h='';if(s.exists()){const d=s.val();for(let i=1;i<=11;i++){const c=`class_${i}`;if(d[c]&&d[c][date])for(let st in d[c][date]){const slots=d[c][date][st];for(let sk in slots){const r=slots[sk];if(r?.status){const bc=r.status==='late'?'badge-late':'badge-absent';const markerIcon=r.markedBy==='teacher'?'👨‍🏫':(r.markedBy==='student'?'🎒':(r.markedBy==='administrator'?'🛡️':'👪'));h+=`<li style="margin-bottom:9px;border-bottom:1px solid #eee;padding-bottom:4px;"><span style="font-size:.72rem;background:var(--teal);color:#fff;padding:2px 5px;border-radius:4px;margin-right:4px;">${i} Кл</span> <b>${escHtml(st)}</b> <span class="badge ${bc}">${r.status==='late'?'Запізнення':'Відсутність'}</span> <span style="font-size:.72rem;color:#888;">${escHtml(formatAttendanceSlotLabel(sk))} ${markerIcon}</span></li>`;}}}
    // Week counters (same aggregation the director dashboard does)
    if(d[c])wd.forEach(w=>{if(d[c][w]&&typeof d[c][w]==='object')Object.values(d[c][w]).forEach(slots=>{if(slots&&typeof slots==='object')Object.values(slots).forEach(r=>{if(r?.status==='late')wl++;else if(r?.status==='absent')wa++;});});});
  }}
  const hd=hwS.exists()?hwS.val():{};const cd=comS.exists()?comS.val():{};
  for(let i=1;i<=11;i++){const c=`class_${i}`;if(hd[c]&&hd[c][date])hw+=Object.keys(hd[c][date]).length;if(cd[c]&&cd[c][date])for(let st in cd[c][date])if(typeof cd[c][date][st]==='object')com+=Object.keys(cd[c][date][st]).length;}
  document.getElementById('a-hw-counter').innerText=hw;document.getElementById('a-com-counter').innerText=com;
  document.getElementById('a-week-late').innerText=wl;document.getElementById('a-week-absent').innerText=wa;
  document.getElementById('a-unified-att-list').innerHTML=h||'<li class="empty-msg">Відсутніх немає.</li>';}catch(e){console.error(e);}};
// ══════════ ADMIN (SECRETARY) — mark absences for any class ══════════
// The secretary takes phone calls from parents and records them centrally, so
// unlike the teacher's version this one isn't scoped to teacher_access — the
// class is picked explicitly. markedBy:'administrator' distinguishes these
// entries in every list that renders an origin icon.
window.loadAdminStudentsForClass=async function(){
  const cls=document.getElementById('a-mark-class').value;
  const sel=document.getElementById('a-mark-student');
  if(!cls){sel.innerHTML='<option value="">Спочатку клас</option>';return;}
  sel.innerHTML='<option value="">Завантаження...</option>';
  const snap=await get(child(ref(db),`students_list/${cls}`));
  sel.innerHTML='<option value="">Учень...</option>';
  if(snap.exists())Object.values(snap.val()).sort().forEach(st=>{const o=document.createElement('option');o.value=st;o.innerText=st;sel.appendChild(o);});
  else sel.innerHTML='<option value="" disabled>Учнів немає</option>';
};
window.adminMarkAbsent=async function(){
  const cls=document.getElementById('a-mark-class').value;
  const st=document.getElementById('a-mark-student').value;
  const reason=document.getElementById('a-mark-reason').value;
  if(!cls||!st)return alert('Оберіть клас та учня!');
  const date=document.getElementById('global-date').value;
  const status=reason==='запізнення'?'late':'absent';
  await set(ref(db,`attendance/${cls}/${date}/${st}/all`),{status,reason,markedBy:'administrator'});
  showToast(`✅ ${st}: ${status==='late'?'запізнення':'відсутність'} (${reason})`);
  loadAdminDashboard();
};
// ══════════ ADMIN — read-only reference views ══════════
window.loadAdminBellSchedule=async function(){
  const cls=document.getElementById('a-bell-class').value;
  const box=document.getElementById('a-bell-view');
  if(!box)return;
  if(!cls){box.innerHTML='<p class="empty-msg">Оберіть клас.</p>';return;}
  box.innerHTML='<p class="empty-msg">Завантаження...</p>';
  const snap=await get(ref(db,`bell_schedules/${cls}`));
  if(!snap.exists()){box.innerHTML='<p class="empty-msg">Розклад дзвінків не задано.</p>';return;}
  const d=snap.val();
  const rows=Object.keys(d).sort((a,b)=>(parseInt(a)||0)-(parseInt(b)||0))
    .map(k=>`<div style="display:flex;justify-content:space-between;padding:6px 9px;background:#fff;border:1px solid #e8eaf6;border-radius:7px;margin-bottom:5px;font-size:.85rem;"><b>Урок ${escHtml(d[k].number??k)}</b><span style="color:#555;">${escHtml(d[k].start||'—')} – ${escHtml(d[k].end||'—')}</span></div>`).join('');
  box.innerHTML=rows||'<p class="empty-msg">Уроків немає.</p>';
};
window.loadAdminAcademicYear=async function(){
  const box=document.getElementById('a-academic-view');
  if(!box)return;
  box.innerHTML='<p class="empty-msg">Завантаження...</p>';
  const snap=await get(ref(db,'academic_year'));
  if(!snap.exists()){box.innerHTML='<p class="empty-msg">Навчальний рік не налаштовано.</p>';return;}
  const years=snap.val();const yearId=Object.keys(years)[0];const y=years[yearId]||{};
  const section=(title,obj,fmt)=>{
    const items=obj?Object.values(obj):[];
    if(items.length===0)return `<h4 style="margin:12px 0 6px 0;color:#e65100;font-size:.86rem;">${title}</h4><p class="empty-msg" style="margin:0;">Немає.</p>`;
    return `<h4 style="margin:12px 0 6px 0;color:#e65100;font-size:.86rem;">${title}</h4>`+
      items.map(it=>`<div style="background:#fff;border:1px solid #ffe0b2;border-radius:7px;padding:6px 9px;margin-bottom:5px;font-size:.83rem;">${fmt(it)}</div>`).join('');
  };
  box.innerHTML=
    section('Семестри',y.semesters,s=>`<b>${escHtml(s.name||'—')}</b><br><span style="color:#666;">${escHtml(s.start||'')} – ${escHtml(s.end||'')}</span>`)+
    section('Канікули',y.breaks,b=>`<b>${escHtml(b.title||'—')}</b><br><span style="color:#666;">${escHtml(b.start||'')} – ${escHtml(b.end||'')}</span>`)+
    section('Свята',y.holidays,h=>`<b>${escHtml(h.title||'—')}</b><br><span style="color:#666;">${escHtml(h.date||'')}</span>`);
};
// ══════════ UNIFIED INBOX (Chat) ══════════
// Used by director-screen, teacher-screen and parent/student-screen alike,
// so it lives here rather than in any single role file.
function getChatId(email1, email2) {
  return [email1, email2].sort().join('___');
}
window.openChatModal = async function(role) {
  document.getElementById('inbox-modal').style.display = 'flex';
  document.getElementById('chat-list-view').style.display = 'flex';
  document.getElementById('chat-detail-view').style.display = 'none';
  renderChatList(role);
};
async function renderChatList(role) {
  const container = document.getElementById('inbox-contacts-list');
  container.innerHTML = '<p class="empty-msg" style="padding:15px;">Завантаження...</p>';
  const myEmailSafe = auth.currentUser.email.replace(/\./g, '_');
  const usersSnap = await get(ref(db, 'users'));
  const allUsers = usersSnap.exists() ? usersSnap.val() : {};
  const getFormattedName = (uEmailSafe) => {
    if (uEmailSafe === 'director_push_school@gmail_com') return '👔 Директор (Адміністрація)';
    let name = uEmailSafe.replace(/_/g, '.');
    for (let uid in allUsers) {
      if (allUsers[uid].email && allUsers[uid].email.replace(/\./g, '_') === uEmailSafe) {
        const u = allUsers[uid];
        const rName = (u.firstName || u.lastName) ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : (u.studentName || u.email);
        let label = '';
        if (u.role === 'teacher' || u.role === 'class_teacher') label = ' (Вчитель)';
        else if (u.role === 'director') label = ' (Директор)';
        else if (u.role === 'administrator') label = ' (Секретар)';
        else if (u.role === 'parent') label = ' (Батьки)';
        else if (u.role === 'student') label = ' (Учень)';
        return rName + label;
      }
    }
    return name;
  };
  if (chatListListener) chatListListener();
  chatListListener = onValue(ref(db, 'chats'), async (snap) => {
    const chats = snap.exists() ? snap.val() : {};
    let html = '';
    const activeContacts = new Map();
    if (role === 'parent' || role === 'student') {
      activeContacts.set('director_push_school@gmail_com', { name: '👔 Директор (Адміністрація)', lastMsg: '', time: 0, unread: 0 });
      const cls = getActiveClass();
      const accSnap = await get(ref(db, 'teacher_access'));
      if (accSnap.exists()) {
        const acc = accSnap.val();
        for (let email in acc) {
          if (acc[email][cls]) {
            activeContacts.set(email, { name: getFormattedName(email), lastMsg: '', time: 0, unread: 0 });
          }
        }
      }
    }
    for (let chatId in chats) {
      const parts = chatId.split('___');
      if (parts.length !== 2) continue;
      const isParticipant = parts.includes(myEmailSafe);
      // The administrator (secretary) gets the same school-wide thread overview as
      // the director — they field parent communication on the school's behalf.
      const isDirector = role === 'director' || role === 'administrator';
      if (isParticipant || isDirector) {
        const messages = chats[chatId].messages ? Object.values(chats[chatId].messages) : [];
        if (messages.length === 0 && !isParticipant) continue;
        const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
        const unreadCount = messages.filter(m => m.from !== myEmailSafe && !m.read).length;
        if (isDirector) {
          let n1 = getFormattedName(parts[0]), n2 = getFormattedName(parts[1]);
          html += `<div class="chat-list-item" onclick="selectChatThread('${chatId}', '💬 ${escJs(n1)} ↔ ${escJs(n2)}')" style="padding:15px; border-bottom:1px solid #eee; cursor:pointer; background:#fff;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <b style="font-size:.95rem; color:var(--purple);">${escHtml(n1)} ↔ ${escHtml(n2)}</b>
              ${unreadCount > 0 ? `<span style="background:var(--red); color:#fff; font-size:.7rem; padding:2px 7px; border-radius:10px;">${unreadCount}</span>` : ''}
            </div>
            <div style="font-size:.8rem; color:#888; margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
              ${lastMsg ? `<b>${escHtml(lastMsg.fromName.split(' ')[0])}:</b> ${escHtml(lastMsg.text)}` : 'Почніть переписку...'}
            </div>
          </div>`;
        } else {
          const otherEmail = parts[0] === myEmailSafe ? parts[1] : parts[0];
          activeContacts.set(otherEmail, {
            name: getFormattedName(otherEmail),
            lastMsg: lastMsg ? lastMsg.text : '',
            time: lastMsg ? lastMsg.time : 0,
            unread: unreadCount
          });
        }
      }
    }
    if (role !== 'director') {
      const sorted = Array.from(activeContacts.entries()).sort((a, b) => b[1].time - a[1].time);
      sorted.forEach(([email, data]) => {
        const cid = getChatId(myEmailSafe, email);
        html += `<div class="chat-list-item" onclick="selectChatThread('${cid}', '${escJs(data.name)}', '${email}')" style="padding:15px; border-bottom:1px solid #eee; cursor:pointer; background:#fff; display:flex; gap:12px; align-items:center;">
          <div style="width:45px; height:45px; border-radius:50%; background:var(--purple); color:#fff; display:flex; align-items:center; justify-content:center; font-weight:800; font-size:1.2rem; flex-shrink:0;">${escHtml(data.name.charAt(0))}</div>
          <div style="flex:1; overflow:hidden;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <b style="font-size:.95rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:80%;">${escHtml(data.name)}</b>
              ${data.unread > 0 ? `<span style="background:var(--red); color:#fff; font-size:.7rem; padding:2px 7px; border-radius:10px; font-weight:700;">${data.unread}</span>` : ''}
            </div>
            <div style="font-size:.82rem; color:#888; margin-top:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
              ${escHtml(data.lastMsg) || 'Повідомлень ще немає'}
            </div>
          </div>
        </div>`;
      });
    }
    container.innerHTML = html || '<p class="empty-msg" style="padding:20px; text-align:center;">У вас ще немає активних чатів.</p>';
  });
}
window.selectChatThread = function(chatId, title, otherEmailSafe = null) {
  currentChatId = chatId;
  document.getElementById('chat-detail-title').innerText = title;
  document.getElementById('chat-list-view').style.display = 'none';
  document.getElementById('chat-detail-view').style.display = 'flex';
  loadChatMessages(chatId);
};
function loadChatMessages(chatId) {
  const list = document.getElementById('inbox-messages-list');
  if (inboxMessagesListener) inboxMessagesListener();
  const myEmailSafe = auth.currentUser.email.replace(/\./g, '_');
  inboxMessagesListener = onValue(ref(db, `chats/${chatId}/messages`), snap => {
    list.innerHTML = '';
    if (snap.exists()) {
      const data = snap.val();
      const msgs = Object.keys(data).map(k => ({ id: k, ...data[k] })).sort((a, b) => a.time - b.time);
      msgs.forEach(m => {
        const isMe = m.from === myEmailSafe;
        const align = isMe ? 'flex-end' : 'flex-start';
        const bg = isMe ? 'var(--purple)' : '#fff';
        const color = isMe ? '#fff' : '#333';
        list.innerHTML += `<div style="align-self:${align}; max-width:85%; background:${bg}; color:${color}; padding:10px 14px; border-radius:15px; box-shadow:0 2px 5px rgba(0,0,0,0.05); margin-bottom:5px;">
          <div style="font-size:.65rem; opacity:.8; margin-bottom:3px; font-weight:700;">${isMe ? 'Я' : escHtml(m.fromName)} • ${new Date(m.time).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}</div>
          <div style="font-size:.92rem; word-break:break-word; line-height:1.4;">${escHtml(m.text)}</div>
        </div>`;
        if (!isMe && !m.read) update(ref(db, `chats/${chatId}/messages/${m.id}`), { read: true });
      });
      list.scrollTop = list.scrollHeight;
    } else list.innerHTML = '<p class="empty-msg">Немає повідомлень. Напишіть що-небудь!</p>';
  });
}
window.backToChatList = function() {
  if (inboxMessagesListener) inboxMessagesListener();
  document.getElementById('chat-detail-view').style.display = 'none';
  document.getElementById('chat-list-view').style.display = 'flex';
  currentChatId = null;
};
window.closeInboxModal = function() {
  document.getElementById('inbox-modal').style.display = 'none';
  if (inboxMessagesListener) inboxMessagesListener();
  if (chatListListener) chatListListener();
};
window.sendInboxMessage = async function() {
  if (!currentChatId) return;
  const input = document.getElementById('msg-text-input');
  const text = input.value.trim();
  if (!text) return;
  const myEmailSafe = auth.currentUser.email.replace(/\./g, '_');
  let roleLabel = '';
  if (currentUserData.role === 'teacher' || currentUserData.role === 'class_teacher') roleLabel = '(Вчитель)';
  else if (currentUserData.role === 'director') roleLabel = '(Директор)';
  else if (currentUserData.role === 'administrator') roleLabel = '(Секретар)';
  else if (currentUserData.role === 'parent') roleLabel = '(Батьки)';
  else if (currentUserData.role === 'student') roleLabel = '(Учень)';
  const myName = (currentUserData.firstName || currentUserData.lastName) ? `${currentUserData.firstName || ''} ${currentUserData.lastName || ''}`.trim() : (currentUserData.studentName || auth.currentUser.email);
  const fullName = `${myName} ${roleLabel}`.trim();
  const msg = { from: myEmailSafe, fromName: fullName, text: text, time: Date.now(), read: false };
  try {
    await push(ref(db, `chats/${currentChatId}/messages`), msg);
    input.value = '';
    const list = document.getElementById('inbox-messages-list');
    list.scrollTop = list.scrollHeight;
  } catch (e) { alert("Помилка: " + e.message); }
};
