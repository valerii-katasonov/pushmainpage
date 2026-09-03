// ═══════════════════════════════════════════════════════════════
// subjects.js — перейменування предмета по всій школі та список
// предметів класу.
//
// ЧОМУ ЦЕ НЕ ОДНЕ ПОЛЕ. Назва предмета в цій базі — ключ, а не підпис.
// «Англійська мова» — це буквально ім'я гілки, у якій лежать оцінки за
// вересень. Тому перейменувати означає перенести чотирнадцять гілок і
// переписати назву ще в шести місцях, де вона лежить значенням.
//
// ЧОМУ НЕ ПЕРЕЙШЛИ НА КОДИ ПРЕДМЕТІВ. Це було б правильніше «по-дорослому»,
// але означало б міграцію всіх живих оцінок і переписування майже кожного
// модуля. Школа вже працює на цій базі, тож ціна помилки надто висока.
// Натомість: разовий перенос + список предметів, щоб нові розбіжності
// («English» / «english» / «Англ. мова») просто не з'являлися.
//
// ЯК ЦЕ ПЕРЕВІРЕНО. Уся логіка обходу дерева — чисті функції без Firebase.
// Вони приймають зчитане піддерево й повертають перелік точкових записів.
// Саме тому їх можна ганяти тестами, і саме тому перед записом ми вміємо
// показати директору, скільки записів зміниться.
// ═══════════════════════════════════════════════════════════════
import { ref, set, get, child, update, remove } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, currentUserData, showToast, escHtml, escJs, logAction } from './common.js';
import { ACTIVE_YEAR, getAcademicYearId } from './director.js';

export const SUBJ_BUILD = '2026-09-02 · subjects v2 (каталог за роками)';

// «Безпечний» ключ: так curriculum_plans і textbooks зберігають назву.
// Крапки й дужки в ключах Firebase заборонені, тому їх колись замінили
// підкресленнями — і перейменування має рахуватися з цим.
export function safeKey(s){ return String(s || '').replace(/[.#$[\]/]/g, '_').trim(); }

// ── Де саме в базі живе назва предмета ─────────────────────────
// depth — скільки проміжних рівнів між {вузол}/{клас} і ключем предмета.
// kind:  plain  — ключ дорівнює назві
//        safe   — ключ дорівнює «безпечній» назві
//        suffix — складений ключ «дата_предмет»
export const SUBJECT_KEY_NODES = [
  { node:'grades',               depth:2, kind:'plain',  label:'Оцінки' },
  { node:'grade_types',          depth:2, kind:'plain',  label:'Типи оцінок' },
  { node:'journal_column_types', depth:2, kind:'plain',  label:'Колонки журналу' },
  { node:'semester_grades',      depth:2, kind:'plain',  label:'Семестрові' },
  { node:'student_grades',       depth:3, kind:'plain',  label:'Оцінки учня (дзеркало)' },
  { node:'exams',                depth:3, kind:'plain',  label:'Контрольні' },
  { node:'authors',              depth:2, kind:'plain',  label:'Автори записів' },
  { node:'comments',             depth:2, kind:'plain',  label:'Коментарі' },
  { node:'homeworks',            depth:2, kind:'plain',  label:'Домашні завдання' },
  { node:'reactions',            depth:2, kind:'plain',  label:'Реакції' },
  { node:'retake_requests',      depth:1, kind:'plain',  label:'Заявки на перескладання' },
  { node:'curriculum_plans',     depth:1, kind:'safe',   label:'Календарні плани' },
  { node:'textbooks',            depth:1, kind:'safe',   label:'Підручники' },
  { node:'stickers',             depth:2, kind:'suffix', label:'Наклейки' }
];

// ── Обхід дерева ────────────────────────────────────────────────

// Чи цей ключ належить предмету
function keyMatches(key, subject, kind){
  if(kind === 'plain')  return key === subject;
  if(kind === 'safe')   return key === safeKey(subject);
  if(kind === 'suffix') return key.endsWith('_' + subject);
  return false;
}
function renamedKey(key, oldName, newName, kind){
  if(kind === 'plain')  return newName;
  if(kind === 'safe')   return safeKey(newName);
  if(kind === 'suffix') return key.slice(0, key.length - oldName.length) + newName;
  return key;
}

// tree — піддерево {вузол}/{клас}. Повертає точкові записи для update()
// та скільки гілок знайдено. base — префікс шляху для цих записів.
//
// ЗЛИТТЯ. Якщо гілка з новою назвою вже існує (перейменовуємо «English»
// у наявну «Англійська мова»), ми НЕ затираємо її цілком, а зливаємо
// лист за листом. Інакше директор одним натисканням стер би чужі оцінки.
export function renameInTree(tree, depth, oldName, newName, kind, base){
  const updates = {}; let branches = 0, leaves = 0, merged = 0;

  function leafPaths(val, prefix){
    if(val === null || typeof val !== 'object'){ updates[prefix] = val; leaves++; return; }
    const keys = Object.keys(val);
    if(!keys.length){ updates[prefix] = val; leaves++; return; }
    keys.forEach(k => leafPaths(val[k], `${prefix}/${k}`));
  }

  function walk(node, left, path){
    if(!node || typeof node !== 'object') return;
    if(left === 0){
      Object.keys(node).forEach(k => {
        if(!keyMatches(k, oldName, kind)) return;
        const nk = renamedKey(k, oldName, newName, kind);
        if(nk === k) return;                       // нічого не змінюється
        branches++;
        if(Object.prototype.hasOwnProperty.call(node, nk)) merged++;
        leafPaths(node[k], `${path}/${nk}`);
        updates[`${path}/${k}`] = null;            // прибираємо стару гілку
      });
      return;
    }
    Object.keys(node).forEach(k => walk(node[k], left - 1, `${path}/${k}`));
  }

  walk(tree, depth - 1, base);
  return { updates, branches, leaves, merged };
}

// ── Назва предмета як значення, а не ключ ───────────────────────

// Розклад: lessons/{День}/{слот}/{і}/subject/{ua,pl} і масив alt
export function renameInLessons(lessons, oldName, newName, base){
  const updates = {}; let hits = 0;
  Object.entries(lessons || {}).forEach(([day, raw]) => {
    const slots = Array.isArray(raw) ? raw : Object.values(raw || {});
    const slotKeys = Array.isArray(raw) ? raw.map((_, i) => i) : Object.keys(raw || {});
    slots.forEach((slot, si) => {
      const sk = slotKeys[si];
      const items = Array.isArray(slot) ? slot : (slot && slot.subject ? [slot] : []);
      const itemKeys = Array.isArray(slot) ? slot.map((_, i) => i) : [null];
      items.forEach((item, ii) => {
        if(!item) return;
        const ik = itemKeys[ii];
        const at = ik === null ? `${base}/${day}/${sk}` : `${base}/${day}/${sk}/${ik}`;
        ['ua','pl'].forEach(lang => {
          const cur = item.subject && typeof item.subject === 'object' ? item.subject[lang] : null;
          if(cur === oldName){ updates[`${at}/subject/${lang}`] = newName; hits++; }
        });
        if(typeof item.subject === 'string' && item.subject === oldName){
          updates[`${at}/subject`] = newName; hits++;
        }
        // Чергування: alt зберігає перелік назв, і парний підпис у subject
        const alt = item.alt && (Array.isArray(item.alt) ? item.alt : Object.values(item.alt));
        if(alt && alt.length){
          const altKeys = Array.isArray(item.alt) ? item.alt.map((_,i)=>i) : Object.keys(item.alt);
          let changed = false;
          const fresh = alt.map((v, i) => {
            if(v === oldName){ updates[`${at}/alt/${altKeys[i]}`] = newName; hits++; changed = true; return newName; }
            return v;
          });
          if(changed){
            const pair = fresh.join(' / ');
            updates[`${at}/subject/ua`] = pair;
            updates[`${at}/subject/pl`] = pair;
          }
        }
      });
    });
  });
  return { updates, hits };
}

// Списки назв: teacher_access/{учитель}/{клас}, teacher_skills/{учитель}/subjects
export function renameInList(list, oldName, newName, base){
  const updates = {}; let hits = 0;
  if(!list) return { updates, hits };
  const keys = Array.isArray(list) ? list.map((_, i) => i) : Object.keys(list);
  const vals = Array.isArray(list) ? list : Object.values(list);
  vals.forEach((v, i) => {
    if(typeof v === 'string' && v.trim() === oldName){
      updates[`${base}/${keys[i]}`] = newName; hits++;
    }
  });
  return { updates, hits };
}

// Чергування: schedule_alt/{клас}/{тиждень}/{День}/{слот} = назва
export function renameInAlt(tree, oldName, newName, base){
  const updates = {}; let hits = 0;
  Object.entries(tree || {}).forEach(([week, days]) => {
    Object.entries(days || {}).forEach(([day, slots]) => {
      Object.entries(slots || {}).forEach(([slot, val]) => {
        if(val === oldName){ updates[`${base}/${week}/${day}/${slot}`] = newName; hits++; }
      });
    });
  });
  return { updates, hits };
}

// Усі назви предметів, які трапляються в розкладі класу
export function subjectsInLessons(lessons){
  const out = new Set();
  Object.values(lessons || {}).forEach(raw => {
    const slots = Array.isArray(raw) ? raw : Object.values(raw || {});
    slots.forEach(slot => {
      const items = Array.isArray(slot) ? slot : (slot && slot.subject ? [slot] : []);
      items.forEach(item => {
        if(!item || item.type === 'break') return;
        const alt = item.alt && (Array.isArray(item.alt) ? item.alt : Object.values(item.alt));
        if(alt && alt.length){ alt.forEach(a => { if(a) out.add(String(a).trim()); }); return; }
        const raw2 = item.subject && typeof item.subject === 'object' ? item.subject.ua : item.subject;
        const n = typeof raw2 === 'string' ? raw2.trim() : '';
        if(n) out.add(n);
      });
    });
  });
  return [...out].sort((a, b) => a.localeCompare(b, 'uk'));
}

// Схожі назви — щоб директор побачив «English» і «english» поруч
export function similarNames(names, target){
  const norm = s => String(s).toLowerCase().replace(/[\s.'’-]/g, '');
  const t = norm(target);
  return names.filter(n => n !== target && norm(n) === t);
}

// ══════════════════════════════════════════════════════════════════
//  ІНТЕРФЕЙС
// ══════════════════════════════════════════════════════════════════
const DIR_ROLES = ['director', 'administrator'];
const CLASSES = Array.from({ length: 11 }, (_, i) => `class_${i + 1}`);
function isDir(){ return DIR_ROLES.includes(currentUserData && currentUserData.role); }

let plan = null;          // прорахований перенос, чекає підтвердження

// Усі предмети школи — з розкладів і зі списків класів
async function allSubjects(){
  const found = new Set();
  await Promise.all(CLASSES.map(async cls => {
    try{
      const s = await get(child(ref(db), `schedules/${cls}/lessons`));
      if(s.exists()) subjectsInLessons(s.val()).forEach(n => found.add(n));
    }catch(e){}
    try{
      const c = await get(child(ref(db), `subjects_catalog/${cls}`));
      if(c.exists()) Object.values(c.val() || {}).forEach(n => { if(n) found.add(String(n).trim()); });
    }catch(e){}
  }));
  return [...found].sort((a, b) => a.localeCompare(b, 'uk'));
}

window.openRenameSubject = async function(){
  const box = document.getElementById('rs-body');
  if(!box || !isDir()) return;
  box.innerHTML = '<p class="empty-msg">Збираю список предметів...</p>';
  const names = await allSubjects();
  if(!names.length){
    box.innerHTML = '<p class="empty-msg">У школі ще немає жодного предмета в розкладі.</p>';
    return;
  }
  box.innerHTML = `
    <label style="font-size:.8rem;color:#ad1457;font-weight:600;">Який предмет перейменувати:</label>
    <select id="rs-old" style="margin-top:4px;">
      ${names.map(n => `<option value="${escHtml(n)}">${escHtml(n)}</option>`).join('')}
    </select>
    <label style="font-size:.8rem;color:#ad1457;font-weight:600;">Нова назва:</label>
    <input type="text" id="rs-new" placeholder="Наприклад: Англійська мова" style="margin-top:4px;">
    <button type="button" id="rs-check" onclick="checkRenameSubject()"
            style="background:#ad1457;color:#fff;margin-top:11px;">🔍 Порахувати, що зміниться</button>
    <div id="rs-report"></div>`;
};

window.checkRenameSubject = async function(){
  const oldName = document.getElementById('rs-old').value;
  const newName = (document.getElementById('rs-new').value || '').trim();
  const rep = document.getElementById('rs-report');
  plan = null;
  if(!newName){ rep.innerHTML = '<div class="rs-warn">Впишіть нову назву.</div>'; return; }
  if(newName === oldName){ rep.innerHTML = '<div class="rs-warn">Нова назва збігається зі старою.</div>'; return; }
  if(/[.#$[\]/]/.test(newName)){
    rep.innerHTML = '<div class="rs-warn">У назві не можна вживати <b>. # $ [ ] /</b> — Firebase не дозволяє такі символи в ключах.</div>';
    return;
  }
  rep.innerHTML = '<p class="empty-msg">Рахую...</p>';

  const updates = {}, rows = [];
  let totalLeaves = 0, totalMerged = 0;

  try{
    // 1. Вузли, де предмет — ключ
    for(const spec of SUBJECT_KEY_NODES){
      let leaves = 0, branches = 0, merged = 0;
      for(const cls of CLASSES){
        const snap = await get(child(ref(db), `${spec.node}/${cls}`));
        if(!snap.exists()) continue;
        const r = renameInTree(snap.val(), spec.depth, oldName, newName, spec.kind, `${spec.node}/${cls}`);
        Object.assign(updates, r.updates);
        leaves += r.leaves; branches += r.branches; merged += r.merged;
      }
      if(branches) rows.push({ label: spec.label, branches, leaves, merged });
      totalLeaves += leaves; totalMerged += merged;
    }
    // 2. Розклади й чернетки
    let schedHits = 0;
    for(const cls of CLASSES){
      const s = await get(child(ref(db), `schedules/${cls}/lessons`));
      if(s.exists()){
        const r = renameInLessons(s.val(), oldName, newName, `schedules/${cls}/lessons`);
        Object.assign(updates, r.updates); schedHits += r.hits;
      }
      const a = await get(child(ref(db), `schedule_alt/${cls}`));
      if(a.exists()){
        const r = renameInAlt(a.val(), oldName, newName, `schedule_alt/${cls}`);
        Object.assign(updates, r.updates); schedHits += r.hits;
      }
    }
    const drafts = await get(child(ref(db), 'schedule_drafts'));
    if(drafts.exists()){
      Object.entries(drafts.val() || {}).forEach(([name, byClass]) => {
        Object.entries(byClass || {}).forEach(([cls, data]) => {
          if(!data || !data.lessons) return;
          const r = renameInLessons(data.lessons, oldName, newName, `schedule_drafts/${name}/${cls}/lessons`);
          Object.assign(updates, r.updates); schedHits += r.hits;
        });
      });
    }
    if(schedHits) rows.push({ label: 'Розклад і чернетки', branches: schedHits, leaves: schedHits, merged: 0 });

    // 3. Доступ учителів і їхні предмети
    let accHits = 0;
    const acc = await get(child(ref(db), 'teacher_access'));
    if(acc.exists()){
      Object.entries(acc.val() || {}).forEach(([se, byClass]) => {
        Object.entries(byClass || {}).forEach(([cls, list]) => {
          const r = renameInList(list, oldName, newName, `teacher_access/${se}/${cls}`);
          Object.assign(updates, r.updates); accHits += r.hits;
        });
      });
    }
    const skills = await get(child(ref(db), 'teacher_skills'));
    if(skills.exists()){
      Object.entries(skills.val() || {}).forEach(([se, rec]) => {
        const r = renameInList(rec && rec.subjects, oldName, newName, `teacher_skills/${se}/subjects`);
        Object.assign(updates, r.updates); accHits += r.hits;
      });
    }
    if(accHits) rows.push({ label: 'Доступ учителів', branches: accHits, leaves: accHits, merged: 0 });

    // 4. Списки предметів класів
    let catHits = 0;
    for(const cls of CLASSES){
      const c = await get(child(ref(db), `subjects_catalog/${cls}`));
      if(!c.exists()) continue;
      Object.entries(c.val() || {}).forEach(([k, v]) => {
        if(String(v).trim() !== oldName) return;
        updates[`subjects_catalog/${cls}/${k}`] = null;
        updates[`subjects_catalog/${cls}/${safeKey(newName)}`] = newName;
        catHits++;
      });
    }
    if(catHits) rows.push({ label: 'Списки предметів', branches: catHits, leaves: catHits, merged: 0 });
  }catch(e){
    rep.innerHTML = `<div class="rs-warn">Не вдалося прочитати базу: ${escHtml(e.message)}</div>`;
    return;
  }

  if(!rows.length){
    rep.innerHTML = `<div class="rs-warn">Записів із назвою «${escHtml(oldName)}» не знайдено. Перейменовувати нічого.</div>`;
    return;
  }

  plan = { oldName, newName, updates, rows };
  const names = await allSubjects();
  const clash = names.includes(newName);
  rep.innerHTML = `
    <div class="rs-sum">Зміниться записів: ${Object.keys(updates).filter(k => updates[k] !== null).length}</div>
    <table class="rs-table"><tbody>
      ${rows.map(r => `<tr><td>${escHtml(r.label)}</td><td>${r.leaves}</td></tr>`).join('')}
    </tbody></table>
    ${clash ? `<div class="rs-warn"><b>Предмет «${escHtml(newName)}» уже існує.</b> Дані буде <b>злито</b>:
       записи зі старою назвою переїдуть у наявну, нічого не зникне.
       Якщо це не те, що ви хочете, — виберіть іншу назву.</div>` : ''}
    ${totalMerged ? `<div class="rs-warn">У ${totalMerged} гілках уже є записи з новою назвою — вони зіллються, а не перезапишуться.</div>` : ''}
    <div class="rs-warn">Перенесення не можна відмінити однією кнопкою. Переконайтеся, що назва написана правильно.</div>
    <button type="button" id="rs-go" onclick="applyRenameSubject()"
            style="background:#c62828;color:#fff;margin-top:11px;">
      Перейменувати «${escHtml(oldName)}» → «${escHtml(newName)}»</button>`;
};

window.applyRenameSubject = async function(){
  if(!plan) return;
  const { oldName, newName, updates } = plan;
  if(!confirm(`Перейменувати «${oldName}» на «${newName}» у всій школі?\n\n`
    + `Зміниться записів: ${Object.keys(updates).filter(k => updates[k] !== null).length}.\n`
    + 'Оцінки, домашні завдання й плани залишаться — вони переїдуть під нову назву.')) return;
  const btn = document.getElementById('rs-go');
  btn.disabled = true; btn.textContent = '⏳ Переношу...';
  try{
    // Одним update(): або застосується все, або нічого. Часткове
    // перейменування було б найгіршим результатом — дані розлізлися б надвоє.
    await update(ref(db), updates);
    logAction('settings', { value: `предмет перейменовано: «${oldName}» → «${newName}»` });

    // Перевіряємо, що старої назви більше немає в розкладі
    let left = 0;
    for(const cls of CLASSES){
      const s = await get(child(ref(db), `schedules/${cls}/lessons`));
      if(s.exists() && subjectsInLessons(s.val()).includes(oldName)) left++;
    }
    document.getElementById('rs-report').innerHTML = left
      ? `<div class="rs-warn">Перенесено, але у ${left} класах стара назва ще трапляється в розкладі.
           Відкрийте конструктор і перевірте ці класи.</div>`
      : `<div class="rs-ok">✅ Готово. «${escHtml(oldName)}» тепер «${escHtml(newName)}» скрізь.
           Оцінки й решта даних збереглися.</div>`;
    showToast('✅ Предмет перейменовано');
    plan = null;
  }catch(e){
    alert('Не вдалося перейменувати: ' + e.message
      + '\n\nНічого не змінено — перенесення виконується цілком або ніяк.'
      + '\n\nЯкщо тут «PERMISSION_DENIED», найімовірніша причина — у базі не '
      + 'опубліковано нові правила (database.rules.json). Перейменування зачіпає '
      + 'зокрема нові вузли subjects_catalog і schedule_alt, і без правил запис у них заборонено.');
    btn.disabled = false; btn.textContent = 'Спробувати ще раз';
  }
};

// ══════════════════════════════════════════════════════════════════
//  КАТАЛОГ ПРЕДМЕТІВ ЗА НАВЧАЛЬНИМИ РОКАМИ
//
// ЯК ЛЕЖИТЬ:  subjects_catalog/{рік}/{клас}/{ключ} = {name, teacherEmail, teacherName}
//
// ЧОМУ ЗА РОКАМИ. Склад предметів у класі змінюється щороку, і в серпні
// школа має робити один зрозумілий рух: «перенести з минулого року й
// поправити». Якщо тримати один спільний список, такого руху немає —
// є повзуча правка, у якій ніхто не пам'ятає, що змінилося.
//
// ЧОМУ ВЧИТЕЛЬ ПИШЕТЬСЯ ЩЕ Й У teacher_access. Права на клас і предмет
// уже живуть там, і конструктор бере звідти вчителя за замовчуванням.
// Якби каталог зберігав призначення тільки в себе, у школи з'явилося б
// друге джерело правди — і воно неминуче розійшлося б із першим. Саме
// так у нас уже розійшлися дзвінки й час уроків.
//
// СТАРИЙ ФОРМАТ. До цього список лежав як subjects_catalog/{клас}/{ключ} =
// 'Назва'. Такі дані читаємо як запасний варіант, поки рік порожній.
// ══════════════════════════════════════════════════════════════════

const CLASSES2 = Array.from({ length: 11 }, (_, i) => `class_${i + 1}`);
const DIR2 = ['director', 'administrator'];
function isDir2(){ return DIR2.includes(currentUserData && currentUserData.role); }

// Запис каталогу може бути рядком (старий формат) або об'єктом
export function catalogEntry(raw){
  if(!raw) return null;
  if(typeof raw === 'string'){
    const n = raw.trim();
    return n ? { name: n, teacherEmail: '', teacherName: '' } : null;
  }
  const n = String(raw.name || '').trim();
  return n ? { name: n, teacherEmail: raw.teacherEmail || '', teacherName: raw.teacherName || '' } : null;
}

// Вузол каталогу → впорядкований список записів
export function catalogList(node){
  return Object.entries(node || {})
    .map(([key, raw]) => { const e = catalogEntry(raw); return e ? { key, ...e } : null; })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, 'uk'));
}

// Предмети класу з розкладу + учителі з матриці доступу → готовий каталог.
// Учителя шукаємо серед тих, кому директор уже дав цей предмет у цьому класі.
export function catalogFromSchedule(lessons, accessByTeacher, teachers, cls){
  const out = {};
  subjectsInLessons(lessons).forEach(name => {
    let email = '', tname = '';
    const nl = name.trim().toLowerCase();
    for(const se in (accessByTeacher || {})){
      const raw = accessByTeacher[se] && accessByTeacher[se][cls];
      if(!raw) continue;
      const list = (Array.isArray(raw) ? raw : Object.values(raw))
        .map(x => typeof x === 'string' ? x.trim().toLowerCase() : '');
      // «Всі предмети» — це не призначення на конкретний предмет,
      // тому такого вчителя за замовчуванням не ставимо
      if(!list.includes(nl)) continue;
      const t = (teachers || []).find(t => t.safeEmail === se);
      if(t){ email = t.email; tname = t.name; break; }
    }
    out[safeKey(name)] = { name, teacherEmail: email, teacherName: tname };
  });
  return out;
}

// Минулий навчальний рік: «2026-2027» → «2025-2026»
export function prevYearId(year){
  const m = /^(\d{4})-(\d{4})$/.exec(String(year || ''));
  if(!m) return null;
  return `${+m[1] - 1}-${+m[2] - 1}`;
}

let catState = { year: null, cls: null, node: {} };

async function readCatalog(year, cls){
  const snap = await get(child(ref(db), `subjects_catalog/${year}/${cls}`));
  if(snap.exists()) return snap.val() || {};
  // Запасний варіант — старий плаский формат
  const old = await get(child(ref(db), `subjects_catalog/${cls}`));
  if(!old.exists()) return {};
  const v = old.val() || {};
  // Старі дані могли бути об'єктом років — тоді це не плаский формат
  if(Object.values(v).some(x => x && typeof x === 'object' && !x.name)) return {};
  return v;
}

// Назви предметів класу — цим користується конструктор
window.catalogNames = async function(cls){
  try{
    const node = await readCatalog(ACTIVE_YEAR, cls);
    return catalogList(node).map(e => e.name);
  }catch(e){ console.warn('subjects_catalog:', e.message); return []; }
};

// Додати предмет у каталог поточного року (з конструктора теж)
window.addCatalogSubject = async function(cls, name, teacherEmail, teacherName){
  const n = String(name || '').trim();
  if(!n) return false;
  if(/[.#$[\]/]/.test(n)){ alert('У назві не можна вживати . # $ [ ] /'); return false; }
  const rec = { name: n, teacherEmail: teacherEmail || '', teacherName: teacherName || '' };
  try{
    await update(ref(db, `subjects_catalog/${ACTIVE_YEAR}/${cls}`), { [safeKey(n)]: rec });
    if(teacherEmail) await grantSubjectToTeacher(teacherEmail, cls, n);
    return true;
  }catch(e){
    alert('Не вдалося додати предмет: ' + e.message
      + '\n\nЯкщо тут «PERMISSION_DENIED» — перевірте, чи опубліковано правила бази.');
    return false;
  }
};

// Призначення вчителя = запис у матрицю доступу. Одне джерело правди.
async function grantSubjectToTeacher(email, cls, subject){
  const se = String(email).replace(/\./g, '_');
  const snap = await get(child(ref(db), `teacher_access/${se}/${cls}`));
  let list = snap.exists() ? snap.val() : [];
  if(!Array.isArray(list)) list = Object.values(list);
  list = list.filter(x => typeof x === 'string' && x.trim());
  if(list.includes('Всі предмети') || list.includes(subject)) return;
  list.push(subject);
  await set(ref(db, `teacher_access/${se}/${cls}`), list);
}

// ── Картка ──────────────────────────────────────────────────────

window.openSubjectsCatalog = async function(){
  const ys = document.getElementById('sc-year'), cs = document.getElementById('sc-class');
  if(!ys || !cs || !isDir2()) return;
  if(!cs.options.length)
    cs.innerHTML = CLASSES2.map((c, i) => `<option value="${c}">${i + 1} клас</option>`).join('');
  if(!ys.options.length){
    const cur = ACTIVE_YEAR || getAcademicYearId();
    const prev = prevYearId(cur);
    ys.innerHTML = [cur, prev].filter(Boolean)
      .map(y => `<option value="${escHtml(y)}">${escHtml(y)}${y === cur ? ' (поточний)' : ''}</option>`).join('');
  }
  renderSubjectsCatalog();
};

window.renderSubjectsCatalog = async function(){
  const box = document.getElementById('sc-body');
  if(!box) return;
  const year = document.getElementById('sc-year').value;
  const cls = document.getElementById('sc-class').value;
  catState.year = year; catState.cls = cls;
  box.innerHTML = '<p class="empty-msg">Завантажую...</p>';

  let node = {}, inSchedule = [];
  try{
    node = await readCatalog(year, cls);
    const sch = await get(child(ref(db), `schedules/${cls}/lessons`));
    inSchedule = sch.exists() ? subjectsInLessons(sch.val()) : [];
  }catch(e){
    box.innerHTML = `<p class="empty-msg" style="color:var(--red);">${escHtml(e.message)}</p>`;
    return;
  }
  catState.node = node;
  const list = catalogList(node);
  const names = list.map(e => e.name);
  const missing = inSchedule.filter(n => !names.includes(n));
  const teachers = (window.globalTeachersList || []);

  const teacherSelect = (e) => `<select onchange="setSubjectTeacher('${escJs(e.key)}', this.value)">
      <option value="">— учитель не призначений —</option>
      ${teachers.map(t => `<option value="${escHtml(t.email)}"${t.email === e.teacherEmail ? ' selected' : ''}>${escHtml(t.name)}</option>`).join('')}
    </select>`;

  box.innerHTML = `
    ${list.length
      ? `<div class="sc-list">${list.map(e => {
          const dup = similarNames(names, e.name);
          return `<div class="sc-item">
            <div class="sc-name">${escHtml(e.name)}
              ${dup.length ? `<i>⚠️ схоже на ${escHtml(dup.join(', '))}</i>` : ''}</div>
            ${teacherSelect(e)}
            <button type="button" onclick="removeSubjectFromCatalog('${escJs(e.key)}')" title="Прибрати зі списку">×</button>
          </div>`;
        }).join('')}</div>`
      : '<p class="empty-msg">Для цього класу й року предметів ще немає.</p>'}

    ${missing.length
      ? `<div class="sc-add-hint">У розкладі є ще ${missing.length}, яких немає у списку:
          ${escHtml(missing.slice(0, 6).join(', '))}${missing.length > 6 ? '…' : ''}</div>`
      : ''}

    <div class="sc-add">
      <input type="text" id="sc-new" placeholder="Новий предмет">
      <select id="sc-new-teacher">
        <option value="">— учитель —</option>
        ${teachers.map(t => `<option value="${escHtml(t.email)}">${escHtml(t.name)}</option>`).join('')}
      </select>
      <button type="button" onclick="addSubjectFromCard()">+ Додати</button>
    </div>

    <div class="sc-tools">
      <button type="button" onclick="fillCatalogFromSchedule()">📥 Зібрати з розкладу й матриці доступу</button>
      <button type="button" onclick="carryOverSubjects()">🗓 Перенести з минулого року</button>
      <button type="button" onclick="copySubjectsFromClass()">📋 Скопіювати з іншого класу</button>
    </div>
    <div class="bk-build">версія модуля: ${escHtml(SUBJ_BUILD)}</div>`;
};

window.addSubjectFromCard = async function(){
  const inp = document.getElementById('sc-new');
  const sel = document.getElementById('sc-new-teacher');
  const t = (window.globalTeachersList || []).find(x => x.email === sel.value);
  if(await window.addCatalogSubject(catState.cls, inp.value, sel.value, t ? t.name : '')){
    inp.value = ''; sel.value = '';
    renderSubjectsCatalog();
  }
};

window.setSubjectTeacher = async function(key, email){
  const rec = catalogEntry(catState.node[key]);
  if(!rec) return;
  const t = (window.globalTeachersList || []).find(x => x.email === email);
  try{
    await update(ref(db, `subjects_catalog/${catState.year}/${catState.cls}/${key}`),
      { name: rec.name, teacherEmail: email || '', teacherName: t ? t.name : '' });
    if(email) await grantSubjectToTeacher(email, catState.cls, rec.name);
    showToast(email ? `✅ ${rec.name} — ${t ? t.name : ''}` : '✅ Учителя знято');
    renderSubjectsCatalog();
  }catch(e){ alert('Не вдалося зберегти: ' + e.message); }
};

window.removeSubjectFromCatalog = async function(key){
  if(!confirm('Прибрати предмет зі списку?\n\nЦе не чіпає ні розклад, ні оцінки, ні права вчителя — '
    + 'лише перелік, з якого обирають у конструкторі.')) return;
  try{
    await remove(ref(db, `subjects_catalog/${catState.year}/${catState.cls}/${key}`));
    renderSubjectsCatalog();
  }catch(e){ alert('Не вдалося прибрати: ' + e.message); }
};

window.fillCatalogFromSchedule = async function(){
  try{
    const [sch, acc] = await Promise.all([
      get(child(ref(db), `schedules/${catState.cls}/lessons`)),
      get(child(ref(db), 'teacher_access'))
    ]);
    if(!sch.exists()) return alert('У цього класу немає розкладу — збирати нема з чого.');
    const patch = catalogFromSchedule(sch.val(), acc.exists() ? acc.val() : {},
                                      window.globalTeachersList || [], catState.cls);
    const n = Object.keys(patch).length;
    if(!n) return alert('У розкладі не знайдено жодного предмета.');
    const withT = Object.values(patch).filter(x => x.teacherEmail).length;
    if(!confirm(`Додати предметів: ${n}?\n\nІз них із визначеним учителем: ${withT}.\n`
      + 'Наявні записи цього класу буде оновлено, зайві не зникнуть.')) return;
    await update(ref(db, `subjects_catalog/${catState.year}/${catState.cls}`), patch);
    showToast(`✅ Додано предметів: ${n}`);
    renderSubjectsCatalog();
  }catch(e){ alert('Не вдалося зібрати: ' + e.message); }
};

window.carryOverSubjects = async function(){
  const prev = prevYearId(catState.year);
  if(!prev) return alert('Не можу визначити минулий рік.');
  try{
    const snap = await get(child(ref(db), `subjects_catalog/${prev}/${catState.cls}`));
    if(!snap.exists()) return alert(`За ${prev} у цього класу немає списку предметів.`);
    const list = catalogList(snap.val());
    if(!list.length) return alert(`За ${prev} список порожній.`);
    if(!confirm(`Перенести ${list.length} предметів із ${prev} у ${catState.year}?\n\n`
      + 'Наявні записи буде оновлено, зайві не зникнуть.')) return;
    const patch = {};
    list.forEach(e => { patch[e.key] = { name: e.name, teacherEmail: e.teacherEmail, teacherName: e.teacherName }; });
    await update(ref(db, `subjects_catalog/${catState.year}/${catState.cls}`), patch);
    logAction('settings', { value: `предмети перенесено ${prev} → ${catState.year}, ${catState.cls}` });
    showToast(`✅ Перенесено: ${list.length}`);
    renderSubjectsCatalog();
  }catch(e){ alert('Не вдалося перенести: ' + e.message); }
};

window.copySubjectsFromClass = async function(){
  const from = prompt('З якого класу скопіювати? Вкажіть номер (1-11):', '');
  if(from === null) return;
  const n = parseInt(from, 10);
  if(!n || n < 1 || n > 11) return alert('Потрібен номер класу від 1 до 11.');
  const src = `class_${n}`;
  if(src === catState.cls) return alert('Це той самий клас.');
  try{
    const node = await readCatalog(catState.year, src);
    const list = catalogList(node);
    if(!list.length) return alert(`У ${n} класу немає списку предметів за ${catState.year}.`);
    if(!confirm(`Скопіювати ${list.length} предметів із ${n} класу?\n\n`
      + 'Разом з учителями. Наявні записи буде оновлено, зайві не зникнуть.')) return;
    const patch = {};
    list.forEach(e => { patch[e.key] = { name: e.name, teacherEmail: e.teacherEmail, teacherName: e.teacherName }; });
    await update(ref(db, `subjects_catalog/${catState.year}/${catState.cls}`), patch);
    for(const e of list) if(e.teacherEmail) await grantSubjectToTeacher(e.teacherEmail, catState.cls, e.name);
    showToast(`✅ Скопійовано: ${list.length}`);
    renderSubjectsCatalog();
  }catch(e){ alert('Не вдалося скопіювати: ' + e.message); }
};

// Підказки для імпорту розкладу (конструктор тепер має власний список)
export async function subjectDatalist(cls, id = 'subject-suggestions'){
  let el = document.getElementById(id);
  if(!el){ el = document.createElement('datalist'); el.id = id; document.body.appendChild(el); }
  // Не називаємо змінну set: у цьому файлі set — це запис у базу,
  // і локальна змінна з таким іменем ховала б його всередині функції
  const names = new Set(await window.catalogNames(cls));
  try{
    const s = await get(child(ref(db), `schedules/${cls}/lessons`));
    if(s.exists()) subjectsInLessons(s.val()).forEach(n => names.add(n));
  }catch(e){ console.warn('subjects:', e.message); }
  el.innerHTML = [...names].sort((a, b) => a.localeCompare(b, 'uk'))
    .map(n => `<option value="${escHtml(n)}"></option>`).join('');
  return el;
}
window.subjectDatalist = subjectDatalist;
