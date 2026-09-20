# lkclean

[English](README.md) · **Français**

Une extension Chrome (Manifest V3, TypeScript) qui nettoie ton fil LinkedIn.
Chaque post est soumis à **Jev**, le modèle de classification typée de
[TypeSafe AI](https://typesafe.ai), qui répond par des probabilités plutôt que par
du texte. L'engagement bait, l'auto-promo, le hors-sujet et le sponsorisé sont
repliés en une barre d'une ligne, et chaque décision est expliquée directement sur
le post.

> Projet indépendant, sans lien avec LinkedIn ni TypeSafe AI. Il te faut ta propre
> clé API TypeSafe.

## Ce que ça fait

- **Masque le bruit** – engagement bait, humble-brags, posts sponsorisés, sujets
  que tu bloques, et posts sans rapport avec les centres d'intérêt que tu listes.
- **S'explique** – les posts masqués affichent la raison et les scores, avec un
  bouton *Afficher* / *Re-masquer*. Les posts gardés reçoivent une ligne discrète
  « Gardé par Jev » avec leurs scores ; un score proche du seuil passe en orange
  (« Gardé de justesse »), ce qui rend le réglage des seuils très simple.
- **Pastille d'activité Jev** – un petit badge flottant (en bas à gauche) pulse
  pendant les appels. Au clic : posts analysés/masqués, appels en cours, tokens,
  coût estimé, latence moyenne, historique des latences et derniers verdicts.
- **Préserve le scroll infini** – quand presque tout est replié, le fil devient
  trop court pour le déclencheur « charger la suite » de LinkedIn ; lkclean le
  relance sans déplacer ta position de lecture.
- **Rapide et pas cher** – un appel API par post, toutes les questions évaluées en
  parallèle, verdicts mis en cache pour la session. Environ 0,042 $ par million de
  tokens en entrée : une session de scroll coûte une fraction de centime.


<img width="502" height="383" alt="notok" src="https://github.com/user-attachments/assets/6c7a739f-a63e-4953-884e-6dff45736c45" />

<img width="513" height="486" alt="ok" src="https://github.com/user-attachments/assets/fa22115b-176c-4720-8700-47dbbbe51c01" />


## Fonctionnement

1. Un content script observe le fil (`MutationObserver`) et attrape chaque post :
   `[data-testid="mainFeed"] [role="listitem"]` sur le front React actuel de
   LinkedIn (texte dans `[data-testid="expandable-text-box"]`), avec repli sur
   l'ancien balisage `data-id="urn:li:activity:…"`. Le post est identifié par un
   hash de son texte, LinkedIn n'exposant plus d'identifiant stable.
2. L'auteur et le texte partent au service worker, qui appelle
   `POST https://api.typesafe.ai/v1/systemone` avec un *state*
   `{ user_interests, post }` et plusieurs questions typées en une seule requête :

   | Question | Type | Sens |
   | --- | --- | --- |
   | `engagement_bait` | `noul` | clickbait, question rhétorique finale, storytelling creux |
   | `self_promo` | `noul` | « thrilled to announce », humble-brag, communication d'entreprise |
   | `matches_interests` | `noul` | le post touche-t-il un de tes centres d'intérêt ? |
   | `top_interest` | `choice` | *lequel* de tes centres d'intérêt il recoupe (affiché sur le post) |
   | `blocked_topic` | `choice` | sujets à masquer d'office |

3. Du code ordinaire transforme les probabilités en verdict selon tes seuils
   (`decide()` dans `src/background.ts`). Aucun parsing de texte libre.
4. Le content script replie ou annote le post et met la pastille à jour.

La clé API ne vit que dans le service worker : elle n'est jamais transmise à la
page LinkedIn ni au content script.

## Installation

```bash
npm install
npm run build
```

Puis dans Chrome : `chrome://extensions` → activer le *Mode développeur* →
*Charger l'extension non empaquetée* → choisir le dossier `dist/`.

Clique sur l'icône de l'extension pour ouvrir les réglages : colle ta clé TypeSafe
(depuis [console.typesafe.ai](https://console.typesafe.ai)), liste tes centres
d'intérêt (un par ligne), éventuellement des sujets à bloquer, puis ajuste les
seuils. Recharge LinkedIn.

Après chaque rebuild, clique sur ↻ sur la carte de l'extension dans
`chrome://extensions`, puis recharge l'onglet LinkedIn.

## Réglages

| Réglage | Défaut | Effet |
| --- | --- | --- |
| Centres d'intérêt | vide | Si vide, seul le bruit est filtré (bait, auto-promo, sponsorisé) |
| Sujets bloqués | vide | Toujours masqués quand Jev est sûr à ≥ 60 % |
| Seuil de bruit | 70 % | Masque si P(bait) ou P(auto-promo) le dépasse |
| Seuil d'intérêt | 35 % | Masque si P(correspond aux intérêts) est en dessous |
| Masquer le sponsorisé | oui | Détection locale, sans appel API |
| Longueur minimale | 40 caractères | Les posts plus courts ne sont jamais évalués |
| Expliquer les posts gardés | oui | La ligne « Gardé par Jev » |
| Pastille d'activité | oui | Le badge flottant Jev |
| Modèle | `jev-latest` | Épingle une version (ex. `jev-1.13.0`) une fois tes seuils réglés |

## Confidentialité

- Le nom de l'auteur et le texte de chaque post affiché dans ton fil sont envoyés à
  l'API TypeSafe pour classification. Rien d'autre ne quitte ton navigateur, et
  lkclean n'a ni serveur ni analytics.
- La clé API est stockée dans le stockage synchronisé de Chrome
  (`chrome.storage.sync`).
- Les verdicts sont mis en cache dans `chrome.storage.session` et effacés à la
  fermeture du navigateur ou à chaque changement de réglages.

## Développement

```bash
npm run watch      # rebuild à chaque modification
npm run typecheck  # tsc --noEmit
```

| Fichier | Rôle |
| --- | --- |
| `src/content.ts` | détection des posts, extraction, masquage/annotation, relance du scroll infini |
| `src/sticker.ts` | la pastille d'activité Jev (Shadow DOM) |
| `src/background.ts` | questions, logique de décision, cache, appels API |
| `src/jev.ts` | client typé minimal pour l'endpoint System One |
| `src/options.ts`, `public/options.*` | page de réglages |

Pour changer ce qui est filtré, modifie `buildQuestions()` et `decide()` dans
`src/background.ts`. Jev évalue chaque question indépendamment et en parallèle :
une question de plus ne coûte presque rien en latence.

## Quand LinkedIn change son balisage

Le DOM de LinkedIn bouge régulièrement. Les sélecteurs sont regroupés en haut de
`src/content.ts` (`POST_SELECTORS`, `TEXT_SELECTORS`, `AUTHOR_SELECTORS`).

Si aucun post n'est détecté 6 secondes après l'arrivée sur `/feed`, l'extension
logue dans la console de la page un bloc `[lkclean] DIAGNOSTIC` décrivant la
structure de la page (noms d'attributs uniquement, aucun contenu). Ce bloc suffit
pour écrire de nouveaux sélecteurs. Chaque verdict est aussi logué au niveau
*Verbose* de la console.

Un badge **!** rouge sur l'icône signifie que le dernier appel API a échoué (clé
absente ou refusée, API injoignable) ; le message est dans la pastille et dans la
console.

## Licence

[MIT](LICENSE)
