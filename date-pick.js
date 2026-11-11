// ДАТА ДЛЯ КОНКРЕТНОГО МІСЦЯ, А НЕ ДЛЯ ВСЬОГО КАБІНЕТУ.
//
// Раніше одне поле «Оберіть дату» над кабінетом керувало всім одразу:
// батько гортав учорашнє меню — і заодно повідомлення про запізнення
// йшло на вчора. Тепер у кожного місця своя дата («сфера», scope):
// 'day' — екран «Сьогодні» родини, далі — свої сфери в учителя й директора.
//
// Модуль нічого не імпортує, щоб його могли підключати будь-які модулі
// (і common.js теж) без циклічних залежностей.
//
// Поки дату не чіпали, сфера зберігає «нічого» і повертає сьогодні —
// тож опівночі вона сама переходить на нову добу.

const vals = Object.create(null);
const subs = Object.create(null);
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const DOW = ['нд','пн','вт','ср','чт','пт','сб'];

export function todayISO(){
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function shiftISO(iso, n){
  const [y, m, d] = String(iso).split('-').map(Number);
  const dt = new Date(y, m - 1, d + n), p = k => String(k).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}
export function pickedDate(scope){ return vals[scope] || todayISO(); }
export function isPickedToday(scope){ return pickedDate(scope) === todayISO(); }

// «Сьогодні», «Завтра», «Вчора» або «пт, 07.11»
export function dayLabel(iso){
  const t = todayISO();
  if(iso === t) return 'Сьогодні';
  if(iso === shiftISO(t, 1)) return 'Завтра';
  if(iso === shiftISO(t, -1)) return 'Вчора';
  const [y, m, d] = iso.split('-').map(Number);
  return `${DOW[new Date(y, m - 1, d).getDay()]}, ${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}`;
}

function paint(scope){
  if(typeof document === 'undefined') return;
  const v = pickedDate(scope), today = v === todayISO();
  document.querySelectorAll(`[data-dp="${scope}"]`).forEach(bar => {
    const txt = bar.querySelector('.dp-txt'); if(txt) txt.textContent = dayLabel(v);
    const inp = bar.querySelector('.dp-in'); if(inp) inp.value = v;
    const back = bar.querySelector('.dp-today'); if(back) back.hidden = today;
    bar.classList.toggle('dp-other', !today);
  });
}

// silent — лише запамʼятати й перемалювати поле, без перезавантаження
// блоків (коли дату ставить сам код, що й так усе перемалює).
export function setPickedDate(scope, v, opts = {}){
  v = v || '';
  if(v && !ISO.test(v)) return;
  const next = (!v || v === todayISO()) ? '' : v;
  const changed = (vals[scope] || '') !== next;
  if(next) vals[scope] = next; else delete vals[scope];
  paint(scope);
  if(changed && !opts.silent) (subs[scope] || []).forEach(fn => { try{ fn(pickedDate(scope)); }catch(e){ console.error(e); } });
}
export function shiftPicked(scope, n){ setPickedDate(scope, shiftISO(pickedDate(scope), n)); }
export function onDatePick(scope, fn){ (subs[scope] = subs[scope] || []).push(fn); }
export function repaintDatePick(scope){ paint(scope); }

// Розмітка: ‹ [Сьогодні] › і кнопка повернення на сьогодні.
// Поле type=date лежить прозорим поверх підпису — тап відкриває
// системний календар телефона.
export function datePickHtml(scope, aria = 'Дата'){
  const s = String(scope).replace(/[^\w-]/g, '');
  return `<div class="dp-bar" data-dp="${s}" role="group" aria-label="${aria}">`
    + `<button type="button" class="dp-arrow" onclick="dpShift('${s}',-1)" aria-label="Попередній день">‹</button>`
    + `<label class="dp-mid">📅 <span class="dp-txt">Сьогодні</span>`
    // showPicker: на компʼютері клік по полю дати сам календар не відкриває —
    // без цього тап по «Сьогодні» в Chrome/Edge нічого видимого не робив
    + `<input type="date" class="dp-in" onclick="try{this.showPicker()}catch(e){}" onchange="dpSet('${s}',this.value)" aria-label="${aria}"></label>`
    + `<button type="button" class="dp-arrow" onclick="dpShift('${s}',1)" aria-label="Наступний день">›</button>`
    + `<button type="button" class="dp-today" onclick="dpSet('${s}','')" hidden>до сьогодні</button>`
    + `</div>`;
}
// Вставити смужку в усі контейнери [data-dp-mount="scope"]
export function mountDatePicks(root){
  if(typeof document === 'undefined') return;
  const scopes = new Set();
  (root || document).querySelectorAll('[data-dp-mount]').forEach(el => {
    scopes.add(el.dataset.dpMount);
    if(el.dataset.dpDone) return;
    el.dataset.dpDone = '1';
    el.innerHTML = datePickHtml(el.dataset.dpMount, el.dataset.dpAria || 'Дата');
  });
  // Перемальовуємо й уже вставлені: після півночі «Сьогодні» має стати
  // «Вчора», а незачеплене поле — показати нову добу
  scopes.forEach(paint);
}

if(typeof window !== 'undefined'){
  window.dpShift = shiftPicked;
  window.dpSet = (s, v) => setPickedDate(s, v);
  window.pickedDate = pickedDate;
  window.setPickedDate = setPickedDate;
  window.mountDatePicks = mountDatePicks;
}
