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
import { db, auth, currentUserData, showToast, escHtml, escJs, isTeacherRole, getUsersSnap, logAction, notifyEvent, initials, avatarColor, chatTime, chatDayLabel, getParentLinks, emailKey } from './common.js';

const safe  = e => emailKey(e||'');
const unsafe = se => String(se||'').replace(/_/g,'.');
const myKey = () => safe(auth.currentUser?.email);

let listListener = null, msgListener = null, currentChatId = null, currentMembers = [];
let listGen = 0;

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
  teacher:'Вчитель', class_teacher:'Класний керівник',
  art_school_teacher:'Вчитель мистецтв', music_teacher:'Вчитель музики',
  psychologist:'Психолог', nurse:'Медсестра', secretary:'Секретар'
};
const roleLabel = r => ROLE_LABEL[r] || (r ? String(r) : '');
const clsLabel  = c => c ? String(c).replace('class_','') + ' клас' : '';

// Підпис під імʼям співробітника.
//
// Батькові й учню показуємо ПРЕДМЕТ, який ця людина веде в їхньому класі.
// Перелік чужих класів («3, 5 кл.») родині нічого не дає: батько шукає
// «вчителя інформатики моєї дитини», а не того, хто ще де викладає.
// Персоналу навпаки лишаємо класи — їм важливо, з ким людина працює.
//
// classes[клас] може бути рядком предметів (новий формат) або true
// (старий запис, зроблений до цієї зміни) — обробляємо обидва.
// ctClasses — класи, де ця людина є класним керівником. Береться з вузла
// class_teachers, а не з поля role, і це принципово: роль у записі
// користувача оновлюється лише коли людина сама зайде в портал, тож
// щойно призначений керівник ще довго значився б просто вчителем.
// class_teachers натомість змінюється тієї ж миті, коли директор призначив.
export function staffSubtitle(rec, viewerRole, viewerClass, ctClasses){
  const ct = Array.isArray(ctClasses) ? ctClasses : [];
  const classes = rec.classes || {};
  const isFamily = viewerRole === 'parent' || viewerRole === 'student';
  if(isFamily){
    const v = viewerClass ? classes[viewerClass] : null;
    const subj = (typeof v === 'string' && v.trim()) ? v.trim() : '';
    // Для родини важливо саме «керівник МОГО класу», а не взагалі керівник
    const role = (viewerClass && ct.includes(viewerClass))
      ? ROLE_LABEL.class_teacher : roleLabel(rec.role);
    return [role, subj].filter(Boolean).join(' · ');
  }
  const role = ct.length ? ROLE_LABEL.class_teacher : roleLabel(rec.role);
  const list = Object.keys(classes).map(c => c.replace('class_','')).join(', ');
  return [role, list && list + ' кл.'].filter(Boolean).join(' · ');
}

// Аватарка співрозмовника. Фото є не в усіх, тому ініціали лишаються
// повноцінним варіантом, а не заглушкою «немає фото».
//
// Джерело — довідник (поле photo), а не вузол users: батькам users
// закритий, і саме тому в чаті колись світилися пошти замість імен.
// Ініціали лежать у самому кружку, а фото накривається зверху. Так не
// доводиться підставляти запасний варіант через onerror із рядком коду
// всередині атрибута — якщо картинка не завантажилась, вона просто
// прибирає себе, і під нею вже готові ініціали.
export function avatarHtml(name, photo, cls){
  const ok = photo && /^(data:image\/|https:\/\/)/.test(String(photo));
  return `<span class="${cls}" style="background:${avatarColor(name)};">${escHtml(initials(name))}`
    + (ok ? `<img src="${escHtml(photo)}" alt="" loading="lazy" onerror="this.remove()">` : '')
    + `</span>`;
}

let _dirCache = null, _dirAt = 0;
export function invalidateContactDir(){ _dirCache = null; }
window.invalidateContactDir = invalidateContactDir;

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
                   photo: (extra && extra.photo) || (prev && prev.photo) || '',
                   classes: (extra && extra.classes) || (prev && prev.classes) || [] });
  };

  // Хто де класний керівник. Вузол відкритий на читання всім, хто увійшов,
  // і оновлюється одразу при призначенні — тому підпис не чекає, поки
  // людина сама зайде в портал і її роль синхронізується.
  const ctBy = {};
  try{
    const ct = await get(child(ref(db),'class_teachers'));
    if(ct.exists()){
      const v = ct.val();
      for(const cls in v){
        const em = String((v[cls]||{}).teacherEmail || '').toLowerCase();
        if(em) (ctBy[safe(em)] ||= []).push(cls);
      }
    }
  }catch(e){ console.warn('class_teachers', e.message); }

  // Персонал бачать усі
  try{
    const sd = await get(child(ref(db),'staff_directory'));
    if(sd.exists()){
      const v = sd.val();
      for(const se in v){
        const r = v[se] || {};
        put(se, r.name, staffSubtitle(r, role, currentUserData?.class, ctBy[se]), 'staff',
            { role: r.role, photo: r.photo || '',
              classes: r.classes ? Object.keys(r.classes) : [] });
      }
    }
  }catch(e){ console.warn('staff_directory', e.message); }

  if(isAdmin){
    // Директор читає першоджерела — там дані свіжіші за довідник
    try{
      const [usersSnap, plVal] = await Promise.all([
        getUsersSnap(), getParentLinks()      // контакти батьків — з кешу
      ]);
      const users = usersSnap.exists() ? usersSnap.val() : {};
      for(const uid in users){
        const u = users[uid];
        if(!u || !u.email || u.disabled) continue;
        if(u.role === 'parent' || u.role === 'student') continue;
        // Фото беремо прямо з облікових записів. Директору вузол users
        // відкритий, тож йому не потрібно чекати, доки кожен співробітник
        // опублікує свою картку — він бачить аватарки одразу.
        // Батькам і вчителям users закритий, для них джерелом лишається
        // довідник, який оновлюється при вході та при правках директора.
        const ph = String(u.photoURL || '');
        put(safe(u.email), [u.firstName,u.lastName].filter(Boolean).join(' '), roleLabel(u.role), 'staff',
            { role: u.role, photo: (ph && !/flaticon/.test(ph)) ? ph : '' });
      }
      const pls = plVal || {};
      for(const se in pls){
        const p = pls[se] || {};
        const kids = p.children || [];
        const list = Array.isArray(kids) ? kids : Object.values(kids);
        const who = list.map(k => k && k.studentName ? k.studentName + (k.class ? ` (${clsLabel(k.class)})` : '') : '')
                        .filter(Boolean).join(', ');
        const prof = p.profile;
        put(se, (prof && [prof.lastName,prof.firstName].filter(Boolean).join(' ')) || '',
            who ? 'Батьки · ' + who : 'Батьки', 'parent',
            { classes: [...new Set(list.map(k => k && k.class).filter(Boolean))] });
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
          // Класи накопичуємо: батьки двох дітей є в списках обох класів
          const prevCls = (map.get(se) && map.get(se).classes) || [];
          put(se, p.name, 'Батьки · ' + [p.children, clsLabel(c)].filter(Boolean).join(', '), 'parent',
              { classes: [...new Set([...prevCls, c])] });
        }
      });
    }catch(e){ console.warn('directory/teacher', e.message); }
  }

  _dirCache = map; _dirAt = Date.now();
  return map;
}

// Група для фільтра у виборі співрозмовників
const TEACH_ROLES = ['teacher','class_teacher','art_school_teacher','music_teacher','master_class_teacher'];
const GROUP_LABEL = { parents:'Батьки', teachers:'Вчителі', admin:'Адміністрація', staff:'Інший персонал' };
function contactGroup(c){
  if(c.kind === 'parent') return 'parents';
  if(c.role === 'director' || c.role === 'administrator' || c.role === 'secretary') return 'admin';
  if(TEACH_ROLES.includes(c.role) || (c.classes || []).length) return 'teachers';
  return 'staff';
}

// Кого САМЕ цей користувач має право писати першим
export async function chatCandidates(){
  const role = currentUserData?.role || '';
  const isAdmin = role === 'director' || role === 'administrator';
  const dir = await contactDirectory();
  const mine = myKey();
  const asItem = c => ({ key:c.key, email:unsafe(c.key), name:c.name, kind:c.kind,
                         photo:c.photo || '', group:contactGroup(c),
                         classes:(c.classes || []).slice(),
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

  // Лічильник поколінь: між зняттям старої підписки й новою читається
  // довідник контактів. Якщо вікно переписок встигли закрити й відкрити
  // ще раз, обидва виклики знімуть ту саму стару підписку, а потім
  // другий затре посилання на першу — і зняти її буде вже нічим.
  const gen = ++listGen;
  if(listListener){ listListener(); listListener = null; }
  const dir = await contactDirectory().catch(()=>new Map());
  if(gen !== listGen) return;
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
      // Непрочитані — чужі повідомлення, новіші за мою позначку readBy.
      // !m.read лишається для старих повідомлень, прочитаних до появи
      // readBy: у них стоїть read:true, і рахувати їх заново не можна.
      const seenAt = Number((c.readBy || {})[myKey()]) || 0;
      const unread = msgs.filter(m=>m.from !== myKey() && !m.system && !m.read && (m.time||0) > seenAt).length;
      rows.push({ id, title: chatTitle(c, dir), sub: chatSubtitle(c, dir),
                  photo: chatPhoto(c, dir),
                  members:Object.keys(c.members||{}).length,
                  last, unread, time: last ? last.time : (c.createdAt||0) });
    });
    rows.sort((a,b)=>b.time-a.time);
    box.innerHTML = rows.map(r=>`
      <div class="ch-row" role="button" tabindex="0" onclick="selectChatThread('${escJs(r.id)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click()}">
        ${avatarHtml(r.title, r.photo, 'ch-av')}
        <div class="ch-mid">
          <div class="ch-top"><span class="ch-name">${escHtml(r.title)}</span>
            ${r.time ? `<span class="ch-time">${chatTime(r.time)}</span>` : ''}</div>
          ${r.sub ? `<div class="ch-sub">${escHtml(r.sub)}</div>` : ''}
          <div class="ch-prev">${
            r.last ? lastPreview(r) : 'Повідомлень ще немає'}</div>
        </div>
        ${r.unread ? `<span class="ch-badge">${r.unread}</span>` : ''}
      </div>`).join('') || '<div class="ch-empty">💬<span>Тут зʼявляться ваші переписки</span></div>';
  }, err => {
    // Мовчазна відмова — найгірший варіант: людина дивиться на спінер
    // і не знає, що робити. Кажемо прямо.
    box.innerHTML = `<div class="ch-empty">⚠️<span>Не вдалося завантажити список: ${escHtml(err.message||'немає доступу')}</span></div>`;
  });
};

// Рядок-прев'ю в списку, як у Telegram: «Ви: …» для свого, імʼя автора —
// лише в групі; у розмові вдвох просто текст.
function lastPreview(r){
  const m = r.last;
  if(m.system) return `<i>${escHtml(m.text)}</i>`;
  const who = m.from === myKey() ? 'Ви'
    : (r.members > 2 ? String(m.fromName || '').split(' ')[0] : '');
  return (who ? `<b>${escHtml(who)}:</b> ` : '') + escHtml(m.text);
}
function chatTitle(c, dir){
  if(c.title) return c.title;
  const others = Object.keys(c.members||{}).filter(k=>k!==myKey());
  if(!others.length) return 'Переписка';
  return others.map(k => (dir && dir.get(k) && dir.get(k).name) || unsafe(k)).join(', ');
}
// Другий рядок підпису: посада або клас дитини
// Фото показуємо лише в розмові вдвох: у груповій незрозуміло, чиє саме
// обличчя ставити, тому там лишаються ініціали за назвою розмови.
function chatPhoto(c, dir){
  const others = Object.keys(c.members||{}).filter(k=>k!==myKey());
  if(others.length !== 1 || !dir) return '';
  const r = dir.get(others[0]);
  return (r && r.photo) || '';
}

function chatSubtitle(c, dir){
  const others = Object.keys(c.members||{}).filter(k=>k!==myKey());
  if(others.length !== 1 || !dir) return '';
  const r = dir.get(others[0]);
  return r && r.sub ? r.sub : '';
}

// ── ОДНА ПЕРЕПИСКА ──
let threadGen = 0;
window.selectChatThread = async function(chatId){
  // Швидко натиснули одну розмову, потім іншу: відповіді бази можуть
  // прийти в іншому порядку, і учасники першої розмови лягли б у другу.
  const gen = ++threadGen;
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
    if(gen !== threadGen) return;
    document.getElementById('inbox-messages-list').innerHTML =
      `<div class="ch-empty">⚠️<span>Немає доступу до цієї розмови</span></div>`;
    return;
  }
  if(gen !== threadGen) return;
  currentMembers = Object.keys(c.members || {});
  currentChat = c;
  const dir = await contactDirectory().catch(()=>new Map());
  if(gen !== threadGen) return;
  document.getElementById('chat-detail-title').innerText = chatTitle(c, dir);
  const hav = document.getElementById('chat-detail-av');
  if(hav) hav.innerHTML = avatarHtml(chatTitle(c, dir), chatPhoto(c, dir), 'chat-head-av');
  const rn = document.getElementById('chat-rename');
  if(rn) rn.style.display = canRenameChat(c) ? 'inline-flex' : 'none';
  const sub = document.getElementById('chat-detail-sub');
  if(sub){
    // Для групи — скільки учасників, для розмови двох — посада або клас
    const t = currentMembers.length > 2
      ? `${currentMembers.length} учасники`
      : chatSubtitle(c, dir);
    sub.textContent = t;
    sub.style.display = t ? 'block' : 'none';
  }
  reactDir = dir;
  loadChatMessages(chatId);
};

// ── ПОВІДОМЛЕННЯ І ПОЗНАЧКИ ПРОЧИТАННЯ ──
//
// chats/{id}/readBy/{пошта} = час останнього прочитаного повідомлення.
//
// Раніше «прочитано» було прапорцем read в кожному повідомленні. Для
// розмови вдвох це працює, а в групі перший, хто відкрив, ставив read
// за всіх. Тепер у кожного учасника своя позначка: ✓ — надіслано,
// ✓✓ — прочитали всі; у групі під моїм повідомленням видно, скільки
// учасників уже прочитали, а натискання показує, хто саме.
// Запис один на відкриття, а не по одному на кожне повідомлення.
let msgState = { msgs: [], readBy: {} }, readByListener = null, currentChat = null;
function readersOf(m){
  const others = currentMembers.filter(k => k !== myKey());
  return others.filter(k => (Number(msgState.readBy[k]) || 0) >= (m.time || 0)
                            // старі повідомлення розмови вдвох: прочитано за прапорцем
                            || (others.length === 1 && m.read === true));
}
function renderMessages(){
  const list = document.getElementById('inbox-messages-list');
  if(!list) return;
  const me = myKey();
  const msgs = msgState.msgs;
  if(!msgs.length){
    list.innerHTML = '<div class="ch-empty">✉️<span>Повідомлень ще немає — напишіть перше</span></div>';
    return;
  }
  const others = currentMembers.filter(k => k !== me);
  let prevFrom = null, prevDay = null, html = '';
  msgs.forEach((m,i)=>{
    const day = new Date(m.time).toDateString();
    if(day !== prevDay){
      html += `<div class="ms-day"><span>${escHtml(chatDayLabel(m.time))}</span></div>`;
      prevDay = day; prevFrom = null;
    }
    if(m.system){
      html += `<div class="ms-sys"><span>${escHtml(m.text)}</span></div>`;
      prevFrom = null;
      return;
    }
    const isMe = m.from === me;
    const grouped = m.from === prevFrom;
    const next = msgs[i+1];
    const last = !next || next.system || next.from !== m.from || new Date(next.time).toDateString() !== day;
    let tick = '';
    // Як у Telegram: позначка й час — у кожному моєму повідомленні
    if(isMe && others.length){
      const rd = readersOf(m);
      const all = rd.length === others.length;
      const label = all ? 'Прочитано' : (rd.length ? `Прочитали ${rd.length} з ${others.length}` : 'Надіслано, ще не прочитано');
      const extra = (others.length > 1 && rd.length && !all) ? ` ${rd.length}/${others.length}` : '';
      tick = `<button type="button" class="ms-tick${all ? ' read' : ''}" title="${escHtml(label)}" aria-label="${escHtml(label)}"`
           + (others.length > 1 ? ` onclick="showChatReaders('${escJs(m.id)}')"` : '')
           + `>${all || rd.length ? '✓✓' : '✓'}${extra}</button>`;
    }
    // Імʼя автора — лише в групі (у розмові вдвох і так ясно, хто пише),
    // кольором, закріпленим за людиною, як у Telegram.
    const showName = !grouped && !isMe && others.length > 1;
    const big = isEmojiOnly(m.text);
    const time = new Date(m.time).toLocaleTimeString('uk-UA',{hour:'2-digit',minute:'2-digit'});
    html += `<div class="ms ${isMe?'me':'they'}${grouped?' grp':''}${last?' last':''}${big?' big':''}" data-mid="${escHtml(m.id)}">
      ${showName ? `<div class="ms-from" style="color:${senderColor(m.from)}">${escHtml(m.fromName||'')}</div>` : ''}
      <div class="ms-text">${escHtml(m.text)}<span class="ms-meta"><span class="ms-t">${time}</span>${tick}</span></div>
      ${reactionsHtml(m)}
      <button type="button" class="ms-react-btn" data-react-open="${escHtml(m.id)}" aria-label="Реакція" title="Реакція">☺</button>
    </div>`;
    prevFrom = m.from;
  });
  // Прокручуємо донизу лише коли прийшло нове повідомлення або людина й
  // так була внизу. Інакше реакція на старе повідомлення (вона теж міняє
  // вузол messages) кидала б сторінку в кінець розмови.
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  const grew = msgs.length !== lastRenderedCount || currentChatId !== lastRenderedChat;
  const keep = list.scrollTop;
  list.innerHTML = html;
  list.scrollTop = (grew || nearBottom) ? list.scrollHeight : keep;
  lastRenderedCount = msgs.length; lastRenderedChat = currentChatId;
}
let lastRenderedCount = -1, lastRenderedChat = null;

// ── РЕАКЦІЇ, ЯК У TELEGRAM ─────────────────────────────────────────
//
// chats/{id}/messages/{msg}/reactions/{пошта} = '👍'
// Одна реакція від людини на повідомлення: інша замінює попередню, та сама
// знімає. Правила бази дозволяють кожному писати лише СВОЮ реакцію.
//
// Як поставити: подвійний клік / подвійний дотик — 👍; права кнопка миші,
// довге натискання або кнопка ☺ біля повідомлення — панель реакцій.
// Натискання на наявну реакцію під повідомленням — поставити/зняти таку ж.
//
// Набір — лише доброзичливі, без 👎 і без «поганих» емодзі.
export const REACTIONS = ['👍','❤️','😂','😮','😢','🙏','👏','🎉','🤔','👌'];
const QUICK_REACTION = '👍';
function reactionsHtml(m){
  if(m.system) return '';
  const r = m.reactions || {};
  const by = {};
  for(const [who, e] of Object.entries(r)) if(REACTIONS.includes(e)) (by[e] ||= []).push(who);
  const list = REACTIONS.filter(e => by[e]);
  if(!list.length) return '';
  const me = myKey();
  return `<div class="ms-reacts">${list.map(e => {
    const mine = by[e].includes(me);
    return `<button type="button" class="ms-react${mine ? ' mine' : ''}" data-react-msg="${escHtml(m.id)}"
      data-react-emoji="${escHtml(e)}" title="${escHtml(reactorNames(by[e]))}"
      aria-label="${escHtml(e + ' ' + by[e].length + (mine ? ', ваша реакція' : ''))}">${e}<span>${by[e].length}</span></button>`;
  }).join('')}</div>`;
}
let reactDir = new Map();
// Як мене підписати для інших учасників. ПОШТУ НЕ ПІДСТАВЛЯЄМО: у групі
// класу її побачили б інші батьки. Без імені в профілі — «Батьки <дитина>»
// або просто «Учасник».
function myDisplayName(){
  const u = currentUserData || {};
  const nm = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  if(nm) return nm;
  if(u.role === 'parent' && u.studentName) return `Батьки: ${u.studentName}`;
  if(u.role === 'student' && u.studentName) return u.studentName;
  return 'Учасник';
}
function hasOwnName(){ const u = currentUserData || {}; return !!(u.firstName || u.lastName); }
// Імʼя учасника для підказок (хто прочитав, хто поставив реакцію).
//
// ПОШТУ НЕ ПОКАЗУЄМО НІКОЛИ. Батькам довідник дає лише персонал, тож для
// інших батьків у групі класу запасним варіантом було unsafe(ключ) — тобто
// їхня пошта. Тепер: довідник → імʼя з підпису їхніх повідомлень → «Учасник».
function memberName(k, dir){
  if(k === myKey()) return 'Ви';
  const d = dir && dir.get(k);
  if(d && d.name && d.name !== unsafe(k)) return d.name;
  const m = [...msgState.msgs].reverse().find(x => x.from === k && x.fromName);
  if(m) return String(m.fromName).replace(/\s*\([^)]*\)\s*$/, '').trim() || 'Учасник';
  return 'Учасник';
}
function reactorNames(keys){
  return keys.map(k => memberName(k, reactDir)).join(', ');
}
async function setReaction(msgId, emoji){
  if(!currentChatId || !msgId || !REACTIONS.includes(emoji)) return;
  const m = msgState.msgs.find(x => x.id === msgId);
  if(!m || m.system) return;
  const me = myKey();
  const cur = (m.reactions || {})[me];
  const next = cur === emoji ? null : emoji;       // та сама — знімаємо
  // Одразу на екрані, не чекаючи бази
  m.reactions = { ...(m.reactions || {}) };
  if(next) m.reactions[me] = next; else delete m.reactions[me];
  renderMessages();
  try{
    await update(ref(db, `chats/${currentChatId}/messages/${msgId}/reactions`), { [me]: next });
  }catch(e){
    showToast('Не вдалося поставити реакцію');
  }
}
window.setChatReaction = setReaction;

// Панель вибору реакції над повідомленням
let reactBarOpenedAt = 0;
async function copyMessage(msgId){
  const m = msgState.msgs.find(x => x.id === msgId);
  if(!m) return;
  const text = String(m.text || '');
  try{ await navigator.clipboard.writeText(text); showToast('Скопійовано'); return; }catch(e){}
  try{
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    showToast('Скопійовано');
  }catch(e){ showToast('Не вдалося скопіювати'); }
}
function closeReactBar(){
  const bar = document.querySelector('.react-bar');
  if(bar) bar.remove();
}
function openReactBar(msgId, anchor){
  closeReactBar();
  const m = msgState.msgs.find(x => x.id === msgId);
  if(!m || m.system || !anchor) return;
  const pane = document.getElementById('chat-detail-view');
  if(!pane) return;
  const mine = (m.reactions || {})[myKey()];
  const bar = document.createElement('div');
  bar.className = 'react-bar';
  bar.setAttribute('role', 'menu');
  // «Копіювати» — бо довге натискання тепер відкриває цю панель, а не
  // системне меню телефона: без кнопки текст повідомлення не скопіювати.
  bar.innerHTML = REACTIONS.map(e =>
    `<button type="button" role="menuitem" class="react-opt${e === mine ? ' on' : ''}" data-react-pick="${escHtml(e)}"
             data-react-msg="${escHtml(msgId)}" aria-label="${escHtml(e)}">${e}</button>`).join('')
    + `<button type="button" role="menuitem" class="react-copy" data-react-copy="${escHtml(msgId)}"
               aria-label="Копіювати текст" title="Копіювати текст">⧉</button>`;
  reactBarOpenedAt = Date.now();
  pane.appendChild(bar);
  // Над повідомленням; якщо зверху тісно — під ним
  const pr = pane.getBoundingClientRect(), ar = anchor.getBoundingClientRect();
  const bw = bar.offsetWidth || 300, bh = bar.offsetHeight || 44;
  let top = ar.top - pr.top - bh - 6;
  if(top < 56) top = ar.bottom - pr.top + 6;
  const isMe = anchor.classList.contains('me');
  let left = isMe ? (ar.right - pr.left - bw) : (ar.left - pr.left);
  left = Math.max(6, Math.min(left, pr.width - bw - 6));
  bar.style.top = top + 'px';
  bar.style.left = left + 'px';
  bar.querySelector('.react-opt')?.focus?.();
}
window.openChatReactBar = openReactBar;

// Делегування: розмітка повідомлень перебудовується, тож слухачі — на списку
(function bindReactions(){
  let pressTimer = null, pressMoved = false, lastTap = { id: null, t: 0 }, touchReactAt = 0;
  const msgOf = el => el && el.closest ? el.closest('#inbox-messages-list .ms[data-mid]') : null;
  document.addEventListener('click', e => {
    const t = e.target;
    if(!t || !t.closest) return;
    const pick = t.closest('[data-react-pick]');
    if(pick){ setReaction(pick.dataset.reactMsg, pick.dataset.reactPick); closeReactBar(); return; }
    const copy = t.closest('[data-react-copy]');
    if(copy){ copyMessage(copy.dataset.reactCopy); closeReactBar(); return; }
    // Після довгого натискання частина браузерів ще й «клацає» по
    // повідомленню — панель не має закриватися від цього ж дотику.
    if(Date.now() - reactBarOpenedAt < 700 && msgOf(t)) return;
    const chipBtn = t.closest('#inbox-messages-list [data-react-emoji]');
    if(chipBtn){ setReaction(chipBtn.dataset.reactMsg, chipBtn.dataset.reactEmoji); return; }
    const open = t.closest('#inbox-messages-list [data-react-open]');
    if(open){ openReactBar(open.dataset.reactOpen, msgOf(open)); e.stopPropagation(); return; }
    if(!t.closest('.react-bar')) closeReactBar();
  });
  document.addEventListener('dblclick', e => {
    const ms = msgOf(e.target);
    if(!ms || (e.target.closest && e.target.closest('button'))) return;
    // Деякі телефони після подвійного дотику ще й шлють dblclick — без цієї
    // перевірки 👍 ставилася б і одразу знімалася.
    if(Date.now() - touchReactAt < 800) return;
    e.preventDefault();
    try{ window.getSelection()?.removeAllRanges(); }catch(err){}
    setReaction(ms.dataset.mid, QUICK_REACTION);
  });
  document.addEventListener('contextmenu', e => {
    const ms = msgOf(e.target);
    if(!ms) return;
    e.preventDefault();
    openReactBar(ms.dataset.mid, ms);
  });
  // Телефон: довге натискання — панель, подвійний дотик — 👍
  document.addEventListener('touchstart', e => {
    const ms = msgOf(e.target);
    if(!ms || (e.target.closest && e.target.closest('button'))) return;
    pressMoved = false;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => { if(!pressMoved) openReactBar(ms.dataset.mid, ms); }, 450);
    const now = Date.now();
    if(lastTap.id === ms.dataset.mid && now - lastTap.t < 300){
      clearTimeout(pressTimer);
      touchReactAt = now;
      setReaction(ms.dataset.mid, QUICK_REACTION);
      lastTap = { id: null, t: 0 };
    } else lastTap = { id: ms.dataset.mid, t: now };
  }, { passive: true });
  document.addEventListener('touchmove', () => { pressMoved = true; clearTimeout(pressTimer); }, { passive: true });
  document.addEventListener('touchend', () => clearTimeout(pressTimer), { passive: true });
  document.addEventListener('keydown', e => { if(e.key === 'Escape') closeReactBar(); });
  document.addEventListener('scroll', e => {
    if(e.target && e.target.id === 'inbox-messages-list') closeReactBar();
  }, true);
})();
// Хто прочитав (для групи): імена тих, хто прочитав, і тих, хто ще ні.
window.showChatReaders = async function(msgId){
  const m = msgState.msgs.find(x => x.id === msgId);
  if(!m) return;
  const dir = await contactDirectory().catch(()=>new Map());
  const nm = k => memberName(k, dir);
  const rd = readersOf(m);
  const not = currentMembers.filter(k => k !== myKey() && !rd.includes(k));
  alert((rd.length ? 'Прочитали:\n' + rd.map(nm).join('\n') : 'Ще ніхто не прочитав.')
      + (not.length ? '\n\nЩе не прочитали:\n' + not.map(nm).join('\n') : ''));
};
// ПРОЧИТАНО — ЛИШЕ КОЛИ РОЗМОВУ СПРАВДІ ВИДНО. Інакше повідомлення, що
// прийшло, поки вкладка згорнута чи вікно чату закрите поверх сторінки,
// одразу ставало «✓✓» у відправника, хоча ніхто його не бачив.
function threadVisible(chatId){
  if(currentChatId !== chatId) return false;
  if(typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
  const modal = document.getElementById('inbox-modal');
  const pane = document.getElementById('chat-detail-view');
  return !!(modal && modal.style.display !== 'none' && pane && pane.style.display !== 'none');
}
document.addEventListener('visibilitychange', () => {
  if(currentChatId && threadVisible(currentChatId)) markThreadRead(currentChatId);
});
function markThreadRead(chatId){
  if(!threadVisible(chatId)) return;
  const me = myKey();
  const latest = msgState.msgs.filter(m => m.from !== me).reduce((t, m) => Math.max(t, m.time || 0), 0);
  if(latest && latest > (Number(msgState.readBy[me]) || 0)){
    msgState.readBy[me] = latest;
    update(ref(db, `chats/${chatId}/readBy`), { [me]: latest }).catch(()=>{});
  }
}
function loadChatMessages(chatId){
  const list = document.getElementById('inbox-messages-list');
  if(msgListener) msgListener();
  if(readByListener) readByListener();
  msgState = { msgs: [], readBy: {} };
  readByListener = onValue(ref(db, `chats/${chatId}/readBy`), snap => {
    msgState.readBy = snap.exists() ? (snap.val() || {}) : {};
    renderMessages();
  }, () => {});
  msgListener = onValue(ref(db, `chats/${chatId}/messages`), snap => {
    const v = snap.exists() ? (snap.val() || {}) : {};
    msgState.msgs = Object.keys(v).map(k=>({id:k, ...v[k]})).sort((a,b)=>a.time-b.time);
    renderMessages();
    // Позначку ставимо, лише коли вікно розмови справді на екрані
    markThreadRead(chatId);
  }, err => {
    list.innerHTML = `<div class="ch-empty">⚠️<span>Не вдалося відкрити переписку: ${escHtml(err.message||'немає доступу')}</span></div>`;
  });
}

// ── ЕМОДЗІ ──────────────────────────────────────────────────────────
//
// Панель як у Telegram, але набір добраний під школу: обличчя, жести,
// серця, навчання, свята, природа, їжа, спорт. Немає зброї, алкоголю,
// цигарок, ліків, черепів, лайливих і двозначних символів.
//
// Ті самі «погані» емодзі можна набрати з клавіатури телефона — їх
// прибирає stripBadEmoji перед надсиланням. Це перевірка в браузері, а
// не в правилах бази: мова правил не вміє розбирати емодзі.
export const EMOJI_SETS = [
  ['😊', 'Смайлики', '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 🤗 🤩 🥳 😎 🤓 🧐 🤔 🤨 😐 😶 🙄 😬 😮 😯 😲 😳 🥺 😢 😭 😥 😓 😔 😕 🙁 ☹️ 😣 😖 😫 😩 🥱 😴 😪 🤧 🤒 😷 🤕 😟 😬 🫡 🤭 🤫 😺 😸 😻'],
  ['👍', 'Жести', '👍 👎 👌 ✌️ 🤞 🤝 👏 🙌 👐 🙏 👋 🤚 ✋ 🖐️ 👆 👇 👈 👉 ☝️ ✊ 👊 💪 🫶 ✍️ 👀 🧠'],
  ['❤️', 'Серця', '❤️ 🧡 💛 💚 💙 💜 🤍 🤎 💖 💗 💓 💞 💕 💝 ❣️ 💯 ✨ ⭐ 🌟 💫 ✅ ☑️ ❗ ❓ ‼️ ⁉️ 🔔 📌 📍'],
  ['📚', 'Школа', '📚 📖 📘 📗 📕 📙 📓 📔 📒 📝 ✏️ 🖊️ 🖍️ 📏 📐 ✂️ 📎 🎒 🏫 🧮 🔬 🔭 🧪 🌍 🗺️ 💻 🖥️ 📱 ⏰ 🕐 📅 📆 🗓️ 🎓 🏅 🥇 🥈 🥉 🏆 🎨 🎭 🎵 🎶 🎹 🎸 🎻 🥁 🎤'],
  ['🎉', 'Свята', '🎉 🎊 🎈 🎂 🍰 🧁 🎁 🎀 🎄 🎃 🪅 🕯️ 🌸 💐 🌷 🌹 🌻 🌼'],
  ['🌞', 'Природа', '🌞 🌝 🌈 ☀️ 🌤️ ⛅ 🌥️ 🌦️ 🌧️ ⛈️ 🌩️ ❄️ ☃️ ⛄ 🌬️ 💧 🌊 🍀 🌱 🌿 🍃 🍂 🍁 🌳 🌲 🌵 🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🐤 🦋 🐞 🐢 🐬 🐳 🦄'],
  ['🍎', 'Їжа', '🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍒 🥝 🍅 🥕 🌽 🥒 🥦 🥔 🍞 🥐 🥨 🧀 🥚 🥞 🧇 🍕 🍝 🍜 🍲 🥗 🥪 🌮 🍿 🍪 🍩 🍫 🍬 🍭 🍦 🥛 🧃 🍵 ☕'],
  ['⚽', 'Спорт', '⚽ 🏀 🏈 ⚾ 🎾 🏐 🏓 🏸 🥅 ⛸️ 🎿 🛷 🏊 🚴 🤸 🧘 🏃 🚶 🎯 🧩 🪁 🚌 🚗 🚲 🛴 ✈️ 🚀 🏠 🏡']
].map(([icon, name, list]) => ({ icon, name, list: [...new Set(list.split(' ').filter(Boolean))] }));

// Недоречне в шкільному листуванні. Разом із відтінками шкіри й варіаціями.
const BAD_EMOJI = ['🖕','🍆','🍑','💦','👅','💋','🔫','🔪','🗡','⚔','💣','🧨','🩸','💀','☠','👿','😈','🤬','💩','🚬','🍺','🍻','🍷','🍸','🍹','🥃','🥂','🍾','🍶','💊','💉','⚰','🪦','🎰','🤮','👙','🩲','🔞','💸','🤑','😘','😗','😚','😙','🥵','🤤','😏','🫦'];
const BAD_RE = new RegExp('(?:' + BAD_EMOJI.map(e => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')[\u{1F3FB}-\u{1F3FF}\uFE0F\u200D]*', 'gu');
// Прибираємо емодзі разом з ОДНИМ пробілом перед ним — щоб не лишалося
// «ок  ок». Решту тексту не чіпаємо: раніше тут стискалися всі подвійні
// пробіли, і повідомлення з двома пробілами підряд (скопійована таблиця,
// відступ) не надсилалося з підказкою про «недоступні емодзі».
const BAD_RE_SP = new RegExp('[ \\t]?' + BAD_RE.source, 'gu');
export function stripBadEmoji(text){
  return String(text || '').replace(BAD_RE_SP, '');
}
export function hasBadEmoji(text){
  return new RegExp(BAD_RE.source, 'u').test(String(text || ''));
}
// Повідомлення лише з 1–3 емодзі показуємо великими, без «бульбашки»
const EMOJI_ONLY_RE = /^(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*\s*){1,3}$/u;
export function isEmojiOnly(text){ return EMOJI_ONLY_RE.test(String(text || '').trim()); }

// Колір імені автора в групі — сталий для людини, як у Telegram
// Самі кольори — токени --tg-name-1…7 у cabinet.html (там і перевірка контрасту)
const SENDER_COLORS = [1,2,3,4,5,6,7].map(i => `var(--tg-name-${i})`);
function senderColor(key){
  let h = 0; const s = String(key || '');
  for(let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return SENDER_COLORS[h % SENDER_COLORS.length];
}

const RECENT_KEY = 'push_school_emoji_recent';
function recentEmoji(){ try{ return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter(e => typeof e === 'string' && e && stripBadEmoji(e) === e).slice(0, 24); }catch(e){ return []; } }
function rememberEmoji(e){
  try{ const r = [e, ...recentEmoji().filter(x => x !== e)].slice(0, 24); localStorage.setItem(RECENT_KEY, JSON.stringify(r)); }catch(err){}
}
let emojiTab = 0;
function renderEmojiPanel(){
  const box = document.getElementById('chat-emoji-panel');
  if(!box) return;
  const recent = recentEmoji();
  const tabs = (recent.length ? [{ icon:'🕘', name:'Нещодавні', list: recent }] : []).concat(EMOJI_SETS);
  if(emojiTab >= tabs.length) emojiTab = 0;
  box.innerHTML = `<div class="em-tabs" role="tablist">${tabs.map((t, i) =>
      `<button type="button" role="tab" class="em-tab${i === emojiTab ? ' on' : ''}" title="${escHtml(t.name)}"
               aria-label="${escHtml(t.name)}" aria-selected="${i === emojiTab}" onclick="setEmojiTab(${i})">${t.icon}</button>`).join('')}</div>
    <div class="em-name">${escHtml(tabs[emojiTab].name)}</div>
    <div class="em-grid">${tabs[emojiTab].list.map(e =>
      `<button type="button" class="em-btn" onclick="insertEmoji('${escJs(e)}')" aria-label="${escHtml(e)}">${e}</button>`).join('')}</div>`;
}
window.setEmojiTab = function(i){ emojiTab = i; renderEmojiPanel(); };
window.toggleEmojiPanel = function(){
  const box = document.getElementById('chat-emoji-panel');
  if(!box) return;
  const open = box.style.display === 'none' || !box.style.display;
  if(open){ renderEmojiPanel(); box.style.display = 'block'; }
  else box.style.display = 'none';
  document.getElementById('chat-emoji-btn')?.classList.toggle('on', open);
};
function closeEmojiPanel(){
  const box = document.getElementById('chat-emoji-panel');
  if(box) box.style.display = 'none';
  document.getElementById('chat-emoji-btn')?.classList.remove('on');
}
window.insertEmoji = function(e){
  const ta = document.getElementById('msg-text-input');
  if(!ta) return;
  const a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, a) + e + ta.value.slice(b);
  const pos = a + e.length;
  try{ ta.setSelectionRange(pos, pos); }catch(err){}
  ta.dispatchEvent(new Event('input'));
  rememberEmoji(e);
  // На телефоні не піднімаємо клавіатуру після кожного емодзі — вона
  // закрила б панель. На компʼютері повертаємо курсор у поле.
  if(!window.matchMedia || !window.matchMedia('(pointer: coarse)').matches) ta.focus();
};
document.addEventListener('click', e => {
  const box = document.getElementById('chat-emoji-panel');
  if(!box || box.style.display === 'none') return;
  if(e.target.closest && (e.target.closest('#chat-emoji-panel') || e.target.closest('#chat-emoji-btn'))) return;
  closeEmojiPanel();
});

// ── НАЗВА ГРУПИ ──
// Перейменувати групу може співробітник або той, хто її створив. Батькам
// у чужій групі змінювати назву не даємо: група вчителя з батьками класу
// не повинна раптом стати «Батьківський чат 3-Б».
function isFamilyRole(){ const r = currentUserData?.role; return r === 'parent' || r === 'student'; }
function canRenameChat(c){
  if(!c || Object.keys(c.members || {}).length <= 2) return false;
  return !isFamilyRole() || c.createdBy === myKey();
}
const GROUP_NAME_MAX = 60;
window.renameCurrentChat = async function(){
  if(!currentChatId || !canRenameChat(currentChat)) return;
  const now = currentChat.title || '';
  const raw = prompt('Назва групи:', now);
  if(raw === null) return;
  const title = stripBadEmoji(raw).replace(/\s+/g, ' ').trim().slice(0, GROUP_NAME_MAX);
  if(!title || title === now) return;
  const nm = myDisplayName();
  try{
    await update(ref(db, `chats/${currentChatId}`), { title, titleBy: myKey(), titleAt: Date.now() });
    // Службовий рядок у самій розмові — щоб усі бачили, хто і як перейменував
    await push(ref(db, `chats/${currentChatId}/messages`), {
      from: myKey(), system: true, time: Date.now(), read: false,
      text: `${nm} змінює назву групи на «${title}»`
    });
    currentChat.title = title;
    document.getElementById('chat-detail-title').innerText = title;
    logAction('chat', { value: `назва групи: ${title}` });
  }catch(e){
    alert('Не вдалося перейменувати: ' + (e.message || 'немає прав'));
  }
};

window.backToChatList = function(){
  closeEmojiPanel();
  closeReactBar();
  if(msgListener) msgListener();
  const d = document.getElementById('chat-detail-view');
  const l = document.getElementById('chat-list-view');
  if(d) d.style.display = 'none';
  if(l) l.style.display = 'flex';
  if(readByListener){ try{ readByListener(); }catch(e){} readByListener = null; }
  currentChatId = null; currentMembers = []; currentChat = null;
};
window.closeInboxModal = function(){
  document.getElementById('inbox-modal').style.display = 'none';
  stopChatListeners();
};
// Знімає підписки вікна переписок. Викликається і при закритті вікна, і
// при виході з акаунта: сторінка після виходу не перезавантажується, а
// телефон у сім'ї часто спільний — чужі переписки не мають лишатися
// підписаними під наступним користувачем.
export function stopChatListeners(){
  listGen++;                       // скасовуємо виклик, що зараз у польоті
  if(msgListener){ try{ msgListener(); }catch(e){} msgListener = null; }
  if(readByListener){ try{ readByListener(); }catch(e){} readByListener = null; }
  if(listListener){ try{ listListener(); }catch(e){} listListener = null; }
}
window.stopChatListeners = stopChatListeners;

window.sendInboxMessage = async function(){
  if(!currentChatId) return;
  const input = document.getElementById('msg-text-input');
  const text = input.value.trim();
  if(!text) return;
  // Недоречні для шкільного чату емодзі з клавіатури телефона: прибираємо
  // з поля й просимо перевірити текст, а не надсилаємо «мовчки обрізаним».
  if(hasBadEmoji(text)){
    input.value = stripBadEmoji(text);
    input.dispatchEvent(new Event('input'));
    showToast('Деякі емодзі в шкільному чаті недоступні — ми їх прибрали. Перевірте текст і надішліть ще раз.');
    return;
  }
  closeEmojiPanel();
  const role = currentUserData?.role;
  const label = role==='director' ? '(Директор)' : role==='administrator' ? '(Секретар)'
              : isTeacherRole(role) ? '(Вчитель)' : role==='parent' ? '(Батьки)'
              : role==='student' ? '(Учень)' : '';
  const nm = myDisplayName();
  try{
    const ts = Date.now();
    await push(ref(db, `chats/${currentChatId}/messages`), {
      // Роль у дужках — лише до справжнього імені: «Батьки: Анна (Батьки)» зайве
      from: myKey(), fromName: (hasOwnName() ? `${nm} ${label}` : nm).trim(), text, time: ts, read: false
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
    //
    // Шлемо КЛЮЧІ пошт, а не спробу відновити з них адресу. `unsafe`
    // міняє назад усі підкреслення на крапки, і для пошти, де
    // підкреслення було з самого початку (ivan_petrov@…), виходила чужа
    // адреса — сповіщення тихо не доходило нікому. Сервер зводить до
    // ключа обидві сторони, тож ключ йому підходить.
    // Сервер бере не більше 30 адрес за раз (notify.js), а група класу з
    // батьками буває більшою — шлемо пачками, інакше частина не дізналась би.
    const others = currentMembers.filter(k => k !== myKey());
    for(let i = 0; i < others.length; i += 30)
      notifyEvent('chat', { to: others.slice(i, i + 30), subject: nm || 'Школа',
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
  const gn = document.getElementById('cp-group-name');
  if(gn){ gn.value = ''; gn.style.display = 'none'; }
  const filters = document.getElementById('cp-filters');
  if(filters) filters.innerHTML = '';
  try{
    const list = (await chatCandidates()).filter(c => !currentMembers.includes(c.key));
    if(!list.length){ box.innerHTML = '<p class="empty-msg">Немає доступних співрозмовників.</p>'; return; }
    list.sort((a,b)=>a.name.localeCompare(b.name,'uk'));
    box.innerHTML = list.map(c=>`
      <label class="cp-row" data-group="${escHtml(c.group)}" data-classes="${escHtml((c.classes||[]).join(' '))}"
             data-search="${escHtml((c.name + ' ' + (c.tag||'')).toLowerCase())}">
        <input type="checkbox" value="${escHtml(c.key)}" data-name="${escHtml(c.name)}">
        ${avatarHtml(c.name, c.photo, 'cp-av')}
        <span class="cp-mid"><b>${escHtml(c.name)}</b><small>${escHtml(c.tag||'')}</small></span>
      </label>`).join('');
    renderPickerFilters(list);
  }catch(e){
    box.innerHTML = `<p class="empty-msg" style="color:var(--danger);">${escHtml(e.message)}</p>`;
  }
};
window.closeChatPicker = function(){ document.getElementById('chat-picker').style.display='none'; };

// ── ФІЛЬТРИ У ВИБОРІ СПІВРОЗМОВНИКІВ ──
// Пошук за імʼям, групи (батьки / вчителі / адміністрація) і клас.
// Рядки не перебудовуються, а лише ховаються — тому позначки не губляться,
// коли перемикаєш фільтр, і можна зібрати групу з кількох класів.
let pickerFilter = { group: '', cls: '', q: '' };
function renderPickerFilters(list){
  const box = document.getElementById('cp-filters');
  if(!box) return;
  pickerFilter = { group: '', cls: '', q: '' };
  const groups = ['parents','teachers','admin','staff'].filter(g => list.some(c => c.group === g));
  const classes = [...new Set(list.flatMap(c => c.classes || []))]
    .sort((a,b) => (parseInt(a.replace(/\D/g,''),10)||0) - (parseInt(b.replace(/\D/g,''),10)||0));
  const chip = (g, label) => `<button type="button" class="cp-chip${g === '' ? ' on' : ''}" data-g="${escHtml(g)}"
      onclick="setPickerGroup('${escJs(g)}')">${escHtml(label)}</button>`;
  box.innerHTML = `
    <input type="search" id="cp-search" placeholder="🔍 Пошук за імʼям" oninput="setPickerSearch(this.value)">
    ${groups.length > 1 ? `<div class="cp-chips">${chip('', 'Усі')}${groups.map(g => chip(g, GROUP_LABEL[g])).join('')}</div>` : ''}
    <div class="cp-tools">
      ${classes.length > 1 ? `<select id="cp-class" onchange="setPickerClass(this.value)">
        <option value="">Усі класи</option>
        ${classes.map(c => `<option value="${escHtml(c)}">${escHtml(clsLabel(c))}</option>`).join('')}
      </select>` : ''}
      <button type="button" class="cp-all" onclick="pickAllShown(true)">✓ Обрати всіх показаних</button>
      <button type="button" class="cp-all" onclick="pickAllShown(false)">Зняти</button>
    </div>
    <div id="cp-count" class="cp-count"></div>`;
  applyPickerFilter();
}
function applyPickerFilter(){
  const q = pickerFilter.q.trim().toLowerCase();
  let shown = 0;
  document.querySelectorAll('#cp-list .cp-row').forEach(row => {
    const ok = (!pickerFilter.group || row.dataset.group === pickerFilter.group)
      && (!pickerFilter.cls || String(row.dataset.classes || '').split(' ').includes(pickerFilter.cls))
      && (!q || String(row.dataset.search || '').includes(q));
    row.style.display = ok ? '' : 'none';
    if(ok) shown++;
  });
  updatePickerCount(shown);
}
function updatePickerCount(shown){
  const el = document.getElementById('cp-count');
  const picked = document.querySelectorAll('#cp-list input:checked').length;
  if(el) el.textContent = `Показано: ${shown ?? document.querySelectorAll('#cp-list .cp-row:not([style*="none"])').length}`
                        + (picked ? ` · обрано: ${picked}` : '');
  // Назва групи потрібна, коли співрозмовників більше одного
  const gn = document.getElementById('cp-group-name');
  const mode = document.getElementById('chat-picker')?.dataset.mode;
  const total = picked + (mode === 'add' ? Math.max(0, currentMembers.length - 1) : 0);
  if(gn) gn.style.display = total > 1 ? 'block' : 'none';
}
window.setPickerGroup = function(g){
  pickerFilter.group = g;
  document.querySelectorAll('#cp-filters .cp-chip').forEach(b => b.classList.toggle('on', b.dataset.g === g));
  applyPickerFilter();
};
window.setPickerClass = function(c){ pickerFilter.cls = c; applyPickerFilter(); };
window.setPickerSearch = function(q){ pickerFilter.q = String(q || ''); applyPickerFilter(); };
window.pickAllShown = function(on){
  document.querySelectorAll('#cp-list .cp-row').forEach(row => {
    if(row.style.display === 'none') return;
    const cb = row.querySelector('input'); if(cb) cb.checked = on;
  });
  updatePickerCount();
};
document.addEventListener('change', e => { if(e.target && e.target.closest && e.target.closest('#cp-list')) updatePickerCount(); });

// Назва групи за замовчуванням — імена ВСІХ учасників. Раніше при
// «додати до розмови» в назву потрапляли лише я й нові люди, а ті, хто
// вже був у розмові, з назви зникали.
function autoGroupTitle(base, me, myName, picked){
  const dir = reactDir;
  const already = base.filter(k => k !== me && !picked.some(p => p.key === k))
                      .map(k => memberName(k, dir)).filter(n => n && n !== 'Учасник');
  return [myName, ...already, ...picked.map(p => p.name)].filter(Boolean).join(', ').slice(0, 200);
}
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

  const myName = myDisplayName();
  try{
    // Чи є вже така розмова — питаємо у ВЛАСНОГО покажчика, а не в самого
    // чату. Читати chats/{id} можна лише учаснику, тож перевірка існування
    // неіснуючого чату сама падала б із «Permission denied».
    const known = await get(child(ref(db), `user_chats/${me}/${id}`));
    if(!known.exists()){
      const mem = {}; members.forEach(k=>mem[k]=true);
      // update, а не set: якщо розмова вже існує (наприклад покажчик
      // загубився), set стер би всі повідомлення.
      const custom = stripBadEmoji(document.getElementById('cp-group-name')?.value || '')
        .replace(/\s+/g, ' ').trim().slice(0, GROUP_NAME_MAX);
      await update(ref(db, `chats/${id}`), {
        members: mem, staff: staffKey,
        title: members.length > 2
          ? (custom || autoGroupTitle(base, me, myName, picked))
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
// Той самий набір, що AV_COLORS у common.js (там же й пояснення, чому
// саме такий). Дублюється історично; міняти треба обидва разом.
const AV = ['#01579B','#00697C','#C2185B','#1E7E4A','#075B65','#9A5B00','#46585E','#0277BD'];

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
