// ═══════════════════════════════════════════════════════════════
// director.js — everything only ever triggered from director-screen:
// Smart Matching (substitute finder), teacher skill matrix, schedule
// drafts constructor, teacher access matrix, staff management, and
// the director's grade statistics / dashboard.
// (Class Teacher Assignment lives in curriculum.js — see that file's
// header for why.)
// ═══════════════════════════════════════════════════════════════
import { ref, set, get, child, push, remove } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, showToast, getClassNum, displayGrade, gradeClass6, teacherAccessMatrix, getWeekDates, formatAttendanceSlotLabel, gradeTypesCache, loadGradeTypesCache, calculateStudentWeightedAvg, escJs } from './common.js';

let directorSkillsTemp=[];

// ══════════ SMART MATCHING (Director) ══════════
window.findSubstitute=async function(){
  const cls=document.getElementById('sm-class').value;const subj=document.getElementById('sm-subject').value.trim();
  const date=document.getElementById('sm-date').value;const time=document.getElementById('sm-time').value.trim();
  const results=document.getElementById('sm-results');
  if(!cls||!subj||!date){results.innerHTML='<p style="color:var(--red);font-size:.85rem;">⚠️ Заповніть усі поля!</p>';return;}
  results.innerHTML='<p style="font-size:.85rem;">🔍 Пошук...</p>';
  const [skillsSnap,usersSnap,attSnap]=await Promise.all([
    get(ref(db,'teacher_skills')),get(ref(db,'users')),get(ref(db,`attendance/ALL/${date}`))
  ]);
  const skills=skillsSnap.exists()?skillsSnap.val():{};
  let candidates=[];
  if(usersSnap.exists()){
    const users=usersSnap.val();
    for(let uid in users){
      const u=users[uid];if(u.role!=='teacher'&&u.role!=='art_school_teacher')continue;
      const se=u.email?.replace(/\./g,'_');if(!se)continue;
      const teacherSkills=skills[se]?.subjects||[];
      const hasSkill=teacherSkills.some(s=>s.toLowerCase()===subj.toLowerCase())||teacherSkills.includes('Всі предмети');
      if(!hasSkill)continue;
      const name=(u.firstName||u.lastName)?`${u.firstName||''} ${u.lastName||''}`.trim():u.email;
      // Check if teaches this class (priority)
      const teachesClass=teacherAccessMatrix[se]&&teacherAccessMatrix[se][cls];
      candidates.push({uid,email:u.email,name,hasSkill,teachesClass:!!teachesClass,priority:teachesClass?2:1});
    }
  }
  candidates.sort((a,b)=>b.priority-a.priority);
  if(candidates.length===0){results.innerHTML='<p style="color:var(--red);font-size:.85rem;">😔 Немає вчителів з потрібним скілом. Додайте скіли у профілях.</p>';return;}
  let html=`<p style="font-size:.82rem;color:#555;margin-bottom:8px;">Знайдено <b>${candidates.length}</b> кандидатів для заміни <b>${subj}</b>:</p>`;
  candidates.forEach(c=>{
    const priority=c.teachesClass?'⭐ Вже веде цей клас':'';
    html+=`<div style="background:#fff;border:1px solid #4caf50;border-radius:9px;padding:10px;margin-bottom:7px;display:flex;justify-content:space-between;align-items:center;">
      <div><b>${c.name}</b><br><span style="font-size:.75rem;color:#888;">${c.email}</span> ${priority?`<br><span style="font-size:.72rem;color:var(--green);font-weight:700;">${priority}</span>`:''}</div>
      <button onclick="confirmSubstitute('${c.email}','${cls}','${escJs(subj)}','${date}')" style="background:#1b5e20;color:#fff;padding:7px 12px;border-radius:8px;border:none;cursor:pointer;font-weight:700;font-size:.78rem;margin:0;width:auto;">Призначити</button>
    </div>`;
  });
  results.innerHTML=html;
};
window.confirmSubstitute=async function(email,cls,subj,date){
  await set(ref(db,`substitutions/${cls}/${date}`),{substituteTeacher:email,subject:subj,confirmedAt:date});
  showToast(`✅ Заміну призначено: ${email} → ${subj} у ${cls.replace('class_','')} класі`);
  document.getElementById('sm-results').innerHTML='<p style="color:var(--green);font-weight:700;">✅ Заміну підтверджено!</p>';
};
// ══════════ TEACHER SKILLS (matrix managed by director) ══════════
export async function loadDirectorTeacherSkillsList(){
  const select=document.getElementById('d-skills-teacher');select.innerHTML='<option value="">-- Оберіть вчителя --</option>';
  const snap=await get(ref(db,'users'));if(!snap.exists())return;
  const users=snap.val();for(let uid in users){const u=users[uid];if((u.role==='teacher'||u.role==='art_school_teacher')&&u.email){const n=(u.firstName||u.lastName)?`${u.firstName||''} ${u.lastName||''}`.trim():u.email;select.innerHTML+=`<option value="${u.email.replace(/\./g,'_')}">${n} (${u.email})</option>`;}}
}
window.loadDirectorTeacherSkillsList=loadDirectorTeacherSkillsList;
document.getElementById('d-skills-teacher').addEventListener('change',async function(){
  const se=this.value;if(!se){document.getElementById('d-skills-current').innerHTML='';directorSkillsTemp=[];return;}
  const snap=await get(ref(db,`teacher_skills/${se}/subjects`));
  directorSkillsTemp=snap.exists()?Object.values(snap.val()):[];
  renderDirectorSkillsTags();
});
function renderDirectorSkillsTags(){
  const c=document.getElementById('d-skills-current');c.innerHTML='';
  directorSkillsTemp.forEach((s,i)=>{c.innerHTML+=`<span class="skill-tag remove" onclick="removeDirectorSkill(${i})">✖ ${s}</span>`;});
  if(directorSkillsTemp.length===0)c.innerHTML='<p class="empty-msg" style="font-size:.8rem;">Скілів ще немає.</p>';
}
window.removeDirectorSkill=function(i){directorSkillsTemp.splice(i,1);renderDirectorSkillsTags();};
window.addTeacherSkill=function(){const v=document.getElementById('d-skill-input').value.trim();if(!v)return;if(!directorSkillsTemp.includes(v))directorSkillsTemp.push(v);document.getElementById('d-skill-input').value='';renderDirectorSkillsTags();};
window.saveTeacherSkills=async function(){const se=document.getElementById('d-skills-teacher').value;if(!se)return alert("Оберіть вчителя!");await set(ref(db,`teacher_skills/${se}/subjects`),directorSkillsTemp);showToast("✅ Скіли збережено!");};
// ══════════ SCHEDULE DRAFTS (Конструктор Розкладу) ══════════
export function loadDrafts(){get(ref(db,'schedule_drafts')).then(snap=>{const c=document.getElementById('drafts-list-container');if(snap.exists()){let h='';const dr=snap.val();for(let dn in dr)h+=`<div style="background:#f4f9fd;padding:13px;border-radius:8px;border:1px solid var(--blue);margin-bottom:9px;"><b style="color:var(--teal);">📝 ${dn}</b><div style="display:flex;gap:8px;margin-top:9px;flex-wrap:wrap;"><button style="flex:1;background:#f39c12;color:#fff;padding:11px;margin:0;min-width:100px;" onclick="openVisualMatrixModal('${dn}')">✏️ Відкрити</button><button style="background:var(--red);color:#fff;padding:11px 13px;margin:0;" onclick="deleteDraft('${dn}')">🗑</button><button style="flex:100%;background:var(--green);color:#fff;padding:11px;margin:0;" onclick="activateDraft('${dn}')">🚀 Опублікувати</button></div></div>`;c.innerHTML=h;}else c.innerHTML='<p class="empty-msg">Чернеток немає.</p>';});}
window.loadDrafts=loadDrafts;
window.createNewDraft=async function(){const name=document.getElementById('new-draft-name').value.trim();if(!name)return alert("Введіть назву!");const ok=confirm("Скопіювати поточний розклад?");if(ok){const s=await get(ref(db,'schedules'));if(s.exists())await set(ref(db,`schedule_drafts/${name}`),s.val());else await set(ref(db,`schedule_drafts/${name}`),{placeholder:true});}else await set(ref(db,`schedule_drafts/${name}`),{placeholder:true});document.getElementById('new-draft-name').value='';showToast("✅ Чернетку створено!");loadDrafts();};
window.deleteDraft=function(name){if(confirm(`Видалити "${name}"?`))remove(ref(db,`schedule_drafts/${name}`)).then(()=>loadDrafts());};
window.activateDraft=async function(name){if(confirm(`⚠️ Зробити "${name}" основним розкладом?`)){const s=await get(ref(db,`schedule_drafts/${name}`));if(s.exists()){await set(ref(db,'schedules'),s.val());showToast("🚀 Розклад опубліковано!");}}};
// ══════════ ACADEMIC YEAR (Навчальний рік) ══════════
// Exported so parent-student.js's read-only calendar (Phase 3) can look up
// the same school year's holidays/breaks without recomputing the rule.
export function getAcademicYearId(){const now=new Date();const y=now.getFullYear();const m=now.getMonth()+1;return m>=9?`${y}-${y+1}`:`${y-1}-${y}`;}
export const ACADEMIC_YEAR_ID=getAcademicYearId();
function formatClassesLabel(classes){if(classes==='all')return '🌟 Усі класи';if(Array.isArray(classes)&&classes.length>0)return classes.map(c=>c.replace('class_','')).sort((a,b)=>a-b).join(', ')+' кл.';return '—';}
window.loadAcademicYear=function(){const lbl=document.getElementById('ay-year-label');if(lbl)lbl.innerText=ACADEMIC_YEAR_ID;loadSemesters();loadBreaks();loadHolidays();};
// --- Семестри ---
function loadSemesters(){get(ref(db,`academic_year/${ACADEMIC_YEAR_ID}/semesters`)).then(snap=>{const c=document.getElementById('ay-semesters-list');if(snap.exists()){const d=snap.val();let h='';for(let id in d){const s=d[id];h+=`<div style="background:#fff;padding:9px 11px;border-radius:8px;border:1px solid #ffe0b2;margin-bottom:7px;display:flex;justify-content:space-between;align-items:center;"><div><b>${s.name}</b><br><span style="font-size:.78rem;color:#888;">${(s.startDate||'').split('-').reverse().join('.')} — ${(s.endDate||'').split('-').reverse().join('.')}</span></div><button onclick="removeSemester('${id}')" style="background:var(--red);color:#fff;width:auto;padding:6px 10px;margin:0;border-radius:7px;font-size:.78rem;">🗑</button></div>`;}c.innerHTML=h||'<p class="empty-msg">Семестрів ще немає.</p>';}else c.innerHTML='<p class="empty-msg">Семестрів ще немає.</p>';});}
window.addSemester=async function(){
  const name=document.getElementById('ay-sem-name').value.trim();
  const startDate=document.getElementById('ay-sem-start').value;
  const endDate=document.getElementById('ay-sem-end').value;
  if(!name||!startDate||!endDate)return alert("Заповніть усі поля!");
  if(startDate>endDate)return alert("Дата початку пізніше дати завершення!");
  await push(ref(db,`academic_year/${ACADEMIC_YEAR_ID}/semesters`),{name,startDate,endDate});
  document.getElementById('ay-sem-name').value='';document.getElementById('ay-sem-start').value='';document.getElementById('ay-sem-end').value='';
  showToast("✅ Семестр додано!");loadSemesters();
};
window.removeSemester=function(id){if(confirm("Видалити цей семестр?"))remove(ref(db,`academic_year/${ACADEMIC_YEAR_ID}/semesters/${id}`)).then(()=>{showToast("🗑️ Семестр видалено");loadSemesters();});};
// --- Канікули ---
window.toggleAllClasses=function(kind){const cb=document.getElementById(`ay-${kind}-all-classes`);const sel=document.getElementById(`ay-${kind}-classes`);sel.disabled=cb.checked;if(cb.checked)Array.from(sel.options).forEach(o=>o.selected=false);};
function loadBreaks(){get(ref(db,`academic_year/${ACADEMIC_YEAR_ID}/breaks`)).then(snap=>{const c=document.getElementById('ay-breaks-list');if(snap.exists()){const d=snap.val();let h='';for(let id in d){const b=d[id];h+=`<div style="background:#fff;padding:9px 11px;border-radius:8px;border:1px solid #ffe0b2;margin-bottom:7px;display:flex;justify-content:space-between;align-items:center;"><div><b>${b.title}</b><br><span style="font-size:.78rem;color:#888;">${(b.startDate||'').split('-').reverse().join('.')} — ${(b.endDate||'').split('-').reverse().join('.')} | ${formatClassesLabel(b.classes)}</span></div><button onclick="removeBreak('${id}')" style="background:var(--red);color:#fff;width:auto;padding:6px 10px;margin:0;border-radius:7px;font-size:.78rem;">🗑</button></div>`;}c.innerHTML=h||'<p class="empty-msg">Канікул ще немає.</p>';}else c.innerHTML='<p class="empty-msg">Канікул ще немає.</p>';});}
window.addBreak=async function(){
  const title=document.getElementById('ay-break-title').value.trim();
  const startDate=document.getElementById('ay-break-start').value;
  const endDate=document.getElementById('ay-break-end').value;
  const allChecked=document.getElementById('ay-break-all-classes').checked;
  const sel=document.getElementById('ay-break-classes');
  const classes=allChecked?'all':Array.from(sel.selectedOptions).map(o=>o.value);
  if(!title||!startDate||!endDate)return alert("Заповніть усі поля!");
  if(startDate>endDate)return alert("Дата початку пізніше дати завершення!");
  if(!allChecked&&classes.length===0)return alert("Оберіть класи або позначте 'Усі класи'!");
  await push(ref(db,`academic_year/${ACADEMIC_YEAR_ID}/breaks`),{title,startDate,endDate,classes});
  document.getElementById('ay-break-title').value='';document.getElementById('ay-break-start').value='';document.getElementById('ay-break-end').value='';
  document.getElementById('ay-break-all-classes').checked=false;sel.disabled=false;Array.from(sel.options).forEach(o=>o.selected=false);
  showToast("✅ Канікули додано!");loadBreaks();
};
window.removeBreak=function(id){if(confirm("Видалити ці канікули?"))remove(ref(db,`academic_year/${ACADEMIC_YEAR_ID}/breaks/${id}`)).then(()=>{showToast("🗑️ Видалено");loadBreaks();});};
// --- Свята ---
function loadHolidays(){get(ref(db,`academic_year/${ACADEMIC_YEAR_ID}/holidays`)).then(snap=>{const c=document.getElementById('ay-holidays-list');if(snap.exists()){const d=snap.val();let h='';for(let id in d){const hd=d[id];const typeLabel=hd.calendarType==='art_school'?'🎵 Школа мистецтв':'🏫 Загальна школа';h+=`<div style="background:#fff;padding:9px 11px;border-radius:8px;border:1px solid #ffe0b2;margin-bottom:7px;display:flex;justify-content:space-between;align-items:center;"><div><b>${hd.title}</b><br><span style="font-size:.78rem;color:#888;">${(hd.date||'').split('-').reverse().join('.')} | ${formatClassesLabel(hd.classes)} | ${typeLabel}</span></div><button onclick="removeHoliday('${id}')" style="background:var(--red);color:#fff;width:auto;padding:6px 10px;margin:0;border-radius:7px;font-size:.78rem;">🗑</button></div>`;}c.innerHTML=h||'<p class="empty-msg">Свят ще немає.</p>';}else c.innerHTML='<p class="empty-msg">Свят ще немає.</p>';});}
window.addHoliday=async function(){
  const title=document.getElementById('ay-holiday-title').value.trim();
  const date=document.getElementById('ay-holiday-date').value;
  const allChecked=document.getElementById('ay-holiday-all-classes').checked;
  const sel=document.getElementById('ay-holiday-classes');
  const classes=allChecked?'all':Array.from(sel.selectedOptions).map(o=>o.value);
  const calendarType=document.getElementById('ay-holiday-calendar-type').value;
  if(!title||!date)return alert("Заповніть усі поля!");
  if(!allChecked&&classes.length===0)return alert("Оберіть класи або позначте 'Усі класи'!");
  await push(ref(db,`academic_year/${ACADEMIC_YEAR_ID}/holidays`),{title,date,classes,calendarType});
  document.getElementById('ay-holiday-title').value='';document.getElementById('ay-holiday-date').value='';
  document.getElementById('ay-holiday-all-classes').checked=false;sel.disabled=false;Array.from(sel.options).forEach(o=>o.selected=false);
  showToast("✅ Свято додано!");loadHolidays();
};
window.removeHoliday=function(id){if(confirm("Видалити це свято?"))remove(ref(db,`academic_year/${ACADEMIC_YEAR_ID}/holidays/${id}`)).then(()=>{showToast("🗑️ Видалено");loadHolidays();});};
// ══════════ TEACHER LIST FOR DIRECTOR (access matrix + staff mgmt) ══════════
export async function loadTeachersListForDirector(){const s=document.getElementById('d-acc-email-select');s.innerHTML='<option value="">-- Вчитель --</option>';const snap=await get(ref(db,'users'));window.globalTeachersList=[];if(snap.exists()){const u=snap.val();for(let uid in u){const us=u[uid];if((us.role==='teacher'||us.role==='art_school_teacher'||us.role==='music_teacher')&&us.email){const n=(us.firstName||us.lastName)?`${us.firstName||''} ${us.lastName||''}`.trim():us.email;const se=us.email.replace(/\./g,'_');s.innerHTML+=`<option value="${se}">${n} (${us.email})</option>`;window.globalTeachersList.push({email:us.email,name:n,safeEmail:se});}}}}
window.loadTeachersListForDirector=loadTeachersListForDirector;
window.loadDirectorMatrixSubjects=function(){const cls=document.getElementById('d-acc-class').value;const ss=document.getElementById('d-acc-subjects');if(!cls){ss.innerHTML='<option disabled>Оберіть клас...</option>';return;}ss.innerHTML='<option disabled>Завантаження...</option>';window.loadScheduleScript(cls,()=>{let u=new Set();if(window.schedule)['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].forEach(d=>window.getTodayLessonsFlattened(d).forEach(i=>{const s=window.getValidSubjectName(i);if(s)u.add(s);}));ss.innerHTML='<option value="Всі предмети" style="font-weight:700;color:#d35400;">🌟 Всі предмети</option>';if(u.size>0)[...u].sort().forEach(subj=>ss.innerHTML+=`<option value="${subj}">${subj}</option>`);else ss.innerHTML='<option disabled>Розклад не знайдено</option>';});};
window.grantTeacherAccess=function(){const se=document.getElementById('d-acc-email-select').value;const cls=document.getElementById('d-acc-class').value;const opts=document.getElementById('d-acc-subjects').selectedOptions;const subjs=Array.from(opts).map(o=>o.value);if(!se||!cls||subjs.length===0)return alert('Заповніть усі поля!');set(ref(db,`pre_approved_roles/${se}`),'teacher').catch(()=>{});set(ref(db,`teacher_access/${se}/${cls}`),subjs).then(()=>{alert('✅ Доступ збережено!');}).catch(e=>alert("Помилка: "+e.message));};
window.grantStaffRole=function(){const e=document.getElementById('new-staff-email').value.trim().replace(/\./g,'_');const r=document.getElementById('new-staff-role').value;if(!e)return alert("Введіть Email!");set(ref(db,`pre_approved_roles/${e}`),r).then(()=>alert('✅ Доступ надано!'));};
// ══════════ DIRECTOR STATS ══════════
window.updateDirectorStatSubjects=function(){const cls=document.getElementById('d-stat-class').value;const ss=document.getElementById('d-stat-subj');if(!cls){ss.innerHTML='<option>Оберіть клас</option>';document.getElementById('d-stat-results').innerHTML='<p class="empty-msg">Оберіть клас та предмет.</p>';return;}ss.innerHTML='<option>Завантаження...</option>';get(child(ref(db),`grades/${cls}`)).then(snap=>{let u=new Set();if(snap.exists()){const d=snap.val();for(let m in d)for(let s in d[m])u.add(s);}ss.innerHTML='<option value="">-- Предмет --</option>';if(u.size>0)[...u].sort().forEach(s=>ss.innerHTML+=`<option value="${s}">${s}</option>`);else ss.innerHTML='<option disabled>Оцінок немає</option>';});};
window.renderDirectorStats=async function(){const cls=document.getElementById('d-stat-class').value;const subj=document.getElementById('d-stat-subj').value;const rd=document.getElementById('d-stat-results');if(!cls||!subj){rd.innerHTML='<p class="empty-msg">Оберіть клас та предмет.</p>';return;}rd.innerHTML='<p>⏳ Обчислення...</p>';try{const [ss,gs,ts]=await Promise.all([get(child(ref(db),`students_list/${cls}`)),get(child(ref(db),`grades/${cls}`)),get(child(ref(db),`grade_types/${cls}`))]);let stList=[];if(ss.exists())stList=Object.values(ss.val()).sort();if(stList.length===0){rd.innerHTML='<p class="empty-msg">Немає учнів.</p>';return;}const gd=gs.exists()?gs.val():{};const td=ts.exists()?ts.val():{};let stats={};stList.forEach(st=>stats[st]={grades:{},types:{}});for(let m in gd)if(gd[m][subj])for(let date in gd[m][subj])for(let st in gd[m][subj][date])if(stats[st]){stats[st].grades[`${m}_${date}`]=gd[m][subj][date][st];const tp=td[m]?.[subj]?.[date]?.[st];if(tp)stats[st].types[`${m}_${date}`]=tp;}
  // The column header says "Зважений сер." — so actually weight it: per-cell grade
  // types come from grade_types/{cls}/{m}/{subj}/{date}/{st} (same composite key as
  // grades above), and calculateStudentWeightedAvg applies grade_type_defs weights
  // (untyped grades default to 'П' ×1 inside it). Was previously a plain mean with
  // a TODO admitting the mismatch between label and calculation.
  const clsNum=getClassNum(cls);
  let h='<table style="width:100%;border-collapse:collapse;font-size:.85rem;"><thead><tr><th style="text-align:left;padding:5px;background:#e8f4fd;">Учень</th><th style="background:#e8f4fd;">Зважений сер.</th><th style="background:#e8f4fd;">Оцінок</th></tr></thead><tbody>';
  let totalAvg=0;let cnt=0;
  stList.forEach(st=>{const g=stats[st].grades;const count=Object.keys(g).length;const avg=calculateStudentWeightedAvg(g,stats[st].types);const disp=avg!==null?displayGrade(String(Math.round(avg)),cls)+' ('+avg.toFixed(2)+')':'-';if(avg!==null){totalAvg+=avg;cnt++;}const gc=avg!==null?gradeClass6(Math.round(avg)):'';h+=`<tr><td style="padding:5px;border-bottom:1px solid #eee;"><b>${st}</b></td><td style="text-align:center;"><span class="g-cell ${gc}" style="display:inline-block;padding:3px 8px;">${disp}</span></td><td style="text-align:center;">${count}</td></tr>`;});
  const ca=cnt>0?(totalAvg/cnt).toFixed(2):'-';h+=`</tbody></table><div style="background:#f4ecf7;border:1px solid #d2b4de;padding:12px;border-radius:8px;text-align:center;margin-top:10px;"><b style="color:var(--purple);">🏆 Середній бал класу:</b><br><span style="font-size:1.5rem;font-weight:800;color:#7b1fa2;">${displayGrade(String(Math.round(parseFloat(ca)||0)),cls)} (${ca})</span></div>`;rd.innerHTML=h;}catch(e){rd.innerHTML=`<p style="color:red;">Помилка: ${e.message}</p>`;}};
// ══════════ DIRECTOR DASHBOARD ══════════
export async function loadDirectorDashboard(){try{const date=document.getElementById('global-date').value;const dp=date.split('-');document.getElementById('d-att-header').innerText=`🚨 Відсутні (${dp[2]}.${dp[1]}, вся школа)`;const wd=getWeekDates(date);let hw=0,com=0,wl=0,wa=0,attHtml='';const[hwS,comS,attS]=await Promise.all([get(child(ref(db),'homeworks')),get(child(ref(db),'comments')),get(child(ref(db),'attendance'))]);const hd=hwS.exists()?hwS.val():{};const cd=comS.exists()?comS.val():{};const ad=attS.exists()?attS.val():{};for(let i=1;i<=11;i++){const c=`class_${i}`;if(hd[c]&&hd[c][date])hw+=Object.keys(hd[c][date]).length;if(cd[c]&&cd[c][date]){for(let s in cd[c][date])if(typeof cd[c][date][s]==='object')com+=Object.keys(cd[c][date][s]).length;}if(ad[c]&&ad[c][date])for(let st in ad[c][date]){const slots=ad[c][date][st];for(let sk in slots){const r=slots[sk];if(r?.status){const bc=r.status==='late'?'badge-late':'badge-absent';const lb=r.status==='late'?'Запізнення':'Відсутність';const markerIcon=r.markedBy==='teacher'?'👨‍🏫':(r.markedBy==='student'?'🎒':'👪');attHtml+=`<li style="margin-bottom:9px;border-bottom:1px solid #eee;padding-bottom:4px;"><span style="font-size:.72rem;background:var(--teal);color:#fff;padding:2px 5px;border-radius:4px;margin-right:4px;">${i} Кл</span> <b>${st}</b> <span class="badge ${bc}">${lb}</span> <span style="font-size:.72rem;color:#888;">${formatAttendanceSlotLabel(sk)} ${markerIcon}</span><br><i style="font-size:.78rem;color:#666;">${r.reason}</i></li>`;}}}if(ad[c])wd.forEach(w=>{if(ad[c][w]&&typeof ad[c][w]==='object')Object.values(ad[c][w]).forEach(slots=>{if(slots&&typeof slots==='object')Object.values(slots).forEach(r=>{if(r?.status==='late')wl++;else if(r?.status==='absent')wa++;});});});}document.getElementById('d-hw-counter').innerText=hw;document.getElementById('d-com-counter').innerText=com;document.getElementById('d-week-late').innerText=wl;document.getElementById('d-week-absent').innerText=wa;document.getElementById('d-unified-att-list').innerHTML=attHtml||'<li class="empty-msg">Усі присутні!</li>';}catch(e){console.error(e);}}
window.loadDirectorDashboard=loadDirectorDashboard;
// ══════════ BELL SCHEDULES (Розклад дзвінків) ══════════
let bellSlotsTemp=[];
window.loadBellSchedule=async function(){
  const cls=document.getElementById('bell-class-select').value;
  const container=document.getElementById('bell-slots-table');
  if(!cls){container.innerHTML='<p class="empty-msg">Оберіть клас.</p>';bellSlotsTemp=[];return;}
  container.innerHTML='<p class="empty-msg">Завантаження...</p>';
  const snap=await get(ref(db,`bell_schedules/${cls}`));
  bellSlotsTemp=[];
  if(snap.exists()){
    const d=snap.val();
    bellSlotsTemp=Object.keys(d).sort((a,b)=>(parseInt(a)||0)-(parseInt(b)||0)).map(k=>({number:d[k].number??k,start:d[k].start||'',end:d[k].end||''}));
  }
  renderBellSlotsTable();
};
function renderBellSlotsTable(){
  const container=document.getElementById('bell-slots-table');
  if(!container)return;
  if(bellSlotsTemp.length===0){container.innerHTML='<p class="empty-msg">Уроків ще немає. Додайте перший.</p>';return;}
  let h='<div style="display:flex;flex-direction:column;gap:6px;">';
  bellSlotsTemp.forEach((s,i)=>{
    h+=`<div style="display:flex;gap:7px;align-items:center;">
      <span style="width:26px;text-align:center;font-weight:800;color:#283593;">${s.number}</span>
      <input type="time" value="${s.start}" onchange="updateBellSlot(${i},'start',this.value)" style="flex:1;margin:0;">
      <span style="color:#888;">—</span>
      <input type="time" value="${s.end}" onchange="updateBellSlot(${i},'end',this.value)" style="flex:1;margin:0;">
      <button onclick="removeBellSlot(${i})" style="background:var(--red);color:#fff;width:auto;padding:6px 9px;margin:0;border-radius:7px;">✖</button>
    </div>`;
  });
  h+='</div>';
  container.innerHTML=h;
}
window.updateBellSlot=function(i,field,val){if(bellSlotsTemp[i])bellSlotsTemp[i][field]=val;};
window.addBellSlot=function(){const nextNum=bellSlotsTemp.length>0?Math.max(...bellSlotsTemp.map(s=>parseInt(s.number)||0))+1:1;bellSlotsTemp.push({number:nextNum,start:'',end:''});renderBellSlotsTable();};
window.removeBellSlot=function(i){bellSlotsTemp.splice(i,1);renderBellSlotsTable();};
window.saveBellSchedule=async function(){
  const cls=document.getElementById('bell-class-select').value;
  if(!cls)return alert("Оберіть клас!");
  const obj={};
  bellSlotsTemp.forEach(s=>{if(s.start&&s.end)obj[s.number]={number:s.number,start:s.start,end:s.end};});
  await set(ref(db,`bell_schedules/${cls}`),obj);
  showToast("✅ Розклад дзвінків збережено!");
};
// ══════════ PHASE 5: GRADE TYPES (Типи оцінок) ══════════
// gradeTypesCache itself is only ever reassigned inside common.js
// (loadGradeTypesCache) — every write below goes to Firebase first, then
// calls loadGradeTypesCache() to refresh the shared cache, then re-renders
// from it. This keeps journal.js's dynamic type buttons/legend and the
// weighted-average calculations in sync immediately, without a page reload.
window.loadGradeTypesAdmin=async function(){
  const c=document.getElementById('gt-types-table');
  if(c)c.innerHTML='<p class="empty-msg">Завантаження...</p>';
  await loadGradeTypesCache();
  renderGradeTypesTable();
};
function renderGradeTypesTable(){
  const c=document.getElementById('gt-types-table');
  if(!c)return;
  const codes=Object.keys(gradeTypesCache);
  if(codes.length===0){c.innerHTML='<p class="empty-msg">Типів ще немає.</p>';return;}
  let h='<div style="display:flex;flex-direction:column;gap:6px;">';
  codes.forEach(code=>{
    const t=gradeTypesCache[code]||{};
    h+=`<div style="display:flex;gap:7px;align-items:center;background:#fff;border:1px solid #e0e0e0;border-radius:8px;padding:7px 9px;">
      <span style="width:38px;text-align:center;font-weight:800;color:#283593;">${code}</span>
      <span style="flex:1;font-size:.85rem;color:#555;">${t.label||code}</span>
      <span style="font-size:.75rem;color:#888;">×</span>
      <input type="number" step="0.1" min="0.1" value="${t.weight??1.0}" onchange="updateGradeTypeWeight('${code}',this.value)" style="width:64px;margin:0;padding:5px;">
      <button onclick="removeGradeType('${code}')" style="background:var(--red);color:#fff;width:auto;padding:6px 9px;margin:0;border-radius:7px;">🗑</button>
    </div>`;
  });
  h+='</div>';
  c.innerHTML=h;
}
window.updateGradeTypeWeight=async function(code,val){
  const w=parseFloat(val);
  if(isNaN(w)||w<=0){showToast('⚠️ Коефіцієнт має бути додатним числом!');renderGradeTypesTable();return;}
  await set(ref(db,`grade_type_defs/${code}/weight`),w);
  await loadGradeTypesCache();renderGradeTypesTable();
  showToast(`✅ Коефіцієнт "${code}" оновлено: ×${w}`);
};
window.addGradeType=async function(){
  const code=document.getElementById('gt-new-code').value.trim();
  const label=document.getElementById('gt-new-label').value.trim();
  const weight=parseFloat(document.getElementById('gt-new-weight').value);
  if(!code||!label||isNaN(weight)||weight<=0)return alert("Заповніть усі поля коректно!");
  if(gradeTypesCache[code]&&!confirm(`Тип "${code}" вже існує. Перезаписати?`))return;
  await set(ref(db,`grade_type_defs/${code}`),{label,shortLabel:code,weight});
  document.getElementById('gt-new-code').value='';document.getElementById('gt-new-label').value='';document.getElementById('gt-new-weight').value='';
  await loadGradeTypesCache();renderGradeTypesTable();
  showToast(`✅ Тип "${code}" додано!`);
};
window.removeGradeType=async function(code){
  if(!confirm(`Видалити тип "${code}"? Це вплине на вже виставлені оцінки цього типу.`))return;
  await remove(ref(db,`grade_type_defs/${code}`));
  await loadGradeTypesCache();renderGradeTypesTable();
  showToast(`🗑️ Тип "${code}" видалено`);
};
