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
TEACH   = ("(" + " || ".join(f"{ROLE} === '{r}'" for r in
           ['teacher','class_teacher','art_school_teacher','music_teacher']) + ")")
EDU     = f"({ADMIN} || {TEACH})"
KITCHEN = f"({ROLE} === 'kitchen')"
FAMILY  = f"({ROLE} === 'parent' || {ROLE} === 'student')"
STAFF   = f"({EDU} || {KITCHEN})"
# Вчитель пише лише в класи, до яких директор дав доступ
def TCLS(v): return f"({ADMIN} || root.child('teacher_access').child({SE}).child({v}).exists())"
def MINE(v): return f"({FAMILY} && {v} === {MYCLS})"

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
    staff_ok = " || ".join([f"{pre}.val() === {role_expr}"] +
                           [f"{pre}.child('{i}').val() === {role_expr}" for i in range(4)])
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
def user_check(base):
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
    return (f"{base}.child('email').val() === auth.token.email"
            f" && {entitled(role)} && {st} && {pa}")

rules['users'] = {".read": f"{AUTH} && {ADMIN}",
  "$uid": {".read": f"{AUTH} && ($uid === auth.uid || {ADMIN})",
           ".write": f"{AUTH} && $uid === auth.uid",
           ".validate": user_check('newData'),
           "$field": {".validate": user_check('newData.parent()')}}}

# ── Джерела ролей: читає лише власник (потрібно на вході) або адміністрація ──
for node in ['pre_approved_roles','parent_links','student_links','teacher_access']:
    own_write = (f" || ($se === {SE} && {FAMILY})") if node == 'parent_links' else ""
    rules[node] = {".read": f"{AUTH} && (" + ({'parent_links': EDU}.get(node, ADMIN)) + ")",
                   "$se": R(
        read  = f"{AUTH} && ($se === {SE} || {ADMIN}" + (f" || {EDU}" if node=='parent_links' else "") + ")",
        write = f"{AUTH} && ({ADMIN}{own_write})")}

# ── Навчальні дані, ключовані класом ──
CLASS_NODES = ['grades','attendance','comments','homeworks','stickers','behavior_grades',
               'semester_grades','reactions','exams','retake_requests','lesson_topics',
               'schedules','textbooks','curriculum_plans','grade_types','students_list',
               ]
for node in CLASS_NODES:
    rules[node] = {".read": f"{AUTH} && {STAFF}",
                   "$cls": R(read  = f"{AUTH} && ({STAFF} || {MINE('$cls')})",
                             write = f"{AUTH} && {EDU} && {TCLS('$cls')}")}
# Чернетки розкладу лежать як schedule_drafts/{версія}/{клас} — це інструмент
# директора, класової логіки тут немає.
rules['schedule_drafts'] = R(read=f"{AUTH} && {EDU}", write=f"{AUTH} && {ADMIN}")

# Родина пише лише за себе і лише туди, де це передбачено
rules['attendance']["$cls"]["$date"] = {"$name": {"$slot": R(
    write = (f"{AUTH} && ({EDU} && {TCLS('$cls')}"
             f" || ({MINE('$cls')} && $name === {MYNAME} || $name === {MYSID} && $slot === 'all'))"))}}
rules['reactions']["$cls"]["$date"] = {"$name": R(
    write = f"{AUTH} && ({EDU} || ({MINE('$cls')} && $name === {MYNAME} || $name === {MYSID}))")}
rules['retake_requests']["$cls"]["$date"] = {"$name": R(
    write = f"{AUTH} && ({EDU} || ({MINE('$cls')} && $name === {MYNAME} || $name === {MYSID}))")}

# ── Картка учня: медичні дані, PESEL, договір ──
rules['student_cards'] = {".read": f"{AUTH} && {EDU}", "$cls": {"$key": R(
    read  = (f"{AUTH} && ({EDU}"
             f" || ({MINE('$cls')} && root.child('students_list').child($cls).child($key).val() === {MYNAME}))"),
    write = (f"{AUTH} && ({EDU} && {TCLS('$cls')}"
             f" || ({MINE('$cls')} && root.child('students_list').child($cls).child($key).val() === {MYNAME}))"))}}

# ── Харчування ──
rules['menu'] = {"$date": R(read=AUTH, write=f"{AUTH} && ({KITCHEN} || {ADMIN})")}
rules['meal_plan'] = {".read": f"{AUTH} && {STAFF}", "$cls": {"$name": R(
    read  = f"{AUTH} && ({STAFF} || ({MINE('$cls')} && $name === {MYNAME} || $name === {MYSID}))",
    write = f"{AUTH} && ({KITCHEN} || {ADMIN} || ({MINE('$cls')} && $name === {MYNAME} || $name === {MYSID}))")}}
rules['meal_day'] = {".read": f"{AUTH} && {STAFF}", "$date": {"$cls": {"$name": R(
    read  = f"{AUTH} && ({STAFF} || ({MINE('$cls')} && $name === {MYNAME} || $name === {MYSID}))",
    write = f"{AUTH} && ({KITCHEN} || {ADMIN} || ({MINE('$cls')} && $name === {MYNAME} || $name === {MYSID}))")}}}

# ── Заміни, згоди, відсутність персоналу ──
rules['substitutions'] = {".read": f"{AUTH} && {STAFF}", "$date": {"$cls": R(
    read  = f"{AUTH} && ({STAFF} || {MINE('$cls')})",
    write = f"{AUTH} && {ADMIN}")}}
rules['consents'] = {".read": AUTH, "$id": R(write=f"{AUTH} && {ADMIN}")}
rules['consent_responses'] = {".read": f"{AUTH} && {EDU}",
    "$id": {".read": f"{AUTH} && {EDU}", "$cls": {"$name": R(
    read  = f"{AUTH} && ({EDU} || ({MINE('$cls')} && $name === {MYNAME} || $name === {MYSID}))",
    write = f"{AUTH} && ({ADMIN} || ({MINE('$cls')} && $name === {MYNAME} || $name === {MYSID}))")}}}
rules['staff_absence'] = {"$date": R(read=f"{AUTH} && {STAFF}", write=f"{AUTH} && {ADMIN}")}

# ── Спільні довідники: читають усі, змінює адміністрація ──
for node in ['academic_year','bell_schedules','grade_type_defs','journal_column_types',
             'class_teachers','authors']:
    rules[node] = R(read=AUTH, write=f"{AUTH} && {ADMIN}")
for node in ['teacher_skills','graduates','migration_log']:
    rules[node] = R(read=f"{AUTH} && {STAFF}", write=f"{AUTH} && {ADMIN}")

# ── Приватне листування: ключ чату — дві пошти через ___ ──
rules['chats'] = {".read": f"{AUTH} && {ADMIN}", "$chatId": R(
    read  = (f"{AUTH} && ($chatId.beginsWith({SE} + '___') || $chatId.endsWith('___' + {SE})"
             f" || {ADMIN})"),
    write = f"{AUTH} && ($chatId.beginsWith({SE} + '___') || $chatId.endsWith('___' + {SE}))")}

# ── Токени сповіщень: лише свій. Сервер читає через службовий акаунт. ──
rules['push_tokens'] = {"$uid": R(read=f"{AUTH} && $uid === auth.uid",
                                  write=f"{AUTH} && $uid === auth.uid")}

# ── Журнал дій: лише дописування, читає адміністрація ──
rules['audit_log'] = {".read": f"{AUTH} && {ADMIN}",
    "$ym": {"$id": R(write = f"{AUTH} && !data.exists() && newData.exists()")}}

out = {"rules": dict(**{".read": "false", ".write": "false"}, **rules)}
io.open('database.rules.json','w',encoding='utf-8').write(json.dumps(out, ensure_ascii=False, indent=2))
print('вузлів описано:', len(rules))
