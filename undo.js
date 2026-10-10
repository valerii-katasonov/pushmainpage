// ═══════════════════════════════════════════════════════════════
// undo.js — «Видалено · Повернути» (підхід 7).
//
// ЩО РОБИТЬ. deleteWithUndo({paths, label, onDone, onUndo}):
//   1) читає поточні значення всіх шляхів (знімок «як було»);
//   2) видаляє їх одним атомарним update;
//   3) показує сповіщення з кнопкою «Повернути» (10 с, або Ctrl+Z).
// «Повернути» записує знімок назад тим самим одним update.
//
// ЧОМУ НЕ confirm(). Діалог «Ви впевнені?» на кожну дрібницю вчить
// натискати «ОК» не читаючи — і тоді він не рятує й від справжньої
// помилки. Для дрібних видалень (оцінка, ДЗ, оголошення, свято)
// краще дати зробити й дозволити передумати. Для великих (співробітник,
// учень, навчальний план) confirm лишається: там «повернути» означало б
// відновлювати права, розклад і прив'язки — це не один знімок.
//
// ЧУЖА ЗМІНА. Якщо за ці секунди на тому самому місці хтось щось
// записав (інший учитель поставив оцінку), «Повернути» нічого не
// перезаписує й каже про це: стерти чужу роботу гірше, ніж не повернути.
// ═══════════════════════════════════════════════════════════════
import { ref, get, update } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, escHtml, showToast } from './common.js';

const UNDO_MS = 10000;
let last = null;        // {restore, el, timer}

export async function snapshotPaths(paths){
  const keys = Object.keys(paths || {});
  const vals = await Promise.all(keys.map(k => get(ref(db, k)).then(s => s.exists() ? s.val() : null)));
  const out = {};
  keys.forEach((k, i) => { out[k] = vals[i] === undefined ? null : vals[i]; });
  return out;
}
// Чи все ще порожньо там, де ми видалили (ніхто не встиг записати своє)
export function untouched(now, paths){
  return Object.keys(paths).every(k => paths[k] === null ? now[k] === null : JSON.stringify(now[k]) === JSON.stringify(paths[k]));
}

function dismiss(){
  if(!last) return;
  clearTimeout(last.timer);
  const el = last.el; last = null;
  if(el){ el.style.opacity = '0'; setTimeout(() => el.remove(), 250); }
}

export function showUndoToast(label, restore, ms = UNDO_MS){
  dismiss();
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = 'toast toast-undo';
  t.setAttribute('role', 'status');
  t.innerHTML = `<span>🗑️ ${escHtml(label)}</span><button type="button" class="toast-undo-btn">Повернути</button>`
    + `<i class="toast-undo-bar" style="animation-duration:${ms}ms"></i>`;
  const entry = { el: t, restore, timer: null };
  t.querySelector('button').addEventListener('click', () => runUndo(entry));
  if(c) c.appendChild(t);
  entry.timer = setTimeout(() => { if(last === entry) dismiss(); }, ms);
  last = entry;
  return entry;
}

async function runUndo(entry){
  // running — від подвійного Ctrl+Z (чи клік + Ctrl+Z): інакше дві
  // паралельні спроби повернути й два onUndo
  if(!entry || entry !== last || entry.running) return;
  entry.running = true;
  const btn = entry.el && entry.el.querySelector('button');
  if(btn){ btn.disabled = true; btn.textContent = '…'; }
  clearTimeout(entry.timer);
  let msg;
  try{ msg = await entry.restore(); }
  catch(e){ msg = '❌ Не вдалося повернути: ' + (e && e.message || ''); }
  dismiss();
  if(msg) showToast(msg);
}

export async function deleteWithUndo({ paths, label = 'Видалено', onDone, onUndo, ms = UNDO_MS }){
  const before = await snapshotPaths(paths);
  const del = {};
  Object.keys(paths).forEach(k => { del[k] = null; });
  await update(ref(db), del);
  if(onDone){ try{ await onDone(); }catch(e){ console.warn('undo onDone:', e); } }
  showUndoToast(label, async () => {
    const now = await snapshotPaths(del);
    if(!untouched(now, del)) return '⚠️ Тут уже щось змінили — не повертаю, щоб не стерти чужий запис.';
    await update(ref(db), before);
    if(onUndo){ try{ await onUndo(); }catch(e){ console.warn('undo onUndo:', e); } }
    return '↩️ Повернуто';
  }, ms);
  return before;
}

// Ctrl+Z / ⌘+Z — поки видно «Повернути». У полях вводу не чіпаємо:
// там Ctrl+Z скасовує набраний текст, і це важливіше.
document.addEventListener('keydown', e => {
  if(!last || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== 'z') return;
  const el = document.activeElement;
  if(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
  e.preventDefault();
  runUndo(last);
});

window.deleteWithUndo = deleteWithUndo;
window.showUndoToast = showUndoToast;
