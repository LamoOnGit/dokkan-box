// Moteur d'optimisation : calcul de la puissance des cartes, du boost de leader,
// des liens partagés, et recherche de la meilleure équipe pour un leader.
// Tout est heuristique : c'est un score comparatif, pas une simulation de combat.

export const TEAM_SIZE = 5; // + leader + ami = 7

// Part du potentiel débloqué selon le nombre de doublons (0 à 4+)
const POTENTIAL = [0.4, 0.6, 0.75, 0.9, 1.0];

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

export function power(card, own = DEFAULT_OWN) {
  const dupes = Math.max(0, (own.count || 1) - 1);
  const pf = POTENTIAL[Math.min(dupes, 4)];
  const st = card.stats || {};
  let p = stat(st.atk, pf) * 1.0 + stat(st.def, pf) * 0.7 + stat(st.hp, pf) * 0.25;
  if (!p) p = card.rarity === 'LR' ? 30000 : 24000; // stats absentes : valeur par défaut
  const saMax = card.saMax || 10;
  const sa = Math.min(own.saLv || 1, saMax);
  p *= 1 + 0.15 * (saMax > 1 ? (sa - 1) / (saMax - 1) : 0);
  return p / 1000;
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
      m[i][j] = i === j ? 0 : sharedLinks(units[i].card, units[j].card) * (units[i].lf + units[j].lf) / 2;
    }
  }
  let best = { v: -1, pairs: [] };
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

export function scoreTeam(units) {
  // units : [{card, own, pw, boost, lf, role}]
  const rot = bestRotations(units);
  const inRot = new Map();
  rot.pairs.forEach(([x, y]) => { inRot.set(x, y); inRot.set(y, x); });
  let total = 0;
  const detail = units.map((u, i) => {
    let lb;
    if (inRot.has(i)) {
      lb = rot.matrix[i][inRot.get(i)];
    } else {
      const others = [...inRot.keys()];
      lb = others.length ? others.reduce((s, k) => s + rot.matrix[i][k], 0) / others.length * 0.5 : 0;
    }
    const eff = u.pw * (1 + u.boost / 100) * (1 + 0.03 * lb);
    total += eff;
    return { ...u, eff, linkBonus: lb };
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
  const ranked = [...byName.values()].sort((a, b) => b.pre - a.pre);
  const boosted = ranked.filter((u) => u.boost > 0);
  const size = forced ? TEAM_SIZE - 1 : TEAM_SIZE;
  let cand = boosted.slice(0, candidates);
  if (cand.length < size) cand = cand.concat(ranked.filter((u) => u.boost === 0).slice(0, size - cand.length));
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
export function optimize(cards, box, { focusCategory = null, focusClass = null, limit = 10, onProgress } = {}) {
  let pool = ownedPool(cards, box);
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
    if ((own.count || 1) < 5) tries.push({ kind: 'dupe', own: { ...own, count: (own.count || 1) + 1 } });
    if ((own.saLv || 1) < saMax) tries.push({ kind: 'sa', own: { ...own, saLv: saMax } });
    if ((own.linkLv || 1) < 10) tries.push({ kind: 'links', own: { ...own, linkLv: 10 } });
    for (const t of tries) {
      const next = team.units.map((x, j) => (j === i ? { ...x, own: t.own, pw: power(x.card, t.own), lf: linkFactor(t.own) } : x));
      const pct = (scoreTeam(next).score - base) / base * 100;
      if (pct > 0.05) tips.push({ id: u.card.id, kind: t.kind, pct, from: own, to: t.own });
    }
  });
  return tips.sort((a, b) => b.pct - a.pct).slice(0, limit);
}
