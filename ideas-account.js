// ═══════════════════════════════════════════════════════════════
// ideas-account.js — 💡 «Мої звернення» в акаунті. ЛИШЕ ЗА ЗГОДОЮ АВТОРА.
//
// НАВІЩО. Номер анонімного звернення живе на пристрої (localStorage), і
// відповідь школи видно лише там, звідки писали. На iPhone Safari сам
// стирає дані сайту після 7 днів без відвідин, іконка на екрані й Safari
// мають окрему памʼять — і батьки відповіді просто не бачили.
//
// ЩО ТУТ. Якщо автор сам поставив галочку «Зберігати в моєму акаунті»,
// номер звернення записується в idea_mine/{uid}/{id} = {d: день, k: вид}.
// Тоді відповідь видно на будь-якому пристрої, і сервер надсилає автору
// push «Школа відповіла» (notify.js → ideaReplyPlan).
//
// ЧЕСНО ПРО ЦІНУ. Директор і адміністрація цього вузла не читають (правила:
// лише сам власник). Але звʼязок «акаунт — звернення» у базі є, тож
// технічно його бачить власник проєкту Firebase. Тому за замовчуванням
// галочки немає, і без неї звернення повністю анонімне, як і раніше.
//
// Окремий модуль навмисно: ideas.js і далі не торкається ні uid, ні пошти
// (це стереже tests-ideas.mjs), а все, що знає автора, — лише тут.
// ═══════════════════════════════════════════════════════════════
import { ref, get, set, remove } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { db, auth } from './common.js';

const ID_RE = /^[a-z0-9]{20,32}$/;
const KIND_RE = /^(idea|complaint|thanks)$/;
const uid = () => (auth.currentUser && auth.currentUser.uid) || '';

export async function accountReceipts(){
  const u = uid(); if(!u) return [];
  try{
    const s = await get(ref(db, `idea_mine/${u}`));
    const v = s.exists() ? s.val() : {};
    return Object.entries(v || {}).filter(([id, r]) => ID_RE.test(id) && r && typeof r === 'object')
      .map(([id, r]) => ({ id, day: String(r.d || ''), kind: String(r.k || ''), acc: true }));
  }catch(e){ return []; }        // правила ще не опубліковані / немає звʼязку — працюємо як раніше
}
export async function saveToAccount(id, day, kind){
  const u = uid();
  if(!u || !ID_RE.test(id) || !KIND_RE.test(kind) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Не вдалося зберегти в акаунті');
  await set(ref(db, `idea_mine/${u}/${id}`), { d: day, k: kind });
}
export async function removeFromAccount(id){
  const u = uid(); if(!u || !ID_RE.test(id)) return;
  await remove(ref(db, `idea_mine/${u}/${id}`));
}
