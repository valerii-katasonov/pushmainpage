// ═══════════════════════════════════════════════════════════════
// child-photo.js — фото дитини, яке ставлять батьки.
//
// ДЕ ЛЕЖИТЬ. student_photos/{клас}/{учень} = data:image/jpeg… (128×128,
// до ~40 КБ — те саме стискання, що й для фото профілю, shrinkImage).
// Картинка лежить у базі, а не на зовнішньому хостингу: посилання на
// фото дитини не можна переслати чи відкрити без входу в портал.
//
// ХТО БАЧИТЬ. Родина цієї дитини і персонал школи (картка учня 360°).
// Однокласники й інші батьки — ні. Ставить/прибирає родина (батько або
// сам учень) — лише своїй дитині; адміністрація може прибрати.
//
// ДЕ ВИДНО. Перемикач дітей у шапці, святкова картка в день народження,
// картка учня в кабінеті вчителя. Змінюється у «⚙️ Профіль» → «Фото дитини».
//
// Правила бази звіряють дитину з профілем (як усі записи родини), тож
// змінити можна фото АКТИВНОЇ дитини. Фото другої дитини в перемикачі
// беремо з памʼяті пристрою, якщо база його зараз не віддає.
// ═══════════════════════════════════════════════════════════════
import { ref, get, set } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, currentUserData, getUserChildren, sidOf, stuId, shrinkImage, showToast, escHtml, childDisplayName } from './common.js';

const LS = 'push_kid_photo_';
const mem = {};
const keyOf = (cls, sid) => `${cls}/${sid}`;
const lsGet = k => { try{ return localStorage.getItem(LS + k) || ''; }catch(e){ return ''; } };
const lsSet = (k, v) => { try{ v ? localStorage.setItem(LS + k, v) : localStorage.removeItem(LS + k); }catch(e){} };
export const isPhoto = v => typeof v === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(v) && v.length <= 60000;

// Фото дитини (або ''). Спершу база, при відмові — памʼять пристрою.
export async function childPhoto(cls, sid, { fresh = false } = {}){
  if(!cls || !sid) return '';
  const k = keyOf(cls, sid);
  if(!fresh && k in mem) return mem[k];
  try{
    const s = await get(ref(db, `student_photos/${cls}/${sid}`));
    const v = s.exists() && isPhoto(s.val()) ? s.val() : '';
    mem[k] = v; lsSet(k, v);
    return v;
  }catch(e){
    return (mem[k] = lsGet(k));
  }
}
window.childPhoto = childPhoto;

async function activeKid(){
  const u = currentUserData || {};
  if(u.role !== 'parent' && u.role !== 'student') return null;
  const cls = u.class, sid = (await sidOf(cls, u.studentName).catch(() => null)) || u.studentId || '';
  return cls && sid ? { cls, sid, name: u.studentName } : null;
}

// ── Перемикач дітей у шапці: кружок з літерою → фото ──
async function paintSwitcher(){
  const box = document.getElementById('pb-child-switcher'); if(!box) return;
  for(const b of box.querySelectorAll('.pb-kid[data-cls]')){
    const cls = b.dataset.cls, name = b.dataset.name;
    const sid = stuId(cls, name) || b.dataset.sid || '';
    const on = b.getAttribute('aria-selected') === 'true';
    const url = on ? await childPhoto(cls, sid) : (mem[keyOf(cls, sid)] || lsGet(keyOf(cls, sid)));
    const av = b.querySelector('.pb-kid-av'); if(!av) continue;
    av.classList.toggle('has-photo', !!url);
    av.style.backgroundImage = url ? `url("${url}")` : '';
  }
}
// ── Святкова картка: торт → фото дитини з тортиком ──
async function paintBday(){
  for(const id of ['p-bday', 's-bday']){
    const box = document.getElementById(id);
    const cake = box && !box.hidden && box.querySelector('.bday-cake:not(.has-photo)');
    if(!cake) continue;
    const k = await activeKid(); if(!k) continue;
    const url = await childPhoto(k.cls, k.sid); if(!url) continue;
    cake.classList.add('has-photo');
    cake.innerHTML = `<img src="${url}" alt=""><i>🎂</i>`;
  }
}

// ── «⚙️ Профіль» → «Фото дитини» ──
let blockSeq = 0;
export async function renderPhotoBlock(){
  const box = document.getElementById('child-photo-block'); if(!box) return;
  const my = ++blockSeq;                     // старший показ не перемальовує новіший
  const k = await activeKid();
  if(my !== blockSeq) return;
  if(!k){ box.hidden = true; return; }
  const url = await childPhoto(k.cls, k.sid, { fresh: true });
  if(my !== blockSeq) return;
  box.hidden = false;
  // «KATASONOV DANIIL» → «Daniil»: власне імʼя, без крику великими літерами
  const nm0 = (childDisplayName(k.name || '').split(' ')[0]) || 'дитини';
  const nm = nm0 === nm0.toUpperCase() ? nm0.charAt(0) + nm0.slice(1).toLowerCase() : nm0;
  const many = currentUserData.role === 'parent' && getUserChildren(currentUserData).length > 1;
  box.innerHTML = `<label style="color:var(--brand-deep);margin-top:0;">📷 Фото: ${escHtml(nm)}</label>
    <div class="kp-row">
      <span class="kp-av${url ? ' has-photo' : ''}"${url ? ` style="background-image:url('${url}')"` : ''} aria-hidden="true">${url ? '' : escHtml((nm.trim()[0] || '?').toUpperCase())}</span>
      <div class="kp-acts">
        <label class="kp-btn kp-pick">${url ? 'Змінити фото' : 'Додати фото'}<input type="file" accept="image/*" id="kp-file" hidden></label>
        ${url ? '<button type="button" class="kp-btn kp-del" onclick="removeChildPhoto()">Прибрати</button>' : ''}
      </div>
    </div>
    <p class="kp-note">Бачать лише ваша родина й учителі школи — однокласники та інші батьки не бачать.${many ? ' Щоб змінити фото іншої дитини, перемкніть її вгорі.' : ''}</p>`;
  box.querySelector('#kp-file').addEventListener('change', e => { const f = e.target.files && e.target.files[0]; if(f) saveChildPhoto(f); });
}
export async function saveChildPhoto(file){
  const k = await activeKid(); if(!k) return;
  let url;
  try{ url = await shrinkImage(file); }catch(e){ showToast('⚠️ ' + (e.message || 'Не вдалося обробити фото')); return; }
  try{
    await set(ref(db, `student_photos/${k.cls}/${k.sid}`), url);
    mem[keyOf(k.cls, k.sid)] = url; lsSet(keyOf(k.cls, k.sid), url);
    showToast('📷 Фото дитини збережено');
  }catch(e){
    showToast('❌ Не збережено: ' + (/permission/i.test(e.message || '') ? 'немає доступу (оновіть сторінку)' : e.message));
    return;
  }
  renderPhotoBlock(); paintSwitcher();
}
window.removeChildPhoto = async function(){
  const k = await activeKid(); if(!k) return;
  if(!confirm('Прибрати фото дитини?')) return;
  try{
    await set(ref(db, `student_photos/${k.cls}/${k.sid}`), null);
    mem[keyOf(k.cls, k.sid)] = ''; lsSet(keyOf(k.cls, k.sid), '');
    showToast('Фото прибрано');
  }catch(e){ showToast('❌ ' + (e.message || '')); return; }
  renderPhotoBlock(); paintSwitcher();
};
window.renderChildPhotoBlock = renderPhotoBlock;

function init(){
  const watch = (id, fn) => {
    const el = document.getElementById(id);
    if(el) new MutationObserver(() => fn()).observe(el, { childList: true, attributes: true, attributeFilter: ['hidden'] });
  };
  watch('pb-child-switcher', paintSwitcher);
  watch('p-bday', paintBday); watch('s-bday', paintBday);
  // Профіль відкрили — показуємо актуальне фото
  const pm = document.getElementById('profile-modal');
  if(pm) new MutationObserver(() => { if(pm.style.display && pm.style.display !== 'none') renderPhotoBlock(); })
    .observe(pm, { attributes: true, attributeFilter: ['style'] });
  window.addEventListener('push:context', () => { for(const k in mem) delete mem[k]; });
}
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
