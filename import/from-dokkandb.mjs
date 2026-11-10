#!/usr/bin/env node
// Import rapide : récupère la base de cartes publique DokkanDB (données de dokkan.fyi, mise à jour toutes les 3 h)
// et la convertit au format de l'app. Aucun accès au wiki nécessaire.
// Usage : node from-dokkandb.mjs [fichier-local.json]

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLeaderSkill } from './parse-card.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = 'https://raw.githubusercontent.com/waltz4replica/dokkandb/main/data/cards.json';
const SRC_EXTRA = 'https://raw.githubusercontent.com/waltz4replica/dokkandb/main/data/extra.json';
const OUT_EXTRA = path.join(HERE, '..', 'web', 'data', 'extra.json');
const OUT = path.join(HERE, '..', 'web', 'data', 'cards.json');

// Le potentiel caché n'est pas dans la source : on l'estime (≈ +5 000 par stat au potentiel 100 %)
const POTENTIAL_BONUS = { hp: 5000, atk: 5000, def: 5000 };

const decode = (s) => String(s || '')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

async function load(url = SRC, local = process.argv[2]) {
  if (local) return JSON.parse(await readFile(local, 'utf8'));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Téléchargement impossible (HTTP ${res.status})`);
  return res.json();
}

const src = await load();
const today = new Date().toISOString().slice(0, 10);
const cards = [];
for (const c of src.cards) {
  if (c.rarity !== 'LR' && c.rarity !== 'UR') continue;
  if (!c.dates?.glb) continue; // Global seulement
  const ls = decode(c.leader?.seza || c.leader?.eza || c.leader?.base || '');
  const stats = {};
  for (const k of ['hp', 'atk', 'def']) {
    const [base, max] = c.stats?.[k] || [0, 0];
    stats[k] = { base, max, locked: max, released: max + POTENTIAL_BONUS[k] };
  }
  cards.push({
    id: c.id,
    page: `${c.title} ${c.name}`,
    title: decode(c.title),
    name: decode(c.name),
    rarity: c.rarity,
    type: c.type,
    class: c.cls || 'Super',
    maxLv: c.maxLevel,
    saMax: c.rarity === 'LR' ? 20 : (c.eza || c.seza ? 15 : 10),
    leaderSkill: ls,
    leader: parseLeaderSkill(ls),
    links: c.links || [],
    categories: c.categories || [],
    stats,
    global: true,
    globalDate: c.dates.glb,
    upcoming: c.dates.glb > today,
    eza: Boolean(c.eza || c.seza),
    ezaDate: c.dates?.glbSeza || c.dates?.glbEza || null,
    ezaKind: c.dates?.glbSeza ? 'SEZA' : c.dates?.glbEza ? 'EZA' : null,
    thumb: c.image || null,
    source: c.source || null,
  });
}

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({
  source: 'DokkanDB (github.com/waltz4replica/dokkandb), données de dokkan.fyi',
  generatedAt: new Date().toISOString(),
  sourceGeneratedAt: src.generated,
  server: 'global',
  count: cards.length,
  linkEffects: src.links || {},
  cards,
}));
const noLs = cards.filter((c) => !c.leader.length).length;
console.log(`${cards.length} cartes LR/UR Global écrites dans ${path.relative(process.cwd(), OUT)} (${noLs} sans leader skill exploitable)`);

// Actualités : bannières en cours, nouvelles du jeu, tier list (même source)
try {
  const x = await load(SRC_EXTRA, process.argv[3]);
  const ids = new Set(cards.map((k) => k.id));
  // Les bannières listent les cartes avant éveil : on remonte vers la LR/UR finale via « awakensFrom »
  const rev = new Map();
  for (const k of src.cards) for (const a of k.awakensFrom || []) { if (!rev.has(a)) rev.set(a, []); rev.get(a).push(k.id); }
  const finals = (id, seen = new Set()) => {
    if (seen.has(id)) return []; seen.add(id);
    const out = ids.has(id) ? [id] : [];
    for (const n of rev.get(id) || []) out.push(...finals(n, seen));
    return out;
  };
  const mapIds = (list) => [...new Set((list || []).flatMap((id) => finals(id)))];
  const extra = {
    generatedAt: x.generated || null,
    summons: (x.summons?.items || []).map((s) => ({
      name: decode(s.name), start: s.start, end: s.end, url: s.url || null, image: s.image || null,
      cards: mapIds(s.cards),
    })).filter((s) => s.cards.length && (!s.end || s.end < '2030'))
      .filter((s, i, arr) => arr.findIndex((o) => o.name === s.name) === i),
    news: (x.news?.items || []).slice(0, 15).map((n) => ({ title: decode(n.title), url: n.url, date: n.iso || n.date, tags: n.tags || [], image: n.image || null })),
    tierlist: (x.tierlist?.tiers || []).map((t) => ({ tier: t.tier, ranks: t.ranks, cards: (t.units || []).map((u) => u.cardId).filter((id) => ids.has(id)) })),
  };
  await writeFile(OUT_EXTRA, JSON.stringify(extra));
  console.log(`Actualités : ${extra.summons.length} bannières, ${extra.news.length} nouvelles, tier list ${extra.tierlist.length} rangs`);
} catch (e) {
  console.log('Actualités non mises à jour :', e.message);
}
