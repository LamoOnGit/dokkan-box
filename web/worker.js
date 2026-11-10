import { optimize, watchlist, setLinkEffects, investTips } from './engine.js';

self.onmessage = (e) => {
  const { id, kind, cards, box, options, links } = e.data;
  if (links) setLinkEffects(links);
  const progress = (p) => self.postMessage({ id, progress: p });
  try {
    if (kind === 'optimize') {
      const teams = optimize(cards, box, { ...options, onProgress: progress });
      self.postMessage({ id, result: teams.map(slimTeam) });
    } else if (kind === 'watch') {
      const top = optimize(cards, box, { limit: 5 });
      const w = watchlist(cards, box, top, { onProgress: progress });
      self.postMessage({
        id,
        result: {
          baseTeams: top.map(slimTeam),
          upgrades: w.upgrades.map((g) => ({
            id: g.card.id, value: g.value,
            teams: g.teams.map((t) => ({ leader: t.leader.id,
    friend: t.friend ? t.friend.id : t.leader.id, replaced: t.replaced?.id, pct: t.pct })),
          })),
          leaders: w.leaders.map((l) => ({ id: l.card.id, pct: l.pct, team: slimTeam(l.team) })),
        },
      });
    }
  } catch (err) {
    self.postMessage({ id, error: String(err && err.stack || err) });
  }
};

function slimTeam(t) {
  return {
    score: t.score,
    leader: t.leader.id,
    friend: t.friend ? t.friend.id : t.leader.id,
    boostedCount: t.boostedCount,
    tips: investTips(t),
    rotations: t.rotations,
    units: t.units.map((u) => ({ id: u.card.id, role: u.role, boost: u.boost, eff: u.eff, linkBonus: u.linkBonus, own: u.role === 'ami' ? null : u.own })),
  };
}
