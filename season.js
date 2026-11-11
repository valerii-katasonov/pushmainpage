// ═══════════════════════════════════════════════════════════════
// season.js — ❄️ зимове оформлення порталу.
//
// ВМИКАЄ ДИРЕКТОР: «Налаштування» → «❄️ Зимове оформлення». Одна галочка
// в базі (season = 'winter'), і зимове вбрання з'являється в усіх одразу,
// без перевикладання сайту. Навесні — зняти галочку.
//
// ЩО ВХОДИТЬ (усе — CSS під html.season-winter у cabinet.html):
//   • заставка запуску — зимовий ролик (pushyk-splash-winter-*);
//   • рідкий сніг поверх сторінки (не заважає натисканням; при
//     «зменшити рух» його немає);
//   • гірлянда над рядком профілю;
//   • снігові шапки на картках;
//   • сніжинка на активній вкладці нижнього меню і святкове привітання
//     вгорі «Сьогодні» (його можна закрити до завтра).
//
// ЧОМУ ЩЕ Й localStorage. Заставка програється до входу, коли базу ще не
// прочитати. Тому останнє відоме значення пам'ятаємо на пристрої:
// вбудований скрипт у <head> ставить клас ще до першого кадру, а після
// входу база підтверджує або знімає його.
// ═══════════════════════════════════════════════════════════════
import { ref, onValue, set, remove } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, showToast, localDateString } from './common.js';

const KEY = 'push_season';
const HI_KEY = 'push_season_hi';
let off = null, current = null;

export function isWinter(){ return document.documentElement.classList.contains('season-winter'); }

// Привітання за датою. Оформлення вмикають і раніше (у листопаді), тож
// «зимовий день» — лише в зимові місяці; до того — «зима вже близько».
// Поза листопадом–лютим привітання немає зовсім ('').
export function seasonGreeting(today){
  const md = String(today).slice(5, 10), m = md.slice(0, 2);
  if(m === '11') return '❄️ Зима вже близько!';
  if(md >= '12-19' && md <= '12-31') return '🎄 Затишних свят і гарного кінця року!';
  if(md >= '01-01' && md <= '01-14') return '🎉 З Новим роком!';
  if(m === '12' || m === '01' || m === '02') return '❄️ Гарного зимового дня!';
  return '';
}

// ── СНІГ ──────────────────────────────────────────────────────────
// Дванадцять сніжинок на CSS-анімації transform: дешево для батареї.
// (Спершу було 22 — виглядало як хуртовина; 11.11.2026 зменшили й сповільнили.)
// Розташування випадкове, щоб не було видно повтору.
const FLAKES = 12;
function ensureSnow(){
  if(document.getElementById('season-snow')) return;
  const box = document.createElement('div');
  box.id = 'season-snow'; box.setAttribute('aria-hidden', 'true');
  let html = '';
  for(let i = 0; i < FLAKES; i++){
    const left = (Math.random() * 100).toFixed(1);
    const dur = (16 + Math.random() * 12).toFixed(1);
    const delay = (-Math.random() * 28).toFixed(1);
    const size = (6 + Math.random() * 7).toFixed(0);
    const sway = (Math.random() * 40 - 20).toFixed(0);
    html += `<i style="left:${left}%;font-size:${size}px;animation-duration:${dur}s;animation-delay:${delay}s;--sway:${sway}px">${i % 3 ? '•' : '❄'}</i>`;
  }
  box.innerHTML = html;
  document.body.appendChild(box);
}
function dropSnow(){ const b = document.getElementById('season-snow'); if(b) b.remove(); }

// ── ПРИВІТАННЯ ВГОРІ «СЬОГОДНІ» ───────────────────────────────────
function hiHidden(){ try{ return localStorage.getItem(HI_KEY) === localDateString; }catch(e){ return false; } }
function paintGreeting(){
  document.querySelectorAll('.season-hi').forEach(x => x.remove());
  if(!isWinter() || hiHidden()) return;
  const text = seasonGreeting(localDateString);
  if(!text) return;
  document.querySelectorAll('section.ui-today[data-dtab="day"]').forEach(sec => {
    const d = document.createElement('div');
    d.className = 'season-hi';
    d.innerHTML = `<span></span><button type="button" aria-label="Сховати до завтра" title="Сховати до завтра">✕</button>`;
    d.querySelector('span').textContent = text;
    d.querySelector('button').addEventListener('click', () => {
      try{ localStorage.setItem(HI_KEY, localDateString); }catch(e){}
      document.querySelectorAll('.season-hi').forEach(x => x.remove());
    });
    sec.prepend(d);
  });
}

export function applySeason(value){
  const on = value === 'winter';
  current = on ? 'winter' : '';
  document.documentElement.classList.toggle('season-winter', on);
  try{ if(on) localStorage.setItem(KEY, 'winter'); else localStorage.removeItem(KEY); }catch(e){}
  if(on) ensureSnow(); else dropSnow();
  paintGreeting();
  const cb = document.getElementById('d-season-winter');
  if(cb){ cb.checked = on; cb.disabled = false; }
}
window.applySeason = applySeason;

// Після входу: база — джерело правди. Помилка читання (вийшли з акаунта,
// немає зв'язку) нічого не міняє: лишається те, що вже на екрані.
export function watchSeason(){
  if(off) return;
  off = onValue(ref(db, 'season'), snap => applySeason(snap.exists() ? snap.val() : ''),
    () => { off = null; });
}
export function stopSeason(){ if(off){ try{ off(); }catch(e){} off = null; } }
window.watchSeason = watchSeason;
window.stopSeason = stopSeason;

// Перемикач директора (cabinet.html → «Налаштування»)
window.setWinterSeason = async function(on){
  const cb = document.getElementById('d-season-winter');
  if(cb) cb.disabled = true;
  try{
    if(on) await set(ref(db, 'season'), 'winter'); else await remove(ref(db, 'season'));
    showToast(on ? '❄️ Зимове оформлення ввімкнено для всіх' : 'Зимове оформлення вимкнено');
  }catch(e){
    if(cb) cb.checked = !on;
    showToast('Не вдалося зберегти: ' + (e.message || ''));
  }finally{ if(cb) cb.disabled = false; }
};

// Сніг для того, що вже стоїть у класі з <head> (ще до входу)
function boot(){
  if(isWinter()) ensureSnow();
  // Розділ «Сьогодні» малюється пізніше — привітання ставимо, коли він є
  paintGreeting();
}
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
window.paintSeasonGreeting = paintGreeting;
