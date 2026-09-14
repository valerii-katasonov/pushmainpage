// Перевірка заповнення матеріалів без записів у базу та зміни класу в кабінеті.
import { ref, get } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, currentUserData, isDirectorRole, escHtml, safeUrl, subjKey, planKeyWith, expandAltSubjects, getClassNum, emailKey } from './common.js';
import { ACTIVE_YEAR } from './director.js';
import { catalogList } from './subjects.js';

// Розклад і каталог визначають очікувані предмети. Самі наявні плани
// не можуть бути джерелом: тоді незавантажені предмети зникли б зі звіту.
export function buildMaterialsAudit(data,year){
  const {schedules={},catalogs={},books={},plans={},aliases={},access={},users={}}=data;
  const staff={};
  for(const u of Object.values(users)){
    if(u?.email&&!u.disabled)staff[emailKey(u.email)]=[u.firstName,u.lastName].filter(Boolean).join(' ')||u.email;
  }
  const classes=new Set([...Object.keys(schedules),...Object.keys(catalogs[year]||{}),...Object.keys(catalogs).filter(c=>/^class_\d+$/.test(c))]);
  const rows=[];
  for(const cls of [...classes].filter(c=>/^class_\d+$/.test(c)).sort((a,b)=>getClassNum(a)-getClassNum(b))){
    const expected=new Map();
    const node=catalogs[year]?.[cls]??catalogs[cls]??{};
    for(const entry of catalogList(node))expected.set(subjKey(entry.name),entry);
    function visit(value){
      if(!value||typeof value!=='object')return;
      // Чергування може мати лише alt, без загального поля subject.
      if(value.subject||value.alt){
        for(const name of expandAltSubjects(value)){
          const key=subjKey(name);if(!expected.has(key))expected.set(key,{name});
        }
        return;
      }
      Object.values(value).forEach(visit);
    }
    visit(schedules[cls]?.lessons);
    for(const [key,entry] of [...expected].sort((a,b)=>a[1].name.localeCompare(b[1].name,'uk'))){
      const teachers=new Set();
      if(entry.teacherEmail)teachers.add(staff[emailKey(entry.teacherEmail)]||entry.teacherName||entry.teacherEmail);
      for(const [email,matrix] of Object.entries(access)){
        if(!staff[email])continue;
        const raw=matrix?.[cls];
        const list=Array.isArray(raw)?raw:Object.values(raw||{});
        if(list.some(s=>typeof s==='string'&&subjKey(s)===key))teachers.add(staff[email]);
      }
      const bookRecords=Object.values(books[cls]?.[key]||{}).filter(b=>b&&typeof b==='object');
      // Назва без робочого посилання не дає родині доступу до підручника.
      const validBooks=bookRecords.filter(b=>{
        try{const url=new URL(String(b.url||'').trim());return ['http:','https:'].includes(url.protocol)&&!!url.hostname;}
        catch(e){return false;}
      });
      const planKey=planKeyWith(aliases[cls],entry.name);
      const topics=Object.values(plans[cls]?.[planKey]?.topics||{}).filter(t=>t&&typeof t.title==='string'&&t.title.trim());
      rows.push({cls,subject:entry.name,teachers:[...teachers],books:validBooks,invalidBooks:bookRecords.length-validBooks.length,topics:topics.length,
        hours:topics.reduce((sum,t)=>sum+(Number(t.plannedHours)||0),0),shared:planKey!==key?(aliases[cls]?.[key]||planKey):'',ready:!!validBooks.length&&!!topics.length});
    }
  }
  return rows;
}
let auditRows=[],generation=0,auditState='idle';
export function renderMaterialsAudit(){
  const box=document.getElementById('d-materials-results');if(!box)return;
  // Фільтри не повинні стирати помилку читання або показувати старі
  // результати, поки нова перевірка ще триває.
  if(auditState!=='ready')return;
  const cls=document.getElementById('d-materials-class')?.value||'';
  const missing=!!document.getElementById('d-materials-missing')?.checked;
  const query=(document.getElementById('d-materials-search')?.value||'').trim().toLocaleLowerCase('uk');
  const rows=auditRows.filter(r=>(!cls||r.cls===cls)&&(!missing||!r.ready)&&(!query||[r.subject,...r.teachers].join(' ').toLocaleLowerCase('uk').includes(query)));
  const total=auditRows.filter(r=>!cls||r.cls===cls);
  const summary=document.getElementById('d-materials-summary');
  if(summary)summary.textContent=`Предметів: ${total.length} · Підручники: ${total.filter(r=>r.books.length).length}/${total.length} · Планування: ${total.filter(r=>r.topics).length}/${total.length} · Усе додано: ${total.filter(r=>r.ready).length}/${total.length}`;
  if(!rows.length){box.innerHTML=`<p class="empty-msg">${!auditRows.length?'Немає предметів у розкладі чи каталозі.':missing&&!query?'За цим фільтром усі матеріали додано.':'За цими фільтрами предметів немає.'}</p>`;return;}
  let html='';
  for(const c of [...new Set(rows.map(r=>r.cls))]){
    html+=`<h4>${escHtml(getClassNum(c))} клас</h4><div class="ma-grid">`;
    for(const r of rows.filter(r=>r.cls===c)){
      const books=r.books.map(b=>{
        const url=safeUrl(b.url||''),title=escHtml(b.title||b.url);
        return url?`<a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer">${title}</a>`:title;
      }).join(' · ');
      html+=`<div class="ma-card ${r.ready?'ma-ready':'ma-missing'}"><b>${escHtml(r.subject)}</b><div class="ma-teacher">${escHtml(r.teachers.join(', ')||'Учителя не призначено')}</div><div>${r.books.length?'✅':'❌'} Підручники: ${r.books.length||'не додано'}</div>${books?`<div class="ma-books">${books}</div>`:''}${r.invalidBooks?`<div style="color:var(--red);">⚠️ Підручників без коректного посилання: ${r.invalidBooks}</div>`:''}<div>${r.topics?'✅':'❌'} Календарне планування: ${r.topics?`${r.topics} тем · ${r.hours} год.`:'не додано'}</div>${r.shared?`<small>Спільний план: ${escHtml(r.shared)}</small>`:''}</div>`;
    }
    html+='</div>';
  }
  box.innerHTML=html;
}
export async function loadMaterialsAudit(){
  const box=document.getElementById('d-materials-results');if(!box)return;
  if(!isDirectorRole(currentUserData?.role))return;
  const gen=++generation;
  auditState='loading';
  const year=ACTIVE_YEAR;
  const button=document.getElementById('d-materials-refresh');if(button)button.disabled=true;
  box.innerHTML='<p class="empty-msg">Перевіряю матеріали...</p>';
  const summary=document.getElementById('d-materials-summary');if(summary)summary.textContent='';
  try{
    const paths=['schedules','subjects_catalog','textbooks','curriculum_plans','curriculum_aliases','teacher_access','users'];
    // Будь-яка відмова читання є помилкою перевірки, а не «матеріалів немає».
    // Кнопка «Оновити» читає також свіжі профілі, без кешу списку вчителів.
    const snaps=await Promise.all(paths.map(path=>get(ref(db,path))));
    if(gen!==generation)return;
    if(year!==ACTIVE_YEAR)throw new Error('Навчальний рік змінився — оновіть перевірку');
    const [schedules,catalogs,books,plans,aliases,access,users]=snaps.map(s=>s.exists()?s.val():{});
    auditRows=buildMaterialsAudit({schedules,catalogs,books,plans,aliases,access,users},year);
    const select=document.getElementById('d-materials-class');
    if(select){
      const previous=select.value;
      const classes=[...new Set(auditRows.map(r=>r.cls))];
      select.innerHTML='<option value="">Усі класи</option>'+classes.map(c=>`<option value="${escHtml(c)}">${escHtml(getClassNum(c))} клас</option>`).join('');
      select.value=classes.includes(previous)?previous:'';
    }
    auditState='ready';
    renderMaterialsAudit();
  }catch(e){
    if(gen===generation){auditState='error';auditRows=[];box.innerHTML=`<p class="empty-msg" style="color:var(--red);">Не вдалося перевірити матеріали: ${escHtml(e.message||'невідома помилка')}. Натисніть «Оновити».</p>`;}
  }finally{if(gen===generation&&button)button.disabled=false;}
}
window.loadMaterialsAudit=loadMaterialsAudit;
window.renderMaterialsAudit=renderMaterialsAudit;
