// Навантаження з чинного розкладу; історичні версії розкладу не зберігаються.
import { ref, get, query, orderByKey, startAt, endAt } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, currentUserData, isDirectorRole, getUserRoles, isTeacherRole, emailKey, subjKey, escHtml, mondayOf, localDateString, dayKeys, parseTimeRange, expandAltSubjects, altPairKey, getClassNum } from './common.js';
import { catalogList } from './subjects.js';
import { ACTIVE_YEAR } from './director.js';
export function workloadDates(monday){
  const [y,m,d]=monday.split('-').map(Number),out=[];
  for(let i=0;i<7;i++){const date=new Date(y,m-1,d+i);out.push(`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`);}
  return out;
}
export function buildWorkload(data,monday,today,year=ACTIVE_YEAR){
  const {schedules={},catalogs={},users={},access={},choices={},subs={},topics={},calendar={}}=data;
  const teachers=new Map(),issues=[];
  for(const u of Object.values(users))if(u?.email&&!u.disabled&&getUserRoles(u).some(isTeacherRole)){
    teachers.set(emailKey(u.email),{name:[u.firstName,u.lastName].filter(Boolean).join(' ')||u.email,email:u.email,lessons:[],possible:[],conflicts:[],missing:[]});
  }
  const dates=workloadDates(monday);
  const applies=(event,cls)=>!event.classes||event.classes==='all'||
    (Array.isArray(event.classes)?event.classes:Object.values(event.classes)).includes(cls);
  const closed=(date,cls)=>Object.values(calendar.holidays||{}).some(h=>h?.date===date&&h.calendarType!=='art_school'&&applies(h,cls))||
    Object.values(calendar.breaks||{}).some(b=>b?.startDate&&b.endDate&&date>=b.startDate&&date<=b.endDate&&applies(b,cls));
  function teacherFor(cls,subject,item){
    if(item.teacherEmail)return emailKey(item.teacherEmail);
    const catalog=catalogList(catalogs[year]?.[cls]??catalogs[cls]??{});
    const assigned=new Set(catalog.filter(e=>subjKey(e.name)===subjKey(subject)&&e.teacherEmail).map(e=>emailKey(e.teacherEmail)));
    // Дублікати предмета з різними викладачами — неоднозначне
    // призначення, а не причина приписати урок першому запису.
    if(assigned.size>1)return '';
    if(assigned.size===1)return [...assigned][0];
    const candidates=Object.entries(access).filter(([key,matrix])=>{
      if(!teachers.has(key))return false;
      const raw=matrix?.[cls]||[];
      return (Array.isArray(raw)?raw:Object.values(raw)).some(s=>typeof s==='string'&&subjKey(s)===subjKey(subject));
    }).map(([key])=>key);
    return candidates.length===1?candidates[0]:'';
  }
  for(const [cls,school] of Object.entries(schedules)){
    if(!/^class_\d+$/.test(cls))continue;
    dates.forEach((date,index)=>{
      if(closed(date,cls))return;
      const dn=dayKeys[(index+1)%7],raw=school.lessons?.[dn]||[];
      const slots=(Array.isArray(raw)?raw.map((slot,i)=>[i,slot]):Object.entries(raw)).sort((a,b)=>Number(a[0])-Number(b[0]));
      slots.forEach(([slotIndex,slot])=>{
        const items=Array.isArray(slot)?slot:[slot];
        items.forEach((item,itemIndex)=>{
          if(!item||typeof item!=='object'||item.type==='break')return;
          const names=expandAltSubjects(item);if(!names.length)return;
          const week=choices[cls]?.[monday]||{};
          const choice=week.pairs?.[altPairKey(names)]||week[dn]?.[slotIndex]||'';
          const resolved=names.length===1||names.includes(choice);
          const subjects=resolved?[names.length===1?names[0]:choice]:names;
          const candidates=new Set();let hasUnassigned=false;
          for(const subject of subjects){
            const daily=subs[date]?.[cls]||{};
            const cover=daily[slotIndex]?.subject===subject?daily[slotIndex]:daily.any?.subject===subject?daily.any:null;
            const key=cover?.subEmail?emailKey(cover.subEmail):teacherFor(cls,subject,item);
            const parsed=parseTimeRange(item.time||'');
            // Загальний парсер терпимий до введення; для підрахунку годин
            // додатково відкидаємо неіснуючі хвилини та години.
            const parts=parsed.text.match(/\d+/g)?.map(Number);
            const valid=parsed.start!==null&&parsed.end!==null&&parsed.end>parsed.start&&
              parts?.length===4&&parts[0]<24&&parts[2]<24&&parts[1]<60&&parts[3]<60;
            const lesson={id:`${cls}/${dn}/${slotIndex}/${itemIndex}`,cls,subject,date,dn,time:item.time||'',start:valid?parsed.start:null,end:valid?parsed.end:null,minutes:valid?parsed.end-parsed.start:0,substitute:!!cover};
            if(!key||!teachers.has(key)){hasUnassigned=true;issues.push({...lesson,reason:key?'Учитель відсутній або вимкнений у списку персоналу':'Учителя не визначено однозначно',possible:!resolved});continue;}
            const teacher=teachers.get(key);
            if(resolved)teacher.lessons.push(lesson);
            else if(!candidates.has(key)){teacher.possible.push({...lesson,subject:names.join(' / '),pending:true});candidates.add(key);}
          }
          // Якщо обидва варіанти веде одна людина, заняття точно її;
          // невизначеною лишається лише тема, не навантаження.
          if(!resolved&&!hasUnassigned&&candidates.size===1){
            const teacher=teachers.get([...candidates][0]);teacher.lessons.push(teacher.possible.pop());
          }
        });
      });
    });
  }
  for(const teacher of teachers.values()){
    const checked=new Set();
    for(const l of teacher.lessons){
      const key=`${l.cls}|${l.subject}|${l.date}`;
      if(!l.pending&&l.date<today&&!checked.has(key)){
        checked.add(key);
        const record=topics[l.cls]?.[subjKey(l.subject)]?.[l.date];
        const entries=typeof record==='string'?[{customText:record}]:Array.isArray(record?.topics)?record.topics:record?[record]:[];
        if(!entries.some(t=>t?.topicId||String(t?.customText||'').trim()))teacher.missing.push(l);
      }
    }
    for(let i=0;i<teacher.lessons.length;i++)for(let j=i+1;j<teacher.lessons.length;j++){
      const a=teacher.lessons[i],b=teacher.lessons[j];
      if(a.date===b.date&&a.start!==null&&b.start!==null&&a.start<b.end&&b.start<a.end)teacher.conflicts.push([a,b]);
    }
  }
  return {teachers:[...teachers.values()].sort((a,b)=>b.lessons.length-a.lessons.length||a.name.localeCompare(b.name,'uk')),issues,dates};
}
let result=null,state='idle',generation=0;
const names={Monday:'Пн',Tuesday:'Вт',Wednesday:'Ср',Thursday:'Чт',Friday:'Пт',Saturday:'Сб',Sunday:'Нд'};
const clock=minutes=>`${String(Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`;
const duration=minutes=>`${Math.floor(minutes/60)} год ${minutes%60} хв`;
const label=l=>`${l.date.split('-').reverse().join('.')} · ${getClassNum(l.cls)} клас · ${l.subject} · ${l.time||'час не вказано'}`;
const subjectCount=lessons=>new Set(lessons.flatMap(l=>l.pending?expandAltSubjects({subject:l.subject}):[l.subject])).size;
export function renderWorkload(){
  const box=document.getElementById('d-workload-results');if(!box||state!=='ready'||!result)return;
  const search=(document.getElementById('d-workload-search')?.value||'').trim().toLocaleLowerCase('uk');
  const rows=result.teachers.filter(t=>[t.name,t.email].join(' ').toLocaleLowerCase('uk').includes(search));
  const summary=document.getElementById('d-workload-summary');
  if(summary)summary.textContent=`Учителів: ${result.teachers.length} · Визначених занять: ${result.teachers.reduce((n,t)=>n+t.lessons.length,0)} · Занять із невибраним чергуванням: ${new Set(result.teachers.flatMap(t=>[...t.possible,...t.lessons.filter(l=>l.pending)]).concat(result.issues.filter(l=>l.possible)).map(l=>l.id)).size} · Занять без визначеного вчителя: ${new Set(result.issues.map(l=>l.id)).size}`;
  const comparison=rows.length?`<div style="overflow-x:auto;"><table style="width:100%;min-width:620px;font-size:.82rem;border-collapse:collapse;"><thead><tr><th>Учитель</th><th>Заняття</th><th>Тривалість</th><th>Класи</th><th>Предмети</th><th>Накладки / дати без тем</th></tr></thead><tbody>${rows.map(t=>`<tr><td>${escHtml(t.name)}</td><td>${t.lessons.length}${t.possible.length?`–${t.lessons.length+t.possible.length}`:''}</td><td>${escHtml(duration(t.lessons.reduce((n,l)=>n+l.minutes,0)))}${t.lessons.some(l=>l.start===null)?' + без часу':''}${t.possible.length?' + можливі заняття':''}</td><td>${new Set(t.lessons.map(l=>l.cls)).size}</td><td>${subjectCount(t.lessons)}</td><td>${t.conflicts.length} / ${t.missing.length}</td></tr>`).join('')}</tbody></table></div>`:'';
  box.innerHTML=comparison+rows.map(t=>{
    const lessons=t.lessons,minutes=lessons.reduce((n,l)=>n+l.minutes,0),unknown=lessons.filter(l=>l.start===null).length;
    const days=result.dates.map(date=>{
      const list=lessons.filter(l=>l.date===date).sort((a,b)=>(a.start??9999)-(b.start??9999));
      if(!list.length)return '';
      const intervals=list.filter(l=>l.start!==null);
      let windows=0,last=null;
      for(const l of intervals){if(last!==null&&l.start>last)windows+=l.start-last;last=Math.max(last??0,l.end);}
      return `<div class="wl-day"><b>${escHtml(names[list[0].dn])}: ${list.length} занять · ${escHtml(duration(list.reduce((n,l)=>n+l.minutes,0)))}</b>${intervals.length?`<small>Час: ${escHtml(clock(intervals[0].start))} — ${escHtml(clock(last))} · проміжки: ${escHtml(duration(windows))}</small>`:''}${list.map(l=>`<div>${escHtml(getClassNum(l.cls))} клас · ${escHtml(l.subject)} · ${escHtml(l.time||'час не вказано')}${l.substitute?' · заміна':''}</div>`).join('')}</div>`;
    }).join('');
    return `<details class="data-card" style="margin-top:12px;"><summary style="cursor:pointer;"><b>${escHtml(t.name)}</b> · ${lessons.length}${t.possible.length?`–${lessons.length+t.possible.length}`:''} занять · ${escHtml(duration(minutes))}${t.possible.length?` + можливі ${escHtml(duration(t.possible.reduce((n,l)=>n+l.minutes,0)))}`:''}${unknown?' + заняття без часу':''}</summary><p style="font-size:.82rem;">Класів: ${new Set(lessons.map(l=>l.cls)).size} · Предметів: ${subjectCount(lessons)} · Накладок: ${t.conflicts.length} · Дат без тем: ${t.missing.length}</p><div class="ma-grid">${days}</div>${t.possible.length?`<h4>Чергування ще не вибрано</h4>${t.possible.map(l=>`<div>${escHtml(label(l))}</div>`).join('')}`:''}${t.conflicts.length?`<h4 style="color:var(--red);">Накладки за часом</h4>${t.conflicts.map(([a,b])=>`<div>${escHtml(label(a))}<br>↔ ${escHtml(label(b))}</div>`).join('')}`:''}${t.missing.length?`<h4>Минулі дати без записаної теми</h4>${t.missing.map(l=>`<div>${escHtml(label(l))}</div>`).join('')}`:''}</details>`;
  }).join('')||'<p class="empty-msg">Учителів за цим пошуком немає.</p>';
  const issues=document.getElementById('d-workload-issues');if(issues)issues.innerHTML=result.issues.length?`<details style="margin-top:14px;"><summary>⚠️ Не вдалося визначити вчителя (${result.issues.length})</summary>${result.issues.map(l=>`<p>${escHtml(label(l))} — ${escHtml(l.reason)}${l.possible?' · можливий варіант чергування':''}</p>`).join('')}</details>`:'';
}
export async function openWorkloadTab(){
  const box=document.getElementById('d-workload-results');if(!box||!isDirectorRole(currentUserData?.role))return;
  const input=document.getElementById('d-workload-week');
  const monday=mondayOf(input?.value||localDateString);if(input)input.value=monday;
  const year=ACTIVE_YEAR,dates=workloadDates(monday),gen=++generation;state='loading';
  box.innerHTML='<p class="empty-msg">Рахую навантаження...</p>';
  for(const id of ['d-workload-summary','d-workload-issues']){const el=document.getElementById(id);if(el)el.textContent='';}
  try{
    const roots=['schedules','subjects_catalog','users','teacher_access'];
    const snapshots=await Promise.all([...roots.map(p=>get(ref(db,p))),
      get(ref(db,'schedule_alt')),
      get(query(ref(db,'substitutions'),orderByKey(),startAt(dates[0]),endAt(dates[6]))),
      get(ref(db,'lesson_topics')),get(ref(db,`academic_year/${year}`))]);
    if(gen!==generation)return;
    if(year!==ACTIVE_YEAR)throw Error('Навчальний рік змінився. Оновіть перевірку.');
    const [schedules,catalogs,users,access,choices,subs,topics,calendar]=snapshots.map(s=>s.exists()?s.val():{});
    result=buildWorkload({schedules,catalogs,users,access,choices,subs,topics,calendar},monday,localDateString,year);
    state='ready';renderWorkload();
  }catch(e){if(gen===generation){state='error';box.innerHTML=`<p class="empty-msg" style="color:var(--red);">Не вдалося завантажити навантаження: ${escHtml(e.message)}</p>`;}}
}
window.openWorkloadTab=openWorkloadTab;
window.renderWorkload=renderWorkload;
// Відновлена вкладка могла відкритися до завантаження цього модуля.
if(document.querySelector('#dtab-bar .dtab.on[data-t="workload"]'))openWorkloadTab();
