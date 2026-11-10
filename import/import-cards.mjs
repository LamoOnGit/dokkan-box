#!/usr/bin/env node
// Import de toutes les cartes LR / UR du wiki Dokkan (Fandom) via l'API MediaWiki.
// Usage :
//   node import-cards.mjs                    -> import complet vers ../web/data/cards.json
//   node import-cards.mjs --limit 30         -> test sur 30 pages
//   node import-cards.mjs --categories       -> liste les catégories du wiki qui ressemblent à des raretés
//   node import-cards.mjs --category "LR" --category "UR"   -> forcer les catégories de cartes
//   node import-cards.mjs --debug "Super Saiyan Counterstrike Super Saiyan Goku"  -> affiche le texte lu
//   node import-cards.mjs --all-servers      -> garder aussi les cartes JP uniquement
//
// Le HTML de chaque page est mis en cache dans .cache/ : relancer le script reprend là où il s'est arrêté
// et ne retélécharge que les pages nouvelles (supprime .cache/ pour tout rafraîchir).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCardPage, extractThumb, htmlToLines } from './parse-card.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = 'https://dbz-dokkanbattle.fandom.com/api.php';
const CACHE = path.join(HERE, '.cache');
const OUT = path.join(HERE, '..', 'web', 'data', 'cards.json');
const DELAY_MS = 250; // politesse envers le wiki
const UA = 'DokkanBoxOptimizer/1.0 (outil perso, import hebdomadaire)';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const optAll = (n) => args.flatMap((a, i) => (a === n ? [args[i + 1]] : []));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(params) {
  const url = `${API}?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error.info || json.error.code);
      return json;
    } catch (e) {
      if (attempt === 4) throw e;
      await sleep(1500 * attempt);
    }
  }
}

async function categoryMembers(cat) {
  const title = cat.startsWith('Category:') ? cat : `Category:${cat}`;
  const out = [];
  let cont = {};
  do {
    const j = await api({ action: 'query', list: 'categorymembers', cmtitle: title, cmlimit: '500', cmnamespace: '0', ...cont });
    out.push(...j.query.categorymembers.map((m) => m.title));
    cont = j.continue || null;
    await sleep(DELAY_MS);
  } while (cont);
  return out;
}

async function listCategories() {
  const seen = [];
  for (const prefix of ['LR', 'UR', 'TUR', 'SSR', 'Global', 'Card', 'Characters']) {
    const j = await api({ action: 'query', list: 'allcategories', acprefix: prefix, aclimit: '50', acprop: 'size' });
    for (const c of j.query.allcategories) seen.push(`${c.category}  (${c.pages ?? c.size ?? '?'} pages)`);
    await sleep(DELAY_MS);
  }
  console.log(seen.join('\n'));
}

async function fetchPageHtml(title) {
  const key = createHash('sha1').update(title).digest('hex');
  const file = path.join(CACHE, `${key}.html`);
  if (existsSync(file)) return readFile(file, 'utf8');
  const j = await api({ action: 'parse', page: title, prop: 'text', disablelimitreport: '1', disableeditsection: '1' });
  const html = j.parse.text;
  await writeFile(file, html);
  await sleep(DELAY_MS);
  return html;
}

// Secours : URL de la vignette reconstruite depuis l'identifiant (chemin MediaWiki = hash MD5 du nom de fichier)
function thumbFromId(html) {
  const m = /alt="Card (\d+) thumb"/.exec(html);
  if (!m) return null;
  const file = `Card_${m[1]}_thumb.png`;
  const h = createHash('md5').update(file).digest('hex');
  return `https://static.wikia.nocookie.net/dbz-dokkanbattle/images/${h[0]}/${h.slice(0, 2)}/${file}/revision/latest`;
}

async function main() {
  await mkdir(CACHE, { recursive: true });

  if (flag('--categories')) return listCategories();

  if (opt('--debug')) {
    const title = opt('--debug');
    const html = await fetchPageHtml(title);
    const lines = htmlToLines(html);
    console.log(lines.slice(0, 400).map((l, i) => `${String(i).padStart(3)} | ${l}`).join('\n'));
    console.log('\n--- Résultat du parseur ---');
    console.log(JSON.stringify(parseCardPage(html, title), null, 2));
    return;
  }

  // 1. Liste des pages de cartes
  const cats = optAll('--category');
  const candidates = cats.length ? cats : ['LR', 'UR'];
  const titles = new Set();
  for (const c of candidates) {
    try {
      const members = await categoryMembers(c);
      console.log(`Catégorie ${c} : ${members.length} pages`);
      members.forEach((t) => titles.add(t));
    } catch (e) {
      console.log(`Catégorie ${c} : erreur (${e.message})`);
    }
  }
  if (!titles.size) {
    console.error('\nAucune page trouvée. Lance `node import-cards.mjs --categories` pour voir les catégories du wiki,'
      + '\npuis relance avec --category "<nom>" (une option par catégorie).');
    process.exit(1);
  }

  let list = [...titles].sort();
  const limit = Number(opt('--limit') || 0);
  if (limit) list = list.slice(0, limit);

  // 2. Téléchargement + parsing
  const cards = [];
  const failures = [];
  let i = 0;
  for (const title of list) {
    i++;
    try {
      const html = await fetchPageHtml(title);
      const res = parseCardPage(html, title);
      if (!res.ok) { failures.push(`${title} : ${res.reason}`); continue; }
      const card = res.card;
      if (!card.rarity || !['LR', 'UR'].includes(card.rarity)) continue;
      if (!flag('--all-servers') && !card.global) continue;
      card.thumb = extractThumb(html) || thumbFromId(html);
      cards.push(card);
    } catch (e) {
      failures.push(`${title} : ${e.message}`);
    }
    if (i % 50 === 0 || i === list.length) process.stdout.write(`\r${i}/${list.length} pages, ${cards.length} cartes gardées`);
  }
  console.log();

  // Dédoublonnage par identifiant
  const byId = new Map();
  for (const c of cards) if (!byId.has(c.id)) byId.set(c.id, c);
  const final = [...byId.values()];

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({
    source: 'Dragon Ball Z Dokkan Battle Wiki (dbz-dokkanbattle.fandom.com) — contenu sous licence CC BY-SA',
    generatedAt: new Date().toISOString(),
    server: flag('--all-servers') ? 'all' : 'global',
    count: final.length,
    cards: final,
  }));
  console.log(`\n${final.length} cartes écrites dans ${path.relative(process.cwd(), OUT)}`);

  const noLinks = final.filter((c) => !c.links.length).length;
  const noCats = final.filter((c) => !c.categories.length).length;
  const noStats = final.filter((c) => !c.stats.atk).length;
  console.log(`Contrôle : ${noLinks} sans liens, ${noCats} sans catégories, ${noStats} sans stats.`);
  if (failures.length) {
    await writeFile(path.join(HERE, 'failures.txt'), failures.join('\n'));
    console.log(`${failures.length} pages non lues -> import/failures.txt`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
