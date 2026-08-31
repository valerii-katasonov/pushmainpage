// ═══════════════════════════════════════════════════════════════
// consent.js — згода батьків на обробку даних.
//
// НАВІЩО ОКРЕМИЙ ЕКРАН, А НЕ РОЗДІЛ У КАБІНЕТІ. Розділ можна ніколи не
// відкрити. GDPR вимагає, щоб людину поінформували ДО обробки і щоб школа
// могла це довести. Тому при першому вході батько бачить екран, який не
// обійти, а в базі лишається запис: хто, коли й на яку версію документа.
//
// ЩО ТУТ Є ЗГОДА, А ЩО НІ. Ознайомлення з інформацією про обробку — не
// згода, а підтвердження, що людину поінформували: журнал школа веде за
// законом незалежно від чиєїсь волі. Згода береться лише на те, від чого
// можна відмовитися без наслідків для навчання.
//
// ЧОМУ ВЕРСІЯ. Якщо школа змінить документ, стара згода його не покриває.
// Змінюється версія — екран показується знову.
//
//   policy_ack/{пошта} = { version, ts, opts:{med,push,child,birthday,photo} }
// ═══════════════════════════════════════════════════════════════
import { ref, set, get, child } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, currentUserData, showToast, escHtml, logAction } from './common.js';

// Дата версії документа. Змінили текст інформації для батьків — змініть і це.
// Зміна версії означає, що екран згоди покажеться всім заново: попередня
// згода стосувалася іншого тексту й нового не покриває.
export const PRIVACY_VERSION = '2026-08-31';

// Адміністратор даних. Названий тут, а не лише в PDF: батько має бачити,
// хто саме розпоряджається даними, ще до того як відкриє документ.
export const CONTROLLER = {
  name:  'Niepubliczna Szkoła Podstawowa PUSH School Warsaw w Markach',
  addr:  'ul. Wyspiańskiego 2, 05-270 Marki',
  email: 'pushschool.warsaw@gmail.com',
  phone: '730 701 108'
};
// Повний текст лежить поруч із порталом. Файл — а не сторінка в коді:
// документ правитиме юрист, і кожна правка не має вимагати деплою.
export const PRIVACY_URL = 'privacy.pdf';

// Необовʼязкове. Порядок і формулювання збігаються з паперовим документом,
// інакше буде розходження між тим, що підписали, і тим, що в базі.
export const CONSENT_OPTS = [
  { k:'med',      title:'Медичні відомості',
    text:'Передаю школі відомості про алергії, хронічні захворювання та ліки моєї дитини, '
       + 'щоб школа могла забезпечити її безпеку під час занять і харчування.',
    warn:'Без цього школа не знатиме про особливості здоровʼя дитини.' },
  { k:'push',     title:'Сповіщення на телефон',
    text:'Хочу отримувати сповіщення про оцінки, відсутність, меню та повідомлення від школи.' },
  { k:'child',    title:'Власний доступ дитини до порталу',
    text:'Прошу створити моїй дитині окремий вхід. Пароль встановлюю і змінюю я.' },
  { k:'birthday', title:'День народження у стрічці класу',
    text:'Дозволяю показувати день і місяць народження моєї дитини однокласникам та їхнім '
       + 'батькам. Рік народження не показується.' },
  { k:'photo',    title:'Фотографії',
    text:'Дозволяю публікувати фотографії моєї дитини у внутрішній стрічці порталу, '
       + 'доступній лише батькам і персоналу школи.' }
];

const myKey = () => String(currentUserData?.email || '').toLowerCase().replace(/\./g, '_');

export async function getMyAck(){
  const se = myKey();
  if(!se) return null;
  try{
    const snap = await get(child(ref(db), `policy_ack/${se}`));
    return snap.exists() ? snap.val() : null;
  }catch(e){
    // Не змогли перевірити — не тримаємо людину на екрані згоди назавжди,
    // але й не вважаємо, що згода є. Просто пропускаємо цей раз.
    console.warn('policy_ack:', e.message);
    return { version: PRIVACY_VERSION, unchecked: true };
  }
}

// Чи дозволив батько конкретну річ. Незаповнене вважаємо відмовою:
// мовчання — не згода, це прямо написано в GDPR.
export function consentGiven(ack, key){
  return !!(ack && ack.opts && ack.opts[key] === true);
}

// ── Екран при вході ──
export async function maybeShowConsent(){
  if(currentUserData?.role !== 'parent') return;      // персонал інформують інакше, у трудових документах
  const ack = await getMyAck();
  if(ack && ack.version === PRIVACY_VERSION) return;  // на чинну версію вже відповідали
  renderConsentGate(ack);
}
window.maybeShowConsent = maybeShowConsent;

function optRow(o, ack){
  const on = consentGiven(ack, o.k);
  return `<label class="cg-opt">
    <input type="checkbox" id="cg-${o.k}" ${on?'checked':''}>
    <span>
      <b>${escHtml(o.title)}</b>
      <em>${escHtml(o.text)}</em>
      ${o.warn?`<i class="cg-warn">${escHtml(o.warn)}</i>`:''}
    </span>
  </label>`;
}

export function renderConsentGate(ack){
  const modal = document.getElementById('consent-gate');
  const body  = document.getElementById('cg-body');
  if(!modal || !body) return;
  body.innerHTML = `
    <p class="cg-lead">Щоб користуватися порталом, ознайомтеся з тим, як школа працює
      з даними вашої дитини. Це займе хвилину.</p>

    <details class="cg-doc">
      <summary>Коротко про головне</summary>
      <ul>
        <li>Розпорядник даних — <b>${escHtml(CONTROLLER.name)}</b>, ${escHtml(CONTROLLER.addr)}.
            Питання щодо даних: ${escHtml(CONTROLLER.email)}, ${escHtml(CONTROLLER.phone)}.</li>
        <li>Портал — інструмент школи, він не діє у власних інтересах.</li>
        <li>Оцінки, відвідуваність і журнал школа веде <b>за законом</b> — на це згода не потрібна
            і відкликати її не можна.</li>
        <li>Медичні дані, сповіщення, доступ дитини, фото — <b>лише за вашою згодою</b>,
            і її можна відкликати будь-коли в кабінеті.</li>
        <li>Дані зберігаються в Європейському Союзі. Школа їх не продає й не передає для реклами.</li>
        <li>Ви маєте право отримати копію даних, виправити їх і подати скаргу до UODO.</li>
      </ul>
      <p class="cg-note">Це стислий виклад. Нижче — повний текст.</p>
    </details>

    <a class="cg-doc-link" href="${PRIVACY_URL}" target="_blank" rel="noopener">
      📄 Повний текст: інформація про обробку персональних даних
    </a>

    <label class="cg-must">
      <input type="checkbox" id="cg-read">
      <span>Я ознайомлений(а) з інформацією про обробку персональних даних.</span>
    </label>

    <div class="cg-sep">Далі — те, від чого можна відмовитися. Відмова не впливає на навчання дитини.</div>
    ${CONSENT_OPTS.map(o=>optRow(o, ack)).join('')}

    <div id="cg-err" class="cg-err" style="display:none;"></div>
    <button id="cg-save" onclick="saveConsentGate()">Зберегти й продовжити</button>
    <p class="cg-foot">Вибір можна змінити будь-коли: кабінет → Профіль → Згоди.</p>`;
  modal.style.display = 'flex';
}

window.saveConsentGate = async function(){
  const err = document.getElementById('cg-err');
  const btn = document.getElementById('cg-save');
  const read = document.getElementById('cg-read');
  if(!read || !read.checked){
    if(err){ err.style.display='block'; err.textContent =
      'Щоб продовжити, підтвердіть ознайомлення з інформацією про обробку даних.'; }
    return;
  }
  const opts = {};
  CONSENT_OPTS.forEach(o=>{
    const el = document.getElementById('cg-'+o.k);
    opts[o.k] = !!(el && el.checked);
  });
  btn.disabled = true; btn.textContent = 'Зберігаю...';
  try{
    await set(ref(db, `policy_ack/${myKey()}`), {
      version: PRIVACY_VERSION,
      ts: Date.now(),
      opts
    });
    logAction('policy_ack', { value: 'версія ' + PRIVACY_VERSION });
    document.getElementById('consent-gate').style.display = 'none';
    showToast('✅ Збережено');
    renderMyConsents();
  }catch(e){
    if(err){ err.style.display='block'; err.textContent = 'Не вдалося зберегти: ' + e.message; }
  }finally{
    btn.disabled = false; btn.textContent = 'Зберегти й продовжити';
  }
};

// ── Розділ у кабінеті: перегляд і зміна ──
export async function renderMyConsents(){
  const box = document.getElementById('p-my-consents');
  if(!box) return;
  if(currentUserData?.role !== 'parent'){ box.innerHTML = ''; return; }
  box.innerHTML = '<p class="empty-msg">Завантаження...</p>';
  const ack = await getMyAck();
  const when = ack && ack.ts ? new Date(ack.ts).toLocaleDateString('uk-UA') : null;
  box.innerHTML = `
    ${when
      ? `<p class="mc-when">Відповіді збережено ${escHtml(when)} · версія документа ${escHtml(ack.version||'—')}</p>`
      : '<p class="mc-when">Ви ще не відповідали.</p>'}
    ${CONSENT_OPTS.map(o=>{
      const on = consentGiven(ack, o.k);
      return `<label class="cg-opt small">
        <input type="checkbox" id="mc-${o.k}" ${on?'checked':''}>
        <span><b>${escHtml(o.title)}</b><em>${escHtml(o.text)}</em></span>
      </label>`;
    }).join('')}
    <a class="cg-doc-link" href="${PRIVACY_URL}" target="_blank" rel="noopener">
      📄 Повний текст: інформація про обробку персональних даних
    </a>
    <button class="mc-save" onclick="saveMyConsents()">Зберегти зміни</button>
    <p class="cg-foot">Відкликання згоди не скасовує обробки, яка вже відбулася. Оцінки та
      відвідуваність школа веде за законом — вони не залежать від цих галочок.</p>`;
}
window.renderMyConsents = renderMyConsents;

window.saveMyConsents = async function(){
  const ack = await getMyAck();
  const opts = {};
  CONSENT_OPTS.forEach(o=>{
    const el = document.getElementById('mc-'+o.k);
    opts[o.k] = !!(el && el.checked);
  });
  try{
    await set(ref(db, `policy_ack/${myKey()}`), {
      // Версію лишаємо ту, з якою людина ознайомилася, а не поточну:
      // зміна галочки не означає, що вона прочитала новий документ.
      version: (ack && ack.version) || PRIVACY_VERSION,
      ts: Date.now(),
      opts
    });
    logAction('policy_ack', { value: 'оновлено згоди' });
    showToast('✅ Збережено');
    renderMyConsents();
  }catch(e){ alert('Не вдалося зберегти: ' + e.message); }
};
