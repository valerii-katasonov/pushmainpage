const schedule = {
  "Monday": [
    { number: 1, subject: { ua: "Англійська мова", pl: "Język angielski" }, time: "9:00 - 9:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "9:45 - 9:55" },
    { number: 2, subject: { ua: "Англійська мова", pl: "Język angielski" }, time: "9:55 - 10:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "10:40 - 10:50" },
    { number: 3, subject: { ua: "Фізика", pl: "Fizyka" }, time: "10:50 - 11:35" },
    { number: " ", subject: { ua: "Обід", pl: "Obiad" }, time: "11:35 - 11:55" },
    { number: 4, subject: { ua: "Польська мова", pl: "Język polski" }, time: "11:55 - 12:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "12:40 - 13:00" },
    { number: 5, subject: { ua: "Алгебра", pl: "Algebra" }, time: "13:00 - 13:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "13:45 - 13:55" },
    { number: 6, subject: { ua: "Геометрія", pl: "Geometria" }, time: "13:55 - 14:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "14:40 - 14:50" },
    { number: 7, subject: { ua: "Інформатика", pl: "Informatyka" }, time: "14:50 - 15:35" }
  ],
  "Tuesday": [
    { number: 1, subject: { ua: "Географія (термінологія)", pl: "Geografia (terminologia)" }, time: "9:00 - 9:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "9:45 - 9:55" },
    { number: 2, subject: { ua: "Історія України", pl: "Historia Ukrainy" }, time: "9:55 - 10:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "10:40 - 10:50" },
    { number: 3, subject: { ua: "Українська мова", pl: "Język ukraiński" }, time: "10:50 - 11:35" },
    { number: " ", subject: { ua: "Обід", pl: "Obiad" }, time: "11:35 - 11:55" },
    { number: 4, subject: { ua: "Українська література", pl: "Literatura ukraińska" }, time: "11:55 - 12:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "12:40 - 13:00" },
    { number: 5, subject: { ua: "Фізична культура", pl: "Wychowanie fizyczne" }, time: "13:00 - 13:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "13:45 - 13:55" },
    { number: 6, subject: { ua: "Українська мова", pl: "Język ukraiński" }, time: "13:55 - 14:40" }
  ],
  "Wednesday": [
    { number: 1, subject: { ua: "Фізика", pl: "Fizyka" }, time: "9:00 - 9:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "9:45 - 9:55" },
    { number: 2, subject: { ua: "Англійська мова", pl: "Język angielski" }, time: "9:55 - 10:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "10:40 - 10:50" },
    { number: 3, subject: { ua: "Англійська мова", pl: "Język angielski" }, time: "10:50 - 11:35" },
    { number: " ", subject: { ua: "Обід", pl: "Obiad" }, time: "11:35 - 11:55" },
    { number: 4, subject: { ua: "Польська мова", pl: "Język polski" }, time: "11:55 - 12:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "12:40 - 13:00" },
    { number: 5, subject: { ua: "Біологія", pl: "Biologia" }, time: "13:00 - 13:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "13:45 - 13:55" },
    { number: 6, subject: { ua: "Хімія", pl: "Chemia" }, time: "13:55 - 14:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "14:50 - 15:35" },
    { number: 7, subject: { ua: "Алгебра", pl: "Algebra" }, time: "13:00 - 13:45" }
    
  ],
  "Thursday": [
    { number: 1, subject: { ua: "Географія", pl: "Geografia" }, time: "9:00 - 9:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "9:45 - 9:55" },
    { number: 2, subject: { ua: "Історія Польщі", pl: "Historia Polska" }, time: "9:55 - 10:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "10:40 - 10:50" },
    { number: 3, subject: { ua: "Фізична культура", pl: "Wychowanie fizyczne" }, time: "10:50 - 11:35" },
    { number: " ", subject: { ua: "Обід", pl: "Obiad" }, time: "11:35 - 11:55" },
    { number: 4, subject: { ua: "Українська мова", pl: "Język ukraiński" }, time: "11:55 - 12:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "12:40 - 13:00" },
    { number: 5, subject: { ua: "Геометрія", pl: "Geometria" }, time: "13:00 - 13:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "13:45 - 13:55" },
    { number: 6, subject: { ua: "Географія (польською)", pl: "Geografia(Polska)" }, time: "13:55 - 14:40" }
  ],
  "Friday": [
    { number: 1, subject: { ua: "Математика (термінологія)", pl: "Matematyka (terminologia)" }, time: "9:00 - 9:45" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "9:45 - 9:55" },
    { number: 2, subject: { ua: "Біологія", pl: "Biologia" }, time: "9:55 - 10:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "10:40 - 10:50" },
    { number: 3, subject: { ua: "Історія України", pl: "Historia Ukrainy" }, time: "10:50 - 11:35" },
    { number: " ", subject: { ua: "Обід", pl: "Obiad" }, time: "11:35 - 11:55" },
    { number: 4, subject: { ua: "Хімія", pl: "Chemia" }, time: "11:55 - 12:40" },
    { number: " ", subject: { ua: "Перерва", pl: "Przerwa" }, time: "12:40 - 13:00" },
    { number: 5, subject: { ua: "Польська мова", pl: "Język polski" }, time: "13:00 - 13:45" },
    { number: " ", subject: { ua: "Очікування автобуса", pl: "Oczekiwanie na autobus" }, time: "13:45 - 14:20" },
    { number: " ", subject: { ua: "Шлях зі школи на басейн автобусом", pl: "Droga ze szkoły na basen autobusem" }, time: "14:20 - 14:45" },
    { number: 6, subject: { ua: "Фізичне виховання (басейн)", pl: "Wychowanie fizyczne (basen)" }, time: "15:00 - 16:00" },
    { number: " ", subject: { ua: "Шлях з басейну до школи автобусом", pl: "Droga z basenu do szkoły autobusem" }, time: "16:30 - 17:00" }
  ]
};

const dayNames = {
  "Monday": { ua: "Понеділок", pl: "Poniedziałek" },
  "Tuesday": { ua: "Вівторок", pl: "Wtorek" },
  "Wednesday": { ua: "Середа", pl: "Środa" },
  "Thursday": { ua: "Четвер", pl: "Czwartek" },
  "Friday": { ua: "П’ятниця", pl: "Piątek" }
};
