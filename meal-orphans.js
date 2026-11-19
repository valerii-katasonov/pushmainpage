import {ref,get,child,push,set,runTransaction} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import {db,currentUserData,escHtml,escJs,showToast} from './common.js';
import {computeMealAccount,accountStart} from './meal-balance.js';

const canRepair=()=>['kitchen','director','administrator'].includes(currentUserData?.role);
const read=async path=>{const s=await get(child(ref(db),path));return s.exists()?s.val():null;};
const stable=value=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)
  ?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export const sameMealRecord=(a,b)=>stable(a)===stable(b);
export function resolvedMealPlan(source,events){
  return Object.values(events||{}).some(e=>e&&['linked','archived'].includes(e.mode)&&sameMealRecord(source,e.source));
}
export function describeMealPlan(p={}){
  const parts=[];
  if(typeof p.lunch==='boolean')parts.push(p.lunch?'обід щодня':'без обіду');
  for(const [k,label] of [['breakfast','сніданок'],['snack','підвечірок']]){
    if(p[k]!==undefined)parts.push(`${label}: ${p[k]==='all'?'щодня':p[k]==='days'?'обрані дні':'не замовлено'}`);
  }
  if(p.pick)parts.push(`обід ${p.pick==='b'?'Б':'А'}`);
  if(p.breakfastPick)parts.push(`сніданок ${p.breakfastPick==='b'?'Б':'А'}`);
  return parts.join(' · ')||'Налаштування не заповнено';
}
export function renderMealOrphanList(rows,resolutions={},available=true){
  const active=rows.filter(r=>r.kind!=='plan'||!resolvedMealPlan(r.data,resolutions?.[r.cls]?.[r.key]));
  if(!active.length)return '';
  return `<div class="k-orphan"><b>⚠️ Записи поза поточними списками учнів: ${active.length}</b>
    <p>Це збережені налаштування, а не підтвердження замовлених порцій. Вони не входять у підрахунок. Запис може залишитися після переведення або видалення учня.</p>
    ${!available?'<p>Розбір тимчасово недоступний: не вдалося прочитати журнал рішень. Перевірте з’єднання та публікацію нових правил Firebase.</p>':''}
    <ul>${active.map(r=>`<li style="margin:12px 0;overflow-wrap:anywhere">
      <b>${escHtml(r.cls.replace('class_',''))} клас · ${escHtml(r.key)}</b> (${escHtml(r.what)})<br>
      ${escHtml(describeMealPlan(r.data))}${r.data?.by?`<br>Зберіг: ${escHtml(r.data.by)}`:''}
      ${r.kind==='plan'&&available&&canRepair()?`<br><button type="button" style="width:auto;max-width:100%;margin-top:6px" onclick="openMealOrphanRepair('${escJs(r.cls)}','${escJs(r.key)}')">Розібрати запис</button>`:''}
    </li>`).join('')}</ul></div>`;
}

// Джерело не змінюємо. Існуючий план дитини не замінюємо, навіть якщо
// старий запис має новіший ts. Денних виборів, рахунків і списань не торкаємося.
export async function applyMealPlanRepair({cls,key,source,mode,targetClass,targetId}){
  await read(`meal_orphan_resolutions/${cls}/${key}`);
  const latest=await read(`meal_plan/${cls}/${key}`);
  if(!latest||!sameMealRecord(latest,source))throw new Error('Вихідний запис змінився. Відкрийте розбір знову.');
  const account=await read(`meal_accounts/${cls}/${key}`);
  // Рахунок за старим ключем блокує лише ПРИВʼЯЗКУ (гроші самі не переїдуть).
  // Позначити запис зайвим можна завжди: план харчування — не гроші, рахунок
  // лишається на місці й видно, скільки на ньому (19.11.2026: кухня не мала
  // що зробити із записом учня, якого вже немає, бо за ним був рахунок).
  if(mode==='linked'&&account&&Object.keys(account).length)
    throw new Error('За старим ключем є особовий рахунок харчування. Потрібно окремо звірити його з адміністрацією; розбір плану заблоковано, щоб не розділити баланс.');
  const students=await read('students_list')||{};
  if(Object.hasOwn(students[cls]||{},key)||Object.values(students[cls]||{}).includes(key))
    throw new Error('Запис уже відповідає учню в цьому класі. Оновіть підрахунок.');
  if(!['linked','archived'].includes(mode))throw new Error('Невідома дія.');
  let copied=false,targetName='';
  if(mode==='linked'){
    targetName=students[targetClass]?.[targetId];
    if(typeof targetName!=='string'||!targetName)throw new Error('Оберіть учня з поточного списку.');
    const [existing,legacy]=await Promise.all([
      read(`meal_plan/${targetClass}/${targetId}`),
      targetName!==targetId?read(`meal_plan/${targetClass}/${targetName}`):null
    ]);
    if(existing===null&&legacy===null){
      // Транзакція не дозволить перезаписати відповідь, яку батьки
      // встигли зберегти після відкриття вікна. Старий ts зберігається:
      // паралельна відповідь під ім'ям теж матиме пріоритет.
      const result=await runTransaction(ref(db,`meal_plan/${targetClass}/${targetId}`),
        current=>current===null?source:undefined,{applyLocally:false});
      copied=result.committed;
      if(!copied)throw new Error('Батьки вже змінили план. Перегляньте результат ще раз.');
    }
  }
  const entry={mode,source,by:currentUserData?.email||'',ts:Date.now(),copied,
    ...(mode==='linked'?{targetClass,targetId,targetName}:{})};
  // Окремий журнал лише доповнюється; старі дані лишаються на місці.
  await set(push(ref(db,`meal_orphan_resolutions/${cls}/${key}`)),entry);
  return entry;
}

let state=null,version=0,busy=false;
function close(){if(busy)return;version++;state=null;document.getElementById('meal-orphan-dialog')?.remove();}
window.closeMealOrphanRepair=close;
window.openMealOrphanRepair=async function(cls,key){
  if(!canRepair()||busy)return;
  close();const seq=++version;
  const overlay=document.createElement('div');overlay.id='meal-orphan-dialog';
  overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');
  overlay.style.cssText='position:fixed;inset:0;z-index:10050;background:#0008;display:flex;align-items:center;justify-content:center;padding:12px;box-sizing:border-box';
  overlay.innerHTML='<div style="background:var(--surface);color:var(--ink);border-radius:16px;padding:20px;width:600px;max-width:100%;max-height:90vh;overflow:auto;box-sizing:border-box"><h3>Перевірка налаштувань харчування</h3><div id="meal-orphan-body">Завантаження…</div><button type="button" onclick="closeMealOrphanRepair()">Закрити</button></div>';
  document.body.appendChild(overlay);
  const body=document.getElementById('meal-orphan-body');
  try{
    const [source,students]=await Promise.all([read(`meal_plan/${cls}/${key}`),read('students_list')]);
    if(seq!==version)return;
    if(!source)throw new Error('Запис уже відсутній. Оновіть підрахунок.');
    const all=students||{},suggestions=[];
    for(const [c,list] of Object.entries(all))if(list?.[key])suggestions.push(`${list[key]} — ${c.replace('class_','')} клас (той самий ID)`);
    if(['director','administrator'].includes(currentUserData?.role)){
      try{
        const links=await read('parent_links');
        for(const link of Object.values(links||{})){
          const kids=link.children?Object.values(link.children):[link];
          for(const kid of kids)if(kid?.studentId===key&&kid.studentName)
            suggestions.push(`${kid.studentName} — ${String(kid.class||'').replace('class_','')} клас (прив’язка батьків)`);
        }
      }catch{suggestions.push('Прив’язки батьків прочитати не вдалося; автоматичної ідентифікації немає.');}
    }
    if(seq!==version)return;
    const choices=[];
    for(const [c,list] of Object.entries(all).sort(([a],[b])=>a.localeCompare(b,undefined,{numeric:true})))
      for(const [sid,name] of Object.entries(list||{}).sort((a,b)=>String(a[1]).localeCompare(String(b[1]),'uk')))
        choices.push({cls:c,sid,name});
    state={cls,key,source,choices,seq};
    const when=Number(source.ts)>0?new Date(Number(source.ts)).toLocaleString('uk-UA'):'';
    body.innerHTML=`<p style="overflow-wrap:anywhere"><b>${escHtml(cls.replace('class_',''))} клас · ${escHtml(key)}</b><br>${escHtml(describeMealPlan(source))}<br>Зберіг: ${escHtml(source.by||'невідомо')}${when?`<br>${escHtml(when)}`:''}</p>
      ${suggestions.length?`<p>${[...new Set(suggestions)].map(escHtml).join('<br>')}</p>`
        :'<p><b>Такого учня в поточних списках немає.</b> Найчастіше це дитина, яка вже не навчається, або запис, що лишився після видалення учня. Тоді натисніть «Учень більше не навчається / запис зайвий» — запис зникне з попередження, а оригінал збережеться. Якщо знаєте, чия це дитина, оберіть її нижче.</p>'}
      <label for="meal-orphan-target">Кому належать ці налаштування?</label>
      <select id="meal-orphan-target" onchange="resetMealOrphanPreview()" style="width:100%;min-width:0;max-width:100%;box-sizing:border-box"><option value="">Оберіть учня після звірки</option>${choices.map((s,i)=>`<option value="${i}">${escHtml(s.cls.replace('class_',''))} клас · ${escHtml(s.name)}</option>`).join('')}</select>
      <button type="button" onclick="previewMealOrphanRepair('linked')">Переглянути прив’язку</button>
      <button type="button" onclick="previewMealOrphanRepair('archived')">Учень більше не навчається / запис зайвий</button>
      <div id="meal-orphan-preview" aria-live="polite"></div>`;
  }catch(e){if(seq===version)body.textContent='Не вдалося перевірити: '+e.message;}
};
window.resetMealOrphanPreview=function(){
  if(!state||busy)return;
  state.review=null;state.reviewVersion=(state.reviewVersion||0)+1;
  document.getElementById('meal-orphan-preview').innerHTML='';
};
window.previewMealOrphanRepair=async function(mode){
  if(!state||busy||!canRepair())return;
  const s=state,box=document.getElementById('meal-orphan-preview');s.review=null;
  const reviewVersion=s.reviewVersion=(s.reviewVersion||0)+1;
  try{
    const account=await read(`meal_accounts/${s.cls}/${s.key}`);
    if(state!==s||s.reviewVersion!==reviewVersion)return;
    const hasAccount=!!(account&&Object.keys(account).length);
    if(hasAccount&&mode==='linked')
      throw new Error('За цим записом є рахунок харчування — гроші автоматично до іншого учня не переносяться. Якщо дитина вже не навчається, натисніть «Учень більше не навчається / запис зайвий». Якщо це та сама дитина під новим записом — перенесіть залишок через адміністрацію, а потім поверніться сюди.');
    let target=null,text='Запис буде позначений як архівний і зникне з попередження. Оригінал лишиться збереженим.';
    let accountHtml='';
    if(hasAccount){
      // Скільки грошей на цьому записі — щоб було видно, що з ними робити далі
      let money='';
      try{
        const a=await computeMealAccount(s.cls,s.key,account);
        if(state!==s||s.reviewVersion!==reviewVersion)return;
        money=`Внесено ${escHtml(a.income.toFixed(2))} zł, списано ${escHtml(a.charged.toFixed(2))} zł, залишок <b>${escHtml(a.balance.toFixed(2))} zł</b>.`;
        s.balance=a.balance; s.accountStart=accountStart(account);
      }catch(e){ money='Залишок порахувати не вдалося.'; s.balance=null; }
      // Розрахувалися поза порталом (вибуття): одним натиском записати це в
      // рахунок, щоб залишок став нульовим. Журнал лише доповнюється — усе
      // попереднє лишається видно.
      const b=s.balance;
      const settle=(mode==='archived'&&Number.isFinite(b)&&Math.abs(b)>=0.01)
        ? `<button type="button" onclick="settleMealOrphanAccount()" style="width:auto;max-width:100%">${b<0
            ? `💳 Батьки розрахувалися — записати оплату ${escHtml((-b).toFixed(2))} zł`
            : `↩️ Залишок повернули батькам — записати ${escHtml(b.toFixed(2))} zł`}</button>` : '';
      accountHtml=`<p>💰 За цим записом є рахунок харчування. ${money} ${Number.isFinite(b)&&Math.abs(b)<0.01
        ? 'Рахунок закрито, залишок нульовий.'
        : 'Якщо з родиною вже розрахувалися, запишіть це кнопкою нижче — залишок стане нульовим. Історія рахунку зберігається.'}</p>${settle}`;
    }
    if(mode==='linked'){
      const value=document.getElementById('meal-orphan-target').value;
      target=value!==''?s.choices[Number(value)]:null;
      if(!target)throw new Error('Спочатку оберіть учня.');
      const [plan,legacy]=await Promise.all([read(`meal_plan/${target.cls}/${target.sid}`),
        target.name!==target.sid?read(`meal_plan/${target.cls}/${target.name}`):null]);
      if(state!==s||s.reviewVersion!==reviewVersion)return;
      text=`${target.name}, ${target.cls.replace('class_','')} клас. `+(plan!==null||legacy!==null
        ?'Учень уже має налаштування: вони залишаться чинними. Старий запис буде позначений як розібраний.'
        :'Учень ще не має налаштувань: буде скопійовано цей постійний план.');
    }
    s.review={mode,target};
    box.innerHTML=`<p>${escHtml(text)}</p>${accountHtml}<p>Денні вибори А/Б, рахунок і списання не змінюються. Оригінал запису зберігається.</p>${target&&target.cls!==s.cls?'<p>Після переведення директору також потрібно звірити клас дитини в прив’язці батьків.</p>':''}<button id="meal-orphan-apply" type="button" onclick="saveMealOrphanRepair()">Підтвердити цю дію</button>`;
  }catch(e){box.textContent=e.message;}
};
window.settleMealOrphanAccount=async function(){
  if(!state||busy||!canRepair())return;
  const s=state,b=Number(s.balance);
  if(!Number.isFinite(b)||Math.abs(b)<0.01||!s.accountStart)return;
  const amount=Math.round(-b*100)/100;
  if(!confirm(b<0
    ? `Записати оплату ${(-b).toFixed(2)} zł — батьки розрахувалися при вибутті?\n\nЗалишок стане 0. Запис додається до історії рахунку, нічого не видаляється.`
    : `Записати повернення ${b.toFixed(2)} zł батькам?\n\nЗалишок стане 0. Запис додається до історії рахунку, нічого не видаляється.`))return;
  busy=true;
  try{
    const d=new Date(),p2=n=>String(n).padStart(2,'0'),today=`${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())}`;
    await set(push(ref(db,`meal_accounts/${s.cls}/${s.key}`)),{amount,date:today,startDate:s.accountStart,
      note:b<0?'Розрахунок при вибутті':'Повернення залишку при вибутті',by:currentUserData?.email||'',ts:Date.now()});
    showToast('✅ Розрахунок записано');
  }catch(e){ busy=false; return alert('Не вдалося записати: '+e.message); }
  busy=false;
  window.previewMealOrphanRepair('archived');
};
window.saveMealOrphanRepair=async function(){
  if(!state?.review||busy||!canRepair())return;
  const s=state,{mode,target}=s.review,button=document.getElementById('meal-orphan-apply');
  busy=true;if(button)button.disabled=true;
  try{
    await applyMealPlanRepair({cls:s.cls,key:s.key,source:s.source,mode,targetClass:target?.cls,targetId:target?.sid});
    busy=false;close();showToast('✅ Запис розібрано, оригінал збережено');
    window.refreshKitchen?.();window.loadClassOrders?.();window.loadMealPlans?.();
  }catch(e){document.getElementById('meal-orphan-preview').textContent='Не вдалося завершити: '+e.message;}
  finally{busy=false;if(button)button.disabled=false;}
};
