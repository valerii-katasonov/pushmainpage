// ═══════════════════════════════════════════════════════════════
// chat.js — листування.
//
// МОДЕЛЬ ДАНИХ
//   chats/{id} = {
//     members: { пошта_з_підкресленнями: true, ... },   // 2 і більше
//     staff:   'пошта_співробітника',   // хоча б один — див. нижче
//     title:   'Іван ↔ Ольга',          // підпис для списку
//     createdBy, createdAt,
//     messages: { push: {from, fromName, text, time, read} }
//   }
//   user_chats/{моя_пошта}/{id} = true   // покажчик «мої переписки»
//
// ЧОМУ ПОКАЖЧИК, А НЕ ПЕРЕБІР УСІХ ЧАТІВ: раніше кабінет читав вузол
// chats цілком і фільтрував у браузері. Це означало, що кожен бачить
// чуже листування — досить відкрити консоль. Тепер кожен читає лише свій
// список і лише ті чати, де він у members.
//
// ЧОМУ ПОЛЕ staff: без нього двоє батьків могли б листуватися між собою
// через портал. Правила вимагають, щоб серед учасників був співробітник,
// і перевіряють це саме за цим полем — інакше довелося б перебирати
// невідомі ключі, чого мова правил не вміє.
//
// ЧОМУ ДОДАВАННЯ ЛЮДИНИ СТВОРЮЄ НОВИЙ ЧАТ: попереднє листування могло
// містити те, що не призначалося третьому. Додати його заднім числом до
// вже написаного означало б розкрити чуже листування.
// ═══════════════════════════════════════════════════════════════
import { ref, set, get, child, push, update, onValue }
  from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, auth, currentUserData, showToast, escHtml, escJs,
         isTeacherRole, getUsersSnap, logAction, notifyEvent } from './common.js';

const safe  = e => String(e||'').toLowerCase().replace(/\./g,'_');
const unsafe = se => String(se||'').replace(/_/g,'.');
const myKey = () => safe(auth.currentUser?.email);

let listListener = null, msgListener = null, currentChatId = null, currentMembers = [];

// ── ХТО КОМУ МОЖЕ ПИСАТИ ──
// Директор і секретар — будь-кому. Учитель — батькам своїх класів та
// адміністрації. Батьки й учні — адміністрації та вчителям свого класу.
// Це обмеження інтерфейсу; правила доступу стежать лише за тим, щоб у
// розмові був хтось зі школи.
// ── Довідник контактів ──
// Один прохід по базі, з якого беруться і підписи в списку розмов, і
// список, з кого обирати співрозмовника. Раніше в списку світилася пошта:
// імена лежать у вузлах, які родині читати не можна, тож підставляти було
// нічого. Тепер є `staff_directory` і `class_parents` — рівно імʼя, роль
// і клас, без контактів та медичних даних.
const ROLE_LABEL = {
  director:'Директор', administrator:'Адміністрація', kitchen:'Кухня',
  teacher:'Учитель', class_teacher:'Класний керівник',
  art_school_teacher:'Учитель мистецтв', music_teacher:'Учитель музики',
  psychologist:'Психолог', nurse:'Медсестра', secretary:'Секретар'
};
const roleLabel = r => ROLE_LABEL[r] || (r ? String(r) : '');
const clsLabel  = c => c ? String(c).replace('class_','') + ' клас' : '';

let _dirCache = null, _dirAt = 0;
export function invalidateContactDir(){ _dirCache = null; }

// Map: safeEmail → { name, sub, kind:'staff'|'parent' }
export async function contactDirectory(){
  if(_dirCache && Date.now() - _dirAt < 60000) return _dirCache;
  const map = new Map();
  const role = currentUserData?.role || '';
  const isAdmin = role === 'director' || role === 'administrator';
  const put = (key, name, sub, kind, extra) => {
    if(!key) return;
    const prev = map.get(key);
    // Не затираємо повніший запис порожнішим
    if(prev && prev.name && !name) return;
    map.set(key, { key, name: name || (prev && prev.name) || unsafe(key),
                   sub: sub || (prev && prev.sub) || '', kind: kind || (prev && prev.kind),
                   role: (extra && extra.role) || (prev && prev.role) || '',
                   classes: (extra && extra.classes) || (prev && prev.classes) || [] });
  };

  // Персонал бачать усі
  try{
    const sd = await get(child(ref(db),'staff_directory'));
    if(sd.exists()){
      const v = sd.val();
      for(const se in v){
        const r = v[se] || {};
        const cls = r.classes ? Object.keys(r.classes).map(c=>c.replace('class_','')).join(', ') : '';
        put(se, r.name, [roleLabel(r.role), cls && cls + ' кл.'].filter(Boolean).join(' · '), 'staff',
            { role: r.role, classes: r.classes ? Object.keys(r.classes) : [] });
      }
    }
  }catch(e){ console.warn('staff_directory', e.message); }

  if(isAdmin){
    // Директор читає першоджерела — там дані свіжіші за довідник
    try{
      const [usersSnap, plSnap] = await Promise.all([
        getUsersSnap(), get(child(ref(db),'parent_links'))
      ]);
      const users = usersSnap.exists() ? usersSnap.val() : {};
      for(const uid in users){
        const u = users[uid];
        if(!u || !u.email || u.disabled) continue;
        if(u.role === 'parent' || u.role === 'student') continue;
        put(safe(u.email), [u.firstName,u.lastName].filter(Boolean).join(' '), roleLabel(u.role), 'staff', { role: u.role });
      }
      const pls = plSnap.exists() ? plSnap.val() : {};
      for(const se in pls){
        const p = pls[se] || {};
        const kids = p.children || [];
        const list = Array.isArray(kids) ? kids : Object.values(kids);
        const who = list.map(k => k && k.studentName ? k.studentName + (k.class ? ` (${clsLabel(k.class)})` : '') : '')
                        .filter(Boolean).join(', ');
        const prof = p.profile;
        put(se, (prof && [prof.lastName,prof.firstName].filter(Boolean).join(' ')) || '',
            who ? 'Батьки · ' + who : 'Батьки', 'parent');
      }
    }catch(e){ console.warn('directory/admin', e.message); }
  } else if(isTeacherRole(role)){
    // Учитель — батьки своїх класів
    try{
      const ts = await get(child(ref(db),`teacher_access/${myKey()}`));
      const myClasses = ts.exists() ? Object.keys(ts.val() || {}) : [];
      const rosters = await Promise.all(myClasses.map(async c => {
        try{ const r = await get(child(ref(db),`class_parents/${c}`)); return [c, r.exists()?r.val():{}]; }
        catch(e){ return [c, {}]; }
      }));
      rosters.forEach(([c, rst]) => {
        for(const se in rst){
          const p = rst[se] || {};
          put(se, p.name, 'Батьки · ' + [p.children, clsLabel(c)].filter(Boolean).join(', '), 'parent');
        }
      });
    }catch(e){ console.warn('directory/teacher', e.message); }
  }

  _dirCache = map; _dirAt = Date.now();
  return map;
}

// Кого САМЕ цей користувач має право писати першим
export async function chatCandidates(){
  const role = currentUserData?.role || '';
  const isAdmin = role === 'director' || role === 'administrator';
  const dir = await contactDirectory();
  const mine = myKey();
  const asItem = c => ({ key:c.key, email:unsafe(c.key), name:c.name, kind:c.kind,
                         tag:c.sub || (c.kind==='parent'?'Батьки':'Персонал') });
  const isAdminRec = c => c.role === 'director' || c.role === 'administrator';

  const all = [...dir.values()].filter(c => c.key !== mine);
  if(isAdmin) return all.map(asItem);                       // директор пише будь-кому

  if(isTeacherRole(role)){
    // Свої батьки + адміністрація
    return all.filter(c => c.kind === 'parent' || isAdminRec(c)).map(asItem);
  }

  // Батьки та учні — адміністрація і вчителі свого класу
  const myClass = currentUserData?.class || '';
  return all.filter(c => {
    if(c.kind !== 'staff') return false;
    if(isAdminRec(c)) return true;
    return myClass && (c.classes || []).includes(myClass);
  }).map(asItem);
}

// ── СПИСОК ПЕРЕПИСОК ──
window.openChatModal = async function(){
  document.getElementById('inbox-modal').style.display = 'flex';
  window.backToChatList();
  const box = document.getElementById('inbox-contacts-list');
  box.innerHTML = '<p class="empty-msg" style="padding:20px;">Завантаження...</p>';

  if(listListener) listListener();
  const dir = await contactDirectory().catch(()=>new Map());
  listListener = onValue(ref(db, `user_chats/${myKey()}`), async snap => {
    const ids = snap.exists() ? Object.keys(snap.val()) : [];
    if(!ids.length){
      box.innerHTML = '<div class="ch-empty">💬<span>Тут зʼявляться ваші переписки</span></div>';
      return;
    }
    const chats = await Promise.all(ids.map(id => get(child(ref(db), `chats/${id}`)).catch(()=>null)));
    const rows = [];
    chats.forEach((s,i)=>{
      if(!s || !s.exists()) return;
      const c = s.val(), id = ids[i];
      const msgs = c.messages ? Object.values(c.messages) : [];
      const last = msgs.length ? msgs[msgs.length-1] : null;
      const unread = msgs.filter(m=>m.from !== myKey() && !m.read).length;
      rows.push({ id, title: chatTitle(c, dir), sub: chatSubtitle(c, dir),
                  members:Object.keys(c.members||{}).length,
                  last, unread, time: last ? last.time : (c.createdAt||0) });
    });
    rows.sort((a,b)=>b.time-a.time);
    box.innerHTML = rows.map(r=>`
      <div class="ch-row" onclick="selectChatThread('${escJs(r.id)}')">
        <div class="ch-av" style="background:${avatarColor(r.title)};">${escHtml(initials(r.title))}</div>
        <div class="ch-mid">
          <div class="ch-top"><span class="ch-name">${escHtml(r.title)}</span>
            ${r.time ? `<span class="ch-time">${chatTime(r.time)}</span>` : ''}</div>
          ${r.sub ? `<div class="ch-sub">${escHtml(r.sub)}</div>` : ''}
          <div class="ch-prev">${r.members>2?`<b>${r.members} учасники · </b>`:''}${
            r.last ? escHtml(String(r.last.fromName||'').split(' ')[0]) + ': ' + escHtml(r.last.text) : 'Повідомлень ще немає'}</div>
        </div>
        ${r.unread ? `<span class="ch-badge">${r.unread}</span>` : ''}
      </div>`).join('') || '<div class="ch-empty">💬<span>Тут зʼявляться ваші переписки</span></div>';
  }, err => {
    // Мовчазна відмова — найгірший варіант: людина дивиться на спінер
    // і не знає, що робити. Кажемо прямо.
    box.innerHTML = `<div class="ch-empty">⚠️<span>Не вдалося завантажити список: ${escHtml(err.message||'немає доступу')}</span></div>`;
  });
};

function chatTitle(c, dir){
  if(c.title) return c.title;
  const others = Object.keys(c.members||{}).filter(k=>k!==myKey());
  if(!others.length) return 'Переписка';
  return others.map(k => (dir && dir.get(k) && dir.get(k).name) || unsafe(k)).join(', ');
}
// Другий рядок підпису: посада або клас дитини
function chatSubtitle(c, dir){
  const others = Object.keys(c.members||{}).filter(k=>k!==myKey());
  if(others.length !== 1 || !dir) return '';
  const r = dir.get(others[0]);
  return r && r.sub ? r.sub : '';
}

// ── ОДНА ПЕРЕПИСКА ──
window.selectChatThread = async function(chatId){
  currentChatId = chatId;
  markChatSeen(chatId);
  setTimeout(()=>{ if(window.watchUnread) window.watchUnread(); }, 0);
  document.getElementById('chat-list-view').style.display = 'none';
  document.getElementById('chat-detail-view').style.display = 'flex';
  let c = {};
  try{
    const snap = await get(child(ref(db), `chats/${chatId}`));
    c = snap.exists() ? snap.val() : {};
  }catch(e){
    document.getElementById('inbox-messages-list').innerHTML =
      `<div class="ch-empty">⚠️<span>Немає доступу до цієї розмови</span></div>`;
    return;
  }
  currentMembers = Object.keys(c.members || {});
  const dir = await contactDirectory().catch(()=>new Map());
  document.getElementById('chat-detail-title').innerText = chatTitle(c, dir);
  const sub = document.getElementById('chat-detail-sub');
  if(sub){
    // Для групи — скільки учасників, для розмови двох — посада або клас
    const t = currentMembers.length > 2
      ? `${currentMembers.length} учасники`
      : chatSubtitle(c, dir);
    sub.textContent = t;
    sub.style.display = t ? 'block' : 'none';
  }
  loadChatMessages(chatId);
};

function loadChatMessages(chatId){
  const list = document.getElementById('inbox-messages-list');
  if(msgListener) msgListener();
  const me = myKey();
  msgListener = onValue(ref(db, `chats/${chatId}/messages`), snap => {
    if(!snap.exists()){
      list.innerHTML = '<div class="ch-empty">✉️<span>Повідомлень ще немає — напишіть перше</span></div>';
      return;
    }
    const msgs = Object.keys(snap.val()).map(k=>({id:k, ...snap.val()[k]})).sort((a,b)=>a.time-b.time);
    let prevFrom = null, prevDay = null, html = '';
    msgs.forEach((m,i)=>{
      const isMe = m.from === me;
      const day = new Date(m.time).toDateString();
      if(day !== prevDay){
        html += `<div class="ms-day"><span>${escHtml(chatDayLabel(m.time))}</span></div>`;
        prevDay = day; prevFrom = null;
      }
      const grouped = m.from === prevFrom;
      const next = msgs[i+1];
      const last = !next || next.from !== m.from || new Date(next.time).toDateString() !== day;
      html += `<div class="ms ${isMe?'me':'they'}${grouped?' grp':''}${last?' last':''}">
        ${(!grouped && !isMe) ? `<div class="ms-from">${escHtml(m.fromName||'')}</div>` : ''}
        <div class="ms-text">${escHtml(m.text)}</div>
        ${last ? `<div class="ms-time">${new Date(m.time).toLocaleTimeString('uk-UA',{hour:'2-digit',minute:'2-digit'})}</div>` : ''}
      </div>`;
      prevFrom = m.from;
      if(!isMe && !m.read) update(ref(db, `chats/${chatId}/messages/${m.id}`), {read:true}).catch(()=>{});
    });
    list.innerHTML = html;
    list.scrollTop = list.scrollHeight;
  }, err => {
    list.innerHTML = `<div class="ch-empty">⚠️<span>Не вдалося відкрити переписку: ${escHtml(err.message||'немає доступу')}</span></div>`;
  });
}

window.backToChatList = function(){
  if(msgListener) msgListener();
  const d = document.getElementById('chat-detail-view');
  const l = document.getElementById('chat-list-view');
  if(d) d.style.display = 'none';
  if(l) l.style.display = 'flex';
  currentChatId = null; currentMembers = [];
};
window.closeInboxModal = function(){
  document.getElementById('inbox-modal').style.display = 'none';
  if(msgListener) msgListener();
  if(listListener) listListener();
};

window.sendInboxMessage = async function(){
  if(!currentChatId) return;
  const input = document.getElementById('msg-text-input');
  const text = input.value.trim();
  if(!text) return;
  const role = currentUserData?.role;
  const label = role==='director' ? '(Директор)' : role==='administrator' ? '(Секретар)'
              : isTeacherRole(role) ? '(Вчитель)' : role==='parent' ? '(Батьки)'
              : role==='student' ? '(Учень)' : '';
  const nm = [currentUserData?.firstName, currentUserData?.lastName].filter(Boolean).join(' ')
             || currentUserData?.studentName || currentUserData?.email || '';
  try{
    const ts = Date.now();
    await push(ref(db, `chats/${currentChatId}/messages`), {
      from: myKey(), fromName: `${nm} ${label}`.trim(), text, time: ts, read: false
    });
    // Короткий зліпок останнього повідомлення: за ним рахується значок
    // непрочитаних, не читаючи всю переписку.
    // Якщо зліпок не запишеться, повідомлення все одно піде, але значок
    // непрочитаних у співрозмовника не зʼявиться — мовчати про це не варто.
    await update(ref(db, `chats/${currentChatId}`), {
      lastMsg: { from: myKey(), text: text.slice(0,120), ts }
    }).catch(e => console.warn('lastMsg не оновлено:', e.message));
    input.value = ''; input.style.height = 'auto';

    // Сповіщення решті учасників. Тексту в пуш не кладемо: він видно на
    // екрані блокування, а в школі листування буває про дітей.
    const others = currentMembers.filter(k => k !== myKey()).map(unsafe);
    if(others.length) notifyEvent('chat', { to: others, subject: nm || 'Школа',
                                            value: 'нове повідомлення' });
  }catch(e){
    alert(/permission|denied/i.test(e.message||'')
      ? 'Ви не учасник цієї переписки.' : 'Не вдалося надіслати: ' + e.message);
  }
};

// ── НОВА ПЕРЕПИСКА / ДОДАТИ УЧАСНИКА ──
window.openChatPicker = async function(mode){
  invalidateContactDir();
  const modal = document.getElementById('chat-picker');
  const box   = document.getElementById('cp-list');
  if(!modal || !box) return;
  modal.dataset.mode = mode;                 // 'new' або 'add'
  document.getElementById('cp-title').textContent =
    mode === 'add' ? 'Додати до розмови' : 'Нова переписка';
  document.getElementById('cp-note').textContent = mode === 'add'
    ? 'Створиться ОКРЕМА переписка з усіма учасниками. Попереднє листування новий учасник не побачить.'
    : 'Оберіть одного або кількох.';
  modal.style.display = 'flex';
  box.innerHTML = '<p class="empty-msg">Завантаження...</p>';
  try{
    const list = (await chatCandidates()).filter(c => !currentMembers.includes(c.key));
    if(!list.length){ box.innerHTML = '<p class="empty-msg">Немає доступних співрозмовників.</p>'; return; }
    list.sort((a,b)=>a.name.localeCompare(b.name,'uk'));
    box.innerHTML = list.map(c=>`
      <label class="cp-row">
        <input type="checkbox" value="${escHtml(c.key)}" data-name="${escHtml(c.name)}">
        <span class="cp-av" style="background:${avatarColor(c.name)};">${escHtml(initials(c.name))}</span>
        <span class="cp-mid"><b>${escHtml(c.name)}</b><small>${escHtml(c.tag||'')}</small></span>
      </label>`).join('');
  }catch(e){
    box.innerHTML = `<p class="empty-msg" style="color:var(--red);">${escHtml(e.message)}</p>`;
  }
};
window.closeChatPicker = function(){ document.getElementById('chat-picker').style.display='none'; };

window.createChatFromPicker = async function(){
  const modal = document.getElementById('chat-picker');
  const picked = Array.from(document.querySelectorAll('#cp-list input:checked'))
                      .map(i=>({key:i.value, name:i.dataset.name}));
  if(!picked.length) return alert('Оберіть хоча б одного співрозмовника.');

  const me = myKey();
  const base = modal.dataset.mode === 'add' ? currentMembers : [me];
  const members = [...new Set([...base, me, ...picked.map(p=>p.key)])];

  // Серед учасників має бути співробітник — інакше правила відхилять запис
  const role = currentUserData?.role || '';
  const iAmStaff = role !== 'parent' && role !== 'student';
  let staffKey = iAmStaff ? me : null;
  if(!staffKey){
    const cands = await chatCandidates();
    const s = picked.find(p => cands.find(c => c.key === p.key && c.kind === 'staff'));
    staffKey = s ? s.key : null;
  }
  if(!staffKey) return alert('У розмові має бути хтось зі школи — учитель або адміністрація.');
  // Звірка зі списком персоналу — лише для адміністрації: читати
  // pre_approved_roles більше нікому не можна. Для решти перевірку робить
  // саме правило при записі, а помилку ми покажемо зрозумілим текстом.
  const canCheckStaff = role === 'director' || role === 'administrator';
  const staffOk = canCheckStaff
    ? await get(child(ref(db), `pre_approved_roles/${staffKey}`)).catch(()=>null)
    : { exists: () => true };
  if(!staffOk || !staffOk.exists()){
    return alert(`Співробітника ${unsafe(staffKey)} немає у списку персоналу школи.\n\n`
      + 'Директор має додати цю пошту в «Управління персоналом» — інакше правила доступу не дозволять створити розмову.');
  }

  // Для розмови двох ключ детермінований, щоб не плодити дублікати.
  // Для групи — новий ключ: додавання людини завжди створює окрему розмову.
  const id = members.length === 2
    ? [...members].sort().join('___')
    : (push(ref(db,'chats')).key);

  const myName = [currentUserData?.firstName, currentUserData?.lastName].filter(Boolean).join(' ')
                 || currentUserData?.email || '';
  try{
    // Чи є вже така розмова — питаємо у ВЛАСНОГО покажчика, а не в самого
    // чату. Читати chats/{id} можна лише учаснику, тож перевірка існування
    // неіснуючого чату сама падала б із «Permission denied».
    const known = await get(child(ref(db), `user_chats/${me}/${id}`));
    if(!known.exists()){
      const mem = {}; members.forEach(k=>mem[k]=true);
      // update, а не set: якщо розмова вже існує (наприклад покажчик
      // загубився), set стер би всі повідомлення.
      await update(ref(db, `chats/${id}`), {
        members: mem, staff: staffKey,
        title: members.length > 2
          ? [myName, ...picked.map(p=>p.name)].join(', ')
          : null,
        createdBy: me, createdAt: Date.now()
      });
      // Покажчики пишемо після чату: правила звіряються з його members
      for(const k of members) await set(ref(db, `user_chats/${k}/${id}`), true);
      logAction('chat', { value: `нова розмова, учасників: ${members.length}` });
    }
    window.closeChatPicker();
    window.selectChatThread(id);
  }catch(e){
    if(String(e.message||'').includes('permission')){
      return alert('Не вдалося створити розмову: немає прав.\n\n'
        + 'Найчастіша причина — співробітника ' + unsafe(staffKey) + ' немає у списку\n'
        + 'персоналу школи. Директор додає його в «Управління персоналом».');
    }
    const denied = /permission|denied/i.test(e.message||'');
    alert(denied
      ? 'Немає дозволу створити цю розмову. У ній має бути хтось зі школи — учитель або адміністрація.'
      : 'Не вдалося створити розмову: ' + e.message);
  }
};

// ── Оформлення ──
function initials(name){
  const p = String(name||'').trim().split(/\s+/);
  return ((p[0]||'')[0] || '?').toUpperCase() + ((p[1]||'')[0] || '').toUpperCase();
}
const AV = ['#5c6bc0','#26a69a','#ef6c00','#8e24aa','#00838f','#c2185b','#558b2f','#4527a0'];
function avatarColor(name){
  let h = 0; const s = String(name||'');
  for(let i=0;i<s.length;i++) h = (h*31 + s.charCodeAt(i)) >>> 0;
  return AV[h % AV.length];
}
function chatTime(ts){
  if(!ts) return '';
  const d = new Date(ts), now = new Date();
  if(d.toDateString() === now.toDateString())
    return d.toLocaleTimeString('uk-UA',{hour:'2-digit',minute:'2-digit'});
  const y = new Date(now); y.setDate(y.getDate()-1);
  if(d.toDateString() === y.toDateString()) return 'вчора';
  return d.toLocaleDateString('uk-UA',{day:'numeric',month:'short'});
}
function chatDayLabel(ts){
  const d = new Date(ts), now = new Date();
  if(d.toDateString() === now.toDateString()) return 'Сьогодні';
  const y = new Date(now); y.setDate(y.getDate()-1);
  if(d.toDateString() === y.toDateString()) return 'Вчора';
  return d.toLocaleDateString('uk-UA',{day:'numeric',month:'long'});
}

// ══════════ ЗНАЧОК НЕПРОЧИТАНИХ ══════════
// Рахуємо не за повідомленнями, а за зліпком lastMsg: інакше довелося б
// тримати відкритими слухачі на всі переписки одразу.
// Позначку «прочитано» тримаємо локально — значок має бути миттєвим,
// а зайвий запис у базу на кожне відкриття чату того не вартий.
const SEEN_KEY = 'push_school_chat_seen';
const seenMap = () => { try{ return JSON.parse(localStorage.getItem(SEEN_KEY)||'{}'); }catch(e){ return {}; } };
const markChatSeen = id => {
  try{ const m = seenMap(); m[id] = Date.now(); localStorage.setItem(SEEN_KEY, JSON.stringify(m)); }catch(e){}
};

let badgeUnsub = [], badgeListUnsub = null;
function paintBadge(n){
  document.querySelectorAll('.chat-dot').forEach(el=>{
    el.textContent = n > 99 ? '99+' : String(n);
    el.classList.toggle('show', n > 0);
  });
  // Значок у заголовку вкладки браузера — щоб було видно з іншої вкладки
  const base = document.title.replace(/^\(\d+\+?\)\s*/, '');
  document.title = n > 0 ? `(${n > 99 ? '99+' : n}) ${base}` : base;
}
export function watchUnread(){
  if(!auth.currentUser) return;
  if(badgeListUnsub) badgeListUnsub();
  badgeUnsub.forEach(u=>u()); badgeUnsub = [];
  const last = {};
  const recount = () => {
    const seen = seenMap();
    let n = 0;
    for(const id in last){
      const lm = last[id];
      if(!lm || lm.from === myKey()) continue;
      if((lm.ts||0) > (seen[id]||0)) n++;
    }
    paintBadge(n);
  };
  badgeListUnsub = onValue(ref(db, `user_chats/${myKey()}`), snap => {
    badgeUnsub.forEach(u=>u()); badgeUnsub = [];
    const ids = snap.exists() ? Object.keys(snap.val()) : [];
    ids.forEach(id => {
      badgeUnsub.push(onValue(ref(db, `chats/${id}/lastMsg`), s2 => {
        last[id] = s2.exists() ? s2.val() : null;
        recount();
      }, ()=>{}));
    });
    if(!ids.length) paintBadge(0);
  }, err => console.warn('значок непрочитаних:', err.message));
}
window.watchUnread = watchUnread;
export function stopWatchUnread(){
  if(badgeListUnsub) badgeListUnsub();
  badgeUnsub.forEach(u=>u()); badgeUnsub = [];
  badgeListUnsub = null; paintBadge(0);
}
window.stopWatchUnread = stopWatchUnread;
