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
import { db, currentUserData, getUserChildren, sidOf, showToast, escHtml, childDisplayName } from './common.js';

const LS = 'push_kid_photo_';
const mem = {};
const keyOf = (cls, sid) => `${cls}/${sid}`;
const lsGet = k => { try{ return localStorage.getItem(LS + k) || ''; }catch(e){ return ''; } };
const lsSet = (k, v) => { try{ v ? localStorage.setItem(LS + k, v) : localStorage.removeItem(LS + k); }catch(e){} };
// Памʼять пристрою — ще й за ІМЕНЕМ дитини. Ідентифікатор другої дитини
// (з іншого класу) родина не завжди може дізнатися — правила не дають
// прочитати чужий список класу, — а імʼя є в перемикачі завжди. Раніше
// пошук ішов лише за ідентифікатором, і фото другої дитини в перемикачі
// то зʼявлялося, то зникало, то лишалося старим.
const nameKey = (cls, name) => `${cls}|${String(name || '').trim().toLowerCase().replace(/\s+/g, ' ')}`;
function remember(cls, sid, name, v){
  if(sid){ mem[keyOf(cls, sid)] = v; lsSet(keyOf(cls, sid), v); }
  if(name) lsSet(nameKey(cls, name), v);
}
export const isPhoto = v => typeof v === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(v) && v.length <= 60000;

// Фото дитини (або ''). Спершу база, при відмові — памʼять пристрою.
// readPhoto → {url, ok}: ok=false — база не відповіла (немає доступу,
// мережа). Тоді памʼять пристрою НЕ чіпаємо: раніше відмова записувала
// туди порожнечу, і фото другої дитини в перемикачі зникало.
async function readPhoto(cls, sid){
  if(!cls || !sid) return { url: '', ok: false };
  try{
    const s = await get(ref(db, `student_photos/${cls}/${sid}`));
    return { url: s.exists() && isPhoto(s.val()) ? s.val() : '', ok: true };
  }catch(e){ return { url: '', ok: false }; }
}
export async function childPhoto(cls, sid, { fresh = false } = {}){
  if(!cls || !sid) return '';
  const k = keyOf(cls, sid);
  if(!fresh && k in mem) return mem[k];
  const r = await readPhoto(cls, sid);
  if(r.ok){ mem[k] = r.url; lsSet(k, r.url); return r.url; }
  return mem[k] || lsGet(k);
}
window.childPhoto = childPhoto;

async function activeKid(){
  const u = currentUserData || {};
  if(u.role !== 'parent' && u.role !== 'student') return null;
  const cls = u.class, sid = (await sidOf(cls, u.studentName).catch(() => null)) || u.studentId || '';
  return cls && sid ? { cls, sid, name: u.studentName } : null;
}

// ── Перемикач дітей у шапці: кружок з літерою → фото ──
let paintSeq = 0;
async function paintSwitcher(){
  const box = document.getElementById('pb-child-switcher'); if(!box) return;
  const my = ++paintSeq;
  for(const b of [...box.querySelectorAll('.pb-kid[data-cls]')]){
    const cls = b.dataset.cls, name = b.dataset.name;
    const on = b.getAttribute('aria-selected') === 'true';
    // Спершу — те, що памʼятає пристрій (миттєво, без мигання), потім
    // уточнюємо з бази. Пишемо в памʼять лише ВДАЛУ відповідь бази.
    const sid = (await sidOf(cls, name).catch(() => null)) || b.dataset.sid || '';
    let url = lsGet(nameKey(cls, name)) || (sid ? lsGet(keyOf(cls, sid)) : '');
    const r = await readPhoto(cls, sid);
    if(r.ok){ url = r.url; remember(cls, sid, name, r.url); }
    else if(on && sid && mem[keyOf(cls, sid)]) url = mem[keyOf(cls, sid)];
    if(my !== paintSeq) return;                 // перемальовано новішим викликом
    const av = b.querySelector('.pb-kid-av'); if(!av) continue;
    const want = url ? `url("${url}")` : '';
    if(av.style.backgroundImage !== want){        // без зайвих перемальовувань
      av.classList.toggle('has-photo', !!url);
      av.style.backgroundImage = want;
    }
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
  box.querySelector('#kp-file').addEventListener('change', e => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if(f) saveChildPhoto(f); });
}
export async function saveChildPhoto(file, crop = openCropper){
  const k = await activeKid(); if(!k) return;
  let url;
  try{ url = await crop(file); }catch(e){ showToast('⚠️ ' + (e.message || 'Не вдалося відкрити фото')); return; }
  if(!url) return;                                // натиснули «Скасувати»
  try{
    await set(ref(db, `student_photos/${k.cls}/${k.sid}`), url);
    remember(k.cls, k.sid, k.name, url);
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
    remember(k.cls, k.sid, k.name, '');
    showToast('Фото прибрано');
  }catch(e){ showToast('❌ ' + (e.message || '')); return; }
  renderPhotoBlock(); paintSwitcher();
};
window.renderChildPhotoBlock = renderPhotoBlock;

// ── ✂️ КАДРУВАННЯ ─────────────────────────────────────────────────
// Раніше фото різалося «по центру» автоматично: обличчя часто опинялося
// збоку чи обрізане. Тепер — коло, як у месенджерах: тягнете фото
// пальцем/мишею, масштаб повзунком, колесом або двома пальцями.
// Результат — 256×256 JPEG (≤ ~45 КБ), саме та область, що в колі.
export const OUT_SIZE = 256, MAX_LEN = 45000;
// Обмежуємо зсув, щоб фото завжди закривало все коло
export function clampOffset(ox, oy, dw, dh, V){
  return [Math.min(0, Math.max(V - dw, ox)), Math.min(0, Math.max(V - dh, oy))];
}
// Область оригіналу, видима у вікні V×V при масштабі scale і зсуві (ox, oy)
export function cropRect(ox, oy, scale, V){
  return { sx: -ox / scale, sy: -oy / scale, side: V / scale };
}
function loadImg(file){
  return new Promise((res, rej) => {
    if(!file || !/^image\//.test(file.type || '')) return rej(new Error('Це не зображення. Оберіть JPG або PNG.'));
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => res({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Не вдалося прочитати фото')); };
    img.src = url;
  });
}
// Фото з камери телефона — 12+ Мп. Рухати таке зображення під колом —
// важко для телефона, і екран мигав. Робимо одну зменшену копію (до
// 1400 px по більшій стороні) і далі працюємо лише з нею.
const WORK_MAX = 1400;
function workCopy(img){
  const k = Math.min(1, WORK_MAX / Math.max(img.naturalWidth, img.naturalHeight));
  const cv = document.createElement('canvas');
  cv.width = Math.round(img.naturalWidth * k); cv.height = Math.round(img.naturalHeight * k);
  cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
  return cv;
}
export async function openCropper(file){
  const { img: orig, url: origUrl } = await loadImg(file);
  const img = workCopy(orig); URL.revokeObjectURL(origUrl);
  const url = img.toDataURL('image/jpeg', 0.92);
  return new Promise(resolve => {
    const w = img.width, h = img.height;
    const ov = document.createElement('div');
    ov.className = 'kp-crop-wrap'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-label', 'Кадрування фото');
    ov.innerHTML = `<div class="kp-crop">
        <b class="kp-crop-t">Розмістіть обличчя в колі</b>
        <div class="kp-crop-v"><img alt="" draggable="false"><i aria-hidden="true"></i></div>
        <label class="kp-zoom"><span aria-hidden="true">−</span><input type="range" min="1" max="4" step="0.01" value="1" aria-label="Масштаб"><span aria-hidden="true">+</span></label>
        <p class="kp-crop-h">Тягніть фото, щоб посунути · колесо або два пальці — масштаб</p>
        <div class="kp-crop-b"><button type="button" class="kp-btn" data-a="no">Скасувати</button><button type="button" class="kp-btn kp-pick" data-a="ok">Зберегти</button></div>
      </div>`;
    document.body.appendChild(ov);
    const view = ov.querySelector('.kp-crop-v'), im = ov.querySelector('img'), range = ov.querySelector('input');
    im.src = url;
    const V = () => view.clientWidth || 280;
    let zoom = 1, ox = 0, oy = 0;
    const base = () => Math.max(V() / w, V() / h);
    // Розмір картинки не змінюємо ніколи — лише transform (без перерахунку
    // макета), і не частіше за кадр екрана
    im.style.width = w + 'px'; im.style.height = h + 'px';
    let raf = 0;
    const paint = () => { raf = 0; im.style.transform = `translate3d(${ox}px,${oy}px,0) scale(${base() * zoom})`; };
    const apply = () => {
      const sc = base() * zoom;
      [ox, oy] = clampOffset(ox, oy, w * sc, h * sc, V());
      if(!raf) raf = requestAnimationFrame(paint);
    };
    // Масштаб відносно точки (cx, cy) у вікні — те, що під пальцем, лишається під пальцем
    const setZoom = (z, cx = V() / 2, cy = V() / 2) => {
      z = Math.min(4, Math.max(1, z));
      const k = z / zoom; ox = cx - (cx - ox) * k; oy = cy - (cy - oy) * k; zoom = z;
      range.value = String(z); apply();
    };
    // Стартово — по центру
    { const sc = base(); ox = (V() - w * sc) / 2; oy = (V() - h * sc) / 2; apply(); }
    const pts = new Map(); let last = null, pinch = null;
    view.addEventListener('pointerdown', e => { view.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); last = [e.clientX, e.clientY];
      if(pts.size === 2){ const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), z: zoom }; } });
    view.addEventListener('pointermove', e => {
      if(!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      if(pts.size >= 2 && pinch){
        const [a, b] = [...pts.values()], r = view.getBoundingClientRect();
        setZoom(pinch.z * Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d, (a[0] + b[0]) / 2 - r.left, (a[1] + b[1]) / 2 - r.top);
      }else if(last){ ox += e.clientX - last[0]; oy += e.clientY - last[1]; last = [e.clientX, e.clientY]; apply(); }
    });
    const up = e => { pts.delete(e.pointerId); if(pts.size < 2) pinch = null; last = pts.size ? [...pts.values()][0] : null; };
    view.addEventListener('pointerup', up); view.addEventListener('pointercancel', up);
    view.addEventListener('wheel', e => { e.preventDefault(); const r = view.getBoundingClientRect();
      setZoom(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
    range.addEventListener('input', () => setZoom(Number(range.value)));
    const done = v => { if(raf) cancelAnimationFrame(raf); ov.remove(); document.removeEventListener('keydown', key); resolve(v); };
    const key = e => { if(e.key === 'Escape') done(null); };
    document.addEventListener('keydown', key);
    ov.addEventListener('click', e => {
      const a = e.target.closest('[data-a]'); if(!a) return;
      if(a.dataset.a === 'no') return done(null);
      const { sx, sy, side } = cropRect(ox, oy, base() * zoom, V());
      const cv = document.createElement('canvas'); cv.width = cv.height = OUT_SIZE;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = 'white'; ctx.fillRect(0, 0, OUT_SIZE, OUT_SIZE);   // прозорий PNG → білий фон
      ctx.drawImage(img, sx, sy, side, side, 0, 0, OUT_SIZE, OUT_SIZE);
      let q = 0.85, out = cv.toDataURL('image/jpeg', q);
      while(out.length > MAX_LEN && q > 0.35){ q -= 0.1; out = cv.toDataURL('image/jpeg', q); }
      done(out.length <= 60000 ? out : null);
    });
    window.addEventListener('resize', apply, { once: true });
  });
}

function init(){
  const watch = (id, fn) => {
    const el = document.getElementById(id);
    if(el) new MutationObserver(() => fn()).observe(el, { childList: true, attributes: true, attributeFilter: ['hidden'] });
  };
  watch('pb-child-switcher', paintSwitcher);
  watch('p-bday', paintBday); watch('s-bday', paintBday);
  // Профіль відкрили — показуємо актуальне фото
  const pm = document.getElementById('profile-modal');
  let pmOpen = false;
  if(pm) new MutationObserver(() => {
    const open = !!pm.style.display && pm.style.display !== 'none';
    if(open && !pmOpen) renderPhotoBlock();          // лише в мить відкриття
    pmOpen = open;
  }).observe(pm, { attributes: true, attributeFilter: ['style'] });
  window.addEventListener('push:context', () => { for(const k in mem) delete mem[k]; });
}
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
