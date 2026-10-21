'use strict';

// Ajoute en base les questions de data/questions.json qui n'y sont pas encore.
// Les questions existantes (même texte) sont ignorées : la base reste la référence,
// y compris pour les questions désactivées à la main (active = 0).

const { openDb } = require('../src/db');

const db = openDb(process.env.DB_FILE);
const added = db.importQuestions();
console.log(`${added} nouvelle(s) question(s) importée(s).`);
db.close();
