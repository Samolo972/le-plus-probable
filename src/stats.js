'use strict';

const REACTIONS = [
  { key: 'mdr', label: 'MDR', color: '#FF7A59' },
  { key: 'choc', label: 'Choqué', color: '#8FB8FF' },
  { key: 'vrai', label: 'Trop vrai', color: '#5EE6C5' },
  { key: 'feu', label: 'Feu', color: '#FFD23F' }
];
const REACTION_KEYS = REACTIONS.map((r) => r.key);
const NO_TITLE = 'Insoupçonnable';

const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;
const seconds = (ms) => (ms / 1000).toFixed(1).replace('.', ',');

function shortQuestion(text) {
  const words = text.replace(/ \?$/, '').split(' ');
  return words.length <= 4 ? words.join(' ') : words.slice(0, 4).join(' ') + '…';
}

// Le titre affiché au podium : celui de la manche où le joueur a été le plus désigné.
function bestTitle(titles) {
  if (!titles.length) return NO_TITLE;
  return titles.reduce((best, t) => (t.votes > best.votes ? t : best)).title;
}

// Classement + stats de fin de partie, à partir de l'historique des manches.
// players : joueurs encore présents { pid, name, initial, color, titles, voteTime }
function computePodium({ history, players, settings }) {
  const received = new Map();
  let totalVotes = 0;
  for (const h of history) {
    totalVotes += h.total;
    for (const r of h.rows) received.set(r.pid, (received.get(r.pid) ?? 0) + r.votes);
  }

  const ranking = players
    .map((p) => ({
      pid: p.pid,
      name: p.name,
      initial: p.initial,
      color: p.color,
      votes: received.get(p.pid) ?? 0,
      title: bestTitle(p.titles)
    }))
    .sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name, 'fr'))
    .map((p, i) => ({ ...p, rank: i + 1 }));

  const stats = [];

  const top = ranking[0];
  stats.push(
    top && top.votes > 0
      ? { label: 'Le plus désigné', value: top.name, detail: `${plural(top.votes, 'vote')} sur ${totalVotes}`, color: '#5EE6C5' }
      : { label: 'Le plus désigné', value: 'Personne', detail: 'Aucun vote cette partie', color: '#5EE6C5' }
  );

  // Vote le plus serré : le plus petit écart entre les deux premiers (chacun au moins un vote).
  let closest = null;
  for (const h of history) {
    const [a, b] = [...h.rows].sort((x, y) => y.votes - x.votes);
    if (!a || !b || b.votes === 0) continue;
    const gap = a.votes - b.votes;
    if (!closest || gap < closest.gap || (gap === closest.gap && b.votes > closest.b.votes)) closest = { h, a, b, gap };
  }
  stats.push(
    closest
      ? {
          label: 'Vote le plus serré',
          value: `Manche ${closest.h.n}`,
          detail: `${closest.a.votes} contre ${closest.b.votes} entre ${closest.a.name} et ${closest.b.name}`,
          color: '#FF7A59'
        }
      : { label: 'Vote le plus serré', value: 'Aucun', detail: 'Que des votes sans appel', color: '#FF7A59' }
  );

  let fastest = null;
  for (const p of players) {
    if (!p.voteTime.count) continue;
    const avg = p.voteTime.sum / p.voteTime.count;
    if (!fastest || avg < fastest.avg) fastest = { p, avg };
  }
  stats.push(
    fastest
      ? { label: 'Le plus rapide', value: fastest.p.name, detail: `${seconds(fastest.avg)} s en moyenne pour voter`, color: '#8FB8FF' }
      : { label: 'Le plus rapide', value: 'Personne', detail: 'Aucun vote enregistré', color: '#8FB8FF' }
  );

  let biggest = null;
  for (const h of history) {
    for (const r of REACTIONS) {
      const c = h.reactions[r.key] ?? 0;
      if (c > 0 && (!biggest || c > biggest.c)) biggest = { h, r, c };
    }
  }
  stats.push(
    biggest
      ? {
          label: 'Plus grosse réaction',
          value: `${biggest.c} × ${biggest.r.label}`,
          detail: `Manche ${biggest.h.n}, « ${shortQuestion(biggest.h.text)} »`,
          color: '#FFD23F'
        }
      : { label: 'Plus grosse réaction', value: 'Aucune', detail: 'Personne n’a réagi', color: '#FFD23F' }
  );

  // Récapitulatif « qui a voté pour qui » : seulement si le vote n'était pas anonyme.
  const reveal =
    settings.reveal && !settings.anon
      ? history.map((h) => ({ n: h.n, text: h.text, pairs: h.pairs ?? [] }))
      : null;

  return {
    rounds: history.length,
    podium: ranking.slice(0, 3),
    others: ranking.slice(3),
    stats,
    reveal
  };
}

module.exports = { REACTIONS, REACTION_KEYS, NO_TITLE, computePodium };
