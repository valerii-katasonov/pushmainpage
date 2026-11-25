// ══════════════════════════════════════════════════════════════════
//  🤝 PUSH School Card — хто має картку, що на ній, чи вона дійсна
// ══════════════════════════════════════════════════════════════════
//
// Картка особиста: своя в кожного з батьків, учня й працівника. На ній
// повне імʼя й номер; партнер на push.school/card бачить лише «Марія К.»,
// групу (батьки / учень / персонал) і термін — нічого більше.
//
// ЧИ ДІЙСНА — щоразу рахуємо наново з бази, а не з запису картки: учень
// вибув, батька відвʼязали, працівника звільнили — картка сама стає
// недійсною, без жодних ручних дій. Термін — до 31 серпня навчального року.
const crypto = require('crypto');

const digits = s => String(s || '').replace(/\D/g, '');
// 12 цифр, перша не нуль: ~9·10¹¹ варіантів — перебором не вгадати
const newNumber = () => String(crypto.randomInt(1, 10)) + Array.from({ length: 11 }, () => crypto.randomInt(0, 10)).join('');
const formatNumber = no => { const d = digits(no); return d.length === 12 ? `PS ${d.slice(0, 4)} ${d.slice(4, 8)} ${d.slice(8)}` : d; };
const emailKey = e => String(e || '').trim().toLowerCase().replace(/\./g, '_');

// Кінець навчального року: з вересня — 31.08 наступного, до вересня — цього
function untilOf(ymd){
  const [y, m] = String(ymd).split('-').map(Number);
  return `${m >= 9 ? y + 1 : y}-08-31`;
}
// students_list: «Прізвище Імʼя» → «Імʼя Прізвище» (як childDisplayName у common.js)
function studentDisplay(name){
  const p = String(name || '').trim().split(/\s+/).filter(Boolean);
  return p.length < 2 ? p.join(' ') : p.slice(1).join(' ') + ' ' + p[0];
}
// «Марія Коваленко» → «Марія К.»
function shortName(full){
  const p = String(full || '').trim().split(/\s+/).filter(Boolean);
  if(!p.length) return '';
  return p.length === 1 ? p[0] : `${p[0]} ${p[p.length - 1][0].toUpperCase()}.`;
}
const rolesOf = rec => [...new Set([rec && rec.role, ...(Array.isArray(rec && rec.roles) ? rec.roles : Object.values((rec && rec.roles) || {}))]
  .filter(r => typeof r === 'string' && r))];

// Групи, до яких людина належить ПРЯМО ЗАРАЗ (за даними бази)
//   user        — users/{uid}
//   parentLink  — parent_links/{пошта} (є діти)
//   student     — запис у students_list за класом і studentId/імʼям
//   staffRole   — pre_approved_roles/{пошта} (працює в школі)
function groupsOf(user, { parentLink, studentListed, staffRole } = {}){
  const roles = rolesOf(user), g = [];
  // Директор і адміністратор — завжди персонал: першого директора могли
  // завести вручну, без запису в pre_approved_roles
  const admin = roles.some(r => r === 'director' || r === 'administrator');
  if(admin || (roles.some(r => r !== 'parent' && r !== 'student') && staffRole)) g.push('staff');
  if(roles.includes('parent') && parentLink) g.push('parent');
  if(roles.includes('student') && studentListed) g.push('student');
  return g;
}
// Повне імʼя для картки: профіль користувача → профіль батька → довідник
// персоналу → імʼя учня зі списку класу
function fullNameOf(user, { parentProfile, staffName, rosterName } = {}){
  const u = user || {};
  // Учень: імʼя веде школа (список класу). Самовписане в профілі не беремо —
  // інакше на картці стояло б будь-яке імʼя, яке учень собі придумав.
  if(u.role === 'student'){
    const r = typeof rosterName === 'string' && rosterName.trim() ? rosterName : u.studentName;
    return r ? studentDisplay(r).slice(0, 80) : '';
  }
  const a = [u.firstName, u.lastName].filter(x => typeof x === 'string' && x.trim()).join(' ').trim();
  if(a) return a.slice(0, 80);
  const p = parentProfile || {};
  const b = [p.firstName, p.lastName].filter(x => typeof x === 'string' && x.trim()).join(' ').trim();
  if(b) return b.slice(0, 80);
  if(typeof staffName === 'string' && staffName.trim()) return staffName.trim().slice(0, 80);
  if(rolesOf(u).includes('student') && u.studentName) return studentDisplay(u.studentName).slice(0, 80);
  return '';
}
const GROUP_LABEL = { staff: 'Персонал школи', parent: 'Батьки учня', student: 'Учень / учениця' };

module.exports = { digits, newNumber, formatNumber, emailKey, untilOf, studentDisplay, shortName, rolesOf, groupsOf, fullNameOf, GROUP_LABEL };
