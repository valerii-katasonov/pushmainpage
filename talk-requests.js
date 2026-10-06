// ═══════════════════════════════════════════════════════════════
// talk-requests.js — «💬 Хочу обговорити»: запит батьків учителю предмета.
//
// НАВІЩО. Не оцінка вчителя й не скарга, а прохання про розмову: «оцінки з
// математики знизились — давайте поговоримо». Батько обирає предмет і
// причину, вчитель предмета отримує push і відповідає тут же. Відповідь
// приходить батькові в кабінет і сповіщенням.
//
// ДЕ ЛЕЖИТЬ (два вузли — свідомо):
//   talk_requests/{клас}/{пошта батька}/{id} — СТАН: предмет, дата, чи
//       відповіли. Бачать батько-автор, учителі класу й директор. Директор
//       у «🔍 Контролі» бачить лише запити без відповіді понад 3 дні.
//   talk_text/{клас}/{пошта батька}/{id} — ЗМІСТ: причина, текст, відповідь.
//       Бачать лише батько-автор і вчителі цього класу (і класний керівник).
//       Директорові — ні, якщо сам не веде урок у цьому класі.
//
// Сповіщення складає сервер (notify.js, події talk / talk_reply) із запису
// в базі: клієнт передає лише адресу запису, а не текст.
// ═══════════════════════════════════════════════════════════════
import { ref, get, child, update, push } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, auth, currentUserData, escHtml, escJs, showToast, notifyEvent, subjKey, teacherAccessMatrix } from './common.js';

export const TALK_REASONS = {
  grades:   'оцінки знизились',
  topic:    'не розуміє тему',
  hw:       'забагато чи заскладне ДЗ',
  behavior: 'поведінка чи стосунки в класі',
  other:    'інше'
};
export const MAX_OPEN = 3;            // відкритих запитів на дитину одночасно
export const TEXT_MAX = 300, REPLY_MAX = 500;
const RECENT_DAYS = 30;               // скільки показувати закриті / з відповіддю

// Ключ пошти — так само, як у правилах бази (auth.token.email.replace('.','_'))
export const seKey = e => String(e || '').replace(/\./g, '_');
const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
// КОПІЯ sameSubj з access.js
// Чи це той самий предмет. Назви приходять із різних місць — матриця
// доступу, розклад із файлу, каталог — і пишуться по-різному: «Укр. мова» і
// «Українська мова», «Англ. мова» і «Англійська мова», чергування «Музика /
// Фізкультура». Точне порівняння тихо відрізало вчителя від сповіщень.
// Правило: однакові після нормалізації; або є спільна частина чергування;
// або слова попарно збігаються, де скорочення (від 3 літер) — початок слова.
function sameSubj(a, b){
  const nz = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const A = nz(a), B = nz(b);
  if(!A || !B) return false;
  if(A === B) return true;
  const pa = A.split(/\s*\/\s*/).filter(x => x.length >= 3), pb = B.split(/\s*\/\s*/).filter(x => x.length >= 3);
  if(pa.length > 1 || pb.length > 1) return pa.some(x => pb.some(y => sameSubj(x, y)));
  const ta = A.split(/[\s.,()\-]+/).filter(Boolean), tb = B.split(/[\s.,()\-]+/).filter(Boolean);
  if(!ta.length || ta.length !== tb.length) return false;
  return ta.every((x, i) => { const y = tb[i]; if(x === y) return true; const s = x.length < y.length ? x : y, l = x.length < y.length ? y : x; return s.length >= 3 && l.startsWith(s); });
}

const p2 = n => String(n).padStart(2, '0');
const dm = ts => { const d = new Date(Number(ts) || 0); return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}`; };
const clsLabel = c => String(c).replace('class_', '') + ' кл.';
const val = async p => { const s = await get(child(ref(db), p)); return s.exists() ? s.val() : null; };

// Предмети класу з розкладу {день: [слот | [варіанти]]}. expand — як
// window.expandAltSubjects (урок, що чергується, дає кілька предметів).
export function subjectsFromSchedule(schedule, expand){
  const out = new Set();
  for(const slots of Object.values(schedule || {}))
    for(const slot of (Array.isArray(slots) ? slots : Object.values(slots || {}))){
      const items = Array.isArray(slot) ? slot : (slot && typeof slot === 'object' && Object.keys(slot).length ? [slot] : []);
      for(const it of items) for(const n of (expand ? expand(it) : [it && it.subject]))
        if(n && typeof n === 'string' && n.trim()) out.add(n.trim());
    }
  return [...out].sort((a, b) => a.localeCompare(b, 'uk'));
}

// {id: meta} + {id: text} → список, найновіші зверху
export function mergeTalks(meta, text, extra = {}){
  return Object.entries(meta || {}).filter(([, m]) => m && typeof m === 'object')
    .map(([id, m]) => ({ id, ...extra, ...m, ...((text || {})[id] || {}) }))
    .sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
}

// Чи бачить цей учитель запит: класний керівник — усі запити класу,
// предметник — лише свого предмета (або «Всі предмети»).
export function teacherSees(req, mySubjects, isHead){
  if(isHead) return true;
  const list = (Array.isArray(mySubjects) ? mySubjects : Object.values(mySubjects || {})).filter(s => typeof s === 'string');
  if(list.some(s => s.trim() === 'Всі предмети')) return true;
  return list.some(s => sameSubj(s, req.subject) || subjKey(s) === subjKey(req.subject));
}

// Що батько може надіслати зараз (null — можна, інакше пояснення)
export function canAsk(mine, subject, now = Date.now()){
  const open = (mine || []).filter(r => r.status === 'open');
  if(open.length >= MAX_OPEN) return `Уже є ${open.length} запити без відповіді — дочекайтеся відповіді або скасуйте один.`;
  if(open.some(r => norm(r.subject) === norm(subject))) return 'З цього предмета запит уже надіслано — учитель ще не відповів.';
  const day = (mine || []).filter(r => now - (Number(r.ts) || 0) < 864e5).length;
  if(day >= 5) return 'Забагато запитів за добу. Спробуйте завтра.';
  return null;
}

const statusHtml = r => r.status === 'answered' ? '<span class="tk-st ok">✅ є відповідь</span>'
  : r.status === 'closed' ? '<span class="tk-st">закрито</span>' : '<span class="tk-st wait">⏳ чекає відповіді</span>';

// ── БАТЬКИ ──
export function parentTalkHtml(list, subjects, now = Date.now()){
  const shown = list.filter(r => r.status === 'open' || now - (Number(r.replyTs || r.ts) || 0) < RECENT_DAYS * 864e5);
  return `<div class="fw-title">💬 Хочу обговорити з учителем</div>
    <p class="fw-note">Запит отримає вчитель предмета, відповідь прийде сюди й сповіщенням. Текст бачать лише вчителі класу. Директор бачить тільки, чи відповіли на запит вчасно.</p>
    ${shown.length ? `<ul class="tk-list">${shown.map(r => `<li class="tk-item">
        <div><b>${escHtml(r.subject)}</b> · ${escHtml(dm(r.ts))} · ${statusHtml(r)}</div>
        <div class="tk-reason">${escHtml(TALK_REASONS[r.reason] || '')}${r.text ? ` — ${escHtml(r.text)}` : ''}</div>
        ${r.reply ? `<div class="tk-reply">👩‍🏫 ${escHtml(r.reply)}</div>` : ''}
        ${r.status === 'open' ? `<button type="button" class="tk-link" onclick="talkCancel('${escJs(r.id)}')">Скасувати запит</button>` : ''}
      </li>`).join('')}</ul>` : ''}
    <button type="button" class="tk-new" onclick="talkOpenForm()">➕ Новий запит</button>
    <div id="talk-form" class="tk-form" hidden>
      <label>Предмет<select id="talk-subj">${subjects.length
        ? '<option value="">— оберіть —</option>' + subjects.map(s => `<option value="${escHtml(s)}">${escHtml(s)}</option>`).join('')
        : '<option value="">Розклад класу ще не завантажено</option>'}</select></label>
      <div class="tk-reasons">${Object.entries(TALK_REASONS).map(([k, t], i) =>
        `<label><input type="radio" name="talk-reason" value="${k}"${i === 0 ? ' checked' : ''}> ${escHtml(t)}</label>`).join('')}</div>
      <label>Коротко, що турбує (необовʼязково)<textarea id="talk-text" maxlength="${TEXT_MAX}" rows="3"></textarea></label>
      <div class="tk-actions"><button type="button" class="tk-send" onclick="talkSubmit()">Надіслати</button>
        <button type="button" class="tk-link" onclick="talkOpenForm(false)">Скасувати</button></div>
    </div>`;
}

const TK = { box: null, cls: '', se: '', list: [] };
function parentCtx(){
  const u = currentUserData || {}, email = auth.currentUser && auth.currentUser.email;
  if(u.role !== 'parent' || !u.class || !email) return null;
  return { cls: u.class, se: seKey(email), email, child: u.studentId || u.studentName, childName: u.studentName || '' };
}
async function classSubjects(cls){
  let sched = window.schedule;
  if(!sched || !Object.keys(sched).length) sched = (await val(`schedules/${cls}/lessons`).catch(() => null)) || {};
  return subjectsFromSchedule(sched, window.expandAltSubjects ? it => { try{ return window.expandAltSubjects(it); }catch(e){ return [it && it.subject]; } } : null);
}
export async function renderTalkParent(boxId){
  const box = document.getElementById(boxId);
  if(!box) return;
  const me = parentCtx();
  if(!me){ box.style.display = 'none'; return; }
  try{
    const [meta, text, subjects] = await Promise.all([
      val(`talk_requests/${me.cls}/${me.se}`), val(`talk_text/${me.cls}/${me.se}`).catch(() => null), classSubjects(me.cls)]);
    Object.assign(TK, { box: boxId, cls: me.cls, se: me.se, list: mergeTalks(meta, text) });
    box.innerHTML = parentTalkHtml(TK.list, subjects);
    box.style.display = 'block';
  }catch(e){
    console.warn('[Push School] запити вчителю:', e.message);
    box.style.display = 'none';
  }
}
window.talkOpenForm = function(show = true){
  const f = document.getElementById('talk-form');
  if(f) f.hidden = !show;
  if(show) document.getElementById('talk-subj')?.focus();
};
window.talkSubmit = async function(){
  const me = parentCtx();
  if(!me) return;
  const subject = document.getElementById('talk-subj')?.value || '';
  const reason = document.querySelector('input[name="talk-reason"]:checked')?.value || 'other';
  const text = String(document.getElementById('talk-text')?.value || '').trim().slice(0, TEXT_MAX);
  if(!subject){ showToast('Оберіть предмет'); return; }
  const why = canAsk(TK.list, subject);
  if(why){ showToast(why); return; }
  const id = push(ref(db, `talk_requests/${me.cls}/${me.se}`)).key;
  const meta = { byEmail: me.email, child: me.child, childName: me.childName, subject: subject.slice(0, 80), ts: Date.now(), status: 'open' };
  const body = { reason: TALK_REASONS[reason] ? reason : 'other' };
  if(text) body.text = text;
  try{
    await update(ref(db), { [`talk_requests/${me.cls}/${me.se}/${id}`]: meta, [`talk_text/${me.cls}/${me.se}/${id}`]: body });
  }catch(e){ alert('Не вдалося надіслати запит: ' + e.message); return; }
  const r = await notifyEvent('talk', { class: me.cls, who: me.se, ref: id });
  showToast(r && r.ok && r.sent ? '✅ Запит надіслано вчителю' : '✅ Запит збережено — учитель побачить його в кабінеті');
  await renderTalkParent(TK.box);
};
window.talkCancel = async function(id){
  const me = parentCtx();
  if(!me || !confirm('Скасувати цей запит?')) return;
  try{ await update(ref(db), { [`talk_requests/${me.cls}/${me.se}/${id}/status`]: 'closed' }); }
  catch(e){ alert('Не вдалося: ' + e.message); return; }
  await renderTalkParent(TK.box);
};

// ── УЧИТЕЛЬ ──
export function teacherTalkHtml(list, now = Date.now()){
  const open = list.filter(r => r.status === 'open');
  const done = list.filter(r => r.status !== 'open' && now - (Number(r.replyTs || r.ts) || 0) < RECENT_DAYS * 864e5);
  const item = r => `<li class="tk-item">
      <div><b>${escHtml(clsLabel(r.cls))} · ${escHtml(r.subject)}</b> · ${escHtml(r.childName || '')} · ${escHtml(dm(r.ts))}
        ${r.status === 'open' ? `<span class="tk-st wait">${Math.floor((now - (Number(r.ts) || 0)) / 864e5)} дн.</span>` : statusHtml(r)}</div>
      <div class="tk-reason">${escHtml(TALK_REASONS[r.reason] || '')}${r.text ? ` — ${escHtml(r.text)}` : ''}</div>
      <div class="fw-note">${escHtml(r.byEmail || '')}${r.phone ? ` · 📞 ${escHtml(r.phone)}` : ''}</div>
      ${r.status === 'open' ? `<textarea id="tk-r-${escHtml(r.id)}" class="tk-answer" maxlength="${REPLY_MAX}" rows="2" placeholder="Напр.: Зателефоную завтра о 15:00 / Чекаю на консультацію в четвер"></textarea>
        <button type="button" class="tk-send" onclick="talkReply('${escJs(r.cls)}','${escJs(r.se)}','${escJs(r.id)}')">Відповісти</button>`
        : r.reply ? `<div class="tk-reply">${escHtml(r.reply)}</div>` : ''}
    </li>`;
  return `<div class="fw-title">💬 Запити батьків ${open.length ? `<span class="tk-badge">${open.length}</span>` : ''}</div>
    ${open.length ? `<ul class="tk-list">${open.map(item).join('')}</ul>` : '<p class="fw-note">Нових запитів немає.</p>'}
    ${done.length ? `<details class="tk-done"><summary>Відповідені за ${RECENT_DAYS} днів: ${done.length}</summary><ul class="tk-list">${done.map(item).join('')}</ul></details>` : ''}
    <p class="fw-note">Директор бачить лише запити без відповіді довше 3 днів — без тексту.</p>`;
}
const TT = { box: null };
export async function renderTalkTeacher(boxId){
  const box = document.getElementById(boxId);
  if(!box) return;
  const email = auth.currentUser && auth.currentUser.email;
  if(!email){ box.style.display = 'none'; return; }
  TT.box = boxId;
  try{
    const heads = (await val('class_teachers').catch(() => null)) || {};
    const access = teacherAccessMatrix || {};
    const headOf = new Set(Object.keys(heads).filter(c => heads[c] && String(heads[c].teacherEmail || '').toLowerCase() === email.toLowerCase()));
    const classes = [...new Set([...Object.keys(access), ...headOf])].filter(c => /^class_\d{1,2}$/.test(c));
    const perClass = await Promise.all(classes.map(c => Promise.all([
      val(`talk_requests/${c}`).catch(() => null), val(`talk_text/${c}`).catch(() => null)])));
    const list = [];
    classes.forEach((c, i) => {
      const [meta, text] = perClass[i];
      for(const [se, byId] of Object.entries(meta || {}))
        for(const r of mergeTalks(byId, (text || {})[se], { cls: c, se }))
          if(teacherSees(r, access[c], headOf.has(c))) list.push(r);
    });
    // Телефон батька — щоб було як звʼязатися (parent_links відкритий учителям)
    await Promise.all(list.filter(r => r.status === 'open').map(async r => {
      const p = await val(`parent_links/${r.se}/profile`).catch(() => null);
      if(p && p.phone) r.phone = String(p.phone).slice(0, 40);
    }));
    // Відкриті — першими; далі новіші
    list.sort((a, b) => ((b.status === 'open') - (a.status === 'open')) || ((Number(b.ts) || 0) - (Number(a.ts) || 0)));
    if(!list.length){ box.style.display = 'none'; box.innerHTML = ''; return; }
    box.innerHTML = teacherTalkHtml(list);
    box.style.display = 'block';
  }catch(e){
    console.warn('[Push School] запити батьків:', e.message);
    box.style.display = 'none';
  }
}
window.talkReply = async function(cls, se, id){
  const ta = document.getElementById('tk-r-' + id);
  const reply = String(ta && ta.value || '').trim().slice(0, REPLY_MAX);
  if(reply.length < 2){ showToast('Напишіть відповідь — батьки побачать її в кабінеті'); ta && ta.focus(); return; }
  const email = auth.currentUser && auth.currentUser.email || '';
  try{
    await update(ref(db), {
      [`talk_requests/${cls}/${se}/${id}/status`]: 'answered',
      [`talk_requests/${cls}/${se}/${id}/replyTs`]: Date.now(),
      [`talk_requests/${cls}/${se}/${id}/replyBy`]: email,
      [`talk_text/${cls}/${se}/${id}/reply`]: reply
    });
  }catch(e){ alert('Не вдалося зберегти відповідь: ' + e.message); return; }
  const r = await notifyEvent('talk_reply', { class: cls, who: se, ref: id });
  showToast(r && r.ok && r.sent ? '✅ Відповідь надіслано батькам' : '✅ Відповідь збережено — батьки побачать її в кабінеті');
  await renderTalkTeacher(TT.box);
};

window.renderTalkParent = renderTalkParent;
window.renderTalkTeacher = renderTalkTeacher;
