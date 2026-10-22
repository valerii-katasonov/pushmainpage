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
export async function renderPaymentBlock(){
  const boxes = [...document.querySelectorAll('.pay-box')];
  if(!boxes.length) return;
  const put = v => boxes.forEach(b => b.innerHTML = v);
  const role = currentUserData?.role;
  if(role !== 'parent' && role !== 'student'){ put(''); return; }

  const d = await loadPaymentDetails();
  const dev = `<div class="pay-dev" role="note">🛠 ${escHtml(PAY_IN_DEV)}</div>`;
  const hasAcc = !!(d.iban && ibanValid(d.iban));
  if(!hasAcc && !d.fullName && !d.name){
    put(`${dev}<p class="pay-note">Реквізити школа ще не додала в портал. Їх можна уточнити в адміністрації школи.</p>`);
    return;
  }

  const student = currentUserData?.studentName || '';
  const title = buildTitle(d.titlePrefix || '', student);
  const amount = Number(d.amount) || 0;
  const acc = hasAcc ? ibanPretty(d.iban) : '';
  let qr = '';
  if(d.qr === true && hasAcc){
    const code = zbpString({ nip: d.nip, iban: d.iban, amount, name: d.name || '', title });
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

  put(`
    ${dev}
    <h4 class="pay-h">🏫 Реквізити школи</h4>
    ${row('Отримувач', d.fullName || d.name || '', d.fullName || d.name || '')}
    ${row('Адреса', d.address || '')}
    ${row('NIP', d.nip || '')}
    ${row('REGON', d.regon || '')}
    ${row('Банк', d.bank || '')}
    ${row('Рахунок', acc, ibanDigits(d.iban))}
    ${hasAcc ? row('Призначення', title, title) : ''}
    ${amount ? row('Сума', amount.toFixed(2) + ' zł', String(amount.toFixed(2))) : ''}
    ${qr}
    <p class="pay-note">
      ${hasAcc && !amount ? 'Суму вкажіть самі — вона залежить від домовленості зі школою.<br>' : ''}
      Натисніть «Копіювати» біля потрібного рядка й вставте в застосунку банку.
    </p>`);
}
window.renderPaymentBlock = renderPaymentBlock;

// ── НАЛАШТУВАННЯ (директор) ─────────────────────────────────────
window.renderPaymentSettings = async function(){
  const box = document.getElementById('d-pay-settings');
  if(!box) return;
  const d = await loadPaymentDetails(true);
  const v = (x) => escHtml(x || '');
  box.innerHTML = `
    <p class="pay-dev">🛠 Батьки бачать ці реквізити у вкладці «Школа» з позначкою, що оплата через портал — у розробці.</p>
    <label>Повна назва школи <small>для батьків, до 120 знаків</small>
      <input type="text" id="pay-fullname" maxlength="120" value="${v(d.fullName)}" placeholder="Fundacja … / Niepubliczna Szkoła Podstawowa …"></label>
    <label>Адреса <small>необовʼязково</small>
      <input type="text" id="pay-address" maxlength="160" value="${v(d.address)}" placeholder="ul. …, 00-000 Warszawa"></label>
    <label>REGON <small>необовʼязково</small>
      <input type="text" id="pay-regon" maxlength="14" value="${v(d.regon)}" placeholder="123456789"></label>
    <label>Банк <small>необовʼязково</small>
      <input type="text" id="pay-bank" maxlength="80" value="${v(d.bank)}" placeholder="Santander Bank Polska"></label>
    <label>Назва отримувача для переказу <small>до ${ZBP_MAX_NAME} знаків — обмеження стандарту</small>
      <input type="text" id="pay-name" maxlength="${ZBP_MAX_NAME}" value="${v(d.name)}" placeholder="Education Ctr PUSH"></label>
    <label>Рахунок <small>26 цифр, пробіли можна</small>
      <input type="text" id="pay-iban" value="${v(d.iban)}" placeholder="48 1090 1883 0000 0001 5014 8624"></label>
    <label>NIP <small>необовʼязково</small>
      <input type="text" id="pay-nip" value="${v(d.nip)}" placeholder="1234567890"></label>
    <label>Початок призначення платежу <small>далі портал додасть імʼя дитини</small>
      <input type="text" id="pay-prefix" value="${v(d.titlePrefix)}" placeholder="edukacja w szkole"></label>
    <label>Сума, zł <small>порожньо — батько вкаже сам; максимум 9999,99</small>
      <input type="text" id="pay-amount" inputmode="decimal" value="${d.amount ? escHtml(String(d.amount)) : ''}" placeholder="—"></label>
    <label class="pay-qr-on"><input type="checkbox" id="pay-qr"${d.qr === true ? ' checked' : ''}> Показувати батькам QR-код переказу</label>
    <button type="button" onclick="savePaymentDetails()">Зберегти реквізити</button>
    <div id="pay-preview" class="pay-preview"></div>`;
  window.previewPaymentTitle();
};

// Показуємо ТОЧНИЙ текст, який піде в банк. Ліміт у 32 знаки ріже імʼя
// мовчки, і побачити це директор має тут, а не з питання батьків.
window.previewPaymentTitle = function(){
  const box = document.getElementById('pay-preview');
  if(!box) return;
  const pre = document.getElementById('pay-prefix')?.value || '';
  const sample = 'Voloshko Mykola';
  const t = buildTitle(pre, sample);
  const cut = ((pre ? pre + ' ' : '') + sample).length > ZBP_MAX_TITLE;
  box.innerHTML = `<b>Приклад призначення:</b> «${escHtml(t)}»`
    + (cut ? `<br><span class="pay-warn">Повне імʼя не вміщається в ${ZBP_MAX_TITLE} знаків —
        портал скорочує його до прізвища з ініціалом.</span>` : '');
};

window.savePaymentDetails = async function(){
  const val = id => (document.getElementById(id)?.value || '').trim();
  const iban = val('pay-iban');
  if(iban && !ibanValid(iban))
    return alert('Рахунок має містити рівно 26 цифр. Зараз їх ' + ibanDigits(iban).length + '.');
  const amountRaw = val('pay-amount').replace(',', '.');
  const amount = amountRaw ? Number(amountRaw) : 0;
  if(amountRaw && (isNaN(amount) || amount < 0)) return alert('Сума має бути числом.');
  if(amount && zbpAmount(amount) === null)
    return alert('Стандарт QR вміщає щонайбільше 9999,99 zł. Для більшої суми лишіть поле порожнім — '
      + 'батько впише її сам.');
  try{
    await set(ref(db, 'payment_details'), {
      name: val('pay-name').slice(0, ZBP_MAX_NAME),
      iban: ibanDigits(iban),
      nip: val('pay-nip').replace(/\D/g, '').slice(0, 10),
      titlePrefix: val('pay-prefix').slice(0, ZBP_MAX_TITLE),
      amount: amount || 0,
      fullName: val('pay-fullname').slice(0, 120),
      address: val('pay-address').slice(0, 160),
      regon: val('pay-regon').replace(/\D/g, '').slice(0, 14),
      bank: val('pay-bank').slice(0, 80),
      qr: !!document.getElementById('pay-qr')?.checked,
      ts: Date.now()
    });
    window.invalidatePaymentDetails();
    logAction('payment_details', { value: 'реквізити оплати оновлено' });
    showToast('✅ Реквізити збережено');
    window.previewPaymentTitle();
  }catch(e){ alert('Не вдалося зберегти: ' + e.message); }
};
