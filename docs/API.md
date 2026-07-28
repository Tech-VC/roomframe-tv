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
GET  /api/v1/studio?sceneId=<uuid>
GET  /api/v1/studio/preview?targetType=tv|group&targetId=<uuid>
POST /api/v1/scenes
POST /api/v1/scenes/:sceneId/revisions
POST /api/v1/scenes/:sceneId/publish
PUT  /api/v1/scene-assignments
POST /api/v1/scene-schedules
POST /api/v1/scene-schedules/:scheduleId/cancel
GET  /api/v1/media
POST /api/v1/media
PATCH /api/v1/media/:assetId
POST /api/v1/messages
GET  /api/v1/tvs
POST /api/v1/tvs/enrollment
POST /api/v1/tvs/:tvId/revoke
POST /api/v1/tvs/:tvId/reenrollment
GET  /api/v1/groups
POST /api/v1/groups
PUT  /api/v1/settings/sources
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
`POST /scenes` crée une nouvelle scène en révision 1 sans la publier.
`GET /studio?sceneId=` charge uniquement son brouillon et son historique.
`PUT /scene-assignments` n’accepte qu’une scène publiée et vérifie l’existence
du groupe ou de la TV avant de remplacer atomiquement l’affectation de cette
cible. L’héritage reste TV, puis groupe, puis instance.

Une programmation exige aussi une scène publiée. Elle accepte une cible
`instance`, `group` ou `tv`, un `startsAt` ISO et un `endsAt` ISO optionnel,
au maximum 366 jours à l’avance. Deux fenêtres actives ou futures d’une même
cible ne peuvent pas se chevaucher. `studio:write` suffit pour l’instance ;
une cible groupe/TV exige en plus `fleet:write`.

Le worker transforme `scheduled` en `active`, puis `active` en `completed`.
Chaque transition qui change réellement la scène incrémente `sync_state` :
une TV qui présente l’ancienne révision reçoit donc le nouveau manifeste au
lieu d’une réponse `upToDate`. À la fin, l’affectation statique reprend
automatiquement. L’annulation conserve l’historique, écrit l’audit et
incrémente aussi la révision si la scène était active.
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
d’une révision numérique et publication. L’aperçu TV/groupe résout côté
serveur la scène publiée et les messages, sources, horaires et éléments de
charte effectivement hérités par cette cible. Il est strictement en lecture
seule dans le Studio et exige à la fois `studio:read` et `fleet:read` ; le
brouillon local reste intact lorsqu’on entre ou sort de l’aperçu.

`PUT /settings/sources` enregistre atomiquement de une à quatre sources pour
une même cible. Les types et les clés de configuration sont fermés ; aucune
configuration HTML ou JavaScript n’est acceptée. La route unitaire
`/settings/sources/:kind` reste disponible. Les règles de puissance conservent
aussi les délais de retour accueil et de veille propres à la cible, avec
héritage des valeurs d’instance lorsqu’aucune surcharge n’existe.

## Enrôlement et synchronisation TV

```text
POST /api/v1/tv/enroll
POST /api/v1/tv/credentials/rotate
POST /api/v1/tv/credentials/confirm
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

La réponse d’enrôlement fournit aussi la génération de credential et sa date
de rotation. La clé brute n’est jamais conservée par l’API : PostgreSQL ne
reçoit que son SHA-256 et Android la chiffre avec une clé non exportable du
Keystore.

Les appels d’un appareil actif utilisent :

```text
x-roomframe-device-id: <UUID de la TV>
x-roomframe-device-key: <clé remise une fois>
```

La rotation est volontairement en deux phases afin de résister à une réponse
HTTP perdue. Les deux requêtes sont fermées par
`contracts/tv-credential.schema.json` :

1. la TV génère localement une nouvelle clé aléatoire, la chiffre dans son
   stockage privé puis appelle `/tv/credentials/rotate` avec son ancienne clé ;
2. le serveur conserve uniquement le hash de la clé en attente pendant
   24 heures et garde l’ancienne clé active ;
3. la TV appelle `/tv/credentials/confirm` avec la nouvelle clé ;
4. le serveur la promeut atomiquement et rend la confirmation idempotente ;
5. la TV promeut ensuite sa copie locale. Si la réponse a été perdue, elle
   peut répéter la confirmation sans perdre l’accès.

Le client tente cette rotation tous les 30 jours et reprend d’abord toute
transition inachevée. `POST /tvs/:tvId/revoke` invalide immédiatement
l’identité sans effacer le cache local de la TV. `POST
/tvs/:tvId/reenrollment` invalide aussi l’ancienne identité et remet une
nouvelle clé temporaire de 30 minutes. Ces deux actions exigent
`fleet:write`, le CSRF de session, une phrase de confirmation exacte et
laissent une trace d’audit.

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
contenu regardé ni appareil personnel n’est collecté. Une mesure valide
actualise aussi la présence de la TV. `GET /studio` expose uniquement sa
dernière mesure et un résumé parc ; l’historique brut reste côté base pour le
diagnostic et la future politique de rétention.

La clé d’appareil rotative reste une étape intermédiaire avant la PKI
individuelle. Les certificats clients et le mTLS doivent encore être finalisés
avant production.

## Releases

```text
GET  /api/v1/releases
POST /api/v1/releases/import
PUT  /api/v1/settings/server-updates
POST /api/v1/releases/:releaseId/server-update-requests
POST /api/v1/releases/:releaseId/deployments
POST /api/v1/deployments/:deploymentId/advance
POST /api/v1/deployments/:deploymentId/retry
GET  /api/v1/tv/update
GET  /api/v1/tv/updates/:deploymentId/apk
POST /api/v1/tv/updates/:deploymentId/status
```

L’import multipart attend un champ `file` portant l’extension `.rfupdate`. Le
serveur vérifie la signature Ed25519, la structure ZIP, la compatibilité, les
tailles et les hashes avant de ranger l’archive dans la quarantaine des
releases. Les clés JSON dupliquées sont refusées avant la validation du
contrat, y compris lorsque le manifeste est correctement signé. Aucun
artefact n’est exécuté par la requête web.

Une release vérifiée qui contient exactement un `server-archive` peut recevoir
une demande d’application serveur. Le corps doit répéter sa version dans
`confirmVersion`. La route exige `releases:write`, une session et CSRF, refuse
une seconde demande active et écrit seulement `server_update_requests` avec
une trace d’audit. Elle ne reçoit jamais de chemin, n’extrait rien et ne lance
ni Docker ni processus root.

Le timer Debian prend au plus une demande, puis la commande root revalide le
fichier quarantainé par son hash et sa signature. `GET /releases` et
`GET /studio` exposent le statut contrôlé `pending`, `running`, `completed`,
`failed` ou `rolled-back`, sans journal système ni chemin interne.

`PUT /settings/server-updates` configure la politique persistante :
`manual` par défaut ou `automatic`, délai minimal après import de 15 minutes à
7 jours, début/fin de fenêtre `HH:MM` et fuseau IANA. Le passage initial en
automatique exige exactement
`ACTIVER LES MISES A JOUR AUTOMATIQUES`, la permission `releases:write`, une
session et CSRF. La réponse expose uniquement la politique normalisée.

En mode automatique, le courtier considère seulement une release dont la
provenance vérifiée est `github`, avec exactement une archive serveur, assez
ancienne et située dans la fenêtre locale. Toute release ayant déjà une
demande dans l’historique est exclue : après un échec ou un rollback, une
décision humaine est obligatoire. Un import multipart manuel n’est jamais
éligible.

`GET /releases` et `GET /studio` exposent également l’état non sensible de la
source automatique : dépôt public, canal, fréquence, dernier contrôle,
dernier résultat et code de refus contrôlé. L’ETag et les chemins de stockage
restent internes. Ils exposent aussi la politique serveur non sensible. Le
poller non privilégié utilise le même importeur que la
route multipart ; une archive déjà présente avec le même identifiant, la même
version et le même hash est reconnue sans créer de doublon.

Une release vérifiée qui contient un `home-apk` peut démarrer un plan `canary`
sur une TV active ou `progressive` sur un groupe ou le parc. La première vague
est offerte immédiatement ; les suivantes sont avancées explicitement après
les retours des TV.

Les trois routes `/tv/update*` exigent l’identité d’appareil et ne donnent
accès qu’à la cible correspondante. L’APK est servi sans cache et les
transitions de statut sont strictes. Un état `installed` dont la version ne
correspond pas à la release est refusé. Une relance administrative remet
explicitement les cibles `failed` ou `deferred` dans la vague active.
L’application du code serveur suit sa file séparée. L’installation silencieuse
Android sans Device Owner n’est pas déduite du statut de vague TV.
