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
import { ref, get, child, update, remove } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, currentUserData, showToast, escHtml, escJs, logAction } from './common.js';

export const SUBJ_BUILD = '2026-09-02 · subjects v1';

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
  const set = new Set();
  await Promise.all(CLASSES.map(async cls => {
    try{
      const s = await get(child(ref(db), `schedules/${cls}/lessons`));
      if(s.exists()) subjectsInLessons(s.val()).forEach(n => set.add(n));
    }catch(e){}
    try{
      const c = await get(child(ref(db), `subjects_catalog/${cls}`));
      if(c.exists()) Object.values(c.val() || {}).forEach(n => { if(n) set.add(String(n).trim()); });
    }catch(e){}
  }));
  return [...set].sort((a, b) => a.localeCompare(b, 'uk'));
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

// ── Список предметів класу ──────────────────────────────────────

window.openSubjectsCatalog = async function(){
  const sel = document.getElementById('sc-class');
  if(!sel || !isDir()) return;
  if(!sel.options.length)
    sel.innerHTML = CLASSES.map((c, i) => `<option value="${c}">${i + 1} клас</option>`).join('');
  renderSubjectsCatalog();
};

window.renderSubjectsCatalog = async function(){
  const box = document.getElementById('sc-body');
  const cls = document.getElementById('sc-class').value;
  if(!box) return;
  box.innerHTML = '<p class="empty-msg">Завантажую...</p>';
  let listed = {}, inSchedule = [];
  try{
    const c = await get(child(ref(db), `subjects_catalog/${cls}`));
    listed = c.exists() ? (c.val() || {}) : {};
    const s = await get(child(ref(db), `schedules/${cls}/lessons`));
    inSchedule = s.exists() ? subjectsInLessons(s.val()) : [];
  }catch(e){
    box.innerHTML = `<p class="empty-msg" style="color:var(--red);">${escHtml(e.message)}</p>`;
    return;
  }
  const names = Object.values(listed).map(v => String(v).trim()).filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'uk'));
  const missing = inSchedule.filter(n => !names.includes(n));

  box.innerHTML = `
    ${names.length
      ? `<div class="sc-list">${names.map(n => {
          const dup = similarNames(names, n);
          return `<div class="sc-item"><span>${escHtml(n)}</span>
            ${dup.length ? `<i title="Схожа назва: ${escHtml(dup.join(', '))}">⚠️ схоже на ${escHtml(dup.join(', '))}</i>` : ''}
            <button type="button" onclick="removeSubjectFromCatalog('${escJs(cls)}','${escJs(safeKey(n))}')" title="Прибрати зі списку">×</button>
          </div>`;
        }).join('')}</div>`
      : '<p class="empty-msg">Список порожній.</p>'}
    ${missing.length
      ? `<div class="sc-add-hint">У розкладі є ще ${missing.length}, яких немає у списку:
          ${escHtml(missing.slice(0, 6).join(', '))}${missing.length > 6 ? '…' : ''}
          <button type="button" onclick="fillCatalogFromSchedule('${escJs(cls)}')">Додати всі</button></div>`
      : ''}
    <div class="sc-add">
      <input type="text" id="sc-new" placeholder="Нова назва предмета">
      <button type="button" onclick="addSubjectToCatalog('${escJs(cls)}')">+ Додати</button>
    </div>`;
};

window.addSubjectToCatalog = async function(cls){
  const inp = document.getElementById('sc-new');
  const name = (inp.value || '').trim();
  if(!name) return;
  if(/[.#$[\]/]/.test(name)){ alert('У назві не можна вживати . # $ [ ] /'); return; }
  try{
    await update(ref(db, `subjects_catalog/${cls}`), { [safeKey(name)]: name });
    inp.value = '';
    renderSubjectsCatalog();
  }catch(e){ alert('Не вдалося додати: ' + e.message); }
};

window.removeSubjectFromCatalog = async function(cls, key){
  if(!confirm('Прибрати предмет зі списку?\n\nЦе не чіпає ні розклад, ні оцінки — лише підказки при введенні.')) return;
  try{
    await remove(ref(db, `subjects_catalog/${cls}/${key}`));
    renderSubjectsCatalog();
  }catch(e){ alert('Не вдалося прибрати: ' + e.message); }
};

window.fillCatalogFromSchedule = async function(cls){
  try{
    const s = await get(child(ref(db), `schedules/${cls}/lessons`));
    if(!s.exists()) return;
    const patch = {};
    subjectsInLessons(s.val()).forEach(n => { patch[safeKey(n)] = n; });
    if(!Object.keys(patch).length) return;
    await update(ref(db, `subjects_catalog/${cls}`), patch);
    showToast('✅ Список поповнено з розкладу');
    renderSubjectsCatalog();
  }catch(e){ alert('Не вдалося зібрати: ' + e.message); }
};

// Підказки для конструктора розкладу й імпорту: <datalist> з назвами класу.
// Свідомо саме підказки, а не жорсткий вибір: якщо школа завтра введе
// новий предмет, ніхто не має впертися в замкнений список.
export async function subjectDatalist(cls, id = 'subject-suggestions'){
  let el = document.getElementById(id);
  if(!el){
    el = document.createElement('datalist');
    el.id = id;
    document.body.appendChild(el);
  }
  const set = new Set();
  try{
    const c = await get(child(ref(db), `subjects_catalog/${cls}`));
    if(c.exists()) Object.values(c.val() || {}).forEach(v => { if(v) set.add(String(v).trim()); });
    const s = await get(child(ref(db), `schedules/${cls}/lessons`));
    if(s.exists()) subjectsInLessons(s.val()).forEach(n => set.add(n));
  }catch(e){ console.warn('subjects_catalog:', e.message); }
  el.innerHTML = [...set].sort((a, b) => a.localeCompare(b, 'uk'))
    .map(n => `<option value="${escHtml(n)}"></option>`).join('');
  return el;
}
window.subjectDatalist = subjectDatalist;
