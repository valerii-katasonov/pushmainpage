const schedule = {
  "Monday": [
    { number: 1, subject: { ua: "Фізика", pl: "Fizyka" }, time: "9:00 - 9:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "9:45 - 9:55" },
    { number: 2, subject: { ua: "Польська мова", pl: "Język polski" }, time: "9:55 - 10:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "10:40 - 10:50" },
    { number: 3, subject: { ua: "Біологія", pl: "Biologia" }, time: "10:50 - 11:35" },
    { number: " ", subject: { ua: "Обід", pl: "Obiad" }, time: "11:35 - 11:55" },
    { number: 4, subject: { ua: "Фізика", pl: "Fizyka" }, time: "11:55 - 12:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "12:40 - 13:00" },
    { number: 5, subject: { ua: "Біологія", pl: "Biologia" }, time: "13:00 - 13:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "13:45 - 13:55" },
    { number: 6, subject: { ua: "Англійська мова", pl: "Język angielski" }, time: "13:55 - 14:40" }
  ],
  "Tuesday": [
    { number: 1, subject: { ua: "Українська мова", pl: "Język ukraiński" }, time: "9:00 - 9:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "9:45 - 9:55" },
    { number: 2, subject: { ua: "Географія", pl: "Geografia" }, time: "9:55 - 10:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "10:40 - 10:50" },
    { number: 3, subject: { ua: "Географія", pl: "Geografia" }, time: "10:50 - 11:35" },
    { number: " ", subject: { ua: "Обід", pl: "Obiad" }, time: "11:35 - 11:55" },
    { number: 4, subject: { ua: "Математика", pl: "Matematyka" }, time: "11:55 - 12:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "12:40 - 13:00" },
    { number: 5, subject: { ua: "Українська мова", pl: "Język ukraiński" }, time: "13:00 - 13:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "13:45 - 13:55" },
    { number: 6, subject: { ua: "Англійська мова", pl: "Język angielski" }, time: "13:55 - 14:40" }
  ],
  "Wednesday": [
    { number: 1, subject: { ua: "Математика", pl: "Matematyka" }, time: "9:00 - 9:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "9:45 - 9:55" },
    { number: 2, subject: { ua: "Польська мова", pl: "Język polski" }, time: "9:55 - 10:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "10:40 - 10:50" },
    { number: 3, subject: { ua: "Хімія", pl: "Chemia" }, time: "10:50 - 11:35" },
    { number: " ", subject: { ua: "Обід", pl: "Obiad" }, time: "11:35 - 11:55" },
    { number: 4, subject: { ua: "Математика", pl: "Matematyka" }, time: "11:55 - 12:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "12:40 - 13:00" },
    { number: 5, subject: { ua: "Історія України", pl: "Historia Ukrainy" }, time: "13:00 - 13:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "13:45 - 13:55" },
    { number: 6, subject: { ua: "Англійська мова", pl: "Język angielski" }, time: "13:55 - 14:40" }
  ],
  "Thursday": [
    { number: 1, subject: { ua: "Хімія", pl: "Chemia" }, time: "9:00 - 9:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "9:45 - 9:55" },
    { number: 2, subject: { ua: "Математика", pl: "Matematyka" }, time: "9:55 - 10:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "10:40 - 10:50" },
    { number: 3, subject: { ua: "Українська мова", pl: "Język ukraiński" }, time: "10:50 - 11:35" },
    { number: " ", subject: { ua: "Обід", pl: "Obiad" }, time: "11:35 - 11:55" },
    { number: 4, subject: { ua: "Історія Польщі", pl: "Historia Polski" }, time: "11:55 - 12:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "12:40 - 13:00" },
    { number: 5, subject: { ua: "Математика", pl: "Matematyka" }, time: "13:00 - 13:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "13:45 - 13:55" },
    { number: 6, subject: { ua: "Інформатика", pl: "Informatyka" }, time: "13:55 - 14:40" }
  ],
  "Friday": [
    { number: 1, subject: { ua: "Всесвітня історія", pl: "Historia powszechna" }, time: "9:00 - 9:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "9:45 - 9:55" },
    { number: 2, subject: { ua: "Історія України", pl: "Historia Ukrainy" }, time: "9:55 - 10:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "10:40 - 10:50" },
    { number: 3, subject: { ua: "Математика", pl: "Matematyka" }, time: "10:50 - 11:35" },
    { number: " ", subject: { ua: "Обід", pl: "Obiad" }, time: "11:35 - 11:55" },
    { number: 4, subject: { ua: "Польська мова", pl: "Język polski" }, time: "11:55 - 12:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "12:40 - 13:00" },
    { number: 5, subject: { ua: "Українська мова", pl: "Język ukraiński" }, time: "13:00 - 13:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "13:45 - 13:55" },
    { number: 6, subject: { ua: "Англійська мова", pl: "Język angielski" }, time: "13:55 - 14:40" }
  ]
};

const dayNames = {
  "Monday": { ua: "Понеділок", pl: "Poniedziałek" },
  "Tuesday": { ua: "Вівторок", pl: "Wtorek" },
  "Wednesday": { ua: "Середа", pl: "Środa" },
  "Thursday": { ua: "Четвер", pl: "Czwartek" },
  "Friday": { ua: "П’ятниця", pl: "Piątek" }
};
