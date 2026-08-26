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
import { getMessaging, getToken, onMessage, isSupported as messagingSupported } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-messaging.js";
import { getDatabase, ref, set, get, child, push, onValue, remove, update, query, orderByKey, startAt, endAt } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";

import { loadTeacherDashboard, loadCurrentTopicAndHW, listenTeacherAttendance, teacherAttendanceListener } from './teacher.js';
import { loadDirectorDashboard, loadTeachersListForDirector, loadDirectorTeacherSkillsList, loadDrafts } from './director.js';
import { loadParentDashboard, loadStudentDashboard, loadTextbooksForParent, renderPaymentsMockup, parentLessonInterval } from './parent-student.js';
import { globalTeacherAccess } from './journal.js';
import { checkCurriculumUploadAccess } from './curriculum.js';

export const CLOUD_NAME='duy1qwsqv'; export const UPLOAD_PRESET='ml_default'; export const CLOUDINARY_URL=`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`;
const firebaseConfig={apiKey:"AIzaSyA3OA9pcR1zscUtEPWD8LEKTKonAN5Y90c",authDomain:"test-4eb3e.firebaseapp.com",databaseURL:"https://test-4eb3e-default-rtdb.europe-west1.firebasedatabase.app",projectId:"test-4eb3e",storageBucket:"test-4eb3e.firebasestorage.app",messagingSenderId:"933339787450",appId:"1:933339787450:web:cc87b850ed3b4903f41283"};
export const app=initializeApp(firebaseConfig); export const auth=getAuth(app); export const db=getDatabase(app);

// ══════════ ЧИТАННЯ ДІАПАЗОНУ ДАТ ══════════
// Ключі дат мають вигляд YYYY-MM-DD, тому лексикографічний порядок збігається
// з хронологічним. Це дозволяє попросити Firebase віддати лише потрібний
// відрізок замість усього вузла. Раніше дашборди тягнули ВСЮ відвідуваність
// школи за весь рік, щоб показати один день.
export async function getDateRange(path, from, to){
  try{
    const snap = await get(query(ref(db, path), orderByKey(), startAt(from), endAt(to)));
    return snap.exists() ? snap.val() : {};
  }catch(e){ console.warn('getDateRange', path, e.message); return {}; }
}
// Той самий діапазон, але одразу по всіх класах: {class_1:{дата:{...}}, ...}
export async function getSchoolRange(node, from, to){
  const classes = [];
  for(let i=1;i<=11;i++) classes.push(`class_${i}`);
  const parts = await Promise.all(classes.map(c=>getDateRange(`${node}/${c}`, from, to)));
  const out = {};
  classes.forEach((c,i)=>{ if(parts[i] && Object.keys(parts[i]).length) out[c]=parts[i]; });
  return out;
}

// ══════════ КЕШ КОРИСТУВАЧІВ ══════════
// users читався 15 разів за сеанс. Вузол невеликий і майже не змінюється,
// тож тримаємо копію. Після будь-якого запису список скидається явно —
// інакше директор додасть учителя і не побачить його у списках.
let _usersCache = null, _usersCacheAt = 0;
const USERS_TTL = 30000;
export async function getAllUsers(force){
  const now = Date.now();
  if(!force && _usersCache && now - _usersCacheAt < USERS_TTL) return _usersCache;
  const s = await get(ref(db,'users'));
  _usersCache = s.exists() ? s.val() : {};
  _usersCacheAt = now;
  return _usersCache;
}
// Обгортка з інтерфейсом snapshot: підміняє get(ref(db,'users')) без
// переписування місць виклику.
export async function getUsersSnap(){
  const v = await getAllUsers();
  return { exists: () => !!v && Object.keys(v).length > 0, val: () => v };
}
export function invalidateUsersCache(){ _usersCache = null; }

// ══════════ ДОВІДНИК УЧНІВ: ІДЕНТИФІКАТОР ↔ ІМʼЯ ══════════
// Історично оцінки, відвідуваність і коментарі ключуються ІМЕНЕМ учня.
// Це крихко: двоє тезок зливаються в один запис, а перейменування вимагає
// переносу всієї історії. Постійний ідентифікатор у нас уже є — це ключ
// запису в students_list. Довідник нижче дає переклад в обидва боки й
// готує ґрунт для переходу на ідентифікатори.
const _stuDir = {};            // cls -> {byId:{sid:name}, byName:{nameLower:sid}}
export async function getStudentDir(cls, force){
  if(!force && _stuDir[cls]) return _stuDir[cls];
  const snap = await get(child(ref(db), `students_list/${cls}`));
  const byId = {}, byName = {};
  if(snap.exists()){
    const v = snap.val();
    for(const sid in v){
      const nm = String(v[sid]);
      byId[sid] = nm;
      byName[nm.replace(/\s+/g,' ').trim().toLowerCase()] = sid;
    }
  }
  _stuDir[cls] = { byId, byName };
  return _stuDir[cls];
}
export function invalidateStudentDir(cls){ if(cls) delete _stuDir[cls]; else Object.keys(_stuDir).forEach(k=>delete _stuDir[k]); }
window.invalidateStudentDir = invalidateStudentDir;


// Довідник усіх класів одним читанням на сеанс. students_list маленький
// (кілька сотень рядків), тож тримати його цілком дешевше, ніж ходити
// в базу з кожного місця відображення.
export async function preloadStudentDirs(){
  const snap = await get(child(ref(db), 'students_list'));
  const all = snap.exists() ? snap.val() : {};
  for(const cls in all){
    const byId = {}, byName = {};
    for(const sid in all[cls]){
      const nm = String(all[cls][sid]);
      byId[sid] = nm;
      byName[nm.replace(/\s+/g,' ').trim().toLowerCase()] = sid;
    }
    _stuDir[cls] = { byId, byName };
  }
  return _stuDir;
}
// Синхронний переклад ідентифікатора в імʼя для відображення.
// Якщо ключ невідомий — повертаємо як є: це або старий запис за іменем,
// або учень, якого вже немає в списку. Краще показати, ніж приховати.
window.preloadStudentDirs = preloadStudentDirs;
export function stuName(cls, key){
  const d = _stuDir[cls];
  return (d && d.byId[key]) || key;
}
// Синхронний зворотний переклад — для побудови шляхів
export function stuId(cls, name){
  const d = _stuDir[cls];
  if(!d) return null;
  return d.byName[String(name).replace(/\s+/g,' ').trim().toLowerCase()] || null;
}
window.stuName = stuName;
window.stuId = stuId;

export async function sidOf(cls, name){
  if(!cls || !name) return null;
  const d = await getStudentDir(cls);
  return d.byName[String(name).replace(/\s+/g,' ').trim().toLowerCase()] || null;
}
export async function nameOf(cls, sid){
  if(!cls || !sid) return null;
  const d = await getStudentDir(cls);
  return d.byId[sid] || null;
}
// Ключ може бути як ідентифікатором, так і старим іменем — під час переходу
// в базі трапляється і те, й інше. Повертає завжди відображуване імʼя.
export async function displayStudentKey(cls, key){
  const d = await getStudentDir(cls);
  return d.byId[key] || key;
}

// Дописуємо постійний ідентифікатор у запис користувача. Імʼя лишається
// на місці: код і правила доступу поки спираються на нього.
export async function backfillStudentId(){
  try{
    const u = currentUserData;
    if(!u || !u.class || !u.studentName) return;
    if(u.studentId) return;
    const sid = await sidOf(u.class, u.studentName);
    if(!sid) return;
    u.studentId = sid;
    await update(ref(db, `users/${auth.currentUser.uid}`), { studentId: sid });
  }catch(e){ /* не критично: це підготовка, а не робочий шлях */ }
}

window.invalidateUsersCache = invalidateUsersCache;


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
  parent:'👪 Батьки', student:'🎒 Учень', kitchen:'🍽️ Кухня'
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
// ══════════ КОНТАКТНІ ДАНІ БАТЬКІВ ══════════
// Зберігаються поруч із дітьми: parent_links/{email} = {children:[...], profile:{...}}
// normalizeChildren дивиться лише на children, тож додаткове поле profile
// нічого не ламає і старі записи читаються як раніше.
export const PARENT_FIELDS=[
  {k:'lastName',   label:'Прізвище',        ph:'Іваненко'},
  {k:'firstName',  label:"Ім'я",            ph:'Оксана'},
  {k:'middleName', label:'По батькові',     ph:'Петрівна'},
  {k:'phonePL',    label:'📞 Телефон (PL)', ph:'+48 600 000 000', type:'tel'},
  {k:'phoneUA',    label:'📞 Телефон (UA)', ph:'+380 67 000 00 00', type:'tel'},
  {k:'telegram',   label:'✈️ Telegram',      ph:'@nickname'},
  {k:'address',    label:'🏠 Адреса',        ph:'вул. Маршалковська 1/2, Варшава'}
];
export function getParentProfile(raw){
  const p=(raw&&typeof raw==='object'&&raw.profile)||{};
  const out={};PARENT_FIELDS.forEach(f=>out[f.k]=p[f.k]||'');
  return out;
}
// ПІБ одним рядком; якщо не заповнено — показуємо email як запасний варіант
export function parentFullName(profile,fallback){
  const s=[profile.lastName,profile.firstName,profile.middleName].filter(Boolean).join(' ').trim();
  return s||fallback||'—';
}
// Telegram зберігаємо як завгодно, а показуємо однаково: @nick + посилання
export function telegramHandle(v){
  const s=String(v||'').trim().replace(/^https?:\/\/(t\.me|telegram\.me)\//i,'').replace(/^@/,'');
  return s?{handle:'@'+s,url:'https://t.me/'+encodeURIComponent(s)}:null;
}
export function telHref(v){
  const s=String(v||'').replace(/[^\d+]/g,'');
  return s?'tel:'+s:'';
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
  currentUserData.studentId=k.studentId||stuId(k.class,k.studentName)||null;
  currentUserData.class=k.class;
  currentUserData.parentRole=k.role||currentUserData.parentRole||'guardian';
  try{await update(ref(db,`users/${auth.currentUser.uid}`),{studentName:k.studentName,studentId:currentUserData.studentId,class:k.class,parentRole:currentUserData.parentRole});}catch(e){console.error(e);}
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
  renderInstallBlock();renderPushButton();
  const childBlock=document.getElementById('child-block');
  if(childBlock){
    const isP=currentUserData?.role==='parent';
    childBlock.style.display=isP?'block':'none';
    if(isP)window.renderChildAccess();
  }
  // Батьки заповнюють свої контакти самі — школі менше ручної роботи,
  // а дані свіжіші. Прізвище/ім'я показуємо тут же, щоб усе було в одному
  // місці, тому окремі поля зверху для батьків ховаємо.
  const isParent=currentUserData.role==='parent';
  const box=document.getElementById('p-contacts-section');
  if(box){
    box.style.display=isParent?'block':'none';
    const nameBlock=document.getElementById('profile-name-block');
    if(nameBlock)nameBlock.style.display=isParent?'none':'block';
    if(isParent){
      const se=(currentUserData.email||'').replace(/\./g,'_');
      const snap=await get(child(ref(db),`parent_links/${se}`));
      const profile=getParentProfile(snap.exists()?snap.val():{});
      // Якщо контактів ще немає — підставляємо ім'я з профілю порталу
      if(!profile.firstName)profile.firstName=currentUserData.firstName||'';
      if(!profile.lastName)profile.lastName=currentUserData.lastName||'';
      document.getElementById('p-contacts-fields').innerHTML=PARENT_FIELDS.map(f=>`
        <label for="pc-${f.k}" style="margin-top:9px;">${f.label}</label>
        <input type="${f.type||'text'}" id="pc-${f.k}" value="${escHtml(profile[f.k])}" placeholder="${escHtml(f.ph)}">
      `).join('');
    }
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
    // Батьки редагують ПІБ у блоці контактів, тому беремо звідти
    let finalFirst=fName, finalLast=lName;
    const isParent=currentUserData.role==='parent';
    if(isParent&&document.getElementById('pc-firstName')){
      const profile={};
      PARENT_FIELDS.forEach(f=>{
        const el=document.getElementById('pc-'+f.k);
        profile[f.k]=el?el.value.trim():'';
      });
      const se=(currentUserData.email||'').replace(/\./g,'_');
      // update, а не set: у цьому ж вузлі лежать children
      await update(ref(db,`parent_links/${se}`),{profile});
      finalFirst=profile.firstName;finalLast=profile.lastName;
    }
    await update(ref(db,`users/${auth.currentUser.uid}`),{firstName:finalFirst,lastName:finalLast,photoURL});
    currentUserData.firstName=finalFirst;currentUserData.lastName=finalLast;currentUserData.photoURL=photoURL;
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
  else if(currentUserData.role==='kitchen'){/* кухня працює тижнями — має власну навігацію */}
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
  // Темна тема лише для екранів входу: після входу портал світлий, як і був.
  document.body.classList.toggle('auth-mode',!user);
  // Людина перейшла за посиланням із листа відновлення пароля — показуємо
  // сторінку встановлення нового пароля і не чіпаємо звичайний вхід.
  if(hasPendingAuthAction()){document.body.classList.add('auth-mode');initPasswordResetScreen();return;}
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
      const nd={role:"parent",children:kids,studentName:first.studentName,studentId:first.studentId||null,class:first.class,parentRole:first.role||'guardian',email:user.email};
      await set(ref(db,`users/${user.uid}`),nd);currentUserData=nd;await loadGradeTypesCache();initUserSession();}else{const sls=await get(child(ref(db),`student_links/${se}`));if(sls.exists()){const sd=sls.val();const nd={role:"student",studentName:sd.studentName,studentId:sd.studentId||null,class:sd.class,email:user.email};await set(ref(db,`users/${user.uid}`),nd);currentUserData=nd;await loadGradeTypesCache();initUserSession();}else{signOut(auth).then(()=>{
      if(window.showFirstLoginScreen){
        window.showFirstLoginScreen();
        setMsg('fl-error','Цей email ще не додано школою. Зверніться до класного керівника або директора.','login-err');
      } else alert('Цей email ще не додано школою. Зверніться до класного керівника або директора.');
    });}}}}
  }else document.getElementById('login-screen').style.display='block';
});
async function fetchTeacherAccess(se){const s=await get(child(ref(db),`teacher_access/${se}`));teacherAccessMatrix=s.exists()?s.val():{};}

// ══════════ САМОВІДНОВЛЕННЯ ЗАПИСУ В pre_approved_roles ══════════
// Акаунти, створені до появи правил доступу, є в users, але їх немає у
// списку персоналу. Правила ж звіряються саме зі списком — і така людина
// не може ані створити розмову, ані підтвердити свою роль при перезаписі.
// Директор і секретар мають право писати в цей вузол, тож дописуємо тихо.
// Нових прав це не дає: роль береться з наявного запису, а не вигадується.
async function healStaffRegistry(){
  try{
    const u = currentUserData;
    if(!u || !u.email) return;
    const roles = getUserRoles(u);
    if(!roles.length) return;
    const isAdmin = roles.includes('director') || roles.includes('administrator');
    if(!isAdmin) return;                       // тільки адміністрація має право запису
    const se = u.email.toLowerCase().replace(/\./g,'_');
    const snap = await get(child(ref(db), `pre_approved_roles/${se}`));
    if(snap.exists()) return;
    await set(ref(db, `pre_approved_roles/${se}`), roles.length > 1 ? roles : roles[0]);
    console.info('Запис у списку персоналу відновлено:', se);
  }catch(e){ /* не критично: підкаже перевірка при створенні розмови */ }
}

// ── Довідник контактів ──
// Кожен пише сам про себе рівно те, що потрібно для вибору співрозмовника
// в чаті. Без цього батько не бачив би, кому писати: `users`,
// `parent_links` і `teacher_access` для нього закриті — і правильно,
// там медичні дані й контакти всіх родин.
export async function publishContactCard(){
  try{
    const u = currentUserData;
    if(!u || !u.email) return;
    const se = u.email.toLowerCase().replace(/\./g,'_');
    const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email;
    const roles = getUserRoles(u);
    const role = roles[0] || u.role || '';

    if(role === 'parent' || role === 'student'){
      if(!u.class) return;                      // без класу нема куди писати
      const kids = u.studentName || '';
      await update(ref(db, `class_parents/${u.class}/${se}`),
                   { name: String(name).slice(0,120), children: String(kids).slice(0,200), ts: Date.now() });
      return;
    }
    if(!role) return;
    // Класи вчителя беремо з його власного рядка teacher_access.
    // Там лежить СПИСОК ПРЕДМЕТІВ на клас, а довіднику треба лише факт
    // «має цей клас» — кладемо true, інакше перевірка типу відхилить запис.
    let classes = null;
    try{
      const ts = await get(child(ref(db), `teacher_access/${se}`));
      if(ts.exists()){
        classes = {};
        Object.keys(ts.val() || {}).forEach(c => { classes[c] = true; });
        if(!Object.keys(classes).length) classes = null;
      }
    }catch(e){ /* не всі ролі мають доступ — не біда */ }
    const rec = { name: String(name).slice(0,120), role: String(role), ts: Date.now() };
    if(classes) rec.classes = classes;
    await update(ref(db, `staff_directory/${se}`), rec);
  }catch(e){
    // Мовчки: довідник — зручність, а не умова роботи кабінету.
    console.warn('publishContactCard', e.message);
  }
}

async function initUserSession(){
  healStaffRegistry();
  publishContactCard();
  // тихо відновлюємо запис у списку персоналу, якщо його немає
  setTimeout(()=>{ if(window.watchUnread) window.watchUnread(); }, 300);
  try{
    let dirs = await preloadStudentDirs();
    // Порожній довідник = усі імена на екрані перетворяться на ключі.
    // Одна повторна спроба дешевша за незрозумілий інтерфейс.
    if(!Object.keys(dirs||{}).length){
      await new Promise(r=>setTimeout(r,700));
      dirs = await preloadStudentDirs();
      if(!Object.keys(dirs||{}).length)
        console.error('Довідник учнів порожній — імена показуватимуться як ключі');
    }
    // Дочекатися обовʼязково: кабінет одразу читає дані за цим ключем
    if(currentUserData && (currentUserData.role==='parent'||currentUserData.role==='student'))
      await backfillStudentId();
  }catch(e){ console.warn('Довідник учнів не завантажено:', e.message); }
  // Приховуємо всі кабінети перед відкриттям потрібного — обов'язково для
  // switchRole(), інакше попередній кабінет залишиться на екрані поверх нового.
  document.querySelectorAll('.panel').forEach(p=>p.style.display='none');
  document.getElementById('calendar-block').style.display='block';updateProfileBar();
  const r=currentUserData.role;
  if(r==='director'){document.getElementById('director-screen').style.display='block';setTimeout(()=>{if(window.initDirTabs)window.initDirTabs();},0);document.getElementById('teacher-class-selector-box').style.display='none';loadTeachersListForDirector();loadDirectorTeacherSkillsList();handleDateChange();loadDrafts();if(window.loadBellCoverage)window.loadBellCoverage();}
  else if(r==='kitchen'){document.getElementById('kitchen-screen').style.display='block';document.getElementById('teacher-class-selector-box').style.display='none';const gd=document.getElementById('global-date'),gl=document.getElementById('global-date-label');if(gd)gd.style.display='none';if(gl)gl.style.display='none';if(window.refreshKitchen)window.refreshKitchen();}
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
    setTimeout(()=>{if(window.initTabs)window.initTabs('teacher-screen');},0);
    setTimeout(()=>{if(window.renderPushInvite)window.renderPushInvite('t-push-invite');},600);
  }
  else if(r==='student'){
    setTimeout(()=>{if(window.initTabs)window.initTabs('student-screen');},0);
    setTimeout(()=>{if(window.renderPushInvite)window.renderPushInvite('s-push-invite');},600);
    document.getElementById('student-screen').style.display='block';
    const cn=currentUserData.class.replace('class_','');document.getElementById('s-schedule-link').href=`https://planlekcjipush.netlify.app/class-${cn}`;
    loadScheduleScript(currentUserData.class,()=>handleDateChange());
    loadTextbooksForParent('student');
  }
  else{
    setTimeout(()=>{if(window.initTabs)window.initTabs('parent-screen');},0);
    setTimeout(()=>{if(window.renderPushInvite)window.renderPushInvite('p-push-invite');},600);
    document.getElementById('parent-screen').style.display='block';
    const cn=currentUserData.class.replace('class_','');document.getElementById('p-schedule-link').href=`https://planlekcjipush.netlify.app/class-${cn}`;
    loadScheduleScript(currentUserData.class,()=>handleDateChange());
    renderPaymentsMockup();loadTextbooksForParent();
    if(window.initChildAccess)window.initChildAccess();
  }
}
// ══════════════════════════════════════════════════════════════════
//  ЖУРНАЛ ДІЙ (аудит)
// ══════════════════════════════════════════════════════════════════
// Хто, що і коли змінив. Найважливіше — правки оцінок: без такого журналу
// неможливо розібрати спірну ситуацію «оцінка була інша».
//
// Розбивка по місяцях (audit_log/{РРРР-ММ}) навмисна: записів з часом
// стануть десятки тисяч, і читати одну спільну гілку було б повільно.
// Читаємо завжди лише потрібний місяць і лише останні N записів.
export const AUDIT_LABELS={
  grade_set:'📊 Оцінку виставлено', grade_del:'📊 Оцінку видалено',
  attendance:'🚨 Відмітка відсутності', comment:'💬 Коментар учню',
  homework:'📚 Домашнє завдання', behavior:'🤝 Оцінка поведінки',
  student_add:'👨‍🎓 Учня додано', student_rename:'✏️ Учня перейменовано',
  student_del:'🗑 Учня прибрано', student_transfer:'↔️ Учня переведено',
  card_edit:'📋 Картку учня змінено', data_export:'📦 Вивантаження даних дитини', staff_absent:'🧑‍🏫 Відсутність вчителя', consent_create:'✍️ Запит на згоду', quick_journal:'⚡ Швидкий журнал', menu:'🍽️ Меню оновлено', announcement:'📣 Оголошення', meal_plan:'🥪 Харчування учня', migration:'🆔 Перехід на ідентифікатори', broadcast:'✉️ Повідомлення класу', substitute:'🔄 Призначено заміну', semester_grade:'🎓 Підсумкові оцінки',
  student_login:'🔑 Вхід учня створено', student_email:'✉️ Email учня змінено',
  student_login_del:'🔒 Вхід учня прибрано',
  parent_link:'🔗 Батьків прив\'язано', parent_unlink:'🔓 Батьків відв\'язано',
  parent_edit:'👪 Контакти батьків', parent_email:'✉️ Email батьків змінено',
  staff_grant:'🛡️ Доступ співробітнику', staff_remove:'🗑 Доступ відкликано',
  pass_reset:'🔑 Скидання пароля', schedule_publish:'🗓️ Розклад опубліковано',
  bell_apply:'🔔 Розклад дзвінків', curriculum:'📅 Календарний план',
  grade_type:'🎯 Типи оцінок', year_rollover:'🎓 Перехід на новий рік'
};
// Виклик навмисно «тихий» і без await: запис у журнал не має ані
// сповільнювати основну дію, ані зривати її, якщо не вдався.
export function logAction(action,details={}){
  try{
    const u=currentUserData||{};
    const name=(u.firstName||u.lastName)
      ? `${u.firstName||''} ${u.lastName||''}`.trim()
      : (u.email||'—');
    push(ref(db,`audit_log/${localDateString.slice(0,7)}`),{
      ts:Date.now(),
      uid:auth.currentUser?.uid||'',
      actor:name,
      role:u.role||'',
      action,
      ...details
    }).catch(()=>{});
  }catch(e){/* журнал не має ламати основну дію */}
}
window.logAction=logAction;
// ══════════════════════════════════════════════════════════════════
//  СПОВІЩЕННЯ (Push / Firebase Cloud Messaging)
// ══════════════════════════════════════════════════════════════════
// Портал був пасивним: оцінку виставили, дитину відмітили відсутньою —
// батьки дізнавалися, лише якщо самі зайшли. Push це закриває.
//
// НАЛАШТУВАННЯ (один раз, у Firebase Console):
//   Project settings → Cloud Messaging → Web Push certificates →
//   Generate key pair → скопіювати ключ у VAPID_KEY нижче.
// Ключ живе в push-config.js — файлі, який оновлення коду не чіпають.
// Раніше він лежав тут, і кожне оновлення common.js стирало вставлене.
const VAPID_KEY = (typeof window !== 'undefined' && window.PUSH_VAPID_KEY)
  || 'ЗАМІНИТИ_НА_КЛЮЧ_З_FIREBASE_CONSOLE';
// Без цього ключа ніхто не може підписатися, тож і слати нема кому.
// Виносимо назовні, щоб екрани могли чесно попередити, а не мовчати.
export const pushConfigured = !VAPID_KEY.startsWith('ЗАМІНИТИ');
let swRegistration=null;
// Реєструємо Service Worker одразу: без нього не працюють ані push,
// ані встановлення застосунку на телефон. Раніше він не реєструвався
// взагалі, тож PWA фактично не працював.
if('serviceWorker' in navigator){
  window.addEventListener('load',()=>{
    navigator.serviceWorker.register('firebase-messaging-sw.js')
      .then(r=>{swRegistration=r;})
      .catch(e=>console.warn('SW не зареєстровано:',e.message));
  });
}
// ── Встановлення застосунку (PWA) ──
// Більшість батьків не знає, що сайт можна «встановити», а на iPhone без
// установки сповіщення взагалі не працюють. Тому показуємо кнопку в порталі.
let deferredInstall=null;
export const isStandalone=()=>window.matchMedia('(display-mode: standalone)').matches||window.navigator.standalone===true;
export const isIOS=()=>/iphone|ipad|ipod/i.test(navigator.userAgent);
// Chrome/Edge/Android дають цю подію — перехоплюємо, щоб показати свою кнопку
window.addEventListener('beforeinstallprompt',(e)=>{
  e.preventDefault();deferredInstall=e;renderInstallBlock();
});
window.addEventListener('appinstalled',()=>{deferredInstall=null;renderInstallBlock();renderPushButton();});
window.installApp=async function(){
  if(!deferredInstall)return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall=null;renderInstallBlock();
};
export function renderInstallBlock(){
  const box=document.getElementById('install-block');
  if(!box)return;
  if(isStandalone()){box.style.display='none';return;}
  if(deferredInstall){
    box.style.display='block';
    box.innerHTML=`<div class="push-row">
      <span class="push-label">📲 Встановити застосунок на пристрій</span>
      <button type="button" class="push-btn" onclick="installApp()">Встановити</button>
    </div>
    <p class="push-hint">Портал відкриватиметься як звичайний застосунок, з іконкою на екрані.</p>`;
    return;
  }
  if(isIOS()){
    // На iPhone програмної установки немає — лише інструкція
    box.style.display='block';
    box.innerHTML=`<div class="push-label" style="margin-bottom:5px;">📲 Встановити на iPhone</div>
      <p class="push-hint" style="flex:auto;">
        Внизу екрана натисніть <b>Поділитися</b> ⬆️ → <b>На екран «Домів»</b>.<br>
        Без цього iPhone не показуватиме сповіщення від порталу.
      </p>`;
    return;
  }
  box.style.display='none';
}
window.renderInstallBlock=renderInstallBlock;
export async function pushSupported(){
  try{
    return 'Notification' in window && 'serviceWorker' in navigator && await messagingSupported();
  }catch(e){return false;}
}
// Стан для кнопки: 'unsupported' | 'denied' | 'on' | 'off'
export async function pushState(){
  if(!await pushSupported())return 'unsupported';
  if(Notification.permission==='denied')return 'denied';
  if(Notification.permission!=='granted')return 'off';
  const uid=auth.currentUser?.uid;
  if(!uid)return 'off';
  const snap=await get(child(ref(db),`push_tokens/${uid}`));
  return snap.exists()?'on':'off';
}
window.enablePush=async function(){
  if(!await pushSupported())return showToast('⚠️ Ваш браузер не підтримує сповіщення');
  if(!pushConfigured)return showToast('⚠️ Сповіщення ще не налаштовані адміністратором');
  try{
    const perm=await Notification.requestPermission();
    if(perm!=='granted'){
      showToast(perm==='denied'
        ?'🔕 Сповіщення заблоковані у налаштуваннях браузера'
        :'🔕 Дозвіл не надано');
      return renderPushButton();
    }
    // Чекаємо реєстрації SW — на першому заході вона може ще тривати
    const reg=swRegistration||await navigator.serviceWorker.ready;
    const messaging=getMessaging(app);
    const token=await getToken(messaging,{vapidKey:VAPID_KEY,serviceWorkerRegistration:reg});
    if(!token)return showToast('⚠️ Не вдалося отримати токен сповіщень');
    const uid=auth.currentUser.uid;
    // Зберігаємо разом із роллю і дитиною — щоб сервер знав, кому що слати
    await set(ref(db,`push_tokens/${uid}`),{
      token,
      role:currentUserData?.role||'',
      email:currentUserData?.email||'',
      studentName:currentUserData?.studentName||'',
      studentId:currentUserData?.studentId||'',
      class:currentUserData?.class||'',
      updatedAt:Date.now()
    });
    showToast('🔔 Сповіщення увімкнено');
    renderPushButton();
  }catch(e){
    console.error(e);
    showToast('Помилка: '+(e.message||e.code));
  }
};
window.disablePush=async function(){
  const uid=auth.currentUser?.uid;
  if(uid)await remove(ref(db,`push_tokens/${uid}`));
  // Відкликати дозвіл браузера з коду не можна — лише перестаємо слати
  showToast('🔕 Сповіщення вимкнено');
  renderPushButton();
};

// ══════════ ЗАПРОШЕННЯ УВІМКНУТИ СПОВІЩЕННЯ ══════════
// Кнопка вмикання жила лише всередині модалки «Профіль» — туди майже
// ніхто не заходить, тому батьки просто не підписувалися, і пуші не
// приходили нікому. Показуємо помітну смужку прямо в кабінеті, поки
// сповіщення не увімкнені. Один раз відхилили — не нагадуємо тиждень.
const PUSH_NAG_KEY = 'push_school_push_nag';
export async function renderPushInvite(containerId){
  const box = document.getElementById(containerId);
  if(!box) return;
  box.style.display = 'none';
  if(!pushConfigured) return;
  try{
    const st = await pushState();
    if(st === 'on') return;
    if(st === 'unsupported'){
      if(!(isIOS() && !isStandalone())) return;
      box.style.display = 'block';
      box.className = 'push-invite';
      box.innerHTML = `<span>🔔 Щоб отримувати сповіщення на iPhone, додайте портал на початковий екран
        — кнопка «Поділитися» → «Додати на початковий екран».</span>
        <button type="button" class="pi-x" onclick="dismissPushInvite('${containerId}')">Пізніше</button>`;
      return;
    }
    let snoozed = 0;
    try{ snoozed = Number(localStorage.getItem(PUSH_NAG_KEY)) || 0; }catch(e){}
    if(Date.now() - snoozed < 7*24*3600*1000) return;
    box.style.display = 'block';
    box.className = 'push-invite';
    box.innerHTML = st === 'denied'
      ? `<span>🔕 Сповіщення заблоковані у браузері. Дозвольте їх у налаштуваннях сайту, щоб не пропустити повідомлення від школи.</span>
         <button type="button" class="pi-x" onclick="dismissPushInvite('${containerId}')">Зрозуміло</button>`
      : `<span>🔔 Увімкніть сповіщення — і не пропустите повідомлення вчителя, оголошення та зміни в меню.</span>
         <button type="button" class="pi-go" onclick="enablePush().then(()=>renderPushInvite('${containerId}'))">Увімкнути</button>
         <button type="button" class="pi-x" onclick="dismissPushInvite('${containerId}')">Пізніше</button>`;
  }catch(e){ /* не критично */ }
}
window.renderPushInvite = renderPushInvite;
window.dismissPushInvite = function(containerId){
  try{ localStorage.setItem(PUSH_NAG_KEY, String(Date.now())); }catch(e){}
  const b = document.getElementById(containerId);
  if(b) b.style.display = 'none';
};


// ══════════ ДІАГНОСТИКА СПОВІЩЕНЬ ══════════
// Проходить ланцюжок по кроках і каже, де саме обрив. Раніше така
// перевірка була лише в кабінеті кухні — а не працювало здебільшого
// в батьків, які до неї не мають доступу.
window.checkPush = async function(){
  const out = [];
  const line = (ok, txt) => out.push(`${ok ? '✅' : '❌'} ${txt}`);

  line(pushConfigured, pushConfigured
    ? 'Ключ VAPID вставлено в код'
    : 'У common.js досі заглушка замість ключа VAPID');

  const sup = await pushSupported();
  line(sup, sup ? 'Браузер підтримує сповіщення'
                : (isIOS() && !isStandalone()
                   ? 'iPhone: спочатку додайте портал на початковий екран'
                   : 'Браузер не підтримує web push'));

  const perm = (typeof Notification !== 'undefined') ? Notification.permission : 'unsupported';
  line(perm === 'granted', perm === 'granted' ? 'Дозвіл на сповіщення надано'
      : perm === 'denied' ? 'Дозвіл заблоковано — зніміть блокування в налаштуваннях сайту'
      : 'Дозвіл ще не запитували — натисніть «Увімкнути»');

  let hasToken = false;
  try{
    const uid = auth.currentUser?.uid;
    if(uid){ const sn = await get(child(ref(db), `push_tokens/${uid}`)); hasToken = sn.exists(); }
  }catch(e){}
  line(hasToken, hasToken ? 'Пристрій підписано, токен збережено'
                          : 'Токена немає — підписка не відбулася');

  let server = '—';
  try{
    const r = await fetch('/.netlify/functions/notify', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ type:'menu', probe:true })
    });
    const d = await r.json();
    if(!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    server = `підписників усього: ${d.eligible ?? '?'} (проєкт ${d.project || '?'})`;
    line(true, 'Сервер сповіщень відповідає · ' + server);
  }catch(e){
    line(false, 'Сервер сповіщень: ' + (e.message || 'немає відповіді'));
  }
  alert('Стан сповіщень\n\n' + out.join('\n'));
};

export async function renderPushButton(){
  const box=document.getElementById('push-toggle');
  if(!box)return;
  const st=await pushState();
  const map={
    unsupported:['','',''],
    denied:['🔕 Сповіщення заблоковані','', 'Дозвольте сповіщення для цього сайту в налаштуваннях браузера'],
    on:['🔔 Сповіщення увімкнено','disablePush()','Вимкнути'],
    off:['🔕 Сповіщення вимкнено','enablePush()','Увімкнути']
  };
  if(st==='unsupported'){
    // На iPhone сповіщення з'являються лише після встановлення на екран
    // «Домів». Мовчки ховати кнопку не можна — людина не зрозуміє, чому в
    // неї немає того, що є в інших.
    if(isIOS()&&!isStandalone()){
      box.style.display='block';
      box.innerHTML=`<div class="push-row"><span class="push-label">🔔 Сповіщення</span></div>
        <p class="push-hint">Щоб отримувати сповіщення на iPhone, спочатку встановіть застосунок (інструкція вище).</p>`;
      return;
    }
    box.style.display='none';return;
  }
  const [label,action,btn]=map[st];
  box.style.display='block';
  box.innerHTML=`<div class="push-row">
    <span class="push-label">${label}</span>
    ${action?`<button type="button" class="push-btn" onclick="${action}">${btn}</button>`
             :`<span class="push-hint">${btn}</span>`}
  </div>`;
}
window.renderPushButton=renderPushButton;
// Надіслати сповіщення про подію. Свідомо «тихий» виклик: якщо сповіщення
// не налаштовані або впали — основна дія (оцінка, відмітка) вже збережена
// і не має зриватися через це.
export function notifyEvent(type,payload){
  if(!pushConfigured) return Promise.resolve({ok:false,error:'Push не налаштовано: немає VAPID-ключа'});
  return fetch('/.netlify/functions/notify',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({type,...payload})
  }).then(async r=>{
    let d={}; try{ d=await r.json(); }catch(e){}
    if(!r.ok) return {ok:false,error:d.error||`HTTP ${r.status}`};
    return {ok:true,sent:d.sent||0,note:d.note||''};
  }).catch(e=>({ok:false,error:e.message||'Немає звʼязку з сервером'}));
}
// Попередження на екрані замість мовчазної тиші, коли push не налаштований
export function renderPushWarning(containerId){
  const box=document.getElementById(containerId);
  if(!box)return;
  if(pushConfigured){box.style.display='none';return;}
  box.style.display='block';
  box.className='push-warn';
  box.textContent='⚠️ Сповіщення поки не працюють: адміністратор ще не додав ключ Firebase. Меню збережеться, але батьки повідомлення не отримають.';
}
window.renderPushWarning=renderPushWarning;
window.notifyEvent=notifyEvent;
// Сповіщення, коли портал відкритий: системне вікно браузер не показує,
// тому показуємо власний тост — інакше подія просто зникне непоміченою.
(async()=>{
  if(!await pushSupported())return;
  try{
    onMessage(getMessaging(app),(payload)=>{
      const d=payload.data||{};
      showToast(`${d.title||'Сповіщення'}: ${d.body||''}`);
    });
  }catch(e){/* messaging недоступний — не критично */}
})();

// ── Дрібниці оформлення чату ──
// Ініціали й колір аватара рахуємо з імені: однакова людина завжди
// того самого кольору, і список читається швидше за текст.
function initials(name){
  const p = String(name||'').trim().split(/\s+/);
  return ((p[0]||'')[0] || '?').toUpperCase() + ((p[1]||'')[0] || '').toUpperCase();
}
const AV_COLORS = ['#5c6bc0','#26a69a','#ef6c00','#8e24aa','#00838f','#c2185b','#558b2f','#4527a0'];
function avatarColor(name){
  let h = 0; const s = String(name||'');
  for(let i=0;i<s.length;i++) h = (h*31 + s.charCodeAt(i)) >>> 0;
  return AV_COLORS[h % AV_COLORS.length];
}
function chatTime(ts){
  if(!ts) return '';
  const d = new Date(ts), now = new Date();
  if(d.toDateString() === now.toDateString())
    return d.toLocaleTimeString('uk-UA',{hour:'2-digit',minute:'2-digit'});
  const y = new Date(now); y.setDate(y.getDate()-1);
  if(d.toDateString() === y.toDateString()) return 'вчора';
  return d.toLocaleDateString('uk-UA',{day:'numeric',month:'short'});
}
function chatDayLabel(ts){
  const d = new Date(ts), now = new Date();
  if(d.toDateString() === now.toDateString()) return 'Сьогодні';
  const y = new Date(now); y.setDate(y.getDate()-1);
  if(d.toDateString() === y.toDateString()) return 'Вчора';
  return d.toLocaleDateString('uk-UA',{day:'numeric',month:'long',year:
    d.getFullYear()===now.getFullYear()?undefined:'numeric'});
}
// ══════════ БАТЬКИ КЛАСУ: спільний список + редактор ══════════
// Один код для кабінету вчителя і директора — інакше довелося б підтримувати
// дві копії. Дані лежать «навпаки» (ключ — пошта батьків), тому для показу
// перевертаємо: дитина → її батьки.
const PARENT_ROLE_LABELS={mother:'👩 Мати',father:'👨 Батько',guardian:'🛡️ Опікун'};
export async function renderParentsBlock(containerId,cls){
  const box=document.getElementById(containerId);
  if(!box)return;
  if(!cls){box.innerHTML='<p class="empty-msg">Оберіть клас.</p>';return;}
  box.innerHTML='<p class="empty-msg">Завантаження...</p>';
  try{
    const [stSnap,plSnap,usersSnap,slSnap,cardSnap]=await Promise.all([
      get(child(ref(db),`students_list/${cls}`)),
      get(child(ref(db),'parent_links')),
      getUsersSnap(),
      get(child(ref(db),'student_links')),
      get(child(ref(db),`student_cards/${cls}`))
    ]);
    const cards=cardSnap.exists()?cardSnap.val():{};
    const students=stSnap.exists()?Object.values(stSnap.val()).sort((a,b)=>String(a).localeCompare(String(b),'uk')):[];
    if(students.length===0){box.innerHTML='<p class="empty-msg">У цьому класі ще немає учнів.</p>';return;}
    const loggedIn=new Set();
    if(usersSnap.exists()){
      const u=usersSnap.val();
      for(const uid in u)if(u[uid].email&&u[uid].role==='parent')loggedIn.add(u[uid].email.toLowerCase());
    }
    const byChild={};
    if(plSnap.exists()){
      const pl=plSnap.val();
      for(const safeEmail in pl){
        const rec=pl[safeEmail];
        const email=safeEmail.replace(/_/g,'.');
        const profile=getParentProfile(rec);
        normalizeChildren(rec).forEach(k=>{
          if(k.class!==cls)return;
          (byChild[k.studentName]=byChild[k.studentName]||[]).push({safeEmail,email,profile,role:k.role||'guardian'});
        });
      }
    }
    const orphans=students.filter(s=>!byChild[s]||byChild[s].length===0);
    let html=orphans.length
      ? `<div class="bell-missing">⚠️ Без прив'язаних батьків: ${escHtml(orphans.join(', '))}</div>`
      : `<div class="po-ok">✓ У всіх учнів є прив'язані контакти</div>`;
    // Ключі учнів потрібні, щоб можна було перейменувати/прибрати учня
    // прямо звідси — окремий «список учнів» більше не потрібен.
    const keyByName={};
    if(stSnap.exists()){const d=stSnap.val();for(const k in d)keyByName[d[k]]=k;}
    // Власний вхід учня: student_links ключується його поштою, тож
    // перевертаємо в «ім'я → email», щоб показати, у кого вхід є, а в кого ні
    const loginByStudent={};
    if(slSnap.exists()){
      const sl=slSnap.val();
      for(const se in sl){
        const v=sl[se];
        if(v&&v.class===cls&&v.studentName)loginByStudent[v.studentName]=se.replace(/_/g,'.');
      }
    }
    students.forEach(st=>{
      const list=byChild[st]||[];
      const sk=keyByName[st]||'';
      html+=`<div class="po-row" id="ds-row-${escHtml(sk)}">
        <div class="po-child">
          <span class="po-child-name">${escHtml(st)}</span>
          <span class="po-login ${loginByStudent[st]?'':'none'}">🔑 ${loginByStudent[st]?escHtml(loginByStudent[st]):'входу немає'}</span>
          ${(cards[sk]&&cards[sk].allergies)
            // Позначка про алергію видна всім, хто бачить список: на уроці це
            // питання безпеки. Самі медичні деталі — лише в картці, під правами.
            ? `<span class="po-allergy" title="${escHtml(cards[sk].allergies)}">⚠️ Алергія</span>`:''}
          <span class="po-child-acts">
            <button class="po-edit" title="Картка учня" onclick="openStudentCard('${escJs(cls)}','${escJs(sk)}','${escJs(st)}')">📋</button>
            <button class="po-edit" title="Табель (PDF)" onclick="downloadReportCard('${escJs(cls)}','${escJs(st)}')">📄</button>
            <button class="po-edit" title="Змінити ПІБ учня" onclick="editStudentName('${escJs(cls)}','${escJs(sk)}','${escJs(st)}')">✏️</button>
            <button class="po-edit" title="Вхід учня (email)" onclick="openStudentLogin('${escJs(cls)}','${escJs(st)}','${escJs(loginByStudent[st]||'')}')">🔑</button>
            <button class="po-edit po-del" title="Прибрати зі списку" onclick="removeStudent('${escJs(cls)}','${escJs(sk)}','${escJs(st)}')">🗑</button>
          </span>
        </div>
        <div class="po-parents">`;
      if(list.length===0)html+=`<span class="po-none">контактів немає</span>`;
      else list.forEach(p=>{
        const tg=telegramHandle(p.profile.telegram);
        const nm=parentFullName(p.profile,p.email);
        html+=`<div class="po-parent">
          <div class="po-line">
            <span class="po-role">${escHtml(PARENT_ROLE_LABELS[p.role]||p.role)}</span>
            <b class="po-name">${escHtml(nm)}</b>
            ${!loggedIn.has(p.email.toLowerCase())?'<span class="po-new">ще не входив</span>':''}
            <button class="po-edit" onclick="openParentEditor('${escJs(p.safeEmail)}')" title="Редагувати контакти">✏️</button>
          </div>
          <div class="po-contacts">
            <span class="po-email">${escHtml(p.email)}</span>
            ${p.profile.phonePL?`<a href="${telHref(p.profile.phonePL)}">🇵🇱 ${escHtml(p.profile.phonePL)}</a>`:''}
            ${p.profile.phoneUA?`<a href="${telHref(p.profile.phoneUA)}">🇺🇦 ${escHtml(p.profile.phoneUA)}</a>`:''}
            ${tg?`<a href="${escHtml(tg.url)}" target="_blank" rel="noopener noreferrer">✈️ ${escHtml(tg.handle)}</a>`:''}
            ${p.profile.address?`<span class="po-addr">🏠 ${escHtml(p.profile.address)}</span>`:''}
          </div>
        </div>`;
      });
      html+=`</div></div>`;
    });
    box.innerHTML=html;
  }catch(e){box.innerHTML=`<p style="color:red;font-size:.8rem;">Помилка: ${escHtml(e.message)}</p>`;}
}
// Inline-атрибути в HTML (ontoggle/onclick) бачать лише глобальні функції,
// а не експорти модуля — тому дублюємо у window.
window.renderParentsBlock=renderParentsBlock;
window.getActiveClass=getActiveClass;
// Список показується у двох кабінетах під різними id — оновлюємо той,
// що зараз на екрані, щоб функції редагування не знали про це нічого.
export function refreshRoster(cls){
  for(const id of ['t-parents-list','po-list']){
    const el=document.getElementById(id);
    if(el&&el.offsetParent!==null){renderParentsBlock(id,cls);return;}
  }
}
window.refreshRoster=refreshRoster;
// ══════════════════════════════════════════════════════════════════
//  КАРТКА УЧНЯ
// ══════════════════════════════════════════════════════════════════
// Раніше учень у системі був лише рядком з іменем — не було куди покласти
// ні договір, ні дату народження, ні алергії.
//
// Ключ — pushKey зі students_list, а НЕ ім'я: тоді перейменування учня
// не рве картку (на відміну від оцінок, які історично ключуються ім'ям).
//
// ЗАХИСТ ДАНИХ: медичні відомості за GDPR — особлива категорія. Тому
// редагувати картку можуть лише директор, адміністратор і класний керівник
// цього класу. Решта вчителів бачить у списку тільки позначку про алергію —
// це потрібно для безпеки на уроці, але без доступу до PESEL, адреси й договору.
export const CARD_GROUPS=[
  {title:'Загальні дані',fields:[
    {k:'birthDate',label:'Дата народження',type:'date'},
    {k:'pesel',label:'PESEL',ph:'11 цифр'},
    {k:'address',label:'Адреса проживання',ph:'вул., буд., місто'}
  ]},
  {title:'Договір',fields:[
    {k:'contractNo',label:'Номер договору',ph:'напр. 2026/114'},
    {k:'enrolledAt',label:'Дата зарахування',type:'date'}
  ]},
  {title:'Медичні відомості',danger:true,fields:[
    {k:'allergies',label:'Алергії',ph:'напр. горіхи — анафілаксія',area:true},
    {k:'conditions',label:'Хронічні захворювання',area:true},
    {k:'meds',label:'Ліки, які приймає',area:true}
  ]},
  {title:'Безпека',fields:[
    {k:'pickup',label:'Хто має право забирати дитину',
     ph:'Іваненко Оксана (мати) +48 600 000 000\nІваненко Сергій (батько) +48 601 000 000',area:true},
    {k:'pickupBan',label:'Кому забирати ЗАБОРОНЕНО',ph:'якщо є судові обмеження',area:true},
    {k:'emergency',label:'Екстрений контакт',ph:"ім'я, ким доводиться, телефон",area:true}
  ]},
  {title:'Інше',fields:[{k:'notes',label:'Примітки',area:true}]}
];
// Поля, які веде ШКОЛА і батьки не редагують: номер договору й дата
// зарахування — адміністративні. Заборона забирати дитину — навмисно теж:
// це поле про судові обмеження, і саме його зацікавлена сторона могла б
// «підправити». Решту (медичне, контакти, адресу) батьки ведуть самі —
// вони знають це краще за школу, та й дані будуть свіжіші.
const SCHOOL_ONLY_FIELDS=['contractNo','enrolledAt','pickupBan'];
export function canEditCard(cls){
  const r=currentUserData?.role;
  if(r==='director'||r==='administrator')return true;
  if(r==='parent')return true; // з обмеженням по полях, див. SCHOOL_ONLY_FIELDS
  // Класний керівник саме цього класу
  return !!(classTeacherCache[cls]&&currentUserData?.email&&
            classTeacherCache[cls].toLowerCase()===currentUserData.email.toLowerCase());
}
const isFieldLocked=(k)=>currentUserData?.role==='parent'&&SCHOOL_ONLY_FIELDS.includes(k);
let classTeacherCache={};
async function loadClassTeacherCache(){
  const s=await get(child(ref(db),'class_teachers'));
  classTeacherCache={};
  if(s.exists()){const d=s.val();for(const c in d)if(d[c]?.teacherEmail)classTeacherCache[c]=d[c].teacherEmail;}
}
let cardTarget={cls:'',key:'',name:''};
window.openStudentCard=async function(cls,key,name){
  cardTarget={cls,key,name};
  await loadClassTeacherCache();
  const editable=canEditCard(cls);
  document.getElementById('sc-student').textContent=name;
  document.getElementById('sc-save').style.display=editable?'block':'none';
  document.getElementById('sc-readonly').style.display=editable?'none':'block';
  const box=document.getElementById('sc-fields');
  box.innerHTML='<p class="empty-msg">Завантаження...</p>';
  document.getElementById('student-card-modal').style.display='flex';
  const snap=await get(child(ref(db),`student_cards/${cls}/${key}`));
  const c=snap.exists()?snap.val():{};
  box.innerHTML=CARD_GROUPS.map(g=>`
    <div class="sc-group${g.danger?' danger':''}">
      <b>${escHtml(g.title)}</b>
      ${g.fields.map(f=>{
        const ro=!editable||isFieldLocked(f.k);
        const hint=isFieldLocked(f.k)?' <span class="sc-lock">веде школа</span>':'';
        return `
        <label for="sc-${f.k}">${escHtml(f.label)}${hint}</label>
        ${f.area
          ? `<textarea id="sc-${f.k}" rows="2" placeholder="${escHtml(f.ph||'')}" ${ro?'readonly':''}>${escHtml(c[f.k]||'')}</textarea>`
          : `<input type="${f.type||'text'}" id="sc-${f.k}" value="${escHtml(c[f.k]||'')}" placeholder="${escHtml(f.ph||'')}" ${ro?'readonly':''}>`}`;
      }).join('')}
    </div>`).join('');
};
window.closeStudentCard=function(){document.getElementById('student-card-modal').style.display='none';};
// Батьки відкривають картку своєї активної дитини зі свого кабінету.
// Ключ у students_list доводиться шукати за ім'ям — картка ключується
// саме ним, щоб переживати перейменування.
window.openMyChildCard=async function(){
  const cls=currentUserData?.class, name=currentUserData?.studentName;
  if(!cls||!name)return showToast('⚠️ Дитина не визначена');
  // Картку відкривають із вікна профілю. Закриваємо його, інакше воно
  // лишається поверх: у DOM профіль іде пізніше, а z-index у модалок однаковий.
  window.closeProfileModal();
  const snap=await get(child(ref(db),`students_list/${cls}`));
  let key='';
  if(snap.exists()){const d=snap.val();for(const k in d)if(d[k]===name){key=k;break;}}
  if(!key)return showToast('⚠️ Дитину не знайдено у списку класу');
  window.openStudentCard(cls,key,name);
};
// Пароль дитини змінити напряму не можна — надсилаємо лист на її пошту.
window.resetChildPassword=async function(){
  const cls=currentUserData?.class, name=currentUserData?.studentName;
  const snap=await get(child(ref(db),'student_links'));
  let email='';
  if(snap.exists()){
    const d=snap.val();
    for(const se in d)if(d[se]?.studentName===name&&d[se]?.class===cls){email=se.replace(/_/g,'.');break;}
  }
  if(!email)return alert('У дитини ще немає власного входу в портал.\nЗверніться до класного керівника, щоб його створити.');
  if(!confirm(`Надіслати лист для зміни пароля на ${email}?\n\nЗа посиланням із листа можна задати новий пароль.\nСтарий перестане діяти.`))return;
  try{await sendPasswordReset(email);showToast(`📧 Лист надіслано на ${email}`);}
  catch(e){alert('Не вдалося надіслати: '+(e.message||e.code));}
};
// Показуємо, чи є в дитини власний вхід, і яка саме адреса
window.renderChildAccess=async function(){
  const box=document.getElementById('child-access');
  if(!box||currentUserData?.role!=='parent')return;
  const cls=currentUserData.class, name=currentUserData.studentName;
  const snap=await get(child(ref(db),'student_links'));
  let email='';
  if(snap.exists()){
    const d=snap.val();
    for(const se in d)if(d[se]?.studentName===name&&d[se]?.class===cls){email=se.replace(/_/g,'.');break;}
  }
  box.innerHTML=`<div class="push-row">
      <span class="push-label">${email?`🔑 Вхід дитини: <b>${escHtml(email)}</b>`:'🔑 У дитини немає власного входу'}</span>
      ${email?'<button type="button" class="push-btn" onclick="resetChildPassword()">Змінити пароль</button>':''}
    </div>
    ${email?'':'<p class="push-hint">Щоб дитина заходила сама, зверніться до класного керівника — він додасть її email.</p>'}`;
};
window.saveStudentCard=async function(){
  const {cls,key,name}=cardTarget;
  if(!canEditCard(cls))return alert('У вас немає прав редагувати картку.');
  const btn=document.getElementById('sc-save');
  btn.disabled=true;btn.textContent='⏳ Збереження...';
  try{
    // readonly у формі — лише підказка для ока. Тому поля, які веде школа,
    // беремо з бази, а не з форми: інакше збереження від батьків їх затерло б.
    const prevSnap=await get(child(ref(db),`student_cards/${cls}/${key}`));
    const prev=prevSnap.exists()?prevSnap.val():{};
    const data={};
    CARD_GROUPS.forEach(g=>g.fields.forEach(f=>{
      if(isFieldLocked(f.k)){data[f.k]=prev[f.k]||'';return;}
      const el=document.getElementById('sc-'+f.k);
      if(el)data[f.k]=el.value.trim();
    }));
    await set(ref(db,`student_cards/${cls}/${key}`),{...data,updatedAt:Date.now()});
    // У журнал пишемо сам факт правки, БЕЗ вмісту: там медичні дані
    logAction('card_edit',{cls,target:name});
    showToast('✅ Картку збережено');
    window.closeStudentCard();
    refreshRoster(cls);
  }catch(e){alert('Помилка: '+e.message);}
  finally{btn.disabled=false;btn.textContent='💾 Зберегти';}
};
// ══════════════════════════════════════════════════════════════════
//  ДНІ НАРОДЖЕННЯ НА ТИЖНІ
// ══════════════════════════════════════════════════════════════════
// Беремо з карток учнів (birthDate). Свідомо показуємо лише день і місяць,
// без року: однокласникам і чужим батькам вік дитини знати не потрібно.
const MONTHS_UA=['січня','лютого','березня','квітня','травня','червня',
                 'липня','серпня','вересня','жовтня','листопада','грудня'];
export async function getWeekBirthdays(cls,dateStr){
  const [stSnap,cardSnap]=await Promise.all([
    get(child(ref(db),`students_list/${cls}`)),
    get(child(ref(db),`student_cards/${cls}`))
  ]);
  if(!stSnap.exists()||!cardSnap.exists())return[];
  const names=stSnap.val(), cards=cardSnap.val();
  // Тиждень Пн–Нд, той самий, що і в решті звітів
  const week=getWeekDates(dateStr).map(d=>d.slice(5)); // «MM-DD»
  const out=[];
  for(const key in names){
    const bd=cards[key]&&cards[key].birthDate;
    if(!bd||bd.length<10)continue;
    const md=bd.slice(5);
    const i=week.indexOf(md);
    if(i===-1)continue;
    const [,m,d]=bd.split('-');
    out.push({name:names[key],md,idx:i,label:`${parseInt(d)} ${MONTHS_UA[parseInt(m)-1]}`});
  }
  return out.sort((a,b)=>a.idx-b.idx);
}
// Один рендер для всіх кабінетів — вчителя, батьків та учня
export async function renderBirthdays(containerId,cls,dateStr,selfName){
  const box=document.getElementById(containerId);
  if(!box)return;
  try{
    const list=await getWeekBirthdays(cls,dateStr);
    if(list.length===0){box.style.display='none';return;}
    box.style.display='block';
    box.innerHTML=`<div class="bd-title">🎂 Дні народження цього тижня</div>`+
      list.map(b=>`<div class="bd-row${b.name===selfName?' me':''}">
        <span class="bd-name">${escHtml(b.name)}${b.name===selfName?' — це ти!':''}</span>
        <span class="bd-date">${escHtml(b.label)}</span>
      </div>`).join('');
  }catch(e){box.style.display='none';}
}
window.renderBirthdays=renderBirthdays;
// ══════════════════════════════════════════════════════════════════
//  ТАБЕЛЬ УЧНЯ (PDF)
// ══════════════════════════════════════════════════════════════════
// Рендеримо HTML і знімаємо його через html2canvas, а не малюємо текст
// у jsPDF: вбудовані шрифти jsPDF не мають кирилиці, і текст вийшов би
// «кракозябрами». Так само вже зроблено в експорті журналу.
window.downloadReportCard=async function(cls,studentName){
  // Дані лежать під постійним ідентифікатором; імʼя потрібне лише для шапки
  const sid = stuId(cls, studentName) || studentName;
  if(!window.html2canvas||!window.jspdf)return alert('Бібліотеки експорту не завантажились. Оновіть сторінку.');
  const holder=document.getElementById('report-card-render');
  holder.innerHTML='<p style="padding:20px;">Готую табель...</p>';
  try{
    const [semSnap,gradesSnap,cardSnap,stSnap]=await Promise.all([
      get(child(ref(db),`academic_year/${ACADEMIC_YEAR_ID_LOCAL}/semesters`)),
      get(child(ref(db),`semester_grades/${cls}`)),
      get(child(ref(db),`student_cards/${cls}`)),
      get(child(ref(db),`students_list/${cls}`))
    ]);
    const sems=semSnap.exists()?semSnap.val():{};
    const all=gradesSnap.exists()?gradesSnap.val():{};
    // Картку шукаємо за ключем учня — вона ключується саме ним
    let card={};
    if(cardSnap.exists()&&stSnap.exists()){
      const names=stSnap.val();
      card = cardSnap.val()[sid] || {};
    }
    // Предмети — об'єднання по всіх семестрах, щоб таблиця була рівна
    const semIds=Object.keys(all);
    const subjects=[...new Set(semIds.flatMap(id=>Object.keys(all[id]||{})))]
      .filter(s=>semIds.some(id=>all[id][s]&&all[id][s][sid]))
      .sort((a,b)=>a.localeCompare(b,'uk'));
    if(subjects.length===0){holder.innerHTML='';return alert('Для цього учня ще немає підсумкових оцінок.');}
    const head=semIds.map(id=>`<th>${escHtml(sems[id]?.name||id)}</th>`).join('');
    const body=subjects.map(s=>`<tr><td class="rc-subj">${escHtml(s)}</td>`+
      semIds.map(id=>{
        const rec=all[id][s]&&all[id][s][sid];
        return `<td class="rc-val">${rec&&rec.value?escHtml(displayGrade(rec.value,cls)):'—'}</td>`;
      }).join('')+'</tr>').join('');
    holder.innerHTML=`<div class="rc-page">
      <div class="rc-head">
        <div class="rc-title">Табель успішності</div>
        <div class="rc-school">Push School Warsaw · ${escHtml(ACADEMIC_YEAR_ID_LOCAL)} н.р.</div>
      </div>
      <div class="rc-meta">
        <div><b>Учень:</b> ${escHtml(studentName)}</div>
        <div><b>Клас:</b> ${escHtml(cls.replace('class_',''))}</div>
        ${card.birthDate?`<div><b>Дата народження:</b> ${escHtml(card.birthDate.split('-').reverse().join('.'))}</div>`:''}
      </div>
      <table class="rc-table"><thead><tr><th>Предмет</th>${head}</tr></thead><tbody>${body}</tbody></table>
      <div class="rc-foot">
        <div>Сформовано: ${new Date().toLocaleDateString('uk-UA')}</div>
        <div class="rc-sign">Класний керівник __________________</div>
      </div>
    </div>`;
    const canvas=await html2canvas(holder.firstElementChild,{scale:2,backgroundColor:'#fff'});
    const {jsPDF}=window.jspdf;
    const pdf=new jsPDF('p','mm','a4');
    const w=190, h=canvas.height*w/canvas.width;
    pdf.addImage(canvas.toDataURL('image/png'),'PNG',10,10,w,Math.min(h,270));
    pdf.save(`Табель_${studentName.replace(/\s+/g,'_')}_${cls.replace('class_','')}кл.pdf`);
    showToast('📄 Табель завантажено');
  }catch(e){alert('Помилка: '+e.message);}
  finally{holder.innerHTML='';}
};
// ACADEMIC_YEAR_ID живе в director.js, але common.js імпортувати його не може
// (director вже імпортує common — вийшов би цикл). Рахуємо ту саму формулу тут.
const ACADEMIC_YEAR_ID_LOCAL=(()=>{
  const d=new Date(), y=d.getFullYear();
  return d.getMonth()+1>=9?`${y}-${y+1}`:`${y-1}-${y}`;
})();
// ══════════════════════════════════════════════════════════════════
//  ВИВАНТАЖЕННЯ ДАНИХ ДИТИНИ
// ══════════════════════════════════════════════════════════════════
// За GDPR батьки мають право отримати всі дані про свою дитину. Без цієї
// кнопки школі довелося б збирати їх вручну через консоль Firebase.
// Формат JSON — повний і однозначний; він же годиться для перенесення
// в іншу систему (право на переносимість даних).
window.exportChildData=async function(cls,studentName){
  const sid = stuId(cls, studentName) || studentName;
  if(!cls||!studentName)return showToast('⚠️ Дитина не визначена');
  showToast('⏳ Збираю дані...');
  try{
    const ym=(o,pick)=>{const r={};for(const m in o)if(pick(m))r[m]=o[m];return r;};
    const [stSnap,cardSnap,gradesSnap,typesSnap,attSnap,behSnap,stickSnap,
           comSnap,semSnap,retSnap,plSnap,slSnap]=await Promise.all([
      get(child(ref(db),`students_list/${cls}`)),
      get(child(ref(db),`student_cards/${cls}`)),
      get(child(ref(db),`grades/${cls}`)),
      get(child(ref(db),`grade_types/${cls}`)),
      get(child(ref(db),`attendance/${cls}`)),
      get(child(ref(db),`behavior_grades/${cls}`)),
      get(child(ref(db),`stickers/${cls}/${sid}`)),
      get(child(ref(db),`comments/${cls}`)),
      get(child(ref(db),`semester_grades/${cls}`)),
      get(child(ref(db),`retake_requests/${cls}`)),
      get(child(ref(db),'parent_links')),
      get(child(ref(db),'student_links'))
    ]);
    // Дані інших дітей у вивантаження потрапити не повинні — усюди
    // фільтруємо строго по імені цієї дитини
    const pick=(snap,depth)=>{
      if(!snap.exists())return {};
      const walk=(node,d)=>{
        if(d===0)return node[sid]!==undefined?node[sid]:undefined;
        const out={};
        for(const k in node){const v=walk(node[k],d-1);if(v!==undefined&&(typeof v!=='object'||Object.keys(v).length))out[k]=v;}
        return out;
      };
      return walk(snap.val(),depth);
    };
    const card = cardSnap.exists() ? (cardSnap.val()[sid] || {}) : {};
    // Батьки, прив'язані саме до цієї дитини
    const parents=[];
    if(plSnap.exists()){
      const pl=plSnap.val();
      for(const se in pl){
        const kids=normalizeChildren(pl[se]);
        if(kids.some(k=>k.studentName===studentName&&k.class===cls))
          parents.push({email:se.replace(/_/g,'.'),...getParentProfile(pl[se]),
                        role:kids.find(k=>k.studentName===studentName)?.role||''});
      }
    }
    let ownLogin='';
    if(slSnap.exists()){
      const sl=slSnap.val();
      for(const se in sl)if(sl[se]?.studentName===studentName&&sl[se]?.class===cls){ownLogin=se.replace(/_/g,'.');break;}
    }
    const data={
      _про_файл:'Усі дані, які портал Push School зберігає про цю дитину.',
      _сформовано:new Date().toISOString(),
      учень:{імʼя:studentName,клас:cls.replace('class_',''),власний_вхід:ownLogin||'немає'},
      картка:card,
      батьки:parents,
      оцінки:pick(gradesSnap,3),
      типи_оцінок:pick(typesSnap,3),
      підсумкові:pick(semSnap,2),
      відвідуваність:pick(attSnap,1),
      поведінка:pick(behSnap,2),
      коментарі:pick(comSnap,2),
      заявки_на_перездачу:pick(retSnap,2),
      наліпки:stickSnap.exists()?stickSnap.val():{}
    };
    const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json;charset=utf-8'});
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download=`Дані_${studentName.replace(/\s+/g,'_')}_${new Date().toISOString().slice(0,10)}.json`;
    a.click();URL.revokeObjectURL(a.href);
    logAction('data_export',{cls,target:studentName});
    showToast('📦 Дані вивантажено');
  }catch(e){alert('Помилка: '+e.message);}
};
// ══════════════════════════════════════════════════════════════════
//  ДРУК РОЗКЛАДУ
// ══════════════════════════════════════════════════════════════════
// Розклад регулярно вішають на стіну. Матриця на екрані для цього не
// годиться, тому будуємо окрему чисту таблицю «урок × день» і друкуємо
// лише її — решту сторінки ховає правило @media print.
window.printClassSchedule=async function(cls){
  cls=cls||getActiveClass();
  if(!cls)return showToast('⚠️ Клас не визначено');
  const holder=document.getElementById('print-area');
  try{
    const [schedSnap,bellSnap]=await Promise.all([
      get(child(ref(db),`schedules/${cls}/lessons`)),
      get(child(ref(db),`bell_schedules/${cls}`))
    ]);
    if(!schedSnap.exists())return showToast('⚠️ Розклад цього класу не заповнено');
    const sched=schedSnap.val();
    const bells=bellSnap.exists()?bellSnap.val():{};
    const days=['Monday','Tuesday','Wednesday','Thursday','Friday'];
    // Скільки рядків потрібно — за найдовшим днем
    let maxRows=0;
    days.forEach(d=>{if(Array.isArray(sched[d]))maxRows=Math.max(maxRows,sched[d].length);});
    if(maxRows===0)return showToast('⚠️ У розкладі немає уроків');
    const cell=(d,i)=>{
      const slot=(sched[d]||[])[i];
      const items=Array.isArray(slot)?slot:(slot&&slot.subject?[slot]:[]);
      return items.map(l=>{
        const sn=typeof l.subject==='string'?l.subject:(l.subject?.ua||'');
        if(!sn)return '';
        const isBreak=sn.toLowerCase().includes('перерва')||sn.toLowerCase().includes('обід');
        return `<div class="${isBreak?'ps-break':''}">${escHtml(sn)}</div>`;
      }).join('');
    };
    const bellFor=(i)=>{
      const b=bells[i+1]||bells[String(i+1)];
      return b&&b.start?`${escHtml(b.start)}–${escHtml(b.end||'')}`:'';
    };
    let rows='';
    for(let i=0;i<maxRows;i++){
      const filled=days.some(d=>cell(d,i).trim());
      if(!filled)continue;
      rows+=`<tr><td class="ps-num">${i+1}<div class="ps-time">${bellFor(i)}</div></td>`+
        days.map(d=>`<td>${cell(d,i)}</td>`).join('')+'</tr>';
    }
    holder.innerHTML=`<div class="ps-sheet">
      <div class="ps-head">
        <div class="ps-title">Розклад уроків</div>
        <div class="ps-cls">${escHtml(cls.replace('class_',''))} клас · ${escHtml(ACADEMIC_YEAR_ID_LOCAL)} н.р.</div>
      </div>
      <table class="ps-table">
        <thead><tr><th>№</th>${days.map(d=>`<th>${escHtml(dayNamesUA[d])}</th>`).join('')}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="ps-foot">Push School Warsaw · роздруковано ${new Date().toLocaleDateString('uk-UA')}</div>
    </div>`;
    document.body.classList.add('printing');
    window.print();
    // Прибираємо після діалогу друку — інакше вміст лишиться у DOM
    setTimeout(()=>{document.body.classList.remove('printing');holder.innerHTML='';},600);
  }catch(e){alert('Помилка: '+e.message);}
};
// ══════════ ВХІД УЧНЯ (власний email) ══════════
// Раніше пошту учня можна було вказати ЛИШЕ під час створення. Якщо тоді її
// не ввели — додати чи змінити було ніде, і в списку не було видно, у кого
// взагалі є доступ. Тепер це керується звідси.
let studentLoginTarget={cls:'',name:'',oldEmail:''};
window.openStudentLogin=function(cls,name,oldEmail){
  studentLoginTarget={cls,name,oldEmail:oldEmail||''};
  document.getElementById('sl-student').textContent=name;
  document.getElementById('sl-email').value=oldEmail||'';
  document.getElementById('sl-remove').style.display=oldEmail?'block':'none';
  document.getElementById('student-login-modal').style.display='flex';
  setTimeout(()=>document.getElementById('sl-email').focus(),60);
};
window.closeStudentLogin=function(){document.getElementById('student-login-modal').style.display='none';};
window.saveStudentLogin=async function(){
  const {cls,name,oldEmail}=studentLoginTarget;
  const raw=document.getElementById('sl-email').value.trim().toLowerCase();
  if(!raw)return alert('Введіть email або натисніть «Прибрати вхід».');
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw))return alert('Схоже, це не email.');
  if(raw===oldEmail)return window.closeStudentLogin();
  const newSafe=raw.replace(/\./g,'_');
  try{
    const busy=await get(child(ref(db),`student_links/${newSafe}`));
    if(busy.exists()){
      const v=busy.val();
      return alert(`Ця адреса вже прив'язана до учня «${v.studentName}». Оберіть іншу.`);
    }
    await set(ref(db,`student_links/${newSafe}`),{studentName:name,class:cls});
    // Стару прив'язку прибираємо, інакше учень зможе заходити з обох адрес
    if(oldEmail)await remove(ref(db,`student_links/${oldEmail.replace(/\./g,'_')}`));
    logAction(oldEmail?'student_email':'student_login',{cls,target:name,value:raw,from:oldEmail||''});
    showToast(oldEmail?`✉️ Вхід змінено на ${raw}`:`🔑 Вхід створено: ${raw}`);
    window.closeStudentLogin();
    refreshRoster(cls);
  }catch(e){alert('Помилка: '+e.message);}
};
window.removeStudentLogin=async function(){
  const {cls,name,oldEmail}=studentLoginTarget;
  if(!oldEmail)return;
  if(!confirm(`Прибрати вхід для ${name}?\n\nУчень більше не зможе заходити у портал самостійно.\nОцінки та всі його дані залишаться недоторканими,\nбатьки бачитимуть їх як і раніше.\n\nПродовжити?`))return;
  try{
    await remove(ref(db,`student_links/${oldEmail.replace(/\./g,'_')}`));
    logAction('student_login_del',{cls,target:name,value:oldEmail});
    showToast('🔒 Вхід прибрано');
    window.closeStudentLogin();
    refreshRoster(cls);
  }catch(e){alert('Помилка: '+e.message);}
};
// Хто саме зараз відкрив редактор і куди повертатися після збереження
let parentEditorTarget={safeEmail:'',containerId:'',cls:''};
window.openParentEditor=async function(safeEmail){
  // Запам'ятовуємо, який список оновити після збереження
  const teacherBox=document.getElementById('t-parents-list');
  const visibleTeacher=teacherBox&&teacherBox.offsetParent!==null;
  parentEditorTarget={
    safeEmail,
    containerId:visibleTeacher?'t-parents-list':'po-list',
    cls:visibleTeacher?getActiveClass():(document.getElementById('po-class')?.value||'')
  };
  const modal=document.getElementById('parent-edit-modal');
  const body=document.getElementById('pe-fields');
  document.getElementById('pe-email').textContent=safeEmail.replace(/_/g,'.');
  body.innerHTML='<p class="empty-msg">Завантаження...</p>';
  modal.style.display='flex';
  const snap=await get(child(ref(db),`parent_links/${safeEmail}`));
  const rec=snap.exists()?snap.val():{};
  const profile=getParentProfile(rec);
  const kids=normalizeChildren(rec);
  body.innerHTML=PARENT_FIELDS.map(f=>`
    <label for="pe-${f.k}">${f.label}</label>
    <input type="${f.type||'text'}" id="pe-${f.k}" value="${escHtml(profile[f.k])}" placeholder="${escHtml(f.ph)}">
  `).join('')+renderParentKids(safeEmail,kids)+renderEmailChange(safeEmail);
};
// Прив'язані діти: можна змінити роль або відв'язати
function renderParentKids(safeEmail,kids){
  const opts=(sel)=>['mother','father','guardian']
    .map(r=>`<option value="${r}" ${r===sel?'selected':''}>${PARENT_ROLE_LABELS[r]}</option>`).join('');
  let h=`<div class="pe-section"><b>👶 Прив'язані діти</b>`;
  if(kids.length===0)h+=`<p class="empty-msg" style="font-size:.8rem;">Дітей не прив'язано.</p>`;
  else kids.forEach((k,i)=>{
    h+=`<div class="pe-kid">
      <span class="pe-kid-name">${escHtml(k.studentName)} <span style="color:#999;">(${escHtml(String(k.class||'').replace('class_',''))} кл.)</span></span>
      <select onchange="setParentChildRole('${escJs(safeEmail)}',${i},this.value)">${opts(k.role||'guardian')}</select>
      <button class="pe-unlink" onclick="unlinkParentChild('${escJs(safeEmail)}',${i},'${escJs(k.studentName)}')" title="Відв'язати">✖</button>
    </div>`;
  });
  return h+'</div>';
}
// Пошта — це ключ запису, тож «зміна email» = перенесення запису.
// ВАЖЛИВО: акаунт Firebase Auth так не переїжджає, тому попереджаємо.
function renderEmailChange(safeEmail){
  return `<div class="pe-section">
    <b>✉️ Змінити email</b>
    <p style="font-size:.75rem;color:#888;margin:4px 0 6px 0;">
      Контакти й діти перенесуться на нову адресу. Але вхід у портал прив'язаний
      до старої пошти — з новою людина заходить як «Перший вхід» і задає пароль наново.
    </p>
    <input type="email" id="pe-new-email" placeholder="нова@пошта.com" autocapitalize="none" spellcheck="false">
    <button onclick="changeParentEmail('${escJs(safeEmail)}')" style="background:#e67e22;color:#fff;margin-top:6px;">✉️ Перенести на новий email</button>
  </div>`;
}
async function refreshParentEditorAndList(safeEmail){
  await window.openParentEditor(safeEmail);
  const {containerId,cls}=parentEditorTarget;
  if(containerId&&cls)renderParentsBlock(containerId,cls);
}
window.setParentChildRole=async function(safeEmail,idx,role){
  const snap=await get(child(ref(db),`parent_links/${safeEmail}`));
  const kids=normalizeChildren(snap.exists()?snap.val():{});
  if(!kids[idx])return;
  kids[idx].role=role;
  await update(ref(db,`parent_links/${safeEmail}`),{children:kids});
  await syncParentUserChildren(safeEmail,kids);
  showToast('✅ Роль оновлено');
  const {containerId,cls}=parentEditorTarget;
  if(containerId&&cls)renderParentsBlock(containerId,cls);
};
window.unlinkParentChild=async function(safeEmail,idx,name){
  if(!confirm(`Відв'язати ${name} від ${safeEmail.replace(/_/g,'.')}?\n\nОцінки та інші дані дитини залишаться недоторканими —\nзникне лише доступ цих батьків до неї.`))return;
  const snap=await get(child(ref(db),`parent_links/${safeEmail}`));
  const kids=normalizeChildren(snap.exists()?snap.val():{});
  kids.splice(idx,1);
  await update(ref(db,`parent_links/${safeEmail}`),{children:kids});
  await syncParentUserChildren(safeEmail,kids);
  logAction('parent_unlink',{target:name,value:safeEmail.replace(/_/g,'.')});
  showToast(`🔓 ${name} відв'язаний`);
  refreshParentEditorAndList(safeEmail);
};
window.changeParentEmail=async function(oldSafe){
  const raw=document.getElementById('pe-new-email').value.trim().toLowerCase();
  if(!raw)return alert('Введіть нову адресу.');
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw))return alert('Схоже, це не email.');
  const newSafe=raw.replace(/\./g,'_');
  if(newSafe===oldSafe)return alert('Це та сама адреса.');
  const exists=await get(child(ref(db),`parent_links/${newSafe}`));
  if(exists.exists())return alert(`На ${raw} уже є запис. Об'єднання адрес робиться вручну.`);
  if(!confirm(`Перенести запис на ${raw}?\n\nСтара адреса ${oldSafe.replace(/_/g,'.')} перестане бути прив'язаною.\nЯкщо людина вже заходила зі старої пошти — доступ по ній зникне,\nа з новою вона увійде через «Перший вхід».\n\nПродовжити?`))return;
  try{
    const snap=await get(child(ref(db),`parent_links/${oldSafe}`));
    await set(ref(db,`parent_links/${newSafe}`),snap.exists()?snap.val():{});
    await remove(ref(db,`parent_links/${oldSafe}`));
    logAction('parent_email',{from:oldSafe.replace(/_/g,'.'),target:raw});
    showToast('✉️ Запис перенесено на нову адресу');
    window.closeParentEditor();
    const {containerId,cls}=parentEditorTarget;
    if(containerId&&cls)renderParentsBlock(containerId,cls);
  }catch(e){alert('Помилка: '+e.message);}
};
// Якщо батьки вже заходили — тримаємо їхній профіль у синхроні
async function syncParentUserChildren(safeEmail,kids){
  const email=safeEmail.replace(/_/g,'.').toLowerCase();
  const us=await getUsersSnap();
  if(!us.exists())return;
  const u=us.val();
  for(const uid in u){
    if((u[uid].email||'').toLowerCase()!==email||u[uid].role!=='parent')continue;
    const patch={children:kids};
    // Активна дитина зникла зі списку — перемикаємо на першу доступну
    const still=kids.find(k=>k.studentName===u[uid].studentName&&k.class===u[uid].class);
    if(!still&&kids[0]){patch.studentName=kids[0].studentName;patch.class=kids[0].class;patch.parentRole=kids[0].role||'guardian';}
    await update(ref(db,`users/${uid}`),patch);
  }
}
window.closeParentEditor=function(){document.getElementById('parent-edit-modal').style.display='none';};
window.saveParentProfile=async function(){
  const {safeEmail,containerId,cls}=parentEditorTarget;
  if(!safeEmail)return;
  const btn=document.getElementById('pe-save');
  const profile={};
  PARENT_FIELDS.forEach(f=>{
    const el=document.getElementById('pe-'+f.k);
    profile[f.k]=el?el.value.trim():'';
  });
  btn.disabled=true;btn.textContent='⏳ Збереження...';
  try{
    // update, а не set: children у цьому ж вузлі не можна зачепити
    await update(ref(db,`parent_links/${safeEmail}`),{profile});
    showToast('✅ Контакти збережено');
    logAction('parent_edit',{target:safeEmail.replace(/_/g,'.')});
    window.closeParentEditor();
    if(containerId&&cls)renderParentsBlock(containerId,cls);
  }catch(e){alert('Помилка: '+e.message);}
  finally{btn.disabled=false;btn.textContent='💾 Зберегти';}
};
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
// Повертає true / false / null. null означає «не змогли перевірити» —
// саме так буває до входу, коли правила ще не дають читати базу.
// Тоді підказку показуємо нейтральну, а не стверджуємо неправду.
async function isEmailApproved(rawEmail){
  const se=emailKey(rawEmail);
  if(!se)return false;
  try{
    const [rs,ls,sls]=await Promise.all([
      get(child(ref(db),`pre_approved_roles/${se}`)),
      get(child(ref(db),`parent_links/${se}`)),
      get(child(ref(db),`student_links/${se}`))
    ]);
    return rs.exists()||ls.exists()||sls.exists();
  }catch(e){ return null; }
}
const AUTH_ERRORS={
  'auth/invalid-email':'Невірний формат email.',
  'auth/too-many-requests':'Забагато спроб. Спробуйте за кілька хвилин.',
  'auth/network-request-failed':"Немає зв'язку із сервером. Перевірте інтернет.",
  'auth/user-disabled':'Цей акаунт відключено. Зверніться до адміністрації.',
  'auth/weak-password':'Пароль занадто простий (мінімум 6 символів).'
};
// ── ВХІД ЗА НІКНЕЙМОМ ──
// Firebase Authentication уміє входити лише за поштою. Але в молодших
// класах у дитини пошти немає, а вигадувати її батькам — зайвий крок і
// ще одна скринька, яку ніхто не читає.
//
// Тому нікнейм перетворюється на технічну адресу виду nick@pupil.push.local.
// Домен існує тільки всередині системи: листи на нього не ходять і не
// мають ходити. Для Firebase це звичайна пошта, для дитини — просто логін.
//
// Унікальність нікнеймів окремо стежити не треба: Firebase не дасть
// створити другий акаунт з тією самою адресою.
export const PUPIL_DOMAIN = 'pupil.push.local';

// Дозволяємо тільки те, що переживе перетворення на адресу і не зіпсує
// ключ у базі: латиниця, цифри, крапка, дефіс, підкреслення.
export function normalizeNick(v){
  return String(v || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
}
export function nickToEmail(nick){ return normalizeNick(nick) + '@' + PUPIL_DOMAIN; }
export function isPupilEmail(email){ return String(email||'').endsWith('@' + PUPIL_DOMAIN); }
export function emailToNick(email){
  return isPupilEmail(email) ? String(email).split('@')[0] : '';
}
// Що ввели у полі входу — пошту чи нікнейм
export function loginIdToEmail(raw){
  const v = String(raw || '').trim();
  return v.includes('@') ? v.toLowerCase() : nickToEmail(v);
}

// ── ЗВИЧАЙНИЙ ВХІД ──
window.submitLogin=async function(ev){
  if(ev&&ev.preventDefault)ev.preventDefault();
  const raw=document.getElementById('email').value.trim();
  const email=loginIdToEmail(raw);
  const byNick=!raw.includes('@');
  const pass=document.getElementById('pass').value;
  setMsg('login-error','');setMsg('login-hint','','login-hint');
  if(!raw||!pass){setMsg('login-error','Введіть email або нікнейм і пароль.','login-err');return false;}
  setBusy('btn-login-submit',true);
  try{
    await signInWithEmailAndPassword(auth,email,pass);
    // Успіх — onAuthStateChanged сам відкриє потрібний кабінет.
  }catch(err){
    setBusy('btn-login-submit',false,'Увійти');
    const code=err&&err.code||'';
    if(code==='auth/user-not-found'){
      // Акаунт учня створює хтось із батьків — самостійного «першого входу»
      // за нікнеймом не буває, тож не пропонуємо його.
      if(byNick){
        setMsg('login-error','Такого нікнейма немає. Перевірте написання або попросіть батьків.','login-err');
        return false;
      }
      const approved=await isEmailApproved(email);
      if(approved!==false)
        window.showFirstLoginScreen(email,'Схоже, це ваш <b>перший вхід</b> — акаунта ще немає. Придумайте пароль нижче.');
      else
        setMsg('login-error','Цей email не зареєстровано у школі.','login-err');
      return false;
    }
    if(code==='auth/invalid-credential'||code==='auth/wrong-password'){
      // Firebase із захистом від перебору не розрізняє "немає акаунта" і
      // "невірний пароль", тому підказуємо обидва варіанти.
      setMsg('login-error', byNick ? 'Невірний нікнейм або пароль.' : 'Невірний email або пароль.','login-err');
      if(byNick){
        setMsg('login-hint','Пароль можна змінити в кабінеті батьків.','login-hint');
        return false;
      }
      if(await isEmailApproved(email)!==false)
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
    // Список дозволених пошт лежить у базі, а читати її можна лише після
    // входу. Тому спершу створюємо акаунт, а перевірку робить обробник
    // входу — він побачить, що пошти немає, і коректно завершить сеанс.
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
  // Нікнейм не має пошти, тож і листа надсилати нікуди. Пароль дитині
  // змінює хтось із батьків у своєму кабінеті.
  if(!email.includes('@') || isPupilEmail(email)){
    setMsg('login-hint','Це вхід за нікнеймом — листа надсилати нікуди. Пароль змінюють батьки у своєму кабінеті, розділ «Доступ дитини».','login-hint');
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
window.logoutUser=function(){if(window.stopWatchUnread)window.stopWatchUnread();if(teacherAttendanceListener)teacherAttendanceListener();if(parentLessonInterval)clearInterval(parentLessonInterval);document.getElementById('profile-bar').style.display='none';signOut(auth);};
// ══════════ ADMIN DASHBOARD ══════════
window.loadAdminDashboard=async function(){try{const date=document.getElementById('global-date').value;document.getElementById('a-att-header').innerText=`🚨 Відсутні (${date.split('-').reverse().slice(0,2).join('.')})`;const wd=getWeekDates(date);let wl=0,wa=0,hw=0,com=0;const _lo=wd[0]<date?wd[0]:date, _hi=wd[wd.length-1]>date?wd[wd.length-1]:date;const[_ad,_hd,_cd]=await Promise.all([getSchoolRange('attendance',_lo,_hi),getSchoolRange('homeworks',_lo,_hi),getSchoolRange('comments',_lo,_hi)]);const s={exists:()=>true,val:()=>_ad},hwS={exists:()=>true,val:()=>_hd},comS={exists:()=>true,val:()=>_cd};let h='';if(s.exists()){const d=s.val();for(let i=1;i<=11;i++){const c=`class_${i}`;if(d[c]&&d[c][date])for(let st in d[c][date]){const slots=d[c][date][st];for(let sk in slots){const r=slots[sk];if(r?.status){const bc=r.status==='late'?'badge-late':'badge-absent';const markerIcon=r.markedBy==='teacher'?'👨‍🏫':(r.markedBy==='student'?'🎒':(r.markedBy==='administrator'?'🛡️':'👪'));h+=`<li style="margin-bottom:9px;border-bottom:1px solid #eee;padding-bottom:4px;"><span style="font-size:.72rem;background:var(--teal);color:#fff;padding:2px 5px;border-radius:4px;margin-right:4px;">${i} Кл</span> <b>${escHtml(stuName(c, st))}</b> <span class="badge ${bc}">${r.status==='late'?'Запізнення':'Відсутність'}</span> <span style="font-size:.72rem;color:#888;">${escHtml(formatAttendanceSlotLabel(sk))} ${markerIcon}</span></li>`;}}}
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
  if(snap.exists())Object.entries(snap.val()).sort((a,b)=>String(a[1]).localeCompare(String(b[1]),'uk')).forEach(([sid,nm])=>{const o=document.createElement('option');o.value=sid;o.innerText=nm;sel.appendChild(o);});
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
  showToast(`✅ ${stuName(cls, st)}: ${status==='late'?'запізнення':'відсутність'} (${reason})`);
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
// Листування переїхало в chat.js: модель змінилася з «дві пошти» на
// список учасників, і код виріс до окремого модуля.

// Поле вводу поводиться як у месенджері: росте під текст, Enter надсилає,
// Shift+Enter переносить рядок. Без цього доводиться цілитися в кнопку.
(function(){
  const bind = () => {
    const ta = document.getElementById('msg-text-input');
    if(!ta || ta.dataset.bound) return;
    ta.dataset.bound = '1';
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 110) + 'px'; };
    ta.addEventListener('input', grow);
    ta.addEventListener('keydown', e=>{
      if(e.key === 'Enter' && !e.shiftKey){
        e.preventDefault();
        if(window.sendInboxMessage) window.sendInboxMessage();
        setTimeout(()=>{ ta.style.height='auto'; }, 0);
      }
    });
  };
  document.addEventListener('DOMContentLoaded', bind);
  bind();
})();
