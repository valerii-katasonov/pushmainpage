// Окремий каталог гуртків; призначення не змінює збережений розклад.
import { ref, get, update } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, currentUserData, isDirectorRole, isTeacherRole, getUserRoles, emailKey, subjKey, escHtml, escJs, showToast } from './common.js';
import { ACTIVE_YEAR } from './director.js';
import { catalogList, prevYearId } from './subjects.js';

let cache={},generation=0,busy=false;
const allowed=()=>isDirectorRole(currentUserData?.role);
const context=()=>({year:document.getElementById('cc-year')?.value,cls:document.getElementById('cc-class')?.value});
const path=c=>`clubs_catalog/${c.year}/${c.cls}`;
export function clubsFromSchedule(school){
  const found=new Map();
  function visit(value,inClubs=false){
    if(!value||typeof value!=='object')return;
    if(value.subject){
      if(value.type==='break'||(!inClubs&&value.type!=='extra'))return;
      const name=String(typeof value.subject==='string'?value.subject:value.subject.ua||'').trim();
      if(!name)return;
      const key=subjKey(name),previous=found.get(key);
      const record={name,teacherEmail:value.teacherEmail||'',teacherName:value.teacherName||''};
      if(!previous)found.set(key,record);
      else if(emailKey(previous.teacherEmail)!==emailKey(record.teacherEmail))found.set(key,{name,teacherEmail:'',teacherName:''});
      return;
    }
    Object.values(value).forEach(v=>visit(v,inClubs));
  }
  visit(school?.clubs,true);visit(school?.lessons);
  return Object.fromEntries(found);
}
export function clubTeacher(node,name){
  const matches=catalogList(node).filter(e=>subjKey(e.name)===subjKey(name)&&e.teacherEmail);
  const emails=new Set(matches.map(e=>emailKey(e.teacherEmail)));
  if(emails.size!==1)return null;
  return {email:matches[0].teacherEmail,name:matches[0].teacherName||matches[0].teacherEmail};
}
window.getClubTeacher=(cls,name)=>clubTeacher(cache[ACTIVE_YEAR]?.[cls],name);
window.loadClubCatalogs=async function(){
  const year=ACTIVE_YEAR,snap=await get(ref(db,`clubs_catalog/${year}`));
  cache[year]=snap.exists()?snap.val():{};
};
window.clubCatalogNames=async function(cls){
  const year=ACTIVE_YEAR,snap=await get(ref(db,`clubs_catalog/${year}/${cls}`));
  (cache[year]||= {})[cls]=snap.exists()?snap.val():{};
  return catalogList(cache[year][cls]).map(e=>e.name);
};
async function staff(){
  const snap=await get(ref(db,'users'));
  return Object.values(snap.exists()?snap.val():{}).filter(u=>u?.email&&!u.disabled&&getUserRoles(u).some(isTeacherRole))
    .map(u=>({email:u.email,name:[u.firstName,u.lastName].filter(Boolean).join(' ')||u.email})).sort((a,b)=>a.name.localeCompare(b.name,'uk'));
}
window.openClubsCatalog=async function(){
  if(!allowed())return;
  const ys=document.getElementById('cc-year'),cs=document.getElementById('cc-class');if(!ys||!cs)return;
  if(!ys.options.length)ys.innerHTML=[ACTIVE_YEAR,prevYearId(ACTIVE_YEAR)].filter(Boolean).map(y=>`<option>${escHtml(y)}</option>`).join('');
  if(!cs.options.length)cs.innerHTML=Array.from({length:11},(_,i)=>`<option value="class_${i+1}">${i+1} клас</option>`).join('');
  await window.renderClubsCatalog();
};
window.renderClubsCatalog=async function(){
  if(!allowed())return;
  const box=document.getElementById('cc-body');if(!box)return;
  const c=context(),gen=++generation;box.innerHTML='<p class="empty-msg">Завантажую гуртки...</p>';
  try{
    const [snap,teachers]=await Promise.all([get(ref(db,path(c))),staff()]);
    if(gen!==generation)return;
    const node=snap.exists()?snap.val():{};(cache[c.year]||={})[c.cls]=node;
    const options=email=>`<option value="">— учителя не призначено —</option>`+teachers.map(t=>`<option value="${escHtml(t.email)}"${emailKey(t.email)===emailKey(email)?' selected':''}>${escHtml(t.name)}</option>`).join('')+
      (email&&!teachers.some(t=>emailKey(t.email)===emailKey(email))?`<option value="${escHtml(email)}" selected>${escHtml(email)} (немає серед активних)</option>`:'');
    box.innerHTML=`<div class="sc-list">${catalogList(node).map(e=>`<div class="sc-item"><div class="sc-name">${escHtml(e.name)}</div><select onchange="setClubTeacher('${escJs(e.key)}',this.value)">${options(e.teacherEmail)}</select><button type="button" onclick="removeClubFromCatalog('${escJs(e.key)}')">×</button></div>`).join('')||'<p class="empty-msg">Гуртків ще немає.</p>'}</div>
      <div class="sc-add"><input id="cc-new" placeholder="Назва гуртка"><select id="cc-new-teacher">${options('')}</select><button type="button" onclick="addClubFromCard()">+ Додати</button></div>
      <div class="sc-tools"><button type="button" onclick="fillClubsFromSchedule()">📥 Зібрати з розкладу</button><button type="button" onclick="carryOverClubs()">🗓 Перенести з минулого року</button><button type="button" onclick="copyClubsFromClass()">📋 Скопіювати з іншого класу</button></div>`;
  }catch(e){if(gen===generation)box.innerHTML=`<p class="empty-msg" style="color:var(--red);">Не вдалося завантажити гуртки: ${escHtml(e.message)}</p>`;}
};
async function mutate(action){
  if(!allowed()||busy)return false;
  busy=true;
  const box=document.getElementById('cc-body');box?.querySelectorAll('button,select,input').forEach(e=>e.disabled=true);
  try{await action();showToast('✅ Каталог гуртків збережено');return true;}
  catch(e){showToast('❌ Не вдалося зберегти гуртки: '+e.message);return false;}
  finally{busy=false;box?.querySelectorAll('button,select,input').forEach(e=>e.disabled=false);}
}
export async function clubWritePaths(c,key,record){
  const writes={[`${path(c)}/${key}`]:record};
  if(record?.teacherEmail&&c.year===ACTIVE_YEAR){
    const accessPath=`teacher_access/${emailKey(record.teacherEmail)}/${c.cls}`;
    const snap=await get(ref(db,accessPath)),raw=snap.exists()?snap.val():[];
    const list=(Array.isArray(raw)?raw:Object.values(raw||{})).filter(s=>typeof s==='string'&&s.trim());
    if(!list.includes('Всі предмети')&&!list.includes(record.name))writes[accessPath]=[...list,record.name];
  }
  return writes;
}
window.addClubFromCard=async function(){
  const c=context(),name=document.getElementById('cc-new')?.value.trim(),email=document.getElementById('cc-new-teacher')?.value||'';
  if(!name||name.length>80)return showToast('Введіть назву гуртка до 80 символів');
  const ok=await mutate(async()=>{
    const snap=await get(ref(db,path(c))),node=snap.exists()?snap.val():{};
    if(catalogList(node).some(e=>subjKey(e.name)===subjKey(name)))throw Error('Цей гурток уже є у списку');
    const teacher=(await staff()).find(t=>emailKey(t.email)===emailKey(email));
    if(email&&!teacher)throw Error('Оберіть активного учителя');
    await update(ref(db),await clubWritePaths(c,subjKey(name),{name,teacherEmail:teacher?.email||'',teacherName:teacher?.name||''}));
  });if(ok)await window.renderClubsCatalog();
};
window.setClubTeacher=async function(key,email){
  const c=context();
  await mutate(async()=>{
    const snap=await get(ref(db,`${path(c)}/${key}`));if(!snap.exists())throw Error('Гурток уже видалено');
    const rec=catalogList({[key]:snap.val()})[0];if(!rec)throw Error('Некоректний запис гуртка');
    const teacher=(await staff()).find(t=>emailKey(t.email)===emailKey(email));if(email&&!teacher)throw Error('Оберіть активного учителя');
    await update(ref(db),await clubWritePaths(c,key,{name:rec.name,teacherEmail:teacher?.email||'',teacherName:teacher?.name||''}));
  });await window.renderClubsCatalog();
};
window.removeClubFromCatalog=async function(key){
  if(!allowed()||!confirm('Прибрати гурток зі списку? Збережений розклад та права вчителя залишаться.'))return;
  const c=context();if(await mutate(()=>update(ref(db),{[`${path(c)}/${key}`]:null})))await window.renderClubsCatalog();
};
async function mergeClubs(source){
  const c=context();const ok=await mutate(async()=>{
    const [snap,incoming]=await Promise.all([get(ref(db,path(c))),source(c)]);
    const existing=snap.exists()?snap.val():{},patch={};
    const names=new Set(catalogList(existing).map(e=>subjKey(e.name)));
    for(const [key,rec] of Object.entries(incoming))if(!existing[key]&&!names.has(subjKey(rec.name))){
      names.add(subjKey(rec.name));
      const writes=await clubWritePaths(c,key,rec);
      for(const [p,value] of Object.entries(writes))patch[p]=p.startsWith('teacher_access/')&&patch[p]?[...new Set([...patch[p],...value])]:value;
    }
    if(!Object.keys(patch).length)throw Error('Нових гуртків для додавання немає');
    await update(ref(db),patch);
  });if(ok)await window.renderClubsCatalog();
}
window.fillClubsFromSchedule=()=>mergeClubs(async c=>{const snap=await get(ref(db,`schedules/${c.cls}`));return clubsFromSchedule(snap.exists()?snap.val():{});});
window.carryOverClubs=()=>mergeClubs(async c=>{const snap=await get(ref(db,`clubs_catalog/${prevYearId(c.year)}/${c.cls}`));return Object.fromEntries(catalogList(snap.exists()?snap.val():{}).map(e=>[subjKey(e.name),{name:e.name,teacherEmail:e.teacherEmail,teacherName:e.teacherName}]));});
window.copyClubsFromClass=async function(){
  if(!allowed()||busy)return;
  const value=(prompt('З якого класу скопіювати гуртки? (1–11)','')||'').trim();if(!value)return;
  if(!/^(?:[1-9]|10|11)$/.test(value))return showToast('Вкажіть клас від 1 до 11');
  const cls=`class_${value}`;if(cls===context().cls)return showToast('Оберіть інший клас');
  await mergeClubs(async c=>{const snap=await get(ref(db,`clubs_catalog/${c.year}/${cls}`));return Object.fromEntries(catalogList(snap.exists()?snap.val():{}).map(e=>[subjKey(e.name),{name:e.name,teacherEmail:e.teacherEmail,teacherName:e.teacherName}]));});
};
