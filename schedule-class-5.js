const dayNames = {
  Monday: { ua: "Понеділок", pl: "Poniedziałek" },
  Tuesday: { ua: "Вівторок", pl: "Wtorek" },
  Wednesday: { ua: "Середа", pl: "Środa" },
  Thursday: { ua: "Четвер", pl: "Czwartek" },
  Friday: { ua: "П'ятниця", pl: "Piątek" },
  Saturday: { ua: "Субота", pl: "Sobota" },
  Sunday: { ua: "Неділя", pl: "Niedziela" }
};

const schedule = {
  Monday: [
    { number: 1, subject: { ua: "Англійська мова", pl: "Język angielski" }, time: "9:00 - 9:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "9:45 - 9:55" },
    { number: 2, subject: { ua: "Українська мова", pl: "Język ukraiński" }, time: "9:55 - 10:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "10:40 - 10:50" },
    { number: 3, subject: { ua: "Українська література", pl: "Literatura ukraińska" }, time: "10:50 - 11:35" },
    { number: " ", subject: { ua: "Обід 1-4 класи", pl: "Obiad klasy 1-4" }, time: "11:35 - 11:55" },
    { number: 4, subject: { ua: "Інформатика", pl: "Informatyka" }, time: "11:55 - 12:40" },
    { number: " ", subject: { ua: "Обід 5-6 класи", pl: "Obiad klasy 5-6" }, time: "12:40 - 13:00" },
    { number: 5, subject: { ua: "Математика", pl: "Matematyka" }, time: "13:00 - 13:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "13:45 - 13:55" },
    { number: 6, subject: { ua: "Історія Польщі", pl: "Historia Polska" }, time: "13:55 - 14:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "14:40 - 14:50" },
    { number: 7, subject: { ua: "Робототехніка", pl: "Robotyka" }, time: "14:50 - 15:35" }
  ],
  Tuesday: [
    { number: 1, subject: { ua: "Przyroda", pl: "Przyroda" }, time: "9:00 - 9:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "9:45 - 9:55" },
    { number: 2, subject: { ua: "Історія та суспільство", pl: "Historia i społeczeństwo" }, time: "9:55 - 10:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "10:40 - 10:50" },
    { number: 3, subject: { ua: "Математика", pl: "Matematyka" }, time: "10:50 - 11:35" },
    { number: " ", subject: { ua: "Обід 1-4 класи", pl: "Obiad klasy 1-4" }, time: "11:35 - 11:55" },
    { number: 4, subject: { ua: "Математика", pl: "Matematyka" }, time: "11:55 - 12:40" },
    { number: " ", subject: { ua: "Обід 5-6 класи", pl: "Obiad klasy 5-6" }, time: "12:40 - 13:00" },
    { number: 5, subject: { ua: "Польська мова", pl: "Język polski" }, time: "13:00 - 13:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "13:45 - 13:55" },
    { number: 6, subject: { ua: "Англійська мова", pl: "Język angielski" }, time: "13:55 - 14:40" }
  ],
  Wednesday: [
    { number: 1, subject: { ua: "Англійська мова", pl: "Język angielski" }, time: "9:00 - 9:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "9:45 - 9:55" },
    { number: 2, subject: { ua: "Математика", pl: "Matematyka" }, time: "9:55 - 10:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "10:40 - 10:50" },
    { number: 3, subject: { ua: "Фізичне виховання", pl: "Wychowanie fizyczne" }, time: "10:50 - 11:35" },
    { number: " ", subject: { ua: "Обід 1-4 класи", pl: "Obiad klasy 1-4" }, time: "11:35 - 11:55" },
    { number: 4, subject: { ua: "Фізичне виховання", pl: "Wychowanie fizyczne" }, time: "11:55 - 12:40" },
    { number: " ", subject: { ua: "Обід 5-6 класи", pl: "Obiad klasy 5-6" }, time: "12:40 - 13:00" },
    { number: 5, subject: { ua: "Українська мова", pl: "Język ukraiński" }, time: "13:00 - 13:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "13:45 - 13:55" },
    { number: 6, subject: { ua: "Українська література", pl: "Literatura ukraińska" }, time: "13:55 - 14:40" }
  ],
  Thursday: [
    { number: 1, subject: { ua: "Przyroda", pl: "Przyroda" }, time: "9:00 - 9:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "9:45 - 9:55" },
    { number: 2, subject: { ua: "Польська мова", pl: "Język polski" }, time: "9:55 - 10:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "10:40 - 10:50" },
    { number: 3, subject: { ua: "Польська мова", pl: "Język polski" }, time: "10:50 - 11:35" },
    { number: " ", subject: { ua: "Обід 1-4 класи", pl: "Obiad klasy 1-4" }, time: "11:35 - 11:55" },
    { number: 4, subject: { ua: "Plastyka /Technika", pl: "Plastyka /Technika" }, time: "11:55 - 12:40" },
    { number: " ", subject: { ua: "Обід 5-6 класи", pl: "Obiad klasy 5-6" }, time: "12:40 - 13:00" },
    { number: 5, subject: { ua: "Англійська мова", pl: "Język angielski" }, time: "13:00 - 13:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "13:45 - 13:55" },
    { number: 6, subject: { ua: "Speaking Club", pl: "Speaking Club" }, time: "13:55 - 14:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "14:40 - 14:50" },
    { number: 7, subject: { ua: "Speaking Club", pl: "Speaking Club" }, time: "14:50 - 15:35" }
  ],
  Friday: [
    { number: 1, subject: { ua: "Англійська мова", pl: "Język angielski" }, time: "9:00 - 9:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "9:45 - 9:55" },
    { number: 2, subject: { ua: "Українська мова", pl: "Język ukraiński" }, time: "9:55 - 10:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "10:40 - 10:50" },
    { number: 3, subject: { ua: "Польська мова", pl: "Język polski" }, time: "10:50 - 11:35" },
    { number: " ", subject: { ua: "Обід 1-4 класи", pl: "Obiad klasy 1-4" }, time: "11:35 - 11:55" },
    { number: 4, subject: { ua: "Plastyka /Technika", pl: "Plastyka /Technika" }, time: "11:55 - 12:40" },
    { number: " ", subject: { ua: "Обід 5-6 класи", pl: "Obiad klasy 5-6" }, time: "12:40 - 13:00" },
    { number: " ", subject: { ua: "Очікування автобуса", pl: "Oczekiwanie na autobus" }, time: "13:00 - 13:20" },
    { number: " ", subject: { ua: "Шлях зі школи до басейну на автобусі", pl: "Droga ze szkoły na basen autobusem" }, time: "13:20 - 13:45" },
    { number: 5, subject: { ua: "Фізичне виховання (басейн)", pl: "Wychowanie fizyczne (basen)" }, time: "14:00 - 15:00" },
    { number: " ", subject: { ua: "Шлях з басейну до школи на автобусі", pl: "Droga z basenu do szkoły autobusem" }, time: "15:30 - 16:00" }
  ]
};

window.schedule = schedule;
window.dayNames = dayNames;
