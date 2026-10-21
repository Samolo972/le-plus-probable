'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { createApp } = require('../server');

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-')), 'test.db');

async function start(dbFile) {
  const inst = createApp({ dbFile, timeScale: 1000 });
  await new Promise((r) => inst.server.listen(0, '127.0.0.1', r));
  inst.url = `http://127.0.0.1:${inst.server.address().port}`;
  return inst;
}

function client(url) {
  const socket = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  socket.last = null;
  socket.on('state', (v) => (socket.last = v));
  socket.call = (event, payload = {}) => new Promise((r) => socket.emit(event, payload, r));
  socket.until = (pred, ms = 2000) =>
    new Promise((resolve, reject) => {
      if (socket.last && pred(socket.last)) return resolve(socket.last);
      const t = setTimeout(() => reject(new Error('état attendu non reçu')), ms);
      const on = (v) => {
        if (pred(v)) {
          clearTimeout(t);
          socket.off('state', on);
          resolve(v);
        }
      };
      socket.on('state', on);
    });
  return new Promise((r) => socket.on('connect', () => r(socket)));
}

test('partie à 5 téléphones + TV, anonymat, réactions, reconnexion, redémarrage', async () => {
  const dbFile = tmpDb();
  let srv = await start(dbFile);
  const names = ['Samuel', 'Inès', 'Karim', 'Léa', 'Tom'];
  const phones = await Promise.all(names.map(() => client(srv.url)));
  const [host] = phones;

  const created = await host.call('create', { name: 'Samuel' });
  assert.ok(created.ok);
  assert.match(created.code, /^[A-Z]{4}$/);
  const tokens = [created.token];
  for (let i = 1; i < 5; i++) {
    const r = await phones[i].call('join', { code: created.code.toLowerCase(), name: names[i] });
    assert.ok(r.ok, r.error);
    tokens.push(r.token);
  }
  assert.equal((await phones[1].call('join', { code: 'ZZZZ', name: 'X' })).ok, false);

  const tv = await client(srv.url);
  assert.ok((await tv.call('tv', { code: created.code })).ok);
  await tv.until((v) => v.players.length === 5);
  assert.equal(tv.last.me, undefined, 'la TV n’a pas de joueur');
  assert.ok(!JSON.stringify(tv.last).includes(tokens[0]), 'aucun token secret dans les vues');

  // Un non-hôte ne peut pas lancer.
  assert.equal((await phones[2].call('start')).ok, false);
  assert.ok((await host.call('settings', { custom: true, timer: 0, count: 5, anon: true })).ok);
  assert.ok((await host.call('start')).ok);
  await phones[1].until((v) => v.phase === 'questions');

  assert.ok((await phones[1].call('q:add', { text: '<img src=x onerror=alert(1)> chanter en réunion' })).ok);
  const mine = (await phones[1].until((v) => v.me.questions.length === 1)).me.questions[0];
  assert.ok(!mine.includes('<'), 'les chevrons sont retirés');

  for (const p of phones) assert.ok((await p.call('ready', { ready: true })).ok);
  const vote = await tv.until((v) => v.phase === 'vote');
  assert.equal(vote.round.total, 5);

  // Manche 1 : 4 votes pour Karim, Karim vote pour Léa.
  const karim = vote.players.find((p) => p.name === 'Karim').pid;
  const lea = vote.players.find((p) => p.name === 'Léa').pid;
  for (let i = 0; i < 5; i++) {
    const r = await phones[i].call('vote', { pid: i === 2 ? lea : karim });
    assert.ok(r.ok, r.error);
  }
  const res = await tv.until((v) => v.phase === 'results');
  assert.deepEqual(res.results.winners, [karim]);
  assert.equal(res.results.rows[0].voters, null, 'anonyme : pas de votants');

  // Réactions en direct, reçues par la TV.
  const got = new Promise((r) => tv.once('reaction', r));
  await phones[3].call('react', { kind: 'mdr' });
  const ev = await got;
  assert.equal(ev.name, 'Léa');
  assert.equal(ev.kind, 'mdr');

  // En base : rien ne permet de savoir qui a voté pour qui.
  const row = srv.db.raw.prepare('SELECT * FROM results').get();
  assert.equal(row.winner, 'Karim');
  assert.equal(row.votes, 4);

  // Téléphone en veille : les autres le voient en reconnexion.
  phones[4].disconnect();
  await tv.until((v) => v.players.find((p) => p.name === 'Tom').connected === false);

  // Manche 2 commencée puis redémarrage du serveur.
  assert.ok((await host.call('next')).ok);
  await tv.until((v) => v.phase === 'vote' && v.round.n === 2);
  assert.ok((await phones[0].call('vote', { pid: lea })).ok);
  for (const p of [...phones.slice(0, 4), tv]) p.disconnect();
  srv.close();

  srv = await start(dbFile);
  const back = await client(srv.url);
  const resumed = await back.call('resume', { code: created.code, token: tokens[1] });
  assert.ok(resumed.ok, resumed.error);
  const state = await back.until((v) => v.phase === 'vote');
  assert.equal(state.round.n, 2);
  assert.equal(state.round.voted.length, 1, 'le vote de Samuel a survécu');
  assert.equal(state.players.find((p) => p.name === 'Samuel').connected, false);

  const intrus = await client(srv.url);
  assert.equal((await intrus.call('resume', { code: created.code, token: '00000000-0000-0000-0000-000000000000' })).ok, false);

  back.disconnect();
  intrus.disconnect();
  srv.close();
});
