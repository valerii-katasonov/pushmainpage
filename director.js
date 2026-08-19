// ═══════════════════════════════════════════════════════════════
// director.js — everything only ever triggered from director-screen:
// Smart Matching (substitute finder), teacher skill matrix, schedule
// drafts constructor, teacher access matrix, staff management, and
// the director's grade statistics / dashboard.
// (Class Teacher Assignment lives in curriculum.js — see that file's
// header for why.)
// ═══════════════════════════════════════════════════════════════
import { ref, set, get, child, push, remove, update } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, showToast, getClassNum, displayGrade, gradeClass6, teacherAccessMatrix, getWeekDates, formatAttendanceSlotLabel, gradeTypesCache, loadGradeTypesCache, calculateStudentWeightedAvg, escJs, escHtml, localDateString, normalizeRoles, getUserRoles, ROLE_LABELS, currentUserData, dayNamesUA, sendPasswordReset } from './common.js';

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
  const users=snap.val();for(let uid in users){const u=users[uid];const rs=getUserRoles(u);if(rs.some(r=>r==='teacher'||r==='art_school_teacher'||r==='class_teacher'||r==='music_teacher')&&u.email&&!u.disabled){const n=(u.firstName||u.lastName)?`${u.firstName||''} ${u.lastName||''}`.trim():u.email;select.innerHTML+=`<option value="${u.email.replace(/\./g,'_')}">${escHtml(n)} (${escHtml(u.email)})</option>`;}}
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
// Мультиролі: вчителем вважається той, у кого вчительська роль є СЕРЕД ролей,
// а не лише як активна. Відключених (disabled) до списків не додаємо.
export async function loadTeachersListForDirector(){const s=document.getElementById('d-acc-email-select');s.innerHTML='<option value="">-- Вчитель --</option>';const snap=await get(ref(db,'users'));window.globalTeachersList=[];if(snap.exists()){const u=snap.val();for(let uid in u){const us=u[uid];const rs=getUserRoles(us);if(rs.some(r=>r==='teacher'||r==='art_school_teacher'||r==='class_teacher'||r==='music_teacher')&&us.email&&!us.disabled){const n=(us.firstName||us.lastName)?`${us.firstName||''} ${us.lastName||''}`.trim():us.email;const se=us.email.replace(/\./g,'_');s.innerHTML+=`<option value="${se}">${escHtml(n)} (${escHtml(us.email)})</option>`;window.globalTeachersList.push({email:us.email,name:n,safeEmail:se});}}}}
window.loadTeachersListForDirector=loadTeachersListForDirector;
window.loadDirectorMatrixSubjects=function(){const cls=document.getElementById('d-acc-class').value;const ss=document.getElementById('d-acc-subjects');if(!cls){ss.innerHTML='<option disabled>Оберіть клас...</option>';return;}ss.innerHTML='<option disabled>Завантаження...</option>';window.loadScheduleScript(cls,()=>{let u=new Set();if(window.schedule)['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].forEach(d=>window.getTodayLessonsFlattened(d).forEach(i=>{const s=window.getValidSubjectName(i);if(s)u.add(s);}));ss.innerHTML='<option value="Всі предмети" style="font-weight:700;color:#d35400;">🌟 Всі предмети</option>';if(u.size>0)[...u].sort().forEach(subj=>ss.innerHTML+=`<option value="${subj}">${subj}</option>`);else ss.innerHTML='<option disabled>Розклад не знайдено</option>';});};
window.grantTeacherAccess=function(){const se=document.getElementById('d-acc-email-select').value;const cls=document.getElementById('d-acc-class').value;const opts=document.getElementById('d-acc-subjects').selectedOptions;const subjs=Array.from(opts).map(o=>o.value);if(!se||!cls||subjs.length===0)return alert('Заповніть усі поля!');set(ref(db,`pre_approved_roles/${se}`),'teacher').catch(()=>{});set(ref(db,`teacher_access/${se}/${cls}`),subjs).then(()=>{alert('✅ Доступ збережено!');}).catch(e=>alert("Помилка: "+e.message));};
// pre_approved_roles/{safeEmail} тепер може містити масив ролей — одна особа
// може бути одночасно, напр., вчителем і адміністратором.
window.grantStaffRole=async function(){
  const raw=document.getElementById('new-staff-email').value.trim().toLowerCase();
  const sel=document.getElementById('new-staff-role');
  const roles=Array.from(sel.selectedOptions).map(o=>o.value);
  if(!raw)return alert("Введіть Email!");
  if(roles.length===0)return alert("Виберіть хоча б одну роль!");
  const se=raw.replace(/\./g,'_');
  try{
    await set(ref(db,`pre_approved_roles/${se}`),roles);
    // Якщо людина вже заходила раніше — оновлюємо і її профіль, щоб нові ролі
    // застосувались без очікування повторного входу. Заодно знімаємо disabled,
    // якщо співробітника раніше видаляли, а тепер повертають.
    const us=await get(ref(db,'users'));
    if(us.exists()){
      const u=us.val();
      for(let uid in u){
        if((u[uid].email||'').toLowerCase()===raw){
          const patch={roles,disabled:null};
          if(!roles.includes(u[uid].role))patch.role=roles[0];
          await update(ref(db,`users/${uid}`),patch);
        }
      }
    }
    const names=roles.map(r=>ROLE_LABELS[r]||r).join(', ');
    showToast(`✅ Доступ надано: ${names}`);
    document.getElementById('new-staff-email').value='';
    window.loadStaffList();
  }catch(e){alert('Помилка: '+e.message);}
};
// ══════════ ПЕРСОНАЛ: список ══════════
window.loadStaffList=async function(){
  const box=document.getElementById('staff-list');
  if(!box)return;
  box.innerHTML='<p class="empty-msg">Завантаження...</p>';
  try{
    const [approvedSnap,usersSnap]=await Promise.all([
      get(child(ref(db),'pre_approved_roles')),
      get(child(ref(db),'users'))
    ]);
    const approved=approvedSnap.exists()?approvedSnap.val():{};
    const users=usersSnap.exists()?usersSnap.val():{};
    // Індекс users за safeEmail — щоб показати ім'я та статус
    const byEmail={};
    for(let uid in users){
      const u=users[uid];
      if(u.email)byEmail[u.email.replace(/\./g,'_')]={uid,...u};
    }
    const keys=Object.keys(approved);
    if(keys.length===0){box.innerHTML='<p class="empty-msg">Персоналу ще не додано.</p>';return;}
    const myEmailSafe=(currentUserData?.email||'').replace(/\./g,'_');
    let html='';
    keys.sort().forEach(safeEmail=>{
      const roles=normalizeRoles(approved[safeEmail]);
      const u=byEmail[safeEmail];
      const email=u?.email||safeEmail.replace(/_/g,'.');
      const name=(u&&(u.firstName||u.lastName))?`${u.firstName||''} ${u.lastName||''}`.trim():'—';
      const isMe=safeEmail===myEmailSafe;
      const neverLoggedIn=!u;
      html+=`<div class="staff-row${u?.disabled?' is-disabled':''}">
        <div class="staff-main">
          <div><b>${escHtml(name)}</b>${isMe?' <span style="font-size:.7rem;color:var(--teal);">(це ви)</span>':''}${neverLoggedIn?' <span style="font-size:.68rem;color:#f39c12;">ще не входив</span>':''}</div>
          <div class="staff-email">${escHtml(email)}</div>
          <div class="staff-roles">${roles.map(r=>`<span class="staff-role-tag">${escHtml(ROLE_LABELS[r]||r)}</span>`).join('')}</div>
        </div>
        <div class="staff-actions">
          <button class="staff-reset" onclick="resetStaffPassword('${escJs(email)}')" title="Надіслати лист для встановлення нового пароля">📧 Скинути пароль</button>
          ${isMe?'':`<button class="staff-del" onclick="removeStaffMember('${escJs(safeEmail)}')">🗑 Видалити</button>`}
        </div>
      </div>`;
    });
    box.innerHTML=html;
  }catch(e){box.innerHTML=`<p style="color:red;font-size:.8rem;">Помилка: ${escHtml(e.message)}</p>`;}
};
// ══════════ ПЕРСОНАЛ: скидання пароля ══════════
// Пароль лежить у Firebase Auth, а не в базі порталу, тому перестворення
// email+ролі його НЕ змінює. Правильний шлях — лист для відновлення.
window.resetStaffPassword=async function(email){
  if(!confirm(`Надіслати на ${email} лист для встановлення нового пароля?\n\nЛюдина перейде за посиланням із листа і задасть новий пароль.\nСтарий пароль перестане діяти.`))return;
  try{
    await sendPasswordReset(email);
    showToast(`📧 Лист надіслано на ${email}`);
  }catch(e){
    alert('Не вдалося надіслати лист: '+(e.message||e.code)+
      '\n\nЯкщо ця адреса не є справжньою поштою, лист не дійде. Тоді пароль\nскидається вручну у Firebase Console → Authentication.');
  }
};
// ══════════ ПЕРСОНАЛ: відкликання доступу ══════════
// ВАЖЛИВО: сам акаунт Firebase Auth з браузера видалити НЕМОЖЛИВО — для цього
// потрібен Admin SDK (серверна функція). Тому "видалення співробітника" тут —
// це повне відкликання доступу: людина зникає зі списків, втрачає роль і всі
// дозволи, а при спробі входу отримує відмову (перевірка disabled у common.js).
// Історичні дані (виставлені нею оцінки, ДЗ) свідомо НЕ видаляються.
// Скільки уроків у ЖИВОМУ розкладі закріплено за цим учителем. Рахуємо лише
// явні призначення (lesson.teacherEmail) — там, де вчитель підставлявся
// автоматично за матрицею доступу, зв'язку в даних немає, про це попереджаємо
// окремим рядком.
async function findTeacherLessons(safeEmail){
  const snap=await get(child(ref(db),'schedules'));
  const result={total:0,byClass:{}};
  if(!snap.exists())return result;
  const all=snap.val();
  for(let cls in all){
    const groups=[all[cls]?.lessons,all[cls]?.clubs];
    groups.forEach(days=>{
      if(!days)return;
      for(let day in days){
        const slots=days[day]||[];
        (Array.isArray(slots)?slots:[slots]).forEach(slot=>{
          const items=Array.isArray(slot)?slot:(slot&&slot.subject?[slot]:[]);
          items.forEach(l=>{
            if(!l||!l.teacherEmail)return;
            if(l.teacherEmail.replace(/\./g,'_')!==safeEmail)return;
            result.total++;
            if(!result.byClass[cls])result.byClass[cls]=new Set();
            result.byClass[cls].add(dayNamesUA[day]||day);
          });
        });
      }
    });
  }
  return result;
}
window.removeStaffMember=async function(safeEmail){
  const readable=safeEmail.replace(/_/g,'.');
  // Попередження про розклад — рахуємо ДО діалогу підтвердження
  let scheduleWarning='';
  try{
    const found=await findTeacherLessons(safeEmail);
    if(found.total>0){
      const lines=Object.keys(found.byClass).sort((a,b)=>getClassNum(a)-getClassNum(b))
        .map(cls=>`   • ${cls.replace('class_','')} клас — ${[...found.byClass[cls]].join(', ')}`);
      scheduleWarning=`\n⚠️ УВАГА: у розкладі за цим учителем закріплено ${found.total} ур.:\n`
        +lines.join('\n')
        +`\n\nУроки залишаться в розкладі, але без учителя — їх треба\nпереназначити вручну через «🗓️ Розклад».\n`;
    }
  }catch(e){console.warn('Не вдалося перевірити розклад:',e.message);}
  if(!confirm(`Видалити співробітника ${readable}?\n${scheduleWarning}\nБуде відкликано:\n• роль і доступ до кабінету\n• доступ до класів і предметів\n• компетенції (скіли)\n\nВиставлені раніше оцінки, ДЗ та коментарі залишаться\nв журналі — вони не прив'язані до вчителя.\n\nПродовжити?`))return;
  try{
    // 1. Прибираємо з дозволених ролей, доступів і скілів
    await Promise.all([
      remove(ref(db,`pre_approved_roles/${safeEmail}`)),
      remove(ref(db,`teacher_access/${safeEmail}`)),
      remove(ref(db,`teacher_skills/${safeEmail}`))
    ]);
    // 2. Позначаємо профіль як відключений (блокує вхід)
    const usersSnap=await get(child(ref(db),'users'));
    if(usersSnap.exists()){
      const users=usersSnap.val();
      for(let uid in users){
        if(users[uid].email&&users[uid].email.replace(/\./g,'_')===safeEmail){
          await update(ref(db,`users/${uid}`),{disabled:true,roles:null,role:null});
        }
      }
    }
    // 3. Знімаємо з посади класного керівника, якщо він ним був
    const ctSnap=await get(child(ref(db),'class_teachers'));
    if(ctSnap.exists()){
      const ct=ctSnap.val();
      for(let cls in ct){
        if(ct[cls]?.teacherEmail&&ct[cls].teacherEmail.replace(/\./g,'_')===safeEmail){
          await remove(ref(db,`class_teachers/${cls}`));
        }
      }
    }
    showToast(scheduleWarning
      ?`🗑️ Доступ відкликано: ${readable}. Не забудьте переназначити його уроки в розкладі!`
      :`🗑️ Доступ відкликано: ${readable}`);
    window.loadStaffList();
    if(typeof window.loadTeachersListForDirector==='function')window.loadTeachersListForDirector();
  }catch(e){alert('Помилка: '+e.message);}
};
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
  stList.forEach(st=>{const g=stats[st].grades;const count=Object.keys(g).length;const avg=calculateStudentWeightedAvg(g,stats[st].types);const disp=avg!==null?displayGrade(String(Math.round(avg)),cls)+' ('+avg.toFixed(2)+')':'-';if(avg!==null){totalAvg+=avg;cnt++;}const gc=avg!==null?gradeClass6(Math.round(avg)):'';h+=`<tr><td style="padding:5px;border-bottom:1px solid #eee;"><b>${escHtml(st)}</b></td><td style="text-align:center;"><span class="g-cell ${gc}" style="display:inline-block;padding:3px 8px;">${disp}</span></td><td style="text-align:center;">${count}</td></tr>`;});
  const ca=cnt>0?(totalAvg/cnt).toFixed(2):'-';h+=`</tbody></table><div style="background:#f4ecf7;border:1px solid #d2b4de;padding:12px;border-radius:8px;text-align:center;margin-top:10px;"><b style="color:var(--purple);">🏆 Середній бал класу:</b><br><span style="font-size:1.5rem;font-weight:800;color:#7b1fa2;">${displayGrade(String(Math.round(parseFloat(ca)||0)),cls)} (${ca})</span></div>`;rd.innerHTML=h;}catch(e){rd.innerHTML=`<p style="color:red;">Помилка: ${e.message}</p>`;}};
// ══════════ DIRECTOR DASHBOARD ══════════
export async function loadDirectorDashboard(){try{const date=document.getElementById('global-date').value;const dp=date.split('-');document.getElementById('d-att-header').innerText=`🚨 Відсутні (${dp[2]}.${dp[1]}, вся школа)`;const wd=getWeekDates(date);let hw=0,com=0,wl=0,wa=0,attHtml='';const[hwS,comS,attS]=await Promise.all([get(child(ref(db),'homeworks')),get(child(ref(db),'comments')),get(child(ref(db),'attendance'))]);const hd=hwS.exists()?hwS.val():{};const cd=comS.exists()?comS.val():{};const ad=attS.exists()?attS.val():{};for(let i=1;i<=11;i++){const c=`class_${i}`;if(hd[c]&&hd[c][date])hw+=Object.keys(hd[c][date]).length;if(cd[c]&&cd[c][date]){for(let s in cd[c][date])if(typeof cd[c][date][s]==='object')com+=Object.keys(cd[c][date][s]).length;}if(ad[c]&&ad[c][date])for(let st in ad[c][date]){const slots=ad[c][date][st];for(let sk in slots){const r=slots[sk];if(r?.status){const bc=r.status==='late'?'badge-late':'badge-absent';const lb=r.status==='late'?'Запізнення':'Відсутність';const markerIcon=r.markedBy==='teacher'?'👨‍🏫':(r.markedBy==='student'?'🎒':'👪');attHtml+=`<li style="margin-bottom:9px;border-bottom:1px solid #eee;padding-bottom:4px;"><span style="font-size:.72rem;background:var(--teal);color:#fff;padding:2px 5px;border-radius:4px;margin-right:4px;">${i} Кл</span> <b>${escHtml(st)}</b> <span class="badge ${bc}">${lb}</span> <span style="font-size:.72rem;color:#888;">${escHtml(formatAttendanceSlotLabel(sk))} ${markerIcon}</span><br><i style="font-size:.78rem;color:#666;">${escHtml(r.reason)}</i></li>`;}}}if(ad[c])wd.forEach(w=>{if(ad[c][w]&&typeof ad[c][w]==='object')Object.values(ad[c][w]).forEach(slots=>{if(slots&&typeof slots==='object')Object.values(slots).forEach(r=>{if(r?.status==='late')wl++;else if(r?.status==='absent')wa++;});});});}document.getElementById('d-hw-counter').innerText=hw;document.getElementById('d-com-counter').innerText=com;document.getElementById('d-week-late').innerText=wl;document.getElementById('d-week-absent').innerText=wa;document.getElementById('d-unified-att-list').innerHTML=attHtml||'<li class="empty-msg">Усі присутні!</li>';}catch(e){console.error(e);}}
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
// Перетворює поточні (можливо ще не збережені) слоти на об'єкт для запису.
// Повертає null, якщо жодного повного слота немає.
function buildBellObject(){
  const obj={};let n=0;
  bellSlotsTemp.forEach(s=>{if(s.start&&s.end){obj[s.number]={number:s.number,start:s.start,end:s.end};n++;}});
  return n>0?obj:null;
}
window.saveBellSchedule=async function(){
  const cls=document.getElementById('bell-class-select').value;
  if(!cls)return alert("Оберіть клас!");
  const obj=buildBellObject();
  if(!obj)return alert("Додайте хоча б один урок із заповненим часом початку і кінця.");
  await set(ref(db,`bell_schedules/${cls}`),obj);
  showToast("✅ Розклад дзвінків збережено!");
  window.loadBellCoverage();
};
// ── Застосувати поточний розклад дзвінків одразу всім 11 класам ──
window.applyBellToAllClasses=async function(){
  const obj=buildBellObject();
  if(!obj)return alert("Спочатку налаштуйте час дзвінків вище (потрібен хоча б один повний урок).");
  const slotCount=Object.keys(obj).length;
  if(!confirm(`Застосувати цей розклад (${slotCount} ур.) до ВСІХ 11 класів?\n\nІснуючий розклад дзвінків усіх класів буде замінено.`))return;
  try{
    // Один апдейт замість 11 окремих записів
    const patch={};
    for(let i=1;i<=11;i++)patch[`class_${i}`]=obj;
    await update(ref(db,'bell_schedules'),patch);
    showToast('✅ Розклад дзвінків застосовано до всіх 11 класів');
    window.loadBellCoverage();
  }catch(e){alert('Помилка: '+e.message);}
};
// ── Хто який розклад має і в кого не вказано ──
window.loadBellCoverage=async function(){
  const box=document.getElementById('bell-coverage');
  if(!box)return;
  box.innerHTML='<p class="empty-msg">Завантаження...</p>';
  try{
    const snap=await get(child(ref(db),'bell_schedules'));
    const data=snap.exists()?snap.val():{};
    const missing=[];let rows='';
    for(let i=1;i<=11;i++){
      const cls=`class_${i}`;
      const d=data[cls];
      const slots=d?Object.keys(d).sort((a,b)=>(parseInt(a)||0)-(parseInt(b)||0)).map(k=>d[k]).filter(s=>s&&s.start&&s.end):[];
      if(slots.length===0){
        missing.push(i);
        rows+=`<div class="bell-row empty"><span class="cls">${i} клас</span><span class="times">не вказано</span></div>`;
      }else{
        const times=slots.map(s=>`${escHtml(s.number)}) ${escHtml(s.start)}–${escHtml(s.end)}`).join(' · ');
        rows+=`<div class="bell-row"><span class="cls">${i} клас</span><span class="times">${times}</span></div>`;
      }
    }
    const head=missing.length>0
      ? `<div class="bell-missing">⚠️ Розклад не вказано: ${missing.join(', ')} клас</div>`
      : `<div style="background:#e8f5e9;border:1px solid #a5d6a7;color:#1b5e20;border-radius:9px;padding:8px 11px;font-size:.8rem;font-weight:700;margin-bottom:8px;">✓ Розклад заповнено в усіх 11 класах</div>`;
    box.innerHTML=head+rows;
  }catch(e){box.innerHTML=`<p style="color:red;font-size:.78rem;">Помилка: ${escHtml(e.message)}</p>`;}
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
// ═══════════════════════════════════════════════════════════════
// CLASS MIGRATION — single-student transfer + end-of-year rollover
// ═══════════════════════════════════════════════════════════════
// DESIGN NOTE (history): grades/attendance/comments/etc. are keyed by class
// (grades/{cls}/{yMonth}/...). Moving a student does NOT rewrite that history —
// records made while they were in class_2 stay under class_2, which is
// historically correct and keeps every past report/journal intact. Only the
// "who is where NOW" pointers move: students_list, users/{uid}.class and the
// parent_links/student_links records that seed those accounts.
//
// Every write below is idempotent-ish and ordered so a partial failure leaves
// the data readable (student may briefly appear in both lists rather than in
// neither).

// Shared: find the students_list key holding a given name in a class.
async function findStudentKey(cls,name){
  const snap=await get(child(ref(db),`students_list/${cls}`));
  if(!snap.exists())return null;
  const d=snap.val();
  for(let k in d)if(d[k]===name)return k;
  return null;
}
// Shared: repoint every account/link that references this student to a new class.
// Returns a list of human-readable changes for the confirmation/result output.
async function repointStudentAccounts(name,fromCls,toCls){
  const changes=[];
  // users/{uid}: the student's own account AND every parent account linked to them
  const us=await get(ref(db,'users'));
  if(us.exists()){
    const u=us.val();
    for(let uid in u){
      if(u[uid].studentName===name&&u[uid].class===fromCls){
        await update(ref(db,`users/${uid}`),{class:toCls});
        changes.push(`${u[uid].role==='parent'?'батьки':'учень'} ${u[uid].email||uid}`);
      }
    }
  }
  // parent_links / student_links keep a class too — they seed users/{uid} on a
  // first login, so a stale class here would silently undo the migration for any
  // parent who hasn't registered yet.
  for(const branch of ['parent_links','student_links']){
    const ls=await get(ref(db,branch));
    if(!ls.exists())continue;
    const l=ls.val();
    for(let se in l){
      const v=l[se];
      if(typeof v==='object'&&v.studentName===name&&v.class===fromCls){
        await update(ref(db,`${branch}/${se}`),{class:toCls});
        changes.push(`${branch==='parent_links'?'прив\'язка батьків':'прив\'язка учня'} ${se.replace(/_/g,'.')}`);
      }
    }
  }
  return changes;
}
// ── Single-student transfer ──
// ══════════ УЧНІ: ведення списків директором ══════════
// Вчитель може додавати учнів лише у «свої» класи (ті, що є в його матриці
// доступу). Директор — у будь-який, тому цей блок продубльовано тут із
// вибором класу замість прив'язки до t-class-selector.
window.loadDirectorStudents=async function(){
  const cls=document.getElementById('ds-class')?.value;
  const box=document.getElementById('ds-list');
  if(!box)return;
  if(!cls){box.innerHTML='<p class="empty-msg">Оберіть клас.</p>';return;}
  box.innerHTML='<p class="empty-msg">Завантаження...</p>';
  try{
    const snap=await get(child(ref(db),`students_list/${cls}`));
    if(!snap.exists()){box.innerHTML='<p class="empty-msg">У цьому класі ще немає учнів.</p>';return;}
    const data=snap.val();
    const rows=Object.keys(data).map(k=>({key:k,name:data[k]})).sort((a,b)=>String(a.name).localeCompare(String(b.name),'uk'));
    let h=`<p style="font-size:.78rem;color:#666;margin:0 0 6px 0;">Усього: <b>${rows.length}</b></p>`;
    rows.forEach((r,i)=>{
      h+=`<div class="ds-row" id="ds-row-${escHtml(r.key)}">
        <span class="ds-num">${i+1}</span>
        <span class="ds-name">${escHtml(r.name)}</span>
        <button class="ds-edit" title="Редагувати ім'я" onclick="directorEditStudent('${escJs(cls)}','${escJs(r.key)}','${escJs(r.name)}')">✏️</button>
        <button class="staff-del" onclick="directorRemoveStudent('${escJs(cls)}','${escJs(r.key)}','${escJs(r.name)}')">🗑</button>
      </div>`;
    });
    box.innerHTML=h;
  }catch(e){box.innerHTML=`<p style="color:red;font-size:.8rem;">Помилка: ${escHtml(e.message)}</p>`;}
};
window.directorAddStudent=async function(){
  const cls=document.getElementById('ds-class').value;
  const name=document.getElementById('ds-new-name').value.trim();
  const emailRaw=document.getElementById('ds-new-email').value.trim().toLowerCase();
  if(!cls)return alert('Спочатку оберіть клас.');
  if(!name)return alert('Введіть прізвище та ім\'я учня.');
  try{
    await push(ref(db,`students_list/${cls}`),name);
    // Email потрібен лише якщо учень заходитиме у портал самостійно
    if(emailRaw)await set(ref(db,`student_links/${emailRaw.replace(/\./g,'_')}`),{studentName:name,class:cls});
    document.getElementById('ds-new-name').value='';
    document.getElementById('ds-new-email').value='';
    showToast(`✅ ${name} доданий до ${cls.replace('class_','')} класу`);
    window.loadDirectorStudents();
  }catch(e){alert('Помилка: '+e.message);}
};
// ══════════ УЧНІ: перейменування ══════════
// ВАЖЛИВО: у базі оцінки, відвідуваність, коментарі тощо зберігаються під
// ІМ'ЯМ учня (grades/{clas}/{місяць}/{предмет}/{дата}/{ІМ'Я}), а не під
// внутрішнім ідентифікатором. Тому просто змінити ім'я у списку не можна —
// вся історія лишиться під старим ключем і зникне з журналу. Нижче ім'я
// переноситься в усіх гілках одночасно.
// Замінює ключ oldK на newK на вказаній глибині вкладеності.
// depth=0 означає, що ключ лежить прямо в цьому вузлі.
function renameKeyAtDepth(node,depth,oldK,newK){
  if(!node||typeof node!=='object')return node;
  if(depth===0){
    if(!(oldK in node))return node;
    const out={...node};
    // Якщо під новим іменем щось уже є — зливаємо, старе не затираємо мовчки
    out[newK]=(newK in out&&typeof out[newK]==='object'&&typeof out[oldK]==='object')
      ?{...out[newK],...out[oldK]}:out[oldK];
    delete out[oldK];
    return out;
  }
  const out={};
  for(const k in node)out[k]=renameKeyAtDepth(node[k],depth-1,oldK,newK);
  return out;
}
// Гілки, де ім'я учня є ключем, із глибиною відносно {branch}/{clas}
const STUDENT_KEYED=[
  ['grades',3],           // {місяць}/{предмет}/{дата}/{ІМ'Я}
  ['grade_types',3],
  ['attendance',1],       // {дата}/{ІМ'Я}
  ['behavior_grades',2],  // {місяць}/{дата}/{ІМ'Я}
  ['stickers',0],         // {ІМ'Я}
  ['comments',2],         // {дата}/{предмет}/{ІМ'Я}
  ['reactions',2],
  ['retake_requests',2]   // {предмет}/{дата}/{ІМ'Я}
];
async function renameStudentEverywhere(cls,oldName,newName){
  const touched=[];
  // 1. Гілки, прив'язані до класу
  for(const [branch,depth] of STUDENT_KEYED){
    const snap=await get(child(ref(db),`${branch}/${cls}`));
    if(!snap.exists())continue;
    const before=snap.val();
    const after=renameKeyAtDepth(before,depth,oldName,newName);
    if(JSON.stringify(before)!==JSON.stringify(after)){
      await set(ref(db,`${branch}/${cls}`),after);
      touched.push(branch);
    }
  }
  // 2. Прив'язки батьків та учня (там ім'я — значення, а не ключ)
  for(const linkBranch of ['parent_links','student_links']){
    const snap=await get(child(ref(db),linkBranch));
    if(!snap.exists())continue;
    const d=snap.val();const patch={};
    for(const k in d){
      const v=d[k];
      if(v&&typeof v==='object'&&v.studentName===oldName&&v.class===cls)patch[`${k}/studentName`]=newName;
    }
    if(Object.keys(patch).length){await update(ref(db,linkBranch),patch);touched.push(linkBranch);}
  }
  // 3. Профілі батьків/учня, які вже заходили в портал
  const uSnap=await get(child(ref(db),'users'));
  if(uSnap.exists()){
    const u=uSnap.val();const patch={};
    for(const uid in u)if(u[uid]?.studentName===oldName&&u[uid]?.class===cls)patch[`${uid}/studentName`]=newName;
    if(Object.keys(patch).length){await update(ref(db,'users'),patch);touched.push('users');}
  }
  // 4. Індивідуальні гуртки в розкладі (ім'я лежить в extraData.student)
  const sSnap=await get(child(ref(db),'schedules'));
  if(sSnap.exists()){
    const all=sSnap.val();let changed=false;
    for(const c in all){
      const days=all[c]?.lessons;if(!days)continue;
      for(const day in days){
        const slots=days[day];if(!Array.isArray(slots))continue;
        slots.forEach(slot=>{
          const items=Array.isArray(slot)?slot:(slot&&slot.subject?[slot]:[]);
          items.forEach(l=>{if(l?.extraData?.student===oldName){l.extraData.student=newName;changed=true;}});
        });
      }
    }
    if(changed){await set(ref(db,'schedules'),all);touched.push('schedules');}
  }
  return touched;
}
window.directorEditStudent=function(cls,key,name){
  const row=document.getElementById(`ds-row-${key}`);
  if(!row)return;
  row.innerHTML=`<input type="text" id="ds-edit-${key}" value="${escHtml(name)}" style="flex:1;margin:0;padding:6px 9px;font-size:.85rem;">
    <button class="ds-ok" onclick="directorSaveStudentName('${escJs(cls)}','${escJs(key)}','${escJs(name)}')">✔</button>
    <button class="staff-del" onclick="loadDirectorStudents()">✖</button>`;
  const inp=document.getElementById(`ds-edit-${key}`);
  if(inp){inp.focus();inp.select();
    inp.addEventListener('keydown',e=>{
      if(e.key==='Enter'){e.preventDefault();window.directorSaveStudentName(cls,key,name);}
      if(e.key==='Escape'){e.preventDefault();window.loadDirectorStudents();}
    });}
};
window.directorSaveStudentName=async function(cls,key,oldName){
  const inp=document.getElementById(`ds-edit-${key}`);
  if(!inp)return;
  const newName=inp.value.trim().replace(/\s+/g,' ');
  if(!newName)return alert("Ім'я не може бути порожнім.");
  if(newName===oldName)return window.loadDirectorStudents();
  // Firebase забороняє ці символи в ключах, а ім'я стає ключем в оцінках
  if(/[.#$[\]/]/.test(newName))return alert('Ім\'я не може містити символи . # $ [ ] /');
  // Перевірка на дубль у цьому ж класі
  const listSnap=await get(child(ref(db),`students_list/${cls}`));
  if(listSnap.exists()){
    const names=Object.entries(listSnap.val());
    if(names.some(([k,v])=>k!==key&&v===newName))
      return alert(`У цьому класі вже є учень «${newName}». Оберіть інше написання.`);
  }
  if(!confirm(`Перейменувати «${oldName}» → «${newName}»?\n\nІм'я буде змінено разом з усією історією: оцінки,\nвідвідуваність, коментарі, поведінка, наліпки, а також\nприв'язки батьків.\n\nПродовжити?`))return;
  const row=document.getElementById(`ds-row-${key}`);
  if(row)row.innerHTML='<span style="font-size:.82rem;color:#888;">⏳ Перейменування та перенесення історії...</span>';
  try{
    await set(ref(db,`students_list/${cls}/${key}`),newName);
    const touched=await renameStudentEverywhere(cls,oldName,newName);
    showToast(touched.length
      ?`✅ Перейменовано. Оновлено: ${touched.length} розд.`
      :'✅ Перейменовано');
    window.loadDirectorStudents();
  }catch(e){alert('Помилка: '+e.message);window.loadDirectorStudents();}
};
window.directorRemoveStudent=async function(cls,key,name){
  if(!confirm(`Прибрати ${name} зі списку ${cls.replace('class_','')} класу?\n\nВиставлені оцінки, відвідуваність і коментарі ЗАЛИШАТЬСЯ в журналі —\nвони зберігаються окремо і не видаляються.\n\nПродовжити?`))return;
  try{
    await remove(ref(db,`students_list/${cls}/${key}`));
    showToast(`🗑️ ${name} прибраний зі списку`);
    window.loadDirectorStudents();
  }catch(e){alert('Помилка: '+e.message);}
};
window.loadTransferClasses=function(){
  const sel=document.getElementById('tr-student');
  if(sel)sel.innerHTML='<option value="">Спочатку клас</option>';
};
window.loadTransferStudents=async function(){
  const cls=document.getElementById('tr-from-class').value;
  const sel=document.getElementById('tr-student');
  if(!cls){sel.innerHTML='<option value="">Спочатку клас</option>';return;}
  sel.innerHTML='<option value="">Завантаження...</option>';
  const snap=await get(child(ref(db),`students_list/${cls}`));
  sel.innerHTML='<option value="">Учень...</option>';
  if(snap.exists())Object.values(snap.val()).sort().forEach(st=>{const o=document.createElement('option');o.value=st;o.innerText=st;sel.appendChild(o);});
  else sel.innerHTML='<option value="" disabled>Учнів немає</option>';
};
window.transferStudent=async function(){
  const fromCls=document.getElementById('tr-from-class').value;
  const toCls=document.getElementById('tr-to-class').value;
  const name=document.getElementById('tr-student').value;
  const out=document.getElementById('tr-result');
  if(!fromCls||!toCls||!name)return alert('Оберіть клас, учня та клас призначення!');
  if(fromCls===toCls)return alert('Класи збігаються — переводити нікуди.');
  if(!confirm(`Перевести ${name} з ${fromCls.replace('class_','')} у ${toCls.replace('class_','')} клас?\n\nОцінки та відвідуваність залишаться в архіві ${fromCls.replace('class_','')} класу.`))return;
  out.innerHTML='<p class="empty-msg">⏳ Переведення...</p>';
  try{
    const key=await findStudentKey(fromCls,name);
    if(!key)throw new Error('Учня не знайдено у списку класу.');
    // Add to the destination first, remove from the source second — if the second
    // write fails the student is duplicated (visible, fixable) rather than lost.
    await push(ref(db,`students_list/${toCls}`),name);
    await remove(ref(db,`students_list/${fromCls}/${key}`));
    const changes=await repointStudentAccounts(name,fromCls,toCls);
    await push(ref(db,'migration_log'),{type:'transfer',student:name,from:fromCls,to:toCls,at:localDateString,by:'director'});
    out.innerHTML=`<div class="data-card" style="border-left-color:var(--green);background:#f0fff4;margin-top:0;"><b style="color:var(--green);">✅ ${escHtml(name)} → ${toCls.replace('class_','')} клас</b><br><span style="font-size:.8rem;color:#666;">Оновлено: ${changes.length?escHtml(changes.join(', ')):'лише список класу (акаунтів ще немає)'}</span></div>`;
    showToast(`✅ ${name} переведено у ${toCls.replace('class_','')} клас`);
    loadTransferStudents();
  }catch(e){out.innerHTML=`<p style="color:red;font-size:.85rem;">Помилка: ${escHtml(e.message)}</p>`;}
};
// ── End-of-year rollover ──
// Preview first (nothing is written), then an explicit typed confirmation.
window.previewYearRollover=async function(){
  const box=document.getElementById('yr-preview');
  box.innerHTML='<p class="empty-msg">⏳ Аналіз...</p>';
  try{
    const snap=await get(ref(db,'students_list'));
    const lists=snap.exists()?snap.val():{};
    let rows='';let total=0;let graduating=0;
    // Show 11 first (graduating), then 10→11 … 1→2
    const grads=lists['class_11']?Object.values(lists['class_11']):[];
    graduating=grads.length;
    if(graduating>0)rows+=`<div style="background:#fdecea;border:1px solid #f5c6cb;border-radius:8px;padding:9px 12px;margin-bottom:6px;font-size:.85rem;"><b style="color:var(--red);">🎓 11 клас → випуск (архів)</b><br><span style="color:#666;">${escHtml(grads.sort().join(', '))}</span></div>`;
    for(let i=10;i>=1;i--){
      const from=`class_${i}`,to=`class_${i+1}`;
      const st=lists[from]?Object.values(lists[from]):[];
      if(st.length===0)continue;
      total+=st.length;
      rows+=`<div style="background:#fff;border:1px solid #e0e0e0;border-radius:8px;padding:9px 12px;margin-bottom:6px;font-size:.85rem;"><b>${i} клас → ${i+1} клас</b> <span style="color:#888;">(${st.length})</span><br><span style="color:#666;">${escHtml(st.sort().join(', '))}</span></div>`;
    }
    if(!rows){box.innerHTML='<p class="empty-msg">Немає учнів для переведення.</p>';return;}
    box.innerHTML=`<div style="max-height:280px;overflow-y:auto;margin-bottom:10px;">${rows}</div>
      <div style="background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:10px 12px;font-size:.83rem;color:#856404;">
        Буде переведено <b>${total}</b> учнів, випущено <b>${graduating}</b>.<br>
        Для підтвердження введіть слово <b>ПЕРЕВЕСТИ</b>:
      </div>
      <div style="display:flex;gap:7px;margin-top:8px;">
        <input type="text" id="yr-confirm-input" placeholder="ПЕРЕВЕСТИ" style="flex:2;margin-top:0;text-align:center;font-weight:800;letter-spacing:1px;">
        <button onclick="runYearRollover()" style="flex:1;margin-top:0;background:var(--red);color:#fff;">🎓 Виконати</button>
      </div>
      <div id="yr-result" style="margin-top:10px;"></div>`;
  }catch(e){box.innerHTML=`<p style="color:red;font-size:.85rem;">Помилка: ${escHtml(e.message)}</p>`;}
};
window.runYearRollover=async function(){
  const input=document.getElementById('yr-confirm-input');
  const out=document.getElementById('yr-result');
  if(!input||input.value.trim().toUpperCase()!=='ПЕРЕВЕСТИ')return alert('Введіть слово ПЕРЕВЕСТИ для підтвердження.');
  out.innerHTML='<p class="empty-msg">⏳ Виконується переведення...</p>';
  try{
    const snap=await get(ref(db,'students_list'));
    const lists=snap.exists()?snap.val():{};
    const year=(document.getElementById('global-date').value||localDateString).split('-')[0];
    let moved=0,graduated=0;
    // 1) Graduate class 11 FIRST — otherwise the 10→11 step would merge into it.
    if(lists['class_11']){
      const grads=Object.values(lists['class_11']);
      for(const name of grads){
        await push(ref(db,`graduates/${year}`),{name,graduatedFrom:'class_11',at:localDateString});
        // Mark accounts inactive rather than deleting them: history stays
        // attributable, and a graduate can't log in to a class they left.
        const us=await get(ref(db,'users'));
        if(us.exists()){const u=us.val();for(let uid in u)if(u[uid].studentName===name&&u[uid].class==='class_11')await update(ref(db,`users/${uid}`),{class:null,graduated:true,graduatedYear:year});}
        graduated++;
      }
      await remove(ref(db,'students_list/class_11'));
    }
    // 2) Walk DOWNWARD (10→11, 9→10 … 1→2). Order matters: going upward would
    //    move class_1 into class_2 and then move those same students again.
    for(let i=10;i>=1;i--){
      const from=`class_${i}`,to=`class_${i+1}`;
      if(!lists[from])continue;
      const names=Object.values(lists[from]);
      for(const name of names){
        await push(ref(db,`students_list/${to}`),name);
        await repointStudentAccounts(name,from,to);
        moved++;
      }
      await remove(ref(db,`students_list/${from}`));
    }
    await push(ref(db,'migration_log'),{type:'year_rollover',year,moved,graduated,at:localDateString,by:'director'});
    out.innerHTML=`<div class="data-card" style="border-left-color:var(--green);background:#f0fff4;margin-top:0;"><b style="color:var(--green);">✅ Переведення завершено</b><br><span style="font-size:.85rem;color:#555;">Переведено: <b>${moved}</b> · Випущено: <b>${graduated}</b></span><br><span style="font-size:.78rem;color:#888;">Оцінки та відвідуваність залишились в архіві своїх класів. Не забудьте перепризначити класних керівників.</span></div>`;
    showToast(`✅ Переведено ${moved} учнів, випущено ${graduated}`);
  }catch(e){out.innerHTML=`<p style="color:red;font-size:.85rem;">Помилка: ${escHtml(e.message)}</p>`;}
};
