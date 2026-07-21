// ═══════════════════════════════════════════════════════════════
// journal.js — Grade editor popup, Journal modal + table rendering,
// and the Visual (schedule) Matrix modal used for both the live
// schedule and director's drafts.
// ═══════════════════════════════════════════════════════════════
import { ref, set, get, child } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, getActiveClass, currentUserData, displayGrade, gradeClass6, calculateStudentWeightedAvg, getClassNum, GRADE_WEIGHTS, dayKeys, dayNamesUA, showToast, localDateString, summarizeAttendanceSlots, gradeTypesCache, escJs } from './common.js';

// globalTeacherAccess is reassigned only in this file (openVisualMatrixModal)
// and read from common.js (window.getDefaultTeacher) — plain export/import.
export let globalTeacherAccess={};
// globalAllSchedules / globalAllStudents / currentMatrixMode / draftWarningsCache
// are only ever used within this file's Visual Matrix functions.
let globalAllSchedules={};
let globalAllStudents={};
let currentMatrixMode='live';
let draftWarningsCache=[];
// globalTeachersList is written to both from here and from director.js
// (loadTeachersListForDirector), so it stays on window (see common.js note).
window.globalTeachersList = window.globalTeachersList || [];

let journalMode='view'; let journalIsTeacher=false;
let gepCls=''; let gepSubj=''; let gepDate=''; let gepStudent=''; let gepType='П'; let gepCellEl=null; let gepYMonth='';
// Phase 4b/9: journal zoom state (10% steps, 40%-150%), applied via --journal-scale on
// .journal-table. journalZoomIsAuto=true means "recompute fit-to-width after every
// render" (the default); it flips to false the moment the teacher manually zooms
// in/out, so their choice survives re-renders (subject/period change, edit-mode
// toggle) until they click the zoom-label button to snap back to auto-fit.
let journalZoomLevel=100;
let journalZoomIsAuto=true;

// Shared by the journal table's month-band headers and the range/weighted-avg
// summary lines below it — hoisted to module scope so it's built once, not
// re-allocated on every renderJournalTable() call.
const monthNamesUA=['Січень','Лютий','Березень','Квітень','Травень','Червень','Липень','Серпень','Вересень','Жовтень','Листопад','Грудень'];
// "yyyy-mm" → "Місяць рррр" (e.g. "2026-07" → "Липень 2026") — used anywhere a
// Firebase month-key needs to be shown to a human instead of a raw ISO fragment.
function fmtYM(ym){const [yy,mm]=ym.split('-');return `${monthNamesUA[parseInt(mm)-1]} ${yy}`;}
// Standard Slavic/Ukrainian plural-form picker: forms=[one,few,many], e.g.
// pluralUA(3,['учень','учні','учнів']) -> 'учні'. Handles the 11-14 "always many"
// exception (11 учнів, not 11 учень) that a naive n%10 check would get wrong.
function pluralUA(n,forms){
  const n100=Math.abs(n)%100,n10=n100%10;
  if(n100>10&&n100<20)return forms[2];
  if(n10>1&&n10<5)return forms[1];
  if(n10===1)return forms[0];
  return forms[2];
}

// ══════════ GRADE EDITOR POPUP ══════════
window.selectGradeType=function(type){gepType=type;document.querySelectorAll('.type-btn').forEach(b=>b.classList.toggle('active',b.dataset.type===type));};
// Phase 5: #gep-type-btns is no longer 7-8 hardcoded <button> tags in HTML —
// they're generated here from gradeTypesCache (falls back to GRADE_WEIGHTS'
// codes if the cache hasn't loaded yet), same className/onclick pattern as before.
function renderGradeTypeButtons(){
  const c=document.getElementById('gep-type-btns');
  if(!c)return;
  const codes=Object.keys(gradeTypesCache).length>0?Object.keys(gradeTypesCache):Object.keys(GRADE_WEIGHTS);
  c.innerHTML=codes.map(code=>{
    const shortLabel=(gradeTypesCache[code]&&gradeTypesCache[code].shortLabel)||code;
    const label=(gradeTypesCache[code]&&gradeTypesCache[code].label)||code;
    return `<button type="button" class="type-btn" data-type="${code}" title="${label}" onclick="selectGradeType('${code}')">${shortLabel}</button>`;
  }).join('');
}
// Phase 4b: added presetType param — when a cell has no existing grade_type yet (new grade),
// the editor now prefills from the date column's pre-set "Тип" (journal_column_types) instead
// of always defaulting to 'П'.
function openGradeEditor(cls,subj,dateStr,student,yMonth,cellEl,existingVal,existingType,presetType){
  gepCls=cls;gepSubj=subj;gepDate=dateStr;gepStudent=student;gepYMonth=yMonth;gepCellEl=cellEl;gepType=existingType||presetType||'П';
  document.getElementById('gep-label').textContent=`${student} | ${subj} | ${dateStr.split('-').reverse().join('.')}`;
  document.getElementById('gep-value').value=existingVal||'';
  renderGradeTypeButtons();
  selectGradeType(gepType);
  const popup=document.getElementById('grade-editor-popup');popup.style.display='block';
  const rect=cellEl.getBoundingClientRect();let top=rect.bottom+6;let left=rect.left;
  if(top+230>window.innerHeight)top=rect.top-236;if(left+220>window.innerWidth)left=window.innerWidth-225;
  popup.style.top=top+'px';popup.style.left=left+'px';
  setTimeout(()=>document.getElementById('gep-value').focus(),50);
}
window.closeGradeEditor=function(){document.getElementById('grade-editor-popup').style.display='none';gepCellEl=null;};
window.confirmGrade=async function(){
  let val=document.getElementById('gep-value').value.trim();
  if(!val)return window.deleteGrade();
  // validate 1-6 scale
  const n=parseInt(val);
  if(!isNaN(n)&&(n<1||n>6)){showToast('⚠️ Оцінка має бути від 1 до 6!');return;}
  await set(ref(db,`grades/${gepCls}/${gepYMonth}/${gepSubj}/${gepDate}/${gepStudent}`),val);
  await set(ref(db,`grade_types/${gepCls}/${gepYMonth}/${gepSubj}/${gepDate}/${gepStudent}`),gepType);
  closeGradeEditor();renderJournalTable();showToast(`✅ ${gepStudent}: ${displayGrade(val,gepCls)} (${gepType})`);
};
window.deleteGrade=async function(){
  await set(ref(db,`grades/${gepCls}/${gepYMonth}/${gepSubj}/${gepDate}/${gepStudent}`),null);
  await set(ref(db,`grade_types/${gepCls}/${gepYMonth}/${gepSubj}/${gepDate}/${gepStudent}`),null);
  closeGradeEditor();renderJournalTable();showToast('🗑️ Оцінку видалено');
};
document.getElementById('gep-value').addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();window.confirmGrade();}if(e.key==='Escape'){e.preventDefault();window.closeGradeEditor();}});
document.addEventListener('click',function(e){const p=document.getElementById('grade-editor-popup');if(p.style.display==='block'&&!p.contains(e.target)&&!e.target.closest('.g-cell'))closeGradeEditor();});
// ══════════ JOURNAL MODE ══════════
window.setJournalMode=function(mode){journalMode=mode;document.getElementById('j-mode-view').classList.toggle('active',mode==='view');document.getElementById('j-mode-edit').classList.toggle('active',mode==='edit');document.getElementById('j-edit-hint').style.display=mode==='edit'?'block':'none';renderJournalTable();};
// ══════════ JOURNAL MODAL ══════════
// Phase 5: legend replacing whatever static "П=1.0 У=1.0 ДЗ=0.5..." text block
// currently lives in the journal-modal markup — swap that block for
// <div id="journal-type-legend"></div> and this renders into it.
function renderGradeTypesLegend(){
  const c=document.getElementById('journal-type-legend');
  if(!c)return;
  const codes=Object.keys(gradeTypesCache).length>0?Object.keys(gradeTypesCache):Object.keys(GRADE_WEIGHTS);
  c.innerHTML=codes.map(code=>{
    const w=(gradeTypesCache[code]&&gradeTypesCache[code].weight)??GRADE_WEIGHTS[code]??1.0;
    const label=(gradeTypesCache[code]&&gradeTypesCache[code].label)||code;
    return `<span style="display:inline-block;background:#f8f9fa;border:1px solid #e6e6e6;border-radius:var(--badge-radius);padding:2px 8px;margin:2px 4px 2px 0;font-size:var(--text-xs);color:#666;"><b style="color:#333;">${code}</b> ${label} ×${w}</span>`;
  }).join('');
}
window.openJournalModal=function(role){
  journalIsTeacher=(role==='teacher');journalMode=journalIsTeacher?'edit':'view';
  document.getElementById('journal-modal').style.display='flex';
  journalZoomIsAuto=true;journalZoomLevel=100;applyJournalZoom();
  renderGradeTypesLegend();
  const dp=document.getElementById('global-date').value.split('-');const curYM=`${dp[0]}-${dp[1]}`;
  document.getElementById('j-month-from').value=curYM;document.getElementById('j-month-to').value=curYM;
  const cs=document.getElementById('j-class-select');const cf=document.getElementById('j-class-field');const mw=document.getElementById('j-mode-toggle-wrap');
  mw.style.display=journalIsTeacher?'flex':'none';
  document.getElementById('j-edit-hint').style.display=journalIsTeacher&&journalMode==='edit'?'block':'none';
  if(journalIsTeacher){document.getElementById('j-mode-view').classList.toggle('active',journalMode==='view');document.getElementById('j-mode-edit').classList.toggle('active',journalMode==='edit');}
  // Toggle the whole label+select field (#j-class-field), not just the <select> —
  // otherwise non-directors were left with a "Клас" label floating over nothing.
  if(role==='director'){cf.style.display='block';cs.innerHTML='<option value="">Оберіть клас...</option>';for(let i=1;i<=11;i++)cs.innerHTML+=`<option value="class_${i}">${i} Клас</option>`;document.getElementById('j-subj-select').innerHTML='<option value="">Спочатку клас</option>';document.getElementById('journal-table-el').innerHTML='';}
  else{cf.style.display='none';cs.innerHTML=`<option value="${getActiveClass()}">${getActiveClass()}</option>`;updateJournalSubjects();}
};
window.closeJournalModal=function(){document.getElementById('journal-modal').style.display='none';};
window.openJournalForGrading=function(){
  openJournalModal('teacher');const subj=document.getElementById('t-subject').value;
  setTimeout(()=>{const s=document.getElementById('j-subj-select');if(subj&&Array.from(s.options).some(o=>o.value===subj))s.value=subj;renderJournalTable();},300);
};
window.updateJournalSubjects=function(){
  const cls=document.getElementById('j-class-select').value;const ss=document.getElementById('j-subj-select');
  if(!cls){ss.innerHTML='<option value="">Спочатку клас</option>';return;}
  ss.innerHTML='<option value="">Завантаження...</option>';
  window.loadScheduleScript(cls,()=>{
    let unique=new Set();if(window.schedule)dayKeys.forEach(d=>window.getTodayLessonsFlattened(d).forEach(i=>{let s=window.getValidSubjectName(i);if(s)unique.add(s);}));
    if(unique.size===0){get(child(ref(db),`grades/${cls}`)).then(snap=>{if(snap.exists()){const md=snap.val();for(let m in md)for(let s in md[m])unique.add(s);}finishJournalSubjectsRender(unique,cls,ss);});return;}
    finishJournalSubjectsRender(unique,cls,ss);
  });
};
function finishJournalSubjectsRender(unique,cls,ss){
  if(currentUserData.role==='teacher'||currentUserData.role==='art_school_teacher')unique=new Set([...unique].filter(s=>window.isSubjectAllowed(cls,s)));
  ss.innerHTML='<option value="">-- Предмет --</option>';
  if(unique.size>0)[...unique].sort().forEach(s=>ss.innerHTML+=`<option value="${s}">${s}</option>`);
  else ss.innerHTML='<option value="" disabled>Предметів немає</option>';
  if(document.getElementById('t-subject')?.value){const cv=document.getElementById('t-subject').value;if(unique.has(cv))ss.value=cv;}
  renderJournalTable();
}
// ══════════ RENDER JOURNAL TABLE ══════════
// Phase 8/9: journal is no longer locked to a single calendar month — the teacher/
// director picks an explicit "від—до" month range (#j-month-from / #j-month-to) and
// the table shows every school day across ALL months in that range. Firebase data
// stays month-keyed (grades/{cls}/{yMonth}/{subj}/...), so we just fetch each month
// in the range in parallel and merge the results client-side — nothing about the
// underlying DB schema changes.
function getJournalMonths(){
  const from=document.getElementById('j-month-from').value;
  let to=document.getElementById('j-month-to').value||from;
  if(!from)return[];
  if(to<from)to=from; // handleJournalRangeChange() already corrects+warns on this; this is just a safety net
  const [fy,fm]=from.split('-').map(Number);
  const [ty,tm]=to.split('-').map(Number);
  const total=(ty-fy)*12+(tm-fm)+1;
  if(total<=0)return[];
  const months=[];
  for(let i=0;i<total;i++){
    const t=(fm-1)+i; const yy=fy+Math.floor(t/12); const mm=(t%12)+1;
    months.push(`${yy}-${String(mm).padStart(2,'0')}`);
  }
  return months;
}
// Validates "до" isn't before "від" (auto-corrects + warns), then re-renders.
window.handleJournalRangeChange=function(){
  const fromEl=document.getElementById('j-month-from');const toEl=document.getElementById('j-month-to');
  if(fromEl.value&&toEl.value&&toEl.value<fromEl.value){toEl.value=fromEl.value;showToast('⚠️ "До" не може бути раніше "Від" — виправлено.');}
  renderJournalTable();
};
window.renderJournalTable=async function(){
  const cls=document.getElementById('j-class-select').value;
  const subj=document.getElementById('j-subj-select').value;
  const months=getJournalMonths();
  const table=document.getElementById('journal-table-el');
  const wAvgDiv=document.getElementById('j-weighted-avg');
  const rangeSummary=document.getElementById('j-range-summary');
  if(!cls||!subj||months.length===0){table.innerHTML='';wAvgDiv.style.display='none';if(rangeSummary)rangeSummary.textContent='';return;}
  if(months.length>12){showToast('⚠️ Максимальний період перегляду — 12 місяців.');return;}
  table.innerHTML='<tr><td style="padding:20px;color:#aaa;">⏳ Завантаження...</td></tr>';
  const clsNum=getClassNum(cls);
  try{
    const [studSnap,attSnap,retakeSnap,...perMonth]=await Promise.all([
      get(child(ref(db),`students_list/${cls}`)),
      get(child(ref(db),`attendance/${cls}`)),
      get(child(ref(db),`retake_requests/${cls}/${subj}`)),
      ...months.flatMap(ym=>[
        get(child(ref(db),`grades/${cls}/${ym}/${subj}`)),
        get(child(ref(db),`grade_types/${cls}/${ym}/${subj}`)),
        get(child(ref(db),`journal_column_types/${cls}/${ym}/${subj}`))
      ])
    ]);
    let students=[];if(studSnap.exists())students=Object.values(studSnap.val()).sort();
    if(students.length===0){table.innerHTML='<tr><td style="padding:20px;">Учнів немає.</td></tr>';return;}
    // Merge each month's grades/types/column-types into one flat, date-keyed object.
    const gradesData={};const typesData={};const journalColumnTypes={};
    months.forEach((ym,i)=>{
      const [gradesSnap,typesSnap,colTypesSnap]=[perMonth[i*3],perMonth[i*3+1],perMonth[i*3+2]];
      if(gradesSnap.exists())Object.assign(gradesData,gradesSnap.val());
      if(typesSnap.exists())Object.assign(typesData,typesSnap.val());
      if(colTypesSnap.exists())Object.assign(journalColumnTypes,colTypesSnap.val());
    });
    const attDataAll=attSnap.exists()?attSnap.val():{};
    const retakeData=retakeSnap.exists()?retakeSnap.val():{};
    const attData={};for(let d in attDataAll)if(months.some(ym=>d.startsWith(ym)))attData[d]=attDataAll[d];
    // Build date columns across every month in the range (each column remembers
    // its own source month `ym`, since grade writes/reads need the *correct*
    // Firebase month key, not just the range's start month).
    let dateCols=[];
    months.forEach(ym=>{
      const [y,m]=ym.split('-');const daysInMonth=new Date(y,m,0).getDate();
      for(let i=1;i<=daysInMonth;i++){
        const ds=`${ym}-${String(i).padStart(2,'0')}`;
        const dow=new Date(y,parseInt(m)-1,i).getDay();
        if(dow===0||dow===6)continue;
        const hasGrade=gradesData[ds]&&Object.keys(gradesData[ds]).length>0;
        const hasAtt=attData[ds]&&Object.keys(attData[ds]).length>0;
        const isToday=ds===localDateString;
        if(hasGrade||hasAtt||isToday)dateCols.push({ds,day:i,dow,ym});
      }
    });
    for(let ds in gradesData)if(!dateCols.find(c=>c.ds===ds)){const[yy,mm,dd]=ds.split('-');dateCols.push({ds,day:parseInt(dd),dow:new Date(ds).getDay(),ym:`${yy}-${mm}`});}
    dateCols.sort((a,b)=>a.ds.localeCompare(b.ds));
    dateCols=[...new Map(dateCols.map(c=>[c.ds,c])).values()];
    const canEdit=journalIsTeacher&&journalMode==='edit';
    const dayN=['Нд','Пн','Вт','Ср','Чт','Пт','Сб'];
    // Phase 9: without an explicit month label, a multi-month range just shows
    // repeating bare day numbers ("1 2 3...") with zero indication of which month
    // is which — group consecutive date columns by their source month so a
    // "Місяць Рік" band can span each month's columns (always shown, even for a
    // single month, so the header never silently depends on range length).
    const monthBands=[];
    dateCols.forEach(c=>{
      const last=monthBands[monthBands.length-1];
      if(last&&last.ym===c.ym)last.count++;
      else monthBands.push({ym:c.ym,count:1,bandIdx:monthBands.length});
    });
    const bandColorOf=idx=>idx%2===0?'#e8f4fd':'#e8f5e9';
    // Row 1: month bands, with rowspan-2 corner cells for the sticky student/avg columns
    let monthRow='<tr class="jt-month-row"><th class="sn" rowspan="2">Учень</th>';
    monthBands.forEach(({ym,count,bandIdx})=>{
      const [yy,mm]=ym.split('-');
      monthRow+=`<th colspan="${count}" style="background:${bandColorOf(bandIdx)};">${monthNamesUA[parseInt(mm)-1]} ${yy}</th>`;
    });
    monthRow+='<th class="avg-col" rowspan="2">Зважений<br>сер. бал</th></tr>';
    // Row 2: day-of-month + weekday (+ editable/preset "тип" control) — same content
    // as before, just tinted to match its month's band so the grouping reads clearly
    // top-to-bottom, not just from the label row.
    let dayRow='<tr class="jt-day-row">';
    let bandPtr=0,bandRemaining=monthBands.length?monthBands[0].count:0;
    dateCols.forEach(({ds,day,dow,ym})=>{
      const isToday=ds===localDateString;
      if(bandRemaining===0){bandPtr++;bandRemaining=monthBands[bandPtr].count;}
      const bandColor=bandColorOf(monthBands[bandPtr].bandIdx);bandRemaining--;
      // Phase 4b: replaced the passive, grade-derived type/weight hint with an editable
      // pre-set "expected type" control (journal_column_types), used by openGradeEditor()
      // to prefill gepType for cells that don't have a grade yet.
      const presetType=journalColumnTypes[ds]||'';
      // Phase 5: option list now sourced from gradeTypesCache (falls back to
      // GRADE_WEIGHTS' codes if the cache hasn't loaded yet), same as elsewhere.
      const typeCodes=Object.keys(gradeTypesCache).length>0?Object.keys(gradeTypesCache):Object.keys(GRADE_WEIGHTS);
      const weightOf=t=>(gradeTypesCache[t]&&gradeTypesCache[t].weight)??GRADE_WEIGHTS[t]??1.0;
      let typeCell;
      if(canEdit){
        // Phase 8: use this column's own source month (`ym`), not a single outer
        // yMonth — the range can now span several Firebase month-keys at once.
        typeCell=`<br><select class="jct-type-select" onclick="event.stopPropagation();" onchange="setJournalColumnType('${cls}','${escJs(subj)}','${ym}','${ds}',this.value)" title="Тип оцінки на цю дату">
          <option value="">—</option>
          ${typeCodes.map(t=>`<option value="${t}" ${presetType===t?'selected':''}>${t} ×${weightOf(t)}</option>`).join('')}
        </select>`;
      } else {
        typeCell=presetType?`<br><span style="font-size:.69em;color:#e67e22;">${presetType}${weightOf(presetType)?` ×${weightOf(presetType)}`:''}</span>`:'';
      }
      dayRow+=`<th class="${isToday?'today-col':''}" style="background:${bandColor};" title="${ds}">${day}<br><span style="font-size:.78em;font-weight:400;">${dayN[dow]}</span>${typeCell}</th>`;
    });
    dayRow+='</tr>';
    let thead='<thead>'+monthRow+dayRow+'</thead>';
    // Body
    let tbody='<tbody>';let classWeightedAvg=0;let classCount=0;
    students.forEach((st)=>{
      let stGrades={};let stTypes={};
      dateCols.forEach(({ds})=>{
        const v=(gradesData[ds]&&gradesData[ds][st])?gradesData[ds][st]:'';
        const tp=(typesData[ds]&&typesData[ds][st])?typesData[ds][st]:'П';
        if(v){stGrades[ds]=v;stTypes[ds]=tp;}
      });
      const avg=calculateStudentWeightedAvg(stGrades,stTypes);
      if(avg!==null){classWeightedAvg+=avg;classCount++;}
      const avgStr=avg!==null?avg.toFixed(2):'-';
      let rowHtml=`<tr><td class="sn" title="${st}">${st}</td>`;
      dateCols.forEach(({ds,ym})=>{
        const isToday=ds===localDateString;
        const attInfo=summarizeAttendanceSlots(attData[ds]&&attData[ds][st]);
        const gradeVal=(gradesData[ds]&&gradesData[ds][st])?gradesData[ds][st]:'';
        const gradeType=(typesData[ds]&&typesData[ds][st])?typesData[ds][st]:'';
        const dispVal=displayGrade(gradeVal,cls);
        const presetType=journalColumnTypes[ds]||'';
        let cell='';
        // escJs on subject + student name — both routinely contain apostrophes in
        // Ukrainian (Комп'ютерні науки, Дем'яненко) which would otherwise terminate
        // the onclick's string literal early and kill the handler.
        if(gradeVal){
          const gc=gradeClass6(gradeVal);
          cell+=`<span class="g-cell ${gc}" onclick="handleGradeClick(event,'${cls}','${escJs(subj)}','${ds}','${escJs(st)}','${ym}','${gradeVal}','${gradeType}','${presetType}')"><span class="g-val">${dispVal}</span>${gradeType?`<span class="g-type">${gradeType}</span>`:''}</span>`;
        } else if(canEdit){
          cell+=`<span class="g-cell g-empty" onclick="handleGradeClick(event,'${cls}','${escJs(subj)}','${ds}','${escJs(st)}','${ym}','','','${presetType}')">＋</span>`;
        }
        if(attInfo){const ac=attInfo.status==='absent'?'att-absent':'att-late';const al=attInfo.status==='absent'?'н':'з';cell+=`<span class="${ac}" title="${attInfo.reason}">${al}</span>`;}
        rowHtml+=`<td class="${isToday?'today-col':''}">${cell}</td>`;
      });
      const avgGc=avg!==null?gradeClass6(Math.round(avg)):'';
      rowHtml+=`<td class="avg-col"><span class="${avgGc}" style="border-radius:6px;padding:.16em .39em;font-weight:800;">${displayGrade(avgStr!=='-'?String(Math.round(avg)):'-',cls)}</span><br><span style="font-size:.78em;color:#aaa;">${avgStr}</span></td>`;
      rowHtml+='</tr>';tbody+=rowHtml;
    });
    tbody+='</tbody>';
    table.innerHTML=thead+tbody;
    // Phase 9: recompute fit-to-width on every render UNLESS the teacher has manually
    // zoomed (journalZoomIsAuto===false) — see journalZoomOut/In/Fit above.
    if(journalZoomIsAuto)journalZoomLevel=computeJournalFitPercent();
    applyJournalZoom();
    // Range summary — quick "what am I looking at" context above the table.
    // Uses fmtYM/pluralUA so it reads as real Ukrainian ("3 учні", "Липень 2026")
    // instead of raw ISO fragments and mechanically-wrong plurals ("3 учнів").
    if(rangeSummary){
      const periodStr=months.length>1?`${fmtYM(months[0])} – ${fmtYM(months[months.length-1])}`:fmtYM(months[0]);
      const studentsWord=pluralUA(students.length,['учень','учні','учнів']);
      const lessonsWord=pluralUA(dateCols.length,['урок','уроки','уроків']);
      rangeSummary.textContent=`👥 ${students.length} ${studentsWord} · 🗓️ ${dateCols.length} ${lessonsWord} · ${periodStr}`;
    }
    // Weighted avg summary
    if(classCount>0){
      const ca=(classWeightedAvg/classCount).toFixed(2);
      const periodLabel=months.length>1?` за ${fmtYM(months[0])} – ${fmtYM(months[months.length-1])}`:` за ${fmtYM(months[0])}`;
      // Build the weights hint from the live config (grade_type_defs via
      // gradeTypesCache), NOT a hardcoded string — the director can change any
      // weight at runtime, so a baked-in "ДЗ×0.5, К×2.0" would silently lie the
      // moment they do. Only non-×1 codes shown, to keep the hint short.
      const hintCodes=Object.keys(gradeTypesCache).length>0?Object.keys(gradeTypesCache):Object.keys(GRADE_WEIGHTS);
      const weightHint=hintCodes
        .map(c=>({c,w:(gradeTypesCache[c]&&gradeTypesCache[c].weight)??GRADE_WEIGHTS[c]??1.0}))
        .filter(x=>x.w!==1.0)
        .map(x=>`${x.c}×${x.w}`)
        .join(', ');
      wAvgDiv.style.display='block';
      wAvgDiv.innerHTML=`<b style="color:var(--purple);">📊 Середньозважений бал класу з ${subj}${periodLabel}:</b><br>
        <span style="font-size:1.6rem;font-weight:800;color:#7b1fa2;">${ca}</span>
        ${weightHint?`<span style="font-size:.8rem;color:#888;margin-left:8px;">(зважений: ${weightHint})</span>`:''}`;
    } else wAvgDiv.style.display='none';
  }catch(e){console.error(e);table.innerHTML=`<tr><td style="padding:20px;color:red;">Помилка: ${e.message}</td></tr>`;}
};
window.handleGradeClick=function(e,cls,subj,ds,student,yMonth,existingVal,existingType,presetType){
  if(!journalIsTeacher||journalMode!=='edit')return;
  e.stopPropagation();openGradeEditor(cls,subj,ds,student,yMonth,e.currentTarget,existingVal,existingType,presetType);
};
// ══════════ PHASE 4b: PER-DATE PRESET "ТИП" (before any grades exist) ══════════
window.setJournalColumnType=async function(cls,subj,yMonth,date,type){
  await set(ref(db,`journal_column_types/${cls}/${yMonth}/${subj}/${date}`),type||null);
  showToast(type?`✅ Тип на ${date.split('-').reverse().join('.')}: ${type}`:'🗑️ Тип знято');
};
// ══════════ PHASE 4b/9/10: JOURNAL ZOOM (40%–150%, 10% steps, smart fit-to-width) ══════════
// Metric-based zoom: --journal-scale multiplies the table's font-size (see the
// .journal-table CSS block), and every internal metric is in em, so the whole grid
// resizes natively. NO transform:scale() — the previous transform-based zoom broke
// position:sticky (sticky offsets resolve in unscaled layout coordinates, so at
// 54% the right-stuck average column visually landed mid-screen). With metric
// scaling there's nothing to compensate: sticky columns/headers and the scroll
// area's own scrollbars all just work at any zoom level.
function applyJournalZoom(){
  const table=document.getElementById('journal-table-el');
  const inner=document.getElementById('journal-scale-inner');
  const label=document.getElementById('journal-zoom-label');
  if(!table)return;
  table.style.setProperty('--journal-scale',journalZoomLevel/100);
  // Clear any leftover explicit sizing from the old transform-era compensation —
  // the wrapper must shrink-wrap the table naturally for scrollbars to be correct.
  if(inner){inner.style.width='';inner.style.height='';}
  if(label)label.innerText=journalZoomLevel+'%';
}
// Multi-month ranges can produce a very wide table (up to ~12 months × ~22 school
// days each); a single month with few students can be much narrower than the modal.
// Rather than always defaulting to a fixed 100% (leaving either a giant horizontal
// scrollbar or wasted empty space), compute the scale that makes the table exactly
// fill the available width — same idea as "zoom to fit" in spreadsheet apps.
function computeJournalFitPercent(){
  const table=document.getElementById('journal-table-el');
  const wrap=table&&table.closest('.journal-wrap');
  if(!table||!wrap)return 100;
  // Table width scales ≈linearly with the zoom percent (all metrics are em-based;
  // only 1px borders don't scale), so extrapolate from the CURRENT rendered width
  // at the CURRENT zoom instead of assuming we're measuring an unscaled table.
  const curW=table.offsetWidth;
  const availW=wrap.clientWidth;
  if(!curW||!availW)return 100;
  const fit=Math.floor(journalZoomLevel*availW/curW);
  // Auto-fit only ever SHRINKS a too-wide table to stop it overflowing — it never
  // blows up a small class (e.g. 2 students, one month) past its natural 100% size,
  // which would look absurd (huge cells, oversized text) just to "fill" the modal.
  // Manual + still lets a teacher zoom in past 100% (up to 150%) if they want to.
  return Math.max(40,Math.min(100,fit));
}
window.journalZoomOut=function(){journalZoomIsAuto=false;journalZoomLevel=Math.max(40,journalZoomLevel-10);applyJournalZoom();};
window.journalZoomIn=function(){journalZoomIsAuto=false;journalZoomLevel=Math.min(150,journalZoomLevel+10);applyJournalZoom();};
// Clicking the % label snaps back to auto-fit — and re-enables auto-fit on future
// re-renders (subject/period change, edit-mode toggle) until the user next zooms manually.
window.journalZoomFit=function(){journalZoomIsAuto=true;journalZoomLevel=computeJournalFitPercent();applyJournalZoom();};
// Re-fit on window resize (debounced) — the available width changes when the user
// resizes the browser or rotates a phone/tablet; only meaningful while the modal
// is open AND auto-fit is active (manual zoom choices are never overridden).
let journalResizeTimer=null;
window.addEventListener('resize',function(){
  if(!journalZoomIsAuto)return;
  const modal=document.getElementById('journal-modal');
  if(!modal||modal.style.display!=='flex')return;
  clearTimeout(journalResizeTimer);
  journalResizeTimer=setTimeout(()=>{journalZoomLevel=computeJournalFitPercent();applyJournalZoom();},150);
});
// ══════════ PHASE 4b: PDF EXPORT (html2canvas + jsPDF, landscape) ══════════
window.exportJournalToPDF=async function(){
  const table=document.getElementById('journal-table-el');
  if(!table||!table.innerHTML.trim()){showToast('⚠️ Немає даних для експорту!');return;}
  const cls=document.getElementById('j-class-select').value;
  const subj=document.getElementById('j-subj-select').value;
  const months=getJournalMonths();
  if(!cls||!subj||months.length===0){showToast('⚠️ Оберіть клас, предмет і місяць!');return;}
  // Human-readable label for the text printed ON the PDF page; a raw ISO-ish
  // string (safe filename characters, no spaces) for the downloaded file's name.
  const periodStrHuman=months.length>1?`${fmtYM(months[0])} – ${fmtYM(months[months.length-1])}`:fmtYM(months[0]);
  const periodStrFile=months.length>1?`${months[0]}_${months[months.length-1]}`:months[0];
  if(typeof html2canvas==='undefined'||!window.jspdf){showToast('⚠️ Бібліотеки експорту ще завантажуються, спробуйте ще раз.');return;}
  const btn=document.getElementById('btn-export-journal-pdf');
  if(btn){btn.disabled=true;btn.innerText='⏳ Експорт...';}
  const savedZoom=journalZoomLevel;
  try{
    // Capture at a consistent 100% zoom regardless of what the teacher currently has selected,
    // so the exported PDF layout doesn't depend on/get cropped by the on-screen zoom level.
    if(savedZoom!==100){journalZoomLevel=100;applyJournalZoom();await new Promise(r=>setTimeout(r,150));}
    const canvas=await html2canvas(table,{scale:2,backgroundColor:'#ffffff'});
    const imgData=canvas.toDataURL('image/png');
    const {jsPDF}=window.jspdf;
    const pdf=new jsPDF({orientation:'landscape',unit:'pt',format:'a4'});
    const pageW=pdf.internal.pageSize.getWidth();const pageH=pdf.internal.pageSize.getHeight();
    const imgRatio=canvas.width/canvas.height;
    let renderW=pageW-40,renderH=renderW/imgRatio;
    if(renderH>pageH-60){renderH=pageH-60;renderW=renderH*imgRatio;}
    pdf.setFontSize(12);
    pdf.text(`${cls.replace('class_','')} клас — ${subj} — ${periodStrHuman}`,20,25);
    pdf.addImage(imgData,'PNG',20,35,renderW,renderH);
    pdf.save(`journal_${cls}_${subj}_${periodStrFile}.pdf`);
  }catch(e){alert('Помилка експорту: '+e.message);}
  finally{
    if(savedZoom!==100){journalZoomLevel=savedZoom;applyJournalZoom();}
    if(btn){btn.disabled=false;btn.innerText='📄 Експорт PDF';}
  }
};
// ══════════ VISUAL MATRIX ══════════
window.openVisualMatrixModal=async function(mode){
  currentMatrixMode=mode;document.getElementById('visual-matrix-modal').style.display='flex';showToast("⏳ Завантаження...");
  let dbPath=mode==='live'?'schedules':`schedule_drafts/${mode}`;
  const [snap,accSnap,stSnap]=await Promise.all([get(ref(db,dbPath)),get(ref(db,'teacher_access')),get(ref(db,'students_list'))]);
  globalAllSchedules=snap.exists()?snap.val():{};globalTeacherAccess=accSnap.exists()?accSnap.val():{};globalAllStudents=stSnap.exists()?stSnap.val():{};
  const uSnap=await get(ref(db,'users'));window.globalTeachersList=[];
  if(uSnap.exists()){const u=uSnap.val();for(let uid in u){const us=u[uid];if((us.role==='teacher'||us.role==='art_school_teacher'||us.role==='music_teacher')&&us.email){const n=(us.firstName||us.lastName)?`${us.firstName||''} ${us.lastName||''}`.trim():"Ім'я";const se=us.email.replace(/\./g,'_');window.globalTeachersList.push({email:us.email,name:n,safeEmail:se});}}}
  const title=document.getElementById('matrix-modal-title');const wb=document.getElementById('constructor-warnings');
  if(mode!=='live'){title.innerHTML=`🛠️ Конструктор: <span style="color:#e67e22">${mode}</span>`;wb.style.display='block';}
  else{title.innerHTML='🗓️ Матриця розкладу';wb.style.display='none';}
  window.calculateMatrixWarnings();renderMatrixGrid();
};
window.closeVisualMatrixModal=function(){document.getElementById('visual-matrix-modal').style.display='none';};
window.calculateMatrixWarnings=function(){if(currentMatrixMode==='live')return;draftWarningsCache=[];const day=document.getElementById('matrix-day-select').value;let wHtml='<b>⚠️ Аналіз накладок:</b><ul style="margin:4px 0 0 0;padding-left:18px;">';let hasW=false;let tracker={};let maxR=8;for(let i=1;i<=11;i++){const cls=`class_${i}`;if(globalAllSchedules[cls]?.lessons?.[day])maxR=Math.max(maxR,globalAllSchedules[cls].lessons[day].length);}for(let row=0;row<maxR;row++){let slotT={};for(let c=1;c<=11;c++){const clsId=`class_${c}`;const building=c<=5?1:2;const la=(globalAllSchedules[clsId]?.lessons?.[day])||[];const raw=la[row];let items=Array.isArray(raw)?raw:(raw&&raw.subject?[raw]:[]);items.forEach((lesson,si)=>{if(lesson.type==='break')return;let te=lesson.teacherEmail;if(!te&&lesson.subject){const sn=typeof lesson.subject==='string'?lesson.subject:(lesson.subject.ua||'');const dt=window.getDefaultTeacher(clsId,sn);if(dt)te=dt.email;}if(te){if(!tracker[te])tracker[te]={};if(slotT[te]){hasW=true;wHtml+=`<li style="color:#c0392b;"><b>Накладка!</b> ${te}: ${clsId}+${slotT[te].classId} (Слот ${row+1})</li>`;draftWarningsCache.push({type:'conflict',row,classId:clsId,subIdx:si});draftWarningsCache.push({type:'conflict',row,classId:slotT[te].classId,subIdx:slotT[te].subIdx});}else slotT[te]={classId:clsId,subIdx:si};tracker[te][row]={classId:clsId,building,subIdx:si};}});}}for(let te in tracker){const slots=Object.keys(tracker[te]).map(Number).sort((a,b)=>a-b);for(let i=0;i<slots.length-1;i++){if(slots[i+1]-slots[i]===1&&tracker[te][slots[i]].building!==tracker[te][slots[i+1]].building){hasW=true;wHtml+=`<li style="color:#e67e22;"><b>Переїзд:</b> ${te} між слотами ${slots[i]+1}→${slots[i+1]+1}</li>`;draftWarningsCache.push({type:'travel',row:slots[i],classId:tracker[te][slots[i]].classId,subIdx:tracker[te][slots[i]].subIdx});draftWarningsCache.push({type:'travel',row:slots[i+1],classId:tracker[te][slots[i+1]].classId,subIdx:tracker[te][slots[i+1]].subIdx});}}}wHtml+='</ul>';const wb=document.getElementById('constructor-warnings');if(hasW){wb.innerHTML=wHtml;wb.style.display='block';}else{wb.innerHTML='✅ Накладок не виявлено!';wb.style.display='block';}};
function hasWC(row,clsId,subIdx){if(currentMatrixMode==='live')return'';const w=draftWarningsCache.find(x=>x.row===row&&x.classId===clsId&&x.subIdx===subIdx);if(!w)return'';return w.type==='conflict'?'cell-warning-conflict':'cell-warning-travel';}
function rsmcc(lesson,dTName,isOvr,clsId,row,si){const sn=typeof lesson.subject==='string'?lesson.subject:(lesson.subject.ua||'');const ts=lesson.time||'';const isB=sn.toLowerCase().includes('перерва')||sn.toLowerCase().includes('обід');const isX=lesson.type==='extra';const sl=JSON.stringify(lesson).replace(/'/g,"&apos;").replace(/"/g,"&quot;");const oc=`event.stopPropagation();openCellEditor('${clsId}',${row},${si},${sl})`;const wc=hasWC(row,clsId,si);if(isB)return`<div class="matrix-cell cell-break" onclick="${oc}"><div class="cell-subj">${sn}</div><div class="cell-time">${ts}</div></div>`;if(isX){let xi='';if(lesson.extraData){if(lesson.extraData.format==='individual')xi=`<div class="cell-student-linked">👤${lesson.extraData.student||''}</div>`;else xi=`<div class="cell-student-linked" style="background:#e8f8f5;color:#16a085;">👥Група</div>`;}const th=dTName?`<div class="cell-teacher">👨‍🏫${dTName}${isOvr?' 🔄':''}</div>`:`<div class="cell-teacher" style="color:#aaa;">—</div>`;return`<div class="matrix-cell cell-club ${wc}" onclick="${oc}"><div class="cell-subj">🎸${sn}</div>${th}${xi}<div class="cell-time">🕘${ts}</div></div>`;}const th=dTName?`<div class="cell-teacher">👨‍🏫${dTName}${isOvr?' 🔄':''}</div>`:`<div class="cell-teacher" style="color:#aaa;">—</div>`;return`<div class="matrix-cell cell-lesson ${wc}" onclick="${oc}"><div class="cell-subj">${sn}</div>${th}<div class="cell-time">🕘${ts}</div></div>`;}
window.renderMatrixGrid=function(){const day=document.getElementById('matrix-day-select').value;const th=document.getElementById('matrix-thead-row');const tb=document.getElementById('matrix-tbody');th.innerHTML='<th class="time-col">№/Час</th>';for(let i=1;i<=11;i++)th.innerHTML+=`<th>${i} Кл</th>`;tb.innerHTML='';let maxR=8;for(let i=1;i<=11;i++){const cls=`class_${i}`;if(globalAllSchedules[cls]?.lessons?.[day])maxR=Math.max(maxR,globalAllSchedules[cls].lessons[day].length);}maxR+=1;let lc=1;for(let row=0;row<maxR;row++){let tr=document.createElement('tr');let bc=0;let lsc=0;for(let c=1;c<=11;c++){const clsId=`class_${c}`;const la=(globalAllSchedules[clsId]?.lessons?.[day])||[];const raw=la[row];let items=Array.isArray(raw)?raw:(raw&&raw.subject?[raw]:[]);items.forEach(l=>{if(l&&l.subject){const sn=typeof l.subject==='string'?l.subject:(l.subject.ua||'');if(sn.toLowerCase().includes('перерва')||sn.toLowerCase().includes('обід'))bc++;else lsc++;}});}const isB=bc>0&&bc>=lsc;const isE=bc===0&&lsc===0;if(isB)tr.innerHTML='<td class="time-col" style="background:#fce4ec;color:#e91e63;">☕</td>';else if(isE)tr.innerHTML='<td class="time-col" style="color:#ccc;font-size:1.1rem;">+</td>';else tr.innerHTML=`<td class="time-col">Ур.${lc++}</td>`;for(let c=1;c<=11;c++){const clsId=`class_${c}`;const la=(globalAllSchedules[clsId]?.lessons?.[day])||[];const raw=la[row];let items=Array.isArray(raw)?raw:(raw&&raw.subject?[raw]:[]);let td=document.createElement('td');let h='';if(items.length>0){h+=`<div class="matrix-cell-container">`;items.forEach((lesson,si)=>{const sn=typeof lesson.subject==='string'?lesson.subject:(lesson.subject.ua||'');const te=lesson.teacherEmail||'';let dn=lesson.teacherName||'';let isOvr=false;const isB2=sn.toLowerCase().includes('перерва')||sn.toLowerCase().includes('обід');if(!isB2){if(!te&&sn){const dt=window.getDefaultTeacher(clsId,sn);if(dt)dn=dt.name;}else if(te)isOvr=true;}h+=rsmcc(lesson,dn,isOvr,clsId,row,si);});h+=`<div class="add-parallel-btn" onclick="event.stopPropagation();openCellEditor('${clsId}',${row},null,null)">+Паралельний</div>`;h+=`</div>`;}else h=`<div class="matrix-cell cell-empty" onclick="openCellEditor('${clsId}',${row},null,null)">+ Додати</div>`;td.innerHTML=h;tr.appendChild(td);}tb.appendChild(tr);}};
window.toggleCellType=function(){const t=document.getElementById('cell-type-select').value;const tw=document.getElementById('cell-teacher-wrapper');const si=document.getElementById('cell-subj-ua');const ni=document.getElementById('cell-number');const sl=document.getElementById('cell-subj-label');const ew=document.getElementById('cell-extra-wrapper');if(t==='break'){tw.style.display='none';ew.style.display='none';sl.innerText='Назва перерви:';if(!si.value.toLowerCase().includes('перерва')&&!si.value.toLowerCase().includes('обід'))si.value='Перерва';ni.value='';ni.disabled=true;}else if(t==='extra'){tw.style.display='block';ew.style.display='block';sl.innerText='Назва гуртка:';if(si.value.toLowerCase().includes('перерва'))si.value='';ni.disabled=false;toggleExtraFormat();}else{tw.style.display='block';ew.style.display='none';sl.innerText='Назва предмету:';if(si.value.toLowerCase().includes('перерва'))si.value='';ni.disabled=false;}window.triggerSmartCheck();};
window.toggleExtraFormat=function(){const f=document.getElementById('cell-extra-format').value;document.getElementById('extra-individual-wrap').style.display=f==='individual'?'block':'none';document.getElementById('extra-group-wrap').style.display=f==='group'?'block':'none';if(f==='group')toggleExtraGroupType();};
window.toggleExtraGroupType=function(){const gt=document.getElementById('extra-group-type').value;document.getElementById('extra-group-classes-wrap').style.display=gt==='classes'?'block':'none';document.getElementById('extra-group-students-wrap').style.display=gt==='students'?'block':'none';};
window.handleSubjInput=function(){const c=document.getElementById('cell-edit-class').value;const s=document.getElementById('cell-subj-ua').value.trim();const ts=document.getElementById('cell-teacher-select');window.updateCellEditorTeacherOptions(c,s,ts.value);window.triggerSmartCheck();};
window.updateCellEditorTeacherOptions=function(clsId,sName,curE){const ts=document.getElementById('cell-teacher-select');const dt=window.getDefaultTeacher(clsId,sName);ts.innerHTML=`<option value="">-- Авто (${dt?dt.name:'—'}) --</option>`;window.globalTeachersList.forEach(t=>ts.innerHTML+=`<option value="${t.email}">${t.name} (${t.email})</option>`);if(curE&&Array.from(ts.options).some(o=>o.value===curE))ts.value=curE;else ts.value='';};
window.triggerSmartCheck=function(){if(currentMatrixMode==='live')return;const te=document.getElementById('cell-teacher-select').value;const wb=document.getElementById('cell-live-warnings');if(!te){wb.style.display='none';return;}const day=document.getElementById('matrix-day-select').value;const clsId=document.getElementById('cell-edit-class').value;const tB=parseInt(clsId.replace('class_',''))<=5?1:2;const row=parseInt(document.getElementById('cell-edit-row').value);let conf=[];let trav=[];for(let c=1;c<=11;c++){let cc=`class_${c}`;if(cc===clsId)continue;let b=c<=5?1:2;let da=globalAllSchedules[cc]?.lessons?.[day]||[];let ss=da[row];let si=Array.isArray(ss)?ss:(ss?[ss]:[]);si.forEach(item=>{if(item.type!=='break'&&item.teacherEmail===te)conf.push(`Накладка: ${c} клас!`);});[row-1,row+1].forEach(nr=>{if(nr<0)return;let ns=da[nr];let ni=Array.isArray(ns)?ns:(ns?[ns]:[]);ni.forEach(item=>{if(item.type!=='break'&&item.teacherEmail===te&&b!==tB)trav.push(`Переїзд: ${c} клас`);});});}if(conf.length>0||trav.length>0){let h=conf.length>0?`<div style="color:#c0392b;font-weight:700;">❌ ${conf[0]}</div>`:'';if(trav.length>0)h+=`<div style="color:#e67e22;font-weight:700;">⚠️ ${trav[0]}</div>`;wb.innerHTML=h;wb.style.display='block';wb.style.background=conf.length>0?'#fdedec':'#fdf2e9';wb.style.border=`1px solid ${conf.length>0?'var(--red)':'#e67e22'}`;}else{wb.innerHTML='<div style="color:#27ae60;font-weight:700;">✅ Вільний, переїзд не потрібен.</div>';wb.style.display='block';wb.style.background='#eafaf1';wb.style.border='1px solid #2ecc71';}};
window.openCellEditor=async function(clsId,rowIdx,subIdx,lessonObj){
  const isArt=currentUserData?.role==='art_school_teacher';
  if(isArt&&lessonObj){const sn=typeof lessonObj.subject==='string'?lessonObj.subject:(lessonObj.subject.ua||'');const t=lessonObj.type||(sn.toLowerCase().includes('перерва')?'break':'lesson');if(t!=='extra'||lessonObj.teacherEmail!==currentUserData.email){alert("⛔ Тільки власні заняття.");return;}}
  document.getElementById('edit-cell-modal').style.display='flex';document.getElementById('cell-live-warnings').style.display='none';
  const day=document.getElementById('matrix-day-select').value;document.getElementById('edit-cell-subtitle').innerText=`${clsId.replace('class_','')} Клас | ${dayNamesUA[day]} | Слот ${rowIdx+1}`;
  document.getElementById('cell-edit-class').value=clsId;document.getElementById('cell-edit-row').value=rowIdx;document.getElementById('cell-edit-subindex').value=subIdx!==null?subIdx:'';
  const is=document.getElementById('extra-ind-student');const gc=document.getElementById('extra-group-classes');const gs=document.getElementById('extra-group-students');
  is.innerHTML='<option value="">-- Учень --</option>';gc.innerHTML='';gs.innerHTML='';
  for(let i=1;i<=11;i++){const cId=`class_${i}`;gc.innerHTML+=`<option value="${cId}">${i} Клас</option>`;if(globalAllStudents[cId]){const og1=document.createElement('optgroup');og1.label=`${i} Клас`;const og2=document.createElement('optgroup');og2.label=`${i} Клас`;Object.values(globalAllStudents[cId]).sort().forEach(st=>{og1.innerHTML+=`<option value="${st}">${st}</option>`;og2.innerHTML+=`<option value="${st}">${st}</option>`;});is.appendChild(og1);gs.appendChild(og2.cloneNode(true));}}
  let sn='';const ts=document.getElementById('cell-type-select');
  if(lessonObj){sn=typeof lessonObj.subject==='string'?lessonObj.subject:(lessonObj.subject.ua||'');document.getElementById('cell-subj-ua').value=sn;document.getElementById('cell-number').value=lessonObj.number||'';document.getElementById('cell-time').value=lessonObj.time||'';const isB=sn.toLowerCase().includes('перерва')||sn.toLowerCase().includes('обід');ts.value=lessonObj.type||(isB?'break':'lesson');if(lessonObj.type==='extra'&&lessonObj.extraData){document.getElementById('cell-extra-format').value=lessonObj.extraData.format||'group';if(lessonObj.extraData.format==='individual')setTimeout(()=>document.getElementById('extra-ind-student').value=lessonObj.extraData.student||'',50);else{document.getElementById('extra-group-type').value=lessonObj.extraData.groupType||'classes';}}}
  else{document.getElementById('cell-subj-ua').value='';document.getElementById('cell-number').value='';document.getElementById('cell-time').value='';ts.value=isArt?'extra':'lesson';}
  if(isArt)Array.from(ts.options).forEach(o=>o.disabled=(o.value!=='extra'));else Array.from(ts.options).forEach(o=>o.disabled=false);
  window.updateCellEditorTeacherOptions(clsId,sn,lessonObj?lessonObj.teacherEmail:'');toggleCellType();if(currentMatrixMode!=='live')window.triggerSmartCheck();
};
window.closeEditCellModal=function(){document.getElementById('edit-cell-modal').style.display='none';};
window.saveMatrixCell=async function(){
  const clsId=document.getElementById('cell-edit-class').value;const ri=parseInt(document.getElementById('cell-edit-row').value);const sis=document.getElementById('cell-edit-subindex').value;const day=document.getElementById('matrix-day-select').value;
  const type=document.getElementById('cell-type-select').value;const subj=document.getElementById('cell-subj-ua').value.trim();const time=document.getElementById('cell-time').value.trim();const num=type==='break'?'':document.getElementById('cell-number').value.trim();
  const ts=document.getElementById('cell-teacher-select');const te=type==='break'?'':ts.value;const tn=te?ts.options[ts.selectedIndex].text.split(' (')[0]:'';
  let ed=null;if(type==='extra'){const fmt=document.getElementById('cell-extra-format').value;ed={format:fmt};if(fmt==='individual')ed.student=document.getElementById('extra-ind-student').value;else{ed.groupType=document.getElementById('extra-group-type').value;const opts=ed.groupType==='classes'?document.getElementById('extra-group-classes').selectedOptions:document.getElementById('extra-group-students').selectedOptions;ed[ed.groupType==='classes'?'classes':'students']=Array.from(opts).map(o=>o.value);}}
  const nc={number:num,time,subject:{ua:subj,pl:subj},teacherEmail:te,teacherName:tn,type,extraData:ed};
  let tClasses=[clsId];if(type==='extra'&&ed?.format==='group'){if(ed.groupType==='classes'&&ed.classes?.length>0)tClasses=ed.classes;else if(ed.groupType==='students'&&ed.students?.length>0){let ac=new Set();ed.students.forEach(st=>{for(let c in globalAllStudents)if(Object.values(globalAllStudents[c]).includes(st)){ac.add(c);break;}});if(ac.size>0)tClasses=Array.from(ac);}}
  const dp=currentMatrixMode==='live'?'schedules':`schedule_drafts/${currentMatrixMode}`;
  try{for(let tc of tClasses){if(!globalAllSchedules[tc])globalAllSchedules[tc]={};if(!globalAllSchedules[tc].lessons)globalAllSchedules[tc].lessons={};if(!globalAllSchedules[tc].lessons[day])globalAllSchedules[tc].lessons[day]=[];let da=globalAllSchedules[tc].lessons[day];while(da.length<=ri)da.push({});let es=da[ri];let si2=Array.isArray(es)?[...es]:(es&&es.subject?[es]:[]);if(sis!=='')si2[parseInt(sis)]={...nc};else si2.push({...nc});da[ri]=si2;await set(ref(db,`${dp}/${tc}/lessons/${day}`),da);}
  if(te&&subj&&type!=='break'&&currentMatrixMode==='live'){const se=te.replace(/\./g,'_');for(let tc of tClasses){const as=await get(child(ref(db),`teacher_access/${se}/${tc}`));let ca=as.exists()?as.val():[];if(!Array.isArray(ca))ca=Object.values(ca);if(!ca.includes("Всі предмети")&&!ca.includes(subj)){ca.push(subj);await set(ref(db,`teacher_access/${se}/${tc}`),ca);}}}
  closeEditCellModal();if(currentMatrixMode!=='live')window.calculateMatrixWarnings();renderMatrixGrid();showToast("✅ Збережено!");}catch(e){alert("Помилка: "+e.message);}};
window.deleteMatrixCell=async function(){const clsId=document.getElementById('cell-edit-class').value;const ri=parseInt(document.getElementById('cell-edit-row').value);const sis=document.getElementById('cell-edit-subindex').value;const day=document.getElementById('matrix-day-select').value;const dp=currentMatrixMode==='live'?'schedules':`schedule_drafts/${currentMatrixMode}`;if(globalAllSchedules[clsId]?.lessons?.[day]){let da=globalAllSchedules[clsId].lessons[day];let es=da[ri];let si2=Array.isArray(es)?[...es]:(es&&es.subject?[es]:[]);if(sis!=='')si2.splice(parseInt(sis),1);da[ri]=si2.length===0?{}:si2;await set(ref(db,`${dp}/${clsId}/lessons/${day}`),da);closeEditCellModal();if(currentMatrixMode!=='live')window.calculateMatrixWarnings();renderMatrixGrid();showToast("🗑️ Видалено!");}};
