// Parseur d'une page carte du wiki Dokkan (dbz-dokkanbattle.fandom.com).
// On convertit le HTML rendu en lignes de texte (les icônes deviennent leur texte "alt"),
// puis on lit les sections dans l'ordre : en-tête, Leader Skill, Link skill, Category, Stats.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function htmlToLines(html) {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  // Les images deviennent leur texte alternatif, sur leur propre ligne
  s = s.replace(/<img\b[^>]*>/gi, (tag) => {
    const alt = /\balt="([^"]*)"/i.exec(tag);
    return alt && alt[1] ? `\n${alt[1]}\n` : '';
  });
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/?(div|p|tr|td|th|li|ul|ol|table|tbody|thead|h[1-6]|center|section|figure|dl|dt|dd)\b[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  return s.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

export function extractThumb(html) {
  // Première vignette de carte : <img alt="Card 1024850 thumb" ... data-src|src="...">
  const re = /<img\b[^>]*alt="Card \d+ thumb"[^>]*>/gi;
  const tag = re.exec(html);
  if (!tag) return null;
  const src = /\b(?:data-src|src)="(https?:\/\/[^"]+)"/i.exec(tag[0]);
  return src ? src[1].replace(/&amp;/g, '&') : null;
}

const TYPE_RE = /^(S|E)?(AGL|TEQ|INT|STR|PHY) icon$/;
const RARITY_RE = /^(N|R|SR|SSR|UR|LR) icon$/;
const HEADER_KEYS = ['Max Lv', 'SA Lv', 'Rarity', 'Type', 'Cost', 'ID'];

function parseHeader(lines, start) {
  // start = index de "Max Lv". Les valeurs suivent les 6 libellés.
  let i = start;
  for (const k of HEADER_KEYS) {
    if (lines[i] !== k) return null;
    i++;
  }
  const out = { maxLv: null, saMax: null, rarity: null, type: null, cost: null, gameId: null };
  // On lit au plus ~10 lignes de valeurs
  const vals = lines.slice(i, i + 10);
  for (const v of vals) {
    let m;
    if (out.maxLv === null && (m = /^(\d{2,3})(?:\/(\d{2,3}))?$/.exec(v))) { out.maxLv = Number(m[2] || m[1]); continue; }
    if (out.saMax === null && (m = /^\d+\/(\d+)$/.exec(v))) { out.saMax = Number(m[1]); continue; }
    if (!out.rarity && (m = RARITY_RE.exec(v))) { out.rarity = m[1]; continue; }
    if (!out.type && (m = TYPE_RE.exec(v))) { out.type = m[2]; out.class = m[1] === 'E' ? 'Extreme' : 'Super'; continue; }
    if (out.type && out.cost === null && /^\d{1,3}$/.test(v)) { out.cost = Number(v); continue; }
    if (out.cost !== null && out.gameId === null && /^\d{4,7}$/.test(v)) { out.gameId = v; break; }
  }
  // L'icône LR a souvent un alt inexploitable : niveau max 150 => LR
  if (!out.rarity && out.maxLv >= 150) out.rarity = 'LR';
  return out;
}

function sectionAfter(lines, label, from, stopLabels) {
  const i = lines.indexOf(label, from);
  if (i < 0) return { start: -1, end: -1, lines: [] };
  let j = i + 1;
  while (j < lines.length && !stopLabels.includes(lines[j])) j++;
  return { start: i, end: j, lines: lines.slice(i + 1, j) };
}

const STOPS = ['Super atk', 'Passive skill', 'Link skill', 'Category', 'Ki meter', 'Stats', 'Acquired',
  'Leader Skill', 'Stage Skill', 'Max Lv', 'Details', 'Active Skill'];

export function parseLeaderSkill(text) {
  // Renvoie une liste de clauses { cats:[], types:[], classes:[], allTypes, ki, pct }
  if (!text) return [];
  const clauses = text.split(/;\s*(?:or\s*)?|\n\s*or\s*\n/i).map((c) => c.trim()).filter(Boolean);
  return clauses.map((c) => {
    const cats = [...c.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const bare = c.replace(/"[^"]*"/g, '');
    const types = [...bare.matchAll(/\b(Super |Extreme )?(AGL|TEQ|INT|STR|PHY)\b/g)].map((m) => ({ cls: m[1] ? m[1].trim() : null, type: m[2] }));
    const classes = [...bare.matchAll(/\b(Super|Extreme) Class\b/g)].map((m) => m[1]);
    const allTypes = /All Types/i.test(c);
    const ki = Number((/Ki \+(\d+)/.exec(c) || [])[1] || 0);
    // On prend le % d'ATK si identifiable, sinon le plus grand %
    let pct = 0;
    const atk = /ATK(?: & DEF)? \+(\d+)%/.exec(c);
    if (atk) pct = Number(atk[1]);
    else {
      const all = [...c.matchAll(/\+(\d+)%/g)].map((m) => Number(m[1]));
      pct = all.length ? Math.max(...all) : 0;
    }
    return { text: c, cats, types, classes, allTypes, ki, pct };
  }).filter((cl) => cl.pct > 0 || cl.ki > 0);
}

export function parseCardPage(html, pageTitle) {
  const lines = htmlToLines(html);
  const hdrIdx = lines.indexOf('Max Lv');
  if (hdrIdx < 0) return { ok: false, reason: 'pas d’en-tête "Max Lv"' };
  const header = parseHeader(lines, hdrIdx);
  if (!header || !header.type) return { ok: false, reason: 'en-tête illisible' };

  // Fin du bloc de la première carte = prochain "Max Lv"
  const nextHdr = lines.indexOf('Max Lv', hdrIdx + 1);
  const blockEnd = nextHdr > 0 ? nextHdr : lines.length;
  const block = lines.slice(0, blockEnd);

  const title = lines[hdrIdx - 2] || '';
  const name = lines[hdrIdx - 1] || '';

  // Leader skills : toutes les occurrences du bloc (base + EZA), on garde la plus forte
  const leaderTexts = [];
  let k = hdrIdx;
  while ((k = block.indexOf('Leader Skill', k + 1)) > 0) {
    const sec = [];
    for (let j = k + 1; j < block.length && !STOPS.includes(block[j]); j++) sec.push(block[j]);
    if (sec.length) leaderTexts.push(sec.join('\n'));
  }
  const scored = leaderTexts.map((t) => ({ t, max: Math.max(0, ...parseLeaderSkill(t).map((c) => c.pct)) }));
  scored.sort((a, b) => b.max - a.max);
  const leaderText = scored[0]?.t || '';

  // Liens
  const linkSec = sectionAfter(block, 'Link skill', hdrIdx, STOPS);
  const links = [];
  for (const l of linkSec.lines) {
    if (/^Lv \d+/.test(l)) continue;
    const n = l.replace(/^-\s*/, '').trim();
    if (n && !links.includes(n)) links.push(n);
  }

  // Catégories : "A - B - C"
  const catSec = sectionAfter(block, 'Category', hdrIdx, STOPS);
  const categories = catSec.lines.join(' - ').split(/\s+-\s+/).map((c) => c.trim()).filter(Boolean);

  // Stats : HP/Atk/Def suivis de 4 nombres (Base, Max, Max Star locked, Max Star released)
  const stats = {};
  const statsIdx = block.indexOf('Stats', hdrIdx);
  if (statsIdx > 0) {
    for (const key of ['HP', 'Atk', 'Def']) {
      const i = block.indexOf(key, statsIdx);
      if (i < 0) continue;
      const nums = [];
      for (let j = i + 1; j < block.length && nums.length < 4 && /^\d+$/.test(block[j]); j++) nums.push(Number(block[j]));
      if (nums.length >= 2) stats[key.toLowerCase()] = { base: nums[0], max: nums[1], locked: nums[2] ?? nums[1], released: nums[3] ?? nums[2] ?? nums[1] };
    }
  }

  // Sortie Global
  const glob = lines.find((l) => /^Global server/i.test(l));
  const globalDate = glob ? glob.replace(/^Global server\s*/i, '').trim() : null;

  return {
    ok: true,
    card: {
      id: header.gameId || pageTitle,
      page: pageTitle,
      title,
      name,
      rarity: header.rarity,
      type: header.type,
      class: header.class,
      maxLv: header.maxLv,
      saMax: header.saMax,
      cost: header.cost,
      leaderSkill: leaderText,
      leader: parseLeaderSkill(leaderText),
      links,
      categories,
      stats,
      global: Boolean(glob),
      globalDate,
      eza: leaderTexts.length > 1,
    },
  };
}
