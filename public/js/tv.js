/* Le Plus Probable — mode grand écran (/tv/:code).
   Simple spectateur : il affiche l'état de la partie, les téléphones servent de manettes. */
(function () {
  'use strict';

  const { $, h, fill, avatar, plural, questionBody, settingsSummary, roundLabel, clock, countdown, REACTIONS, spawnBubble, fillWinner, fillVoteRows, fillPodium } = window.PP;
  const FX = window.FX;

  const SUSPENSE_MS = 2600;
  const code = (location.pathname.split('/')[2] || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  const S = { view: null, key: null, els: {}, stopCountdown: null, revealedAt: null, suspenseTimer: 0, lastTick: null, podiumShown: null };

  $('tv-code').textContent = code;
  $('tv-url').textContent = 'Rejoindre : ' + location.host;
  document.title = code + ' · Grand écran – Le Plus Probable';

  // Une télé ne reçoit pas de clic spontané : un bouton pour autoriser le son.
  $('tv-sound').addEventListener('click', () => {
    FX.unlock();
    $('tv-sound').hidden = true;
  });

  const socket = io({ reconnectionDelay: 500, reconnectionDelayMax: 3000 });
  let retry = 0;

  function watch() {
    clearTimeout(retry);
    socket.timeout(8000).emit('tv', { code }, (err, res) => {
      if (!err && res && res.ok) return;
      message('Aucune partie en cours avec le code ' + code, 'Créez la partie depuis un téléphone, cet écran se mettra à jour tout seul.');
      retry = setTimeout(watch, 5000);
    });
  }

  socket.on('connect', () => {
    $('netbar').hidden = true;
    watch();
  });
  socket.on('disconnect', () => ($('netbar').hidden = false));
  socket.on('state', (view) => {
    clock.sync(view.serverNow);
    S.view = view;
    FX.sound = view.settings.sound;
    FX.vibe = false;
    render();
  });
  socket.on('reaction', (ev) => {
    spawnBubble($('tv-bubbles'), ev);
    FX.play('pop');
  });

  function message(title, text) {
    S.key = 'message';
    stopCountdown();
    $('tv-body').replaceChildren(h('div', { class: 'tv-message' }, h('h1', { class: 'tv-title', text: title }), h('p', { text: text })));
  }

  function stopCountdown() {
    if (S.stopCountdown) S.stopCountdown();
    S.stopCountdown = null;
  }

  // ---------- statut des joueurs ----------

  function statusOf(p, v) {
    if (!p.connected) return { text: 'Reconnexion…', cls: 'away' };
    if (v.phase === 'vote') return v.round.voted.includes(p.pid) ? { text: 'A voté', cls: 'voted' } : { text: 'Réfléchit…', cls: 'wait' };
    if (v.phase === 'questions') return p.ready ? { text: 'Prêt', cls: 'voted' } : { text: 'Écrit…', cls: 'wait' };
    if (p.host) return { text: 'Hôte', cls: 'host' };
    return null;
  }

  function fillPlayers(container, v) {
    container.classList.toggle('dense', v.players.length > 7);
    fill(container, [v.players, v.phase, v.round && v.round.voted], () =>
      v.players.map((p) => {
        const st = statusOf(p, v);
        return h(
          'div',
          { class: 'tv-player' },
          avatar(p, { off: !p.connected }),
          h('span', { class: 'nm', text: p.name }),
          st ? h('span', { class: 'status ' + st.cls, text: st.text }) : null
        );
      })
    );
  }

  // ---------- squelettes par phase ----------

  function sideHead(title) {
    const count = h('span');
    return { el: h('div', { class: 'tv-side-head' }, h('b', { text: title }), count), count };
  }

  function buildLobby() {
    const qr = h('img', { class: 'qr', attrs: { alt: 'QR code pour rejoindre la partie', src: '/api/qr/' + code } });
    const summary = h('span', { class: 'tv-kicker' });
    const head = sideHead('Joueurs');
    const list = h('div', { class: 'tv-players' });
    $('tv-body').replaceChildren(
      h(
        'div',
        { class: 'tv-main' },
        h('div', { class: 'tv-lobby' }, qr, h('div', { class: 'info' }, h('span', { text: 'Scannez le QR code ou allez sur ' + location.host }), h('b', { text: code }))),
        summary
      ),
      h('div', { class: 'tv-side' }, head.el, list)
    );
    return { summary, count: head.count, list };
  }

  function buildQuestions() {
    const head = sideHead('Prêts');
    const list = h('div', { class: 'tv-players' });
    $('tv-body').replaceChildren(
      h(
        'div',
        { class: 'tv-main' },
        h('span', { class: 'tv-kicker', text: 'Avant de commencer' }),
        h('h1', { class: 'tv-title', text: 'Les joueurs écrivent leurs questions…' }),
        h('p', { class: 'lead', text: 'Jusqu’à 2 questions chacun, mélangées anonymement avec celles du jeu. Sortez vos téléphones !' })
      ),
      h('div', { class: 'tv-side' }, head.el, list)
    );
    return { count: head.count, list };
  }

  function buildVote() {
    const kicker = h('span', { class: 'tv-kicker' });
    const q = h('p', { class: 'q' });
    const barFill = h('div');
    const bar = h('div', { class: 'bar' }, barFill);
    const secs = h('b');
    const head = sideHead('Votes');
    const list = h('div', { class: 'tv-players' });
    $('tv-body').replaceChildren(
      h(
        'div',
        { class: 'tv-main' },
        kicker,
        h('div', { class: 'qcard' }, h('span', { class: 'prefix', text: 'Qui est le plus susceptible de…' }), q),
        h('div', { class: 'tv-timer' }, bar, secs)
      ),
      h('div', { class: 'tv-side' }, head.el, list)
    );
    return { kicker, q, bar, barFill, secs, count: head.count, list };
  }

  function buildResults() {
    const kicker = h('span', { class: 'tv-kicker' });
    const phrase = h('p', { class: 'lead' });
    const suspense = h('div', { class: 'suspense' }, h('strong', { text: 'Et c’est…' }), h('div', { class: 'dots', attrs: { 'aria-hidden': 'true' } }, h('i'), h('i'), h('i')));
    const faces = h('div', { class: 'faces' });
    const name = h('span', { class: 'wname' });
    const line = h('span', { class: 'wline' });
    const winner = h('div', { class: 'winner reveal' }, faces, name, line);
    const head = sideHead('Détail des votes');
    const rows = h('div', { class: 'list gap12' });
    const reacts = h('div', { class: 'tv-reacts' });
    $('tv-body').replaceChildren(
      h('div', { class: 'tv-main' }, kicker, phrase, h('div', { class: 'stage' }, suspense, winner)),
      h('div', { class: 'tv-side' }, head.el, rows, reacts)
    );
    return { kicker, phrase, suspense, winner, faces, name, line, count: head.count, rows, reacts };
  }

  function buildPodium() {
    const kicker = h('span', { class: 'tv-kicker' });
    const steps = h('div', { class: 'steps' });
    const stats = h('div', { class: 'stats' });
    $('tv-body').replaceChildren(
      h('div', { class: 'tv-main' }, kicker, h('h1', { class: 'tv-title', text: 'Le podium des titres' }), steps),
      h('div', { class: 'tv-side' }, h('div', { class: 'tv-side-head' }, h('b', { text: 'Stats rigolotes' })), stats)
    );
    return { kicker, steps, stats };
  }

  const BUILD = { lobby: buildLobby, questions: buildQuestions, vote: buildVote, results: buildResults, podium: buildPodium };

  // ---------- rendu ----------

  function render() {
    const v = S.view;
    const key = v.phase + ':' + (v.round ? v.round.n + ':' + v.round.text : '');
    if (key !== S.key) {
      stopCountdown();
      S.key = key;
      S.els = BUILD[v.phase]();
      if (v.phase === 'vote') startVote(v);
    }
    const e = S.els;
    const online = v.players.filter((p) => p.connected).length;

    if (v.phase === 'lobby') {
      e.summary.textContent = settingsSummary(v.settings);
      e.count.textContent = plural(online, 'connecté');
      fillPlayers(e.list, v);
    } else if (v.phase === 'questions') {
      e.count.textContent = v.players.filter((p) => p.connected && p.ready).length + ' / ' + online;
      fillPlayers(e.list, v);
    } else if (v.phase === 'vote') {
      e.kicker.textContent = roundLabel(v.round) + (v.round.custom ? ' · question proposée par un joueur' : '');
      e.q.textContent = v.round.text;
      e.count.textContent = v.round.voted.length + ' / ' + online;
      fillPlayers(e.list, v);
    } else if (v.phase === 'results') {
      renderResults(v, e);
    } else if (v.phase === 'podium') {
      e.kicker.textContent = 'Fin de partie · ' + plural(v.podium.rounds, 'question');
      fillPodium({ steps: e.steps, stats: e.stats }, v.podium, { scale: 1.7, vwScale: 0.5 });
      if (S.podiumShown !== v.code + v.podium.rounds) {
        S.podiumShown = v.code + v.podium.rounds;
        FX.play('podium');
      }
    }
  }

  function startVote(v) {
    const e = S.els;
    FX.play('question');
    S.lastTick = null;
    S.stopCountdown = countdown(e.barFill, e.secs, v.round, (secs) => {
      e.bar.classList.toggle('urgent', secs <= 5);
      if (secs <= 3 && secs > 0 && secs !== S.lastTick) {
        S.lastTick = secs;
        FX.play('tick');
      }
    });
  }

  function renderResults(v, e) {
    const r = v.round;
    const res = v.results;
    e.kicker.textContent = roundLabel(r);
    e.phrase.textContent = 'Le plus susceptible de ' + questionBody(r.text) + ', c’est…';
    e.count.textContent = plural(res.total, 'vote');

    const key = v.code + ':' + r.n + ':' + res.shownAt;
    const left = SUSPENSE_MS - (clock.now() - res.shownAt);
    const revealed = S.revealedAt === key || left <= 0;
    if (!revealed && !S.suspenseTimer) {
      S.suspenseTimer = setTimeout(() => {
        S.suspenseTimer = 0;
        S.revealedAt = key;
        if (S.view.phase !== 'results') return;
        FX.play('reveal');
        render();
      }, left);
    }
    if (revealed) S.revealedAt = key;
    e.suspense.hidden = revealed;
    e.winner.hidden = !revealed;
    if (revealed) fillWinner(e, res, r, v.players);
    fillVoteRows(e.rows, res, revealed);

    fill(e.reacts, r.reactions, () =>
      REACTIONS.filter((re) => r.reactions[re.key] > 0).map((re) =>
        h('span', { text: re.label + ' ×' + r.reactions[re.key], style: { color: re.color } })
      )
    );
  }
})();
