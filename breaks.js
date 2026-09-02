// ═══════════════════════════════════════════════════════════════
// breaks.js — перерви класу: назви, розстановка в усі дні, копіювання.
//
// ЗВІДКИ БЕРЕТЬСЯ ЧАС. З розкладу дзвінків класу, і тільки звідти.
// Перерва — це проміжок між кінцем одного уроку й початком наступного,
// тобто час перерв уже заданий дзвінками. Якби ми завели окреме сховище
// з часом перерв, школа отримала б два місця з тим самим часом, які
// зобов'язані збігатися. Перший же зсув дзвінків на п'ять хвилин — і вони
// розійшлися б, а портал почав би показувати батькам неправду.
//
// ЩО ЗБЕРІГАЄМО ОКРЕМО. Лише назви: break_names/{клас}/{після якого уроку}.
// «Обід 1-3 класи» з проміжку не вирахуєш. Назва необов'язкова — без неї
// перерва підписується просто «Перерва 20 хв».
//
// ЧОМУ ПОВТОРНЕ ЗАСТОСУВАННЯ БЕЗПЕЧНЕ. Перед розстановкою прибираємо
// наявні перерви з дня. Інакше друге натискання подвоїло б їх, а третє
// потроїло — і день перетворився б на кашу.
// ═══════════════════════════════════════════════════════════════
import { ref, set, get, child, update, remove } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, currentUserData, showToast, escHtml, escJs, logAction,
         makeBreak, hhmmFromMins, isBreakItem, dayNamesUA } from './common.js';

export const BREAKS_BUILD = '2026-09-02 · breaks v1';

const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const CLASSES = Array.from({ length: 11 }, (_, i) => `class_${i + 1}`);
const DIR_ROLES = ['director', 'administrator'];

// ── Чиста логіка ────────────────────────────────────────────────

function mins(t){
  const [h, m] = String(t || '').split(':').map(Number);
  return (isNaN(h) || isNaN(m)) ? null : h * 60 + m;
}

// Проміжки між дзвінками → [{after, start, end, mins}]
export function gapsFromBells(bells, minMinutes = 5){
  const slots = Object.values(bells || {})
    .map(s => ({ number: parseInt(s && s.number, 10), start: mins(s && s.start), end: mins(s && s.end) }))
    .filter(s => s.number && s.start != null && s.end != null)
    .sort((a, b) => a.number - b.number);
  const out = [];
  for(let i = 0; i < slots.length - 1; i++){
    const gap = slots[i + 1].start - slots[i].end;
    if(gap < minMinutes) continue;
    out.push({ after: slots[i].number, start: hhmmFromMins(slots[i].end),
               end: hhmmFromMins(slots[i + 1].start), mins: gap });
  }
  return out;
}

// Проміжки + назви → готовий план перерв
export function breakPlan(bells, names, minMinutes = 5){
  return gapsFromBells(bells, minMinutes).map(g => ({
    ...g,
    name: (names && (names[g.after] || names[String(g.after)]) || '').trim() || `Перерва ${g.mins} хв`
  }));
}

// Найбільший номер уроку в слоті — саме після нього ставиться перерва
export function slotLessonNumber(slot){
  const items = Array.isArray(slot) ? slot : (slot && slot.subject ? [slot] : []);
  let max = null;
  items.forEach(it => {
    if(!it || isBreakItem(it)) return;
    const n = parseInt(it.number, 10);
    if(!isNaN(n)) max = (max === null) ? n : Math.max(max, n);
  });
  return max;
}

// Чи слот складається лише з перерв
export function isBreakSlot(slot){
  const items = Array.isArray(slot) ? slot : (slot && slot.subject ? [slot] : []);
  return items.length > 0 && items.every(it => isBreakItem(it));
}

// Розставити перерви в одному дні. Наявні перерви прибираємо, щоб
// повторне застосування давало той самий результат, а не подвоєння.
export function applyBreakPlan(day, plan){
  const src = (day || []).filter(slot => !isBreakSlot(slot));
  const out = [];
  src.forEach(slot => {
    out.push(slot);
    const n = slotLessonNumber(slot);
    if(n === null) return;
    const b = plan.find(p => p.after === n);
    if(b) out.push([ makeBreak(`${b.start} - ${b.end}`, b.name) ]);
  });
  // Перерва в самому кінці дня безглузда: після неї нічого немає
  while(out.length && isBreakSlot(out[out.length - 1])) out.pop();
  return out;
}

// Скільки перерв додасться і скільки зникне — для чесного попередження
export function planDiff(lessons, plan){
  let added = 0, removed = 0, days = 0;
  DAYS.forEach(day => {
    const raw = (lessons || {})[day];
    if(!raw) return;
    const cur = Array.isArray(raw) ? raw : Object.values(raw);
    const before = cur.filter(isBreakSlot).length;
    const after = applyBreakPlan(cur, plan).filter(isBreakSlot).length;
    if(before !== after) days++;
    added += Math.max(0, after - before);
    removed += Math.max(0, before - after);
  });
  return { added, removed, days };
}

// ══════════════════════════════════════════════════════════════════
//  ІНТЕРФЕЙС
// ══════════════════════════════════════════════════════════════════
function isDir(){ return DIR_ROLES.includes(currentUserData && currentUserData.role); }
let state = { cls: null, bells: {}, names: {} };

window.openBreaksCard = async function(){
  const sel = document.getElementById('bk-class');
  if(!sel || !isDir()) return;
  if(!sel.options.length)
    sel.innerHTML = CLASSES.map((c, i) => `<option value="${c}">${i + 1} клас</option>`).join('');
  await fillBreakDest();
  renderBreaksCard();
};

async function fillBreakDest(){
  const sel = document.getElementById('bk-dest');
  if(!sel) return;
  let drafts = [];
  try{
    const snap = await get(child(ref(db), 'schedule_drafts'));
    if(snap.exists()) drafts = Object.keys(snap.val() || {});
  }catch(e){ console.warn('schedule_drafts:', e.message); }
  sel.innerHTML = '<option value="live">Чинний розклад школи</option>'
    + drafts.map(d => `<option value="${escHtml(d)}">Чернетка «${escHtml(d)}»</option>`).join('');
}

window.renderBreaksCard = async function(){
  const box = document.getElementById('bk-body');
  const cls = document.getElementById('bk-class').value;
  if(!box) return;
  state.cls = cls;
  box.innerHTML = '<p class="empty-msg">Завантажую...</p>';
  try{
    const [b, n] = await Promise.all([
      get(child(ref(db), `bell_schedules/${cls}`)),
      get(child(ref(db), `break_names/${cls}`))
    ]);
    state.bells = b.exists() ? b.val() : {};
    state.names = n.exists() ? n.val() : {};
  }catch(e){
    box.innerHTML = `<p class="empty-msg" style="color:var(--red);">${escHtml(e.message)}</p>`;
    return;
  }

  const plan = breakPlan(state.bells, state.names);
  if(!plan.length){
    box.innerHTML = `<div class="bk-warn">У цього класу немає проміжків між уроками.<br>
      Перерви беруться з <b>розкладу дзвінків</b>: спершу заповніть його вище, і проміжки зʼявляться тут самі.</div>`;
    return;
  }

  box.innerHTML = `
    <div class="bk-list">
      ${plan.map(p => `
        <div class="bk-row">
          <div class="bk-when">після ${p.after} уроку<span>${escHtml(p.start)} – ${escHtml(p.end)} · ${p.mins} хв</span></div>
          <input type="text" value="${escHtml((state.names[p.after] || state.names[String(p.after)] || ''))}"
                 placeholder="${escHtml(`Перерва ${p.mins} хв`)}"
                 onchange="setBreakName(${p.after}, this.value)">
        </div>`).join('')}
    </div>
    <div class="bk-hint">Назва необовʼязкова. Порожнє поле — портал підпише перерву за тривалістю.</div>
    <button type="button" class="bk-apply" onclick="applyBreaksToClass()">
      ⏱ Розставити ці перерви в усі дні класу</button>
    <button type="button" class="bk-copy" onclick="openBreakCopy()">
      📋 Скопіювати дзвінки й назви в інші класи</button>
    <div id="bk-copy-box"></div>`;
};

window.setBreakName = async function(after, value){
  const name = (value || '').trim().slice(0, 60);
  try{
    if(name) await update(ref(db, `break_names/${state.cls}`), { [after]: name });
    else     await remove(ref(db, `break_names/${state.cls}/${after}`));
    if(name) state.names[after] = name; else delete state.names[after];
    showToast('✅ Назву збережено');
  }catch(e){ alert('Не вдалося зберегти назву: ' + e.message); }
};

window.applyBreaksToClass = async function(){
  const cls = state.cls;
  const dest = document.getElementById('bk-dest').value;
  const base = dest === 'live' ? `schedules/${cls}` : `schedule_drafts/${dest}/${cls}`;
  const plan = breakPlan(state.bells, state.names);
  let lessons = {};
  try{
    const snap = await get(child(ref(db), `${base}/lessons`));
    lessons = snap.exists() ? (snap.val() || {}) : {};
  }catch(e){ return alert('Не вдалося прочитати розклад: ' + e.message); }
  if(!Object.keys(lessons).length)
    return alert('У цього класу ще немає розкладу — нема куди вставляти перерви.');

  const d = planDiff(lessons, plan);
  if(!d.added && !d.removed)
    return alert('Нічого не зміниться: перерви вже стоять саме так.');
  if(!confirm(`Клас ${cls.replace('class_','')}, ${dest === 'live' ? 'ЧИННИЙ розклад' : `чернетка «${dest}»`}.\n\n`
    + `Днів торкнеться: ${d.days}\nПерерв додасться: ${d.added}\n`
    + (d.removed ? `Наявних перерв буде замінено: ${d.removed}\n` : '')
    + '\nПерерви, розставлені руками, буде замінено на цей набір.'
    + (dest === 'live' ? '\nЗміну одразу побачать батьки та вчителі.' : ''))) return;

  try{
    const patch = {};
    DAYS.forEach(day => {
      const raw = lessons[day];
      if(!raw) return;
      const cur = Array.isArray(raw) ? raw : Object.values(raw);
      patch[`${base}/lessons/${day}`] = applyBreakPlan(cur, plan);
    });
    await update(ref(db), patch);
    logAction('settings', { value: `перерви розставлено: ${cls}, ${dest}, +${d.added}` });
    showToast(`✅ Перерв додано: ${d.added}`);
  }catch(e){ alert('Не вдалося зберегти: ' + e.message); }
};

window.openBreakCopy = function(){
  const box = document.getElementById('bk-copy-box');
  if(!box) return;
  if(box.innerHTML){ box.innerHTML = ''; return; }
  box.innerHTML = `
    <div class="bk-copy-box">
      <div class="bk-copy-title">Скопіювати з ${state.cls.replace('class_','')} класу в:</div>
      <div class="bk-copy-classes">
        ${CLASSES.filter(c => c !== state.cls).map(c => `
          <label><input type="checkbox" value="${c}"> ${c.replace('class_','')} кл.</label>`).join('')}
      </div>
      <div class="bk-warn small">Скопіюються <b>розклад дзвінків і назви перерв</b>. Розклад уроків цих класів
        не змінюється — щоб перерви там зʼявилися, оберіть потрібний клас і натисніть «Розставити».</div>
      <button type="button" onclick="doBreakCopy()">Скопіювати</button>
    </div>`;
};

window.doBreakCopy = async function(){
  const box = document.getElementById('bk-copy-box');
  const picked = [...box.querySelectorAll('input[type=checkbox]:checked')].map(i => i.value);
  if(!picked.length) return alert('Оберіть хоча б один клас.');
  if(!Object.keys(state.bells).length)
    return alert('У цього класу немає розкладу дзвінків — копіювати нічого.');
  // Називаємо класи поіменно. Раніше тут стояла кількість — «у 1 кл.» —
  // і це читалося як «у 1 клас», тобто повідомлення казало протилежне тому,
  // що робила кнопка.
  const names = picked.map(c => c.replace('class_','')).join(', ');
  if(!confirm(`Скопіювати з ${state.cls.replace('class_','')} класу в ${picked.length === 1 ? 'клас' : 'класи'}: ${names}?\n\n`
    + 'Копіюються розклад дзвінків і назви перерв.\n'
    + `Наявні дзвінки ${picked.length === 1 ? 'цього класу' : 'цих класів'} буде замінено.`)) return;
  // ДЗВІНКИ Й НАЗВИ ПИШЕМО ОКРЕМО, А НЕ ОДНИМ update().
  // Спільний запис був атомарний: якщо правила для нового вузла break_names
  // ще не опубліковані, база відхиляла всю операцію — і разом із назвами
  // не доїжджали дзвінки. Ззовні це виглядало так, ніби кнопка не працює.
  // Дзвінки важливіші, тож вони йдуть першими й окремо.
  const failed = [];
  let bellsOk = 0, namesOk = 0;
  const hasNames = Object.keys(state.names).length > 0;

  for(const c of picked){
    try{
      await set(ref(db, `bell_schedules/${c}`), state.bells);
      bellsOk++;
    }catch(e){ failed.push(`дзвінки в ${c.replace('class_','')} кл.: ${e.message}`); continue; }
    if(!hasNames){ try{ await remove(ref(db, `break_names/${c}`)); }catch(e){} continue; }
    try{
      await set(ref(db, `break_names/${c}`), state.names);
      namesOk++;
    }catch(e){ failed.push(`назви перерв у ${c.replace('class_','')} кл.: ${e.message}`); }
  }

  // Перевіряємо читанням: інакше повідомлення «скопійовано» — це віра,
  // а не факт. Цю кнопку вже одного разу вважали робочою даремно.
  let verified = 0;
  for(const c of picked){
    try{
      const chk = await get(child(ref(db), `bell_schedules/${c}`));
      if(chk.exists() && Object.keys(chk.val() || {}).length) verified++;
    }catch(e){}
  }

  if(!bellsOk){
    alert('Скопіювати не вдалося — жоден клас не змінено.\n\n'
      + failed.join('\n')
      + '\n\nНайімовірніша причина: у базі ще не опубліковано нові правила '
      + '(database.rules.json). Без них запис у нові вузли заборонено.');
    return;
  }

  logAction('bell_apply', { value: `дзвінки й перерви з ${state.cls} → ${picked.join(', ')}` });
  if(failed.length){
    alert(`Дзвінки скопійовано в ${verified} кл., але не все пройшло:\n\n${failed.join('\n')}`
      + '\n\nНазви перерв не зберігаються, поки не опубліковано нові правила бази. '
      + 'Час перерв від цього не залежить — він береться з дзвінків.');
  }else{
    showToast(`✅ Скопійовано в ${picked.length === 1 ? 'клас' : 'класи'} ${names}`
      + (verified === picked.length ? '' : ` (підтверджено ${verified})`));
  }
  box.innerHTML = '';
};
