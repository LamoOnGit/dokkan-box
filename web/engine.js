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

// pool : [{card, own}] ; leader : {card, own}
// Boost total : le leader skill du leader + celui de l'ami s'additionnent
export function teamBoost(L, F, card) {
  return leaderBoost(L, card) + (F ? leaderBoost(F, card) : 0);
}

// Leaders amis possibles (n'importe quelle carte du jeu) pour un leader donné
export function friendCandidates(L, allLeaders, n = 4) {
  const cats = new Set([...L.categories, ...(L.leader || []).flatMap((cl) => cl.cats)]);
  return allLeaders
    .filter((F) => F.id !== L.id && F.leader.some((cl) => cl.cats.some((c) => cats.has(c)) || cl.allTypes))
    .sort((a, b) => leaderMax(b) - leaderMax(a))
    .slice(0, n);
}

export function bestTeamForLeader(leader, pool, { candidates = 12, friend = null } = {}) {
  const L = leader.card;
  const F = friend || L;
  const mk = (card, own, role) => ({
    card, own, role, pw: power(card, own), boost: teamBoost(L, F, card), lf: linkFactor(own),
  });
  const leadU = mk(L, leader.own, 'leader');
  const friendU = mk(F, FRIEND_OWN, 'ami');

  // Une carte par nom de personnage (règle du jeu), hors nom du leader
  const byName = new Map();
  for (const p of pool) {
    if (p.card.id === L.id || p.card.name === L.name || p.card.name === F.name) continue;
    const u = mk(p.card, p.own, 'membre');
    u.pre = u.pw * (1 + u.boost / 100) * (1 + 0.02 * sharedLinks(L, p.card));
    const prev = byName.get(p.card.name);
    if (!prev || prev.pre < u.pre) byName.set(p.card.name, u);
  }
  const ranked = [...byName.values()].sort((a, b) => b.pre - a.pre);
  const boosted = ranked.filter((u) => u.boost > 0);
  let cand = boosted.slice(0, candidates);
  if (cand.length < TEAM_SIZE) cand = cand.concat(ranked.filter((u) => u.boost === 0).slice(0, TEAM_SIZE - cand.length));
  if (!cand.length) return null;
  const k = Math.min(TEAM_SIZE, cand.length);

  let best = null;
  for (const combo of combinations(cand, k)) {
    const res = scoreTeam([leadU, friendU, ...combo]);
    if (!best || res.score > best.score) best = res;
  }
  best.leader = L;
  best.friend = F;
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
  const allLeaders = cards.filter((c) => leaderMax(c) >= 150);
  let leaders = pool.filter((p) => leaderMax(p.card) > 0);
  if (focusCategory) leaders = leaders.filter((p) => p.card.leader.some((cl) => cl.cats.includes(focusCategory)));
  const teams = [];
  leaders.forEach((l, i) => {
    let usable = pool;
    if (focusCategory) usable = pool.filter((p) => p.card.categories.includes(focusCategory));
    // On teste le leader en double (ami = même carte) et les meilleurs leaders amis compatibles
    let t = null;
    for (const F of [null, ...friendCandidates(l.card, allLeaders)]) {
      const r = bestTeamForLeader(l, usable, { friend: F, candidates: F ? 10 : 12 });
      if (r && (!t || r.score > t.score)) t = r;
    }
    if (t) teams.push(t);
    if (onProgress && i % 10 === 0) onProgress(i / leaders.length);
  });
  teams.sort((a, b) => b.score - a.score);
  // Une seule équipe par nom de leader dans le classement
  const seen = new Set();
  return teams.filter((t) => (seen.has(t.leader.name + t.leader.leaderSkill) ? false : seen.add(t.leader.name + t.leader.leaderSkill))).slice(0, limit);
}

// À surveiller : cartes manquantes qui améliorent le plus tes équipes, et leaders à aller chercher
export function watchlist(cards, box, topTeams, { onProgress } = {}) {
  const pool = ownedPool(cards, box);
  const missing = cards.filter((c) => !(box[c.id] && box[c.id].count > 0));

  // A. Cartes qui renforcent tes meilleures équipes
  const gains = new Map();
  topTeams.slice(0, 5).forEach((team, ti) => {
    const L = team.units[0].card;
    const F = team.friend || L;
    const base = team.score;
    const members = team.units.slice(2);
    const teamNames = new Set(team.units.map((u) => u.card.name));
    for (const c of missing) {
      const boost = teamBoost(L, F, c);
      if (boost <= 0) continue;
      const u = { card: c, own: FRESH_OWN, role: 'membre', pw: power(c, FRESH_OWN), boost, lf: linkFactor(FRESH_OWN) };
      let bestDelta = 0; let replaced = null;
      for (let r = 0; r < members.length; r++) {
        if (teamNames.has(c.name) && members[r].card.name !== c.name) continue;
        if (c.name === L.name || c.name === F.name) continue;
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
