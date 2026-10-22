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
import { db, currentUserData, escHtml, escJs, showToast, logAction } from './common.js';

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

// ── КІЛЬКА РАХУНКІВ ЗА КЛАСАМИ ──────────────────────────────────
// Школа приймає оплату на різні рахунки залежно від класу (напр. 0–8 —
// на спółkę, 10–11 — на фундацію). payment_details.accounts/{a1…} =
//   {from, to, fullName, iban, titlePrefix, name?, nip?, regon?, bank?, address?, amount?}
// Старі реквізити одним набором (поля просто в payment_details) читаємо
// як один рахунок для всіх класів — доки директор не збереже нові.
export const ACC_FIELDS = ['fullName', 'address', 'nip', 'regon', 'bank', 'iban', 'titlePrefix', 'name', 'amount'];
export const CLASS_MIN = 0, CLASS_MAX = 11;
const intIn = (v, lo, hi, dflt) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : dflt; };
export function accountsOf(d){
  d = d || {};
  if(d.accounts && typeof d.accounts === 'object'){
    return Object.keys(d.accounts).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).map(id => {
      const a = d.accounts[id] || {};
      const from = intIn(a.from, CLASS_MIN, CLASS_MAX, CLASS_MIN), to = intIn(a.to, CLASS_MIN, CLASS_MAX, CLASS_MAX);
      return { id, ...a, from: Math.min(from, to), to: Math.max(from, to) };
    });
  }
  if(d.iban || d.fullName || d.name)
    return [{ id: 'a1', from: CLASS_MIN, to: CLASS_MAX, ...Object.fromEntries(ACC_FIELDS.map(k => [k, d[k]]).filter(([, v]) => v != null)) }];
  return [];
}
export const classNum = cls => { const m = /^class_(\d{1,2})$/.exec(String(cls || '')); return m ? Number(m[1]) : null; };
export const accountsForClass = (d, cls) => { const n = classNum(cls); return n == null ? [] : accountsOf(d).filter(a => n >= a.from && n <= a.to); };
export const rangeLabel = a => a.from === a.to ? `${a.from} клас` : `${a.from}–${a.to} класи`;
// Класи порталу (1–11), для яких не вказано жодного рахунку — показуємо директору
export function classGaps(accs, lo = 1, hi = CLASS_MAX){
  const out = [];
  for(let n = lo; n <= hi; n++) if(!accs.some(a => n >= a.from && n <= a.to)) out.push(n);
  return out;
}
export function classOverlaps(accs, lo = 1, hi = CLASS_MAX){
  const out = [];
  for(let n = lo; n <= hi; n++) if(accs.filter(a => n >= a.from && n <= a.to).length > 1) out.push(n);
  return out;
}
const numsLabel = ns => ns.join(', ');

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

// ОПЛАТА ЧЕРЕЗ ПОРТАЛ — У РОЗРОБЦІ. Поки так, батькам показуємо лише
// РЕКВІЗИТИ школи (з кнопками «Копіювати») і чесно кажемо, що платити
// треба звичайним переказом. QR-код переказу вже вміє малюватися
// (zbpString нижче), але показуємо його тільки тоді, коли школа сама
// увімкне оплату (payment_details.qr = true) — щоб не обіцяти більше,
// ніж є.
export const PAY_IN_DEV = 'Оплата через портал — у розробці. Поки що оплачуйте звичайним банківським переказом за реквізитами нижче.';
export const LATIN_NOTE = 'Імʼя дитини латиницею портал підставив сам — перевірте, щоб воно збігалося з написанням у документах дитини.';

// Один рахунок — рядки з «Копіювати» (і QR, якщо школа ввімкнула)
function accountHtml(a, student, qrOn, withRange){
  const hasAcc = !!(a.iban && ibanValid(a.iban));
  const lat = latinName(student);
  const title = fullTitle(a.titlePrefix, lat);
  const amount = Number(a.amount) || 0;
  const acc = hasAcc ? ibanPretty(a.iban) : '';
  const who = a.fullName || a.name || '';
  let qr = '';
  if(qrOn && hasAcc){
    const code = zbpString({ nip: a.nip, iban: a.iban, amount, name: a.name || who.slice(0, ZBP_MAX_NAME), title: buildTitle(a.titlePrefix || '', lat) });
    const svg = code ? qrSvg(code, 220) : null;
    qr = svg ? `<div class="pay-qr">${svg}<span>Наведіть камеру в застосунку банку</span></div>` : '';
  }
  const row = (label, value, copy) => value ? `
    <div class="pay-row">
      <span class="pay-label">${escHtml(label)}</span>
      <b class="pay-value">${escHtml(value)}</b>
      <button type="button" class="pay-copy"
        onclick="copyPayField('${escJs(label)}','${escJs(copy !== undefined ? copy : value)}')">Копіювати</button>
    </div>` : '';
  return `<section class="pay-acc">
    ${withRange ? `<div class="pay-range">${escHtml(rangeLabel(a))}</div>` : ''}
    ${row('Отримувач', who)}
    ${row('Адреса', a.address || '')}
    ${row('NIP', a.nip || '')}
    ${row('REGON', a.regon || '')}
    ${row('Банк', a.bank || '')}
    ${row('Рахунок', acc, ibanDigits(a.iban))}
    ${hasAcc && title ? row('Призначення', title) : ''}
    ${amount ? row('Сума', amount.toFixed(2) + ' zł', String(amount.toFixed(2))) : ''}
    ${qr}
    ${hasAcc && lat && lat !== String(student || '').trim() ? `<p class="pay-note">ℹ️ ${escHtml(LATIN_NOTE)}</p>` : ''}
    ${hasAcc && !amount ? '<p class="pay-note">Суму вкажіть самі — вона залежить від домовленості зі школою.</p>' : ''}
  </section>`;
}

export async function renderPaymentBlock(){
  const boxes = [...document.querySelectorAll('.pay-box')];
  if(!boxes.length) return;
  const put = v => boxes.forEach(b => b.innerHTML = v);
  const role = currentUserData?.role;
  if(role !== 'parent' && role !== 'student'){ put(''); return; }

  const d = await loadPaymentDetails();
  const dev = `<div class="pay-dev" role="note">🛠 ${escHtml(PAY_IN_DEV)}</div>`;
  const all = accountsOf(d);
  if(!all.length){
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
  const qrOn = d.qr === true;
  put(`
    ${dev}
    <h4 class="pay-h">🏫 Реквізити школи</h4>
    ${mine.map(a => accountHtml(a, student, qrOn, mine.length > 1)).join('')}
    <p class="pay-note">Натисніть «Копіювати» біля потрібного рядка й вставте в застосунку банку.</p>`);
}
window.renderPaymentBlock = renderPaymentBlock;

// ── НАЛАШТУВАННЯ (директор) ─────────────────────────────────────
// Рахунки — картками; у кожній «для яких класів». Нижче — попередження,
// якщо якийсь клас лишився без рахунку або потрапив у два одразу.
let draft = [];
const SAMPLE = 'Волошко Микола';
const clsOpts = sel => Array.from({ length: CLASS_MAX - CLASS_MIN + 1 }, (_, i) => i + CLASS_MIN)
  .map(n => `<option value="${n}"${n === sel ? ' selected' : ''}>${n}</option>`).join('');
function readDraft(){
  const box = document.getElementById('d-pay-settings');
  if(!box) return;
  box.querySelectorAll('.pay-acc-edit').forEach((card, i) => {
    const a = draft[i]; if(!a) return;
    card.querySelectorAll('[data-k]').forEach(el => { a[el.dataset.k] = el.value; });
  });
}
function paintSettings(qr){
  const box = document.getElementById('d-pay-settings');
  if(!box) return;
  const v = x => escHtml(x == null ? '' : String(x));
  const f = (k, label, hint, ph, extra = '') => `<label>${label}${hint ? ` <small>${hint}</small>` : ''}
      <input type="text" data-k="${k}" value="${v(draft.__i[k])}" placeholder="${escHtml(ph)}" ${extra}></label>`;
  box.innerHTML = `
    <p class="pay-dev">🛠 Батьки бачать ці реквізити у вкладці «Школа» з позначкою, що оплата через портал — у розробці. Кожна родина бачить лише рахунок для класу своєї дитини.</p>
    ${draft.map((a, i) => { draft.__i = a; return `
    <fieldset class="pay-acc-edit">
      <legend>Рахунок ${i + 1}</legend>
      <div class="pay-cls">Для класів з <select data-k="from" aria-label="З класу">${clsOpts(Number(a.from))}</select>
        по <select data-k="to" aria-label="По клас">${clsOpts(Number(a.to))}</select></div>
      ${f('fullName', 'Отримувач', 'повна назва, до 120 знаків', 'Education Center PUSH spółka z o.o.', 'maxlength="120"')}
      ${f('iban', 'Рахунок', '26 цифр, пробіли можна', '48 1090 1883 0000 0001 5014 8624')}
      ${f('titlePrefix', 'Початок призначення платежу', 'далі портал додасть прізвище й імʼя дитини латиницею', 'edukacja w szkole', 'maxlength="60" oninput="previewPaymentTitle()"')}
      <div class="pay-preview" data-prev="${i}"></div>
      <details class="pay-more"><summary>Додатково: адреса, NIP, REGON, банк, сума, назва для QR</summary>
        ${f('address', 'Адреса', '', 'ul. …, 00-000 Warszawa', 'maxlength="160"')}
        ${f('nip', 'NIP', '', '1234567890')}
        ${f('regon', 'REGON', '', '123456789')}
        ${f('bank', 'Банк', '', 'Santander Bank Polska', 'maxlength="80"')}
        ${f('amount', 'Сума, zł', 'порожньо — батько вкаже сам; для QR максимум 9999,99', '—', 'inputmode="decimal"')}
        ${f('name', 'Назва отримувача для QR', `до ${ZBP_MAX_NAME} знаків — обмеження стандарту`, 'Education Ctr PUSH', `maxlength="${ZBP_MAX_NAME}"`)}
      </details>
      ${draft.length > 1 ? `<button type="button" class="pay-del" onclick="removePayAccount(${i})">Прибрати рахунок</button>` : ''}
    </fieldset>`; }).join('')}
    <button type="button" class="pay-add" onclick="addPayAccount()">➕ Додати рахунок для інших класів</button>
    <div id="pay-cover" class="pay-cover"></div>
    <label class="pay-qr-on"><input type="checkbox" id="pay-qr"${qr ? ' checked' : ''} onchange="previewPaymentTitle()"> Показувати батькам QR-код переказу</label>
    <button type="button" onclick="savePaymentDetails()">Зберегти реквізити</button>`;
  delete draft.__i;
  box.querySelectorAll('.pay-acc-edit select').forEach(s => s.addEventListener('change', () => { readDraft(); window.previewPaymentTitle(); }));
  window.previewPaymentTitle();
}
window.renderPaymentSettings = async function(){
  const box = document.getElementById('d-pay-settings');
  if(!box) return;
  const d = await loadPaymentDetails(true);
  const accs = accountsOf(d);
  draft = (accs.length ? accs : [{ from: CLASS_MIN, to: CLASS_MAX }]).map(a => {
    const o = { from: a.from, to: a.to };
    ACC_FIELDS.forEach(k => { o[k] = k === 'amount' ? (Number(a.amount) ? String(a.amount) : '') : (k === 'iban' && a.iban ? ibanPretty(a.iban) : (a[k] || '')); });
    return o;
  });
  paintSettings(d.qr === true);
};
window.addPayAccount = function(){
  readDraft();
  const used = draft.reduce((m, a) => Math.max(m, Number(a.to)), CLASS_MIN - 1);
  const from = Math.min(used + 1, CLASS_MAX);
  draft.push({ from, to: CLASS_MAX, ...Object.fromEntries(ACC_FIELDS.map(k => [k, ''])) });
  paintSettings(!!document.getElementById('pay-qr')?.checked);
};
window.removePayAccount = function(i){
  readDraft();
  draft.splice(i, 1);
  paintSettings(!!document.getElementById('pay-qr')?.checked);
};

// Показуємо ТОЧНИЙ текст, який батько скопіює, і чи вміщається він у QR.
window.previewPaymentTitle = function(){
  readDraft();
  const box = document.getElementById('d-pay-settings');
  if(!box) return;
  const lat = latinName(SAMPLE);
  draft.forEach((a, i) => {
    const el = box.querySelector(`[data-prev="${i}"]`);
    if(!el) return;
    const t = fullTitle(a.titlePrefix, lat);
    const cut = t.length > ZBP_MAX_TITLE && !!document.getElementById('pay-qr')?.checked;
    el.innerHTML = `<b>Приклад призначення:</b> «${escHtml(t)}» <small>(учень «${escHtml(SAMPLE)}» у списку класу)</small>`
      + (cut ? `<br><span class="pay-warn">У QR-код вміщається ${ZBP_MAX_TITLE} знаки — там буде «${escHtml(buildTitle(a.titlePrefix, lat))}». Для копіювання — повний текст.</span>` : '');
  });
  const cover = document.getElementById('pay-cover');
  if(cover){
    const accs = draft.map(a => ({ from: Math.min(Number(a.from), Number(a.to)), to: Math.max(Number(a.from), Number(a.to)) }));
    const gaps = classGaps(accs), over = classOverlaps(accs);
    cover.innerHTML = (gaps.length ? `<p class="pay-warn">⚠️ Без рахунку: ${escHtml(numsLabel(gaps))} клас. Батьки цих класів побачать «уточніть в адміністрації».</p>` : '')
      + (over.length ? `<p class="pay-warn">⚠️ У двох рахунках одразу: ${escHtml(numsLabel(over))} клас — батьки побачать обидва.</p>` : '')
      + (!gaps.length && !over.length ? '<p class="pay-ok">✅ Кожен клас 1–11 має свій рахунок.</p>' : '');
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
    const amountRaw = String(a.amount || '').trim().replace(',', '.');
    const amount = amountRaw ? Number(amountRaw) : 0;
    if(amountRaw && (isNaN(amount) || amount < 0)) return alert(`Рахунок ${n}: сума має бути числом.`);
    if(amount && zbpAmount(amount) === null)
      return alert(`Рахунок ${n}: стандарт QR вміщає щонайбільше 9999,99 zł. Для більшої суми лишіть поле порожнім — батько впише її сам.`);
    const from = Number(a.from), to = Number(a.to);
    const t = s => String(s || '').trim();
    accounts['a' + n] = {
      from: Math.min(from, to), to: Math.max(from, to),
      fullName: t(a.fullName).slice(0, 120), iban: ibanDigits(iban), titlePrefix: t(a.titlePrefix).slice(0, 60),
      name: t(a.name).slice(0, ZBP_MAX_NAME), nip: t(a.nip).replace(/\D/g, '').slice(0, 10),
      regon: t(a.regon).replace(/\D/g, '').slice(0, 14), bank: t(a.bank).slice(0, 80), address: t(a.address).slice(0, 160),
      amount: amount || 0
    };
  }
  try{
    // Цілим вузлом: старі поля одного набору (iban, name…) зникають —
    // тепер усе в accounts, і читати двома способами не доведеться
    await set(ref(db, 'payment_details'), { accounts, qr: !!document.getElementById('pay-qr')?.checked, ts: Date.now() });
    window.invalidatePaymentDetails();
    logAction('payment_details', { value: `реквізити оплати оновлено (${Object.values(accounts).map(rangeLabel).join('; ')})` });
    showToast('✅ Реквізити збережено');
  }catch(e){ alert('Не вдалося зберегти: ' + e.message); }
};
