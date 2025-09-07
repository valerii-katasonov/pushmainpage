const dayNames = {
  "Monday": { ua: "Понеділок", pl: "Poniedziałek" },
  "Tuesday": { ua: "Вівторок", pl: "Wtorek" },
  "Wednesday": { ua: "Середа", pl: "Środa" },
  "Thursday": { ua: "Четвер", pl: "Czwartek" },
  "Friday": { ua: "П’ятниця", pl: "Piątek" }
};

const schedule = {
  "Monday": [
    { number: 1, subject: { ua: "Фізика", pl: "Fizyka" }, time: "9:00 - 9:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "9:45 - 9:55" },
    { number: 2, subject: { ua: "Фізика", pl: "Fizyka" }, time: "9:55 - 10:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "10:40 - 10:50" },
    { number: 3, subject: { ua: "Англійська мова", pl: "Język angielski" }, time: "10:50 - 11:35" },
    { number: " ", subject: { ua: "Обід", pl: "Obiad" }, time: "11:35 - 11:55" },
    { number: 4, subject: { ua: "Хімія", pl: "Chemia" }, time: "11:55 - 12:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "12:40 - 13:00" },
    { number: 5, subject: { ua: "Польська мова", pl: "Język polski" }, time: "13:00 - 13:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "13:45 - 13:55" },
    { number: 6, subject: { ua: "Англійська мова", pl: "Język angielski" }, time: "13:55 - 14:40" },
  ],
  "Tuesday": [
    { number: 1, subject: { ua: "Математика", pl: "Matematyka" }, time: "9:00 - 9:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "9:45 - 9:55" },
    { number: 2, subject: { ua: "Польська мова", pl: "Język polski" }, time: "9:55 - 10:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "10:40 - 10:50" },
    { number: 3, subject: { ua: "Математика", pl: "Matematyka" }, time: "10:50 - 11:35" },
    { number: " ", subject: { ua: "Обід", pl: "Obiad" }, time: "11:35 - 11:55" },
    { number: 4, subject: { ua: "Хімія", pl: "Chemia" }, time: "11:55 - 12:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "12:40 - 13:00" },
    { number: 5, subject: { ua: "Історія України", pl: "Historia Ukrainy" }, time: "13:00 - 13:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "13:45 - 13:55" },
    { number: 6, subject: { ua: "Уроку немає", pl: "Nie ma lekcji" }, time: "13:55 - 14:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "14:40 - 14:50" },
    { number: 7, subject: { ua: "Підготовка до НМТ з математики", pl: "Przygotowanie do NMT z matematyky" }, time: "14:50 - 15:35" },
  ],
  "Wednesday": [
    { number: 1, subject: { ua: "Українська мова", pl: "Język ukraiński" }, time: "9:00 - 9:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "9:45 - 9:55" },
    { number: 2, subject: { ua: "Українська література", pl: "Ukraińska literatura" }, time: "9:55 - 10:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "10:40 - 10:50" },
    { number: 3, subject: { ua: "Біологія", pl: "Biologia" }, time: "10:50 - 11:35" },
    { number: " ", subject: { ua: "Обід", pl: "Obiad" }, time: "11:35 - 11:55" },
    { number: 4, subject: { ua: "Англійська мова", pl: "Język angielski" }, time: "11:55 - 12:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "12:40 - 13:00" },
    { number: 5, subject: { ua: "Англійська мова", pl: "Język angielski" }, time: "13:00 - 13:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "13:45 - 13:55" },
    { number: 6, subject: { ua: "Польська мова", pl: "Język polski" }, time: "13:55 - 14:40" },
  ],
  "Thursday": [
    { number: 1, subject: { ua: "Географія", pl: "Geografia" }, time: "9:00 - 9:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "9:45 - 9:55" },
    { number: 2, subject: { ua: "Географія", pl: "Geografia" }, time: "9:55 - 10:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "10:40 - 10:50" },
    { number: 3, subject: { ua: "Математика", pl: "Matematyka" }, time: "10:50 - 11:35" },
    { number: " ", subject: { ua: "Обід", pl: "Obiad" }, time: "11:35 - 11:55" },
    { number: 4, subject: { ua: "Українська мова", pl: "Język ukraiński" }, time: "11:55 - 12:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "12:40 - 13:00" },
    { number: 5, subject: { ua: "Біологія", pl: "Biologia" }, time: "13:00 - 13:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "13:45 - 13:55" },
    { number: 6, subject: { ua: "Польська мова", pl: "Język polski" }, time: "13:55 - 14:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "14:40 - 14:50" },
    { number: 7, subject: { ua: "Розмовний клуб", pl: "Speaking Club" }, time: "14:50 - 15:35" },
  ],
  "Friday": [
    { number: 1, subject: { ua: "Математика", pl: "Matematyka" }, time: "9:00 - 9:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "9:45 - 9:55" },
    { number: 2, subject: { ua: "Польська мова", pl: "Język polski" }, time: "9:55 - 10:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "10:40 - 10:50" },
    { number: 3, subject: { ua: "Інформатика", pl: "Informatyka" }, time: "10:50 - 11:35" },
    { number: " ", subject: { ua: "Обід", pl: "Obiad" }, time: "11:35 - 11:55" },
    { number: 4, subject: { ua: "Історія України", pl: "Historia Ukrainy" }, time: "11:55 - 12:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "12:40 - 13:00" },
    { number: 5, subject: { ua: "Англійська мова", pl: "Język angielski" }, time: "13:00 - 13:45" },
  ]
};

// Проверка данных на корректность
Object.values(schedule).forEach((day, dayIndex) => {
  day.forEach((lesson, lessonIndex) => {
    if (!lesson.subject || !lesson.subject.ua || !lesson.subject.pl) {
      console.error(`Invalid subject format in schedule at ${Object.keys(schedule)[dayIndex]} lesson ${lessonIndex + 1}:`, lesson);
    }
    if (!lesson.time || !lesson.time.includes(' - ')) {
      console.error(`Invalid time format in schedule at ${Object.keys(schedule)[dayIndex]} lesson ${lessonIndex + 1}:`, lesson);
    }
  });
});

window.schedule = schedule;
window.dayNames = dayNames;
