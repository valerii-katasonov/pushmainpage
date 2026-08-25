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
         isTeacherRole, getUsersSnap, logAction } from './common.js';

const safe  = e => String(e||'').toLowerCase().replace(/\./g,'_');
const unsafe = se => String(se||'').replace(/_/g,'.');
const myKey = () => safe(auth.currentUser?.email);

let listListener = null, msgListener = null, currentChatId = null, currentMembers = [];

// ── ХТО КОМУ МОЖЕ ПИСАТИ ──
// Директор і секретар — будь-кому. Учитель — батькам своїх класів та
// адміністрації. Батьки й учні — адміністрації та вчителям свого класу.
// Це обмеження інтерфейсу; правила доступу стежать лише за тим, щоб у
// розмові був хтось зі школи.
export async function chatCandidates(){
  const role = currentUserData?.role || '';
  const isAdmin = role === 'director' || role === 'administrator';
  const out = new Map();
  const add = (email, name, tag) => {
    const k = safe(email);
    if(!k || k === myKey() || out.has(k)) return;
    out.set(k, { key:k, email:String(email).toLowerCase(), name: name || unsafe(k), tag });
  };

  const [usersSnap, plSnap, taSnap, ctSnap] = await Promise.all([
    getUsersSnap(),
    get(child(ref(db),'parent_links')),
    get(child(ref(db),'teacher_access')),
    get(child(ref(db),'class_teachers'))
  ]);
  const users = usersSnap.exists() ? usersSnap.val() : {};
  const pls   = plSnap.exists() ? plSnap.val() : {};
  const ta    = taSnap.exists() ? taSnap.val() : {};
  const ct    = ctSnap.exists() ? ctSnap.val() : {};

  const nameOfUser = u => [u.firstName,u.lastName].filter(Boolean).join(' ') || u.email || '';
  const staffList = [];
  for(const uid in users){
    const u = users[uid];
    if(!u || !u.email || u.disabled) continue;
    if(u.role === 'parent' || u.role === 'student') continue;
    staffList.push({ email:u.email, name:nameOfUser(u), role:u.role });
  }

  if(isAdmin){
    staffList.forEach(s => add(s.email, s.name, 'Персонал'));
    for(const se in pls){
      const kids = pls[se].children || [];
      const list = Array.isArray(kids) ? kids : Object.values(kids);
      const who = list.map(k=>k && k.studentName).filter(Boolean).join(', ');
      add(unsafe(se), (pls[se].profile && [pls[se].profile.lastName,pls[se].profile.firstName].filter(Boolean).join(' ')) || unsafe(se),
          who ? `Батьки · ${who}` : 'Батьки');
    }
    return [...out.values()];
  }

  // Адміністрація доступна всім
  staffList.filter(s=>s.role==='director'||s.role==='administrator')
           .forEach(s=>add(s.email, s.name, 'Адміністрація'));

  if(isTeacherRole(role)){
    const myClasses = Object.keys(ta[myKey()] || {});
    for(const se in pls){
      const kids = pls[se].children || [];
      const list = Array.isArray(kids) ? kids : Object.values(kids);
      const mine = list.filter(k=>k && myClasses.includes(k.class));
      if(!mine.length) continue;
      add(unsafe(se),
          (pls[se].profile && [pls[se].profile.lastName,pls[se].profile.firstName].filter(Boolean).join(' ')) || unsafe(se),
          'Батьки · ' + mine.map(k=>k.studentName).join(', '));
    }
    return [...out.values()];
  }

  // Батьки та учні — вчителі свого класу
  const myClass = currentUserData?.class;
  if(myClass){
    const ctEmail = ct[myClass];
    for(const se in ta){
      if(!ta[se][myClass]) continue;
      const u = staffList.find(s=>safe(s.email) === se);
      add(unsafe(se), u ? u.name : unsafe(se),
          safe(ctEmail) === se ? 'Класний керівник' : 'Учитель');
    }
  }
  return [...out.values()];
}

// ── СПИСОК ПЕРЕПИСОК ──
window.openChatModal = async function(){
  document.getElementById('inbox-modal').style.display = 'flex';
  window.backToChatList();
  const box = document.getElementById('inbox-contacts-list');
  box.innerHTML = '<p class="empty-msg" style="padding:20px;">Завантаження...</p>';

  if(listListener) listListener();
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
      rows.push({ id, title: chatTitle(c), members:Object.keys(c.members||{}).length,
                  last, unread, time: last ? last.time : (c.createdAt||0) });
    });
    rows.sort((a,b)=>b.time-a.time);
    box.innerHTML = rows.map(r=>`
      <div class="ch-row" onclick="selectChatThread('${escJs(r.id)}')">
        <div class="ch-av" style="background:${avatarColor(r.title)};">${escHtml(initials(r.title))}</div>
        <div class="ch-mid">
          <div class="ch-top"><span class="ch-name">${escHtml(r.title)}</span>
            ${r.time ? `<span class="ch-time">${chatTime(r.time)}</span>` : ''}</div>
          <div class="ch-prev">${r.members>2?`<b>${r.members} учасники · </b>`:''}${
            r.last ? escHtml(String(r.last.fromName||'').split(' ')[0]) + ': ' + escHtml(r.last.text) : 'Повідомлень ще немає'}</div>
        </div>
        ${r.unread ? `<span class="ch-badge">${r.unread}</span>` : ''}
      </div>`).join('') || '<div class="ch-empty">💬<span>Тут зʼявляться ваші переписки</span></div>';
  });
};

function chatTitle(c){
  if(c.title) return c.title;
  const others = Object.keys(c.members||{}).filter(k=>k!==myKey());
  return others.map(unsafe).join(', ') || 'Переписка';
}

// ── ОДНА ПЕРЕПИСКА ──
window.selectChatThread = async function(chatId){
  currentChatId = chatId;
  document.getElementById('chat-list-view').style.display = 'none';
  document.getElementById('chat-detail-view').style.display = 'flex';
  const snap = await get(child(ref(db), `chats/${chatId}`));
  const c = snap.exists() ? snap.val() : {};
  currentMembers = Object.keys(c.members || {});
  document.getElementById('chat-detail-title').innerText = chatTitle(c);
  const sub = document.getElementById('chat-detail-sub');
  if(sub){
    sub.textContent = currentMembers.length > 2 ? `${currentMembers.length} учасники` : '';
    sub.style.display = currentMembers.length > 2 ? 'block' : 'none';
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
    await push(ref(db, `chats/${currentChatId}/messages`), {
      from: myKey(), fromName: `${nm} ${label}`.trim(), text, time: Date.now(), read: false
    });
    input.value = ''; input.style.height = 'auto';
  }catch(e){
    alert(/permission|denied/i.test(e.message||'')
      ? 'Ви не учасник цієї переписки.' : 'Не вдалося надіслати: ' + e.message);
  }
};

// ── НОВА ПЕРЕПИСКА / ДОДАТИ УЧАСНИКА ──
window.openChatPicker = async function(mode){
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
    const s = picked.find(p => cands.find(c=>c.key===p.key && c.tag !== 'Батьки' && !String(c.tag||'').startsWith('Батьки')));
    staffKey = s ? s.key : null;
  }
  if(!staffKey) return alert('У розмові має бути хтось зі школи — учитель або адміністрація.');

  // Для розмови двох ключ детермінований, щоб не плодити дублікати.
  // Для групи — новий ключ: додавання людини завжди створює окрему розмову.
  const id = members.length === 2
    ? [...members].sort().join('___')
    : (push(ref(db,'chats')).key);

  const myName = [currentUserData?.firstName, currentUserData?.lastName].filter(Boolean).join(' ')
                 || currentUserData?.email || '';
  try{
    const existing = await get(child(ref(db), `chats/${id}`));
    if(!existing.exists()){
      const mem = {}; members.forEach(k=>mem[k]=true);
      await set(ref(db, `chats/${id}`), {
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
    alert('Не вдалося створити розмову: ' + e.message);
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
