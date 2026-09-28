// ═══════════════════════════════════════════════════════════════
// role-blocks.js — блоки кабінету для прав із конструктора ролей.
//
// Кожне право (ROLE_PERMS у common.js) = один блок тут + рядок у
// PERM_READS у database.rules.gen.py. Блоки ЛИШЕ ПОКАЗУЮТЬ: жодної
// кнопки, що щось змінює. Навіть якщо хтось викличе запис із консолі,
// правила бази для цих прав запису не дають.
//
//   група 1 (дані відкриті всім, хто увійшов): bells, menu, clubs
//   група 2 (дані дітей, лише читання): birthdays, activities, attendance,
//            consents, meals_view, workload
// ═══════════════════════════════════════════════════════════════
import { ref, get, child, query, orderByKey, startAt, endAt } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, currentUserData, escHtml, escJs, localDateString, getClassNum, mondayOf,
         getUpcomingBirthdays, formatAttendanceSlotLabel, dayKeys } from './common.js';
import { ACTIVE_YEAR } from './director.js';
import { catalogList } from './subjects.js';
import { buildOrderRows, orderTotals, choicePair, breakfastChoicePair, absentSet, weekdayIdx } from './kitchen.js';
import { buildWorkload } from './workload.js';

const CLASSES = Array.from({ length: 11 }, (_, i) => `class_${i + 1}`);
const clsNum = c => String(c).replace('class_', '');
const clsOptions = sel => CLASSES.map(c => `<option value="${c}"${c === sel ? ' selected' : ''}>${clsNum(c)} клас</option>`).join('');
const humanDate = ds => String(ds || '').split('-').reverse().join('.');
const err = e => `<p class="empty-msg" style="color:var(--danger);">Не вдалося завантажити: ${escHtml(e && e.message || e)}</p>`;
const val = async p => { const s = await get(child(ref(db), p)); return s.exists() ? s.val() : null; };

// ── група 1 ──────────────────────────────────────────────────────
async function bells(body, cls){
  cls = cls || 'class_1';
  body.innerHTML = `<select aria-label="Клас" onchange="rbkRender('bells',this.value)">${clsOptions(cls)}</select><div class="rbk-out"><p class="empty-msg">Завантаження...</p></div>`;
  const out = body.querySelector('.rbk-out');
  try{
    const d = await val(`bell_schedules/${cls}`);
    if(!d){ out.innerHTML = '<p class="empty-msg">Розклад дзвінків ще не задано.</p>'; return; }
    const rows = Object.keys(d).sort((a, b) => (parseInt(a) || 0) - (parseInt(b) || 0)).map(k => d[k]).filter(Boolean);
    out.innerHTML = `<table class="os-table rbk-narrow"><thead><tr><th>Урок</th><th>Час</th></tr></thead><tbody>${rows.map(s =>
      `<tr><td class="os-num">${escHtml(s.number ?? '')}</td><td>${escHtml(s.start || '')} — ${escHtml(s.end || '')}</td></tr>`).join('')}</tbody></table>`;
  }catch(e){ out.innerHTML = err(e); }
}

const MENU_FIELDS = [['breakfast', 'Сніданок'], ['breakfast2', 'Сніданок (Б)'], ['first', 'Перше'], ['second', 'Друге'],
                     ['second2', 'Друге (Б)'], ['side', 'Гарнір'], ['side2', 'Гарнір (Б)'], ['snack', 'Підвечірок']];
export function weekOf(dateStr){
  const m = mondayOf(dateStr);
  const [y, mo, d] = m.split('-').map(Number);
  return Array.from({ length: 5 }, (_, i) => { const x = new Date(y, mo - 1, d + i); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; });
}
async function menu(body){
  body.innerHTML = '<p class="empty-msg">Завантаження...</p>';
  try{
    const dates = weekOf(localDateString);
    const days = await Promise.all(dates.map(d => val(`menu/${d}`)));
    const WD = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт'];
    const cards = dates.map((d, i) => {
      const m = days[i] || {};
      const items = MENU_FIELDS.filter(([k]) => String(m[k] || '').trim()).map(([k, l]) => `<div><small>${l}</small> ${escHtml(m[k])}</div>`).join('');
      return `<div class="rbk-day${d === localDateString ? ' today' : ''}"><b>${WD[i]}, ${escHtml(humanDate(d).slice(0, 5))}</b>${items || '<div class="empty-msg">меню ще немає</div>'}</div>`;
    }).join('');
    body.innerHTML = `<div class="rbk-days">${cards}</div>`;
  }catch(e){ body.innerHTML = err(e); }
}

async function clubs(body){
  body.innerHTML = '<p class="empty-msg">Завантаження...</p>';
  try{
    const all = await val(`clubs_catalog/${ACTIVE_YEAR}`) || {};
    const rows = [];
    for(const cls of CLASSES) for(const e of catalogList(all[cls] || {}))
      rows.push(`<tr><td class="os-num">${clsNum(cls)}</td><td>${escHtml(e.name)}</td><td>${escHtml(e.teacherName || '—')}</td></tr>`);
    body.innerHTML = rows.length
      ? `<div class="os-wrap"><table class="os-table"><thead><tr><th>Клас</th><th>Гурток</th><th>Керівник</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`
      : '<p class="empty-msg">Гуртків у каталозі цього року ще немає.</p>';
  }catch(e){ body.innerHTML = err(e); }
}

// ── група 2 ──────────────────────────────────────────────────────
// Дні народження всієї школи на місяць уперед. Та сама функція, що в
// кабінеті класу: лише день і місяць, без року.
async function birthdays(body){
  body.innerHTML = '<p class="empty-msg">Завантаження...</p>';
  try{
    const per = await Promise.all(CLASSES.map(c => getUpcomingBirthdays(c, localDateString, 30).then(l => l.map(b => ({ ...b, cls: c }))).catch(() => [])));
    const list = per.flat().sort((a, b) => a.idx - b.idx || getClassNum(a.cls) - getClassNum(b.cls) || String(a.name).localeCompare(String(b.name), 'uk'));
    body.innerHTML = list.length ? list.map(b => `<div class="bd-row${b.today ? ' bd-today' : ''}">
        <span class="bd-name">${b.today ? '🎉 ' : ''}${escHtml(b.name)} <small>· ${clsNum(b.cls)} клас</small></span>
        <span class="bd-date">${escHtml(b.label)} <i class="bd-when${b.idx <= 7 ? ' soon' : ''}">${escHtml(b.when)}</i></span></div>`).join('')
      : '<p class="empty-msg">Найближчого місяця днів народження немає.</p>';
  }catch(e){ body.innerHTML = err(e); }
}

async function activities(body){
  body.innerHTML = '<div id="rbk-act-box"><p class="empty-msg">Завантаження...</p></div>';
  if(window.renderActivitySummary) await window.renderActivitySummary('rbk-act-box', 'school');
}

// Відвідуваність за день по всій школі: хто відсутній і хто запізнюється.
export function attendanceRows(att, names){
  const out = [];
  for(const cls of CLASSES){
    const day = (att || {})[cls] || {};
    for(const [key, slots] of Object.entries(day)){
      for(const [slot, r] of Object.entries(slots || {})){
        if(!r || (r.status !== 'absent' && r.status !== 'late')) continue;
        out.push({ cls, key, name: (names[cls] || {})[key] || key, slot, status: r.status, reason: r.reason || '',
                   by: r.markedBy === 'parent' || r.markedBy === 'student' ? 'родина' : 'школа' });
      }
    }
  }
  return out.sort((a, b) => getClassNum(a.cls) - getClassNum(b.cls) || String(a.name).localeCompare(String(b.name), 'uk'));
}
async function attendance(body, date){
  date = date || localDateString;
  body.innerHTML = `<input type="date" value="${escHtml(date)}" aria-label="Дата" onchange="rbkRender('attendance',this.value)"><div class="rbk-out"><p class="empty-msg">Завантаження...</p></div>`;
  const out = body.querySelector('.rbk-out');
  try{
    const [names, ...days] = await Promise.all([val('students_list'), ...CLASSES.map(c => val(`attendance/${c}/${date}`))]);
    const att = {}; CLASSES.forEach((c, i) => { if(days[i]) att[c] = days[i]; });
    const rows = attendanceRows(att, names || {});
    const abs = rows.filter(r => r.status === 'absent').length, late = rows.length - abs;
    out.innerHTML = `<p class="rbk-sum">🚨 Відсутні: <b>${abs}</b> · ⏰ Запізнення: <b>${late}</b></p>` + (rows.length
      ? `<div class="os-wrap"><table class="os-table"><thead><tr><th>Клас</th><th>Учень</th><th>Що</th><th>Коли</th><th>Причина</th><th>Повідомила</th></tr></thead><tbody>${rows.map(r =>
        `<tr><td class="os-num">${clsNum(r.cls)}</td><td>${escHtml(r.name)}</td><td>${r.status === 'absent' ? '🚨 відсутній' : '⏰ запізнення'}</td><td>${escHtml(formatAttendanceSlotLabel(r.slot))}</td><td>${escHtml(r.reason)}</td><td>${r.by}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="empty-msg">Цього дня відміток немає.</p>');
  }catch(e){ out.innerHTML = err(e); }
}

async function consents(body, id){
  body.innerHTML = '<p class="empty-msg">Завантаження...</p>';
  try{
    const [all, students] = await Promise.all([val('consents'), val('students_list')]);
    if(!all){ body.innerHTML = '<p class="empty-msg">Запитів на згоду ще немає.</p>'; return; }
    const st = students || {};
    const classesOf = c => Array.isArray(c.classes) ? c.classes : (c.classes === 'all' ? Object.keys(st) : Object.values(c.classes || {}));
    if(id && all[id]){
      const c = all[id], resp = await val(`consent_responses/${id}`) || {};
      let h = `<button type="button" class="cm-print" onclick="rbkRender('consents')">← Усі запити</button><h4 style="margin:8px 0;">${escHtml(c.title || '')}</h4>`;
      for(const cls of classesOf(c)){
        const pairs = Object.entries(st[cls] || {}).map(([sid, nm]) => ({ sid, nm: String(nm) })).sort((a, b) => a.nm.localeCompare(b.nm, 'uk'));
        const r = resp[cls] || {};
        h += `<div class="cs-cls">${clsNum(cls)} клас</div>` + pairs.map(p => {
          const a = (r[p.sid] || r[p.nm] || {}).answer;
          return `<div class="cs-row"><span>${escHtml(p.nm)}</span><span class="${a === 'yes' ? 'cs-yes' : a === 'no' ? 'cs-no' : 'cs-wait'}">${a === 'yes' ? '✓ згода' : a === 'no' ? '✕ відмова' : 'очікуємо'}</span></div>`;
        }).join('');
      }
      body.innerHTML = h;
      return;
    }
    const resp = await val('consent_responses') || {};
    const ids = Object.keys(all).sort((a, b) => (all[b].createdAt || 0) - (all[a].createdAt || 0));
    body.innerHTML = ids.map(i => {
      const c = all[i], cls = classesOf(c);
      let total = 0, yes = 0, no = 0;
      cls.forEach(k => { total += Object.keys(st[k] || {}).length; for(const x of Object.values((resp[i] || {})[k] || {})){ if(x && x.answer === 'yes') yes++; else if(x && x.answer === 'no') no++; } });
      return `<div class="cs-card"><b>${escHtml(c.title || '—')}</b>
        <div class="cs-meta">${escHtml(cls.map(clsNum).join(', '))} кл.${c.deadline ? ` · до ${escHtml(humanDate(c.deadline))}` : ''}</div>
        <div class="cs-stats"><span class="cs-yes">✓ ${yes}</span> <span class="cs-no">✕ ${no}</span> <span class="cs-wait">очікуємо ${Math.max(0, total - yes - no)}</span></div>
        <button type="button" class="cs-detail" onclick="rbkRender('consents','${escJs(i)}')">Хто як відповів →</button></div>`;
    }).join('');
  }catch(e){ body.innerHTML = err(e); }
}

// Скільки порцій на день по класах — та сама логіка, що в кухні
// (buildOrderRows), але без імен і без кнопок правки.
async function meals_view(body, date){
  date = date || localDateString;
  body.innerHTML = `<input type="date" value="${escHtml(date)}" aria-label="Дата" onchange="rbkRender('meals_view',this.value)"><div class="rbk-out"><p class="empty-msg">Рахую...</p></div>`;
  const out = body.querySelector('.rbk-out');
  try{
    const [students, plans, days, menuDay, ...att] = await Promise.all([val('students_list'), val('meal_plan'), val(`meal_day/${date}`), val(`menu/${date}`),
      ...CLASSES.map(c => val(`attendance/${c}/${date}`))]);
    const m = menuDay || {}, hasChoice = !!choicePair(m), hasBrk = !!breakfastChoicePair(m), wd = weekdayIdx(date);
    const per = CLASSES.filter(c => (students || {})[c]).map((c, i) => {
      const rows = buildOrderRows(c, students[c], (plans || {})[c] || {}, (days || {})[c] || {}, absentSet(att[CLASSES.indexOf(c)]), wd, m, hasChoice, hasBrk);
      return { cls: c, t: orderTotals(rows) };
    });
    const sum = f => per.reduce((n, x) => n + x.t[f], 0);
    out.innerHTML = `<p class="rbk-sum">🍳 Сніданків: <b>${sum('brk')}</b> · 🍲 Обідів: <b>${sum('lunch')}</b> · 🥛 Підвечірків: <b>${sum('snack')}</b> · 🚨 Відсутні: <b>${sum('absent')}</b></p>
      <div class="os-wrap"><table class="os-table"><thead><tr><th>Клас</th><th>Сніданок</th><th>Обід${hasChoice ? ' (А/Б)' : ''}</th><th>Підвечірок</th><th>Відсутні</th><th>Без відповіді</th></tr></thead><tbody>${per.map(x =>
      `<tr><td class="os-num">${clsNum(x.cls)}</td><td>${x.t.brk}</td><td>${x.t.lunch}${hasChoice ? ` (${x.t.pa}/${x.t.pb})` : ''}</td><td>${x.t.snack}</td><td>${x.t.absent}</td><td>${x.t.noReply}</td></tr>`).join('')}</tbody></table></div>
      ${menuDay ? '' : '<p class="cm-hint">Меню на цей день ще немає.</p>'}`;
  }catch(e){ out.innerHTML = err(e); }
}

// Навантаження вчителів за тиждень. Та сама функція, що в директора, але
// без вузла users: імена беремо з довідника персоналу, а теми уроків не
// читаємо — тому колонки «без тем» тут немає.
async function workload(body, date){
  const monday = mondayOf(date || localDateString);
  body.innerHTML = `<input type="date" value="${escHtml(monday)}" aria-label="Тиждень" onchange="rbkRender('workload',this.value)"><div class="rbk-out"><p class="empty-msg">Рахую...</p></div>`;
  const out = body.querySelector('.rbk-out');
  try{
    const dates = weekOf(monday);
    const [schedules, catalogs, dir, access, choices, subsSnap, calendar] = await Promise.all([
      val('schedules'), val('subjects_catalog'), val('staff_directory'), val('teacher_access'), val('schedule_alt'),
      get(query(ref(db, 'substitutions'), orderByKey(), startAt(dates[0]), endAt(dates[4]))), val(`academic_year/${ACTIVE_YEAR}`)]);
    const users = {};
    for(const [se, d] of Object.entries(dir || {}))
      // У довіднику одна роль — перша службова. Учитель, який ще й директор,
      // значився б «директором» і випав би з навантаження. Тому вчителем
      // вважаємо кожного, у кого в картці є класи з предметами.
      if(d && d.name){ const r = d.classes && Object.keys(d.classes).length ? 'teacher' : (d.role || ''); users[se] = { email: se.replace(/_/g, '.'), firstName: d.name, role: r, roles: [r] }; }
    const res = buildWorkload({ schedules: schedules || {}, catalogs: catalogs || {}, users, access: access || {}, choices: choices || {},
      subs: subsSnap.exists() ? subsSnap.val() : {}, topics: {}, calendar: calendar || {} }, monday, localDateString, ACTIVE_YEAR);
    const dur = m => `${Math.floor(m / 60)} год ${m % 60} хв`;
    const rows = res.teachers.filter(t => t.lessons.length || t.possible.length);
    out.innerHTML = rows.length
      ? `<p class="rbk-sum">Тиждень з ${escHtml(humanDate(monday))} · учителів: <b>${rows.length}</b></p><div class="os-wrap"><table class="os-table"><thead><tr><th>Учитель</th><th>Занять</th><th>Тривалість</th><th>Класів</th><th>Накладки</th></tr></thead><tbody>${rows.map(t =>
        `<tr><td>${escHtml(t.name)}</td><td>${t.lessons.length}${t.possible.length ? `–${t.lessons.length + t.possible.length}` : ''}</td><td>${dur(t.lessons.reduce((n, l) => n + l.minutes, 0))}</td><td>${new Set(t.lessons.map(l => l.cls)).size}</td><td>${t.conflicts.length ? `<b style="color:var(--danger);">${t.conflicts.length}</b>` : '0'}</td></tr>`).join('')}</tbody></table></div>`
        + (res.issues.length ? `<p class="cm-hint">Уроків без визначеного вчителя: ${res.issues.length}.</p>` : '')
      : '<p class="empty-msg">На цьому тижні занять не знайдено.</p>';
  }catch(e){ out.innerHTML = err(e); }
}

export const BLOCKS = {
  bells:      { title: '🔔 Розклад дзвінків', render: bells },
  menu:       { title: '🍽 Меню їдальні на тиждень', render: menu },
  clubs:      { title: '🎨 Гуртки', render: clubs },
  birthdays:  { title: '🎂 Дні народження школи', render: birthdays },
  activities: { title: '🏊 Басейн і автобус', render: activities },
  attendance: { title: '📋 Відвідуваність', render: attendance },
  consents:   { title: '✍️ Згоди батьків', render: consents },
  meals_view: { title: '🍲 Зведення харчування', render: meals_view },
  workload:   { title: '⚖️ Навантаження вчителів', render: workload }
};

window.rbkRender = function(key, arg){
  const b = BLOCKS[key], body = document.querySelector(`#rbk-${key} .rbk-body`);
  if(b && body) return b.render(body, arg);
};

// Блоки для поточної ролі. Картки створюються лише для прав, які є.
export function renderRoleBlocks(containerId, role){
  const box = document.getElementById(containerId);
  if(!box) return [];
  const has = p => !!(window.hasPerm && window.hasPerm(p, role));
  const keys = Object.keys(BLOCKS).filter(has);
  box.innerHTML = keys.map(k => `<section class="screen-section"><div class="data-card" id="rbk-${k}">
      <h3 style="margin-top:0;">${BLOCKS[k].title}</h3><div class="rbk-body"></div></div></section>`).join('');
  keys.forEach(k => window.rbkRender(k));
  return keys;
}
window.renderRoleBlocks = renderRoleBlocks;
