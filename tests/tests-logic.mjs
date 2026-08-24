// Витягуємо чисту логіку з kitchen.js і виконуємо її на вигаданих даних.
// Статичні перевірки кажуть «синтаксис правильний», але не кажуть
// «рахує правильно». Це — про друге.
import fs from 'fs';
const src = fs.readFileSync('./kitchen.js','utf8');
const grab = (name) => {
  const i = src.indexOf(`function ${name}(`);
  let j = src.indexOf('{', i), d = 1, k = j + 1;
  while (d) { if (src[k]==='{') d++; else if (src[k]==='}') d--; k++; }
  return src.slice(i, k);
};
const code = ['snackPlanned','effectiveMeals','absentSet','mondayOf','weekDates','nextWorkday']
  .map(grab).join('\n')
  + `\nconst iso = d => \`\${d.getFullYear()}-\${String(d.getMonth()+1).padStart(2,'0')}-\${String(d.getDate()).padStart(2,'0')}\`;`;
const fn = new Function(code + '; return {snackPlanned,effectiveMeals,absentSet,mondayOf,weekDates,nextWorkday};');
const L = fn();

let pass=0, fail=0;
const t=(name,got,exp)=>{
  const ok = JSON.stringify(got)===JSON.stringify(exp);
  if(ok)pass++;else{fail++;console.log(`  ❌ ${name}\n     отримано ${JSON.stringify(got)}\n     очікували ${JSON.stringify(exp)}`);}
};

// ── Хто що їсть ──
t('без плану = обідає, без підвечірка', L.effectiveMeals(null,null,false,3), {lunch:true,snack:false,absent:false});
t('знято з харчування',                L.effectiveMeals({lunch:false},null,false,3), {lunch:false,snack:false,absent:false});
t('підвечірок щодня',                  L.effectiveMeals({snack:'all'},null,false,3), {lunch:true,snack:true,absent:false});
t('підвечірок по днях — потрібний день',L.effectiveMeals({snack:'days',snackDays:{3:true}},null,false,3), {lunch:true,snack:true,absent:false});
t('підвечірок по днях — інший день',   L.effectiveMeals({snack:'days',snackDays:{2:true}},null,false,3), {lunch:true,snack:false,absent:false});
t('відсутній переважає все',           L.effectiveMeals({snack:'all'},{lunch:1,snack:1},true,3), {lunch:false,snack:false,absent:true});
t('разова відмова від обіду',          L.effectiveMeals(null,{lunch:0},false,3), {lunch:false,snack:false,absent:false});
t('разовий підвечірок понад план',     L.effectiveMeals(null,{snack:1},false,3), {lunch:true,snack:true,absent:false});

// ── Відсутність ──
t('відсутній хоч на одному уроці', L.absentSet({'-Nx1':{a:{status:'late'},b:{status:'absent'}}}), {'-Nx1':true});
t('лише запізнення — не відсутній', L.absentSet({'-Nx1':{a:{status:'late'}}}), {});
t('порожній день', L.absentSet(null), {});

// ── Тижні ──
t('понеділок від пʼятниці', L.mondayOf('2026-08-21'), '2026-08-17');
t('понеділок від неділі',   L.mondayOf('2026-08-23'), '2026-08-17');
t('тиждень = 5 робочих днів', L.weekDates('2026-08-24').length, 5);
t('тиждень не містить вихідних', L.weekDates('2026-08-24'), ['2026-08-24','2026-08-25','2026-08-26','2026-08-27','2026-08-28']);
t('наступний робочий після пʼятниці', L.nextWorkday('2026-08-21'), '2026-08-24');
t('наступний робочий після суботи',   L.nextWorkday('2026-08-22'), '2026-08-24');

console.log(`\n  пройдено ${pass}, провалено ${fail}`);
process.exit(fail?1:0);
