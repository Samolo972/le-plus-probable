/* Outils partagés par le téléphone (app.js) et le grand écran (tv.js).
   Tout texte venant des joueurs passe par textContent : jamais d'innerHTML. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // h('div', { class: 'x', text: 'y', style: { width: '10px' }, attrs: {...}, on: { click } }, ...enfants)
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    const p = props || {};
    if (p.class) el.className = p.class;
    if (p.text != null) el.textContent = p.text;
    if (p.style) for (const [k, v] of Object.entries(p.style)) el.style.setProperty(k, v);
    if (p.attrs) for (const [k, v] of Object.entries(p.attrs)) if (v != null && v !== false) el.setAttribute(k, v === true ? '' : v);
    if (p.on) for (const [k, fn] of Object.entries(p.on)) el.addEventListener(k, fn);
    for (const c of children.flat()) if (c != null && c !== false) el.append(c);
    return el;
  }

  // Ne reconstruit une liste que si ses données ont changé (garde le focus et les animations).
  function fill(container, key, build) {
    const sig = JSON.stringify(key);
    if (container._sig === sig) return false;
    container._sig = sig;
    container.replaceChildren(...[].concat(build()));
    return true;
  }

  function avatar(p, opts) {
    const o = opts || {};
    return h('div', {
      class: 'avatar' + (o.off ? ' off' : '') + (o.class ? ' ' + o.class : ''),
      text: p.initial,
      style: Object.assign({ background: p.color }, o.size ? { '--size': o.size } : {}, o.style || {}),
      attrs: { 'aria-hidden': 'true' }
    });
  }

  function show(el, visible) {
    el.hidden = !visible;
  }

  const plural = (n, word, many) => n + ' ' + (n > 1 ? many || word + 's' : word);

  // La phrase sans son « ? » final, pour « Le plus susceptible de …, c'est… ».
  const questionBody = (text) => text.replace(/\s*\?$/, '');

  function joinNames(names) {
    if (names.length <= 1) return names[0] || '';
    return names.slice(0, -1).join(', ') + ' et ' + names[names.length - 1];
  }

  function settingsSummary(s) {
    const time = s.timer ? s.timer + ' secondes pour voter' : 'temps de vote illimité';
    if (s.hard) return 'Mode Hard · sans limite · ' + time;
    return s.count + ' questions · ' + time;
  }

  function roundLabel(round) {
    return round.total ? 'Manche ' + round.n + ' / ' + round.total : 'Manche ' + round.n + ' · Mode Hard';
  }

  // Horloge alignée sur le serveur pour que tous les timers tombent ensemble.
  const clock = {
    offset: 0,
    sync(serverNow) {
      this.offset = serverNow - Date.now();
    },
    now() {
      return Date.now() + this.offset;
    }
  };

  // Barre + secondes restantes, animées jusqu'à l'échéance.
  function countdown(barFill, label, round, onTick) {
    let raf = 0;
    const total = round.timer * 1000;
    const step = () => {
      const left = Math.max(0, round.deadline - clock.now());
      const secs = Math.ceil(left / 1000);
      barFill.style.transform = 'scaleX(' + (total ? left / total : 0) + ')';
      label.textContent = secs + ' s';
      if (onTick) onTick(secs, left);
      if (left > 0) raf = requestAnimationFrame(step);
    };
    if (round.deadline) step();
    else {
      barFill.style.transform = 'scaleX(1)';
      label.textContent = 'Sans limite';
    }
    return () => cancelAnimationFrame(raf);
  }

  const REACTIONS = [
    { key: 'mdr', label: 'MDR', color: '#FF7A59' },
    { key: 'choc', label: 'Choqué', color: '#8FB8FF' },
    { key: 'vrai', label: 'Trop vrai', color: '#5EE6C5' },
    { key: 'feu', label: 'Feu', color: '#FFD23F' }
  ];
  const reactionLabel = (key) => (REACTIONS.find((r) => r.key === key) || { label: key }).label;

  function spawnBubble(layer, ev) {
    if (!layer || !layer.getClientRects().length) return; // écran masqué
    const rot = (Math.random() * 18 - 9).toFixed(1) + 'deg';
    // En haut ou en bas de la carte, comme sur la maquette, pour ne pas cacher le gagnant.
    spawnBubble.flip = !spawnBubble.flip;
    const top = spawnBubble.flip ? Math.random() * 10 : 80 + Math.random() * 12;
    const el = h('span', {
      class: 'bubble',
      text: ev.name + ' · ' + reactionLabel(ev.kind),
      style: {
        background: ev.color,
        left: (2 + Math.random() * 62).toFixed(1) + '%',
        top: top.toFixed(1) + '%',
        '--rot': rot
      }
    });
    layer.append(el);
    el.addEventListener('animationend', () => el.remove());
    while (layer.childElementCount > 14) layer.firstElementChild.remove();
  }

  // Bloc « gagnant » commun aux deux écrans.
  function fillWinner(els, results, round, players) {
    const byPid = new Map(players.map((p) => [p.pid, p]));
    const rows = new Map(results.rows.map((r) => [r.pid, r]));
    const winners = results.winners.map((pid) => byPid.get(pid) || rows.get(pid)).filter(Boolean);
    els.faces.classList.toggle('many', winners.length > 1);
    els.faces.replaceChildren(
      ...winners.slice(0, 4).map((w) => h('div', { class: 'avatar', text: w.initial, style: { color: w.color }, attrs: { 'aria-hidden': 'true' } }))
    );
    if (!winners.length) {
      els.name.textContent = 'Personne !';
      els.line.textContent = 'Aucun vote cette manche';
    } else if (winners.length === 1) {
      els.name.textContent = winners[0].name + ' !';
      els.line.textContent = plural(results.best, 'vote') + ' sur ' + results.total + ' · titre gagné : ' + round.title;
    } else {
      els.name.textContent = joinNames(winners.map((w) => w.name)) + ' !';
      els.line.textContent = 'Égalité à ' + plural(results.best, 'vote') + ' · titre partagé : ' + round.title;
    }
    return winners;
  }

  function fillVoteRows(container, results, revealed) {
    const total = results.total || 1;
    fill(container, [results.rows, revealed], () =>
      results.rows.flatMap((r) => {
        const fillEl = h('div', { class: 'fill', style: { background: r.color } });
        if (revealed) requestAnimationFrame(() => requestAnimationFrame(() => (fillEl.style.width = Math.round((r.votes / total) * 100) + '%')));
        const row = h(
          'div',
          { class: 'vote-row' },
          h('span', { class: 'nm', text: r.name }),
          h('div', { class: 'track' }, fillEl),
          h('span', { class: 'n', text: revealed ? String(r.votes) : '·' })
        );
        const by = revealed && r.voters && r.voters.length ? h('p', { class: 'vote-by', text: 'par ' + joinNames(r.voters.map((v) => v.name)) }) : null;
        return by ? [row, by] : [row];
      })
    );
  }

  function fillPodium(els, podium, opts) {
    const o = opts || {};
    const order = [podium.podium[1], podium.podium[0], podium.podium[2]].filter(Boolean);
    const dims = { 1: { h: 150, size: 76 }, 2: { h: 110, size: 60 }, 3: { h: 84, size: 54 } };
    const scale = o.scale || 1;
    fill(els.steps, podium.podium, () =>
      order.map((p) => {
        const d = dims[p.rank];
        const size = 'clamp(' + Math.round(d.size * 0.75) + 'px, ' + ((d.size / 3.9) * (o.vwScale || 1)).toFixed(1) + 'vw, ' + Math.round(d.size * scale) + 'px)';
        return h(
          'div',
          { class: 'step' + (p.rank === 1 ? ' first' : '') },
          h('div', { class: 'avatar', text: p.initial, style: { background: p.color, '--size': size, 'font-size': 'calc(var(--size) * 0.45)' }, attrs: { 'aria-hidden': 'true' } }),
          h('span', { class: 'nm', text: p.name }),
          h('span', { class: 'ttl', text: p.title }),
          h(
            'div',
            { class: 'block', style: { height: Math.round(d.h * scale) + 'px', background: p.rank === 1 ? 'var(--accent)' : p.color } },
            h('b', { text: String(p.rank) }),
            h('span', { text: plural(p.votes, 'vote') })
          )
        );
      })
    );
    if (els.others) {
      fill(els.others, podium.others, () =>
        podium.others.map((p) =>
          h(
            'div',
            { class: 'other-row' },
            h('span', { class: 'rk', text: String(p.rank) }),
            avatar(p),
            h('div', { class: 'who' }, h('b', { text: p.name }), h('span', { text: p.title })),
            h('span', { class: 'v', text: plural(p.votes, 'vote') })
          )
        )
      );
    }
    fill(els.stats, podium.stats, () =>
      podium.stats.map((s) =>
        h(
          'div',
          { class: 'stat' },
          h('span', { class: 'k', text: s.label, style: { color: s.color } }),
          h('span', { class: 'val', text: s.value }),
          h('span', { class: 'd', text: s.detail })
        )
      )
    );
  }

  window.PP = {
    $, h, fill, avatar, show, plural, questionBody, joinNames, settingsSummary, roundLabel,
    clock, countdown, REACTIONS, reactionLabel, spawnBubble, fillWinner, fillVoteRows, fillPodium
  };
})();
