# Modèle de sécurité

## Principes

- aucun secret, certificat d’instance ou mot de passe dans Git ;
- HTTPS obligatoire, avec administration et API de même origine ;
- bootstrap à usage unique puis verrou définitif ;
- Argon2id, MFA TOTP ou passkey WebAuthn, sessions bornées et révocables, CSRF
  et limitation de débit ;
- rôles explicites et journal d’audit ;
- validation stricte des scènes, médias et bundles ;
- moindre privilège des conteneurs et exposition réseau minimale ;
- collecte de télémétrie technique limitée, sans contenu vu ni appareil
  personnel.

La découverte locale publie une annonce DNS-SD minimale et un manifeste HTTPS
signé en ECDSA P-256. Elle ne devient authentifiée qu’avec l’étape suivante :
la CA chiffrée par le ticket doit correspondre à la chaîne TLS observée et à
l’empreinte du manifeste avant tout envoi du secret. WebAuthn, les certificats
individuels TV et le mTLS sont également implémentés. La découverte DNS-SD,
l’appairage de la CA, l’enrôlement et l’activation mTLS ont été observés sur la
Philips Android TV 12 de validation.

## Secrets de l’instance

L’installation crée une fois, sous `/etc/roomframe/secrets/` :

- `postgres_password` ;
- `postgres_migrator_password` ;
- `postgres_runtime_password` ;
- `bootstrap_token` ;
- `session_secret` ;
- `totp_encryption_key` ;
- `weather_api_key` ;
- `discovery_signing_key` ;
- `backup_age_identity`.

Le répertoire est `root:root` en mode `0700`. Les fichiers sont réguliers, non
vides et `root:root`, à l’exception de `weather_api_key`, volontairement vide
tant que le mode d’évaluation Open-Meteo est utilisé. Les secrets montés dans
les conteneurs sont en mode
`0444` ; les identités age et ECDSA de découverte, jamais montées, sont en mode
`0400`. Sur l’hôte, aucun
compte non-root ne peut les
lire puisqu’il ne peut pas traverser le répertoire `0700`. Docker monte ensuite
individuellement et en lecture seule uniquement les secrets autorisés pour
chaque conteneur ; ce mode permet à l’API exécutée sans privilèges de lire son
montage. Les secrets ne transitent jamais dans les variables d’environnement.
Une seconde installation conserve leur contenu. `postgres_password` reste le
secret du compte d’administration local utilisé uniquement par PostgreSQL et
les opérations root. `database-roles` reçoit ce secret le temps de préparer
les rôles. Le conteneur one-shot `migrate` ne reçoit que le secret migrateur ;
l’API, le worker et le poller ne reçoivent que le secret runtime.

La météo suit une séparation réseau dédiée. L’API n’accède jamais directement
à Internet : elle interroge uniquement `weather-gateway` sur le réseau Docker
interne. Cette passerelle n’expose aucun port entrant, ne reçoit aucun secret
RoomFrame et rejoint seule `weather-egress`. Elle ne contacte que les points de
terminaison Open-Meteo fixés dans son code, avec redirections refusées,
temporisation et taille de réponse bornées. En mode commercial, elle reçoit
seulement `weather_api_key` par montage Docker en lecture seule ; la clé ne
transite ni dans `runtime.conf`, ni dans PostgreSQL, ni dans les journaux.

`/etc/roomframe/runtime.conf` contient uniquement les chemins, URL, hôte,
IPv4, version et fuseau nécessaires à Compose.

## Identités administrateur

Les phrases de passe doivent faire entre 12 et 256 caractères, couvrir au
moins trois classes et ne pas commencer par une valeur faible connue. Elles
sont hachées avec Argon2id.

Le secret TOTP est généré aléatoirement, chiffré au repos avec AES-256-GCM et
associé à un défi temporaire. La vérification tolère une fenêtre d’un pas et
refuse la réutilisation d’un compteur déjà accepté.

La connexion habituelle exige le TOTP : six chiffres, période de 30 secondes,
HMAC-SHA-1 conforme au profil interopérable RFC 6238. Un compte ayant enrôlé
une passkey peut choisir à la place le parcours phrase de passe + passkey. Ce
jalon ne propose pas de connexion sans mot de passe.

L’enrôlement ou la révocation d’une passkey exige une session, le CSRF, la
phrase de passe actuelle et un nouveau code TOTP non réutilisé. Les défis
WebAuthn sont aléatoires, liés au compte et, pour l’enrôlement, à la session ;
ils expirent après cinq minutes et ne peuvent être consommés qu’une fois.
L’API exige `userVerification=required`, vérifie exactement l’origine et le
RP ID attendus, conserve uniquement la clé publique et le compteur de
signature puis journalise l’usage. Les clés privées restent dans
l’authenticator choisi par l’utilisateur.

Les passkeys ne fonctionnent volontairement que sur le nom HTTPS principal
configuré. L’URL IP reste un secours pour la connexion TOTP, mais elle ne crée
pas une seconde identité WebAuthn. Les tentatives de connexion sont limitées
à huit par tranche de 15 minutes.

Le jeton initial est lu explicitement avec :

```bash
sudo roomframe-bootstrap-token --show
```

L’API le compare en temps constant. La création du propriétaire, de l’instance
et du seed est transactionnelle ; une seconde tentative reçoit un conflit.

## Invitations et rôles administrateur

Seul un propriétaire peut créer, réinviter, désactiver ou modifier le rôle
d’un autre compte. L’invitation est une valeur aléatoire de 32 octets, affichée
une seule fois, valable 24 heures et stockée uniquement sous forme SHA-256.
RoomFrame ne crée jamais de mot de passe temporaire.

La personne invitée choisit sa propre phrase de passe et enrôle TOTP au moyen
d’un défi chiffré valable 15 minutes. L’activation est transactionnelle :
l’invitation et le défi sont consommés avec le nouveau hash Argon2id, le secret
TOTP chiffré et la première session. Un jeton utilisé, révoqué ou expiré ne
peut pas être rejoué.

Les mutations sensibles exigent une session active, le CSRF, la phrase de
passe courante du propriétaire et un code TOTP frais. Un changement de rôle
révoque immédiatement toutes les sessions du compte concerné. Une
désactivation ou une réinvitation supprime également ses passkeys et défis
WebAuthn, puis invalide ses invitations précédentes.

La cible ne peut pas être le compte courant. Un verrou advisory PostgreSQL
sérialise les mutations de propriétaires et la transaction refuse toute
opération qui laisserait l’instance sans propriétaire actif. Les rôles
disponibles appartiennent à une liste fermée ; les rôles contenu, parc et
sécurité ne peuvent ni provisionner un compte ni s’accorder davantage de
droits.

## Sessions, permissions et audit

Les jetons de session ne sont stockés qu’après HMAC. Le cookie
`__Host-roomframe_session` est `Secure`, `HttpOnly`, `SameSite=Strict`, sans
attribut Domain et limité au chemin `/`. La durée par défaut est 12 heures.

Les écritures exigent :

1. une session active ;
2. la permission correspondant à la route ;
3. un `x-csrf-token` lié à la session ;
4. une origine égale au FQDN ou à l’URL IP de secours lorsqu’un en-tête Origin
   est présent.

Les rôles initiaux séparent propriétaire, contenu et sécurité. Les lectures
agrégées du Studio retirent les collections auxquelles le rôle n’a pas droit.
Les actions sensibles produisent un événement dans `audit_log`.

Le Studio liste au maximum les 50 sessions actives du compte courant avec leur
date, expiration, adresse distante et agent utilisateur borné. Le compte peut
fermer une session précise ou toutes les autres ; fermer la session courante
supprime aussi immédiatement son cookie.

## Récupération locale

```bash
sudo roomframe-recover-admin --create
```

La commande exige root, génère un jeton aléatoire et n’écrit que son SHA-256,
sa date et son expiration. L’API crée aussi une autorité one-shot verrouillée
en base, lie le défi TOTP au compte demandé, puis :

- remplace le hash du mot de passe et le secret TOTP ;
- révoque toutes les sessions du compte ;
- supprime toutes les passkeys et tous les défis WebAuthn du compte ;
- consomme le défi et l’autorité ;
- journalise la récupération.

Le répertoire de demande est monté en lecture seule dans l’API. La tentative
de marquage du fichier reste best effort, mais la consommation autoritative en
base empêche le rejeu même lorsque le fichier root-owned reste inchangé.

## HTTPS et navigateur

Caddy crée une autorité locale. Sa racine est distribuée par un canal
administré ou épinglée pendant l’enrôlement TV.

Les en-têtes incluent HSTS, `nosniff`, refus des frames, politique de
référent, Permissions Policy et une CSP restrictive. Les scripts et feuilles
de style doivent être des fichiers locaux ; la CSP n’autorise ni code inline,
ni objet, ni frame, ni base externe. Les aperçus contrôlés peuvent utiliser
`blob:` et certaines images `data:`. La Permissions Policy autorise
explicitement la création et l’utilisation de credentials WebAuthn uniquement
sur la même origine.

`scripts/check.sh` refuse les scripts, styles et attributs de style inline dans
les deux interfaces.

La page de connexion configurée affiche seulement l’identité visuelle publique
bornée de l’instance. Elle ne présente plus le FQDN, l’IPv4, les détails TLS ou
la topologie réseau. Le logo authentifié reste protégé par les mêmes règles de
téléchargement média que le Studio.

## TV et données

Le code d’installation et la clé longue correspondante expirent après 30
minutes et ne peuvent pas synchroniser. La clé longue est échangée atomiquement
contre une clé d’appareil remise une fois. Seuls leurs identifiants SHA-256
contextuels sont stockés.

Avant cet échange, le serveur chiffre dans une enveloppe AES-256-GCM sa CA
HTTPS publique, l’UUID et la clé longue. La clé AES est dérivée par
HKDF-SHA256 depuis le code numérique de 16 chiffres (environ 53,15 bits) et un
sel propre au ticket. Le ticket expire après 30 minutes et le bootstrap est
limité à 10 essais par adresse IP toutes les 15 minutes. La TV ne
transmet que l’identifiant SHA-256 du code, déchiffre l’enveloppe localement,
puis vérifie que la chaîne TLS réellement rencontrée aboutit à cette CA et que
le nom ou l’IP correspond à l’URL saisie. Elle épingle ensuite la CA avant la
première requête contenant la clé longue. Un relais qui substitue son
certificat peut relayer le blob, mais il ne connaît pas le code, ne peut pas le
modifier et ne peut pas faire valider sa propre chaîne. L’enveloppe historique
dérivée directement de la clé longue reste disponible uniquement pour les APK
déjà déployées.

La copie publique montée dans l’API est
`/var/lib/roomframe/pki/server-ca/ca.crt`. Elle est synchronisée depuis les
données Caddy par une commande root ; aucune clé privée Caddy n’est montée
dans l’API. Le blob est effacé atomiquement dès que le ticket est consommé.

Les téléchargements d’une TV sont limités aux assets de sa scène. Les
métriques et événements acceptent des champs et types fermés, des tailles
bornées et une rétention de 90 jours par défaut.

Lors de l’enrôlement, l’APK génère une clé RSA 2048 bits dans Android Keystore.
La clé privée n’est pas exportable. La TV envoie seulement sa clé publique SPKI
et une signature de la clé d’enrôlement et de son UUID. L’API vérifie cette
preuve de possession puis crée une demande en base.

Le courtier `roomframe-tv-certificate-broker` est un processus systemd root
sans port entrant. Il prend une demande à la fois, utilise la CA persistante
sous `/var/lib/roomframe/pki/tv-client-ca/`, émet un certificat de 90 jours
avec EKU `clientAuth` et SAN `urn:roomframe:tv:<UUID>`, puis remet uniquement
le certificat public à PostgreSQL. La clé privée de la CA n’est montée dans
aucun conteneur. L’API, le worker et Caddy ne peuvent pas la lire.

Caddy utilise `verify_if_given` car le navigateur d’administration et les TV
partagent volontairement la même origine TLS. Il remplace tout en-tête
d’attestation reçu du LAN par l’empreinte SHA-256 du certificat qu’il a
réellement vérifié contre la CA TV. Le remplacement doit rester une unique
opération Caddy : une suppression configurée en parallèle serait appliquée
après le remplacement et effacerait l’attestation. L’API exige ensuite que
cette empreinte appartienne à l’UUID et à la clé rotative présentés. Après
activation par la TV, une requête sans le certificat individuel est refusée.

Le renouvellement commence 30 jours avant l’expiration et conserve l’ancien
certificat actif jusqu’à la confirmation du nouveau. La révocation
administrative invalide l’identité dans l’API même si le certificat peut
encore terminer une négociation TLS avec la CA : aucune autorisation ni donnée
TV n’est accordée après ce handshake.

Les programmations de scènes n’acceptent qu’un UUID de scène déjà publiée, une
cible existante et des timestamps ISO bornés. Elles n’embarquent ni commande,
ni HTML, ni script. Les cibles groupe/TV exigent `fleet:write` en plus de
`studio:write`, les chevauchements sont refusés sous verrou et toute création,
transition ou annulation laisse une trace d’audit. Le worker ne modifie que le
statut fermé de la programmation et la révision de synchronisation.

Limite restante avant production :

- pas encore de CRL distribuée à Caddy ; la révocation est autoritative dans
  l’API après la validation cryptographique du handshake.

Les clés bearer actuelles ont néanmoins un cycle complet : génération locale
aléatoire, stockage chiffré Android, rotation automatique tous les 30 jours,
promotion serveur en deux phases, révocation administrateur et réenrôlement
one-shot. L’ancienne clé reste valide seulement jusqu’à la confirmation de la
nouvelle ; une confirmation répétée est idempotente afin qu’une coupure réseau
ne bloque pas définitivement la TV. PostgreSQL et l’audit ne reçoivent jamais
la valeur brute d’une clé active ou en attente.

Révoquer ou réenrôler exige `fleet:write`, une session, le CSRF et une phrase
de confirmation exacte. La révocation remplace le hash actif par un tombstone
aléatoire non divulgué, efface toute rotation en attente et conserve
l’historique. Elle ne prétend pas effacer le cache local de la TV : ce cache
reste nécessaire au fonctionnement hors ligne et cesse seulement de se
synchroniser.

La suppression définitive d’une fiche TV exige une seconde action explicite,
la même permission, le CSRF et la phrase exacte `SUPPRIMER LA TV`. L’API la
refuse tant que la TV n’est pas déjà révoquée, ainsi que pour le simulateur.
Elle retire la fiche, ses certificats, mesures, déploiements directs et réglages
ciblés afin de ne laisser aucune cible orpheline. Le journal d’audit append-only
conserve néanmoins la trace de la suppression, sans secret ni clé brute.

## Conteneurs et base

- seul Caddy publie un port applicatif TCP (`443`) ; Avahi peut publier
  l’annonce DNS-SD minimale sur `5353/udp` ;
- PostgreSQL reste sur le réseau Docker interne ;
- `roomframe_owner` ne peut pas se connecter ; `roomframe_migrator` peut
  prendre ce rôle uniquement dans le conteneur de migration one-shot ;
  `roomframe_runtime` possède les droits de données nécessaires mais aucun
  droit de création de base, schéma, table ou table temporaire ;
- l’historique `schema_migrations` est explicitement refusé au runtime et la
  table RLS des cibles de déploiement possède une politique limitée à ce rôle ;
- l’installateur crée le compte système Debian `roomframe`, sans home ni shell
  de connexion ; l’API, le worker et le poller utilisent son UID/GID explicite ;
- API, worker média et poller d’updates utilisent une racine en lecture seule,
  des `tmpfs` bornés,
  `no-new-privileges`, aucune capacité Linux et des limites CPU/mémoire/PID ;
- le répertoire de récupération et le magasin de clés publiques sont montés en
  lecture seule dans l’API ;
- les volumes écrits sont limités à leurs responsabilités ;
- le code installé appartient à root et n’est pas modifiable par groupe ou
  autres utilisateurs.

Les images externes Caddy et PostgreSQL sont verrouillées par digest dans
Compose. L’image API est construite depuis une image Node elle aussi verrouillée
par digest et des dépendances npm issues du lockfile. Un changement amont ne
peut donc pas remplacer silencieusement ces bases sous le même tag.

Le rôle PostgreSQL historique `roomframe` reste limité aux opérations locales
root et à l’initialisation du cluster. Les migrations applicatives utilisent
désormais exclusivement le rôle one-shot `roomframe_migrator`, après la
sauvegarde effectuée par l’installateur lors d’une mise à niveau existante.

## Médias et updates

Les médias sont typés d’après leurs octets, stockés par hash, traités hors
requête et servis seulement depuis des variantes produites. SVG, HTML et
JavaScript libre sont refusés.

Les `.rfupdate` exigent une signature Ed25519 et une clé publique approuvée.
La clé privée reste hors du dépôt et du serveur. La requête d’import ne fait
qu’une vérification et une mise en quarantaine ; elle n’exécute ni shell, ni
migration, ni image. Le vérificateur CLI et le vérificateur Node de l’API
refusent tous deux les clés JSON dupliquées avant validation du contrat. Un
SBOM SPDX est lui-même listé et hashé dans le manifeste signé ; son package
racine doit porter la version et le SHA-256 de l’unique archive serveur.

Le poller GitHub ne change pas cette frontière : il interroge uniquement le
dépôt `owner/repo` validé, utilise l’API GitHub versionnée et un ETag, refuse
les brouillons, exige un unique asset `.rfupdate`, borne sa taille et contrôle
son éventuel digest SHA-256. Le téléchargement part de l’URL d’asset de
`api.github.com`; les redirections HTTPS sont limitées à GitHub et à ses hôtes
de contenu. Le poller n’a ni port entrant, ni secret de session/TOTP, ni accès
à Docker. Après téléchargement, le même vérificateur Ed25519 que l’import
manuel décide de l’acceptation. Aucun artefact serveur n’est exécuté.
Un import provenant de GitHub est refusé si le dépôt ou le tag observé ne
correspond pas au dépôt et à la ref inscrits dans les octets signés, ou si le
SBOM SPDX est absent. Le SHA source est lui aussi signé et publié dans le SBOM ;
sa correspondance avec l’exécution GitHub est vérifiable par l’attestation
publique du workflow, pas en résolvant le tag depuis le poller local. Les imports
hors ligne restent possibles avec la seule chaîne de confiance Ed25519 locale.

Les réseaux Docker séparent aussi les chemins : l’API ne rejoint que
`frontend` et `backend`, tous deux internes ; Caddy porte seul le réseau
`ingress` publié, tandis que le poller porte seul `update-egress`.

Une clé publique est approuvée uniquement après contrôle d’empreinte :

```bash
sudo roomframe-trust-update-key \
  --key-id release-main \
  --public-key /chemin/release-main.pem \
  --sha256 EMPREINTE_SHA256
```

Le workflow de signature utilise l’environnement GitHub
`release-signing`. Cet environnement doit conserver ses règles de protection
et approbateurs ; le job de vérification non privilégié n’a pas accès à la clé
et le job de packaging reçoit ses permissions de publication seulement après
validation. GitHub/Sigstore atteste en plus la provenance SLSA et le SBOM avec
une identité OIDC éphémère. Cette attestation publique ne remplace jamais la
clé Ed25519 RoomFrame approuvée explicitement par l’instance.

Pour un artefact APK, le manifeste signé lie aussi le package, le
`versionCode` et l’empreinte du certificat Android. La TV télécharge dans son
répertoire privé, recalcule le hash, lit les métadonnées de l’archive avec
`PackageManager`, puis compare le certificat à la lignée de signature de
l’application installée avant tout appel à `PackageInstaller`.

La clé d’appareil conservée par l’APK est chiffrée en AES-256-GCM avec une clé
non exportable de l’Android Keystore. L’origine HTTPS, l’identifiant de la TV
et le rôle actif/en attente sont liés comme données authentifiées. Le lecteur
reste compatible avec les credentials 0.3.0/0.3.1, puis les réécrit dans la
nouvelle enveloppe lors de la première rotation. Cette protection locale et la
rotation sont complétées par une seconde clé RSA non exportable, distincte de
l’enveloppe AES. Elle porte le certificat mTLS et autorise PKCS#1 et RSA-PSS.
La politique Android Keystore autorise aussi le digest `NONE` et le padding
RSA brut `NONE` : Conscrypt pré-hache la transcription TLS puis délègue cette
opération privée au Keystore. Ces autorisations servent uniquement à la
signature TLS et ne rendent jamais la clé exportable.

## Sauvegardes

`roomframe-backup` chiffre en flux avec `age` le dump PostgreSQL, l’archive de
configuration/PKI et l’archive des données, puis lie les trois payloads et les
métadonnées publiques par `SHA256SUMS`. Les nouveaux formats ne conservent donc
aucune copie finale du dump, des secrets ou de la PKI en clair.

L’identité X25519 est générée une seule fois, root-only en mode `0400`, hors du
dépôt. Le trousseau local indexé par l’empreinte du destinataire conserve les
identités antérieures sans les inclure dans les données restaurées. Il protège
le point de retour lorsqu’une restauration remplace la configuration active.
Il ne remplace pas la reprise après désastre : `roomframe-backup-key
--export-identity` doit déposer une copie privée `0600` sur un support hors
ligne contrôlé, sans jamais écraser une destination.

`roomframe-verify-backup --latest`, exécutable uniquement par root, refuse les
liens, entrées inattendues, permissions trop ouvertes, identité ne
correspondant pas au destinataire, payload altéré, archive dangereuse et
checksum invalide. Les fichiers sont déchiffrés dans un staging root-only
éphémère. Le dump est réellement restauré dans un conteneur PostgreSQL avec
`--network none`. Un rôle runtime sans login y est créé uniquement pour
restaurer les politiques RLS référencées par le dump ; aucune donnée de
production n’est écrite ou remplacée.

Les timers quotidien et hebdomadaire ne prunent qu’après vérification réussie
du nouveau point. La rétention est bornée par classe et ignore tout point
manuel, pré-migration ou de sécurité.

`roomframe-restore` partage le verrou de maintenance avec l’installateur et les
sauvegardes. Il exige un enfant direct du répertoire de sauvegardes et une
confirmation égale à son identifiant ; `--latest` est refusé. Il impose une
sauvegarde complète de la même version, contrôle strictement les racines des
archives et le `runtime.conf`, puis crée et vérifie un point de retour avant
toute bascule. PostgreSQL est restauré dans une base temporaire et renommé
seulement après contrôle d’intégrité. Un échec de démarrage ou de HTTPS
réactive automatiquement la configuration, les données et la base précédentes.

`roomframe-apply-update` partage ce même verrou et n’accepte qu’un UUID de
release déjà importée accompagné d’une confirmation de version. Il exige le
chemin par hash sous `releases/verified`, recalcule le SHA-256 et revalide la
signature Ed25519 avant toute extraction. L’archive serveur est extraite sans
liens, périphériques ni traversée, dans un staging root-only placé sur le même
système de fichiers que le code. La commande préconstruit, sauvegarde, vérifie
le point de retour puis bascule. L’API, le worker et le poller ne possèdent ni
socket Docker, ni mécanisme sudo permettant de lancer cette commande.

Le courtier systemd n’est pas un serveur réseau. L’API écrit une demande
strictement typée en base après permission `releases:write`, CSRF et
confirmation exacte de version. L’unité root prend une seule demande sous
verrou, puis appelle le moteur avec l’UUID ; elle n’accepte aucun argument
HTTP, chemin ou clé. Une API compromise pourrait demander l’application d’une
release déjà signée et importée, mais ne pourrait ni fournir un autre fichier,
ni choisir une clé privée, ni contourner la revalidation/downgrade, ni obtenir
un shell root. Les actions demandées, démarrées, terminées ou annulées par
rollback restent dans l’audit.

La politique automatique est désactivée par défaut et son activation initiale
exige une seconde confirmation textuelle. Même activée, la sélection root
refuse les imports manuels, les releases trop récentes, celles hors fenêtre et
toute version déjà tentée. Elle exige aussi que la source signée enregistrée
soit identique à celle du manifeste et qu’un SBOM SPDX ait été validé ; les
anciens imports GitHub sans cette preuve ne sont pas promus automatiquement.
La provenance GitHub est enregistrée par l’importeur après la vérification
complète du bundle ; elle n’est jamais acceptée depuis un corps HTTP
d’administration. Modifier la politique ne donne à l’API ni Docker, ni sudo,
ni accès en écriture au magasin de clés.
