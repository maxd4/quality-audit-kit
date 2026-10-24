# Export SonarQube depuis Chrome

`tools/sonarqube-console-exporter.js` est un exporteur ponctuel à coller dans la console Chrome d’une page SonarQube déjà authentifiée. Il produit une enveloppe JSON locale au format `quality-audit-kit/sonarqube-browser-export` v1.

Le fichier contient les pages brutes de `/api/issues/search`, la version de `/api/server/version`, la dernière analyse de `/api/project_analyses/search`, les sélecteurs, la pagination et les diagnostics. L’importeur Quality Audit Kit réutilise ensuite le même contrat SonarQube et la même normalisation que l’import réseau.

## Utilisation

1. Ouvrir dans Chrome la page SonarQube correspondant au projet et vérifier que la session possède la permission nécessaire pour lire les issues et l’historique d’analyse.
2. Ouvrir DevTools → Console.
3. Copier le contenu complet de [`tools/sonarqube-console-exporter.js`](../tools/sonarqube-console-exporter.js) et l’exécuter.
4. Si la clé projet n’est pas présente dans l’URL, renseigner `CONFIG.project` au début du script avant de le copier. `CONFIG.branch` et `CONFIG.pullRequest` sont exclusifs. Pour une instance publiée sous un préfixe, renseigner aussi `CONFIG.basePath` (par exemple `/sonarqube`) ; laisser vide pour un déploiement à la racine.
5. Enregistrer le fichier téléchargé sans le modifier.
6. Dans un checkout local du dépôt à auditer, convertir l’export en run Quality Audit Kit :

   ```text
   node bin/quality-audit-kit.js import sonar-export sonarqube-export.json --repository /chemin/du/depot --output sonar-run.json
   node bin/quality-audit-kit.js report sonar-run.json --format markdown --output sonar-report.md
   ```

   L’alias suivant est également accepté :

   ```text
   node bin/quality-audit-kit.js import sonar /chemin/du/depot --sonar-export sonarqube-export.json --output sonar-run.json
   ```

Le run produit est au format `0.1-draft`, comme celui de `import sonar`. Il peut donc être utilisé par les commandes locales de rapport, baseline et triage. La commande d’import vérifie le format, les numéros de pages, les totaux et la limite avant de qualifier la mesure.

## Sécurité et limites

- Les seules requêtes sont des `GET` same-origin vers les trois endpoints du contrat SonarQube. Aucune requête cross-origin, mutation serveur, upload ou service tiers n’est utilisé.
- Le script ne lit ni `document.cookie`, ni `localStorage`, ni `sessionStorage`, ni token, ni en-tête d’authentification. `credentials: "same-origin"` laisse seulement le navigateur appliquer la session existante aux requêtes autorisées.
- La réponse est téléchargée avec un `Blob` local. Le script ne copie pas le JSON dans le presse-papiers et n’affiche pas de réponse brute dans la console.
- Une erreur de page, une pagination sans métadonnées, un total changeant, un doublon, une limite atteinte ou une analyse inaccessible conserve les pages reçues mais produit `PARTIAL` et un diagnostic. Une version absente, invalide ou antérieure à SonarQube 9 produit `INCOMPATIBLE`.
- Une exportation `PARTIAL`, `FAILURE` ou `INCOMPATIBLE` ne devient jamais une mesure propre à l’import. Les findings partiels restent visibles comme éléments d’audit.
- Le script ne peut pas prouver que l’analyse SonarQube correspond au contenu local. La révision SonarQube reste `UNVERIFIED` si elle est un SHA démontrable, sinon `UNKNOWN`; elle n’est jamais remplacée par `HEAD`.
- La taille maximale configurable est `10000` findings, conformément au connecteur Node. Au-delà, l’export est explicitement partiel.

## Compatibilité officielle

Le script s’appuie sur la Web API documentée par SonarSource et sur les endpoints déjà retenus par le connecteur du dépôt. SonarSource indique que la Web API v2 remplace progressivement la Web API existante ; le profil de version et les diagnostics sont donc conservés dans l’export au lieu de supposer une compatibilité éternelle. Voir la [documentation officielle Web API SonarQube Server](https://docs.sonarsource.com/sonarqube-server/extension-guide/web-api).

## Exemple

[`examples/sonarqube-browser-export.example.json`](../examples/sonarqube-browser-export.example.json) est un exemple synthétique sans cookie, token, en-tête ou donnée d’authentification. Il sert de fixture de format et ne constitue pas une capture d’un serveur réel.
