// ═══════════════════════════════════════════════════════════════
// teacher.js — everything specific to teacher-screen: journal
// filling (topic + homework), behavior grades, textbooks, the
// legacy curriculum topic checklist, teacher-side retake request
// review, class/attendance management, teacher dashboard counters,
// exams calendar, and reactions/weekly-wrapped.
// ═══════════════════════════════════════════════════════════════
import { ref, set, get, child, push, remove, update, onValue } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { renderNewsFeed } from './news.js';
import { db, auth, CLOUDINARY_URL, UPLOAD_PRESET, HW_FILE_EXT, HW_FILE_MAX_MB, fileExt, getActiveClass, currentUserData, showToast, displayGrade, renderHwItem, renderHwList, dayKeys, formatAttendanceSlotLabel, STICKER_GOAL, stickerGoal, escJs, escHtml, safeUrl, normalizeChildren, notifyEvent, logAction, renderBirthdays, teacherAccessMatrix, getUsersSnap, stuName, gradeWritePaths, localDateString, isMasterTeacher, gradeTypesCache, subjKey, emailKey } from './common.js';
import { populateTopicSelector, availableTopicsCache, planKey, loadAliases } from './curriculum.js';

let currentHwImages=[];
// teacherAttendanceListener is reassigned only here and read/invoked from
// common.js's logoutUser — plain export/import.
export let teacherAttendanceListener=null;
window.myDetailedReactions=[];

// ══════════ TEACHER: TOPIC & HW ══════════

// ═══════════════════════════════════════════════════════════════
//  ПРЕДМЕТ ПИТАЄМО В САМІЙ ДІЇ
//
// Раніше «Швидкий журнал», «Без оцінок» і копіювання ДЗ мовчки брали
// предмет із селектора на вкладці «Журнал». Учитель натискав кнопку на
// «Сьогодні» — і дія спиралася на контрол, якого в цю мить не видно.
// Зміна предмета в журналі непомітно міняла поведінку кнопок на іншій
// вкладці, і зрозуміти це з екрана було неможливо.
//
// Тепер кожне вікно має власний список предметів. Джерело те саме —
// #t-subject, тобто перелік, дозволений цьому вчителю в цьому класі,
// — але вибір видно поруч із кнопкою, якою людина зараз користується.
// ═══════════════════════════════════════════════════════════════
export async function fillActionSubject(selectId, preselect){
  const sel = document.getElementById(selectId);
  if(!sel) return '';
  const cls = getActiveClass();

  // ЗВІДКИ БЕРЕМО ПРЕДМЕТИ — за спаданням надійності:
  //
  // 1. Каталог предметів класу на навчальний рік. Це перелік того, що
  //    клас узагалі вивчає. Він не залежить ні від дати, ні від того,
  //    чи потрапив предмет у розклад.
  // 2. Розклад за весь тиждень — якщо каталог ще не заповнено.
  // 3. Список журналу — останній запасний варіант.
  //
  // Спершу тут стояв селектор журналу, який будується з уроків ОБРАНОГО
  // ДНЯ. Через це в суботу список був порожній, а в будній день залежав
  // від дати вгорі — хоча ці дії про предмет у класі, а не про розклад дня.
  let opts = [];
  if(typeof window.catalogNames === 'function'){
    try{ opts = await window.catalogNames(cls); }catch(e){ opts = []; }
    opts = opts.filter(x => window.isSubjectAllowed(cls, x));
  }
  if(!opts.length && typeof window.subjectsForClassWeek === 'function')
    opts = window.subjectsForClassWeek(cls);
  if(!opts.length){
    const src = document.getElementById('t-subject');
    opts = src ? Array.from(src.options).map(o => o.value).filter(Boolean) : [];
  }
  if(!opts.length){
    sel.innerHTML = '<option value="">— предметів класу не задано —</option>';
    return '';
  }
  const want = opts.includes(preselect) ? preselect : opts[0];
  sel.innerHTML = opts.map(o =>
    `<option value="${escHtml(o)}"${o === want ? ' selected' : ''}>${escHtml(o)}</option>`).join('');
  return want;
}

// Предмет для дії: беремо з її власного списку, а якщо його ще не
// наповнено — з журналу. Другий випадок буває лише в першу мить відкриття.
export function actionSubject(selectId){
  const sel = document.getElementById(selectId);
  if(sel && sel.value) return sel.value;
  const src = document.getElementById('t-subject');
  return src ? src.value : '';
}


// Список предметів для коментаря — з каталогу класу, як і в інших діях.
//
// ЧОМУ ОКРЕМО. Раніше це поле наповнювалося разом із журнальним, тобто
// з уроків ОБРАНОГО ДНЯ. У суботу чи в день без уроків воно лишалося
// порожнім і без підпису: друге поле незрозуміло навпроти імені учня,
// у яке нічого не можна обрати.
window.fillCommentSubjects = async function(){
  const sel = document.getElementById('t-subject-for-comment');
  if(!sel) return;
  const keep = sel.value;
  await fillActionSubject('t-subject-for-comment', keep);
};


// Поля вкладки «Клас» (коментар, наліпка) наповнюються звідси, а не з
// функцій вкладки «Урок». Вони належать іншому екрану, і чіпати їх звідти
// означало б знову зробити те, від чого ми щойно пішли: зміна на одному
// екрані мовчки міняє стан іншого. Викликається зі зміни класу — тобто з
// глобального селектора, спільного для всіх вкладок.
window.refreshClassTabPickers = async function(){
  if(document.getElementById('t-subject-for-comment')) await fillCommentSubjects();
  if(document.getElementById('t-sticker-subject'))
    await fillActionSubject('t-sticker-subject', actionSubject('t-sticker-subject'));
};

window.handleSubjectChange=function(){
  loadCurrentTopicAndHW();
  const subj=document.getElementById('t-subject').value;
  // Поле коментаря живе на вкладці «Клас» і має власний список — звідси
  // його не чіпаємо взагалі. Інакше вибір на одному екрані мовчки міняв
  // би стан іншого, якого в цю мить не видно.
  loadTextbooksForTeacher();loadCurriculumTopics();
  populateTopicSelector(); /* CURRICULUM v3 */
  // Список підручників для ДЗ наповнювався ЛИШЕ при розгортанні блока
  // (ontoggle). Якщо вчитель відкрив його до вибору предмета або змінив
  // предмет після — там лишалося «спочатку оберіть предмет» назавжди.
  if(document.getElementById('hw-textbook')) fillHwTextbooks();
};
export function loadCurrentTopicAndHW(){
  const date=document.getElementById('global-date').value;const subject=document.getElementById('t-subject').value;const cls=getActiveClass();
  // Підручники прив'язані до пари «клас + предмет», тож після зміни класу
  // список теж застаріває
  if(document.getElementById('hw-textbook')) fillHwTextbooks();
  if(document.getElementById('t-subject-for-comment')) fillCommentSubjects();
  if(!subject)return;
  // ТЕМУ ТЕЖ ПЕРЕЧИТУЄМО. Раніше на зміну дати оновлювалося все, крім теми:
  // її підвантажував лише обробник зміни ПРЕДМЕТА. Через це, перейшовши на
  // інший день, учитель бачив тему попереднього дня — або порожнє поле там,
  // де тема насправді збережена. Звідси й питання «де подивитися, чи вона
  // збереглася».
  populateTopicSelector();
  if(document.getElementById('t-hw'))document.getElementById('t-hw').value='';
  if(document.getElementById('existing-image-info'))document.getElementById('existing-image-info').style.display='none';
  currentHwImages=[];
  // Поля контексту теж СКИДАЄМО. Вони не скидалися ніколи, тож перейшовши
  // з математики на читання, учитель ніс із собою сторінки з математики —
  // і вони мовчки потрапляли в чуже завдання.
  const pagesEl=document.getElementById('hw-pages');
  const bookCustomEl=document.getElementById('hw-textbook-custom');
  if(pagesEl)pagesEl.value='';
  if(bookCustomEl)bookCustomEl.value='';
  /* Topic loading is now handled by populateTopicSelector() → loadSavedTopicForLesson() */
  get(ref(db,`homeworks/${cls}/${date}/${subject}`)).then(snap=>{
    if(!snap.exists())return;
    const val=snap.val();
    const hwEl=document.getElementById('t-hw');
    if(typeof val==='string'){ if(hwEl)hwEl.value=val; return; }
    if(hwEl)hwEl.value=val.text||'';
    // Повертаємо у форму те, з чого завдання складали: інакше наступне
    // збереження зібрало б текст із порожніх полів і затерло сторінки.
    if(pagesEl&&val.pages)pagesEl.value=val.pages;
    if(val.book&&val.book.title){
      const sel=document.getElementById('hw-textbook');
      // Випадайка заповнюється окремо й асинхронно, тож обираємо збережений
      // підручник тоді, коли варіанти вже на місці.
      const pick=()=>{ if(!sel)return false;
        const o=[...sel.options].find(x=>x.value===val.book.title);
        if(o){sel.value=val.book.title;return true;} return false; };
      if(!pick())setTimeout(pick,400);
    }
    if(val.images&&Array.isArray(val.images))currentHwImages=val.images;
    else if(val.image)currentHwImages=[val.image];
    const info=document.getElementById('existing-image-info');
    if(currentHwImages.length>0&&info){
      info.innerText=`📎 Вкладень: ${currentHwImages.length} шт.`;
      info.style.display='block';
    }
  });
}
window.loadCurrentTopicAndHW=loadCurrentTopicAndHW;
// Phase 6: up to 2 topics per lesson. lesson_topics/{cls}/{sk}/{date} is now
// {topics:[{topicId|customText}, {topicId|customText}?]} (slot 2 optional).
// hoursUsed inc/dec now compares prev vs new PER ARRAY POSITION (slot 1 vs
// slot 1, slot 2 vs slot 2) instead of the old single prevTopicId/newTopicId pair.
// ══════════ AI: ЧЕРНЕТКА ДОМАШНЬОГО ЗАВДАННЯ ══════════
// Викликає нашу серверну функцію (netlify/functions/ai-assist.js), а не
// Gemini напряму: ключ до AI не має потрапляти в браузер.
// У запит іде ЛИШЕ предмет, тема і номер класу — жодних даних про учнів.
function readCurrentTopicText(){
  // Тема береться так само, як у saveLessonTopic: спершу обрана з плану,
  // інакше — введена вручну.
  const idEl=document.getElementById('t-topic-value-1');
  const selectedId=idEl?idEl.value:'__custom__';
  if(selectedId&&selectedId!=='__custom__'){
    const t=availableTopicsCache[selectedId];
    if(t&&t.title)return t.title;
  }
  const custom=document.getElementById('t-topic-1');
  return custom?custom.value.trim():'';
}
// Спільний виклик серверної AI-функції. Усі AI-можливості ходять в один
// endpoint із різним task — див. netlify/functions/ai-assist.js
async function callAI(task,payload){
  const r=await fetch('/.netlify/functions/ai-assist',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({task,...payload})
  });
  const data=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(data.error||`Помилка ${r.status}`);
  return data;
}
// Показ статусу під кнопкою (використовують обидві AI-кнопки)
function aiMsg(id,text,isErr){
  const el=document.getElementById(id);
  if(!el)return;
  el.textContent=text;el.className='ai-hw-msg'+(isErr?' err':'');
  el.style.display=text?'block':'none';
}
// Список підручників для цього предмета вже ведеться в порталі —
// підставляємо його, щоб учитель не набирав назву вручну щоразу.
window.fillHwTextbooks=async function(){
  const sel=document.getElementById('hw-textbook');
  const subj=document.getElementById('t-subject')?.value;
  if(!sel)return;
  if(!subj){sel.innerHTML='<option value="">— спочатку оберіть предмет —</option>';return;}
  const snap=await get(ref(db,`textbooks/${getActiveClass()}/${subjKey(subj)}`));
  let html='<option value="">— не вказувати —</option>';
  let n=0;
  if(snap.exists()){
    const d=snap.val();
    // value лишається назвою — на неї спирається підказка для ШІ. Посилання
    // веземо поруч, у data-url: без нього підручник у ДЗ у батьків був просто
    // текстом, і відкрити його з завдання було неможливо.
    for(const k in d){
      const t=d[k].title||d[k].url;
      html+=`<option value="${escHtml(t)}" data-url="${escHtml(d[k].url||'')}">${escHtml(t)}</option>`;
      n++;
    }
  }
  if(!n) html='<option value="">— для цього предмета підручників ще не додано —</option>';
  sel.innerHTML=html;
};
window.generateHomeworkAI=async function(){
  const subject=document.getElementById('t-subject').value;
  const topic=readCurrentTopicText();
  const classNum=parseInt(String(getActiveClass()||'').replace('class_',''),10);
  const btn=document.getElementById('btn-ai-hw');
  const area=document.getElementById('t-hw');
  // Контекст необов'язковий: якщо поля порожні — працює як раніше
  const textbook=(document.getElementById('hw-textbook-custom')?.value.trim())
                 ||(document.getElementById('hw-textbook')?.value||'');
  const pages=document.getElementById('hw-pages')?.value.trim()||'';
  const material=document.getElementById('hw-material')?.value.trim()||'';
  if(!subject)return aiMsg('ai-hw-msg','Спочатку оберіть предмет.',true);
  if(!topic)return aiMsg('ai-hw-msg','Спочатку вкажіть тему уроку — з плану або вручну.',true);
  if(area.value.trim()&&!confirm('Поле ДЗ не порожнє. Замінити його згенерованою чернеткою?'))return;
  btn.disabled=true;const label=btn.textContent;btn.textContent='⏳ Генерую...';
  aiMsg('ai-hw-msg','');
  try{
    const data=await callAI('homework',{subject,topic,classNum,textbook,pages,material});
    area.value=data.text||'';
    area.rows=Math.min(12,Math.max(3,String(data.text||'').split('\n').length+1));
    aiMsg('ai-hw-msg',data.truncated
      ?'⚠️ Текст обірвався на середині (модель уперлася в ліміт). Допишіть вручну або згенеруйте ще раз.'
      :'✨ Чернетку створено. Перевірте, за потреби відредагуйте — і збережіть.',!!data.truncated);
  }catch(e){aiMsg('ai-hw-msg','Не вдалося згенерувати: '+e.message,true);}
  finally{btn.disabled=false;btn.textContent=label;}
};
// ══════════════════════════════════════════════════════════════════
//  ШВИДКИЙ ЖУРНАЛ НА УРОЦІ
// ══════════════════════════════════════════════════════════════════
// Повний журнал зручний за комп'ютером, але на уроці вчитель стоїть із
// телефоном. Тут один екран: увесь клас списком, у кожного — присутність
// і поле оцінки. Зберігається все разом, одним натисканням.
window.openQuickJournal=async function(){
  const cls=getActiveClass();
  const subj=await fillActionSubject('qj-subject', actionSubject('qj-subject'));
  const date=document.getElementById('global-date').value;
  if(!subj)return showToast('⚠️ Предметів класу не задано. Директор заповнює їх у «📗 Предмети класу й учителі»');
  document.getElementById('qj-date').textContent=date.split('-').reverse().join('.');
  const box=document.getElementById('qj-body');
  box.innerHTML='<p class="empty-msg">Завантаження...</p>';
  document.getElementById('quick-journal-modal').style.display='flex';
  try{
    const ym=date.slice(0,7);
    const [stSnap,gSnap,tSnap,aSnap,cardSnap]=await Promise.all([
      get(child(ref(db),`students_list/${cls}`)),
      get(child(ref(db),`grades/${cls}/${ym}/${subj}/${date}`)),
      get(child(ref(db),`grade_types/${cls}/${ym}/${subj}/${date}`)),
      get(child(ref(db),`attendance/${cls}/${date}`)),
      get(child(ref(db),`student_cards/${cls}`))
    ]);
    // [{sid, nm}] — дані ключуються ідентифікатором, людині показуємо імʼя
    const students=stSnap.exists()
      ?Object.entries(stSnap.val()).map(([sid,nm])=>({sid,nm:String(nm)}))
        .sort((a,b)=>a.nm.localeCompare(b.nm,'uk')):[];
    if(students.length===0){box.innerHTML='<p class="empty-msg">У класі немає учнів.</p>';return;}
    const g=gSnap.exists()?gSnap.val():{}, t=tSnap.exists()?tSnap.val():{}, a=aSnap.exists()?aSnap.val():{};
    // Алергії показуємо і тут: на уроці це найпотрібніше місце
    const allerg={};
    if(cardSnap.exists()&&stSnap.exists()){
      const cards=cardSnap.val(), names=stSnap.val();
      for(const k in names)if(cards[k]&&cards[k].allergies)allerg[k]=cards[k].allergies;
    }
    const slotKey=document.getElementById('t-mark-absent-lesson')?.value||'all';
    box.innerHTML=students.map((s,i)=>{
      // Поточний статус: беремо будь-яку відмітку на цей день
      let status='';
      // І за ідентифікатором, і за імʼям: повідомлення про запізнення пише
      // родина, а її записи донедавна лягали під імʼям. Та сама причина, через
      // яку кухня не бачила обраний гарнір.
      const slots=a[s.sid]||a[s.nm]||{};
      for(const sk in slots){if(slots[sk]?.status){status=slots[sk].status;break;}}
      return `<div class="qj-row" data-sid="${escHtml(s.sid)}" data-name="${escHtml(s.nm)}">
        <div class="qj-n">${i+1}</div>
        <div class="qj-name">${escHtml(s.nm)}${allerg[s.sid]?` <span class="po-allergy" data-tip="${escHtml(allerg[s.sid])}">⚠️</span>`:''}</div>
        <div class="qj-att">
          <button type="button" class="qj-b ok${status===''?' on':''}"   onclick="qjSet(this,'')">✓</button>
          <button type="button" class="qj-b lt${status==='late'?' on':''}" onclick="qjSet(this,'late')">З</button>
          <button type="button" class="qj-b ab${status==='absent'?' on':''}" onclick="qjSet(this,'absent')">Н</button>
        </div>
        <input type="text" class="qj-g" maxlength="1" value="${escHtml(g[s.sid]||'')}"
               data-orig="${escHtml(g[s.sid]||'')}" placeholder="—">
      </div>`;
    }).join('');
    // Тип оцінки — один на весь урок, як зазвичай і буває
    const ts=document.getElementById('qj-type');
    const codes=Object.keys(gradeTypesCache).length?Object.keys(gradeTypesCache):['П','У','ДЗ','СР','К'];
    ts.innerHTML=codes.map(c=>`<option value="${escHtml(c)}">${escHtml((gradeTypesCache[c]&&gradeTypesCache[c].label)||c)}</option>`).join('');
    const firstType=Object.values(t)[0];
    if(firstType&&codes.includes(firstType))ts.value=firstType;
    box.dataset.slot=slotKey;
  }catch(e){box.innerHTML=`<p style="color:red;font-size:.8rem;">Помилка: ${escHtml(e.message)}</p>`;}
};
window.qjSet=function(btn,val){
  const row=btn.closest('.qj-row');
  row.querySelectorAll('.qj-b').forEach(b=>b.classList.remove('on'));
  btn.classList.add('on');
  row.dataset.status=val;
};
window.closeQuickJournal=function(){document.getElementById('quick-journal-modal').style.display='none';};
window.saveQuickJournal=async function(){
  const cls=getActiveClass();
  // Саме той предмет, який видно у вікні, а не той, що лишився в журналі
  const subj=actionSubject('qj-subject');
  const date=document.getElementById('global-date').value;
  const ym=date.slice(0,7);
  const gtype=document.getElementById('qj-type').value;
  const slotKey=document.getElementById('qj-body').dataset.slot||'all';
  const rows=Array.from(document.querySelectorAll('.qj-row'));
  const bad=rows.find(r=>{const v=r.querySelector('.qj-g').value.trim();return v&&!/^[1-6]$/.test(v);});
  if(bad)return alert('Оцінки мають бути від 1 до 6.');
  const btn=document.getElementById('btn-qj-save');
  btn.disabled=true;btn.textContent='⏳ Збереження...';
  try{
    const gPatch={},tPatch={};let nG=0,nA=0;
    for(const r of rows){
      const sid=r.dataset.sid, name=r.dataset.name;
      const v=r.querySelector('.qj-g').value.trim();
      const orig=r.querySelector('.qj-g').dataset.orig||'';
      if(v!==orig){
        gPatch[sid]=v||null;
        tPatch[sid]=v?gtype:null;
        if(v){nG++;notifyEvent('grade',{class:cls,studentName:name,subject:subj,value:displayGrade(v,cls)});}
      }
      // Відвідуваність пишемо лише там, де вчитель щось позначив
      const status=r.dataset.status;
      if(status===undefined)continue;
      if(status===''){await remove(ref(db,`attendance/${cls}/${date}/${sid}/${slotKey}`));}
      else{
        await set(ref(db,`attendance/${cls}/${date}/${sid}/${slotKey}`),
          {status,reason:status==='late'?'запізнення':'Відмічено вчителем',markedBy:'teacher'});
        nA++;notifyEvent('absence',{class:cls,studentName:name,subject:subj});
      }
    }
    if(Object.keys(gPatch).length){
      // Один запис від кореня на всіх учнів: основа і дзеркало разом
      const upd = {};
      for(const sid in gPatch)
        Object.assign(upd, gradeWritePaths(cls,ym,subj,date,sid,gPatch[sid],tPatch[sid]));
      await update(ref(db), upd);
    }
    logAction('quick_journal',{cls,subject:subj,date,value:`оцінок: ${nG}, відміток: ${nA}`});
    showToast(`✅ Збережено — оцінок ${nG}, відміток ${nA}`);
    window.closeQuickJournal();
  }catch(e){alert('Помилка: '+e.message);}
  finally{btn.disabled=false;btn.textContent='💾 Зберегти все';}
};
// ══════════════════════════════════════════════════════════════════
//  ПОВІДОМЛЕННЯ ВСЬОМУ КЛАСУ
// ══════════════════════════════════════════════════════════════════
// Чат був лише один на один, і «завтра принести альбом» доводилося
// копіювати двадцять разів. Тут одне повідомлення розходиться всім
// батькам класу — кожному в його особистий чат, а не в спільну групу:
// так батьки не бачать контактів одне одного.
window.openClassBroadcast=function(){
  document.getElementById('cb-class').textContent=getActiveClass().replace('class_','')+' клас';
  document.getElementById('cb-text').value='';
  document.getElementById('cb-status').textContent='';
  document.getElementById('class-broadcast-modal').style.display='flex';
};
window.closeClassBroadcast=function(){document.getElementById('class-broadcast-modal').style.display='none';};
window.sendClassBroadcast=async function(){
  const cls=getActiveClass();
  const text=document.getElementById('cb-text').value.trim();
  if(!text)return alert('Введіть текст повідомлення.');
  const btn=document.getElementById('btn-cb-send');
  btn.disabled=true;btn.textContent='⏳ Надсилаю...';
  try{
    const plSnap=await get(child(ref(db),'parent_links'));
    const targets=[];
    if(plSnap.exists()){
      const pl=plSnap.val();
      for(const se in pl){
        if(normalizeChildren(pl[se]).some(k=>k.class===cls))targets.push(se);
      }
    }
    if(targets.length===0){alert('У цьому класі немає прив\'язаних батьків.');return;}
    if(!confirm(`Надіслати повідомлення ${targets.length} отримувачам?\n\nКожен отримає його в особистий чат.`))return;
    const mySafe=emailKey(currentUserData?.email);
    const myName=((currentUserData?.firstName||'')+' '+(currentUserData?.lastName||'')).trim()||currentUserData?.email||'Вчитель';
    for(const se of targets){
      const chatId=[mySafe,se].sort().join('___');
      await push(ref(db,`chats/${chatId}/messages`),
        {from:mySafe,fromName:`${myName} (Вчитель)`,text,time:Date.now(),read:false});
    }
    logAction('broadcast',{cls,value:`${targets.length} отримувачів`});
    document.getElementById('cb-status').textContent=`✅ Надіслано ${targets.length} отримувачам`;
    document.getElementById('cb-text').value='';
    showToast(`✉️ Надіслано: ${targets.length}`);
  }catch(e){alert('Помилка: '+e.message);}
  finally{btn.disabled=false;btn.textContent='✉️ Надіслати всім';}
};
// ══════════ УЧНІ БЕЗ ОЦІНОК ══════════
// Тихий учень, який не тягне руку, легко випадає з уваги на місяць —
// і це спливає аж на батьківських зборах. Показуємо, кого давно не оцінювали
// саме з цього предмета.
window.showUngraded=async function(){
  const cls=getActiveClass();
  const subj=await fillActionSubject('ungraded-subject', actionSubject('ungraded-subject'));
  const box=document.getElementById('ungraded-body');
  if(!subj)return showToast('⚠️ Предметів класу не задано. Директор заповнює їх у «📗 Предмети класу й учителі»');
  document.getElementById('ungraded-modal').style.display='flex';
  box.innerHTML='<p class="empty-msg">Обчислення...</p>';
  try{
    // РАХУЄМО ВІД СПРАВЖНЬОГО СЬОГОДНІ, а не від обраної дати.
    //
    // «Давно не оцінювали» означає «давно від цієї миті». Раніше точкою
    // відліку була дата з верхнього селектора: якщо вчитель лишив її на
    // минулому тижні, портал рахував давність від неї й показував інший
    // список. Дата тут не потрібна взагалі — це підсумок за період.
    const today=localDateString;
    // Дивимось поточний і два попередні місяці — цього досить, щоб побачити
    // «давно не оцінювали», і не читати весь рік
    const months=[];let [y,m]=today.split('-').map(Number);
    for(let i=0;i<3;i++){months.push(`${y}-${String(m).padStart(2,'0')}`);m--;if(m<1){m=12;y--;}}
    const [stSnap,...gs]=await Promise.all([
      get(child(ref(db),`students_list/${cls}`)),
      ...months.map(ym=>get(child(ref(db),`grades/${cls}/${ym}/${subj}`)))
    ]);
    const students=stSnap.exists()
      ?Object.entries(stSnap.val()).map(([sid,nm])=>({sid,nm:String(nm)}))
        .sort((a,b)=>a.nm.localeCompare(b.nm,'uk')):[];
    if(students.length===0){box.innerHTML='<p class="empty-msg">У класі немає учнів.</p>';return;}
    const last={};
    gs.forEach(sn=>{
      if(!sn.exists())return;
      const d=sn.val();
      for(const date in d)for(const sid in d[date])
        if(!last[sid]||date>last[sid])last[sid]=date;
    });
    const days=(a,b)=>Math.round((new Date(b)-new Date(a))/86400000);
    const rows=students.map(st=>({st:st.nm,date:last[st.sid]||null,d:last[st.sid]?days(last[st.sid],today):null}))
      .sort((a,b)=>(b.d===null?9999:b.d)-(a.d===null?9999:a.d));
    const problem=rows.filter(r=>r.date===null||r.d>=14);
    const note=`<p class="ug-note">Рахуємо від сьогодні, ${today.split('-').reverse().join('.')}. `
             + 'Обрана вгорі дата на цей список не впливає.</p>';
    let html=note+(problem.length===0
      ? '<div class="po-ok">✓ Усіх оцінювали протягом останніх двох тижнів</div>'
      : `<div class="bell-missing">⚠️ Давно без оцінок: ${problem.length} ${problem.length===1?'учень':'учнів'}</div>`);
    html+=rows.map(r=>`<div class="ug-row${r.date===null||r.d>=14?' warn':''}">
      <span class="ug-name">${escHtml(r.st)}</span>
      <span class="ug-when">${r.date
        ? `${escHtml(r.date.split('-').reverse().join('.'))} · ${r.d} дн. тому`
        : 'жодної оцінки'}</span>
    </div>`).join('');
    box.innerHTML=html;
  }catch(e){box.innerHTML=`<p style="color:red;font-size:.8rem;">Помилка: ${escHtml(e.message)}</p>`;}
};
window.closeUngraded=function(){document.getElementById('ungraded-modal').style.display='none';};
// ══════════ КОПІЮВАННЯ ДЗ У ПАРАЛЕЛЬНІ КЛАСИ ══════════
// Учитель веде той самий предмет у кількох класах і набирав те саме ДЗ
// двічі-тричі. Копіюємо ЛИШЕ домашнє завдання, а не тему уроку: теми
// пов'язані з календарним планом і вичиткою годин, і в кожного класу
// свій прогрес — копіювання їх зіпсувало б лічильники.
window.openHwCopy=async function(){
  const subject=await fillActionSubject('hw-copy-subject', actionSubject('hw-copy-subject'));
  const box=document.getElementById('hw-copy-classes');
  if(!subject)return showToast('⚠️ Предметів класу не задано. Директор заповнює їх у «📗 Предмети класу й учителі»');
  const cur=getActiveClass();
  // Пропонуємо лише класи, до яких у вчителя є доступ саме з цього предмета
  const mine=Object.keys(teacherAccessMatrix||{}).filter(c=>c!==cur&&window.isSubjectAllowed(c,subject));
  if(mine.length===0)return showToast('ℹ️ Немає інших класів із цим предметом');
  box.innerHTML=mine.map(c=>`<label class="hw-copy-opt">
      <input type="checkbox" value="${escHtml(c)}"> ${escHtml(c.replace('class_',''))} клас
    </label>`).join('');
  // Дата тут справді впливає на результат — копіюється ДЗ саме за цей день.
  // Тому вона має бути видна у вікні, а не лише в тексті підтвердження.
  const hd=document.getElementById('hw-copy-date');
  if(hd)hd.textContent=(document.getElementById('global-date').value||'').split('-').reverse().join('.');
  document.getElementById('hw-copy-modal').style.display='flex';
};
window.closeHwCopy=function(){document.getElementById('hw-copy-modal').style.display='none';};
window.doHwCopy=async function(){
  const subject=actionSubject('hw-copy-subject');
  const date=document.getElementById('global-date').value;
  const targets=Array.from(document.querySelectorAll('#hw-copy-classes input:checked')).map(i=>i.value);
  if(targets.length===0)return alert('Оберіть хоча б один клас.');
  const text=document.getElementById('t-hw').value.trim();
  if(!text&&currentHwImages.length===0)return alert('Поле ДЗ порожнє — нічого копіювати.');
  const names=targets.map(c=>c.replace('class_','')).join(', ');
  if(!confirm(`Скопіювати це ДЗ у класи: ${names}?\n\nПредмет: ${subject}\nДата: ${date.split('-').reverse().join('.')}\n\nЯкщо в цих класах на цю дату вже є ДЗ — воно буде замінено.\nТеми уроків не копіюються.`))return;
  const btn=document.getElementById('btn-hw-copy-do');
  btn.disabled=true;btn.textContent='⏳ Копіюю...';
  try{
    // Копія має бути ПОВНОЮ. Раніше сюди клалися лише текст і фото, тож
    // у паралельному класі зникали сторінки й посилання на підручник —
    // хоча вчитель бачив їх на екрані й був певен, що копіює все.
    const payload={text,images:currentHwImages,ts:Date.now()};
    const pagesRaw=document.getElementById('hw-pages')?.value.trim()||'';
    if(pagesRaw)payload.pages=pagesRaw;
    const bSel=document.getElementById('hw-textbook');
    const bOpt=bSel&&bSel.selectedIndex>=0?bSel.options[bSel.selectedIndex]:null;
    const bCustom=document.getElementById('hw-textbook-custom')?.value.trim()||'';
    const bTitle=bCustom||(bSel?bSel.value:'');
    const bUrl=bCustom?'':(bOpt?(bOpt.getAttribute('data-url')||''):'');
    if(bTitle&&bUrl)payload.book={title:bTitle,url:bUrl};
    for(const c of targets){
      const hwRef=ref(db,`homeworks/${c}/${date}/${subject}`);
      // Те саме правило, що й при звичайному збереженні: сповіщаємо лише
      // там, де завдання з цього предмета на цей день ще не було.
      const existed=(await get(hwRef)).exists();
      await set(hwRef,payload);
      await set(ref(db,`authors/${c}/${date}/${subject}`),auth.currentUser.uid);
      logAction('homework',{cls:c,subject,date,value:'копія'});
      if(!existed)notifyEvent('homework',{class:c,subject}).catch(()=>{});
    }
    showToast(`✅ ДЗ скопійовано у ${targets.length} кл.`);
    window.closeHwCopy();
  }catch(e){alert('Помилка: '+e.message);}
  finally{btn.disabled=false;btn.textContent='📋 Скопіювати';}
};
// ══════════ AI: ДОПОМОГА З КОМЕНТАРЕМ ДЛЯ БАТЬКІВ ══════════
// Учитель пише як думає («не готовий, заважає»), а отримує коректне
// формулювання. ПРИВАТНІСТЬ: у сервіс іде лише текст, який написав сам
// учитель, плюс предмет і номер класу. Ім'я учня не передається — і в
// підказці окремо сказано моделі не вигадувати імен.
window.improveCommentAI=async function(){
  const area=document.getElementById('t-comment');
  const note=area.value.trim();
  const subject=document.getElementById('t-subject-for-comment')?.value||'';
  const classNum=parseInt(String(getActiveClass()||'').replace('class_',''),10);
  const btn=document.getElementById('btn-ai-comment');
  if(!note)return aiMsg('ai-comment-msg','Спочатку напишіть кілька слів своїми словами — я допоможу сформулювати.',true);
  btn.disabled=true;const label=btn.textContent;btn.textContent='⏳ Формулюю...';
  aiMsg('ai-comment-msg','');
  try{
    const data=await callAI('comment',{note,subject,classNum});
    area.value=data.text||'';
    area.rows=Math.min(8,Math.max(2,String(data.text||'').split('\n').length+1));
    aiMsg('ai-comment-msg','✨ Варіант готовий. Перевірте формулювання — і збережіть.');
  }catch(e){aiMsg('ai-comment-msg','Не вдалося сформулювати: '+e.message,true);}
  finally{btn.disabled=false;btn.textContent=label;}
};
// Перевіряємо файли ОДРАЗУ при виборі, а не при збереженні: інакше вчитель
// напише завдання, натисне «Зберегти» і аж тоді дізнається, що формат не той.
window.hwFilesPicked=function(input){
  const lbl=document.getElementById('hw-file-name');
  const files=Array.from(input.files||[]);
  if(!files.length){ if(lbl){lbl.textContent='Файл не обрано';lbl.style.color='#78909c';} return; }
  const bad=files.filter(f=>!HW_FILE_EXT.includes(fileExt(f.name)));
  const big=files.filter(f=>f.size>HW_FILE_MAX_MB*1024*1024);
  if(bad.length||big.length){
    input.value='';
    if(lbl){lbl.style.color='#b71c1c';
      lbl.textContent=bad.length
        ? `Не підходить: ${bad.map(f=>f.name).join(', ')}. Можна лише ${HW_FILE_EXT.join(', ')}.`
        : `Завеликий файл: ${big.map(f=>f.name).join(', ')} — понад ${HW_FILE_MAX_MB} МБ.`;}
    return;
  }
  if(lbl){lbl.style.color='#2e7d32';
    lbl.textContent=files.length===1?files[0].name:`Обрано файлів: ${files.length}`;}
};
// ── ЗБЕРЕЖЕННЯ УРОКУ: ТЕМА Й ДЗ ОКРЕМО ──────────────────────────
//
// Раніше це була одна кнопка «Зберегти тему та ДЗ». Учитель заповнював
// щось одне, а натискав кнопку про двоє, і не було зрозуміло, що саме
// пішло в базу. Тепер у кожного блоку своя кнопка, і кожна відповідає
// рівно за своє.
const BTN_TOPIC = '💾 Зберегти тему';
const BTN_HW    = '💾 Зберегти ДЗ';

// Що зараз редагується. Предмет обов'язковий обом кнопкам: без нього
// невідомо, до чого чіпляти запис.
// ДВА КЛЮЧІ, А НЕ ОДИН — І ЦЕ НЕ ДРІБНИЦЯ.
//
//   sk — під цією назвою лежить те, що робив САМЕ ЦЕЙ урок:
//        lesson_topics/{клас}/{sk}/{дата}. Тут псевдонім не діє: два
//        рядки в розкладі — це два різні уроки, і зливати їхні журнали
//        ми навмисно не стали.
//
//   pk — під цією назвою лежить ПЛАН: curriculum_plans/{клас}/{pk}/…
//        Він може бути спільним, і тоді «Matematyka» бере теми з
//        «Математика».
//
// Досі скрізь стояв один sk на обидва вузли, і це працювало рівно доти,
// доки план не став спільним. Далі виходило так: список тем уроку
// приходив зі спільного плану (там свої ідентифікатори), а витрачені
// години дописувалися в curriculum_plans/{клас}/Matematyka — вузол,
// якого не існує. get().exists() повертав false, лічильник тихо не
// збільшувався, і в плані назавжди лишалося «0 з 140». Без жодної
// помилки на екрані.
function lessonCtx(){
  const subject=document.getElementById('t-subject').value;
  if(!subject){ alert('Оберіть предмет!'); return null; }
  const cls=getActiveClass();
  return { date:document.getElementById('global-date').value,
           subject, sk:subjKey(subject), pk:planKey(cls, subject), cls,
           uid:auth.currentUser.uid, sm:document.getElementById('status-msg') };
}

// Спільна обгортка: зайнятий стан, ловля помилок, звільнення кнопки.
// Кнопок тепер дві, і писати цей код двічі означало б рано чи пізно
// забути finally в одній із них — саме через це кнопка колись назавжди
// лишалася в стані «Збереження...».
async function runSave(btnId, label, sm, job){
  const btn=document.getElementById(btnId);
  if(btn){ btn.disabled=true; btn.innerText='⏳ Збереження...'; }
  try{
    const msg=await job();
    if(msg!==false&&sm){
      sm.style.display='block'; sm.style.color='#1a7d3a'; sm.style.background='#e8f5e9';
      sm.innerText=msg||'✅ Збережено!';
      setTimeout(()=>{ sm.style.display='none'; },2500);
    }
  }catch(e){
    console.error(label+':',e);
    // PERMISSION_DENIED — це не поломка, а незаповнена матриця доступу.
    const denied=/permission[_ ]denied/i.test((e&&e.message)||'');
    if(sm){
      sm.style.display='block'; sm.style.color='#b71c1c'; sm.style.background='#ffebee';
      sm.innerText=denied
        ? '⛔ Немає прав на запис у цей клас. Директор має відкрити його вам у «Матриці доступу вчителів».'
        : ('❌ Не збережено: '+((e&&e.message)||'невідома помилка'));
    }
    showToast('❌ Не вдалося зберегти');
  }finally{
    if(btn){ btn.disabled=false; btn.innerText=label; }
  }
}

// ── ТЕМА УРОКУ ──────────────────────────────────────────────────
window.saveLessonTopic=function(){
  const c=lessonCtx(); if(!c) return;
  // Кнопок тепер дві, а раніше була одна — «Зберегти тему та ДЗ». За
  // звичкою натискають першу й вважають, що збережено все. Тема при цьому
  // лягає в базу, завдання — ні, і батьки бачать вчорашнє. Тож коли в
  // полях ДЗ щось є, попереджаємо про це прямо.
  const hw=document.getElementById('t-hw')?.value.trim()||'';
  const pages=document.getElementById('hw-pages')?.value.trim()||'';
  const files=document.getElementById('t-image')?.files.length||0;
  if(hw||pages||files){
    if(!confirm('Ця кнопка зберігає ЛИШЕ тему уроку.\n\n'
      +'Домашнє завдання нижче не збережеться — для нього є окрема кнопка '
      +'«💾 Зберегти ДЗ».\n\nЗберегти саму тему?')) return;
  }
  return runSave('btn-save-topic', BTN_TOPIC, c.sm, async()=>{
    const {cls,sk,date}=c;
    // Псевдоніми могли ще не прочитатися — тоді pk у контексті порахувався
    // за старим кешем. Читання одне на клас і з кешу, тож перестрахуватися
    // тут дешево, а помилитися ключем плану — ні: години пішли б у нікуди.
    await loadAliases(cls);
    const pk=planKey(cls, c.subject);

    // 1. Вибір з обох слотів (слот 2 — лише якщо його блок відкритий)
    const slot2Active=document.getElementById('t-topic-slot-2-wrap')&&document.getElementById('t-topic-slot-2-wrap').style.display!=='none';
    const slotInputs=[1,...(slot2Active?[2]:[])].map(n=>({
      selectedId:document.getElementById(`t-topic-value-${n}`)?document.getElementById(`t-topic-value-${n}`).value:'__custom__',
      customText:document.getElementById(`t-topic-${n}`)?document.getElementById(`t-topic-${n}`).value.trim():''
    }));

    // 2. Попередній стан (будь-яку стару форму запису зводимо до масиву)
    const prevSnap=await get(ref(db,`lesson_topics/${cls}/${sk}/${date}`));
    let prevTopics=[];
    if(prevSnap.exists()){
      const v=prevSnap.val();
      if(typeof v==='string')prevTopics=[{customText:v}];
      else if(Array.isArray(v.topics))prevTopics=v.topics;
      else if(v.topicId||v.customText)prevTopics=[v];
    }

    // 3. Новий масив тем; ліміт годин перевіряємо для КОЖНОЇ нової окремо
    let newTopics=[];
    for(let i=0;i<slotInputs.length;i++){
      const {selectedId,customText}=slotInputs[i];
      if(selectedId==='__custom__'){ if(customText)newTopics.push({customText}); continue; }
      // ЛІМІТ ГОДИН БІЛЬШЕ НЕ ЗАБОРОНЯЄ, А ПОПЕРЕДЖАЄ.
      //
      // Раніше тут стояла відмова: години теми вичерпані — зберегти не
      // можна. Учителі попросили прибрати, і слушно: клас не зрозумів
      // матеріал, урок випав через свято, контрольна показала прогалину.
      // Заборона змушувала вписувати ту саму тему «вручну», і план
      // переставав відповідати тому, що було на уроках, — тобто ставав
      // менш точним саме там, де мав бути точним.
      const prevTopicId=prevTopics[i]?.topicId||null;
      if(selectedId!==prevTopicId){
        const newTSnap=await get(ref(db,`curriculum_plans/${cls}/${pk}/topics/${selectedId}`));
        if(newTSnap.exists()){
          const t=newTSnap.val();
          if((t.hoursUsed||0)>=(t.plannedHours||0))
            showToast(`↻ Тема "${t.title}" береться повторно — години понад план`);
        }
      }
      newTopics.push({topicId:selectedId});
    }
    if(newTopics.length===2&&newTopics[0].topicId&&newTopics[0].topicId===newTopics[1].topicId){
      showToast('⚠️ Тема 1 і Тема 2 не можуть збігатися!');
      return false;
    }

    // 4. Запис або видалення теми
    if(newTopics.length>0) await set(ref(db,`lesson_topics/${cls}/${sk}/${date}`),{topics:newTopics});
    else await remove(ref(db,`lesson_topics/${cls}/${sk}/${date}`));

    // 5. hoursUsed — окремо для кожної позиції масиву (слот 1 порівнюється
    //    лише зі слотом 1, слот 2 — лише зі слотом 2)
    const maxLen=Math.max(prevTopics.length,newTopics.length);
    for(let i=0;i<maxLen;i++){
      const prevId=prevTopics[i]?.topicId||null;
      const newId=newTopics[i]?.topicId||null;
      if(prevId===newId)continue;
      // pk, а не sk: ідентифікатори тем прийшли зі СПІЛЬНОГО плану, і
      // лічильник годин має зростати саме там, звідки взято тему.
      if(prevId){
        const pSnap=await get(ref(db,`curriculum_plans/${cls}/${pk}/topics/${prevId}`));
        if(pSnap.exists()){
          const t=pSnap.val();
          await set(ref(db,`curriculum_plans/${cls}/${pk}/topics/${prevId}/hoursUsed`),Math.max(0,(t.hoursUsed||0)-1));
        }
      }
      if(newId){
        const nSnap=await get(ref(db,`curriculum_plans/${cls}/${pk}/topics/${newId}`));
        if(nSnap.exists()){
          const t=nSnap.val();
          await set(ref(db,`curriculum_plans/${cls}/${pk}/topics/${newId}/hoursUsed`),(t.hoursUsed||0)+1);
        }
      }
    }
    populateTopicSelector();   // перемальовує обидві випадайки
    return newTopics.length ? '✅ Тему збережено' : '✅ Тему прибрано';
  });
};

// ── ДОМАШНЄ ЗАВДАННЯ ────────────────────────────────────────────
window.saveHomework=function(){
  const c=lessonCtx(); if(!c) return;
  return runSave('btn-save-hw', BTN_HW, c.sm, async()=>{
    const {cls,date,subject,uid,sm}=c;
    let hwText=document.getElementById('t-hw')?document.getElementById('t-hw').value.trim():'';
    const fileInput=document.getElementById('t-image');

    // Обраний підручник разом із посиланням — прикладаємо окремим полем,
    // щоб у батьків він був клікабельний, а не просто назвою.
    const bookSel=document.getElementById('hw-textbook');
    const bookOpt=bookSel&&bookSel.selectedIndex>=0?bookSel.options[bookSel.selectedIndex]:null;
    const bookCustom=document.getElementById('hw-textbook-custom')?.value.trim()||'';
    // Назва, вписана вручну, НЕ має посилання: інакше в завдання могло б
    // потрапити одне видання з посиланням на зовсім інше.
    const bookTitle=bookCustom||(bookSel?bookSel.value:'');
    const bookUrl=bookCustom?'':(bookOpt?(bookOpt.getAttribute('data-url')||''):'');

    // Поле ДЗ порожнє, але вказано підручник і сторінки — це і є завдання.
    if(!hwText&&!(fileInput&&fileInput.files.length)){
      const pages=document.getElementById('hw-pages')?.value.trim()||'';
      if(bookTitle||pages){
        // Є клікабельний підручник — назву в текст не дублюємо.
        hwText=(bookUrl&&pages)?pages:[bookTitle,pages].filter(Boolean).join(' — ');
        const area=document.getElementById('t-hw');
        if(area)area.value=hwText;
      }
    }

    let finalImageUrls=[...currentHwImages];
    if(fileInput&&fileInput.files.length>0){
      sm.style.display='block';sm.innerText='⏳ Завантаження файлів...';
      sm.style.color='#f39c12';sm.style.background='#fff8e1';
      finalImageUrls=await Promise.all(Array.from(fileInput.files).map(async file=>{
        const fd=new FormData(); fd.append('file',file); fd.append('upload_preset',UPLOAD_PRESET);
        const r=await fetch(CLOUDINARY_URL,{method:'POST',body:fd});
        const d=await r.json();
        if(!d.secure_url) throw new Error('файл не завантажився: '+(d.error&&d.error.message||'невідома причина'));
        return d.secure_url;
      }));
    }

    if(!hwText&&finalImageUrls.length===0){
      showToast('⚠️ Завдання порожнє — нічого зберігати');
      return false;
    }

    // Автора пишемо тільки разом із завданням: сам по собі запис про те,
    // хто відкривав урок, нікому не потрібен.
    await set(ref(db,`authors/${cls}/${date}/${subject}`),uid);

    const hwRef=ref(db,`homeworks/${cls}/${date}/${subject}`);
    // Чи це ПЕРШЕ завдання з предмета на цей день. Учитель зберігає той
    // самий урок по три-чотири рази — виправляє текст, дописує сторінки.
    // Слати push щоразу означало б навчити батьків не звертати уваги.
    const existed=(await get(hwRef)).exists();
    // ts — коли завдання внесли. Дата в ключі каже, НА який день задано.
    const rec={text:hwText,images:finalImageUrls,ts:Date.now()};
    if(bookTitle&&bookUrl)rec.book={title:bookTitle,url:bookUrl};
    // Сторінки зберігаємо ОКРЕМИМ полем, хоч вони вже є в тексті.
    // Поля контексту ніде не зберігалися, тож при повторному відкритті
    // уроку вони були порожні: учитель правив щось одне, натискав
    // «Зберегти ДЗ» — і сторінки зникали, бо складати текст не було з чого.
    // Тепер їх можна відновити у формі.
    const pagesRaw=document.getElementById('hw-pages')?.value.trim()||'';
    if(pagesRaw)rec.pages=pagesRaw;
    await set(hwRef,rec);
    // Сповіщення не має права зірвати збереження: воно вже відбулося.
    if(!existed)notifyEvent('homework',{class:cls,subject}).catch(()=>{});

    if(fileInput)fileInput.value='';
    const lbl=document.getElementById('hw-file-name');
    if(lbl){lbl.textContent='Файл не обрано';lbl.style.color='#78909c';}
    setTimeout(()=>loadTeacherDashboard(),300);
    return '✅ ДЗ збережено';
  });
};
// ══════════ BEHAVIOR GRADE ══════════
window.saveBehaviorGrade=async function(){
  const student=document.getElementById('t-behavior-student').value;
  const val=document.getElementById('t-behavior-grade').value.trim();
  const date=document.getElementById('global-date').value;const cls=getActiveClass();
  const yMonth=date.substring(0,7);
  if(!student||!val){showToast("⚠️ Оберіть учня та введіть оцінку (1-6)!");return;}
  const n=parseInt(val);if(isNaN(n)||n<1||n>6){showToast("⚠️ Оцінка поведінки: від 1 до 6!");return;}
  await set(ref(db,`behavior_grades/${cls}/${yMonth}/${date}/${student}`),n);
  showToast(`✅ Поведінка ${stuName(cls,student)}: ${displayGrade(n,cls)}`);
  document.getElementById('t-behavior-grade').value='';
};
// ══════════ TEXTBOOKS (teacher side) ══════════
async function loadTextbooksForTeacher(){
  const cls=getActiveClass();const subj=document.getElementById('t-subject').value;
  if(!subj)return;
  const snap=await get(ref(db,`textbooks/${cls}/${subjKey(subj)}`));
  const container=document.getElementById('t-textbooks-list');container.innerHTML='';
  if(snap.exists()){const data=snap.val();for(let k in data){const tb=data[k];container.innerHTML+=`<div class="textbook-item">📘 <a href="${safeUrl(tb.url)}" target="_blank" rel="noopener noreferrer">${escHtml(tb.title||tb.url)}</a><button onclick="removeTextbook('${cls}','${escJs(subj)}','${k}')" style="background:none;border:none;color:var(--red);cursor:pointer;padding:0;width:auto;margin:0;font-size:1rem;">✖</button></div>`;}}
  else container.innerHTML='<p class="empty-msg" style="font-size:.8rem;">Підручників ще не додано.</p>';
}
window.saveTextbook=async function(){
  const cls=getActiveClass();const subj=document.getElementById('t-subject').value;
  const title=document.getElementById('t-tb-title').value.trim();const url=document.getElementById('t-tb-url').value.trim();
  if(!subj||!url){showToast("⚠️ Оберіть предмет та введіть посилання!");return;}
  if(!url.startsWith('http')){showToast("⚠️ URL має починатись з http!");return;}
  await push(ref(db,`textbooks/${cls}/${subjKey(subj)}`),{title:title||url,url,addedBy:auth.currentUser.uid});
  document.getElementById('t-tb-title').value='';document.getElementById('t-tb-url').value='';
  showToast("📘 Підручник додано!");loadTextbooksForTeacher();
};
window.removeTextbook=async function(cls,subj,key){
  await remove(ref(db,`textbooks/${cls}/${subjKey(subj)}/${key}`));
  showToast("🗑️ Видалено");loadTextbooksForTeacher();
};
// ══════════ CURRICULUM PLAN (legacy checklist) ══════════
//
// ДВА ПЛАНИ В ОДНОМУ ВУЗЛІ. curriculum_plans/{клас}/{предмет} використовують
// дві різні речі:
//   • цей простий чекліст — плоско: {pushId: {title, hours, covered}}
//   • календарне планування з файлу — вкладено: /meta та /topics
//
// Чекліст перебирав УСІ ключі вузла поспіль. Коли для предмета завантажено
// календарний план, у списку зʼявлялися два порожні рядки «1 год.» —
// це були самі `meta` і `topics`, показані як теми. Ані назви, ані сенсу;
// картка виглядала зламаною, і саме на це вона й була схожа.
//
// Тепер службові ключі відсіюються тут, в одному місці, і рядок без назви
// не малюється взагалі — хай би звідки він узявся.
const PLAN_SYS_KEYS = ['meta', 'topics', 'updatedAt', 'author'];
export function legacyTopics(node){
  const out = [];
  for(const k in (node || {})){
    if(PLAN_SYS_KEYS.includes(k)) continue;
    const t = node[k];
    if(!t || typeof t !== 'object') continue;
    const title = typeof t.title === 'string' ? t.title.trim() : '';
    if(!title) continue;                       // рядок без назви — не тема
    out.push({ key:k, title, hours: parseInt(t.hours, 10) || 1, covered: !!t.covered });
  }
  return out;
}
export function hasCalendarPlan(node){
  return !!(node && node.topics && Object.keys(node.topics).length);
}

async function loadCurriculumTopics(){
  const cls=getActiveClass();const subj=document.getElementById('t-subject').value;if(!subj)return;
  const snap=await get(ref(db,`curriculum_plans/${cls}/${subjKey(subj)}`));
  const container=document.getElementById('curriculum-topics');container.innerHTML='';
  const node=snap.exists()?snap.val():{};
  const list=legacyTopics(node);
  let totalHours=0,coveredHours=0,coveredCount=0;
  const topicCount=list.length;
  list.forEach(t=>{
    totalHours+=t.hours;
    if(t.covered){coveredHours+=t.hours;coveredCount++;}
    container.innerHTML+=`<div class="topic-row ${t.covered?'covered':''}">
      <input type="checkbox" ${t.covered?'checked':''} onchange="toggleTopicCovered('${cls}','${escJs(subj)}','${t.key}',this.checked)">
      <span style="flex:1;${t.covered?'text-decoration:line-through;color:#aaa;':''}">${escHtml(t.title)}</span>
      <span style="font-size:.75rem;color:#888;flex-shrink:0;">${t.hours} год.</span>
    </div>`;
  });
  // Календарний план — окрема картка нижче. Якщо він є, тут пояснюємо це,
  // а не мовчимо: інакше «Тем ще не додано» під завантаженим планом
  // виглядає як втрата даних.
  if(topicCount===0){
    container.innerHTML = hasCalendarPlan(node)
      ? '<p class="empty-msg" style="font-size:.8rem;">Для цього предмета завантажено '
        + '<b>календарне планування</b> — теми беруться звідти, у картці нижче. '
        + 'Цей список — простий чекліст на кілька тем, він потрібен лише коли '
        + 'календарного плану немає.</p>'
      : '<p class="empty-msg" style="font-size:.8rem;">Тем ще не додано.</p>';
  }
  // Smart alert: remaining hours >> remaining topics
  const remainingHours=totalHours-coveredHours;const remainingTopics=topicCount-coveredCount;
  const alertEl=document.getElementById('curriculum-smart-alert');
  if(remainingHours>remainingTopics+4&&topicCount>0){alertEl.style.display='block';alertEl.innerHTML=`⚠️ <b>Увага!</b> Залишок годин (<b>${remainingHours}</b>) перевищує кількість тем (<b>${remainingTopics}</b>) на ${remainingHours-remainingTopics}. Перевірте план або додайте теми.`;}
  else alertEl.style.display='none';
}
// Phase 6: ліміт 5 тем на рік для цього вчителя+предмета+класу. Це legacy-чеклист
// (curriculum_plans/{cls}/{subj}/{pushId} — плоска схема, без вкладеного /topics/,
// на відміну від v3-плану з Excel), тож рахуємо існуючі записи саме за ЦИМ шляхом.
window.addCurriculumTopic=async function(){
  const cls=getActiveClass();const subj=document.getElementById('t-subject').value;
  const title=document.getElementById('new-topic-title').value.trim();const hours=parseInt(document.getElementById('new-topic-hours').value)||1;
  if(!subj||!title){showToast("⚠️ Оберіть предмет і введіть тему!");return;}
  const existSnap=await get(ref(db,`curriculum_plans/${cls}/${subjKey(subj)}`));
  // Рахуємо САМЕ теми чекліста. Раніше бралися всі ключі вузла, тож
  // завантажений календарний план додавав до ліміту двійку зі своїх
  // службових ключів — і п'ять тем перетворювалися на три.
  const existCount=existSnap.exists()?legacyTopics(existSnap.val()).length:0;
  if(existCount>=5){showToast(`⚠️ Ліміт 5 тем на рік для "${subj}" вже досягнуто!`);return;}
  await push(ref(db,`curriculum_plans/${cls}/${subjKey(subj)}`),{title,hours,covered:false});
  document.getElementById('new-topic-title').value='';document.getElementById('new-topic-hours').value='';
  showToast("✅ Тему додано!");loadCurriculumTopics();
};
window.toggleTopicCovered=async function(cls,subj,key,val){
  await set(ref(db,`curriculum_plans/${cls}/${subjKey(subj)}/${key}/covered`),val);
  loadCurriculumTopics();
};
// ══════════ RETAKE REQUESTS (teacher review side) ══════════
window.openRetakeRequestsModal=async function(){
  document.getElementById('retake-modal').style.display='flex';
  const cls=getActiveClass();const snap=await get(ref(db,`retake_requests/${cls}`));
  const list=document.getElementById('retake-list');list.innerHTML='';
  if(!snap.exists()){list.innerHTML='<p class="empty-msg">Запитів немає.</p>';return;}
  const data=snap.val();let html='';
  for(let subj in data){
    for(let date in data[subj]){
      for(let student in data[subj][date]){
        const req=data[subj][date][student];
        const statusColor=req.status==='approved'?'var(--green)':req.status==='rejected'?'var(--red)':'var(--orange)';
        const statusLabel=req.status==='approved'?'✅ Схвалено':req.status==='rejected'?'❌ Відхилено':'⏳ Очікує';
        html+=`<div style="background:#fafafa;border:1px solid #eee;border-radius:9px;padding:11px;margin-bottom:9px;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div><b>${escHtml(stuName(cls,student))}</b> | ${escHtml(subj)} | ${date.split('-').reverse().join('.')}</div>
            <span style="color:${statusColor};font-size:.8rem;font-weight:700;">${statusLabel}</span>
          </div>
          <div style="font-size:.8rem;color:#888;margin-top:5px;">Поточна оцінка: <b>${req.grade||'—'}</b></div>
          ${req.status==='pending'?`<div style="display:flex;gap:7px;margin-top:8px;">
            <button onclick="processRetake('${cls}','${escJs(subj)}','${date}','${escJs(student)}','approved')" style="flex:1;background:var(--green);color:#fff;padding:7px;border-radius:8px;border:none;cursor:pointer;font-weight:700;font-size:.82rem;margin:0;">✅ Дозволити</button>
            <button onclick="processRetake('${cls}','${escJs(subj)}','${date}','${escJs(student)}','rejected')" style="flex:1;background:var(--red);color:#fff;padding:7px;border-radius:8px;border:none;cursor:pointer;font-weight:700;font-size:.82rem;margin:0;">❌ Відхилити</button>
          </div>`:''}
        </div>`;
      }
    }
  }
  list.innerHTML=html||'<p class="empty-msg">Запитів немає.</p>';
};
window.processRetake=async function(cls,subj,date,student,status){
  await set(ref(db,`retake_requests/${cls}/${subj}/${date}/${student}/status`),status);
  showToast(status==='approved'?`✅ Перездачу дозволено: ${stuName(cls,student)}`:`❌ Перездачу відхилено`);
  window.openRetakeRequestsModal();
};
window.closeRetakeModal=function(){document.getElementById('retake-modal').style.display='none';};
// ══════════ ATTENDANCE / CLASS MANAGEMENT ══════════
window.loadStudentsList=function(){get(child(ref(db),`students_list/${getActiveClass()}`)).then(snap=>{const els=['t-student','t-mark-absent-student','t-sticker-student','t-behavior-student','t-student-for-parent'];els.forEach(id=>{const el=document.getElementById(id);if(el)el.innerHTML='<option value="">Учень...</option>';});if(snap.exists())Object.entries(snap.val()).sort((a,b)=>String(a[1]).localeCompare(String(b[1]),'uk')).forEach(([sid,nm])=>{els.forEach(id=>{const el=document.getElementById(id);if(el){const o=document.createElement('option');o.value=sid;o.innerText=nm;el.appendChild(o.cloneNode(true));}});});});};
// Populates #t-mark-absent-lesson with this day's lessons (position in
// getTodayLessonsFlattened is the slotKey), so the teacher marks absence
// for their own lesson instead of the whole day. Falls back to the
// currently selected subject (or a generic "all") when no schedule is
// loaded for the date.
// ── ЧИЇ ЦЕ УРОКИ ────────────────────────────────────────────────
// Учитель математики бачив відсутніх з УСІХ уроків класу — і з читання, і
// з фізкультури. Це і зайве, і збиває: він відповідає за свій урок.
// Класний керівник, навпаки, має бачити весь день.

// Заміни на обрану дату: substitutions/{дата}/{клас}/{слот}. Тримаємо поруч,
// бо урок за заміною — це теж «мій урок», хоч у матриці доступу його немає.
let attSubs={};
async function loadAttSubs(cls,date){
  try{
    const s=await get(child(ref(db),`substitutions/${date}/${cls}`));
    attSubs=s.exists()?(s.val()||{}):{};
  }catch(e){ attSubs={}; }
}

// getTodayLessonsFlattened РОЗГОРТАЄ слоти, у яких кілька уроків (підгрупи),
// тому порядковий номер у пласкому списку не дорівнює номеру слота. Ключем
// відсутності служить перший, ключем заміни — другий. Тримаємо обидва.
function daySlotPairs(dayName){
  const out=[];
  const day=(window.schedule&&window.schedule[dayName])||[];
  day.forEach((slot,slotIdx)=>{
    const items=Array.isArray(slot)?slot:((slot&&Object.keys(slot).length>0)?[slot]:[]);
    items.forEach(item=>out.push({item,slotIdx,flatIdx:out.length}));
  });
  return out;
}

// Уроки цього дня, які веде САМЕ цей учитель, з урахуванням замін.
// Одне джерело правди на дві потреби: список для відміток відсутності
// (там потрібні ключі уроків) і сторінка ДЗ (там потрібні предмети).
// Раніше правило «чий це урок» існувало лише всередині myAttendanceSlots,
// і сторінці ДЗ довелося б його переписати — тобто завести другу копію.
//
// mine=false у результаті означає «веде хтось інший»: класному керівнику
// показуємо всі уроки, але позначаємо, які з них його власні.
export function myLessonsForDay(cls){
  const role=currentUserData&&currentUserData.role;
  const seesAll=(role==='class_teacher'||isMasterTeacher(role));
  const dateStr=document.getElementById('global-date').value;
  const [y,m,d]=String(dateStr||'').split('-');
  if(!y) return [];
  const dn=dayKeys[new Date(y,m-1,d).getDay()];
  const me=String((currentUserData&&currentUserData.email)||'').toLowerCase();
  const anySub=attSubs.any;   // заміна «на предмет», без прив'язки до слота
  const out=[];
  daySlotPairs(dn).forEach(({item,slotIdx,flatIdx})=>{
    // Чергування розгортаємо: «Plastyka / Technika» — це два предмети, і
    // в базу має піти той, який учитель насправді веде. Комбінована назва
    // містить «/» і розірвала б шлях у Firebase (див. expandAltSubjects).
    const names=window.expandAltSubjects?window.expandAltSubjects(item)
                                        :[window.getValidSubjectName(item)].filter(Boolean);
    if(!names.length)return;                         // перерва
    // КЛЮЧ УРОКУ — ЦЕ ЙОГО НОМЕР У РОЗКЛАДІ, А НЕ МІСЦЕ В МАСИВІ.
    //
    // Тут стояло flatIdx+1 — порядкове місце в пласкому списку дня. Але в
    // тому списку разом з уроками лежать перерви й обіди, і кожне з них
    // це місце займає. При звичайному чергуванні «урок — перерва» другий
    // урок опинявся на місці 3, третій — на 5.
    //
    // Помітити було важко, бо у випадайці стояв ПРАВИЛЬНИЙ номер: підпис
    // брався з item.number, а значення — з індексу. Учитель обирав
    // «2. Математика», у базу йшло 3, і батько читав «Урок 3».
    //
    // У перерв number — пробіл, але сюди вони не доходять: вихід по
    // порожньому names стоїть рядком вище. Запасне flatIdx+1 лишається на
    // випадок розкладу без номерів — там зсув можливий, зате ключ буде.
    const key=String(item.number||(flatIdx+1));
    names.forEach(sn=>{
    const sub=attSubs[slotIdx];
    let mine, viaSub=false;
    if(sub){
      // Урок веде заміна: він у того, кого призначили, і НЕ у заміненого.
      mine=(String(sub.subEmail||'').toLowerCase()===me); viaSub=true;
    }else if(anySub&&String(anySub.subject||'').trim().toLowerCase()===sn.trim().toLowerCase()){
      mine=(String(anySub.subEmail||'').toLowerCase()===me); viaSub=true;
    }else{
      mine=!!window.isSubjectAllowed(cls,sn);
    }
      out.push({subject:sn, key, number:item.number||(flatIdx+1), time:item.time||'', mine, viaSub, seesAll});
    });
  });
  return out;
}

// Набір ключів уроків цього вчителя. null — обмежувати не треба.
function myAttendanceSlots(cls){
  const role=currentUserData&&currentUserData.role;
  if(role==='class_teacher'||isMasterTeacher(role))return null;
  return new Set(myLessonsForDay(cls).filter(l=>l.mine).map(l=>l.key));
}

function buildMarkAbsentLessonOptions(){
  const sel=document.getElementById('t-mark-absent-lesson');
  if(!sel)return;
  const dateStr=document.getElementById('global-date').value;
  const [y,m,d]=dateStr.split('-');const dv=new Date(y,m-1,d);const dn=dayKeys[dv.getDay()];
  const flat=window.getTodayLessonsFlattened(dn);
  const mine=myAttendanceSlots(getActiveClass());
  sel.innerHTML='';
  if(flat.length>0){
    // «УВЕСЬ ДЕНЬ» — ПЕРШИМ ПУНКТОМ, і саме класному керівникові.
    //
    // Дитини часто немає не на уроці, а взагалі: захворіла, поїхала. Тоді
    // відмічати по одному уроку — безглузда робота. Раніше цей варіант
    // з'являвся, лише якщо на день немає розкладу, тож у звичайний день
    // його просто не існувало.
    //
    // Предметникові його не даємо: пропуск усього дня — це рішення про
    // весь день дитини, а він відповідає за свій урок. Він і бачить лише
    // свої уроки — див. myAttendanceSlots.
    if(!mine) sel.innerHTML='<option value="all">Увесь день</option>';

    // ПЕРЕРВИ У СПИСОК НЕ ЙДУТЬ. getValidSubjectName повертає для них null,
    // а запасне «Урок» перетворювало кожну перерву на пункт меню: між
    // математикою та читанням висіли «2. Урок», «4. Урок», ще й із чужими
    // номерами (у перерви свого номера немає, тож підставлявся порядковий).
    // Та сама умова стоїть у myAttendanceSlots — обидва місця мають
    // однаково розуміти, що таке урок.
    // НОМЕР УРОКУ ЛИШЕ З ОДНОГО ДЖЕРЕЛА.
    //
    // Раніше підпис брався з l.number, а значення — з індексу в масиві,
    // де перерви теж займають місця. Два різні числа під одним пунктом:
    // учитель бачив «2», у базу йшло «3». Тепер обидва з key, і розійтися
    // їм більше нема як. Та сама формула стоїть у myLessonsForDay —
    // звідки приходить mine, і порівнювати їх треба однаковими ключами.
    const shown=flat.map((l,i)=>({sn:window.getValidSubjectName(l),key:String(l.number||(i+1))}))
      .filter(({sn})=>!!sn)
      .filter(({key})=>!mine||mine.has(key));
    shown.forEach(({sn,key})=>{
      sel.innerHTML+=`<option value="${escHtml(key)}">${escHtml(key)}. ${escHtml(sn)}</option>`;
    });
    if(!shown.length&&mine)
      sel.innerHTML='<option value="all">Увесь день (ваших уроків цього дня немає)</option>';
  } else {
    // Розкладу на цей день немає — відмічаємо ВЕСЬ день.
    //
    // Раніше сюди підставлявся предмет із вкладки «Журнал», і він ставав
    // ключем уроку в записі про відсутність. Тобто те, що вчитель обрав
    // на іншому екрані, мовчки визначало, до якого «уроку» прив'яжеться
    // пропуск. Вигадувати урок, якого немає в розкладі, ми не маємо права.
    sel.innerHTML = '<option value="all">Увесь день (розкладу на цей день немає)</option>';
  }
}
window.teacherMarkAbsent=function(){
  const st=document.getElementById('t-mark-absent-student').value;
  const rs=document.getElementById('t-mark-absent-reason').value;
  const slotKey=document.getElementById('t-mark-absent-lesson')?.value||'all';
  const date=document.getElementById('global-date').value;
  if(!st)return alert('Оберіть учня!');
  const status=rs==='запізнення'?'late':'absent';
  // .catch обов'язковий: якщо відмітка не запишеться, учитель має це
  // побачити одразу — інакше він певен, що батьків уже сповістили.
  set(ref(db,`attendance/${getActiveClass()}/${date}/${st}/${slotKey}`),{status,reason:rs,markedBy:'teacher'})
  .catch(e=>{alert('Не вдалося відмітити: '+e.message);throw e;})
  .then(()=>{
    showToast(`✅ ${stuName(getActiveClass(), st)} відмічений.`);
    // Сповіщення батькам — саме заради цього випадку push і потрібен:
    // дитина не дійшла до школи, а сім'я про це ще не знає
    // Предмет у сповіщенні беремо з обраного УРОКУ, а не з журналу:
  // інакше батько отримає «відсутній на Читанні» тільки тому, що вчитель
  // хвилину тому дивився Читання на іншій вкладці.
  const lessonSel=document.getElementById('t-mark-absent-lesson');
  const lessonLabel=lessonSel&&lessonSel.selectedIndex>=0
    ? (lessonSel.options[lessonSel.selectedIndex].text||'').replace(/^\d+\.\s*/,'') : '';
  notifyEvent('absence',{class:getActiveClass(),studentName:stuName(getActiveClass(),st),
    subject:(slotKey==='all'?'':lessonLabel)});
    logAction('attendance',{cls:getActiveClass(),target:stuName(getActiveClass(),st),date,value:status,reason:rs});
    document.getElementById('t-mark-absent-student').value='';
  });
};
window.addStudent=function(){const name=document.getElementById('new-student-name').value.trim();const emailEl=document.getElementById('new-student-email');const email=emailEl?emailKey(emailEl.value):'';if(name){push(ref(db,`students_list/${getActiveClass()}`),name).then(()=>{if(email)set(ref(db,`student_links/${email}`),{studentName:name,class:getActiveClass()});alert("Учня додано!");loadStudentsList();document.getElementById('new-student-name').value='';if(emailEl)emailEl.value='';});}};
// Прив'язка ДОДАЄ дитину до списку, а не замінює його: в одних батьків у школі
// може вчитися кілька дітей. Раніше другий виклик мовчки затирав першу дитину.
// ══════════════════════════════════════════════════════════════════
//  ПРИВʼЯЗКА ПОШТИ БАТЬКІВ ДО УЧНЯ
// ══════════════════════════════════════════════════════════════════
//
// ЩО ЗМІНИЛОСЯ. Раніше тут стояла транзакція на ВЕСЬ вузол
// parent_links/{пошта}: прочитати, дописати дитину, записати назад.
// Для директора це працювало, а для класного керівника — ні, і кнопка
// просто відмовляла в правах. Розширити право на цілий вузол не можна:
// поруч із дітьми там лежить profile — телефони й адреса родини, а в
// списку дітей можуть бути діти ІНШИХ класів.
//
// Тому пишемо не вузол, а ОДИН вільний слот у списку дітей. Правило бази
// дозволяє лише створення (!data.exists()), лише у свій клас і лише під
// тим імʼям, під яким учень записаний у списку класу.
//
// Побічна користь: транзакція більше не потрібна. Якщо два вчителі
// одночасно цілять у той самий слот, другий отримає відмову, а не тихо
// затре першого, — і ми просто спробуємо наступний вільний.
const MAX_KIDS = 6;          // стільки ж, скільки звіряє правило users

// Сирі ключі списку дітей — саме ключі, а не значення: нам потрібно
// знати, які індекси вже зайняті.
function rawKidKeys(node){
  const c = node && node.children;
  if(!c) return [];
  return Array.isArray(c) ? c.map((v,i)=>v?String(i):null).filter(Boolean)
                          : Object.keys(c);
}
function firstFreeSlot(node){
  const used = new Set(rawKidKeys(node));
  for(let i=0;i<MAX_KIDS;i++) if(!used.has(String(i))) return String(i);
  return null;
}

window.linkParent=async function(){
  const raw=document.getElementById('parent-email').value.trim().toLowerCase();
  const e=emailKey(raw);
  const st=document.getElementById('t-student-for-parent').value;
  const cls=getActiveClass();
  const role=document.getElementById('t-parent-role').value;
  if(!e||!st)return alert("Оберіть учня та Email");
  const stNm=stuName(cls,st);
  try{
    const snap=await get(ref(db,`parent_links/${e}`));
    const node=snap.exists()?(snap.val()||{}):{};

    // Старий формат: дитина лежить у корені вузла, списку children немає.
    // Перекласти її в список — означає записати чужий, можливо, клас, а на
    // це в класного керівника права немає (і не має бути). Кажемо прямо.
    if(!node.children && node.studentName){
      return alert('Цей запис зроблено в старому форматі, і додати до нього '
        + 'другу дитину може лише адміністрація школи.\n\nПередайте їй пошту '
        + `${raw} та імʼя учня.`);
    }

    const kids=normalizeChildren(node);
    if(kids.some(k=>k.studentId===st||(k.studentName===stNm&&k.class===cls)))
      return alert("Ця дитина вже привʼязана.");
    const slot=firstFreeSlot(node);
    if(slot===null)
      return alert(`До цієї пошти вже привʼязано ${MAX_KIDS} дітей — більше портал не веде.`);

    await set(ref(db,`parent_links/${e}/children/${slot}`),
      {studentId:st,studentName:stNm,class:cls,role});
    if(window.invalidateParentLinks) window.invalidateParentLinks();

    const total=kids.length+1;
    // Якщо батьки вже заходили — оновлюємо і їхній профіль.
    //
    // Читати users має право лише директор: там персональні дані всіх
    // людей школи. Привʼязку класний керівник зробити може, а оновити
    // чужий профіль — ні. Раніше ця відмова летіла нагору й привʼязка
    // виглядала як провал, хоча головне вже збереглося.
    let profileSynced = true;
    try{
      const us = await getUsersSnap();
      if(us.exists()){
        const u = us.val();
        for(const uid in u){
          if((u[uid].email||'').toLowerCase() === raw && u[uid].role === 'parent'){
            await update(ref(db, `users/${uid}`),
              { children: kids.concat([{studentId:st,studentName:stNm,class:cls,role}]) });
          }
        }
      }
    }catch(err){ profileSynced = false; }
    const syncNote = profileSynced ? ''
      : '\n\nПрофіль батьків оновиться, коли вони наступного разу зайдуть у портал.';
    alert((total>1
      ? `✅ Додано. Тепер до ${raw} привʼязано дітей: ${total}. Батьки зможуть перемикатися між ними у профілі.`
      : `✅ Email привʼязано!`) + syncNote);
    document.getElementById('parent-email').value='';
  }catch(err){
    // Найімовірніша відмова — не свій клас. Кажемо це словами, а не кодом.
    const denied=/permission[_ ]denied/i.test(err&&err.message||'');
    alert(denied
      ? 'Немає прав на цю дію.\n\nПривʼязувати батьків можна лише до учнів '
        + 'СВОГО класу — і це має бути клас, де ви класний керівник. '
        + 'Якщо клас ваш, зверніться до адміністрації: можливо, призначення '
        + 'класного керівника ще не внесено в портал.'
      : 'Помилка: '+err.message);
  }
};
// Підпис над списком. Раніше тут завжди стояло «сьогодні», навіть коли
// вгорі обрано інший день, — учитель бачив чуже слово й вирішував, що
// минулу дату відмітити не можна. Тепер дата видно прямо в заголовку.
function setAttHeader(limited){
  const h=document.getElementById('t-att-header');
  const hint=document.getElementById('t-att-hint');
  const d=document.getElementById('global-date').value;
  const human=d?d.split('-').reverse().join('.'):'';
  const isToday=d===localDateString;   // це рядок дати, а не функція
  if(h)h.innerText=`🚨 Відвідуваність ${limited?'на ваших уроках':'класу'} — `
    +(isToday?`сьогодні, ${human}`:human);
  if(hint)hint.innerHTML='Щоб відмітити за інший день — змініть дату вгорі сторінки, у полі «📅 Оберіть дату».'
    +(limited?' Показано лише ваші уроки; класний керівник бачить усі.':'');
}

// ЛІЧИЛЬНИК ПОКОЛІНЬ. Стару підписку знімаємо на початку, а нову ставимо
// після await (читання замін). Учитель клацає стрілку дати двічі поспіль —
// виклики переплітаються: обидва знімають ту саму стару підписку, потім
// перший записує свою в teacherAttendanceListener, а другий її затирає.
// Підписка першого лишається живою назавжди — зняти її вже нічим.
//
// Для вчителя мистецької школи й директора це не одна підписка, а
// одинадцять (по класу на кожну), тож кожне таке переплетіння лишає
// одинадцять слухачів, які довічно перемальовують список.
let attGen = 0;
export async function listenTeacherAttendance(){
  const gen = ++attGen;
  const date=document.getElementById('global-date').value;const list=document.getElementById('t-attendance-list');
  if(teacherAttendanceListener){teacherAttendanceListener();teacherAttendanceListener=null;}
  // Заміни читаємо ДО побудови списків: без них учитель, поставлений на
  // заміну, не побачив би уроку, який сьогодні веде саме він.
  await loadAttSubs(getActiveClass(),date);
  if(gen !== attGen) return;   // нас обігнав пізніший виклик
  buildMarkAbsentLessonOptions();
  if(currentUserData.role==='art_school_teacher'){
    document.getElementById('t-att-header').innerText="🚨 Відсутні (Вся школа):";
    // Раніше тут висів слухач на ВЕСЬ вузол attendance: кожна відмітка
    // будь-де в школі змушувала браузер перекачати всю історію. Тепер
    // 11 маленьких слухачів — по одному на клас, лише на обрану дату.
    const allDay = {};
    const unsubs = [];
    const renderAll = () => {
      let h = '';
      for(let i=1;i<=11;i++){
        const d = allDay[`class_${i}`];
        if(!d) continue;
        for(const st in d){
          const slots = d[st];
          for(const sk in slots){
            const r = slots[sk];
            if(!r?.status) continue;
            const bc = r.status==='late'?'badge-late':'badge-absent';
            const lb = r.status==='late'?'Запізнення':'Відсутність';
            const mi = r.markedBy==='teacher'?'👨‍🏫':(r.markedBy==='student'?'🎒':'👪');
            h += `<li style="margin-bottom:7px;border-bottom:1px dashed #eee;padding-bottom:4px;"><span style="font-size:.72rem;background:var(--teal);color:#fff;padding:2px 5px;border-radius:4px;margin-right:4px;">${i} Кл</span> <b>${escHtml(stuName(`class_${i}`, st))}</b> <span class="badge ${bc}">${lb}</span> <span style="font-size:.72rem;color:#888;">${escHtml(formatAttendanceSlotLabel(sk))} ${mi}</span></li>`;
          }
        }
      }
      list.innerHTML = h || '<li class="empty-msg">Усі на місці.</li>';
    };
    for(let i=1;i<=11;i++){
      const c = `class_${i}`;
      unsubs.push(onValue(ref(db,`attendance/${c}/${date}`), snap=>{
        allDay[c] = snap.exists() ? snap.val() : null;
        renderAll();
      }, err=>{
        list.innerHTML = `<li class="empty-msg" style="color:var(--red);">Не вдалося прочитати відвідуваність: ${escHtml(err.message||'')}</li>`;
      }));
    }
    teacherAttendanceListener = () => unsubs.forEach(u=>u());
  }else{
    const cls=getActiveClass();
    const mine=myAttendanceSlots(cls);
    setAttHeader(!!mine);
    teacherAttendanceListener=onValue(ref(db,`attendance/${cls}/${date}`),snap=>{list.innerHTML='';if(snap.exists()){const d=snap.val();let h='';for(let st in d){const slots=d[st];for(let sk in slots){const r=slots[sk];if(!r?.status)continue;
      // Чужий урок ховаємо. «all» лишаємо всім: це заявка батьків на цілий
      // день — дитини не буде і на вашому уроці теж.
      if(mine&&sk!=='all'&&!mine.has(String(sk)))continue;const bc=r.status==='late'?'badge-late':'badge-absent';const lb=r.status==='late'?'Запізнення':'Відсутність';const markerIcon=r.markedBy==='teacher'?'👨‍🏫':(r.markedBy==='student'?'🎒':'👪');h+=`<li style="margin-bottom:7px;border-bottom:1px dashed #eee;padding-bottom:4px;"><b>${escHtml(stuName(cls, st))}</b> <span class="badge ${bc}">${lb}</span> <span style="font-size:.72rem;color:#888;">${escHtml(formatAttendanceSlotLabel(sk))} ${markerIcon}</span> <i style="font-size:.78rem;color:#666;">(${escHtml(r.reason)})</i></li>`;}}list.innerHTML=h||'<li class="empty-msg">Усі на місці.</li>';}else list.innerHTML='<li class="empty-msg">Усі на місці.</li>';}, err=>{list.innerHTML=`<li class="empty-msg" style="color:var(--red);">Не вдалося прочитати відвідуваність: ${escHtml(err.message||'')}</li>`;});
  }
}
window.listenTeacherAttendance=listenTeacherAttendance;
// ══════════ TEACHER DASHBOARD ══════════
export function loadTeacherDashboard(){
  renderNewsFeed('t-news-feed');
  const cls=getActiveClass();const uid=auth.currentUser.uid;
  // Retake counter
  get(ref(db,`retake_requests/${cls}`)).then(snap=>{if(snap.exists()){const d=snap.val();let cnt=0;for(let s in d)for(let dt in d[s])for(let st in d[s][dt])if(d[s][dt][st].status==='pending')cnt++;document.getElementById('t-retake-counter').innerText=cnt;}else document.getElementById('t-retake-counter').innerText=0;});
  Promise.all([get(child(ref(db),`reactions/${cls}`)),get(child(ref(db),`authors/${cls}`)),get(child(ref(db),`comments/${cls}`))]).then(([rs,as,cs])=>{
    let cnt=0;window.myDetailedReactions=[];
    if(rs.exists()&&as.exists()){const reactions=rs.val();const authors=as.val();const comments=cs.exists()?cs.val():{};for(let d in reactions)for(let s in reactions[d])if(authors[d]&&authors[d][s]===uid)for(let st in reactions[d][s]){cnt++;let emoji=reactions[d][s][st];let cm=(comments[d]&&comments[d][s]&&comments[d][s][st])?comments[d][s][st]:'Без коментаря';window.myDetailedReactions.push({date:d,subject:s,student:st,emoji,comment:cm});}window.myDetailedReactions.sort((a,b)=>new Date(b.date)-new Date(a.date));}
    document.getElementById('t-karma-counter').innerText=cnt;
  });
  if(currentUserData.role!=='art_school_teacher'){const date=document.getElementById('global-date').value;renderHwList(cls,date,'t-daily-hw-list');}
  renderBirthdays('t-birthdays',cls,'');
  // Зведення по басейну й автобусу — справа класного керівника: він веде
  // клас. Предметникові воно ні до чого, та й правила бази його не пустять.
  const actCard=document.getElementById('t-activities-card');
  if(actCard){
    const isCT=currentUserData.role==='class_teacher'||isMasterTeacher(currentUserData.role);
    actCard.style.display=isCT?'block':'none';
    if(isCT&&window.renderActivitySummary)window.renderActivitySummary('t-activities','class');
  }
  listenTeacherAttendance();
}
window.loadTeacherDashboard=loadTeacherDashboard;
window.giveStickerToStudent=async function(){const st=document.getElementById('t-sticker-student').value;
  // Наліпка живе на вкладці «Клас» і не має залежати від предмета, обраного
  // на вкладці «Урок»: це різні екрани, і людина не бачить того селектора.
  const subj=actionSubject('t-sticker-subject');
  const date=document.getElementById('global-date').value;const cls=getActiveClass();
  if(!st||!subj){showToast("⚠️ Оберіть учня та предмет");return;}await set(ref(db,`stickers/${cls}/${st}/${date}_${subj}`),true);showToast(`🌟 Наліпка: ${st}!`);};
window.saveComment=async function(){const st=document.getElementById('t-student').value;const subj=document.getElementById('t-subject-for-comment').value;const cm=document.getElementById('t-comment').value.trim();const date=document.getElementById('global-date').value;const cls=getActiveClass();if(!st||!subj){showToast("⚠️ Оберіть учня та предмет!");return;}if(!cm){showToast("⚠️ Введіть коментар!");return;}await set(ref(db,`comments/${cls}/${date}/${subj}/${st}`),cm);document.getElementById('t-comment').value='';showToast(`💬 Коментар збережено: ${st}`);
  // Сам текст коментаря в сповіщення не кладемо — воно видно на екрані
  // блокування, а коментар може бути делікатним
  notifyEvent('comment',{class:cls,studentName:stuName(cls,st),subject:subj});
  logAction('comment',{cls,target:stuName(cls,st),subject:subj,date});};
// ══════════ EXAMS ══════════
window.openExamsCalendar=function(){document.getElementById('exams-modal').style.display='flex';document.getElementById('exam-class-label').innerText=document.getElementById('t-class-selector').options[document.getElementById('t-class-selector').selectedIndex].text;document.getElementById('exams-day-details').style.display='none';const mi=document.getElementById('exam-month-select');const dp=document.getElementById('global-date').value.split('-');mi.value=`${dp[0]}-${dp[1]}`;renderExamsCalendar();};
window.closeExamsModal=function(){document.getElementById('exams-modal').style.display='none';};
window.renderExamsCalendar=function(){const cls=getActiveClass();const ym=document.getElementById('exam-month-select').value;if(!ym)return;const[y,m]=ym.split('-');get(child(ref(db),`exams/${cls}/${y}-${m}`)).then(snap=>{const d=snap.exists()?snap.val():{};let h='<div class="cal-grid">';['Пн','Вт','Ср','Чт','Пт','Сб','Нд'].forEach(d2=>h+=`<div class="cal-header">${d2}</div>`);const dim=new Date(y,parseInt(m),0).getDate();let fd=new Date(y,parseInt(m)-1,1).getDay();if(fd===0)fd=7;for(let i=1;i<fd;i++)h+=`<div></div>`;for(let i=1;i<=dim;i++){const cd=`${y}-${m}-${String(i).padStart(2,'0')}`;const cnt=d[cd]?Object.keys(d[cd]).length:0;const cc=cnt===1?'has-1':cnt>=2?'has-2':'';h+=`<div class="cal-day ${cc}" onclick="manageDayExams('${cd}')">${i}<br><small style="font-size:.68rem;">${cnt>0?cnt+' к.р.':''}</small></div>`;}h+='</div>';document.getElementById('exams-cal-container').innerHTML=h;});};
window.manageDayExams=function(ds){const cls=getActiveClass();const dd=document.getElementById('exams-day-details');dd.style.display='block';get(child(ref(db),`exams/${cls}/${ds.substring(0,7)}/${ds}`)).then(snap=>{let ex=snap.exists()?snap.val():{};let lh='';for(let s in ex){const me=ex[s]===auth.currentUser.uid;const db2=me?`<button onclick="deleteExam('${ds}','${escJs(s)}')" style="background:none;border:none;color:var(--red);cursor:pointer;font-weight:700;padding:0 4px;width:auto;margin:0;font-size:1.1rem;">✖</button>`:'';lh+=`<li style="margin-bottom:7px;display:flex;justify-content:space-between;align-items:center;background:#fff;padding:7px 11px;border-radius:8px;border:1px solid #eee;"><span><b>${s}</b></span>${db2}</li>`;}let h=`<h4 style="margin-top:0;color:#d35400;border-bottom:1px dashed var(--orange);padding-bottom:9px;">Контрольні: ${ds.split('-').reverse().join('.')}</h4>`;h+=`<ul style="padding-left:0;list-style:none;margin-bottom:13px;">${lh||'<li class="empty-msg">Жодної</li>'}</ul>`;const[yy,mm,dd2]=ds.split('-');const dn=dayKeys[new Date(yy,mm-1,dd2).getDay()];let ds2=new Set();window.getTodayLessonsFlattened(dn).forEach(item=>{const sn=window.getValidSubjectName(item);if(sn)ds2.add(sn);});let fe=currentUserData.role==='teacher'?[...ds2].filter(s=>window.isSubjectAllowed(cls,s)).sort():[...ds2].sort();let so=fe.map(s=>`<option value="${s}">${s}</option>`).join('');if(!so){so='<option disabled>Немає предметів</option>';}h+=`<div style="display:flex;gap:9px;"><select id="exam-add-subj" style="flex:1;margin:0;">${so}</select><button style="background:var(--green);color:#fff;width:auto;padding:9px 13px;margin:0;" onclick="addExam('${ds}')">Додати</button></div>`;dd.innerHTML=h;});};
window.addExam=function(ds){const s=document.getElementById('exam-add-subj').value;if(!s)return;const cls=getActiveClass();const ym=ds.substring(0,7);get(child(ref(db),`exams/${cls}/${ym}/${ds}`)).then(snap=>{let cnt=snap.exists()?Object.keys(snap.val()).length:0;if(cnt>=2)return alert('❌ Ліміт: більше 2 контрольних не можна!');set(ref(db,`exams/${cls}/${ym}/${ds}/${s}`),auth.currentUser.uid).then(()=>{renderExamsCalendar();manageDayExams(ds);});});};
window.deleteExam=function(ds,s){const cls=getActiveClass();remove(ref(db,`exams/${cls}/${ds.substring(0,7)}/${ds}/${s}`)).then(()=>{renderExamsCalendar();manageDayExams(ds);});};
// ══════════ REACTIONS & WRAPPED (teacher side) ══════════
window.showReactionsDetails=function(){document.getElementById('reactions-modal').style.display='flex';const list=document.getElementById('reactions-list');list.innerHTML='';if(!window.myDetailedReactions?.length){list.innerHTML='<p class="empty-msg" style="text-align:center;">Немає реакцій.</p>';return;}let h='<ul style="list-style:none;padding:0;margin:0;">';window.myDetailedReactions.forEach(r=>{const[y,m,d]=r.date.split('-');h+=`<li style="background:#fdfbfb;border:1px solid #eee;border-radius:8px;padding:11px;margin-bottom:9px;"><div style="display:flex;justify-content:space-between;border-bottom:1px dashed #ddd;padding-bottom:4px;margin-bottom:7px;"><span style="font-weight:700;color:var(--teal);">${r.student}</span><span style="font-size:1.3rem;">${r.emoji}</span></div><div style="font-size:.78rem;color:#888;margin-bottom:4px;">📅 ${d}.${m}.${y} | 📚 ${escHtml(r.subject)}</div><div style="font-size:.88rem;color:#444;background:#f0f8ff;padding:7px;border-radius:6px;font-style:italic;">"${escHtml(r.comment)}"</div></li>`;});h+='</ul>';list.innerHTML=h;};
window.closeReactionsModal=function(){document.getElementById('reactions-modal').style.display='none';};
window.showWeeklyWrapped=function(){confetti({particleCount:200,spread:90,origin:{y:0.6},zIndex:2000});document.getElementById('wrapped-modal').style.display='flex';document.body.style.overflow='hidden';const uid=auth.currentUser.uid;const cls=getActiveClass();Promise.all([get(child(ref(db),`homeworks/${cls}`)),get(child(ref(db),`comments/${cls}`)),get(child(ref(db),`stickers/${cls}`)),get(child(ref(db),`authors/${cls}`))]).then(([hs,cs,ss,as])=>{const a=as.exists()?as.val():{};let hw=0;if(hs.exists()){const d=hs.val();for(let dt in d)for(let s in d[dt])if(a[dt]&&a[dt][s]===uid)hw++;}document.getElementById('w-hw').innerText=hw;let com=0;if(cs.exists()){const d=cs.val();for(let dt in d)for(let s in d[dt])if(a[dt]&&a[dt][s]===uid)com+=Object.keys(d[dt][s]).length;}document.getElementById('w-com').innerText=com;let st=0;if(ss.exists()){const d=ss.val();for(let student in d)for(let k in d[student]){const[dt,s]=k.split('_');if(a[dt]&&a[dt][s]===uid)st++;}}document.getElementById('w-st').innerText=st;});};
window.closeModal=function(){document.getElementById('wrapped-modal').style.display='none';document.body.style.overflow='';};
// ══════════ PHASE 7: STICKER STATS ══════════
// Reuses #reactions-modal's markup/structure (new modal id: sticker-stats-modal,
// new list id: sticker-stats-list). One get() on the whole stickers/{cls} subtree
// instead of per-student calls — Object.keys(stickersData[student]||{}).length is
// the same "count all keys" the prompt asks for, just batched.
window.openStickerStatsModal=async function(){
  try{
  document.getElementById('sticker-stats-modal').style.display='flex';
  const list=document.getElementById('sticker-stats-list');
  list.innerHTML='<p class="empty-msg" style="text-align:center;">⏳ Завантаження...</p>';
  const cls=getActiveClass();
  const [stuSnap,stSnap]=await Promise.all([
    get(child(ref(db),`students_list/${cls}`)),
    get(child(ref(db),`stickers/${cls}`))
  ]);
  const students=stuSnap.exists()?Object.entries(stuSnap.val()).map(([sid,nm])=>({sid,nm:String(nm)})):[];
  const stickersData=stSnap.exists()?stSnap.val():{};
  if(students.length===0){list.innerHTML='<p class="empty-msg" style="text-align:center;">Учнів немає.</p>';return;}
  const goal=stickerGoal(cls);
  renderStickerGoalBox(cls, goal);
  const stats=students.map(({sid,nm})=>({name:nm,count:stickersData[sid]?Object.keys(stickersData[sid]).length:0}));
  stats.sort((a,b)=>b.count-a.count);
  let h='<ul style="list-style:none;padding:0;margin:0;">';
  stats.forEach((s,i)=>{
    const pct=Math.min((s.count/goal)*100,100);
    const medal=i===0?'🥇 ':i===1?'🥈 ':i===2?'🥉 ':'';
    h+=`<li style="background:#fdfbfb;border:1px solid #eee;border-radius:8px;padding:11px;margin-bottom:9px;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="font-weight:700;color:var(--teal);">${medal}${s.name}</span>
        <span style="font-size:1.05rem;font-weight:800;color:#f39c12;">🌟 ${s.count}</span>
      </div>
      <div style="background:#eee;border-radius:6px;height:8px;margin-top:7px;overflow:hidden;">
        <div style="background:linear-gradient(90deg,#f39c12,#f1c40f);height:100%;width:${pct}%;"></div>
      </div>
      <div style="font-size:.72rem;color:#888;margin-top:3px;text-align:right;">${s.count}/${goal} до призу</div>
    </li>`;
  });
  h+='</ul>';
  list.innerHTML=h;
  }catch(err){
    // Читання не вдалося. Без цього блоку на екрані назавжди лишався б
    // напис-заглушка, і людина не знала б, зламалося чи просто повільно.
    console.error("teacher.js → sticker-stats-list", err);
    const _b=document.getElementById("sticker-stats-list");
    if(_b)_b.innerHTML='<p class="empty-msg" style="color:var(--red);">Не вдалося завантажити: '+((err&&err.message)||'невідома помилка')+'</p>';
  }
};

// ── МЕТА НАЛІПОК ──────────────────────────────────────────────
// Скільки наліпок до призу — вирішує класний керівник свого класу.
// Раніше число 30 було зашите в коді на всю школу, хоча для першого
// й для дев'ятого класу «багато» — це різні числа.
//
// Хто змінює: класний керівник цього класу, директор, майстер-роль.
// Учитель-предметник бачить число, але не міняє: приз — справа класу.
function canSetStickerGoal(cls){
  const role = currentUserData && currentUserData.role;
  if(['director','administrator','master_class_teacher'].includes(role)) return true;
  return !!(window.__isClassTeacherOf && window.__isClassTeacherOf === cls);
}

window.renderStickerGoalBox = function(cls, goal){
  const box = document.getElementById('sticker-goal-box');
  const inp = document.getElementById('sticker-goal-input');
  const note = document.getElementById('sticker-goal-note');
  if(!box || !inp) return;
  const may = canSetStickerGoal(cls);
  inp.value = goal;
  inp.disabled = !may;
  const btn = box.querySelector('button');
  if(btn) btn.style.display = may ? '' : 'none';
  if(note) note.textContent = may
    ? 'Це число бачать учні та батьки на смужці прогресу. Змінюється лише для цього класу.'
    : 'Мету призу задає класний керівник цього класу.';
};

window.saveStickerGoal = async function(){
  const cls = getActiveClass();
  const inp = document.getElementById('sticker-goal-input');
  const n = parseInt(inp.value, 10);
  if(!Number.isFinite(n) || n < 1 || n > 500)
    return alert('Вкажіть число від 1 до 500.');
  try{
    await set(ref(db, `sticker_goal/${cls}`), n);
    logAction('settings', { value: `мета наліпок ${cls}: ${n}` });
    showToast(`✅ Мета: ${n} наліпок`);
    openStickerStatsModal();
  }catch(e){
    alert('Не вдалося зберегти: ' + e.message
      + '\n\nЯкщо тут «PERMISSION_DENIED» — перевірте, чи опубліковано правила бази: вузол sticker_goal новий.');
  }
};

window.closeStickerStatsModal=function(){document.getElementById('sticker-stats-modal').style.display='none';};

// ══════════════════════════════════════════════════════════════════
//  ДЗ НА ДЕНЬ: усі уроки вчителя одним екраном
// ══════════════════════════════════════════════════════════════════
//
// НАВІЩО. Учитель заповнює не «урок», а кінець дня: у нього чотири уроки,
// і він хоче пройти їх поспіль. Досі для кожного треба було перемикати
// предмет угорі, заповнювати, зберігати й перемикати знову — при чотирьох
// уроках це чотири кола по тій самій сторінці.
//
// Тут усі його уроки цього дня — згорнутими рядками. Заповнене позначено
// галочкою, після збереження рядок згортається сам. Тема уроку лишається
// на подробній сторінці: вона тягне за собою план і облік годин з
// лімітами, а це обережна операція, і мішати її зі швидким заповненням
// не варто.
//
// ЩО ТУТ НЕОЧЕВИДНОГО. Якщо відкрити три рядки, поправити всі три й
// зберегти один — два лишаться незбереженими. Тому кожен рядок стежить за
// змінами й показує «змінено, не збережено», а сторінка попереджає при
// спробі піти.

let hwDayState = {};   // {предмет: {saved:bool, dirty:bool}}

export async function renderTeacherHwDay(){
  const box=document.getElementById('t-hw-day');
  if(!box) return;
  const cls=getActiveClass();
  const date=document.getElementById('global-date').value;
  if(!cls||!date){ box.innerHTML='<p class="empty-msg">Оберіть клас і дату.</p>'; return; }
  box.innerHTML='<p class="empty-msg">Завантаження...</p>';

  try{
    // Заміни потрібні ДО побудови списку: учитель на заміні має бачити
    // урок, який сьогодні веде саме він.
    await loadAttSubs(cls,date);
    // СПАРЕНІ УРОКИ — ОДИН РЯДОК.
    //
    // Математика двічі поспіль — звична річ. Але завдання в базі лежить
    // за предметом і датою: homeworks/{клас}/{дата}/{предмет}, тобто
    // місце для нього ОДНЕ. Два рядки писали б у той самий вузол і тихо
    // затирали один одного, а вчитель бачив би два однакових бланки й не
    // розумів, чому зникає введене. Тому зводимо в один рядок і показуємо
    // обидва номери уроків.
    const byName=new Map();
    myLessonsForDay(cls).filter(l=>l.mine).forEach(l=>{
      const prev=byName.get(l.subject);
      if(prev){ prev.numbers.push(l.number); prev.viaSub=prev.viaSub||l.viaSub; }
      else byName.set(l.subject, {...l, numbers:[l.number]});
    });
    const lessons=[...byName.values()];
    if(!lessons.length){
      box.innerHTML='<p class="empty-msg">Цього дня у вас немає уроків у цьому класі.</p>';
      return;
    }
    // Одне читання на весь день і одне на підручники — замість читання
    // на кожен предмет окремо.
    const [hwSnap,tbSnap]=await Promise.all([
      get(child(ref(db),`homeworks/${cls}/${date}`)),
      get(child(ref(db),`textbooks/${cls}`)).catch(()=>null)
    ]);
    const saved=hwSnap.exists()?(hwSnap.val()||{}):{};
    const allBooks=(tbSnap&&tbSnap.exists())?tbSnap.val():{};

    hwDayState={};
    box.innerHTML=lessons.map((l,i)=>{
      const rec=saved[l.subject]||null;
      // Наявні вкладення тримаємо в стані рядка. Інакше при повторному
      // збереженні вони б зникли: запис іде цілком, і порожній список
      // фото затер би те, що вчитель приклав учора.
      const have=(rec&&Array.isArray(rec.images))?rec.images:[];
      hwDayState[l.subject]={saved:!!rec, dirty:false, images:have};
      const id=`hwd-${i}`;
      const books=(function(){
        const k=subjKey(l.subject);
        const node=allBooks[k]||{};
        return Object.entries(node).map(([key,b])=>({key,...b})).filter(b=>b.title);
      })();
      const bookOpts=['<option value="">— не вказувати —</option>']
        .concat(books.map(b=>`<option value="${escHtml(b.title)}" data-url="${escHtml(b.url||'')}"${
          rec&&rec.book&&rec.book.title===b.title?' selected':''}>${escHtml(b.title)}</option>`)).join('');

      return `
      <div class="hwd-row${rec?' done':''}" id="${id}-row" data-subject="${escHtml(l.subject)}">
        <button type="button" class="hwd-head" onclick="hwdToggle('${id}')">
          <span class="hwd-mark">${rec?'✓':'○'}</span>
          <span class="hwd-name">${escHtml(l.numbers.join(', '))}. ${escHtml(l.subject)}${
            l.numbers.length>1?' <span class="hwd-dbl">спарені</span>':''}</span>
          ${l.viaSub?'<span class="hwd-sub">заміна</span>':''}
          <span class="hwd-state" id="${id}-state">${rec?'задано':'не задано'}</span>
          <span class="hwd-chev">▾</span>
        </button>
        <div class="hwd-body" id="${id}-body" style="display:none;">
          <label>Домашнє завдання</label>
          <textarea id="${id}-text" rows="2" placeholder="Введіть ДЗ..."
                    oninput="hwdDirty('${id}')">${escHtml(rec?(rec.text||''):'')}</textarea>
          <label>📘 Підручник</label>
          <select id="${id}-book" onchange="hwdDirty('${id}')">${bookOpts}</select>
          <label>📄 Сторінки / вправи</label>
          <input type="text" id="${id}-pages" placeholder="напр. с. 45, вправи 3–5"
                 value="${escHtml(rec?(rec.pages||''):'')}" oninput="hwdDirty('${id}')">
          <label>📎 Фото або файл</label>
          <!-- Нативну кнопку вибору файлу малює браузер, і напис на ній —
               мовою браузера. Тому input сховано, а видима кнопка — label. -->
          <input type="file" id="${id}-file" class="hw-file-input" multiple
                 accept="image/*,.doc,.docx,.xls,.xlsx,.csv"
                 onchange="hwdFilesPicked('${id}')">
          <div class="hw-file-row">
            <label for="${id}-file" class="hw-file-btn">📂 Обрати файли</label>
            <span id="${id}-fname" class="hw-file-name">${have.length
              ? `Уже додано: ${have.length} шт. — нові замінять їх`
              : 'Файл не обрано'}</span>
          </div>
          <p class="hw-file-hint">Фото (JPG, PNG, HEIC), документ (DOC, DOCX),
            таблиця (XLS, XLSX, CSV). До ${HW_FILE_MAX_MB} МБ на файл.</p>
          <div class="hwd-actions">
            <span class="hwd-dirty" id="${id}-dirty"></span>
            <button type="button" class="qa-btn qa-save" id="${id}-save"
                    onclick="hwdSave('${id}')">💾 Зберегти</button>
          </div>
        </div>
      </div>`;
    }).join('') + `<p class="hwd-hint">Заповнене позначається галочкою й згортається.
        Тема уроку — на вкладці «Урок».</p>`;
  }catch(e){
    console.error('ДЗ на день:',e);
    box.innerHTML=`<p class="empty-msg" style="color:var(--red);">Не вдалося завантажити: ${escHtml(e.message||'')}</p>`;
  }
}
window.renderTeacherHwDay=renderTeacherHwDay;

// ── ОНОВЛЕННЯ ПРИ ЗМІНІ ДАТИ ЧИ КЛАСУ ───────────────────────────
//
// Сторінка малювалася лише при натисканні на вкладку. Тож змінивши дату
// або клас, учитель лишався з уроками попереднього дня — і мусив піти на
// іншу вкладку й повернутися, щоб побачити правильні.
//
// Перемальовуємо тільки коли вкладку ВИДНО: інакше кожна зміна дати
// тягла б зайве читання в фоні. А якщо в рядках є незбережене —
// попереджаємо, бо перемальовування його втратить.
window.refreshHwDayIfOpen=function(){
  const box=document.getElementById('t-hw-day');
  if(!box||box.offsetParent===null) return;
  if(Object.values(hwDayState).some(v=>v&&v.dirty))
    showToast('⚠️ Незбережені зміни в ДЗ скинуто');
  renderTeacherHwDay();
};

window.hwdToggle=function(id){
  const b=document.getElementById(id+'-body');
  if(!b) return;
  b.style.display = b.style.display==='none' ? 'block' : 'none';
};

// Позначка «змінено, не збережено». Без неї відкриті рядки виглядають
// однаково, і людина йде зі сторінки, впевнена, що все записала.
window.hwdDirty=function(id){
  const row=document.getElementById(id+'-row');
  const mark=document.getElementById(id+'-dirty');
  if(mark) mark.textContent='● змінено, не збережено';
  if(row){ row.classList.add('dirty'); const s=row.dataset.subject;
           if(hwDayState[s]) hwDayState[s].dirty=true; }
};

// Перевірка файлів одразу при виборі — щоб не дізнатися про неправильний
// формат уже після того, як завдання написане й натиснуто «Зберегти».
window.hwdFilesPicked=function(id){
  const input=document.getElementById(id+'-file');
  const lbl=document.getElementById(id+'-fname');
  const files=Array.from((input&&input.files)||[]);
  if(!files.length){ if(lbl){lbl.textContent='Файл не обрано';lbl.style.color='#78909c';} return; }
  const bad=files.filter(f=>!HW_FILE_EXT.includes(fileExt(f.name)));
  const big=files.filter(f=>f.size>HW_FILE_MAX_MB*1024*1024);
  if(bad.length||big.length){
    input.value='';
    if(lbl){ lbl.style.color='#b71c1c';
      lbl.textContent=bad.length
        ? `Не підходить: ${bad.map(f=>f.name).join(', ')}`
        : `Завеликий файл: ${big.map(f=>f.name).join(', ')} — понад ${HW_FILE_MAX_MB} МБ`; }
    return;
  }
  if(lbl){ lbl.style.color='#2e7d32';
    lbl.textContent=files.length===1?files[0].name:`Обрано файлів: ${files.length}`; }
  hwdDirty(id);
};

window.hwdSave=function(id){
  const row=document.getElementById(id+'-row');
  if(!row) return;
  const subject=row.dataset.subject;
  const cls=getActiveClass();
  const date=document.getElementById('global-date').value;
  const text=(document.getElementById(id+'-text')?.value||'').trim();
  const pages=(document.getElementById(id+'-pages')?.value||'').trim();
  const sel=document.getElementById(id+'-book');
  const opt=sel&&sel.selectedIndex>=0?sel.options[sel.selectedIndex]:null;
  const bookTitle=sel?sel.value:'';
  const bookUrl=opt?(opt.getAttribute('data-url')||''):'';

  return runSave(id+'-save','💾 Зберегти', null, async()=>{
    // Те саме правило, що й на подробній сторінці: якщо поле ДЗ порожнє,
    // а підручник зі сторінками вказані — вони і є завдання.
    let hwText=text;
    if(!hwText&&(bookTitle||pages))
      hwText=(bookUrl&&pages)?pages:[bookTitle,pages].filter(Boolean).join(' — ');

    // Вкладення: нові замінюють старі, а якщо нових немає — лишаються ті,
    // що вже були. Порожній список тут означав би «стерти прикріплене».
    const fileInput=document.getElementById(id+'-file');
    let images=(hwDayState[subject]&&hwDayState[subject].images)||[];
    if(fileInput&&fileInput.files.length>0){
      const dm=document.getElementById(id+'-dirty');
      if(dm) dm.textContent='⏳ Завантаження файлів...';
      images=await Promise.all(Array.from(fileInput.files).map(async file=>{
        const fd=new FormData(); fd.append('file',file); fd.append('upload_preset',UPLOAD_PRESET);
        const r=await fetch(CLOUDINARY_URL,{method:'POST',body:fd});
        const d=await r.json();
        if(!d.secure_url) throw new Error('файл не завантажився: '+((d.error&&d.error.message)||'невідома причина'));
        return d.secure_url;
      }));
    }

    // Саме завдання може бути й самим фото — тоді текст не обов'язковий.
    if(!hwText&&images.length===0){ showToast('⚠️ Завдання порожнє'); return false; }

    const hwRef=ref(db,`homeworks/${cls}/${date}/${subject}`);
    const existed=(await get(hwRef)).exists();
    const rec={text:hwText, images, ts:Date.now()};
    if(bookTitle&&bookUrl) rec.book={title:bookTitle,url:bookUrl};
    if(pages) rec.pages=pages;
    await set(hwRef,rec);
    await set(ref(db,`authors/${cls}/${date}/${subject}`),auth.currentUser.uid);
    if(!existed) notifyEvent('homework',{class:cls,subject}).catch(()=>{});

    // Успіх: галочка, згортаємо, знімаємо позначку про зміни.
    row.classList.add('done'); row.classList.remove('dirty');
    hwDayState[subject]={saved:true, dirty:false, images};
    // Поле вибору очищаємо, а підпис показує, скільки тепер прикріплено:
    // інакше при наступному збереженні ті самі файли завантажилися б удруге.
    if(fileInput) fileInput.value='';
    const fn=document.getElementById(id+'-fname');
    if(fn){ fn.style.color='#78909c';
      fn.textContent=images.length?`Уже додано: ${images.length} шт. — нові замінять їх`:'Файл не обрано'; }
    const mk=row.querySelector('.hwd-mark'); if(mk) mk.textContent='✓';
    const st=document.getElementById(id+'-state'); if(st) st.textContent='задано';
    const dm=document.getElementById(id+'-dirty'); if(dm) dm.textContent='';
    const body=document.getElementById(id+'-body'); if(body) body.style.display='none';
    showToast(`✅ ${subject}: ДЗ збережено`);
    return false;                     // власне повідомлення вже показали
  });
};

// Попередження при спробі піти з незбереженими змінами. Браузер показує
// своє вікно; текст задати не можна, але сам факт зупинки — головне.
window.addEventListener('beforeunload',(e)=>{
  if(Object.values(hwDayState).some(v=>v&&v.dirty)){ e.preventDefault(); e.returnValue=''; }
});
