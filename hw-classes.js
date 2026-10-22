// ═══════════════════════════════════════════════════════════════
// hw-classes.js — 📚 «ДЗ класу» для директора й адміністрації.
//
// НАВІЩО. Адміністрація відповідає батькам «що задали на завтра» і
// перевіряє навантаження, а побачити ДЗ конкретного класу могла лише
// через журнал по одному предмету. Тут — клас і тиждень одним екраном:
// по днях видачі, кожне завдання з предметом, автором, вкладеннями і
// датою, ДО якої його треба зробити (наступний урок за розкладом класу,
// так само, як рахує вкладка «ДЗ» у батьків і серія 🔥).
//
// ЛИШЕ ЧИТАННЯ. Нічого не пише; homeworks/{клас} і authors/{клас}
// персонал і так має право читати (CLASS_NODES у правилах).
// ═══════════════════════════════════════════════════════════════
import { ref, get, child, query, orderByKey, startAt, endAt } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, currentUserData, escHtml, localDateString, mondayOf, nextLessonDate, renderHwItem, getUsersSnap } from './common.js';
import { loadSkipDates } from './homework.js';

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const shift = (ds, n) => { const [y, m, d] = ds.split('-').map(Number); const dt = new Date(y, m - 1, d); dt.setDate(dt.getDate() + n); return ymd(dt); };
const human = ds => ds ? ds.split('-').reverse().slice(0, 2).join('.') : '';
const DOW = ['Неділя', 'Понеділок', 'Вівторок', 'Середа', 'Четвер', 'Пʼятниця', 'Субота'];
const dowOf = ds => DOW[new Date(ds + 'T12:00:00').getDay()];
// «зробити до середи» — родовий відмінок
const DOW_GEN = ['неділі', 'понеділка', 'вівторка', 'середи', 'четверга', 'пʼятниці', 'суботи'];
const dowGen = ds => DOW_GEN[new Date(ds + 'T12:00:00').getDay()];
export const canSee = role => role === 'director' || role === 'administrator';

// Чи є в записі хоч щось (текст, сторінки, фото, файли, тренажери)
export function hasHw(v){
  if(!v) return false;
  if(typeof v === 'string') return !!v.trim();
  return !!((v.text && String(v.text).trim()) || (v.pages && String(v.pages).trim()) || v.image || (v.images && v.images.length)
    || (v.files && v.files.length) || (v.trainers && (Array.isArray(v.trainers) ? v.trainers.length : Object.keys(v.trainers).length)) || (v.book && v.book.url));
}
// {дата: {предмет: запис}} → [{date, items:[{subj, rec, due, by}]}] на Пн–Пт
// тижня; субота й неділя — лише якщо того дня щось задали
export function weekRows(hw, monday, { dueOf = () => '', authors = {}, users = {} } = {}){
  const days = [0, 1, 2, 3, 4, 5, 6].map(i => shift(monday, i))
    .filter((d, i) => i < 5 || Object.values((hw || {})[d] || {}).some(hasHw));
  return days.map(date => ({
    date,
    items: Object.keys((hw || {})[date] || {}).filter(s => hasHw(hw[date][s]))
      .sort((a, b) => a.localeCompare(b, 'uk'))
      .map(subj => {
        // authors/{клас}/{дата}/{предмет} = uid автора → імʼя з users
        const uid = authors && authors[date] && authors[date][subj];
        const u = uid && users && users[uid];
        return { subj, rec: hw[date][subj], due: dueOf(subj, date) || '', by: (u && (u.name || u.displayName || u.email)) || '' };
      })
  }));
}

let cls = '', week = '';
function overlay(){
  let o = document.getElementById('hw-classes-modal');
  if(o) return o;
  o = document.createElement('div');
  o.id = 'hw-classes-modal'; o.className = 'modal-overlay'; o.style.zIndex = '1012';
  // Кабінет директора поки не перекладається (i18n.js) — і це вікно теж,
  // щоб не було мішанини мов на одному екрані
  o.setAttribute('data-no-i18n', '');
  o.innerHTML = `<div class="modal-content hwc-modal">
    <h2 class="hwc-h">📚 ДЗ класу</h2>
    <div class="hwc-bar">
      <select id="hwc-class" aria-label="Клас">${Array.from({ length: 11 }, (_, i) => `<option value="class_${i + 1}">${i + 1} клас</option>`).join('')}</select>
      <div class="hwc-week">
        <button type="button" data-w="-1" aria-label="Попередній тиждень">←</button>
        <b id="hwc-range"></b>
        <button type="button" data-w="1" aria-label="Наступний тиждень">→</button>
      </div>
    </div>
    <button type="button" class="hwc-now" data-w="0" hidden>Повернутися до поточного тижня</button>
    <div id="hwc-body"></div>
    <button type="button" class="hwc-close" onclick="document.getElementById('hw-classes-modal').style.display='none'">Закрити</button>
  </div>`;
  o.addEventListener('click', e => {
    if(e.target === o){ o.style.display = 'none'; return; }
    const b = e.target.closest('[data-w]'); if(!b) return;
    const w = Number(b.dataset.w);
    week = w === 0 ? mondayOf(localDateString) : shift(week, 7 * w);
    paint();
  });
  o.querySelector('#hwc-class').addEventListener('change', e => { cls = e.target.value; try{ localStorage.setItem('push_hwc_class', cls); }catch(_){} paint(); });
  document.body.appendChild(o);
  return o;
}

let seq = 0;
async function paint(){
  const o = overlay(), my = ++seq;
  const body = o.querySelector('#hwc-body');
  o.querySelector('#hwc-class').value = cls;
  o.querySelector('#hwc-range').textContent = `${human(week)} – ${human(shift(week, 4))}`;
  o.querySelector('.hwc-now').hidden = week === mondayOf(localDateString);
  body.innerHTML = '<p class="empty-msg is-loading">Завантаження...</p>';
  try{
    const [hwSnap, auSnap, schSnap, skip, usSnap] = await Promise.all([
      get(query(child(ref(db), `homeworks/${cls}`), orderByKey(), startAt(week), endAt(shift(week, 6)))),
      get(query(child(ref(db), `authors/${cls}`), orderByKey(), startAt(week), endAt(shift(week, 6)))).catch(() => null),
      get(child(ref(db), `schedules/${cls}/lessons`)).catch(() => null),
      Promise.resolve().then(() => loadSkipDates()).catch(() => new Set()),
      Promise.resolve().then(() => getUsersSnap()).catch(() => null)
    ]);
    if(my !== seq) return;
    const sch = schSnap && schSnap.exists() ? schSnap.val() : null;
    const dueOf = (s, d) => sch ? nextLessonDate(sch, s, d, skip) : '';
    const users = usSnap && typeof usSnap.val === 'function' ? (usSnap.val() || {}) : (usSnap || {});
    const rows = weekRows(hwSnap.exists() ? hwSnap.val() : {}, week, { dueOf, authors: auSnap && auSnap.exists() ? auSnap.val() : {}, users });
    const total = rows.reduce((n, r) => n + r.items.length, 0);
    body.innerHTML = `<p class="hwc-sum">${total ? `Завдань за тиждень: <b>${total}</b>` : 'Цього тижня ДЗ не задавали.'}</p>` + rows.map(r => `
      <section class="hwc-day${r.date === localDateString ? ' is-today' : ''}">
        <h4>${escHtml(dowOf(r.date))}, ${escHtml(human(r.date))}${r.date === localDateString ? ' <span>сьогодні</span>' : ''}</h4>
        ${r.items.length ? r.items.map(it => `
          <div class="hwc-item">
            <ul class="hwc-ul" data-no-i18n>${renderHwItem(it.subj, it.rec, [])}</ul>
            <div class="hwc-meta">
              ${it.due ? `<span class="hwc-due">зробити до ${escHtml(dowGen(it.due))}, ${escHtml(human(it.due))}</span>` : ''}
              ${it.by ? `<span class="hwc-by">👩‍🏫 ${escHtml(it.by)}</span>` : ''}</div>
          </div>`).join('') : '<p class="hwc-none">Не задавали</p>'}
      </section>`).join('');
  }catch(e){
    if(my === seq) body.innerHTML = `<p class="empty-msg">Не вдалося завантажити: ${escHtml(e.message || '')}</p>`;
  }
}

export function openHwClasses(){
  if(!canSee(currentUserData && currentUserData.role)) return;
  try{ cls = localStorage.getItem('push_hwc_class') || ''; }catch(e){}
  if(!/^class_\d{1,2}$/.test(cls)) cls = 'class_1';
  week = mondayOf(localDateString);
  overlay().style.display = 'flex';
  paint();
}
window.openHwClasses = openHwClasses;
