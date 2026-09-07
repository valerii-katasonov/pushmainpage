// ═══════════════════════════════════════════════════════════════
// students-import.js — завантаження учнів і прив'язки батьків із таблиці.
//
// НАВІЩО. Школа веде списки в xlsx: учень, клас, батьки, пошта. Заводити
// це в портал руками — сотня учнів по одному, плюс прив'язка батьків
// окремою дією. Робота на вечір, і кожен рядок — шанс на друкарську
// помилку в пошті, через яку батьки потім не зайдуть.
//
// ЩО РОБИМО ОБЕРЕЖНО:
//   • спершу ПОКАЗУЄМО, що буде зроблено, і лише потім пишемо;
//   • повторний запуск нічого не дублює — учень, який уже є в списку
//     класу, не додається вдруге, прив'язка, яка вже є, не повторюється;
//   • нічого не видаляємо. Якщо в таблиці когось немає, у порталі він
//     лишається: таблиця може бути частковою, а список класу — ні.
//
// ПРАВИЛО ПРО ПОШТУ (як просила школа): якщо батьків двоє, а пошта одна,
// вона дістається ПЕРШОМУ. Другий лишається без доступу — і про це прямо
// написано в попередньому перегляді, щоб школа бачила, кому доступу не
// буде, а не дізнавалася про це від батьків.
//
// ВСІ ЯК ОПІКУНИ. Таблиця не каже, хто мати, а хто батько, і вгадувати за
// іменем — шлях до помилок. Роль «опікун» нейтральна; батьки змінять її
// самі в профілі, коли зайдуть.
// ═══════════════════════════════════════════════════════════════
import { ref, get, child, update, push } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, escHtml, showToast, logAction, getStudentDir, matchSid,
         nameKey, invalidateStudentDir } from './common.js';

export const SI_BUILD = '2026-09-06 · імпорт учнів v1';

// ── Розбір таблиці (чиста логіка, перевіряється тестами) ────────

// Заголовки шукаємо ЗА НАЗВОЮ, а не за номером колонки.
//
// Так само зроблено в імпорті календарного плану, і не випадково: у
// реальних таблицях школи колонки переставляють, додають «№ п/п» або
// порожню колонку збоку. Прив'язка до позиції ламається на першій же
// такій таблиці, причому мовчки — імпорт «спрацює» й запише сміття.
const COLUMNS = [
  { k:'name',    match:/учн/i },                    // ПІП учня
  { k:'cls',     match:/клас/i },
  { k:'parents', match:/батьк|мат|опік/i },         // ПІП батьків
  { k:'emails',  match:/пошт|email|e-mail/i }
];

export function headerMap(row){
  const map = {};
  (row || []).forEach((cell, i) => {
    const s = String(cell == null ? '' : cell).trim();
    if(!s) return;
    for(const c of COLUMNS){
      if(map[c.k] === undefined && c.match.test(s)) map[c.k] = i;
    }
  });
  return map;
}

// Пошта: у клітинці буває одна, дві через перенос рядка, кома або крапка
// з комою. Беремо все, що схоже на пошту, у порядку появи.
export function splitEmails(cell){
  return String(cell == null ? '' : cell)
    .split(/[\s,;]+/)
    .map(s => s.trim().toLowerCase())
    .filter(s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
}

// Батьки: «Артюх Наталія Олександрівна, Артюх Сергій Леонідович».
// Кома — роздільник; переноси рядків теж трапляються.
export function splitParents(cell){
  return String(cell == null ? '' : cell)
    .split(/[,;\n]+/)
    .map(s => s.replace(/\s+/g,' ').trim())
    .filter(s => s.length > 2);
}

// «1», «1 клас», «1-А» → 'class_1'. Порожнє або незрозуміле → null:
// краще показати рядок як проблемний, ніж покласти дитину в чужий клас.
export function classId(cell){
  const m = /(\d{1,2})/.exec(String(cell == null ? '' : cell));
  if(!m) return null;
  const n = parseInt(m[1], 10);
  return (n >= 1 && n <= 11) ? `class_${n}` : null;
}

// Рядки таблиці → перелік того, що маємо створити.
// rows — масив масивів (як віддає SheetJS з header:1).
export function parseStudentsSheet(rows){
  const out = { rows: [], problems: [], header: null };
  const data = rows || [];
  let hi = -1, map = null;
  for(let i = 0; i < Math.min(data.length, 20); i++){
    const m = headerMap(data[i]);
    if(m.name !== undefined && m.cls !== undefined){ hi = i; map = m; break; }
  }
  if(hi === -1){
    out.problems.push('Не знайдено рядок заголовків. Потрібні колонки з назвами '
      + '«ПІП учня», «Клас», «ПІП батьків», «Електронна пошта».');
    return out;
  }
  out.header = map;

  for(let i = hi + 1; i < data.length; i++){
    const r = data[i] || [];
    const name = String(r[map.name] == null ? '' : r[map.name]).replace(/\s+/g,' ').trim();
    if(!name) continue;                         // порожній рядок — просто пропуск
    const cls = classId(r[map.cls]);
    const parents = map.parents === undefined ? [] : splitParents(r[map.parents]);
    const emails  = map.emails  === undefined ? [] : splitEmails(r[map.emails]);
    // Пошта дістається батькам ПО ПОРЯДКУ: перша — першому. Кому не
    // вистачило, той лишається без доступу.
    const people = parents.map((p, idx) => ({ name: p, email: emails[idx] || '' }));
    // Пошта є, а імені батька в таблиці немає — все одно прив'язуємо:
    // доступ важливіший за підпис, ім'я з'явиться в профілі.
    if(!people.length && emails.length)
      emails.forEach(e => people.push({ name:'', email:e }));

    out.rows.push({ line:i + 1, name, cls, people,
                    rawCls: String(r[map.cls] == null ? '' : r[map.cls]).trim() });
    if(!cls) out.problems.push(`Рядок ${i + 1}: не зрозуміло, який клас — «${name}»`);
    if(!people.some(p => p.email))
      out.problems.push(`Рядок ${i + 1}: жодної пошти — «${name}», доступу в батьків не буде`);
  }
  if(!out.rows.length) out.problems.push('У таблиці не знайдено жодного учня.');
  return out;
}

// Що саме зміниться в базі, з урахуванням того, що там уже є.
// dirs: {class_1:{byId,byName,byLoose}}, links: {safeEmail:{children:[...]}}
export function planChanges(parsed, dirs, links){
  const plan = { addStudents: [], addLinks: [], skipStudents: [], skipLinks: [] };
  // Учні, яких додамо в межах цього ж імпорту, теж рахуються як наявні —
  // інакше двоє дітей з однаковим імʼям в одному класі створили б два записи
  const pending = {};
  for(const r of parsed.rows){
    if(!r.cls) continue;
    const dir = dirs[r.cls] || { byId:{}, byName:{}, byLoose:{} };
    let sid = matchSid(dir, r.name);
    if(!sid) sid = (pending[r.cls] || {})[nameKey(r.name)];
    if(sid) plan.skipStudents.push({ name:r.name, cls:r.cls, sid });
    else{
      pending[r.cls] = pending[r.cls] || {};
      pending[r.cls][nameKey(r.name)] = '(новий)';
      plan.addStudents.push({ name:r.name, cls:r.cls });
    }
    for(const p of r.people){
      if(!p.email) continue;
      const se = p.email.replace(/\./g,'_');
      const kids = ((links || {})[se] || {}).children || [];
      const already = (Array.isArray(kids) ? kids : Object.values(kids))
        .some(k => k && nameKey(k.studentName) === nameKey(r.name) && k.class === r.cls);
      const rec = { email:p.email, se, parentName:p.name, studentName:r.name, cls:r.cls };
      if(already) plan.skipLinks.push(rec); else plan.addLinks.push(rec);
    }
  }
  return plan;
}

// ── Інтерфейс ───────────────────────────────────────────────────

let siParsed = null, siPlan = null;

function siBox(){ return document.getElementById('si-body'); }

window.openStudentsImport = function(){
  const box = siBox();
  if(!box) return;
  siParsed = siPlan = null;
  box.innerHTML = `<p class="empty-msg">Оберіть файл .xlsx зі списком учнів.</p>`;
};

window.handleStudentsFile = function(input){
  const file = input && input.files && input.files[0];
  if(!file) return;
  const box = siBox();
  box.innerHTML = '<p class="empty-msg">Читаю файл...</p>';
  const reader = new FileReader();
  reader.onload = async (evt) => {
    try{
      const wb = XLSX.read(evt.target.result, { type:'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header:1, defval:null });
      siParsed = parseStudentsSheet(rows);
      await renderPreview();
    }catch(e){
      box.innerHTML = `<p class="empty-msg" style="color:var(--red);">Не вдалося прочитати файл: ${escHtml(e.message)}</p>`;
    }
  };
  reader.readAsArrayBuffer(file);
};

async function renderPreview(){
  const box = siBox();
  if(!siParsed) return;
  if(!siParsed.rows.length){
    box.innerHTML = `<div class="si-warn">${siParsed.problems.map(escHtml).join('<br>')}</div>`;
    return;
  }
  box.innerHTML = '<p class="empty-msg">Звіряю зі списками класів...</p>';
  // Читаємо те, що вже є: без цього не відрізнити «додати» від «уже є»
  const classes = [...new Set(siParsed.rows.map(r => r.cls).filter(Boolean))];
  const dirs = {};
  for(const c of classes){
    try{ dirs[c] = await getStudentDir(c, true); }catch(e){ dirs[c] = { byId:{}, byName:{}, byLoose:{} }; }
  }
  let links = {};
  try{
    const snap = await get(child(ref(db), 'parent_links'));
    links = snap.exists() ? snap.val() : {};
  }catch(e){ /* прочитати не вдалося — покажемо все як «додати» */ }

  siPlan = planChanges(siParsed, dirs, links);

  const noAccess = [];
  siParsed.rows.forEach(r => r.people.forEach(p => { if(!p.email && p.name) noAccess.push(`${p.name} (${r.name})`); }));

  box.innerHTML = `
    <div class="si-sum">
      <b>${siPlan.addStudents.length}</b> нових учнів ·
      <b>${siPlan.addLinks.length}</b> нових прив'язок батьків
      <span>уже є: ${siPlan.skipStudents.length} учнів, ${siPlan.skipLinks.length} прив'язок</span>
    </div>
    ${siParsed.problems.length ? `<div class="si-warn"><b>Зверніть увагу:</b><br>${siParsed.problems.slice(0,12).map(escHtml).join('<br>')}${siParsed.problems.length>12?`<br>…і ще ${siParsed.problems.length-12}`:''}</div>` : ''}
    ${noAccess.length ? `<div class="si-note"><b>Без доступу в портал (немає пошти):</b> ${escHtml(noAccess.slice(0,20).join(', '))}${noAccess.length>20?` …і ще ${noAccess.length-20}`:''}</div>` : ''}
    <table class="si-table"><thead><tr><th>Учень</th><th>Клас</th><th>Батьки → пошта</th><th></th></tr></thead><tbody>
      ${siParsed.rows.slice(0,200).map(r => {
        const isNew = siPlan.addStudents.some(s => s.name === r.name && s.cls === r.cls);
        return `<tr class="${r.cls ? '' : 'si-bad'}">
          <td>${escHtml(r.name)}</td>
          <td>${escHtml(r.cls ? r.cls.replace('class_','') : r.rawCls || '—')}</td>
          <td>${r.people.length
            ? r.people.map(p => `${escHtml(p.name || '—')} ${p.email
                ? `<span class="si-mail">${escHtml(p.email)}</span>`
                : '<span class="si-nomail">без пошти</span>'}`).join('<br>')
            : '<span class="si-nomail">не вказано</span>'}</td>
          <td>${isNew ? '<span class="si-new">новий</span>' : '<span class="si-old">уже є</span>'}</td>
        </tr>`;
      }).join('')}
    </tbody></table>
    ${siParsed.rows.length > 200 ? `<p class="empty-msg">Показано перші 200 рядків із ${siParsed.rows.length}.</p>` : ''}
    <button class="si-apply" onclick="applyStudentsImport()"
      ${(siPlan.addStudents.length + siPlan.addLinks.length) ? '' : 'disabled'}>
      Записати в портал</button>
    <p class="si-hint">Нічого не видаляється. Учні, яких немає в таблиці, лишаються в порталі як були.
      Перед першим імпортом на живих даних зробіть експорт бази.</p>
    <div class="si-build">${escHtml(SI_BUILD)}</div>`;
}

window.applyStudentsImport = async function(){
  if(!siPlan) return;
  const n = siPlan.addStudents.length + siPlan.addLinks.length;
  if(!confirm(`Записати: ${siPlan.addStudents.length} учнів і ${siPlan.addLinks.length} прив'язок батьків?\n\nНічого не видаляється.`)) return;
  const box = siBox();
  const log = [];
  let okStu = 0, okLink = 0;
  try{
    // 1. Учні. Кожен окремо: ключ генерує push(), і зібрати їх в один
    //    атомарний запис не вийде. Зате збій на одному не валить решту.
    const newSid = {};
    for(const s of siPlan.addStudents){
      try{
        const r = await push(ref(db, `students_list/${s.cls}`), s.name);
        newSid[`${s.cls}|${nameKey(s.name)}`] = r.key;
        okStu++;
      }catch(e){ log.push(`✕ ${s.name}: ${e.message}`); }
    }
    invalidateStudentDir();

    // 2. Прив'язки. parent_links/{пошта}/children — масив, тож дописуємо
    //    до наявного, а не перезаписуємо: у батьків може бути кілька дітей
    //    і одна з них уже прив'язана.
    const byEmail = {};
    siPlan.addLinks.forEach(l => { (byEmail[l.se] = byEmail[l.se] || []).push(l); });
    for(const se in byEmail){
      try{
        const snap = await get(child(ref(db), `parent_links/${se}`));
        const cur = snap.exists() ? (snap.val() || {}) : {};
        const kids = Array.isArray(cur.children) ? cur.children.slice()
                   : (cur.children ? Object.values(cur.children) : []);
        for(const l of byEmail[se]){
          const dir = await getStudentDir(l.cls);
          const sid = matchSid(dir, l.studentName) || newSid[`${l.cls}|${nameKey(l.studentName)}`] || '';
          kids.push({ studentId: sid, studentName: l.studentName, class: l.cls, role: 'guardian' });
          okLink++;
        }
        await update(ref(db, `parent_links/${se}`), { children: kids });
      }catch(e){ log.push(`✕ ${se}: ${e.message}`); }
    }

    logAction('students_import', { value:`учнів ${okStu}, прив'язок ${okLink}` });
    showToast(`✅ Додано учнів: ${okStu}, прив'язок: ${okLink}`);
    box.innerHTML = `<div class="si-sum"><b>Готово.</b> Учнів додано: ${okStu}, прив'язок батьків: ${okLink}.
        <span>Батьки заходять своєю поштою — пароль вони придумають самі при першому вході.</span></div>`
      + (log.length ? `<div class="si-warn"><b>Не вдалося:</b><br>${log.map(escHtml).join('<br>')}</div>` : '');
  }catch(e){
    box.innerHTML = `<div class="si-warn">Помилка: ${escHtml(e.message)}</div>`;
  }
};
