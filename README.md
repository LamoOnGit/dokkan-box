# Dokkan Box — optimiseur d'équipes (Global)

Web app pour gérer ta box Dokkan Battle et construire tes meilleures teams.

- **Ma box** : toutes les cartes LR et UR Global. Pour chaque carte : nombre d'exemplaires (les doublons débloquent le potentiel), niveau moyen des liens, niveau d'attaque spéciale.
- **Optimiseur** : pour chaque leader de ta box, il cherche les 5 cartes et les 2 rotations qui donnent le meilleur score. Il affiche les 10 meilleures teams. Tu peux viser une catégorie précise.
- **À surveiller** : les cartes qui renforceraient le plus tes 5 meilleures teams, et les leaders qui ouvriraient une meilleure team avec ta box actuelle.

Chaque fiche carte a un lien vers sa recherche DokkanEssentials et vers le wiki.

## Structure

```
import/          script qui récupère les cartes sur le wiki (Node 18+, aucune dépendance)
web/             l'app (HTML/CSS/JS, sans build) — c'est ce dossier qu'on publie
web/data/cards.json   les cartes (version démo de 6 cartes tant que l'import n'a pas tourné)
supabase/schema.sql   la table de la box
netlify.toml
```

## 1. Importer toutes les cartes

**Méthode rapide (recommandée)** : `node import/from-dokkandb.mjs` télécharge la base publique DokkanDB (données de dokkan.fyi, mise à jour toutes les 3 h) et écrit `web/data/cards.json` en quelques secondes. C'est ce que fait la tâche GitHub Actions chaque lundi. Le potentiel caché n'y figure pas : il est estimé à +5 000 par stat au maximum.

**Méthode wiki (secours)** : le script ci-dessous lit le wiki Fandom page par page.

```bash
cd import
node import-cards.mjs --limit 30     # test rapide sur 30 pages
node import-cards.mjs                # import complet (~15-20 min la première fois)
```

Le script utilise l'API officielle du wiki Fandom (pas de lecture du site page par page dans un navigateur). Il garde uniquement les cartes LR/UR sorties sur Global et écrit `web/data/cards.json`. Le HTML de chaque page est mis en cache dans `import/.cache/` : les imports suivants ne téléchargent que les nouvelles pages. Pour tout rafraîchir (EZA, nouveaux liens), supprime `.cache/`.

En fin d'import, une ligne de contrôle indique combien de cartes n'ont pas de liens, de catégories ou de stats. Si ces chiffres sont élevés, le format des pages a dû changer :

```bash
node import-cards.mjs --debug "Super Saiyan Counterstrike Super Saiyan Goku"
```

affiche le texte lu et le résultat du parseur pour une page. Si aucune page n'est trouvée, `--categories` liste les catégories du wiki, puis relance avec `--category "<nom>"` (une option par catégorie).

**Mise à jour automatique sur le VPS** (tous les lundis à 6 h, après les sorties du week-end) :

```cron
0 6 * * 1 cd /chemin/dokkan-optimizer/import && node import-cards.mjs && cd .. && git commit -am "maj cartes" && git push
```

Netlify redéploie à chaque push.

## 2. Supabase (box en ligne)

1. Dans ton projet Supabase (un existant convient), ouvre SQL Editor et exécute `supabase/schema.sql`.
2. Dans `web/config.js`, renseigne `SUPABASE_URL` et `SUPABASE_ANON_KEY` (Project Settings > API).
3. Authentication > Providers : Email activé. Désactive « Confirm email » si tu veux te connecter sans e-mail de validation.

Sans configuration, l'app marche en mode local : la box reste dans le navigateur. À la première connexion, la box locale est envoyée sur ton compte.

## 3. Mise en ligne

Pousse le dossier sur GitHub et relie-le à Netlify : le dossier publié est `web` (déjà indiqué dans `netlify.toml`). En local : `cd web && python3 -m http.server`.

## Comment le score est calculé

C'est un score comparatif, pas une simulation de combat.

- **Puissance d'une carte** : ATK + 0,7 × DEF + 0,25 × PV, au potentiel estimé selon les doublons (0 doublon ≈ 40 % du potentiel débloqué, 4 doublons = 100 %), avec un bonus selon le niveau d'attaque spéciale.
- **Leader** : chaque carte reçoit le % du leader skill si elle est dans la catégorie, le type ou la classe ciblés (le plus fort des deux si le leader a deux options, et la version EZA si elle existe). L'ami est supposé être le même leader, investi au maximum.
- **Liens** : les 2 rotations sont les paires qui partagent le plus de liens, pondérés par leur niveau. Les flottants comptent leurs liens avec les cartes des rotations à moitié.
- **Règle du jeu** : un seul exemplaire de chaque nom de personnage par team (hors leader/ami).
- **À surveiller** : une carte manquante est supposée fraîchement tirée (0 doublon, liens niveau 5).

Ce que le score ne voit pas : les effets détaillés des passifs (esquive, réduction de dégâts, conditions de transformation), les actives, les ki. Pour ces nuances, la fiche DokkanEssentials reste la référence.

Les réglages sont en haut de `web/engine.js` (`POTENTIAL`, poids des stats, bonus de liens) si tu veux les ajuster.

## Données et crédits

Cartes, stats, liens et catégories : [Dragon Ball Z Dokkan Battle Wiki](https://dbz-dokkanbattle.fandom.com), contenu sous licence CC BY-SA. Les vignettes sont affichées depuis le CDN du wiki. Dragon Ball Z Dokkan Battle © Bandai Namco / Akatsuki. Outil perso non officiel.
