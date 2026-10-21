'use strict';

// Tout ce qui vient d'un client passe par ici avant d'être stocké ou diffusé.
// Le front affiche le texte avec textContent : on retire en plus < et > pour
// qu'aucun fragment HTML ne circule, même dans la base.

const NAME_MAX = 16;
const QUESTION_MIN = 5;
const QUESTION_MAX = 120;
const NBSP = String.fromCharCode(0xa0);

// Caractères de contrôle et invisibles (espaces de largeur nulle, marques de direction…).
const INVISIBLES = new RegExp(
  '[' +
    [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff]]
      .map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b))
      .join('') +
    ']',
  'g'
);

function baseClean(raw) {
  return String(raw ?? '')
    .normalize('NFC')
    .replace(INVISIBLES, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanName(raw) {
  const name = Array.from(baseClean(raw)).slice(0, NAME_MAX).join('').trim();
  return name.length ? name : null;
}

// Clé de comparaison d'un pseudo : insensible à la casse et aux accents.
function nameKey(name) {
  return String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

// Le joueur écrit la fin de la phrase « Qui est le plus susceptible de… ».
// On tolère qu'il recopie le début ou les points de suspension.
function cleanQuestion(raw) {
  let text = baseClean(raw)
    .replace(/^qui est (le|la) plus susceptible (de|d['’])\s*/i, '')
    .replace(/^(…|\.{2,})\s*/, '')
    .replace(/[\s?!.]+$/, '')
    .trim();
  if (Array.from(text).length < QUESTION_MIN) return null;
  if (Array.from(text).length > QUESTION_MAX) return null;
  return text + NBSP + '?';
}

function cleanCode(raw) {
  const code = String(raw ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  return code.length === 4 ? code : null;
}

function isToken(raw) {
  return typeof raw === 'string' && /^[0-9a-f-]{36}$/.test(raw);
}

module.exports = { cleanName, nameKey, cleanQuestion, cleanCode, isToken, NAME_MAX, QUESTION_MAX };
