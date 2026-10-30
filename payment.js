// ═══════════════════════════════════════════════════════════════
// payment.js — реквізити школи й QR-код переказу (стандарт ZBP).
//
// НАВІЩО. Оплата за навчання йде звичайним переказом, і батько щоразу
// переписує з паперу 26 цифр рахунку й призначення платежу. Помилка в
// призначенні означає, що бухгалтерія не може зрозуміти, за яку дитину
// прийшли гроші, — і починається листування.
//
// ── ЧОМУ САМЕ QR, А НЕ КНОПКА «ОПЛАТИТИ» ───────────────────────
//
// Кнопка «оплатити» — це платіжний шлюз: договір, верифікація фірми і
// комісія з кожного платежу. QR за стандартом Związku Banków Polskich —
// відкрита й безкоштовна специфікація, яку читають застосунки всіх
// польських банків. Гроші йдуть прямо на рахунок школи, посередника
// немає, платити нікому не треба.
//
// Ціна цього — портал НЕ ЗНАЄ, чи платіж пройшов. Звірка лишається
// ручною, за випискою. Для школи це не крок назад: зараз так само, лише
// ще й з ручним переписуванням цифр.
//
// ── ФОРМАТ РЯДКА (рекомендація ZBP, стандарт 2D) ───────────────
//
//   NIP|PL|рахунок|сума|назва|призначення|рез1|рез2|рез3
//
//   рахунок      — 26 цифр без пробілів і без «PL»
//   сума         — РІВНО 6 цифр у грошах; «000000» = вводить людина
//   назва        — до 20 знаків
//   призначення  — до 32 знаків
//   увесь рядок  — до 160 знаків
//
// Ліміти жорсткі й мовчазні: застосунок банку просто не розпізнає
// задовгий код, не пояснюючи чому. Тому все ріжеться тут, у коді, а не
// сподіваннями на те, що школа впишеться в рамку.
//
// ── ЧОМУ ГЕНЕРУЄМО КОД САМІ, А НЕ ЧЕРЕЗ СЕРВІС ─────────────────
//
// Онлайн-генератори QR роблять те саме, але для цього треба відправити
// їм номер рахунку школи, суму й прізвище дитини. Це персональні дані
// родини на чужому сервері заради картинки, яку браузер малює сам.
// ═══════════════════════════════════════════════════════════════
import { ref, get, child, set } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, currentUserData, escHtml, escJs, showToast, logAction, localDateString } from './common.js';

// ── ЧИСТА ЧАСТИНА ───────────────────────────────────────────────

export const ZBP_MAX_NAME  = 20;
export const ZBP_MAX_TITLE = 32;
export const ZBP_MAX_TOTAL = 160;

// Рахунок у базі зберігаємо як завгодно — люди пишуть його з пробілами,
// з «PL» і без. У код він має піти 26 цифрами поспіль.
export function ibanDigits(iban){
  const d = String(iban || '').toUpperCase().replace(/^PL/, '').replace(/\D/g, '');
  return d;
}
export function ibanValid(iban){ return ibanDigits(iban).length === 26; }

// Для показу — звичними четвірками: 48 1090 1883 0000 0001 5014 8624
export function ibanPretty(iban){
  const d = ibanDigits(iban);
  if(d.length !== 26) return String(iban || '');
  return d.slice(0,2) + ' ' + (d.slice(2).match(/.{1,4}/g) || []).join(' ');
}

// Сума — рівно шість цифр у грошах. Нуль означає «людина введе сама», і
// це не те саме, що «нуль злотих»: за навчання портал суми не знає.
//
// Шість цифр — це стеля 9999,99 zł. Більше стандарт не вміє, тож замість
// мовчазного обрізання (яке перетворило б 12 000 на 2 000) повертаємо
// null, а показ пояснює це людині.
export function zbpAmount(pln){
  const v = Number(pln);
  if(!v || v <= 0) return '000000';
  const gr = Math.round(v * 100);
  if(gr > 999999) return null;
  return String(gr).padStart(6, '0');
}

// Призначення платежу. Префікс задає школа («edukacja w szkole»), далі
// імʼя дитини — і все це має влізти в 32 знаки.
//
// СКОРОЧУЄМО ІМʼЯ, А НЕ ПРЕФІКС. Префікс — те, за чим бухгалтерія
// розрізняє призначення платежу; імʼя ж лишається впізнаваним і як
// «Voloshko M.». Тому черга така: повне імʼя → прізвище з ініціалом →
// саме прізвище → і лише тоді обрізання.
export function buildTitle(prefix, studentName, max){
  const lim = max || ZBP_MAX_TITLE;
  const pre = String(prefix || '').trim();
  const name = String(studentName || '').trim().replace(/\s+/g, ' ');
  const join = (n) => (pre ? pre + ' ' : '') + n;
  if(!name) return pre.slice(0, lim);

  const full = join(name);
  if(full.length <= lim) return full;

  // У списках класу записано «ПРІЗВИЩЕ Імʼя» — перше слово прізвище.
  const parts = name.split(' ');
  const surname = parts[0];
  const rest = parts.slice(1);
  if(rest.length){
    const withInitial = join(surname + ' ' + rest[0][0] + '.');
    if(withInitial.length <= lim) return withInitial;
  }
  const onlySurname = join(surname);
  if(onlySurname.length <= lim) return onlySurname;
  return onlySurname.slice(0, lim);
}

// Сам рядок коду.
export function zbpString({ nip, iban, amount, name, title }){
  const acc = ibanDigits(iban);
  const amt = zbpAmount(amount);
  if(acc.length !== 26 || amt === null) return null;
  const clean = (s, n) => String(s || '').replace(/[|\n\r]/g, ' ').trim().slice(0, n);
  const parts = [
    String(nip || '').replace(/\D/g, '').slice(0, 10),
    'PL',
    acc,
    amt,
    clean(name, ZBP_MAX_NAME),
    clean(title, ZBP_MAX_TITLE),
    '', '', ''
  ];
  const out = parts.join('|');
  return out.length <= ZBP_MAX_TOTAL ? out : null;
}

// ── ІМʼЯ ДИТИНИ ЛАТИНИЦЕЮ ───────────────────────────────────────
// Школа просить у призначенні платежу «прізвище ім’я учня англійською»
// (edukacja w szkole Voloshko Mykola), а в списках класу імена записані
// кирилицею. Переписувати батько не мусить: транслітеруємо за офіційною
// таблицею України (постанова КМУ № 55, 2010) — за нею ж пишуть імена в
// закордонних паспортах. Особливі випадки таблиці: «зг» → zgh, а Є Ї Й Ю Я
// на початку слова — Ye Yi Y Yu Ya, далі — ie i i iu ia.
const UA_LAT = { а:'a', б:'b', в:'v', г:'h', ґ:'g', д:'d', е:'e', є:'ie', ж:'zh', з:'z', и:'y', і:'i', ї:'i', й:'i',
  к:'k', л:'l', м:'m', н:'n', о:'o', п:'p', р:'r', с:'s', т:'t', у:'u', ф:'f', х:'kh', ц:'ts', ч:'ch', ш:'sh',
  щ:'shch', ь:'', ю:'iu', я:'ia',
  // Російські літери трапляються в іменах із документів — щоб не губились
  ы:'y', э:'e', ё:'io', ъ:'' };
const UA_FIRST = { є:'ye', ї:'yi', й:'y', ю:'yu', я:'ya' };
const APOS = /['’ʼ`]/g;
function translitWord(w){
  const s = w.toLowerCase().replace(APOS, '');
  let out = '';
  for(let i = 0; i < s.length; i++){
    const c = s[i];
    if(c === 'з' && s[i + 1] === 'г'){ out += 'zgh'; i++; continue; }
    const first = i === 0 || !/[а-яґєіїё]/.test(s[i - 1]);
    out += first && UA_FIRST[c] ? UA_FIRST[c] : (UA_LAT[c] !== undefined ? UA_LAT[c] : c);
  }
  return out;
}
// «ВОЛОШКО Микола» → «Voloshko Mykola»; подвійне прізвище — кожна частина з великої
export function latinName(name){
  const s = String(name || '').trim().replace(/\s+/g, ' ');
  if(!s) return '';
  if(!/[А-Яа-яҐґЄєІіЇїЁёЫыЭэЪъ]/.test(s)) return s;        // уже латиницею — не чіпаємо
  return s.split(' ').map(word => word.split('-').map(p => {
    const t = translitWord(p);
    return t ? t[0].toUpperCase() + t.slice(1) : t;
  }).join('-')).join(' ');
}
// Призначення для КОПІЮВАННЯ — повне: обмеження в 32 знаки є лише в QR-коді
// (у звичайному переказі банки дають 140). Скорочує тільки buildTitle для QR.
export const fullTitle = (prefix, name) => [String(prefix || '').trim(), String(name || '').trim()].filter(Boolean).join(' ').slice(0, 140);

// ── РАХУНКИ ДЛЯ ОПЛАТИ: НАВЧАННЯ, ХАРЧУВАННЯ, АВТОБУС… ────────────
// payment_details.accounts/{a1…} — кожен рахунок окремою карткою у
// вкладці батьків «💳 Оплата»:
//   kind   — 'tuition' (навчання) | 'meals' (харчування) | 'bus' (автобус) | 'other'
//   label  — назва картки (порожньо — назва виду: «Навчання», «Харчування»…)
//   from/to — для яких класів (навчання 0–8 і 10–11 платять на різні рахунки)
//   fullName, iban, name (до 20 знаків — для QR), nip, regon, bank, address
//   title  — призначення платежу з підстановками:
//            {дитина}  → прізвище й імʼя дитини латиницею
//            {тиждень} → дати тижня («03.11-07.11»), батько обирає який
//   amounts — варіанти суми [{sum, label}] («125 zł — обіди й підвечірки»)
//   note   — пояснення школи (вільний текст), qr — показувати QR (типово так)
// Старий формат (titlePrefix, amount, усе одним набором у payment_details)
// читаємо як і раніше — доки директор не збереже нові.
export const KINDS = {
  tuition: { icon: '🎓', label: 'Навчання' },
  meals:   { icon: '🍽️', label: 'Харчування' },
  bus:     { icon: '🚌', label: 'Автобус на басейн' },
  other:   { icon: '💳', label: 'Інша оплата' }
};
const KIND_ORDER = Object.keys(KINDS);
export const ACC_FIELDS = ['fullName', 'address', 'nip', 'regon', 'bank', 'iban', 'name', 'title', 'note', 'label'];
export const CLASS_MIN = 0, CLASS_MAX = 11;
export const T_CHILD = '{дитина}', T_WEEK = '{тиждень}';
const intIn = (v, lo, hi, dflt) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : dflt; };
const list = v => Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.keys(v).sort((a, b) => a - b).map(k => v[k]) : []);
function normalize(id, a, legacyQr){
  a = a || {};
  const from = intIn(a.from, CLASS_MIN, CLASS_MAX, CLASS_MIN), to = intIn(a.to, CLASS_MIN, CLASS_MAX, CLASS_MAX);
  const amounts = list(a.amounts).filter(x => x && Number(x.sum) > 0).map(x => ({ sum: Number(x.sum), label: String(x.label || '') }));
  if(!amounts.length && Number(a.amount) > 0) amounts.push({ sum: Number(a.amount), label: '' });
  const title = a.title != null && String(a.title).trim() ? String(a.title)
    : `${String(a.titlePrefix || '').trim()} ${T_CHILD}`.trim();
  return { id, ...a, kind: KINDS[a.kind] ? a.kind : 'tuition', from: Math.min(from, to), to: Math.max(from, to),
           title, amounts, qr: a.qr === false ? false : (a.qr === true || legacyQr !== false) };
}
export function accountsOf(d){
  d = d || {};
  let out = [];
  if(d.accounts && typeof d.accounts === 'object')
    out = Object.keys(d.accounts).map(id => normalize(id, d.accounts[id], d.qr));
  else if(d.iban || d.fullName || d.name)
    out = [normalize('a1', { from: CLASS_MIN, to: CLASS_MAX, ...Object.fromEntries(['fullName','address','nip','regon','bank','iban','name','titlePrefix','amount'].map(k => [k, d[k]]).filter(([, v]) => v != null)) }, d.qr === true)];
  return out.sort((x, y) => KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind) || Number(x.id.slice(1)) - Number(y.id.slice(1)));
}
export const classNum = cls => { const m = /^class_(\d{1,2})$/.exec(String(cls || '')); return m ? Number(m[1]) : null; };
export const accountsForClass = (d, cls) => { const n = classNum(cls); return n == null ? [] : accountsOf(d).filter(a => n >= a.from && n <= a.to); };
export const rangeLabel = a => a.from === a.to ? `${a.from} клас` : `${a.from}–${a.to} класи`;
export const kindLabel = a => (a.label && String(a.label).trim()) || KINDS[a.kind].label;
// Класи порталу (1–11) без рахунку за НАВЧАННЯ — показуємо директору.
// Харчування й автобус бувають не для всіх — їх не рахуємо.
export function classGaps(accs, lo = 1, hi = CLASS_MAX){
  const t = accs.filter(a => (a.kind || 'tuition') === 'tuition');
  const out = [];
  for(let n = lo; n <= hi; n++) if(!t.some(a => n >= a.from && n <= a.to)) out.push(n);
  return out;
}
export function classOverlaps(accs, lo = 1, hi = CLASS_MAX){
  const t = accs.filter(a => (a.kind || 'tuition') === 'tuition');
  const out = [];
  for(let n = lo; n <= hi; n++) if(t.filter(a => n >= a.from && n <= a.to).length > 1) out.push(n);
  return out;
}
const numsLabel = ns => ns.join(', ');

// ── ТИЖДЕНЬ ДЛЯ ПРИЗНАЧЕННЯ («03.11-07.11») ────────────────────
// Звичайний дефіс, а не тире: банківські системи приймають у
// призначенні не всі символи.
const pad2 = n => String(n).padStart(2, '0');
export function weekRange(today, offset = 0){
  const [y, m, d] = String(today).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const wd = (dt.getDay() + 6) % 7;                  // 0 — понеділок
  dt.setDate(dt.getDate() - wd + 7 * offset);
  const mon = new Date(dt), fri = new Date(dt); fri.setDate(fri.getDate() + 4);
  const f = x => `${pad2(x.getDate())}.${pad2(x.getMonth() + 1)}`;
  return `${f(mon)}-${f(fri)}`;
}
// Типово — наступний тиждень із пʼятниці по неділю, інакше поточний
export const defaultWeekOffset = today => { const [y, m, d] = String(today).split('-').map(Number); const w = new Date(y, m - 1, d).getDay(); return (w === 5 || w === 6 || w === 0) ? 1 : 0; };

// Призначення з шаблону. max — для QR (32 знаки): тоді скорочуємо ІМʼЯ
// (повне → прізвище з ініціалом → прізвище), а решту шаблону не чіпаємо.
export function fillTitle(tpl, name, week, max){
  const t = String(tpl || T_CHILD).replace(/\s+/g, ' ').trim();
  const nm = String(name || '').trim().replace(/\s+/g, ' ');
  const parts = nm.split(' ');
  const variants = [nm];
  if(parts.length > 1) variants.push(`${parts[0]} ${parts[1][0]}.`);
  variants.push(parts[0] || '');
  for(const v of variants){
    const s = t.split(T_CHILD).join(v).split(T_WEEK).join(week || '').replace(/\s+/g, ' ').trim();
    if(!max || s.length <= max) return max ? s : s.slice(0, 140);
  }
  return t.split(T_CHILD).join(parts[0] || '').split(T_WEEK).join(week || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// ── РЕКВІЗИТИ ШКОЛИ ─────────────────────────────────────────────
let payCache = null;
export async function loadPaymentDetails(force){
  if(payCache && !force) return payCache;
  try{
    const snap = await get(child(ref(db), 'payment_details'));
    payCache = snap.exists() ? (snap.val() || {}) : {};
  }catch(e){
    console.warn('[Push School] реквізити оплати:', e.message);
    payCache = {};
  }
  return payCache;
}
window.invalidatePaymentDetails = () => { payCache = null; };

// ── ПОКАЗ ───────────────────────────────────────────────────────

// QR малює qrcode-generator, підключений у cabinet.html. Якщо
// бібліотека не приїхала — не мовчимо: реквізити показуємо текстом, бо
// заплатити людина має змогти в будь-якому разі.
function qrSvg(text, size){
  try{
    if(typeof qrcode !== 'function') return null;
    // Тип 0 — автоматичний вибір версії під довжину рядка.
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: Math.max(3, Math.round((size||220)/q.getModuleCount())), margin: 8 });
  }catch(e){ console.warn('[Push School] QR:', e.message); return null; }
}

window.copyPayField = async function(what, value){
  try{
    await navigator.clipboard.writeText(value);
    showToast('✅ Скопійовано: ' + what);
  }catch(e){
    // Clipboard API вимагає https і дозволу; на старих телефонах його
    // немає. Запасний шлях — старе доброго виділення.
    const ta = document.createElement('textarea');
    ta.value = value; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try{ document.execCommand('copy'); showToast('✅ Скопійовано: ' + what); }
    catch(e2){ alert(value); }
    ta.remove();
  }
};

// ОПЛАТА ЧЕРЕЗ ПОРТАЛ — У РОЗРОБЦІ. Поки так, батькам показуємо
// РЕКВІЗИТИ (з кнопками «Копіювати» і QR-кодом переказу) і чесно кажемо,
// що платити треба звичайним переказом. QR — окремо для кожного рахунку
// (вимикається в налаштуваннях рахунку).
export const PAY_IN_DEV = 'Оплата через портал — у розробці. Поки що оплачуйте звичайним банківським переказом за реквізитами нижче.';
export const LATIN_NOTE = 'Імʼя дитини латиницею портал підставив сам — перевірте, щоб воно збігалося з написанням у документах дитини.';

// Що обрав батько в кожній картці: {id: {amt: індекс суми, week: 0|1}}
const picks = {};
const pickOf = (a, today) => picks[a.id] || (picks[a.id] = { amt: 0, week: defaultWeekOffset(today) });

// Одна картка рахунку
export function accountHtml(a, student, today = localDateString){
  const hasAcc = !!(a.iban && ibanValid(a.iban));
  const lat = latinName(student);
  const pk = pickOf(a, today);
  const withWeek = String(a.title || '').includes(T_WEEK);
  const week = withWeek ? weekRange(today, pk.week) : '';
  const title = fillTitle(a.title, lat, week);
  const am = a.amounts[pk.amt] || a.amounts[0] || null;
  const amount = am ? am.sum : 0;
  const acc = hasAcc ? ibanPretty(a.iban) : '';
  const who = a.fullName || a.name || '';
  const k = KINDS[a.kind] || KINDS.other;
  let qr = '';
  if(a.qr !== false && hasAcc){
    const code = zbpString({ nip: a.nip, iban: a.iban, amount: amount && zbpAmount(amount) ? amount : 0,
      name: a.name || who.slice(0, ZBP_MAX_NAME), title: fillTitle(a.title, lat, week, ZBP_MAX_TITLE) });
    const svg = code ? qrSvg(code, 200) : null;
    qr = svg ? `<div class="pay-qr">${svg}<span>Наведіть камеру в застосунку банку${amount ? ` · ${escHtml(amount.toFixed(2))} zł` : ''}</span></div>` : '';
  }
  const row = (label, value, copy) => value ? `
    <div class="pay-row">
      <span class="pay-label">${escHtml(label)}</span>
      <b class="pay-value">${escHtml(value)}</b>
      <button type="button" class="pay-copy"
        onclick="copyPayField('${escJs(label)}','${escJs(copy !== undefined ? copy : value)}')">Копіювати</button>
    </div>` : '';
  const chips = (act, items, on) => `<div class="pay-chips" role="group">${items.map((t, i) =>
    `<button type="button" class="pay-chip${i === on ? ' on' : ''}" aria-pressed="${i === on}" data-pay="${act}:${escHtml(a.id)}:${i}">${t}</button>`).join('')}</div>`;
  return `<section class="pay-card pay-k-${escHtml(a.kind)}" data-acc="${escHtml(a.id)}">
    <header class="pay-card-h"><span class="pay-card-ic" aria-hidden="true">${k.icon}</span><b${a.label && String(a.label).trim() ? ' data-no-i18n' : ''}>${escHtml(kindLabel(a))}</b></header>
    ${a.note ? `<div class="pay-text" data-no-i18n>${escHtml(String(a.note)).replace(/\n/g, '<br>')}</div>` : ''}
    ${a.amounts.length > 1 ? chips('amt', a.amounts.map(x => `<b>${escHtml(x.sum.toFixed(0))} zł</b>${x.label ? ` <small data-no-i18n>${escHtml(x.label)}</small>` : ''}`), pk.amt) : ''}
    ${withWeek ? `<div class="pay-sub">За який тиждень</div>${chips('week', [`Цей · ${escHtml(weekRange(today, 0))}`, `Наступний · ${escHtml(weekRange(today, 1))}`], pk.week)}` : ''}
    ${row('Отримувач', who)}
    ${row('Адреса', a.address || '')}
    ${row('NIP', a.nip || '')}
    ${row('REGON', a.regon || '')}
    ${row('Банк', a.bank || '')}
    ${row('Рахунок', acc, ibanDigits(a.iban))}
    ${hasAcc && title ? row('Призначення', title) : ''}
    ${amount ? row('Сума', amount.toFixed(2) + ' zł', amount.toFixed(2)) : ''}
    ${qr}
    ${hasAcc && String(a.title || '').includes(T_CHILD) && lat && lat !== String(student || '').trim() ? `<p class="pay-note">ℹ️ ${escHtml(LATIN_NOTE)}</p>` : ''}
    ${hasAcc && !amount ? '<p class="pay-note">Суму вкажіть самі — вона залежить від домовленості зі школою.</p>' : ''}
  </section>`;
}

let lastD = null;
export async function renderPaymentBlock(){
  const boxes = [...document.querySelectorAll('.pay-box')];
  if(!boxes.length) return;
  const put = v => boxes.forEach(b => b.innerHTML = v);
  const role = currentUserData?.role;
  if(role !== 'parent' && role !== 'student'){ put(''); return; }
  const d = lastD = await loadPaymentDetails();
  const dev = `<div class="pay-dev" role="note">🛠 ${escHtml(PAY_IN_DEV)}</div>`;
  if(!accountsOf(d).length){
    put(`${dev}<p class="pay-note">Реквізити школа ще не додала в портал. Їх можна уточнити в адміністрації школи.</p>`);
    return;
  }
  const cls = currentUserData?.class || '';
  const mine = accountsForClass(d, cls);
  if(!mine.length){
    const n = classNum(cls);
    put(`${dev}<p class="pay-note">Реквізитів для ${n != null ? `${n} класу` : 'вашого класу'} школа в портал ще не додала. Їх можна уточнити в адміністрації школи.</p>`);
    return;
  }
  const student = currentUserData?.studentName || '';
  put(`${dev}${mine.map(a => accountHtml(a, student)).join('')}
    <p class="pay-note">Натисніть «Копіювати» біля потрібного рядка й вставте в застосунку банку — або наведіть камеру на QR-код.</p>`);
}
window.renderPaymentBlock = renderPaymentBlock;
// Вибір суми чи тижня — перемальовуємо лише цю картку
if(typeof document !== 'undefined') document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('[data-pay]');
  if(!b || !lastD) return;
  const [act, id, i] = b.dataset.pay.split(':');
  const a = accountsOf(lastD).find(x => x.id === id);
  if(!a) return;
  const pk = pickOf(a, localDateString);
  if(act === 'amt') pk.amt = Number(i) || 0;
  if(act === 'week') pk.week = Number(i) ? 1 : 0;
  const card = b.closest('.pay-card');
  if(card) card.outerHTML = accountHtml(a, currentUserData?.studentName || '');
});

// ── НАЛАШТУВАННЯ (директор) ─────────────────────────────────────
// Кожен рахунок — картка: вид, назва, для яких класів, отримувач,
// рахунок, призначення з підстановками, варіанти суми, пояснення, QR.
let draft = [];
const SAMPLE = 'Волошко Микола';
const AMT_ROWS = 3;
const clsOpts = sel => Array.from({ length: CLASS_MAX - CLASS_MIN + 1 }, (_, i) => i + CLASS_MIN)
  .map(n => `<option value="${n}"${n === sel ? ' selected' : ''}>${n}</option>`).join('');
const blankAcc = kind => ({ kind, label: '', from: CLASS_MIN, to: CLASS_MAX, fullName: '', iban: '', title: '', name: '', nip: '', regon: '', bank: '', address: '', note: '', qr: true, amounts: [] });
function readDraft(){
  const box = document.getElementById('d-pay-settings');
  if(!box) return;
  box.querySelectorAll('.pay-acc-edit').forEach((card, i) => {
    const a = draft[i]; if(!a) return;
    card.querySelectorAll('[data-k]').forEach(el => { a[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value; });
    a.amounts = [...card.querySelectorAll('.pay-amt-row')].map(r => ({ sum: r.querySelector('[data-a="sum"]').value, label: r.querySelector('[data-a="label"]').value }));
  });
}
function paintSettings(){
  const box = document.getElementById('d-pay-settings');
  if(!box) return;
  const v = x => escHtml(x == null ? '' : String(x));
  const f = (a, k, label, hint, ph, extra = '') => `<label>${label}${hint ? ` <small>${hint}</small>` : ''}
      <input type="text" data-k="${k}" value="${v(a[k])}" placeholder="${escHtml(ph)}" ${extra}></label>`;
  box.innerHTML = `
    <p class="pay-dev">🛠 Батьки бачать ці реквізити у вкладці «💳 Оплата» з позначкою, що оплата через портал — у розробці. Кожна родина бачить лише рахунки для класу своєї дитини.</p>
    ${draft.map((a, i) => {
      const amts = [...(a.amounts || [])]; while(amts.length < AMT_ROWS) amts.push({ sum: '', label: '' });
      return `
    <fieldset class="pay-acc-edit pay-k-${v(a.kind)}">
      <legend>${KINDS[a.kind] ? KINDS[a.kind].icon : '💳'} Рахунок ${i + 1}</legend>
      <div class="pay-cls">Вид <select data-k="kind" aria-label="Вид оплати">${Object.entries(KINDS).map(([k, x]) => `<option value="${k}"${k === a.kind ? ' selected' : ''}>${x.icon} ${x.label}</option>`).join('')}</select></div>
      <div class="pay-cls">Для класів з <select data-k="from" aria-label="З класу">${clsOpts(Number(a.from))}</select>
        по <select data-k="to" aria-label="По клас">${clsOpts(Number(a.to))}</select></div>
      ${f(a, 'label', 'Назва картки', 'порожньо — назва виду', KINDS[a.kind] ? KINDS[a.kind].label : '', 'maxlength="40"')}
      ${f(a, 'fullName', 'Отримувач', 'повна назва, до 120 знаків', 'Education Center PUSH spółka z o.o.', 'maxlength="120"')}
      ${f(a, 'iban', 'Рахунок', '26 цифр, пробіли можна', '48 1090 1883 0000 0001 5014 8624')}
      ${f(a, 'title', 'Призначення платежу', `${T_CHILD} — прізвище й імʼя дитини латиницею, ${T_WEEK} — дати тижня (батько обирає)`, `edukacja w szkole ${T_CHILD}`, 'maxlength="100" oninput="previewPaymentTitle()"')}
      <div class="pay-preview" data-prev="${i}"></div>
      <div class="pay-amts"><b>Сума</b> <small>порожньо — батько вкаже сам; кілька — батько обере</small>
        ${amts.map(x => `<div class="pay-amt-row"><input type="text" data-a="sum" inputmode="decimal" placeholder="zł" value="${v(x.sum)}" aria-label="Сума, zł"><input type="text" data-a="label" maxlength="60" placeholder="за що (напр. обіди й підвечірки)" value="${v(x.label)}" aria-label="За що"></div>`).join('')}</div>
      <label>Пояснення для батьків <small>необовʼязково: період, кількість виїздів, що важливо в призначенні…</small>
        <textarea data-k="note" maxlength="400" rows="3">${v(a.note)}</textarea></label>
      <label class="pay-qr-on"><input type="checkbox" data-k="qr"${a.qr !== false ? ' checked' : ''}> Показувати QR-код переказу</label>
      <details class="pay-more"><summary>Додатково: адреса, NIP, REGON, банк, назва для QR</summary>
        ${f(a, 'address', 'Адреса', '', 'ul. …, 00-000 Warszawa', 'maxlength="160"')}
        ${f(a, 'nip', 'NIP', '', '1234567890')}
        ${f(a, 'regon', 'REGON', '', '123456789')}
        ${f(a, 'bank', 'Банк', '', 'Santander Bank Polska', 'maxlength="80"')}
        ${f(a, 'name', 'Назва отримувача для QR', `до ${ZBP_MAX_NAME} знаків — обмеження стандарту`, 'Education Ctr PUSH', `maxlength="${ZBP_MAX_NAME}"`)}
      </details>
      ${draft.length > 1 ? `<button type="button" class="pay-del" onclick="removePayAccount(${i})">Прибрати рахунок</button>` : ''}
    </fieldset>`; }).join('')}
    <div class="pay-add-row">${Object.entries(KINDS).map(([k, x]) => `<button type="button" class="pay-add" onclick="addPayAccount('${k}')">➕ ${x.icon} ${x.label}</button>`).join('')}</div>
    <div id="pay-cover" class="pay-cover"></div>
    <button type="button" onclick="savePaymentDetails()">Зберегти реквізити</button>`;
  box.querySelectorAll('.pay-acc-edit select').forEach(s => s.addEventListener('change', () => { readDraft(); if(s.dataset.k === 'kind') paintSettings(); else window.previewPaymentTitle(); }));
  box.querySelectorAll('.pay-acc-edit [data-k="qr"]').forEach(c => c.addEventListener('change', () => window.previewPaymentTitle()));
  window.previewPaymentTitle();
}
window.renderPaymentSettings = async function(){
  const box = document.getElementById('d-pay-settings');
  if(!box) return;
  const d = await loadPaymentDetails(true);
  const accs = accountsOf(d);
  draft = (accs.length ? accs : [blankAcc('tuition')]).map(a => ({
    kind: a.kind, label: a.label || '', from: a.from, to: a.to, fullName: a.fullName || '', iban: a.iban ? ibanPretty(a.iban) : '',
    title: a.title || '', name: a.name || '', nip: a.nip || '', regon: a.regon || '', bank: a.bank || '', address: a.address || '',
    note: a.note || '', qr: a.qr !== false, amounts: a.amounts.map(x => ({ sum: String(x.sum), label: x.label || '' }))
  }));
  paintSettings();
};
window.addPayAccount = function(kind){
  readDraft();
  draft.push(blankAcc(KINDS[kind] ? kind : 'other'));
  paintSettings();
};
window.removePayAccount = function(i){
  readDraft();
  draft.splice(i, 1);
  paintSettings();
};

// ТОЧНИЙ текст призначення, який побачить батько, і як він ляже в QR
window.previewPaymentTitle = function(){
  readDraft();
  const box = document.getElementById('d-pay-settings');
  if(!box) return;
  const lat = latinName(SAMPLE), week = weekRange(localDateString, 1);
  draft.forEach((a, i) => {
    const el = box.querySelector(`[data-prev="${i}"]`);
    if(!el) return;
    const tpl = a.title || T_CHILD;
    const t = fillTitle(tpl, lat, week), q = fillTitle(tpl, lat, week, ZBP_MAX_TITLE);
    el.innerHTML = `<b>Приклад:</b> «${escHtml(t)}» <small>(учень «${escHtml(SAMPLE)}»)</small>`
      + (!tpl.includes(T_CHILD) ? `<br><span class="pay-warn">У призначенні немає ${T_CHILD} — імʼя дитини не підставиться.</span>` : '')
      + (a.qr !== false && q !== t ? `<br><span class="pay-warn">У QR-код вміщається ${ZBP_MAX_TITLE} знаки — там буде «${escHtml(q)}». Для копіювання — повний текст.</span>` : '');
  });
  const cover = document.getElementById('pay-cover');
  if(cover){
    const accs = draft.map(a => ({ kind: a.kind, from: Math.min(Number(a.from), Number(a.to)), to: Math.max(Number(a.from), Number(a.to)) }));
    const gaps = classGaps(accs), over = classOverlaps(accs);
    cover.innerHTML = (gaps.length ? `<p class="pay-warn">⚠️ Без рахунку за навчання: ${escHtml(numsLabel(gaps))} клас. Батьки цих класів побачать «уточніть в адміністрації».</p>` : '')
      + (over.length ? `<p class="pay-warn">⚠️ Два рахунки за навчання одразу: ${escHtml(numsLabel(over))} клас — батьки побачать обидва.</p>` : '')
      + (!gaps.length && !over.length ? '<p class="pay-ok">✅ Кожен клас 1–11 має рахунок за навчання.</p>' : '');
  }
};

window.savePaymentDetails = async function(){
  readDraft();
  const accounts = {};
  for(let i = 0; i < draft.length; i++){
    const a = draft[i], n = i + 1;
    const iban = String(a.iban || '').trim();
    if(!iban) return alert(`Рахунок ${n}: вкажіть номер рахунку або приберіть цю картку.`);
    if(!ibanValid(iban)) return alert(`Рахунок ${n}: має бути рівно 26 цифр. Зараз їх ${ibanDigits(iban).length}.`);
    const amounts = [];
    for(const x of (a.amounts || [])){
      const raw = String(x.sum || '').trim().replace(',', '.');
      if(!raw) continue;
      const sum = Number(raw);
      if(isNaN(sum) || sum <= 0) return alert(`Рахунок ${n}: сума «${x.sum}» — не число.`);
      if(zbpAmount(sum) === null) return alert(`Рахунок ${n}: стандарт QR вміщає щонайбільше 9999,99 zł.`);
      amounts.push({ sum, label: String(x.label || '').trim().slice(0, 60) });
    }
    const from = Number(a.from), to = Number(a.to), t = s => String(s || '').trim();
    const rec = {
      kind: KINDS[a.kind] ? a.kind : 'other', from: Math.min(from, to), to: Math.max(from, to),
      fullName: t(a.fullName).slice(0, 120), iban: ibanDigits(iban), title: t(a.title).slice(0, 100) || T_CHILD,
      label: t(a.label).slice(0, 40), note: t(a.note).slice(0, 400), qr: a.qr !== false,
      name: t(a.name).slice(0, ZBP_MAX_NAME), nip: t(a.nip).replace(/\D/g, '').slice(0, 10),
      regon: t(a.regon).replace(/\D/g, '').slice(0, 14), bank: t(a.bank).slice(0, 80), address: t(a.address).slice(0, 160)
    };
    if(amounts.length) rec.amounts = amounts;
    accounts['a' + n] = rec;
  }
  try{
    // Цілим вузлом: старі поля (titlePrefix, amount, загальний qr) зникають
    await set(ref(db, 'payment_details'), { accounts, ts: Date.now() });
    window.invalidatePaymentDetails();
    logAction('payment_details', { value: `реквізити оплати оновлено (${Object.values(accounts).map(x => `${kindLabel(x)} ${rangeLabel(x)}`).join('; ')})` });
    showToast('✅ Реквізити збережено');
  }catch(e){ alert('Не вдалося зберегти: ' + e.message); }
};
