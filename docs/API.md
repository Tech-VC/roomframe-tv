# API locale

RoomFrame expose l’administration et l’API sous la même origine HTTPS. Les
routes ci-dessous sont relatives à
`https://roomframe.<domaine-local>/`.

Les erreurs sont des objets JSON stables :

```json
{"error":"authentication_required"}
```

Les détails internes restent dans les logs serveur. Les mots de passe, jetons,
cookies, codes MFA et clés d’appareil sont masqués.

## Bootstrap et authentification

```text
GET  /api/v1/bootstrap/status
POST /api/v1/bootstrap/totp
POST /api/v1/bootstrap/complete
POST /api/v1/auth/login
GET  /api/v1/auth/session
POST /api/v1/auth/logout
POST /api/v1/auth/recovery/totp
POST /api/v1/auth/recovery/complete
```

Le jeton de bootstrap est créé une fois par l’installateur et reste dans un
fichier root-only hors du dépôt. Le flux :

1. valide ce jeton en temps constant ;
2. crée un défi TOTP temporaire, lié au nom d’utilisateur ;
3. exige un premier code TOTP valide ;
4. hache le mot de passe avec Argon2id ;
5. crée le propriétaire, l’instance et le seed dans une transaction ;
6. verrouille définitivement le bootstrap.

Deux tentatives concurrentes ne peuvent pas créer deux instances. Une rotation
du fichier de jeton après configuration ne déverrouille pas la base.

Les sessions utilisent le cookie `__Host-roomframe_session` avec `Secure`,
`HttpOnly` et `SameSite=Strict`. Toute écriture par session exige le jeton
retourné par l’API dans l’en-tête `x-csrf-token`. L’origine HTTPS préférée et
l’origine IP de secours sont toutes deux reconnues ; une origine tierce est
refusée.

La récupération reprend le même enrôlement TOTP, mais avec une autorité locale
créée par `roomframe-recover-admin`. Le défi est lié au compte ciblé et le
jeton ne peut être consommé qu’une fois. Toutes les anciennes sessions du
compte sont révoquées après succès.

## Studio et parc

```text
GET  /api/v1/instance
PUT  /api/v1/instance/branding
GET  /api/v1/studio
POST /api/v1/scenes/:sceneId/revisions
POST /api/v1/scenes/:sceneId/publish
GET  /api/v1/media
POST /api/v1/media
PATCH /api/v1/media/:assetId
POST /api/v1/messages
GET  /api/v1/tvs
POST /api/v1/tvs/enrollment
GET  /api/v1/groups
POST /api/v1/groups
PUT  /api/v1/settings/sources/:kind
PUT  /api/v1/settings/power
GET  /api/v1/users
GET  /api/v1/roles
GET  /api/v1/audit
```

Chaque route applique une permission dédiée. Le rôle contenu peut, par
exemple, obtenir le Studio sans recevoir le parc, les réglages de sources ou
les releases. Les actions d’écriture sont ajoutées au journal d’audit.

`PUT /instance/branding` est réservé au propriétaire et exige le CSRF de
session. Il met à jour atomiquement le nom affiché, cinq couleurs bornées au
format hexadécimal, un rythme typographique choisi dans une liste fermée et un
logo image déjà traité. La révision TV globale est incrémentée. Le statut de
bootstrap public n’expose ensuite que ce nom et ces valeurs visuelles sûres :
la page de connexion peut être personnalisée sans publier de média ni
d’information réseau.

Une scène est un document typé conforme à `contracts/layout.schema.json`.
Créer une révision exige `baseRevision`; une base obsolète renvoie `409` et la
révision courante. Publier déplace le pointeur publié et incrémente la révision
globale de synchronisation dans la même transaction.

Les uploads utilisent un formulaire multipart avec un seul champ `file`. Le
serveur contrôle les octets réels, l’extension et l’espace disponible avant de
mettre le média en file. `PATCH /media/:assetId` accepte un point focal
normalisé `focalX`/`focalY`.

Pour une image, le worker peut ajouter une variante `logo` WebP avec canal
alpha lorsqu’un fond clair uniforme est détecté avec confiance, ou normaliser
une transparence déjà présente. La réponse média expose `logoTransparency`
pour distinguer un détourage appliqué, une source déjà transparente et un fond
jugé ambigu.

Le Studio web consomme directement ces routes : état de bootstrap,
TOTP/complete, login/session/logout, chargement `scene.document`, création
d’une révision numérique et publication. La cible reste l’instance dans ce
jalon ; le contrôle TV/groupe est affiché désactivé plutôt que de simuler une
affectation non prise en charge.

## Enrôlement et synchronisation TV

```text
POST /api/v1/tv/enroll
GET  /api/v1/tv/sync
POST /api/v1/tv/metrics
POST /api/v1/tv/events
GET  /api/v1/media/:assetId/:variant
GET  /api/v1/default-assets/*
```

Un administrateur crée d’abord un enrôlement valable 30 minutes avec
`POST /api/v1/tvs/enrollment`. La TV échange cette clé temporaire une seule
fois sur `POST /api/v1/tv/enroll`; l’API lui remet alors une nouvelle clé
d’appareil. Une TV encore en attente ne peut pas synchroniser.

Les appels d’un appareil actif utilisent :

```text
x-roomframe-device-id: <UUID de la TV>
x-roomframe-device-key: <clé remise une fois>
```

Le manifeste de synchronisation suit `contracts/tv-sync.schema.json`. Il
contient la révision globale, la révision de scène publiée, les documents
`scene`, `messages`, `schedule`, `sources` et `branding`, leurs SHA-256, les
variantes médias prêtes et un SHA-256 canonique du
manifeste. `?revision=<n>` reçoit une réponse courte `upToDate` lorsque rien n’a
changé.

Un appareil ne peut télécharger que les médias réellement référencés par sa
scène assignée. Une session d’administration dotée de la permission adéquate
peut aussi utiliser ces routes pour un aperçu.

Les métriques acceptées concernent uniquement le démarrage, la reprise, la
mémoire, le stockage, le réseau, la synchronisation, la mise à jour et les
codes d’erreur. Les événements sont limités à une liste contrôlée. Aucun
contenu regardé ni appareil personnel n’est collecté.

La clé d’appareil reste une étape intermédiaire. Les certificats individuels,
la rotation de clé et le mTLS doivent être finalisés avant production.

## Releases

```text
GET  /api/v1/releases
POST /api/v1/releases/import
POST /api/v1/releases/:releaseId/deployments
```

L’import multipart attend un champ `file` portant l’extension `.rfupdate`. Le
serveur vérifie la signature Ed25519, la structure ZIP, la compatibilité, les
tailles et les hashes avant de ranger l’archive dans la quarantaine des
releases. Les clés JSON dupliquées sont refusées avant la validation du
contrat, y compris lorsque le manifeste est correctement signé. Aucun
artefact n’est exécuté par la requête web.

Une release vérifiée peut recevoir un plan `canary` ou `progressive`. Le plan
est persisté avec l’état `planned`; le moteur d’application et les actions sur
les TV ne sont pas encore implémentés.
