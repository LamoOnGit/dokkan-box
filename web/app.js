import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { setLinkEffects, linkTotals, linkValue, setMeta, tierOf, isMeta } from './engine.js';

const TYPES = ['AGL', 'TEQ', 'INT', 'STR', 'PHY'];
const PAGE = 120;
const LOCAL_KEY = 'dokkan-box-v1';
const GUIDE_KEY = 'dokkan-guide-hidden';
const TEAMS_KEY = 'dokkan-teams-v1';
const TYPE_ORDER = { AGL: 0, TEQ: 1, INT: 2, STR: 3, PHY: 4 };
const POTENTIAL = ['≈ 40 %', '≈ 60 %', '≈ 75 %', '≈ 90 %', '100 %'];

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  cards: [], byId: new Map(), categories: [], meta: {},
  box: {}, user: null, sb: null,
  filters: { q: '', types: new Set(), rarity: '', cat: '', cls: '', owned: false },
  shown: PAGE, ranOptimizer: false, quick: false, sort: 'recent', saved: [], lastTeams: [], bulkArmed: false, lastBulk: null,
};

const ownedCount = () => Object.values(state.box).filter((o) => o.count > 0).length;

/* ---------- Données ---------- */
async function loadCards() {
  const res = await fetch('data/cards.json', { cache: 'no-cache' });
  const data = await res.json();
  state.meta = data;
  setLinkEffects(data.linkEffects || {});
  state.cards = data.cards.sort((a, b) => (a.rarity === b.rarity ? 0 : a.rarity === 'LR' ? -1 : 1) || a.name.localeCompare(b.name));
  state.cards.forEach((c) => { c._search = `${c.name} ${c.title} ${c.categories.join(' ')}`.toLowerCase(); state.byId.set(c.id, c); });
  const cats = new Set();
  state.cards.forEach((c) => c.categories.forEach((k) => cats.add(k)));
  state.categories = [...cats].sort((a, b) => a.localeCompare(b));
  $('#demo-banner').hidden = !data.demo;
  try { const r = await fetch('data/extra.json', { cache: 'no-cache' }); state.extra = r.ok ? await r.json() : null; } catch { state.extra = null; }
  setMeta(state.extra?.tierlist || []);
  try { const r = await fetch('data/top-teams.json', { cache: 'no-cache' }); state.top = r.ok ? await r.json() : null; } catch { state.top = null; }
  try { const r = await fetch('data/manual.json', { cache: 'no-cache' }); state.manual = r.ok ? await r.json() : {}; } catch { state.manual = {}; }
  const date = data.generatedAt ? new Date(data.generatedAt).toLocaleDateString('fr-FR') : '?';
  $('#credits').innerHTML = `${state.cards.length} cartes LR et UR Global, mises à jour le ${date}. Source : ${esc(data.source || 'wiki Dokkan')}.`;
}

/* ---------- Sauvegarde ---------- */
let saveTimer = null;
function saveBox() {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(state.box));
    localStorage.setItem(TEAMS_KEY, JSON.stringify(state.saved));
  } catch { /* stockage indisponible */ }
  if (!state.sb || !state.user) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const row = { user_id: state.user.id, box: state.box, teams: state.saved, updated_at: new Date().toISOString() };
    let { error } = await state.sb.from('dokkan_box').upsert(row);
    if (error && /teams/.test(error.message || '')) {
      delete row.teams; // colonne pas encore créée : on garde au moins la box
      ({ error } = await state.sb.from('dokkan_box').upsert(row));
    }
    if (error) toast('Sauvegarde en ligne impossible, réessaie plus tard');
  }, 700);
}

async function loadBox() {
  let local = {}; let teams = [];
  try { local = JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}'); } catch { local = {}; }
  try { teams = JSON.parse(localStorage.getItem(TEAMS_KEY) || '[]'); } catch { teams = []; }
  state.box = local; state.saved = Array.isArray(teams) ? teams : [];
  if (state.sb && state.user) {
    let res = await state.sb.from('dokkan_box').select('box, teams').eq('user_id', state.user.id).maybeSingle();
    if (res.error) res = await state.sb.from('dokkan_box').select('box').eq('user_id', state.user.id).maybeSingle();
    const { data, error } = res;
    if (!error && data) { state.box = data.box || {}; if (Array.isArray(data.teams)) state.saved = data.teams; }
    else if (!error && !data && Object.keys(local).length) saveBox();
  }
}

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

/* ---------- Connexion ---------- */
async function initAuth() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    $('#account').textContent = 'Sans compte';
    $('#account').onclick = () => toast('Box gardée sur cet appareil');
    return startApp();
  }
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  state.sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data } = await state.sb.auth.getSession();
  if (data.session) { state.user = data.session.user; return startApp(); }
  showAuth();
}

function showAuth() {
  $('#auth').hidden = false; $('#app').hidden = true; $('#tabs').hidden = true;
  $('#account').hidden = true;
  let mode = 'login';
  $('#auth-form').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { mode = b.dataset.mode; }));
  $('#auth-form').onsubmit = async (e) => {
    e.preventDefault();
    const email = $('#auth-email').value.trim();
    const password = $('#auth-pass').value;
    $('#auth-msg').textContent = 'Connexion…';
    const fn = mode === 'signup' ? state.sb.auth.signUp({ email, password }) : state.sb.auth.signInWithPassword({ email, password });
    const { data, error } = await fn;
    if (error) { $('#auth-msg').textContent = error.message === 'Invalid login credentials' ? 'E-mail ou mot de passe incorrect.' : error.message; return; }
    if (!data.session) { $('#auth-msg').textContent = 'Compte créé. Confirme ton e-mail, puis connecte-toi.'; return; }
    state.user = data.session.user;
    startApp();
  };
}

// Transfert de box : l'ancien site envoie ses données dans l'adresse (#import=…)
function importFromHash() {
  const h = location.hash || '';
  if (!h.startsWith('#import=')) return;
  try {
    const data = JSON.parse(decodeURIComponent(h.slice(8)));
    const inBox = data.box || {};
    let n = 0;
    for (const [id, v] of Object.entries(inBox)) {
      if (id.startsWith('__')) { if (!state.box[id]) state.box[id] = v; continue; }
      if (!v || !(v.count > 0)) continue;
      const cur = state.box[id];
      state.box[id] = cur ? { ...v, ...cur, count: Math.max(cur.count || 0, v.count) } : v;
      n++;
    }
    const keys = new Set(state.saved.map((t) => (t.units || []).map((u) => u.id).sort().join('-')));
    for (const t of data.teams || []) { const k = (t.units || []).map((u) => u.id).sort().join('-'); if (!keys.has(k)) state.saved.push(t); }
    saveBox();
    setTimeout(() => toast(`Box importée : ${n} cartes`), 300);
  } catch {
    setTimeout(() => toast('Import impossible : lien incomplet'), 300);
  }
  history.replaceState(null, '', location.pathname + location.search);
}

async function startApp() {
  await loadBox();
  importFromHash();
  $('#app').hidden = false; $('#tabs').hidden = false; $('#auth').hidden = true; $('#account').hidden = false;
  if (state.user) {
    $('#account').textContent = 'Déconnexion';
    $('#account').onclick = async () => { await state.sb.auth.signOut(); location.reload(); };
  }
  renderFilters();
  renderGuide();
  renderGrid();
  renderSaved();
}

/* ---------- Visuels ---------- */
function initials(name) {
  const words = name.replace(/\(.*?\)/g, '').split(/[\s&+/]+/).filter((w) => /^[A-Z]/.test(w));
  return words.length ? words.slice(-2).map((w) => w[0]).join('') : name.slice(0, 2);
}
function art(c, cls = '') {
  const ph = `<span class="ph c-${c.type}">${esc(initials(c.name))}</span>`;
  const img = c.thumb ? `<img src="${esc(c.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : '';
  return `<div class="art ${cls}">${ph}${img}</div>`;
}
const short = (c) => (c.name.includes(' & ') ? `${c.name.split(' & ')[0]} & co` : c.name);
const typeName = (c) => `${c.class === 'Extreme' ? 'Extreme' : 'Super'} ${c.type}`;
const typeBadge = (c) => `<span class="badge t-${c.type}">${c.class === 'Extreme' ? 'E' : 'S'}${c.type}</span>`;
const orbNum = (n, size = 26) => `<span class="orb num" style="--s:${size}px">${n}</span>`;
const orbStar = (size) => `<span class="orb" style="--s:${size}px"><i></i></span>`;

/* ---------- Guide ---------- */
function renderGuide() {
  const n = ownedCount();
  let hidden = false;
  try { hidden = localStorage.getItem(GUIDE_KEY) === '1'; } catch { /* rien */ }
  const g = $('#guide');
  if (hidden && n > 0) { g.innerHTML = ''; return; }
  if (n >= 6) {
    g.innerHTML = `<div class="guide-mini">${orbStar(24)}<span>${n} cartes dans ta box. Va dans <b>Mes teams</b> pour voir tes meilleures équipes.</span>
      <button class="ghost small" id="guide-hide" type="button">OK</button></div>`;
    $('#guide-hide').onclick = () => { try { localStorage.setItem(GUIDE_KEY, '1'); } catch { /* rien */ } renderGuide(); };
    return;
  }
  const step = (i, title, text, done) => `<li class="${done ? 'done' : ''}">${orbNum(done ? '✓' : i, 34)}<div><b>${title}</b><span>${text}</span></div></li>`;
  g.innerHTML = `<div class="guide"><h2>Comment ça marche</h2><ol class="steps">
    ${step(1, n ? `Ajoute tes cartes (${n} pour l'instant)` : 'Ajoute tes cartes', 'Touche le + sur chaque carte que tu possèdes. Ajoute au moins tes LR et tes meilleures UR.', n >= 6)}
    ${step(2, 'Regarde tes meilleures teams', "L'onglet Mes teams choisit le leader et les 5 cartes qui vont le mieux ensemble.", state.ranOptimizer)}
    ${step(3, 'Vois quoi invoquer', "L'onglet À invoquer te dit quelles cartes manquantes rendraient tes teams plus fortes.", false)}
  </ol></div>`;
}

/* ---------- Onglet Box ---------- */
function renderFilters() {
  $('#type-chips').innerHTML = TYPES.map((t) => `<button class="chip c-${t}" data-t="${t}" type="button" aria-pressed="false">${t}</button>`).join('');
  $('#type-chips').onclick = (e) => {
    const b = e.target.closest('[data-t]'); if (!b) return;
    const t = b.dataset.t;
    state.filters.types.has(t) ? state.filters.types.delete(t) : state.filters.types.add(t);
    b.classList.toggle('on'); b.setAttribute('aria-pressed', b.classList.contains('on'));
    resetGrid();
  };
  const opts = state.categories.map((c) => `<option>${esc(c)}</option>`).join('');
  $('#f-cat').insertAdjacentHTML('beforeend', opts);
  $('#o-cat').insertAdjacentHTML('beforeend', opts);
  let t;
  $('#q').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { state.filters.q = e.target.value.trim().toLowerCase(); resetGrid(); }, 150); };
  $('#class-seg').onclick = (e) => {
    const b = e.target.closest('[data-cls]'); if (!b) return;
    state.filters.cls = b.dataset.cls;
    $('#class-seg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    resetGrid();
  };
  $('#f-rarity').onchange = (e) => { state.filters.rarity = e.target.value; resetGrid(); };
  $('#f-cat').onchange = (e) => { state.filters.cat = e.target.value; resetGrid(); };
  const seg = (mine) => { state.filters.owned = mine; $('#seg-all').classList.toggle('on', !mine); $('#seg-mine').classList.toggle('on', mine); resetGrid(); };
  $('#seg-all').onclick = () => seg(false);
  $('#seg-mine').onclick = () => seg(true);
  $('#more').onclick = () => { state.shown += PAGE; renderGrid(); };
  $('#grid').onclick = (e) => {
    const sub = e.target.closest('[data-sub]');
    if (sub) { removeOne(sub.dataset.sub); return; }
    const add = e.target.closest('[data-add]');
    if (add) { addCard(add.dataset.add); return; }
    const el = e.target.closest('[data-id]'); if (!el) return;
    if (state.quick) addCard(el.dataset.id); else openCard(el.dataset.id);
  };
  $('#f-sort').onchange = (e) => { state.sort = e.target.value; resetGrid(); };
  $('#quick').onclick = () => {
    state.quick = !state.quick;
    $('#quick').classList.toggle('on', state.quick);
    $('#quick').setAttribute('aria-pressed', state.quick);
    $('#quick').textContent = state.quick ? 'Ajout rapide : activé' : 'Ajout rapide';
    $('#quick-bar').hidden = !state.quick;
    renderGrid();
  };
  $('#bulk').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.act === 'undo') { undoBulk(); return; }
    if (!state.bulkArmed) { state.bulkArmed = true; renderBulk(); return; }
    bulkAdd();
  };
}

function removeOne(id) {
  const cur = state.box[id]; if (!cur) return;
  if (cur.count <= 1) delete state.box[id]; else state.box[id] = { ...cur, count: cur.count - 1 };
  saveBox(); refreshTile(id); updateCounts();
  toast(state.box[id] ? `${state.box[id].count} exemplaire${state.box[id].count > 1 ? 's' : ''}` : 'Retirée de ta box');
}

function bulkTargets() { return filtered().filter((c) => !(state.box[c.id]?.count > 0)); }
function filtersActive() { const f = state.filters; return Boolean(f.q || f.types.size || f.rarity || f.cls || f.cat); }
function renderBulk() {
  const el = $('#bulk');
  if (state.lastBulk) {
    el.hidden = false;
    el.innerHTML = `<span>${state.lastBulk.length} cartes ajoutées à ta box.</span><button class="ghost small" data-act="undo" type="button">Annuler</button>`;
    return;
  }
  const n = bulkTargets().length;
  if (state.filters.owned || !filtersActive() || !n || n > 300) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = state.bulkArmed
    ? `<span>Ajouter ces ${n} cartes à ta box ?</span><button class="small" type="button">Oui, ajouter les ${n}</button>`
    : `<span>Tu as toutes ces cartes ?</span><button class="ghost small" type="button">Tout ajouter (${n})</button>`;
}
function bulkAdd() {
  const ids = bulkTargets().map((c) => c.id);
  ids.forEach((id) => { state.box[id] = { count: 1, linkLv: 1, saLv: 1 }; });
  state.bulkArmed = false; state.lastBulk = ids;
  saveBox(); renderGrid();
  toast(`${ids.length} cartes ajoutées`);
  setTimeout(() => { if (state.lastBulk === ids) { state.lastBulk = null; renderBulk(); } }, 10000);
}
function undoBulk() {
  (state.lastBulk || []).forEach((id) => { delete state.box[id]; });
  state.lastBulk = null; saveBox(); renderGrid(); toast('Ajout annulé');
}

function sortList(list) {
  const date = (c) => c.globalDate || '';
  if (state.sort === 'name') return list.slice().sort((a, b) => a.name.localeCompare(b.name));
  if (state.sort === 'type') {
    return list.slice().sort((a, b) => (TYPE_ORDER[a.type] - TYPE_ORDER[b.type])
      || ((a.rarity === 'LR' ? 0 : 1) - (b.rarity === 'LR' ? 0 : 1)) || date(b).localeCompare(date(a)));
  }
  return list.slice().sort((a, b) => date(b).localeCompare(date(a)) || a.name.localeCompare(b.name));
}

function addCard(id) {
  const cur = state.box[id];
  state.box[id] = cur ? { ...cur, count: cur.count + 1 } : { count: 1, linkLv: 1, saLv: 1 };
  saveBox(); refreshTile(id); updateCounts();
  toast(cur ? `${state.box[id].count} exemplaires` : 'Ajoutée à ta box');
}

function filtered() {
  const f = state.filters;
  return state.cards.filter((c) =>
    (!f.q || f.q.split(/\s+/).every((w) => c._search.includes(w)))
    && (!f.types.size || f.types.has(c.type))
    && (!f.rarity || c.rarity === f.rarity)
    && (!f.cls || c.class === f.cls)
    && (!f.cat || c.categories.includes(f.cat))
    && (!f.owned || (state.box[c.id]?.count > 0)));
}
function resetGrid() { state.shown = PAGE; renderGrid(); }

function tile(c) {
  const own = state.box[c.id];
  const corner = own?.count
    ? `<span class="qty" title="${own.count} exemplaire(s)">${orbNum(own.count)}</span>${state.quick ? `<button class="minus" data-sub="${esc(c.id)}" type="button" aria-label="Retirer un exemplaire de ${esc(c.name)}">−</button>` : ''}`
    : `<button class="add" data-add="${esc(c.id)}" type="button" aria-label="Ajouter ${esc(c.name)} à ma box">+</button>`;
  return `<div class="tile${own?.count ? ' owned' : ''}${state.quick ? ' quick' : ''}" data-tile="${esc(c.id)}">
    <button class="open" data-id="${esc(c.id)}" type="button" aria-label="Voir ${esc(c.name)}">
      ${art(c)}<div class="nm">${esc(c.name)}</div><div class="tt">${esc(c.rarity)} · ${esc(c.title)}</div></button>
    ${typeBadge(c)}${corner}</div>`;
}
function refreshTile(id) {
  const el = document.querySelector(`[data-tile="${CSS.escape(id)}"]`);
  if (el) el.outerHTML = tile(state.byId.get(id));
}
function updateCounts() {
  $('#mine-count').textContent = ownedCount();
  $('#box-count').textContent = state.filters.owned ? `${filtered().length} cartes dans ta box` : `${filtered().length} cartes`;
  renderGuide();
}

function renderGrid() {
  const list = sortList(filtered());
  updateCounts();
  if (!state.lastBulk) state.bulkArmed = false;
  renderBulk();
  if (!list.length) {
    $('#grid').innerHTML = state.filters.owned && !ownedCount()
      ? '<div class="empty" style="grid-column:1/-1"><b>Ta box est vide</b>Passe sur « Toutes les cartes » et touche le + sur celles que tu possèdes.</div>'
      : '<div class="empty" style="grid-column:1/-1"><b>Aucune carte trouvée</b>Essaie un autre nom ou retire un filtre.</div>';
  } else {
    $('#grid').innerHTML = list.slice(0, state.shown).map(tile).join('');
  }
  $('#more').hidden = list.length <= state.shown;
}

/* ---------- Feuille du bas ---------- */
function openSheet(html) {
  const sheet = $('#sheet');
  sheet.innerHTML = `<div class="grab"></div>${html}`;
  sheet.hidden = false; $('#sheet-bg').hidden = false;
  sheet.scrollTop = 0;
}
function closeSheet() {
  $('#sheet').hidden = true; $('#sheet-bg').hidden = true;
  if (state.filters.owned) renderGrid();
}
$('#sheet-bg').onclick = closeSheet;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });

function openCard(id) {
  const c = state.byId.get(id); if (!c) return;
  const saMax = c.saMax || 10;
  const dokkanEssentials = `https://www.google.com/search?q=${encodeURIComponent(`site:dokkanessentials.com ${c.title} ${c.name}`)}`;
  const wiki = `https://dbz-dokkanbattle.fandom.com/wiki/${encodeURIComponent(c.page.replace(/ /g, '_'))}`;

  const POT = [['', 'Selon mes doublons'], [0, '0 % (rien débloqué)'], [55, '55 %'], [69, '69 %'], [79, '79 %'], [90, '90 %'], [100, '100 % (complet)']];
  const fx = state.meta.linkEffects || {};
  const ownHtml = () => {
    const own = state.box[id];
    if (!own) return `<button class="block" id="c-add" type="button">Ajouter à ma box</button>`;
    const dupes = Math.max(0, own.count - 1);
    const lv = (l) => own.links?.[l] ?? own.linkLv ?? 1;
    return `<div class="own-box">
      <div class="ctrl"><div class="ctrl-top"><span>Exemplaires</span>
        <div class="stepper"><button class="ghost" data-step="-1" type="button" aria-label="Retirer un exemplaire">−</button><span class="v">${own.count}</span><button data-step="1" type="button" aria-label="Ajouter un exemplaire">+</button></div></div>
        <p>${dupes ? `${dupes} doublon${dupes > 1 ? 's' : ''}` : 'Aucun doublon'}.</p></div>
      <div class="ctrl"><div class="ctrl-top"><label for="s-pot">Potentiel caché débloqué</label>
        <select id="s-pot" class="pot-select">${POT.map(([v, t]) => `<option value="${v}"${String(own.pot ?? '') === String(v) ? ' selected' : ''}>${t}</option>`).join('')}</select></div>
        <p>${own.pot == null || own.pot === '' ? `Estimé à ${POTENTIAL[Math.min(dupes, 4)]} avec ${dupes} doublon${dupes > 1 ? 's' : ''}. Indique ton vrai pourcentage pour plus de précision.` : 'Le pourcentage affiché en jeu sur l\'écran du potentiel caché.'}</p></div>
      <div class="ctrl"><div class="ctrl-top"><span>Attaque spéciale</span><span class="v" id="v-sa">${Math.min(own.saLv, saMax)}/${saMax}</span></div>
        <input type="range" min="1" max="${saMax}" value="${Math.min(own.saLv, saMax)}" id="r-sa" aria-label="Niveau d'attaque spéciale"></div>
      <div class="ctrl"><div class="ctrl-top"><span>Niveau des liens</span>
        <span class="row"><button class="ghost small" data-all="1" type="button">Tous à 1</button><button class="ghost small" data-all="10" type="button">Tous à 10</button></span></div>
        <ul class="link-lv">${c.links.map((l) => `<li><div><b>${esc(l)}</b><small>${esc(fx[l] || '')}</small></div>
          <div class="stepper"><button class="ghost" data-lk="${esc(l)}" data-d="-1" type="button" aria-label="Baisser ${esc(l)}">−</button><span class="v">${lv(l)}</span><button data-lk="${esc(l)}" data-d="1" type="button" aria-label="Monter ${esc(l)}">+</button></div></li>`).join('')}</ul>
        <p>Les niveaux de liens se voient en jeu sur la fiche du perso. Ils comptent dans le calcul des rotations.</p></div>
    </div>
    <button class="danger block" id="c-remove" type="button">Retirer de ma box</button>`;
  };

  openSheet(`
    <div class="sheet-head">${art(c)}
      <div><span class="pill t-${c.type}">${typeName(c)}</span><span class="pill dark">${esc(c.rarity)}</span>
      <h2>${esc(c.name)}</h2><div class="muted small-text">${esc(c.title)}</div></div></div>
    <div id="own">${ownHtml()}</div>
    <div id="fit" class="fit"><button class="block" id="fit-run" type="button">Dans quelles teams la jouer ?</button></div>
    <div id="eza-mark"></div>
    ${forceHtml(c)}
    <h3>Si elle est leader</h3><div class="small-text">${esc(c.leaderSkill || 'Pas de leader skill.').replace(/\n/g, '<br>')}</div>
    <div id="links-ro"></div>
    <h3>Ses catégories</h3><div>${c.categories.map((l) => `<span class="pill dark">${esc(l)}</span>`).join('')}</div>
    <div class="ext"><a href="${dokkanEssentials}" target="_blank" rel="noopener">Analyse DokkanEssentials ↗</a><a href="${wiki}" target="_blank" rel="noopener">Page du wiki ↗</a></div>`);

  $('#fit-run').onclick = () => runFit(id);
  renderEzaMark(id);
  const bind = () => {
    const own = $('#own');
    own.innerHTML = ownHtml();
    const upd = (patch) => {
      state.box[id] = { ...state.box[id], ...patch };
      if (state.box[id].count <= 0) delete state.box[id];
      saveBox(); refreshTile(id); updateCounts();
    };
    $('#c-add')?.addEventListener('click', () => { state.box[id] = { count: 1, linkLv: 1, saLv: 1 }; saveBox(); refreshTile(id); updateCounts(); toast('Ajoutée à ta box'); bind(); });
    $('#c-remove')?.addEventListener('click', () => { delete state.box[id]; saveBox(); refreshTile(id); updateCounts(); toast('Retirée de ta box'); bind(); });
    own.querySelectorAll('[data-step]').forEach((b) => b.onclick = () => { upd({ count: Math.min(99, state.box[id].count + Number(b.dataset.step)) }); bind(); });
    $('#s-pot')?.addEventListener('change', (e) => { upd({ pot: e.target.value === '' ? null : Number(e.target.value) }); bind(); });
    own.querySelectorAll('[data-lk]').forEach((b) => b.onclick = () => {
      const o = state.box[id]; const l = b.dataset.lk;
      const cur = o.links?.[l] ?? o.linkLv ?? 1;
      upd({ links: { ...(o.links || {}), [l]: Math.min(10, Math.max(1, cur + Number(b.dataset.d))) } }); bind();
    });
    own.querySelectorAll('[data-all]').forEach((b) => b.onclick = () => { upd({ linkLv: Number(b.dataset.all), links: {} }); bind(); });
    $('#links-ro').innerHTML = state.box[id] ? '' : `<h3>Ses liens</h3><ul class="link-lv ro">${c.links.map((l) => `<li><div><b>${esc(l)}</b><small>${esc(fx[l] || '')}</small></div></li>`).join('') || '<li class="muted">Non renseignés</li>'}</ul>`;
    $('#r-sa')?.addEventListener('input', (e) => { $('#v-sa').textContent = `${e.target.value}/${saMax}`; upd({ saLv: Number(e.target.value) }); });
  };
  bind();
}

$('#help').onclick = () => openSheet(`<div class="help"><h2 style="font-family:'Bebas Neue';font-size:30px;font-weight:400;margin:0">Les mots du jeu</h2><dl>
  <dt>Leader</dt><dd>La carte en tête d'équipe. Son leader skill booste les cartes de certaines catégories ou de certains types. Avant chaque combat, tu empruntes aussi le leader d'un ami : son bonus s'ajoute à celui de ton leader. L'optimiseur construit la team avec ton leader seulement, puis te conseille les amis à choisir en priorité.</dd>
  <dt>Boost (+200 %)</dt><dd>Ce que le leader ajoute aux stats d'une carte. Une carte « hors leader » ne reçoit rien : à éviter.</dd>
  <dt>Liens</dt><dd>Des bonus qui s'activent quand deux cartes côte à côte ont le même lien. Plus elles en partagent, plus elles tapent fort.</dd>
  <dt>Rotation</dt><dd>Deux cartes qui reviennent ensemble sur le terrain un tour sur deux. On y met les cartes qui partagent le plus de liens.</dd>
  <dt>Flottants</dt><dd>Les 3 autres cartes : elles prennent la 3e place à tour de rôle.</dd>
  <dt>Doublons</dt><dd>Les exemplaires en plus d'une même carte. Ils débloquent son potentiel caché, donc plus de stats.</dd>
  <dt>Puissance</dt><dd>Le score de l'optimiseur : stats de chaque carte (ATK, DEF, PV, potentiel, attaque spéciale) × effet du passif × tier list × boost du leader × liens partagés. Il compare tes teams entre elles, il ne simule pas un combat.</dd>
  <dt>Passif</dt><dd>L'outil lit le passif de chaque carte (version EZA si elle existe) : ATK et DEF en plus, réduction de dégâts, esquive, critiques, garde, attaques spéciales en plus, Ki, soutien aux alliés. Chaque effet est pondéré selon sa condition : un effet de base compte en entier, un effet « à partir du 5e tour » beaucoup moins.</dd>
  <dt>Tier list</dt><dd>Les cartes classées dans la tier list du moment reçoivent un petit bonus en plus (jusqu'à ×1,36 pour une S++), pour ce que le passif ne dit pas : actives, transformations…</dd>
  </dl></div>`);

/* ---------- Calculs (web worker) ---------- */
let worker = null; let reqId = 0; const pending = new Map();
function run(kind, options, onProgress) {
  if (!worker) {
    worker = new Worker('worker.js', { type: 'module' });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id); if (!p) return;
      if ('progress' in e.data) return p.onProgress?.(e.data.progress);
      pending.delete(e.data.id);
      e.data.error ? p.reject(new Error(e.data.error)) : p.resolve(e.data.result);
    };
  }
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, kind, cards: state.cards, box: state.box, options, links: state.meta.linkEffects || {}, tiers: state.extra?.tierlist || [] });
  });
}
function bar(el, p) { el.hidden = false; el.firstElementChild.style.width = `${Math.round(p * 100)}%`; }

function mini(u, highlight, markOwned = false) {
  const c = state.byId.get(u.id);
  const owned = state.box[u.id]?.count > 0;
  let role;
  if (u.role === 'leader') role = '<div class="role lead">Leader</div>';
  else if (u.role === 'ami') role = '<div class="role lead">Ami</div><div class="via">au choix, voir conseils</div>';
  else if (u.boost > 0) role = `<div class="role">+${u.boost} %</div>${u.via ? `<div class="via">${esc(u.via)}</div>` : ''}`;
  else role = '<div class="role off">Hors leader</div>';
  if (markOwned && u.role !== 'ami') role += owned ? '<div class="have-tag">✓ Dans ta box</div>' : '<div class="via">À aller chercher</div>';
  const inv = !markOwned && u.own && u.id !== highlight ? `<div class="inv">×${u.own.count || 1} · AS ${Math.min(u.own.saLv || 1, c.saMax || 10)}/${c.saMax || 10}</div>` : '';
  const tb = tierOf(c) ? `<span class="tier-mini">${esc(tierOf(c))}</span>` : (u.role === 'membre' && !isMeta(c) ? '<span class="tier-mini off">hors méta</span>' : '');
  return `<div class="mini${u.id === highlight ? ' missing' : ''}${markOwned && owned ? ' have' : ''}" data-id="${esc(u.id)}" role="button" tabindex="0">${art(c)}${typeBadge(c)}${tb}<div class="nm">${esc(c.name)}</div>${role}${inv}</div>`;
}

function shared(a, b) {
  const la = state.byId.get(a.id).links; const lb = state.byId.get(b.id).links;
  return la.filter((l) => lb.includes(l));
}

function teamHtml(t, i, { highlight = null, best = null, tag = null, saveIdx = null, savedIdx = null, markOwned = false, compact = false, extraTop = '', footer = '' } = {}) {
  const L = state.byId.get(t.leader);
  const units = t.units;
  const rotIdx = new Set(t.rotations.flat());
  const floaters = units.filter((u, k) => !rotIdx.has(k));
  const members = units.filter((u) => u.role === 'membre');
  const boosted = members.filter((u) => u.boost > 0).length;
  const rel = best ? Math.round(t.score / best * 100) : 100;
  const maxPct = Math.max(...(L.leader || []).map((c) => c.pct), 0);

  const why = [];
  const vias = [...new Set(members.filter((u) => u.boost > 0).map((u) => u.via).filter(Boolean))];
  why.push({ ok: boosted === members.length, txt: boosted === members.length
    ? `Les ${members.length} cartes sont boostées par ton leader${vias.length === 1 ? ` (toutes dans « ${vias[0]} »)` : ''}`
    : `${boosted} cartes sur ${members.length} boostées par ton leader` });

  // Affinités : nombre moyen de liens partagés avec le reste de l'équipe (hors ami)
  const team = units.filter((u) => u.role !== 'ami');
  const avgLinks = (u) => {
    const others = team.filter((v) => v !== u);
    return others.length ? others.reduce((sum, v) => sum + shared(u, v).length, 0) / others.length : 0;
  };
  const weak = team.filter((u) => u.role === 'membre' && avgLinks(u) < 2);
  if (weak.length) why.push({ ok: false, txt: `Peu de liens avec l'équipe : ${weak.map((u) => state.byId.get(u.id).name).join(', ')}` });
  else why.push({ ok: true, txt: `Toutes les cartes partagent des liens entre elles (${(team.reduce((sum, u) => sum + avgLinks(u), 0) / team.length).toFixed(1)} en moyenne)` });
  const offMeta = team.filter((u) => u.role === 'membre' && !isMeta(state.byId.get(u.id)));
  if (offMeta.length) why.push({ ok: false, txt: `Hors méta : ${offMeta.map((u) => state.byId.get(u.id).name).join(', ')}. ${compact ? 'Regarde plus bas les cartes à aller chercher.' : 'C\'est ce que ta box a de mieux pour cette place ; « À invoquer » te dit par quoi la remplacer.'}` });
  t.rotations.forEach((r, k) => {
    const names = shared(units[r[0]], units[r[1]]);
    const n = names.length; const tot = linkTotals(names);
    why.push({ ok: tot.atk + tot.ki * 8 >= 50, txt: `Rotation ${k + 1} : ${n} lien${n > 1 ? 's' : ''} en commun${n ? ` (${bonusTxt(tot)})` : ''}` });
  });

  const group = (title, sub, list, hint, extra = '') => `<div class="group"><div class="group-h">${title}${hint ? `<small>${hint}</small>` : ''}</div>
    <p class="group-sub">${sub}</p><div class="slot-row">${list.map((u) => mini(u, highlight, markOwned)).join('')}</div>${extra}</div>`;

  const key = teamKey(t);
  const isSaved = state.saved.some((x) => teamKey(x) === key);
  const saveBtn = savedIdx !== null
    ? `<button class="danger block" data-unsave="${savedIdx}" type="button">Supprimer cette team</button>`
    : saveIdx !== null ? `<button class="${isSaved ? 'ghost' : ''} block" data-save="${String(saveIdx).includes(':') ? saveIdx : 'opt:' + saveIdx}" type="button"${isSaved ? ' disabled' : ''}>${isSaved ? 'Team enregistrée' : 'Enregistrer cette team'}</button>` : '';
  return `<article class="team${i === 0 && !highlight && savedIdx === null && !markOwned && !compact ? ' best' : ''}">
    <div class="team-head">${art(L)}
      <div><div class="team-tag">${tag || (i === 0 ? 'Ta meilleure team' : `Team n° ${i + 1}`)}</div>
      <div class="team-lead">${esc(L.name)}</div><div class="muted small-text">Leader : +${maxPct} % aux ${esc(leaderTarget(L))}</div></div></div>
    <div class="power"><span>Puissance</span><div class="bar"><span style="width:${Math.min(100, rel)}%"></span></div><b>${Math.round(t.score)}</b></div>
    ${extraTop}
    ${friendLine(t, L)}
    ${best && rel !== 100 ? `<p class="muted small-text" style="margin:0">${rel} % de ta meilleure team</p>` : ''}
    <ul class="why">${why.map((w) => `<li class="${w.ok ? '' : 'warn'}">${esc(w.txt)}</li>`).join('')}</ul>
    ${t.rotations.map((r, k) => { const names = shared(units[r[0]], units[r[1]]);
      return group(`Rotation ${k + 1}`, 'Ces 2 cartes jouent ensemble un tour sur deux.', [units[r[0]], units[r[1]]], '', linksDetail(names)); }).join('')}
    ${floaters.length ? group('Flottants', 'Elles prennent la 3e place à tour de rôle.', floaters) : ''}
    ${markOwned ? '' : linkPlanHtml(t)}
    ${markOwned ? '' : tipsHtml(t)}
    ${saveBtn}
    ${footer}
  </article>`;
}

// Liens à monter : pour chaque carte, ses liens les plus utiles DANS cette team
// (partagés avec son partenaire de rotation = priorité, puis avec le plus de coéquipiers)
function teamKey(t) { return t.units.filter((u) => u.role !== 'ami').map((u) => u.id).sort().join('-'); }

function renderSaved() {
  const el = $('#saved');
  if (!state.saved.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<h2 class="sec-h" style="margin-top:4px">Mes teams enregistrées</h2>
    ${state.saved.map((t, k) => {
      const L = state.byId.get(t.leader); if (!L) return '';
      const d = t.savedAt ? new Date(t.savedAt).toLocaleDateString('fr-FR') : '';
      return `<details class="lead-pick saved-team"><summary class="item">${art(L)}
        <div><div class="nm">${esc(L.name)}</div><div class="sub">${esc(t.label || '')}</div><div class="sub more-lbl">Voir la team</div></div>
        <div class="gain" style="color:var(--text)">${Math.round(t.score)}<small>enregistrée le ${d}</small></div></summary>
        ${teamHtml(t, k, { savedIdx: k, tag: 'Team enregistrée' })}</details>`;
    }).join('')}`;
}

function teamLabel(t) {
  const vias = [...new Set(t.units.filter((u) => u.role === 'membre' && u.via).map((u) => u.via))];
  return vias.length === 1 ? `Team ${vias[0]}` : `Leader : ${state.byId.get(t.leader)?.title || ''}`;
}

function linkPlan(t) {
  const units = t.units;
  const partner = new Map();
  t.rotations.forEach(([a, b]) => { partner.set(a, b); partner.set(b, a); });
  const fx = state.meta.linkEffects || {};
  return units.map((u, i) => {
    if (u.role === 'ami') return null;
    const c = state.byId.get(u.id);
    const own = state.box[u.id] || u.own || {};
    const mates = units.map((v, j) => ({ v, j })).filter(({ v, j }) => j !== i && v.role !== 'ami');
    const scored = c.links.map((l) => {
      const p = partner.has(i) && units[partner.get(i)].role !== 'ami' && state.byId.get(units[partner.get(i)].id).links.includes(l);
      const n = mates.filter(({ v }) => state.byId.get(v.id).links.includes(l)).length;
      const lv = own.links?.[l] ?? own.linkLv ?? 1;
      return { l, p, n, lv, score: linkValue(l) * ((p ? 2 : 0) + n) * (10 - lv), fx: fx[l] || '' };
    }).filter((x) => x.n > 0 && x.lv < 10).sort((a, b) => b.score - a.score).slice(0, 3);
    return { c, scored };
  }).filter((x) => x && x.scored.length);
}

function linkPlanHtml(t) {
  const plan = linkPlan(t);
  if (!plan.length) return '';
  return `<details class="link-plan"><summary><span class="group-h">Liens à monter en priorité</span>
    <span class="group-sub">Pour chaque carte, les liens qui rapportent le plus dans cette team, selon leur niveau actuel. Les liens déjà au niveau 10 ne sont pas listés.</span></summary>
    <ul>${plan.map(({ c, scored }) => `<li data-id="${esc(c.id)}"><div class="nm">${esc(c.name)}</div>
      <div class="lp-links">${scored.map((x) => `<span class="lp" title="${esc(x.fx)}"><b>${esc(x.l)} <span class="lv">niv. ${x.lv} → 10</span></b><small>${x.p ? 'avec son partenaire de rotation' : ''}${x.p && x.n > 1 ? ' · ' : ''}${x.n > 1 || !x.p ? `${x.n} coéquipier${x.n > 1 ? 's' : ''}` : ''} · ${esc(x.fx)}</small></span>`).join('')}</div></li>`).join('')}</ul></details>`;
}

function tipsHtml(t) {
  if (!t.tips || !t.tips.length) return '';
  const label = (tip) => {
    const c = state.byId.get(tip.id);
    if (tip.kind === 'dupe') return `1 doublon de plus sur <b>${esc(c.name)}</b> (×${tip.from.count || 1} → ×${tip.to.count})`;
    if (tip.kind === 'sa') return `Attaque spéciale de <b>${esc(c.name)}</b> au max (${tip.from.saLv || 1} → ${tip.to.saLv})`;
    if (tip.kind === 'pot') return `Potentiel caché de <b>${esc(c.name)}</b> à 100 % (${tip.from.pot} % → 100 %)`;
    return `Tous les liens de <b>${esc(c.name)}</b> au niveau 10`;
  };
  return `<div class="group"><div class="group-h">Où investir dans cette team</div>
    <ul class="tips">${t.tips.map((tip) => `<li data-id="${esc(tip.id)}"><span>${label(tip)}</span><b>+${tip.pct.toFixed(1)} %</b></li>`).join('')}</ul></div>`;
}

function bonusTxt(t) {
  const p = [];
  if (t.ki) p.push(`Ki +${t.ki}`);
  if (t.atk) p.push(`ATK +${t.atk} %`);
  if (t.def) p.push(`DEF +${t.def} %`);
  return p.join(', ') || 'bonus mineurs';
}

function linksDetail(names) {
  if (!names.length) return '<p class="links-detail muted">Aucun lien en commun.</p>';
  const fx = state.meta.linkEffects || {};
  return `<details class="links-detail"><summary>Bonus des liens : <b>${esc(bonusTxt(linkTotals(names)))}</b> pour chacune</summary>
    <ul>${names.map((n) => `<li><b>${esc(n)}</b> <span class="muted">${esc(fx[n] || '')}</span></li>`).join('')}</ul></details>`;
}

function friendLine(t, L) {
  const fr = (t.friends || []).filter((f) => state.byId.get(f.id));
  if (!fr.length) return '';
  const item = (f, k) => {
    const F = state.byId.get(f.id);
    const all = f.covered === f.total;
    return `<li data-id="${esc(f.id)}"><span class="rank-n">${k + 1}</span>${art(F)}
      <div><div class="nm">${esc(F.name)}${F.id === L.id ? ' <span class="muted">(même leader)</span>' : ''}</div>
      <div class="sub">${esc(F.title)} · +${f.pct} %${f.via ? ` aux ${esc(f.via)}` : ''}</div>
      <div class="sub ${all ? 'ok' : 'warn'}">Booste ${all ? 'toute la team' : `${f.covered} cartes sur ${f.total}`}</div></div></li>`;
  };
  return `<div class="friends"><div class="group-h">Amis à choisir en priorité</div>
    <p class="group-sub">Leur leader skill s'ajoute au tien. Cherche-les dans ta liste d'amis ou d'invités.</p>
    <ol>${fr.map(item).join('')}</ol></div>`;
}

function leaderTarget(L) {
  const cl = (L.leader || []).slice().sort((a, b) => b.pct - a.pct)[0];
  if (!cl) return 'cartes';
  if (cl.allTypes) return 'cartes de tous types';
  const parts = [...cl.cats.map((c) => `« ${c} »`), ...cl.types.map((t) => `${t.cls ? t.cls + ' ' : ''}${t.type}`), ...cl.classes.map((k) => `cartes ${k}`)];
  return parts.join(' ou ') || 'cartes';
}

function needCards(where) {
  $(where).innerHTML = `<div class="empty"><b>Ajoute d'abord tes cartes</b>L'optimiseur a besoin de ta box, avec au moins une carte qui a un leader skill.
    <br><button type="button" class="ghost" data-goto="box">Aller à Ma box</button></div>`;
}

$('#run-opt').onclick = async () => {
  if (!ownedCount()) return needCards('#opt-results');
  const btn = $('#run-opt'); btn.disabled = true; btn.textContent = 'Calcul en cours…';
  const prog = $('#opt-progress'); bar(prog, 0);
  try {
    const teams = await run('optimize', { focusCategory: $('#o-cat').value || null, focusClass: $('#o-cls').value || null, metaOnly: $('#o-meta').value === '1', limit: 10 }, (p) => bar(prog, p));
    state.ranOptimizer = true; renderGuide();
    state.lastTeams = teams;
    const best = teams[0]?.score;
    $('#opt-results').innerHTML = teams.length
      ? teams.map((t, i) => teamHtml(t, i, { best, saveIdx: i })).join('')
      : `<div class="empty"><b>Pas de team possible</b>${$('#o-cat').value || $('#o-cls').value ? 'Aucun leader de ta box ne correspond à ces choix. Essaie une autre catégorie ou classe.' : 'Aucune carte de ta box n’a de leader skill.'}</div>`;
  } catch (e) {
    $('#opt-results').innerHTML = `<div class="empty"><b>Le calcul a échoué</b>${esc(e.message)}</div>`;
  } finally { btn.disabled = false; btn.textContent = 'Trouver mes meilleures teams'; prog.hidden = true; }
};

$('#run-watch').onclick = async () => {
  if (!ownedCount()) return needCards('#watch-results');
  const btn = $('#run-watch'); btn.disabled = true; btn.textContent = 'Analyse en cours…';
  const prog = $('#watch-progress'); bar(prog, 0);
  try {
    const r = await run('watch', {}, (p) => bar(prog, p));
    state.gains = new Map(r.upgrades.map((g) => [g.id, Math.max(...g.teams.map((t) => t.pct))]));
    r.leaders.forEach((l) => { if (!state.gains.has(l.id)) state.gains.set(l.id, l.pct); });
    const best = r.baseTeams[0];
    const bestLead = best ? state.byId.get(best.leader) : null;
    let html = '<h2 class="sec-h">Cartes qui renforcent tes teams</h2><p class="sec-p">Le gain de puissance si tu l\'avais dans ta team, à la place de sa carte la plus faible.</p>';
    html += r.upgrades.length ? r.upgrades.slice(0, 20).map((g) => {
      const c = state.byId.get(g.id);
      const top = g.teams.slice().sort((a, b) => b.pct - a.pct)[0];
      const lead = state.byId.get(top.leader);
      const rep = top.replaced ? state.byId.get(top.replaced) : null;
      return `<button class="item" data-id="${esc(g.id)}" type="button">${art(c)}
        <div><div class="nm">${esc(c.name)}</div>
        <div class="sub">Team ${esc(short(lead))}${rep ? `, remplace ${esc(short(rep))}` : ''}</div>${g.teams.length > 1 ? `<div class="sub">Utile dans ${g.teams.length} de tes teams</div>` : ''}</div>
        <div class="gain">+${top.pct.toFixed(1)} %<small>de puissance</small></div></button>`;
    }).join('') : '<div class="empty">Aucune carte manquante ne rend tes 5 meilleures teams plus fortes.</div>';

    html += `<h2 class="sec-h">Leaders qui ouvriraient une meilleure team</h2><p class="sec-p">Ces leaders, que tu n'as pas, formeraient une team plus forte${bestLead ? ` que ta team ${esc(short(bestLead))}` : ''} avec les cartes que tu as déjà.</p>`;
    html += r.leaders.length ? r.leaders.slice(0, 8).map((l, i) => {
      const c = state.byId.get(l.id);
      return `<details class="lead-pick"><summary class="item">${art(c)}
        <div><div class="nm">${esc(c.name)}</div><div class="sub">${esc(c.title)}</div><div class="sub more-lbl">Voir la team</div></div>
        <div class="gain">${l.pct >= 0 ? '+' : ''}${l.pct.toFixed(0)} %<small>vs ta meilleure</small></div></summary>
        ${teamHtml(l.team, i, { highlight: l.id, best: best?.score, tag: 'Team possible avec ce leader' })}</details>`;
    }).join('') : '<div class="empty">Aucun leader manquant ne ferait mieux que tes teams actuelles.</div>';
    $('#watch-results').innerHTML = html;
  } catch (e) {
    $('#watch-results').innerHTML = `<div class="empty"><b>L'analyse a échoué</b>${esc(e.message)}</div>`;
  } finally { btn.disabled = false; btn.textContent = 'Trouver les cartes à invoquer'; prog.hidden = true; }
};

document.addEventListener('click', (e) => {
  const oc = e.target.closest('[data-open-custom]');
  if (oc) { editing = JSON.parse(JSON.stringify(customs()[Number(oc.dataset.openCustom)])); renderBuilder(); return; }
  const ct = e.target.closest('[data-copy-top]');
  if (ct) {
    const tt = state.top.teams[Number(ct.dataset.copyTop)];
    editing = { id: String(Date.now()), name: `Ma team ${tt.category}`, leader: tt.leader, members: tt.units.filter((u) => u.role === 'membre').map((u) => u.id) };
    $('#opt-sub [data-sub="mine"]').click(); renderBuilder(); window.scrollTo(0, 0); return;
  }
  const sv = e.target.closest('[data-save]');
  if (sv) {
    const [src, n] = sv.dataset.save.split(':');
    const t = (src === 'fit' ? state.fitTeams : state.lastTeams)[Number(n)]; if (!t) return;
    state.saved.unshift({ ...t, label: teamLabel(t), savedAt: new Date().toISOString() });
    saveBox(); renderSaved();
    sv.textContent = 'Team enregistrée'; sv.disabled = true; sv.classList.add('ghost');
    toast('Team enregistrée'); return;
  }
  const us = e.target.closest('[data-unsave]');
  if (us) {
    if (us.dataset.armed !== '1') { us.dataset.armed = '1'; us.textContent = 'Confirmer la suppression'; return; }
    state.saved.splice(Number(us.dataset.unsave), 1);
    saveBox(); renderSaved(); toast('Team supprimée'); return;
  }
  const go = e.target.closest('[data-goto]');
  if (go) { switchTab(go.dataset.goto); return; }
  const el = e.target.closest('#top-results .mini[data-id], #top-results .friends li[data-id], #mine .mini[data-id], #mine .friends li[data-id], #mine .tips li[data-id], #mine .link-plan li[data-id], #mine button.item[data-id], #opt-results .mini[data-id], #opt-results .tips li[data-id], #opt-results .friends li[data-id], #opt-results .link-plan li[data-id], #saved .mini[data-id], #news .mini[data-id], #meta .mini[data-id], #saved .tips li[data-id], #saved .friends li[data-id], #saved .link-plan li[data-id], #watch-results .mini[data-id], #watch-results button.item[data-id]');
  if (el) openCard(el.dataset.id);
});

/* ---------- Force d'une carte ---------- */
function forceHtml(c) {
  const st = c.stats || {};
  const fmt = (n) => (n ? Math.round(n).toLocaleString('fr-FR') : '—');
  const tier = tierOf(c);
  const f = c.pfx || {};
  const chips = [];
  if (f.atk) chips.push(`ATK +${Math.round(f.atk)} %`);
  if (f.def) chips.push(`DEF +${Math.round(f.def)} %`);
  if (f.dr) chips.push(`Réduction de dégâts ${Math.round(f.dr)} %`);
  if (f.evade) chips.push(`Esquive ${Math.round(f.evade)} %`);
  if (f.crit) chips.push(`Critiques ${Math.round(f.crit)} %`);
  if (f.guard) chips.push('Garde');
  if (f.addSA) chips.push(`+${f.addSA.toFixed(1)} attaque spéciale`);
  if (f.ki) chips.push(`Ki +${Math.round(f.ki)}`);
  if (f.support) chips.push(`Soutien aux alliés`);
  return `<h3>Sa force</h3>
    <div class="force">
      <div class="stats3"><div><small>ATK</small><b>${fmt(st.atk?.released)}</b></div><div><small>DEF</small><b>${fmt(st.def?.released)}</b></div><div><small>PV</small><b>${fmt(st.hp?.released)}</b></div></div>
      <p>${tier ? `<span class="tier-pill">${esc(tier)}</span> Classée <b>${esc(tier)}</b> dans la tier list du moment. ` : ''}Ce que l'outil retient de son passif${c.ezaKind ? ` (version ${esc(c.ezaKind)})` : ''}, en moyenne sur un combat :</p>
      <div class="pfx">${chips.map((x) => `<span class="pill dark">${esc(x)}</span>`).join('') || '<span class="muted small-text">Aucun effet chiffrable trouvé.</span>'}</div>
    </div>
    ${c.passive ? `<details class="passive"><summary>Lire son passif${c.passiveName ? ` : ${esc(c.passiveName)}` : ''}</summary><div class="ptext">${esc(c.passive).replace(/\n/g, '<br>')}</div></details>` : ''}`;
}

/* ---------- EZA annoncée (ajoutée à la main) ---------- */
function ezaAnnounced(id) {
  return state.box.__eza?.[id] || (state.manual?.upcomingEza || []).find((m) => m.id === id) || (state.extra?.announcedEza || []).find((m) => m.id === id) || null;
}
function renderEzaMark(id) {
  const el = $('#eza-mark'); if (!el) return;
  const c = state.byId.get(id);
  const today = new Date().toISOString().slice(0, 10);
  if (c.ezaDate && c.ezaDate <= today && !state.box.__eza?.[id]) { el.innerHTML = ''; return; }
  const a = ezaAnnounced(id);
  const mineOnly = Boolean(state.box.__eza?.[id]);
  el.innerHTML = a
    ? `<div class="eza-box"><b>${esc(a.kind || 'EZA')} annoncée${a.date ? ` le ${frDate(a.date)}` : ''}</b>
        <p>Son leader skill, ses stats et son passif vont être améliorés. Tant que l'EZA n'est pas sortie, l'outil la calcule avec sa version actuelle ; dès sa sortie, ses teams sont recalculées automatiquement.</p>
        <div class="row"><input type="date" id="eza-date" value="${esc(a.date || '')}" aria-label="Date de l'EZA">${mineOnly ? '<button class="ghost small" id="eza-del" type="button">Retirer</button>' : ''}</div></div>`
    : `<button class="ghost block" id="eza-add" type="button">Signaler une EZA annoncée pour cette carte</button>`;
  $('#eza-add')?.addEventListener('click', () => { state.box.__eza = { ...(state.box.__eza || {}), [id]: { kind: 'EZA', date: null } }; saveBox(); renderEzaMark(id); toast('EZA ajoutée à l\'onglet Actu'); });
  $('#eza-date')?.addEventListener('change', (e) => { state.box.__eza = { ...(state.box.__eza || {}), [id]: { kind: a.kind || 'EZA', date: e.target.value || null } }; saveBox(); toast('Date enregistrée'); });
  $('#eza-del')?.addEventListener('click', () => { const x = { ...(state.box.__eza || {}) }; delete x[id]; state.box.__eza = x; saveBox(); renderEzaMark(id); toast('EZA retirée'); });
}

/* ---------- Dans quelles teams jouer une carte ---------- */
async function runFit(id) {
  const box = $('#fit'); const c = state.byId.get(id);
  box.innerHTML = '<div class="progress"><span style="width:60%"></span></div><p class="muted small-text">Je cherche les meilleures teams avec cette carte…</p>';
  try {
    const r = await run('fit', { cardId: id });
    state.fitTeams = r.teams;
    if (!r.teams.length) {
      box.innerHTML = `<div class="empty"><b>Aucune team possible pour l'instant</b>Aucun leader de ta box ne booste cette carte. Regarde son leader skill et ses catégories : un leader de l'une d'elles lui ouvrirait une team.</div>`;
      return;
    }
    const intro = r.owned ? 'Les meilleures teams de ta box qui l\'incluent.' : 'Si tu l\'invoquais, voici les meilleures teams qu\'elle formerait avec tes cartes.';
    box.innerHTML = `<h3>Dans quelles teams la jouer</h3><p class="muted small-text" style="margin:0 0 6px">${intro}</p>
      ${r.teams.map((t, i) => {
        const L = state.byId.get(t.leader);
        const rel = r.best ? Math.round(t.score / r.best * 100) : 100;
        const gain = t.gain == null ? (t.leader === id ? 'Elle est le leader' : '') : t.gain > 0.05 ? `+${t.gain.toFixed(1)} % pour cette team` : 'N\'améliore pas cette team';
        return `<details class="lead-pick fit-pick"><summary class="item">${art(L)}
          <div><div class="nm">Team ${esc(L.name)}</div><div class="sub">${esc(gain)}</div><div class="sub more-lbl">Voir la team</div></div>
          <div class="gain" style="color:var(--text)">${Math.round(t.score)}<small>${rel} % de ta meilleure</small></div></summary>
          ${teamHtml(t, i, { highlight: r.owned ? null : id, saveIdx: 'fit:' + i, tag: `Team avec ${c.name}` })}</details>`;
      }).join('')}`;
  } catch (e) {
    box.innerHTML = `<div class="empty"><b>Le calcul a échoué</b>${esc(e.message)}</div>`;
  }
}

/* ---------- Onglet Actu ---------- */
const frDate = (d) => (d ? new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' }) : '');
function chip(id, note = '') {
  const c = state.byId.get(id); if (!c) return '';
  const own = state.box[id]?.count > 0;
  const gain = state.gains?.get(id);
  const tag = own ? '<div class="role">Dans ta box</div>'
    : gain > 0 ? `<div class="role">+${gain.toFixed(1)} % pour toi</div>` : `<div class="via">${esc(c.rarity)} · ${esc(c.title)}</div>`;
  return `<div class="mini${own ? ' have' : ''}" data-id="${esc(id)}" role="button" tabindex="0">${art(c)}${typeBadge(c)}<div class="nm">${esc(c.name)}</div>${tag}${note ? `<div class="via">${esc(note)}</div>` : ''}</div>`;
}
function renderNews() {
  const x = state.extra || {};
  const today = new Date().toISOString().slice(0, 10);
  const soon = state.cards.filter((c) => c.globalDate > today).sort((a, b) => a.globalDate.localeCompare(b.globalDate));
  const ezaSoon = state.cards.filter((c) => c.ezaDate && c.ezaDate > today);
  const manualNotes = {};
  const mine = Object.entries(state.box.__eza || {}).map(([id, v]) => ({ id, kind: v.kind || 'EZA', date: v.date || null, note: 'Annoncée' }));
  for (const m of [...(state.manual?.upcomingEza || []), ...(state.extra?.announcedEza || []), ...mine]) {
    const c = state.byId.get(m.id);
    if (!c || (c.ezaDate && (!m.date || c.ezaDate >= m.date))) continue; // déjà dans la base : on ne double pas
    if (!ezaSoon.includes(c)) ezaSoon.unshift(c);
    manualNotes[c.id] = `${m.kind || 'EZA'} ${m.date ? 'le ' + frDate(m.date) : (m.note || 'annoncée').toLowerCase()}`;
  }
  const since = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
  const ezaRecent = state.cards.filter((c) => c.ezaDate && c.ezaDate <= today && c.ezaDate >= since).sort((a, b) => b.ezaDate.localeCompare(a.ezaDate));
  const sec = (title, sub, body) => `<section class="news-sec"><h2 class="sec-h">${title}</h2>${sub ? `<p class="sec-p">${sub}</p>` : ''}${body}</section>`;
  const row = (ids, notes = {}) => `<div class="slot-row">${ids.map((id) => chip(id, notes[id] || '')).join('')}</div>`;
  let html = '';
  html += sec('Bientôt sur Global', 'Les nouvelles cartes déjà annoncées, avec leur date de sortie.',
    soon.length ? row(soon.map((c) => c.id), Object.fromEntries(soon.map((c) => [c.id, `Sort le ${frDate(c.globalDate)}`])))
      : '<p class="empty">Aucune nouvelle carte annoncée pour le moment.</p>');
  html += sec('EZA à venir et récentes', 'Les cartes qui viennent de recevoir (ou vont recevoir) un Extreme Z-Awakening. Une EZA manque ? Ouvre la carte et touche « Signaler une EZA annoncée ».',
    (ezaSoon.length || ezaRecent.length) ? row([...ezaSoon, ...ezaRecent].map((c) => c.id), Object.fromEntries([...ezaSoon, ...ezaRecent].map((c) => [c.id, manualNotes[c.id] || `${c.ezaKind || 'EZA'} ${c.ezaDate > today ? 'le' : 'depuis le'} ${frDate(c.ezaDate)}`])))
      : '<p class="empty">Aucune EZA récente.</p>');
  const banners = (x.summons || []).filter((b) => !b.end || b.end >= new Date().toISOString());
  html += sec('Bannières en cours', state.gains ? 'Le % indique ce que la carte apporterait à tes teams.' : 'Lance « À invoquer » pour voir ce que chaque carte apporterait à tes teams.',
    banners.length ? banners.map((b) => `<div class="banner-card"><div class="bn-h"><b>${esc(b.name)}</b><span>jusqu'au ${frDate(b.end)}</span></div>${row(b.cards)}</div>`).join('')
      : '<p class="empty">Pas d\'info sur les bannières pour le moment.</p>');
  if ((x.news || []).length) html += sec('Nouvelles du jeu', '', `<ul class="news-list">${x.news.slice(0, 10).map((n) => `<li><a href="${esc(n.url)}" target="_blank" rel="noopener"><b>${esc(n.title)}</b><span>${frDate(n.date)}${n.tags?.length ? ' · ' + esc(n.tags.join(', ')) : ''}</span></a></li>`).join('')}</ul>`);
  $('#news').innerHTML = html;
}

/* ---------- Sous-onglets de « Mes teams » ---------- */
let optSub = 'sugg';
$('#opt-sub').onclick = (e) => {
  const b = e.target.closest('[data-sub]'); if (!b) return;
  optSub = b.dataset.sub;
  $('#opt-sub').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  ['sugg', 'top', 'mine'].forEach((k) => { $(`#sub-${k}`).hidden = k !== optSub; });
  if (optSub === 'top') renderTop();
  if (optSub === 'mine') renderMine();
};

function renderTop() {
  const teams = state.top?.teams || [];
  if (!teams.length) { $('#top-results').innerHTML = '<div class="empty"><b>Pas encore calculées</b>Elles arrivent avec la prochaine mise à jour du matin.</div>'; return; }
  const best = teams[0].score;
  $('#top-results').innerHTML = teams.map((t, i) => {
    const ids = t.units.filter((u) => u.role !== 'ami').map((u) => u.id);
    const have = ids.filter((id) => state.box[id]?.count > 0).length;
    const extra = `<p class="have-sum"><b>${have}/${ids.length}</b> cartes dans ta box${have === ids.length ? ' : tu peux la jouer telle quelle !' : ''}</p>`;
    const foot = `<button class="ghost block" data-copy-top="${i}" type="button">Créer ma version de cette team</button>`;
    return teamHtml(t, i, { tag: `${i + 1}. Team ${t.category}`, best, markOwned: true, extraTop: extra, footer: foot });
  }).join('');
}

/* ---------- Mes créations : teams faites à la main ---------- */
const customs = () => (Array.isArray(state.box.__custom) ? state.box.__custom : []);
let editing = null; // { id, name, leader, members: [] }

function renderMine() {
  if (editing) return renderBuilder();
  const list = customs();
  $('#mine').innerHTML = `<div class="intro"><h2>Mes créations</h2>
      <p class="muted">Compose ta propre team : je te dis ses avantages, ses limites, les liens à monter, et les cartes et leaders à aller chercher.</p>
      <button class="block" id="mine-new" type="button">Créer une team</button></div>
    ${list.length ? list.map((t, k) => {
      const L = state.byId.get(t.leader);
      return `<button class="item" data-open-custom="${k}" type="button">${L ? art(L) : '<div class="art"></div>'}
        <div><div class="nm">${esc(t.name || 'Ma team')}</div><div class="sub">${L ? `Leader : ${esc(L.name)}` : 'Pas de leader'} · ${t.members.length}/5 cartes</div></div>
        <div class="gain" style="color:var(--text)">›</div></button>`;
    }).join('') : '<div class="empty">Tu n\'as pas encore créé de team.</div>'}`;
  $('#mine-new').onclick = () => { editing = { id: String(Date.now()), name: '', leader: null, members: [] }; renderBuilder(); };
}

function slotHtml(id, label, attr) {
  const c = id ? state.byId.get(id) : null;
  if (!c) return `<button class="slot empty-slot" ${attr} type="button"><span class="plus">+</span><span>${label}</span></button>`;
  const owned = state.box[id]?.count > 0;
  return `<div class="slot"><button class="mini${owned ? ' have' : ''}" ${attr} type="button">${art(c)}${typeBadge(c)}${tierOf(c) ? `<span class="tier-mini">${esc(tierOf(c))}</span>` : ''}<div class="nm">${esc(c.name)}</div><div class="via">${owned ? '✓ Dans ta box' : 'Pas dans ta box'}</div></button></div>`;
}

function renderBuilder() {
  const t = editing;
  const slots = [];
  for (let k = 0; k < 5; k++) slots.push(slotHtml(t.members[k], `Carte ${k + 1}`, `data-pick="m${k}"`));
  $('#mine').innerHTML = `<div class="intro builder">
      <button class="ghost small back" id="b-back" type="button">‹ Mes créations</button>
      <label class="label" for="b-name">Nom de la team</label>
      <input id="b-name" type="text" maxlength="40" placeholder="Ex. : Team Saiyans purs" value="${esc(t.name)}">
      <div class="label">Leader</div>
      <div class="slot-row lead-slot">${slotHtml(t.leader, 'Choisir le leader', 'data-pick="leader"')}</div>
      <div class="label">Les 5 autres cartes <span class="muted small-text">(l'ami s'ajoute en jeu)</span></div>
      <div class="slot-row">${slots.join('')}</div>
      <p class="muted small-text" style="margin:4px 0 0">Touche une carte pour la changer ou la retirer.</p>
      <div class="row" style="margin-top:12px"><button id="b-save" type="button" style="flex:1">Enregistrer et analyser</button>
      ${customs().some((x) => x.id === t.id) ? '<button class="danger" id="b-del" type="button">Supprimer</button>' : ''}</div>
    </div>
    <div id="analysis"></div>`;
  $('#b-back').onclick = () => { editing = null; renderMine(); };
  $('#b-name').oninput = (e) => { t.name = e.target.value; };
  $('#mine').querySelectorAll('[data-pick]').forEach((b) => b.onclick = () => openPicker(b.dataset.pick));
  $('#b-save').onclick = () => {
    if (!t.leader) { toast('Choisis d\'abord un leader'); return; }
    const list = customs().filter((x) => x.id !== t.id);
    state.box.__custom = [{ ...t, name: t.name || `Team ${state.byId.get(t.leader).name}` }, ...list];
    saveBox(); toast('Team enregistrée'); runAnalysis();
  };
  $('#b-del')?.addEventListener('click', (e) => {
    if (e.target.dataset.armed !== '1') { e.target.dataset.armed = '1'; e.target.textContent = 'Confirmer'; return; }
    state.box.__custom = customs().filter((x) => x.id !== t.id); saveBox(); editing = null; renderMine(); toast('Team supprimée');
  });
  if (t.leader && customs().some((x) => x.id === t.id)) runAnalysis();
}

function openPicker(slot) {
  const t = editing;
  const isLead = slot === 'leader';
  const k = isLead ? -1 : Number(slot.slice(1));
  const current = isLead ? t.leader : t.members[k];
  const L = t.leader ? state.byId.get(t.leader) : null;
  let mineOnly = ownedCount() > 0; let q = '';
  const taken = new Set([t.leader, ...t.members].filter(Boolean).map((id) => state.byId.get(id)?.name));
  const listHtml = () => {
    let list = state.cards.filter((c) => (!mineOnly || state.box[c.id]?.count > 0) && (!q || q.split(/\s+/).every((w) => c._search.includes(w))));
    const score = (c) => {
      let s = 0;
      if (isLead) s += Math.max(0, ...(c.leader || []).map((x) => x.pct)) / 10;
      else if (L) { const b = (L.leader || []).length ? leaderPct(L, c) : 0; s += b > 0 ? 100 : 0; }
      if (state.box[c.id]?.count > 0) s += 30;
      if (tierOf(c)) s += 20; else if (isMeta(c)) s += 8;
      return s;
    };
    list = list.map((c) => ({ c, s: score(c) })).sort((a, b) => b.s - a.s).slice(0, 60);
    if (!list.length) return '<div class="empty">Aucune carte trouvée.</div>';
    return list.map(({ c }) => {
      const owned = state.box[c.id]?.count > 0;
      const used = !isLead && taken.has(c.name) && c.id !== current;
      const b = !isLead && L ? leaderPct(L, c) : null;
      const tag = isLead ? `Leader +${Math.max(0, ...(c.leader || []).map((x) => x.pct))} %` : b == null ? '' : b > 0 ? `+${b} % avec ce leader` : 'Pas boostée par ce leader';
      return `<button class="item pick-row${used ? ' used' : ''}" data-choose="${esc(c.id)}" type="button"${used ? ' disabled' : ''}>${art(c)}
        <div><div class="nm">${esc(c.name)}</div><div class="sub">${esc(c.rarity)} · ${esc(c.title)}</div>
        <div class="sub">${tag ? `<span class="${b === 0 ? 'bad' : 'good'}">${esc(tag)}</span>` : ''}${used ? ' · déjà dans la team' : ''}</div></div>
        <div class="pick-side">${tierOf(c) ? `<span class="tier-pill">${esc(tierOf(c))}</span>` : ''}${owned ? '<span class="have-tag">✓</span>' : ''}</div></button>`;
    }).join('');
  };
  openSheet(`<h2 class="pick-h">${isLead ? 'Choisir le leader' : `Choisir la carte ${k + 1}`}</h2>
    <input id="p-q" type="search" placeholder="Chercher un perso, un titre, une catégorie…" autocomplete="off">
    <div class="seg seg-sm" id="p-seg" style="grid-template-columns:1fr 1fr;margin:8px 0 0"><button data-p="mine" class="${mineOnly ? 'on' : ''}" type="button">Ma box</button><button data-p="all" class="${mineOnly ? '' : 'on'}" type="button">Tout le jeu</button></div>
    ${current ? '<button class="danger block" id="p-remove" type="button">Retirer cette carte</button>' : ''}
    <div id="p-list" class="pick-list">${listHtml()}</div>`);
  const refresh = () => { $('#p-list').innerHTML = listHtml(); };
  let tm; $('#p-q').oninput = (e) => { clearTimeout(tm); tm = setTimeout(() => { q = e.target.value.trim().toLowerCase(); refresh(); }, 150); };
  $('#p-seg').onclick = (e) => { const b = e.target.closest('[data-p]'); if (!b) return; mineOnly = b.dataset.p === 'mine'; $('#p-seg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); refresh(); };
  $('#p-list').onclick = (e) => {
    const b = e.target.closest('[data-choose]'); if (!b || b.disabled) return;
    if (isLead) t.leader = b.dataset.choose; else t.members[k] = b.dataset.choose;
    t.members = t.members.filter(Boolean);
    closeSheet(); renderBuilder();
  };
  $('#p-remove')?.addEventListener('click', () => {
    if (isLead) t.leader = null; else t.members.splice(k, 1);
    closeSheet(); renderBuilder();
  });
}

function leaderPct(L, c) {
  let best = 0;
  for (const cl of L.leader || []) {
    const ok = cl.allTypes || cl.cats.some((x) => c.categories.includes(x))
      || (cl.classes.includes(c.class) && !cl.types.length)
      || cl.types.some((x) => x.type === c.type && (!x.cls || x.cls === c.class));
    if (ok) best = Math.max(best, cl.pct);
  }
  return best;
}

async function runAnalysis() {
  const t = editing; if (!t?.leader) return;
  const box = $('#analysis');
  box.innerHTML = '<div class="progress"><span style="width:60%"></span></div><p class="muted small-text">J\'analyse ta team…</p>';
  try {
    const r = await run('analyze', { leader: t.leader, members: t.members });
    if (!r) { box.innerHTML = ''; return; }
    box.innerHTML = analysisHtml(t, r);
  } catch (e) {
    box.innerHTML = `<div class="empty"><b>L'analyse a échoué</b>${esc(e.message)}</div>`;
  }
}

function analysisHtml(t, r) {
  const T = r.team;
  const team = T.units.filter((u) => u.role !== 'ami');
  const members = T.units.filter((u) => u.role === 'membre');
  const card = (u) => state.byId.get(u.id);
  const avgLinks = (u) => { const o = team.filter((v) => v !== u); return o.length ? o.reduce((s, v) => s + shared(u, v).length, 0) / o.length : 0; };
  const pros = []; const cons = [];
  const boosted = members.filter((u) => u.boost > 0);
  if (members.length && boosted.length === members.length) pros.push(`Toutes les cartes sont boostées par le leader (+${Math.min(...boosted.map((u) => u.boost))} % ou plus).`);
  const notB = members.filter((u) => u.boost <= 0);
  if (notB.length) cons.push(`Pas boostées par le leader : ${notB.map((u) => card(u).name).join(', ')}. Elles perdent tout le bonus du leader.`);
  const avgAll = team.length ? team.reduce((s, u) => s + avgLinks(u), 0) / team.length : 0;
  const weak = members.filter((u) => avgLinks(u) < 2);
  if (avgAll >= 3) pros.push(`Très bonne entente des liens : ${avgAll.toFixed(1)} liens partagés en moyenne entre deux cartes.`);
  else if (avgAll >= 2) pros.push(`Liens corrects : ${avgAll.toFixed(1)} liens partagés en moyenne entre deux cartes.`);
  if (weak.length) cons.push(`Peu de liens avec l'équipe : ${weak.map((u) => card(u).name).join(', ')}.`);
  const metaN = team.filter((u) => tierOf(card(u))).length;
  if (metaN) pros.push(`${metaN} carte${metaN > 1 ? 's' : ''} de la tier list du moment.`);
  const off = members.filter((u) => !isMeta(card(u)));
  if (off.length) cons.push(`Cartes dépassées (hors tier list, sans sortie ou EZA récente) : ${off.map((u) => card(u).name).join(', ')}.`);
  const tanks = team.filter((u) => { const f = card(u).pfx || {}; return f.dr >= 30 || f.evade >= 30 || f.guard >= 0.5; });
  if (tanks.length >= 2) pros.push(`Bonne défense : ${tanks.length} cartes avec réduction de dégâts, esquive ou garde.`);
  else if (tanks.length === 1) cons.push(`Une seule carte vraiment défensive (${card(tanks[0]).name}) : la team peut souffrir face aux gros boss.`);
  else cons.push('Aucune carte avec réduction de dégâts, esquive ou garde : la team encaisse mal.');
  const types = new Set(team.map((u) => card(u).type));
  if (types.size >= 4) pros.push(`Bonne couverture des types (${[...types].join(', ')}).`);
  else if (team.length >= 4) cons.push(`Peu de types différents (${[...types].join(', ')}) : prudence face à un ennemi qui les contre.`);
  const notOwned = team.filter((u) => !(state.box[u.id]?.count > 0));
  if (notOwned.length) cons.push(`Pas encore dans ta box : ${notOwned.map((u) => card(u).name).join(', ')}.`);
  if (members.length < 5) cons.push(`La team n'a que ${members.length} carte${members.length > 1 ? 's' : ''} sur 5 en plus du leader.`);

  const up = (r.upgrades || []).map((g) => {
    const c = state.byId.get(g.id); const rep = g.replaced ? state.byId.get(g.replaced) : null;
    return `<button class="item" data-id="${esc(g.id)}" type="button">${art(c)}
      <div><div class="nm">${esc(c.name)}${tierOf(c) ? ` <span class="tier-pill">${esc(tierOf(c))}</span>` : ''}</div><div class="sub">${esc(c.title)}</div>
      <div class="sub">${rep ? `À la place de ${esc(rep.name)}` : 'Sur une place libre'}${g.owned ? ' · <span class="good">déjà dans ta box !</span>' : ''}</div></div>
      <div class="gain">+${g.pct.toFixed(1)} %<small>de puissance</small></div></button>`;
  }).join('');
  const leads = (r.leaders || []).map((g) => {
    const c = state.byId.get(g.id);
    const pct = Math.max(0, ...(c.leader || []).map((x) => x.pct));
    return `<button class="item" data-id="${esc(g.id)}" type="button">${art(c)}
      <div><div class="nm">${esc(c.name)}</div><div class="sub">${esc(c.title)} · +${pct} %</div>
      <div class="sub">Booste ${g.covered}/${g.total} de tes cartes${g.owned ? ' · <span class="good">déjà dans ta box !</span>' : ''}</div></div>
      <div class="gain">+${g.pct.toFixed(1)} %<small>de puissance</small></div></button>`;
  }).join('');

  return `<section class="verdict">
      <h2 class="sec-h">Avantages</h2><ul class="why">${pros.map((x) => `<li>${esc(x)}</li>`).join('') || '<li class="warn">Pas d\'atout particulier pour l\'instant.</li>'}</ul>
      <h2 class="sec-h">Limites</h2><ul class="why">${cons.map((x) => `<li class="warn">${esc(x)}</li>`).join('') || '<li>Rien à signaler.</li>'}</ul>
    </section>
    ${teamHtml(T, 0, { tag: esc(t.name || 'Ma team'), compact: true })}
    <h2 class="sec-h">Cartes à aller chercher</h2><p class="sec-p">Les cartes du jeu qui feraient le plus progresser cette team.</p>
    ${up || '<div class="empty">Aucune carte ne ferait mieux pour l\'instant.</div>'}
    <h2 class="sec-h">Leaders à aller chercher</h2><p class="sec-p">Avec les mêmes cartes, ces leaders rendraient la team plus forte.</p>
    ${leads || '<div class="empty">Ton leader est déjà le meilleur choix pour ces cartes.</div>'}`;
}

/* ---------- Onglet Méta ---------- */
let metaFilter = 'all';
function renderMeta() {
  const tl = state.extra?.tierlist || [];
  if (!tl.length) { $('#meta').innerHTML = '<div class="empty"><b>Tier list indisponible</b>Elle revient à la prochaine mise à jour des données.</div>'; $('#meta-sum').textContent = ''; return; }
  const have = (id) => state.box[id]?.count > 0;
  const all = tl.flatMap((t) => t.cards);
  const nHave = all.filter(have).length;
  $('#meta-sum').textContent = `Tu en as ${nHave} sur ${all.length}.`;
  const keep = (id) => metaFilter === 'all' || (metaFilter === 'have' ? have(id) : !have(id));
  const blocks = tl.map((t) => {
    const ids = t.cards.filter(keep);
    if (!ids.length) return '';
    return `<div class="tier"><div class="tier-h"><span class="tier-badge">${esc(t.tier)}</span><span class="muted small-text">rangs ${esc(t.ranks)} · ${t.cards.filter(have).length}/${t.cards.length} dans ta box</span></div>
      <div class="slot-row">${ids.map((id) => chip(id)).join('')}</div></div>`;
  }).join('');
  $('#meta').innerHTML = blocks || `<div class="empty"><b>${metaFilter === 'have' ? 'Aucune carte de la tier list dans ta box' : 'Tu les as toutes'}</b></div>`;
}
$('#meta-seg').onclick = (e) => {
  const b = e.target.closest('[data-m]'); if (!b) return;
  metaFilter = b.dataset.m;
  $('#meta-seg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  renderMeta();
};

/* ---------- Onglets ---------- */
function switchTab(name) {
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
  ['box', 'opt', 'watch', 'meta', 'news'].forEach((t) => { $(`#tab-${t}`).hidden = t !== name; });
  if (name === 'meta') renderMeta();
  if (name === 'box') renderGrid();
  if (name === 'news') renderNews();
  window.scrollTo(0, 0);
}
$('#tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) switchTab(b.dataset.tab); };

/* ---------- Démarrage ---------- */
loadCards().then(initAuth).catch((e) => {
  document.body.insertAdjacentHTML('beforeend', `<div class="empty"><b>Impossible de charger les cartes</b>Le fichier data/cards.json est introuvable ou illisible (${esc(e.message)}).</div>`);
});
