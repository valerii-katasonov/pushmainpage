// ═══════════════════════════════════════════════════════════════
// journal.js — Grade editor popup, Journal modal + table rendering,
// and the Visual (schedule) Matrix modal used for both the live
// schedule and director's drafts.
// ═══════════════════════════════════════════════════════════════
import { ref, set, get, child, update } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { loadGradeWork, prepareGradeWork, setGradeWorkBusy, hasGradeWorkChanges } from './grade-work.js';
import { ACTIVE_YEAR } from './director.js';
import { topicNames } from './parent-student.js';
import { db, getActiveClass, currentUserData, displayGrade, gradeClass6, calculateStudentWeightedAvg, validDailyGrade, getClassNum, LEVEL_MAX_CLASS, GRADE_WEIGHTS, dayKeys, dayNamesUA, showToast, normalizeTimeRange, localDateString, summarizeAttendanceSlots, attendanceForLesson, gradeTypesCache, escJs, escHtml, notifyEvent, logAction, getUserRoles, getUsersSnap, stuName, gradeWritePaths, journalGradeKey, journalBaseDate, journalSlot, expandAltSubjects, altOptions, splitAltName, altPairKey, mondayOf, isBreakItem, insertSlot, removeSlot, makeBreak, withBreaks, slotBounds, hhmmFromMins, emailKey, subjKey, planKeyWith, getDateRange, openTabByKey, fetchSubjectTeachers } from './common.js';

// globalTeacherAccess is reassigned only in this file (openVisualMatrixModal)
// and read from common.js (window.getDefaultTeacher) — plain export/import.
export let globalTeacherAccess={};
// globalAllSchedules / globalAllStudents / currentMatrixMode / draftWarningsCache
// are only ever used within this file's Visual Matrix functions.
let globalAllSchedules={};
let globalAllStudents={};
let currentMatrixMode='live';
let draftWarningsCache=[];
// ── ПОГОДЖЕНІ НАКЛАДКИ ──────────────────────────────────────────
//
// Накладка не завжди помилка. Той самий учитель справді буває одночасно
// в кількох класах: повіз усіх на басейн, веде об'єднану групу, супроводжує
// поїздку. Портал цього не знає й знати не може — а список щоразу той
// самий, і серед звичних червоних рядків губиться справжня помилка.
//
// Тому директор може сказати «так і має бути». Погоджене не зникає
// назовсім: воно згортається в рядок, який розгортається назад і де
// погодження можна зняти. Попередження, що просто зникло, потім нічим
// не перевірити й не пригадати, чому його немає.
//
// Живуть погодження в тій чернетці, до якої належать. Чернетка — це
// окремий розклад; переносити погодження між ними означало б мовчки
// сказати «і тут ця накладка нормальна», чого ніхто не казав.
let warnOk = {};
// globalTeachersList is written to both from here and from director.js
// (loadTeachersListForDirector), so it stays on window (see common.js note).
window.globalTeachersList = window.globalTeachersList || [];

let journalMode='view'; let journalIsTeacher=false;
let gradeSaving=false;
let gepCls=''; let gepSubj=''; let gepDate=''; let gepStudent=''; let gepType='П'; let gepCellEl=null; let gepYMonth='';
let journalScaleMax=6,journalNumericScale=false,journalRenderSeq=0,semesterRenderSeq=0,journalVisibleColumns=[];
let journalColumnBusy=false;
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
    // data-tip замість title: нативну підказку браузер показує приблизно
    // через секунду, і цю затримку не змінити ні CSS, ні скриптом. Учитель
    // же водить мишею по десятку кнопок поспіль, і кожна відповідає з
    // паузою — виглядає як гальмування порталу. Своя підказка з'являється
    // одразу (див. [data-tip] у cabinet.html).
    return `<button type="button" class="type-btn" data-type="${code}" data-tip="${escHtml(label)}" onclick="selectGradeType('${code}')">${shortLabel}</button>`;
  }).join('');
}
// Phase 4b: added presetType param — when a cell has no existing grade_type yet (new grade),
// the editor now prefills from the date column's pre-set "Тип" (journal_column_types) instead
// of always defaulting to 'П'.
// Кнопки рівнів для 1–5 класів.
//
// НАВІЩО. Учитель писав рівень у те саме поле, куди старші класи пишуть
// цифру. Літера туди лягала, але далі її ніхто не чекав: у журналі кожен
// рівень показувався як «П». А ще в клітинці поруч стоїть ВИД роботи, і
// його код теж «П» — поточна. Дві різні «П» в одній клітинці.
//
// Кнопки прибирають і те, й інше: рівень обирається, а не набирається, і
// поруч підписано, що це саме рівень.
const LEVELS = [
  { v:'П', label:'Початковий' },
  { v:'С', label:'Середній' },
  { v:'Д', label:'Достатній' },
  { v:'В', label:'Високий' }
];
function renderLevelButtons(cls, current){
  const box = document.getElementById('gep-level-btns');
  const input = document.getElementById('gep-value');
  const hint = document.getElementById('gep-type-hint');
  if(!box) return;
  const junior = getClassNum(cls) <= LEVEL_MAX_CLASS;
  box.style.display = junior ? 'flex' : 'none';
  if(input) input.style.display = junior ? 'none' : 'block';
  if(hint) hint.style.display = junior ? 'block' : 'none';
  if(!junior){ box.innerHTML=''; return; }
  const cur = String(current||'').trim().toUpperCase();
  box.innerHTML = '<div class="gep-hint">Рівень:</div>' + LEVELS.map(L =>
    `<button type="button" class="level-btn${L.v===cur?' active':''}" data-lv="${L.v}"
       data-tip="${escHtml(L.label)}" onclick="selectGradeLevel('${L.v}')">${L.v}</button>`).join('');
}
window.selectGradeLevel = function(v){
  const input = document.getElementById('gep-value');
  if(input) input.value = v;
  document.querySelectorAll('#gep-level-btns .level-btn')
    .forEach(b => b.classList.toggle('active', b.dataset.lv === v));
};
function gradeModifiersAllowed(cls){
  return journalScaleMax===6&&getClassNum(cls)>LEVEL_MAX_CLASS;
}
function syncGradeModifierButtons(){
  const value=document.getElementById('gep-value')?.value.trim().replace('−','-')||'';
  document.querySelectorAll('#gep-modifiers button').forEach(btn=>
    btn.classList.toggle('active',value.endsWith(btn.dataset.mod)));
}
window.setGradeModifier=function(mod){
  if(!gradeModifiersAllowed(gepCls))return;
  const input=document.getElementById('gep-value');
  const match=/^([1-6])([+\-−])?$/.exec(input.value.trim());
  if(!match)return showToast('⚠️ Спершу введіть бал від 1 до 6.');
  const old=match[2]==='−'?'-':match[2];
  input.value=match[1]+(old===mod?'':mod);
  syncGradeModifierButtons();input.focus();
};

function openGradeEditor(cls,subj,dateStr,student,yMonth,cellEl,existingVal,existingType,presetType){
  if(gradeSaving)return;
  loadGradeWork(cls,student,yMonth,subj,dateStr);
  gepCls=cls;gepSubj=subj;gepDate=dateStr;gepStudent=student;gepYMonth=yMonth;gepCellEl=cellEl;gepType=existingType||presetType||'П';
  document.getElementById('gep-label').textContent=`${stuName(cls,student)} | ${subj} | ${journalBaseDate(dateStr).split('-').reverse().join('.')} · стовпець ${journalSlot(dateStr)}`;
  document.getElementById('gep-value').value=existingVal||'';
  document.getElementById('gep-value').placeholder=gradeModifiersAllowed(cls)?'1–6, напр. 5+':`1–${journalScaleMax}`;
  renderLevelButtons(cls, existingVal);
  document.getElementById('gep-modifiers').style.display=gradeModifiersAllowed(cls)?'flex':'none';
  syncGradeModifierButtons();
  renderGradeTypeButtons();
  selectGradeType(gepType);
  const popup=document.getElementById('grade-editor-popup');popup.style.display='block';
  const rect=cellEl.getBoundingClientRect();
  const height=popup.offsetHeight,width=popup.offsetWidth;
  let top=rect.bottom+6,left=rect.left;
  if(top+height>window.innerHeight)top=rect.top-height-6;
  top=Math.max(10,Math.min(top,window.innerHeight-height-10));
  left=Math.max(10,Math.min(left,window.innerWidth-width-10));
  popup.style.top=top+'px';popup.style.left=left+'px';
  setTimeout(()=>document.getElementById('gep-value').focus(),50);
}
window.closeGradeEditor=function(){if(gradeSaving)return;document.getElementById('grade-editor-popup').style.display='none';gepCellEl=null;};
window.confirmGrade=async function(){
  if(gradeSaving)return;
  let val=document.getElementById('gep-value').value.trim().replace('−','-');
  if(!val){
    if(hasGradeWorkChanges())return showToast('⚠️ Спершу вкажіть оцінку. Фото роботи не зберігаються без оцінки.');
    return window.deleteGrade();
  }
  // Рівень зберігаємо великою літерою: інакше в базі опиняться і «в», і «В»,
  // і будь-яке порівняння почне брехати
  const up=val.toUpperCase();
  if(getClassNum(gepCls)<=LEVEL_MAX_CLASS){
    if(!LEVELS.some(level=>level.v===up))return showToast('⚠️ Оберіть рівень: П, С, Д або В.');
    val=up;
  }else if(!validDailyGrade(val,journalScaleMax)||(/[+\-]$/.test(val)&&!gradeModifiersAllowed(gepCls))){
    showToast(gradeModifiersAllowed(gepCls)
      ? '⚠️ Оцінка: від 1 до 6; можна додати + або −.'
      : `⚠️ Оцінка має бути цілим числом від 1 до ${journalScaleMax}!`);return;
  }
  // Основа і дзеркало — одним атомарним записом.
  // Під try: якщо запис не пройде, вікно не має закриватися з бадьорим
  // «✅» — учитель піде далі, певний, що оцінка стоїть, а її немає.
  gradeSaving=true;setGradeWorkBusy(true);
  const save=document.getElementById('gep-save');if(save){save.disabled=true;save.textContent='⏳ Збереження...';}
  try{
    const workPhotos=await prepareGradeWork();
    const paths=gradeWritePaths(gepCls,gepYMonth,gepSubj,gepDate,gepStudent,val,gepType);
    // Незмінені вкладення не перезаписуємо: інший учитель міг додати
    // фото після відкриття цього вікна.
    if(workPhotos!==undefined)paths[`student_grades/${gepCls}/${gepStudent}/${gepYMonth}/${gepSubj}/${gepDate}/workPhotos`]=workPhotos;
    await update(ref(db),paths);
  }catch(e){
    console.error('Виставлення оцінки:',e);
    showToast(/permission[_ ]denied/i.test(e.message||'')
      ? '⛔ Немає прав виставляти оцінку в цьому класі'
      : '❌ Оцінку не збережено: '+(e.message||''));
    return;
  }finally{gradeSaving=false;setGradeWorkBusy(false);if(save){save.disabled=false;save.textContent='✔ Зберегти';}}
  closeGradeEditor();renderJournalTable();showToast(`✅ ${stuName(gepCls,gepStudent)}: ${displayGrade(val,gepCls,journalNumericScale)} (${gepType})`);
  // Сповіщаємо батьків/учня. Оцінку показуємо у вигляді, який бачить сім'я
  // (для 1-5 класів — літерою, а не цифрою).
  notifyEvent('grade',{class:gepCls,studentName:stuName(gepCls,gepStudent),subject:gepSubj,value:displayGrade(val,gepCls,journalNumericScale)});
  logAction('grade_set',{cls:gepCls,target:stuName(gepCls,gepStudent),subject:gepSubj,date:gepDate,value:val,gtype:gepType});
};
window.deleteGrade=async function(){
  if(gradeSaving)return;
  gradeSaving=true;setGradeWorkBusy(true);
  try{
    await update(ref(db), gradeWritePaths(gepCls,gepYMonth,gepSubj,gepDate,gepStudent,null,null));
  }catch(e){
    console.error('Видалення оцінки:',e);
    showToast('❌ Не видалено: '+(e.message||''));
    return;
  }finally{gradeSaving=false;setGradeWorkBusy(false);}
  closeGradeEditor();renderJournalTable();showToast('🗑️ Оцінку видалено');
  logAction('grade_del',{cls:gepCls,target:stuName(gepCls,gepStudent),subject:gepSubj,date:gepDate});
};
document.getElementById('gep-value').addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();window.confirmGrade();}if(e.key==='Escape'){e.preventDefault();window.closeGradeEditor();}});
document.getElementById('gep-value').addEventListener('input',syncGradeModifierButtons);
document.addEventListener('click',function(e){const p=document.getElementById('grade-editor-popup');if(p.style.display==='block'&&!p.contains(e.target)&&!e.target.closest('.g-cell'))closeGradeEditor();});
// ══════════════════════════════════════════════════════════════════
//  ПІДСУМКОВІ (СЕМЕСТРОВІ) ОЦІНКИ
// ══════════════════════════════════════════════════════════════════
// Система рахує середньозважений бал за період семестру і ПРОПОНУЄ оцінку,
// але останнє слово завжди за вчителем: пропозицію видно окремо від
// підсумкової, і будь-яку правку видно в журналі дій.
// Зберігаємо і те, що запропонувала система, і те, що поставив учитель —
// інакше потім не розібрати, чи оцінку змінювали вручну.
// semester_grades/{cls}/{semId}/{subject}/{ключ учня} = {value, auto, by, ts}
let semCache={};
window.openSemesterGrades=async function(){
  try{
  const cls=document.getElementById('j-class-select').value;
  const subj=document.getElementById('j-subj-select').value;
  if(!cls||!subj)return showToast('⚠️ Спочатку оберіть клас і предмет');
  document.getElementById('sem-class').textContent=cls.replace('class_','')+' клас';
  document.getElementById('sem-subject').textContent=subj;
  const sel=document.getElementById('sem-period');
  sel.innerHTML='<option value="">Завантаження...</option>';
  document.getElementById('semester-modal').style.display='flex';
  const snap=await get(child(ref(db),`academic_year/${ACTIVE_YEAR}/semesters`));
  semCache=snap.exists()?snap.val():{};
  const ids=Object.keys(semCache);
  sel.innerHTML=ids.length
    ? ids.map(id=>`<option value="${escHtml(id)}">${escHtml(semCache[id].name||id)}</option>`).join('')
    : '<option value="">Семестри не задані</option>';
  if(ids.length===0){
    document.getElementById('sem-body').innerHTML=
      '<p class="empty-msg">Директор ще не створив семестри — розділ «Навчальний рік».</p>';
    return;
  }
  window.renderSemesterTable();
  }catch(err){
    // Читання не вдалося. Без цього блоку на екрані назавжди лишався б
    // напис-заглушка, і людина не знала б, зламалося чи просто повільно.
    console.error("journal.js → sem-period", err);
    const _b=document.getElementById("sem-period");
    if(_b)_b.innerHTML='<option value="">Не вдалося завантажити</option>';
  }
};
window.closeSemesterGrades=function(){document.getElementById('semester-modal').style.display='none';};
// Місяці «yyyy-MM», що потрапляють у діапазон семестру
function monthsBetween(a,b){
  const out=[];let [y,m]=a.split('-').map(Number);
  const [ey,em]=b.split('-').map(Number);
  while(y<ey||(y===ey&&m<=em)){out.push(`${y}-${String(m).padStart(2,'0')}`);m++;if(m>12){m=1;y++;}}
  return out;
}
window.renderSemesterTable=async function(){
  const request=++semesterRenderSeq;
  const cls=document.getElementById('j-class-select').value;
  const subj=document.getElementById('j-subj-select').value;
  const semId=document.getElementById('sem-period').value;
  const box=document.getElementById('sem-body');
  if(!semId)return;
  const sem=semCache[semId]||{};
  if(!sem.startDate||!sem.endDate){box.innerHTML='<p class="empty-msg">У семестру не вказані дати.</p>';return;}
  box.innerHTML='<p class="empty-msg">Обчислення...</p>';
  try{
    const months=monthsBetween(sem.startDate.slice(0,7),sem.endDate.slice(0,7));
    const [stSnap,savedSnap,scaleSnap,...monthSnaps]=await Promise.all([
      get(child(ref(db),`students_list/${cls}`)),
      get(child(ref(db),`semester_grades/${cls}/${semId}/${subj}`)),
      get(child(ref(db),`grade_scales/${cls}/${subj}`)).catch(()=>null),
      ...months.flatMap(ym=>[
        get(child(ref(db),`grades/${cls}/${ym}/${subj}`)),
        get(child(ref(db),`grade_types/${cls}/${ym}/${subj}`))
      ])
    ]);
    if(request!==semesterRenderSeq)return;
    const junior=getClassNum(cls)<=LEVEL_MAX_CLASS;
    const numericScale=!junior&&!!scaleSnap?.exists();
    const configuredMax=numericScale?Number(scaleSnap.val().max||scaleSnap.val()):6;
    const scaleMax=Number.isInteger(configuredMax)&&configuredMax>=2&&configuredMax<=2000?configuredMax:6;
    box.dataset.scaleMax=String(scaleMax);
    box.dataset.junior=junior?'1':'0';
    const students=stSnap.exists()
      ?Object.entries(stSnap.val()).map(([sid,nm])=>({sid,nm:String(nm)}))
        .sort((a,b)=>a.nm.localeCompare(b.nm,'uk')):[];
    if(students.length===0){box.innerHTML='<p class="empty-msg">У класі немає учнів.</p>';return;}
    const saved=savedSnap.exists()?savedSnap.val():{};
    // Збираємо всі оцінки учня за період (дати поза межами семестру відкидаємо)
    const per={};students.forEach(s=>per[s.sid]={g:{},t:{}});
    for(let i=0;i<months.length;i++){
      const gSnap=monthSnaps[i*2], tSnap=monthSnaps[i*2+1];
      if(!gSnap.exists())continue;
      const gd=gSnap.val(), td=tSnap.exists()?tSnap.val():{};
      for(const date in gd){
        if(journalBaseDate(date)<sem.startDate||journalBaseDate(date)>sem.endDate)continue;
        for(const st in gd[date]){
          if(!per[st])continue;
          per[st].g[date]=gd[date][st];
          if(td[date]&&td[date][st])per[st].t[date]=td[date][st];
        }
      }
    }
    let rows='';let filled=0;
    students.forEach(st=>{
      const eligible=junior?Object.fromEntries(Object.entries(per[st.sid].g).filter(([,value])=>!(Number(value)>6))):per[st.sid].g;
      const avg=calculateStudentWeightedAvg(eligible,per[st.sid].t);
      const cnt=Object.keys(per[st.sid].g).length;
      // Старі бали понад 6 не переводимо у рівень навмання: для них
      // учитель обирає підсумкову літеру самостійно.
      const auto=avg!==null&&(!junior||avg<=6)?String(Math.min(scaleMax,Math.max(1,Math.round(avg)))):'';
      const suggested=auto?displayGrade(auto,cls,numericScale):'';
      const cur=saved[st.sid]?String(saved[st.sid].value):'';
      const choice=cur?(junior?displayGrade(cur,cls,false):cur):suggested;
      const legacy=junior&&cur&&!LEVELS.some(level=>level.v===choice);
      const gradeInput=junior
        ? `<select class="sem-in" id="sem-${escHtml(st.sid)}" data-auto="${escHtml(suggested)}" data-original="${escHtml(cur)}" data-initial="${escHtml(choice)}" data-sid="${escHtml(st.sid)}" data-name="${escHtml(st.nm)}">
             <option value="">—</option>
             ${legacy?`<option value="${escHtml(cur)}" selected>${escHtml(cur)} (збережено раніше)</option>`:''}
             ${LEVELS.map(level=>`<option value="${level.v}" ${choice===level.v?'selected':''}>${level.v} — ${level.label}</option>`).join('')}
           </select>`
        : `<input type="text" class="sem-in" id="sem-${escHtml(st.sid)}" value="${escHtml(choice)}"
             data-auto="${escHtml(auto)}" data-sid="${escHtml(st.sid)}" data-name="${escHtml(st.nm)}" maxlength="${String(scaleMax).length}">`;
      if(cur)filled++;
      const changed=saved[st.sid]&&saved[st.sid].auto&&String(saved[st.sid].auto)!==String(saved[st.sid].value);
      rows+=`<tr>
        <td class="sem-name">${escHtml(st.nm)}</td>
        <td class="sem-avg">${avg!==null?avg.toFixed(2):'—'}<br><span class="sem-cnt">${cnt} оц.</span></td>
        <td class="sem-auto">${suggested?escHtml(suggested):'—'}</td>
        <td>${gradeInput}</td>
        <td class="sem-flag">${changed?'<span data-tip="Відрізняється від запропонованої">✎</span>':''}</td>
      </tr>`;
    });
    box.innerHTML=`<p class="sem-info">Період: ${escHtml(sem.startDate.split('-').reverse().join('.'))} — ${escHtml(sem.endDate.split('-').reverse().join('.'))} · виставлено: <b>${filled} з ${students.length}</b></p>
      <div class="sem-wrap"><table class="sem-table">
        <thead><tr><th>Учень</th><th>Серед.<br>зваж.</th><th>Пропо-<br>новано</th><th>Підсум-<br>кова</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
  }catch(e){if(request===semesterRenderSeq)box.innerHTML=`<p style="color:red;font-size:.8rem;">Помилка: ${escHtml(e.message)}</p>`;}
};
window.saveSemesterGrades=async function(){
  const cls=document.getElementById('j-class-select').value;
  const subj=document.getElementById('j-subj-select').value;
  const semId=document.getElementById('sem-period').value;
  if(!semId)return;
  const semBody=document.getElementById('sem-body');
  const scaleMax=Number(semBody.dataset.scaleMax||6);
  const junior=getClassNum(cls)<=LEVEL_MAX_CLASS;
  const inputs=Array.from(document.querySelectorAll('.sem-in'));
  if(!inputs.length)return showToast('⚠️ Дочекайтеся завантаження оцінок');
  const bad=inputs.find(i=>{
    const value=i.value.trim();
    if(!value)return false;
    if(junior)return !LEVELS.some(level=>level.v===value)&&!(i.dataset.original===value&&i.dataset.initial===value);
    return !/^[1-9]\d*$/.test(value)||Number(value)>scaleMax;
  });
  if(bad)return alert(junior?'Оберіть підсумковий рівень: П, С, Д або В.':`Оцінка «${bad.value}» некоректна. Допустимі значення — від 1 до ${scaleMax}.`);
  const btn=document.getElementById('btn-sem-save');
  btn.disabled=true;btn.textContent='⏳ Збереження...';
  try{
    const patch={};let n=0,manual=0;
    inputs.forEach(i=>{
      let v=i.value.trim();const sid=i.dataset.sid, auto=i.dataset.auto||'';
      if(junior&&i.dataset.original&&v===i.dataset.initial)v=i.dataset.original;
      if(!v){patch[sid]=null;return;}
      patch[sid]={value:v,auto,by:currentUserData?.email||'',ts:Date.now()};
      n++;if(auto&&auto!==v)manual++;
    });
    await update(ref(db,`semester_grades/${cls}/${semId}/${subj}`),patch);
    logAction('semester_grade',{cls,subject:subj,value:`${semCache[semId]?.name||semId}: ${n} оц.`+(manual?`, змінено вручну: ${manual}`:'')});
    showToast(`✅ Підсумкові збережено (${n})`);
    window.renderSemesterTable();
  }catch(e){alert('Помилка: '+e.message);}
  finally{btn.disabled=false;btn.textContent='💾 Зберегти підсумкові';}
};
// Кнопка «підставити запропоновані всім, у кого поле порожнє»
window.semesterFillAuto=function(){
  let n=0;
  document.querySelectorAll('.sem-in').forEach(i=>{
    if(!i.value.trim()&&i.dataset.auto){i.value=i.dataset.auto;n++;}
  });
  showToast(n?`Підставлено: ${n}`:'Порожніх немає');
};
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
    return `<span style="display:inline-block;background:var(--surface-2);border:1px solid var(--line-soft);border-radius:var(--badge-radius);padding:2px 8px;margin:2px 4px 2px 0;font-size:var(--text-xs);color:var(--ink-2);"><b style="color:var(--ink);">${code}</b> ${label} ×${w}</span>`;
  }).join('');
}
window.openJournalModal=function(role){
  journalIsTeacher=(role==='teacher');journalMode=journalIsTeacher?'edit':'view';
  document.getElementById('journal-modal').style.display='flex';
  journalZoomIsAuto=true;journalZoomLevel=100;applyJournalZoom();
  renderGradeTypesLegend();
  const dp=document.getElementById('global-date').value.split('-');const curYM=`${dp[0]}-${dp[1]}`;
  const firstYM=`${ACTIVE_YEAR.split('-')[0]}-09`;
  document.getElementById('j-month-from').value=firstYM<=curYM?firstYM:curYM;
  document.getElementById('j-month-to').value=curYM;
  document.getElementById('j-scale-controls').style.display=journalIsTeacher&&getClassNum(getActiveClass())>LEVEL_MAX_CLASS?'flex':'none';
  const cs=document.getElementById('j-class-select');const cf=document.getElementById('j-class-field');const mw=document.getElementById('j-mode-toggle-wrap');
  mw.style.display=journalIsTeacher?'flex':'none';
  document.getElementById('j-edit-hint').style.display=journalIsTeacher&&journalMode==='edit'?'block':'none';
  if(journalIsTeacher){document.getElementById('j-mode-view').classList.toggle('active',journalMode==='view');document.getElementById('j-mode-edit').classList.toggle('active',journalMode==='edit');}
  // Toggle the whole label+select field (#j-class-field), not just the <select> —
  // otherwise non-directors were left with a "Клас" label floating over nothing.
  // director AND administrator both browse any class (the administrator/secretary
  // in strictly read-only mode: journalIsTeacher stays false, so setJournalMode's
  // edit branch and every handleGradeClick are inert for them).
  if(role==='director'||role==='administrator'){cf.style.display='block';cs.innerHTML='<option value="">Оберіть клас...</option>';for(let i=1;i<=11;i++)cs.innerHTML+=`<option value="class_${i}">${i} Клас</option>`;document.getElementById('j-subj-select').innerHTML='<option value="">Спочатку клас</option>';document.getElementById('journal-table-el').innerHTML='';}
  else{cf.style.display='none';cs.innerHTML=`<option value="${getActiveClass()}">${getActiveClass()}</option>`;updateJournalSubjects();}
};
window.closeJournalModal=function(){
  const modal=document.getElementById('journal-modal');
  modal.style.display='none';modal.classList.remove('journal-fullscreen');
  const btn=document.getElementById('j-fullscreen');if(btn)btn.textContent='⛶ На весь екран';
};
window.openJournalForGrading=function(){
  openJournalModal('teacher');const subj=document.getElementById('t-subject').value;
  setTimeout(()=>{const s=document.getElementById('j-subj-select');if(subj&&Array.from(s.options).some(o=>o.value===subj))s.value=subj;renderJournalTable();},300);
};
window.updateJournalSubjects=function(){
  try{
  const cls=document.getElementById('j-class-select').value;const ss=document.getElementById('j-subj-select');
  if(!cls){ss.innerHTML='<option value="">Спочатку клас</option>';return;}
  ss.innerHTML='<option value="">Завантаження...</option>';
  window.loadScheduleScript(cls,()=>{
    let unique=new Set();if(window.schedule)dayKeys.forEach(d=>window.getTodayLessonsFlattened(d).forEach(i=>expandAltSubjects(i).forEach(s=>unique.add(s))));
    if(unique.size===0){get(child(ref(db),`grades/${cls}`)).then(snap=>{if(snap.exists()){const md=snap.val();for(let m in md)for(let s in md[m])unique.add(s);}finishJournalSubjectsRender(unique,cls,ss);});return;}
    finishJournalSubjectsRender(unique,cls,ss);
  });
  }catch(err){
    // Читання не вдалося. Без цього блоку на екрані назавжди лишався б
    // напис-заглушка, і людина не знала б, зламалося чи просто повільно.
    console.error("journal.js → j-subj-select", err);
    const _b=document.getElementById("j-subj-select");
    if(_b)_b.innerHTML='<option value="">Не вдалося завантажити</option>';
  }
};
function finishJournalSubjectsRender(unique,cls,ss){
  if(currentUserData.role==='teacher'||currentUserData.role==='art_school_teacher')unique=new Set([...unique].filter(s=>window.isSubjectAllowed(cls,s)));
  ss.innerHTML='<option value="">-- Предмет --</option>';
  if(unique.size>0)[...unique].sort().forEach(s=>ss.innerHTML+=`<option value="${escHtml(s)}">${escHtml(s)}</option>`);
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
// Кожен запис предмета в розкладі — окремий урок, включно з двома
// уроками в один день. Порожні слоти й перерви не рахуються.
// НОМЕРИ УРОКІВ ЦЬОГО ПРЕДМЕТА В ЦЕЙ ДЕНЬ — у тому ж порядку, що й
// стовпці журналу. Потрібні, щоб зіставити стовпець із відміткою
// відвідуваності: та зберігається за НОМЕРОМ УРОКУ в розкладі, а стовпці
// журналу нумеруються окремо («перший урок цього предмета, другий...»).
// Дві різні нумерації — і саме через їх плутанину «Н» не потрапляла в
// потрібну клітинку.
//
// Порожній рядок означає «номера немає»: у такому розкладі зіставляти
// нема з чим, і тоді в стовпці лишиться тільки відмітка за весь день.
export function scheduledSubjectLessons(schedule,dayName,subject,weekChoices={}){
  const raw=schedule?.[dayName]||{};
  const slots=Array.isArray(raw)?raw:Object.values(raw);
  const keys=[];
  slots.forEach((slot,slotIdx)=>{
    const lessons=Array.isArray(slot)?slot:(slot&&(slot.subject||slot.alt)?[slot]:[]);
    lessons.forEach(lesson=>{
      const options=altOptions(lesson);
      const selected=options&&(weekChoices?.pairs?.[altPairKey(options)]
        ||weekChoices?.[dayName]?.[slotIdx]
        ||weekChoices?.[dayName]?.[String(slotIdx)]);
      const subjects=options&&options.includes(selected)?[selected]:expandAltSubjects(lesson);
      if(subjects.includes(subject))keys.push(String(lesson&&lesson.number||''));
    });
  });
  return keys;
}
export function scheduledSubjectCount(schedule,dayName,subject,weekChoices={}){
  return scheduledSubjectLessons(schedule,dayName,subject,weekChoices).length;
}
export function buildJournalColumns(months,gradesData,attData,manualCounts,schedule,subject,today,firstDate,altChoices={}){
  const columns=[];
  months.forEach(ym=>{
    const [y,m]=ym.split('-').map(Number);
    const daysInMonth=new Date(y,m,0).getDate();
    for(let day=1;day<=daysInMonth;day++){
      const ds=`${ym}-${String(day).padStart(2,'0')}`;
      if(ds<firstDate||ds>today)continue;
      const dow=new Date(y,m-1,day).getDay();
      const dayName=dayKeys[dow];
      const lessonKeys=(dow===0||dow===6)?[]:scheduledSubjectLessons(schedule,dayName,subject,altChoices[mondayOf(ds)]);
      const scheduled=lessonKeys.length;
      const gradeSlots=Object.keys(gradesData).filter(k=>journalBaseDate(k)===ds&&
          Object.values(gradesData[k]||{}).some(v=>v!==null&&v!==''))
        .reduce((max,k)=>Math.max(max,journalSlot(k)),0);
      const manual=Number(manualCounts[ds]?.count||0);
      // Відвідуваність — спільна для класу, не для предмета. Вона не має
      // створювати «урок математики» в день, коли математики немає.
      // Залишаємо лише уроки розкладу, явно додані стовпці та дні з
      // уже виставленими оцінками (історичні дані не можна приховати).
      const count=Math.max(scheduled,gradeSlots,manual);
      for(let slot=1;slot<=Math.min(count,30);slot++)
        columns.push({ds,key:journalGradeKey(ds,slot),slot,scheduled,manual,day,dow,ym,
          lessonKey:lessonKeys[slot-1]||''});
    }
  });
  return columns;
}
// ══════════════════════════════════════════════════════════════════
//  ТЕМА Й ДОМАШНЄ ЗАВДАННЯ В ШАПЦІ ЖУРНАЛУ
// ══════════════════════════════════════════════════════════════════
//
// ЩО ЦЕ РОЗВ'ЯЗУЄ. Учитель бачить у журналі оцінки, але не бачить, чи
// вписані тема уроку й домашнє завдання. Щоб це перевірити, доводилося
// виходити з журналу, перемикати дату, дивитися вкладку «Урок» — і так
// на кожен день. Тепер під числом стоять дві позначки: сіра — порожньо,
// зелена — заповнено. Натиснув — прочитав, не виходячи з журналу.
//
// ОДНА ПАРА ПОЗНАЧОК НА ДЕНЬ, А НЕ НА СТОВПЕЦЬ. Тема й завдання лежать
// у базі під датою і предметом (lesson_topics/{клас}/{предмет}/{дата},
// homeworks/{клас}/{дата}/{предмет}) — окремого запису на другий урок
// того самого предмета в той самий день немає. Тож дублювати позначки в
// кожному стовпці дня означало б показувати ту саму річ двічі й натякати,
// що їх можна заповнити окремо.
//
// Тексти тримаємо тут, а не перечитуємо базу на кожне натискання: журнал
// і так уже прочитав їх, щоб пофарбувати позначки.
let journalDayNotes = {};

// Що показати за день. Винесено окремо, бо форм запису тут три — і всі
// три лежать у базі живими (див. topicNames), а домашнє завдання буває і
// рядком, і об'єктом.
export function journalDayNote(topicsForSubject, plan, homeworkByDate, subject, ds){
  const topic = topicNames((topicsForSubject || {})[ds], plan);
  const rec = ((homeworkByDate || {})[ds] || {})[subject];
  let hw = '';
  if(typeof rec === 'string') hw = rec.trim();
  else if(rec && typeof rec === 'object') hw = String(rec.text || '').trim();
  return { topic, hw };
}

// Позначки в шапці дня. Порожнє — сіре й непомітне, заповнене — зелене:
// учитель шукає очима саме прогалини, тож помітним має бути те, чого
// бракує, а не те, що вже зроблено. Тому сіре не бліде до невидимості.
export function journalFlagsHtml(note, ds){
  const flag = (kind, label, filled, hint) =>
    `<button type="button" class="jt-flag jt-flag-${kind}${filled ? ' on' : ''}"
       onclick="event.stopPropagation();showJournalNote(event,'${ds}')"
       data-tip="${hint}">${label}</button>`;
  return `<div class="jt-flags">${
    flag('t', 'Т', !!note.topic, note.topic ? 'Тема вписана — натисніть, щоб прочитати' : 'Тему уроку не вписано')
  }${
    flag('h', 'ДЗ', !!note.hw, note.hw ? 'Завдання є — натисніть, щоб прочитати' : 'Домашнє завдання не задано')
  }</div>`;
}

window.showJournalNote = function(ev, ds){
  const pop = document.getElementById('jt-note-pop');
  if(!pop) return;
  const note = journalDayNotes[ds] || { topic:'', hw:'' };
  const empty = '<i class="jt-note-empty">не заповнено</i>';
  pop.innerHTML = `
    <div class="jt-note-head">${escHtml(String(ds).split('-').reverse().join('.'))}</div>
    <div class="jt-note-row"><b>Тема</b>${note.topic ? escHtml(note.topic) : empty}</div>
    <div class="jt-note-row"><b>Домашнє завдання</b>${note.hw ? escHtml(note.hw) : empty}</div>
    <button type="button" class="jt-note-go" onclick="jumpToJournalDay('${ds}')">
      Відкрити цей день ↗</button>`;
  pop.style.display = 'block';
  // Спершу показуємо, потім міряємо: у прихованого блоку розміри нульові,
  // і вікно щоразу тулилося б у лівий верхній кут.
  const r = pop.getBoundingClientRect();
  const x = Math.min(Math.max(8, (ev.clientX || 0) - r.width / 2), innerWidth - r.width - 8);
  const y = (ev.clientY || 0) + 14 + r.height > innerHeight
    ? (ev.clientY || 0) - r.height - 12 : (ev.clientY || 0) + 14;
  pop.style.left = Math.round(x) + 'px';
  pop.style.top = Math.round(Math.max(8, y)) + 'px';
  // Закриваємо наступним натисканням будь-де. once:true і setTimeout —
  // щоб поточний клік, який щойно відкрив вікно, його ж і не закрив.
  setTimeout(() => {
    document.addEventListener('click', () => { pop.style.display = 'none'; }, { once:true });
  }, 0);
};

// «Відкрити цей день» — те, заради чого вчителі й просили позначки:
// побачив прогалину — пішов і заповнив. Закриваємо журнал, ставимо дату
// й відкриваємо вкладку «Урок», де тема й завдання і редагуються.
window.jumpToJournalDay = function(ds){
  const pop = document.getElementById('jt-note-pop');
  if(pop) pop.style.display = 'none';
  if(window.closeJournalModal) window.closeJournalModal();
  const dateEl = document.getElementById('global-date');
  if(dateEl && ds){ dateEl.value = ds; if(window.handleDateChange) window.handleDateChange(); }
  openTabByKey('teacher-screen', 'lesson');
};

window.renderJournalTable=async function(){
  const request=++journalRenderSeq;
  const cls=document.getElementById('j-class-select').value;
  const subj=document.getElementById('j-subj-select').value;
  document.getElementById('j-scale-controls').style.display=journalIsTeacher&&getClassNum(cls)>LEVEL_MAX_CLASS?'flex':'none';
  const months=getJournalMonths();
  const table=document.getElementById('journal-table-el');
  const wAvgDiv=document.getElementById('j-weighted-avg');
  const rangeSummary=document.getElementById('j-range-summary');
  const teacherEl=document.getElementById('j-teacher-name');
  if(teacherEl) teacherEl.textContent='';
  if(!cls||!subj||months.length===0){table.innerHTML='';wAvgDiv.style.display='none';if(rangeSummary)rangeSummary.textContent='';return;}
  if(teacherEl){
    fetchSubjectTeachers(cls).then(map=>{
      if(document.getElementById('j-subj-select')?.value===subj){
        const tName=map[subjKey(subj)]||map[subj.trim()];
        teacherEl.textContent=tName?`👩‍🏫 ${tName}`:'👩‍🏫 Не призначено';
      }
    });
  }
  if(months.length>12){showToast('⚠️ Максимальний період перегляду — 12 місяців.');return;}
  table.innerHTML='<tr><td style="padding:20px;color:var(--ink-3);">⏳ Завантаження...</td></tr>';
  const clsNum=getClassNum(cls);
  try{
    const [studSnap,attSnap,retakeSnap,scheduleSnap,altSnap,scaleSnap,topicsSnap,hwSnap,plansSnap,aliasesSnap,...perMonth]=await Promise.all([
      get(child(ref(db),`students_list/${cls}`)),
      get(child(ref(db),`attendance/${cls}`)),
      get(child(ref(db),`retake_requests/${cls}/${subj}`)),
      get(child(ref(db),`schedules/${cls}/lessons`)),
      get(child(ref(db),`schedule_alt/${cls}`)).catch(()=>null),
      get(child(ref(db),`grade_scales/${cls}/${subj}`)),
      get(child(ref(db),`lesson_topics/${cls}/${subjKey(subj)}`)).catch(()=>null),
      get(child(ref(db),`homeworks/${cls}`)).catch(()=>null),
      get(child(ref(db),`curriculum_plans/${cls}`)).catch(()=>null),
      get(child(ref(db),`curriculum_aliases/${cls}`)).catch(()=>null),
      ...months.flatMap(ym=>[
        get(child(ref(db),`grades/${cls}/${ym}/${subj}`)),
        get(child(ref(db),`grade_types/${cls}/${ym}/${subj}`)),
        get(child(ref(db),`journal_column_types/${cls}/${ym}/${subj}`)),
        get(child(ref(db),`journal_columns/${cls}/${ym}/${subj}`))
      ])
    ]);
    if(request!==journalRenderSeq)return;
    journalNumericScale=getClassNum(cls)>LEVEL_MAX_CLASS&&scaleSnap.exists();
    journalScaleMax=journalNumericScale?Number(scaleSnap.val().max||scaleSnap.val()):6;
    if(!Number.isInteger(journalScaleMax)||journalScaleMax<2||journalScaleMax>2000)journalScaleMax=6;
    const scaleInput=document.getElementById('j-scale-max');
    if(scaleInput)scaleInput.value=journalScaleMax;
    const scaleInfo=document.getElementById('j-scale-info');
    if(scaleInfo)scaleInfo.textContent=journalNumericScale?`Шкала 1–${journalScaleMax}`:'Стандартна шкала 1–6';
    // [{sid, nm}] — дані ключуються ідентифікатором, у таблиці показуємо імʼя
    let students=[];
    if(studSnap.exists())students=Object.entries(studSnap.val())
      .map(([sid,nm])=>({sid,nm:String(nm)}))
      .sort((a,b)=>a.nm.localeCompare(b.nm,'uk'));
    if(students.length===0){table.innerHTML='<tr><td style="padding:20px;">Учнів немає.</td></tr>';return;}
    // Merge each month's grades/types/column-types into one flat, date-keyed object.
    const gradesData={};const typesData={};const journalColumnTypes={};const manualCounts={};
    months.forEach((ym,i)=>{
      const [gradesSnap,typesSnap,colTypesSnap,colSnap]=[perMonth[i*4],perMonth[i*4+1],perMonth[i*4+2],perMonth[i*4+3]];
      if(gradesSnap.exists())Object.assign(gradesData,gradesSnap.val());
      if(typesSnap.exists())Object.assign(typesData,typesSnap.val());
      if(colTypesSnap.exists())Object.assign(journalColumnTypes,colTypesSnap.val());
      if(colSnap.exists())Object.assign(manualCounts,colSnap.val());
    });
    const attDataAll=attSnap.exists()?attSnap.val():{};
    const retakeData=retakeSnap.exists()?retakeSnap.val():{};
    const attData={};for(let d in attDataAll)if(months.some(ym=>d.startsWith(ym)))attData[d]=attDataAll[d];
    // Build date columns across every month in the range (each column remembers
    // its own source month `ym`, since grade writes/reads need the *correct*
    // Firebase month key, not just the range's start month).
    const dateCols=buildJournalColumns(months,gradesData,attData,manualCounts,
      scheduleSnap.exists()?scheduleSnap.val():{},subj,localDateString,`${ACTIVE_YEAR.split('-')[0]}-09-01`,
      altSnap?.exists()?altSnap.val():{});
    journalVisibleColumns=dateCols;

    const topicsForSubject = topicsSnap && topicsSnap.exists() ? topicsSnap.val() : {};
    const homeworkByDate = hwSnap && hwSnap.exists() ? hwSnap.val() : {};
    const plans = plansSnap && plansSnap.exists() ? plansSnap.val() : {};
    const aliases = aliasesSnap && aliasesSnap.exists() ? aliasesSnap.val() : {};
    const pKey = planKeyWith(aliases, subjKey(subj));
    const planForSubject = plans[pKey] || null;

    journalDayNotes = {};
    const uniqueDates = [...new Set(dateCols.map(c => c.ds))];
    uniqueDates.forEach(ds => {
      journalDayNotes[ds] = journalDayNote(topicsForSubject, planForSubject, homeworkByDate, subj, ds);
    });
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
    // Смуги місяців у журналі. Тут навмисно ЛІТЕРАЛИ, а не var(--…):
    // ця таблиця йде на друк через html2canvas, а він перемальовує
    // сторінку у власне полотно, і покладатися на те, що змінні доїдуть
    // туди правильно, не хочеться. Значення — ті самі, що в токенах
    // --brand-soft і --surface-2; міняти їх треба парою.
    const bandColorOf=idx=>idx%2===0?'#E0F7FA':'#F4F8F9';
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
    dateCols.forEach((col)=>{
      const {ds,key,slot,scheduled,manual,day,dow,ym} = col;
      const isToday=ds===localDateString;
      if(bandRemaining===0){bandPtr++;bandRemaining=monthBands[bandPtr].count;}
      const bandColor=bandColorOf(monthBands[bandPtr].bandIdx);bandRemaining--;
      // Phase 4b: replaced the passive, grade-derived type/weight hint with an editable
      // pre-set "expected type" control (journal_column_types), used by openGradeEditor()
      // to prefill gepType for cells that don't have a grade yet.
      const presetType=journalColumnTypes[key]||'';
      // Phase 5: option list now sourced from gradeTypesCache (falls back to
      // GRADE_WEIGHTS' codes if the cache hasn't loaded yet), same as elsewhere.
      const typeCodes=Object.keys(gradeTypesCache).length>0?Object.keys(gradeTypesCache):Object.keys(GRADE_WEIGHTS);
      const weightOf=t=>(gradeTypesCache[t]&&gradeTypesCache[t].weight)??GRADE_WEIGHTS[t]??1.0;
      let typeCell;
      if(canEdit){
        // Phase 8: use this column's own source month (`ym`), not a single outer
        // yMonth — the range can now span several Firebase month-keys at once.
        typeCell=`<br><select class="jct-type-select" onclick="event.stopPropagation();" onchange="setJournalColumnType('${cls}','${escJs(subj)}','${ym}','${key}',this.value)" data-tip="Тип оцінки на цей стовпець">
          <option value="">—</option>
          ${typeCodes.map(t=>`<option value="${t}" ${presetType===t?'selected':''}>${t} ×${weightOf(t)}</option>`).join('')}
        </select>`;
      } else {
        typeCell=presetType?`<br><span style="font-size:.69em;color:var(--warn);">${presetType}${weightOf(presetType)?` ×${weightOf(presetType)}`:''}</span>`:'';
      }
      const label=slot<=scheduled?`Урок ${slot}`:`Оцінка ${slot}`;
      const last=slot===Math.max(...dateCols.filter(c=>c.ds===ds).map(c=>c.slot));
      const add=canEdit&&last&&slot<30
        ?`<button type="button" class="j-add-column" onclick="addJournalColumn('${ds}')" aria-label="Додати стовпець" data-tip="Додати ще одну оцінку на цей день">＋</button>`:'';
      const remove=canEdit&&last&&manual===slot&&slot>scheduled
        ?`<button type="button" class="j-remove-column" onclick="removeJournalColumn('${ds}')" aria-label="Видалити додатковий стовпець" data-tip="Видалити порожній додатковий стовпець">−</button>`:'';
      const actions=add||remove?`<div class="j-column-actions">${remove}${add}</div>`:'';

      const flagsHtml = journalFlagsHtml(journalDayNotes[ds], ds);

      dayRow+=`<th class="${isToday?'today-col':''}" style="background:${bandColor};" title="${ds} · ${label}">${day}<br><span style="font-size:.78em;font-weight:400;">${dayN[dow]} · ${label}</span>${flagsHtml}${typeCell}${actions}</th>`;
    });
    dayRow+='</tr>';
    let thead='<thead>'+monthRow+dayRow+'</thead>';
    // Body
    let tbody='<tbody>';let classWeightedAvg=0;let classCount=0;let legacyExcluded=0;
    students.forEach((st)=>{
      let stGrades={};let stTypes={};
      dateCols.forEach(({key})=>{
        const v=gradesData[key]?.[st.sid]||'';
        const tp=typesData[key]?.[st.sid]||'П';
        if(v){stGrades[key]=v;stTypes[key]=tp;}
      });
      const eligible=getClassNum(cls)<=LEVEL_MAX_CLASS
        ?Object.fromEntries(Object.entries(stGrades).filter(([,value])=>{if(Number(value)>6){legacyExcluded++;return false;}return true;}))
        :stGrades;
      const avg=calculateStudentWeightedAvg(eligible,stTypes);
      if(avg!==null){classWeightedAvg+=avg;classCount++;}
      const avgStr=avg!==null?avg.toFixed(2):'-';
      let rowHtml=`<tr><td class="sn" title="${escHtml(st.nm)}">${escHtml(st.nm)}</td>`;
      dateCols.forEach(({ds,key,slot,ym,lessonKey})=>{
        const isToday=ds===localDateString;
        // «Весь день» — у кожному стовпці дня; відмітка за уроком — у своєму.
        // І за ідентифікатором, і за імʼям: самозвіт родини донедавна лягав
        // під імʼям, і в журналі його не було видно взагалі.
        const slotsOf=(attData[ds]&&(attData[ds][st.sid]||attData[ds][st.nm]))||null;
        const attInfo=attendanceForLesson(slotsOf,lessonKey);
        const gradeVal=gradesData[key]?.[st.sid]||'';
        const gradeType=typesData[key]?.[st.sid]||'';
        const dispVal=displayGrade(gradeVal,cls,journalNumericScale);
        const presetType=journalColumnTypes[key]||'';
        let cell='';
        // escJs on subject + student name — both routinely contain apostrophes in
        // Ukrainian (Комп'ютерні науки, Дем'яненко) which would otherwise terminate
        // the onclick's string literal early and kill the handler.
        if(gradeVal){
          const gc=journalNumericScale?'g-scale':gradeClass6(gradeVal);
          const gradeAction=canEdit?` role="button" tabindex="0" aria-label="Оцінка ${escHtml(st.nm)} ${ds}: ${escHtml(String(dispVal))}" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click()}" onclick="handleGradeClick(event,'${cls}','${escJs(subj)}','${key}','${escJs(st.sid)}','${ym}','${escJs(String(gradeVal))}','${escJs(String(gradeType))}','${escJs(String(presetType))}')"`:'';
          cell+=`<span class="g-cell ${gc}"${gradeAction}><span class="g-val">${escHtml(String(dispVal))}</span>${gradeType?`<span class="g-type">${escHtml(String(gradeType))}</span>`:''}</span>`;
        } else if(canEdit){
          cell+=`<span class="g-cell g-empty" role="button" tabindex="0" aria-label="Додати оцінку ${escHtml(st.nm)} ${ds}" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click()}" onclick="handleGradeClick(event,'${cls}','${escJs(subj)}','${key}','${escJs(st.sid)}','${ym}','','','${escJs(String(presetType))}')">＋</span>`;
        }
        if(attInfo){const ac=attInfo.status==='absent'?'att-absent':'att-late';const al=attInfo.status==='absent'?'н':'з';cell+=`<span class="${ac}" data-tip="${attInfo.reason}">${al}</span>`;}
        rowHtml+=`<td class="${isToday?'today-col':''}">${cell}</td>`;
      });
      const roundedAvg=avg!==null?Math.min(journalScaleMax,Math.max(1,Math.round(avg))):null;
      const avgGc=roundedAvg!==null?(journalNumericScale?'g-scale':gradeClass6(roundedAvg)):'';
      rowHtml+=`<td class="avg-col"><span class="${avgGc}" style="border-radius:6px;padding:.16em .39em;font-weight:800;">${displayGrade(roundedAvg!==null?String(roundedAvg):'-',cls,journalNumericScale)}</span><br><span style="font-size:.78em;color:var(--ink-3);">${avgStr}</span></td>`;
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
      rangeSummary.textContent=`👥 ${students.length} ${studentsWord} · 🗓️ ${dateCols.length} ${lessonsWord} / стовпці · ${periodStr} · ${getClassNum(cls)<=LEVEL_MAX_CLASS?'рівні П/С/Д/В':`шкала 1–${journalScaleMax}`}${legacyExcluded?` · ${legacyExcluded} історичних балів понад 6 не враховано в середньому`:''}`;
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
      wAvgDiv.innerHTML=`<b style="color:var(--brand-deep);">📊 Середньозважений бал класу з ${subj}${periodLabel}:</b><br>
        <span style="font-size:1.6rem;font-weight:800;color:var(--brand-deep);">${ca}</span>
        ${weightHint?`<span style="font-size:.8rem;color:var(--ink-3);margin-left:8px;">(зважений: ${weightHint})</span>`:''}`;
    } else wAvgDiv.style.display='none';
  }catch(e){console.error(e);table.innerHTML=`<tr><td style="padding:20px;color:red;">Помилка: ${e.message}</td></tr>`;}
};
window.handleGradeClick=function(e,cls,subj,ds,student,yMonth,existingVal,existingType,presetType){
  if(!journalIsTeacher||journalMode!=='edit')return;
  e.stopPropagation();openGradeEditor(cls,subj,ds,student,yMonth,e.currentTarget,existingVal,existingType,presetType);
};
// ══════════ PHASE 4b: PER-DATE PRESET "ТИП" (before any grades exist) ══════════
window.setJournalColumnType=async function(cls,subj,yMonth,date,type){
  try{
    await set(ref(db,`journal_column_types/${cls}/${yMonth}/${subj}/${date}`),type||null);
    showToast(type?`✅ Тип на ${journalBaseDate(date).split('-').reverse().join('.')}: ${type}`:'🗑️ Тип знято');
  }catch(e){showToast('❌ Тип не збережено: '+e.message);renderJournalTable();}
};
window.addJournalColumn=async function(day){
  if(!journalIsTeacher||journalMode!=='edit'||journalColumnBusy)return;
  const cls=document.getElementById('j-class-select').value;
  const subj=document.getElementById('j-subj-select').value;
  const count=journalVisibleColumns.filter(c=>c.ds===day).length;
  if(!cls||!subj||!count)return;
  if(count>=30)return showToast('⚠️ Не більше 30 стовпців на день');
  journalColumnBusy=true;
  try{
    await set(ref(db,`journal_columns/${cls}/${day.slice(0,7)}/${subj}/${day}/count`),count+1);
    await renderJournalTable();
    showToast('✅ Стовпець додано');
  }catch(e){showToast('❌ Стовпець не додано: '+e.message);}
  finally{journalColumnBusy=false;}
};
window.removeJournalColumn=async function(day){
  if(!journalIsTeacher||journalMode!=='edit'||journalColumnBusy)return;
  const cls=document.getElementById('j-class-select').value;
  const subj=document.getElementById('j-subj-select').value;
  const columns=journalVisibleColumns.filter(c=>c.ds===day);
  const last=columns[columns.length-1];
  if(!cls||!subj||!last||last.manual!==last.slot||last.slot<=last.scheduled)return;
  const ym=day.slice(0,7);
  const countPath=`journal_columns/${cls}/${ym}/${subj}/${day}/count`;
  journalColumnBusy=true;
  try{
    const [countSnap,gradeSnap]=await Promise.all([
      get(child(ref(db),countPath)),
      get(child(ref(db),`grades/${cls}/${ym}/${subj}/${last.key}`))
    ]);
    if(Number(countSnap.val())!==last.slot){showToast('⚠️ Стовпці вже змінилися. Оновлюємо журнал.');await renderJournalTable();return;}
    if(gradeSnap.exists()&&Object.keys(gradeSnap.val()||{}).length){
      showToast('⚠️ Спочатку видаліть оцінки в цьому стовпці.');return;
    }
    await update(ref(db),{
      [countPath]:last.slot>1?last.slot-1:null,
      [`journal_column_types/${cls}/${ym}/${subj}/${last.key}`]:null
    });
    await renderJournalTable();
    showToast('🗑️ Додатковий стовпець видалено');
  }catch(e){showToast('❌ Стовпець не видалено: '+e.message);}
  finally{journalColumnBusy=false;}
};
window.saveJournalScale=async function(){
  if(!journalIsTeacher)return;
  const cls=document.getElementById('j-class-select').value;
  const subj=document.getElementById('j-subj-select').value;
  const max=Number(document.getElementById('j-scale-max').value);
  if(!cls||!subj)return showToast('⚠️ Оберіть предмет');
  if(getClassNum(cls)<=LEVEL_MAX_CLASS)return showToast('⚠️ У 1–4 класах оцінки ставлять рівнями: П, С, Д, В.');
  if(!Number.isInteger(max)||max<2||max>2000)return showToast('⚠️ Максимальний бал має бути від 2 до 2000');
  try{
    await set(ref(db,`grade_scales/${cls}/${subj}`),{max});
    journalScaleMax=max;journalNumericScale=true;
    await renderJournalTable();
    showToast(`✅ Шкала з ${subj}: 1–${max}`);
  }catch(e){showToast('❌ Шкалу не збережено: '+e.message);}
};
window.toggleJournalFullscreen=function(){
  const modal=document.getElementById('journal-modal');
  const on=modal.classList.toggle('journal-fullscreen');
  const btn=document.getElementById('j-fullscreen');
  if(btn)btn.textContent=on?'🗗 Звичайний розмір':'⛶ На весь екран';
  if(journalZoomIsAuto)setTimeout(window.journalZoomFit,0);
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
// Уроки дня — ЗАВЖДИ масив.
//
// ЧОМУ ЦЕ ПОТРІБНО. Firebase не зберігає порожні обʼєкти. Конструктор
// заповнює порожні слоти як {}, тому масив [{}, {}, [урок]] приїжджає
// назад як обʼєкт {"2": [урок]} — з дірками. У обʼєкта немає .length,
// і рядок
//     maxR = Math.max(maxR, lessons[day].length)
// давав NaN. Далі for(row=0; row<NaN; row++) не виконувався жодного разу,
// і таблиця лишалася без рядків: шапка є, редагувати нема чого.
//
// Саме тому «не відкривався понеділок»: у дні, де уроків немає, гілки
// взагалі не було, maxR лишався 8 і сітка малювалася. А в понеділок, де
// вже стояв один урок, приходив обʼєкт — і зникали всі рядки.
function dayArr(raw){
  if(Array.isArray(raw)) return raw;
  if(!raw || typeof raw !== 'object') return [];
  const out = [];
  Object.keys(raw).forEach(k => {
    const i = Number(k);
    if(Number.isInteger(i) && i >= 0 && i < 1000) out[i] = raw[k];
  });
  for(let i = 0; i < out.length; i++) if(out[i] === undefined) out[i] = {};
  return out;
}

// ВІДКРИТТЯ КОНСТРУКТОРА.
//
// Тут не було жодного try/catch. Якщо будь-яке з чотирьох читань падало,
// функція обривалася ДО renderMatrixGrid — вікно відкривалося порожнім, і
// це виглядало як «понеділок не відкривається для редагування»: адже
// перший день не малювався взагалі, а варто було перемкнути день, і сітка
// зʼявлялася (бо onchange викликає renderMatrixGrid напряму).
//
// Тепер: помилка видима, день завжди скидається на понеділок, а під
// заголовком видно, що саме завантажилося.
let liveEditConfirmed=false;   // підтвердження правки чинного розкладу — раз на відкриття
window.openVisualMatrixModal=async function(mode){
  currentMatrixMode=mode;liveEditConfirmed=false;
  document.getElementById('visual-matrix-modal').style.display='flex';
  const daySel=document.getElementById('matrix-day-select');
  if(daySel) daySel.value='Monday';
  const info=document.getElementById('matrix-load-info');
  const say=(t,bad)=>{ if(info){ info.style.display=t?'block':'none'; info.textContent=t||'';
                                 info.style.color=bad?'var(--danger)':'var(--ink-3)'; } };
  say('Завантаження...');
  try{
  let dbPath=mode==='live'?'schedules':`schedule_drafts/${mode}`;
  // МАТРИЦЯ ДОСТУПУ — НЕОБОВ'ЯЗКОВА.
  //
  // teacher_access читає лише директор: це документ про всю школу. Раніше
  // він читався в одному Promise.all із розкладом, тож відмова в правах
  // валила побудову всієї сітки — «Permission denied. Сітку не побудовано»,
  // хоча сам розклад людині доступний. Матриця потрібна тільки для того,
  // щоб підставити ім'я вчителя за замовчуванням; без неї сітка будується,
  // просто без цих підписів.
  // КОЖНЕ ЧИТАННЯ ОКРЕМО, І КОЖНЕ ЗВІТУЄ ПРО СЕБЕ.
  //
  // Це вікно читає чотири вузли з різними правами. Двічі я вирішував, що
  // винне одне з них, лагодив — і помилка лишалася, бо поруч було інше.
  // Тепер жодне читання не валить решту, а рядок стану називає конкретний
  // шлях, у якому відмовлено. Гадати більше не треба ні мені, ні школі.
  const denied = [];
  const tryGet = async (path, label) => {
    try{ return await get(ref(db, path)); }
    catch(e){ denied.push(`${label} (${path}): ${e.message}`); return null; }
  };
  const snap = await tryGet(dbPath, 'розклад');
  if(!snap){
    say(`Не вдалося прочитати розклад. ${denied.join(' · ')}`, true);
    return;
  }
  const stSnap = await tryGet('students_list', 'список учнів');
  const accSnap = await tryGet('teacher_access', 'матриця доступу вчителів');
  const accDenied = !accSnap;

  // Каталог предметів — друге, доступне всім джерело вчителя за предметом.
  // Саме воно рятує сітку, коли матриця доступу закрита: у каталозі
  // вчитель записаний поруч із предметом, і особливих прав він не потребує.
  window.catalogTeachers = {};
  try{
    const cat = await get(ref(db, `subjects_catalog/${ACTIVE_YEAR}`));
    if(cat.exists()){
      const all = cat.val() || {};
      for(const cls in all){
        const byName = {};
        for(const key in (all[cls] || {})){
          const rec = all[cls][key];
          const name = (rec && typeof rec === 'object') ? rec.name : rec;
          if(!name) continue;
          if(rec && rec.teacherName)
            byName[String(name).trim()] = { email: rec.teacherEmail || '', name: rec.teacherName };
        }
        if(Object.keys(byName).length) window.catalogTeachers[cls] = byName;
      }
    }
  }catch(e){ console.warn('subjects_catalog:', e.message); }
  if(window.loadClubCatalogs){try{await window.loadClubCatalogs();}catch(e){console.warn('clubs_catalog:',e.message);}}
  // Класні години всіх класів. У сітці їх немає й бути не може: сітка
  // будується з розкладу, а класна година лежить окремим вузлом, бо розклад
  // перезаписує імпорт. Але директор, який складає розклад, мусить бачити,
  // що цей час у класу вже зайнятий — інакше поставить туди урок.
  window.allClassHours = {};
  try{
    const ch = await get(ref(db, 'class_hour'));
    if(ch.exists()) window.allClassHours = ch.val() || {};
  }catch(e){ console.warn('class_hour:', e.message); }
  // Погодження накладок цієї чернетки. У чинному розкладі попереджень
  // немає взагалі, тож і читати нічого. Відмова в правах не страшна:
  // без погоджень список просто буде повним, як і був досі.
  warnOk = {};
  if(mode !== 'live'){
    try{
      const wo = await get(ref(db, `schedule_warn_ok/${mode}`));
      if(wo.exists()) warnOk = wo.val() || {};
    }catch(e){ console.warn('schedule_warn_ok:', e.message); }
  }
  globalAllSchedules=snap.exists()?snap.val():{};
  globalTeacherAccess=(accSnap&&accSnap.exists())?accSnap.val():{};
  globalAllStudents=(stSnap&&stSnap.exists())?stSnap.val():{};
  // СПИСОК УЧИТЕЛІВ — ТЕЖ НЕОБОВ'ЯЗКОВИЙ.
  //
  // users читає лише директор — і правильно, там персональні дані всіх
  // людей школи. Цей запит стояв поза захистом, тож відмова в правах
  // валила побудову сітки так само, як раніше матриця доступу. Список
  // потрібен лише для випадайки «хто веде урок» у редакторі клітинки.
  let uSnap=null, usersDenied=false;
  try{ uSnap=await getUsersSnap(); }
  catch(e){ usersDenied=true; denied.push(`список персоналу (users): ${e.message}`); }
  window.globalTeachersList=[];
  if(uSnap&&uSnap.exists()){const u=uSnap.val();for(let uid in u){const us=u[uid];const rs=getUserRoles(us);if(rs.some(r=>r==='teacher'||r==='class_teacher'||r==='art_school_teacher'||r==='music_teacher')&&us.email&&!us.disabled){const n=(us.firstName||us.lastName)?`${us.firstName||''} ${us.lastName||''}`.trim():"Ім'я";const se=emailKey(us.email);window.globalTeachersList.push({email:us.email,name:n,safeEmail:se});}}}
  window._matrixAccDenied=accDenied;
  // Помітна смуга просто у вікні: рядок стану внизу легко не помітити,
  // а наслідок серйозний — половина сітки виглядає як розклад без учителів.
  const mw=document.getElementById('matrix-acc-warn');
  if(mw){
    mw.style.display=accDenied?'block':'none';
    const cats=Object.keys(window.catalogTeachers||{}).length;
    mw.innerHTML='⚠️ <b>Матриця доступу вчителів недоступна</b> — її читає лише директор. '
      + (cats
          ? `Учителів беремо з каталогу предметів (заповнено класів: ${cats}). `
            + 'Де в каталозі вчителя не вказано, стоїть «?».'
          : 'Каталог предметів теж порожній, тому вчителів підставити нема звідки. '
            + 'Заповніть його: кабінет директора → «📗 Предмети класу й учителі».');
  }
  const title=document.getElementById('matrix-modal-title');const wb=document.getElementById('constructor-warnings');
  // ЧІТКО КАЖЕМО, ЩО САМЕ РЕДАГУЄТЬСЯ.
  //
  // Вікно виглядало однаково для чинного розкладу і для чернетки, тому
  // було незрозуміло, куди підуть зміни. А різниця принципова: у режимі
  // «чинний» кожна правка одразу видима батькам і вчителям, скасувати її
  // нема чим — історії змін розкладу портал не веде.
  const mb=document.getElementById('matrix-mode-banner');
  if(mode!=='live'){
    title.innerHTML=`🛠️ Конструктор: <span style="color:var(--warn)">${mode}</span>`;
    wb.style.display='block';
    if(mb){ mb.className='mx-mode draft'; mb.style.display='block';
      mb.textContent='Це чернетка. На чинний розклад вона не впливає, доки ви не натиснете «Опублікувати».'; }
  } else {
    title.innerHTML='🗓️ Чинний розклад школи';
    wb.style.display='none';
    if(mb){ mb.className='mx-mode live'; mb.style.display='block';
      mb.textContent='Ви редагуєте ЧИННИЙ розклад. Кожна зміна одразу видима батькам і вчителям. '
        + 'Щоб готувати новий розклад безпечно — робіть це в чернетці.'; }
  }
  window.calculateMatrixWarnings();renderMatrixGrid();

  // Що саме прочитано — щоб «порожній понеділок» більше не був загадкою
  const clsKeys=Object.keys(globalAllSchedules||{}).filter(k=>k!=='placeholder');
  let mon=0;
  clsKeys.forEach(c=>{
    const arr=globalAllSchedules[c]?.lessons?.Monday;
    const list=Array.isArray(arr)?arr:Object.values(arr||{});
    list.forEach(i=>{ const items=Array.isArray(i)?i:(i&&i.subject?[i]:[]); mon+=items.length; });
  });
  const accNote = denied.length
    ? ` · Недоступно: ${denied.join(' · ')}. Сітка побудована без цих даних —`
      + ' імена вчителів не підставляються. Уроки, час і предмети редагуються звично.'
    : '';
  say((clsKeys.length
    ? `${mode==='live'?'Чинний розклад':'Чернетка «'+mode+'»'}: класів ${clsKeys.length}, уроків у понеділок ${mon}.`
    : `${mode==='live'?'Чинний розклад':'Чернетка «'+mode+'»'} порожня — жодного класу. Додайте уроки клацанням по клітинці.`)
    + accNote);
  }catch(e){
    console.error('openVisualMatrixModal', e);
    say('Не вдалося завантажити: '+e.message+'. Сітку не побудовано.', true);
  }
};
window.closeVisualMatrixModal=function(){document.getElementById('visual-matrix-modal').style.display='none';};
// Ключ попередження. Навмисно НЕ містить пари класів: у слоті, де вчитель
// веде п'ять класів одразу, пар виходить п'ять, а обставина одна.
// Крапки в пошті — у підкреслення, інакше ключ розірве шлях у Firebase.
function warnKey(kind, day, row, email){
  return `${kind}_${day}_${row}_${emailKey(email || '')}`;
}

window.calculateMatrixWarnings=function(){
  if(currentMatrixMode==='live')return;
  draftWarningsCache=[];
  const daySel=document.getElementById('matrix-day-select');
  if(!daySel) return;
  const day=daySel.value;

  let maxR=8;
  for(let i=1;i<=11;i++){
    const cls=`class_${i}`;
    maxR=Math.max(maxR,dayArr(globalAllSchedules[cls]?.lessons?.[day]).length);
  }

  // Накладки збираємо групами «вчитель + слот», а не окремими парами.
  // Раніше кожна пара була своїм рядком: учитель, що повіз шість класів
  // на басейн, давав п'ять однакових рядків поспіль.
  const conflicts=new Map();
  const travels=new Map();
  const tracker={};

  for(let row=0;row<maxR;row++){
    const slotT={};
    for(let c=1;c<=11;c++){
      const clsId=`class_${c}`;
      const building=c<=5?1:2;
      const la=dayArr(globalAllSchedules[clsId]?.lessons?.[day]);
      const raw=la[row];
      const items=Array.isArray(raw)?raw:(raw&&raw.subject?[raw]:[]);
      items.forEach((lesson,si)=>{
        if(lesson.type==='break')return;
        let te=lesson.teacherEmail;
        if(!te&&lesson.subject){
          const sn=typeof lesson.subject==='string'?lesson.subject:(lesson.subject.ua||'');
          const dt=lesson.type==='extra'?window.getClubTeacher?.(clsId,sn):window.getDefaultTeacher(clsId,sn);
          if(dt)te=dt.email;
        }
        if(!te)return;
        if(!tracker[te])tracker[te]={};
        if(slotT[te]){
          const key=warnKey('c',day,row,te);
          let g=conflicts.get(key);
          if(!g){
            // Перший клас слота теж потрапляє в групу — він половина
            // накладки, а не сторонній спостерігач.
            g={key,email:te,row,classes:new Set([slotT[te].classId]),
               cells:[{type:'conflict',row,classId:slotT[te].classId,subIdx:slotT[te].subIdx}]};
            conflicts.set(key,g);
          }
          g.classes.add(clsId);
          g.cells.push({type:'conflict',row,classId:clsId,subIdx:si});
        } else slotT[te]={classId:clsId,subIdx:si};
        tracker[te][row]={classId:clsId,building,subIdx:si};
      });
    }
  }

  for(const te in tracker){
    const slots=Object.keys(tracker[te]).map(Number).sort((a,b)=>a-b);
    for(let i=0;i<slots.length-1;i++){
      const a=slots[i], b=slots[i+1];
      if(b-a!==1) continue;
      if(tracker[te][a].building===tracker[te][b].building) continue;
      const key=warnKey('t',day,a,te);
      travels.set(key,{key,email:te,from:a,to:b,
        cells:[{type:'travel',row:a,classId:tracker[te][a].classId,subIdx:tracker[te][a].subIdx},
               {type:'travel',row:b,classId:tracker[te][b].classId,subIdx:tracker[te][b].subIdx}]});
    }
  }

  const open=[], okd=[];
  conflicts.forEach(g=>(warnOk[g.key]?okd:open).push({kind:'c',g}));
  travels.forEach(g=>(warnOk[g.key]?okd:open).push({kind:'t',g}));

  // Клітинки підсвічуємо лише за непогодженими. Інакше погодження нічого
  // не змінювало б: рядок зник, а сітка так само червона.
  open.forEach(({g})=>g.cells.forEach(c=>draftWarningsCache.push(c)));

  const okBtn=(k)=>`<button type="button" onclick="approveWarn('${escJs(k)}')" class="wo-btn">Це нормально</button>`;
  const line=({kind,g})=>kind==='c'
    ? `<li style="color:var(--danger);"><b>Накладка!</b> ${escHtml(g.email)}: `
      + `${escHtml([...g.classes].join(', '))} (Слот ${g.row+1}) ${okBtn(g.key)}</li>`
    : `<li style="color:var(--warn);"><b>Переїзд:</b> ${escHtml(g.email)} `
      + `між слотами ${g.from+1}→${g.to+1} ${okBtn(g.key)}</li>`;

  let html='<b>⚠️ Аналіз накладок:</b>';
  if(open.length) html+=`<ul style="margin:4px 0 0 0;padding-left:18px;">${open.map(line).join('')}</ul>`;
  else html+=okd.length
    ? ' <span style="color:var(--ok);">усі погоджені.</span>'
    : ' <span style="color:var(--ok);">накладок не виявлено.</span>';

  // Погоджені — згорнутим рядком. Не ховаємо назовсім: інакше через місяць
  // ніхто не згадає, що саме визнали нормальним і чому в сітці тиша.
  if(okd.length){
    const items=okd.map(({kind,g})=>{
      const what=kind==='c'
        ? `${escHtml(g.email)}: ${escHtml([...g.classes].join(', '))} (Слот ${g.row+1})`
        : `${escHtml(g.email)} — переїзд ${g.from+1}→${g.to+1}`;
      const who=warnOk[g.key]&&warnOk[g.key].by ? ` <i>— ${escHtml(warnOk[g.key].by)}</i>` : '';
      return `<li>${what}${who} `
        + `<button type="button" onclick="unapproveWarn('${escJs(g.key)}')" class="wo-btn wo-undo">Повернути</button></li>`;
    }).join('');
    html+=`<div style="margin-top:7px;">`
      + `<button type="button" onclick="toggleWarnOkList()" class="wo-btn wo-toggle">✔️ Погоджено: ${okd.length}</button>`
      + `<ul id="warn-ok-list" style="display:none;margin:5px 0 0 0;padding-left:18px;color:var(--ink-2);">${items}</ul>`
      + `</div>`;
  }

  const wb=document.getElementById('constructor-warnings');
  // Стара розмітка в браузері — не привід валити побудову сітки цілком.
  // Раніше тут стояло голе wb.innerHTML, і відсутній блок означав би
  // виключення просто посеред відкриття конструктора.
  if(!wb) return;
  wb.innerHTML=html;
  wb.style.display='block';
};

window.toggleWarnOkList=function(){
  const el=document.getElementById('warn-ok-list');
  if(el) el.style.display = el.style.display==='none' ? '' : 'none';
};

// Погодження пише директор і бачать усі, хто відкриє цю чернетку. Тому
// зберігаємо, хто саме сказав «нормально»: за місяць це єдиний спосіб
// зрозуміти, з ким про цю накладку розмовляти.
window.approveWarn=async function(key){
  if(currentMatrixMode==='live') return;
  const u=currentUserData||{};
  const by=((u.firstName||u.lastName)?`${u.firstName||''} ${u.lastName||''}`.trim():'')||u.email||'';
  const rec={by,ts:Date.now()};
  warnOk[key]=rec;
  window.calculateMatrixWarnings();renderMatrixGrid();
  try{
    await set(ref(db,`schedule_warn_ok/${currentMatrixMode}/${key}`),rec);
    logAction('warn_approved',{draft:currentMatrixMode,key});
  }catch(e){
    // Не змогли зберегти — повертаємо як було. Показати «погоджено» і
    // мовчки цього не зберегти означало б, що завтра попередження
    // повернеться, а людина буде впевнена, що вже все вирішила.
    delete warnOk[key];
    window.calculateMatrixWarnings();renderMatrixGrid();
    showToast('Не вдалося зберегти погодження: '+e.message);
  }
};

window.unapproveWarn=async function(key){
  if(currentMatrixMode==='live') return;
  const prev=warnOk[key];
  delete warnOk[key];
  window.calculateMatrixWarnings();renderMatrixGrid();
  try{
    await set(ref(db,`schedule_warn_ok/${currentMatrixMode}/${key}`),null);
    logAction('warn_unapproved',{draft:currentMatrixMode,key});
  }catch(e){
    if(prev) warnOk[key]=prev;
    window.calculateMatrixWarnings();renderMatrixGrid();
    showToast('Не вдалося зняти погодження: '+e.message);
  }
};
// Чи веде цей вчитель цей предмет у цьому класі за матрицею доступу.
//
// НАВІЩО. Значок 🔄 у клітинці має означати заміну — тобто урок веде не
// той, хто закріплений за предметом. Раніше ознакою було «вчителя вказано
// явно» (isOvr = !!teacherEmail), а явно він вказується завжди, коли його
// обирають у редакторі клітинки. Тому значок стояв у кожного, зокрема й у
// того, хто цей предмет і веде.
//
// Перевіряємо саме за матрицею, а не за «вчителем за замовчуванням»:
// getDefaultTeacher повертає ПЕРШОГО знайденого, тож коли предмет у класі
// ведуть двоє, другий помилково виглядав би заміною.
// Чи справді цей учитель закріплений за предметом.
//
// ВАЖЛИВО ПРО ПОРОЖНЮ МАТРИЦЮ. Якщо матриця доступу не прочиталася
// (у неї право лише в директора), тут усе виглядало б як «не закріплений»,
// і портал ставив би значок заміни 🔄 навпроти КОЖНОГО вчителя. Це не
// «невідомо» — це неправда. Незнання і відсутність — різні речі, тож
// повертаємо null: «сказати нічого не можу».
export function teacherTeaches(email, clsId, subjName){
  if(!globalTeacherAccess || !Object.keys(globalTeacherAccess).length) return null;
  const se = emailKey(email || '');
  const raw = globalTeacherAccess && globalTeacherAccess[se] && globalTeacherAccess[se][clsId];
  if(!raw) return false;
  const list = Array.isArray(raw) ? raw : Object.values(raw);
  // Пара чергування «А / Б» — учитель веде урок, якщо веде хоч один із
  // двох предметів. Без цього кожен такий урок отримував значок заміни:
  // повної назви пари в матриці доступу немає й бути не може.
  const full = String(subjName || '').trim();
  const names = (full.includes('/') ? full.split(/\s+\/\s+/) : [full])
    .map(s => s.trim().toLowerCase()).filter(Boolean);
  return list.some(x => {
    const t = String(x || '').trim().toLowerCase();
    return t === 'всі предмети' || (t && names.includes(t));
  });
}

function hasWC(row,clsId,subIdx){if(currentMatrixMode==='live')return'';const w=draftWarningsCache.find(x=>x.row===row&&x.classId===clsId&&x.subIdx===subIdx);if(!w)return'';return w.type==='conflict'?'cell-warning-conflict':'cell-warning-travel';}

// Клітинка без учителя. «—» означає «нікого не призначено», і це факт.
// Але коли матриця доступу недоступна, ми просто НЕ ЗНАЄМО, хто веде
// урок: імена звідти й беруться. Показувати в цьому випадку «—» —
// видавати незнання за факт, і саме на цьому людина втрачає час, шукаючи
// неіснуючу дірку в розкладі.
function noTeacherCell(){
  const known = globalTeacherAccess && Object.keys(globalTeacherAccess).length;
  return known
    ? '<div class="cell-teacher" style="color:var(--ink-3);">—</div>'
    : '<div class="cell-teacher" style="color:var(--warn);" data-tip="Учителя визначає матриця доступу, а вона зараз недоступна. Це не означає, що вчителя не призначено.">?</div>';
}

function rsmcc(lesson,dTName,isOvr,clsId,row,si){const sn=typeof lesson.subject==='string'?lesson.subject:(lesson.subject.ua||'');const ts=lesson.time||'';const isB=isBreakItem(lesson);const isX=lesson.type==='extra';const sl=JSON.stringify(lesson).replace(/&/g,"&amp;").replace(/'/g,"&apos;").replace(/"/g,"&quot;");const oc=`event.stopPropagation();openCellEditor('${clsId}',${row},${si},${sl})`;const wc=hasWC(row,clsId,si);if(isB)return`<div class="matrix-cell cell-break" role="button" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click()}" onclick="${oc}"><div class="cell-subj">${escHtml(sn)}</div><div class="cell-time">${escHtml(ts)}</div></div>`;if(isX){let xi='';if(lesson.extraData){if(lesson.extraData.format==='individual')xi=`<div class="cell-student-linked">👤${escHtml(lesson.extraData.student||'')}</div>`;else xi=`<div class="cell-student-linked" style="background:var(--surface-2);color:var(--brand-ink);">👥Група</div>`;}const th=dTName?`<div class="cell-teacher">👨‍🏫${escHtml(dTName)}${isOvr?' <span data-tip="Веде не той, хто закріплений за предметом — заміна">🔄</span>':''}</div>`:noTeacherCell();return`<div class="matrix-cell cell-club ${wc}" role="button" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click()}" onclick="${oc}"><div class="cell-subj">🎸${escHtml(sn)}</div>${th}${xi}<div class="cell-time">🕘${escHtml(ts)}</div></div>`;}const th=dTName?`<div class="cell-teacher">👨‍🏫${escHtml(dTName)}${isOvr?' <span data-tip="Веде не той, хто закріплений за предметом — заміна">🔄</span>':''}</div>`:noTeacherCell();return`<div class="matrix-cell cell-lesson ${wc}" role="button" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click()}" onclick="${oc}"><div class="cell-subj">${escHtml(sn)}</div>${th}<div class="cell-time">🕘${escHtml(ts)}</div></div>`;}
// Класні години цього дня — рядком під сіткою.
//
// ЧОМУ РЯДКОМ, А НЕ КЛІТИНКОЮ В СІТЦІ. Сітка редагована: натискання на
// клітинку відкриває редактор і пише в schedules. Класна година там не
// живе, тож підроблена клітинка або мовчки загубилася б при збереженні,
// або, гірше, потрапила б у розклад і зникла з першим імпортом.
window.renderClassHourNote=function(day){
  const box=document.getElementById('matrix-hours-note');
  if(!box)return;
  const all=window.allClassHours||{};
  const list=[];
  for(let i=1;i<=11;i++){
    const h=all[`class_${i}`];
    if(h&&h.day===day&&h.time) list.push(`${i} кл. — ${h.time}`);
  }
  box.style.display=list.length?'block':'none';
  box.innerHTML=list.length
    ? `🕘 <b>Класні години цього дня:</b> ${escHtml(list.join(' · '))}<br>
       <span style="color:var(--ink-3);">Їх немає в сітці — вони зберігаються окремо від розкладу. Не ставте на цей час уроки.</span>`
    : '';
};

window.renderMatrixGrid=function(){const day=document.getElementById('matrix-day-select').value;window.renderClassHourNote(day);const th=document.getElementById('matrix-thead-row');const tb=document.getElementById('matrix-tbody');th.innerHTML='<th class="time-col">№/Час</th>';for(let i=1;i<=11;i++)th.innerHTML+=`<th>${i} Кл</th>`;tb.innerHTML='';let maxR=8;for(let i=1;i<=11;i++){const cls=`class_${i}`;maxR=Math.max(maxR,dayArr(globalAllSchedules[cls]?.lessons?.[day]).length);}maxR+=1;let lc=1;for(let row=0;row<maxR;row++){let tr=document.createElement('tr');let bc=0;let lsc=0;for(let c=1;c<=11;c++){const clsId=`class_${c}`;const la=dayArr(globalAllSchedules[clsId]?.lessons?.[day]);const raw=la[row];let items=Array.isArray(raw)?raw:(raw&&raw.subject?[raw]:[]);items.forEach(l=>{if(l&&l.subject){if(isBreakItem(l))bc++;else lsc++;}});}const isB=bc>0&&bc>=lsc;const isE=bc===0&&lsc===0;if(isB)tr.innerHTML='<td class="time-col" style="background:var(--accent-soft);color:var(--accent-ink);">☕</td>';else if(isE)tr.innerHTML='<td class="time-col" style="color:var(--ink-3);font-size:1.1rem;">+</td>';else tr.innerHTML=`<td class="time-col">Ур.${lc++}</td>`;for(let c=1;c<=11;c++){const clsId=`class_${c}`;const la=dayArr(globalAllSchedules[clsId]?.lessons?.[day]);const raw=la[row];let items=Array.isArray(raw)?raw:(raw&&raw.subject?[raw]:[]);let td=document.createElement('td');let h='';if(items.length>0){h+=`<div class="matrix-cell-container">`;items.forEach((lesson,si)=>{const sn=typeof lesson.subject==='string'?lesson.subject:(lesson.subject.ua||'');const te=lesson.teacherEmail||'';let dn=lesson.teacherName||'';let isOvr=false;const isB2=isBreakItem(lesson);if(!isB2){if(!te&&sn){const dt=lesson.type==='extra'?window.getClubTeacher?.(clsId,sn):window.getDefaultTeacher(clsId,sn);if(dt)dn=dt.name;
        // Урок-чергування: повної назви «А / Б» немає в жодному
        // довіднику, тож шукаємо вчителя окремо для кожного предмета пари.
        else{const al=window.altTeacherLabel(clsId,lesson);if(al)dn=al;}}
        else if(te){const known=teacherTeaches(te,clsId,sn);isOvr=(known===false);}
        // Матриці доступу може не бути — тоді підставити ім'я нема звідки.
        // Але воно могло зберегтися в самому уроці, коли розклад складали.
        if(!dn&&lesson.teacherName)dn=lesson.teacherName;}h+=rsmcc(lesson,dn,isOvr,clsId,row,si);});h+=`<div class="add-parallel-btn" role="button" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click()}" onclick="event.stopPropagation();openCellEditor('${clsId}',${row},null,null)">+Паралельний</div>`;h+=`</div>`;}else h=`<div class="matrix-cell cell-empty" role="button" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click()}" onclick="openCellEditor('${clsId}',${row},null,null)">+ Додати</div>`;td.innerHTML=h;tr.appendChild(td);}tb.appendChild(tr);}};
// Тип клітинки міняє не лише підписи, а й ЩО саме пропонується у списку:
// предмети класу для уроку, назви перерв для перерви. Раніше сюди просто
// вписувався рядок — тепер це список, тож його треба перебудувати.
window.toggleCellType=async function(){
  const t=document.getElementById('cell-type-select').value;
  const tw=document.getElementById('cell-teacher-wrapper');
  const si=document.getElementById('cell-subj-ua');
  const ni=document.getElementById('cell-number');
  const sl=document.getElementById('cell-subj-label');
  const ew=document.getElementById('cell-extra-wrapper');
  const cls=document.getElementById('cell-edit-class').value;
  let cur=si.value==='__other__'?'':si.value;
  const isBreakName=/перерва|обід/i.test(cur);
  if(t==='break'){
    tw.style.display='none';ew.style.display='none';sl.innerText='Назва перерви:';
    if(!isBreakName)cur='Перерва';
    ni.value='';ni.disabled=true;
  }else if(t==='extra'){
    tw.style.display='block';ew.style.display='block';sl.innerText='Назва гуртка:';
    if(isBreakName)cur='';
    ni.disabled=false;toggleExtraFormat();
  }else{
    tw.style.display='block';ew.style.display='none';sl.innerText='Назва предмету:';
    if(isBreakName)cur='';
    ni.disabled=false;
  }
  await window.fillCellSubjects(cls,cur,t);
  if(document.getElementById('cell-type-select').value!==t||document.getElementById('cell-edit-class').value!==cls)return;
  const teacherSelect=document.getElementById('cell-teacher-select');
  window.updateCellEditorTeacherOptions(cls,cur,teacherSelect.value);
  // Чергування можливе лише для уроку, і саме toggleCellAlt ховає галочку
  // на перерві та гуртку. Викликаємо ПІСЛЯ fillCellSubjects: другий список
  // будується з тих самих предметів класу мінус уже обраний перший.
  await window.toggleCellAlt();
  window.triggerSmartCheck();
};
window.toggleExtraFormat=function(){const f=document.getElementById('cell-extra-format').value;document.getElementById('extra-individual-wrap').style.display=f==='individual'?'block':'none';document.getElementById('extra-group-wrap').style.display=f==='group'?'block':'none';if(f==='group')toggleExtraGroupType();};
window.toggleExtraGroupType=function(){const gt=document.getElementById('extra-group-type').value;document.getElementById('extra-group-classes-wrap').style.display=gt==='classes'?'block':'none';document.getElementById('extra-group-students-wrap').style.display=gt==='students'?'block':'none';};
// Назви перерв каталогом не керуються: «Обід 1-3 класи» — це не предмет
const BREAK_NAMES = ['Перерва', 'Велика перерва', 'Обід'];
let cellSubjectsGeneration=0;

// Наповнити список предметів. current лишаємо в переліку, навіть якщо
// його немає в каталозі: інакше, відкривши старий урок, директор мовчки
// втратив би назву, щойно натиснув «Зберегти».
window.fillCellSubjects = async function(clsId, current, type){
  const sel = document.getElementById('cell-subj-ua');
  if(!sel) return;
  const gen=++cellSubjectsGeneration;
  let names = [];
  if(type === 'break') names = BREAK_NAMES.slice();
  else if(type==='extra'&&window.clubCatalogNames){try{names=await window.clubCatalogNames(clsId);}catch(e){names=[];}}
  else if(type!=='extra'&&window.catalogNames) { try{ names = await window.catalogNames(clsId); }catch(e){ names = []; } }
  if(gen!==cellSubjectsGeneration)return;
  if(current && !names.includes(current)) names = [current, ...names];
  const empty = type === 'break' ? '— оберіть назву —'
    : (names.length ? (type==='extra'?'— оберіть гурток —':'— оберіть предмет —') : '— каталог порожній —');
  sel.innerHTML = `<option value="">${empty}</option>`
    + names.map(n => `<option value="${escHtml(n)}">${escHtml(n)}</option>`).join('')
    + `<option value="__other__">${type==='extra'?'➕ Створити новий гурток…':'➕ Інший…'}</option>`;
  sel.value = current || '';
  const hint = document.getElementById('cell-subj-hint');
  if(hint) hint.textContent = (type === 'break' || names.length)
    ? '' : type==='extra'?'Заповніть «🎨 Гуртки класу й учителі» або додайте через «Інший…».':'Каталог цього класу порожній. Заповніть «📗 Предмети класу й учителі» або додайте через «Інший…».';
};

// ── ЧЕРГУВАННЯ УРОКІВ У КОНСТРУКТОРІ ────────────────────────────
//
// ЩО ЦЕ. «Музичне мистецтво / Фізичне виховання» — один урок у сітці,
// але цього тижня одне, наступного інше. У базі це ОДИН запис із полем
// alt:['Музичне мистецтво','Фізичне виховання'] і парною назвою в
// subject. Такий самий запис робить імпорт із Word, тож обидва джерела
// дають однакову структуру, і читає її одна функція — altOptions.
//
// ЧОМУ ДВА ПОЛЯ, А НЕ ОДИН РЯДОК ЧЕРЕЗ КОСУ. Коса риска заборонена в
// ключах Firebase, тому предмет із нею не заводиться в каталог класу: за
// ним нема кому призначити вчителя, і журналу в нього теж нема. Раніше
// конструктор просто відмовлявся зберігати таку назву, і чергування
// можна було завести хіба що імпортом документа. Тепер пара збирається з
// двох справжніх предметів каталогу, а коса лишається тільки в тому, що
// бачить людина.
let cellAltGeneration=0;

// Другий предмет пари. Список той самий, що й у першого поля — це
// звичайні предмети класу. Сам із собою предмет не чергується, тому вже
// обраний перший із переліку прибираємо.
async function fillAltSubjects(clsId, current){
  const sel=document.getElementById('cell-subj-alt');
  if(!sel) return;
  const gen=++cellAltGeneration;
  let names=[];
  if(window.catalogNames){ try{ names=await window.catalogNames(clsId); }catch(e){ names=[]; } }
  if(gen!==cellAltGeneration) return;
  const first=(document.getElementById('cell-subj-ua').value||'').trim();
  names=names.filter(n=>n!==first);
  if(current&&!names.includes(current)) names=[current,...names];
  sel.innerHTML=`<option value="">${names.length?'— оберіть другий предмет —':'— каталог порожній —'}</option>`
    +names.map(n=>`<option value="${escHtml(n)}">${escHtml(n)}</option>`).join('')
    +`<option value="__other__">➕ Інший…</option>`;
  sel.value=current||'';
}

// Показати/сховати другий предмет. forceAlt — коли назву щойно створили
// й у списку її ще немає (див. handleSubjInput і handleAltSubjInput).
window.toggleCellAlt=async function(forceAlt){
  const box=document.getElementById('cell-alt-on');
  const wrap=document.getElementById('cell-alt-wrapper');
  const lbl=document.getElementById('cell-alt-toggle');
  const hint=document.getElementById('cell-alt-hint');
  const ts=document.getElementById('cell-teacher-select');
  if(!box||!wrap||!lbl||!ts) return;
  const type=document.getElementById('cell-type-select').value;
  const cls=document.getElementById('cell-edit-class').value;
  // Чергуватися можуть тільки уроки: перерва й гурток пари не утворюють
  if(type!=='lesson'){ lbl.style.display='none'; box.checked=false; }
  else lbl.style.display='flex';
  const on=type==='lesson'&&box.checked;
  wrap.style.display=on?'block':'none';
  const sel=document.getElementById('cell-subj-alt');
  if(on){
    const cur=forceAlt||(sel&&sel.value==='__other__'?'':(sel?sel.value:''));
    await fillAltSubjects(cls,cur);
  }
  const first=(document.getElementById('cell-subj-ua').value||'').trim();
  const second=on&&sel?(sel.value==='__other__'?'':sel.value.trim()):'';
  // Учителя показуємо за парою: altTeacherLabel розбере назву через косу
  // і візьме по вчителю на кожен предмет із каталогу класу.
  window.updateCellEditorTeacherOptions(cls, on&&second?`${first} / ${second}`:first, on?'':ts.value);
  if(on){
    // ЧОМУ «АВТО» І БЕЗ ВИБОРУ. Поле teacherEmail у записі одне, а
    // предмети два. Один учитель, записаний на пару, пів року стояв би
    // в розкладі не на своєму уроці. Тому вчителя кожного предмета
    // портал бере з каталогу класу — там він свій у кожного.
    ts.value=''; ts.disabled=true;
    hint.innerHTML='Учителя кожного предмета портал бере з каталогу «📗 Предмети класу й учителі» — тут його не обирають.<br>Який предмет буде цього тижня, позначають у картці «🔁 Чергування уроків».';
  }else{
    ts.disabled=false;
    hint.textContent='';
  }
};

window.handleAltSubjInput=async function(){
  const c=document.getElementById('cell-edit-class').value;
  const sel=document.getElementById('cell-subj-alt');
  let forced='';
  if(sel.value==='__other__'){
    const name=(prompt('Назва другого предмета пари:','')||'').trim();
    if(!name){ sel.value=''; await window.toggleCellAlt(); return; }
    if(window.addCatalogSubject && !await window.addCatalogSubject(c,name)){ sel.value=''; await window.toggleCellAlt(); return; }
    forced=name;
  }
  await window.toggleCellAlt(forced);
  window.triggerSmartCheck();
};

window.handleSubjInput=async function(){
  const c=document.getElementById('cell-edit-class').value;
  const sel=document.getElementById('cell-subj-ua');
  const type=document.getElementById('cell-type-select').value;
  if(sel.value === '__other__'){
    if(type==='extra'){
      sel.value='';
      if(window.openQuickClubCreator)await window.openQuickClubCreator();
      else showToast('Модуль каталогу гуртків не завантажено. Оновіть сторінку.');
      return;
    }
    const name=(prompt(type==='break'?'Назва перерви:':type==='extra'?'Назва нового гуртка:':'Назва нового предмета:','')||'').trim();
    if(!name){ sel.value=''; return; }
    // «Музика / Фізкультура» — це не назва предмета, а ДВА предмети.
    // Раніше конструктор на такий рядок просто лаявся («не можна /»), і
    // чергування лишалося доступним тільки через імпорт документа. Тепер
    // пара розкладається по двох полях, обидва предмети окремо йдуть у
    // каталог класу, а галочка чергування вмикається сама.
    const pair = type==='lesson' ? splitAltName(name) : null;
    if(pair){
      if(window.addCatalogSubject) for(const part of pair) await window.addCatalogSubject(c, part);
      await window.fillCellSubjects(c, pair[0], type);
      const box=document.getElementById('cell-alt-on');
      if(box) box.checked=true;
      await window.toggleCellAlt(pair[1]);
      window.triggerSmartCheck();
      return;
    }
    // Новий предмет одразу лягає в каталог — інакше наступного разу
    // його знову довелося б вписувати руками, і розбіжності повернулися б
    if(type==='lesson' && window.addCatalogSubject) await window.addCatalogSubject(c, name);
    await window.fillCellSubjects(c, name, type);
  }
  const s=sel.value.trim();
  const ts=document.getElementById('cell-teacher-select');
  window.updateCellEditorTeacherOptions(c,s,ts.value);
  // Перший предмет змінився — другий список треба перебрати, щоб той
  // самий предмет не опинився обома половинами пари.
  await window.toggleCellAlt();
  window.triggerSmartCheck();
};
window.updateCellEditorTeacherOptions=function(clsId,sName,curE){const ts=document.getElementById('cell-teacher-select');const isClub=document.getElementById('cell-type-select').value==='extra';const dt=isClub?window.getClubTeacher?.(clsId,sName):window.getDefaultTeacher(clsId,sName);
  // Для пари чергування «Авто» — це двоє вчителів, по одному на предмет
  const auto=dt?dt.name:(isClub?'—':window.altTeacherLabel(clsId,{subject:sName})||'—');
  ts.innerHTML=`<option value="">-- Авто (${escHtml(auto)}) --</option>`;window.globalTeachersList.forEach(t=>ts.innerHTML+=`<option value="${escHtml(t.email)}">${escHtml(t.name)} (${escHtml(t.email)})</option>`);if(curE&&Array.from(ts.options).some(o=>o.value===curE))ts.value=curE;else ts.value='';};
window.triggerSmartCheck=function(){if(currentMatrixMode==='live')return;const te=document.getElementById('cell-teacher-select').value;const wb=document.getElementById('cell-live-warnings');if(!te){wb.style.display='none';return;}const day=document.getElementById('matrix-day-select').value;const clsId=document.getElementById('cell-edit-class').value;const tB=parseInt(clsId.replace('class_',''))<=5?1:2;const row=parseInt(document.getElementById('cell-edit-row').value);let conf=[];let trav=[];for(let c=1;c<=11;c++){let cc=`class_${c}`;if(cc===clsId)continue;let b=c<=5?1:2;let da=dayArr(globalAllSchedules[cc]?.lessons?.[day]);let ss=da[row];let si=Array.isArray(ss)?ss:(ss?[ss]:[]);si.forEach(item=>{if(item.type!=='break'&&item.teacherEmail===te)conf.push(`Накладка: ${c} клас!`);});[row-1,row+1].forEach(nr=>{if(nr<0)return;let ns=da[nr];let ni=Array.isArray(ns)?ns:(ns?[ns]:[]);ni.forEach(item=>{if(item.type!=='break'&&item.teacherEmail===te&&b!==tB)trav.push(`Переїзд: ${c} клас`);});});}if(conf.length>0||trav.length>0){let h=conf.length>0?`<div style="color:var(--danger);font-weight:700;">❌ ${conf[0]}</div>`:'';if(trav.length>0)h+=`<div style="color:var(--warn);font-weight:700;">⚠️ ${trav[0]}</div>`;wb.innerHTML=h;wb.style.display='block';wb.style.background=conf.length>0?'var(--danger-soft)':'var(--warn-soft)';wb.style.border=`1px solid ${conf.length>0?'var(--danger)':'var(--warn)'}`;}else{wb.innerHTML='<div style="color:var(--ok);font-weight:700;">✅ Вільний, переїзд не потрібен.</div>';wb.style.display='block';wb.style.background='var(--surface-2)';wb.style.border='1px solid var(--ok-line)';}};
// Поставити значення в <select> ДО того, як список перебудують.
//
// Списки предметів наповнюються асинхронно (fillCellSubjects чекає на
// каталог класу), а при відкритті вікна в них ще лежать варіанти з
// минулого разу. Присвоєння sel.value назві, якої серед них немає,
// браузер мовчки ігнорує — і toggleCellType потім читав порожньо, тобто
// відкритий урок втрачав свою назву. Тому спершу дописуємо потрібний
// варіант, а вже тоді обираємо.
function presetCellSelect(sel, val){
  if(!sel) return;
  const v=val||'';
  if(v && !Array.from(sel.options).some(o=>o.value===v))
    sel.insertAdjacentHTML('afterbegin', `<option value="${escHtml(v)}">${escHtml(v)}</option>`);
  sel.value=v;
}
let cellEditorReturnFocus=null;
window.openCellEditor=async function(clsId,rowIdx,subIdx,lessonObj){
  cellEditorReturnFocus=document.activeElement;
  // Підказки з назв, які вже вживає цей клас: щоб «English» і «english»
  // не стали двома різними предметами з двома різними журналами
  // Список предметів беремо з каталогу класу на поточний навчальний рік
  const isArt=currentUserData?.role==='art_school_teacher';
  if(isArt&&lessonObj){const sn=typeof lessonObj.subject==='string'?lessonObj.subject:(lessonObj.subject.ua||'');const t=lessonObj.type||(sn.toLowerCase().includes('перерва')?'break':'lesson');if(t!=='extra'||lessonObj.teacherEmail!==currentUserData.email){alert("⛔ Тільки власні заняття.");return;}}
  document.getElementById('edit-cell-modal').style.display='flex';document.getElementById('cell-live-warnings').style.display='none';
  document.getElementById('cell-type-select').focus();
  const day=document.getElementById('matrix-day-select').value;document.getElementById('edit-cell-subtitle').innerText=`${clsId.replace('class_','')} Клас | ${dayNamesUA[day]} | Слот ${rowIdx+1}`;
  document.getElementById('cell-edit-class').value=clsId;document.getElementById('cell-edit-row').value=rowIdx;document.getElementById('cell-edit-subindex').value=subIdx!==null?subIdx:'';
  const is=document.getElementById('extra-ind-student');const gc=document.getElementById('extra-group-classes');const gs=document.getElementById('extra-group-students');
  is.innerHTML='<option value="">-- Учень --</option>';gc.innerHTML='';gs.innerHTML='';
  for(let i=1;i<=11;i++){const cId=`class_${i}`;gc.innerHTML+=`<option value="${cId}">${i} Клас</option>`;if(globalAllStudents[cId]){const og1=document.createElement('optgroup');og1.label=`${i} Клас`;const og2=document.createElement('optgroup');og2.label=`${i} Клас`;Object.values(globalAllStudents[cId]).sort().forEach(st=>{og1.innerHTML+=`<option value="${st}">${st}</option>`;og2.innerHTML+=`<option value="${st}">${st}</option>`;});is.appendChild(og1);gs.appendChild(og2.cloneNode(true));}}
  // Відкриваємо урок, що чергується: у полях мають стояти ДВА предмети
  // окремо, а не парний рядок через косу. altOptions розбере і новий
  // запис із alt, і старий, де пара лишилася просто в назві.
  const altOpts=lessonObj?altOptions(lessonObj):null;
  const altBox=document.getElementById('cell-alt-on');
  if(altBox) altBox.checked=!!(altOpts&&altOpts.length>1);
  presetCellSelect(document.getElementById('cell-subj-alt'), altOpts&&altOpts.length>1?altOpts[1]:'');
  let sn='';const ts=document.getElementById('cell-type-select');
  if(lessonObj){sn=(altOpts&&altOpts.length>1)?altOpts[0]:(typeof lessonObj.subject==='string'?lessonObj.subject:(lessonObj.subject.ua||''));presetCellSelect(document.getElementById('cell-subj-ua'),sn);document.getElementById('cell-number').value=lessonObj.number||'';document.getElementById('cell-time').value=lessonObj.time||'';const isB=sn.toLowerCase().includes('перерва')||sn.toLowerCase().includes('обід');ts.value=lessonObj.type||(isB?'break':'lesson');if(lessonObj.type==='extra'&&lessonObj.extraData){document.getElementById('cell-extra-format').value=lessonObj.extraData.format||'group';if(lessonObj.extraData.format==='individual')setTimeout(()=>document.getElementById('extra-ind-student').value=lessonObj.extraData.student||'',50);else{document.getElementById('extra-group-type').value=lessonObj.extraData.groupType||'classes';}}}
  else{presetCellSelect(document.getElementById('cell-subj-ua'),'');document.getElementById('cell-number').value='';document.getElementById('cell-time').value='';ts.value=isArt?'extra':'lesson';}
  if(isArt)Array.from(ts.options).forEach(o=>o.disabled=(o.value!=='extra'));else Array.from(ts.options).forEach(o=>o.disabled=false);
  window.updateCellEditorTeacherOptions(clsId,sn,lessonObj?lessonObj.teacherEmail:'');await toggleCellType();if(currentMatrixMode!=='live')window.triggerSmartCheck();
};

// ── РЯДКИ РОЗКЛАДУ ──────────────────────────────────────────────
// Перерву не можна «дописати» в клітинку: у дні вона займає власний
// рядок, і все, що нижче, має з'їхати. Без цих кнопок школі довелося б
// перескладати день заново, щоб додати одну перерву.
async function writeDay(clsId, day, arr){
  const dp = currentMatrixMode === 'live' ? 'schedules' : `schedule_drafts/${currentMatrixMode}`;
  if(!globalAllSchedules[clsId]) globalAllSchedules[clsId] = {};
  if(!globalAllSchedules[clsId].lessons) globalAllSchedules[clsId].lessons = {};
  globalAllSchedules[clsId].lessons[day] = arr;
  await set(ref(db, `${dp}/${clsId}/lessons/${day}`), arr);
  if(currentMatrixMode !== 'live') window.calculateMatrixWarnings();
  renderMatrixGrid();
}

// where: 'above' | 'below'; what: 'break' | 'empty'
window.insertMatrixRow = async function(where, what){
  const clsId = document.getElementById('cell-edit-class').value;
  const ri = parseInt(document.getElementById('cell-edit-row').value);
  const day = document.getElementById('matrix-day-select').value;
  if(currentMatrixMode === 'live' && !liveEditConfirmed){
    if(!confirm('Ви змінюєте ЧИННИЙ розклад школи.\n\nЗміна одразу зʼявиться в кабінетах '
      + 'батьків і вчителів, і скасувати її автоматично не вийде.\n\nПродовжити?')) return;
    liveEditConfirmed = true;
  }
  const cur = dayArr(globalAllSchedules[clsId]?.lessons?.[day]);
  const at = where === 'above' ? ri : ri + 1;
  let slot = {};
  if(what === 'break'){
    // Час перерви пропонуємо з проміжку між сусідніми уроками, якщо він є
    const prev = slotBounds(cur[at - 1]), next = slotBounds(cur[at]);
    let time = '', label = 'Перерва';
    if(prev && next && next.start > prev.end){
      const gap = next.start - prev.end;
      time = `${hhmmFromMins(prev.end)} - ${hhmmFromMins(next.start)}`;
      label = `Перерва ${gap} хв`;
    }
    const name = prompt('Назва перерви:', label);
    if(name === null) return;
    const t = prompt('Час (напр. 11:35 - 11:55). Можна лишити порожнім:', time);
    if(t === null) return;
    slot = [ makeBreak(normalizeTimeRange(t), name.trim() || 'Перерва') ];
  }
  await writeDay(clsId, day, insertSlot(cur, at, slot));
  closeEditCellModal();
  showToast(what === 'break' ? '✅ Перерву вставлено' : '✅ Рядок вставлено');
};

window.deleteMatrixRow = async function(){
  const clsId = document.getElementById('cell-edit-class').value;
  const ri = parseInt(document.getElementById('cell-edit-row').value);
  const day = document.getElementById('matrix-day-select').value;
  if(!confirm(`Прибрати рядок ${ri + 1} цілком?\n\nУсе, що нижче, підніметься на один рядок вгору.`)) return;
  const cur = dayArr(globalAllSchedules[clsId]?.lessons?.[day]);
  await writeDay(clsId, day, removeSlot(cur, ri));
  closeEditCellModal();
  showToast('🗑️ Рядок прибрано');
};

// Один день класу — розставити перерви за проміжками в часі уроків
window.autoBreaksForDay = async function(){
  const clsId = document.getElementById('cell-edit-class').value;
  const day = document.getElementById('matrix-day-select').value;
  const cur = dayArr(globalAllSchedules[clsId]?.lessons?.[day]);
  const next = withBreaks(cur);
  const added = next.length - cur.length;
  if(!added) return alert('Проміжків між уроками не знайдено.\n\n'
    + 'Перерви розставляються за часом уроків: якщо час не заповнений або уроки йдуть впритул, вставляти нема чого.');
  if(!confirm(`Додати перерв: ${added}?\n\nЧас візьмемо з проміжків між уроками цього дня.`)) return;
  await writeDay(clsId, day, next);
  closeEditCellModal();
  showToast(`✅ Додано перерв: ${added}`);
};

window.closeEditCellModal=function(){
  const modal=document.getElementById('edit-cell-modal');
  modal.style.display='none';
  const previous=cellEditorReturnFocus;cellEditorReturnFocus=null;
  setTimeout(()=>{
    if(modal.style.display!=='none')return;
    if(previous?.isConnected && previous!==document.body)previous.focus();
    else document.getElementById('matrix-day-select')?.focus();
  },0);
};
document.getElementById('edit-cell-modal').addEventListener('keydown',e=>{
  if(e.key==='Escape'){
    e.preventDefault();e.stopPropagation();window.closeEditCellModal();return;
  }
  if(e.key!=='Tab')return;
  const modal=document.getElementById('edit-cell-modal');
  const items=[...modal.querySelectorAll('button,input:not([type="hidden"]),select,textarea,[tabindex]:not([tabindex="-1"])')]
    .filter(el=>!el.disabled&&el.getClientRects().length);
  if(!items.length)return;
  if(e.shiftKey&&document.activeElement===items[0]){e.preventDefault();items[items.length-1].focus();}
  else if(!e.shiftKey&&document.activeElement===items[items.length-1]){e.preventDefault();items[0].focus();}
});
window.saveMatrixCell=async function(){
  const clsId=document.getElementById('cell-edit-class').value;const ri=parseInt(document.getElementById('cell-edit-row').value);const sis=document.getElementById('cell-edit-subindex').value;const day=document.getElementById('matrix-day-select').value;
  const type=document.getElementById('cell-type-select').value;const subj=document.getElementById('cell-subj-ua').value.trim();const time=normalizeTimeRange(document.getElementById('cell-time').value);   /* «13:55-14:40» і «13:55 - 14:40» — той самий урок. Різнобій у базі колись зламав кабінет 5 класу: кінець уроку не розбирався, і день «закінчувався» за останньою перервою. */const num=type==='break'?'':document.getElementById('cell-number').value.trim();
  const ts=document.getElementById('cell-teacher-select');const clubDefault=type==='extra'&&!ts.value?window.getClubTeacher?.(clsId,subj):null;const te=type==='break'?'':ts.value||clubDefault?.email||'';const tn=clubDefault?.name||(te?ts.options[ts.selectedIndex].text.split(' (')[0]:'');
  let ed=null;if(type==='extra'){const fmt=document.getElementById('cell-extra-format').value;ed={format:fmt};if(fmt==='individual')ed.student=document.getElementById('extra-ind-student').value;else{ed.groupType=document.getElementById('extra-group-type').value;const opts=ed.groupType==='classes'?document.getElementById('extra-group-classes').selectedOptions:document.getElementById('extra-group-students').selectedOptions;ed[ed.groupType==='classes'?'classes':'students']=Array.from(opts).map(o=>o.value);}}
  // ЧЕРГУВАННЯ. Зберігаємо рівно в тому вигляді, у якому його пише імпорт
  // із Word: одна клітинка, subject — парний рядок через косу (його бачать
  // люди і старі версії кабінету), alt — два справжніх предмети каталогу
  // (за ними працюють журнал, каталог, навантаження й картка чергування).
  const altOn=type==='lesson'&&document.getElementById('cell-alt-on').checked;
  const subj2=altOn?document.getElementById('cell-subj-alt').value.trim():'';
  if(altOn&&(!subj||!subj2)){alert('Для чергування потрібні обидва предмети — або зніміть галочку «Уроки чергуються».');return;}
  if(altOn&&subj2===subj){alert('Предмети пари мають бути різні.');return;}
  const display=altOn?`${subj} / ${subj2}`:subj;
  const nc={number:num,time,subject:{ua:display,pl:display},teacherEmail:te,teacherName:tn,type,extraData:ed};
  if(altOn) nc.alt=[subj,subj2];
  let tClasses=[clsId];if(type==='extra'&&ed?.format==='group'){if(ed.groupType==='classes'&&ed.classes?.length>0)tClasses=ed.classes;else if(ed.groupType==='students'&&ed.students?.length>0){let ac=new Set();ed.students.forEach(st=>{for(let c in globalAllStudents)if(Object.values(globalAllStudents[c]).includes(st)){ac.add(c);break;}});if(ac.size>0)tClasses=Array.from(ac);}}
  const dp=currentMatrixMode==='live'?'schedules':`schedule_drafts/${currentMatrixMode}`;
  // Чинний розклад видно всій школі, а історії змін портал не веде —
  // відкотити правку нема чим. Питаємо один раз за відкриття вікна.
  if(currentMatrixMode==='live' && !liveEditConfirmed){
    if(!confirm('Ви змінюєте ЧИННИЙ розклад школи.\n\n'
      + 'Зміна одразу зʼявиться в кабінетах батьків і вчителів. Скасувати її автоматично '
      + 'не вийде — портал не зберігає попередніх версій розкладу.\n\n'
      + 'Якщо ви готуєте новий розклад — краще робити це в чернетці.\n\nПродовжити?')) return;
    liveEditConfirmed=true;
  }
  try{for(let tc of tClasses){if(!globalAllSchedules[tc])globalAllSchedules[tc]={};if(!globalAllSchedules[tc].lessons)globalAllSchedules[tc].lessons={};if(!globalAllSchedules[tc].lessons[day])globalAllSchedules[tc].lessons[day]=[];let da=dayArr(globalAllSchedules[tc].lessons[day]);globalAllSchedules[tc].lessons[day]=da;while(da.length<=ri)da.push({});let es=da[ri];let si2=Array.isArray(es)?[...es]:(es&&es.subject?[es]:[]);if(sis!=='')si2[parseInt(sis)]={...nc};else si2.push({...nc});da[ri]=si2;await set(ref(db,`${dp}/${tc}/lessons/${day}`),da);}
  if(te&&subj&&type!=='break'&&currentMatrixMode==='live'){const se=emailKey(te);for(let tc of tClasses){const as=await get(child(ref(db),`teacher_access/${se}/${tc}`));let ca=as.exists()?as.val():[];if(!Array.isArray(ca))ca=Object.values(ca);if(!ca.includes("Всі предмети")&&!ca.includes(subj)){ca.push(subj);await set(ref(db,`teacher_access/${se}/${tc}`),ca);}}}
  closeEditCellModal();if(currentMatrixMode!=='live')window.calculateMatrixWarnings();renderMatrixGrid();showToast("✅ Збережено!");}catch(e){alert("Помилка: "+e.message);}};
window.deleteMatrixCell=async function(){const clsId=document.getElementById('cell-edit-class').value;const ri=parseInt(document.getElementById('cell-edit-row').value);const sis=document.getElementById('cell-edit-subindex').value;const day=document.getElementById('matrix-day-select').value;const dp=currentMatrixMode==='live'?'schedules':`schedule_drafts/${currentMatrixMode}`;if(globalAllSchedules[clsId]?.lessons?.[day]){let da=dayArr(globalAllSchedules[clsId].lessons[day]);let es=da[ri];let si2=Array.isArray(es)?[...es]:(es&&es.subject?[es]:[]);if(sis!=='')si2.splice(parseInt(sis),1);da[ri]=si2.length===0?{}:si2;await set(ref(db,`${dp}/${clsId}/lessons/${day}`),da);closeEditCellModal();if(currentMatrixMode!=='live')window.calculateMatrixWarnings();renderMatrixGrid();showToast("🗑️ Видалено!");}};
