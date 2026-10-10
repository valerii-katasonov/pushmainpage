// ═══════════════════════════════════════════════════════════════
// family-week.js — для батьків і учня: «📚 Що пропущено» і «📊 Тиждень коротко».
//
// ЩО ПРОПУЩЕНО. Дитина хворіла — батько збирав теми й ДЗ по днях або питав
// у чаті класу. Тут портал сам бере дні відсутності за три тижні й для
// кожного показує теми уроків і ДЗ з усіх предметів цього дня. Якщо дитини
// не було лише на кількох уроках — показуємо весь день із позначкою, які
// уроки пропущено: точно звʼязати номер уроку з предметом не завжди можна
// (перерви, чергування), а зайвий предмет у списку не шкодить.
//
// ТИЖДЕНЬ КОРОТКО. Оцінки цього тижня по предметах, пропуски й запізнення,
// контрольні наступного тижня. Один спокійний підсумок замість потоку.
// Той самий підсумок у пʼятницю приходить push-ем (netlify/functions/
// week-digest.js) і відкриває кабінет саме тут.
//
// Нічого не пишемо в базу — лише читаємо те, що родині й так відкрито.
// ═══════════════════════════════════════════════════════════════
import { ref, get, child, query, orderByKey, startAt, endAt, limitToLast } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, currentUserData, escHtml, localDateString, mondayOf, dayKeys, dayNamesUA, displayGrade,
         getStudentDir, resolveStudentKey, planKeyWith, subjKey } from './common.js';
import { topicNames } from './parent-student.js';

export const LOOKBACK_DAYS = 21;
const p2 = n => String(n).padStart(2, '0');
const isoOf = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
export function addDays(ds, n){ const [y, m, d] = ds.split('-').map(Number); return isoOf(new Date(y, m - 1, d + n)); }
const isWeekday = ds => { const [y, m, d] = ds.split('-').map(Number); const w = new Date(y, m - 1, d).getDay(); return w >= 1 && w <= 5; };
export function schoolDaysBetween(from, to){ const out = []; for(let d = from; d <= to; d = addDays(d, 1)) if(isWeekday(d)) out.push(d); return out; }
export function dayTitle(ds){
  const [y, m, d] = ds.split('-').map(Number);
  return `${dayNamesUA[dayKeys[new Date(y, m - 1, d).getDay()]] || ''}, ${p2(d)}.${p2(m)}`;
}
const val = async p => { const s = await get(child(ref(db), p)); return s.exists() ? s.val() : null; };

// Відмітки дитини за день → {absent, late, slots:[номери уроків]}
export function dayStatus(rec){
  const out = { absent: false, allDay: false, late: false, slots: [] };
  for(const [slot, r] of Object.entries(rec || {})){
    if(!r || typeof r !== 'object') continue;
    if(r.status === 'absent'){ out.absent = true; if(slot === 'all') out.allDay = true; else out.slots.push(slot); }
    if(r.status === 'late') out.late = true;
  }
  out.slots.sort((a, b) => Number(a) - Number(b));
  return out;
}

// Дитина і її ключ у базі — тим самим способом, що й решта кабінету
async function who(){
  const u = currentUserData || {};
  const cls = u.class;
  if(!cls) return null;
  let dir = null; try{ dir = await getStudentDir(cls); }catch(e){}
  const { key } = resolveStudentKey(dir, u.studentId, u.studentName);
  return { cls, key: key || u.studentId || u.studentName, name: u.studentName || '' };
}

// Відмітки за період — по днях і ЛИШЕ своєї дитини. Читаємо саме її гілку
// (за ключем і, для старих записів, за імʼям), а не весь день класу: інакше
// в браузер батька завантажувалися б відмітки й причини інших дітей.
async function attendanceFor(cls, key, name, dates){
  const keys = [...new Set([key, name].filter(Boolean))];
  const days = await Promise.all(dates.map(d => Promise.all(keys.map(k => val(`attendance/${cls}/${d}/${k}`).catch(() => null)))));
  const out = {};
  dates.forEach((d, i) => { const r = days[i].find(Boolean); if(r) out[d] = dayStatus(r); });
  return out;
}

// ── ЩО ПРОПУЩЕНО ──
export function catchUpDays(statusByDate, topicsBySk, hwByDate, plans, aliases){
  return Object.entries(statusByDate).filter(([, s]) => s.absent).sort((a, b) => b[0].localeCompare(a[0])).map(([date, s]) => {
    const subjects = new Map();
    for(const [sk, byDate] of Object.entries(topicsBySk || {})){
      const t = topicNames(byDate && byDate[date], plans && plans[planKeyWith(aliases, sk)]);
      if(t) subjects.set(sk, { subject: sk, topic: t, hw: null });
    }
    for(const [subj, rec] of Object.entries((hwByDate || {})[date] || {})){
      const text = String(rec && rec.text || '').trim(), files = rec && rec.images ? Object.keys(rec.images).length : 0;
      if(!text && !files) continue;
      // Теми лежать під очищеним ключем предмета, ДЗ — під назвою: звіряємо через subjKey
      const sk = subjKey(subj);
      const cur = subjects.get(sk) || { subject: subj, topic: '' };
      cur.subject = subj;            // назва з ДЗ читабельніша за ключ
      cur.hw = { text, files, pages: rec.pages || '' };
      subjects.set(sk, cur);
    }
    return { date, allDay: s.allDay, slots: s.slots, items: [...subjects.values()].sort((a, b) => a.subject.localeCompare(b.subject, 'uk')) };
  });
}
export function catchUpHtml(days){
  if(!days.length) return '';
  // Згорнуто за замовчуванням — і сам блок, і кожен день: це довідка на
  // випадок потреби, а не те, що має займати пів «Сьогодні».
  return `<details class="fw-catch-all"><summary><span class="fw-title">📚 Що пропущено</span> <span class="fw-sub">за ${LOOKBACK_DAYS} днів: ${days.length} ${days.length === 1 ? 'день' : days.length < 5 ? 'дні' : 'днів'}</span></summary>`
    + days.map(d => `<details class="fw-day">
      <summary><b>${escHtml(dayTitle(d.date))}</b> — ${d.allDay ? 'не було весь день' : `пропущено уроки: ${escHtml(d.slots.join(', '))}`}
        <span class="fw-count">${d.items.length ? `${d.items.length} предм.` : ''}</span></summary>
      ${d.items.length ? `<ul class="fw-list">${d.items.map(it => `<li><b>${escHtml(it.subject)}</b>
          ${it.topic ? `<div>📖 ${escHtml(it.topic)}</div>` : ''}
          ${it.hw ? `<div>📝 ${escHtml(it.hw.text.length > 220 ? it.hw.text.slice(0, 220) + '…' : it.hw.text)}${it.hw.files ? ` <span class="fw-sub">(файлів: ${it.hw.files})</span>` : ''}</div>` : ''}</li>`).join('')}</ul>
          ${d.allDay ? '' : '<p class="fw-note">Показано всі предмети дня — не лише пропущені уроки.</p>'}`
        : '<p class="fw-note">Учителі ще не внесли теми й ДЗ за цей день.</p>'}
    </details>`).join('')
    + '<p class="fw-note">Повне ДЗ з файлами — у вкладці «📚 ДЗ».</p></details>';
}
export async function renderCatchUp(boxId){
  const box = document.getElementById(boxId);
  if(!box) return;
  try{
    const me = await who();
    if(!me){ box.style.display = 'none'; return; }
    const from = addDays(localDateString, -LOOKBACK_DAYS);
    const status = await attendanceFor(me.cls, me.key, me.name, schoolDaysBetween(from, localDateString));
    const absentDates = Object.keys(status).filter(d => status[d].absent).sort();
    if(!absentDates.length){ box.style.display = 'none'; box.innerHTML = ''; return; }
    const [topics, plans, aliases, hw] = await Promise.all([
      val(`lesson_topics/${me.cls}`), val(`curriculum_plans/${me.cls}`).catch(() => null), val(`curriculum_aliases/${me.cls}`).catch(() => null),
      get(query(ref(db, `homeworks/${me.cls}`), orderByKey(), startAt(absentDates[0]), endAt(absentDates.at(-1)))).then(s => s.exists() ? s.val() : {})
    ]);
    box.innerHTML = catchUpHtml(catchUpDays(status, topics || {}, hw, plans || {}, aliases || {}));
    box.style.display = 'block';
  }catch(e){
    console.warn('[Push School] що пропущено:', e.message);
    box.style.display = 'none';
  }
}

// ── ТИЖДЕНЬ КОРОТКО ──
// grades: дзеркало student_grades/{клас}/{учень}/{місяць}/{предмет}/{ключ дня} = {v, t}
export function weekGrades(mirror, from, to){
  const out = {};
  for(const subs of Object.values(mirror || {}))
    for(const [subj, days] of Object.entries(subs || {}))
      for(const [k, g] of Object.entries(days || {})){
        const d = String(k).slice(0, 10), v = g && typeof g === 'object' ? g.v : g;
        if(d < from || d > to || v === undefined || v === null || v === '') continue;
        (out[subj] ||= []).push({ date: d, v });
      }
  for(const list of Object.values(out)) list.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}
export function upcomingExams(examsByMonth, from, to){
  const out = [];
  for(const days of Object.values(examsByMonth || {}))
    for(const [d, subs] of Object.entries(days || {}))
      if(d >= from && d <= to) for(const s of Object.keys(subs || {})) out.push({ date: d, subject: s });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
export function digestHtml({ grades, status, exams, cls }){
  const subj = Object.keys(grades).sort((a, b) => a.localeCompare(b, 'uk'));
  const n = subj.reduce((k, s) => k + grades[s].length, 0);
  const abs = Object.values(status).filter(s => s.absent).length, late = Object.values(status).filter(s => s.late).length;
  const WD = ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const wd = ds => { const [y, m, d] = ds.split('-').map(Number); return `${WD[new Date(y, m - 1, d).getDay()]} ${p2(d)}.${p2(m)}`; };
  return `<div class="fw-title">📊 Тиждень коротко</div>
    <div class="fw-stats"><span>📝 Оцінок: <b>${n}</b></span><span>🚨 Днів із пропусками: <b>${abs}</b></span><span>⏰ Запізнень: <b>${late}</b></span><span>📅 Контрольних попереду: <b>${exams.length}</b></span></div>
    ${n ? `<ul class="fw-list">${subj.map(s => `<li><b>${escHtml(s)}</b>: ${grades[s].map(g => `<span class="fw-grade" title="${escHtml(wd(g.date))}">${escHtml(displayGrade(g.v, cls))}</span>`).join(' ')}</li>`).join('')}</ul>` : '<p class="fw-note">Цього тижня оцінок ще немає.</p>'}
    ${exams.length ? `<p class="fw-exams"><b>Наступного тижня:</b> ${exams.map(e => `${escHtml(e.subject)} (${escHtml(wd(e.date))})`).join(', ')}</p>` : ''}`;
}
export async function renderWeekDigest(boxId){
  const box = document.getElementById(boxId);
  if(!box) return;
  try{
    const me = await who();
    if(!me){ box.style.display = 'none'; return; }
    const monday = mondayOf(localDateString), friday = addDays(monday, 4);
    const nextMon = addDays(monday, 7), nextFri = addDays(monday, 11);
    const months = [...new Set([monday.slice(0, 7), friday.slice(0, 7)])], exMonths = [...new Set([nextMon.slice(0, 7), nextFri.slice(0, 7)])];
    const [mirrors, status, exams] = await Promise.all([
      Promise.all(months.map(m => val(`student_grades/${me.cls}/${me.key}/${m}`).catch(() => null))),
      attendanceFor(me.cls, me.key, me.name, schoolDaysBetween(monday, localDateString < friday ? localDateString : friday)),
      Promise.all(exMonths.map(m => val(`exams/${me.cls}/${m}`).catch(() => null)))
    ]);
    const mirror = {}; months.forEach((m, i) => { if(mirrors[i]) mirror[m] = mirrors[i]; });
    const exMap = {}; exMonths.forEach((m, i) => { if(exams[i]) exMap[m] = exams[i]; });
    box.innerHTML = digestHtml({ grades: weekGrades(mirror, monday, friday), status, exams: upcomingExams(exMap, nextMon, nextFri), cls: me.cls });
    box.style.display = 'block';
  }catch(e){
    console.warn('[Push School] тиждень коротко:', e.message);
    box.style.display = 'none';
  }
}
// ── ЗМІНИ В РОЗКЛАДІ ──
// schedule_changes/{клас} пише серверна функція schedule-changes разом із
// push-ем. Тут — те саме на «Сьогодні» ще SCHED_DAYS днів: сповіщення легко
// змахнути, не прочитавши.
export const SCHED_DAYS = 7;
// seenTs — до якої зміни людина вже бачила блок (у попередній вхід).
// Нове — розгорнуте; уже бачене — згорнуте в один рядок «переглянуто».
export function schedChangesHtml(entries, now = Date.now(), seenTs = 0){
  const fresh = Object.values(entries || {}).filter(e => e && Array.isArray(e.lines) && now - (Number(e.ts) || 0) < SCHED_DAYS * 864e5)
    .sort((a, b) => b.ts - a.ts);
  if(!fresh.length) return '';
  const dm = ts => { const d = new Date(ts); return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}`; };
  const li = list => list.flatMap(e => e.lines.map(l => `<li><span class="fw-sub">${escHtml(dm(e.ts))}</span> ${escHtml(l)}</li>`)).join('');
  const nw = fresh.filter(e => (Number(e.ts) || 0) > seenTs), old = fresh.filter(e => (Number(e.ts) || 0) <= seenTs);
  const nOld = old.reduce((k, e) => k + e.lines.length, 0);
  if(!nw.length){
    return `<details class="fw-fold"><summary class="fw-title">📅 Зміни в розкладі <span class="fw-seen">${nOld} · переглянуто</span></summary>`
      + `<ul class="fw-list">${li(old)}</ul></details>`;
  }
  return `<div class="fw-title">📅 Зміни в розкладі</div><ul class="fw-list">${li(nw)}</ul>`
    + (old.length ? `<details class="fw-fold fw-fold-sub"><summary>ще ${nOld} — переглянуті раніше</summary><ul class="fw-list">${li(old)}</ul></details>` : '');
}
// Що з цього людина вже бачила — на цьому пристрої, окремо для кожного класу.
// Знімок беремо при завантаженні: показане зараз згортається з НАСТУПНОГО входу.
const SCHED_SEEN_LS = 'push_school_sched_seen';
const schedSeenMap = () => { try{ return JSON.parse(localStorage.getItem(SCHED_SEEN_LS) || '{}') || {}; }catch(e){ return {}; } };
const SCHED_SEEN_START = schedSeenMap();
export async function renderSchedChanges(boxId){
  const box = document.getElementById(boxId);
  if(!box) return;
  try{
    const cls = currentUserData && currentUserData.class;
    if(!cls){ box.style.display = 'none'; return; }
    const s = await get(query(ref(db, `schedule_changes/${cls}`), orderByKey(), limitToLast(5)));
    const entries = s.exists() ? s.val() : {};
    const html = schedChangesHtml(entries, Date.now(), Number(SCHED_SEEN_START[cls]) || 0);
    box.innerHTML = html;
    box.style.display = html ? 'block' : 'none';
    // Показали — запамʼятовуємо найновішу зміну як «переглянуту»
    const top = Math.max(0, ...Object.values(entries).map(e => Number(e && e.ts) || 0));
    if(html && top){ const m = schedSeenMap(); if((Number(m[cls]) || 0) < top){ m[cls] = top; try{ localStorage.setItem(SCHED_SEEN_LS, JSON.stringify(m)); }catch(e){} } }
  }catch(e){ box.style.display = 'none'; }
}
window.renderSchedChanges = renderSchedChanges;
window.renderCatchUp = renderCatchUp;
window.renderWeekDigest = renderWeekDigest;
