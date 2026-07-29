# Modèle de sécurité

## Principes

- aucun secret, certificat d’instance ou mot de passe dans Git ;
- HTTPS obligatoire, avec administration et API de même origine ;
- bootstrap à usage unique puis verrou définitif ;
- Argon2id, MFA TOTP, sessions bornées, CSRF et limitation de débit ;
- rôles explicites et journal d’audit ;
- validation stricte des scènes, médias et bundles ;
- moindre privilège des conteneurs et exposition réseau minimale ;
- collecte de télémétrie technique limitée, sans contenu vu ni appareil
  personnel.

WebAuthn et la découverte locale authentifiée restent des étapes à venir. Les
certificats individuels TV et le mTLS sont implémentés ; leur fonctionnement
avec le firmware Philips reste à observer sur le matériel réel.

## Secrets de l’instance

L’installation crée une fois, sous `/etc/roomframe/secrets/` :

- `postgres_password` ;
- `postgres_migrator_password` ;
- `postgres_runtime_password` ;
- `bootstrap_token` ;
- `session_secret` ;
- `totp_encryption_key`.

Le répertoire est `root:root` en mode `0700`. Les fichiers sont réguliers, non
vides, `root:root` en mode `0444`. Sur l’hôte, aucun compte non-root ne peut les
lire puisqu’il ne peut pas traverser le répertoire `0700`. Docker monte ensuite
individuellement et en lecture seule uniquement les secrets autorisés pour
chaque conteneur ; ce mode permet à l’API exécutée sans privilèges de lire son
montage. Les secrets ne transitent jamais dans les variables d’environnement.
Une seconde installation conserve leur contenu. `postgres_password` reste le
secret du compte d’administration local utilisé uniquement par PostgreSQL et
les opérations root. `database-roles` reçoit ce secret le temps de préparer
les rôles. Le conteneur one-shot `migrate` ne reçoit que le secret migrateur ;
l’API, le worker et le poller ne reçoivent que le secret runtime.

`/etc/roomframe/runtime.conf` contient uniquement les chemins, URL, hôte,
IPv4, version et fuseau nécessaires à Compose.

## Identités administrateur

Les phrases de passe doivent faire entre 12 et 256 caractères, couvrir au
moins trois classes et ne pas commencer par une valeur faible connue. Elles
sont hachées avec Argon2id.

Le secret TOTP est généré aléatoirement, chiffré au repos avec AES-256-GCM et
associé à un défi temporaire. La vérification tolère une fenêtre d’un pas et
refuse la réutilisation d’un compteur déjà accepté.

Le TOTP est obligatoire à chaque connexion : six chiffres, période de
30 secondes, HMAC-SHA-1 conforme au profil interopérable RFC 6238. Les
tentatives de connexion sont limitées à huit par tranche de 15 minutes. Ce
facteur protège notamment contre la réutilisation isolée d’une phrase de
passe, mais ne doit pas être présenté comme résistant au phishing. WebAuthn et
les passkeys restent l’étape prévue pour cette propriété.

Le jeton initial est lu explicitement avec :

```bash
sudo roomframe-bootstrap-token --show
```

L’API le compare en temps constant. La création du propriétaire, de l’instance
et du seed est transactionnelle ; une seconde tentative reçoit un conflit.

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

## Récupération locale

```bash
sudo roomframe-recover-admin --create
```

La commande exige root, génère un jeton aléatoire et n’écrit que son SHA-256,
sa date et son expiration. L’API crée aussi une autorité one-shot verrouillée
en base, lie le défi TOTP au compte demandé, puis :

- remplace le hash du mot de passe et le secret TOTP ;
- révoque toutes les sessions du compte ;
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
`blob:` et certaines images `data:`.

`scripts/check.sh` refuse les scripts, styles et attributs de style inline dans
les deux interfaces.

La page de connexion configurée affiche seulement l’identité visuelle publique
bornée de l’instance. Elle ne présente plus le FQDN, l’IPv4, les détails TLS ou
la topologie réseau. Le logo authentifié reste protégé par les mêmes règles de
téléchargement média que le Studio.

## TV et données

La clé d’enrôlement expire après 30 minutes et ne peut pas synchroniser. Elle
est échangée atomiquement contre une clé d’appareil remise une fois. Seul son
SHA-256 est stocké.

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
partagent volontairement la même origine TLS. Il supprime tout en-tête
d’empreinte reçu du LAN et transmet seulement l’empreinte SHA-256 d’un
certificat réellement vérifié contre la CA TV. L’API exige ensuite que cette
empreinte appartienne à l’UUID et à la clé rotative présentés. Après activation
par la TV, une requête sans le certificat individuel est refusée.

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

Limites avant production :

- découverte locale authentifiée non implémentée ;
- activation Android Keystore/mTLS non encore observée sur la Philips ;
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

## Conteneurs et base

- seul Caddy publie `443/tcp` ;
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
refusent tous deux les clés JSON dupliquées avant validation du contrat.

Le poller GitHub ne change pas cette frontière : il interroge uniquement le
dépôt `owner/repo` validé, utilise l’API GitHub versionnée et un ETag, refuse
les brouillons, exige un unique asset `.rfupdate`, borne sa taille et contrôle
son éventuel digest SHA-256. Le téléchargement part de l’URL d’asset de
`api.github.com`; les redirections HTTPS sont limitées à GitHub et à ses hôtes
de contenu. Le poller n’a ni port entrant, ni secret de session/TOTP, ni accès
à Docker. Après téléchargement, le même vérificateur Ed25519 que l’import
manuel décide de l’acceptation. Aucun artefact serveur n’est exécuté.

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
et le job de packaging reçoit `contents: write` seulement après validation.

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
l’enveloppe AES. Elle porte le certificat mTLS et autorise PKCS#1 et RSA-PSS
pour rester compatible avec TLS 1.2 et TLS 1.3.

## Sauvegardes

`roomframe-backup` produit un dump PostgreSQL et des archives avec
`SHA256SUMS`. Une sauvegarde contient la configuration et la PKI : elle doit
être protégée comme un secret, déplacée vers un stockage sûr et chiffrée selon
la politique de l’organisation.

`roomframe-verify-backup --latest`, exécutable uniquement par root, refuse les
liens, entrées inattendues, permissions trop ouvertes, archives dangereuses et
checksums invalides. Le dump est réellement restauré dans un conteneur
PostgreSQL éphémère avec `--network none`. Un rôle runtime sans login y est
créé uniquement pour restaurer les politiques RLS référencées par le dump ;
aucune donnée de production n’est écrite ou remplacée.

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
toute version déjà tentée. La provenance GitHub est enregistrée par
l’importeur après la vérification complète du bundle ; elle n’est jamais
acceptée depuis un corps HTTP d’administration. Modifier la politique ne donne
à l’API ni Docker, ni sudo, ni accès en écriture au magasin de clés.
