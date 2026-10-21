'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { Room } = require('../src/room');
const { cleanQuestion, cleanName } = require('../src/sanitize');

function setup(n = 4, settings = {}) {
  const db = openDb(':memory:');
  db.seedIfEmpty();
  const room = new Room({ code: 'TEST', db, timeScale: 1 });
  const players = [];
  for (let i = 0; i < n; i++) players.push(room.addPlayer(['Samuel', 'Inès', 'Karim', 'Léa', 'Tom', 'Zoé'][i]));
  const host = players[0].token;
  room.updateSettings(host, { custom: false, timer: 0, ...settings });
  return { db, room, players, host };
}

test('la banque est importée au premier lancement seulement', () => {
  const db = openDb(':memory:');
  const first = db.seedIfEmpty();
  assert.ok(first >= 200, `questions importées : ${first}`);
  assert.equal(db.seedIfEmpty(), 0);
  const hard = db.activeQuestions().filter((q) => q.hard);
  assert.ok(hard.length >= 50);
  assert.ok(db.activeQuestions().every((q) => q.text.endsWith(' ?')));
});

test('nettoyage des textes joueurs', () => {
  assert.equal(cleanQuestion('Qui est le plus susceptible de <b>danser</b> sur la table ???'), 'bdanser/b sur la table ?');
  assert.equal(cleanQuestion('…oublier son badge'), 'oublier son badge ?');
  assert.equal(cleanQuestion('abc'), null);
  assert.equal(cleanQuestion('x'.repeat(121)), null);
  assert.equal(cleanName('  <script>Zoé</script>  '), 'scriptZoé/script');
  assert.equal(cleanName('   '), null);
});

test('partie complète : vote, gagnant, titre, podium', () => {
  const { db, room, players, host } = setup(4, { count: 5 });
  room.start(host);
  assert.equal(room.phase, 'vote');
  assert.equal(room.deck.length, 5);

  for (let n = 1; n <= 5; n++) {
    // Tout le monde vote pour Karim sauf Karim qui vote pour Léa.
    for (const p of players) room.vote(p.token, p.name === 'Karim' ? players[3].pid : players[2].pid);
    assert.equal(room.phase, 'results', 'la manche se clôt quand tout le monde a voté');
    const v = room.view(players[0].token);
    assert.equal(v.results.winners[0], players[2].pid);
    assert.equal(v.results.total, 4);
    room.next(host);
  }
  assert.equal(room.phase, 'podium');
  const podium = room.view(null).podium;
  assert.equal(podium.podium[0].name, 'Karim');
  assert.equal(podium.podium[0].votes, 15);
  assert.equal(podium.stats.length, 4);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM results').get().n, 5);
  assert.equal(db.titleCount('karim'), 5);
  assert.equal(db.raw.prepare("SELECT status FROM games WHERE id = ?").get(room.gameId).status, 'finished');
});

test('vote anonyme : aucune trace de qui a voté pour qui', () => {
  const { room, players, host, db } = setup(3, { anon: true, reveal: true });
  assert.equal(room.settings.reveal, false, 'révéler est coupé par l’anonymat');
  room.start(host);
  room.vote(players[0].token, players[1].pid);
  assert.equal(room.round.pairs, null);
  const snap = JSON.stringify(room.snapshot());
  assert.ok(!snap.includes('"pairs":{'), 'pas de paires dans l’instantané');
  room.vote(players[1].token, players[2].pid);
  room.vote(players[2].token, players[1].pid);
  const v = room.view(players[0].token);
  assert.equal(v.results.rows[0].voters, null);
  assert.equal(v.me.myVote, null);
  const row = db.raw.prepare('SELECT tally FROM results').get();
  assert.deepEqual(Object.keys(JSON.parse(row.tally)).sort(), ['Inès', 'Karim', 'Samuel']);
});

test('vote nominatif + révélation à la fin', () => {
  const { room, players, host } = setup(3, { anon: false, reveal: true, count: 5 });
  room.start(host);
  room.vote(players[0].token, players[1].pid);
  room.vote(players[1].token, players[0].pid);
  room.vote(players[2].token, players[1].pid);
  const v = room.view(players[0].token);
  assert.equal(v.results.rows[0].voters.length, 2);
  room.end(host);
  assert.equal(room.podium.reveal.length, 1);
  assert.equal(room.podium.reveal[0].pairs.length, 3);
});

test('règles de vote : pas pour soi, pas deux fois', () => {
  const { room, players, host } = setup(3);
  room.start(host);
  assert.throws(() => room.vote(players[0].token, players[0].pid), /impossible/);
  room.vote(players[0].token, players[1].pid);
  assert.throws(() => room.vote(players[0].token, players[2].pid), /déjà voté/);
});

test('seul l’hôte règle et lance', () => {
  const { room, players } = setup(3);
  assert.throws(() => room.updateSettings(players[1].token, { count: 5 }), /hôte/);
  assert.throws(() => room.start(players[1].token), /hôte/);
  assert.throws(() => room.updateSettings(players[0].token, { themes: [] }), /thème/);
});

test('questions des joueurs mélangées dans la partie et conservées', () => {
  const { room, players, host, db } = setup(3, { custom: true, count: 10 });
  room.start(host);
  assert.equal(room.phase, 'questions');
  room.addQuestion(players[0].token, 'oublier sa propre réunion');
  room.addQuestion(players[0].token, 'arriver en pyjama en visio');
  assert.throws(() => room.addQuestion(players[0].token, 'une troisième question'), /Maximum/);
  room.addQuestion(players[1].token, 'parler à la photocopieuse');
  room.setReady(players[0].token, true);
  room.setReady(players[1].token, true);
  assert.equal(room.phase, 'questions');
  room.setReady(players[2].token, true);
  assert.equal(room.phase, 'vote');
  const customs = room.deck.filter((q) => q.custom).map((q) => q.text);
  assert.equal(customs.length, 3);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM custom_questions').get().n, 3);
});

test('timer : la manche se clôt toute seule', async () => {
  const { room, players, host } = setup(3, { timer: 10 }); // timeScale 1 → 10 ms
  room.start(host);
  room.vote(players[0].token, players[1].pid);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(room.phase, 'results');
  assert.equal(room.results.total, 1);
});

test('un joueur en veille ne bloque pas la manche', () => {
  const { room, players, host } = setup(3);
  room.start(host);
  room.vote(players[0].token, players[1].pid);
  room.vote(players[1].token, players[0].pid);
  room.setConnected(players[2].token, false);
  assert.equal(room.phase, 'results');
  assert.equal(room.view(null).players[2].connected, false);
});

test('mode Hard : sans limite, on enchaîne jusqu’à l’arrêt', () => {
  const { room, players, host } = setup(2, { hard: true });
  room.start(host);
  assert.equal(room.view(null).round.total, null);
  for (let i = 0; i < 80; i++) {
    room.vote(players[0].token, players[1].pid);
    room.vote(players[1].token, players[0].pid);
    room.next(host);
  }
  assert.equal(room.phase, 'vote');
  assert.equal(room.round.n, 81);
  room.end(host);
  assert.equal(room.phase, 'podium');
  assert.equal(room.podium.rounds, 80);
});

test('instantané → restauration après redémarrage', () => {
  const { room, players, host, db } = setup(3, { timer: 0 });
  room.start(host);
  room.vote(players[0].token, players[1].pid);
  const restored = Room.restore({ gameId: room.gameId, state: JSON.parse(JSON.stringify(room.snapshot())), db, timeScale: 1 });
  assert.equal(restored.phase, 'vote');
  assert.ok(restored.connectedPlayers().length === 0, 'tout le monde revient en veille');
  restored.setConnected(players[1].token, true);
  restored.vote(players[1].token, players[0].pid);
  assert.equal(restored.phase, 'results', 'les connectés ont tous voté');
  assert.equal(restored.results.total, 2);
});

test('rejouer avec les mêmes joueurs', () => {
  const { room, players, host } = setup(3);
  room.start(host);
  room.end(host);
  const oldGame = room.gameId;
  room.replay(host);
  assert.equal(room.phase, 'lobby');
  assert.notEqual(room.gameId, oldGame);
  assert.equal(room.players.size, 3);
  assert.equal(room.code, 'TEST');
});

test('purge des parties et sessions de plus de 30 jours', () => {
  const { db, room } = setup(2);
  room.dispose();
  const old = Date.now() - 31 * 24 * 3600 * 1000;
  db.raw.prepare('UPDATE games SET created_at = ?').run(old);
  db.raw.prepare('UPDATE sessions SET last_seen = ?').run(old);
  const out = db.purgeOld();
  assert.equal(out.games, 1);
  assert.equal(out.sessions, 2);
});
