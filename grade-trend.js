// ═══════════════════════════════════════════════════════════════
// grade-trend.js — 📈 динаміка оцінок: як змінюється середній бал з предмета.
//
// ДЕ ВИДНО
//   • Батьки й учень, «Оцінки → За предметом»: графік середнього по місяцях
//     з точками всіх оцінок (тематичні — кільцем) і рискою порогу.
//   • Батьки й учень, «📊 Підсумок»: усі предмети списком — маленька лінія,
//     середній за останній місяць і стрілка ↑/↓ порівняно з попереднім.
//   • Учитель, картка учня 360° → «Оцінки»: стовпець «Динаміка».
//
// ЯК РАХУЄМО. Середній місяця — середньозважений поточних оцінок за той
// місяць (тематичні в нього не входять, як і всюди). Стрілка — порівняння
// останнього місяця з оцінками з попереднім таким місяцем; «без змін», якщо
// різниця менша за 4 % шкали (на 12-бальній — 0.5, на 6-бальній — 0.25).
//
// КОЛЬОРИ — лише токени (var(--…)), тож графік однаково читається у
// світлій і темній темі. Підказки при наведенні — <title> у кожній точці.
// ═══════════════════════════════════════════════════════════════
import { calculateStudentWeightedAvg, levelNum, THEMATIC } from './common.js';

const MONTHS_SHORT = ['січ', 'лют', 'бер', 'кві', 'тра', 'чер', 'лип', 'сер', 'вер', 'жов', 'лис', 'гру'];
const MONTHS_FULL = ['Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень', 'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень'];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ── ЧИСТА ЛОГІКА ─────────────────────────────────────────────────
// g {ключ: оцінка}, t {ключ: тип} → [{ym, avg, n}] за місяцями, по порядку
export function monthlySeries(g, t){
  const by = {};
  for(const k in (g || {})){
    if(levelNum(g[k]) === null) continue;
    const ym = String(k).slice(0, 7);
    (by[ym] ||= { g: {}, t: {} });
    by[ym].g[k] = g[k]; by[ym].t[k] = (t && t[k]) || 'П';
  }
  return Object.keys(by).sort().map(ym => {
    const avg = calculateStudentWeightedAvg(by[ym].g, by[ym].t);
    const n = Object.keys(by[ym].g).filter(k => by[ym].t[k] !== THEMATIC).length;
    return { ym, avg, n };
  }).filter(x => x.avg !== null);
}
// Стрілка: останній місяць проти попереднього
export function trendInfo(series, max){
  const s = (series || []).filter(x => x.avg !== null);
  if(s.length < 2) return { dir: null, delta: 0, last: s.length ? s[s.length - 1].avg : null };
  const last = s[s.length - 1].avg, prev = s[s.length - 2].avg, delta = last - prev;
  const eps = (Number(max) || 6) * 0.04;
  return { dir: delta >= eps ? 'up' : delta <= -eps ? 'down' : 'flat', delta, last };
}
export const monthLabel = ym => MONTHS_FULL[Number(ym.slice(5, 7)) - 1] || ym;

// ── МАЛЮНКИ ──────────────────────────────────────────────────────
// Маленька лінія для списку: без осей, лише форма й остання точка
export function sparkSVG(series, max, min = 1){
  const s = (series || []).filter(x => x.avg !== null);
  if(!s.length) return '';
  const W = 72, H = 22, P = 3;
  const x = i => s.length === 1 ? W / 2 : P + i * (W - 2 * P) / (s.length - 1);
  const y = v => P + (1 - (Math.min(max, Math.max(min, v)) - min) / ((max - min) || 1)) * (H - 2 * P);
  const pts = s.map((p, i) => `${x(i).toFixed(1)},${y(p.avg).toFixed(1)}`).join(' ');
  const last = s[s.length - 1];
  return `<svg class="gt-spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">`
    + (s.length > 1 ? `<polyline points="${pts}" fill="none" stroke="var(--brand-deep)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` : '')
    + `<circle cx="${x(s.length - 1).toFixed(1)}" cy="${y(last.avg).toFixed(1)}" r="3" fill="var(--brand-deep)" stroke="var(--surface)" stroke-width="1.5"/></svg>`;
}
// Стрілка з підписом — текст несе зміст, колір лише підсилює
export function trendBadge(info, max){
  if(!info || !info.dir) return '<span class="gt-badge flat" title="Мало даних для порівняння">—</span>';
  const d = Math.abs(info.delta).toFixed((Number(max) || 6) > 6 ? 1 : 2);
  if(info.dir === 'up') return `<span class="gt-badge up" title="Краще, ніж минулого місяця">↑ +${d}</span>`;
  if(info.dir === 'down') return `<span class="gt-badge down" title="Гірше, ніж минулого місяця">↓ −${d}</span>`;
  return '<span class="gt-badge flat" title="Приблизно так само, як минулого місяця">→ без змін</span>';
}
// Великий графік: середній по місяцях (лінія) + кожна оцінка (точка) + поріг.
//   rows: [{date, v, t}], max: шкала, thr: поріг низького балу,
//   levels: true для 1–4 класів (вісь підписана П/С/Д/В)
export function trendChartSVG(rows, { max = 6, min = 1, thr = null, levels = false } = {}){
  const pts = (rows || []).map(r => ({ d: String(r.date).slice(0, 10), n: levelNum(r.v), v: r.v, t: r.t || '' }))
    .filter(p => p.n !== null).sort((a, b) => a.d.localeCompare(b.d));
  if(pts.length < 2) return '';
  const g = {}, t = {}; (rows || []).forEach(r => { g[r.date] = r.v; t[r.date] = r.t || 'П'; });
  const series = monthlySeries(g, t);
  const W = 340, H = 170, L = 28, R = 10, T = 10, B = 24;
  const months = []; { // кожен місяць від першої до останньої оцінки
    let [y, m] = pts[0].d.slice(0, 7).split('-').map(Number);
    const [ey, em] = pts[pts.length - 1].d.slice(0, 7).split('-').map(Number);
    while(y < ey || (y === ey && m <= em)){ months.push(`${y}-${String(m).padStart(2, '0')}`); if(++m > 12){ m = 1; y++; } }
  }
  const day0 = Date.parse(`${months[0]}-01`), [ly, lm] = months[months.length - 1].split('-').map(Number);
  const day1 = Date.parse(`${ly + (lm === 12 ? 1 : 0)}-${String(lm === 12 ? 1 : lm + 1).padStart(2, '0')}-01`);
  const X = ds => L + (Date.parse(ds) - day0) / (day1 - day0) * (W - L - R);
  const Y = v => T + (1 - (Math.min(max, Math.max(min, v)) - min) / ((max - min) || 1)) * (H - T - B);
  const ticks = levels ? [[2, 'П'], [3, 'С'], [4, 'Д'], [5, 'В']]
    : (max === 12 ? [2, 4, 6, 8, 10, 12] : max === 6 ? [1, 2, 3, 4, 5, 6] : [min, Math.round(max / 2), max]).map(v => [v, String(v)]);
  let s = `<svg class="gt-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Середній бал за місяцями">`;
  // сітка й підписи осі Y — тихі
  ticks.forEach(([v, l]) => {
    s += `<line x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="var(--line-soft)" stroke-width="1"/>`
       + `<text x="${L - 6}" y="${(Y(v) + 3.5).toFixed(1)}" text-anchor="end" class="gt-ax">${esc(l)}</text>`;
  });
  // межі й підписи місяців
  months.forEach((ym, i) => {
    const x0 = X(`${ym}-01`);
    if(i) s += `<line x1="${x0.toFixed(1)}" x2="${x0.toFixed(1)}" y1="${T}" y2="${H - B}" stroke="var(--line-soft)" stroke-width="1"/>`;
    const next = i < months.length - 1 ? X(`${months[i + 1]}-01`) : W - R;
    s += `<text x="${((x0 + next) / 2).toFixed(1)}" y="${H - 7}" text-anchor="middle" class="gt-ax">${MONTHS_SHORT[Number(ym.slice(5, 7)) - 1]}</text>`;
  });
  // поріг низького балу — пунктир із підписом
  if(thr !== null && thr > min && thr <= max){
    s += `<line x1="${L}" x2="${W - R}" y1="${Y(thr).toFixed(1)}" y2="${Y(thr).toFixed(1)}" stroke="var(--danger)" stroke-width="1" stroke-dasharray="4 3" opacity=".7"/>`
       + `<text x="${W - R}" y="${(Y(thr) - 3).toFixed(1)}" text-anchor="end" class="gt-thr">поріг ${Number.isInteger(thr) ? thr : thr.toFixed(1)}</text>`;
  }
  // кожна оцінка — дрібна точка (тематична — кільце)
  pts.forEach(p => {
    const th = p.t === THEMATIC, [, mm, dd] = p.d.split('-');
    s += `<circle cx="${X(p.d).toFixed(1)}" cy="${Y(p.n).toFixed(1)}" r="${th ? 4 : 2.6}" class="${th ? 'gt-pt-th' : 'gt-pt'}"><title>${dd}.${mm} · ${esc(p.v)}${p.t ? ` (${esc(p.t)})` : ''}</title></circle>`;
  });
  // середній місяця — лінія через середини місяців
  const mid = ym => { const i = months.indexOf(ym); const a = X(`${ym}-01`), b = i < months.length - 1 ? X(`${months[i + 1]}-01`) : W - R; return (a + b) / 2; };
  if(series.length > 1) s += `<polyline points="${series.map(p => `${mid(p.ym).toFixed(1)},${Y(p.avg).toFixed(1)}`).join(' ')}" fill="none" stroke="var(--brand-deep)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  series.forEach(p => {
    s += `<circle cx="${mid(p.ym).toFixed(1)}" cy="${Y(p.avg).toFixed(1)}" r="5" fill="var(--brand-deep)" stroke="var(--surface)" stroke-width="2"><title>${esc(monthLabel(p.ym))}: середній ${p.avg.toFixed(2)} (${p.n} оц.)</title></circle>`;
  });
  return s + '</svg>';
}
