// ══════════════════════════════════════════════════════════════════
//  ПУШИК ВІТАЄТЬСЯ ПІСЛЯ ВХОДУ
// ══════════════════════════════════════════════════════════════════
//
// ЩО ЦЕ. Персонаж виїжджає з-за нижнього краю екрана, махає лапою,
// каже «Привіт, Марку!» і ховається. Одна коротка сцена на день, без
// звуку, нічого не перекриває й не чекає на натискання.
//
// ЧОМУ КАДРИ PNG, А НЕ ВІДЕО. Відео тут програє за всіма пунктами:
//   • вага: коротке відео — 0,5–2 МБ на першому ж екрані, часто з
//     мобільного інтернету; три PNG — близько 60 КБ разом;
//   • прозорість: mp4 її не має взагалі, тож персонаж «з-за краю»
//     вийшов би прямокутником із тлом. Прозоре відео існує (WebM з
//     альфою), але Safari його не бере — довелося б тримати ще й HEVC
//     з альфою, тобто два файли й дві перевірки;
//   • автозапуск: у режимі енергозбереження на iPhone він не працює, і
//     дитина бачить чорний прямокутник замість привітання;
//   • правки: змінити тривалість чи траєкторію в CSS — це один рядок,
//     у відео — перегенерувати все й сподіватися, що персонаж вийде
//     таким самим.
//
// ЧОМУ НЕ НА ЕКРАНІ ВХОДУ. Там ще невідомо, хто прийшов, — привітання
// вийшло б безадресним. І це перший екран: йому потрібні швидкість і
// спокій, а не анімація.
//
// КАРТИНОК МОЖЕ НЕ БУТИ. Файли кадрів лежать поруч із порталом і
// викладаються окремо. Поки їх немає — не показуємо нічого: порожня
// рамка гірша за відсутність привітання.
import { currentUserData, auth, localDateString, escHtml } from './common.js';

// Кадри махання. Один кадр — теж працює: тоді замість зміни кадрів
// персонаж похитується (див. клас pk-solo).
//
// ПЕРСОНАЖІВ ДВОЄ, І ВОНИ ЧЕРГУЮТЬСЯ ПО ДНЯХ. Той самий Пушик щоранку
// швидко стає меблями; різні — привід зазирнути. Вибір прив'язаний до
// дня й акаунта, а не випадковий: інакше два відкриття порталу за ранок
// дали б двох різних, і вийшло б не «сьогодні Креа», а миготіння.
export const PUSHYK_CAST = [
  { id:'mandrivnyk', frames:['pushyk-1.png','pushyk-2.png','pushyk-3.png'] },
  { id:'krea',       frames:['pushyk-kre-1.png','pushyk-kre-2.png','pushyk-kre-3.png'] }
];
export function castFor(seed){
  const s = String(seed || '');
  let h = 0;
  for(let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100000;
  return PUSHYK_CAST[h % PUSHYK_CAST.length];
}
const ROLES = ['student', 'parent'];      // вітаємо дітей і родини, не персонал
// ЗА ЗАМОВЧУВАННЯМ ВИМКНЕНО. Пушики махають уже на заставці запуску
// (#boot-splash у cabinet.html) — це те саме привітання, тільки в кращу
// мить: одразу після системної заставки, поки портал усе одно чекає на
// відповідь Firebase. Два привітання поспіль за одне відкриття — це вже
// не мило, а настирливо. Поставте true, якщо захочете ще й іменне
// привітання в кутку кабінету.
export const GREETING_IN_CABINET = false;
const SEEN_PREFIX = 'push_school_hello_';

// ── ЗВЕРТАННЯ ──
// Українською «Привіт, Марк!» звучить як бирка на парті. Кличний
// відмінок робить це живим зверненням, але вгадати його для будь-якого
// імені неможливо, а зіпсувати дитині імʼя — гірше, ніж не чіпати.
// Тому беремо лише випадки, у яких правило однозначне, а решту лишаємо
// як є: «Привіт, Марк!» читається нормально, «Привіт, Маркю!» — ні.
export function vocative(name){
  const n = String(name || '').trim();
  if(!n || /\s/.test(n) || n.length < 3) return n;
  const low = n.toLowerCase();
  const keep = s => n.slice(0, n.length - 1) + s;     // зберігаємо регістр початку
  if(/[іи]я$/.test(low)) return n.slice(0, -1) + 'є';  // Софія → Софіє, Марія → Маріє
  if(/ь?ка$/.test(low)) return keep('о');              // Оксанка → Оксанко
  if(/а$/.test(low))    return keep('о');              // Анна → Анно, Оксана → Оксано
  if(/я$/.test(low))    return keep('ю');              // Настя → Настю, Юля → Юлю
  if(/й$/.test(low))    return keep('ю');              // Андрій → Андрію, Сергій → Сергію
  if(/о$/.test(low))    return keep('е');              // Петро → Петре, Дмитро → Дмитре
  if(/[кгх]$/.test(low))return n + 'у';                // Марк → Марку, Олег → Олегу
  if(/[бвдзлмнпрстф]$/.test(low)) return n + 'е';      // Іван → Іване, Назар → Назаре
  return n;                                            // не впевнені — не чіпаємо
}

const LINES = ['Гарного дня!', 'Сьогодні все вийде!', 'Радий тебе бачити!',
               'Гарного настрою!', 'До нових наліпок!'];
export function helloText(role, name, pick = Math.random()){
  const line = LINES[Math.min(LINES.length - 1, Math.floor(pick * LINES.length))];
  const first = String(name || '').trim().split(/\s+/).filter(Boolean).pop() || '';
  // У батьків імʼя дитини у звертанні звучало б дивно — вітаємо просто.
  const head = (role === 'student' && first) ? `Привіт, ${vocative(first)}!` : 'Привіт!';
  return { head, line };
}

// Один раз на день на акаунт. Не «раз за сеанс»: дитина відкриває портал
// по кілька разів на день, і махання на кожне відкриття з милого стає
// настирливим.
export function shouldGreet(role, seen, today, reducedMotion, enabled = GREETING_IN_CABINET){
  if(!enabled) return false;
  if(!ROLES.includes(role)) return false;
  // «Зменшити рух» у налаштуваннях системи вмикають не просто так: для
  // частини людей рухома картинка — це нудота й головний біль.
  if(reducedMotion) return false;
  return seen !== today;
}

function seenKey(){
  return SEEN_PREFIX + ((auth && auth.currentUser && auth.currentUser.uid) || 'anon');
}

window.showPushykGreeting = function(opts){
  const force = !!(opts && opts.force);
  const role = (currentUserData && currentUserData.role) || '';
  const reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  let seen = '';
  try{ seen = localStorage.getItem(seenKey()) || ''; }catch(e){}
  if(!force && !shouldGreet(role, seen, localDateString, reduced)) return;
  if(document.getElementById('pk-hello')) return;

  const name = (currentUserData && (currentUserData.studentName || currentUserData.firstName)) || '';
  const { head, line } = helloText(role, name);

  const cast = castFor(localDateString + '|' + seenKey());
  const box = document.createElement('div');
  box.id = 'pk-hello';
  box.className = 'pk-hello';
  box.dataset.pushyk = cast.id;
  // Привітання — прикраса, а не повідомлення. Для програми читання
  // екрана його немає: почути «Привіт, Марку» замість свого кабінету —
  // не подарунок.
  box.setAttribute('aria-hidden', 'true');
  box.innerHTML = `
    <div class="pk-bubble"><b>${escHtml(head)}</b><span>${escHtml(line)}</span></div>
    <div class="pk-art">${cast.frames.map((src,i)=>
      `<img class="pk-f pk-f${i+1}" src="${escHtml(src)}" alt="">`).join('')}</div>`;

  const imgs = Array.from(box.querySelectorAll('.pk-f'));
  let loaded = 0, answered = 0;
  const decide = () => {
    // Немає жодного кадру — файли ще не викладені. Тихо прибираємо:
    // порожня рамка в кутку виглядала б як поломка.
    if(!loaded){ box.remove(); return; }
    // Один кадр замість трьох — махати нічим, тож персонаж похитується.
    if(loaded < 2) box.classList.add('pk-solo');
    box.classList.add('pk-go');
  };
  imgs.forEach(img=>{
    img.addEventListener('load', ()=>{ loaded++; if(++answered === imgs.length) decide(); });
    img.addEventListener('error', ()=>{ img.remove(); if(++answered === imgs.length) decide(); });
  });

  // Клік прибирає одразу: якщо дитині не до Пушика, вона не має його
  // пересиджувати.
  box.addEventListener('click', ()=>box.remove());
  document.body.appendChild(box);
  // Прибираємо самі, не покладаючись на подію кінця анімації: якщо
  // вкладку згорнули посеред сцени, анімація не завершиться ніколи, і
  // Пушик лишиться висіти в кутку до перезавантаження.
  setTimeout(()=>{ const el = document.getElementById('pk-hello'); if(el) el.remove(); }, 6000);
  try{ localStorage.setItem(seenKey(), localDateString); }catch(e){}
};
