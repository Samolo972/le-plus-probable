/* Le Plus Probable — application téléphone.
   Le serveur fait foi : chaque événement « state » décrit la partie, on affiche. */
(function () {
  'use strict';

  const { $, h, fill, avatar, show, plural, questionBody, joinNames, settingsSummary, roundLabel, clock, countdown, REACTIONS, spawnBubble, fillWinner, fillVoteRows, fillPodium } = window.PP;
  const FX = window.FX;

  const SUSPENSE_MS = 2600;
  const THEMES = ['Vie perso', 'Absurde', 'Food', 'Voyages', 'Soirées', 'Ados à jamais', '+18'];
  const OPTIONS = [
    { key: 'anon', label: 'Vote anonyme', hint: 'Personne ne sait qui a voté quoi' },
    { key: 'self', label: 'Voter pour soi-même', hint: 'Autoriser l’autodérision' },
    { key: 'reveal', label: 'Révéler les votes', hint: 'Afficher qui a voté pour qui à la fin' },
    { key: 'custom', label: 'Questions des joueurs', hint: 'Chacun propose 2 questions avant la partie' },
    { key: 'sound', label: 'Son', hint: 'Jingle à chaque question et révélation' },
    { key: 'vibe', label: 'Vibration', hint: 'Le téléphone vibre quand c’est l’heure de voter' }
  ];

  // ---------- session (localStorage, peut être indisponible) ----------

  const store = {
    get(key) {
      try {
        return JSON.parse(localStorage.getItem(key));
      } catch (e) {
        return null;
      }
    },
    set(key, value) {
      try {
        if (value == null) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify(value));
      } catch (e) {
        /* navigation privée : tant pis, pas de reprise automatique */
      }
    }
  };

  const S = {
    view: null,
    session: store.get('pp.session'), // { code, token }
    overlay: null, // 'settings'
    draft: null, // brouillon des paramètres
    pick: null,
    pickRound: null,
    screen: null,
    lastRound: null,
    revealedAt: null,
    suspenseTimer: 0,
    stopCountdown: null,
    lastTick: null
  };

  const socket = io({ reconnectionDelay: 500, reconnectionDelayMax: 3000 });

  function emit(event, payload) {
    return new Promise((resolve) => {
      if (!socket.connected) {
        toast('Pas de connexion, on réessaie…');
        return resolve({ ok: false });
      }
      socket.timeout(8000).emit(event, payload || {}, (err, res) => {
        if (err) {
          toast('Le serveur ne répond pas, réessaie.');
          return resolve({ ok: false });
        }
        if (!res.ok && res.error) toast(res.error);
        resolve(res);
      });
    });
  }

  let toastTimer = 0;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 3200);
  }

  function saveSession(code, token) {
    S.session = { code, token };
    store.set('pp.session', S.session);
  }

  function leaveToHome(message) {
    S.session = null;
    S.view = null;
    S.overlay = null;
    store.set('pp.session', null);
    if (message) toast(message);
    render();
  }

  // ---------- connexion et reprise ----------

  socket.on('connect', async () => {
    $('netbar').hidden = true;
    if (!S.session) return render();
    const res = await emit('resume', S.session);
    if (!res.ok) leaveToHome(S.view ? 'Cette partie est terminée.' : null);
  });

  socket.on('disconnect', () => {
    if (S.session) $('netbar').hidden = false;
  });

  // Retour de veille : on relance la connexion sans attendre le prochain essai.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !socket.connected) socket.connect();
  });
  window.addEventListener('online', () => {
    if (!socket.connected) socket.connect();
  });

  socket.on('state', (view) => {
    clock.sync(view.serverNow);
    if (!view.me) return leaveToHome('Tu ne fais plus partie de cette partie.');
    S.view = view;
    FX.sound = view.settings.sound;
    FX.vibe = view.settings.vibe;
    render();
  });

  socket.on('reaction', (ev) => {
    if (S.screen !== 's-results') return;
    spawnBubble($('r-bubbles'), ev);
    FX.play('pop');
  });

  // ---------- rendu ----------

  function showScreen(id) {
    if (S.screen === id) return;
    for (const el of document.querySelectorAll('main.screen')) el.hidden = el.id !== id;
    S.screen = id;
    window.scrollTo(0, 0);
  }

  function render() {
    const v = S.view;
    if (!v) {
      showScreen('s-home');
      return renderHome();
    }
    if (v.phase !== 'lobby' || !v.me.host) S.overlay = null;

    if (v.phase !== 'vote' && S.stopCountdown) {
      S.stopCountdown();
      S.stopCountdown = null;
    }

    switch (v.phase) {
      case 'lobby':
        if (S.overlay === 'settings') {
          showScreen('s-settings');
          renderSettings();
        } else {
          showScreen('s-lobby');
          renderLobby(v);
        }
        break;
      case 'questions':
        showScreen('s-questions');
        renderQuestions(v);
        break;
      case 'vote':
        showScreen('s-vote');
        renderVote(v);
        break;
      case 'results':
        showScreen('s-results');
        renderResults(v);
        break;
      case 'podium':
        showScreen('s-podium');
        renderPodium(v);
        break;
    }
  }

  // ---------- 1 · accueil ----------

  let homeReady = false;
  function renderHome() {
    $('home-host').textContent = location.host;
    if (homeReady) return;
    homeReady = true;
    const params = new URLSearchParams(location.search);
    const code = (params.get('code') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    if (code) $('code').value = code;
    $('pseudo').value = store.get('pp.name') || '';
  }

  function homeValues() {
    const code = $('code').value.toUpperCase().replace(/[^A-Z]/g, '');
    const name = $('pseudo').value.trim();
    return { code, name };
  }

  function homeError(text) {
    $('home-error').textContent = text || '';
  }

  async function enter(event, payload) {
    store.set('pp.name', payload.name);
    for (const b of [$('btn-join'), $('btn-create')]) b.disabled = true;
    const res = await emit(event, payload);
    for (const b of [$('btn-join'), $('btn-create')]) b.disabled = false;
    if (res.ok) {
      saveSession(res.code, res.token);
      homeError('');
      history.replaceState(null, '', '/');
    } else if (res.error) {
      homeError(res.error);
    }
  }

  $('code').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  });

  $('btn-join').addEventListener('click', () => {
    const { code, name } = homeValues();
    if (code.length !== 4) return homeError('Le code de la salle fait 4 lettres.');
    if (!name) return homeError('Choisis un pseudo.');
    enter('join', { code, name });
  });
  $('btn-create').addEventListener('click', () => {
    const { name } = homeValues();
    if (!name) return homeError('Choisis un pseudo pour créer la partie.');
    enter('create', { name });
  });
  $('home-form').addEventListener('submit', (e) => {
    e.preventDefault();
    (homeValues().code.length === 4 ? $('btn-join') : $('btn-create')).click();
  });

  // ---------- 2 · salle d'attente ----------

  function renderLobby(v) {
    const me = v.me;
    $('lobby-code').textContent = v.code;
    const qr = '/api/qr/' + v.code;
    if ($('lobby-qr').getAttribute('src') !== qr) $('lobby-qr').src = qr;
    const online = v.players.filter((p) => p.connected).length;
    $('lobby-count').textContent = plural(online, 'connecté');

    fill($('lobby-players'), [v.players, me.pid], () =>
      v.players.map((p) =>
        h(
          'div',
          { class: 'player-row' },
          avatar(p, { off: !p.connected }),
          h(
            'div',
            { class: 'who' },
            h('span', { class: 'name', text: p.name + (p.pid === me.pid ? ' (toi)' : '') }),
            !p.connected
              ? h('span', { class: 'away', text: 'En veille · reconnexion…' })
              : p.palmares > 0
                ? h('span', { class: 'sub', text: plural(p.palmares, 'titre') + ' au palmarès' })
                : null
          ),
          p.host ? h('span', { class: 'tag', text: 'Hôte' }) : null
        )
      )
    );

    show($('btn-settings'), me.host);
    show($('settings-spacer'), !me.host);
    show($('btn-start'), me.host);
    show($('lobby-wait'), !me.host);
    show($('lobby-tv'), me.host);
    $('lobby-tv').href = '/tv/' + v.code;
    const enough = v.players.length >= 2;
    $('btn-start').disabled = !enough;
    $('btn-start').textContent = enough ? 'Lancer la partie' : 'En attente d’un 2e joueur…';
    $('lobby-summary').textContent = settingsSummary(v.settings);
  }

  $('btn-leave').addEventListener('click', async () => {
    await emit('leave');
    leaveToHome();
  });
  $('btn-start').addEventListener('click', () => emit('start'));
  $('btn-settings').addEventListener('click', () => {
    S.draft = JSON.parse(JSON.stringify(S.view.settings));
    S.overlay = 'settings';
    $('themes-error').textContent = '';
    render();
  });

  // ---------- paramètres (hôte) ----------

  function setDraft(patch) {
    Object.assign(S.draft, patch);
    if (S.draft.anon) S.draft.reveal = false;
    renderSettings();
  }

  function renderSettings() {
    const d = S.draft;
    $('hard-card').classList.toggle('on', d.hard);
    $('sw-hard').setAttribute('aria-checked', String(d.hard));
    $('hard-tag').textContent = d.hard ? 'Activé · sans limite' : 'Désactivé';
    show($('count-unlimited'), d.hard);
    show($('pills-count'), !d.hard);

    const pill = (label, on, onClick) =>
      h('button', { class: 'pill', text: label, attrs: { type: 'button', 'aria-pressed': String(on) }, on: { click: onClick } });

    fill($('pills-count'), d.count, () => [5, 10, 15, 20].map((n) => pill(String(n), d.count === n, () => setDraft({ count: n }))));
    fill($('pills-timer'), d.timer, () =>
      [10, 20, 30, 0].map((t) =>
        pill(t ? t + ' s' : '∞', d.timer === t, () => setDraft({ timer: t }))
      )
    );
    const infinity = $('pills-timer').lastElementChild;
    if (infinity) infinity.setAttribute('aria-label', 'Temps illimité');

    fill($('chips-themes'), d.themes, () =>
      THEMES.map((t) => {
        const on = d.themes.includes(t);
        return h('button', {
          class: 'chip',
          text: t,
          attrs: { type: 'button', 'aria-pressed': String(on) },
          on: {
            click: () => {
              $('themes-error').textContent = '';
              setDraft({ themes: on ? d.themes.filter((x) => x !== t) : THEMES.filter((x) => x === t || d.themes.includes(x)) });
            }
          }
        });
      })
    );

    show($('themes-adult'), d.themes.includes('+18'));

    fill($('options'), OPTIONS.map((o) => [d[o.key], o.key === 'reveal' && d.anon]), () =>
      OPTIONS.map((o) => {
        const locked = o.key === 'reveal' && d.anon;
        return h(
          'div',
          { class: 'option' + (locked ? ' disabled' : '') },
          h('div', { class: 'txt' }, h('strong', { text: o.label }), h('span', { text: locked ? 'Impossible avec le vote anonyme' : o.hint })),
          h('button', {
            class: 'switch',
            attrs: { type: 'button', role: 'switch', 'aria-checked': String(Boolean(d[o.key])), 'aria-label': o.label, disabled: locked },
            on: { click: () => setDraft({ [o.key]: !d[o.key] }) }
          })
        );
      })
    );
  }

  $('sw-hard').addEventListener('click', () => setDraft({ hard: !S.draft.hard }));
  $('btn-settings-back').addEventListener('click', () => {
    S.overlay = null;
    render();
  });
  $('btn-save').addEventListener('click', async () => {
    if (!S.draft.themes.length) {
      $('themes-error').textContent = 'Choisis au moins un thème.';
      return;
    }
    const res = await emit('settings', S.draft);
    if (res.ok) {
      S.overlay = null;
      render();
    }
  });

  // ---------- 3 · questions des joueurs ----------

  function renderQuestions(v) {
    const me = v.me;
    const online = v.players.filter((p) => p.connected);
    $('q-ready').textContent = online.filter((p) => p.ready).length + ' / ' + plural(online.length, 'joueur') + ' prêts';
    const mine = me.questions;
    $('q-mine-label').textContent = 'Tes questions (' + mine.length + '/2)';
    fill($('q-mine'), [mine, me.ready], () =>
      mine.map((text, i) =>
        h(
          'div',
          { class: 'mine' },
          h('span', { text: '…' + text }),
          me.ready
            ? null
            : h(
                'button',
                { class: 'icon-btn', attrs: { type: 'button', 'aria-label': 'Supprimer cette question' }, on: { click: () => emit('q:remove', { index: i }) } },
                svgClose()
              )
        )
      )
    );
    const full = mine.length >= 2;
    $('q-input').disabled = full || me.ready;
    updateAddButton();
    $('btn-ready').textContent = me.ready ? 'Finalement, je modifie' : 'Je suis prêt';
    $('btn-ready').classList.toggle('ghost', me.ready);
    show($('btn-force-start'), me.host);
  }

  function svgClose() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', '#FFFFFF');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M6 6l12 12M18 6L6 18');
    svg.append(path);
    return svg;
  }

  function updateAddButton() {
    const v = S.view;
    if (!v || v.phase !== 'questions') return;
    const len = $('q-input').value.trim().replace(/^…\s*/, '').length;
    const full = v.me.questions.length >= 2;
    $('q-counter').textContent = $('q-input').value.length + ' / 120';
    $('btn-q-add').disabled = full || v.me.ready || len < 5;
    $('btn-q-add').textContent = full ? 'Maximum atteint' : 'Ajouter ma question';
  }

  $('q-input').addEventListener('input', updateAddButton);
  $('btn-q-add').addEventListener('click', async () => {
    const res = await emit('q:add', { text: $('q-input').value });
    if (res.ok) {
      $('q-input').value = '';
      updateAddButton();
    }
  });
  $('btn-ready').addEventListener('click', () => emit('ready', { ready: !S.view.me.ready }));
  $('btn-force-start').addEventListener('click', () => emit('force'));

  // ---------- 4 · vote ----------

  function renderVote(v) {
    const r = v.round;
    const me = v.me;
    const roundKey = v.code + ':' + r.n + ':' + r.text;
    if (S.lastRound !== roundKey) {
      // Nouvelle manche : jingle, vibration, on oublie le choix précédent.
      // Pas de jingle si on arrive (ou revient de veille) au milieu d'une manche.
      const startedAt = r.deadline ? r.deadline - r.timer * 1000 : null;
      const fresh = S.lastRound !== null || (startedAt !== null && clock.now() - startedAt < 3000);
      S.lastRound = roundKey;
      S.pick = null;
      S.pickRound = roundKey;
      S.lastTick = null;
      if (fresh) {
        FX.play('question');
        FX.vibrate(80);
      }
      if (S.stopCountdown) S.stopCountdown();
      S.stopCountdown = countdown($('v-bar').firstElementChild, $('v-seconds'), r, (secs) => {
        $('v-bar').classList.toggle('urgent', secs <= 5);
        if (secs <= 3 && secs > 0 && secs !== S.lastTick && !S.view.me.voted) {
          S.lastTick = secs;
          FX.play('tick');
        }
      });
    }

    $('v-round').textContent = roundLabel(r);
    $('v-question').textContent = r.text;
    show($('v-from'), r.custom);

    const voted = me.voted;
    const chosen = voted ? me.myVote || S.pick : S.pick;
    const targets = v.players.filter((p) => v.settings.self || p.pid !== me.pid);
    fill($('v-tiles'), [targets, chosen, voted], () =>
      targets.map((p) =>
        h(
          'button',
          {
            class: 'tile',
            attrs: { type: 'button', 'aria-pressed': String(p.pid === chosen), disabled: voted },
            on: {
              click: () => {
                S.pick = p.pid;
                render();
              }
            }
          },
          avatar(p, { off: !p.connected }),
          h('span', { class: 'nm', text: p.pid === me.pid ? p.name + ' (toi)' : p.name })
        )
      )
    );

    const pickName = (v.players.find((p) => p.pid === S.pick) || {}).name;
    $('v-hint').textContent = voted ? 'Ton vote est enregistré' : 'Choisis un collègue';
    show($('btn-vote'), !voted);
    show($('v-done'), voted);
    $('btn-vote').textContent = pickName ? 'Voter pour ' + pickName : 'Choisis quelqu’un';
    $('btn-vote').classList.toggle('muted', !pickName);

    const online = v.players.filter((p) => p.connected);
    const away = v.players.filter((p) => !p.connected).map((p) => p.name);
    const parts = [v.settings.anon ? 'Vote anonyme' : 'Vote à découvert', r.voted.length + ' / ' + online.length + ' ont voté'];
    if (away.length === 1) parts.push(away[0] + ' se reconnecte…');
    else if (away.length === 2) parts.push(joinNames(away) + ' se reconnectent…');
    else if (away.length > 2) parts.push(away.length + ' joueurs se reconnectent…');
    $('v-status').textContent = parts.join(' · ');
    show($('btn-reveal-now'), me.host);
  }

  $('btn-vote').addEventListener('click', async () => {
    if (!S.pick) return toast('Choisis d’abord un collègue.');
    const res = await emit('vote', { pid: S.pick });
    if (res.ok) FX.vibrate(30);
  });
  $('btn-reveal-now').addEventListener('click', () => emit('force'));

  // ---------- 5 · résultats ----------

  function renderResults(v) {
    const r = v.round;
    const res = v.results;
    const me = v.me;
    $('r-round').textContent = roundLabel(r);
    $('r-total').textContent = plural(res.total, 'vote') + ' ' + (res.total > 1 ? 'reçus' : 'reçu');
    $('r-phrase').textContent = 'Le plus susceptible de ' + questionBody(r.text) + ', c’est…';

    const key = v.code + ':' + r.n + ':' + res.shownAt;
    const left = SUSPENSE_MS - (clock.now() - res.shownAt);
    const revealed = S.revealedAt === key || left <= 0;
    if (!revealed && !S.suspenseTimer) {
      S.suspenseTimer = setTimeout(() => {
        S.suspenseTimer = 0;
        S.revealedAt = key;
        if (!S.view || S.view.phase !== 'results') return;
        const winners = res.winners;
        $('r-winner').classList.add('reveal');
        FX.play('reveal');
        FX.vibrate(winners.includes(me.pid) ? [120, 60, 220] : [60, 40, 60]);
        render();
      }, left);
    }
    if (revealed) S.revealedAt = key;

    show($('r-suspense'), !revealed);
    show($('r-winner'), revealed);
    if (revealed) fillWinner({ faces: $('r-faces'), name: $('r-name'), line: $('r-line') }, res, r, v.players);
    fillVoteRows($('r-rows'), res, revealed);

    fill($('r-reactions'), r.reactions, () =>
      REACTIONS.map((re) =>
        h(
          'button',
          { class: 'react', attrs: { type: 'button', 'aria-label': 'Réagir : ' + re.label }, on: { click: () => react(re.key) } },
          h('span', { class: 'lbl', text: re.label, style: { color: re.color } }),
          h('span', { class: 'cnt', text: '×' + (r.reactions[re.key] || 0) })
        )
      )
    );

    show($('btn-next'), me.host);
    show($('btn-end'), me.host && !res.last);
    show($('r-wait'), !me.host);
    $('btn-next').textContent = res.last ? 'Voir le podium' : 'Question suivante';
  }

  function react(kind) {
    FX.vibrate(15);
    socket.emit('react', { kind });
  }

  $('btn-next').addEventListener('click', () => emit('next'));
  $('btn-end').addEventListener('click', () => emit('end'));

  // ---------- 6 · podium ----------

  let podiumShown = null;
  function renderPodium(v) {
    const p = v.podium;
    $('p-sub').textContent = 'Fin de partie · ' + plural(p.rounds, 'question');
    fillPodium({ steps: $('p-steps'), others: $('p-others'), stats: $('p-stats') }, p);
    if (podiumShown !== v.code + p.rounds) {
      podiumShown = v.code + p.rounds;
      FX.play('podium');
      FX.vibrate([80, 50, 80, 50, 160]);
    }

    show($('p-recap'), Boolean(p.reveal && p.reveal.length));
    if (p.reveal) {
      fill($('p-recap-list'), p.reveal, () =>
        p.reveal.map((round) =>
          h(
            'li',
            null,
            h('span', { class: 'rq', text: 'Manche ' + round.n + ' · ' + round.text }),
            round.pairs.length
              ? round.pairs.map((x) => h('span', { text: x.voter.name + ' → ' + x.target.name + '   ' }))
              : h('span', { text: 'Aucun vote' })
          )
        )
      );
    }

    show($('btn-replay'), v.me.host);
    show($('p-wait'), !v.me.host);
  }

  $('btn-replay').addEventListener('click', () => emit('replay'));
  $('btn-new').addEventListener('click', async () => {
    await emit('leave');
    leaveToHome();
  });

  render();
})();
