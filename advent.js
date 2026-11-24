// ═══════════════════════════════════════════════════════════════
// advent.js — 🎄 АДВЕНТ-КАЛЕНДАР
//
// 1–21 грудня дитина щодня відкриває віконце й вішає нову іграшку на
// свою ялинку. Забула — можна відкрити наступного дня; пропущене двічі
// згорає (місце на ялинці лишається порожнім). 22 грудня, в останній
// навчальний день, засвічується зірка й випадає приз. Рівень призу — від
// кількості іграшок (золотий / срібний / бронзовий, пороги задає
// директор), сам приз — випадковий із тих, що внесла школа.
//
// ХТО ЩО БАЧИТЬ
//   • батьки (за активною дитиною) й учень — картка на «Сьогодні» і
//     повноекранна ялинка;
//   • класний керівник — з 22 грудня список призів свого класу з
//     відміткою «вручено»;
//   • директор — «Налаштування» → «🎄 Адвент-календар»: увімкнення,
//     пороги, призи, хто що отримав, CSV.
//
// ДЕ ЩО ЗБЕРІГАЄТЬСЯ (правила — database.rules.gen.py, блок «Адвент»)
//   advent_cfg                          — увімкнено, рік, початок, пороги;
//   advent_prizes/{id}                  — призи (бачить лише адміністрація);
//   advent/{рік}/open/{клас}/{учень}/dN — коли відкрили віконце N;
//   advent/{рік}/award/{клас}/{учень}   — приз (пише лише сервер).
// Розіграш — на сервері (netlify/functions/advent-draw.js) 22 грудня о
// 7:00 за Варшавою: телефон дитини не може «підкрутити» собі приз.
//
// КОПІЇ. tierOf, DEFAULT_TIERS, startMs і drawAtMs мають близнюків у
// netlify/functions/lib/advent-core.js; tests-advent.mjs звіряє обидві.
// ═══════════════════════════════════════════════════════════════
import { ref, get, set, update, remove, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, auth, currentUserData, sidOf, nameOf, showToast, escHtml } from './common.js';

// ── Календар і рівні (чисті функції — перевіряються в tests-advent.mjs) ──
export const DAY = 86400000;
export const DOORS = 21;                 // віконця з іграшками; 22-ге — зірка
export const DEFAULT_TIERS = { gold: 21, silver: 15, bronze: 7 };
export const TIERS = ['gold', 'silver', 'bronze'];
export const TIER_LABEL = { gold: 'Золотий приз', silver: 'Срібний приз', bronze: 'Бронзовий приз', none: 'Без призу' };
export const TIER_SHORT = { gold: 'Золотий', silver: 'Срібний', bronze: 'Бронзовий', none: '—' };
// 1 грудня, 00:00 за Варшавою (у грудні це UTC+1)
export const startMs = year => Date.UTC(Number(year), 11, 1) - 3600000;
// Розіграш: 22 грудня, 7:00 за Варшавою
export const drawAtMs = year => Date.UTC(Number(year), 11, 22, 6, 0);
// Котрий сьогодні день календаря (1 — це 1 грудня; 0 і менше — ще не почався)
export const advDay = (now, year) => Math.floor((now - startMs(year)) / DAY) + 1;
// Рік календаря: з липня — цей рік, до липня — минулий (січень після свят)
export const adventYear = (d = new Date()) => String(d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1);

export function tierOf(count, tiers){
  const t = { ...DEFAULT_TIERS, ...(tiers || {}) };
  if(count >= t.gold) return 'gold';
  if(count >= t.silver) return 'silver';
  if(count >= t.bronze) return 'bronze';
  return 'none';
}
export function countOpened(rec){
  if(!rec || typeof rec !== 'object') return 0;
  let n = 0;
  for(let d = 1; d <= DOORS; d++) if(typeof rec['d' + d] === 'number') n++;
  return n;
}
// Те саме вікно, що й у правилах бази: віконце N — у день N і наступний
export const canOpen = (n, D) => n >= 1 && n <= DOORS && (D === n || D === n + 1);
export function doorState(n, D, opened){
  if(n === 22) return D >= 22 ? 'star' : 'final';
  if(opened) return 'opened';
  if(n === D) return 'today';
  if(n === D - 1) return 'catchup';
  if(n < D - 1) return 'burned';
  return 'locked';
}
// Скільки ще можна встигнути: сьогоднішнє, учорашнє (якщо не відкрите) і всі майбутні
export function maxReachable(rec, D){
  let n = 0;
  for(let d = 1; d <= DOORS; d++){
    const o = rec && typeof rec['d' + d] === 'number';
    if(o || d >= D - 1) n++;
  }
  return n;
}
// Підказка під прогресом: що вже є і що ще можливо
export function tierHint(count, rec, D, tiers){
  const t = { ...DEFAULT_TIERS, ...(tiers || {}) };
  const now = tierOf(count, t), best = tierOf(maxReachable(rec, D), t);
  const next = now === 'none' ? 'bronze' : now === 'bronze' ? 'silver' : now === 'silver' ? 'gold' : null;
  return { now, best, next, need: next ? Math.max(0, t[next] - count) : 0 };
}

// ── Іграшки: 8 форм × 6 кольорів; день N — своя форма й колір ──
export const kindOf = n => (n - 1) % 8;
export const colorOf = n => (n - 1) % 6;
export const ORN_NAMES = [
  'Червона кулька', 'Блакитна кулька в горошок', 'Золотий дзвіночок', 'Рожева сніжинка',
  'Синій льодяник', 'Пряничок із білими ґудзиками', 'Червона рукавичка', 'Блакитна шкарпетка',
  'Золота кулька', 'Рожева кулька в горошок', 'Синій дзвіночок', 'Біла сніжинка',
  'Червоний льодяник', 'Пряничок із блакитними ґудзиками', 'Золота рукавичка', 'Рожева шкарпетка',
  'Синя кулька', 'Біла кулька в горошок', 'Червоний дзвіночок', 'Блакитна сніжинка', 'Золотий льодяник'
];
// «Добра справа на сьогодні» — по одній на віконце
export const KIND_DEEDS = [
  'Привітайся сьогодні з кимось, із ким зазвичай не говориш.',
  'Допоможи вдома накрити на стіл.',
  'Намалюй сніжинку й подаруй комусь.',
  'Скажи вчителю «дякую» за урок.',
  'Пригадай три речі, за які ти вдячний сьогодні.',
  'Завтра — Святий Миколай! Напиши йому листа або намалюй, що хочеш.',
  'Зроби комусь щирий комплімент.',
  'Прибери свою полицю чи стіл — хай буде місце для свята.',
  'Подзвони бабусі чи дідусеві й розкажи, як минув тиждень.',
  'Пограй із молодшими у їхню улюблену гру.',
  'Вивчи нове слово польською чи англійською й навчи когось.',
  'Зроби ранкову зарядку разом із родиною.',
  'Почитай 15 хвилин книжку, яку давно хотів.',
  'Пригости когось чимось смачним.',
  'Зроби паперову гірлянду для кімнати.',
  'Запитай батьків, якою була їхня зима в дитинстві.',
  'Відклади телефон на годину й пограйте разом у настільну гру.',
  'Подаруй усмішку кожному, кого сьогодні зустрінеш.',
  'Напиши листівку вчителеві чи другові.',
  'Допоможи комусь у класі з завданням.',
  'Загадай бажання на канікули й розкажи про нього вдома.'
];
// Місця на ялинці (центр іграшки в системі 390×520), рядами згори донизу
export const SLOTS = [
  [168,185],[222,185],
  [140,240],[195,240],[250,240],
  [112,295],[165,295],[218,295],[271,295],
  [140,350],[195,350],[250,350],
  [92,400],[144,400],[195,400],[246,400],[298,400],
  [75,440],[155,440],[235,440],[315,440]
];
// День → місце: перемішано, щоб ялинка заповнювалась рівномірно
export const SLOT_OF_DAY = [11,4,18,0,15,8,20,2,13,6,17,1,19,9,3,16,5,12,7,14,10];

// Кольори — лише токенами (cabinet.html → :root, --adv-*): класи f-*/s-*
const HOOK = '<path class="s-h" stroke-width="1.6" d="M20 1.5a3 3 0 1 1 0 .1"/>';
const CAP = '<rect class="f-g" x="15.5" y="5" width="9" height="6" rx="1.5"/>';
const SHAPES = [
  HOOK + CAP + '<circle class="f-b" cx="20" cy="27" r="16"/><path class="s-w o85" stroke-width="3" d="M5.5 22h29M4.6 30h30.8"/><path class="s-g" stroke-width="1.6" d="M5 26h30"/><circle class="f-w o45" cx="14" cy="20" r="3"/>',
  HOOK + CAP + '<circle class="f-b" cx="20" cy="27" r="16"/><circle class="f-w" cx="13" cy="24" r="2.2"/><circle class="f-w" cx="24" cy="19" r="2.2"/><circle class="f-w" cx="27" cy="31" r="2.2"/><circle class="f-w" cx="17" cy="35" r="2.2"/><circle class="f-g" cx="20" cy="27" r="1.6"/><circle class="f-g" cx="31" cy="24" r="1.6"/><circle class="f-g" cx="10" cy="31" r="1.6"/>',
  HOOK + '<path class="f-b" d="M20 7c-7 0-10 6-10 13v8l-4 6h28l-4-6v-8c0-7-3-13-10-13z"/><path class="s-w o80" stroke-width="2.4" stroke-linecap="round" d="M6 34h28"/><circle class="f-g" cx="20" cy="39" r="4"/><path class="s-w o55" stroke-width="2" stroke-linecap="round" d="M14 17c1-4 3-6 6-6"/>',
  HOOK + '<path class="s-b" stroke-width="3" stroke-linecap="round" d="M20 9v36M4.4 18l31.2 18M4.4 36l31.2-18"/><path class="s-b" stroke-width="2.2" stroke-linecap="round" d="M15 12l5 4 5-4M15 42l5-4 5 4M6 24l6 1-2 6M34 24l-6 1 2 6M6 30l6-1-2-6M34 30l-6-1 2-6"/><circle class="f-g" cx="20" cy="27" r="3.2"/>',
  HOOK + '<path class="s-w" stroke-width="7" stroke-linecap="round" d="M24 44V17a7 7 0 0 0-14 0"/><path class="s-b" stroke-width="7" stroke-dasharray="4 4" d="M24 44V17a7 7 0 0 0-14 0"/>',
  HOOK + '<path class="f-n" d="M20 6a7 7 0 0 1 4.6 12.3H32a3 3 0 0 1 0 6h-6v4l5 10a3 3 0 0 1-5.4 2.6L20 31l-5.6 9.9A3 3 0 0 1 9 38.3l5-10v-4H8a3 3 0 0 1 0-6h7.4A7 7 0 0 1 20 6z"/><circle class="f-w" cx="17.4" cy="12" r="1.3"/><circle class="f-w" cx="22.6" cy="12" r="1.3"/><path class="s-w" stroke-width="1.4" stroke-linecap="round" d="M17 15.5q3 2 6 0"/><circle class="f-b" cx="20" cy="22" r="1.6"/><circle class="f-b" cx="20" cy="27" r="1.6"/>',
  HOOK + '<path class="f-b" d="M13 14h14v8l5-4a3.5 3.5 0 0 1 4.5 5.3L28 33v7H12V22c0-4 0-8 1-8z"/><rect class="f-w" x="11" y="36" width="18" height="7" rx="2.5"/><path class="s-w o80" stroke-width="1.6" d="M16 22l2 2 2-2 2 2 2-2"/>',
  HOOK + '<path class="f-b" d="M14 13h14v17l-5 9a5 5 0 0 1-6.8 2L8 37a5 5 0 0 1-1.8-6.8L14 24z"/><rect class="f-w" x="12" y="7" width="18" height="8" rx="2.5"/><path class="s-w o70" stroke-width="1.8" stroke-linecap="round" d="M16 22h8M15 27h8"/><circle class="f-g" cx="24" cy="34" r="2"/>'
];
export function ornamentSvg(n, cls = ''){
  return `<svg class="adv-orn oc${colorOf(n)} ${cls}" viewBox="0 0 40 46" aria-hidden="true" focusable="false">${SHAPES[kindOf(n)]}</svg>`;
}
const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 1.8l3 6.4 7 .8-5.2 4.8 1.5 6.9L12 17.2l-6.3 3.5 1.5-6.9L2 9l7-.8z"/></svg>';

export function treeHtml(rec, star){
  const hung = [], empty = new Set(SLOTS.map((_, i) => i));
  for(let n = 1; n <= DOORS; n++){
    if(!(rec && typeof rec['d' + n] === 'number')) continue;
    const s = SLOT_OF_DAY[n - 1]; empty.delete(s);
    const [x, y] = SLOTS[s];
    hung.push(`<span class="adv-hang" style="left:${(x / 3.9).toFixed(2)}%;top:${(y / 5.2).toFixed(2)}%">${ornamentSvg(n)}</span>`);
  }
  const dots = [...empty].map(i => { const [x, y] = SLOTS[i];
    return `<i class="adv-spot" style="left:${(x / 3.9).toFixed(2)}%;top:${(y / 5.2).toFixed(2)}%"></i>`; }).join('');
  const count = hung.length;
  return `<div class="adv-tree" role="img" aria-label="Ялинка: ${count} іграшок із ${DOORS}${star ? ', зірка світиться' : ''}">
    <svg class="adv-tree-svg" viewBox="0 0 390 520" aria-hidden="true" focusable="false">
      <ellipse class="t-snow" cx="195" cy="500" rx="185" ry="26"/><ellipse class="t-snow2" cx="195" cy="494" rx="150" ry="14"/>
      <rect class="t-trunk" x="176" y="452" width="38" height="44" rx="4"/>
      <path class="t-1" d="M195 70L270 205H120z"/><path class="t-2" d="M195 130L322 330H68z"/><path class="t-3" d="M195 235L360 462H30z"/>
      <path class="t-shade" d="M195 70L270 205H232zM195 130L322 330H262zM195 235L360 462H282z"/>
      <path class="t-garl" d="M120 205Q150 214 195 207Q240 214 270 205M68 330Q130 342 195 333Q260 342 322 330M30 462Q110 474 195 465Q280 474 360 462"/>
      <path class="t-lights" d="M150 160Q195 182 246 168M110 262Q190 300 290 270M70 380Q190 430 330 392"/>
    </svg>
    ${dots}${hung.join('')}
    <span class="adv-star${star ? ' on' : ''}">${STAR}</span>
  </div>`;
}

// ── Хто дитина: активна дитина батька або сам учень ──
async function activeKid(){
  const u = currentUserData || {};
  if(u.role !== 'parent' && u.role !== 'student') return null;
  const cls = u.class, sid = (await sidOf(cls, u.studentName).catch(() => null)) || u.studentId || '';
  return cls && sid ? { cls, sid, name: u.studentName || '' } : null;
}
const clsLabel = c => String(c || '').replace('class_', '') + ' клас';
let cfgCache = null, cfgAt = 0;
async function readCfg(fresh){
  if(!fresh && cfgCache && Date.now() - cfgAt < 60e3) return cfgCache;
  const s = await get(ref(db, 'advent_cfg')).catch(() => null);
  cfgCache = s && s.exists() ? s.val() : {}; cfgAt = Date.now();
  return cfgCache;
}
const isOn = c => c && c.enabled === true && /^20\d\d$/.test(String(c.year || ''));
const val = async path => { const s = await get(ref(db, path)); return s.exists() ? s.val() : null; };

// ═══════════ КАРТКА НА «СЬОГОДНІ» (батьки й учень) ═══════════
let paintSeq = 0;
export async function paintFamilyCard(){
  const my = ++paintSeq;
  const boxes = ['p-advent', 's-advent'].map(id => document.getElementById(id)).filter(Boolean);
  if(!boxes.length) return;
  const hide = () => boxes.forEach(b => { b.hidden = true; b.innerHTML = ''; });
  const kid = await activeKid();
  if(!kid) return hide();
  const cfg = await readCfg();
  if(my !== paintSeq) return;
  if(!isOn(cfg)) return hide();
  const y = String(cfg.year), D = advDay(Date.now(), y);
  let html = '';
  if(D >= -6 && D <= 0){
    html = cardHtml('Скоро адвент-календар', `З 1 грудня щодня — нова іграшка на ялинку, а 22-го — приз`, '');
  }else if(D >= 1 && D <= 22){
    const rec = await val(`advent/${y}/open/${kid.cls}/${kid.sid}`).catch(() => null);
    if(my !== paintSeq) return;
    const cnt = countOpened(rec);
    let line;
    if(D === 22) line = 'Сьогодні засвітиться зірка — подивись свій приз';
    else{
      const todayOpen = rec && typeof rec['d' + D] === 'number';
      const late = D > 1 && !(rec && typeof rec['d' + (D - 1)] === 'number');
      line = (todayOpen ? 'Сьогоднішнє віконце відкрито' : `Віконце №${D} чекає`) + (late ? ` · і вчорашнє №${D - 1}` : '');
    }
    html = cardHtml('Адвент-календар', `${line} · на ялинці ${cnt} із ${DOORS}`, D === 22 || !(rec && rec['d' + D]) ? 'Відкрити' : 'Ялинка');
  }else if(D > 22 && D <= 62){
    const a = await val(`advent/${y}/award/${kid.cls}/${kid.sid}`).catch(() => null);
    if(my !== paintSeq) return;
    if(a && a.prize && !a.given) html = cardHtml('Твій приз адвенту', `${a.prize} — забери в класного керівника`, 'Ялинка');
  }
  boxes.forEach(b => { b.hidden = !html; b.innerHTML = html; });
}
function cardHtml(title, line, btn){
  return `<button type="button" class="adv-card" onclick="openAdvent()">
    <span class="adv-card-tree" aria-hidden="true">${ornamentSvg(9, 'adv-card-orn')}</span>
    <span class="adv-card-txt"><b>${escHtml(title)}</b><small>${escHtml(line)}</small></span>
    ${btn ? `<span class="adv-card-btn">${escHtml(btn)}</span>` : ''}
  </button>`;
}

// ═══════════ ЯЛИНКА НА ВЕСЬ ЕКРАН ═══════════
let ovState = null;
window.openAdvent = async function(){
  const kid = await activeKid();
  const cfg = await readCfg(true);
  if(!kid || !isOn(cfg)) return showToast('Адвент-календар зараз не працює');
  const y = String(cfg.year);
  document.querySelectorAll('.adv-ov').forEach(x => x.remove());
  const ov = document.createElement('div');
  ov.className = 'adv-ov';
  ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-label', 'Адвент-календар');
  document.body.appendChild(ov);
  document.body.classList.add('adv-open');
  ovState = { ov, kid, cfg, y, rec: null, award: null };
  ov.addEventListener('click', onOvClick);
  ov.addEventListener('keydown', e => { if(e.key === 'Escape') closeAdvent(); });
  await reloadOv();
  ov.querySelector('.adv-x')?.focus();
};
function closeAdvent(){
  document.querySelectorAll('.adv-ov').forEach(x => x.remove());
  document.body.classList.remove('adv-open');
  ovState = null;
  paintFamilyCard();
}
window.closeAdvent = closeAdvent;
async function reloadOv(){
  const st = ovState; if(!st) return;
  const D = advDay(Date.now(), st.y);
  st.rec = await val(`advent/${st.y}/open/${st.kid.cls}/${st.kid.sid}`).catch(() => null) || {};
  st.award = D >= 22 ? await val(`advent/${st.y}/award/${st.kid.cls}/${st.kid.sid}`).catch(() => null) : null;
  if(ovState !== st) return;
  st.ov.innerHTML = ovHtml(st, D);
}
function ovHtml(st, D){
  const { rec, cfg, kid } = st;
  const tiers = { ...DEFAULT_TIERS, ...(cfg.tiers || {}) };
  const cnt = countOpened(rec);
  const doors = [];
  for(let n = 1; n <= 22; n++){
    const s = doorState(n, D, rec && typeof rec['d' + n] === 'number');
    const inner = s === 'opened' ? `${ornamentSvg(n)}<small>${n}</small>`
      : s === 'today' ? `<b>${n}</b><small>сьогодні</small>`
      : s === 'catchup' ? `<b>${n}</b><small>встигни</small>`
      : s === 'burned' ? `<b class="x">${n}</b><small>пропущено</small>`
      : s === 'star' ? `${STAR}<small>зірка</small>`
      : s === 'final' ? `${STAR}<small>22 · приз</small>`
      : `<b>${n}</b>`;
    const act = s === 'today' || s === 'catchup' || s === 'star';
    const lbl = s === 'opened' ? `Віконце ${n}: ${ORN_NAMES[n - 1]}` : s === 'burned' ? `Віконце ${n}: пропущено`
      : s === 'locked' ? `Віконце ${n}: ще закрите` : s === 'final' ? 'Віконце 22: зірка й приз' : `Відкрити віконце ${n}`;
    doors.push(act
      ? `<button type="button" class="adv-door ${s}" data-door="${n}" aria-label="${lbl}">${inner}</button>`
      : `<span class="adv-door ${s}" role="img" aria-label="${lbl}">${inner}</span>`);
  }
  let banner = '';
  if(D >= 1 && D <= DOORS && !(rec && rec['d' + D]))
    banner += `<div class="adv-banner"><span><small>${D} ГРУДНЯ</small><b>Нова іграшка чекає у віконці №${D}</b></span><button type="button" class="adv-go" data-door="${D}">Відкрити</button></div>`;
  if(D >= 2 && D - 1 <= DOORS && !(rec && rec['d' + (D - 1)])){
    // 22-го після розіграшу 21-ше ще можна відкрити, але на приз воно вже не
    // вплине — кажемо чесно, щоб дитина не чекала кращого призу
    const late = D === 22 && Date.now() >= drawAtMs(st.y);
    banner += `<button type="button" class="adv-late" data-door="${D - 1}"><span>${late
      ? `Віконце №${D - 1} ще можна відкрити для краси ялинки — приз уже розіграно`
      : `Учорашнє віконце №${D - 1} ще можна відкрити — лише сьогодні${D === 22 ? ', до 7:00' : ''}`}</span><b>${late ? 'Відкрити' : 'Встигнути'}</b></button>`;
  }
  if(D >= 22) banner += prizeHtml(st.award, D, st.y);
  const h = tierHint(cnt, rec, D, tiers);
  const rank = t => t === 'none' ? 3 : TIERS.indexOf(t);
  const tierRows = TIERS.map(t => `<li class="${h.now === t ? 'now' : ''}"><i class="adv-dot ${t}"></i><span>${TIER_LABEL[t]}</span><em>${t === 'gold' ? `усі ${tiers.gold}` : `від ${tiers[t]}`}</em></li>`).join('');
  const hint = D > DOORS ? '' : h.next
    ? `<p class="adv-hint">${h.now === 'none' ? 'Поки без призу' : `Зараз: ${TIER_LABEL[h.now].toLowerCase()}`} · ${TIER_SHORT[h.next].toLowerCase()} — ще ${h.need} ${plural(h.need)}${rank(h.best) > rank(h.next) ? ' (на жаль, уже не встигнути)' : ''}</p>`
    : `<p class="adv-hint">Золотий рівень! Головне — не пропусти далі.</p>`;
  return `<div class="adv-wrap">
    <header class="adv-head">
      <button type="button" class="adv-x" aria-label="Закрити адвент-календар" data-act="close">✕</button>
      <span class="adv-title"><b>Адвент-календар</b><small>${escHtml(kid.name)} · ${escHtml(clsLabel(kid.cls))}</small></span>
      <span class="adv-count"><b>${cnt}</b><small>з ${DOORS} на ялинці</small></span>
    </header>
    ${treeHtml(rec, D >= 22)}
    ${banner}
    <section class="adv-doors" aria-label="Віконця 1–22 грудня">${doors.join('')}</section>
    <section class="adv-tiers" aria-label="Призи">
      <h4>22 грудня — зірка й приз</h4>
      <p>В останній навчальний день засвітиться зірка, і тобі випаде приз від школи. Що більше іграшок на ялинці — то кращий:</p>
      <ul>${tierRows}</ul>${hint}
      <p class="adv-small">Забув відкрити — є ще наступний день. Приз вручить класний керівник 22 грудня.</p>
    </section>
  </div>`;
}
const plural = n => (n % 10 === 1 && n % 100 !== 11) ? 'іграшка' : ([2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)) ? 'іграшки' : 'іграшок';
function prizeHtml(a, D, y){
  if(!a){
    return Date.now() < drawAtMs(y)
      ? `<div class="adv-prize wait"><b>Зірка вже світиться!</b><span>Призи розіграють сьогодні о 7:00 — зазирни трохи пізніше.</span></div>`
      : `<div class="adv-prize wait"><b>Дякуємо, що були з нами!</b><span>Цього разу в календарі не відкрито жодного віконця.</span></div>`;
  }
  if(a.tier === 'none' || !a.prize){
    return `<div class="adv-prize thanks"><b>Дякуємо, що були з нами!</b><span>${a.tier === 'none'
      ? `На ялинці ${a.count || 0} ${plural(a.count || 0)} — для призу треба було більше. Наступного року вийде!`
      : 'Твій приз уточнить класний керівник.'}</span></div>`;
  }
  return `<div class="adv-prize ${a.tier}">
    <span class="adv-tier ${a.tier}">${TIER_LABEL[a.tier]}</span>
    <small>ТОБІ ВИПАЛО</small><b>${escHtml(a.prize)}</b>${a.note ? `<span>${escHtml(a.note)}</span>` : ''}
    <em>${a.given ? '✓ Вручено' : 'Забери в класного керівника'}</em>
  </div>`;
}
async function onOvClick(e){
  const st = ovState; if(!st) return;
  if(e.target.closest('[data-act="close"]')) return closeAdvent();
  if(e.target.closest('[data-act="hang"]')){ st.ov.querySelector('.adv-rev')?.remove(); return reloadOv(); }
  const b = e.target.closest('[data-door]'); if(!b) return;
  const n = Number(b.dataset.door), D = advDay(Date.now(), st.y);
  if(n === 22){ st.ov.querySelector('.adv-prize')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
  if(!canOpen(n, D)) return showToast('Це віконце зараз не відкривається');
  if(st.rec && st.rec['d' + n]) return;
  b.disabled = true;
  try{
    await set(ref(db, `advent/${st.y}/open/${st.kid.cls}/${st.kid.sid}/d${n}`), serverTimestamp());
  }catch(err){
    b.disabled = false;
    return showToast(/permission/i.test(err.message || '') ? 'Це віконце вже не відкрити' : 'Не вдалося відкрити: ' + (err.message || ''));
  }
  st.rec = { ...(st.rec || {}), ['d' + n]: Date.now() };
  showReveal(st, n);
}
function showReveal(st, n){
  const cnt = countOpened(st.rec), tiers = { ...DEFAULT_TIERS, ...(st.cfg.tiers || {}) };
  const h = tierHint(cnt, st.rec, advDay(Date.now(), st.y), tiers);
  const pct = Math.round(cnt / DOORS * 100);
  const mark = t => `<i class="adv-mark ${t}" style="left:${(tiers[t] / DOORS * 100).toFixed(1)}%"></i>`;
  const d = document.createElement('div');
  d.className = 'adv-rev';
  d.innerHTML = `<div class="adv-rev-in">
    <small>ВІКОНЦЕ №${n} · ${n} ГРУДНЯ</small>
    <div class="adv-rev-orn">${ornamentSvg(n)}</div>
    <span class="adv-rev-new">Нова іграшка!</span>
    <h3>${escHtml(ORN_NAMES[n - 1])}</h3>
    <div class="adv-deed"><small>ДОБРА СПРАВА НА СЬОГОДНІ</small><span>${escHtml(KIND_DEEDS[n - 1])}</span></div>
    <div class="adv-prog"><span>На ялинці ${cnt} із ${DOORS}</span><span>${h.now === 'none' ? 'поки без призу' : TIER_LABEL[h.now].toLowerCase()}</span></div>
    <div class="adv-bar" role="img" aria-label="Зібрано ${cnt} із ${DOORS}"><i style="width:${pct}%"></i>${mark('bronze')}${mark('silver')}</div>
    <button type="button" class="adv-hang-btn" data-act="hang">Повісити на ялинку</button>
  </div>`;
  st.ov.appendChild(d);
  d.querySelector('.adv-hang-btn').focus();
}

// ═══════════ КЛАСНИЙ КЕРІВНИК: ВРУЧЕННЯ ═══════════
let tSeq = 0;
export async function paintTeacherCard(){
  const my = ++tSeq;
  const box = document.getElementById('t-advent'); if(!box) return;
  const hide = () => { box.hidden = true; box.innerHTML = ''; };
  const email = String(auth.currentUser?.email || '').toLowerCase();
  if(!email) return hide();
  const cfg = await readCfg();
  if(!isOn(cfg)) return hide();
  const y = String(cfg.year), D = advDay(Date.now(), y);
  if(D < 22 || D > 62) return hide();
  const ct = await val('class_teachers').catch(() => null) || {};
  const mine = Object.keys(ct).filter(c => String(ct[c] && ct[c].teacherEmail || '').toLowerCase() === email);
  if(!mine.length) return hide();
  const parts = [];
  for(const cls of mine){
    const aw = await val(`advent/${y}/award/${cls}`).catch(() => null) || {};
    const rows = [];
    for(const [sid, a] of Object.entries(aw)){
      if(!a || !a.prize) continue;
      rows.push({ sid, a, name: (await nameOf(cls, sid).catch(() => null)) || sid });
    }
    if(!rows.length) continue;
    rows.sort((p, q) => p.name.localeCompare(q.name, 'uk'));
    const done = rows.filter(r => r.a.given).length;
    parts.push(`<div class="adv-tc">
      <div class="adv-tc-h"><b>🎄 Призи адвенту · ${escHtml(clsLabel(cls))}</b><span>вручено ${done} із ${rows.length}</span></div>
      ${rows.map(r => `<label class="adv-tc-row"><input type="checkbox" ${r.a.given ? 'checked' : ''} data-cls="${escHtml(cls)}" data-sid="${escHtml(r.sid)}">
        <span><b>${escHtml(r.name)}</b><small>${escHtml(r.a.prize)}</small></span><em class="adv-tier ${r.a.tier}">${TIER_SHORT[r.a.tier] || ''}</em></label>`).join('')}
    </div>`);
  }
  if(my !== tSeq) return;
  if(!parts.length) return hide();
  box.hidden = false;
  box.innerHTML = parts.join('');
  box.onchange = async e => {
    const cb = e.target.closest('input[data-sid]'); if(!cb) return;
    cb.disabled = true;
    try{
      await update(ref(db, `advent/${y}/award/${cb.dataset.cls}/${cb.dataset.sid}`),
        { given: cb.checked, givenAt: Date.now(), givenBy: auth.currentUser.email });
      paintTeacherCard();
    }catch(err){ cb.checked = !cb.checked; cb.disabled = false; showToast('Не вдалося зберегти: ' + (err.message || '')); }
  };
}

// ═══════════ ДИРЕКТОР: НАЛАШТУВАННЯ, ПРИЗИ, РЕЗУЛЬТАТИ ═══════════
const WHO = { all: 'Усі класи', junior: '1–5 класи', senior: '6–11 класи' };
let adm = null;
window.openAdventAdmin = async function(){
  document.querySelectorAll('.adv-adm-ov').forEach(x => x.remove());
  const ov = document.createElement('div');
  ov.className = 'modal-overlay adv-adm-ov';
  ov.style.display = 'flex'; ov.style.zIndex = '1020';
  ov.innerHTML = '<div class="modal-content adv-adm" role="dialog" aria-modal="true" aria-label="Адвент-календар"><p class="empty-msg is-loading">Завантаження...</p></div>';
  document.body.appendChild(ov);
  ov.addEventListener('click', e => { if(e.target === ov) ov.remove(); });
  ov.addEventListener('keydown', e => { if(e.key === 'Escape') ov.remove(); });
  adm = { ov };
  await admLoad();
};
async function admLoad(){
  const st = adm; if(!st) return;
  const cfg = await readCfg(true);
  const y = isOn(cfg) ? String(cfg.year) : (cfg.year ? String(cfg.year) : adventYear());
  const [prizes, opens, awards, students] = await Promise.all([
    val('advent_prizes').catch(() => null), val(`advent/${y}/open`).catch(() => null),
    val(`advent/${y}/award`).catch(() => null), val('students_list').catch(() => null)]);
  Object.assign(st, { cfg, y, prizes: prizes || {}, opens: opens || {}, awards: awards || {}, students: students || {} });
  if(adm !== st) return;
  st.ov.querySelector('.adv-adm').innerHTML = admHtml(st);
  st.ov.querySelector('.adv-adm').onchange = admChange;
  st.ov.querySelector('.adv-adm').onclick = admClick;
}
export function forecast(opens, tiers){
  const by = { gold: 0, silver: 0, bronze: 0, none: 0 }; let kids = 0;
  for(const list of Object.values(opens || {}))
    for(const rec of Object.values(list || {})){
      const c = countOpened(rec); if(!c) continue;
      kids++; by[tierOf(c, tiers)]++;
    }
  return { kids, ...by };
}
// Призів рівня вистачить? Запасний (без ліміту) знімає питання
export function shortage(prizes, tier, kids){
  const list = Object.values(prizes || {}).filter(p => p && p.tier === tier);
  if(list.some(p => typeof p.qty !== 'number')) return 0;
  const units = list.reduce((s, p) => s + (Number(p.left) || 0), 0);
  return Math.max(0, kids - units);
}
function admHtml(st){
  const { cfg, y } = st, on = isOn(cfg);
  const tiers = { ...DEFAULT_TIERS, ...(cfg.tiers || {}) };
  const D = advDay(Date.now(), y);
  const fc = forecast(st.opens, tiers);
  const todayOpened = D >= 1 && D <= DOORS
    ? Object.values(st.opens).reduce((s, l) => s + Object.values(l || {}).filter(r => r && r['d' + D]).length, 0) : 0;
  const prizes = Object.entries(st.prizes).sort((a, b) => TIERS.indexOf(a[1].tier) - TIERS.indexOf(b[1].tier) || String(a[1].name).localeCompare(String(b[1].name), 'uk'));
  const warn = TIERS.map(t => ({ t, miss: shortage(st.prizes, t, fc[t]) })).filter(x => x.miss > 0);
  const nameOfLocal = (cls, sid) => (st.students[cls] && st.students[cls][sid]) || sid;
  const winners = [];
  for(const [cls, list] of Object.entries(st.awards))
    for(const [sid, a] of Object.entries(list || {})) if(a) winners.push({ cls, sid, a, name: nameOfLocal(cls, sid) });
  winners.sort((p, q) => (parseInt(p.cls.slice(6)) - parseInt(q.cls.slice(6))) || p.name.localeCompare(q.name, 'uk'));
  const given = winners.filter(w => w.a.given).length, withPrize = winners.filter(w => w.a.prize).length;
  const canDraw = on && Date.now() >= drawAtMs(y);
  return `
  <div class="adv-adm-h"><h3>🎄 Адвент-календар ${escHtml(y)}</h3><button type="button" class="adv-adm-x" data-a="close" aria-label="Закрити">✕</button></div>
  <p class="adv-adm-sub">Віконця 1–22 грудня · розіграш 22 грудня о 7:00 · класні керівники вручають того ж дня.</p>
  <label class="adv-adm-on"><input type="checkbox" data-a="enabled" ${on ? 'checked' : ''}> <span><b>Увімкнено</b> — картка зʼявиться в батьків і учнів за тиждень до старту</span></label>
  <div class="adv-adm-stats">
    <div><b>${fc.kids}</b><span>беруть участь</span></div>
    <div><b>${D >= 1 && D <= DOORS ? (fc.kids ? Math.round(todayOpened / fc.kids * 100) + '%' : '—') : '—'}</b><span>${D >= 1 && D <= DOORS ? `відкрили віконце №${D}` : 'відкривають сьогодні'}</span></div>
    <div><b>${fc.gold} · ${fc.silver} · ${fc.bronze}</b><span>зараз на рівнях з / с / б</span></div>
    <div><b>${withPrize ? `${given} / ${withPrize}` : '—'}</b><span>призів вручено</span></div>
  </div>
  <section class="adv-adm-sec"><h4>Рівні — скільки іграшок треба (із ${DOORS})</h4>
    <div class="adv-adm-tiers">${TIERS.map(t => `<label><i class="adv-dot ${t}"></i>${TIER_SHORT[t]} — від <input type="number" min="1" max="21" value="${tiers[t]}" data-tier="${t}" aria-label="${TIER_SHORT[t]}: від скількох іграшок"></label>`).join('')}</div>
    <p class="adv-adm-note">Менше бронзового порогу — без призу, але з подякою. Пороги мають іти за спаданням: золотий &gt; срібний &gt; бронзовий.</p>
  </section>
  <section class="adv-adm-sec"><h4>Призи</h4>
    ${prizes.length ? `<div class="adv-adm-pz">${prizes.map(([id, p]) => `<div class="adv-adm-row" data-id="${escHtml(id)}">
      <span class="nm"><b>${escHtml(p.name)}</b>${p.note ? `<small>${escHtml(p.note)}</small>` : ''}</span>
      <select data-f="tier" aria-label="Рівень">${TIERS.map(t => `<option value="${t}" ${p.tier === t ? 'selected' : ''}>${TIER_SHORT[t]}</option>`).join('')}</select>
      <select data-f="who" aria-label="Для кого">${Object.entries(WHO).map(([k, v]) => `<option value="${k}" ${p.who === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <input data-f="qty" inputmode="numeric" placeholder="∞" value="${typeof p.qty === 'number' ? p.qty : ''}" aria-label="Кількість (порожньо — без ліміту)">
      <span class="lf" title="Лишилось">${typeof p.qty === 'number' ? `лиш. ${Number(p.left) || 0}` : '∞'}</span>
      <button type="button" class="del" data-a="del" aria-label="Видалити приз ${escHtml(p.name)}">✕</button>
    </div>`).join('')}</div>` : '<p class="adv-adm-note">Призів ще немає. Додайте хоча б по одному «без ліміту» на кожен рівень — тоді без подарунка не лишиться ніхто.</p>'}
    ${warn.length ? `<p class="adv-adm-warn">${warn.map(w => `${TIER_SHORT[w.t]}: за прогнозом бракує ${w.miss}`).join(' · ')}. Додайте кількість або запасний приз без ліміту.</p>` : ''}
    <div class="adv-adm-add">
      <input data-n="name" maxlength="80" placeholder="Назва, напр. «Вибрати музику на перерві»" aria-label="Назва призу">
      <input data-n="note" maxlength="80" placeholder="Примітка (необовʼязково)" aria-label="Примітка">
      <select data-n="tier" aria-label="Рівень">${TIERS.map(t => `<option value="${t}">${TIER_SHORT[t]}</option>`).join('')}</select>
      <select data-n="who" aria-label="Для кого">${Object.entries(WHO).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
      <input data-n="qty" inputmode="numeric" placeholder="∞" aria-label="Кількість (порожньо — без ліміту)">
      <button type="button" class="ui-btn" data-a="add">+ Додати приз</button>
    </div>
    <p class="adv-adm-note">Порожня кількість — приз без ліміту (запасний): він дістається, коли лімітовані цього рівня скінчились. Дітям список призів не показується — це сюрприз.</p>
  </section>
  <section class="adv-adm-sec"><h4>Хто що отримав</h4>
    ${winners.length ? `<div class="adv-adm-tools"><button type="button" class="ui-btn ui-btn-2" data-a="csv">⬇️ CSV</button>${canDraw ? '<button type="button" class="ui-btn ui-btn-2" data-a="draw">Дорозіграти нових</button>' : ''}</div>
      <div class="adv-adm-win">${winners.map(w => `<div class="adv-adm-w"><span>${escHtml(w.name)}</span><span>${escHtml(clsLabel(w.cls))}</span>
        <span class="adv-tier ${w.a.tier}">${TIER_SHORT[w.a.tier] || ''}</span><span>${w.a.prize ? escHtml(w.a.prize) : (w.a.tier === 'none' ? 'подяка' : '⚠️ бракувало призу')}</span>
        <span>${w.a.prize ? (w.a.given ? '✓ вручено' : 'ні') : ''}</span></div>`).join('')}</div>`
      : `<p class="adv-adm-note">${canDraw ? 'Розіграшу ще не було.' : 'Зʼявиться 22 грудня о 7:00.'}</p>${canDraw ? '<button type="button" class="ui-btn" data-a="draw">Розіграти зараз</button>' : ''}`}
  </section>
  ${D > 22 && (Object.keys(st.opens).length || winners.length) ? `<section class="adv-adm-sec"><h4>Дані календаря ${escHtml(y)}</h4>
    <p class="adv-adm-note">За політикою приватності дані адвенту (коли відкривали віконця, хто що отримав) зберігаються до кінця навчального року. Коли призи вручено, їх можна видалити.</p>
    <button type="button" class="ui-btn ui-btn-2" data-a="wipe">🗑 Видалити дані адвенту ${escHtml(y)}</button></section>` : ''}`;
}
async function saveCfg(patch){
  const st = adm; const y = st.cfg.year ? String(st.cfg.year) : adventYear();
  const next = { enabled: !!st.cfg.enabled, year: y, start: startMs(y), tiers: { ...DEFAULT_TIERS, ...(st.cfg.tiers || {}) }, ...patch };
  await set(ref(db, 'advent_cfg'), next);
  cfgCache = next; cfgAt = Date.now();
}
async function admChange(e){
  const st = adm; if(!st) return;
  const t = e.target;
  try{
    if(t.dataset.a === 'enabled'){
      // Вмикаємо — завжди на поточний рік (минулорічний календар не підхопиться)
      await saveCfg(t.checked ? { enabled: true, year: adventYear(), start: startMs(adventYear()) } : { enabled: false });
      showToast(t.checked ? '🎄 Адвент-календар увімкнено' : 'Адвент-календар вимкнено');
      paintFamilyCard();
      return admLoad();
    }
    if(t.dataset.tier){
      const tiers = { ...DEFAULT_TIERS, ...(st.cfg.tiers || {}) };
      const v = Math.round(Number(t.value));
      const nt = { ...tiers, [t.dataset.tier]: v };
      if(!(v >= 1 && v <= DOORS) || !(nt.gold > nt.silver && nt.silver > nt.bronze)){
        t.value = tiers[t.dataset.tier];
        return showToast('Пороги: від 1 до 21, золотий > срібний > бронзовий');
      }
      await saveCfg({ tiers: nt });
      showToast('Пороги збережено');
      return admLoad();
    }
    const row = t.closest('.adv-adm-row');
    if(row && t.dataset.f){
      const id = row.dataset.id, p = { ...st.prizes[id] };
      if(t.dataset.f === 'qty'){
        const raw = t.value.trim();
        const oldQ = typeof p.qty === 'number' ? p.qty : null, oldL = Number(p.left) || 0;
        if(raw === ''){ delete p.qty; p.left = 0; }
        else{
          const q = Math.round(Number(raw));
          if(!(q >= 1 && q <= 10000)){ t.value = oldQ ?? ''; return showToast('Кількість — від 1 до 10000 або порожньо (без ліміту)'); }
          // Уже розіграні одиниці не повертаємо: лишок зсувається на різницю
          p.left = oldQ === null ? q : Math.max(0, oldL + (q - oldQ));
          p.qty = q;
        }
      }else p[t.dataset.f] = t.value;
      await set(ref(db, `advent_prizes/${id}`), p);
      showToast('Збережено');
      return admLoad();
    }
  }catch(err){ showToast('Не вдалося зберегти: ' + (err.message || '')); admLoad(); }
}
async function admClick(e){
  const st = adm; if(!st) return;
  const b = e.target.closest('[data-a]'); if(!b || b.tagName === 'INPUT') return;
  const a = b.dataset.a;
  if(a === 'close'){ st.ov.remove(); adm = null; return; }
  if(a === 'add'){
    const box = b.closest('.adv-adm-add'), f = k => box.querySelector(`[data-n="${k}"]`).value.trim();
    const name = f('name').slice(0, 80);
    if(!name) return showToast('Вкажіть назву призу');
    const p = { name, note: f('note').slice(0, 80), tier: f('tier'), who: f('who'), left: 0 };
    if(f('qty')){
      const q = Math.round(Number(f('qty')));
      if(!(q >= 1 && q <= 10000)) return showToast('Кількість — від 1 до 10000 або порожньо (без ліміту)');
      p.qty = q; p.left = q;
    }
    if(!p.note) delete p.note;
    const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    try{ await set(ref(db, `advent_prizes/${id}`), p); showToast('Приз додано'); admLoad(); }
    catch(err){ showToast('Не вдалося додати: ' + (err.message || '')); }
    return;
  }
  if(a === 'del'){
    const id = b.closest('.adv-adm-row').dataset.id;
    if(!confirm(`Видалити приз «${st.prizes[id]?.name || ''}»? Уже розіграні не зміняться.`)) return;
    try{ await set(ref(db, `advent_prizes/${id}`), null); admLoad(); }
    catch(err){ showToast('Не вдалося видалити: ' + (err.message || '')); }
    return;
  }
  if(a === 'csv'){
    const rows = [['Клас', 'Учень', 'Іграшок', 'Рівень', 'Приз', 'Вручено']];
    for(const [cls, list] of Object.entries(st.awards))
      for(const [sid, w] of Object.entries(list || {})) if(w)
        rows.push([clsLabel(cls), (st.students[cls] && st.students[cls][sid]) || sid, w.count || '', TIER_SHORT[w.tier] || '', w.prize || '', w.given ? 'так' : 'ні']);
    // Клітинка з = + - @ на початку в Excel стала б формулою — гасимо апострофом
    const cell = v => { const t = String(v); return `"${(/^[=+\-@]/.test(t) ? "'" + t : t).replace(/"/g, '""')}"`; };
    const csv = '\ufeff' + rows.map(r => r.map(cell).join(';')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `advent-${st.y}.csv`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return;
  }
  if(a === 'wipe'){
    const left = Object.values(st.awards).reduce((n, l) => n + Object.values(l || {}).filter(w => w && w.prize && !w.given).length, 0);
    if(!confirm(`Видалити всі дані адвенту ${st.y}: віконця й призи?${left ? ` Ще не вручено призів: ${left}.` : ''} Це не скасувати.`)) return;
    try{ await remove(ref(db, `advent/${st.y}`)); showToast('Дані адвенту видалено'); admLoad(); }
    catch(err){ showToast('Не вдалося: ' + (err.message || '')); }
    return;
  }
  if(a === 'draw'){
    b.disabled = true;
    try{
      const idToken = await window.authIdToken();
      const r = await fetch('/.netlify/functions/advent-draw-now', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }) });
      const d = await r.json().catch(() => ({}));
      if(!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      showToast(d.skip ? d.skip : `Розіграно: ${d.drawn || 0}`);
      admLoad();
    }catch(err){ b.disabled = false; showToast('Не вдалося: ' + (err.message || '')); }
  }
}

// ── Коли малювати картки ──
// Дашборд перемальовується сам, а картка адвенту від нього не залежить:
// оновлюємо після входу, при зміні дитини чи кабінету і коли людина
// повертається у вкладку (міг змінитися день).
function paintAll(){ paintFamilyCard().catch(() => {}); paintTeacherCard().catch(() => {}); }
window.paintAdvent = paintAll;
window.addEventListener('push:context', () => { cfgCache = null; setTimeout(paintAll, 300); });
document.addEventListener('visibilitychange', () => { if(!document.hidden) paintAll(); });
// Вхід буває будь-коли (людина довго стоїть на екрані входу), тож не
// чекаємо обмежений час, а дешево звіряємо «хто зараз» раз на 3 секунди.
let who = '';
function watchUser(){
  const u = currentUserData;
  const key = u ? `${u.email || ''}|${u.role || ''}|${u.class || ''}|${u.studentName || ''}` : '';
  if(key !== who){ who = key; if(key) paintAll(); }
}
setInterval(watchUser, 3000);
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchUser); else watchUser();
