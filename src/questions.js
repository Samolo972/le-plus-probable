'use strict';

const { randomInt } = require('node:crypto');

const THEMES = ['Vie au bureau', 'Absurde', 'Food', 'Voyages', 'Soirées', 'Ados à jamais'];

// Titre donné au gagnant d'une question proposée par un joueur.
const CUSTOM_TITLES = [
  'Légende vivante',
  'Star de la manche',
  'Cas d’école',
  'Profil suspect',
  'Valeur sûre',
  'Personnage culte',
  'Énigme du bureau',
  'Icône incomprise'
];

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pick(list) {
  return list[randomInt(list.length)];
}

function fromBank(q) {
  return { text: q.text, title: q.title, theme: q.theme, custom: false };
}

function fromPlayers(text, customId) {
  return { text, title: pick(CUSTOM_TITLES), theme: 'joueurs', custom: true, customId };
}

// Mode Hard : deux questions piquantes pour une classique, tant qu'il en reste.
function interleave(hard, normal) {
  const out = [];
  let h = 0;
  let n = 0;
  while (h < hard.length || n < normal.length) {
    if (h < hard.length) out.push(hard[h++]);
    if (h < hard.length) out.push(hard[h++]);
    if (n < normal.length) out.push(normal[n++]);
  }
  return out;
}

// Pioche de la banque, sans les questions des joueurs. Sert aussi à recharger
// la pioche quand une partie Hard sans limite l'a épuisée.
function bankPool(db, settings) {
  const all = db.activeQuestions();
  const themed = shuffle(all.filter((q) => !q.hard && settings.themes.includes(q.theme))).map(fromBank);
  if (!settings.hard) return themed;
  const hard = shuffle(all.filter((q) => q.hard)).map(fromBank);
  return interleave(hard, themed);
}

// playerQuestions : [[q1, q2], [q1], …] une liste par joueur, textes déjà nettoyés.
// Chaque joueur voit au moins une de ses questions passer si la partie est assez
// longue ; les questions des joueurs ne dépassent pas la moitié de la partie.
function buildDeck(db, settings, playerQuestions = []) {
  const pool = bankPool(db, settings);
  const window = settings.hard ? 15 : settings.count;

  let customs = [];
  if (settings.custom) {
    const firsts = shuffle(playerQuestions.map((qs) => qs[0]).filter(Boolean));
    const seconds = shuffle(playerQuestions.map((qs) => qs[1]).filter(Boolean));
    // Toutes sont conservées en base pour les parties suivantes, même celles qui ne sortent pas.
    const ids = new Map([...firsts, ...seconds].map((text) => [text, db.saveCustomQuestion(text)]));
    const cap = Math.ceil(window / 2);
    customs = [...firsts, ...seconds].slice(0, cap).map((text) => fromPlayers(text, ids.get(text)));

    // Questions proposées lors des parties précédentes.
    const pastWanted = Math.max(0, Math.floor(window / 5) - customs.length);
    if (pastWanted > 0) {
      const taken = customs.map((q) => q.text);
      for (const q of db.randomCustomQuestions(pastWanted, taken)) customs.push(fromPlayers(q.text, q.id));
    }
  }

  const seen = new Set(customs.map((q) => q.text.toLowerCase()));
  const bank = pool.filter((q) => !seen.has(q.text.toLowerCase()));
  const head = shuffle([...customs, ...bank.slice(0, Math.max(0, window - customs.length))]);
  const tail = settings.hard ? bank.slice(Math.max(0, window - customs.length)) : [];
  return settings.hard ? [...head, ...tail] : head;
}

module.exports = { THEMES, CUSTOM_TITLES, shuffle, bankPool, buildDeck };
