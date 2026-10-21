/* Petits jingles en Web Audio (aucun fichier son) et vibrations.
   Les deux suivent les réglages de l'hôte : FX.sound / FX.vibe. */
(function () {
  'use strict';

  const FX = { sound: true, vibe: true, ctx: null };

  // Les navigateurs n'autorisent l'audio qu'après un geste de l'utilisateur.
  FX.unlock = function () {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!FX.ctx) FX.ctx = new AC();
    if (FX.ctx.state === 'suspended') FX.ctx.resume();
  };
  for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, FX.unlock, { passive: true });

  function note(freq, at, dur, opts) {
    const o = opts || {};
    const ctx = FX.ctx;
    const t = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = o.type || 'triangle';
    osc.frequency.setValueAtTime(freq, t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(o.gain || 0.16, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  const SONGS = {
    // Nouvelle question : petit arpège montant.
    question() {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => note(f, i * 0.08, 0.22));
    },
    // Révélation : roulement puis accord.
    reveal() {
      for (let i = 0; i < 8; i++) note(180 + i * 12, i * 0.045, 0.05, { type: 'square', gain: 0.05 });
      [392, 493.88, 587.33, 783.99].forEach((f) => note(f, 0.4, 0.6, { gain: 0.1 }));
    },
    // Réaction reçue : petit « pop ».
    pop() {
      note(660, 0, 0.09, { type: 'sine', to: 1320, gain: 0.07 });
    },
    // Dernières secondes.
    tick() {
      note(1200, 0, 0.05, { type: 'sine', gain: 0.06 });
    },
    // Fin de partie.
    podium() {
      [523.25, 659.25, 783.99].forEach((f, i) => note(f, i * 0.14, 0.18));
      [523.25, 659.25, 783.99, 1046.5].forEach((f) => note(f, 0.5, 0.9, { gain: 0.08 }));
    }
  };

  FX.play = function (name) {
    if (!FX.sound || !FX.ctx || FX.ctx.state !== 'running' || !SONGS[name]) return;
    try {
      SONGS[name]();
    } catch (e) {
      /* son indisponible : on ignore */
    }
  };

  FX.vibrate = function (pattern) {
    if (FX.vibe && navigator.vibrate) navigator.vibrate(pattern);
  };

  window.FX = FX;
})();
