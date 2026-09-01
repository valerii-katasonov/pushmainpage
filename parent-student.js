// ═══════════════════════════════════════════════════════════════
// parent-student.js — parent-screen and student-screen: dynamic
// "today's schedule" widget, payments mockup, attendance submit,
// grade reactions, and retake-request submission (the review side
// lives in teacher.js).
// ═══════════════════════════════════════════════════════════════
import { ref, set, get, child } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, getActiveClass, currentUserData, STICKER_GOAL, getWeekDates, displayGrade, gradeClass6, showToast, renderHwItem, dayKeys, localDateString, formatAttendanceSlotLabel, renderGradeFormulaInfo, escJs, escHtml, safeUrl, renderBirthdays, stuName, auth, normalizeChildren, gradesFromMirror} from './common.js';
import { ACTIVE_YEAR } from './director.js';
import { renderParentMenu } from './kitchen.js';
import { renderNewsFeed } from './news.js';

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
  const snap=await get(child(ref(db),`attendance/${cls}/${date}/${currentUserData.studentId||currentUserData.studentName}`));
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
    // Перерва після уроку. У розкладі на сьогодні вона ще й показує,
    // що саме зараз іде перерва і скільки її лишилося — вранці це
    // потрібніше за сам список уроків.
    const br = breakAfter(lessons, i);
    if(br){
      const nowBreak = !showTomorrow && currentMins >= br.from && currentMins < br.to;
      const left = br.to - currentMins;
      html += `<div class="lesson-break${nowBreak?' now':''}">
        <span class="lb-label">${nowBreak?'Зараз перерва':'перерва'} ${br.mins} хв</span>
        <span class="lb-time">${nowBreak?`ще ${left} хв`:`${hhmm(br.from)} – ${hhmm(br.to)}`}</span>
      </div>`;
    }
  });
  container.innerHTML=html;
}
// ══════════ PAYMENTS MOCKUP ══════════
export function renderPaymentsMockup(){
  const el=document.getElementById('payments-section');
  if(!el)return;
  // ЧОМУ ТУТ НЕМАЄ СУМ. Раніше стояв макет із вигаданими цифрами: борг
  // 4150 грн, оплачені місяці, кнопки «оплатити». Виглядало як справжні
  // дані — батько міг повірити, що заборгував школі, або навпаки що вже
  // все сплатив. Розмити такі числа мало: розмите число все одно читається
  // як число, у нього просто вдивляються. Тому їх немає зовсім.
  el.innerHTML=`
  <div class="pay-soon">
    <div class="pay-soon-icon">💳</div>
    <div>
      <b>Розділ у розробці</b>
      <p>Оплата за навчання, харчування та додаткові послуги зʼявиться тут пізніше.
         Поки що все — як і раніше, через адміністрацію школи.</p>
      <p class="pay-soon-note">Коли розділ запрацює, ми повідомимо окремо.</p>
    </div>
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
// Дата → «РРРР-ММ-ДД» локальним часом. toISOString() тут не годиться:
// він переводить у UTC і на вечірніх годинах зсуває день назад.
const iso=(d)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
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
  // Без перехоплення відмова лишала б вічне «Завантаження...» — людина
  // дивилася б на спінер і не знала, зламалося щось чи просто повільно.
  let examsSnap,holidaysSnap,breaksSnap;
  try{
    [examsSnap,holidaysSnap,breaksSnap]=await Promise.all([
      get(ref(db,`exams/${cls}/${ym}`)),
      get(ref(db,`academic_year/${ACTIVE_YEAR}/holidays`)),
      get(ref(db,`academic_year/${ACTIVE_YEAR}/breaks`))
    ]);
  }catch(e){
    grid.innerHTML=`<p class="empty-msg" style="color:var(--red);">Не вдалося завантажити календар: ${escHtml(e.message||e.code||'відмова')}</p>`;
    return;
  }
  const examsData=examsSnap.exists()?examsSnap.val():{};
  const allHolidays=holidaysSnap.exists()?Object.values(holidaysSnap.val()):[];
  const allBreaks=breaksSnap.exists()?Object.values(breaksSnap.val()):[];
  const myCalendarType=currentUserData?.isArtSchool?'art_school':'general';
  const classMatches=cs=>cs==='all'||(Array.isArray(cs)&&cs.includes(cls));
  const holidaysInMonth={};
  allHolidays.forEach(h=>{if(h.date&&h.date.startsWith(ym)&&(!h.calendarType||h.calendarType===myCalendarType)&&classMatches(h.classes))(holidaysInMonth[h.date]=holidaysInMonth[h.date]||[]).push(h);});
  const breaksInMonth={};
  const monthStart=new Date(y,parseInt(m)-1,1);const monthEnd=new Date(y,parseInt(m),0);
  const breakSpans=[];   // цілі періоди — для списку під календарем
  allBreaks.forEach(b=>{
    if(!b.startDate||!b.endDate||!classMatches(b.classes))return;
    const s=new Date(b.startDate)<monthStart?monthStart:new Date(b.startDate);
    const e=new Date(b.endDate)>monthEnd?monthEnd:new Date(b.endDate);
    if(s>e)return;
    breakSpans.push({ title:b.title||'Канікули', from:b.startDate, to:b.endDate, sort:iso(s) });
    for(let cur=new Date(s);cur<=e;cur.setDate(cur.getDate()+1)){
      const ds=iso(cur);
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

  // ЧОМУ СПИСОК, А НЕ ЛИШЕ ПІДСВІТКА. Розфарбовані клітинки кажуть «тут
  // щось є», але не кажуть що. Дізнатися можна було тільки натиснувши на
  // кожен день по черзі — а дані вже завантажені, ховати їх нема сенсу.
  const events=[];
  Object.keys(holidaysInMonth).forEach(ds=>{
    holidaysInMonth[ds].forEach(x=>events.push({
      kind:'holiday', sort:ds, when:humanDay(ds), title:x.title||'Свято'
    }));
  });
  breakSpans.forEach(b=>events.push({
    kind:'brk', sort:b.sort, when:`${humanDay(b.from)} – ${humanDay(b.to)}`, title:b.title
  }));
  Object.keys(examsData).forEach(ds=>{
    const subjects=Object.keys(examsData[ds]||{});
    if(subjects.length) events.push({
      kind:'exam', sort:ds, when:humanDay(ds), title:'Контрольна: '+subjects.join(', ')
    });
  });
  events.sort((a,b)=>a.sort.localeCompare(b.sort));

  h += events.length
    ? `<ul class="cal-list">${events.map(e=>`
        <li class="ev ${e.kind}">
          <span class="ev-when">${escHtml(e.when)}</span>
          <span class="ev-title">${escHtml(e.title)}</span>
        </li>`).join('')}</ul>`
    : '<p class="cal-none">Цього місяця подій немає.</p>';

  grid.innerHTML=h;
  document.getElementById(`${prefix}-cal-day-details`).style.display='none';
};
// «2026-12-23» → «23 груд.»
function humanDay(ds){
  const [,m,d]=String(ds||'').split('-');
  if(!m||!d)return ds||'';
  return `${parseInt(d)} ${MONTHS_SHORT_UA[parseInt(m)-1]||''}`.trim();
}
const MONTHS_SHORT_UA=['січ.','лют.','бер.','квіт.','трав.','черв.',
                       'лип.','серп.','вер.','жовт.','лист.','груд.'];
window.showParentCalDayDetails=async function(role,ds){
  const prefix=role==='student'?'s':'p';
  const dd=document.getElementById(`${prefix}-cal-day-details`);
  if(!dd)return;
  dd.style.display='block';dd.innerHTML='<p class="empty-msg">⏳ Завантаження...</p>';
  const cls=getActiveClass();const ym=ds.substring(0,7);
  const myCalendarType=currentUserData?.isArtSchool?'art_school':'general';
  const classMatches=cs=>cs==='all'||(Array.isArray(cs)&&cs.includes(cls));
  let examsSnap,holidaysSnap,breaksSnap;
  try{
    [examsSnap,holidaysSnap,breaksSnap]=await Promise.all([
      get(ref(db,`exams/${cls}/${ym}/${ds}`)),
      get(ref(db,`academic_year/${ACTIVE_YEAR}/holidays`)),
      get(ref(db,`academic_year/${ACTIVE_YEAR}/breaks`))
    ]);
  }catch(e){
    dd.innerHTML=`<p class="empty-msg" style="color:var(--red);">Не вдалося завантажити подробиці: ${escHtml(e.message||e.code||'відмова')}</p>`;
    return;
  }
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
// Ключ дитини в дзеркалі — той самий, яким пише вчитель
function mySid(){ return currentUserData?.studentId || currentUserData?.studentName || ''; }

// ══════════ RETAKE REQUEST (parent/student submit side) ══════════
async function sendRetakeRequest(cls,subj,date,student,grade){
  // Рахуємо по дзеркалу своєї дитини, а не по всьому класу.
  // Зміна сенсу: раніше це були всі уроки предмета в класі, тепер — ті,
  // де оцінку має саме ця дитина. Число виходить не більшим, тож ліміт
  // на перездачі стає не м'якшим, а трохи суворішим.
  const yearSnap=await get(ref(db,`student_grades/${cls}/${mySid()}`));
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
  // Список причин будується тут, а не лише в onchange: інакше до першої
  // зміни типу в полі висів би єдиний варіант, зашитий у розмітці.
  fillAttReasons('p');
  // Dynamic schedule
  if(window.schedule){renderDynamicSchedule();if(parentLessonInterval)clearInterval(parentLessonInterval);parentLessonInterval=setInterval(renderDynamicSchedule,30000);}
  // Stickers
  get(child(ref(db),`stickers/${cls}/${currentUserData.studentId||currentUserData.studentName}`)).then(snap=>{const cnt=snap.exists()?Object.keys(snap.val()).length:0;const pct=Math.min((cnt/STICKER_GOAL)*100,100);document.getElementById('p-ribbon-progress').style.width=pct+'%';document.getElementById('p-ribbon-count').innerText=`${cnt} / ${STICKER_GOAL} наліпок до призу`;const me=document.getElementById('p-ribbon-msg');if(me){if(cnt>=STICKER_GOAL){me.innerText="🎉 Ура! Ти досяг мети!";confetti({particleCount:150,spread:80,origin:{y:0.5}});}else me.innerText='';}}).catch(()=>document.getElementById('p-ribbon-count').innerText="Помилка");
  // Att status (self-report confirmation lives under the "all" slot)
  get(child(ref(db),`attendance/${cls}/${date}/${currentUserData.studentId||currentUserData.studentName}/${SELF_REPORT_SLOT}`)).then(snap=>{const se=document.getElementById('p-att-status');if(snap.exists()){const d=snap.val();se.innerText=`✅ Ви повідомили: ${d.status==='late'?'Запізнення':'Відсутність'} (${d.reason})`;se.style.display='block';}else se.style.display='none';});
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
  renderNewsFeed('p-news-feed');
  renderParentMenu(cls,currentUserData.studentId||currentUserData.studentName,date);
  // Grades + comments + behavior
  const ym=date.substring(0,7);
  Promise.all([
    get(child(ref(db),`comments/${cls}/${date}`)),
    get(child(ref(db),`reactions/${cls}/${date}`)),
    // Дзеркало: лише своя дитина, а не весь клас
    get(child(ref(db),`student_grades/${cls}/${mySid()}/${ym}`)),
    get(child(ref(db),`behavior_grades/${cls}/${ym}`))
  ]).then(([cmS,rxS,mirS,bhS])=>{
    const list=document.getElementById('p-daily-comments-list');list.innerHTML=renderGradeFormulaInfo();let hasItems=false;
    const rx=rxS.exists()?rxS.val():{};
    const sn=currentUserData.studentName;
    // Дзеркало розгортаємо у звичну форму gr[предмет][дата][імʼя],
    // щоб малювання нижче лишилося без змін
    const {gr,gt}=gradesFromMirror(mirS.exists()?mirS.val():{}, sn);
    const subjs=new Set();
    if(cmS.exists())Object.keys(cmS.val()).forEach(s=>subjs.add(s));
    Object.keys(gr).forEach(s=>{if(gr[s][date]&&gr[s][date][sn])subjs.add(s);});
    subjs.forEach(s=>{
      const cm=cmS.exists()&&cmS.val()[s]&&cmS.val()[s][sn]?cmS.val()[s][sn]:'';
      const gv=gr[s]&&gr[s][date]&&gr[s][date][sn]?gr[s][date][sn]:'';
      const gtp=gt[s]&&gt[s][date]&&gt[s][date][sn]?gt[s][date][sn]:'';
      if(cm||gv){
        hasItems=true;const cr=rx[s]?.[sn]||null;const gc=gradeClass6(gv);const dispVal=displayGrade(gv,cls);
        let gHtml=gv?`<span class="g-cell ${gc}" style="display:inline-flex;padding:4px 9px;border-radius:8px;gap:5px;margin-bottom:3px;"><span class="g-val">${dispVal}</span>${gtp?`<span class="g-type">${gtp}</span>`:''}</span>`:'';
        // Retake button
        let retakeBtn='';if(gv){const n=parseInt(gv);if(!isNaN(n)&&n<=3)retakeBtn=`<button class="retake-btn" onclick="sendRetakeRequest('${cls}','${escJs(s)}','${date}','${escJs(currentUserData.studentId||sn)}',${n})" style="margin-left:6px;">🔄 Покращити</button>`;}
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
      get(child(ref(db),`academic_year/${ACTIVE_YEAR}/semesters`)),
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
  }catch(e){
    box.innerHTML='<p class="empty-msg">Не вдалося завантажити згоди.</p>';
  }
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
  const cls=currentUserData.class, sid=currentUserData.studentId||currentUserData.studentName;
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
      const my=resp[id]&&resp[id][cls]&&resp[id][cls][sid];
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
  const cls=currentUserData?.class, sid=currentUserData?.studentId||currentUserData?.studentName;
  if(!cls||!sid)return;
  if(answer==='no'&&!confirm('Підтвердити відмову?'))return;
  try{
    await set(ref(db,`consent_responses/${id}/${cls}/${sid}`),
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
  if(!ctx.topic&&!ctx.homework)return aiOut(prefix,'Вчитель ще не вказав тему уроку чи завдання.',true);
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
// ── Причини запізнення та відсутності ──
// Раніше цей перелік був двічі переписаний рядком у коді — окремо для
// батька, окремо для учня. Дві копії одного списку рано чи пізно
// розходяться, тому тепер він один і будується з чисел.
//
// Хвилини: від 5 до 30 з кроком 5. Усі ці числа беруть форму «хвилин»
// (5, 10, 15, 20, 25, 30), тож окремої обробки відмінків не потрібно.
export const LATE_MINUTES = [5, 10, 15, 20, 25, 30];

// Запізнення «до N-го уроку» — це вже не хвилини, а інша ситуація:
// дитина приїде значно пізніше. Лишаємо як окремі варіанти в кінці.
export const LATE_REASONS = [
  ...LATE_MINUTES.map(m => `на ${m} хвилин`),
  'до 2-го уроку',
  'до 3-го уроку'
];
export const ABSENT_REASONS = [
  { v:'за сімейними обставинами', t:'За сімейними обставинами' },
  { v:'через хворобу',            t:'Через хворобу' }
];

function attReasonOptions(type){
  const list = type === 'late'
    ? LATE_REASONS.map(v => ({ v, t:v }))
    : ABSENT_REASONS;
  return list.map(o => `<option value="${escHtml(o.v)}">${escHtml(o.t)}</option>`).join('');
}

// prefix: 'p' — батько, 's' — учень. Одна функція на обидва кабінети.
export function fillAttReasons(prefix){
  const ts = document.getElementById(`${prefix}-att-type`);
  const rs = document.getElementById(`${prefix}-att-reason`);
  if(!ts || !rs) return;
  rs.innerHTML = attReasonOptions(ts.value);
}
window.fillAttReasons = fillAttReasons;

window.updateAttOptions=function(){ fillAttReasons('p'); };
window.submitAttendance=function(role='parent'){
  const date=document.getElementById('global-date').value;
  const prefix=role==='student'?'s':'p';
  const type=document.getElementById(`${prefix}-att-type`).value;
  const reason=document.getElementById(`${prefix}-att-reason`).value;
  const markedBy=role==='student'?'student':'parent';
  set(ref(db,`attendance/${getActiveClass()}/${date}/${currentUserData.studentId||currentUserData.studentName}/${SELF_REPORT_SLOT}`),{status:type,reason,markedBy}).then(()=>{
    document.getElementById(`${prefix}-att-status`).innerText=`✅ ${type==='late'?'Запізнення':'Відсутність'} (${reason})`;
    document.getElementById(`${prefix}-att-status`).style.display='block';
    checkTeacherAttendanceAlert(role);
  });
};
window.updateAttOptionsStudent=function(){ fillAttReasons('s'); };
window.sendReaction=function(date,subject,emoji){if(!currentUserData)return;set(ref(db,`reactions/${getActiveClass()}/${date}/${subject}/${currentUserData.studentId||currentUserData.studentName}`),emoji).then(()=>loadParentDashboard());};
// ══════════ STUDENT DASHBOARD ══════════
export function loadStudentDashboard(){
  renderNewsFeed('s-news-feed');
  if(!currentUserData)return;const date=document.getElementById('global-date').value;const cls=getActiveClass();
  fillAttReasons('s');
  if(window.schedule){renderDynamicSchedule('student');if(parentLessonInterval)clearInterval(parentLessonInterval);parentLessonInterval=setInterval(()=>renderDynamicSchedule('student'),30000);}
  get(child(ref(db),`stickers/${cls}/${currentUserData.studentId||currentUserData.studentName}`)).then(snap=>{const cnt=snap.exists()?Object.keys(snap.val()).length:0;const pct=Math.min((cnt/STICKER_GOAL)*100,100);document.getElementById('s-ribbon-progress').style.width=pct+'%';document.getElementById('s-ribbon-count').innerText=`${cnt} / ${STICKER_GOAL} наліпок до призу`;});
  get(child(ref(db),`attendance/${cls}/${date}/${currentUserData.studentId||currentUserData.studentName}/${SELF_REPORT_SLOT}`)).then(snap=>{const se=document.getElementById('s-att-status');if(snap.exists()){const d=snap.val();se.innerText=`✅ Повідомлено: ${d.status==='late'?'Запізнення':'Відсутність'} (${d.reason})`;se.style.display='block';}else se.style.display='none';});
  checkTeacherAttendanceAlert('student');
  renderParentCalendar('student');loadParentBellSchedule('student');
  get(child(ref(db),`homeworks/${cls}/${date}`)).then(snap=>{const hl=document.getElementById('s-daily-hw-list');hl.innerHTML='';if(snap.exists()){const d=snap.val();for(let s in d)hl.innerHTML+=renderHwItem(s,d[s]);}else hl.innerHTML='<li class="empty-msg">ДЗ не задано.</li>';});
  loadTextbooksForParent('student');
  loadAiDayContext('s');
  renderBirthdays('s-birthdays',cls,date,currentUserData.studentName);
  renderFinalGrades('s-final-grades',cls,currentUserData.studentName);
  loadTodaySubstitutions(cls,date).then(()=>renderDynamicSchedule('student'));
  const ym=date.substring(0,7);
  Promise.all([get(child(ref(db),`comments/${cls}/${date}`)),get(child(ref(db),`student_grades/${cls}/${mySid()}/${ym}`)),get(child(ref(db),`behavior_grades/${cls}/${ym}`))]).then(([cmS,mirS,bhS])=>{
    const list=document.getElementById('s-daily-comments-list');list.innerHTML=renderGradeFormulaInfo();let hasItems=false;
    const sn=currentUserData.studentName;
    const {gr,gt}=gradesFromMirror(mirS.exists()?mirS.val():{}, sn);
    const subjs=new Set();
    if(cmS.exists())Object.keys(cmS.val()).forEach(s=>subjs.add(s));
    Object.keys(gr).forEach(s=>{if(gr[s][date]&&gr[s][date][sn])subjs.add(s);});
    subjs.forEach(s=>{
      const cm=cmS.exists()&&cmS.val()[s]&&cmS.val()[s][sn]?cmS.val()[s][sn]:'';
      const gv=gr[s]&&gr[s][date]&&gr[s][date][sn]?gr[s][date][sn]:'';
      const gtp=gt[s]&&gt[s][date]&&gt[s][date][sn]?gt[s][date][sn]:'';
      if(cm||gv){
        hasItems=true;const gc=gradeClass6(gv);const dispVal=displayGrade(gv,cls);
        let gHtml=gv?`<span class="g-cell ${gc}" style="display:inline-flex;padding:4px 9px;border-radius:8px;gap:5px;margin-bottom:3px;"><span class="g-val">${dispVal}</span>${gtp?`<span class="g-type">${gtp}</span>`:''}</span>`:'';
        let retakeBtn='';if(gv){const n=parseInt(gv);if(!isNaN(n)&&n<=3)retakeBtn=`<button class="retake-btn" onclick="sendRetakeRequest('${cls}','${escJs(s)}','${date}','${escJs(currentUserData.studentId||sn)}',${n})" style="margin-left:6px;">🔄 Покращити</button>`;}
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

// ═══════════ ДОСТУП ДИТИНИ ДО ПОРТАЛУ ═══════════
// Батько створює дитині вхід, змінює пароль і вимикає доступ.
//
// ЧОМУ ЧЕРЕЗ СЕРВЕРНУ ФУНКЦІЮ: створення чужого акаунта і зміна чужого
// пароля — операції адміністратора Firebase. З браузера їх зробити не
// можна, і добре: інакше ключ адміністратора лежав би у коді сторінки.
// Тут ми лише збираємо форму й показуємо відповідь.
//
// ЧОМУ НІКНЕЙМ, А НЕ ПОШТА: у молодших класах пошти в дитини немає.
// Нікнейм усередині системи стає адресою nick@pupil.push.local — для
// Firebase це звичайна пошта, для дитини просто логін.
const CA_FN = '/.netlify/functions/child-access';
// Мітка збірки. Якщо в кабінеті під розділом стоїть інша дата — на сайті
// лежить стара версія файлу, і шукати помилку в коді немає сенсу.
const CA_BUILD = '2026-08-26 · v8';

// Список дітей приходить із сервера — з того самого parent_links, за яким
// перевіряється право міняти дитині пароль. Локальний профіль сюди більше
// не втручається: у старих акаунтів він буває неповним, і розділ казав
// «дитину не привʼязано» на дитині, яка видно в меню поруч.
let caKids = null;
let caKidsLoading = false;   // щоб два виклики поспіль не били сервер двічі

// ── Слід виконання ──
// Один рядок «Завантаження...» не розрізняє «повільно» і «зупинилося
// назавжди», а показ лише останнього кроку ховає те, що було до нього.
// Тому ведемо список кроків: зі знімка екрана одразу видно весь шлях.
const caTrail = [];
const caT0 = Date.now();
function caStep(text){
  caTrail.push(`${((Date.now() - caT0) / 1000).toFixed(1)}s  ${text}`);
  if(caTrail.length > 12) caTrail.shift();
  const el = document.getElementById('ca-trail');
  if(el){
    el.style.display = 'block';
    el.textContent = caTrail.join('\n');
  }
}
window.caStep = caStep;

async function caCall(action, payload){
  caStep(`→ ${action}`);
  try{
    const d = await caCallInner(action, payload);
    caStep(`✓ ${action}`);
    return d;
  }catch(e){
    caStep(`✗ ${action}: ${e.message}`);
    throw e;
  }
}

async function caCallInner(action, payload){
  const user = auth.currentUser;
  if(!user) throw new Error('Ви не увійшли в портал.');
  // getIdToken може піти оновлювати токен у Google — теж під наглядом,
  // інакше зависання тут виглядало б так само, як зависання запиту.
  const idToken = await Promise.race([
    user.getIdToken(),
    new Promise((_, rej) => setTimeout(
      () => rej(new Error('Не вдалося оновити вхідний токен. Вийдіть і зайдіть у портал заново.')), 10000))
  ]);
  // Тайм-аут обовʼязковий: якщо серверна функція впаде або застрягне,
  // fetch чекатиме мовчки, а людина дивитиметься на «Завантаження...»
  // і не знатиме, зламалося чи просто повільно.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  let r;
  try{
    r = await fetch(CA_FN, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(Object.assign({ action, idToken }, payload)),
      signal: ctl.signal
    });
  }catch(e){
    if(e.name === 'AbortError')
      throw new Error('Сервер не відповів за 20 секунд. Перевірте журнал функції child-access у Netlify.');
    throw new Error('Немає звʼязку із сервером: ' + e.message);
  }finally{
    clearTimeout(timer);
  }
  // Читаємо текстом, а не одразу JSON: коли щось не так, Netlify віддає
  // HTML-сторінку помилки, і .json() падає. Раніше через це назовні йшло
  // безпорадне «сервер відповів не тим, що очікувалося» — без коду
  // відповіді, за яким видно причину.
  const raw = await r.text();
  let d = null;
  try{ d = JSON.parse(raw); }catch(e){ /* не JSON — розберемо нижче */ }

  if(!d){
    if(r.status === 404) throw new Error(
      'Серверна функція child-access не знайдена (404). Її ще не викладено на Netlify.');
    const snippet = raw.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim().slice(0,160);
    throw new Error(`Сервер відповів кодом ${r.status}` + (snippet ? `: ${snippet}` : '.'));
  }
  if(!r.ok || d.error) throw new Error(d.error || `Помилка ${r.status}`);
  return d;
}

export async function initChildAccess(){
  const sel = document.getElementById('ca-child');
  const box = document.getElementById('ca-body');
  if(!sel || !box) return;
  const ver = document.getElementById('ca-ver');
  if(ver) ver.textContent = CA_BUILD;
  try{
    await caLoadChildren(sel, box);
  }catch(e){
    // Остання лінія оборони: що б не сталося, людина бачить причину,
    // а не нескінченне «Завантаження...».
    box.innerHTML = `<p class="empty-msg" style="color:var(--red);">Збій розділу: ${escHtml(e && e.message || String(e))}</p>`;
    caKidsLoading = false;
  }
}

async function caLoadChildren(sel, box){
  if(caKidsLoading) return;
  caKidsLoading = true;
  box.innerHTML = '<p class="empty-msg">Завантаження...</p>';
  try{
    const d = await caCall('children', {});
    caKids = (d.children || []).filter(k => k && k.studentName);
  }catch(e){
    caKids = null;
    sel.innerHTML = '<option value="">—</option>';
    box.innerHTML = `<p class="empty-msg" style="color:var(--red);">Не вдалося отримати список дітей: ${escHtml(e.message)}</p>`;
    return;
  }finally{
    caKidsLoading = false;
  }
  if(!caKids.length){
    sel.innerHTML = '<option value="">Дітей не привʼязано</option>';
    box.innerHTML = '<p class="empty-msg">До вашого акаунта не привʼязано жодної дитини. Зверніться до класного керівника.</p>';
    return;
  }
  caStep(`список: ${caKids.length} дит.`);
  sel.innerHTML = caKids.map((k,i)=>
    `<option value="${i}">${escHtml(k.studentName)}${
      k.class ? ' · ' + escHtml(String(k.class).replace('class_','')) + ' клас' : ''}</option>`
  ).join('');
  caStep('малюю картку');
  caRenderLocal();
}
window.caInit = initChildAccess;

// Кабінет батьків відкриває common.js, а цей файл браузер міг ще не встигнути
// виконати — тоді виклик просто нікуди не потрапляв, і в розділі назавжди
// лишалося «Завантаження...». Тому підстраховуємося двома шляхами.
function caAutoInit(){
  const scr = document.getElementById('parent-screen');
  if(scr && scr.style.display !== 'none' && document.getElementById('ca-child')) initChildAccess();
}
if(document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', () => setTimeout(caAutoInit, 600));
else setTimeout(caAutoInit, 600);
// Розділ згорнутий: відкриття — надійний момент, щоб оновити стан
document.addEventListener('toggle', (e) => {
  if(e.target && e.target.tagName === 'DETAILS' && e.target.open
     && e.target.querySelector('#ca-child')) initChildAccess();
}, true);

async function caRenderLocal(){
  const box = document.getElementById('ca-body');
  if(!box) return;
  const sel = document.getElementById('ca-child');
  if(!caKids || !caKids.length) return initChildAccess();
  // Дитину беремо за позицією у випадайці — список будувався з цього ж
  // масиву, тож розійтися вони не можуть.
  const kid = caKids[Math.max(0, sel ? sel.selectedIndex : 0)] || caKids[0];
  caStep(`обрано: ${kid.studentName}`);
  box.innerHTML = '<p class="empty-msg">Перевіряю доступ...</p>';

  // Що саме надсилати серверу, щоб він упізнав дитину
  // Імʼя і клас — запасні ключі: у старих записах постійного
  // ідентифікатора може не бути зовсім.
  window._caTarget = {
    studentId: kid.studentId || '',
    class: kid.class || '',
    studentName: kid.studentName || ''
  };

  let acc = null, known = '';
  try{
    // Питаємо сервер, а не базу: він бачить і акаунти, заведені школою
    // раніше, і сам підбирає їх до дитини.
    const d = await caCall('status', window._caTarget);
    acc = d.access;
    known = d.known || '';
  }catch(e){
    box.innerHTML = `<p class="empty-msg" style="color:var(--red);">Не вдалося перевірити: ${escHtml(e.message)}</p>`;
    return;
  }

  caStep(acc && acc.login ? 'доступ є' : ('доступу немає' + (known ? ', відома пошта: ' + known : '')));
  if(!acc || !acc.login){
    box.innerHTML = `
      <label for="ca-nick" style="margin-top:0;">Нікнейм</label>
      <input type="text" id="ca-nick" placeholder="напр. olya2015" autocapitalize="none" spellcheck="false">
      <p style="font-size:.75rem;color:#90a4ae;margin:3px 0 0 0;">Латинські літери, цифри, крапка або дефіс. Це і буде логін.</p>
      <label for="ca-mail">Пошта дитини <span style="font-weight:400;color:#90a4ae;">— за бажанням</span></label>
      <input type="email" id="ca-mail" value="${escHtml(known)}"
             placeholder="можна залишити порожнім" autocapitalize="none" spellcheck="false">
      ${known ? `<p style="font-size:.75rem;color:#00838f;margin:3px 0 0 0;">Цю адресу школа вже записала дитині. Входу за нею ще немає — залиште її, щоб не заводити другу.</p>` : ''}
      <label for="ca-pass">Пароль</label>
      <input type="text" id="ca-pass" placeholder="мінімум 6 символів" autocapitalize="none">
      <p style="font-size:.75rem;color:#90a4ae;margin:3px 0 0 0;">Пароль видно навмисне — ви маєте продиктувати його дитині.</p>
      <button onclick="caCreate()" id="ca-create"
              style="background:var(--teal);color:#fff;padding:11px;margin-top:13px;width:100%;">Створити доступ</button>
      <div id="ca-msg" style="display:none;font-size:.82rem;margin-top:9px;"></div>`;
    return;
  }

  const off = !!acc.disabled;
  box.innerHTML = `
    <div class="data-card" style="border-left-color:${off ? '#b0bec5' : 'var(--green)'};margin-top:0;">
      <div style="font-size:.8rem;color:#78909c;">Логін дитини</div>
      <div style="font-weight:700;font-size:.98rem;word-break:break-all;">${escHtml(acc.nick || acc.login)}</div>
      ${acc.email ? `<div style="font-size:.78rem;color:#78909c;margin-top:3px;">Вхід за поштою — пароль можна відновити листом</div>` : ''}
      <div style="font-size:.78rem;color:${off ? 'var(--red)' : 'var(--green)'};font-weight:700;margin-top:5px;">
        ${off ? 'Доступ вимкнено' : 'Доступ активний'}</div>
    </div>
    <label for="ca-newpass" style="margin-top:13px;">Новий пароль</label>
    <input type="text" id="ca-newpass" placeholder="мінімум 6 символів" autocapitalize="none">
    <button onclick="caPassword()" id="ca-pwd"
            style="background:#00838f;color:#fff;padding:11px;margin-top:9px;width:100%;">Змінити пароль</button>
    <button onclick="caDisable(${off ? 'false' : 'true'})" id="ca-toggle"
            style="background:${off ? 'var(--green)' : '#eceff1'};color:${off ? '#fff' : '#546e7a'};padding:10px;margin-top:7px;width:100%;">
      ${off ? 'Увімкнути доступ' : 'Вимкнути доступ'}</button>
    <div id="ca-msg" style="display:none;font-size:.82rem;margin-top:9px;"></div>`;
};

function caMsg(text, bad){
  const m = document.getElementById('ca-msg');
  if(!m) return;
  m.style.display = 'block';
  m.style.color = bad ? 'var(--red)' : 'var(--green)';
  m.innerText = text;
}
function caBusy(id, on, label){
  const b = document.getElementById(id);
  if(!b) return;
  b.disabled = on;
  if(label) b.textContent = label;
}

window.caCreate = async function(){
  const nick = document.getElementById('ca-nick').value.trim();
  const email = document.getElementById('ca-mail').value.trim();
  const password = document.getElementById('ca-pass').value;
  if(!nick && !email) return caMsg('Вкажіть нікнейм або пошту дитини.', true);
  if(password.length < 6) return caMsg('Пароль — щонайменше 6 символів.', true);
  caBusy('ca-create', true, 'Створюю...');
  try{
    const d = await caCall('create', Object.assign({}, window._caTarget, { nick, email, password }));
    showToast('Доступ створено');
    caMsg(`Готово. Логін: ${d.nick || d.login}`);
    caRenderLocal();
  }catch(e){
    caMsg(e.message, true);
  }finally{
    caBusy('ca-create', false, 'Створити доступ');
  }
};

window.caPassword = async function(){
  const password = document.getElementById('ca-newpass').value;
  if(password.length < 6) return caMsg('Пароль — щонайменше 6 символів.', true);
  caBusy('ca-pwd', true, 'Змінюю...');
  try{
    await caCall('password', Object.assign({}, window._caTarget, { password }));
    showToast('Пароль змінено');
    caMsg('Пароль змінено. Продиктуйте його дитині.');
    document.getElementById('ca-newpass').value = '';
  }catch(e){
    caMsg(e.message, true);
  }finally{
    caBusy('ca-pwd', false, 'Змінити пароль');
  }
};

window.caDisable = async function(off){
  if(off && !confirm('Вимкнути доступ? Дитина не зможе увійти, поки ви не увімкнете його знову.')) return;
  caBusy('ca-toggle', true, '...');
  try{
    await caCall(off ? 'disable' : 'enable', Object.assign({}, window._caTarget));
    showToast(off ? 'Доступ вимкнено' : 'Доступ увімкнено');
    caRenderLocal();
  }catch(e){
    caMsg(e.message, true);
    caBusy('ca-toggle', false, off ? 'Вимкнути доступ' : 'Увімкнути доступ');
  }
};
window.caRender = caRenderLocal;

// ── Перерви ──
// У базі лежать лише уроки з їхнім часом. Перерва — це проміжок між
// кінцем одного уроку і початком наступного, тож рахуємо її самі, а не
// просимо школу заповнювати ще одну таблицю.
function minsOf(hhmm){
  const [h,m] = String(hhmm||'').split(':');
  const n = parseInt(h)*60 + parseInt(m);
  return isNaN(n) ? null : n;
}
function lessonBounds(l){
  const [a,b] = String(l && l.time || '').split(' - ');
  return { start: minsOf(a), end: minsOf(b) };
}
// Проміжок між уроками i та i+1 у хвилинах; null, якщо часу немає або
// уроки йдуть впритул
function breakAfter(lessons, i){
  const cur = lessonBounds(lessons[i]);
  const nxt = lessons[i+1] ? lessonBounds(lessons[i+1]) : null;
  if(cur.end == null || !nxt || nxt.start == null) return null;
  const gap = nxt.start - cur.end;
  return gap > 0 ? { mins: gap, from: cur.end, to: nxt.start } : null;
}
const hhmm = (m) => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;

// ══════════ ПОВНИЙ РОЗКЛАД НА ТИЖДЕНЬ ══════════
// РАНІШЕ: кнопка «Відкрити повний розклад» вела на окрему сторінку сайту.
// Людина виходила з кабінету, дивилася розклад і поверталася назад руками —
// а на телефоні ще й втрачала місце, де була. Тепер тиждень розгортається
// тут же, з тих самих даних, які вже завантажені для сьогоднішнього дня:
// window.schedule приходить одним запитом на вході і містить усі дні.
const WEEK_DAYS = [
  { key:'Monday',    label:'Понеділок' },
  { key:'Tuesday',   label:'Вівторок'  },
  { key:'Wednesday', label:'Середа'    },
  { key:'Thursday',  label:'Четвер'    },
  { key:'Friday',    label:'Пʼятниця'  }
];

function renderWeekSchedule(prefix){
  const box = document.getElementById(`${prefix}-week-schedule`);
  if(!box) return;
  if(!window.schedule || !Object.keys(window.schedule).length){
    box.innerHTML = '<p class="empty-msg">Розклад ще не заповнено школою.</p>';
    return;
  }
  const todayKey = dayKeys[new Date().getDay()];
  let html = '';
  let anyLesson = false;
  WEEK_DAYS.forEach(d => {
    // isToday=false: у тижневому огляді не потрібні заміни й підсвітка уроку,
    // це довідка «що коли», а не годинник
    const lessons = buildDynamicSchedule(window.schedule, d.key, false) || [];
    if(lessons.length) anyLesson = true;
    html += `<div class="wk-day${d.key===todayKey?' today':''}">
      <div class="wk-day-name">${escHtml(d.label)}${d.key===todayKey?' <span class="wk-today">сьогодні</span>':''}</div>
      ${lessons.length
        ? lessons.map((l,i)=>{
            const sn = typeof l.subject==='string' ? l.subject : (l.subject?.ua || '');
            const br = breakAfter(lessons, i);
            return `<div class="wk-row">
              <span class="wk-num">${i+1}</span>
              <span class="wk-subj">${escHtml(sn)}</span>
              <span class="wk-time">${escHtml(l.time||'—')}</span>
            </div>`
            + (br ? `<div class="wk-break">
                 <span class="wk-break-label">перерва ${br.mins} хв</span>
                 <span class="wk-break-time">${hhmm(br.from)} – ${hhmm(br.to)}</span>
               </div>` : '');
          }).join('')
        : '<div class="wk-empty">Уроків немає</div>'}
    </div>`;
  });
  box.innerHTML = anyLesson ? html : '<p class="empty-msg">Розклад ще не заповнено школою.</p>';
}

window.toggleWeekSchedule = function(prefix){
  const box = document.getElementById(`${prefix}-week-schedule`);
  const btn = document.getElementById(`${prefix}-week-btn`);
  if(!box) return;
  const opening = box.style.display === 'none' || !box.style.display;
  if(opening) renderWeekSchedule(prefix);   // перемальовуємо щоразу: розклад міг оновитися
  box.style.display = opening ? 'block' : 'none';
  if(btn) btn.textContent = opening ? '▲ Згорнути тиждень' : '📅 Показати весь тиждень';
};

// ══════════════════════════════════════════════════════════════════
//  КАЛЕНДАР НА ВЕСЬ НАВЧАЛЬНИЙ РІК
// ══════════════════════════════════════════════════════════════════
// Помісячний перегляд відповідає на питання «що цього місяця», але не на
// «коли канікули» й «скільки ще до свят». Для цього доводилося клацати
// місяць за місяцем. Тут — усі 12 місяців року одразу, з підсвіченими
// датами, і під ними суцільний список подій із датами.
//
// Дані читаються ОДИН раз на весь рік, а не по місяцю: свята й канікули
// лежать в одному вузлі, а контрольні — по місяцях, тож їх беремо
// діапазоном ключів.
// Рік починається із серпня — так само, як його визначає getAcademicYearId.
// Якби тут був вересень, а там серпень, серпневі свята потрапляли б
// у клітинку наступного календарного року.
const YEAR_MONTHS = ['08','09','10','11','12','01','02','03','04','05','06','07'];

// Місяць «08» року «2026-2027» → 2026; «01» → 2027
export function monthYear(ym, academicYear){
  const [a, b] = String(academicYear || '').split('-').map(Number);
  const m = parseInt(ym, 10);
  if(!a || !b || !m) return null;
  return m >= 8 ? a : b;
}

window.toggleYearCalendar = async function(role = 'parent'){
  const prefix = role === 'student' ? 's' : 'p';
  const box = document.getElementById(`${prefix}-cal-year`);
  const btn = document.getElementById(`${prefix}-cal-year-btn`);
  if(!box) return;
  const opening = box.style.display === 'none' || !box.style.display;
  box.style.display = opening ? 'block' : 'none';
  if(btn) btn.textContent = opening ? '📅 Згорнути рік' : '📅 Показати весь навчальний рік';
  if(!opening) return;
  await renderYearCalendar(role);
};

async function renderYearCalendar(role){
  const prefix = role === 'student' ? 's' : 'p';
  const box = document.getElementById(`${prefix}-cal-year`);
  const cls = getActiveClass();
  box.innerHTML = '<p class="empty-msg">⏳ Завантаження...</p>';

  let holidaysSnap, breaksSnap, examsSnap;
  try{
    [holidaysSnap, breaksSnap, examsSnap] = await Promise.all([
      get(ref(db, `academic_year/${ACTIVE_YEAR}/holidays`)),
      get(ref(db, `academic_year/${ACTIVE_YEAR}/breaks`)),
      get(ref(db, `exams/${cls}`))
    ]);
  }catch(e){
    box.innerHTML = `<p class="empty-msg" style="color:var(--red);">Не вдалося завантажити рік: ${escHtml(e.message||'відмова')}</p>`;
    return;
  }

  const holidays = holidaysSnap.exists() ? Object.values(holidaysSnap.val()) : [];
  const breaks   = breaksSnap.exists()   ? Object.values(breaksSnap.val())   : [];
  const exams    = examsSnap.exists()    ? examsSnap.val()                   : {};
  const myType = currentUserData?.isArtSchool ? 'art_school' : 'general';
  const mine = cs => cs === 'all' || (Array.isArray(cs) && cs.includes(cls));

  // Розкладаємо все по днях один раз
  const byDay = {};
  const mark = (ds, kind) => { (byDay[ds] = byDay[ds] || new Set()).add(kind); };
  const events = [];

  holidays.forEach(x => {
    if(!x.date || (x.calendarType && x.calendarType !== myType) || !mine(x.classes)) return;
    mark(x.date, 'holiday');
    events.push({ kind:'holiday', sort:x.date, when:humanDay(x.date), title:x.title || 'Свято' });
  });
  breaks.forEach(b => {
    if(!b.startDate || !b.endDate || !mine(b.classes)) return;
    for(let cur = new Date(b.startDate); cur <= new Date(b.endDate); cur.setDate(cur.getDate()+1)) mark(iso(cur), 'brk');
    events.push({ kind:'brk', sort:b.startDate,
                  when:`${humanDay(b.startDate)} – ${humanDay(b.endDate)}`, title:b.title || 'Канікули' });
  });
  Object.keys(exams).forEach(ym => {
    Object.keys(exams[ym] || {}).forEach(ds => {
      const subjects = Object.keys(exams[ym][ds] || {});
      if(!subjects.length) return;
      mark(ds, 'exam');
      events.push({ kind:'exam', sort:ds, when:humanDay(ds), title:'Контрольна: ' + subjects.join(', ') });
    });
  });
  events.sort((a, b) => a.sort.localeCompare(b.sort));

  const MN = { '09':'Вересень','10':'Жовтень','11':'Листопад','12':'Грудень','01':'Січень','02':'Лютий',
               '03':'Березень','04':'Квітень','05':'Травень','06':'Червень','07':'Липень','08':'Серпень' };
  let h = '<div class="yc-wrap">';
  YEAR_MONTHS.forEach(mm => {
    const yy = monthYear(mm, ACTIVE_YEAR);
    const dim = new Date(yy, parseInt(mm), 0).getDate();
    let fd = new Date(yy, parseInt(mm)-1, 1).getDay(); if(fd === 0) fd = 7;
    h += `<div class="yc-month"><div class="yc-name">${MN[mm]} <span>${yy}</span></div><div class="yc-grid">`;
    ['Пн','Вт','Ср','Чт','Пт','Сб','Нд'].forEach(d => h += `<i class="yc-h">${d}</i>`);
    for(let i = 1; i < fd; i++) h += '<i></i>';
    for(let d = 1; d <= dim; d++){
      const ds = `${yy}-${mm}-${String(d).padStart(2,'0')}`;
      const kinds = byDay[ds];
      let c = '';
      if(kinds) c = kinds.size > 1 ? 'yc-multi' : ('yc-' + [...kinds][0]);
      h += `<i class="${c}" title="${kinds ? escHtml([...kinds].join(', ')) : ''}">${d}</i>`;
    }
    h += '</div></div>';
  });
  h += '</div>';

  h += '<div class="yc-legend"><span class="yc-holiday"></span>свято'
     + '<span class="yc-brk"></span>канікули<span class="yc-exam"></span>контрольна</div>';

  h += events.length
    ? `<ul class="cal-list">${events.map(e => `
        <li class="ev ${e.kind}">
          <span class="ev-when">${escHtml(e.when)}</span>
          <span class="ev-title">${escHtml(e.title)}</span>
        </li>`).join('')}</ul>`
    : `<p class="cal-none">У ${escHtml(ACTIVE_YEAR)} навчальному році подій ще не внесено.</p>`;

  box.innerHTML = h;
}
