// Лицеві рахунки харчування: надходження вносять кухня/директор,
// витрати обчислюються з фактичного харчування та замовлень на винос.
import { ref, get, child, push, update } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, currentUserData, showToast, escHtml, localDateString, stuName } from './common.js';
import { computeMyMealStats, loadMealPrices, mealCost, mealPriceAt, MEAL_CUTOFF_HOUR, BREAKFAST_CUTOFF_HOUR, TA_CUTOFF_HOUR } from './kitchen.js';

const money=n=>(Math.round((Number(n)||0)*100)/100);
const moneyText=n=>money(n).toFixed(2);
const iso=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const dayBefore=s=>{const d=new Date(s+'T12:00:00');d.setDate(d.getDate()-1);return iso(d);};
const datesBetween=(a,b)=>{const out=[],d=new Date(a+'T12:00:00'),e=new Date(b+'T12:00:00');while(d<=e){out.push(iso(d));d.setDate(d.getDate()+1);}return out;};

export function accountStart(entries){
  const rows=Object.values(entries||{}).filter(x=>x&&Number(x.amount)>0);
  return rows.map(x=>String(x.startDate||x.date||'')).filter(Boolean).sort()[0]||'';
}
export function credited(entries,today=localDateString){
  return money(Object.values(entries||{}).filter(x=>x&&String(x.date||'')<=today).reduce((s,x)=>s+Number(x.amount||0),0));
}
export function cutoffState(date,hour,now=new Date(),today=localDateString){
  if(date<today)return true;if(date>today)return false;return now.getHours()>=hour;
}
export function balanceResult(income,charged,pending=0){
  return {income:money(income),charged:money(charged),pending:money(pending),balance:money(income-charged),afterPending:money(income-charged-pending)};
}

async function studentKey(cls,id,name){
  const s=await get(child(ref(db),`students_list/${cls}`));
  const rows=s.exists()?s.val():{};
  if(id&&Object.prototype.hasOwnProperty.call(rows,id))return id;
  return Object.keys(rows).find(k=>String(rows[k]).trim()===String(name||'').trim())||name||'';
}
async function mealCounts(from,to,cls,sid){
  if(!from||from>to)return {lunch:0,brk:0,snack:0};
  const all={lunch:0,brk:0,snack:0};
  const ds=datesBetween(from,to);
  for(let i=0;i<ds.length;i+=60){
    const part=(await computeMyMealStats(ds[i],ds[Math.min(i+59,ds.length-1)],cls,sid))[0]||{};
    all.lunch+=Number(part.lunch)||0;all.brk+=Number(part.brk)||0;all.snack+=Number(part.snack)||0;
  }
  return all;
}
export const priceAt=mealPriceAt;
async function pricedMeals(from,to,cls,sid,current,history){
  if(!from||from>to)return {total:0,lunch:0,brk:0,snack:0};
  const changes=Object.keys(history||{}).filter(d=>d>from&&d<=to).sort();
  const starts=[from,...changes], out={total:0,lunch:0,brk:0,snack:0};
  for(let i=0;i<starts.length;i++){
    const end=i+1<starts.length?dayBefore(starts[i+1]):to;
    const c=mealCost(await mealCounts(starts[i],end,cls,sid),priceAt(starts[i],current,history));
    for(const k of Object.keys(out))out[k]=money(out[k]+Number(c[k]||0));
  }
  return out;
}
function takeawayPrice(id,date,items,history){
  const h=history?.[id]||{},all=Object.keys(h).sort(),keys=all.filter(d=>d<=date);
  return Number(keys.length?h[keys[keys.length-1]]:all.length?h[all[0]]:items[id]?.price)||0;
}
async function takeawayCostHistoric(from,to,cls,sid,items,history){
  if(!from||from>to)return 0;
  const dates=datesBetween(from,to);let total=0;
  // Довга історія може містити сотні днів. Читаємо невеликими порціями,
  // щоб браузер і Firebase не отримали сотні одночасних запитів.
  for(let i=0;i<dates.length;i+=60){
    const part=dates.slice(i,i+60);
    const sums=await Promise.all(part.map(async date=>{
      const s=await get(child(ref(db),`takeaway_orders/${date}/${cls}/${sid}`)),order=s.exists()?s.val():{};
      return Object.entries(order||{}).reduce((n,[id,q])=>n+(Number(q)||0)*takeawayPrice(id,date,items,history),0);
    }));
    total+=sums.reduce((a,b)=>a+b,0);
  }
  return money(total);
}

export function ledgerTotals(from,to,ledger){
  const parts={lunch:0,brk:0,snack:0,takeaway:0,total:0},missing=[];
  if(!from||from>to)return {parts,missing};
  for(const date of datesBetween(from,to)){
    const row=ledger?.[date];
    if(!row||!Number.isFinite(Number(row.total))){missing.push(date);continue;}
    parts.lunch=money(parts.lunch+Number(row.lunch||0));
    parts.brk=money(parts.brk+Number(row.breakfast||0));
    parts.snack=money(parts.snack+Number(row.snack||0));
    parts.takeaway=money(parts.takeaway+Number(row.takeaway||0));
    parts.total=money(parts.total+Number(row.total));
  }
  return {parts,missing};
}
function contiguousRanges(dates){
  const ranges=[];
  for(const date of dates){
    const last=ranges.at(-1);
    if(last&&dayBefore(date)===last.to)last.to=date;
    else ranges.push({from:date,to:date});
  }
  return ranges;
}

export async function computeMealAccount(cls,sid,entries,now=new Date()){
  const start=accountStart(entries),today=iso(now);
  const prices=await loadMealPrices(true,true);
  const [itemSnap,priceHistorySnap,taHistorySnap]=await Promise.all([
    get(child(ref(db),'takeaway_items')),get(child(ref(db),'meal_price_history')),get(child(ref(db),'takeaway_price_history'))
  ]);
  const items=itemSnap.exists()?itemSnap.val():{};
  const priceHistory=priceHistorySnap.exists()?priceHistorySnap.val():{};
  const taHistory=taHistorySnap.exists()?taHistorySnap.val():{};
  if(!start||start>today)return {start,entries,prices,...balanceResult(credited(entries,today),0,0),parts:{}};
  const [ledgerSnap, adjustmentSnap]=await Promise.all([
    get(child(ref(db),`meal_ledger/${cls}/${sid}`)),
    get(child(ref(db),`meal_ledger_adjustments/${cls}/${sid}`))
  ]);
  const ledger=ledgerSnap.exists()?ledgerSnap.val():{};
  const adjustments=adjustmentSnap.exists()?adjustmentSnap.val():{};
  const pastEnd=dayBefore(today);
  const sealed=ledgerTotals(start,pastEnd,ledger);
  const pastMeals={lunch:sealed.parts.lunch,brk:sealed.parts.brk,snack:sealed.parts.snack,
    total:money(sealed.parts.lunch+sealed.parts.brk+sealed.parts.snack)};
  let pastTa=sealed.parts.takeaway;
  for(const range of contiguousRanges(sealed.missing)){
    const dynamic=await pricedMeals(range.from,range.to,cls,sid,prices,priceHistory);
    for(const k of Object.keys(pastMeals))pastMeals[k]=money(pastMeals[k]+dynamic[k]);
    pastTa=money(pastTa+await takeawayCostHistoric(range.from,range.to,cls,sid,items,taHistory));
  }
  const todaySealed=ledger[today]&&Number.isFinite(Number(ledger[today].total));
  const todayCounts=todaySealed?{lunch:0,brk:0,snack:0}:await mealCounts(today,today,cls,sid);
  const todayPrices=priceAt(today,prices,priceHistory);
  const brkCost=todaySealed?money(ledger[today].breakfast):money(todayCounts.brk*todayPrices.breakfast);
  const lunchCost=todaySealed?money(ledger[today].lunch):money(todayCounts.lunch*todayPrices.lunch);
  const snackCost=todaySealed?money(ledger[today].snack):money(todayCounts.snack*todayPrices.snack);
  const todayTa=todaySealed?money(ledger[today].takeaway):await takeawayCostHistoric(today,today,cls,sid,items,taHistory);
  const brkClosed=todaySealed||cutoffState(today,BREAKFAST_CUTOFF_HOUR,now,today);
  const mealClosed=todaySealed||cutoffState(today,MEAL_CUTOFF_HOUR,now,today);
  const taClosed=todaySealed||cutoffState(today,TA_CUTOFF_HOUR,now,today);
  const adjustmentTotal=money(Object.values(adjustments).filter(x=>x&&x.date>=start&&x.date<=today)
    .reduce((sum,x)=>sum+Number(x.amount||0),0));
  const charged=money(pastMeals.total+pastTa+(brkClosed?brkCost:0)+(mealClosed?lunchCost+snackCost:0)+(taClosed?todayTa:0)+adjustmentTotal);
  const pending=money((brkClosed?0:brkCost)+(mealClosed?0:lunchCost+snackCost)+(taClosed?0:todayTa));
  const chargedParts={
    lunch:money(pastMeals.lunch+(mealClosed?lunchCost:0)),
    breakfast:money(pastMeals.brk+(brkClosed?brkCost:0)),
    snack:money(pastMeals.snack+(mealClosed?snackCost:0)),
    takeaway:money(pastTa+(taClosed?todayTa:0)),
    adjustments:adjustmentTotal
  };
  return {start,entries,prices,parts:{pastMeals,pastTa,brkCost,lunchCost,snackCost,todayTa,
    chargedParts,ledger,adjustments,unsealed:sealed.missing.length},
    ...balanceResult(credited(entries,today),charged,pending)};
}

function renderAccount(box,a,name,editable){
  const cls=a.balance<0?' bad':a.balance<50?' low':'';
  const rows=Object.entries(a.entries||{}).sort((x,y)=>String(y[1]?.date||'').localeCompare(String(x[1]?.date||''))).slice(0,12);
  const ledgerRows=Object.entries(a.parts.ledger||{}).filter(([date])=>date>=a.start)
    .sort((x,y)=>y[0].localeCompare(x[0])).slice(0,30);
  const adjustmentRows=Object.values(a.parts.adjustments||{})
    .sort((x,y)=>String(y.date||'').localeCompare(String(x.date||''))).slice(0,20);
  box.innerHTML=`<div class="mb-head${cls}"><span>${escHtml(name||'Рахунок')}</span><b>${moneyText(a.balance)} zł</b><small>надходження ${moneyText(a.income)} · списано ${moneyText(a.charged)}</small></div>
    ${a.pending?`<div class="mb-pending">Після сьогоднішніх дедлайнів: <b>${moneyText(a.afterPending)} zł</b> (очікує списання ${moneyText(a.pending)} zł)</div>`:''}
    ${a.start?`<div class="mb-note">Харчування рахується від ${escHtml(a.start)}. Списано: обіди ${moneyText(a.parts.chargedParts?.lunch||0)} · сніданки ${moneyText(a.parts.chargedParts?.breakfast||0)} · підвечірки ${moneyText(a.parts.chargedParts?.snack||0)} · винос ${moneyText(a.parts.chargedParts?.takeaway||0)} · корекції ${moneyText(a.parts.chargedParts?.adjustments||0)} zł.</div>`:'<div class="mb-note">Рахунок ще не відкрито: додайте перше надходження.</div>'}
    ${a.parts.unsealed?`<div class="mb-pending">Ще не зафіксовано днів: ${a.parts.unsealed}. Для них показано попередній розрахунок; після нічного закриття суми стануть незмінними.</div>`:''}
    ${editable?`<div class="mb-form"><label>Дата надходження<input type="date" id="mb-date" value="${iso(new Date())}"></label><label>Рахувати харчування від<input type="date" id="mb-start" value="${a.start||iso(new Date())}" ${a.start?'disabled':''}></label><input type="text" id="mb-amount" inputmode="decimal" placeholder="Сума, zl"><input type="text" id="mb-note" maxlength="120" placeholder="Примітка"><button id="mb-add" onclick="addMealAccountEntry()">Додати</button><small>${a.start?`Початок розрахунку зафіксовано: ${escHtml(a.start)}. `:''}Для повернення платежу введіть від’ємну суму.</small></div>`:''}
    <details class="mb-history"><summary>Історія надходжень і корекцій</summary>${rows.length?rows.map(([,x])=>`<div><span>${escHtml(x.date||'')}</span><b class="${Number(x.amount)<0?'neg':''}">${Number(x.amount)>0?'+':''}${moneyText(x.amount)} zł</b><small>${escHtml(x.note||'')}</small></div>`).join(''):'<p class="empty-msg">Записів ще немає.</p>'}</details>
    <details class="mb-history mb-ledger"><summary>Щоденний журнал списань</summary>${ledgerRows.length?ledgerRows.map(([date,x])=>`<div><span>${escHtml(date)}</span><b>${moneyText(x.total)} zł</b><small>сніданок ${moneyText(x.breakfast)}${x.breakfastChoice?` (${escHtml(x.breakfastChoice)})`:''} · обід ${moneyText(x.lunch)}${x.lunchChoice?` (${escHtml(x.lunchChoice)})`:''} · підвечірок ${moneyText(x.snack)} · винос ${moneyText(x.takeaway)}</small></div>`).join(''):'<p class="empty-msg">Закритих днів ще немає.</p>'}</details>
    <details class="mb-history"><summary>Корекції списань</summary>${adjustmentRows.length?adjustmentRows.map(x=>`<div><span>${escHtml(x.date||'')}</span><b class="${Number(x.amount)<0?'neg':''}">${Number(x.amount)>0?'+':''}${moneyText(x.amount)} zł</b><small>${escHtml(x.reason||'')}</small></div>`).join(''):'<p class="empty-msg">Корекцій немає.</p>'}</details>
    ${editable&&ledgerRows.length?`<div class="mb-adjust"><b>Виправити закритий день</b><p>Початкове списання лишиться в журналі. Плюс — додаткове списання, мінус — повернення.</p><div><input type="date" id="mb-adj-date" value="${escHtml(ledgerRows[0][0])}"><input type="text" id="mb-adj-amount" inputmode="decimal" placeholder="+ або − сума, zł"><input type="text" id="mb-adj-reason" maxlength="160" placeholder="Причина корекції"><button id="mb-adj-add" onclick="addMealChargeAdjustment()">Додати корекцію</button></div></div>`:''}`;
}

let selected={cls:'',sid:'',name:'',start:'',entries:{},ledger:{}};
let accountSaving=false,adjustmentSaving=false,kitchenLoadSeq=0,familyLoadSeq=0,familyCache=null;
window.invalidateMealBalance=()=>{familyCache=null;};
window.loadMealAccountStudents=async function(){
  kitchenLoadSeq++;
  const cls=document.getElementById('k-balance-class')?.value||'';
  const sel=document.getElementById('k-balance-student');if(!sel)return;
  selected={cls,sid:'',name:'',start:'',entries:{},ledger:{}};sel.innerHTML='<option value="">Оберіть дитину...</option>';
  if(!cls)return;
  try{
    const s=await get(child(ref(db),`students_list/${cls}`));
    const rows=s.exists()?s.val():{};
    sel.innerHTML+=Object.entries(rows).sort((a,b)=>String(a[1]).localeCompare(String(b[1]),'uk')).map(([id,n])=>`<option value="${escHtml(id)}">${escHtml(n)}</option>`).join('');
  }catch(e){
    const box=document.getElementById('k-meal-balance');
    if(box)box.innerHTML=`<p class="empty-msg">Не вдалося завантажити учнів: ${escHtml(e.message)}</p>`;
  }
};
window.loadKitchenMealAccount=async function(){
  const cls=document.getElementById('k-balance-class')?.value||'',sid=document.getElementById('k-balance-student')?.value||'',box=document.getElementById('k-meal-balance');
  if(!box||!cls||!sid){if(box)box.innerHTML='<p class="empty-msg">Оберіть клас і дитину.</p>';return;}
  const seq=++kitchenLoadSeq;
  box.innerHTML='<p class="empty-msg">Рахуємо...</p>';selected={cls,sid,name:stuName(cls,sid),start:'',entries:{},ledger:{}};
  try{
    const s=await get(child(ref(db),`meal_accounts/${cls}/${sid}`)),entries=s.exists()?s.val():{};
    const a=await computeMealAccount(cls,sid,entries);
    if(seq!==kitchenLoadSeq||document.getElementById('k-balance-class')?.value!==cls||document.getElementById('k-balance-student')?.value!==sid)return;
    selected.entries=entries;selected.start=a.start;selected.ledger=a.parts.ledger||{};renderAccount(box,a,selected.name,true);
  }catch(e){if(seq===kitchenLoadSeq)box.innerHTML=`<p class="empty-msg">Помилка: ${escHtml(e.message)}</p>`;}
};
window.addMealAccountEntry=async function(){
  const amount=Number(String(document.getElementById('mb-amount')?.value||'').replace(',','.')),date=document.getElementById('mb-date')?.value,startDate=selected.start||document.getElementById('mb-start')?.value,note=(document.getElementById('mb-note')?.value||'').trim();
  if(accountSaving||!selected.cls||!selected.sid)return;if(!Number.isFinite(amount)||!money(amount)||Math.abs(amount)>100000)return alert('Введіть коректну ненульову суму щонайменше 0,01 zł.');if(!date||!startDate)return alert('Вкажіть дати.');
  if(amount<0&&!selected.start)return alert('Спочатку додайте перше надходження і відкрийте рахунок.');
  const button=document.getElementById('mb-add');accountSaving=true;if(button)button.disabled=true;
  try{
    const [ph,th,it]=await Promise.all([get(child(ref(db),'meal_price_history')),get(child(ref(db),'takeaway_price_history')),get(child(ref(db),'takeaway_items'))]);
    const prices=await loadMealPrices(true),priceHistory=ph.exists()?ph.val():{},taHistory=th.exists()?th.val():{},items=it.exists()?it.val():{};
    const id=push(ref(db,`meal_accounts/${selected.cls}/${selected.sid}`)).key,changes={
      [`meal_accounts/${selected.cls}/${selected.sid}/${id}`]:{amount:money(amount),date,startDate,note:note.slice(0,120),by:currentUserData?.email||'',ts:Date.now()}
    };
    if(!Object.keys(priceHistory||{}).length)changes[`meal_price_history/${startDate}`]={...prices,ts:Date.now()};
    for(const itemId of Object.keys(items||{}))if(!Object.keys(taHistory?.[itemId]||{}).length)changes[`takeaway_price_history/${itemId}/${startDate}`]=Number(items[itemId]?.price)||0;
    await update(ref(db),changes);
    showToast('✅ Операцію додано');await window.loadKitchenMealAccount();
  }catch(e){
    alert('Не вдалося додати операцію: '+e.message);
  }finally{accountSaving=false;if(button&&document.body.contains(button))button.disabled=false;}
};

window.addMealChargeAdjustment=async function(){
  if(adjustmentSaving||!selected.cls||!selected.sid||!selected.start)return;
  const date=document.getElementById('mb-adj-date')?.value||'';
  const amount=Number(String(document.getElementById('mb-adj-amount')?.value||'').replace(',','.'));
  const reason=String(document.getElementById('mb-adj-reason')?.value||'').trim();
  if(!date||date<selected.start||date>iso(new Date())||!selected.ledger?.[date])return alert('Оберіть день, який уже зафіксовано в журналі.');
  if(!Number.isFinite(amount)||!money(amount)||Math.abs(amount)>100000)return alert('Введіть ненульову суму корекції щонайменше 0,01 zł.');
  if(!reason)return alert('Вкажіть причину корекції.');
  const button=document.getElementById('mb-adj-add');
  adjustmentSaving=true;if(button)button.disabled=true;
  try{
    const path=`meal_ledger_adjustments/${selected.cls}/${selected.sid}`;
    const id=push(ref(db,path)).key;
    await update(ref(db),{[`${path}/${id}`]:{
      amount:money(amount),date,reason:reason.slice(0,160),by:currentUserData?.email||'',ts:Date.now()
    }});
    if(window.invalidateMealBalance)window.invalidateMealBalance();
    showToast('✅ Корекцію додано');await window.loadKitchenMealAccount();
  }catch(e){alert('Не вдалося додати корекцію: '+e.message);}
  finally{adjustmentSaving=false;if(button&&document.body.contains(button))button.disabled=false;}
};

window.loadFamilyMealBalance=async function(){
  const box=document.getElementById('p-meal-balance');if(!box||!currentUserData)return;
  const seq=++familyLoadSeq;
  const cls=currentUserData.class;if(!cls)return;
  let sid='';
  try{sid=await studentKey(cls,currentUserData.studentId,currentUserData.studentName);}
  catch(e){if(seq===familyLoadSeq)box.innerHTML=`<p class="empty-msg">Не вдалося визначити дитину: ${escHtml(e.message)}</p>`;return;}
  if(!sid||seq!==familyLoadSeq)return;
  const phase=`${new Date().getHours()>=BREAKFAST_CUTOFF_HOUR}:${new Date().getHours()>=MEAL_CUTOFF_HOUR}:${new Date().getHours()>=TA_CUTOFF_HOUR}`;
  const cacheKey=`${cls}/${sid}/${iso(new Date())}/${phase}`;
  if(familyCache?.key===cacheKey&&Date.now()-familyCache.at<30000){renderAccount(box,familyCache.account,currentUserData.studentName,false);return;}
  box.innerHTML='<p class="empty-msg">Рахуємо...</p>';
  try{
    const s=await get(child(ref(db),`meal_accounts/${cls}/${sid}`));const account=await computeMealAccount(cls,sid,s.exists()?s.val():{});
    if(seq!==familyLoadSeq)return;familyCache={key:cacheKey,at:Date.now(),account};renderAccount(box,account,currentUserData.studentName,false);
  }catch(e){if(seq===familyLoadSeq)box.innerHTML=`<p class="empty-msg">Не вдалося завантажити баланс: ${escHtml(e.message)}</p>`;}
};

// Якщо авторизація завершилася раніше, ніж завантажився цей модуль,
// перший виклик із renderParentMenu міг ще не існувати.
setTimeout(()=>{if(currentUserData?.role==='parent'&&document.getElementById('p-meal-balance'))window.loadFamilyMealBalance();},0);
