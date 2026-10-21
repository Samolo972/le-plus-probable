'use strict';

// Synchronise la base avec data/questions.json : ajoute les nouvelles questions et
// désactive celles qui ont été retirées du fichier. Les questions désactivées à la
// main (active = 0) le restent.

const { openDb } = require('../src/db');

const db = openDb(process.env.DB_FILE);
const { added, removed } = db.importQuestions();
console.log(`${added} nouvelle(s) question(s) importée(s), ${removed} retirée(s).`);
db.close();
