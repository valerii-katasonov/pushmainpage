// ═══════════════════════════════════════════════════════════════
// director.js — everything only ever triggered from director-screen:
// Smart Matching (substitute finder), teacher skill matrix, schedule
// drafts constructor, teacher access matrix, staff management, and
// the director's grade statistics / dashboard.
// (Class Teacher Assignment lives in curriculum.js — see that file's
// header for why.)
// ═══════════════════════════════════════════════════════════════
import { ref, set, get, child, push, remove, update, query, limitToLast } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, showToast, getClassNum, displayGrade, gradeClass6, teacherAccessMatrix, getWeekDates, formatAttendanceSlotLabel, gradeTypesCache, loadGradeTypesCache, calculateStudentWeightedAvg, escJs, escHtml, localDateString, normalizeRoles, getUserRoles, ROLE_LABELS, currentUserData, dayNamesUA, sendPasswordReset, normalizeChildren, renderParentsBlock, logAction, AUDIT_LABELS, getParentProfile, parentFullName, getSchoolRange, getAllUsers, invalidateUsersCache, getUsersSnap, stuName, invalidateStudentDir, subjectsLabel, syncStaffCard, shrinkImage , dayKeys} from './common.js';

let directorSkillsTemp=[];

// ══════════ SMART MATCHING (Director) ══════════
window.findSubstitute=async function(){
  const cls=document.getElementById('sm-class').value;const subj=document.getElementById('sm-subject').value.trim();
  const date=document.getElementById('sm-date').value;const time=document.getElementById('sm-time').value.trim();
  const results=document.getElementById('sm-results');
  if(!cls||!subj||!date){results.innerHTML='<p style="color:var(--red);font-size:.85rem;">⚠️ Заповніть усі поля!</p>';return;}
  results.innerHTML='<p style="font-size:.85rem;">🔍 Пошук...</p>';
  const [skillsSnap,usersSnap,attSnap]=await Promise.all([
    get(ref(db,'teacher_skills')),getUsersSnap(),get(ref(db,`attendance/ALL/${date}`))
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
// Пишемо в тому самому форматі, що й розділ «Відсутність і заміни»
// (substitutions/{дата}/{клас}/{слот}) — інакше призначена звідси заміна
// ніде б не показалася. Slot 'any': Smart Matching підбирає на предмет,
// а не на конкретний урок у сітці.
window.confirmSubstitute=async function(email,cls,subj,date){
  const t=(window.globalTeachersList||[]).find(t=>t.email===email);
  await set(ref(db,`substitutions/${date}/${cls}/any`),
    {subject:subj,subEmail:email,subName:t?t.name:email,origName:'',by:currentUserData?.email||'',ts:Date.now()});
  logAction('substitute',{cls,subject:subj,date,target:t?t.name:email});
  showToast(`✅ Заміну призначено: ${t?t.name:email} → ${subj} у ${cls.replace('class_','')} класі`);
  document.getElementById('sm-results').innerHTML='<p style="color:var(--green);font-weight:700;">✅ Заміну підтверджено!</p>';
};
// ══════════ TEACHER SKILLS (matrix managed by director) ══════════
export async function loadDirectorTeacherSkillsList(){invalidateUsersCache();
  const select=document.getElementById('d-skills-teacher');select.innerHTML='<option value="">-- Оберіть вчителя --</option>';
  const _s=await getUsersSnap(); if(!_s.exists())return; const users=_s.val();for(let uid in users){const u=users[uid];const rs=getUserRoles(u);if(rs.some(r=>r==='teacher'||r==='art_school_teacher'||r==='class_teacher'||r==='music_teacher')&&u.email&&!u.disabled){const n=(u.firstName||u.lastName)?`${u.firstName||''} ${u.lastName||''}`.trim():u.email;select.innerHTML+=`<option value="${u.email.replace(/\./g,'_')}">${escHtml(n)} (${escHtml(u.email)})</option>`;}}
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
  directorSkillsTemp.forEach((s,i)=>{c.innerHTML+=`<span class="skill-tag remove" onclick="removeDirectorSkill(${i})">✖ ${escHtml(s)}</span>`;});
  if(directorSkillsTemp.length===0)c.innerHTML='<p class="empty-msg" style="font-size:.8rem;">Скілів ще немає.</p>';
}
window.removeDirectorSkill=function(i){directorSkillsTemp.splice(i,1);renderDirectorSkillsTags();};
window.addTeacherSkill=function(){const v=document.getElementById('d-skill-input').value.trim();if(!v)return;if(!directorSkillsTemp.includes(v))directorSkillsTemp.push(v);document.getElementById('d-skill-input').value='';renderDirectorSkillsTags();};
window.saveTeacherSkills=async function(){const se=document.getElementById('d-skills-teacher').value;if(!se)return alert("Оберіть вчителя!");await set(ref(db,`teacher_skills/${se}/subjects`),directorSkillsTemp);showToast("✅ Скіли збережено!");};
// ══════════ SCHEDULE DRAFTS (Конструктор Розкладу) ══════════
export function loadDrafts(){get(ref(db,'schedule_drafts')).then(snap=>{const c=document.getElementById('drafts-list-container');if(snap.exists()){let h='';const dr=snap.val();for(let dn in dr)h+=`<div style="background:#f4f9fd;padding:13px;border-radius:8px;border:1px solid var(--blue);margin-bottom:9px;"><b style="color:var(--teal);">📝 ${dn}</b><div style="display:flex;gap:8px;margin-top:9px;flex-wrap:wrap;"><button style="flex:1;background:#f39c12;color:#fff;padding:11px;margin:0;min-width:100px;" onclick="openVisualMatrixModal('${dn}')">✏️ Відкрити</button><button style="background:var(--red);color:#fff;padding:11px 13px;margin:0;" onclick="deleteDraft('${dn}')">🗑</button><button style="flex:100%;background:var(--green);color:#fff;padding:11px;margin:0;" onclick="activateDraft('${dn}','replace')">🚀 Опублікувати як увесь розклад школи</button><button style="flex:100%;background:#0288d1;color:#fff;padding:10px;margin:0;font-size:.83rem;" onclick="activateDraft('${dn}','merge')">➕ Оновити лише класи з чернетки</button></div></div>`;c.innerHTML=h;}else c.innerHTML='<p class="empty-msg">Чернеток немає.</p>';});}
window.loadDrafts=loadDrafts;
window.createNewDraft=async function(){const name=document.getElementById('new-draft-name').value.trim();if(!name)return alert("Введіть назву!");const ok=confirm("Скопіювати поточний розклад?");if(ok){const s=await get(ref(db,'schedules'));if(s.exists())await set(ref(db,`schedule_drafts/${name}`),s.val());else await set(ref(db,`schedule_drafts/${name}`),{placeholder:true});}else await set(ref(db,`schedule_drafts/${name}`),{placeholder:true});document.getElementById('new-draft-name').value='';showToast("✅ Чернетку створено!");loadDrafts();};
window.deleteDraft=function(name){if(confirm(`Видалити "${name}"?`))remove(ref(db,`schedule_drafts/${name}`)).then(()=>loadDrafts());};
// Публікація чернетки розкладу.
//
// ЩО ТУТ БУЛО НЕ ТАК.
// 1. Порожня чернетка СТИРАЛА ВЕСЬ РОЗКЛАД ШКОЛИ. Створена без копіювання
//    чернетка має вигляд {placeholder:true}; публікація писала цей обʼєкт
//    у schedules цілком — тобто всі класи лишалися без розкладу. Один
//    зайвий клік, і відновлювати нема звідки, бо резервних копій немає.
// 2. Не було жодного підтвердження результату. Помилку запису ніхто не
//    ловив, а «опубліковано» показувалося ще до того, як стало відомо,
//    що саме записалося.
//
// Тепер: перевіряємо вміст, рахуємо, що публікуємо, звіряємо після
// запису й показуємо це людині.
// Публікація чернетки у двох режимах.
//
// ЧОМУ ДВА. Раніше я публікував лише класи з чернетки, а решту лишав як є —
// це здавалося безпечнішим. Але очікування було інше: «опублікував розклад»
// означає, що новий розклад стає ЄДИНИМ. Обидві поведінки осмислені,
// тому вибір робить людина, а не я за неї:
//
//   replace — чернетка стає всім розкладом школи. Класи, яких у ній немає,
//             лишаються без розкладу. Так починають новий навчальний рік.
//   merge   — оновлюються лише класи з чернетки, решта не чіпається.
//             Так вносять зміни в один-два класи посеред року.
//
// У режимі replace перед записом перелічуємо поіменно, у кого зникне
// розклад: 11 класів без розкладу через один клік — те, про що треба
// попередити словами, а не дрібним шрифтом.
window.activateDraft=async function(name, mode){
  try{
    const snap=await get(ref(db,`schedule_drafts/${name}`));
    if(!snap.exists()) return alert(`Чернетки «${name}» більше немає.`);
    const draft=snap.val()||{};

    // Рахуємо реальні класи з уроками, а не просто ключі
    const classes=Object.keys(draft).filter(k=>k!=='placeholder' && draft[k] && draft[k].lessons);
    let lessons=0, days=new Set();
    classes.forEach(c=>Object.entries(draft[c].lessons||{}).forEach(([d,arr])=>{
      const list=Array.isArray(arr)?arr:Object.values(arr||{});
      const n=list.filter(i=>i && (Array.isArray(i)?i.length:i.subject)).length;
      if(n){ lessons+=n; days.add(d); }
    }));

    if(!classes.length || !lessons){
      return alert(`Чернетка «${name}» порожня — у ній немає жодного уроку.\n\n`
        + 'Публікація стерла б чинний розклад усієї школи, тому вона зупинена. '
        + 'Відкрийте чернетку, складіть розклад і спробуйте знову.');
    }

    // Хто зараз має розклад, але в чернетці його немає
    const liveSnap = await get(child(ref(db),'schedules'));
    const liveClasses = liveSnap.exists()
      ? Object.keys(liveSnap.val()||{}).filter(k => /^class_\d+$/.test(k)) : [];
    const willClear = mode === 'replace'
      ? liveClasses.filter(c => !classes.includes(c)) : [];

    const head = mode === 'replace'
      ? `Зробити «${name}» УСІМ розкладом школи?`
      : `Оновити з «${name}» лише класи, що є в чернетці?`;
    let msg = head + `\n\nКласів у чернетці: ${classes.length}\nДнів тижня: ${days.size}\nУроків: ${lessons}\n`;
    if(mode === 'replace'){
      msg += willClear.length
        ? `\n⚠️ Ці класи ЗАЛИШАТЬСЯ БЕЗ РОЗКЛАДУ, бо їх немає в чернетці:\n`
          + willClear.map(c=>c.replace('class_','')+' клас').join(', ')
          + '\n\nЯкщо це не те, що потрібно — скасуйте і скористайтеся кнопкою '
          + '«Оновити лише класи з чернетки».'
        : '\nУсі класи, що мають розклад, є в чернетці.';
    } else {
      msg += '\nРешта класів збереже свій розклад.';
    }
    if(!confirm(msg)) return;

    // ЗАПИС ПО КЛАСАХ, А НЕ В КОРІНЬ.
    //
    // Раніше тут стояло set(ref(db,'schedules'), draft) — запис у САМ вузол
    // schedules. А правила дозволяють запис лише в schedules/{клас}: на
    // самому вузлі правила .write немає взагалі. Тобто публікація завжди
    // отримувала відмову — і, оскільки помилку ніхто не ловив, виглядало
    // це так, ніби нічого не відбувається. Розклад не змінювався жодного
    // разу, а в матриці доступу лишалися старі предмети.
    //
    // Побічний наслідок такого запису: класи, яких немає в чернетці,
    // тепер зберігають свій розклад, а не зникають. Для чернетки на один
    // клас це саме те, що потрібно.
    const failed=[];
    for(const c of classes){
      try{ await set(ref(db,`schedules/${c}`), draft[c]); }
      catch(e){ failed.push(`${c.replace('class_','')} кл.: ${e.message}`); }
    }
    // Повна заміна: класи поза чернеткою прибираємо поштучно — запис у
    // корінь schedules правилами заборонений.
    for(const c of willClear){
      try{ await remove(ref(db,`schedules/${c}`)); }
      catch(e){ failed.push(`${c.replace('class_','')} кл. (очищення): ${e.message}`); }
    }
    if(failed.length===classes.length){
      return alert('Не вдалося опублікувати жодного класу.\n\n'+failed.join('\n'));
    }

    const check=await get(ref(db,'schedules'));
    const got=check.exists()?Object.keys(check.val()||{}).filter(k=>k!=='placeholder').length:0;
    if(failed.length){
      alert(`Опубліковано частково.\n\nНе записалося:\n${failed.join('\n')}`);
    }
    showToast(`🚀 Опубліковано: ${classes.length-failed.length} кл., ${lessons} уроків`);
    alert(`✅ Розклад опубліковано.\n\nОновлено класів: ${classes.length - failed.length}\n`
      + `Уроків: ${lessons}\n`
      + (mode === 'replace' && willClear.length ? `Очищено класів: ${willClear.length}\n` : '')
      + `Всього класів із розкладом у школі: ${got}\n\n`
      + (mode === 'replace'
          ? 'Чернетка тепер — увесь розклад школи.'
          : 'Класи, яких у чернетці не було, зберегли свій попередній розклад.')
      + ' Предмети в «Матриці доступу вчителів» беруться саме звідси, за всі дні тижня.');
    logAction('settings',{value:`розклад ${mode==='replace'?'замінено':'оновлено'}: ${name}, ${classes.length} кл., ${lessons} уроків`+(willClear.length?`, очищено ${willClear.length}`:'')});
    loadDrafts();
  }catch(e){
    alert('Не вдалося опублікувати: '+e.message);
  }
};
// ══════════ ACADEMIC YEAR (Навчальний рік) ══════════
// Exported so parent-student.js's read-only calendar (Phase 3) can look up
// the same school year's holidays/breaks without recomputing the rule.
// Навчальний рік: КОРДОН У СЕРПНІ, А НЕ У ВЕРЕСНІ.
//
// Раніше межа стояла на 1 вересня. Це означало, що канікули та свята,
// внесені в серпні на майбутній рік, лягали у вузол ПОПЕРЕДНЬОГО року —
// а 1 вересня портал починав читати новий вузол, і календар ставав
// порожнім за одну ніч. Саме це й сталося: дані від 31 серпня лежать у
// «2025-2026», а портал 1 вересня пішов у «2026-2027».
//
// Школи планують рік у серпні, тому серпень уже належить новому року.
export function getAcademicYearId(now = new Date()){
  const y = now.getFullYear(), m = now.getMonth() + 1;
  return m >= 8 ? `${y}-${y+1}` : `${y-1}-${y}`;
}
export const ACADEMIC_YEAR_ID = getAcademicYearId();

// Але й дати вирішувати все не можна: школа може ще працювати з минулим
// роком або готувати наступний. Тому чинний рік — це НАЛАШТУВАННЯ в базі,
// а обчислення лишається запасним варіантом, коли налаштування ще немає.
export let ACTIVE_YEAR = ACADEMIC_YEAR_ID;

export function yearsAround(id){
  const [a] = String(id).split('-').map(Number);
  return [`${a-1}-${a}`, `${a}-${a+1}`, `${a+1}-${a+2}`];
}

window.resolveAcademicYear = async function(){
  try{
    const snap = await get(child(ref(db), 'academic_year/current'));
    const saved = snap.exists() ? String(snap.val() || '') : '';
    if(/^\d{4}-\d{4}$/.test(saved)) ACTIVE_YEAR = saved;
  }catch(e){ console.warn('academic_year/current:', e.message); }
  const lbl = document.getElementById('ay-year-label');
  if(lbl) lbl.innerText = ACTIVE_YEAR;
  return ACTIVE_YEAR;
};

// Перемикач року для директора. Показуємо і роки, які вже є в базі, —
// інакше дані, внесені «не в той» рік, знайти було б неможливо.
// ══════════ ПЕРЕНЕСЕННЯ СВЯТ І КАНІКУЛ З ІНШОГО РОКУ ══════════
// Дати обовʼязково ЗСУВАЮТЬСЯ. Просте копіювання було б марним: свято з
// датою 2025-12-25 у році «2026-2027» не показалося б ніде, бо календар
// малює 2026-й і 2027-й. Тому кожна дата переїжджає у відповідний
// календарний рік нового навчального року.
//
// Межа — серпень, та сама, що й у getAcademicYearId.
export function shiftDateToYear(ds, fromYear, toYear){
  const m0 = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ds || ''));
  if(!m0) return null;
  const [fa, fb] = String(fromYear).split('-').map(Number);
  const [ta, tb] = String(toYear).split('-').map(Number);
  if(!fa || !fb || !ta || !tb) return null;
  const y = Number(m0[1]), mm = Number(m0[2]), dd = Number(m0[3]);
  const first = mm >= 8;
  if(y !== (first ? fa : fb)) return null;   // дата не з цього навчального року
  const ny = first ? ta : tb;
  // 29 лютого існує не щороку — переносимо на 28-е, а не мовчки псуємо дату
  const days = new Date(ny, mm, 0).getDate();
  const nd = Math.min(dd, days);
  return `${ny}-${String(mm).padStart(2,'0')}-${String(nd).padStart(2,'0')}`;
}

// Чи належить дата цьому навчальному році. Межа — серпень.
export function dateBelongsToYear(ds, year){
  const m0 = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(ds || ''));
  const [a, b] = String(year || '').split('-').map(Number);
  if(!m0 || !a || !b) return false;
  const y = Number(m0[1]), mm = Number(m0[2]);
  return y === (mm >= 8 ? a : b);
}

// Куди покласти дату при перенесенні.
//
// ЧОМУ НЕ ПРОСТО ЗСУВ. Виявилося, що свята нового року можуть лежати у
// вузлі старого: їх вносили в серпні, коли портал ще називав рік
// попереднім. Дати там уже правильні — зсовувати їх означало б зіпсувати
// на рік уперед. Тому спершу дивимось, чи дата вже належить потрібному
// року: якщо так — беремо як є, і лише інакше зсуваємо.
export function mapDateToYear(ds, fromYear, toYear){
  if(dateBelongsToYear(ds, toYear)) return ds;
  return shiftDateToYear(ds, fromYear, toYear);
}

window.fillCopyFromSelect = async function(){
  const sel = document.getElementById('ay-copy-from');
  if(!sel) return;
  let opts = [];
  try{
    const snap = await get(child(ref(db), 'academic_year'));
    const v = snap.exists() ? (snap.val() || {}) : {};
    Object.keys(v).forEach(k => {
      if(!/^\d{4}-\d{4}$/.test(k) || k === ACTIVE_YEAR) return;
      const n = (v[k].holidays ? Object.keys(v[k].holidays).length : 0)
              + (v[k].breaks   ? Object.keys(v[k].breaks).length   : 0);
      if(n) opts.push({ k, n });
    });
  }catch(e){ console.warn('academic_year:', e.message); }
  opts.sort((a,b)=>b.k.localeCompare(a.k));
  sel.innerHTML = opts.length
    ? opts.map(o=>`<option value="${o.k}">${o.k} — записів: ${o.n}</option>`).join('')
    : '<option value="">Інших років із даними немає</option>';
};

window.copyYearData = async function(){
  const sel = document.getElementById('ay-copy-from');
  const src = sel ? sel.value : '';
  if(!src) return alert('Немає року, з якого копіювати.');
  if(src === ACTIVE_YEAR) return alert('Це той самий рік.');
  const btn = document.getElementById('ay-copy-btn');
  try{
    const [hSnap, bSnap, curH, curB] = await Promise.all([
      get(child(ref(db), `academic_year/${src}/holidays`)),
      get(child(ref(db), `academic_year/${src}/breaks`)),
      get(child(ref(db), `academic_year/${ACTIVE_YEAR}/holidays`)),
      get(child(ref(db), `academic_year/${ACTIVE_YEAR}/breaks`))
    ]);
    const have = new Set();
    if(curH.exists()) Object.values(curH.val()).forEach(x => have.add('h|'+x.title+'|'+x.date));
    if(curB.exists()) Object.values(curB.val()).forEach(x => have.add('b|'+x.title+'|'+x.startDate));

    const holidays = [], breaks = [], skipped = [];
    let asIs = 0, shifted = 0;
    if(hSnap.exists()) Object.values(hSnap.val()).forEach(x => {
      const d = mapDateToYear(x.date, src, ACTIVE_YEAR);
      if(!d){ skipped.push(`${x.title || 'Свято'} (${x.date})`); return; }
      if(have.has('h|'+x.title+'|'+d)) return;         // вже є — не дублюємо
      d === x.date ? asIs++ : shifted++;
      holidays.push({ ...x, date: d });
    });
    if(bSnap.exists()) Object.values(bSnap.val()).forEach(x => {
      // Обидві дати періоду обробляємо однаково: якщо початок уже в
      // потрібному році — кінець теж беремо як є, інакше зсуваємо обидві.
      const keep = dateBelongsToYear(x.startDate, ACTIVE_YEAR);
      const s2 = keep ? x.startDate : shiftDateToYear(x.startDate, src, ACTIVE_YEAR);
      const e2 = keep ? x.endDate   : shiftDateToYear(x.endDate,   src, ACTIVE_YEAR);
      if(!s2 || !e2){ skipped.push(`${x.title || 'Канікули'} (${x.startDate})`); return; }
      if(have.has('b|'+x.title+'|'+s2)) return;
      keep ? asIs++ : shifted++;
      breaks.push({ ...x, startDate: s2, endDate: e2 });
    });

    if(!holidays.length && !breaks.length){
      return alert('Переносити нема чого: усе вже є в цьому році'
        + (skipped.length ? `, а ці дати не належать року ${src}:\n` + skipped.join('\n') : '.'));
    }
    if(!confirm(`Перенести з ${src} у ${ACTIVE_YEAR}?\n\n`
      + `Свят: ${holidays.length}\nКанікул: ${breaks.length}\n\n`
      + `Дати вже правильні, беремо як є: ${asIs}\n`
      + `Дати зсуваються на рік уперед: ${shifted}\n\n`
      + 'Наявні записи не чіпаємо.')) return;

    if(btn){ btn.disabled = true; btn.textContent = '⏳ Переношу...'; }
    for(const x of holidays) await push(ref(db, `academic_year/${ACTIVE_YEAR}/holidays`), x);
    for(const x of breaks)   await push(ref(db, `academic_year/${ACTIVE_YEAR}/breaks`), x);
    logAction('settings', { value: `перенесено з ${src}: свят ${holidays.length}, канікул ${breaks.length}` });
    alert(`✅ Перенесено.\n\nСвят: ${holidays.length}\nКанікул: ${breaks.length}`
      + (skipped.length ? `\n\nНе перенесено (дати поза роком ${src}):\n` + skipped.join('\n') : ''));
    window.loadAcademicYear();
  }catch(e){
    alert('Не вдалося перенести: ' + e.message);
  }finally{
    if(btn){ btn.disabled = false; btn.textContent = '📋 Перенести з іншого року'; }
  }
};

window.fillYearSelect = async function(){
  const sel = document.getElementById('ay-year-select');
  if(!sel) return;
  const years = new Set(yearsAround(ACADEMIC_YEAR_ID));
  years.add(ACTIVE_YEAR);
  const counts = {};
  try{
    const snap = await get(child(ref(db), 'academic_year'));
    if(snap.exists()){
      const v = snap.val() || {};
      Object.keys(v).forEach(k => {
        if(!/^\d{4}-\d{4}$/.test(k)) return;
        years.add(k);
        const n = (v[k] && v[k].holidays ? Object.keys(v[k].holidays).length : 0)
                + (v[k] && v[k].breaks   ? Object.keys(v[k].breaks).length   : 0);
        counts[k] = n;
      });
    }
  }catch(e){ console.warn('academic_year:', e.message); }
  sel.innerHTML = [...years].sort().map(y =>
    `<option value="${y}"${y===ACTIVE_YEAR?' selected':''}>${y}`
    + (counts[y] ? ` — записів: ${counts[y]}` : ' — порожній') + `</option>`).join('');
};

window.switchAcademicYear = async function(){
  const sel = document.getElementById('ay-year-select');
  if(!sel || !sel.value) return;
  try{
    await set(ref(db, 'academic_year/current'), sel.value);
    ACTIVE_YEAR = sel.value;
    const lbl = document.getElementById('ay-year-label');
    if(lbl) lbl.innerText = ACTIVE_YEAR;
    logAction('settings', { value: 'навчальний рік: ' + ACTIVE_YEAR });
    showToast('✅ Рік: ' + ACTIVE_YEAR);
    window.loadAcademicYear();
    if(window.renderParentCalendar) window.renderParentCalendar('parent');
  }catch(e){ alert('Не вдалося змінити рік: ' + e.message); }
};
function formatClassesLabel(classes){if(classes==='all')return '🌟 Усі класи';if(Array.isArray(classes)&&classes.length>0)return classes.map(c=>c.replace('class_','')).sort((a,b)=>a-b).join(', ')+' кл.';return '—';}
window.loadAcademicYear=function(){const lbl=document.getElementById('ay-year-label');if(lbl)lbl.innerText=ACTIVE_YEAR;window.fillYearSelect();window.fillCopyFromSelect();loadSemesters();loadBreaks();loadHolidays();};
// --- Семестри ---
function loadSemesters(){get(ref(db,`academic_year/${ACTIVE_YEAR}/semesters`)).then(snap=>{const c=document.getElementById('ay-semesters-list');if(snap.exists()){const d=snap.val();let h='';for(let id in d){const s=d[id];h+=`<div style="background:#fff;padding:9px 11px;border-radius:8px;border:1px solid #ffe0b2;margin-bottom:7px;display:flex;justify-content:space-between;align-items:center;"><div><b>${s.name}</b><br><span style="font-size:.78rem;color:#888;">${(s.startDate||'').split('-').reverse().join('.')} — ${(s.endDate||'').split('-').reverse().join('.')}</span></div><button onclick="removeSemester('${id}')" style="background:var(--red);color:#fff;width:auto;padding:6px 10px;margin:0;border-radius:7px;font-size:.78rem;">🗑</button></div>`;}c.innerHTML=h||'<p class="empty-msg">Семестрів ще немає.</p>';}else c.innerHTML='<p class="empty-msg">Семестрів ще немає.</p>';});}
window.addSemester=async function(){
  const name=document.getElementById('ay-sem-name').value.trim();
  const startDate=document.getElementById('ay-sem-start').value;
  const endDate=document.getElementById('ay-sem-end').value;
  if(!name||!startDate||!endDate)return alert("Заповніть усі поля!");
  if(startDate>endDate)return alert("Дата початку пізніше дати завершення!");
  await push(ref(db,`academic_year/${ACTIVE_YEAR}/semesters`),{name,startDate,endDate});
  document.getElementById('ay-sem-name').value='';document.getElementById('ay-sem-start').value='';document.getElementById('ay-sem-end').value='';
  showToast("✅ Семестр додано!");loadSemesters();
};
window.removeSemester=function(id){if(confirm("Видалити цей семестр?"))remove(ref(db,`academic_year/${ACTIVE_YEAR}/semesters/${id}`)).then(()=>{showToast("🗑️ Семестр видалено");loadSemesters();});};
// --- Канікули ---
window.toggleAllClasses=function(kind){const cb=document.getElementById(`ay-${kind}-all-classes`);const sel=document.getElementById(`ay-${kind}-classes`);sel.disabled=cb.checked;if(cb.checked)Array.from(sel.options).forEach(o=>o.selected=false);};
function loadBreaks(){get(ref(db,`academic_year/${ACTIVE_YEAR}/breaks`)).then(snap=>{const c=document.getElementById('ay-breaks-list');if(snap.exists()){const d=snap.val();let h='';for(let id in d){const b=d[id];h+=`<div style="background:#fff;padding:9px 11px;border-radius:8px;border:1px solid #ffe0b2;margin-bottom:7px;display:flex;justify-content:space-between;align-items:center;"><div><b>${b.title}</b><br><span style="font-size:.78rem;color:#888;">${(b.startDate||'').split('-').reverse().join('.')} — ${(b.endDate||'').split('-').reverse().join('.')} | ${formatClassesLabel(b.classes)}</span></div><button onclick="removeBreak('${id}')" style="background:var(--red);color:#fff;width:auto;padding:6px 10px;margin:0;border-radius:7px;font-size:.78rem;">🗑</button></div>`;}c.innerHTML=h||'<p class="empty-msg">Канікул ще немає.</p>';}else c.innerHTML='<p class="empty-msg">Канікул ще немає.</p>';});}
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
  await push(ref(db,`academic_year/${ACTIVE_YEAR}/breaks`),{title,startDate,endDate,classes});
  document.getElementById('ay-break-title').value='';document.getElementById('ay-break-start').value='';document.getElementById('ay-break-end').value='';
  document.getElementById('ay-break-all-classes').checked=false;sel.disabled=false;Array.from(sel.options).forEach(o=>o.selected=false);
  showToast("✅ Канікули додано!");loadBreaks();
};
window.removeBreak=function(id){if(confirm("Видалити ці канікули?"))remove(ref(db,`academic_year/${ACTIVE_YEAR}/breaks/${id}`)).then(()=>{showToast("🗑️ Видалено");loadBreaks();});};
// --- Свята ---
function loadHolidays(){get(ref(db,`academic_year/${ACTIVE_YEAR}/holidays`)).then(snap=>{const c=document.getElementById('ay-holidays-list');if(snap.exists()){const d=snap.val();let h='';for(let id in d){const hd=d[id];const typeLabel=hd.calendarType==='art_school'?'🎵 Школа мистецтв':'🏫 Загальна школа';h+=`<div style="background:#fff;padding:9px 11px;border-radius:8px;border:1px solid #ffe0b2;margin-bottom:7px;display:flex;justify-content:space-between;align-items:center;"><div><b>${hd.title}</b><br><span style="font-size:.78rem;color:#888;">${(hd.date||'').split('-').reverse().join('.')} | ${formatClassesLabel(hd.classes)} | ${typeLabel}</span></div><button onclick="removeHoliday('${id}')" style="background:var(--red);color:#fff;width:auto;padding:6px 10px;margin:0;border-radius:7px;font-size:.78rem;">🗑</button></div>`;}c.innerHTML=h||'<p class="empty-msg">Свят ще немає.</p>';}else c.innerHTML='<p class="empty-msg">Свят ще немає.</p>';});}
window.addHoliday=async function(){
  const title=document.getElementById('ay-holiday-title').value.trim();
  const date=document.getElementById('ay-holiday-date').value;
  const allChecked=document.getElementById('ay-holiday-all-classes').checked;
  const sel=document.getElementById('ay-holiday-classes');
  const classes=allChecked?'all':Array.from(sel.selectedOptions).map(o=>o.value);
  const calendarType=document.getElementById('ay-holiday-calendar-type').value;
  if(!title||!date)return alert("Заповніть усі поля!");
  if(!allChecked&&classes.length===0)return alert("Оберіть класи або позначте 'Усі класи'!");
  await push(ref(db,`academic_year/${ACTIVE_YEAR}/holidays`),{title,date,classes,calendarType});
  document.getElementById('ay-holiday-title').value='';document.getElementById('ay-holiday-date').value='';
  document.getElementById('ay-holiday-all-classes').checked=false;sel.disabled=false;Array.from(sel.options).forEach(o=>o.selected=false);
  showToast("✅ Свято додано!");loadHolidays();
};
window.removeHoliday=function(id){if(confirm("Видалити це свято?"))remove(ref(db,`academic_year/${ACTIVE_YEAR}/holidays/${id}`)).then(()=>{showToast("🗑️ Видалено");loadHolidays();});};
// ══════════ TEACHER LIST FOR DIRECTOR (access matrix + staff mgmt) ══════════
// Мультиролі: вчителем вважається той, у кого вчительська роль є СЕРЕД ролей,
// а не лише як активна. Відключених (disabled) до списків не додаємо.
export async function loadTeachersListForDirector(){invalidateUsersCache();const s=document.getElementById('d-acc-email-select');s.innerHTML='<option value="">-- Вчитель --</option>';const snap=await getUsersSnap();window.globalTeachersList=[];if(snap.exists()){const u=snap.val();for(let uid in u){const us=u[uid];const rs=getUserRoles(us);if(rs.some(r=>r==='teacher'||r==='art_school_teacher'||r==='class_teacher'||r==='music_teacher')&&us.email&&!us.disabled){const n=(us.firstName||us.lastName)?`${us.firstName||''} ${us.lastName||''}`.trim():us.email;const se=us.email.replace(/\./g,'_');s.innerHTML+=`<option value="${se}">${escHtml(n)} (${escHtml(us.email)})</option>`;window.globalTeachersList.push({email:us.email,name:n,safeEmail:se});}}}}
window.loadTeachersListForDirector=loadTeachersListForDirector;
// Предмети для матриці доступу беруться з ЧИННОГО розкладу класу, за всі
// дні тижня одразу. Це збиває з пантелику: додав розклад на понеділок —
// а в списку ще й предмети з решти днів, які лишилися від попереднього
// розкладу (чернетку зазвичай створюють копією старого). Тому тепер під
// списком прямо написано, звідки він і скільки там днів.
window.loadDirectorMatrixSubjects=function(){
  const cls=document.getElementById('d-acc-class').value;
  const ss=document.getElementById('d-acc-subjects');
  const info=document.getElementById('d-acc-subj-src');
  const say=(t,bad)=>{ if(info){ info.style.display=t?'block':'none'; info.textContent=t||'';
                                 info.style.color=bad?'var(--red)':'#78909c'; } };
  if(!cls){ ss.innerHTML='<option disabled>Оберіть клас...</option>'; say(''); return; }
  ss.innerHTML='<option disabled>Завантаження...</option>'; say('Читаю розклад класу...');
  window.loadScheduleScript(cls,()=>{
    const DAYS=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
    const UA={Monday:'Пн',Tuesday:'Вт',Wednesday:'Ср',Thursday:'Чт',Friday:'Пт',Saturday:'Сб',Sunday:'Нд'};
    const u=new Set(); const withLessons=[];
    if(window.schedule) DAYS.forEach(d=>{
      const items=window.getTodayLessonsFlattened(d)||[];
      let n=0;
      items.forEach(i=>{ const s=window.getValidSubjectName(i); if(s){ u.add(s); n++; } });
      if(n) withLessons.push(UA[d]);
    });
    ss.innerHTML='<option value="Всі предмети" style="font-weight:700;color:#d35400;">🌟 Всі предмети</option>';
    if(u.size>0){
      [...u].sort((a,b)=>a.localeCompare(b,'uk')).forEach(subj=>{
        ss.innerHTML+=`<option value="${escHtml(subj)}">${escHtml(subj)}</option>`;
      });
      say(`Предметів: ${u.size}. З чинного розкладу класу, дні: ${withLessons.join(', ')}.`);
    }else{
      ss.innerHTML='<option disabled>Розклад не знайдено</option>';
      say('У цього класу немає жодного уроку в чинному розкладі. '
        + 'Якщо ви щойно публікували чернетку — перевірте, чи вона справді опублікована.', true);
    }
  });
};
window.grantTeacherAccess=async function(){
  const se=document.getElementById('d-acc-email-select').value;
  const cls=document.getElementById('d-acc-class').value;
  const subjs=Array.from(document.getElementById('d-acc-subjects').selectedOptions).map(o=>o.value);
  if(!se||!cls||subjs.length===0)return alert('Заповніть усі поля!');
  try{
    // РОЛЬ НЕ ЧІПАЄМО, ЯКЩО ВОНА ВЖЕ Є.
    //
    // Раніше тут беззастережно писалося pre_approved_roles/{se} = 'teacher'.
    // Через це призначення предмета скидало посаду: щойно призначений
    // класний керівник ставав звичайним учителем, а якщо в людини було
    // кілька ролей (напр. учитель і адміністратор) — лишалася одна.
    // Саме тому в чаті керівник підписувався як «Вчитель».
    //
    // Роль тут потрібна лише для того, щоб людина взагалі значилася в
    // списку персоналу. Якщо вона там уже є — не втручаємось.
    const cur=await get(child(ref(db),`pre_approved_roles/${se}`));
    const writes=[set(ref(db,`teacher_access/${se}/${cls}`),subjs)];
    let roleNote='';
    if(!cur.exists()){
      writes.push(set(ref(db,`pre_approved_roles/${se}`),'teacher'));
      roleNote='\n\nЛюдину додано до списку персоналу як вчителя.';
    }
    await Promise.all(writes);
    // Оновлюємо картку в довіднику одразу — щоб предмет зʼявився в чаті
    // у батьків зараз, а не після того, як учитель наступного разу зайде.
    const synced = await syncStaffCard(se);
    alert(`✅ Доступ збережено: ${subjs.join(', ')} — ${cls.replace('class_','')} клас.`+roleNote
      + (synced ? '\n\nУ чаті в батьків предмет уже видно.'
                : '\n\nДовідник контактів оновити не вдалося — скористайтеся кнопкою «📇 Довідник контактів для чату».'));
  }catch(e){
    alert('Помилка: '+e.message+'\n\nЯкщо не записався список персоналу, учитель не зможе листуватися.');
  }
};
// pre_approved_roles/{safeEmail} тепер може містити масив ролей — одна особа
// може бути одночасно, напр., вчителем і адміністратором.
window.grantStaffRole=async function(){
  const raw=document.getElementById('new-staff-email').value.trim().toLowerCase();
  const sel=document.getElementById('new-staff-role');
  const roles=Array.from(sel.selectedOptions).map(o=>o.value);
  if(!raw)return alert("Введіть Email!");
  if(roles.length===0)return alert("Виберіть хоча б одну роль!");
  const se=raw.toLowerCase().replace(/\./g,'_');
  try{
    await set(ref(db,`pre_approved_roles/${se}`),roles);
    // Якщо людина вже заходила раніше — оновлюємо і її профіль, щоб нові ролі
    // застосувались без очікування повторного входу. Заодно знімаємо disabled,
    // якщо співробітника раніше видаляли, а тепер повертають.
    const us=await getUsersSnap();
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
    await syncStaffCard(se);   // одразу в довідник, щоб був у списку чату
    const names=roles.map(r=>ROLE_LABELS[r]||r).join(', ');
    showToast(`✅ Доступ надано: ${names}`);
    logAction('staff_grant',{target:raw,value:roles.join(',')});
    document.getElementById('new-staff-email').value='';
    window.loadStaffList();
  }catch(e){alert('Помилка: '+e.message);}
};
// ══════════ ПЕРСОНАЛ: список ══════════
window.loadStaffList=async function(){invalidateUsersCache();
  const box=document.getElementById('staff-list');
  if(!box)return;
  box.innerHTML='<p class="empty-msg">Завантаження...</p>';
  try{
    const [approvedSnap,usersSnap]=await Promise.all([
      get(child(ref(db),'pre_approved_roles')),
      getUsersSnap()
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
      const ph=u?.photoURL||'';
      html+=`<div class="staff-row${u?.disabled?' is-disabled':''}">
        <span class="staff-av">${escHtml((name==='—'?email:name).trim().slice(0,1).toUpperCase())}${
          /^(data:image\/|https:\/\/)/.test(ph)?`<img src="${escHtml(ph)}" alt="" loading="lazy" onerror="this.remove()">`:''}</span>
        <div class="staff-main">
          <div><b>${escHtml(name)}</b>${isMe?' <span style="font-size:.7rem;color:var(--teal);">(це ви)</span>':''}${neverLoggedIn?' <span style="font-size:.68rem;color:#f39c12;">ще не входив</span>':''}</div>
          <div class="staff-email">${escHtml(email)}</div>
          <div class="staff-roles">${roles.map(r=>`<span class="staff-role-tag">${escHtml(ROLE_LABELS[r]||r)}</span>`).join('')}</div>
        </div>
        <div class="staff-actions">
          <button class="staff-edit" onclick="openStaffProfile('${escJs(safeEmail)}')" title="Змінити імʼя та фото">✏️ Профіль</button>
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
    logAction('pass_reset',{target:email});
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
      remove(ref(db,`teacher_skills/${safeEmail}`)),
      // З довідника теж: інакше звільнена людина лишалася б у списку
      // контактів чату, і їй можна було б написати.
      remove(ref(db,`staff_directory/${safeEmail}`))
    ]);
    if(window.invalidateContactDir) window.invalidateContactDir();
    // 2. Позначаємо профіль як відключений (блокує вхід)
    const usersSnap=await getUsersSnap();
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
    logAction('staff_remove',{target:readable});
    showToast(scheduleWarning
      ?`🗑️ Доступ відкликано: ${readable}. Не забудьте переназначити його уроки в розкладі!`
      :`🗑️ Доступ відкликано: ${readable}`);
    window.loadStaffList();
    if(typeof window.loadTeachersListForDirector==='function')window.loadTeachersListForDirector();
  }catch(e){alert('Помилка: '+e.message);}
};
// ══════════ DIRECTOR STATS ══════════
window.updateDirectorStatSubjects=function(){const cls=document.getElementById('d-stat-class').value;const ss=document.getElementById('d-stat-subj');if(!cls){ss.innerHTML='<option>Оберіть клас</option>';document.getElementById('d-stat-results').innerHTML='<p class="empty-msg">Оберіть клас та предмет.</p>';return;}ss.innerHTML='<option>Завантаження...</option>';get(child(ref(db),`grades/${cls}`)).then(snap=>{let u=new Set();if(snap.exists()){const d=snap.val();for(let m in d)for(let s in d[m])u.add(s);}ss.innerHTML='<option value="">-- Предмет --</option>';if(u.size>0)[...u].sort().forEach(s=>ss.innerHTML+=`<option value="${s}">${s}</option>`);else ss.innerHTML='<option disabled>Оцінок немає</option>';});};
window.renderDirectorStats=async function(){const cls=document.getElementById('d-stat-class').value;const subj=document.getElementById('d-stat-subj').value;const rd=document.getElementById('d-stat-results');if(!cls||!subj){rd.innerHTML='<p class="empty-msg">Оберіть клас та предмет.</p>';return;}rd.innerHTML='<p>⏳ Обчислення...</p>';try{const [ss,gs,ts]=await Promise.all([get(child(ref(db),`students_list/${cls}`)),get(child(ref(db),`grades/${cls}`)),get(child(ref(db),`grade_types/${cls}`))]);let stList=[];if(ss.exists())stList=Object.keys(ss.val()).sort((a,b)=>String(ss.val()[a]).localeCompare(String(ss.val()[b]),'uk'));if(stList.length===0){rd.innerHTML='<p class="empty-msg">Немає учнів.</p>';return;}const gd=gs.exists()?gs.val():{};const td=ts.exists()?ts.val():{};let stats={};stList.forEach(st=>stats[st]={grades:{},types:{}});for(let m in gd)if(gd[m][subj])for(let date in gd[m][subj])for(let st in gd[m][subj][date])if(stats[st]){stats[st].grades[`${m}_${date}`]=gd[m][subj][date][st];const tp=td[m]?.[subj]?.[date]?.[st];if(tp)stats[st].types[`${m}_${date}`]=tp;}
  // The column header says "Зважений сер." — so actually weight it: per-cell grade
  // types come from grade_types/{cls}/{m}/{subj}/{date}/{st} (same composite key as
  // grades above), and calculateStudentWeightedAvg applies grade_type_defs weights
  // (untyped grades default to 'П' ×1 inside it). Was previously a plain mean with
  // a TODO admitting the mismatch between label and calculation.
  const clsNum=getClassNum(cls);
  let h='<table style="width:100%;border-collapse:collapse;font-size:.85rem;"><thead><tr><th style="text-align:left;padding:5px;background:#e8f4fd;">Учень</th><th style="background:#e8f4fd;">Зважений сер.</th><th style="background:#e8f4fd;">Оцінок</th></tr></thead><tbody>';
  let totalAvg=0;let cnt=0;
  stList.forEach(st=>{const g=stats[st].grades;const count=Object.keys(g).length;const avg=calculateStudentWeightedAvg(g,stats[st].types);const disp=avg!==null?displayGrade(String(Math.round(avg)),cls)+' ('+avg.toFixed(2)+')':'-';if(avg!==null){totalAvg+=avg;cnt++;}const gc=avg!==null?gradeClass6(Math.round(avg)):'';h+=`<tr><td style="padding:5px;border-bottom:1px solid #eee;"><b>${escHtml(stuName(cls, st))}</b></td><td style="text-align:center;"><span class="g-cell ${gc}" style="display:inline-block;padding:3px 8px;">${disp}</span></td><td style="text-align:center;">${count}</td></tr>`;});
  const ca=cnt>0?(totalAvg/cnt).toFixed(2):'-';h+=`</tbody></table><div style="background:#f4ecf7;border:1px solid #d2b4de;padding:12px;border-radius:8px;text-align:center;margin-top:10px;"><b style="color:var(--purple);">🏆 Середній бал класу:</b><br><span style="font-size:1.5rem;font-weight:800;color:#7b1fa2;">${displayGrade(String(Math.round(parseFloat(ca)||0)),cls)} (${ca})</span></div>`;rd.innerHTML=h;}catch(e){rd.innerHTML=`<p style="color:red;">Помилка: ${e.message}</p>`;}};
// ══════════ DIRECTOR DASHBOARD ══════════
export async function loadDirectorDashboard(){try{const date=document.getElementById('global-date').value;const dp=date.split('-');document.getElementById('d-att-header').innerText=`🚨 Відсутні (${dp[2]}.${dp[1]}, вся школа)`;const wd=getWeekDates(date);let hw=0,com=0,wl=0,wa=0,attHtml='';const _lo=wd[0]<date?wd[0]:date, _hi=wd[wd.length-1]>date?wd[wd.length-1]:date;const[hd,cd,ad]=await Promise.all([getSchoolRange('homeworks',_lo,_hi),getSchoolRange('comments',_lo,_hi),getSchoolRange('attendance',_lo,_hi)]);for(let i=1;i<=11;i++){const c=`class_${i}`;if(hd[c]&&hd[c][date])hw+=Object.keys(hd[c][date]).length;if(cd[c]&&cd[c][date]){for(let s in cd[c][date])if(typeof cd[c][date][s]==='object')com+=Object.keys(cd[c][date][s]).length;}if(ad[c]&&ad[c][date])for(let st in ad[c][date]){const slots=ad[c][date][st];for(let sk in slots){const r=slots[sk];if(r?.status){const bc=r.status==='late'?'badge-late':'badge-absent';const lb=r.status==='late'?'Запізнення':'Відсутність';const markerIcon=r.markedBy==='teacher'?'👨‍🏫':(r.markedBy==='student'?'🎒':'👪');attHtml+=`<li style="margin-bottom:9px;border-bottom:1px solid #eee;padding-bottom:4px;"><span style="font-size:.72rem;background:var(--teal);color:#fff;padding:2px 5px;border-radius:4px;margin-right:4px;">${i} Кл</span> <b>${escHtml(stuName(c, st))}</b> <span class="badge ${bc}">${lb}</span> <span style="font-size:.72rem;color:#888;">${escHtml(formatAttendanceSlotLabel(sk))} ${markerIcon}</span><br><i style="font-size:.78rem;color:#666;">${escHtml(r.reason)}</i></li>`;}}}if(ad[c])wd.forEach(w=>{if(ad[c][w]&&typeof ad[c][w]==='object')Object.values(ad[c][w]).forEach(slots=>{if(slots&&typeof slots==='object')Object.values(slots).forEach(r=>{if(r?.status==='late')wl++;else if(r?.status==='absent')wa++;});});});}// Підпис «сьогодні» був неправдою: лічильники рахують ОБРАНУ дату в
// шапці кабінету, а не поточний день. Через це старе ДЗ виглядало як
// сьогоднішнє. Тепер дата написана прямо на картці.
const dLabel=date.split('-').reverse().slice(0,2).join('.');
const isToday=date===localDateString;
const hwT=document.getElementById('d-hw-title');
if(hwT)hwT.innerText=`📚 ДЗ · ${isToday?'сьогодні':dLabel}`;
const comT=document.getElementById('d-com-title');
if(comT)comT.innerText=`💬 Коментарі · ${isToday?'сьогодні':dLabel}`;
document.getElementById('d-hw-counter').innerText=hw;document.getElementById('d-com-counter').innerText=com;document.getElementById('d-week-late').innerText=wl;document.getElementById('d-week-absent').innerText=wa;document.getElementById('d-unified-att-list').innerHTML=attHtml||'<li class="empty-msg">Усі присутні!</li>';}catch(e){console.error(e);}}
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
  // Дзвінки й час уроків у розкладі — це дві різні копії того самого часу.
  // Змінивши дзвінки, ми лишаємо уроки зі старим часом, і кабінет батьків
  // перестає їх показувати. Мовчати про це не можна.
  if(!confirm(`Застосувати цей розклад (${slotCount} ур.) до ВСІХ 11 класів?\n\n`
    + 'Існуючий розклад дзвінків усіх класів буде замінено.\n\n'
    + 'ВАЖЛИВО: час уроків у самому розкладі при цьому НЕ оновиться — уроки '
    + 'лишаться зі старим часом, і батьки можуть перестати їх бачити.\n\n'
    + 'Після цього для кожного класу відкрийте «⏱ Перерви класу» і натисніть '
    + '«Розставити» — саме там час уроків підтягнеться з нових дзвінків.'))return;
  try{
    // Один апдейт замість 11 окремих записів
    const patch={};
    for(let i=1;i<=11;i++)patch[`class_${i}`]=obj;
    await update(ref(db,'bell_schedules'),patch);
    showToast('✅ Розклад дзвінків застосовано до всіх 11 класів');
    logAction('bell_apply',{value:'усі 11 класів'});
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
  const us=await getUsersSnap();
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
// ══════════ БАТЬКИ: хто до кого прив'язаний ══════════
// Дані лежать «навпаки» — parent_links ключується поштою батьків, а директору
// зручніше бачити зріз по дітях. Тому перевертаємо: дитина → її батьки.
// Заодно видно дітей БЕЗ жодного прив'язаного контакту — це найкорисніше.
// Рендер спільний із кабінетом вчителя — див. renderParentsBlock у common.js
window.loadParentsOverview=function(){
  renderParentsBlock('po-list',document.getElementById('po-class')?.value||'');
};
// Список учнів обраного класу для форми прив'язки
window.loadParentLinkStudents=async function(){
  const cls=document.getElementById('po-class')?.value;
  const sel=document.getElementById('pl-student');
  if(!sel)return;
  if(!cls){sel.innerHTML='<option value="">Спочатку оберіть клас</option>';return;}
  sel.innerHTML='<option value="">Завантаження...</option>';
  const snap=await get(child(ref(db),`students_list/${cls}`));
  const names=snap.exists()?Object.values(snap.val()).sort((a,b)=>String(a).localeCompare(String(b),'uk')):[];
  sel.innerHTML=names.length
    ? '<option value="">-- Оберіть учня --</option>'+names.map(n=>`<option value="${escHtml(n)}">${escHtml(n)}</option>`).join('')
    : '<option value="">У класі немає учнів</option>';
};
// Прив'язка ДОДАЄ дитину до наявних, а не замінює (у батьків може бути
// кілька дітей). Та сама логіка, що й у вчителя, але для будь-якого класу.
window.directorLinkParent=async function(){
  const cls=document.getElementById('po-class').value;
  const st=document.getElementById('pl-student').value;
  const role=document.getElementById('pl-role').value;
  const raw=document.getElementById('pl-email').value.trim().toLowerCase();
  if(!cls||!st)return alert('Оберіть клас та учня.');
  if(!raw)return alert('Введіть email батьків.');
  const se=raw.replace(/\./g,'_');
  try{
    const snap=await get(child(ref(db),`parent_links/${se}`));
    const rec=snap.exists()?snap.val():{};
    const kids=normalizeChildren(rec);
    const stNm=stuName(cls,st);
    if(kids.some(k=>k.studentId===st||(k.studentName===stNm&&k.class===cls)))
      return alert(`Ця дитина вже прив'язана.`);
    kids.push({studentId:st,studentName:stNm,class:cls,role});
    await update(ref(db,`parent_links/${se}`),{children:kids});
    // Якщо батьки вже заходили — одразу оновлюємо їхній профіль
    const us=await getUsersSnap();
    if(us.exists()){
      const u=us.val();
      for(const uid in u)
        if((u[uid].email||'').toLowerCase()===raw&&u[uid].role==='parent')
          await update(ref(db,`users/${uid}`),{children:kids});
    }
    logAction('parent_link',{cls,target:stNm,value:raw,role});
    showToast(kids.length>1?`✅ Прив'язано. Дітей у цих батьків: ${kids.length}`:'✅ Прив\'язано');
    document.getElementById('pl-email').value='';
    window.loadParentsOverview();
  }catch(e){alert('Помилка: '+e.message);}
};
// ══════════════════════════════════════════════════════════════════
//  ЗГОДИ БАТЬКІВ
// ══════════════════════════════════════════════════════════════════
// Екскурсія, фотозйомка, басейн — це збиралося паперами тижнями. Тут
// батьки відповідають одним дотиком, а школа отримує зафіксовану дату
// відповіді, що важливо і юридично.
//   consents/{id} = {title, text, classes:[], deadline, createdAt}
//   consent_responses/{id}/{клас}/{ІМ'Я} = {answer:'yes'|'no', by, ts}
window.loadConsents=async function(){
  const box=document.getElementById('cs-list');
  if(!box)return;
  box.innerHTML='<p class="empty-msg">Завантаження...</p>';
  try{
    const [cSnap,rSnap,stSnap]=await Promise.all([
      get(child(ref(db),'consents')),
      get(child(ref(db),'consent_responses')),
      get(child(ref(db),'students_list'))
    ]);
    if(!cSnap.exists()){box.innerHTML='<p class="empty-msg">Запитів на згоду ще немає.</p>';return;}
    const all=cSnap.val(), resp=rSnap.exists()?rSnap.val():{}, students=stSnap.exists()?stSnap.val():{};
    const ids=Object.keys(all).sort((a,b)=>(all[b].createdAt||0)-(all[a].createdAt||0));
    box.innerHTML=ids.map(id=>{
      const c=all[id];
      const classes=Array.isArray(c.classes)?c.classes:(c.classes==='all'?Object.keys(students):[]);
      // Скільки всього мають відповісти і скільки вже відповіли
      let total=0,yes=0,no=0;
      classes.forEach(cls=>{
        total+=students[cls]?Object.keys(students[cls]).length:0;
        const r=resp[id]&&resp[id][cls];
        if(r)for(const st in r){if(r[st].answer==='yes')yes++;else if(r[st].answer==='no')no++;}
      });
      const left=Math.max(0,total-yes-no);
      const overdue=c.deadline&&c.deadline<localDateString&&left>0;
      return `<div class="cs-card${overdue?' overdue':''}">
        <div class="cs-head">
          <b>${escHtml(c.title||'—')}</b>
          <button class="staff-del" onclick="deleteConsent('${escJs(id)}')">🗑</button>
        </div>
        ${c.text?`<div class="cs-text">${escHtml(c.text)}</div>`:''}
        <div class="cs-meta">
          ${escHtml(classes.map(x=>x.replace('class_','')).join(', '))} кл.
          ${c.deadline?` · до ${escHtml(c.deadline.split('-').reverse().join('.'))}`:''}
          ${overdue?' · <b style="color:var(--red);">термін минув</b>':''}
        </div>
        <div class="cs-stats">
          <span class="cs-yes">✓ ${yes}</span>
          <span class="cs-no">✕ ${no}</span>
          <span class="cs-wait">очікуємо ${left}</span>
        </div>
        <button class="cs-detail" onclick="showConsentDetail('${escJs(id)}')">Хто ще не відповів →</button>
      </div>`;
    }).join('');
  }catch(e){box.innerHTML=`<p style="color:red;font-size:.8rem;">Помилка: ${escHtml(e.message)}</p>`;}
};
window.showConsentDetail=async function(id){
  const box=document.getElementById('cs-list');
  const [cSnap,rSnap,stSnap]=await Promise.all([
    get(child(ref(db),`consents/${id}`)),
    get(child(ref(db),`consent_responses/${id}`)),
    get(child(ref(db),'students_list'))
  ]);
  if(!cSnap.exists())return;
  const c=cSnap.val(), resp=rSnap.exists()?rSnap.val():{}, students=stSnap.exists()?stSnap.val():{};
  const classes=Array.isArray(c.classes)?c.classes:Object.keys(students);
  let html=`<button class="cs-detail" onclick="loadConsents()">← Назад до списку</button>
    <div class="cs-card"><b>${escHtml(c.title||'')}</b>`;
  classes.forEach(cls=>{
    const pairs=students[cls]?Object.entries(students[cls]).map(([sid,nm])=>({sid,nm:String(nm)}))
      .sort((a,b)=>a.nm.localeCompare(b.nm,'uk')):[];
    const r=resp[cls]||{};
    const pending=pairs.filter(p=>!r[p.sid]&&!r[p.nm]);
    html+=`<div class="cs-cls">${escHtml(cls.replace('class_',''))} клас</div>`;
    html+=pairs.map(p=>{
      const a=(r[p.sid]||r[p.nm])?.answer;
      return `<div class="cs-row">
        <span>${escHtml(p.nm)}</span>
        <span class="${a==='yes'?'cs-yes':a==='no'?'cs-no':'cs-wait'}">${a==='yes'?'✓ згода':a==='no'?'✕ відмова':'очікуємо'}</span>
      </div>`;
    }).join('');
    if(pending.length===0)html+='<div class="cs-ok">усі відповіли</div>';
  });
  box.innerHTML=html+'</div>';
};
window.createConsent=async function(){
  const title=document.getElementById('cs-title').value.trim();
  const text=document.getElementById('cs-text').value.trim();
  const deadline=document.getElementById('cs-deadline').value;
  const allCls=document.getElementById('cs-all').checked;
  const sel=document.getElementById('cs-classes');
  const classes=allCls?Array.from({length:11},(_,i)=>`class_${i+1}`)
                      :Array.from(sel.selectedOptions).map(o=>o.value);
  if(!title)return alert('Введіть назву запиту.');
  if(classes.length===0)return alert('Оберіть класи або позначте «Усі класи».');
  await push(ref(db,'consents'),{title,text,classes,deadline,
    createdBy:currentUserData?.email||'',createdAt:Date.now()});
  logAction('consent_create',{target:title,value:classes.length+' кл.'});
  ['cs-title','cs-text','cs-deadline'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('cs-all').checked=false;sel.disabled=false;
  Array.from(sel.options).forEach(o=>o.selected=false);
  showToast('✅ Запит на згоду створено');
  window.loadConsents();
};
window.deleteConsent=async function(id){
  if(!confirm('Видалити цей запит разом з усіма відповідями батьків?'))return;
  await Promise.all([remove(ref(db,`consents/${id}`)),remove(ref(db,`consent_responses/${id}`))]);
  showToast('🗑️ Видалено');window.loadConsents();
};
window.toggleConsentAll=function(){
  const cb=document.getElementById('cs-all'), sel=document.getElementById('cs-classes');
  sel.disabled=cb.checked;
  if(cb.checked)Array.from(sel.options).forEach(o=>o.selected=false);
};
// ══════════════════════════════════════════════════════════════════
//  ВІДСУТНІСТЬ ВЧИТЕЛІВ І ЗАМІНИ
// ══════════════════════════════════════════════════════════════════
// Відвідуваність у порталі велася лише для дітей. Для директора ж
// щоранку головне питання інше: хто з учителів сьогодні не вийшов і хто
// закриє його уроки.
//   staff_absence/{дата}/{email_}       = {name, reason, note}
//   substitutions/{дата}/{клас}/{слот}  = {subject, origName, subName, subEmail}
// Раніше substitutions писалися у формі {клас}/{дата} і ніде не читалися —
// структуру змінено на «за датою», бо саме так її переглядають.
window.loadAbsenceDay=async function(){
  const date=document.getElementById('sa-date').value;
  const box=document.getElementById('sa-list');
  if(!box||!date)return;
  box.innerHTML='<p class="empty-msg">Завантаження...</p>';
  try{
    const [absSnap,subSnap,schedSnap]=await Promise.all([
      get(child(ref(db),`staff_absence/${date}`)),
      get(child(ref(db),`substitutions/${date}`)),
      get(child(ref(db),'schedules'))
    ]);
    const abs=absSnap.exists()?absSnap.val():{};
    const subs=subSnap.exists()?subSnap.val():{};
    const scheds=schedSnap.exists()?schedSnap.val():{};
    const keys=Object.keys(abs);
    if(keys.length===0){box.innerHTML='<p class="empty-msg">Цього дня всі вчителі на місці.</p>';return;}
    const dayName=dayKeys[new Date(date).getDay()];
    let html='';
    for(const se of keys){
      const a=abs[se], email=se.replace(/_/g,'.');
      // Уроки цього вчителя того дня — щоб було видно, що саме треба закрити
      const lessons=[];
      for(const cls in scheds){
        const days=scheds[cls]?.lessons;if(!days||!days[dayName])continue;
        (days[dayName]||[]).forEach((slot,idx)=>{
          const items=Array.isArray(slot)?slot:(slot&&slot.subject?[slot]:[]);
          items.forEach(l=>{
            if(!l||l.type==='break')return;
            const sn=typeof l.subject==='string'?l.subject:(l.subject?.ua||'');
            let te=l.teacherEmail;
            if(!te&&sn){const dt=window.getDefaultTeacher(cls,sn);if(dt)te=dt.email;}
            if(!te||te.toLowerCase()!==email.toLowerCase())return;
            const cover=subs[cls]&&subs[cls][idx];
            lessons.push({cls,idx,sn,time:l.time||'',cover});
          });
        });
      }
      const open=lessons.filter(l=>!l.cover).length;
      html+=`<div class="sa-card">
        <div class="sa-head">
          <div><b>${escHtml(a.name||email)}</b><div class="sa-mail">${escHtml(email)}</div></div>
          <button class="staff-del" onclick="unmarkStaffAbsent('${escJs(se)}')">✖</button>
        </div>
        <div class="sa-reason">${escHtml(a.reason||'')}${a.note?' · '+escHtml(a.note):''}</div>
        ${lessons.length===0
          ? '<div class="sa-none">Уроків цього дня немає</div>'
          : `<div class="sa-sub">${open>0?`⚠️ Без заміни: ${open} з ${lessons.length}`:`✓ Усі ${lessons.length} уроків закрито`}</div>`+
            lessons.map(l=>`<div class="sa-lesson">
              <span class="sa-l-info">${escHtml(l.cls.replace('class_',''))} кл · ${escHtml(l.sn)}${l.time?` · ${escHtml(l.time)}`:''}</span>
              ${l.cover
                ? `<span class="sa-cover">→ ${escHtml(l.cover.subName||l.cover.subEmail||'')}
                     <button class="sa-x" onclick="clearSubstitute('${escJs(l.cls)}',${l.idx})">✖</button></span>`
                : `<select class="sa-pick" onchange="assignSubstitute('${escJs(l.cls)}',${l.idx},'${escJs(l.sn)}','${escJs(a.name||email)}',this.value)">
                     <option value="">— обрати заміну —</option>
                     ${(window.globalTeachersList||[]).filter(t=>t.email.toLowerCase()!==email.toLowerCase())
                        .map(t=>`<option value="${escHtml(t.email)}|${escHtml(t.name)}">${escHtml(t.name)}</option>`).join('')}
                   </select>`}
            </div>`).join('')}
      </div>`;
    }
    box.innerHTML=html;
  }catch(e){box.innerHTML=`<p style="color:red;font-size:.8rem;">Помилка: ${escHtml(e.message)}</p>`;}
};
window.markStaffAbsent=async function(){
  const date=document.getElementById('sa-date').value;
  const sel=document.getElementById('sa-teacher');
  const reason=document.getElementById('sa-reason').value;
  const note=document.getElementById('sa-note').value.trim();
  if(!date||!sel.value)return alert('Оберіть дату та вчителя.');
  const [email,name]=sel.value.split('|');
  await set(ref(db,`staff_absence/${date}/${email.replace(/\./g,'_')}`),
            {name,email,reason,note,by:currentUserData?.email||'',ts:Date.now()});
  logAction('staff_absent',{target:name,date,value:reason});
  document.getElementById('sa-note').value='';
  showToast(`✅ ${name} відмічений відсутнім`);
  window.loadAbsenceDay();
};
window.unmarkStaffAbsent=async function(se){
  const date=document.getElementById('sa-date').value;
  if(!confirm('Прибрати відмітку про відсутність?\n\nПризначені заміни залишаться — приберіть їх окремо, якщо потрібно.'))return;
  await remove(ref(db,`staff_absence/${date}/${se}`));
  showToast('Відмітку прибрано');
  window.loadAbsenceDay();
};
window.assignSubstitute=async function(cls,idx,subject,origName,val){
  if(!val)return;
  const date=document.getElementById('sa-date').value;
  const [subEmail,subName]=val.split('|');
  await set(ref(db,`substitutions/${date}/${cls}/${idx}`),
            {subject,origName,subEmail,subName,by:currentUserData?.email||'',ts:Date.now()});
  logAction('substitute',{cls,subject,date,target:subName,from:origName});
  showToast(`✅ Заміна: ${subName}`);
  window.loadAbsenceDay();
};
window.clearSubstitute=async function(cls,idx){
  const date=document.getElementById('sa-date').value;
  await remove(ref(db,`substitutions/${date}/${cls}/${idx}`));
  showToast('Заміну прибрано');
  window.loadAbsenceDay();
};
window.fillAbsenceTeachers=function(){
  const sel=document.getElementById('sa-teacher');
  if(!sel)return;
  sel.innerHTML='<option value="">— оберіть вчителя —</option>'+
    (window.globalTeachersList||[]).map(t=>`<option value="${escHtml(t.email)}|${escHtml(t.name)}">${escHtml(t.name)}</option>`).join('');
  const d=document.getElementById('sa-date');
  if(d&&!d.value)d.value=localDateString;
};
// ══════════ ГЛОБАЛЬНИЙ ПОШУК ══════════
// На 165 учнях, щоб знайти людину, треба пам'ятати її клас. Тут шукаємо
// по всій школі одразу — за ім'ям учня, ПІБ батьків, поштою чи телефоном.
let searchIndex=null;
async function buildSearchIndex(){
  const [stSnap,plSnap,slSnap]=await Promise.all([
    get(child(ref(db),'students_list')),
    get(child(ref(db),'parent_links')),
    get(child(ref(db),'student_links'))
  ]);
  const idx=[];
  // Учні
  if(stSnap.exists()){
    const all=stSnap.val();
    for(const cls in all)for(const k in all[cls])
      idx.push({type:'student',cls,name:all[cls][k],hay:`${all[cls][k]}`.toLowerCase()});
  }
  // Власні входи учнів — щоб можна було шукати і за поштою дитини
  if(slSnap.exists()){
    const sl=slSnap.val();
    for(const se in sl){
      const v=sl[se];if(!v?.studentName)continue;
      const email=se.replace(/_/g,'.');
      const hit=idx.find(i=>i.type==='student'&&i.name===v.studentName&&i.cls===v.class);
      if(hit){hit.email=email;hit.hay+=' '+email.toLowerCase();}
    }
  }
  // Батьки — по кожній прив'язаній дитині окремим записом
  if(plSnap.exists()){
    const pl=plSnap.val();
    for(const se in pl){
      const rec=pl[se], email=se.replace(/_/g,'.'), pr=getParentProfile(rec);
      const fio=parentFullName(pr,'');
      normalizeChildren(rec).forEach(k=>{
        idx.push({type:'parent',cls:k.class,name:fio||email,child:k.studentName,email,
          phone:[pr.phonePL,pr.phoneUA].filter(Boolean).join(' '),tg:pr.telegram||'',
          hay:`${fio} ${email} ${pr.phonePL} ${pr.phoneUA} ${pr.telegram} ${k.studentName}`.toLowerCase()});
      });
    }
  }
  return idx;
}
window.runGlobalSearch=async function(){
  const q=document.getElementById('gs-query').value.trim().toLowerCase();
  const box=document.getElementById('gs-results');
  if(!box)return;
  if(q.length<2){box.innerHTML='<p class="empty-msg">Введіть щонайменше 2 символи.</p>';return;}
  box.innerHTML='<p class="empty-msg">Пошук...</p>';
  try{
    // Індекс будуємо один раз за сеанс — школа невелика, дані змінюються рідко
    if(!searchIndex)searchIndex=await buildSearchIndex();
    const hits=searchIndex.filter(i=>i.hay.includes(q)).slice(0,40);
    if(hits.length===0){box.innerHTML='<p class="empty-msg">Нічого не знайдено.</p>';return;}
    box.innerHTML=hits.map(h=>h.type==='student'
      ? `<div class="gs-row" onclick="gsGoto('${escJs(h.cls)}')">
           <span class="gs-tag st">Учень</span>
           <span class="gs-main">${escHtml(h.name)}</span>
           <span class="gs-sub">${escHtml(h.cls.replace('class_',''))} кл.${h.email?' · '+escHtml(h.email):''}</span>
         </div>`
      : `<div class="gs-row" onclick="gsGoto('${escJs(h.cls)}')">
           <span class="gs-tag pa">Батьки</span>
           <span class="gs-main">${escHtml(h.name)}</span>
           <span class="gs-sub">дитина: ${escHtml(h.child)} · ${escHtml(h.cls.replace('class_',''))} кл.<br>
             ${escHtml(h.email)}${h.phone?' · '+escHtml(h.phone):''}${h.tg?' · '+escHtml(h.tg):''}</span>
         </div>`).join('');
  }catch(e){box.innerHTML=`<p style="color:red;font-size:.8rem;">Помилка: ${escHtml(e.message)}</p>`;}
};
// Перехід до знайденого: відкриваємо список того класу
window.gsGoto=function(cls){
  const sel=document.getElementById('po-class');
  if(sel){sel.value=cls;window.loadParentsOverview();window.loadParentLinkStudents();}
  showToast(`Відкрито ${cls.replace('class_','')} клас нижче`);
};
window.resetSearchIndex=function(){searchIndex=null;showToast('Індекс оновлено');};
// ══════════ СТАТИСТИКА ВІДВІДУВАНОСТІ ══════════
// Відвідуваність досі було видно лише по днях — картини в цілому не було,
// хоча школа зобов'язана її відстежувати. Рахуємо за місяць: по класах
// і поіменно тих, хто пропускає найбільше.
window.loadAttendanceStats=async function(){
  const box=document.getElementById('att-stats');
  if(!box)return;
  const ym=document.getElementById('att-month').value||localDateString.slice(0,7);
  box.innerHTML='<p class="empty-msg">Обчислення...</p>';
  try{
    const all=await getSchoolRange('attendance', ym+'-01', ym+'-31');
    if(!Object.keys(all).length){box.innerHTML='<p class="empty-msg">Даних немає.</p>';return;}
    const byClass={},byStudent={};
    let totAbs=0,totLate=0;
    for(let i=1;i<=11;i++){
      const cls=`class_${i}`;
      if(!all[cls])continue;
      byClass[cls]={abs:0,late:0};
      for(const date in all[cls]){
        if(!date.startsWith(ym))continue;
        for(const st in all[cls][date]){
          const slots=all[cls][date][st];
          if(!slots||typeof slots!=='object')continue;
          // Кілька уроків одного дня рахуємо як один пропуск дня —
          // інакше в учня з 6 уроками буде 6 «пропусків» замість одного
          let dayAbs=false,dayLate=false;
          for(const sk in slots){
            const r=slots[sk];
            if(r?.status==='absent')dayAbs=true;
            else if(r?.status==='late')dayLate=true;
          }
          if(!dayAbs&&!dayLate)continue;
          const key=`${cls}|${st}`;
          byStudent[key]=byStudent[key]||{cls,st,nm:stuName(cls,st),abs:0,late:0};
          if(dayAbs){byClass[cls].abs++;byStudent[key].abs++;totAbs++;}
          if(dayLate){byClass[cls].late++;byStudent[key].late++;totLate++;}
        }
      }
    }
    const top=Object.values(byStudent).sort((a,b)=>(b.abs*2+b.late)-(a.abs*2+a.late)).slice(0,12);
    let html=`<div class="as-sum">
      <div><b>${totAbs}</b><span>днів пропусків</span></div>
      <div><b>${totLate}</b><span>запізнень</span></div>
    </div>`;
    html+='<div class="as-title">По класах</div><div class="as-classes">';
    for(let i=1;i<=11;i++){
      const c=byClass[`class_${i}`];
      const n=c?c.abs:0;
      html+=`<span class="as-cls${n>0?'':' zero'}">${i} кл: <b>${n}</b>${c&&c.late?` +${c.late}з`:''}</span>`;
    }
    html+='</div>';
    if(top.length>0){
      html+='<div class="as-title">Найбільше пропусків</div>';
      html+=top.map(t=>`<div class="as-row">
        <span class="as-name">${escHtml(t.nm||t.st)} <span class="as-c">${escHtml(t.cls.replace('class_',''))} кл.</span></span>
        <span class="as-nums">${t.abs?`<b>${t.abs}</b> проп.`:''}${t.late?` · ${t.late} зап.`:''}</span>
      </div>`).join('');
    }
    box.innerHTML=html;
  }catch(e){box.innerHTML=`<p style="color:red;font-size:.8rem;">Помилка: ${escHtml(e.message)}</p>`;}
};
// ══════════ ЖУРНАЛ ДІЙ: перегляд ══════════
// Читаємо лише обраний місяць і лише останні 300 записів — інакше з часом
// сторінка почне вантажити десятки тисяч рядків.
const AUDIT_LIMIT=300;
window.loadAuditLog=async function(){
  const box=document.getElementById('audit-list');
  if(!box)return;
  const ym=document.getElementById('audit-month').value||localDateString.slice(0,7);
  const fAction=document.getElementById('audit-action').value;
  const fText=document.getElementById('audit-search').value.trim().toLowerCase();
  box.innerHTML='<p class="empty-msg">Завантаження...</p>';
  try{
    // Сортуємо за ключем, а не за полем ts: push-ключі Firebase генеруються
    // хронологічно, тож limitToLast без orderByChild дає ті самі останні
    // записи — і не потребує оголошення індексу ".indexOn" у правилах.
    const snap=await get(query(child(ref(db),`audit_log/${ym}`),limitToLast(AUDIT_LIMIT)));
    if(!snap.exists()){box.innerHTML='<p class="empty-msg">За цей місяць записів немає.</p>';return;}
    let rows=Object.values(snap.val()).sort((a,b)=>b.ts-a.ts);
    if(fAction)rows=rows.filter(r=>r.action===fAction);
    if(fText)rows=rows.filter(r=>JSON.stringify(r).toLowerCase().includes(fText));
    if(rows.length===0){box.innerHTML='<p class="empty-msg">Нічого не знайдено за фільтром.</p>';return;}
    const fmt=ts=>{const d=new Date(ts);return d.toLocaleString('uk-UA',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});};
    box.innerHTML=`<p style="font-size:.75rem;color:#888;margin:0 0 6px 0;">Показано ${rows.length} з останніх ${AUDIT_LIMIT} за місяць</p>`+
      rows.map(r=>{
        // Деталі показуємо лише ті, що є — щоб рядок не рябів порожнечею
        const bits=[];
        if(r.cls)bits.push(`${escHtml(String(r.cls).replace('class_',''))} кл.`);
        if(r.target)bits.push(escHtml(r.target));
        if(r.subject)bits.push(escHtml(r.subject));
        if(r.value)bits.push(`<b>${escHtml(r.value)}</b>`);
        if(r.from)bits.push(`було: ${escHtml(r.from)}`);
        if(r.date)bits.push(escHtml(String(r.date).split('-').reverse().join('.')));
        return `<div class="audit-row">
          <span class="audit-time">${fmt(r.ts)}</span>
          <span class="audit-act">${escHtml(AUDIT_LABELS[r.action]||r.action)}</span>
          <span class="audit-det">${bits.join(' · ')}</span>
          <span class="audit-who">${escHtml(r.actor||'—')}</span>
        </div>`;
      }).join('');
  }catch(e){box.innerHTML=`<p style="color:red;font-size:.8rem;">Помилка: ${escHtml(e.message)}</p>`;}
};
window.fillAuditActions=function(){
  const sel=document.getElementById('audit-action');
  if(!sel||sel.options.length>1)return;
  sel.innerHTML='<option value="">— усі дії —</option>'+
    Object.entries(AUDIT_LABELS).map(([k,v])=>`<option value="${k}">${escHtml(v)}</option>`).join('');
  const m=document.getElementById('audit-month');
  if(m&&!m.value)m.value=localDateString.slice(0,7);
};
// ══════════ AI: ЧЕРНЕТКА ОГОЛОШЕННЯ ДЛЯ БАТЬКІВ ══════════
// У сервіс іде лише те, що директор написав сам. Жодних даних із бази.
window.announcementAI=async function(){
  const note=document.getElementById('d-ann-note').value.trim();
  const btn=document.getElementById('btn-ai-ann');
  const out=document.getElementById('d-ann-out');
  const copyBtn=document.getElementById('btn-ann-copy');
  const msg=(t,e)=>{const el=document.getElementById('ai-ann-msg');el.textContent=t||'';el.className='ai-hw-msg'+(e?' err':'');el.style.display=t?'block':'none';};
  if(!note)return msg('Напишіть коротко, про що оголошення.',true);
  btn.disabled=true;const label=btn.textContent;btn.textContent='⏳ Складаю...';
  msg('');
  try{
    const r=await fetch('/.netlify/functions/ai-assist',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({task:'announcement',note})
    });
    const data=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(data.error||`Помилка ${r.status}`);
    out.value=data.text||'';out.style.display='block';copyBtn.style.display='block';
    msg('✨ Готово. Перевірте дати й деталі — і можна надсилати.');
  }catch(e){msg('Не вдалося скласти: '+e.message,true);}
  finally{btn.disabled=false;btn.textContent=label;}
};
window.copyAnnouncement=async function(){
  const out=document.getElementById('d-ann-out');
  if(!out||!out.value)return;
  try{await navigator.clipboard.writeText(out.value);showToast('📋 Текст скопійовано');}
  catch(e){out.select();showToast('Виділено — натисніть Ctrl+C');}
};
// ══════════ УЧНІ: ведення списків директором ══════════
// Окремого «списку учнів» більше немає — учні показуються в об'єднаному
// списку разом зі своїми батьками (renderParentsBlock у common.js).
// Тут лишилася лише форма додавання; клас береться з того самого селектора.
window.directorAddStudent=async function(){
  const cls=document.getElementById('po-class').value;
  const name=document.getElementById('ds-new-name').value.trim();
  const emailRaw=document.getElementById('ds-new-email').value.trim().toLowerCase();
  if(!cls)return alert('Спочатку оберіть клас.');
  if(!name)return alert('Введіть прізвище та ім\'я учня.');
  // Ім'я стає ключем у грейдах і відвідуваності — Firebase ці символи в ключах не дозволяє
  if(/[.#$[\]/]/.test(name))return alert("Ім'я не може містити символи . # $ [ ] /");
  const nName=name.replace(/\s+/g,' ');
  // Тезка в одному класі призвела б до злиття двох дітей в один запис
  const exSnap=await get(child(ref(db),`students_list/${cls}`));
  if(exSnap.exists()){
    const same=Object.values(exSnap.val()).find(v=>String(v).replace(/\s+/g,' ').toLowerCase()===nName.toLowerCase());
    if(same)return alert(`У цьому класі вже є учень «${same}».\n\nДані не переплутаються — у кожного свій постійний ключ. Але два однакових рядки в журналі плутають учителів. Додайте по батькові або другу літеру імені.`);
  }
  try{
    const newRef = await push(ref(db,`students_list/${cls}`),nName);
    const newSid = newRef.key;
    // Email потрібен лише якщо учень заходитиме у портал самостійно
    if(emailRaw)await set(ref(db,`student_links/${emailRaw.replace(/\./g,'_')}`),{studentName:nName,studentId:newSid,class:cls});
    document.getElementById('ds-new-name').value='';
    document.getElementById('ds-new-email').value='';
    invalidateStudentDir(cls); if(window.preloadStudentDirs) await window.preloadStudentDirs();
    showToast(`✅ ${nName} доданий до ${cls.replace('class_','')} класу`);
    logAction('student_add',{cls,target:name});
    refreshRoster(cls);
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
// renameKeyAtDepth / renameStudentEverywhere видалено: після переходу на
// постійні ідентифікатори перейменування не зачіпає історію взагалі.
window.editStudentName=function(cls,key,name){
  const row=document.getElementById(`ds-row-${key}`);
  const cell=row&&row.querySelector('.po-child');
  if(!cell)return;
  cell.innerHTML=`<input type="text" id="ds-edit-${key}" value="${escHtml(name)}" style="width:100%;margin:0 0 5px 0;padding:6px 9px;font-size:.85rem;">
    <span class="po-child-acts">
      <button class="ds-ok" onclick="saveStudentName('${escJs(cls)}','${escJs(key)}','${escJs(name)}')">✔</button>
      <button class="po-edit" onclick="refreshRoster('${escJs(cls)}')">✖</button>
    </span>`;
  const inp=document.getElementById(`ds-edit-${key}`);
  if(inp){inp.focus();inp.select();
    inp.addEventListener('keydown',e=>{
      if(e.key==='Enter'){e.preventDefault();window.saveStudentName(cls,key,name);}
      if(e.key==='Escape'){e.preventDefault();refreshRoster(cls);}
    });}
};
window.saveStudentName=async function(cls,key,oldName){
  const inp=document.getElementById(`ds-edit-${key}`);
  if(!inp)return;
  const newName=inp.value.trim().replace(/\s+/g,' ');
  if(!newName)return alert("Ім'я не може бути порожнім.");
  if(newName===oldName)return refreshRoster(cls);
  // Firebase забороняє ці символи в ключах, а ім'я стає ключем в оцінках
  if(/[.#$[\]/]/.test(newName))return alert('Ім\'я не може містити символи . # $ [ ] /');
  // Перевірка на дубль у цьому ж класі
  const listSnap=await get(child(ref(db),`students_list/${cls}`));
  if(listSnap.exists()){
    const names=Object.entries(listSnap.val());
    if(names.some(([k,v])=>k!==key&&v===newName))
      return alert(`У цьому класі вже є учень «${newName}». Оберіть інше написання.`);
  }
  if(!confirm(`Перейменувати «${oldName}» → «${newName}»?\n\nІсторія оцінок і відвідуваності збережеться: вона привʼязана до постійного ідентифікатора учня, а не до імені.`))return refreshRoster(cls);
  const row=document.getElementById(`ds-row-${key}`);
  if(row)row.innerHTML='<span style="font-size:.82rem;color:#888;">⏳ Перейменування...</span>';
  try{
    // Після переходу на ідентифікатори перейменування — це один запис.
    // Переносити історію більше не треба: вона лежить під ключем, який
    // не змінюється. Оновлюємо лише підписи там, де зберігається імʼя.
    await set(ref(db,`students_list/${cls}/${key}`),newName);
    invalidateStudentDir(cls);
    if(window.preloadStudentDirs) await window.preloadStudentDirs();
    // Прив'язки батьків та учня зберігають імʼя для показу — освіжаємо
    const [plSnap, slSnap] = await Promise.all([
      get(child(ref(db),'parent_links')), get(child(ref(db),'student_links'))
    ]);
    const upd = {};
    if(plSnap.exists()){
      const pl = plSnap.val();
      for(const se in pl){
        const kids = normalizeChildren(pl[se]);
        let changed = false;
        kids.forEach((k,i)=>{ if(k.studentId===key || (k.studentName===oldName && k.class===cls)){ kids[i]={...k, studentId:key, studentName:newName}; changed=true; } });
        if(changed) upd[`parent_links/${se}/children`] = kids;
      }
    }
    if(slSnap.exists()){
      const sl = slSnap.val();
      for(const se in sl)
        if(sl[se] && (sl[se].studentId===key || (sl[se].studentName===oldName && sl[se].class===cls)))
          upd[`student_links/${se}/studentName`] = newName;
    }
    if(Object.keys(upd).length) await update(ref(db), upd);
    logAction('student_rename',{cls,target:newName,from:oldName});
    showToast('✅ Перейменовано');
    refreshRoster(cls);
  }catch(e){alert('Помилка: '+e.message);refreshRoster(cls);}
};
window.removeStudent=async function(cls,key,name){
  if(!confirm(`Прибрати ${name} зі списку ${cls.replace('class_','')} класу?\n\nВиставлені оцінки, відвідуваність і коментарі ЗАЛИШАТЬСЯ в журналі —\nвони зберігаються окремо і не видаляються.\n\nПродовжити?`))return;
  try{
    await remove(ref(db,`students_list/${cls}/${key}`));
    invalidateStudentDir(cls);
    if(window.preloadStudentDirs) await window.preloadStudentDirs();
    showToast(`🗑️ ${name} прибраний зі списку`);
    logAction('student_del',{cls,target:name});
    refreshRoster(cls);
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
  if(snap.exists())Object.entries(snap.val()).sort((a,b)=>String(a[1]).localeCompare(String(b[1]),'uk')).forEach(([sid,nm])=>{const o=document.createElement('option');o.value=sid;o.innerText=nm;sel.appendChild(o);});
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
        const us=await getUsersSnap();
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

// Тезки, що вже потрапили в базу до появи перевірки. Порівнюємо без огляду
// на регістр і подвійні пробіли — «Іван  Петренко» та «іван петренко»
// виглядають по-різному, але для людини це та сама дитина.
window.findDuplicateStudents = async function(){
  const box = document.getElementById('d-dup-result');
  if(!box) return;
  box.style.display='block';
  box.innerHTML = '<p class="empty-msg">Перевіряю...</p>';
  const snap = await get(child(ref(db),'students_list'));
  if(!snap.exists()){ box.innerHTML='<p class="empty-msg">Списків учнів немає.</p>'; return; }
  const all = snap.val();
  const problems = [];
  for(let i=1;i<=11;i++){
    const cls = `class_${i}`;
    if(!all[cls]) continue;
    const seen = {};
    for(const k in all[cls]){
      const raw = String(all[cls][k]);
      const norm = raw.replace(/\s+/g,' ').trim().toLowerCase();
      if(seen[norm]) problems.push({cls:i, a:seen[norm], b:raw, exact:seen[norm]===raw});
      else seen[norm] = raw;
    }
  }
  if(!problems.length){
    box.innerHTML = '<p style="color:#1b5e20;font-size:.85rem;margin:0;">✅ Тезок не знайдено. Дані в порядку.</p>';
    return;
  }
  box.innerHTML = `<p style="color:#b71c1c;font-weight:700;font-size:.85rem;margin:0 0 7px 0;">Знайдено збігів: ${problems.length}</p>`
    + problems.map(p=>`<div style="font-size:.82rem;padding:5px 0;border-bottom:1px dashed #eee;">
        <b>${p.cls} клас</b> — «${escHtml(p.a)}» та «${escHtml(p.b)}»
        ${p.exact?'<span style="color:#b71c1c;"> · повний збіг, дані вже спільні</span>'
                 :'<span style="color:#e65100;"> · різне написання, дані розділені</span>'}
      </div>`).join('')
    + `<p style="font-size:.78rem;color:#666;margin-top:9px;">Виправляйте перейменуванням: додайте по батькові або другу літеру імені. Перейменування переносить усю історію.</p>`;
};

// ══════════ АУДИТ ПЕРЕХОДУ НА ІДЕНТИФІКАТОРИ ══════════
// Не мігрує, лише рахує. Обхід рекурсивний: ключ вважається іменем учня,
// якщо він збігається з іменем зі students_list того класу, у чиїй гілці
// ми зараз перебуваємо. Так не треба вгадувати глибину кожного вузла —
// а саме на вгадуванні глибини такі міграції зазвичай і ламаються.
const KEY_NODES = ['grades','attendance','comments','stickers','behavior_grades',
                   'reactions','retake_requests','semester_grades','meal_plan',
                   'meal_day','consent_responses'];

window.auditStudentKeys = async function(){
  const box = document.getElementById('d-idmig-result');
  if(!box) return;
  box.style.display = 'block';
  box.innerHTML = '<p class="empty-msg">Рахую... на великій базі це може зайняти хвилину.</p>';
  try{
    // Довідники імен по класах
    const dirs = {};
    const stSnap = await get(child(ref(db),'students_list'));
    const lists = stSnap.exists() ? stSnap.val() : {};
    for(const cls in lists){
      const byName = {};
      for(const sid in lists[cls]) byName[String(lists[cls][sid]).replace(/\s+/g,' ').trim().toLowerCase()] = sid;
      dirs[cls] = byName;
    }

    const report = {};
    let orphanTotal = 0;
    const orphanSamples = [];

    const walk = (node, cls, path, nodeName) => {
      if(!node || typeof node !== 'object') return;
      for(const k in node){
        const isCls = /^class_\d+$/.test(k);
        const curCls = isCls ? k : cls;
        // Ключ схожий на імʼя? (містить пробіл і літери, не дата, не число)
        const looksName = !isCls && /[^\d\-_.]/.test(k) && k.includes(' ') && !/^\d{4}-\d{2}/.test(k);
        if(looksName && curCls){
          const sid = (dirs[curCls]||{})[k.replace(/\s+/g,' ').trim().toLowerCase()];
          report[nodeName] = report[nodeName] || {found:0, orphan:0};
          if(sid) report[nodeName].found++;
          else {
            report[nodeName].orphan++;
            orphanTotal++;
            if(orphanSamples.length < 12) orphanSamples.push(`${nodeName} · ${curCls.replace('class_','')} кл · «${k}»`);
          }
          continue;   // глибше під іменем шукати нічого
        }
        walk(node[k], curCls, path+'/'+k, nodeName);
      }
    };

    for(const n of KEY_NODES){
      const snap = await get(child(ref(db), n));
      if(snap.exists()) walk(snap.val(), null, n, n);
    }

    const rows = Object.keys(report).sort();
    if(!rows.length){ box.innerHTML = '<p class="empty-msg">Записів, ключованих імʼям, не знайдено.</p>'; return; }
    const total = rows.reduce((a,n)=>a+report[n].found+report[n].orphan, 0);

    box.innerHTML = `
      <div style="background:#e0f7fa;border-radius:10px;padding:10px 13px;margin-bottom:9px;">
        <b style="font-size:1.05rem;color:#00838f;">${total}</b>
        <span style="font-size:.82rem;color:#555;"> записів ключовано імʼям учня</span>
      </div>
      <table class="k-table"><thead><tr><th>Розділ</th><th>Знайдено учня</th><th>Немає в списку</th></tr></thead><tbody>
      ${rows.map(n=>`<tr><td>${escHtml(n)}</td><td>${report[n].found}</td>
        <td style="color:${report[n].orphan?'#b71c1c':'#999'};">${report[n].orphan||''}</td></tr>`).join('')}
      </tbody></table>
      ${orphanTotal ? `<div class="k-skip-title">Імена, яких немає у списках класу (${orphanTotal})</div>
        <p style="font-size:.76rem;color:#666;margin:0 0 6px 0;">Це або вибулі учні, або описки в написанні. Такі записи при переході на ідентифікатори втратять звʼязок з дитиною — їх треба або виправити, або свідомо лишити в архіві.</p>
        ${orphanSamples.map(x=>`<div style="font-size:.79rem;padding:2px 0;">${escHtml(x)}</div>`).join('')}
        ${orphanTotal>12?`<div style="font-size:.76rem;color:#999;padding-top:4px;">…та ще ${orphanTotal-12}</div>`:''}`
      : '<p style="color:#1b5e20;font-size:.82rem;margin-top:9px;">✅ Усі імена в даних збігаються зі списками класів. Перехід пройде без втрат.</p>'}`;
  }catch(e){
    box.innerHTML = `<p style="color:red;font-size:.8rem;">Помилка: ${escHtml(e.message)}</p>`;
  }
};

// ══════════ ОЧИЩЕННЯ СТАРИХ ЗАПИСІВ, КЛЮЧОВАНИХ ІМЕНЕМ ══════════
// Після переходу на ідентифікатори старі тестові записи стають сміттям:
// код їх уже не читає, але вони плутають підрахунки й аудит. Видаляє лише
// ті ключі, які збігаються з іменем учня зі списку класу; записи під
// ідентифікаторами не чіпає.
window.wipeLegacyStudentKeys = async function(){
  const box = document.getElementById('d-idmig-result');
  if(!box) return;
  if(!confirm('Видалити старі записи, ключовані ІМЕНЕМ учня?\n\nЦе тестові дані до переходу на ідентифікатори. Записи під новими ключами залишаться.\n\nЗробіть Export JSON перед цим.')) return;
  box.style.display='block';
  box.innerHTML = '<p class="empty-msg">Видаляю...</p>';
  try{
    const dirs = {};
    const stSnap = await get(child(ref(db),'students_list'));
    const lists = stSnap.exists()?stSnap.val():{};
    for(const cls in lists){
      const names = {};
      for(const sid in lists[cls]) names[String(lists[cls][sid]).replace(/\s+/g,' ').trim().toLowerCase()] = true;
      dirs[cls] = names;
    }
    const del = {};
    const walk = (node, cls, path) => {
      if(!node || typeof node !== 'object') return;
      for(const k in node){
        const isCls = /^class_\d+$/.test(k);
        const curCls = isCls ? k : cls;
        const looksName = !isCls && k.includes(' ') && !/^\d{4}-\d{2}/.test(k);
        if(looksName && curCls && (dirs[curCls]||{})[k.replace(/\s+/g,' ').trim().toLowerCase()]){
          del[`${path}/${k}`] = null;
          continue;
        }
        walk(node[k], curCls, `${path}/${k}`);
      }
    };
    for(const n of KEY_NODES){
      const snap = await get(child(ref(db), n));
      if(snap.exists()) walk(snap.val(), null, n);
    }
    const cnt = Object.keys(del).length;
    if(!cnt){ box.innerHTML = '<p style="color:#1b5e20;font-size:.85rem;">✅ Старих записів немає — усе вже на ідентифікаторах.</p>'; return; }
    await update(ref(db), del);
    logAction('migration',{ value:`видалено застарілих записів: ${cnt}` });
    box.className = 'k-notify ok';
    box.innerHTML = `<p style="color:#1b5e20;font-size:.85rem;margin:0;">✅ Видалено записів: ${cnt}. Оновіть сторінку.</p>`;
  }catch(e){
    box.innerHTML = `<p style="color:red;font-size:.8rem;">Помилка: ${escHtml(e.message)}</p>`;
  }
};

// ══════════ ВКЛАДКИ КАБІНЕТУ ДИРЕКТОРА ══════════
// У кабінеті сімнадцять блоків. Одним сувоєм до журналу дій треба гортати
// через увесь розклад і персонал. Розкладати HTML наново було б ризиковано,
// тому кожен блок позначено атрибутом data-dtab, а перемикач просто ховає
// зайве. Секцію без жодного видимого блоку ховаємо теж — інакше лишався б
// самотній заголовок.
const DTAB_KEY = 'push_school_dir_tab';
window.switchDirTab = function(tab, btn){
  document.querySelectorAll('#dtab-bar .dtab').forEach(b=>b.classList.toggle('on', b.dataset.t === tab));
  const scr = document.getElementById('director-screen');
  if(!scr) return;

  // Дві секції — просто обгортки: усередині лежать блоки з РІЗНИХ вкладок
  // (наприклад «Матриця доступу» — це персонал, хоча живе в секції розкладу).
  // Тому вирішує не секція, а її вміст. Заголовок такої секції ховаємо
  // назавжди: «Учні» над журналом дій збивав з пантелику.
  scr.querySelectorAll('section.screen-section').forEach(sec=>{
    const kids = Array.from(sec.querySelectorAll(':scope [data-dtab]'));
    if(kids.length){
      let anyVisible = false;
      kids.forEach(k=>{
        const on = k.dataset.dtab === tab;
        k.style.display = on ? '' : 'none';
        if(on) anyVisible = true;
      });
      const mixed = new Set(kids.map(k=>k.dataset.dtab)).size > 1;
      const h3 = sec.querySelector(':scope > h3');
      if(h3) h3.style.display = mixed ? 'none' : '';
      sec.style.display = anyVisible ? '' : 'none';
    } else {
      sec.style.display = (sec.dataset.dtab === tab) ? '' : 'none';
    }
  });
  // Блоки поза секціями (наприклад стрічка новин)
  scr.querySelectorAll(':scope > [data-dtab]').forEach(el=>{
    el.style.display = (el.dataset.dtab === tab) ? '' : 'none';
  });

  try{ localStorage.setItem(DTAB_KEY, tab); }catch(e){}
  if(tab === 'news' && window.renderNewsFeed) window.renderNewsFeed('d-news-feed');
};
// Відновлюємо останню відкриту вкладку: директор зазвичай повертається
// в те саме місце, де працював.
window.initDirTabs = function(){
  let tab = 'ogl';
  try{ tab = localStorage.getItem(DTAB_KEY) || 'ogl'; }catch(e){}
  const btn = document.querySelector(`#dtab-bar .dtab[data-t="${tab}"]`) 
           || document.querySelector('#dtab-bar .dtab');
  if(btn) window.switchDirTab(btn.dataset.t, btn);
  // Значок непрочитаних новин
  if(window.countUnreadNews) window.countUnreadNews().then(n=>{
    const b = document.getElementById('dtab-news-badge');
    if(b){ b.textContent = n>0 ? n : ''; b.classList.toggle('show', n>0); }
  });
};

// ══════════ ВКЛАДКИ КАБІНЕТІВ ══════════
// Один перемикач на всі кабінети: директора, вчителя, батьків, учня.
// Секція показується, якщо позначена цією вкладкою АБО якщо всередині є
// блок цієї вкладки — деякі секції історично змішують різне.
export function switchTab(screenId, tab, btn){
  const scr = document.getElementById(screenId);
  if(!scr) return;
  const bar = document.getElementById(screenId + '-tabs') || document.getElementById('dtab-bar');
  if(bar) bar.querySelectorAll('.dtab').forEach(b=>b.classList.toggle('on', b.dataset.t === tab));

  scr.querySelectorAll('section.screen-section').forEach(sec=>{
    const kids = Array.from(sec.querySelectorAll(':scope [data-dtab]'));
    if(kids.length){
      let any = false;
      kids.forEach(k=>{ const on = k.dataset.dtab === tab; k.style.display = on ? '' : 'none'; if(on) any = true; });
      const mixed = new Set(kids.map(k=>k.dataset.dtab)).size > 1;
      const h3 = sec.querySelector(':scope > h3');
      if(h3) h3.style.display = mixed ? 'none' : '';
      sec.style.display = (any || sec.dataset.dtab === tab) ? '' : 'none';
    } else {
      sec.style.display = (!sec.dataset.dtab || sec.dataset.dtab === tab) ? '' : 'none';
    }
  });
  scr.querySelectorAll(':scope > [data-dtab]').forEach(el=>{
    if(el.tagName === 'SECTION') return;
    el.style.display = (el.dataset.dtab === tab) ? '' : 'none';
  });
  try{ localStorage.setItem('push_school_tab_' + screenId, tab); }catch(e){}
  // У батьків вкладка новин тепер називається «Школа». Без цього рядка
  // стрічка не оновлювалася б при перемиканні на неї.
  if((tab === 'news' || tab === 'school') && window.renderNewsFeed){
    const feed = scr.querySelector('.nw-feed');
    if(feed && feed.id) window.renderNewsFeed(feed.id);
  }
}
window.switchTab = switchTab;

// Відновлюємо останню відкриту вкладку кабінету
// Вкладки, які колись існували, але були перейменовані. Без цієї карти
// людина, у якої в пам'яті браузера лишилася стара назва, отримала б
// порожній кабінет: кнопки з такою назвою вже немає, і нічого не
// вмикається.
const RENAMED_TABS = { journal: 'lesson' };

export function initTabs(screenId){
  const bar = document.getElementById(screenId + '-tabs');
  if(!bar) return;
  let tab = null;
  try{ tab = localStorage.getItem('push_school_tab_' + screenId); }catch(e){}
  if(tab && RENAMED_TABS[tab] && bar.querySelector(`.dtab[data-t="${RENAMED_TABS[tab]}"]`))
    tab = RENAMED_TABS[tab];
  const btn = (tab && bar.querySelector(`.dtab[data-t="${tab}"]`)) || bar.querySelector('.dtab');
  if(btn) switchTab(screenId, btn.dataset.t, btn);
}
window.initTabs = initTabs;

// ── Разове заповнення довідників контактів ──
// staff_directory і class_parents кожен заповнює про себе при вході. Але
// поки люди не зайшли, у батька список співрозмовників порожній. Директор
// читає `users` і `parent_links`, тож може заповнити довідники за всіх
// одразу. Персональних даних сюди не потрапляє: імʼя, роль, класи.
window.rebuildContactDirs = async function(){
  const info = document.getElementById('d-dirs-info');
  const say = (t, bad) => { if(info){ info.style.display='block'; info.style.color = bad?'var(--red)':'#2e7d32'; info.innerText = t; } };
  say('Заповнюю...');
  try{
    const [usersSnap, plSnap, taSnap, prSnap] = await Promise.all([
      getUsersSnap(),
      get(child(ref(db),'parent_links')),
      get(child(ref(db),'teacher_access')),
      get(child(ref(db),'pre_approved_roles'))
    ]);
    const users = usersSnap.exists() ? usersSnap.val() : {};
    const pls   = plSnap.exists()   ? plSnap.val()   : {};
    const ta    = taSnap.exists()   ? taSnap.val()   : {};
    // Ключі в списку персоналу історично бувають і з великими літерами —
    // звіряємо в нижньому регістрі, інакше людину дарма пропустимо.
    const preRaw = prSnap.exists() ? prSnap.val() : {};
    const pre = {};
    Object.keys(preRaw).forEach(k => { pre[k.toLowerCase()] = preRaw[k]; });

    // ── Персонал ──
    const staffUpd = {};
    const skipped = [];
    let staff = 0, withSubjects = 0, withPhoto = 0;
    for(const uid in users){
      const u = users[uid];
      if(!u || !u.email || u.disabled) continue;
      const rawRole = Array.isArray(u.role) ? u.role[0] : u.role;
      if(rawRole === 'parent' || rawRole === 'student' || !rawRole) continue;
      const se = u.email.toLowerCase().replace(/\./g,'_');
      // Правило вимагає, щоб людина була у списку персоналу — інакше через
      // довідник можна було б приписати собі будь-яку посаду.
      if(!pre[se]){ skipped.push(u.email); continue; }
      // Посаду беремо з pre_approved_roles, а не з users. users оновлюється
      // лише коли людина сама зайде в портал, тому щойно призначений класний
      // керівник ще кілька днів значився б у чаті звичайним учителем.
      // pre_approved_roles — це те, що директор призначив, і воно чинне одразу.
      const assigned = normalizeRoles(pre[se])[0];
      const rec = {
        name: [u.firstName,u.lastName].filter(Boolean).join(' ') || u.email,
        role: String(assigned || rawRole),
        ts: Date.now()
      };
      // Фото теж переносимо: інакше після масового заповнення аватарки в
      // чаті зникали б у тих, хто вже їх завантажив.
      const ph = String(u.photoURL || '');
      if(ph && ph.length <= 60000 && !/flaticon/.test(ph)){ rec.photo = ph; withPhoto++; }
      // Пишемо перелік предметів на клас — саме його бачить батько в списку
      // контактів. Формат той самий, що й у publishContactCard: один спосіб
      // на два місця, інакше довідник виглядав би по-різному залежно від
      // того, хто його заповнив останнім.
      if(ta[se]){
        const cls = {};
        Object.keys(ta[se]).forEach(c => { cls[c] = subjectsLabel(ta[se][c]); });
        if(Object.keys(cls).length) rec.classes = cls;
        // Рахуємо, скільком людям справді вписалися назви предметів.
        // Без цього повідомлення «Готово» виглядало однаково і тоді, коли
        // предмети записалися, і тоді, коли в усіх стоїть «Всі предмети»
        // або порожньо — а батько потім не бачить у чаті жодного предмета.
        if(Object.values(cls).some(v => typeof v === 'string')) withSubjects++;
      }
      staffUpd[`staff_directory/${se}`] = rec; staff++;
    }

    // ── Батьки ──
    const parUpd = {};
    let parents = 0;
    for(const se in pls){
      const p = pls[se] || {};
      const kids = p.children || [];
      const list = Array.isArray(kids) ? kids : Object.values(kids);
      const byClass = {};
      list.forEach(k => { if(k && k.class) (byClass[k.class] ||= []).push(k.studentName || ''); });
      const prof = p.profile;
      const nm = (prof && [prof.lastName,prof.firstName].filter(Boolean).join(' ')) || se.replace(/_([^_]*)$/, '.$1');
      for(const cls in byClass){
        parUpd[`class_parents/${cls}/${se}`] = {
          name: String(nm).slice(0,120),
          children: byClass[cls].filter(Boolean).join(', ').slice(0,200),
          ts: Date.now()
        };
        parents++;
      }
    }

    // ── Дні народження ──
    // Дата лежить у картці; клас має бачити свята, але картки класу
    // батькам закриті. Переносимо в student_birthdays лише «MM-DD».
    const bdUpd = {};
    let bdays = 0;
    try{
      const cardsSnap = await get(child(ref(db),'student_cards'));
      const cards = cardsSnap.exists() ? cardsSnap.val() : {};
      for(const cls in cards){
        for(const key in cards[cls]){
          const bd = String((cards[cls][key]||{}).birthDate||'');
          if(bd.length < 10) continue;
          bdUpd[`student_birthdays/${cls}/${key}`] = bd.slice(5);
          bdays++;
        }
      }
    }catch(e){ /* карток може ще не бути — не привід зупиняти решту */ }

    if(!staff && !parents && !bdays){
      return say('Нічого заповнювати: немає ні персоналу зі списку ролей, ні привʼязаних батьків.'
        + (skipped.length ? '\n\nПропущено (немає в «Управлінні персоналом»): ' + skipped.join(', ') : ''), true);
    }

    // Пишемо двома частинами, а не однією: запис у Firebase атомарний, тож
    // один невдалий рядок відхиляв би геть усе — і без підказки, який саме.
    const errs = [];
    if(staff)   { try{ await update(ref(db), staffUpd); }catch(e){ errs.push('персонал: ' + e.message); staff = 0; } }
    if(parents) { try{ await update(ref(db), parUpd);   }catch(e){ errs.push('батьки: ' + e.message); parents = 0; } }
    if(bdays)   { try{ await update(ref(db), bdUpd);    }catch(e){ errs.push('дні народження: ' + e.message); bdays = 0; } }

    if(errs.length){
      return say('Частина не записалася.\n' + errs.join('\n')
        + `\n\nЗаписано: персоналу ${staff}, батьків ${parents}, дат народження ${bdays}`, true);
    }
    logAction('settings', { value: `довідники контактів: ${staff} персоналу, ${parents} записів батьків` });
    say(`✅ Готово: персоналу ${staff}, записів батьків ${parents}, дат народження ${bdays}.`
      + `\nЗ назвами предметів: ${withSubjects} із ${staff}.`
      + `\nЗ фото: ${withPhoto} із ${staff}.`
      + (withPhoto === 0 && staff
          ? '\n\nℹ️ Фото ще ніхто не завантажив. Аватарка зʼявляється в чаті у ТОГО, '
            + 'хто її поставив, і видно її іншим — власної аватарки у списку розмов ви не '
            + 'побачите. Щоб перевірити, поставте фото комусь із учителів кнопкою «✏️ Профіль».'
          : '')
      + (withSubjects === 0 && staff
          ? '\n\n⚠️ Жодного предмета не записано. Перевірте «Матрицю доступу»: якщо там '
            + 'у всіх стоїть «Всі предмети», батьки бачитимуть лише посаду, без предмета.'
          : '')
      + (skipped.length ? `\n\n⚠️ Пропущено, бо немає в «Управлінні персоналом»: ${skipped.join(', ')}` : '')
      + '\n\nТепер у батьків і вчителів є з кого обирати в чаті.');
  }catch(e){
    say('Не вдалося: ' + e.message, true);
  }
};

// ══════════ ПЕРСОНАЛ: профіль співробітника ══════════
// Директор змінює імʼя, прізвище та фото вчителя.
//
// ЧОМУ ЦЕ ПОТРІБНО. Донедавна профіль міг заповнити лише сам власник
// запису, і в списку персоналу висіли прочерки замість імен, доки людина
// не зайде й не заповнить себе сама. Тепер правило users/$uid дозволяє
// запис адміністрації, тож директор може підготувати профілі наперед.
//
// ЧОМУ ЛИШЕ ІМʼЯ ТА ФОТО. Роль призначається окремо, у списку персоналу:
// змішувати «як людину звати» і «що їй дозволено» в одній формі — вірний
// спосіб колись роздати зайві права, не помітивши.
let staffProfileSE = null, staffProfilePhoto = null;

window.openStaffProfile = async function(safeEmail){
  staffProfileSE = safeEmail; staffProfilePhoto = null;
  const box = document.getElementById('staff-profile-modal');
  if(!box) return alert('Розділ профілю не знайдено — оновіть cabinet.html.');
  const err = document.getElementById('sp-err'); if(err) err.style.display='none';
  document.getElementById('sp-email').textContent = safeEmail.replace(/_/g,'.');
  document.getElementById('sp-first').value = '';
  document.getElementById('sp-last').value  = '';
  document.getElementById('sp-preview').removeAttribute('src');
  document.getElementById('sp-preview').style.display = 'none';
  document.getElementById('sp-file').value = '';
  box.style.display = 'flex';
  try{
    const us = await getUsersSnap();
    const users = us.exists() ? us.val() : {};
    for(const uid in users){
      const u = users[uid] || {};
      if(String(u.email||'').replace(/\./g,'_') === safeEmail){
        document.getElementById('sp-first').value = u.firstName || '';
        document.getElementById('sp-last').value  = u.lastName  || '';
        if(u.photoURL){
          const img = document.getElementById('sp-preview');
          img.src = u.photoURL; img.style.display = 'block';
        }
        return;
      }
    }
    // Людина ще жодного разу не заходила — записувати нема куди.
    if(err){
      err.style.display = 'block';
      err.textContent = 'Ця людина ще не входила в портал. Профіль можна буде заповнити '
        + 'після її першого входу — облікового запису поки не існує.';
    }
  }catch(e){
    if(err){ err.style.display='block'; err.textContent = 'Не вдалося прочитати профіль: ' + e.message; }
  }
};
window.closeStaffProfile = function(){
  const b = document.getElementById('staff-profile-modal');
  if(b) b.style.display = 'none';
  staffProfileSE = null; staffProfilePhoto = null;
};

window.pickStaffPhoto = async function(input){
  const err = document.getElementById('sp-err');
  if(!input.files || !input.files[0]) return;
  try{
    staffProfilePhoto = await shrinkImage(input.files[0]);
    const img = document.getElementById('sp-preview');
    img.src = staffProfilePhoto; img.style.display = 'block';
    if(err) err.style.display = 'none';
  }catch(e){
    staffProfilePhoto = null;
    if(err){ err.style.display='block'; err.textContent = 'Фото: ' + e.message; }
  }
};

window.saveStaffProfile = async function(){
  if(!staffProfileSE) return;
  const btn = document.getElementById('sp-save');
  const err = document.getElementById('sp-err');
  const first = document.getElementById('sp-first').value.trim();
  const last  = document.getElementById('sp-last').value.trim();
  btn.disabled = true; btn.textContent = 'Зберігаю...';
  try{
    const us = await getUsersSnap();
    const users = us.exists() ? us.val() : {};
    let uid = null;
    for(const k in users){
      if(String((users[k]||{}).email||'').replace(/\./g,'_') === staffProfileSE){ uid = k; break; }
    }
    if(!uid) throw new Error('Обліковий запис не знайдено — людина ще не входила в портал.');
    const patch = { firstName: first, lastName: last };
    if(staffProfilePhoto) patch.photoURL = staffProfilePhoto;
    await update(ref(db, `users/${uid}`), patch);
    // Довідник чату оновлюємо одразу — інакше нове імʼя й фото зʼявилися б
    // у батьків лише після того, як цей учитель сам зайде в портал.
    await syncStaffCard(staffProfileSE);
    invalidateUsersCache();
    logAction('staff_profile', { target: staffProfileSE.replace(/_/g,'.'),
                                 value: staffProfilePhoto ? 'імʼя та фото' : 'імʼя' });
    showToast('✅ Профіль збережено');
    window.closeStaffProfile();
    window.loadStaffList();
  }catch(e){
    if(err){ err.style.display='block'; err.textContent = 'Не вдалося зберегти: ' + e.message; }
  }finally{
    btn.disabled = false; btn.textContent = '💾 Зберегти';
  }
};

// ══════════ РОЗШИФРОВКА ЛІЧИЛЬНИКА ДЗ ══════════
// Число на дашборді відповідало на «скільки», але не на «що і хто» —
// і зрозуміти, звідки взялася одиниця, було ніяк. Тепер по натисканню
// розгортається список: клас → предмет → текст → хто задав.
//
// Автор береться з вузла authors/{клас}/{дата}/{предмет} — його пише
// вчитель разом із самим завданням.
window.toggleHomeworkBreakdown = async function(){
  const box = document.getElementById('d-hw-breakdown');
  if(!box) return;
  const opening = box.style.display === 'none' || !box.style.display;
  box.style.display = opening ? 'block' : 'none';
  if(!opening) return;

  const date = document.getElementById('global-date').value;
  box.innerHTML = '<p class="empty-msg">Завантаження...</p>';
  try{
    const [hw, au, usersSnap] = await Promise.all([
      getSchoolRange('homeworks', date, date),
      getSchoolRange('authors',   date, date).catch(()=>({})),
      getUsersSnap()
    ]);
    const users = usersSnap.exists() ? usersSnap.val() : {};
    const nameOf = uid => {
      const u = users[uid];
      if(!u) return '';
      return [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || '';
    };

    const classes = Object.keys(hw).filter(c => hw[c] && hw[c][date])
                          .sort((a,b) => getClassNum(a) - getClassNum(b));
    if(!classes.length){
      box.innerHTML = `<p class="empty-msg">На ${escHtml(date.split('-').reverse().join('.'))} домашніх завдань немає.</p>`;
      return;
    }
    const human = date.split('-').reverse().join('.');
    let h = `<p class="hwb-date">Завдання за ${escHtml(human)}${date===localDateString?' (сьогодні)':''}</p>`, total = 0;
    classes.forEach(c => {
      const subjects = hw[c][date] || {};
      const keys = Object.keys(subjects);
      if(!keys.length) return;
      h += `<div class="hwb-cls"><b>${escHtml(c.replace('class_',''))} клас</b> <span>${keys.length}</span></div>`;
      keys.sort((a,b)=>a.localeCompare(b,'uk')).forEach(subj => {
        total++;
        const v = subjects[subj];
        const text = typeof v === 'string' ? v : String(v && v.text || '');
        const imgs = (v && Array.isArray(v.images)) ? v.images.length : (v && v.image ? 1 : 0);
        const who = nameOf(au[c] && au[c][date] && au[c][date][subj]);
        // Коли внесли. У старих записах позначки немає — так і пишемо,
        // а не вигадуємо дату.
        const ts = v && typeof v === 'object' ? v.ts : null;
        const made = ts ? new Date(ts).toLocaleDateString('uk-UA') : '';
        h += `<div class="hwb-row">
          <div class="hwb-subj">${escHtml(subj)}</div>
          <div class="hwb-text">${escHtml(text) || '<i>без тексту</i>'}${imgs?` 📎${imgs}`:''}</div>
          <div class="hwb-who">${who ? '👨‍🏫 ' + escHtml(who) : '<i>автор не вказаний</i>'}`
          + `${made ? ' · внесено ' + escHtml(made) : ' · <i>час не записано (старий запис)</i>'}</div>
        </div>`;
      });
    });
    box.innerHTML = h + `<p class="hwb-total">Усього завдань: ${total}</p>`;
  }catch(e){
    box.innerHTML = `<p class="empty-msg" style="color:var(--red);">Не вдалося прочитати: ${escHtml(e.message||'відмова')}</p>`;
  }
};

// ══════════ РОЗШИФРОВКА: КОМЕНТАРІ ══════════
// comments/{клас}/{дата}/{предмет}/{учень} = текст.
// Автора коментаря портал не зберігає — тут його свідомо не вигадуємо.
window.toggleCommentsBreakdown = async function(){
  const box = document.getElementById('d-com-breakdown');
  if(!box) return;
  const opening = box.style.display === 'none' || !box.style.display;
  box.style.display = opening ? 'block' : 'none';
  if(!opening) return;

  const date = document.getElementById('global-date').value;
  box.innerHTML = '<p class="empty-msg">Завантаження...</p>';
  try{
    const cd = await getSchoolRange('comments', date, date);
    const human = date.split('-').reverse().join('.');
    const classes = Object.keys(cd).filter(c => cd[c] && cd[c][date])
                          .sort((a,b) => getClassNum(a) - getClassNum(b));
    let h = `<p class="hwb-date">Коментарі за ${escHtml(human)}${date===localDateString?' (сьогодні)':''}</p>`;
    let total = 0;
    classes.forEach(c => {
      const bySubj = cd[c][date] || {};
      const rows = [];
      Object.keys(bySubj).sort((a,b)=>a.localeCompare(b,'uk')).forEach(subj => {
        const perStudent = bySubj[subj];
        if(!perStudent || typeof perStudent !== 'object') return;
        Object.keys(perStudent).forEach(st => {
          rows.push({ subj, st, text: String(perStudent[st] || '') });
        });
      });
      if(!rows.length) return;
      h += `<div class="hwb-cls"><b>${escHtml(c.replace('class_',''))} клас</b> <span>${rows.length}</span></div>`;
      rows.forEach(r => {
        total++;
        h += `<div class="hwb-row">
          <div class="hwb-subj">${escHtml(stuName(c, r.st))} <span style="font-weight:400;color:#90a4ae;">· ${escHtml(r.subj)}</span></div>
          <div class="hwb-text">${escHtml(r.text)}</div>
        </div>`;
      });
    });
    box.innerHTML = total
      ? h + `<p class="hwb-total">Усього коментарів: ${total}</p>`
      : `<p class="empty-msg">За ${escHtml(human)} коментарів немає.</p>`;
  }catch(e){
    box.innerHTML = `<p class="empty-msg" style="color:var(--red);">Не вдалося прочитати: ${escHtml(e.message||'відмова')}</p>`;
  }
};

// ══════════ РОЗШИФРОВКА: СТАТИСТИКА ТИЖНЯ ══════════
// Числа на картці — сума за весь тиждень по всій школі. Побачити, з чого
// вони складаються, було ніяк: список нижче показує лише обраний день.
window.toggleWeekBreakdown = async function(){
  const box = document.getElementById('d-week-breakdown');
  if(!box) return;
  const opening = box.style.display === 'none' || !box.style.display;
  box.style.display = opening ? 'block' : 'none';
  if(!opening) return;

  const date = document.getElementById('global-date').value;
  const wd = getWeekDates(date);
  box.innerHTML = '<p class="empty-msg">Завантаження...</p>';
  try{
    const ad = await getSchoolRange('attendance', wd[0], wd[wd.length-1]);
    const UA = ['Пн','Вт','Ср','Чт','Пт','Сб','Нд'];
    let h = `<p class="hwb-date">Тиждень ${escHtml(wd[0].split('-').reverse().join('.'))}`
          + ` – ${escHtml(wd[wd.length-1].split('-').reverse().join('.'))}</p>`;
    let late = 0, absent = 0, days = 0;

    wd.forEach((ds, di) => {
      const rows = [];
      Object.keys(ad).sort((a,b)=>getClassNum(a)-getClassNum(b)).forEach(c => {
        const byStudent = (ad[c] && ad[c][ds]) || {};
        Object.keys(byStudent).forEach(st => {
          const slots = byStudent[st] || {};
          Object.keys(slots).forEach(sk => {
            const r = slots[sk];
            if(!r || !r.status) return;
            if(r.status === 'late') late++; else if(r.status === 'absent') absent++;
            rows.push({ c, st, sk, r });
          });
        });
      });
      if(!rows.length) return;
      days++;
      h += `<div class="hwb-cls"><b>${UA[di]}, ${escHtml(ds.split('-').reverse().slice(0,2).join('.'))}</b>`
         + ` <span>${rows.length}</span></div>`;
      rows.forEach(({c, st, sk, r}) => {
        const badge = r.status === 'late' ? 'badge-late' : 'badge-absent';
        const label = r.status === 'late' ? 'Запізнення' : 'Відсутність';
        h += `<div class="hwb-row">
          <div class="hwb-subj">${escHtml(c.replace('class_',''))} кл · ${escHtml(stuName(c, st))}
            <span class="badge ${badge}">${label}</span></div>
          <div class="hwb-text">${escHtml(formatAttendanceSlotLabel(sk))}${r.reason?' · '+escHtml(r.reason):''}</div>
        </div>`;
      });
    });

    box.innerHTML = days
      ? h + `<p class="hwb-total">За тиждень: запізнень ${late}, відсутностей ${absent}</p>`
      : '<p class="empty-msg">Цього тижня відміток немає.</p>';
  }catch(e){
    box.innerHTML = `<p class="empty-msg" style="color:var(--red);">Не вдалося прочитати: ${escHtml(e.message||'відмова')}</p>`;
  }
};
