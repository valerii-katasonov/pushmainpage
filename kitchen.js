// ═══════════════════════════════════════════════════════════════
// kitchen.js — облік харчування: меню на день і кількість обідів.
//
// МОДЕЛЬ ДАНИХ. Записуємо лише ВІДМОВИ, а не тих, хто їсть:
//   student_cards/{clas}/{key}.meals = 'no'  → дитина взагалі не на харчуванні
//   meal_optout/{дата}/{клас}/{ІМʼЯ} = {reason, by, ts} → разова відмова
// Так у базі лежать десятки записів на місяць замість тисяч, і це збігається
// з реальністю: більшість дітей обідає щодня, відмова — виняток.
//
//   menu/{дата} = {first, second, side, drink, dessert, note, allergens}
// ═══════════════════════════════════════════════════════════════
import { ref, set, get, child, remove } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, currentUserData, showToast, escHtml, escJs, localDateString, logAction } from './common.js';

export const MENU_FIELDS=[
  {k:'first',   label:'Перша страва', ph:'напр. Борщ український'},
  {k:'second',  label:'Друга страва', ph:'напр. Котлета з індички'},
  {k:'side',    label:'Гарнір',       ph:'напр. Пюре картопляне'},
  {k:'drink',   label:'Напій',        ph:'напр. Компот із сухофруктів'},
  {k:'dessert', label:'Десерт',       ph:'необовʼязково'},
  {k:'allergens',label:'⚠️ Алергени', ph:'напр. містить глютен, молоко', danger:true},
  {k:'note',    label:'Примітка',     ph:'необовʼязково'}
];

// ── МЕНЮ ──
export async function loadMenuEditor(){
  const date=document.getElementById('k-date')?.value;
  const box=document.getElementById('k-menu-fields');
  if(!box||!date)return;
  const snap=await get(child(ref(db),`menu/${date}`));
  const m=snap.exists()?snap.val():{};
  box.innerHTML=MENU_FIELDS.map(f=>`
    <label for="km-${f.k}" ${f.danger?'style="color:var(--red);"':''}>${escHtml(f.label)}</label>
    <input type="text" id="km-${f.k}" value="${escHtml(m[f.k]||'')}" placeholder="${escHtml(f.ph)}">
  `).join('');
  const info=document.getElementById('k-menu-info');
  if(info)info.textContent=m.ts?`Оновлено ${new Date(m.ts).toLocaleString('uk-UA')}`:'Меню на цей день ще не заповнене';
}
window.loadMenuEditor=loadMenuEditor;
window.saveMenu=async function(){
  const date=document.getElementById('k-date').value;
  if(!date)return alert('Оберіть дату.');
  const data={};
  MENU_FIELDS.forEach(f=>{const el=document.getElementById('km-'+f.k);if(el)data[f.k]=el.value.trim();});
  if(!data.first&&!data.second)return alert('Заповніть хоча б першу або другу страву.');
  await set(ref(db,`menu/${date}`),{...data,by:currentUserData?.email||'',ts:Date.now()});
  logAction('menu',{date,value:data.first||data.second});
  showToast('✅ Меню збережено');
  loadMenuEditor();
};
// Часто меню повторюється або складається на тиждень наперед
window.copyMenuForward=async function(){
  const date=document.getElementById('k-date').value;
  const days=parseInt(document.getElementById('k-copy-days').value,10)||0;
  if(!date||days<1)return alert('Оберіть дату і кількість днів.');
  const snap=await get(child(ref(db),`menu/${date}`));
  if(!snap.exists())return alert('Спочатку збережіть меню на цю дату.');
  const m=snap.val();
  if(!confirm(`Скопіювати це меню на наступні ${days} робочих днів?\n\nІснуюче меню тих днів буде замінено.`))return;
  let d=new Date(date), done=0;
  while(done<days){
    d.setDate(d.getDate()+1);
    if(d.getDay()===0||d.getDay()===6)continue; // вихідні пропускаємо
    const key=d.toISOString().slice(0,10);
    await set(ref(db,`menu/${key}`),{...m,by:currentUserData?.email||'',ts:Date.now()});
    done++;
  }
  showToast(`✅ Скопійовано на ${days} дн.`);
};

// ── ПІДРАХУНОК ОБІДІВ ──
// Кухні щоранку потрібна одна цифра: скільки готувати. Рахуємо як
// «усі, хто на харчуванні» мінус «ті, хто сьогодні відмовився».
export async function loadMealCounts(){
  const date=document.getElementById('k-date')?.value;
  const box=document.getElementById('k-counts');
  if(!box||!date)return;
  box.innerHTML='<p class="empty-msg">Обчислення...</p>';
  try{
    const [stSnap,cardSnap,outSnap]=await Promise.all([
      get(child(ref(db),'students_list')),
      get(child(ref(db),'student_cards')),
      get(child(ref(db),`meal_optout/${date}`))
    ]);
    const students=stSnap.exists()?stSnap.val():{};
    const cards=cardSnap.exists()?cardSnap.val():{};
    const outs=outSnap.exists()?outSnap.val():{};
    let total=0, skipped=0, offPlan=0;
    const rows=[], skipList=[];
    for(let i=1;i<=11;i++){
      const cls=`class_${i}`;
      if(!students[cls])continue;
      let eat=0, off=0, skip=0;
      for(const key in students[cls]){
        const name=students[cls][key];
        // 'no' у картці — дитина взагалі не харчується в школі
        if(cards[cls]&&cards[cls][key]&&cards[cls][key].meals==='no'){off++;offPlan++;continue;}
        if(outs[cls]&&outs[cls][name]){skip++;skipped++;skipList.push({cls,name,reason:outs[cls][name].reason||''});continue;}
        eat++;total++;
      }
      if(eat+off+skip>0)rows.push({cls,eat,off,skip});
    }
    box.innerHTML=`<div class="k-total"><b>${total}</b><span>обідів на ${escHtml(date.split('-').reverse().join('.'))}</span></div>
      <div class="k-sub">не харчуються постійно: ${offPlan} · відмовились сьогодні: ${skipped}</div>
      <table class="k-table"><thead><tr><th>Клас</th><th>Обідів</th><th>Відмова</th><th>Не харч.</th></tr></thead><tbody>
      ${rows.map(r=>`<tr><td>${escHtml(r.cls.replace('class_',''))}</td>
        <td><b>${r.eat}</b></td><td>${r.skip||''}</td><td class="k-off">${r.off||''}</td></tr>`).join('')}
      </tbody></table>
      ${skipList.length?`<div class="k-skip-title">Відмови на цей день</div>`+
        skipList.map(s=>`<div class="k-skip">${escHtml(s.name)} <span>${escHtml(s.cls.replace('class_',''))} кл.${s.reason?' · '+escHtml(s.reason):''}</span></div>`).join('')
        :''}`;
  }catch(e){box.innerHTML=`<p style="color:red;font-size:.8rem;">Помилка: ${escHtml(e.message)}</p>`;}
}
window.loadMealCounts=loadMealCounts;
window.refreshKitchen=function(){loadMenuEditor();loadMealCounts();};

// ── БІК БАТЬКІВ ──
// Показуємо меню і даємо відмовитися. Свідомо дозволяємо відмову лише
// на сьогодні і наперед: заднім числом кухні це вже не допоможе.
export async function renderParentMenu(cls,studentName,date){
  const box=document.getElementById('p-menu');
  if(!box)return;
  try{
    const [mSnap,oSnap]=await Promise.all([
      get(child(ref(db),`menu/${date}`)),
      get(child(ref(db),`meal_optout/${date}/${cls}/${studentName}`))
    ]);
    const m=mSnap.exists()?mSnap.val():null;
    const off=oSnap.exists();
    const past=date<localDateString;
    if(!m&&!off){box.style.display='none';return;}
    box.style.display='block';
    const dishes=['first','second','side','drink','dessert']
      .filter(k=>m&&m[k]).map(k=>`<div class="pm-dish">${escHtml(m[k])}</div>`).join('');
    box.innerHTML=`<div class="pm-title">🍽️ Меню на ${escHtml(date.split('-').reverse().join('.'))}</div>
      ${dishes||'<div class="pm-none">Меню ще не опубліковане</div>'}
      ${m&&m.allergens?`<div class="pm-allerg">⚠️ ${escHtml(m.allergens)}</div>`:''}
      ${m&&m.note?`<div class="pm-note">${escHtml(m.note)}</div>`:''}
      <div class="pm-act">
        ${off
          ? `<span class="pm-off">✕ Дитина не обідає цього дня</span>
             ${past?'':`<button class="pm-btn back" onclick="cancelMealOptout('${escJs(date)}')">Скасувати відмову</button>`}`
          : (past?'<span class="pm-past">День минув</span>'
                 :`<button class="pm-btn" onclick="mealOptout('${escJs(date)}')">Не буде обідати</button>`)}
      </div>`;
  }catch(e){box.style.display='none';}
}
window.mealOptout=async function(date){
  const cls=currentUserData?.class, name=currentUserData?.studentName;
  if(!cls||!name)return;
  const reason=prompt('Причина (необовʼязково):','')||'';
  await set(ref(db,`meal_optout/${date}/${cls}/${name}`),
    {reason:reason.trim().slice(0,120),by:currentUserData.email||'',ts:Date.now()});
  showToast('✕ Відмову зафіксовано');
  renderParentMenu(cls,name,date);
};
window.cancelMealOptout=async function(date){
  const cls=currentUserData?.class, name=currentUserData?.studentName;
  if(!cls||!name)return;
  await remove(ref(db,`meal_optout/${date}/${cls}/${name}`));
  showToast('✓ Відмову скасовано');
  renderParentMenu(cls,name,date);
};
