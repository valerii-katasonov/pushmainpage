// ═══════════════════════════════════════════════════════════════
// parent-student.js — parent-screen and student-screen: dynamic
// "today's schedule" widget, payments mockup, attendance submit,
// grade reactions, and retake-request submission (the review side
// lives in teacher.js).
// ═══════════════════════════════════════════════════════════════
import { ref, set, get, child } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, getActiveClass, currentUserData, STICKER_GOAL, getWeekDates, displayGrade, gradeClass6, showToast, renderHwItem, dayKeys, localDateString, formatAttendanceSlotLabel, renderGradeFormulaInfo, escJs, escHtml, safeUrl, renderBirthdays } from './common.js';
import { ACADEMIC_YEAR_ID } from './director.js';
import { renderParentMenu } from './kitchen.js';

// parentLessonInterval is reassigned only here and read/cleared from
// common.js's logoutUser — plain export/import.
export let parentLessonInterval=null;

// "all" is the reserved slotKey that submitAttendance() below writes under —
// it represents a whole-day self-report from the parent/student (they don't
// pick a specific lesson), as opposed to teacher's per-lesson slotKeys.
const SELF_REPORT_SLOT='all';
// Checks today's attendance/{cls}/{date}/{student} slot-map for teacher-marked
// entries that the parent/student hasn't acknowledged (no "all" self-report
// and no self-report on that exact slotKey), and shows/hides a persistent
// alert banner (#p-teacher-alert-banner / #s-teacher-alert-banner).
async function checkTeacherAttendanceAlert(role='parent'){
  const prefix=role==='student'?'s':'p';
  const banner=document.getElementById(`${prefix}-teacher-alert-banner`);
  if(!banner||!currentUserData)return;
  const date=document.getElementById('global-date').value;
  const cls=getActiveClass();
  const snap=await get(child(ref(db),`attendance/${cls}/${date}/${currentUserData.studentName}`));
  if(!snap.exists()){banner.style.display='none';return;}
  const slots=snap.val();
  const selfSlotKeys=new Set(Object.entries(slots).filter(([,r])=>r&&(r.markedBy==='parent'||r.markedBy==='student')).map(([k])=>k));
  const hasSelfAll=selfSlotKeys.has(SELF_REPORT_SLOT);
  const uncovered=Object.entries(slots).filter(([k,r])=>r&&r.markedBy==='teacher'&&!hasSelfAll&&!selfSlotKeys.has(k));
  if(uncovered.length>0){
    const list=uncovered.map(([k,r])=>`${formatAttendanceSlotLabel(k)} — ${r.status==='absent'?'відсутність':'запізнення'}`).join(', ');
    banner.innerHTML=`🚨 <b>Вчитель відмітив:</b> ${list}. Якщо це помилка або вам відомі причини — повідомте вчителя.`;
    banner.style.display='block';
  } else banner.style.display='none';
}

// ══════════ DYNAMIC SCHEDULE (PARENT/STUDENT) ══════════
function buildDynamicSchedule(schedule,dayName,isToday){
  if(!schedule||!schedule[dayName])return null;
  const flat=[];
  (schedule[dayName]||[]).forEach(slot=>{const items=Array.isArray(slot)?slot:(slot&&slot.subject?[slot]:[]);items.forEach(l=>{if(l&&l.time&&l.subject){const sn=typeof l.subject==='string'?l.subject:(l.subject.ua||'');if(!sn.toLowerCase().includes('перерва'))flat.push(l);}});});
  return flat;
}
// Заміни на обрану дату: {індекс слота → дані}. Тримаємо окремо, щоб
// renderDynamicSchedule лишався синхронним — він викликається щохвилини
// з таймера, і читати базу звідти не можна.
let todaySubs={};
export async function loadTodaySubstitutions(cls,date){
  try{
    const snap=await get(child(ref(db),`substitutions/${date}/${cls}`));
    todaySubs=snap.exists()?snap.val():{};
  }catch(e){todaySubs={};}
}
function renderDynamicSchedule(role='parent'){
  if(!window.schedule)return;
  const prefix = role==='student'?'s':'p';
  const now=new Date();const currentMins=now.getHours()*60+now.getMinutes();
  const todayDow=now.getDay();const todayDayName=dayKeys[todayDow];
  const tomorrowDate=new Date(now);tomorrowDate.setDate(tomorrowDate.getDate()+1);
  const tomorrowDow=tomorrowDate.getDay();const tomorrowDayName=dayKeys[tomorrowDow];
  // Check if today's lessons are all done
  const todayLessons=buildDynamicSchedule(window.schedule,todayDayName,true)||[];
  let lastEndMins=0;
  todayLessons.forEach(l=>{const[,e]=(l.time||'').split(' - ');if(e){const[eh,em]=e.split(':');const em2=parseInt(eh)*60+parseInt(em);if(em2>lastEndMins)lastEndMins=em2;}});
  const showTomorrow=todayLessons.length>0&&currentMins>=lastEndMins&&lastEndMins>0;
  const targetDayName=showTomorrow?tomorrowDayName:todayDayName;
  const label=showTomorrow?'📅 Розклад на завтра':'📅 Розклад на сьогодні';
  const lblEl=document.getElementById(`${prefix}-schedule-day-label`);if(lblEl)lblEl.textContent=label;
  const lessons=buildDynamicSchedule(window.schedule,targetDayName,!showTomorrow)||[];
  const container=document.getElementById(`${prefix}-dynamic-schedule`);if(!container)return;
  if(lessons.length===0){container.innerHTML='<div class="no-lessons-msg">🎉 Уроків немає — вихідний!</div>';return;}
  let html='';
  lessons.forEach((l,i)=>{
    const sn=typeof l.subject==='string'?l.subject:(l.subject.ua||'');
    const [startStr,endStr]=(l.time||'').split(' - ');
    let isCurrent=false;let isPassed=false;let countdown='';let progress=0;
    if(!showTomorrow&&startStr&&endStr){
      const[sh,sm]=startStr.split(':');const sMins=parseInt(sh)*60+parseInt(sm);
      const[eh,em]=endStr.split(':');const eMins=parseInt(eh)*60+parseInt(em);
      isCurrent=currentMins>=sMins&&currentMins<eMins;isPassed=currentMins>=eMins;
      if(isCurrent){const rem=eMins-currentMins;countdown=`${rem} хв`;progress=Math.round(((currentMins-sMins)/(eMins-sMins))*100);}
    }
    // Заміни зіставляємо за індексом уроку в розкладі дня
    const sub=todaySubs[i];
    html+=`<div class="lesson-row${isCurrent?' current':isPassed?' passed':''}">
      <div class="lesson-num">${i+1}</div>
      <div class="lesson-info">
        <div class="lesson-subj">${escHtml(sn)}${sub?' <span class="sub-badge">заміна</span>':''}</div>
        <div class="lesson-time">${l.time||'—'}${sub&&sub.subName?` · ${escHtml(sub.subName)}`:''}</div>
        ${isCurrent?`<div class="progress-thin"><div class="progress-thin-fill" style="width:${progress}%"></div></div>`:''}
      </div>
      ${isCurrent?`<div class="lesson-countdown">⏱ ${countdown}</div>`:''}
    </div>`;
  });
  container.innerHTML=html;
}
// ══════════ PAYMENTS MOCKUP ══════════
export function renderPaymentsMockup(){
  const el=document.getElementById('payments-section');if(!el)return;
  const today=new Date();const isFirstOfMonth=today.getDate()===1;
  el.innerHTML=`
  <div class="payment-card">
    <h4>🏫 Оплата за навчання</h4>
    ${isFirstOfMonth?'<div style="background:#fff3cd;border-radius:8px;padding:6px 11px;font-size:.8rem;color:#856404;margin-bottom:8px;">🔔 Нагадування: сьогодні 1-ше число — день оплати!</div>':''}
    <div class="payment-row"><span>Листопад 2025</span><span class="pay-amount pay-paid">✅ Оплачено</span></div>
    <div class="payment-row"><span>Грудень 2025</span><span class="pay-amount pay-due">3 500 грн <span class="debt-badge">Борг</span></span></div>
    <button class="pay-btn" style="margin-top:10px;width:100%;">💳 Оплатити зараз (тестово)</button>
    <p style="font-size:.7rem;color:#aaa;text-align:center;margin-top:5px;">* Платіжна інтеграція у розробці</p>
  </div>
  <div class="payment-card">
    <h4>🍽️ Харчування</h4>
    <div class="payment-row"><span>Поточний баланс</span><span class="pay-amount pay-paid">450 грн</span></div>
    <div class="payment-row"><span>Поточний тиждень (передплата)</span><span class="pay-amount">250 грн</span></div>
    <div class="payment-row" style="font-size:.8rem;color:#888;"><span>Перерахунок щопонеділка</span><span>—</span></div>
    <button class="pay-btn" style="margin-top:10px;width:100%;">+ Поповнити баланс харчування</button>
  </div>
  <div class="payment-card">
    <h4>🎭 Додаткові послуги</h4>
    <div class="payment-row"><span>🎵 Школа мистецтв</span><span class="pay-amount"><span class="paid-badge">Оплачено</span></span></div>
    <div class="payment-row"><span>🏊 Басейн (грудень)</span><span class="pay-amount pay-due">450 грн</span></div>
    <div class="payment-row"><span>🚌 Екскурсія (12 груд.)</span><span class="pay-amount pay-due">200 грн</span></div>
    <button class="pay-btn" style="margin-top:10px;width:100%;">💳 Оплатити послуги</button>
  </div>
  <div class="payment-card" style="border:1px solid #f5c6cb;">
    <h4 style="color:var(--red);">⚠️ Заборгованість</h4>
    <div class="payment-row"><span>Загальна сума боргу</span><span class="pay-amount pay-due">4 150 грн</span></div>
    <p style="font-size:.75rem;color:#888;margin:6px 0 0 0;">Будь ласка, погасіть заборгованість до 10 числа поточного місяця.</p>
  </div>`;
}
// ══════════ TEXTBOOKS (parent/student side) ══════════
export async function loadTextbooksForParent(role='parent'){
  const prefix = role==='student'?'s':'p';
  const cls=getActiveClass();const snap=await get(ref(db,`textbooks/${cls}`));
  const container=document.getElementById(`${prefix}-textbooks-list`);if(!container)return;
  container.innerHTML='';
  if(snap.exists()){const data=snap.val();let html='';for(let subj in data){for(let k in data[subj]){const tb=data[subj][k];html+=`<div class="textbook-item">📘 <b>${escHtml(subj)}:</b> <a href="${safeUrl(tb.url)}" target="_blank" rel="noopener noreferrer">${escHtml(tb.title||tb.url)}</a></div>`;}}container.innerHTML=html||'<p class="empty-msg">Підручників немає.</p>';}
  else container.innerHTML='<p class="empty-msg">Підручників немає.</p>';
}
// ══════════ CALENDAR (read-only): holidays / breaks / exams ══════════
// Reuses the .cal-grid/.cal-day CSS already used by teacher.js's exams
// calendar (renderExamsCalendar/manageDayExams — untouched). Three new
// highlight classes (has-exam-p/has-holiday-p/has-break-p, "-p" so they
// never collide with the teacher-side .has-1/.has-2) are added in the
// stylesheet; see the accompanying CSS block.
// currentUserData.isArtSchool doesn't exist in the schema yet — if it's
// ever added (e.g. at registration/linking time) this immediately starts
// filtering "art_school" holidays correctly; until then every family sees
// the "general" school calendar, per the task's explicit fallback.
window.renderParentCalendar=async function(role='parent'){
  const prefix=role==='student'?'s':'p';
  const monthInput=document.getElementById(`${prefix}-cal-month-select`);
  if(!monthInput)return;
  if(!monthInput.value){const now=new Date();monthInput.value=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;}
  const ym=monthInput.value;const [y,m]=ym.split('-');
  const cls=getActiveClass();
  const grid=document.getElementById(`${prefix}-cal-grid`);
  if(!grid)return;
  grid.innerHTML='<p class="empty-msg">⏳ Завантаження...</p>';
  const [examsSnap,holidaysSnap,breaksSnap]=await Promise.all([
    get(ref(db,`exams/${cls}/${ym}`)),
    get(ref(db,`academic_year/${ACADEMIC_YEAR_ID}/holidays`)),
    get(ref(db,`academic_year/${ACADEMIC_YEAR_ID}/breaks`))
  ]);
  const examsData=examsSnap.exists()?examsSnap.val():{};
  const allHolidays=holidaysSnap.exists()?Object.values(holidaysSnap.val()):[];
  const allBreaks=breaksSnap.exists()?Object.values(breaksSnap.val()):[];
  const myCalendarType=currentUserData?.isArtSchool?'art_school':'general';
  const classMatches=cs=>cs==='all'||(Array.isArray(cs)&&cs.includes(cls));
  const holidaysInMonth={};
  allHolidays.forEach(h=>{if(h.date&&h.date.startsWith(ym)&&(!h.calendarType||h.calendarType===myCalendarType)&&classMatches(h.classes))(holidaysInMonth[h.date]=holidaysInMonth[h.date]||[]).push(h);});
  const breaksInMonth={};
  const monthStart=new Date(y,parseInt(m)-1,1);const monthEnd=new Date(y,parseInt(m),0);
  allBreaks.forEach(b=>{
    if(!b.startDate||!b.endDate||!classMatches(b.classes))return;
    const s=new Date(b.startDate)<monthStart?monthStart:new Date(b.startDate);
    const e=new Date(b.endDate)>monthEnd?monthEnd:new Date(b.endDate);
    for(let cur=new Date(s);cur<=e;cur.setDate(cur.getDate()+1)){
      const ds=`${cur.getFullYear()}-${String(cur.getMonth()+1).padStart(2,'0')}-${String(cur.getDate()).padStart(2,'0')}`;
      (breaksInMonth[ds]=breaksInMonth[ds]||[]).push(b);
    }
  });
  const dim=new Date(y,parseInt(m),0).getDate();let fd=new Date(y,parseInt(m)-1,1).getDay();if(fd===0)fd=7;
  let h='<div class="cal-grid">';
  ['Пн','Вт','Ср','Чт','Пт','Сб','Нд'].forEach(d2=>h+=`<div class="cal-header">${d2}</div>`);
  for(let i=1;i<fd;i++)h+='<div></div>';
  for(let i=1;i<=dim;i++){
    const ds=`${y}-${m}-${String(i).padStart(2,'0')}`;
    const hasExam=!!(examsData[ds]&&Object.keys(examsData[ds]).length>0);
    const hasHoliday=!!holidaysInMonth[ds];
    const hasBreak=!!breaksInMonth[ds];
    const typesCount=[hasExam,hasHoliday,hasBreak].filter(Boolean).length;
    let cc='';
    if(typesCount>1)cc='has-multiple-p';
    else if(hasExam)cc='has-exam-p';
    else if(hasHoliday)cc='has-holiday-p';
    else if(hasBreak)cc='has-break-p';
    const clickable=typesCount>0?` onclick="showParentCalDayDetails('${role}','${ds}')"`:'';
    h+=`<div class="cal-day ${cc}"${clickable}>${i}</div>`;
  }
  h+='</div>';
  grid.innerHTML=h;
  document.getElementById(`${prefix}-cal-day-details`).style.display='none';
};
window.showParentCalDayDetails=async function(role,ds){
  const prefix=role==='student'?'s':'p';
  const dd=document.getElementById(`${prefix}-cal-day-details`);
  if(!dd)return;
  dd.style.display='block';dd.innerHTML='<p class="empty-msg">⏳ Завантаження...</p>';
  const cls=getActiveClass();const ym=ds.substring(0,7);
  const myCalendarType=currentUserData?.isArtSchool?'art_school':'general';
  const classMatches=cs=>cs==='all'||(Array.isArray(cs)&&cs.includes(cls));
  const [examsSnap,holidaysSnap,breaksSnap]=await Promise.all([
    get(ref(db,`exams/${cls}/${ym}/${ds}`)),
    get(ref(db,`academic_year/${ACADEMIC_YEAR_ID}/holidays`)),
    get(ref(db,`academic_year/${ACADEMIC_YEAR_ID}/breaks`))
  ]);
  let h=`<h4 style="margin-top:0;color:#8e44ad;border-bottom:1px dashed #ce93d8;padding-bottom:9px;">${ds.split('-').reverse().join('.')}</h4>`;
  let hasAny=false;
  if(examsSnap.exists()){
    hasAny=true;
    h+=`<p style="margin:8px 0;"><b style="color:#6a1b9a;">📝 Контрольні:</b> ${Object.keys(examsSnap.val()).join(', ')}</p>`;
  }
  if(holidaysSnap.exists()){
    const hs=Object.values(holidaysSnap.val()).filter(hd=>hd.date===ds&&(!hd.calendarType||hd.calendarType===myCalendarType)&&classMatches(hd.classes));
    if(hs.length>0){hasAny=true;h+=`<p style="margin:8px 0;"><b style="color:#2e7d32;">🎉 Свято:</b> ${hs.map(hd=>hd.title).join(', ')}</p>`;}
  }
  if(breaksSnap.exists()){
    const bs=Object.values(breaksSnap.val()).filter(b=>b.startDate<=ds&&b.endDate>=ds&&classMatches(b.classes));
    if(bs.length>0){hasAny=true;bs.forEach(b=>{h+=`<p style="margin:8px 0;"><b style="color:#01579b;">🏖️ Канікули:</b> ${b.title} (${b.startDate.split('-').reverse().join('.')} — ${b.endDate.split('-').reverse().join('.')})</p>`;});}
  }
  if(!hasAny)h+='<p class="empty-msg">Подій немає.</p>';
  dd.innerHTML=h;
};
// ══════════ BELL SCHEDULE (read-only, from Phase 2's bell_schedules) ══════════
window.loadParentBellSchedule=async function(role='parent'){
  const prefix=role==='student'?'s':'p';
  const container=document.getElementById(`${prefix}-bell-schedule-table`);
  if(!container)return;
  const cls=getActiveClass();
  const snap=await get(ref(db,`bell_schedules/${cls}`));
  if(!snap.exists()){container.innerHTML='<p class="empty-msg">Розклад дзвінків ще не задано.</p>';return;}
  const d=snap.val();
  const rows=Object.keys(d).sort((a,b)=>(parseInt(a)||0)-(parseInt(b)||0)).map(k=>d[k]);
  let h='<table style="width:100%;border-collapse:collapse;font-size:.85rem;">';
  rows.forEach(s=>{h+=`<tr><td style="padding:5px 8px;border-bottom:1px solid #eee;font-weight:700;color:#3949ab;">${s.number}</td><td style="padding:5px 8px;border-bottom:1px solid #eee;">${s.start} — ${s.end}</td></tr>`;});
  h+='</table>';
  container.innerHTML=h;
};
// ══════════ RETAKE REQUEST (parent/student submit side) ══════════
async function sendRetakeRequest(cls,subj,date,student,grade){
  const yearSnap=await get(ref(db,`grades/${cls}`));
  let totalLessons=0;let subjLessons=0;
  if(yearSnap.exists()){const d=yearSnap.val();for(let m in d)if(d[m][subj])for(let dt in d[m][subj])subjLessons++;}
  const limit=Math.max(1,Math.floor(subjLessons*0.1));
  const existingSnap=await get(ref(db,`retake_requests/${cls}/${subj}`));
  let existing=0;if(existingSnap.exists()){const ed=existingSnap.val();for(let dt in ed)if(ed[dt][student])existing++;}
  if(existing>=limit){showToast(`🚫 Ви вже використали всі можливості для покращення оцінок з ${subj} (ліміт ${limit})`);return;}
  await set(ref(db,`retake_requests/${cls}/${subj}/${date}/${student}`),{status:'pending',grade,requestDate:localDateString});
  showToast(`🔄 Запит на перездачу надіслано вчителю!`);
}
window.sendRetakeRequest=sendRetakeRequest;
// ══════════ PARENT DASHBOARD ══════════
export function loadParentDashboard(){
  if(!currentUserData)return;const date=document.getElementById('global-date').value;const cls=getActiveClass();
  // Dynamic schedule
  if(window.schedule){renderDynamicSchedule();if(parentLessonInterval)clearInterval(parentLessonInterval);parentLessonInterval=setInterval(renderDynamicSchedule,30000);}
  // Stickers
  get(child(ref(db),`stickers/${cls}/${currentUserData.studentName}`)).then(snap=>{const cnt=snap.exists()?Object.keys(snap.val()).length:0;const pct=Math.min((cnt/STICKER_GOAL)*100,100);document.getElementById('p-ribbon-progress').style.width=pct+'%';document.getElementById('p-ribbon-count').innerText=`${cnt} / ${STICKER_GOAL} наліпок до призу`;const me=document.getElementById('p-ribbon-msg');if(me){if(cnt>=STICKER_GOAL){me.innerText="🎉 Ура! Ти досяг мети!";confetti({particleCount:150,spread:80,origin:{y:0.5}});}else me.innerText='';}}).catch(()=>document.getElementById('p-ribbon-count').innerText="Помилка");
  // Att status (self-report confirmation lives under the "all" slot)
  get(child(ref(db),`attendance/${cls}/${date}/${currentUserData.studentName}/${SELF_REPORT_SLOT}`)).then(snap=>{const se=document.getElementById('p-att-status');if(snap.exists()){const d=snap.val();se.innerText=`✅ Ви повідомили: ${d.status==='late'?'Запізнення':'Відсутність'} (${d.reason})`;se.style.display='block';}else se.style.display='none';});
  // Persistent alert if the teacher marked something the parent hasn't acknowledged
  checkTeacherAttendanceAlert('parent');
  // Calendar (holidays/breaks/exams) + bell schedule — Phase 3
  renderParentCalendar('parent');loadParentBellSchedule('parent');
  // HW
  get(child(ref(db),`homeworks/${cls}/${date}`)).then(snap=>{const hl=document.getElementById('p-daily-hw-list');hl.innerHTML='';if(snap.exists()){const d=snap.val();for(let s in d)hl.innerHTML+=renderHwItem(s,d[s]);}else hl.innerHTML='<li class="empty-msg">ДЗ не задано.</li>';});
  // Textbooks
  loadTextbooksForParent();
  loadAiDayContext('p');
  renderBirthdays('p-birthdays',cls,date,currentUserData.studentName);
  renderFinalGrades('p-final-grades',cls,currentUserData.studentName);
  loadTodaySubstitutions(cls,date).then(()=>renderDynamicSchedule('parent'));
  renderConsents();
  renderParentMenu(cls,currentUserData.studentName,date);
  // Grades + comments + behavior
  const ym=date.substring(0,7);
  Promise.all([
    get(child(ref(db),`comments/${cls}/${date}`)),
    get(child(ref(db),`reactions/${cls}/${date}`)),
    get(child(ref(db),`grades/${cls}/${ym}`)),
    get(child(ref(db),`grade_types/${cls}/${ym}`)),
    get(child(ref(db),`behavior_grades/${cls}/${ym}`))
  ]).then(([cmS,rxS,grS,gtS,bhS])=>{
    const list=document.getElementById('p-daily-comments-list');list.innerHTML=renderGradeFormulaInfo();let hasItems=false;
    const rx=rxS.exists()?rxS.val():{};const gr=grS.exists()?grS.val():{};const gt=gtS.exists()?gtS.val():{};
    const sn=currentUserData.studentName;
    const subjs=new Set();
    if(cmS.exists())Object.keys(cmS.val()).forEach(s=>subjs.add(s));
    if(grS.exists())Object.keys(gr).forEach(s=>{if(gr[s][date]&&gr[s][date][sn])subjs.add(s);});
    subjs.forEach(s=>{
      const cm=cmS.exists()&&cmS.val()[s]&&cmS.val()[s][sn]?cmS.val()[s][sn]:'';
      const gv=gr[s]&&gr[s][date]&&gr[s][date][sn]?gr[s][date][sn]:'';
      const gtp=gt[s]&&gt[s][date]&&gt[s][date][sn]?gt[s][date][sn]:'';
      if(cm||gv){
        hasItems=true;const cr=rx[s]?.[sn]||null;const gc=gradeClass6(gv);const dispVal=displayGrade(gv,cls);
        let gHtml=gv?`<span class="g-cell ${gc}" style="display:inline-flex;padding:4px 9px;border-radius:8px;gap:5px;margin-bottom:3px;"><span class="g-val">${dispVal}</span>${gtp?`<span class="g-type">${gtp}</span>`:''}</span>`:'';
        // Retake button
        let retakeBtn='';if(gv){const n=parseInt(gv);if(!isNaN(n)&&n<=3)retakeBtn=`<button class="retake-btn" onclick="sendRetakeRequest('${cls}','${escJs(s)}','${date}','${escJs(sn)}',${n})" style="margin-left:6px;">🔄 Покращити</button>`;}
        const rxHtml=`<div style="display:flex;gap:8px;margin-top:8px;padding-top:7px;border-top:1px dashed #eee;align-items:center;"><button style="background:none;border:none;font-size:1.3rem;cursor:pointer;filter:${cr==='👍'?'none':'grayscale(100%)'};opacity:${cr==='👍'?'1':'.5'};padding:4px;width:auto;margin:0;" onclick="sendReaction('${date}','${escJs(s)}','👍')">👍</button><button style="background:none;border:none;font-size:1.3rem;cursor:pointer;filter:${cr==='❤️'?'none':'grayscale(100%)'};opacity:${cr==='❤️'?'1':'.5'};padding:4px;width:auto;margin:0;" onclick="sendReaction('${date}','${escJs(s)}','❤️')">❤️</button><button style="background:none;border:none;font-size:1.3rem;cursor:pointer;filter:${cr==='🔥'?'none':'grayscale(100%)'};opacity:${cr==='🔥'?'1':'.5'};padding:4px;width:auto;margin:0;" onclick="sendReaction('${date}','${escJs(s)}','🔥')">🔥</button></div>`;
        list.innerHTML+=`<li><b>${escHtml(s)}:</b><br>${gHtml}${retakeBtn}${cm?`<div style="background:#f0f8ff;padding:5px 9px;border-radius:6px;font-style:italic;font-size:.88rem;margin-top:3px;">${escHtml(cm)}</div>`:''}${rxHtml}</li>`;
      }
    });
    if(!hasItems)list.innerHTML+='<li class="empty-msg">Немає оцінок або коментарів.</li>';
    // Behavior
    const bEl=document.getElementById('p-behavior-list');bEl.innerHTML='';
    if(bhS.exists()){const bd=bhS.val();const wDates=getWeekDates(date);let bh='';wDates.forEach(wd=>{if(bd[wd]&&bd[wd][sn]){const bv=bd[wd][sn];const dispBv=displayGrade(String(bv),cls);const gc=gradeClass6(bv);bh+=`<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px dashed #c5cae9;font-size:.85rem;"><span style="color:#888;flex:1;">${wd.split('-').slice(1).reverse().join('.')}</span><span class="g-cell ${gc}" style="padding:3px 8px;">${dispBv}</span></div>`;}});bEl.innerHTML=bh||'<p class="empty-msg" style="font-size:.82rem;">Оцінок поведінки немає.</p>';}
    else bEl.innerHTML='<p class="empty-msg" style="font-size:.82rem;">Оцінок поведінки немає.</p>';
  });
}
// ══════════ ПІДСУМКОВІ ОЦІНКИ У БАТЬКІВ/УЧНЯ ══════════
// Показуємо лише виставлені вчителем підсумкові — жодних «попередніх»
// розрахунків: сім'я не має бачити прогноз, який учитель ще не підтвердив.
export async function renderFinalGrades(containerId,cls,studentName){
  const box=document.getElementById(containerId);
  if(!box)return;
  try{
    const [semSnap,gradesSnap]=await Promise.all([
      get(child(ref(db),`academic_year/${ACADEMIC_YEAR_ID}/semesters`)),
      get(child(ref(db),`semester_grades/${cls}`))
    ]);
    if(!gradesSnap.exists()){box.style.display='none';return;}
    const sems=semSnap.exists()?semSnap.val():{};
    const all=gradesSnap.val();
    let html='';
    for(const semId in all){
      const rows=[];
      for(const subj in all[semId]){
        const rec=all[semId][subj]&&all[semId][subj][studentName];
        if(rec&&rec.value)rows.push({subj,v:rec.value});
      }
      if(rows.length===0)continue;
      rows.sort((a,b)=>a.subj.localeCompare(b.subj,'uk'));
      html+=`<div class="fin-title">🎓 ${escHtml(sems[semId]?.name||semId)}</div>`+
        rows.map(r=>`<div class="fin-row">
          <span>${escHtml(r.subj)}</span>
          <span class="g-cell ${gradeClass6(r.v)}" style="padding:3px 9px;">${escHtml(displayGrade(r.v,cls))}</span>
        </div>`).join('');
    }
    if(!html){box.style.display='none';return;}
    box.style.display='block';box.innerHTML=html;
  }catch(e){box.style.display='none';}
}
// Табель активної дитини (у батьків) або власний (в учня)
window.downloadMyReportCard=function(){
  if(!currentUserData?.class||!currentUserData?.studentName)
    return showToast('⚠️ Дитина не визначена');
  window.downloadReportCard(currentUserData.class,currentUserData.studentName);
};
// ══════════ ЗГОДИ БАТЬКІВ ══════════
// Показуємо лише ті запити, що стосуються класу дитини. Уже відповіді
// не ховаємо — батьки мають бачити, що саме вони підтвердили і коли.
export async function renderConsents(){
  const box=document.getElementById('p-consents');
  if(!box||currentUserData?.role!=='parent')return;
  const cls=currentUserData.class, name=currentUserData.studentName;
  try{
    const [cSnap,rSnap]=await Promise.all([
      get(child(ref(db),'consents')),
      get(child(ref(db),'consent_responses'))
    ]);
    if(!cSnap.exists()){box.style.display='none';return;}
    const all=cSnap.val(), resp=rSnap.exists()?rSnap.val():{};
    const mine=Object.keys(all).filter(id=>{
      const c=all[id];
      const list=Array.isArray(c.classes)?c.classes:[];
      return list.includes(cls);
    }).sort((a,b)=>(all[b].createdAt||0)-(all[a].createdAt||0));
    if(mine.length===0){box.style.display='none';return;}
    box.style.display='block';
    box.innerHTML=mine.map(id=>{
      const c=all[id];
      const my=resp[id]&&resp[id][cls]&&resp[id][cls][name];
      const over=c.deadline&&c.deadline<localDateString;
      return `<div class="pc-card${my?' answered':''}">
        <div class="pc-title">${escHtml(c.title||'')}</div>
        ${c.text?`<div class="pc-text">${escHtml(c.text)}</div>`:''}
        ${c.deadline?`<div class="pc-deadline">Відповісти до ${escHtml(c.deadline.split('-').reverse().join('.'))}${over&&!my?' · термін минув':''}</div>`:''}
        ${my
          ? `<div class="pc-done">${my.answer==='yes'?'✓ Ви погодились':'✕ Ви відмовились'}
               <span class="pc-when">${new Date(my.ts).toLocaleDateString('uk-UA')}</span>
               <button class="pc-change" onclick="answerConsent('${escJs(id)}','${my.answer==='yes'?'no':'yes'}')">змінити</button>
             </div>`
          : `<div class="pc-btns">
               <button class="pc-yes" onclick="answerConsent('${escJs(id)}','yes')">✓ Погоджуюсь</button>
               <button class="pc-no" onclick="answerConsent('${escJs(id)}','no')">✕ Не погоджуюсь</button>
             </div>`}
      </div>`;
    }).join('');
  }catch(e){box.style.display='none';}
}
window.answerConsent=async function(id,answer){
  const cls=currentUserData?.class, name=currentUserData?.studentName;
  if(!cls||!name)return;
  if(answer==='no'&&!confirm('Підтвердити відмову?'))return;
  try{
    await set(ref(db,`consent_responses/${id}/${cls}/${name}`),
      {answer,by:currentUserData.email||'',ts:Date.now()});
    showToast(answer==='yes'?'✓ Згоду зафіксовано':'✕ Відмову зафіксовано');
    renderConsents();
  }catch(e){alert('Помилка: '+e.message);}
};
// Право батьків отримати всі дані про свою дитину (GDPR)
window.exportMyChildData=function(){
  if(!currentUserData?.class||!currentUserData?.studentName)
    return showToast('⚠️ Дитина не визначена');
  window.exportChildData(currentUserData.class,currentUserData.studentName);
};
// ══════════ AI У КАБІНЕТАХ БАТЬКІВ ТА УЧНЯ ══════════
// У сервіс іде ЛИШЕ предмет, тема уроку, текст ДЗ і номер класу — жодних
// імен, оцінок чи інших персональних даних.
// Кеш «предмет → {тема, ДЗ}» на обрану дату, щоб не читати базу двічі.
let aiDayContext={};
async function loadAiDayContext(prefix){
  const cls=getActiveClass();
  const date=document.getElementById('global-date').value;
  const sel=document.getElementById(`${prefix}-help-subject`);
  if(!sel)return;
  aiDayContext={};
  const [hwSnap,topSnap]=await Promise.all([
    get(child(ref(db),`homeworks/${cls}/${date}`)),
    get(child(ref(db),`lesson_topics/${cls}`))
  ]);
  // Домашні завдання за цей день
  if(hwSnap.exists()){
    const d=hwSnap.val();
    for(const s in d){
      const v=d[s];
      aiDayContext[s]={homework:typeof v==='string'?v:(v.text||''),topic:''};
    }
  }
  // Теми уроків: ключ предмета в lesson_topics «безпечний» (крапки замінені),
  // тому зіставляємо за нормалізованою назвою.
  if(topSnap.exists()){
    const byKey=topSnap.val();
    for(const s in aiDayContext){
      const sk=String(s).replace(/[.#$[\]/]/g,'_').trim();
      const rec=byKey[sk]&&byKey[sk][date];
      if(!rec)continue;
      let t='';
      if(typeof rec==='string')t=rec;
      else if(Array.isArray(rec.topics)&&rec.topics[0])t=rec.topics[0].customText||'';
      else t=rec.customText||'';
      if(t)aiDayContext[s].topic=t;
    }
  }
  const subjects=Object.keys(aiDayContext);
  sel.innerHTML=subjects.length
    ? subjects.map(s=>`<option value="${escHtml(s)}">${escHtml(s)}</option>`).join('')
    : '<option value="">Немає уроків на цей день</option>';
}
function aiOut(prefix,text,isErr){
  const msg=document.getElementById(`ai-${prefix}-msg`);
  if(msg){msg.textContent=text||'';msg.className='ai-hw-msg'+(isErr?' err':'');msg.style.display=text?'block':'none';}
}
async function runDayAI(task,prefix,btnId,outId){
  const sel=document.getElementById(task==='parentHelp'?'p-help-subject':'s-help-subject');
  const subject=sel?sel.value:'';
  const ctx=aiDayContext[subject]||{};
  const classNum=parseInt(String(getActiveClass()||'').replace('class_',''),10);
  const btn=document.getElementById(btnId);
  const out=document.getElementById(outId);
  if(!subject)return aiOut(prefix,'На цей день уроків із завданнями немає.',true);
  if(!ctx.topic&&!ctx.homework)return aiOut(prefix,'Учитель ще не вказав тему уроку чи завдання.',true);
  btn.disabled=true;const label=btn.textContent;btn.textContent='⏳ Хвилинку...';
  aiOut(prefix,'');out.style.display='none';
  try{
    const r=await fetch('/.netlify/functions/ai-assist',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({task,subject,topic:ctx.topic,homework:ctx.homework,classNum})
    });
    const data=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(data.error||`Помилка ${r.status}`);
    out.textContent=data.text||'';out.style.display='block';
    aiOut(prefix,task==='parentHelp'
      ?'💡 Це загальні поради — орієнтуйтесь на свою дитину.'
      :'💡 Спробуй відповісти сам(а), не підглядаючи в зошит.');
  }catch(e){aiOut(prefix,'Не вдалося отримати відповідь: '+e.message,true);}
  finally{btn.disabled=false;btn.textContent=label;}
}
window.parentHelpAI=()=>runDayAI('parentHelp','parent','btn-ai-parent','ai-parent-out');
window.selfCheckAI=()=>runDayAI('selfCheck','student','btn-ai-student','ai-student-out');
window.loadParentDashboard=loadParentDashboard;
window.updateAttOptions=function(){const t=document.getElementById('p-att-type').value;const r=document.getElementById('p-att-reason');r.innerHTML='';if(t==='late')r.innerHTML='<option value="на 10 хвилин">на 10 хвилин</option><option value="на 15 хвилин">на 15 хвилин</option><option value="до 2-го уроку">до 2-го уроку</option><option value="до 3-го уроку">до 3-го уроку</option>';else r.innerHTML='<option value="за сімейними обставинами">За сімейними обставинами</option><option value="через хворобу">Через хворобу</option>';};
window.submitAttendance=function(role='parent'){
  const date=document.getElementById('global-date').value;
  const prefix=role==='student'?'s':'p';
  const type=document.getElementById(`${prefix}-att-type`).value;
  const reason=document.getElementById(`${prefix}-att-reason`).value;
  const markedBy=role==='student'?'student':'parent';
  set(ref(db,`attendance/${getActiveClass()}/${date}/${currentUserData.studentName}/${SELF_REPORT_SLOT}`),{status:type,reason,markedBy}).then(()=>{
    document.getElementById(`${prefix}-att-status`).innerText=`✅ ${type==='late'?'Запізнення':'Відсутність'} (${reason})`;
    document.getElementById(`${prefix}-att-status`).style.display='block';
    checkTeacherAttendanceAlert(role);
  });
};
window.updateAttOptionsStudent=function(){const t=document.getElementById('s-att-type').value;const r=document.getElementById('s-att-reason');r.innerHTML='';if(t==='late')r.innerHTML='<option value="на 10 хвилин">на 10 хвилин</option><option value="на 15 хвилин">на 15 хвилин</option><option value="до 2-го уроку">до 2-го уроку</option><option value="до 3-го уроку">до 3-го уроку</option>';else r.innerHTML='<option value="за сімейними обставинами">За сімейними обставинами</option><option value="через хворобу">Через хворобу</option>';};
window.sendReaction=function(date,subject,emoji){if(!currentUserData)return;set(ref(db,`reactions/${getActiveClass()}/${date}/${subject}/${currentUserData.studentName}`),emoji).then(()=>loadParentDashboard());};
// ══════════ STUDENT DASHBOARD ══════════
export function loadStudentDashboard(){
  if(!currentUserData)return;const date=document.getElementById('global-date').value;const cls=getActiveClass();
  if(window.schedule){renderDynamicSchedule('student');if(parentLessonInterval)clearInterval(parentLessonInterval);parentLessonInterval=setInterval(()=>renderDynamicSchedule('student'),30000);}
  get(child(ref(db),`stickers/${cls}/${currentUserData.studentName}`)).then(snap=>{const cnt=snap.exists()?Object.keys(snap.val()).length:0;const pct=Math.min((cnt/STICKER_GOAL)*100,100);document.getElementById('s-ribbon-progress').style.width=pct+'%';document.getElementById('s-ribbon-count').innerText=`${cnt} / ${STICKER_GOAL} наліпок до призу`;});
  get(child(ref(db),`attendance/${cls}/${date}/${currentUserData.studentName}/${SELF_REPORT_SLOT}`)).then(snap=>{const se=document.getElementById('s-att-status');if(snap.exists()){const d=snap.val();se.innerText=`✅ Повідомлено: ${d.status==='late'?'Запізнення':'Відсутність'} (${d.reason})`;se.style.display='block';}else se.style.display='none';});
  checkTeacherAttendanceAlert('student');
  renderParentCalendar('student');loadParentBellSchedule('student');
  get(child(ref(db),`homeworks/${cls}/${date}`)).then(snap=>{const hl=document.getElementById('s-daily-hw-list');hl.innerHTML='';if(snap.exists()){const d=snap.val();for(let s in d)hl.innerHTML+=renderHwItem(s,d[s]);}else hl.innerHTML='<li class="empty-msg">ДЗ не задано.</li>';});
  loadTextbooksForParent('student');
  loadAiDayContext('s');
  renderBirthdays('s-birthdays',cls,date,currentUserData.studentName);
  renderFinalGrades('s-final-grades',cls,currentUserData.studentName);
  loadTodaySubstitutions(cls,date).then(()=>renderDynamicSchedule('student'));
  const ym=date.substring(0,7);
  Promise.all([get(child(ref(db),`comments/${cls}/${date}`)),get(child(ref(db),`grades/${cls}/${ym}`)),get(child(ref(db),`grade_types/${cls}/${ym}`)),get(child(ref(db),`behavior_grades/${cls}/${ym}`))]).then(([cmS,grS,gtS,bhS])=>{
    const list=document.getElementById('s-daily-comments-list');list.innerHTML=renderGradeFormulaInfo();let hasItems=false;
    const gr=grS.exists()?grS.val():{};const gt=gtS.exists()?gtS.val():{};const sn=currentUserData.studentName;
    const subjs=new Set();
    if(cmS.exists())Object.keys(cmS.val()).forEach(s=>subjs.add(s));
    if(grS.exists())Object.keys(gr).forEach(s=>{if(gr[s][date]&&gr[s][date][sn])subjs.add(s);});
    subjs.forEach(s=>{
      const cm=cmS.exists()&&cmS.val()[s]&&cmS.val()[s][sn]?cmS.val()[s][sn]:'';
      const gv=gr[s]&&gr[s][date]&&gr[s][date][sn]?gr[s][date][sn]:'';
      const gtp=gt[s]&&gt[s][date]&&gt[s][date][sn]?gt[s][date][sn]:'';
      if(cm||gv){
        hasItems=true;const gc=gradeClass6(gv);const dispVal=displayGrade(gv,cls);
        let gHtml=gv?`<span class="g-cell ${gc}" style="display:inline-flex;padding:4px 9px;border-radius:8px;gap:5px;margin-bottom:3px;"><span class="g-val">${dispVal}</span>${gtp?`<span class="g-type">${gtp}</span>`:''}</span>`:'';
        let retakeBtn='';if(gv){const n=parseInt(gv);if(!isNaN(n)&&n<=3)retakeBtn=`<button class="retake-btn" onclick="sendRetakeRequest('${cls}','${escJs(s)}','${date}','${escJs(sn)}',${n})" style="margin-left:6px;">🔄 Покращити</button>`;}
        list.innerHTML+=`<li><b>${escHtml(s)}:</b><br>${gHtml}${retakeBtn}${cm?`<div style="background:#f0f8ff;padding:5px 9px;border-radius:6px;font-style:italic;font-size:.88rem;margin-top:3px;">${escHtml(cm)}</div>`:''}</li>`;
      }
    });
    if(!hasItems)list.innerHTML+='<li class="empty-msg">Немає оцінок або коментарів.</li>';
    const bEl=document.getElementById('s-behavior-list');bEl.innerHTML='';
    if(bhS.exists()){const bd=bhS.val();const wDates=getWeekDates(date);let bh='';wDates.forEach(wd=>{if(bd[wd]&&bd[wd][sn]){const bv=bd[wd][sn];const dispBv=displayGrade(String(bv),cls);const gc=gradeClass6(bv);bh+=`<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px dashed #c5cae9;font-size:.85rem;"><span style="color:#888;flex:1;">${wd.split('-').slice(1).reverse().join('.')}</span><span class="g-cell ${gc}" style="padding:3px 8px;">${dispBv}</span></div>`;}});bEl.innerHTML=bh||'<p class="empty-msg" style="font-size:.82rem;">Оцінок поведінки немає.</p>';}
    else bEl.innerHTML='<p class="empty-msg" style="font-size:.82rem;">Оцінок поведінки немає.</p>';
  });
}
window.loadStudentDashboard=loadStudentDashboard;
