// ══════════════════════════════════════════════════════════════════
//  🎄 Адвент-календар — розрахунки розіграшу (сервер)
// ══════════════════════════════════════════════════════════════════
//
// Календар: віконця 1–21 грудня — по іграшці на ялинку; 22-ге (останній
// навчальний день) — зірка й приз. Розіграш — 22 грудня о 7:00 за
// Варшавою, щоб класні керівники вручили призи того ж дня.
//
// Рівень призу — від того, скільки іграшок на ялинці: золотий, срібний,
// бронзовий (пороги задає директор, advent_cfg/tiers). Менше бронзового
// порогу — без призу, але з подякою. Хто не відкрив жодного віконця, у
// розіграші не бере участі зовсім.
//
// Приз у межах рівня — випадковий: кожна ОДИНИЦЯ призу з лімітом має
// рівний шанс (приз, якого 30 штук, випадає частіше за приз, якого 3).
// Приз без ліміту — запасний: дістається, лише коли лімітовані цього
// рівня скінчились. Без жодного призу на рівні дитина отримає подяку —
// і директор побачить це в розіграші як «бракує призів».
//
// Частина функцій має КОПІЮ в advent.js (браузер не імпортує цей файл):
// tierOf, DEFAULT_TIERS, drawAtMs. tests-advent.mjs звіряє обидві.

const DAY = 86400000;
const DOORS = 21;                        // віконця з іграшками; 22-ге — зірка
const DEFAULT_TIERS = { gold: 21, silver: 15, bronze: 7 };
const TIER_ORDER = ['gold', 'silver', 'bronze'];

// Початок 1 грудня за Варшавою (у грудні це UTC+1) — та сама мітка, що
// директор записує в advent_cfg/start і за якою правила бази відкривають віконця
const startMs = year => Date.UTC(Number(year), 11, 1) - 3600000;
// Розіграш: 22 грудня о 7:00 за Варшавою
const drawAtMs = year => Date.UTC(Number(year), 11, 22, 6, 0);

function tierOf(count, tiers) {
  const t = { ...DEFAULT_TIERS, ...(tiers || {}) };
  if (count >= t.gold) return 'gold';
  if (count >= t.silver) return 'silver';
  if (count >= t.bronze) return 'bronze';
  return 'none';
}

// Скільки іграшок: лише d1…d21 із числовою міткою
function countOpened(rec) {
  if (!rec || typeof rec !== 'object') return 0;
  let n = 0;
  for (let d = 1; d <= DOORS; d++) if (typeof rec['d' + d] === 'number') n++;
  return n;
}

const classNum = cls => parseInt(String(cls).replace('class_', ''), 10) || 0;
function fitsClass(prize, cls) {
  const n = classNum(cls);
  if (prize.who === 'junior') return n >= 1 && n <= 5;
  if (prize.who === 'senior') return n >= 6;
  return true;
}
const limited = p => typeof p.qty === 'number';

// Вибір призу: rnd(n) → ціле 0…n-1 (у тестах — передбачуване)
function pickPrize(pool, tier, cls, rnd) {
  const fit = pool.filter(p => p.tier === tier && fitsClass(p, cls));
  const lim = fit.filter(p => limited(p) && p.left > 0);
  const units = lim.reduce((s, p) => s + p.left, 0);
  if (units > 0) {
    let k = rnd(units);
    for (const p of lim) { if (k < p.left) return p; k -= p.left; }
  }
  const free = fit.filter(p => !limited(p));
  return free.length ? free[rnd(free.length)] : null;
}

// Повний розіграш у памʼяті. Нічого не пише — повертає, що записати.
//   students: students_list; opens: advent/{рік}/open; awards: уже розіграні
//   (їх не чіпаємо — повторний запуск дорозігрує лише нових);
//   prizes: advent_prizes; tiers: advent_cfg/tiers.
function planDraw({ students, opens, awards, prizes, tiers, rnd, now }) {
  const pool = Object.entries(prizes || {})
    .filter(([, p]) => p && typeof p === 'object' && TIER_ORDER.includes(p.tier))
    .map(([id, p]) => ({ id, name: String(p.name || ''), note: String(p.note || ''), tier: p.tier,
                         who: p.who || 'all', qty: typeof p.qty === 'number' ? p.qty : undefined,
                         left: typeof p.left === 'number' ? p.left : 0 }));
  const out = {}, stats = { gold: 0, silver: 0, bronze: 0, none: 0, short: 0 };
  // Порядок: від найщедріших рівнів, а всередині — випадково, щоб
  // «перші в списку класи» не вибирали лімітовані призи наперед
  const kids = [];
  for (const [cls, list] of Object.entries(students || {})) {
    if (!list || typeof list !== 'object') continue;
    for (const sid of Object.keys(list)) {
      if (awards && awards[cls] && awards[cls][sid]) continue;
      const count = countOpened(opens && opens[cls] && opens[cls][sid]);
      if (!count) continue;
      kids.push({ cls, sid, count, tier: tierOf(count, tiers), r: rnd(1e9) });
    }
  }
  kids.sort((a, b) => TIER_ORDER.indexOf(a.tier === 'none' ? 'z' : a.tier) - TIER_ORDER.indexOf(b.tier === 'none' ? 'z' : b.tier) || a.r - b.r);
  for (const k of kids) {
    const rec = { tier: k.tier, count: k.count, ts: now };
    if (k.tier !== 'none') {
      const p = pickPrize(pool, k.tier, k.cls, rnd);
      if (p) {
        rec.prize = p.name; if (p.note) rec.note = p.note; rec.prizeId = p.id;
        if (limited(p)) p.left -= 1;
      } else { rec.prize = ''; stats.short++; }
    }
    stats[k.tier]++;
    (out[k.cls] = out[k.cls] || {})[k.sid] = rec;
  }
  const left = Object.fromEntries(pool.filter(limited).map(p => [p.id, p.left]));
  return { awards: out, left, stats, total: kids.length };
}

module.exports = { DAY, DOORS, DEFAULT_TIERS, startMs, drawAtMs, tierOf, countOpened, fitsClass, pickPrize, planDraw };
