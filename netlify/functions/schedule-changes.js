// ══════════════════════════════════════════════════════════════════
//  Push School — «📅 Зміни в розкладі»: сповіщення родинам
// ══════════════════════════════════════════════════════════════════
// ЩО РОБИТЬ. Кожні 20 хвилин звіряє розклад кожного класу зі знімком, про
// який родини вже знають, і шле ОДИН push на клас із тим, що змінилося:
//   • час уроку («1-й урок тепер 09:00–09:40, було 09:00–09:45»);
//   • сам урок («Музика замість Фізкультури»), доданий чи прибраний урок;
//   • учитель — у клітинці розкладу або в каталозі предметів класу;
//   • заміна на сьогодні / завтра (substitutions) — «веде Іванова».
// Те саме зберігається в schedule_changes/{клас} — кабінет показує це на
// «Сьогодні» кілька днів, якщо push пропустили.
//
// ЧОМУ ЗА РОЗКЛАДОМ, А НЕ З КНОПКИ «ЗБЕРЕГТИ». Розклад змінюють кілька
// місць (конструктор, матриця, імпорт із Word, каталог предметів). Звірка
// знімків ловить будь-яку з них — і жодна не може «забути» сповістити.
//
// ЧОМУ НЕ ОДРАЗУ. Директор править розклад клітинка за клítинкою; push на
// кожну правку — це десять сповіщень за п'ять хвилин. Тому чекаємо, поки
// розклад класу простоїть незмінним хоча б STABLE_MIN хвилин, і шлемо
// все разом. Уночі (21:00–7:00 за Варшавою) не шлемо — дочекаються ранку.
//
// ПЕРШИЙ ЗАПУСК лише запамʼятовує розклад: інакше всі родини школи
// отримали б «зміни» в розкладі, який ніхто не змінював.
//
// Позначки (schedule_watch, sub_seen) пише лише ця функція — службовий
// ключ обходить правила, з браузера їх змінити не можна.

const { STABLE_MIN, QUIET_FROM, QUIET_TO, getAccessToken, readDb, writeDb, warsawNow, addDays, snapshotOf, hashOf, diffSnapshots,
        summarize, newSubs, sendToClass, catalogFor, ...core } = require('./lib/schedule-core');

exports.handler = async () => {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return { statusCode: 200, body: 'no service account' };
  let sa; try { sa = JSON.parse(raw); } catch (e) { return { statusCode: 200, body: 'bad json' }; }
  try {
    const token = await getAccessToken(sa);
    const now = warsawNow(), quiet = now.hour >= QUIET_FROM || now.hour < QUIET_TO;
    const tomorrow = addDays(now.date, 1);
    const [schedules, catalogs, watch, dir, subsToday, subsTomorrow, subSeen] = await Promise.all([
      readDb(token, 'schedules'), catalogFor(token, now),
      readDb(token, 'schedule_watch'), readDb(token, 'staff_directory').catch(() => null),
      readDb(token, `substitutions/${now.date}`).catch(() => null), readDb(token, `substitutions/${tomorrow}`).catch(() => null),
      readDb(token, 'sub_seen').catch(() => null)
    ]);
    const nameOf = e => (dir && dir[e] && dir[e].name) || String(e).replace(/_/g, '.');
    const report = [];
    for (const [cls, sch] of Object.entries(schedules || {})) {
      if (!/^class_\d{1,2}$/.test(cls)) continue;
      const lessons = (sch && sch.lessons) || {};
      const snap = snapshotOf(lessons, catalogs && catalogs[cls]);
      const h = hashOf(snap), w = (watch && watch[cls]) || null;
      let lines = [], newWatch = null;
      if (!w || !w.snap) newWatch = { snap, hash: h };                        // перший раз — лише запамʼятати
      else if (w.hash !== h) {
        if (w.pendingHash !== h) newWatch = { ...w, pendingHash: h, pendingSince: Date.now() };   // ще редагують — чекаємо
        else if (Date.now() - Number(w.pendingSince || 0) >= STABLE_MIN * 60e3 && !quiet) {
          lines = summarize(diffSnapshots(w.snap, snap), nameOf);
          newWatch = { snap, hash: h };
        }
      } else if (w.pendingHash) newWatch = { snap: w.snap, hash: w.hash };      // повернули як було — нічого не шлемо
      // Заміни на сьогодні й завтра
      const subs = {};
      if (subsToday && subsToday[cls]) subs[now.date] = subsToday[cls];
      if (subsTomorrow && subsTomorrow[cls]) subs[tomorrow] = subsTomorrow[cls];
      const seenCls = (subSeen && subSeen[cls]) || {};
      const sub = newSubs(subs, lessons, seenCls);
      const sendSubs = !quiet && sub.lines.length;
      const all = [...lines, ...(sendSubs ? sub.lines : [])];
      if (all.length) {
        const n = await sendToClass(token, sa, cls, all);
        report.push(`${cls}: ${all.length} змін, push ${n}`);
      }
      if (newWatch) await writeDb(token, `schedule_watch/${cls}`, newWatch);
      if (sendSubs || (!quiet && Object.keys(sub.next).join() !== Object.keys(seenCls).join()))
        await writeDb(token, `sub_seen/${cls}`, sub.next);
    }
    const note = report.length ? report.join('; ') : 'змін немає';
    console.log('Зміни в розкладі: ' + note);
    return { statusCode: 200, body: note };
  } catch (e) {
    console.log('Зміни в розкладі — помилка: ' + e.message);
    return { statusCode: 200, body: 'error: ' + e.message };
  }
};
exports._test = { snapshotOf, diffSnapshots, summarize, newSubs, hashOf, ...core };
