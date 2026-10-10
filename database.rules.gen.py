# -*- coding: utf-8 -*-
# Генератор database.rules.json — щоб однакові вирази не розходилися між вузлами.
import io, json, re

SE     = "auth.token.email.replace('.','_')"
ROLE   = "root.child('users').child(auth.uid).child('role').val()"
MYCLS  = "root.child('users').child(auth.uid).child('class').val()"
MYSID  = f"root.child('users').child(auth.uid).child('studentId').val()"
def MINE_STU(seg): return f"({seg} === {MYNAME} || {seg} === {MYSID})"
MYNAME = "root.child('users').child(auth.uid).child('studentName').val()"

AUTH    = "auth != null && auth.token.email != null"
ADMIN   = f"({ROLE} === 'director' || {ROLE} === 'administrator')"
# ── ТИМЧАСОВА РОЛЬ ДЛЯ НАЛАГОДЖЕННЯ ──────────────────────────────
# master_class_teacher — права класного керівника в БУДЬ-ЯКОМУ класі.
# Потрібна, щоб розробник міг відтворити те, що бачить класний керівник,
# не питаючи в нього пароль.
#
# ЧОГО ЇЙ НЕ ДАНО. Читати чужі переписки. Правила для chats/ і user_chats/
# нижче спираються лише на членство в розмові, і MASTER там навмисно не
# згадано. «Подивитися очима вчителя» ніколи не має означати «прочитати
# його листування».
#
# ЯК ПРИБРАТИ ПЕРЕД ПЕРЕДАЧЕЮ ШКОЛІ: зняти роль у людини
# (users/{uid}/role і pre_approved_roles/{email}). Для повної певності —
# прибрати MASTER із цього файлу, перегенерувати правила й опублікувати.
MASTER  = f"({ROLE} === 'master_class_teacher')"

TEACH   = ("(" + " || ".join(f"{ROLE} === '{r}'" for r in
           ['teacher','class_teacher','art_school_teacher','music_teacher']) + f" || {MASTER})")
EDU     = f"({ADMIN} || {TEACH})"
KITCHEN = f"({ROLE} === 'kitchen')"
FAMILY  = f"({ROLE} === 'parent' || {ROLE} === 'student')"
STAFF   = f"({EDU} || {KITCHEN})"
# Педагог-організатор: не вчитель. Бачить розклад усіх класів, веде свята й
# культурно-виховні заходи в календарі, пише оголошення. До оцінок,
# відвідуваності й даних родин доступу НЕ має — тому в STAFF/EDU її немає.
ORG     = f"({ROLE} === 'organizer')"

# ── КОНСТРУКТОР РОЛЕЙ ─────────────────────────────────────────────
# custom_roles/{id} = {name, icon, perms:{news,calendar,schedule,chat,meals}}
# Директор збирає роль галочками. Кожне право — це конкретні вузли бази
# нижче; права поза цим списком роль не отримає ніяк. id: 'organizer'
# (шаблон «Педагог-організатор») або 'cr_…'.
ROLE_PERMS = ['news', 'calendar', 'schedule', 'chat', 'meals',
              # група 1 — дані й так відкриті всім, хто увійшов
              'bells', 'menu', 'clubs',
              # група 2 — дані дітей, лише ЧИТАННЯ (див. PERM_READS унизу)
              'birthdays', 'activities', 'attendance', 'consents', 'meals_view', 'workload']
ORG_DEFAULT = ['news', 'calendar', 'schedule']
def PERM(p):
    own = f"root.child('custom_roles').child({ROLE}).child('perms').child('{p}').val() === true"
    if p in ORG_DEFAULT:
        # Поки директор не відкрив конструктор, запису для організатора ще
        # немає — тоді діють права, з якими роль створювали.
        own += f" || ({ORG} && !root.child('custom_roles').child('organizer').exists())"
    return f"({own})"
# Вчитель пише лише в класи, до яких директор дав доступ
# Майстер-роль допущена до всіх класів без запису в teacher_access:
# інакше довелося б заводити одинадцять рядків, які потім легко забути прибрати.
# Тимчасовий доступ на час заміни (temp_access/{пошта}/{клас}.until, мс):
# учитель на заміні веде журнал у чужому класі кілька днів, а потім доступ
# зникає сам. Раніше на заміну давали постійний доступ — і він лишався
# назавжди («колись раз заміняв у 10 класі»).
TEMP = lambda v: f"root.child('temp_access').child({SE}).child({v}).child('until').val() > now"
def TCLS(v): return f"({ADMIN} || {MASTER} || root.child('teacher_access').child({SE}).child({v}).exists() || {TEMP(v)})"
def MINE(v): return f"({FAMILY} && {v} === {MYCLS})"

# ── «Це ключ МОЄЇ дитини у списку класу» ─────────────────────────
#
# ЧОМУ ЦЬОГО НЕ ВИСТАЧАЛО РАНІШЕ. Правила питали: «чи дорівнює ключ запису
# тому, що лежить у твоєму профілі — studentId або studentName». Профіль —
# це КОПІЯ, і вона мусить спершу туди потрапити. Портал дописує туди
# ідентифікатор сам, але сам цей запис теж проходить перевірку: users/{uid}
# приймається лише тоді, коли імʼя й клас у профілі збігаються з
# parent_links. Варто класному керівникові виправити написання імені в
# списку класу — і копії розходяться, профіль перестає зберігатися, а
# разом з ним перестає працювати ВСЕ, що звіряється з профілем.
#
# Саме так виглядало «батько тисне Б, а лишається А»: запис у базу
# відхилявся, бо в профілі не було ідентифікатора, а записати його туди
# теж не виходило.
#
# Тепер питаємо по суті: чи це ключ у списку класу, під яким записана
# дитина цього батька. Список класу веде школа — підробити його не можна,
# а зайвої довіри це не додає.
def MY_STU(cls, key):
    return (f"({MINE(cls)} && root.child('students_list').child({cls}).child({key}).val() === {MYNAME})")
# Класний керівник САМЕ цього класу. На відміну від TCLS, доступу до
# предмета в класі тут замало: класна година — справа класу, а не предмета.
def CT_OF(v): return (f"({MASTER} || root.child('class_teachers').child({v})"
                      f".child('teacherEmail').val() === auth.token.email)")

def R(read=None, write=None, validate=None, index=None, children=None):
    d = {}
    if read     is not None: d['.read']     = read
    if write    is not None: d['.write']    = write
    if validate is not None: d['.validate'] = validate
    if index    is not None: d['.indexOn']  = index
    if children: d.update(children)
    return d

# ── users: роль підтверджується джерелом, яке користувач не може змінити ──
def entitled(role_expr):
    pre = f"root.child('pre_approved_roles').child({SE})"
    # У формі персоналу сім службових ролей. Перевірка лише індексів 0–3
    # робила ролі знизу мультивибору видимими в UI, але непридатними для
    # перемикання. Вісім слотів покривають увесь поточний перелік із запасом.
    staff_ok = " || ".join([f"{pre}.val() === {role_expr}"] +
                           [f"{pre}.child('{i}').val() === {role_expr}" for i in range(8)])
    return (f"({role_expr} === 'parent' ? root.child('parent_links').child({SE}).exists()"
            f" : ({role_expr} === 'student' ? root.child('student_links').child({SE}).exists()"
            f" : ({staff_ok})))")

NEWROLE = "newData.child('role').val()"
NEWNAME = "newData.child('studentName').val()"
NEWCLS  = "newData.child('class').val()"
sl = f"root.child('student_links').child({SE})"
pl = f"root.child('parent_links').child({SE})"
student_pair = (f"({NEWROLE} !== 'student' || ({NEWNAME} === {sl}.child('studentName').val()"
                f" && {NEWCLS} === {sl}.child('class').val()))")
kid = lambda i: (f"({pl}.child('children').child('{i}').child('studentName').val() === {NEWNAME}"
                 f" && {pl}.child('children').child('{i}').child('class').val() === {NEWCLS})")
legacy = f"({pl}.child('studentName').val() === {NEWNAME} && {pl}.child('class').val() === {NEWCLS})"
parent_pair = (f"({NEWROLE} !== 'parent' || (" + " || ".join([kid(i) for i in range(6)] + [legacy]) + "))")

rules = {}
def user_check(base, old):
    role = f"{base}.child('role').val()"
    name = f"{base}.child('studentName').val()"
    cls  = f"{base}.child('class').val()"
    sl2 = f"root.child('student_links').child({SE})"
    pl2 = f"root.child('parent_links').child({SE})"
    st = (f"({role} !== 'student' || ({name} === {sl2}.child('studentName').val()"
          f" && {cls} === {sl2}.child('class').val()))")
    k = lambda i: (f"({pl2}.child('children').child('{i}').child('studentName').val() === {name}"
                   f" && {pl2}.child('children').child('{i}').child('class').val() === {cls})")
    lg = f"({pl2}.child('studentName').val() === {name} && {pl2}.child('class').val() === {cls})"
    pa = f"({role} !== 'parent' || (" + " || ".join([k(i) for i in range(6)] + [lg]) + "))"
    # studentId раніше не перевірявся взагалі: батько чи учень ставив собі
    # ідентифікатор чужої дитини, і всі правила з `$sid === studentId`
    # відкривали її дані. Тепер ідентифікатор мусить бути ключем у списку
    # класу, під яким записане ТЕ САМЕ імʼя, що вже звірене з
    # parent_links/student_links, — або прямо збігатися з ідентифікатором,
    # який школа вписала в parent_links/student_links. Для персоналу поле
    # не важить (усі гілки зі studentId вимагають роль родини), тож його
    # не чіпаємо — інакше перемикання ролі «батько → учитель» ламалося б.
    #
    # НЕЗМІНЕНЕ ЗНАЧЕННЯ ПРОПУСКАЄМО. Інакше повторилася б історія, описана
    # біля MY_STU: класний керівник виправив імʼя в списку класу — і
    # профіль батька перестає зберігатися через ідентифікатор, який він
    # навіть не чіпав. Нові значення перевіряються завжди.
    #
    # «Незмінене» рахуємо лише тоді, коли й ДО запису роль була родинна.
    # Інакше людина з двома ролями (учитель + батько) ставила б собі будь-
    # який studentId у ролі вчителя (там він не перевіряється), а потім
    # перемикалася на батька — і значення проходило б як «незмінене».
    sid = f"{base}.child('studentId')"
    kid_id = " || ".join(
        [f"({pl2}.child('children').child('{i}').child('studentId').val() === {sid}.val()"
         f" && {pl2}.child('children').child('{i}').child('class').val() === {cls})" for i in range(6)]
        + [f"({pl2}.child('studentId').val() === {sid}.val() && {pl2}.child('class').val() === {cls})"])
    stu_id = f"({sl2}.child('studentId').val() === {sid}.val() && {sl2}.child('class').val() === {cls})"
    sd = (f"(({role} !== 'parent' && {role} !== 'student') || !{sid}.exists()"
          f" || (({old}.child('role').val() === 'parent' || {old}.child('role').val() === 'student')"
          f" && {old}.child('studentId').val() === {sid}.val())"
          f" || ({role} === 'parent' && ({kid_id}))"
          f" || ({role} === 'student' && {stu_id})"
          f" || ({sid}.isString() && {sid}.val().length > 0 && {base}.child('class').isString() && root.child('students_list').child({cls}).child({sid}.val()).val() === {name}))")
    return (f"{base}.child('email').val() === auth.token.email"
            f" && {entitled(role)} && {st} && {pa} && {sd}")

# ── Облікові записи ──
#
# ЗАПИС. Раніше тут стояло лише "$uid === auth.uid" — писати міг тільки
# власник запису. Це захищало від підробки ролі, але заодно ламало всю
# роботу директора з людьми: призначення класного керівника, відкликання
# доступу, переведення учня в інший клас, випуск 11-го класу, прив'язку
# дітей до батьків. Кожна з цих дій пише в чужий users/{uid} і отримувала
# PERMISSION_DENIED.
#
# Додаємо адміністрацію. Нових повноважень це не дає: директор і так
# роздає ролі через pre_approved_roles, звідки вони підхоплюються при
# вході. Різниця лише в тому, що тепер він може зробити це прямо.
#
# ПЕРЕВІРКА. user_check прив'язує запис до власної пошти й до заздалегідь
# призначеної ролі — саме це не дає звичайному користувачеві приписати
# собі роль директора. Для адміністрації перевірку знімаємо: вона пише в
# чужі записи, де чужа пошта, і жодна з умов user_check не виконалася б.
rules['users'] = {".read": f"{AUTH} && {ADMIN}",
  "$uid": {".read": f"{AUTH} && ($uid === auth.uid || {ADMIN})",
           ".write": f"{AUTH} && ($uid === auth.uid || {ADMIN})",
           ".validate": f"{ADMIN} || (" + user_check('newData', 'data') + ")",
           "$field": {".validate": f"{ADMIN} || (" + user_check('newData.parent()', 'data.parent()') + ")"}}}

# ── Джерела ролей: читає лише власник (потрібно на вході) або адміністрація ──
#
# КЛАСНИЙ КЕРІВНИК ПРИВʼЯЗУЄ БАТЬКІВ САМ — але вузько.
#
# Досі привʼязати пошту батьків міг лише директор, хоча кнопка стояла в
# кабінеті вчителя: він тиснув її й отримував відмову в правах. Списки
# класу веде класний керівник, до нього ж приходять батьки — тож право
# логічно його.
#
# Але вузол parent_links/{пошта} — це не лише список дітей: поруч лежить
# profile з телефонами та адресою родини. Дозволити писати вузол цілком
# означало б дати вчителеві переписати чужі контакти й, гірше, стерти
# привʼязку дитини з ІНШОГО класу — вона лежить у тому самому списку.
#
# Тому право дається не на вузол, а на ОДИН запис у списку дітей, і лише
# на створення:
#   • !data.exists()      — змінити чи видалити наявний запис не можна;
#   • CT_OF(клас)         — клас має бути той, де ти класний керівник;
#   • учень є в списку класу, і саме під цим імʼям — щоб привʼязка не
#     вказувала на дитину, якої в класі немає.
#
# Індекси 0–5: рівно стільки дітей звіряє правило users (kid(i) вище).
# Запис у сьомий слот був би невидимий для перевірки профілю, і батько
# перестав би зберігати власні дані, не розуміючи чому.
NEWCLS_K = "newData.child('class').val()"
NEWSID_K = "newData.child('studentId').val()"
ROSTER_K = f"root.child('students_list').child({NEWCLS_K}).child({NEWSID_K})"
CT_ADD_KID = ("(!data.exists()"
              f" && {CT_OF(NEWCLS_K)}"
              f" && {ROSTER_K}.exists()"
              f" && {ROSTER_K}.val() === newData.child('studentName').val())")

for node in ['pre_approved_roles','parent_links','student_links','teacher_access']:
    # Родина пише ЛИШЕ у свій profile (телефони, адреса). Раніше право
    # стояло на весь вузол parent_links/{пошта} — і батько міг дописати
    # собі в children будь-яку дитину школи, а з нею отримати її оцінки,
    # харчування й (через child-access) зміну пароля. Право, видане на
    # рівні вузла, правило для children нижче вже не звужувало б.
    se_rule = R(
        read  = f"{AUTH} && ($se === {SE} || {ADMIN}" + (f" || {EDU}" if node=='parent_links' else "") + ")",
        write = f"{AUTH} && ({ADMIN})")
    if node == 'parent_links':
        se_rule['children'] = {'$idx': R(
            write=f"{AUTH} && $idx.matches(/^[0-5]$/) && {CT_ADD_KID}")}
        se_rule['profile'] = R(write=f"{AUTH} && $se === {SE} && {FAMILY}")
    rules[node] = {".read": f"{AUTH} && (" + ({'parent_links': EDU}.get(node, ADMIN)) + ")",
                   "$se": se_rule}

# ── Навчальні дані, ключовані класом ──
CLASS_NODES = ['grades','attendance','comments','homeworks','stickers','behavior_grades',
               'semester_grades','reactions','exams','retake_requests','lesson_topics',
               'schedules','textbooks','curriculum_plans','grade_types','students_list',
               # curriculum_aliases/{клас}/{ключ} = «Канонічна назва предмета».
               # «Matematyka» і «Математика» — той самий курс, і план у них
               # спільний. Права ті самі, що в самого плану: хто може
               # завантажити план класу, той може й сказати, що план спільний.
               'curriculum_aliases',
               # authors/{клас}/{дата}/{предмет} — хто вніс ДЗ. Раніше цей
               # вузол лежав серед спільних довідників, де пише лише
               # адміністрація, хоча пише його ВЧИТЕЛЬ, і то при кожному
               # збереженні теми та ДЗ. Наслідок: у звичайного вчителя
               # збереження мовчки падало з PERMISSION_DENIED, а кнопка
               # назавжди лишалася в стані «Збереження...». Форма запису
               # у нього класна, тож і правило має бути класне.
               'authors',
               'homework_submissions',
               ]
for node in CLASS_NODES:
    rules[node] = {".read": f"{AUTH} && {STAFF}",
                   "$cls": R(read  = f"{AUTH} && ({STAFF} || {MINE('$cls')})",
                             write = f"{AUTH} && {EDU} && {TCLS('$cls')}")}
# У 1–4 класах підсумкова — рівень П/С/Д/В. Старі числові записи
# можна зберегти без зміни; з 5-го класу дозволено цілий бал без знака.
rules['semester_grades']['$cls']['$sem'] = {'$subj': {'$student': {
    'value': R(validate="newData.isString() && (($cls.matches(/^class_[1-4]$/) && (newData.val().matches(/^[ПСДВ]$/) || (data.exists() && newData.val() === data.val()))) || (!$cls.matches(/^class_[1-4]$/) && newData.val().matches(/^[1-9][0-9]*$/)))")}}}
# ── Позиції на винос ──
# Асортимент бачать усі, хто увійшов: батькам треба з чого обирати.
# Веде його кухня та адміністрація.
rules['takeaway_items'] = R(
    read=AUTH,
    write=f"{AUTH} && ({KITCHEN} || {ADMIN})",
    children={'$id': R(children={
        'title':  R(validate="newData.isString() && newData.val().length <= 80"),
        'price':  R(validate="newData.isNumber() && newData.val() >= 0 && newData.val() <= 999"),
        'note':   R(validate="newData.isString() && newData.val().length <= 120"),
        'active': R(validate="newData.isBoolean()"),
        'by':     R(validate="newData.isString()"),
        'ts':     R(validate="newData.isNumber()"),
    })})
# Розклад бачить і педагог-організатор — лише розклад, не оцінки й не журнал.
rules['schedules']['.read'] = f"{AUTH} && ({STAFF} || {PERM('schedule')})"
rules['schedules']['$cls']['.read'] = f"{AUTH} && ({STAFF} || {PERM('schedule')} || {MINE('$cls')})"

# ПЕРСОНАЛ ЗАМОВЛЯЄ ПІД ПСЕВДОКЛАСОМ 'staff'.
#
# Учителі й директор теж беруть їжу, але класу в них немає. Заводити для
# цього окремий вузол означало б другу гілку замовлень, другий підрахунок
# у кухні й другу нагоду розійтися. Тому замовлення персоналу лежать там
# само, у ключі 'staff', а ключ людини — її пошта.
#
# Писати можна ЛИШЕ під власною поштою: інакше вчитель міг би замовити
# обід від імені колеги.
STAFF_TA = f"($cls === 'staff' && $sid === {SE} && ({STAFF} || {PERM('meals')}))"

# Замовлення: кухня та адміністрація читають усе, родина пише лише свою
# дитину. Кількість обмежена правилом, а не лише інтерфейсом.
rules['takeaway_orders'] = R(
    read=f"{AUTH} && ({KITCHEN} || {ADMIN})",
    children={'$date': R(children={'$cls': R(
        read=f"{AUTH} && ({KITCHEN} || {ADMIN} || {EDU})",
        children={'$sid': R(
            read=f"{AUTH} && ({KITCHEN} || {ADMIN} || {STAFF_TA} || ({MINE('$cls')} && ($sid === {MYSID} || $sid === {MYNAME}) || {MY_STU('$cls','$sid')}))",
            write=f"{AUTH} && ({KITCHEN} || {ADMIN} || {STAFF_TA} || ({MINE('$cls')} && ($sid === {MYSID} || $sid === {MYNAME}) || {MY_STU('$cls','$sid')}))",
            children={'$item': R(
                validate="!newData.exists() || (newData.isNumber() && newData.val() >= 1 && newData.val() <= 9)")})})})})

# ── Підтвердження ознайомлення та згоди батьків ──
# policy_ack/{пошта} = {version, ts, opts:{...}}
#
# Батько пише лише свій запис — інакше згоду можна було б проставити за
# іншого. Персонал читає все: школа мусить довести, що поінформувала, а
# без можливості перевірити це доведення неможливе.
rules['policy_ack'] = R(
    read=f"{AUTH} && {STAFF}",
    children={'$se': R(
        read=f"{AUTH} && ($se === {SE} || {STAFF})",
        write=f"{AUTH} && $se === {SE}",
        children={
            'version': R(validate="newData.isString() && newData.val().length <= 20"),
            'ts':      R(validate="newData.isNumber()"),
            'opts':    R(children={'$k': R(validate="newData.isBoolean()")}),
        })})

# ── Дні народження класу ──
# student_birthdays/{клас}/{учень} = "MM-DD"
#
# НАВІЩО ОКРЕМО. Дата народження лежить у картці учня, а картку класу
# батькам відкривати не можна: там медичні дані, PESEL і телефони. Тут —
# рівно день і місяць, без року, тож клас може бачити, у кого свято.
# Батько теж пише — але лише рядок СВОЄЇ дитини. Інакше збереження картки
# ламалося б цілком: дата народження летить у той самий атомарний запис, і
# відмова на одному шляху відхиляє обидва.
OWN_STU = (f"({MINE('$cls')} && root.child('students_list').child($cls).child($sid).val() "
           f"=== {MYNAME})")
rules['student_birthdays'] = R(
    read=f"{AUTH} && {STAFF}",
    children={'$cls': R(
        read=f"{AUTH} && ({STAFF} || {MINE('$cls')})",
        children={'$sid': R(
            write=f"{AUTH} && (({EDU} && {TCLS('$cls')}) || {OWN_STU})",
            validate="!newData.exists() || (newData.isString() && newData.val().length === 5)")})})

# ── Позначки про надіслані нагадування ──
# birthday_notices/{клас}/{учень} = "YYYY-MM-DD" — дата свята, про яке вже
# нагадали класному керівнику.
#
# НАВІЩО. Запланована функція прокидається щодня. Без позначки вона щодня
# слала б те саме нагадування про той самий день народження — сім разів
# поспіль. Зберігаємо саме дату свята, а не «надіслано»: наступного року
# дата буде інша, і нагадування прийде знову без жодного прибирання.
#
# ХТО ПИШЕ. Тільки сервер: функція ходить у базу сервісним ключем і правила
# на неї не поширюються. Тому тут write заборонено всім — щоб з браузера
# ніхто не міг «погасити» чуже нагадування. Читати може персонал: інакше
# незрозуміло, чому нагадування не прийшло.
rules['birthday_notices'] = R(
    read=f"{AUTH} && {STAFF}",
    write="false")

# ── Дзеркало оцінок по учнях ──
# student_grades/{клас}/{учень}/{місяць}/{предмет}/{дата} = {v, t}
#
# НАВІЩО ОКРЕМИЙ ВУЗОЛ. В основному `grades` учень стоїть ОСТАННІМ сегментом,
# тож правило не може обмежити батька його дитиною: щоб дістати одну оцінку,
# треба спершу відкрити весь клас. Тут учень другий — і заборона стає
# властивістю бази, а не ввічливістю інтерфейсу.
#
# Персонал читає вузол цілком (учителю свій клас видно й так), батько й
# учень — рівно свою гілку. Пише лише вчитель із доступом до класу.
rules['student_grades'] = R(
    read=f"{AUTH} && {EDU}",
    children={'$cls': R(
        read=f"{AUTH} && {EDU}",
        write=f"{AUTH} && {EDU} && {TCLS('$cls')}",
        children={'$sid': R(
            read=f"{AUTH} && ({EDU} || ({MINE('$cls')} && ($sid === {MYSID} || $sid === {MYNAME}) || {MY_STU('$cls','$sid')}))")})})

# Чернетки розкладу лежать як schedule_drafts/{версія}/{клас} — це інструмент
# директора, класової логіки тут немає.
rules['schedule_drafts'] = R(read=f"{AUTH} && {EDU}", write=f"{AUTH} && {ADMIN}")





# Мета наліпок: sticker_goal/{клас} = число. Скільки наліпок до призу.
# Читають усі авторизовані — учень і батько бачать ту саму смужку
# прогресу, що й учитель. Пише той, хто допущений до класу: класний
# керівник або директор. Обмежуємо число, щоб зіпсований клієнт не
# записав сюди нуль чи текст — на нуль ділити не можна.
rules['sticker_goal'] = R(
    read=AUTH,
    children={'$cls': R(
        write=f"{AUTH} && {EDU} && {TCLS('$cls')}",
        validate="newData.isNumber() && newData.val() >= 1 && newData.val() <= 500")})

# Назви перерв: break_names/{клас}/{після якого уроку} = «Обід 1-3 класи».
# Час перерв тут НЕ зберігається — він завжди береться з bell_schedules,
# щоб два джерела не розійшлися. Читають усі, пише директор.
rules['break_names'] = R(
    read=AUTH, write=f"{AUTH} && {ADMIN}",
    children={'$cls': {'$after': R(
        validate="newData.isString() && newData.val().length <= 60")}})

# Каталог предметів: subjects_catalog/{рік}/{клас}/{ключ} = {name, teacherEmail, teacherName}.
# Це перелік, з якого обирають у конструкторі, а не дані журналу. Читають усі
# авторизовані (учитель має бачити список), пише директор.
#
# ПРО ВАЛІДАЦІЮ. Старі записи були простими рядками, тому дозволяємо обидві
# форми: рядок або об'єкт з name. Інакше дані, записані до цієї зміни,
# стали б невалідними й школа не змогла б їх навіть прибрати.
rules['subjects_catalog'] = R(
    read=AUTH, write=f"{AUTH} && {ADMIN}",
    children={'$a': {'$b': {'$key': R(
        validate="newData.isString() && newData.val().length <= 80"
                 " || newData.hasChild('name') && newData.child('name').isString()"
                 " && newData.child('name').val().length <= 80")}}})

# Окремий каталог гуртків з тими самими правами адміністрації.
rules['clubs_catalog'] = R(
    read=AUTH, write=f"{AUTH} && {ADMIN}",
    children={'$year': {'$cls': {'$key': R(
        validate="newData.hasChildren(['name','teacherEmail','teacherName'])"
                 " && newData.child('name').isString() && newData.child('name').val().length > 0"
                 " && newData.child('name').val().length <= 80"
                 " && newData.child('teacherEmail').isString() && newData.child('teacherName').isString()")}}})

# Чергування уроків: schedule_alt/{клас}/{понеділок}/{День}/{слот} = назва предмета.
# Читають усі авторизовані — батькам це потрібно, щоб знати, що класти в рюкзак.
# Пише вчитель, допущений до цього класу, або директор. Значення — короткий
# рядок; так зіпсований клієнт не заллє сюди сторонні дані.
rules['schedule_alt'] = R(
    read=AUTH,
    children={'$cls': R(
        write=f"{AUTH} && {EDU} && {TCLS('$cls')}",
        children={'$week': {'$day': {'$slot': R(
            validate="newData.isString() && newData.val().length <= 80")}}})})

# Класна година: class_hour/{клас} = {day, number, time}.
#
# ЧОМУ ОКРЕМО ВІД РОЗКЛАДУ. Розклад цілком перезаписує імпорт із Word.
# Класна година, дописана в розклад, зникла б при першому ж імпорті —
# мовчки, і ніхто б не зрозумів, куди вона поділася.
#
# ЧИТАЮТЬ УСІ авторизовані: батькам і учням її видно в розкладі дня.
# ПИШЕ класний керівник саме цього класу або директор. Учитель-предметник,
# навіть допущений до класу, не пише: класна година — справа класу.
rules['class_hour'] = R(
    read=AUTH,
    children={'$cls': R(
        write=f"{AUTH} && ({ADMIN} || ({EDU} && {CT_OF('$cls')}))",
        children={
            'day':    R(validate="newData.isString() && newData.val().length <= 12"),
            'number': R(validate="newData.isNumber() && newData.val() >= 0 && newData.val() <= 20"),
            'time':   R(validate="newData.isString() && newData.val().length <= 20"),
        })})

# Родина пише лише за себе і лише туди, де це передбачено
rules['attendance']["$cls"]["$date"] = {"$name": {"$slot": R(
    write = (f"{AUTH} && ({EDU} && {TCLS('$cls')}"
             f" || ({MINE('$cls')} && $slot === 'all' && ($name === {MYNAME} || $name === {MYSID} || {MY_STU('$cls','$name')})))"))}}
# ЧИТАННЯ ВІДВІДУВАНОСТІ РОДИНОЮ — ЛИШЕ СВОЯ ДИТИНА.
# Раніше родина читала весь вузол класу (право MINE на рівні $cls, як у
# решті CLASS_NODES) — тобто через консоль браузера бачила відмітки й
# причини відсутності («хворіє») усіх однокласників. Тепер клас цілком
# читає лише персонал, а родина — тільки гілку {дата}/{своя дитина}.
rules['attendance']['$cls']['.read'] = f"{AUTH} && {STAFF}"
MYSID_OK = "root.child('users').child(auth.uid).child('studentId').isString() && root.child('users').child(auth.uid).child('studentId').val().length > 0"
rules['attendance']['$cls']['$date']['$name']['.read'] = (
    f"{AUTH} && {MINE('$cls')} && ($name === {MYNAME} || $name === {MYSID} || {MY_STU('$cls','$name')}"
    # Старі відмітки лежать під імʼям зі СПИСКУ класу. Якщо школа змінила
    # написання (пробіл, апостроф) і воно розійшлося з імʼям у профілі,
    # батько не міг прочитати власну дитину, а статистика харчування падала
    # на PERMISSION_DENIED. Імʼя беремо зі списку за ідентифікатором дитини.
    f" || ({MYSID_OK} && $name === root.child('students_list').child($cls).child({MYSID}).val()))")

# ── Реакції на коментар: reactions/{клас}/{дата}/{предмет}/{учень} ──
#
# ТУТ БУЛА ПОМИЛКА ГЛИБИНИ. Правило описувало шлях {клас}/{дата}/{учень} —
# на один рівень коротший за справжній. Через це «$name» насправді
# збігався з ПРЕДМЕТОМ, і перевірка «$name — це моя дитина» ніколи не
# справджувалася: батько отримував Permission denied на кожну реакцію.
#
# Правило мусить повторювати форму даних, а не її скорочений переказ.
# Значення — лише емодзі зі списку COMMENT_REACTS (common.js); міняти парою.
COMMENT_REACTS = ['👍', '❤️', '🔥', '👌', '🤝', '😔', '🤔']
rules['reactions']["$cls"]["$date"] = {"$subj": {"$name": R(
    # Учитель — лише свого класу (ревізія 10.10.2026: раніше будь-який
    # учитель школи міг поставити чи стерти реакцію родини в чужому класі).
    write = f"{AUTH} && (({EDU} && {TCLS('$cls')}) || ({MINE('$cls')} && ($name === {MYNAME} || $name === {MYSID} || {MY_STU('$cls','$name')})))",
    validate = "newData.isString() && (" + " || ".join(f"newData.val() === '{e}'" for e in COMMENT_REACTS) + ")")}}
# ── Хто написав коментар і хто з родини його переглянув (comments-view.js) ──
# comment_meta/{клас}/{дата}/{предмет}/{учень} = {by, se, name, ts}
#   Пише вчитель класу разом із коментарем (by — лише свій uid). Читає персонал.
# comment_seen/{клас}/{дата}/{предмет}/{учень}/{uid} = {ts, se, role, pr, r?, rts?}
#   «Переглянуто» й реакція з часом. Пише сама родина свій запис і лише
#   на наявний коментар своєї дитини; читає персонал і сама людина свій.
_own_stu = f"({MINE('$cls')} && ($sid === {MYNAME} || $sid === {MYSID} || {MY_STU('$cls','$sid')}))"
rules['comment_meta'] = {".read": f"{AUTH} && {EDU}", "$cls": R(
    read=f"{AUTH} && {EDU}", write=f"{AUTH} && {EDU} && {TCLS('$cls')}",
    children={'$date': {'$subj': {'$sid': R(
        validate="newData.hasChildren(['by','ts'])",
        children={'by': R(validate="newData.val() === auth.uid || (data.exists() && newData.val() === data.val())"),
                  'se': R(validate="newData.isString() && newData.val().length <= 120"),
                  'name': R(validate="newData.isString() && newData.val().length <= 80"),
                  'ts': R(validate="newData.isNumber()"),
                  '$other': R(validate="false")})}}})}
rules['comment_seen'] = {".read": f"{AUTH} && {EDU}", "$cls": R(read=f"{AUTH} && {EDU}",
    children={'$date': {'$subj': {'$sid': {'$uid': R(
        read=f"{AUTH} && $uid === auth.uid",
        write=(f"{AUTH} && $uid === auth.uid && {FAMILY} && {_own_stu}"
               # Старі коментарі лежать під ІМЕНЕМ, а родина пише під ідентифікатором
               # (ключ із дзеркала) — тож годиться й наявний текст у дзеркалі
               " && (root.child('comments').child($cls).child($date).child($subj).child($sid).exists()"
               " || root.child('student_comments').child($cls).child($sid).child($date).child($subj).child('t').exists())"),
        validate="newData.hasChildren(['ts','se','role'])",
        children={'ts': R(validate="newData.isNumber()"),
                  'se': R(validate=f"newData.val() === {SE}"),
                  'role': R(validate="newData.val() === 'parent' || newData.val() === 'student'"),
                  'pr': R(validate="newData.isString() && newData.val().length <= 20"),
                  'r': R(validate="newData.isString() && (" + " || ".join(f"newData.val() === '{e}'" for e in COMMENT_REACTS) + ")"),
                  'rts': R(validate="newData.isNumber()"),
                  '$other': R(validate="false")})}}}})}

# ── Заявки на перескладання: retake_requests/{клас}/{предмет}/{дата}/{учень} ──
#
# Та сама помилка, що й у реакціях, ще й із переставленими рівнями: у
# правилі стояло {клас}/{дата}/{учень}, а насправді після класу йде
# ПРЕДМЕТ. Заявка від учня чи батьків не проходила взагалі.
# РЕВІЗІЯ 10.10.2026. Заявка не мала жодної перевірки: батько з консолі міг
# записати status:'approved' сам собі (ліміт рахується лише в браузері) або
# HTML у поле grade, яке вчитель бачив у вікні заявок. Тепер родина лише
# СТВОРЮЄ заявку зі статусом 'pending'; рішення — тільки за вчителем.
rules['retake_requests']["$cls"]["$subj"] = {"$date": {"$name": R(
    write = (f"{AUTH} && ({EDU} || ({MINE('$cls')} && ($name === {MYNAME} || $name === {MYSID} || {MY_STU('$cls','$name')})"
             " && !data.exists() && newData.child('status').val() === 'pending'))"),
    validate = "newData.hasChildren(['status']) && $date.matches(/^[0-9]{4}-[0-9]{2}-[0-9]{2}(__[0-9]+)?$/)",
    children = {
        'status':      R(validate="newData.val() === 'pending' || newData.val() === 'approved' || newData.val() === 'rejected'"),
        'grade':       R(validate="(newData.isNumber() && newData.val() >= 0 && newData.val() <= 12) || (newData.isString() && newData.val().length <= 4)"),
        'requestDate': R(validate="newData.isString() && newData.val().matches(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/)"),
        '$other':      R(validate="false")})}}

# ── Здача робіт учнями: homework_submissions/{клас}/{дата}/{предмет}/{учень} ──
rules['homework_submissions']["$cls"]["$date"] = {"$subj": {"$name": R(
    write = f"{AUTH} && ({EDU} || ({MINE('$cls')} && ($name === {MYNAME} || $name === {MYSID} || {MY_STU('$cls','$name')})))")}}

# ── Картка учня: медичні дані, PESEL, договір ──
# КАРТКИ — ЛИШЕ КЛАСНОМУ КЕРІВНИКУ Й АДМІНІСТРАЦІЇ (06.10.2026). Раніше
# читати їх міг будь-який учитель школи — PESEL, адресу, діагнози й
# «кому заборонено забирати» дітей з усіх класів. Предметнику це не
# потрібно; швидкий журнал алергій більше не показує.
rules['student_cards'] = {".read": f"{AUTH} && {ADMIN}", "$cls": R(
    read = f"{AUTH} && ({ADMIN} || {CT_OF('$cls')})",
    children={"$key": R(
    read  = (f"{AUTH} && ({MINE('$cls')} && root.child('students_list').child($cls).child($key).val() === {MYNAME})"),
    write = (f"{AUTH} && ({ADMIN} || {CT_OF('$cls')}"
             f" || ({MINE('$cls')} && root.child('students_list').child($cls).child($key).val() === {MYNAME}))"))})}

# ── Харчування ──
rules['menu'] = {"$date": R(read=AUTH, write=f"{AUTH} && ({KITCHEN} || {ADMIN})")}
OWN_MEAL = f"({MINE('$cls')} && ({MINE_STU('$name')} || {MY_STU('$cls','$name')}))"
rules['meal_plan'] = {".read": f"{AUTH} && {STAFF}", "$cls": {"$name": R(
    read  = f"{AUTH} && ({STAFF} || {OWN_MEAL})",
    write = f"{AUTH} && ({KITCHEN} || {ADMIN} || {OWN_MEAL})")}}
rules['meal_day'] = {".read": f"{AUTH} && {STAFF}", "$date": {"$cls": {"$name": R(
    read  = f"{AUTH} && ({STAFF} || {OWN_MEAL})",
    write = f"{AUTH} && ({KITCHEN} || {ADMIN} || {OWN_MEAL})")}}}

# ── Басейн і шкільний автобус ──
#
# activity_plan/{клас}/{учень} = {pool:bool, bus:bool} — постійна відповідь.
#   Питається один раз, змінити можна будь-коли (як «дитина обідає в школі»).
# pool_week/{клас}/{понеділок}/{учень} = {going:false} — тижневий виняток.
#   ЗБЕРІГАЄМО ЛИШЕ ВІДМОВИ. Немає запису — дитина йде: типова відповідь «так»,
#   і не треба щотижня заводити рядок на кожного учня школи лише щоб
#   підтвердити очікуване. Тиждень позначаємо датою понеділка.
#
# Права ті самі, що в meal_plan: бачить персонал і своя родина, пише своя
# родина й адміністрація. Кухня сюди не допущена — це не про харчування.
for node, depth in (('activity_plan', 1), ('pool_week', 2)):
    own = (f"({MINE('$cls')} && ($name === {MYNAME} || $name === {MYSID}"
           f" || {MY_STU('$cls','$name')}))")
    leaf = R(read  = f"{AUTH} && ({STAFF} || {own})",
             write = f"{AUTH} && ({ADMIN} || {own})")
    rules[node] = {".read": f"{AUTH} && {STAFF}",
                   "$cls": ({"$name": leaf} if depth == 1
                            else {"$week": {"$name": leaf}})}

# ── Навчальні ігри ──
#
# games_progress/{клас}/{учень}/{гра} = {best, plays, last, total, lastAt, by}
#
# Права влаштовані як у activity_plan, з двома відмінностями.
#
# ПИШЕ ТІЛЬКИ СВОЯ РОДИНА — адміністрацію сюди не пускаємо навіть на
# запис. У решті вузлів ADMIN потрібен, щоб виправити чужу помилку:
# директор може змінити відповідь про басейн, бо це організаційне
# рішення школи. Тут виправляти нічого — це особистий результат дитини,
# і сторонньої руки в ньому бути не повинно.
#
# КУХНЯ НЕ ЧИТАЄ. STAFF включає роль kitchen, і в харчуванні це доречно.
# Хто скільки разів помилився в таблиці множення — не її справа, тож
# читання тут на EDU, а не на STAFF.
#
# Ключ гри ($game) окремо не описуємо: дозвіл на $name поширюється на
# все, що під ним. Список ігор живе в games.js і в правилах не потрібен —
# інакше кожна нова гра вимагала б викладати правила заново.
_own = (f"({MINE('$cls')} && ($name === {MYNAME} || $name === {MYSID}"
        f" || {MY_STU('$cls','$name')}))")
rules['games_progress'] = {
    ".read": f"{AUTH} && {EDU}",
    "$cls": {"$name": R(read  = f"{AUTH} && ({EDU} || {_own})",
                        write = f"{AUTH} && {_own}")}}

# ── Заміни, згоди, відсутність персоналу ──
rules['substitutions'] = {".read": f"{AUTH} && {STAFF}", "$date": {"$cls": R(
    read  = f"{AUTH} && ({STAFF} || {MINE('$cls')})",
    write = f"{AUTH} && {ADMIN}")}}
# ── Оголошення ──
# Читають усі, хто увійшов: це і є сенс стрічки. Пише адміністрація —
# на всю школу або на клас; учитель — лише в клас, до якого має доступ.
rules['announcements'] = {".read": AUTH,
  "$id": R(write=(f"{AUTH} && ({ADMIN}"
                  # Педагог-організатор пише будь-куди, а видаляє лише своє (правило автора нижче)
                  f" || ({PERM('news')} && newData.exists())"
                  f" || ({TEACH} && newData.child('scope').val() === 'class'"
                  f" && root.child('teacher_access').child({SE}).child(newData.child('class').val()).exists())"
                  f" || (data.exists() && !newData.exists() && data.child('author').val() === auth.uid))"))}

# ── Реакції на оголошення й «хто переглянув» (news-reactions.js) ──
# news_reactions/{оголошення}/{uid} = код реакції. Читають усі (лічильники):
# ключ — uid, за ним інша родина не впізнає, хто це. Пише лише сама родина
# свій ключ і лише на наявне оголошення.
# news_seen/{оголошення}/{uid} = {ts, se, cls, child, role, pr}. Читає лише
# персонал; пише родина свій ключ, і se — саме її пошта.
_ann_ok = "root.child('announcements').child($id).exists()"
rules['news_reactions'] = {".read": AUTH, "$id": {"$uid": R(
    write=f"{AUTH} && $uid === auth.uid && {FAMILY} && {_ann_ok}",
    validate="newData.isString() && newData.val().matches(/^(like|love|party|thanks|wow|sad)$/)")}}
rules['news_seen'] = {".read": f"{AUTH} && {EDU}", "$id": {".read": f"{AUTH} && {EDU}", "$uid": R(
    write=f"{AUTH} && $uid === auth.uid && {FAMILY} && {_ann_ok}",
    validate="newData.hasChildren(['ts','se','role'])",
    children={
        'ts':    R(validate="newData.isNumber()"),
        'se':    R(validate=f"newData.val() === {SE}"),
        'role':  R(validate="newData.val() === 'parent' || newData.val() === 'student'"),
        'cls':   R(validate="newData.isString() && newData.val().matches(/^class_[0-9]{1,2}$/)"),
        'child': R(validate="newData.isString() && newData.val().length <= 80"),
        'pr':    R(validate="newData.isString() && newData.val().length <= 20"),
        '$other': R(validate="false")})}}

rules['consents'] = {".read": AUTH, "$id": R(write=f"{AUTH} && {ADMIN}")}
rules['consent_responses'] = {".read": f"{AUTH} && {EDU}",
    "$id": {".read": f"{AUTH} && {EDU}", "$cls": {"$name": R(
    read  = f"{AUTH} && ({EDU} || ({MINE('$cls')} && ($name === {MYNAME} || $name === {MYSID} || {MY_STU('$cls','$name')})))",
    write = f"{AUTH} && ({ADMIN} || ({MINE('$cls')} && ($name === {MYNAME} || $name === {MYSID} || {MY_STU('$cls','$name')})))")}}}
rules['staff_absence'] = {"$date": R(read=f"{AUTH} && {STAFF}", write=f"{AUTH} && {ADMIN}")}

# ── Погоджені накладки в конструкторі розкладу ──
#
# schedule_warn_ok/{чернетка}/{ключ} = {by, ts}
#
# «Той самий учитель у двох класах одночасно» — не завжди помилка: буває
# поїздка на басейн або об'єднана група. Директор позначає такі випадки як
# нормальні, щоб серед них було видно справжні накладки.
#
# ЧИТАЮТЬ УСІ, ХТО БАЧИТЬ КОНСТРУКТОР — а це не лише директор: матрицю
# відкривають і майстер-роль, і вчитель через «Матриця розкладу». Якби
# читання було лише в адміністрації, у решти список попереджень мовчки
# показував би вже вирішене як невирішене.
#
# ПИШЕ АДМІНІСТРАЦІЯ. Це рішення про розклад школи, а не про свій урок.
rules['schedule_warn_ok'] = {".read": f"{AUTH} && {EDU}",
    "$draft": R(read=f"{AUTH} && {EDU}", write=f"{AUTH} && {ADMIN}")}

# ── Спільні довідники: читають усі, змінює адміністрація ──
for node in ['academic_year','bell_schedules','grade_type_defs',
             'class_teachers']:
    rules[node] = R(read=AUTH, write=f"{AUTH} && {ADMIN}")
# Свята й культурно-виховні заходи веде ще й педагог-організатор. Канікули
# й семестри — лише адміністрація (вони впливають на навантаження й журнал).
# events/{id} = {title, date, time?, place?, note?, classes, by, ts}
EV_STR = lambda n: R(validate=f"newData.isString() && newData.val().length <= {n}")
rules['academic_year']['$year'] = {
    'holidays': R(write=f"{AUTH} && {PERM('calendar')}"),
    'events': R(write=f"{AUTH} && ({ADMIN} || {PERM('calendar')})", children={'$id': R(
        validate="newData.hasChildren(['title','date','classes'])",
        children={
            'title': EV_STR(120),
            'date':  R(validate="newData.isString() && newData.val().matches(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/)"),
            'time':  R(validate="newData.isString() && newData.val().matches(/^([0-9]{2}:[0-9]{2})?$/)"),
            'place': EV_STR(120), 'note': EV_STR(400), 'by': EV_STR(200), 'byName': EV_STR(120),
            'ts':    R(validate="newData.isNumber()"),
            'classes': R(validate="(newData.isString() && newData.val() === 'all') || newData.hasChildren()"),
            '$other': R(validate="false")
        })})}
# Ролі з конструктора: читають усі (кабінет будується з прав), пише адміністрація.
rules['custom_roles'] = {".read": AUTH, "$rid": R(
    write=f"{AUTH} && {ADMIN}",
    validate="$rid.matches(/^(organizer|cr_[a-z0-9]{3,24})$/) && newData.hasChildren(['name','perms'])",
    children={
        'name':  R(validate="newData.isString() && newData.val().length >= 2 && newData.val().length <= 40"),
        'icon':  R(validate="newData.isString() && newData.val().length <= 8"),
        'perms': R(children={**{p: R(validate="newData.isBoolean()") for p in ROLE_PERMS}, '$other': R(validate="false")}),
        'by':    R(validate="newData.isString() && newData.val().length <= 200"),
        'ts':    R(validate="newData.isNumber()"),
        '$other': R(validate="false")
    })}

# Налаштування «🔍 Контролю» (teacher-control.js): винятки для ДЗ і пороги.
rules['control_settings'] = R(read=f"{AUTH} && {ADMIN}", write=f"{AUTH} && {ADMIN}",
    validate="newData.hasChildren(['gradeGapDays','maxHwPerDay'])",
    children={
        'noHwSubjects': R(children={'$i': R(validate="newData.isString() && newData.val().length <= 60")}),
        'noHwClasses':  R(children={'$i': R(validate="newData.isString() && newData.val().matches(/^class_[0-9]{1,2}$/)")}),
        'gradeGapDays': R(validate="newData.isNumber() && newData.val() >= 3 && newData.val() <= 60"),
        'maxHwPerDay':  R(validate="newData.isNumber() && newData.val() >= 2 && newData.val() <= 15"),
        'by': R(validate="newData.isString() && newData.val().length <= 200"),
        'ts': R(validate="newData.isNumber()"),
        '$other': R(validate="false")
    })

# Позначка «підсумок тижня надіслано» — пише лише серверна функція
# week-digest (службовий акаунт обходить правила), читає адміністрація.
rules['digest_sent'] = R(read=f"{AUTH} && {ADMIN}", write="false")

# ── 🔔 Центр сповіщень (notif-center.js) ─────────────────────────
# notif_seen/{uid} = {ts} — коли людина востаннє переглянула сповіщення.
# Самі сповіщення не зберігаються: центр збирає їх із даних, які людина
# й так бачить (оцінки й коментарі своєї дитини, ДЗ класу, оголошення,
# запити «обговорити»). Тож новий вузол — лише одна позначка часу, своя.
# Час не з майбутнього: інакше «все прочитано» назавжди сховало б нове.
rules['notif_seen'] = {'$uid': R(
    read="auth != null && $uid === auth.uid",
    write="auth != null && $uid === auth.uid",
    validate="newData.hasChildren(['ts'])",
    children={'ts': R(validate="newData.isNumber() && newData.val() <= now + 600000"),
              '$other': R(validate="false")})}

# ── «💬 Хочу обговорити» (talk-requests.js) ──────────────────────
# Запит батька вчителю предмета. СТАН і ЗМІСТ — у різних вузлах:
#   talk_requests/{клас}/{пошта батька}/{id} — предмет, дата, статус.
#       Читають автор, учителі класу, директор (для «Контролю»: хто не
#       відповів понад 3 дні).
#   talk_text/{клас}/{пошта батька}/{id} — причина, текст, відповідь.
#       Читають лише автор і вчителі цього класу / класний керівник.
#       ADMIN тут свідомо немає, MASTER — теж (як і для листування).
# Позначки notified / replyNotified ставить лише сервер (notify.js), щоб
# одне й те саме сповіщення не можна було викликати вдруге.
def TOF(v): return (f"(root.child('teacher_access').child({SE}).child({v}).exists()"
                    f" || root.child('class_teachers').child({v}).child('teacherEmail').val() === auth.token.email)")
def PARENT_OF(v): return f"({ROLE} === 'parent' && {v} === {MYCLS})"
TALK_NEW = (f"!data.exists() && $se === {SE} && {PARENT_OF('$cls')}")
NOWISH = "newData.val() > now - 600000 && newData.val() < now + 600000"
STR = lambda n, lo=0: f"newData.isString() && newData.val().length >= {lo} && newData.val().length <= {n}"
rules['talk_requests'] = R(read=f"{AUTH} && {ADMIN}", children={'$cls': R(
    read=f"{AUTH} && ({ADMIN} || {TOF('$cls')})", children={'$se': R(
    read=f"{AUTH} && $se === {SE}", children={'$id': R(
        write=(f"{AUTH} && (({TALK_NEW} && newData.child('byEmail').val() === auth.token.email"
               f" && newData.child('childName').val() === {MYNAME}"
               f" && (newData.child('child').val() === {MYNAME} || newData.child('child').val() === {MYSID})"
               f" && newData.child('status').val() === 'open' && !newData.hasChild('replyTs') && !newData.hasChild('replyBy'))"
               f" || ({ADMIN} && !newData.exists()))"),
        validate="newData.hasChildren(['byEmail','child','childName','subject','ts','status'])",
        children={
            'byEmail':   R(validate=STR(200)),
            'child':     R(validate=STR(120, 1)),
            'childName': R(validate=STR(120)),
            'subject':   R(validate=STR(80, 1)),
            # Час — лише «зараз» (±10 хв на годинник телефона). Інакше батько
            # міг поставити запиту давню дату: сповіщення вчителю не йшло
            # («застарий»), а в «Контролі» директор бачив «N днів без відповіді».
            'ts':        R(validate=f"newData.isNumber() && {NOWISH}"),
            'status':    R(write=f"{AUTH} && ({TOF('$cls')} || ($se === {SE} && newData.val() === 'closed'))",
                           validate="newData.val() === 'open' || newData.val() === 'answered' || newData.val() === 'closed'"),
            'replyTs':   R(write=f"{AUTH} && {TOF('$cls')}", validate=f"newData.isNumber() && {NOWISH}"),
            'replyBy':   R(write=f"{AUTH} && {TOF('$cls')}", validate=STR(200)),
            'notified':      R(validate="false"),
            'replyNotified': R(validate="false"),
            '$other':    R(validate="false")
        })})})})
rules['talk_text'] = {'$cls': R(
    read=f"{AUTH} && {TOF('$cls')}", children={'$se': R(
    read=f"{AUTH} && $se === {SE}", children={'$id': R(
        write=f"{AUTH} && (({TALK_NEW} && !newData.hasChild('reply')) || ({ADMIN} && !newData.exists()))",
        validate="newData.hasChildren(['reason'])",
        children={
            'reason': R(validate="newData.isString() && newData.val().matches(/^(grades|topic|hw|behavior|other)$/)"),
            'text':   R(validate=STR(300)),
            'reply':  R(write=f"{AUTH} && {TOF('$cls')}", validate=STR(500, 1)),
            '$other': R(validate="false")
        })})})}

# ── Учні, що вибули: students_left/{клас}/{ключ} = {name, to?, at, by} ──
# Пише той, хто може правити список класу. Читає персонал — щоб в історії
# (відмітки, оцінки, коментарі) був «Імʼя (вибув)», а не ключ «-P-OCC9…».
rules['students_left'] = R(read=f"{AUTH} && {STAFF}", children={'$cls': R(
    write=f"{AUTH} && {EDU} && {TCLS('$cls')}",
    children={'$key': R(validate="newData.hasChildren(['name','at'])", children={
        'name': R(validate="newData.isString() && newData.val().length >= 1 && newData.val().length <= 120"),
        'to':   R(validate="newData.isString() && newData.val().matches(/^class_[0-9]{1,2}$/)"),
        'at':   R(validate="newData.isNumber()"),
        'by':   R(validate="newData.isString() && newData.val().length <= 200"),
        '$other': R(validate="false")})})})

# ── «📅 Зміни в розкладі» (netlify/functions/schedule-changes.js) ──
# schedule_watch/{клас} — знімок, про який родини вже знають; sub_seen/{клас}
# — про які заміни вже сповіщено. Пише лише сервер (службовий ключ), читає
# адміністрація. schedule_changes/{клас}/{id} = {ts, lines} — що змінилося:
# кабінет показує родині свого класу кілька днів.
rules['schedule_watch'] = R(read=f"{AUTH} && {ADMIN}", write="false")
rules['sub_seen'] = R(read=f"{AUTH} && {ADMIN}", write="false")
rules['schedule_changes'] = R(read=f"{AUTH} && {STAFF}", write="false",
    children={'$cls': R(read=f"{AUTH} && ({STAFF} || {MINE('$cls')})", index=['ts'])})

# Шкалу і кількість стовпців задає вчитель свого класу/предмета. Тип
# стовпця теж змінює вчитель: стара адміністративна заборона робила цей
# перемикач у журналі декоративним.
for node in ['grade_scales','journal_columns','journal_column_types']:
    rules[node] = R(
        read=AUTH,
        children={'$cls': R(write=f"{AUTH} && {EDU} && {TCLS('$cls')}")})
rules['grade_scales']['$cls']['$subj'] = R(
    validate="!$cls.matches(/^class_[1-4]$/) && newData.hasChild('max') && newData.child('max').isNumber() && newData.child('max').val() >= 2 && newData.child('max').val() <= 2000")
rules['journal_columns']['$cls']['$ym'] = {'$subj': {'$date': {'count': R(
    validate="newData.isNumber() && newData.val() >= 1 && newData.val() <= 30")}}}
# Вчитель має бачити СВІЙ рядок доступів — щоб знати, батькам яких класів
# він може писати. Решта вузла лишається директорською.
# Матрицю доступу читає директор — це документ про всю школу: хто який
# предмет веде. Кожен учитель бачить лише свій рядок.
#
# MASTER додано до читання свідомо: без матриці «Матриця розкладу» показує
# розклад без імен учителів, а значок заміни перестає щось означати. Це
# роль для налагодження, і саме розклад вона й налагоджує. Запис лишається
# тільки в директора.
rules['teacher_access'] = R(
    read=f"{AUTH} && ({ADMIN} || {MASTER})", write=f"{AUTH} && {ADMIN}",
    children={'$se': R(read=f"{AUTH} && $se === {SE}")})

# ── Тимчасовий доступ на заміну (див. TCLS) ──
# temp_access/{пошта}/{клас} = {until, subj:{ключ: назва}, date, by, at}
# Пише адміністрація, коли призначає заміну. Учитель читає свій рядок —
# щоб клас зʼявився в його списку на ці дні.
rules['temp_access'] = R(read=f"{AUTH} && {ADMIN}", write=f"{AUTH} && {ADMIN}", children={'$se': R(
    read=f"{AUTH} && $se === {SE}", children={'$cls': R(
        validate="newData.hasChildren(['until'])",
        children={
            'until': R(validate="newData.isNumber()"),
            'subj':  R(children={'$k': R(validate="newData.isString() && newData.val().length <= 80")}),
            'date':  R(validate="newData.isString() && newData.val().length === 10"),
            'by':    R(validate="newData.isString() && newData.val().length <= 200"),
            'at':    R(validate="newData.isNumber()"),
            '$other': R(validate="false")
        })})})

# ── Походження доступу і журнал доступу (access.js) ──
# Пише той самий, хто пише teacher_access, — директор/адміністратор.
# Журнал лише дописується: рядок не можна ні змінити, ні стерти, інакше
# «прозорість» доступу нічого не варта.
rules['teacher_access_meta'] = R(read=f"{AUTH} && {ADMIN}", write=f"{AUTH} && {ADMIN}")
rules['access_log'] = {".read": f"{AUTH} && {ADMIN}",
    ".indexOn": ["at"],
    "$id": R(write=f"{AUTH} && {ADMIN} && !data.exists() && newData.exists()",
             validate="newData.hasChildren(['at','t','cls','act','subj']) && newData.child('at').isNumber()"
                      " && (newData.child('act').val() === 'grant' || newData.child('act').val() === 'revoke')")}

for node in ['teacher_skills','graduates','migration_log']:
    rules[node] = R(read=f"{AUTH} && {STAFF}", write=f"{AUTH} && {ADMIN}")

# ── Доступ дитини до порталу ──
# Пише сюди лише серверна функція службовим акаунтом (він правила
# обходить), тому клієнту запис закритий повністю. Батько читає лише
# свій рядок: там логін і нікнейм його дитини.
rules['child_access'] = R(
    children={'$se': R(
        read=f"{AUTH} && ($se === {SE} || {ADMIN})",
        write="false")})

# ── Довідники для вибору співрозмовника ──
# ЧОМУ ОКРЕМІ ВУЗЛИ: щоб відкрити чат, батькові треба знати, кому писати.
# Раніше список збирався з `users`, `parent_links` і `teacher_access` — усі
# три директорські, тож у батька виходив Permission denied. Відкривати їх
# не можна: там медичні дані, PESEL і контакти всіх родин.
#
# Тому кожен пише САМ ПРО СЕБЕ рівно те, що потрібно для списку контактів:
# імʼя, роль і класи. Підробити роль не вийде — правило звіряє її з
# pre_approved_roles, куди пише лише директор.

# Персонал: бачить будь-хто, хто увійшов. Це робочі контакти школи.
rules['staff_directory'] = R(
    read=AUTH,
    children={'$se': R(
        write=f"{AUTH} && ($se === {SE} || {ADMIN})",
        validate=("!newData.exists() || (newData.hasChildren(['name','role']) && "
                  "root.child('pre_approved_roles').child($se).exists())"),
        children={
            'name':    R(validate="newData.isString() && newData.val().length <= 120"),
            'role':    R(validate="newData.isString() && newData.val().length <= 40"),
            # Значення — перелік предметів, які вчитель веде в цьому класі
            # (рядок «Інформатика, Математика»). Раніше клали true, і батько
            # бачив лише номери класів, які йому нічого не кажуть. true
            # лишаємо дозволеним: у базі є записи старого формату.
            'classes': R(children={'$cls': R(validate=(
                "newData.isBoolean() || (newData.isString() && newData.val().length <= 120)"))}),
            # Мініатюра 128×128 рядком (data:image/jpeg;base64,...).
            # Стеля з запасом до MAX_PHOTO_BYTES у common.js: у базу не
            # має потрапити повнорозмірний знімок на кілька мегабайт.
            'photo':   R(validate="newData.isString() && newData.val().length <= 60000"),
            'ts':      R(validate="newData.isNumber()"),
        })})

# Батьки: бачить адміністрація та вчитель того класу. Іншим батькам
# і учням список батьків класу закритий.
rules['class_parents'] = R(
    children={'$cls': R(
        read=f"{AUTH} && ({ADMIN} || root.child('teacher_access').child({SE}).child($cls).exists())",
        children={'$se': R(
            read=f"{AUTH} && $se === {SE}",
            write=f"{AUTH} && ({ADMIN} || ($se === {SE} && {FAMILY} && $cls === {MYCLS}))",
            children={
                'name':     R(validate="newData.isString() && newData.val().length <= 120"),
                'children': R(validate="newData.isString() && newData.val().length <= 200"),
                'ts':       R(validate="newData.isNumber()"),
            })})})

# ── Приватне листування: ключ чату — дві пошти через ___ ──
# ── Листування ──
# Доступ визначає список учасників у самому чаті, а не форма ключа.
SE_LOW = "auth.token.email.toLowerCase().replace('.','_')"
# Читати вузол chats цілком не може ніхто: кожен ходить за своїм
# покажчиком user_chats і бере лише ті чати, де він у members.
#
# Поле staff обовʼязкове при створенні: воно гарантує, що в розмові є
# хтось зі школи. Без нього двоє батьків могли б листуватися через
# портал. Перебрати всіх учасників і перевірити їхні ролі мова правил
# не вміє — тому співробітника вказують явно, а правило звіряє його з
# pre_approved_roles.
MEM = f"data.child('members').child({SE_LOW}).exists()"
NEWMEM = f"newData.child('members').child({SE_LOW}).exists()"
STAFF_OK = (f"root.child('pre_approved_roles').child(newData.child('staff').val()).exists()"
            f" && newData.child('members').child(newData.child('staff').val()).exists()")
# КЛЮЧ ЧАТУ — ЛИШЕ БЕЗПЕЧНІ СИМВОЛИ. Ключ іде в onclick у списку
# переписок. Ключі RTDB допускають ' & ; ( ), і чат із ключем на кшталт
# «x&#39;);…//» виконував чужий код у кабінеті співрозмовника (директора).
# Портал сам робить ключі з пошт через ___ або push() — під шаблон
# підпадають обидва.
# Лише конструкції, які вже працюють у цих правилах: клас символів і «+».
# Довжину — окремою умовою, а не квантором {1,300}.
CHAT_ID_OK = "($chatId.length <= 300 && $chatId.matches(/^[A-Za-z0-9_@+~!-]+$/))"
# РЕАКЦІЇ: chats/{id}/messages/{msg}/reactions/{пошта} = емодзі.
# Писати в чат учасник може цілком, тож заборонити запис глибше правилом
# .write не вийде. Але .validate спрацьовує на кожному записаному вузлі:
# реакцію можна поставити лише під СВОЄЮ поштою і лише коротким рядком.
# Зняти (записати null) — теж лише свою: validate на null не спрацьовує,
# тому це стереже клієнт; чужу реакцію підмінити на свою правило не дасть.
REACTION_OK = f"$k === {SE_LOW} && newData.isString() && newData.val().length > 0 && newData.val().length <= 8"
rules['chats'] = {"$chatId": R(
    read  = f"{AUTH} && {MEM}",
    write = (f"{AUTH} && {CHAT_ID_OK} && ({MEM}"       # учасник пише в свою розмову
             f" || (!data.exists() && {NEWMEM} && {STAFF_OK}))"),
    children={"messages": {"$msgId": {"reactions": {"$k": R(validate=REACTION_OK)}}}})}   # або створює нову
# Покажчик «мої переписки». Створювач розмови дописує його всім учасникам,
# тому пишемо не лише собі — але лише для чату, де ми справді учасники.
# Читання стоїть на рівні $se: кабінет бере СПИСОК своїх переписок одним
# запитом. Якщо лишити дозвіл лише на окремий запис, список не прочитається
# і вікно зависне на «Завантаження...».
rules['user_chats'] = {"$se": {
    ".read": f"{AUTH} && $se === {SE_LOW}",
    # Свій покажчик — завжди (зокрема прибрати старий на чат із «кривим»
    # ключем). Чужий — лише на чат із безпечним ключем, де ти учасник.
    "$chatId": R(write = (f"{AUTH} && ($se === {SE_LOW}"
                          f" || ({CHAT_ID_OK} && root.child('chats').child($chatId).child('members').child({SE_LOW}).exists()))"))}}


# ══════════════════════════════════════════════════════════════════
#  ХАРЧУВАННЯ ПЕРСОНАЛУ
# ══════════════════════════════════════════════════════════════════
#
# staff_meals/{пошта}            = {lunch:bool, ts}
#     Постійна відповідь співробітника: обідаю чи ні.
# staff_meal_day/{дата}/{пошта}  = {lunch:0|1, pick:'a'|'b', ts}
#     Виняток на конкретний день — рівно так само, як у дітей.
# staff_meal_price               = {lunch: число}
#     Скільки коштує обід для персоналу. Дітям ціну в порталі не рахують
#     (це справа школи й батьків), а персонал платить сам, тож кухні
#     потрібна сума.
#
# ЧОМУ ОКРЕМІ ВУЗЛИ, А НЕ meal_plan/staff. Правила харчування дітей
# звіряють клас і ключ учня зі списком класу — у співробітника немає ні
# того, ні іншого. Домішати його туди означало б у кожному рядку тих
# правил дописувати «або це персонал», і одна забута гілка відкрила б
# доступ до чужої дитини. Окремий вузол коштує кілька рядків тут і нічого
# не ускладнює в решті.
#
# ЧИТАЮТЬ УСІ СПІВРОБІТНИКИ, а не лише кухня: учитель має бачити, що
# замовив, а кухня — кого годувати. Особливого в цих даних немає, а
# окремі права на кожного лише ускладнили б показ.
_own_mail = f"$se === {SE}"
# Роль із конструктора з правом «харчування» — лише свій рядок.
MEALS_OWN = f"({PERM('meals')} && {_own_mail})"
rules['staff_meals'] = R(
    read=f"{AUTH} && {STAFF}",
    children={'$se': R(
        read=f"{AUTH} && {MEALS_OWN}",
        write=f"{AUTH} && (({STAFF} && ({_own_mail} || {KITCHEN} || {ADMIN})) || {MEALS_OWN})",
        children={
            'lunch': R(validate="newData.isBoolean()"),
            'ts':    R(validate="newData.isNumber()"),
        })})

rules['staff_meal_day'] = R(
    read=f"{AUTH} && {STAFF}",
    children={'$date': R(children={'$se': R(
        read=f"{AUTH} && {MEALS_OWN}",
        write=f"{AUTH} && (({STAFF} && ({_own_mail} || {KITCHEN} || {ADMIN})) || {MEALS_OWN})",
        children={
            'lunch': R(validate="newData.isNumber() && (newData.val() === 0 || newData.val() === 1)"),
            'pick':  R(validate="newData.isString() && (newData.val() === 'a' || newData.val() === 'b')"),
            'ts':    R(validate="newData.isNumber()"),
        })})})

# ── РЕКВІЗИТИ ДЛЯ ОПЛАТИ ────────────────────────────────────────
#
# payment_details = {name, iban, nip, titlePrefix, amount, ts}
#
# ЧИТАЮТЬ УСІ, ХТО УВІЙШОВ. Це не таємниця: ті самі цифри школа роздає
# батькам на папері й пише в договорі. Зате з них портал малює QR, і
# батько не переписує 26 цифр руками.
#
# ПИШЕ ЛИШЕ АДМІНІСТРАЦІЯ. Номер рахунку — саме те, що зловмиснику
# вигідно підмінити: підправив цифру, і платежі родин пішли не туди.
# Тому тут найвужче коло, яке взагалі є в порталі.
rules['payment_details'] = R(
    read=AUTH,
    write=f"{AUTH} && {ADMIN}",
    children={
        'name':        R(validate="newData.isString() && newData.val().length <= 20"),
        'iban':        R(validate="newData.isString() && newData.val().length <= 26"),
        'nip':         R(validate="newData.isString() && newData.val().length <= 10"),
        'titlePrefix': R(validate="newData.isString() && newData.val().length <= 32"),
        'amount':      R(validate="newData.isNumber() && newData.val() >= 0 && newData.val() <= 9999.99"),
        'ts':          R(validate="newData.isNumber()"),
    })

# ── ЦІНИ НА ХАРЧУВАННЯ ──────────────────────────────────────────
#
# meal_prices = {lunch, breakfast, snack, staff}
#
# ОДИН ВУЗОЛ НА ВСІ ЦІНИ. Спершу тут лежала окрема ціна для персоналу
# (staff_meal_price). Щойно цін стало чотири, стало видно, чим це
# закінчується: кожна нова позиція — новий вузол, нове правило, новий
# рядок у кожному читанні, і чотири місця, де ціна може розійтися.
#
# ЧИТАЮТЬ УСІ, ХТО УВІЙШОВ, а не лише персонал: батьки мають бачити, у
# що обійшовся місяць. Ціни — не таємниця, вони висять на стіні їдальні.
# Пише кухня або адміністрація.
rules['meal_price_history'] = R(read=AUTH, write=f"{AUTH} && ({KITCHEN} || {ADMIN})")
rules['takeaway_price_history'] = R(read=AUTH, write=f"{AUTH} && ({KITCHEN} || {ADMIN})")

# Особові рахунки: родина бачить лише свою дитину, записує кухня/адміністрація.
ACCOUNT_MINE = f"({MINE('$cls')} && ($sid === {MYSID} || $sid === {MYNAME} || root.child('students_list').child($cls).child($sid).val() === {MYNAME}))"
rules['meal_accounts'] = {'$cls': {'$sid': R(
    read=f"{AUTH} && ({KITCHEN} || {ADMIN} || {ACCOUNT_MINE})",
    children={'$entry': R(
        # Фінансовий журнал лише доповнюється. Помилку виправляють новим
        # від'ємним/додатним рядком, тому старі операції не можна стерти або
        # переписати без сліду навіть кухні чи директору.
        write=f"{AUTH} && ({KITCHEN} || {ADMIN}) && !data.exists() && newData.exists()",
        validate="!newData.exists() || newData.hasChildren(['amount','date','startDate','by','ts'])",
        children={
            'amount': R(validate="newData.isNumber() && newData.val() != 0 && newData.val() >= -100000 && newData.val() <= 100000"),
            'date': R(validate="newData.isString() && newData.val().matches(/^\\d{4}-\\d{2}-\\d{2}$/)"),
            'startDate': R(validate="newData.isString() && newData.val().matches(/^\\d{4}-\\d{2}-\\d{2}$/)"),
            'note': R(validate="newData.isString() && newData.val().length <= 120"),
            'by': R(validate="newData.isString() && newData.val().length <= 200"),
            'ts': R(validate="newData.isNumber()"),
            '$other': R(validate="false")
        })
})}}

# Сервер один раз закриває кожен день. Клієнт не може ні створити, ні
# виправити цю суму: інакше випадкове редагування старого меню знову
# змінило б баланс. Корекції йдуть окремими додатковими записами.
rules['meal_ledger'] = {'.read': f"{AUTH} && ({KITCHEN} || {ADMIN})", '$cls': {'$sid': R(
    read=f"{AUTH} && ({KITCHEN} || {ADMIN} || {ACCOUNT_MINE})",
    write='false'
)}}
rules['meal_ledger_adjustments'] = {'.read': f"{AUTH} && ({KITCHEN} || {ADMIN})", '$cls': {'$sid': R(
    read=f"{AUTH} && ({KITCHEN} || {ADMIN} || {ACCOUNT_MINE})",
    children={'$entry': R(
        write=f"{AUTH} && ({KITCHEN} || {ADMIN}) && !data.exists() && newData.exists()",
        validate=("newData.hasChildren(['amount','date','reason','by','ts']) && "
                  "root.child('meal_ledger').child($cls).child($sid)"
                  ".child(newData.child('date').val()).exists()"),
        children={
            'amount': R(validate="newData.isNumber() && newData.val() != 0 && newData.val() >= -100000 && newData.val() <= 100000"),
            'date': R(validate="newData.isString() && newData.val().matches(/^\\d{4}-\\d{2}-\\d{2}$/)"),
            'reason': R(validate="newData.isString() && newData.val().length > 0 && newData.val().length <= 160"),
            'by': R(validate="newData.isString() && newData.val().length <= 200"),
            'ts': R(validate="newData.isNumber()"),
            '$other': R(validate="false")
        })
    }
)}}

rules['meal_prices'] = R(
    read=AUTH,
    write=f"{AUTH} && ({KITCHEN} || {ADMIN})",
    children={k: R(validate="newData.isNumber() && newData.val() >= 0 && newData.val() <= 999")
              for k in ('lunch','breakfast','snack','staff')})

# Розбір налаштувань, що лишилися поза списками. Оригінали meal_plan
# зберігаються; рішення зі знімком джерела лише додаються до журналу.
rules['meal_orphan_resolutions'] = {'.read': f"{AUTH} && {STAFF}", '$cls': {'$key': {'$entry': R(
    write=f"{AUTH} && ({KITCHEN} || {ADMIN}) && !data.exists() && newData.exists()",
    validate="newData.hasChildren(['source','mode','by','ts','copied']) && (newData.child('mode').val() === 'archived' || (newData.child('mode').val() === 'linked' && newData.hasChildren(['targetClass','targetId','targetName']) && root.child('students_list').child(newData.child('targetClass').val()).child(newData.child('targetId').val()).exists()))",
    children={
        'source': R(validate='newData.hasChildren()'),
        'mode': R(validate="newData.val() === 'linked' || newData.val() === 'archived'"),
        'by': R(validate='newData.isString() && newData.val().length <= 200'),
        'ts': R(validate='newData.isNumber()'),
        'copied': R(validate='newData.isBoolean()'),
        'targetClass': R(validate="newData.isString() && newData.val().matches(/^class_[0-9]+$/)"),
        'targetId': R(validate='newData.isString() && newData.val().length <= 200'),
        'targetName': R(validate='newData.isString() && newData.val().length <= 300'),
        '$other': R(validate='false')
    }
)}}}

# ── Токени сповіщень: лише свій. Сервер читає через службовий акаунт. ──
rules['push_tokens'] = {"$uid": R(read=f"{AUTH} && $uid === auth.uid",
                                  write=f"{AUTH} && $uid === auth.uid")}

# ── Журнал дій: лише дописування, читає адміністрація ──
rules['audit_log'] = {".read": f"{AUTH} && {ADMIN}",
    "$ym": {"$id": R(write = f"{AUTH} && !data.exists() && newData.exists()")}}

# ── База тренажерів ──
# trainers/{id} = {title, url, subjects:{ключ: назва}, by, byName, ts}
# Спільна для всієї школи: бачать і поповнюють усі вчителі. Правити й
# видаляти — автор запису або адміністрація (щоб чужу добірку не стерли
# випадково). Родина базу не читає: тренажер, прикріплений до ДЗ, лежить
# копією в самому завданні — посилання й назва, нічого більше.
rules['trainers'] = R(
    read=f"{AUTH} && {EDU}",
    children={'$id': R(
        write=f"{AUTH} && {EDU} && (!data.exists() || data.child('by').val() === {SE} || {ADMIN})",
        validate="newData.hasChildren(['title','url','by','ts'])",
        children={
            'title':  R(validate="newData.isString() && newData.val().length > 0 && newData.val().length <= 120"),
            'url':    R(validate="newData.isString() && newData.val().length <= 500 && newData.val().matches(/^https?:\\/\\/[^ ]{4,}$/)"),
            'by':     R(validate=f"newData.isString() && (data.exists() ? newData.val() === data.val() : newData.val() === {SE})"),
            'byName': R(validate="newData.isString() && newData.val().length <= 80"),
            'note':   R(validate="newData.isString() && newData.val().length <= 300"),
            'ts':     R(validate="newData.isNumber()"),
            'subjects': R(children={'$s': R(validate="newData.isString() && newData.val().length <= 80")}),
            '$other': R(validate="false"),
        })})

# ══ ЗАКРИТО: РОДИНА БІЛЬШЕ НЕ ЧИТАЄ ДАНІ ВСЬОГО КЛАСУ (09.10.2026) ══
#
# ДІРКА. У CLASS_NODES родина (MINE) мала читання на рівні {клас} — тобто
# через консоль браузера бачила оцінки, коментарі вчителів, поведінку,
# підсумкові, наліпки й заявки на перездачу ВСІХ однокласників. Інтерфейс
# цього не показував, але правило дозволяло.
#
# ТЕПЕР. Клас цілком читає лише персонал. Родина читає:
#   • дзеркала своєї дитини — student_grades (оцінки й типи),
#     student_comments (коментарі + своя реакція), student_semester
#     (підсумкові) — у кожному дитина другим сегментом шляху;
#   • у вузлах, де дитина останнім сегментом, — лише свій лист
#     (поведінка за день, заявка на перездачу, здана робота, наліпки).
PRIVATE_NODES = ['grades', 'grade_types', 'comments', 'reactions', 'behavior_grades',
                 'semester_grades', 'retake_requests', 'homework_submissions', 'stickers']
for node in PRIVATE_NODES:
    # EDU, а не STAFF: кухні оцінки, коментарі й поведінка дітей не потрібні
    # (ревізія 10.10.2026 — STAFF включає роль kitchen)
    rules[node]['.read'] = f"{AUTH} && {EDU}"
    rules[node]['$cls']['.read'] = f"{AUTH} && {EDU}"
def OWN(cls, key):
    """Ключ — це моя дитина: за ідентифікатором, за іменем, або старе ім'я зі списку класу."""
    return (f"({MINE(cls)} && ({key} === {MYNAME} || {key} === {MYSID} || {MY_STU(cls, key)}"
            f" || ({MYSID_OK} && {key} === root.child('students_list').child({cls}).child({MYSID}).val())))")
rules['behavior_grades']['$cls']['$ym'] = {'$date': {'$sid': R(read=f"{AUTH} && {OWN('$cls', '$sid')}")}}
rules['retake_requests']['$cls']['$subj']['$date']['$name']['.read'] = f"{AUTH} && {OWN('$cls', '$name')}"
rules['homework_submissions']['$cls']['$date']['$subj']['$name']['.read'] = f"{AUTH} && {OWN('$cls', '$name')}"
rules['stickers']['$cls']['$sid'] = R(read=f"{AUTH} && {OWN('$cls', '$sid')}")

# Дзеркало коментарів: student_comments/{клас}/{учень}/{дата}/{предмет} = {t, r?}
#   t — текст (пише вчитель класу разом із comments), r — реакція родини
#   (пише сама родина, лише r і лише зі списку).
rules['student_comments'] = R(read=f"{AUTH} && {EDU}", children={'$cls': R(
    read=f"{AUTH} && {EDU}", write=f"{AUTH} && {EDU} && {TCLS('$cls')}",
    children={'$sid': R(read=f"{AUTH} && ({EDU} || {OWN('$cls', '$sid')})",
        children={'$date': {'$subj': R(children={
            't': R(validate="newData.isString() && newData.val().length <= 5000"),
            # ts — коли вчитель написав (центр сповіщень родини показує нове)
            'ts': R(validate="newData.isNumber()"),
            'r': R(write=f"{AUTH} && {OWN('$cls', '$sid')} && root.child('student_comments').child($cls).child($sid).child($date).child($subj).child('t').exists()",
                   validate="newData.isString() && (" + " || ".join(f"newData.val() === '{e}'" for e in COMMENT_REACTS) + ")"),
            '$other': R(validate="false")})}})})})
# Дзеркало підсумкових: student_semester/{клас}/{учень}/{семестр}/{предмет} = {value}
rules['student_semester'] = R(read=f"{AUTH} && {EDU}", children={'$cls': R(
    read=f"{AUTH} && {EDU}", write=f"{AUTH} && {EDU} && {TCLS('$cls')}",
    children={'$sid': R(read=f"{AUTH} && ({EDU} || {OWN('$cls', '$sid')})",
        children={'$sem': {'$subj': R(validate="newData.hasChild('value')", children={
            'value': R(validate="newData.isString() && newData.val().length <= 10"),
            '$other': R(validate="false")})}})})})
# Позначки разових міграцій (пише й читає адміністрація)
rules['system_flags'] = R(read=f"{AUTH} && {ADMIN}", write=f"{AUTH} && {ADMIN}")

# ── ✓ ДЗ виконано (homework.js) ──────────────────────────────────
# hw_done/{клас}/{дата}/{предмет}/{учень} = {ts, by: 'parent'|'student'}
# Позначає СІМʼЯ (батько чи сам учень) — лише свою дитину. Учитель
# читає клас цілком: бачить «виконали 12 з 24» біля свого ДЗ. Однокласники
# одне одного не бачать. Учитель не пише: це слово родини, не оцінка.
rules['hw_done'] = {".read": f"{AUTH} && {EDU}", "$cls": R(
    read=f"{AUTH} && {EDU}",
    children={'$date': {'$subj': {'$sid': R(
        read=f"{AUTH} && {OWN('$cls', '$sid')}",
        write=f"{AUTH} && {FAMILY} && {OWN('$cls', '$sid')}",
        validate="newData.hasChildren(['ts','by'])",
        children={'ts': R(validate=f"newData.isNumber() && {NOWISH}"),
                  'by': R(validate=f"newData.val() === {ROLE}"),
                  '$other': R(validate="false")})}}})}

# Дзеркало для родини: student_hw_done/{клас}/{учень}/{дата}/{предмет} = ts.
# Те саме, що hw_done, але учень — другим сегментом, щоб родина могла
# прочитати СВОЇ позначки діапазоном дат (серії, streaks.js). Пишеться
# одним записом разом із hw_done.
rules['student_hw_done'] = {".read": f"{AUTH} && {EDU}", "$cls": R(
    read=f"{AUTH} && {EDU}",
    children={'$sid': R(
        read=f"{AUTH} && ({EDU} || {OWN('$cls', '$sid')})",
        write=f"{AUTH} && {FAMILY} && {OWN('$cls', '$sid')}",
        children={'$date': {'$subj': R(validate="newData.isNumber()")}})})}

# ── 🗓 Консультації (consult.js) ─────────────────────────────────
# consult_slots/{пошта вчителя}/{id} — вільний час, який учитель відкрив
#   для батьків своїх класів. Бачать усі, хто увійшов (лише ім'я
#   вчителя й час — нічого особистого). Пише лише сам учитель.
# consult_bookings/{пошта вчителя}/{id} — хто записався й навіщо. Бачать
#   лише цей учитель і сам батько; інші батьки — ні.
# consult_taken/{пошта вчителя}/{id} = true — «зайнято» без імені: за цим
#   інші батьки бачать, що час уже не вільний. Ставиться разом із записом.
SLOT = "root.child('consult_slots').child($se).child($id)"
rules['consult_slots'] = R(read=AUTH, children={'$se': R(
    write=f"{AUTH} && {EDU} && $se === {SE}",
    children={'$id': R(
        validate="newData.hasChildren(['date','start','end','name','ts'])",
        children={
            'date':    R(validate="newData.isString() && newData.val().matches(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/)"),
            'start':   R(validate="newData.isString() && newData.val().matches(/^[0-2][0-9]:[0-5][0-9]$/)"),
            'end':     R(validate="newData.isString() && newData.val().matches(/^[0-2][0-9]:[0-5][0-9]$/)"),
            'name':    R(validate=STR(80, 1)),
            'subject': R(validate=STR(80)),
            'place':   R(validate=STR(200)),
            'mode':    R(validate="newData.val() === 'school' || newData.val() === 'online'"),
            'classes': {'$c': R(validate="newData.val() === true")},
            'ts':      R(validate="newData.isNumber()"),
            '$other':  R(validate="false")})})})
_OWN_BOOK = OWN("newData.child('cls').val()", "newData.child('child').val()")
rules['consult_bookings'] = {'$se': R(
    read=f"{AUTH} && $se === {SE}",
    children={'$id': R(
        read=f"{AUTH} && data.child('by').val() === {SE}",
        write=(f"{AUTH} && ((!data.exists() && {ROLE} === 'parent' && newData.child('by').val() === {SE}"
               f" && newData.child('cls').val() === {MYCLS} && {SLOT}.child('classes').child({MYCLS}).val() === true"
               # лише за свою дитину (ревізія: раніше можна було вписати однокласника)
               f" && {_OWN_BOOK})"
               f" || (data.exists() && !newData.exists() && (data.child('by').val() === {SE} || $se === {SE})))"),
        validate="newData.hasChildren(['by','cls','child','childName','ts'])",
        children={
            'by':        R(validate=f"newData.val() === {SE}"),
            'byName':    R(validate=STR(120)),
            'cls':       R(validate=STR(40, 1)),
            'child':     R(validate=STR(120, 1)),
            'childName': R(validate=STR(120)),
            'topic':     R(validate=STR(300)),
            'ts':        R(validate=f"newData.isNumber() && {NOWISH}"),
            '$other':    R(validate="false")})})}
rules['consult_taken'] = R(read=AUTH, children={'$se': {'$id': R(
    write=(f"{AUTH} && ((!data.exists() && {ROLE} === 'parent' && {SLOT}.child('classes').child({MYCLS}).val() === true)"
           f" || (data.exists() && !newData.exists() && ($se === {SE}"
           f" || root.child('consult_bookings').child($se).child($id).child('by').val() === {SE})))"),
    validate="newData.val() === true")}})

# ── Читання для ролей із конструктора ──
# Лише .read і лише на рівні вузла: запис цим правам не дається ніде.
# Кожен рядок — «право → які вузли воно відкриває для читання».
PERM_READS = {
    'students_list':     ['birthdays', 'activities', 'attendance', 'consents', 'meals_view'],
    'student_birthdays': ['birthdays'],
    'activity_plan':     ['activities'],
    'pool_week':         ['activities'],
    'attendance':        ['attendance', 'meals_view'],
    'consent_responses': ['consents'],
    'meal_plan':         ['meals_view'],
    'meal_day':          ['meals_view'],
    'schedules':         ['workload'],
    'teacher_access':    ['workload'],
    'substitutions':     ['workload'],
}
for node, perms in PERM_READS.items():
    old_read = rules[node]['.read']
    rules[node]['.read'] = f"({old_read}) || ({AUTH} && (" + " || ".join(PERM(p) for p in perms) + "))"

out = {"rules": dict(**{".read": "false", ".write": "false"}, **rules)}
io.open('database.rules.json','w',encoding='utf-8').write(json.dumps(out, ensure_ascii=False, indent=2))
print('вузлів описано:', len(rules))
