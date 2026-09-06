// ═══════════════════════════════════════════════════════════════
// alternating.js — картка «Чергування уроків».
//
// НАВІЩО. У розкладі бувають клітинки «Музичне мистецтво / Фізичне
// виховання»: один тиждень одне, другий тиждень інше. Батькам це
// потрібно знати заздалегідь — щоб покласти в рюкзак форму або флейту.
// Тому хтось із персоналу раз на тиждень позначає, що саме буде.
//
// ЧОМУ ВРУЧНУ, А НЕ ПО ПАРНОСТІ ТИЖНЯ. Канікули, святкові дні й
// перенесення збивають будь-яку арифметику. Автомат тоді впевнено
// показував би неправду, а це гірше за чесне «уточнюється».
//
// ХТО МОЖЕ. Учитель предмета, класний керівник, директор. Те саме
// перевіряють і правила бази — інтерфейс лише не показує зайвого.
//
// ЩО ПИШЕМО. schedule_alt/{клас}/{понеділок}/pairs/{пара} = 'Назва'.
// Ключ тижня — понеділок, тому минулі тижні лишаються в історії. Ключ
// усередині тижня — сама пара предметів, а не номер уроку: номери
// зсуваються від будь-якої правки розкладу (найчастіше — від вставлених
// перерв), і прив'язаний до них вибір переставав збігатися з уроком.
// Старий формат {День}/{слот} читається як запасний — див. groupChoice.
//
// ТУТ ЖЕ КЛАСНА ГОДИНА (у кінці файлу): та сама задача — сказати класу,
// що і коли в нього стоїть, і той самий власник — класний керівник.
// ═══════════════════════════════════════════════════════════════
import { ref, set, get, child, remove, update } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, currentUserData, getActiveClass, teacherAccessMatrix, showToast,
         escHtml, escJs, mondayOf, altOptions, altPairKey, resolveAlt,
         freeBellSlots, logAction } from './common.js';

export const ALT_BUILD = '2026-09-05 · alt v3 (пари предметів, правильний екран)';

const DIR_ROLES  = ['director', 'administrator'];
const TEACH_ROLES = ['teacher', 'class_teacher', 'art_school_teacher', 'music_teacher', 'master_class_teacher'];
const DAY_UA = { Monday:'Понеділок', Tuesday:'Вівторок', Wednesday:'Середа',
                 Thursday:'Четвер', Friday:'Пʼятниця', Saturday:'Субота' };
const DAY_ORDER = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

// ── Чиста логіка (перевіряється тестами) ─────────────────────────

// Понеділок наступного тижня від заданого понеділка
export function nextMonday(week){
  const [y, m, d] = String(week).split('-').map(Number);
  const dt = new Date(y, m - 1, d + 7);
  const p2 = n => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p2(dt.getMonth() + 1)}-${p2(dt.getDate())}`;
}

// «2026-09-07» → «7 вер.» (для заголовка тижня)
const MON_SHORT = ['січ.','лют.','бер.','квіт.','трав.','черв.','лип.','серп.','вер.','жовт.','лист.','груд.'];
export function weekLabel(week){
  const [y, m, d] = String(week).split('-').map(Number);
  if(!y || !m || !d) return week;
  const end = new Date(y, m - 1, d + 4);      // понеділок + 4 = пʼятниця
  return `${d} ${MON_SHORT[m-1]} – ${end.getDate()} ${MON_SHORT[end.getMonth()]}`;
}

// Усі уроки розкладу, що чергуються → [{day, slot, options, number, time}]
export function altLessons(lessons){
  const out = [];
  DAY_ORDER.forEach(day => {
    const raw = (lessons || {})[day];
    if(!raw) return;
    const slots = Array.isArray(raw) ? raw : Object.values(raw);
    slots.forEach((slot, slotIdx) => {
      const items = Array.isArray(slot) ? slot : (slot && slot.subject ? [slot] : []);
      items.forEach(l => {
        const opts = altOptions(l);
        if(opts) out.push({ day, slot: slotIdx, options: opts,
                            number: l.number || slotIdx + 1, time: l.time || '' });
      });
    });
  });
  return out;
}

// Уроки, що чергуються, згруповані за ПАРОЮ предметів.
//
// ЧОМУ ГРУПА, А НЕ ОКРЕМИЙ УРОК. «Музичне / Фізичне» стоїть у тижні
// кілька разів, і в межах тижня це завжди той самий предмет — не буває
// так, що в понеділок музика, а в четвер того ж тижня фізкультура.
// Позначати кожен урок окремо означало б робити ту саму дію двічі й
// мати шанс помилитися. Одна пара — одне натискання на тиждень.
export function altGroups(lessons){
  const byPair = new Map();
  altLessons(lessons).forEach(L => {
    const key = L.options.join(' / ');
    if(!byPair.has(key)) byPair.set(key, { key, options: L.options, slots: [] });
    byPair.get(key).slots.push({ day: L.day, slot: L.slot, number: L.number, time: L.time });
  });
  return [...byPair.values()];
}

// Що обрано для цієї групи в цьому тижні: назва, '' або 'mixed',
// якщо старі записи по слотах чомусь розійшлися.
//
// Спершу дивимось новий ключ — саму пару. Він не залежить від позиції
// уроку в дні, тож переставлений розклад чи вставлена перерва його не
// збивають. Старі записи по слотах читаємо далі, щоб уже позначені
// школою тижні не зникли.
export function groupChoice(group, weekData){
  const byPair = weekData && weekData.pairs
    && weekData.pairs[altPairKey(group.options)];
  if(byPair) return byPair;
  const vals = group.slots.map(sl => {
    const d = (weekData || {})[sl.day] || {};
    return d[sl.slot] || d[String(sl.slot)] || '';
  });
  const uniq = [...new Set(vals)];
  if(uniq.length === 1) return uniq[0];
  return uniq.some(Boolean) ? 'mixed' : '';
}

// Короткий підпис, де саме ця пара стоїть у тижні
export function slotsLabel(group, dayNames){
  return group.slots
    .map(sl => `${(dayNames || {})[sl.day] || sl.day} ${sl.number} ур.`)
    .join(' · ');
}

// Чи може ця людина міняти вибір для такого уроку
export function canSetAlt(options, role, matrix, cls, isClassTeacher){
  if(DIR_ROLES.includes(role)) return true;
  if(role === 'master_class_teacher') return true;   // роль для налагодження
  if(isClassTeacher) return true;
  if(!TEACH_ROLES.includes(role)) return false;
  const raw = (matrix || {})[cls];
  if(!raw) return false;
  const mine = (Array.isArray(raw) ? raw : Object.values(raw))
    .map(s => typeof s === 'string' ? s.trim().toLowerCase() : '')
    .filter(Boolean);
  if(mine.includes('всі предмети')) return true;
  return options.some(o => mine.includes(o.trim().toLowerCase()));
}

// ── Інтерфейс ────────────────────────────────────────────────────

let altState = { cls: null, weeks: [], lessons: {}, chosen: {}, isCT: false };

// З двох можливих місць вибираємо ВИДИМЕ.
//
// ЧОМУ ЦЕ ВАЖЛИВО. Картка стоїть і в кабінеті директора, і в кабінеті
// вчителя. Обидва елементи завжди присутні в документі — екран іншої ролі
// лише прихований, а не видалений. Попередній варіант брав перший
// знайдений, тобто ЗАВЖДИ директорський. Тому у вчителя картка лишалася
// порожньою, хоч би що ми виправляли в логіці чергування.
export function pickVisible(els){
  const list = (els || []).filter(Boolean);
  // offsetParent === null означає, що елемент або його предок прихований
  return list.find(el => el.offsetParent !== null) || list[0] || null;
}

function slotEl(){
  return pickVisible([
    document.getElementById('alt-slot-teacher'),
    document.getElementById('alt-slot-dir')
  ]);
}

window.openAltCard = async function(){
  const box = slotEl();
  if(!box) return;
  const role = currentUserData && currentUserData.role;
  if(!DIR_ROLES.includes(role) && !TEACH_ROLES.includes(role)){ box.innerHTML = ''; return; }

  box.innerHTML = '<p class="empty-msg">Завантажую...</p>';
  // ЧИЙ КЛАС ПОКАЗУЄМО. У директора є власний список класів усередині
  // картки, тож його вибір запам'ятовуємо. У вчителя такого списку немає —
  // клас задає селектор кабінету, і картка мусить іти за ним. Раніше клас
  // запам'ятовувався при першому відкритті й більше не оновлювався: учитель
  // перемикався на 3 клас, а картка й далі шукала уроки в першому.
  const cls = DIR_ROLES.includes(role) ? (altState.cls || getActiveClass()) : getActiveClass();
  altState.cls = cls;

  try{
    const [schedSnap, ctSnap] = await Promise.all([
      get(child(ref(db), `schedules/${cls}`)),
      get(child(ref(db), `class_teachers/${cls}`))
    ]);
    altState.lessons = schedSnap.exists() ? (schedSnap.val().lessons || {}) : {};
    altState.isCT = role === 'master_class_teacher'
      || (ctSnap.exists() && ctSnap.val().teacherEmail === (currentUserData && currentUserData.email));
  }catch(e){
    box.innerHTML = `<p class="empty-msg" style="color:var(--red);">Не вдалося прочитати розклад: ${escHtml(e.message)}</p>`;
    return;
  }

  const thisWeek = mondayOf(new Date());
  altState.weeks = [thisWeek, nextMonday(thisWeek)];
  altState.chosen = {};
  await Promise.all(altState.weeks.map(async w => {
    try{
      const s = await get(child(ref(db), `schedule_alt/${cls}/${w}`));
      altState.chosen[w] = s.exists() ? s.val() : {};
    }catch(e){ altState.chosen[w] = {}; }
  }));

  renderAltCard();
};

// Що з цього вибору вийде в кабінеті батьків.
//
// НАВІЩО ПОКАЗУВАТИ. Учитель натискав кнопку, бачив «✅ збережено» — і не
// мав жодного способу дізнатися, що батькам усе одно показуються обидві
// назви. Розбіжність між «записано» і «показано» коштувала цілого раунду
// листування. Тепер картка проганяє збережене значення через ту саму
// функцію, що й кабінет батьків, і пише результат просто в рядку.
function parentSees(group, chosen){
  const item = { subject: { ua: group.options.join(' / ') } };
  const r = resolveAlt(item, chosen);
  return r._altPending ? 'обидві назви через косу' : (r.subject && r.subject.ua) || '';
}

function renderAltCard(){
  const box = slotEl();
  if(!box) return;
  const role = currentUserData && currentUserData.role;
  const list = altLessons(altState.lessons);
  const clsNum = String(altState.cls || '').replace('class_', '');

  const picker = DIR_ROLES.includes(role)
    ? `<label style="font-size:.8rem;color:#4527a0;font-weight:600;">Клас:</label>
       <select id="alt-class" onchange="changeAltClass(this.value)" style="margin-top:4px;">
         ${Array.from({length:11}, (_,i)=>`<option value="class_${i+1}"${altState.cls===`class_${i+1}`?' selected':''}>${i+1} клас</option>`).join('')}
       </select>`
    : `<div style="font-size:.8rem;color:#4527a0;font-weight:600;margin-bottom:8px;">${escHtml(clsNum)} клас</div>`;
  // Підпис класу береться з altState.cls — того самого, з якого читали розклад

  if(!list.length){
    box.innerHTML = picker
      + '<p class="empty-msg">У розкладі цього класу немає уроків, що чергуються.<br>'
      + 'Портал вважає урок таким, коли в назві предмета стоять дві назви через '
      + 'косу риску з пробілами: <b>Музичне мистецтво / Фізичне виховання</b>.</p>';
    return;
  }

  const groups = altGroups(altState.lessons);
  let html = picker;
  altState.weeks.forEach((w, wi) => {
    html += `<div class="alt-week"><div class="alt-week-head">${wi === 0 ? 'Цей тиждень' : 'Наступний тиждень'}
      <span>${escHtml(weekLabel(w))}</span></div>`;
    groups.forEach((G, gi) => {
      const may = canSetAlt(G.options, role, teacherAccessMatrix, altState.cls, altState.isCT);
      const cur = groupChoice(G, altState.chosen[w]);
      html += `<div class="alt-row">
        <div class="alt-when">${escHtml(G.options.join(' / '))}
          <span>${escHtml(slotsLabel(G, DAY_UA))}</span></div>
        <div class="alt-opts">
          ${G.options.map(o => `<button type="button" class="alt-opt${o === cur ? ' on' : ''}"
              ${may ? '' : 'disabled'}
              onclick="setAltGroup('${escJs(w)}',${gi},'${escJs(o)}')">${escHtml(o)}</button>`).join('')}
          ${cur && may ? `<button type="button" class="alt-clear"
              onclick="setAltGroup('${escJs(w)}',${gi},'')" title="Прибрати вибір">×</button>` : ''}
        </div>
        ${cur === 'mixed'
          ? '<div class="alt-none">у різних днях позначено по-різному — оберіть заново</div>'
          : (cur ? `<div class="alt-seen">батьки бачать: <b>${escHtml(parentSees(G, cur))}</b></div>`
                 : `<div class="alt-none">${may ? 'не позначено — батьки бачать обидві назви' : 'позначає вчитель цього предмета'}</div>`)}
      </div>`;
    });
    html += '</div>';
  });
  html += `<div class="alt-build">версія модуля: ${escHtml(ALT_BUILD)}</div>`;
  box.innerHTML = html;
}

window.changeAltClass = function(cls){
  altState.cls = cls;
  openAltCard();
};

// Одне натискання — усі уроки цієї пари в цьому тижні
window.setAltGroup = async function(week, groupIdx, name){
  const G = altGroups(altState.lessons)[groupIdx];
  if(!G) return;
  const cls = altState.cls;
  const key = altPairKey(G.options);
  try{
    // Пишемо за парою — і ОДРАЗУ прибираємо старі записи по слотах для
    // цих самих уроків. Інакше в базі лишилися б два джерела правди, і
    // перше ж переставлення розкладу зробило б їх суперечливими.
    const patch = { [`schedule_alt/${cls}/${week}/pairs/${key}`]: name || null };
    G.slots.forEach(sl => {
      patch[`schedule_alt/${cls}/${week}/${sl.day}/${sl.slot}`] = null;
    });
    await update(ref(db), patch);
    const wk = altState.chosen[week] = altState.chosen[week] || {};
    wk.pairs = wk.pairs || {};
    if(name) wk.pairs[key] = name; else delete wk.pairs[key];
    G.slots.forEach(sl => { if(wk[sl.day]) delete wk[sl.day][sl.slot]; });
    renderAltCard();
    showToast(name ? `✅ ${name} — уроків: ${G.slots.length}` : '✅ Вибір прибрано');
    logAction('settings', { value: `чергування ${cls} ${week}: ${G.key} → ${name || 'знято'}` });
  }catch(e){
    alert('Не вдалося зберегти: ' + e.message
      + '\n\nПозначати може вчитель цього предмета, класний керівник або директор.'
      + '\n\nЯкщо тут «PERMISSION_DENIED» навіть у директора — у базі ще не '
      + 'опубліковано нові правила (database.rules.json): вузол schedule_alt новий.');
  }
};

window.setAltChoice = async function(week, day, slot, name){
  const cls = altState.cls;
  const path = `schedule_alt/${cls}/${week}/${day}/${slot}`;
  try{
    if(name) await set(ref(db, path), name);
    else     await remove(ref(db, path));
    altState.chosen[week] = altState.chosen[week] || {};
    altState.chosen[week][day] = altState.chosen[week][day] || {};
    if(name) altState.chosen[week][day][slot] = name;
    else     delete altState.chosen[week][day][slot];
    renderAltCard();
    showToast(name ? `✅ ${name}` : '✅ Вибір прибрано');
    logAction('settings', { value: `чергування ${cls} ${day} слот ${slot} на ${week}: ${name || 'знято'}` });
  }catch(e){
    alert('Не вдалося зберегти: ' + e.message
      + '\n\nПозначати може вчитель цього предмета, класний керівник або директор.'
      + '\n\nЯкщо тут «PERMISSION_DENIED» навіть у директора — у базі ще не '
      + 'опубліковано нові правила (database.rules.json): вузол schedule_alt новий.');
  }
};

// ══════════════════════════════════════════════════════════════════
//  КЛАСНА ГОДИНА
// ══════════════════════════════════════════════════════════════════
// Один рядок: день + вільний час. Тут же, поруч із чергуванням, бо це
// та сама задача — сказати класу, що і коли в нього стоїть.
//
// ХТО МОЖЕ: класний керівник свого класу, директор, майстер-роль. Учитель
// -предметник бачить, але не міняє: це справа класу, а не предмета.
//
// ЧОМУ ЧАС ЛИШЕ З ДЗВІНКІВ. Вільний ввід дав би «14.00», «14:0», «о 14»
// і час, якого в школі не буває. А головне — класна година могла б стати
// поверх уроку, і ніхто б не помітив, поки клас не прийшов би на два
// заняття одразу.

let chState = { cls:null, bells:{}, lessons:{}, hour:null, may:false, day:'Monday' };

window.openClassHourCard = async function(){
  const box = document.getElementById('chour-slot');
  if(!box) return;
  box.innerHTML = '<p class="empty-msg">Завантажую...</p>';
  const role = currentUserData && currentUserData.role;
  const cls = getActiveClass();
  chState.cls = cls;
  try{
    const [schedSnap, bellSnap, ctSnap, hourSnap] = await Promise.all([
      get(child(ref(db), `schedules/${cls}`)),
      get(child(ref(db), `bell_schedules/${cls}`)),
      get(child(ref(db), `class_teachers/${cls}`)),
      get(child(ref(db), `class_hour/${cls}`)).catch(() => null)
    ]);
    chState.lessons = schedSnap.exists() ? (schedSnap.val().lessons || {}) : {};
    chState.bells   = bellSnap.exists() ? bellSnap.val() : {};
    chState.hour    = (hourSnap && hourSnap.exists()) ? hourSnap.val() : null;
    const isCT = role === 'master_class_teacher'
      || (ctSnap.exists() && ctSnap.val().teacherEmail === (currentUserData && currentUserData.email));
    chState.may = DIR_ROLES.includes(role) || isCT;
    if(chState.hour && chState.hour.day) chState.day = chState.hour.day;
  }catch(e){
    box.innerHTML = `<p class="empty-msg" style="color:var(--red);">Не вдалося прочитати: ${escHtml(e.message)}</p>`;
    return;
  }
  renderClassHourCard();
};

function renderClassHourCard(){
  const box = document.getElementById('chour-slot');
  if(!box) return;
  const H = chState.hour;
  const cur = H && H.time
    ? `<div class="ch-cur">Зараз: <b>${escHtml(DAY_UA[H.day] || H.day)}, ${escHtml(H.time)}</b>`
      + (H.number ? ` <span>(${escHtml(String(H.number))} урок)</span>` : '') + '</div>'
    : '<div class="ch-cur ch-none">Класну годину ще не поставлено</div>';

  if(!chState.may){
    box.innerHTML = cur + '<p class="empty-msg">Ставить класний керівник цього класу.</p>';
    return;
  }

  const free = freeBellSlots(chState.bells, (chState.lessons || {})[chState.day]);
  const days = DAY_ORDER.map(d =>
    `<option value="${d}"${d === chState.day ? ' selected' : ''}>${DAY_UA[d]}</option>`).join('');
  const times = free.length
    ? free.map(sl => {
        const t = `${sl.start} - ${sl.end}`;
        const on = H && H.day === chState.day && H.time === t;
        return `<option value="${escHtml(String(sl.number))}"${on ? ' selected' : ''}>${escHtml(t)} · ${sl.number} урок</option>`;
      }).join('')
    : '';

  box.innerHTML = cur + `<div class="ch-row">
      <select id="ch-day" onchange="changeClassHourDay(this.value)">${days}</select>
      ${free.length
        ? `<select id="ch-time">${times}</select>
           <button type="button" class="ch-save" onclick="saveClassHour()">Поставити</button>`
        : `<span class="ch-full">цього дня вільних уроків немає</span>`}
      ${H && H.time ? '<button type="button" class="ch-clear" onclick="clearClassHour()" title="Прибрати">×</button>' : ''}
    </div>`
    + (Object.keys(chState.bells || {}).length ? ''
       : '<p class="empty-msg" style="color:#ef6c00;">У цього класу не заповнено розклад дзвінків — директор задає його в кабінеті директора. Без дзвінків немає з чого обирати час.</p>');
}

window.changeClassHourDay = function(day){ chState.day = day; renderClassHourCard(); };

window.saveClassHour = async function(){
  const sel = document.getElementById('ch-time');
  if(!sel || !sel.value) return;
  const num = parseInt(sel.value, 10);
  const slot = freeBellSlots(chState.bells, (chState.lessons || {})[chState.day])
    .find(s => s.number === num);
  if(!slot) return alert('Цей час уже зайнято — оновіть картку.');
  const rec = { day: chState.day, number: num, time: `${slot.start} - ${slot.end}` };
  try{
    await set(ref(db, `class_hour/${chState.cls}`), rec);
    chState.hour = rec;
    renderClassHourCard();
    showToast(`✅ Класна година: ${DAY_UA[rec.day]}, ${rec.time}`);
    logAction('settings', { value: `класна година ${chState.cls}: ${rec.day} ${rec.time}` });
  }catch(e){
    alert('Не вдалося зберегти: ' + e.message
      + '\n\nСтавить класний керівник цього класу або директор.'
      + '\n\nЯкщо тут «PERMISSION_DENIED» навіть у директора — у базі ще не '
      + 'опубліковано нові правила (database.rules.json): вузол class_hour новий.');
  }
};

window.clearClassHour = async function(){
  if(!confirm('Прибрати класну годину з розкладу класу?')) return;
  try{
    await remove(ref(db, `class_hour/${chState.cls}`));
    chState.hour = null;
    renderClassHourCard();
    showToast('✅ Класну годину прибрано');
    logAction('settings', { value: `класна година ${chState.cls}: знято` });
  }catch(e){ alert('Не вдалося прибрати: ' + e.message); }
};
