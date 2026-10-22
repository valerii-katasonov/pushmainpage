// ═══════════════════════════════════════════════════════════════
// staff-bdays.js — 🎂 «Дні народження колег»: календар працівників школи.
//
// ЩО ЦЕ. Один список на всю школу: найближчі дні народження зверху,
// нижче — весь рік по місяцях. Кожен працівник може вписати свій день
// сам (у цьому ж вікні); директор і адміністрація — за будь-кого.
//
// ДАНІ.
//   staff_birthdays/{пошта} = 'ММ-ДД' — лише день і місяць, рік НЕ
//     зберігаємо: вік — не справа календаря.
//   staff_bday_subs/{пошта} = true|false — чи слати мені нагадування.
//     Директору й адміністрації — за замовчуванням так (поки не вимкнуть),
//     решті — лише якщо увімкнули самі.
// Бачать лише працівники (не батьки й не учні) — правило в базі.
// Імена й ролі — зі staff_directory (той самий довідник, що й у чаті).
//
// НАГАДУВАННЯ шле щоденна функція netlify/functions/birthday-reminders.js:
// за 3 дні й у сам день.
// ═══════════════════════════════════════════════════════════════
import { ref, get, child, set } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, auth, currentUserData, escHtml, showToast, emailKey, ROLE_LABELS, localDateString } from './common.js';

export const MONTHS = ['Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень', 'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень'];
const MONTHS_GEN = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
export const MD_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
export const isAdmin = r => r === 'director' || r === 'administrator';
export const isStaff = r => !!r && r !== 'parent' && r !== 'student';
const pad = n => String(n).padStart(2, '0');
export const mdHuman = md => { const [m, d] = md.split('-').map(Number); return `${d} ${MONTHS_GEN[m - 1]}`; };
const daysIn = m => [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
export const validMd = md => MD_RE.test(md) && Number(md.slice(3)) <= daysIn(Number(md.slice(0, 2)));

// Скільки днів до найближчого дня народження (0 — сьогодні).
// 29 лютого в невисокосний рік святкуємо 1 березня — як і в учнів.
export function daysUntil(md, today = localDateString){
  const [y, tm, td] = today.split('-').map(Number);
  const base = new Date(y, tm - 1, td);
  for(const yy of [y, y + 1]){
    let [m, d] = md.split('-').map(Number);
    if(m === 2 && d === 29 && new Date(yy, 1, 29).getDate() !== 29){ m = 3; d = 1; }
    const dt = new Date(yy, m - 1, d);
    const diff = Math.round((dt - base) / 86400000);
    if(diff >= 0) return diff;
  }
  return 365;
}
// [{se, name, role, md, left}] — лише ті, в кого дата вказана
// Хто вже не в довіднику персоналу (звільнився) — не показуємо
export function bdayList(bdays, dir, today = localDateString){
  const known = dir && Object.keys(dir).length;
  return Object.entries(bdays || {}).filter(([se, md]) => validMd(String(md)) && (!known || dir[se])).map(([se, md]) => {
    const p = (dir || {})[se] || {};
    return { se, name: p.name || se.replace(/_/g, '.'), role: p.role || '', md, left: daysUntil(md, today) };
  });
}
export const upcoming = (list, days = 30) => list.filter(x => x.left <= days).sort((a, b) => a.left - b.left || a.name.localeCompare(b.name, 'uk'));
export function byMonth(list){
  const out = MONTHS.map(() => []);
  list.forEach(x => out[Number(x.md.slice(0, 2)) - 1].push(x));
  out.forEach(a => a.sort((p, q) => p.md.localeCompare(q.md) || p.name.localeCompare(q.name, 'uk')));
  return out;
}
export const leftLabel = n => n === 0 ? '🎉 сьогодні' : n === 1 ? 'завтра' : `через ${n} дн.`;

// ── ВІКНО ───────────────────────────────────────────────────────
const myKey = () => emailKey((currentUserData && currentUserData.email) || (auth.currentUser && auth.currentUser.email) || '');
let data = { bdays: {}, dir: {}, subs: {} }, editAll = false;

function overlay(){
  let o = document.getElementById('staff-bdays-modal');
  if(o) return o;
  o = document.createElement('div');
  o.id = 'staff-bdays-modal'; o.className = 'modal-overlay'; o.style.zIndex = '1012';
  o.innerHTML = '<div class="modal-content sb-modal"></div>';
  o.addEventListener('click', e => { if(e.target === o) o.style.display = 'none'; });
  o.addEventListener('change', onChange);
  o.addEventListener('click', onClick);
  document.body.appendChild(o);
  return o;
}
const daySel = (md, attr) => {
  const [m, d] = md && MD_RE.test(md) ? md.split('-') : ['', ''];
  return `<select ${attr} data-part="d" aria-label="День"><option value="">день</option>${Array.from({ length: 31 }, (_, i) => `<option value="${pad(i + 1)}"${pad(i + 1) === d ? ' selected' : ''}>${i + 1}</option>`).join('')}</select>`
    + `<select ${attr} data-part="m" aria-label="Місяць"><option value="">місяць</option>${MONTHS_GEN.map((n, i) => `<option value="${pad(i + 1)}"${pad(i + 1) === m ? ' selected' : ''}>${n}</option>`).join('')}</select>`;
};

function paint(){
  const o = overlay(), mc = o.querySelector('.modal-content');
  const role = currentUserData && currentUserData.role, me = myKey(), admin = isAdmin(role);
  const list = bdayList(data.bdays, data.dir);
  const soon = upcoming(list, 30), months = byMonth(list);
  const subOn = data.subs[me] === true || (admin && data.subs[me] !== false);
  const person = x => `<div class="sb-row${x.left === 0 ? ' is-today' : ''}"><span class="sb-name">${escHtml(x.name)}${x.role ? ` <small>${escHtml(ROLE_LABELS[x.role] || x.role)}</small>` : ''}</span><span class="sb-date">${escHtml(mdHuman(x.md))}</span></div>`;
  mc.innerHTML = `
    <h2 class="sb-h">🎂 Дні народження колег</h2>
    <p class="sb-sub">Бачать лише працівники школи. Зберігаємо тільки день і місяць — без року.</p>
    <div class="sb-me">
      <b>Мій день народження</b>
      <div class="sb-pick">${daySel(data.bdays[me] || '', 'data-me="1"')}
        <button type="button" data-act="save-me">Зберегти</button>
        ${data.bdays[me] ? '<button type="button" data-act="clear-me" class="sb-ghost">Прибрати</button>' : ''}</div>
      <label class="sb-sub-on"><input type="checkbox" data-act="subs"${subOn ? ' checked' : ''}> 🔔 Нагадувати мені про дні народження колег (за 3 дні й у сам день)</label>
    </div>
    <h4 class="sb-h4">Найближчі 30 днів</h4>
    ${soon.length ? soon.map(x => `<div class="sb-row${x.left === 0 ? ' is-today' : ''}"><span class="sb-name">${escHtml(x.name)}</span><span class="sb-date">${escHtml(mdHuman(x.md))} · <b>${escHtml(leftLabel(x.left))}</b></span></div>`).join('')
      : '<p class="sb-none">Найближчим часом днів народження немає.</p>'}
    <h4 class="sb-h4">Увесь рік</h4>
    ${list.length ? months.map((arr, i) => arr.length ? `<div class="sb-month"><div class="sb-mh">${MONTHS[i]}</div>${arr.map(person).join('')}</div>` : '').join('')
      : '<p class="sb-none">Поки ніхто не вписав свій день народження.</p>'}
    ${admin ? `<details class="sb-all"${editAll ? ' open' : ''}><summary>✏️ Заповнити за колег</summary>
      <p class="sb-sub">Список — з довідника персоналу (хто хоч раз заходив у портал).</p>
      ${Object.entries(data.dir).sort((a, b) => String(a[1].name || '').localeCompare(String(b[1].name || ''), 'uk')).map(([se, p]) => `
        <div class="sb-edit" data-se="${escHtml(se)}"><span>${escHtml(p.name || se)}</span>${daySel(data.bdays[se] || '', `data-se="${escHtml(se)}"`)}
          <button type="button" data-act="save-one">✓</button></div>`).join('') || '<p class="sb-none">Довідник персоналу порожній.</p>'}
    </details>` : ''}
    <button type="button" class="sb-close" onclick="document.getElementById('staff-bdays-modal').style.display='none'">Закрити</button>`;
}
const mdFrom = box => {
  const d = box.querySelector('[data-part="d"]').value, m = box.querySelector('[data-part="m"]').value;
  return d && m ? `${m}-${d}` : '';
};
async function saveMd(se, md){
  if(md && !validMd(md)){ showToast('⚠️ Такої дати не буває'); return false; }
  try{
    await set(ref(db, `staff_birthdays/${se}`), md || null);
    if(md) data.bdays[se] = md; else delete data.bdays[se];
    showToast(md ? `✓ Збережено: ${mdHuman(md)}` : '✓ Прибрано');
    return true;
  }catch(e){ showToast('❌ Не збережено: ' + (e.message || '')); return false; }
}
async function onClick(e){
  const b = e.target.closest('button[data-act]'); if(!b) return;
  const o = overlay(), me = myKey();
  if(b.dataset.act === 'save-me'){ const md = mdFrom(o.querySelector('.sb-pick')); if(!md) return showToast('⚠️ Оберіть день і місяць'); if(await saveMd(me, md)) paint(); }
  if(b.dataset.act === 'clear-me'){ if(await saveMd(me, '')) paint(); }
  if(b.dataset.act === 'save-one'){ const row = b.closest('.sb-edit'); editAll = true; if(await saveMd(row.dataset.se, mdFrom(row))) paint(); }
}
async function onChange(e){
  if(e.target.dataset.act !== 'subs') return;
  const me = myKey(), on = e.target.checked;
  try{ await set(ref(db, `staff_bday_subs/${me}`), on); data.subs[me] = on; showToast(on ? '🔔 Нагадування увімкнено' : '🔕 Нагадування вимкнено'); }
  catch(err){ e.target.checked = !on; showToast('❌ Не збережено: ' + (err.message || '')); }
}

export async function openStaffBirthdays(){
  if(!isStaff(currentUserData && currentUserData.role)) return;
  const o = overlay();
  o.querySelector('.modal-content').innerHTML = '<p class="empty-msg is-loading">Завантаження...</p>';
  o.style.display = 'flex';
  const val = p => get(child(ref(db), p)).then(s => s.exists() ? s.val() : {}).catch(() => ({}));
  const me = myKey();
  const [bdays, dir, mine] = await Promise.all([val('staff_birthdays'), val('staff_directory'), val(`staff_bday_subs/${me}`)]);
  data = { bdays: bdays || {}, dir: dir || {}, subs: { [me]: typeof mine === 'boolean' ? mine : undefined } };
  editAll = false;
  paint();
}
window.openStaffBirthdays = openStaffBirthdays;
