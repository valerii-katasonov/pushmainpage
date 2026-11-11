// ═══════════════════════════════════════════════════════════════
// teacher-attention.js — блок «Потребує уваги» на «Сьогодні» вчителя.
//
// НАВІЩО. Тут стояла сітка з 18 кнопок однакової ваги: щоденний журнал
// поруч із друком розкладу, який відкривають раз на місяць. Кнопки
// переїхали у вкладки («Журнал», «Клас», «Розклад», «Новини»), а тут
// лишилося те, де вчителеві справді є що зробити:
//   🔄 заявки на перездачу, що чекають (teacher.js → refreshRetakeCounter);
//   📥 здані домашні роботи за обраний день (teacher.js → loadDailyHomeworkSubmissions);
//   💬 відкриті запити батьків «Хочу обговорити» (talk-requests.js).
// Плитка з нулем ховається; коли всі нулі — «✅ Усе гаразд».
//
// ЛІЧИЛЬНИКИ НЕ РАХУЄМО ВДРУГЕ. Їх уже пишуть свої модулі; тут лише
// спостерігаємо за числами (MutationObserver) і показуємо/ховаємо плитки.
// ═══════════════════════════════════════════════════════════════
const TILES = [
  { tile: 't-retake-btn',  count: 't-retake-counter' },
  { tile: 't-subs-btn',    count: 't-subs-counter' },
  { tile: 't-talkreq-btn', count: 't-talk-counter' }
];
const num = id => { const el = document.getElementById(id); return el ? (parseInt(el.textContent, 10) || 0) : 0; };

export function refreshAttention(){
  let any = false;
  TILES.forEach(t => {
    const el = document.getElementById(t.tile); if(!el) return;
    const on = num(t.count) > 0;
    if(el.hidden === on) el.hidden = !on;
    any = any || on;
  });
  const ok = document.getElementById('t-attn-ok');
  if(ok && ok.hidden !== any) ok.hidden = any;
}
window.refreshAttention = refreshAttention;

// Запити батьків: talk-requests.js малює блок #t-talk із бейджем кількості
// відкритих запитів. Беремо число з бейджа.
function syncTalk(){
  const box = document.getElementById('t-talk');
  const c = document.getElementById('t-talk-counter');
  if(!c) return;
  const shown = box && box.style.display !== 'none';
  const badge = shown && box.querySelector('.tk-badge');
  const n = String(badge ? (parseInt(badge.textContent, 10) || 0) : 0);
  // Пишемо лише зміну: лічильник сам під наглядом, і запис того самого
  // числа знову будив би спостерігача — безкінечне коло.
  if(c.textContent !== n) c.textContent = n;
}

window.attnGo = function(id){
  const el = document.getElementById(id);
  if(!el) return;
  try{ el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }catch(e){ el.scrollIntoView(); }
  el.classList.add('flash-target');
  setTimeout(() => el.classList.remove('flash-target'), 2400);
};

function boot(){
  const watch = new MutationObserver(() => { syncTalk(); refreshAttention(); });
  TILES.forEach(t => { const el = document.getElementById(t.count); if(el) watch.observe(el, { childList: true, characterData: true, subtree: true }); });
  const talk = document.getElementById('t-talk');
  if(talk) watch.observe(talk, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
  syncTalk(); refreshAttention();
}
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
