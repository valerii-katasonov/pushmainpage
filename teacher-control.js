// ═══════════════════════════════════════════════════════════════
// teacher-control.js — «🔍 Контроль»: як учителі ведуть журнал.
//
// ЩО ПЕРЕВІРЯЄМО (по кожному уроку, що ВЖЕ відбувся)
//   • тема уроку відмічена?          lesson_topics/{клас}/{предмет}/{дата}
//   • ДЗ задане?                      homeworks/{клас}/{дата}/{предмет}
//       ключ — дата УРОКУ, на якому задали (див. homework.js);
//       ts запису — коли внесли: пізніше за день уроку = «внесено пізно»
//   • давно не було оцінок з предмета в класі      grades/{клас}/{місяць}/…
//   • перевантаження ДЗ: забагато завдань класу на один день
//
// ХТО ВЕДЕ УРОК — з buildWorkload (workload.js): та сама логіка, що в
// «Навантаженні», з урахуванням замін, чергувань, свят і канікул. Тож
// урок, який провів замінний учитель, рахується йому, а не основному.
//
// «УЖЕ ВІДБУВСЯ»: минула дата, або сьогодні й час закінчення минув. Урок
// без часу в розкладі сьогодні не рахуємо — невідомо, чи він уже був.
//
// ГОЛОС БАТЬКІВ (лише зведення, без імен і текстів):
//   • запити «💬 Хочу обговорити» без відповіді понад 3 дні — кому з учителів
//     (talk_requests: предмет, дата, статус; текст директорові не відкрито)
//   • навантаження ДЗ очима батьків по класу (hw_load), від 3 відповідей
//
// ВИНЯТКИ (control_settings): класи й предмети без ДЗ (1 клас, фізкультура
// тощо) — там відсутність ДЗ не порушення. Налаштовує директор.
// ═══════════════════════════════════════════════════════════════
import { ref, get, set, child, query, orderByKey, startAt, endAt } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, currentUserData, escHtml, escJs, showToast, localDateString, getClassNum, mondayOf, subjKey,
         emailKey, notifyEvent, journalBaseDate, logAction } from './common.js';
import { ACTIVE_YEAR } from './director.js';
import { buildWorkload, workloadDates } from './workload.js';

const CLASSES = Array.from({ length: 11 }, (_, i) => `class_${i + 1}`);
export const CONTROL_DEFAULTS = {
  noHwClasses: ['class_1'],
  noHwSubjects: ['Фізична культура', 'Фізкультура', 'Музичне мистецтво', 'Образотворче мистецтво', 'Мистецтво', 'Хореографія'],
  gradeGapDays: 14,
  maxHwPerDay: 6
};
const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const p2 = n => String(n).padStart(2, '0');
const isoOf = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
export function addDays(ds, n){ const [y, m, d] = ds.split('-').map(Number); return isoOf(new Date(y, m - 1, d + n)); }
export function daysBetween(a, b){ const t = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); }; return Math.round((t(b) - t(a)) / 864e5); }
const human = ds => String(ds || '').split('-').reverse().join('.').slice(0, 5);
const clsLabel = c => String(c).replace('class_', '') + ' кл.';

export function hwExempt(settings, cls, subject){
  const s = { ...CONTROL_DEFAULTS, ...(settings || {}) };
  const classes = Array.isArray(s.noHwClasses) ? s.noHwClasses : Object.values(s.noHwClasses || {});
  const subjects = (Array.isArray(s.noHwSubjects) ? s.noHwSubjects : Object.values(s.noHwSubjects || {})).map(norm).filter(Boolean);
  const n = norm(subject);
  return classes.includes(cls) || subjects.some(x => n === x || n.startsWith(x));
}
function topicFilled(topics, cls, subject, date){
  const rec = topics?.[cls]?.[subjKey(subject)]?.[date];
  const entries = typeof rec === 'string' ? [{ customText: rec }] : Array.isArray(rec?.topics) ? rec.topics : rec ? Object.values(rec.topics || { a: rec }) : [];
  return entries.some(t => t && (t.topicId || String(t.customText || '').trim()));
}
function hwRecord(homeworks, cls, date, subject){
  const day = homeworks?.[cls]?.[date];
  if(!day) return null;
  if(day[subject]) return day[subject];
  const k = Object.keys(day).find(x => subjKey(x) === subjKey(subject) || norm(x) === norm(subject));
  return k ? day[k] : null;
}
const hwNonEmpty = r => !!(r && (String(r.text || '').trim() || (r.images && Object.keys(r.images).length)));
// Кінець дня уроку за місцевим часом — «внесено пізно», якщо ts пізніше
function dayEndTs(ds){ const [y, m, d] = ds.split('-').map(Number); return new Date(y, m - 1, d, 23, 59, 59).getTime(); }

// Останній день з оцінкою для «клас|предмет»
export function lastGradeDates(grades){
  const out = {};
  for(const [cls, months] of Object.entries(grades || {}))
    for(const subs of Object.values(months || {}))
      for(const [subj, days] of Object.entries(subs || {}))
        for(const [key, row] of Object.entries(days || {})){
          if(!row || typeof row !== 'object' || !Object.keys(row).length) continue;
          const d = journalBaseDate(key), k = `${cls}|${subjKey(subj)}`;
          if(!out[k] || out[k] < d) out[k] = d;
        }
  return out;
}

// ── ГОЛОС БАТЬКІВ ──
export const TALK_LATE_DAYS = 3, HW_LOAD_MIN = 3;
// Учителі предмета в класі за матрицею доступу; немає — класний керівник
// (так само вибирає адресатів сервер у notify.js)
export function subjectTeacherKeys(access, heads, cls, subject){
  const want = norm(subject), out = [];
  for(const [key, row] of Object.entries(access || {})){
    const raw = row && row[cls];
    const list = (Array.isArray(raw) ? raw : Object.values(raw || {})).filter(v => typeof v === 'string');
    if(list.some(v => v.trim() === 'Всі предмети' || norm(v) === want)) out.push(key);
  }
  if(!out.length && heads?.[cls]?.teacherEmail) out.push(emailKey(heads[cls].teacherEmail));
  return [...new Set(out)];
}
// talk_requests/{клас}/{батько}/{id} → [{key, items:[{cls, subject, days}]}]
export function talkOverdue(talk, access, heads, now, lateDays = TALK_LATE_DAYS){
  const by = new Map();
  for(const [cls, parents] of Object.entries(talk || {}))
    for(const reqs of Object.values(parents || {}))
      for(const r of Object.values(reqs || {})){
        if(!r || r.status !== 'open') continue;
        const days = Math.floor((now - (Number(r.ts) || 0)) / 864e5);
        if(days < lateDays) continue;
        const keys = subjectTeacherKeys(access, heads, cls, r.subject);
        for(const k of keys.length ? keys : ['—']){
          const cur = by.get(k) || { key: k, items: [] };
          cur.items.push({ cls, subject: String(r.subject || ''), days });
          by.set(k, cur);
        }
      }
  return [...by.values()].map(x => ({ ...x, items: x.items.sort((a, b) => b.days - a.days) }))
    .sort((a, b) => b.items.length - a.items.length || b.items[0].days - a.items[0].days);
}
// hw_load/{клас}/{понеділок}/{uid} = {v} → по класах за тижні періоду
export function hwLoadSummary(hwLoad, fromWeek, toDate, minN = HW_LOAD_MIN){
  const out = [];
  for(const [cls, weeks] of Object.entries(hwLoad || {})){
    const c = { cls, n: 0, few: 0, ok: 0, much: 0 };
    for(const [week, votes] of Object.entries(weeks || {})){
      if(week < fromWeek || week > toDate) continue;
      for(const x of Object.values(votes || {})){
        const v = Number(x && x.v);
        if(v === 1) c.few++; else if(v === 2) c.ok++; else if(v === 3) c.much++; else continue;
        c.n++;
      }
    }
    if(c.n) out.push({ ...c, enough: c.n >= minN });
  }
  const share = x => x.enough ? x.much / x.n : -1;
  return out.sort((a, b) => share(b) - share(a) || getClassNum(a.cls) - getClassNum(b.cls));
}

// ── АНАЛІЗ ── (чиста функція: усе потрібне приходить аргументом)
//   teachers — [{name, email, lessons:[{cls, subject, date, start, end, time}]}]
//   from..to — період; nowMin — хвилини від півночі (для «сьогодні»)
export function analyzeControl({ teachers, topics, homeworks, grades, settings, from, to, today, nowMin }){
  const s = { ...CONTROL_DEFAULTS, ...(settings || {}) };
  const lastGrade = lastGradeDates(grades);
  const done = l => l.date < today || (l.date === today && l.end != null && l.end <= nowMin);
  const rows = [];
  for(const t of teachers || []){
    const seenDay = new Map(), gaps = [], todayGaps = [];
    let lessons = 0, topicsOk = 0, hwNeeded = 0, hwOk = 0, hwLate = 0;
    const pairs = new Map();   // клас|предмет → уроки за період
    for(const l of t.lessons || []){
      if(l.date < from || l.date > to || !done(l)) continue;
      lessons++;
      const pk = `${l.cls}|${subjKey(l.subject)}`;
      pairs.set(pk, [...(pairs.get(pk) || []), l]);
      // Спарений урок: тема й ДЗ — одні на день, рахуємо день один раз
      const dayKey = `${l.cls}|${subjKey(l.subject)}|${l.date}`;
      if(seenDay.has(dayKey)){ if(seenDay.get(dayKey)) topicsOk++; continue; }
      const topic = topicFilled(topics, l.cls, l.subject, l.date);
      seenDay.set(dayKey, topic);
      if(topic) topicsOk++;
      const exempt = hwExempt(s, l.cls, l.subject);
      const hw = hwRecord(homeworks, l.cls, l.date, l.subject);
      const hasHw = hwNonEmpty(hw);
      if(!exempt){ hwNeeded++; if(hasHw) hwOk++; }
      const late = hasHw && hw.ts && hw.ts > dayEndTs(l.date);
      if(late) hwLate++;
      const miss = [!topic && 'тема', !exempt && !hasHw && 'ДЗ'].filter(Boolean);
      if(miss.length || late){
        const g = { cls: l.cls, subject: l.subject, date: l.date, time: l.time || '', miss, late: !!late };
        gaps.push(g);
        if(l.date === today && miss.length) todayGaps.push(g);
      }
    }
    // Давно без оцінок: у класі були уроки цього вчителя, а оцінок немає довше порогу
    const noGrades = [];
    for(const [pk, list] of pairs){
      const last = lastGrade[pk] || null;
      const since = last ? daysBetween(last, today) : null;
      const recent = list.filter(l => daysBetween(l.date, today) <= s.gradeGapDays).length;
      if(recent >= 2 && (since === null || since > s.gradeGapDays))
        noGrades.push({ cls: list[0].cls, subject: list[0].subject, last, since });
    }
    const pct = (a, b) => b ? Math.round(a * 100 / b) : null;
    rows.push({ name: t.name, email: t.email, lessons, topicPct: pct(topicsOk, lessons), hwPct: pct(hwOk, hwNeeded),
                hwNeeded, hwLate, gaps, todayGaps, noGrades,
                score: (lessons - topicsOk) + (hwNeeded - hwOk) + noGrades.length * 2 + hwLate * 0.5 });
  }
  rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'uk'));
  // Перевантаження ДЗ: скільки предметів задали класу за день
  const overload = [];
  for(const [cls, days] of Object.entries(homeworks || {}))
    for(const [date, subs] of Object.entries(days || {})){
      if(date < from || date > to) continue;
      const n = Object.values(subs || {}).filter(hwNonEmpty).length;
      if(n >= s.maxHwPerDay) overload.push({ cls, date, n, subjects: Object.keys(subs) });
    }
  overload.sort((a, b) => b.n - a.n || a.date.localeCompare(b.date));
  return { rows, overload };
}

// ── ЗАВАНТАЖЕННЯ ──
const val = async p => { const s = await get(child(ref(db), p)); return s.exists() ? s.val() : null; };
const range = (p, a, b) => get(query(ref(db, p), orderByKey(), startAt(a), endAt(b))).then(s => s.exists() ? s.val() : null);
export function periodOf(kind, today){
  if(kind === 'today') return { from: today, to: today };
  if(kind === 'week') return { from: mondayOf(today), to: today };
  return { from: addDays(today, -27), to: today };
}
let CT = { data: null, busy: false };
export async function loadControl(kind){
  const today = localDateString, { from, to } = periodOf(kind, today);
  const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
  // Тижні, що перекривають період (buildWorkload рахує потижнево)
  const mondays = []; for(let m = mondayOf(from); m <= to; m = addDays(m, 7)) mondays.push(m);
  const gFrom = addDays(today, -60), months = [...new Set([gFrom.slice(0, 7), addDays(today, -30).slice(0, 7), today.slice(0, 7)])];
  const [schedules, catalogs, users, access, choices, subs, topics, calendar, settings, talk, heads, hwLoad, ...perClass] = await Promise.all([
    val('schedules'), val('subjects_catalog'), val('users'), val('teacher_access'), val('schedule_alt'),
    range('substitutions', mondays[0], addDays(mondays.at(-1), 6)), val('lesson_topics'), val(`academic_year/${ACTIVE_YEAR}`), val('control_settings'),
    // Голос батьків — необовʼязковий: поки правила не опубліковано, решта працює
    val('talk_requests').catch(() => null), val('class_teachers').catch(() => null), val('hw_load').catch(() => null),
    ...CLASSES.map(c => range(`homeworks/${c}`, from, to)),
    ...CLASSES.flatMap(c => months.map(m => val(`grades/${c}/${m}`)))
  ]);
  const homeworks = {}, grades = {};
  CLASSES.forEach((c, i) => { if(perClass[i]) homeworks[c] = perClass[i]; });
  CLASSES.forEach((c, i) => months.forEach((m, j) => { const v = perClass[CLASSES.length + i * months.length + j]; if(v) (grades[c] ||= {})[m] = v; }));
  const byEmail = new Map();
  for(const m of mondays){
    const res = buildWorkload({ schedules: schedules || {}, catalogs: catalogs || {}, users: users || {}, access: access || {},
      choices: choices || {}, subs: subs || {}, topics: {}, calendar: calendar || {} }, m, today, ACTIVE_YEAR);
    for(const t of res.teachers){
      const cur = byEmail.get(t.email) || { name: t.name, email: t.email, lessons: [] };
      cur.lessons.push(...t.lessons);
      byEmail.set(t.email, cur);
    }
  }
  const out = analyzeControl({ teachers: [...byEmail.values()], topics, homeworks, grades, settings, from, to, today, nowMin });
  // Імена для запитів: з навантаження, інакше з users
  const names = {};
  for(const t of byEmail.values()) names[emailKey(t.email)] = t.name;
  for(const u of Object.values(users || {})) if(u && u.email && !names[emailKey(u.email)]) names[emailKey(u.email)] = u.name || u.displayName || u.email;
  const talkLate = talkOverdue(talk, access, heads, Date.now()).map(x => ({ ...x, name: names[x.key] || x.key.replace(/_/g, '.') }));
  return { ...out, kind, from, to, today, settings: { ...CONTROL_DEFAULTS, ...(settings || {}) },
           talkLate, hwLoad: hwLoadSummary(hwLoad, mondayOf(from), to) };
}

// ── ПОКАЗ ──
const pctCell = v => v === null ? '<span class="ct-na">—</span>'
  : `<b class="ct-pct ${v >= 90 ? 'ok' : v >= 60 ? 'warn' : 'bad'}">${v}%</b>`;
function gapLine(g){
  return `<li>${escHtml(human(g.date))}${g.time ? ` · ${escHtml(g.time)}` : ''} · ${escHtml(clsLabel(g.cls))} · ${escHtml(g.subject)} — `
    + [g.miss.length && `<b>немає: ${escHtml(g.miss.join(', '))}</b>`, g.late && 'ДЗ внесено пізніше дня уроку'].filter(Boolean).join('; ') + '</li>';
}
export function controlHtml(r){
  const kindLabel = { today: 'сьогодні', week: 'цей тиждень', month: '4 тижні' }[r.kind] || '';
  const withGaps = r.rows.filter(x => x.gaps.length || x.noGrades.length);
  const todayList = r.rows.filter(x => x.todayGaps.length);
  let h = `<p class="ct-sum">Період: <b>${escHtml(kindLabel)}</b> (${escHtml(human(r.from))}–${escHtml(human(r.to))}) · учителів з уроками: <b>${r.rows.filter(x => x.lessons).length}</b> · з прогалинами: <b style="color:${withGaps.length ? 'var(--danger)' : 'var(--ok)'}">${withGaps.length}</b></p>`;
  // Сьогодні — окремо і першим: це те, що ще можна виправити сьогодні
  h += `<div class="ct-block"><h4>⏰ Сьогодні урок уже був, а журнал не заповнено</h4>`
    + (todayList.length ? todayList.map(x => `<div class="ct-today"><b>${escHtml(x.name)}</b>
        <ul>${x.todayGaps.map(gapLine).join('')}</ul>
        <button type="button" class="ct-remind" onclick="ctRemind('${escJs(x.email)}')">🔔 Нагадати</button></div>`).join('')
      : '<p class="empty-msg">Усе, що вже відбулося сьогодні, заповнено.</p>') + '</div>';
  h += `<div class="ct-block"><h4>📊 За період</h4><div class="os-wrap"><table class="os-table ct-table"><thead><tr>
      <th>Учитель</th><th>Уроків</th><th>Теми</th><th>ДЗ</th><th>ДЗ пізно</th><th>Без оцінок</th></tr></thead><tbody>`
    + r.rows.filter(x => x.lessons).map((x, i) => `<tr>
        <td><button type="button" class="ct-name" onclick="ctToggle(${i})" aria-expanded="false">${escHtml(x.name)}</button></td>
        <td>${x.lessons}</td><td>${pctCell(x.topicPct)}</td><td>${pctCell(x.hwPct)}</td>
        <td>${x.hwLate ? `<b class="ct-pct warn">${x.hwLate}</b>` : '0'}</td>
        <td>${x.noGrades.length ? `<b class="ct-pct bad">${x.noGrades.length}</b>` : '0'}</td></tr>
        <tr class="ct-detail" id="ct-d-${i}" hidden><td colspan="6">
          ${x.noGrades.length ? `<p><b>Давно без оцінок:</b> ${x.noGrades.map(n => `${escHtml(clsLabel(n.cls))} ${escHtml(n.subject)} (${n.last ? `остання ${escHtml(human(n.last))}, ${n.since} дн. тому` : 'жодної за 2 місяці'})`).join('; ')}</p>` : ''}
          ${x.gaps.length ? `<ul>${x.gaps.map(gapLine).join('')}</ul>` : '<p class="empty-msg">Прогалин немає.</p>'}
          ${x.gaps.length || x.noGrades.length ? `<button type="button" class="ct-remind" onclick="ctRemind('${escJs(x.email)}')">🔔 Нагадати</button>` : ''}
        </td></tr>`).join('')
    + `</tbody></table></div><p class="cm-hint">Відсоток — частка уроків, що вже відбулися, де відмічено тему / задано ДЗ. Для ДЗ не рахуються класи й предмети-винятки (налаштування нижче). Спарені уроки — один день.</p></div>`;
  if(r.talkLate) h += `<div class="ct-block"><h4>💬 Запити батьків без відповіді понад ${TALK_LATE_DAYS} дні</h4>`
    + (r.talkLate.length ? `<ul>${r.talkLate.map(x => `<li><b>${escHtml(x.key === '—' ? 'учителя не знайдено в матриці доступу' : x.name)}</b>: ${x.items.length} — `
        + x.items.map(i => `${escHtml(clsLabel(i.cls))} ${escHtml(i.subject)} (${i.days} дн.)`).join(', ') + '</li>').join('')}</ul>`
      : '<p class="empty-msg">Усі запити батьків отримали відповідь вчасно.</p>')
    + '<p class="cm-hint">Лише кількість, клас і предмет. Текст запитів бачать тільки вчителі класу.</p></div>';
  h += `<div class="ct-block"><h4>📚 Перевантаження ДЗ (від ${r.settings.maxHwPerDay} предметів на день)</h4>`
    + (r.overload.length ? `<ul>${r.overload.map(o => `<li>${escHtml(clsLabel(o.cls))} · ${escHtml(human(o.date))}: <b>${o.n}</b> — ${escHtml(o.subjects.join(', '))}</li>`).join('')}</ul>`
      : '<p class="empty-msg">Перевантажених днів немає.</p>');
  if(r.hwLoad) h += `<p><b>Очима батьків</b> (відповіді в «Тиждень коротко»):</p>`
    + (r.hwLoad.length ? `<ul>${r.hwLoad.map(x => x.enough
        ? `<li>${escHtml(clsLabel(x.cls))}: відповідей <b>${x.n}</b> — забагато <b${x.much * 100 / x.n >= 40 ? ' class="ct-pct bad"' : ''}>${Math.round(x.much * 100 / x.n)}%</b>, нормально ${Math.round(x.ok * 100 / x.n)}%, мало ${Math.round(x.few * 100 / x.n)}%</li>`
        : `<li>${escHtml(clsLabel(x.cls))}: замало відповідей (${x.n}) — показуємо від ${HW_LOAD_MIN}</li>`).join('')}</ul>`
      : '<p class="empty-msg">За цей період батьки ще не відповідали.</p>');
  h += '</div>';
  return h;
}

window.openTeacherControl = async function(kind){
  const box = document.getElementById('ct-body');
  if(!box || CT.busy) return;
  kind = kind || document.getElementById('ct-period')?.value || 'week';
  CT.busy = true;
  box.innerHTML = '<p class="empty-msg">Перевіряю журнал... (кілька секунд)</p>';
  try{
    CT.data = await loadControl(kind);
    box.innerHTML = controlHtml(CT.data);
    fillControlSettings(CT.data.settings);
  }catch(e){
    box.innerHTML = `<p class="empty-msg" style="color:var(--danger);">Не вдалося перевірити: ${escHtml(e.message)}</p>`;
  }finally{ CT.busy = false; }
};
window.ctToggle = function(i){
  const tr = document.getElementById('ct-d-' + i);
  if(!tr) return;
  tr.hidden = !tr.hidden;
  const b = tr.previousElementSibling?.querySelector('.ct-name');
  if(b) b.setAttribute('aria-expanded', String(!tr.hidden));
};

// Нагадування — push самому вчителю. Скільки й чого бракує — у тексті.
window.ctRemind = async function(email){
  const x = CT.data && CT.data.rows.find(r => r.email === email);
  if(!x) return;
  const topics = x.gaps.filter(g => g.miss.includes('тема')).length, hw = x.gaps.filter(g => g.miss.includes('ДЗ')).length;
  const parts = [topics && `тем: ${topics}`, hw && `ДЗ: ${hw}`, x.noGrades.length && `класів без оцінок: ${x.noGrades.length}`].filter(Boolean);
  // Текст складає сервер лише з чисел: функція сповіщень приймає запити без
  // входу, і вільний текст «від директора» був би готовим інструментом для
  // підробки. Тут показуємо, що саме прийде.
  const text = `Не заповнено в журналі: ${parts.join(', ') || 'записи'}. Відкрийте портал і допишіть.`;
  if(!confirm(`Надіслати ${x.name} сповіщення?\n\n«${text}»`)) return;
  const r = await notifyEvent('reminder', { to: [email], topics, hw, grades: x.noGrades.length });
  if(r && r.ok && r.sent){
    showToast('🔔 Нагадування надіслано');
    logAction('settings', { target: email, value: 'нагадування про журнал: ' + parts.join(', ') });
  }else showToast(r && r.ok ? '⚠️ У вчителя не ввімкнені сповіщення — напишіть у чат' : '⚠️ Не вдалося надіслати сповіщення');
};

// ── НАЛАШТУВАННЯ ──
function fillControlSettings(s){
  const set_ = (id, v) => { const el = document.getElementById(id); if(el && document.activeElement !== el) el.value = v; };
  set_('ct-nohw-subjects', (s.noHwSubjects || []).join(', '));
  set_('ct-grade-gap', s.gradeGapDays);
  set_('ct-max-hw', s.maxHwPerDay);
  const sel = document.getElementById('ct-nohw-classes');
  if(sel) Array.from(sel.options).forEach(o => { o.selected = (s.noHwClasses || []).includes(o.value); });
}
window.saveControlSettings = async function(){
  const subjects = (document.getElementById('ct-nohw-subjects').value || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 40);
  const classes = Array.from(document.getElementById('ct-nohw-classes').selectedOptions).map(o => o.value);
  const gap = Math.min(60, Math.max(3, parseInt(document.getElementById('ct-grade-gap').value) || 14));
  const maxHw = Math.min(15, Math.max(2, parseInt(document.getElementById('ct-max-hw').value) || 6));
  try{
    await set(ref(db, 'control_settings'), { noHwSubjects: subjects, noHwClasses: classes, gradeGapDays: gap, maxHwPerDay: maxHw, by: currentUserData?.email || '', ts: Date.now() });
    showToast('✅ Налаштування контролю збережено');
    window.openTeacherControl();
  }catch(e){ alert('Не вдалося зберегти: ' + e.message + '\n\nЯкщо тут PERMISSION_DENIED — опублікуйте нові правила бази.'); }
};
