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
const OUT = path.join(HERE, '..', 'web', 'data', 'cards.json');

// Le potentiel caché n'est pas dans la source : on l'estime (≈ +5 000 par stat au potentiel 100 %)
const POTENTIAL_BONUS = { hp: 5000, atk: 5000, def: 5000 };

const decode = (s) => String(s || '')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

async function load() {
  const local = process.argv[2];
  if (local) return JSON.parse(await readFile(local, 'utf8'));
  const res = await fetch(SRC);
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
  cards,
}));
const noLs = cards.filter((c) => !c.leader.length).length;
console.log(`${cards.length} cartes LR/UR Global écrites dans ${path.relative(process.cwd(), OUT)} (${noLs} sans leader skill exploitable)`);
