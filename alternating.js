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
// ЩО ПИШЕМО. schedule_alt/{клас}/{понеділок}/{День}/{слот} = 'Назва'.
// Ключ — понеділок того тижня, тому минулі тижні лишаються в історії,
// а не перезаписуються.
// ═══════════════════════════════════════════════════════════════
import { ref, set, get, child, remove } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, currentUserData, getActiveClass, teacherAccessMatrix, showToast,
         escHtml, escJs, mondayOf, altOptions, logAction } from './common.js';

export const ALT_BUILD = '2026-09-02 · alt v1';

const DIR_ROLES  = ['director', 'administrator'];
const TEACH_ROLES = ['teacher', 'class_teacher', 'art_school_teacher', 'music_teacher'];
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

// Чи може ця людина міняти вибір для такого уроку
export function canSetAlt(options, role, matrix, cls, isClassTeacher){
  if(DIR_ROLES.includes(role)) return true;
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

function slotEl(){
  return document.getElementById('alt-slot-dir') || document.getElementById('alt-slot-teacher');
}

window.openAltCard = async function(){
  const box = slotEl();
  if(!box) return;
  const role = currentUserData && currentUserData.role;
  if(!DIR_ROLES.includes(role) && !TEACH_ROLES.includes(role)){ box.innerHTML = ''; return; }

  box.innerHTML = '<p class="empty-msg">Завантажую...</p>';
  const cls = altState.cls || getActiveClass();
  altState.cls = cls;

  try{
    const [schedSnap, ctSnap] = await Promise.all([
      get(child(ref(db), `schedules/${cls}`)),
      get(child(ref(db), `class_teachers/${cls}`))
    ]);
    altState.lessons = schedSnap.exists() ? (schedSnap.val().lessons || {}) : {};
    altState.isCT = ctSnap.exists() && ctSnap.val().teacherEmail === (currentUserData && currentUserData.email);
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

  if(!list.length){
    box.innerHTML = picker
      + '<p class="empty-msg">У розкладі цього класу немає уроків, що чергуються.<br>'
      + 'Такі уроки зʼявляються, коли в клітинці розкладу два предмети через косу риску.</p>';
    return;
  }

  let html = picker;
  altState.weeks.forEach((w, wi) => {
    html += `<div class="alt-week"><div class="alt-week-head">${wi === 0 ? 'Цей тиждень' : 'Наступний тиждень'}
      <span>${escHtml(weekLabel(w))}</span></div>`;
    list.forEach(L => {
      const may = canSetAlt(L.options, role, teacherAccessMatrix, altState.cls, altState.isCT);
      const cur = ((altState.chosen[w] || {})[L.day] || {})[L.slot]
               || ((altState.chosen[w] || {})[L.day] || {})[String(L.slot)] || '';
      html += `<div class="alt-row">
        <div class="alt-when">${escHtml(DAY_UA[L.day] || L.day)}<span>урок ${escHtml(String(L.number))}${L.time ? ' · ' + escHtml(L.time) : ''}</span></div>
        <div class="alt-opts">
          ${L.options.map(o => `<button type="button" class="alt-opt${o === cur ? ' on' : ''}"
              ${may ? '' : 'disabled'}
              onclick="setAltChoice('${escJs(w)}','${escJs(L.day)}',${L.slot},'${escJs(o)}')">${escHtml(o)}</button>`).join('')}
          ${cur && may ? `<button type="button" class="alt-clear"
              onclick="setAltChoice('${escJs(w)}','${escJs(L.day)}',${L.slot},'')" title="Прибрати вибір">×</button>` : ''}
        </div>
        ${cur ? '' : `<div class="alt-none">${may ? 'не позначено — батьки бачать обидві назви' : 'позначає вчитель цього предмета'}</div>`}
      </div>`;
    });
    html += '</div>';
  });
  box.innerHTML = html;
}

window.changeAltClass = function(cls){
  altState.cls = cls;
  openAltCard();
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
