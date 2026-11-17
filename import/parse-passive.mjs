// Lecture des passifs : on transforme le texte du passif en quelques chiffres
// (ATK, DEF, réduction de dégâts, esquive, critiques, attaques spéciales en plus, Ki, garde, soutien).
// Chaque effet est pondéré selon sa condition : un effet de base compte en entier,
// un effet « à partir du 5e tour » ou « une fois » beaucoup moins.

const ENT = { amp: '&', quot: '"', '#39': "'", lt: '<', gt: '>', nbsp: ' ' };
export const decodeHtml = (s) => String(s || '').replace(/&(#\d+|\w+);/g, (m, e) => ENT[e] ?? (e[0] === '#' ? String.fromCharCode(Number(e.slice(1))) : m));

// Texte lisible (pour l'affichage dans la fiche)
export function passiveText(html) {
  return decodeHtml(String(html || '')
    .replace(/<hr\s*\/?>/gi, '\n\n').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<span class="ic up">▲<\/span>/g, ' ↑').replace(/<span class="ic down">▼<\/span>/g, ' ↓')
    .replace(/<span class="tag once">[^<]*<\/span>/g, '(1 fois) ').replace(/<span class="tag perm">[^<]*<\/span>/g, '(permanent) ')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

const CHANCE = { rare: 10, medium: 20, great: 30, high: 40, huge: 50, 'ultra-high': 70 };

// Poids d'une condition (titre en gras d'un bloc du passif)
export function conditionWeight(h) {
  const t = h.toLowerCase();
  if (!t || /basic effect/.test(t)) return 1;
  if (/^when attacking$/.test(t)) return 1;
  let m;
  if ((m = /when attacking with (\d+) or more ki/.exec(t))) { const k = Number(m[1]); return k <= 12 ? 0.95 : k <= 18 ? 0.85 : 0.7; }
  if ((m = /when attacking with (\d+) ki/.exec(t))) return Number(m[1]) >= 24 ? 0.55 : 0.75;
  if (/when receiving|after receiving|for every attack received|when receiving a super/.test(t)) return 0.85;
  if ((m = /when hp is (\d+)% or more/.exec(t))) return Number(m[1]) >= 80 ? 0.55 : 0.8;
  if ((m = /when hp is (\d+)% or less/.exec(t))) return Number(m[1]) <= 30 ? 0.3 : 0.45;
  if ((m = /for (\d+) turns? (?:\(s\) )?from the character/.exec(t))) { const n = Number(m[1]); return n >= 7 ? 0.85 : n >= 4 ? 0.7 : n >= 2 ? 0.5 : 0.3; }
  if ((m = /starting from the (\d+)\w* turn/.exec(t))) { const n = Number(m[1]); return n <= 2 ? 0.8 : n <= 4 ? 0.6 : 0.4; }
  if (/per .* category ally|per .* ally/.test(t)) return 0.7;
  if (/for every|the more/.test(t)) return 0.65;
  if (/ki spheres? obtained/.test(t)) return 0.65;
  if (/as the \d\w* attacker/.test(t)) return 0.6;
  if (/ally attacking in the same turn|allies attacking in the same turn/.test(t)) return 0.5;
  if (/another .* ally on the team|ally on the team/.test(t)) return 0.85;
  if (/when facing only/.test(t)) return 0.55;
  if (/when facing/.test(t)) return 0.5;
  if (/enemy|enemies/.test(t)) return 0.35;
  if (/after evading|attack evaded/.test(t)) return 0.5;
  if (/at the start of each turn/.test(t)) return 0.9;
  if (/transform|revive|rage|standby|exchange/.test(t)) return 0.4;
  return 0.5;
}

function blocks(html) {
  // Découpe en blocs { titre, lignes }
  const out = [];
  for (const part of String(html || '').split(/<hr\s*\/?>/i)) {
    const hm = /^\s*<b>([\s\S]*?)<\/b>/.exec(part);
    const title = hm ? decodeHtml(hm[1].replace(/<[^>]+>/g, '')).trim() : '';
    const body = hm ? part.slice(hm[0].length) : part;
    const lines = body.split(/<br\s*\/?>/i).map((l) => l.trim()).filter(Boolean);
    out.push({ title, lines });
  }
  return out;
}

export function parsePassive(html) {
  const fx = { atk: 0, def: 0, dr: 0, evade: 0, crit: 0, addSA: 0, ki: 0, guard: 0, support: 0 };
  if (!html) return fx;
  for (const b of blocks(html)) {
    const w0 = conditionWeight(b.title);
    const stacking = /for every|per |the more/i.test(b.title);
    for (const raw of b.lines) {
      const once = /tag once/.test(raw);
      const line = decodeHtml(raw.replace(/<span class="ic up">▲<\/span>/g, '↑').replace(/<span class="ic down">▼<\/span>/g, '↓').replace(/<[^>]+>/g, ''))
        .replace(/^-\s*/, '');
      let w = w0 * (once ? 0.35 : 1);
      // « Great chance of ATK & DEF 713% » : effet aléatoire, pondéré par sa probabilité
      const ch = /^(rare|medium|great|high|huge|ultra-high) chance of (?:ATK|DEF)/i.exec(line);
      if (ch) w *= CHANCE[ch[1].toLowerCase()] / 100;
      if (/for (\d+) turns?/i.test(line)) { const n = Number(/for (\d+) turns?/i.exec(line)[1]); if (n <= 1) w *= 0.5; else if (n <= 3) w *= 0.75; }
      const upTo = /\(up to ([\d.]+)%?\)/i.exec(line);
      const stackMul = (v) => (stacking ? (upTo ? Number(upTo[1]) : v * 3) : v);
      const allies = /allies'|allies |ally's|all allies/i.test(line);
      if (allies) {
        // Soutien : on le note à part, il profite aux autres cartes de la team
        const m = /ATK(?: & DEF)? (\d+)%↑/.exec(line) || /ATK(?: & DEF)? \+(\d+)%/.exec(line);
        if (m) fx.support += stackMul(Number(m[1])) * w;
        const k = /Ki \+(\d+)/.exec(line); if (k) fx.support += Number(k[1]) * 6 * w;
        continue;
      }
      if (/enemy's|enemies'|all enemies/i.test(line) && !/evading|attacks/.test(line)) continue; // baisses de stats ennemies : ignorées
      let m;
      for (m of line.matchAll(/\b(ATK & DEF|ATK|DEF)\s*(?:\+)?(\d+)%\s*(↑)?/g)) {
        if (/↓/.test(line.slice(m.index, m.index + m[0].length + 2))) continue;
        // Une seule ligne ne compte pas plus de +300 % (les gros chiffres « gadget » type DEF 4410 % restent marginaux)
        const v = Math.min(300, stackMul(Number(m[2]))) * w;
        if (m[1] !== 'DEF') fx.atk += v;
        if (m[1] !== 'ATK') fx.def += v;
      }
      if ((m = /damage reduction rate (\d+)%/i.exec(line))) fx.dr += stackMul(Number(m[1])) * w;
      if ((m = /chance of evading (?:enemy's attack(?:s)?(?: \(including Super Attack\))?\s*)?(\d+)%/i.exec(line))) fx.evade += stackMul(Number(m[1])) * w;
      else if ((m = /(rare|medium|great|high|huge|ultra-high) chance of evading/i.exec(line))) fx.evade += CHANCE[m[1].toLowerCase()] * w;
      if (/performs a critical hit/i.test(line)) fx.crit += 100 * w;
      else if ((m = /chance of performing a critical hit (\d+)%/i.exec(line))) fx.crit += stackMul(Number(m[1])) * w;
      else if ((m = /(rare|medium|great|high|huge|ultra-high) chance of performing a critical hit/i.exec(line))) fx.crit += CHANCE[m[1].toLowerCase()] * w;
      if (/guards all attacks/i.test(line)) fx.guard += w;
      if (/launches? (?:an )?additional super attack|launches? (\d+) additional super attacks?/i.test(line)) {
        const n = Number((/launches? (\d+) additional/i.exec(line) || [])[1] || 1);
        const ch = /(rare|medium|great|high|huge) chance of launching/i.exec(line);
        fx.addSA += n * w * (ch ? CHANCE[ch[1].toLowerCase()] / 100 : 1);
      } else if ((m = /(rare|medium|great|high|huge|ultra-high) chance of launching an additional/i.exec(line))) fx.addSA += w * CHANCE[m[1].toLowerCase()] / 100;
      if ((m = /\bKi \+(\d+)/.exec(line)) && !/up to/.test(line.slice(m.index - 3, m.index))) fx.ki += stackMul(Number(m[1])) * w;
    }
  }
  for (const k of Object.keys(fx)) fx[k] = Math.round(fx[k] * 10) / 10;
  fx.atk = Math.min(fx.atk, 1000); fx.def = Math.min(fx.def, 1000);
  fx.dr = Math.min(fx.dr, 80); fx.evade = Math.min(fx.evade, 80); fx.crit = Math.min(fx.crit, 100); fx.guard = Math.min(fx.guard, 1);
  return fx;
}

// ---- Super attaques ----
// Multiplicateur de dégâts selon le mot employé (valeurs approximatives Global, SA au max)
export const SA_MULT = { low: 1.3, damage: 1.7, huge: 2.0, destructive: 2.0, extreme: 2.2, mass: 2.2, supreme: 2.6, immense: 2.9, colossal: 3.5, 'mega-colossal': 4.5, ultimate: 5.5, 'super-intense': 6 };
const RAISE = { raises: 0.3, 'greatly raises': 0.5, 'massively raises': 1.0, 'tremendously raises': 1.0, 'immensely raises': 1.0, 'hugely raises': 1.0 };

// « Raises ATK, greatly raises DEF for 1 turn, causes colossal damage… »
export function parseSA(html) {
  const t = decodeHtml(String(html || '').replace(/<[^>]+>/g, ' ')).toLowerCase();
  if (!t) return null;
  const dm = /causes (?:an? )?([\w-]+) damage/.exec(t);
  const out = { mult: SA_MULT[dm?.[1]] || 2.2, atk: 0, def: 0 };
  // Chaque « raises » s'applique à la stat citée juste après (ATK, DEF ou ATK & DEF)
  for (const m of t.matchAll(/((?:greatly |massively |tremendously |immensely |hugely )?raises) (atk & def|atk|def)(?: and (atk|def))?/g)) {
    const v = RAISE[m[1]] ?? 0.3;
    const rest = t.slice(m.index, m.index + 80);
    const stacks = !/for (\d+) turns?|for 1 turn/.test(rest.split(',')[0] + (rest.split(',')[1] || '')) ; // sans durée = cumulable
    const w = stacks ? 1.6 : 1;
    const stats = (m[2] + ' ' + (m[3] || '')).trim();
    if (/atk/.test(stats)) out.atk += v * w;
    if (/def/.test(stats)) out.def += v * w;
  }
  out.atk = Math.round(out.atk * 100) / 100; out.def = Math.round(out.def * 100) / 100;
  return out;
}
