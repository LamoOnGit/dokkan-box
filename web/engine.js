// Moteur d'optimisation : calcul de la puissance des cartes, du boost de leader,
// des liens partagés, et recherche de la meilleure équipe pour un leader.
// Tout est heuristique : c'est un score comparatif, pas une simulation de combat.

export const TEAM_SIZE = 5; // + leader + ami = 7

// Part du potentiel débloqué selon le nombre de doublons (0 à 4+), si le joueur n'a pas indiqué son potentiel
const POTENTIAL = [0.4, 0.6, 0.75, 0.9, 1.0];
export function potentialOf(own = DEFAULT_OWN) {
  if (own.pot != null && own.pot !== '') return Math.max(0, Math.min(100, Number(own.pot))) / 100;
  return POTENTIAL[Math.min(Math.max(0, (own.count || 1) - 1), 4)];
}

export const DEFAULT_OWN = { count: 1, linkLv: 1, saLv: 1 };
// Hypothèse pour une carte qu'on n'a pas encore (À surveiller) : fraîchement tirée
export const FRESH_OWN = { count: 1, linkLv: 5, saLv: 1 };
// Hypothèse pour la carte de l'ami : investie au maximum
export const FRIEND_OWN = { count: 5, linkLv: 10, saLv: 99 };

function stat(s, pf) {
  if (!s) return 0;
  const lo = s.locked ?? s.max ?? 0;
  const hi = s.released ?? lo;
  return lo + (hi - lo) * pf;
}

// ---- Force méta ----
// Les stats seules ne disent pas tout : le passif fait l'essentiel de la force d'une carte.
// On l'estime avec la tier list du moment (si la carte y est) et, sinon, avec sa date de sortie / d'EZA
// (les cartes récentes ont des passifs bien plus forts).
const TIER_FACTOR = { 'S++': 1.9, 'S+': 1.8, 'S': 1.7, 'S-': 1.6, 'A+': 1.5, 'A': 1.43, 'A-': 1.37, 'B+': 1.31, 'B': 1.26, 'B-': 1.22 };
let TIERS = {};           // id -> tier
let TODAY = Date.now();

export function setMeta(tierlist) {
  TIERS = {};
  for (const t of tierlist || []) for (const id of t.cards || []) if (!TIERS[id]) TIERS[id] = t.tier;
}

export function tierOf(card) { return TIERS[card.id] || null; }

// Effet du passif sur l'attaque et sur la défense (racine carrée pour ne pas écraser leader et liens)
export function passiveMult(card) {
  const f = card.pfx;
  if (!f) return { off: 1.5, def: 1.5 };
  const off = (1 + f.atk / 100) * (1 + 0.6 * f.addSA) * (1 + 0.5 * f.crit / 100) * (1 + 0.03 * f.ki);
  const def = (1 + f.def / 100) / (1 - 0.8 * f.dr / 100) * (1 + 0.8 * f.evade / 100) * (1 + 0.4 * f.guard);
  return { off: Math.sqrt(off), def: Math.sqrt(def) };
}

// Bonus méta : la tier list du moment donne un vrai bonus ; une carte hors tier list perd un peu
// selon l'ancienneté de sa sortie ou de sa dernière EZA (les anciennes cartes non réveillées sont dépassées)
export function freshYears(card) {
  const rel = card.globalDate ? Date.parse(card.globalDate) : 0;
  const eza = card.ezaDate ? Date.parse(card.ezaDate) : 0;
  const fresh = Math.max(rel, eza);
  return fresh ? Math.max(0, (TODAY - fresh) / (365 * 864e5)) : 8;
}
export function isMeta(card) {
  return Boolean(TIERS[card.id]) || freshYears(card) <= 1;
}
export function metaFactor(card) {
  const tier = TIER_FACTOR[TIERS[card.id]];
  if (tier) return 1 + 0.6 * (tier - 1);
  return Math.max(0.75, 1 - 0.05 * freshYears(card));
}

// Stats pures (affichage)
export function statPower(card, own = DEFAULT_OWN) {
  const pf = potentialOf(own);
  const st = card.stats || {};
  let p = stat(st.atk, pf) * 1.0 + stat(st.def, pf) * 0.7 + stat(st.hp, pf) * 0.25;
  if (!p) p = card.rarity === 'LR' ? 30000 : 24000;
  return p;
}

export function power(card, own = DEFAULT_OWN) {
  const pf = potentialOf(own);
  const st = card.stats || {};
  const pm = passiveMult(card);
  let p = stat(st.atk, pf) * pm.off + stat(st.def, pf) * 0.7 * pm.def + stat(st.hp, pf) * 0.25;
  if (!p) p = (card.rarity === 'LR' ? 30000 : 24000) * 1.5; // stats absentes : valeur par défaut
  const saMax = card.saMax || 10;
  const sa = Math.min(own.saLv || 1, saMax);
  p *= 1 + 0.15 * (saMax > 1 ? (sa - 1) / (saMax - 1) : 0);
  p *= metaFactor(card);
  return p / 1000;
}

// Niveau d'un lien précis (réglé lien par lien, sinon le niveau moyen de la carte)
export function linkLevel(own, name) {
  const v = own?.links?.[name];
  return Math.min(10, Math.max(1, v != null ? v : (own?.linkLv || 1)));
}
const lvFactor = (lv) => 0.6 + 0.04 * lv;

// Valeur des liens partagés par deux cartes, selon le niveau de chaque lien chez chacune
export function pairLinkValue(a, b) {
  let v = 0;
  for (const l of a.card.links) {
    if (!b.card.links.includes(l)) continue;
    v += linkValue(l) * (lvFactor(linkLevel(a.own, l)) + lvFactor(linkLevel(b.own, l))) / 2;
  }
  return v;
}

export function linkFactor(own = DEFAULT_OWN) {
  return 0.6 + 0.04 * Math.min(10, Math.max(1, own.linkLv || 1));
}

function clauseMatches(cl, card) {
  if (cl.allTypes) return true;
  if (cl.cats.some((c) => card.categories.includes(c))) return true;
  if (cl.classes.some((k) => k === card.class) && !cl.types.length) return true;
  if (cl.types.some((t) => t.type === card.type && (!t.cls || t.cls === card.class))) return true;
  return false;
}

// Pourquoi une carte est boostée : la catégorie (ou le type) qui la fait entrer dans le leader skill
export function boostReason(leaderCard, card) {
  let best = null;
  for (const cl of leaderCard.leader || []) {
    if (!clauseMatches(cl, card)) continue;
    if (best && best.pct >= cl.pct) continue;
    let why = cl.cats.find((c) => card.categories.includes(c));
    if (!why && cl.allTypes) why = 'Tous types';
    if (!why) { const t = cl.types.find((x) => x.type === card.type); if (t) why = `${t.cls ? t.cls + ' ' : ''}${t.type}`; }
    if (!why && cl.classes.length) why = `Classe ${cl.classes[0]}`;
    best = { pct: cl.pct, why };
  }
  return best;
}

export function leaderBoost(leaderCard, card) {
  let best = 0;
  for (const cl of leaderCard.leader || []) if (clauseMatches(cl, card)) best = Math.max(best, cl.pct);
  return best;
}

export function leaderMax(card) {
  return Math.max(0, ...(card.leader || []).map((c) => c.pct));
}

// ---- Effets des liens (niveau 10) ----
// Chaque lien est converti en Ki / ATK % / DEF %, puis en une valeur unique.
let LINKS = {};           // nom -> { text, ki, atk, def, cond, value }
const AVG_LINK = 20;      // valeur d'un lien « moyen » (ex. ATK +20 %)

export function parseLink(text) {
  const t = String(text || '');
  const r = { text: t, ki: 0, atk: 0, def: 0, enemyDef: 0, crit: 0, evade: 0, cond: 1 };
  let m;
  if ((m = /Ki \+(\d+)/.exec(t))) r.ki = Number(m[1]);
  for (m of t.matchAll(/(?<!enemies' )(?<!enemy's )(ATK & DEF|ATK|DEF) \+(\d+)%/g)) {
    const v = Number(m[2]);
    if (m[1] !== 'DEF') r.atk += v;
    if (m[1] !== 'ATK') r.def += v;
  }
  if ((m = /enem(?:y's|ies') DEF -(\d+)%/.exec(t))) r.enemyDef = Number(m[1]);
  if ((m = /critical hit \+(\d+)%/.exec(t))) r.crit = Number(m[1]);
  if ((m = /evading[^+]*\+(\d+)%/.exec(t))) r.evade = Number(m[1]);
  if (/when performing a Super Attack/i.test(t)) r.cond = 0.8;
  else if (/\b(when|if|while|after|against|facing|per )\b/i.test(t)) r.cond = 0.5;
  if (/Recovers/i.test(t)) r.def += 5;
  r.value = (r.ki * 8 + r.atk + r.enemyDef * 0.5 + r.crit * 1.5 + (r.def + r.evade * 2) * 0.5) * r.cond;
  return r;
}

export function setLinkEffects(map) {
  LINKS = {};
  for (const [name, text] of Object.entries(map || {})) LINKS[name] = parseLink(text);
}

export function linkValue(name) {
  return LINKS[name] ? LINKS[name].value / AVG_LINK : 1; // lien inconnu = lien moyen
}

export function sharedLinkNames(a, b) {
  if (a === b) return a.links.slice();
  return a.links.filter((l) => b.links.includes(l));
}

// Liens partagés pondérés par leur effet réel (1 = un lien moyen)
export function sharedLinks(a, b) {
  let v = 0;
  for (const l of sharedLinkNames(a, b)) v += linkValue(l);
  return v;
}

// Total des bonus des liens partagés (affichage)
export function linkTotals(names) {
  const t = { ki: 0, atk: 0, def: 0, cond: 0 };
  for (const n of names) {
    const l = LINKS[n]; if (!l) continue;
    t.ki += l.ki; t.atk += l.atk; t.def += l.def;
    if (l.cond < 1) t.cond++;
  }
  return t;
}

// Meilleures 2 rotations (2 paires disjointes) parmi les membres
function bestRotations(units) {
  const n = units.length;
  const m = [];
  for (let i = 0; i < n; i++) {
    m[i] = [];
    for (let j = 0; j < n; j++) {
      m[i][j] = i === j ? 0 : pairLinkValue(units[i], units[j]);
    }
  }
  let best = { v: -1, pairs: [] };
  // Comme dans le jeu : place 1 = leader (rotation 1 avec la place 2), place 7 = ami (toujours flottant)
  if (units[0]?.role === 'leader' && units[1]?.role === 'ami' && n >= 5) {
    for (let p = 2; p < n; p++) {
      for (let c = 2; c < n; c++) {
        if (c === p) continue;
        for (let d = c + 1; d < n; d++) {
          if (d === p) continue;
          const v = m[0][p] + m[c][d];
          if (v > best.v) best = { v, pairs: [[0, p], [c, d]] };
        }
      }
    }
    return { ...best, matrix: m };
  }
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
    for (let c = a + 1; c < n; c++) {
      if (c === b) continue;
      for (let d = c + 1; d < n; d++) {
        if (d === b) continue;
        const v = m[a][b] + m[c][d];
        if (v > best.v) best = { v, pairs: [[a, b], [c, d]] };
      }
    }
  }
  return { ...best, matrix: m };
}

// Poids des liens : 1 lien « moyen » partagé (ex. ATK +20 %) ≈ +8 % d'efficacité
export const LINK_WEIGHT = 0.08;
// En dessous de cette affinité (≈ 2 liens moyens partagés en moyenne avec chaque coéquipier), la carte est jugée isolée
const ISO_MIN = 1.6;

export function scoreTeam(units, pairs = null) {
  // units : [{card, own, pw, boost, lf, role}] ; pairs : rotations imposées [[i, j], [k, l]] (sinon les meilleures)
  const rot = bestRotations(units);
  if (pairs) rot.pairs = pairs;
  const inRot = new Map();
  rot.pairs.forEach(([x, y]) => { inRot.set(x, y); inRot.set(y, x); });
  const n = units.length;
  const avgWith = (i) => {
    let s = 0; let k = 0;
    for (let j = 0; j < n; j++) if (j !== i) { s += rot.matrix[i][j]; k++; }
    return k ? s / k : 0;
  };
  let total = 0;
  const supportTotal = units.filter((u) => u.role !== 'ami').reduce((s, u) => s + (u.card.pfx?.support || 0), 0);
  const detail = units.map((u, i) => {
    // Affinité : liens partagés (pondérés par leur effet et leur niveau) avec ses voisins réels
    // En rotation : surtout avec son partenaire, un peu avec le flottant qui le rejoint.
    // Flottant : il tourne, donc la moyenne avec toute l'équipe.
    const affinity = avgWith(i);
    const lb = inRot.has(i) ? 0.75 * rot.matrix[i][inRot.get(i)] + 0.25 * affinity : affinity;
    // Soutien des coéquipiers (passifs qui boostent les alliés), plafonné
    const sup = Math.min(0.4, 0.002 * (supportTotal - (u.card.pfx?.support || 0)));
    // Carte isolée (presque aucun lien partagé avec l'équipe) : en jeu elle tape bien moins fort
    // et casse les liens de ses voisins → forte pénalité, pour qu'une carte bien liée passe devant
    const iso = u.role === 'ami' ? 1 : affinity >= ISO_MIN ? 1 : 0.6 + 0.4 * (affinity / ISO_MIN);
    const eff = u.pw * (1 + u.boost / 100) * (1 + LINK_WEIGHT * lb) * (1 + Math.max(0, sup)) * iso;
    total += eff;
    return { ...u, eff, linkBonus: lb, affinity };
  });
  const types = new Set(units.map((u) => u.card.type));
  total *= 1 + 0.01 * (types.size - 1); // petit bonus de couverture de types
  return { score: total, rotations: rot.pairs, units: detail };
}

function* combinations(arr, k, start = 0, acc = []) {
  if (acc.length === k) { yield acc; return; }
  for (let i = start; i <= arr.length - (k - acc.length); i++) {
    acc.push(arr[i]);
    yield* combinations(arr, k, i + 1, acc);
    acc.pop();
  }
}

// Amis à choisir en priorité : leaders du jeu qui boostent le plus de cartes de la team, et le plus fort
// (le score de la team ne compte que TON leader ; l'ami est un conseil à part)
export function recommendFriends(team, allLeaders, n = 3) {
  const cards = team.units.filter((u) => u.role !== 'ami').map((u) => u.card);
  const out = [];
  for (const F of allLeaders) {
    let covered = 0; let pct = 0;
    for (const c of cards) { const b = leaderBoost(F, c); if (b > 0) { covered++; pct = Math.max(pct, b); } }
    if (!covered) continue;
    const via = boostReason(F, cards.find((c) => leaderBoost(F, c) > 0) || cards[0]);
    out.push({ card: F, covered, total: cards.length, pct, via: via?.why || null, value: covered * 1000 + pct });
  }
  out.sort((a, b) => b.value - a.value);
  // un seul conseil par nom de personnage
  const seen = new Set();
  return out.filter((f) => (seen.has(f.card.name) ? false : seen.add(f.card.name))).slice(0, n);
}

// pool : [{card, own}] ; leader : {card, own}
export function bestTeamForLeader(leader, pool, { candidates = 12, force = null } = {}) {
  const L = leader.card;
  const mk = (card, own, role) => {
    const r = boostReason(L, card);
    return {
      card, own, role, pw: power(card, own), boost: r ? r.pct : 0, lf: linkFactor(own), via: r ? r.why : null,
    };
  };
  const leadU = mk(L, leader.own, 'leader');
  const friendU = mk(L, FRIEND_OWN, 'ami'); // place de l'ami : comptée comme un leader équivalent

  // Une carte par nom de personnage (règle du jeu), hors nom du leader
  const byName = new Map();
  for (const p of pool) {
    if (p.card.id === L.id || p.card.name === L.name) continue;
    const u = mk(p.card, p.own, 'membre');
    u.pre = u.pw * (1 + u.boost / 100) * (1 + 0.02 * sharedLinks(L, p.card));
    const prev = byName.get(p.card.name);
    if (!prev || prev.pre < u.pre) byName.set(p.card.name, u);
  }
  // Carte imposée (onglet Actu / fiche carte) : elle est toujours dans la team
  let forced = null;
  if (force && force !== L.id) {
    const fp = pool.find((p) => p.card.id === force);
    if (fp && fp.card.name !== L.name) { forced = mk(fp.card, fp.own, 'membre'); byName.delete(fp.card.name); }
  }
  // Pré-sélection en deux temps :
  // 1) on garde les cartes qui RENTRENT dans la team : boostées par le leader ET bien liées au reste des cartes boostées
  //    (affinité calculée sur les liens seulement, sans regarder la force, pour ne pas favoriser les cartes méta isolées)
  // 2) parmi elles, on prend les plus fortes (stats + passif + tier list)
  const pool0 = [...byName.values()].filter((u) => u.boost > 0);
  for (const u of byName.values()) {
    const others = pool0.filter((v) => v !== u).map((v) => sharedLinks(u.card, v.card)).sort((a, b) => b - a).slice(0, 4);
    u.aff = others.length ? others.reduce((s, x) => s + x, 0) / others.length : 0;
    u.lead = sharedLinks(L, u.card);
    u.pre = u.pw * (1 + u.boost / 100);
  }
  const size = forced ? TEAM_SIZE - 1 : TEAM_SIZE;
  const byPower = (a, b) => b.pre - a.pre;
  const fits = pool0.filter((u) => u.aff >= ISO_MIN).sort(byPower);
  const loose = pool0.filter((u) => u.aff < ISO_MIN).sort((a, b) => b.aff * b.pre - a.aff * a.pre);
  let cand = fits.slice(0, candidates);
  if (cand.length < size + 2) cand = cand.concat(loose.slice(0, size + 2 - cand.length));
  if (cand.length < size) cand = cand.concat([...byName.values()].filter((u) => u.boost === 0).sort(byPower).slice(0, size - cand.length));
  if (!cand.length && !forced) return null;
  const k = Math.min(size, cand.length);

  let best = null;
  for (const combo of combinations(cand, k)) {
    const res = scoreTeam([leadU, friendU, ...(forced ? [forced] : []), ...combo]);
    if (!best || res.score > best.score) best = res;
  }
  best.leader = L;
  best.boostedCount = best.units.filter((u) => u.role === 'membre' && u.boost > 0).length;
  return best;
}

export function ownedPool(cards, box) {
  const out = [];
  for (const c of cards) {
    const own = box[c.id];
    if (own && own.count > 0) out.push({ card: c, own });
  }
  return out;
}

// Optimiseur : meilleures équipes avec la box
export function optimize(cards, box, { focusCategory = null, focusClass = null, metaOnly = false, limit = 10, onProgress } = {}) {
  let pool = ownedPool(cards, box);
  if (metaOnly) pool = pool.filter((p) => isMeta(p.card));
  if (focusClass) pool = pool.filter((p) => p.card.class === focusClass);
  let leaders = pool.filter((p) => leaderMax(p.card) > 0);
  if (focusCategory) leaders = leaders.filter((p) => p.card.leader.some((cl) => cl.cats.includes(focusCategory)));
  const teams = [];
  leaders.forEach((l, i) => {
    let usable = pool;
    if (focusCategory) usable = pool.filter((p) => p.card.categories.includes(focusCategory));
    const t = bestTeamForLeader(l, usable);
    if (t) teams.push(t);
    if (onProgress && i % 10 === 0) onProgress(i / leaders.length);
  });
  teams.sort((a, b) => b.score - a.score);
  // Une seule équipe par nom de leader dans le classement
  const seen = new Set();
  const top = teams.filter((t) => (seen.has(t.leader.name + t.leader.leaderSkill) ? false : seen.add(t.leader.name + t.leader.leaderSkill))).slice(0, limit);
  const allLeaders = cards.filter((c) => leaderMax(c) >= 100);
  for (const t of top) t.friends = recommendFriends(t, allLeaders);
  return top;
}

// ---------- Équipes : format léger (pour l'app) ----------
export function slimTeam(t) {
  return {
    score: t.score,
    leader: t.leader.id,
    friends: (t.friends || []).map((f) => ({ id: f.card.id, covered: f.covered, total: f.total, pct: f.pct, via: f.via })),
    boostedCount: t.boostedCount,
    tips: investTips(t),
    rotations: t.rotations,
    units: t.units.map((u) => ({ id: u.card.id, role: u.role, boost: u.boost, via: u.via, affinity: u.affinity, eff: u.eff, linkBonus: u.linkBonus, own: u.role === 'ami' ? null : u.own })),
  };
}

export const MAX_OWN = { count: 5, linkLv: 10, saLv: 99, pot: 100 };

function unit(L, card, own, role) {
  const r = boostReason(L, card);
  return { card, own, role, pw: power(card, own), boost: r ? r.pct : 0, lf: linkFactor(own), via: r ? r.why : null };
}

// Meilleures teams du jeu : toutes les cartes, investies au max. Une team par catégorie principale.
export function topGameTeams(cards, { limit = 15, onProgress } = {}) {
  const box = {};
  for (const c of cards) box[c.id] = MAX_OWN;
  const leaders = cards.filter((c) => leaderMax(c) >= 150);
  const pool = ownedPool(cards, box);
  const teams = [];
  leaders.forEach((L, i) => {
    const t = bestTeamForLeader({ card: L, own: MAX_OWN }, pool, { candidates: 11 });
    if (t) teams.push(t);
    if (onProgress && i % 20 === 0) onProgress(i / leaders.length);
  });
  teams.sort((a, b) => b.score - a.score);
  const seen = new Set(); const out = [];
  const allLeaders = cards.filter((c) => leaderMax(c) >= 100);
  for (const t of teams) {
    const vias = t.units.filter((u) => u.role === 'membre' && u.via).map((u) => u.via);
    const main = vias.sort((a, b) => vias.filter((x) => x === b).length - vias.filter((x) => x === a).length)[0] || t.leader.name;
    if (seen.has(main) || seen.has('L:' + t.leader.name)) continue;
    seen.add(main); seen.add('L:' + t.leader.name);
    t.category = main;
    t.friends = recommendFriends(t, allLeaders);
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

// Analyse d'une team créée à la main : rotations, conseils, cartes et leaders à aller chercher
export function analyzeTeam(cards, box, leaderId, memberIds, userPairs = null) {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const L = byId.get(leaderId);
  if (!L) return null;
  const ownOf = (c) => (box[c.id]?.count > 0 ? box[c.id] : FRESH_OWN);
  const members = memberIds.map((id) => byId.get(id)).filter(Boolean);
  const units = [unit(L, L, ownOf(L), 'leader'), unit(L, L, FRIEND_OWN, 'ami'), ...members.map((c) => unit(L, c, ownOf(c), 'membre'))];
  // Rotations choisies par le joueur (indices dans units), sinon les meilleures
  const okPairs = Array.isArray(userPairs) && userPairs.length === 2
    && userPairs.every((p) => p.length === 2 && p.every((i) => i >= 0 && i < units.length))
    && new Set(userPairs.flat()).size === 4;
  const best = scoreTeam(units);
  const team = okPairs ? scoreTeam(units, userPairs) : best;
  team.leader = L;
  team.boostedCount = team.units.filter((u) => u.role === 'membre' && u.boost > 0).length;
  const allLeaders = cards.filter((c) => leaderMax(c) >= 100);
  team.friends = recommendFriends(team, allLeaders);
  team.bestPairs = best.rotations;
  team.bestScore = best.score;
  team.userPairs = okPairs;
  const base = team.score;
  const names = new Set([L.name, ...members.map((c) => c.name)]);

  // Cartes à aller chercher : remplacer un membre (ou compléter une place libre)
  const cands = cards.filter((c) => !names.has(c.name) && leaderBoost(L, c) > 0)
    .map((c) => ({ c, u: unit(L, c, ownOf(c), 'membre') }))
    .sort((a, b) => b.u.pw * (1 + b.u.boost / 100) - a.u.pw * (1 + a.u.boost / 100)).slice(0, 160);
  const head = units.slice(0, 2); const mem = units.slice(2);
  const ups = [];
  for (const { c, u } of cands) {
    let best = { delta: 0, replaced: null };
    if (mem.length < TEAM_SIZE) {
      const s = scoreTeam([...head, ...mem, u]).score;
      best = { delta: s - base, replaced: null };
    }
    for (let r = 0; r < mem.length; r++) {
      const s = scoreTeam([...head, ...mem.map((m, j) => (j === r ? u : m))]).score;
      if (s - base > best.delta) best = { delta: s - base, replaced: mem[r].card.id };
    }
    if (best.delta > 0) ups.push({ id: c.id, owned: Boolean(box[c.id]?.count > 0), pct: best.delta / base * 100, replaced: best.replaced });
  }
  ups.sort((a, b) => b.pct - a.pct);

  // Leaders à aller chercher : même équipe, autre leader
  const leaders = [];
  for (const N of cards) {
    if (N.id === L.id || leaderMax(N) < 120) continue;
    const covered = members.filter((c) => leaderBoost(N, c) > 0).length;
    if (covered < Math.max(1, members.length - 1)) continue;
    const us = [unit(N, N, ownOf(N), 'leader'), unit(N, N, FRIEND_OWN, 'ami'), ...members.map((c) => unit(N, c, ownOf(c), 'membre'))];
    const s = scoreTeam(us).score;
    if (s > base * 1.01) leaders.push({ id: N.id, owned: Boolean(box[N.id]?.count > 0), pct: (s - base) / base * 100, covered, total: members.length });
  }
  leaders.sort((a, b) => b.pct - a.pct);
  const seenL = new Set();
  const leadersTop = leaders.filter((x) => { const n = byId.get(x.id).name; return seenL.has(n) ? false : seenL.add(n); }).slice(0, 6);

  return { team, upgrades: ups.slice(0, 8), leaders: leadersTop };
}

// Dans quelles teams jouer une carte (possédée ou non) : meilleures teams qui l'incluent
export function teamsWithCard(cards, box, cardId, { limit = 3 } = {}) {
  const card = cards.find((c) => c.id === cardId);
  if (!card) return { teams: [], best: 0, owned: false };
  const owned = Boolean(box[cardId]?.count > 0);
  const base = ownedPool(cards, box);
  const pool = owned ? base : base.concat([{ card, own: FRESH_OWN }]);
  const without = base.filter((p) => p.card.id !== cardId);
  const allLeaders = cards.filter((c) => leaderMax(c) >= 100);
  const leaders = pool.filter((p) => leaderMax(p.card) > 0 && (p.card.id === cardId || leaderBoost(p.card, card) > 0));
  const out = [];
  for (const l of leaders) {
    const t = bestTeamForLeader(l, pool, { force: cardId });
    if (!t || !t.units.some((u) => u.card.id === cardId)) continue;
    let gain = null;
    if (l.card.id !== cardId) {
      const ref = bestTeamForLeader(l, without);
      if (ref) gain = (t.score - ref.score) / ref.score * 100;
    }
    t.gain = gain;
    out.push(t);
  }
  out.sort((a, b) => b.score - a.score);
  const seen = new Set();
  const top = out.filter((t) => (seen.has(t.leader.name) ? false : seen.add(t.leader.name))).slice(0, limit);
  for (const t of top) t.friends = recommendFriends(t, allLeaders);
  const bestNow = optimize(cards, box, { limit: 1 })[0];
  return { teams: top, best: bestNow ? bestNow.score : 0, owned };
}

// À surveiller : cartes manquantes qui améliorent le plus tes équipes, et leaders à aller chercher
export function watchlist(cards, box, topTeams, { onProgress } = {}) {
  const pool = ownedPool(cards, box);
  const missing = cards.filter((c) => !(box[c.id] && box[c.id].count > 0));

  // A. Cartes qui renforcent tes meilleures équipes
  const gains = new Map();
  topTeams.slice(0, 5).forEach((team, ti) => {
    const L = team.units[0].card;
    const base = team.score;
    const members = team.units.slice(2);
    const teamNames = new Set(team.units.map((u) => u.card.name));
    for (const c of missing) {
      const boost = leaderBoost(L, c);
      if (boost <= 0) continue;
      const u = { card: c, own: FRESH_OWN, role: 'membre', pw: power(c, FRESH_OWN), boost, lf: linkFactor(FRESH_OWN) };
      let bestDelta = 0; let replaced = null;
      for (let r = 0; r < members.length; r++) {
        if (teamNames.has(c.name) && members[r].card.name !== c.name) continue;
        if (c.name === L.name) continue;
        const next = team.units.slice(0, 2).concat(members.map((m, j) => (j === r ? u : m)));
        const s = scoreTeam(next).score;
        if (s - base > bestDelta) { bestDelta = s - base; replaced = members[r].card; }
      }
      if (bestDelta > 0) {
        const pct = bestDelta / base * 100;
        const prev = gains.get(c.id);
        const entry = { teamIndex: ti, leader: L, replaced, delta: bestDelta, pct };
        if (!prev) gains.set(c.id, { card: c, best: entry, teams: [entry] });
        else { prev.teams.push(entry); if (entry.pct > prev.best.pct) prev.best = entry; }
      }
    }
    onProgress && onProgress((ti + 1) / 10);
  });
  const upgrades = [...gains.values()]
    .map((g) => ({ ...g, value: g.teams.reduce((s, t) => s + t.pct, 0) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 30);

  // B. Leaders manquants qui ouvriraient une meilleure équipe avec ta box
  const bestScore = topTeams[0]?.score || 0;
  const leaderCands = missing.filter((c) => leaderMax(c) >= 150);
  const newLeaders = [];
  leaderCands.forEach((c, i) => {
    const eligible = pool.filter((p) => leaderBoost(c, p.card) > 0);
    if (eligible.length < 4) return;
    const t = bestTeamForLeader({ card: c, own: FRESH_OWN }, pool, { candidates: 9 });
    if (t && t.score > bestScore * 0.97) newLeaders.push({ card: c, team: t, pct: bestScore ? (t.score - bestScore) / bestScore * 100 : 0 });
    if (onProgress && i % 20 === 0) onProgress(0.5 + 0.5 * i / leaderCands.length);
  });
  newLeaders.sort((a, b) => b.team.score - a.team.score);

  return { upgrades, leaders: newLeaders.slice(0, 15) };
}

// Où investir : gain de puissance de la team si on monte une carte d'un cran
export function investTips(team, limit = 3) {
  const base = team.score;
  const tips = [];
  team.units.forEach((u, i) => {
    if (u.role === 'ami') return;
    const own = u.own || DEFAULT_OWN;
    const saMax = u.card.saMax || 10;
    const tries = [];
    if ((own.count || 1) < 5 && (own.pot == null || own.pot === '')) tries.push({ kind: 'dupe', own: { ...own, count: (own.count || 1) + 1 } });
    if (own.pot != null && own.pot !== '' && Number(own.pot) < 100) tries.push({ kind: 'pot', own: { ...own, pot: 100 } });
    if ((own.saLv || 1) < saMax) tries.push({ kind: 'sa', own: { ...own, saLv: saMax } });
    if (u.card.links.some((l) => linkLevel(own, l) < 10)) tries.push({ kind: 'links', own: { ...own, linkLv: 10, links: {} } });
    for (const t of tries) {
      const next = team.units.map((x, j) => (j === i ? { ...x, own: t.own, pw: power(x.card, t.own), lf: linkFactor(t.own) } : x));
      const pct = (scoreTeam(next).score - base) / base * 100;
      if (pct > 0.05) tips.push({ id: u.card.id, kind: t.kind, pct, from: own, to: t.own });
    }
  });
  return tips.sort((a, b) => b.pct - a.pct).slice(0, limit);
}
