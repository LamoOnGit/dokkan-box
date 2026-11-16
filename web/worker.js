import { optimize, watchlist, setLinkEffects, setMeta, teamsWithCard, slimTeam, analyzeTeam } from './engine.js';

self.onmessage = (e) => {
  const { id, kind, cards, box, options, links } = e.data;
  if (links) setLinkEffects(links);
  if (e.data.tiers) setMeta(e.data.tiers);
  const progress = (p) => self.postMessage({ id, progress: p });
  try {
    if (kind === 'optimize') {
      const teams = optimize(cards, box, { ...options, onProgress: progress });
      self.postMessage({ id, result: teams.map(slimTeam) });
    } else if (kind === 'analyze') {
      const r = analyzeTeam(cards, box, options.leader, options.members);
      self.postMessage({ id, result: r && { team: slimTeam(r.team), upgrades: r.upgrades, leaders: r.leaders } });
    } else if (kind === 'fit') {
      const r = teamsWithCard(cards, box, options.cardId);
      self.postMessage({ id, result: { best: r.best, owned: r.owned, teams: r.teams.map((t) => ({ ...slimTeam(t), gain: t.gain })) } });
    } else if (kind === 'watch') {
      const top = optimize(cards, box, { limit: 5 });
      const w = watchlist(cards, box, top, { onProgress: progress });
      self.postMessage({
        id,
        result: {
          baseTeams: top.map(slimTeam),
          upgrades: w.upgrades.map((g) => ({
            id: g.card.id, value: g.value,
            teams: g.teams.map((t) => ({ leader: t.leader.id, replaced: t.replaced?.id, pct: t.pct })),
          })),
          leaders: w.leaders.map((l) => ({ id: l.card.id, pct: l.pct, team: slimTeam(l.team) })),
        },
      });
    }
  } catch (err) {
    self.postMessage({ id, error: String(err && err.stack || err) });
  }
};

