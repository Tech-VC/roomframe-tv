# RoomFrame TV

RoomFrame TV est une solution open source et **local-first** pour transformer
une Google TV ou Android TV en portail d’accueil personnalisable. Le serveur,
l’administration et les téléviseurs continuent de servir l’expérience locale
sans dépendre d’un service cloud.

Le dépôt public est volontairement neutre. L’organisation, le domaine local,
les salles, les comptes, les médias, les certificats et les règles sont créés
sur chaque instance après l’installation.

> État actuel : le jalon `0.3.0` est exécutable avec PostgreSQL, bootstrap à
> usage unique, TOTP, passkeys WebAuthn, sessions révocables, Studio relié à
> l’API, pipeline média,
> synchronisation TV et vérification des mises à jour signées. Le simulateur
> et le client Android conservent la dernière révision valide hors ligne ; le
> client natif rend la scène sans WebView et contrôle les APK distribués par
> vagues. Un poller non privilégié peut aussi importer automatiquement une
> release GitHub signée. Les TV génèrent aussi une clé TLS non exportable,
> appairent la CA HTTPS de l’instance sans envoyer leur secret sur une
> connexion non vérifiée, reçoivent un certificat individuel via un courtier
> root isolé et utilisent ensuite mTLS en plus de leur clé rotative. Device Owner,
> installation silencieuse, HDMI, veille/réveil, Cast et AirPlay restent à
> valider.

## Installation Debian

Le CT, la VM ou le serveur Debian doit déjà posséder son IPv4, son masque, sa
passerelle et ses DNS. RoomFrame lit cet état, mais ne modifie jamais le réseau
de l’hôte.

Depuis le dépôt public :

```bash
git clone --depth 1 https://github.com/Tech-VC/roomframe-tv.git
cd roomframe-tv
sudo ./install.sh
```

Pour imposer le nom HTTPS :

```bash
sudo ./install.sh --host roomframe.example.local
```

Une release publiée fournit aussi un installateur autonome en une commande.
Celui-ci vérifie le SHA-256 de l’archive avant de l’extraire :

```bash
curl -fsSL https://github.com/Tech-VC/roomframe-tv/releases/latest/download/roomframe-install.sh \
  | sudo bash
```

Sans `--host`, l’installateur utilise
`roomframe.<suffixe-DNS-détecté>`, puis l’IPv4 principale si aucun suffixe
valide n’est disponible. Il ne bloque pas lorsque le DNS n’est pas encore
créé : l’URL par IP reste disponible et l’enregistrement A à ajouter est
affiché.

La fin d’une installation démarrée affiche notamment :

```text
Tout est prêt.
Interface d’administration : https://roomframe.example.local
API locale TV             : https://roomframe.example.local/api
URL de secours par IP     : https://192.0.2.20
Simulateur TV             : https://roomframe.example.local/simulator/
```

L’administration sur `/` et l’API sur `/api/` partagent une seule origine
HTTPS. Caddy est le seul service publié sur le LAN.

Voir [docs/INSTALLATION.md](docs/INSTALLATION.md) et
[docs/NETWORKING.md](docs/NETWORKING.md).

## Première configuration

Le jeton initial n’est pas affiché automatiquement par l’installateur. Il se
lit explicitement sur la console locale :

```bash
sudo roomframe-bootstrap-token --show
```

Le bootstrap crée une seule instance et un premier propriétaire :

- mot de passe haché avec Argon2id ;
- enrôlement TOTP puis validation d’un premier code ;
- ajout ultérieur de passkeys depuis le nom HTTPS principal, avec confirmation
  par phrase de passe et nouveau code TOTP ;
- cookie de session sécurisé et protection CSRF ;
- chargement du bundle neutre seulement si la base est vide ;
- verrouillage définitif du bootstrap après succès.

L’assistant applicatif ne demande jamais l’IP, le masque, la passerelle ou les
DNS du serveur. Une procédure de récupération root-only, valable 15 minutes
par défaut, est disponible :

```bash
sudo roomframe-recover-admin --create
```

Voir [docs/SECURITY.md](docs/SECURITY.md) et [docs/API.md](docs/API.md).

## Fonctions réellement présentes dans le jalon

- migrations PostgreSQL additives avec checksum et verrou advisory, exécutées
  par un rôle dédié avant le démarrage des services applicatifs ;
- modèles instance, utilisateurs, rôles, sessions, groupes, TV, scènes,
  révisions, médias, messages, horaires, métriques, événements, releases,
  déploiements et audit ;
- connexion au choix par phrase de passe + TOTP ou phrase de passe + passkey
  avec vérification utilisateur, défis éphémères en base, compteur de signature,
  liste des passkeys et révocation des sessions actives ;
- révisions de scène immuables et publication transactionnelle ;
- Studio de régie relié aux flux réels de bootstrap, session, scènes, médias,
  messages et releases, avec glisser-déposer, redimensionnement, calques,
  propriétés, clavier et historique ;
- règles AirPlay, Cast, HDMI, application privée, retour accueil et horaires
  configurables par instance, groupe ou TV sans prétendre exécuter le matériel ;
- bibliothèque de scènes, copie de brouillon et affectation publiée par
  instance, groupe ou TV avec aperçu résolu ;
- programmation temporaire d’une scène par instance, groupe ou TV, avec refus
  des chevauchements, activation/retour par le worker et révision TV à chaque
  transition effective ;
- validation des scènes typées 1920 × 1080, sans HTML ni JavaScript libre ;
- upload image/vidéo avec contrôle du type réel, stockage par SHA-256 et
  traitement asynchrone par Sharp/FFmpeg, dont une variante transparente
  prudente pour les logos sur fond clair uniforme ;
- enrôlement TV à clé temporaire, clé TLS RSA non exportable dans Android
  Keystore, appairage chiffré de la CA HTTPS, certificat client individuel,
  mTLS, rotation automatique à deux phases, renouvellement, révocation et
  réenrôlement administrés ;
- découverte locale DNS-SD `_roomframe._tcp` sans balayage, manifeste HTTPS
  ECDSA P-256 signé et validation finale de la CA liée au ticket, avec saisie
  manuelle du FQDN ou de l’IP toujours disponible ;
- synchronisation par révision avec hashes des documents et médias ;
- simulateur IndexedDB : staging vérifié, activation transactionnelle,
  révision précédente conservée et interrupteur de coupure API ;
- import `.rfupdate` avec validation Ed25519, compatibilité, chemins, tailles,
  hashes, source Git signée et SBOM SPDX 2.3 embarqué, puis quarantaine ;
- découverte GitHub `stable` ou `preview`, ETag, téléchargement borné,
  redirections GitHub contrôlées et import automatique idempotent sans
  exécution de l’artefact ;
- application root explicite d’une archive serveur : nouvelle vérification
  Ed25519, staging, préconstruction, sauvegarde vérifiée, bascule du code et
  retour automatique au code précédent sur healthcheck négatif ;
- mise en file depuis le Studio via PostgreSQL et courtier systemd root, sans
  monter Docker dans l’API ni lui donner sudo ;
- politique serveur manuelle par défaut, avec opt-in explicite pour appliquer
  uniquement les imports GitHub signés après délai et dans une fenêtre de
  maintenance ; un échec n’est jamais relancé automatiquement ;
- distribution d’APK par canari ou vagues progressives avec état par TV ;
- état du parc alimenté par la dernière télémétrie technique autorisée, sans
  contenu consulté ni identifiant d’appareil personnel ;
- accueil Android natif, cache atomique, synchronisation HTTPS, enrôlement et
  contrôle de l’APK avant `PackageInstaller` ;
- diagnostic, sauvegarde `age` chiffrée avant migration, cycles quotidien et
  hebdomadaire vérifiés, et restauration complète avec point de retour
  automatique.

## Exploitation

Les commandes installées sont :

```bash
sudo roomframe-compose ps
sudo roomframe-compose logs --tail=200 api worker update-poller
sudo roomframe-diagnose
sudo roomframe-backup
sudo roomframe-backup --without-media
sudo roomframe-backup-key --export-identity \
  /chemin/hors-ligne/roomframe-backup.agekey
sudo roomframe-verify-backup --latest
sudo roomframe-restore \
  /var/lib/roomframe/backups/20260101T120000Z \
  --confirm 20260101T120000Z
sudo roomframe-apply-update \
  --release-id 00000000-0000-4000-8000-000000000000 \
  --confirm 0.3.1
sudo roomframe-trust-update-key --key-id release-main \
  --public-key /chemin/release-main.pem \
  --sha256 EMPREINTE_SHA256
sudo roomframe-trust-update-key --revoke --key-id release-main \
  --sha256 EMPREINTE_SHA256
sudo roomframe-sync-server-ca
sudo roomframe-refresh-discovery
sudo systemctl status roomframe-tv-certificate-broker.timer
sudo systemctl status roomframe-backup-daily.timer
sudo systemctl status roomframe-backup-weekly.timer
```

Les nouvelles sauvegardes ne déposent jamais le dump, la configuration ou la
PKI en clair : chaque payload est chiffré en flux vers l’identité `age`
root-only de l’instance. L’identité doit être exportée une fois hors ligne pour
permettre une reprise après perte totale du serveur. La planification conserve
par défaut 14 sauvegardes quotidiennes sans médias et 4 sauvegardes
hebdomadaires complètes ; elle ne supprime jamais un point manuel ou
pré-migration.

Les données sont séparées du code :

```text
/opt/roomframe/                      code installé
/etc/roomframe/                      configuration et secrets root-only
/var/lib/roomframe/app/             état applicatif
/var/lib/roomframe/postgres/        base PostgreSQL
/var/lib/roomframe/media/           originaux privés et variantes
/var/lib/roomframe/processing/      file de traitement
/var/lib/roomframe/pki/             PKI locale, dont clés privées root-only
/var/lib/roomframe/releases/        mises à jour vérifiées
/var/lib/roomframe/backups/         sauvegardes age chiffrées
/var/lib/roomframe/backup-keyring/  anciennes identités de reprise root-only
/var/lib/roomframe/seed/            expérience initiale figée
```

Une seconde exécution de `install.sh` conserve les secrets et les données. Si
une base existe, l’installateur exige et lance une sauvegarde avant de recopier
le code. `roomframe-restore` exige un identifiant explicite, vérifie deux fois
les données avant la bascule, restaure PostgreSQL par changement de base et
revient automatiquement au point de sécurité si le healthcheck échoue.

## Développement et tests

Node.js 22.12 ou plus récent, Python 3 et Docker sont utilisés par les checks :

```bash
./scripts/check.sh
./scripts/test.sh
./scripts/test-supply-chain.sh
```

Sur un clone frais, `scripts/test.sh` installe les dépendances verrouillées,
puis démarre automatiquement un PostgreSQL 17 éphémère lorsqu’un serveur de
test n’est pas fourni. Il y provisionne les rôles propriétaire, migration et
runtime, puis vérifie que le runtime ne possède aucun droit DDL. Il exécute
27 tests Studio/synchronisation TV et
25 tests API, contrôle de syntaxe serveur inclus, soit 52 tests. Les workflows
GitHub de validation et de release ajoutent trois scénarios root dédiés au
chiffrement, à la rétention, au trousseau et à la restauration PostgreSQL
isolée d’une sauvegarde, ainsi qu’à la découverte locale signée, plus un test
non privilégié du SBOM et de la provenance. Les scénarios
couvrent notamment le bootstrap concurrent, Argon2id/TOTP, les sessions et permissions,
WebAuthn avec signatures réelles, CSRF, les révisions, l’enrôlement TV, le seed
unique, la récupération locale,
les invitations administrateur one-shot, l’activation TOTP sans mot de passe
temporaire, la révocation de session et la protection du dernier propriétaire,
la compatibilité des scènes UI, le rejet concis des réponses API non JSON,
la stabilité des formulaires asynchrones, le détourage prudent des logos et le refus des
bundles de mise à jour altérés, contenant des clés JSON dupliquées ou un SBOM
incohérent avec l’archive serveur. Le test
d’intégration couvre aussi l’upload et le traitement réel d’une image ainsi
que l’import multipart d’un `.rfupdate`, la découverte GitHub conditionnelle,
le contrôle des redirections, l’import automatique idempotent, la sélection
bornée d’une release serveur par la politique opt-in et les transitions
temporelles de scènes sans réponse `upToDate` périmée.

Le client Android se vérifie séparément avec JDK 17 et le SDK 35 :

```bash
cd apps/tv-android
./gradlew --no-daemon clean :app:testDebugUnitTest :app:assembleDebug
```

Voir [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Limites connues

- le launcher Android rend la scène native depuis son cache vérifié,
  synchronise en HTTPS, conserve la révision précédente et contrôle les APK
  avant `PackageInstaller` ; le Device Owner et l’installation silencieuse
  doivent encore être validés sur la TV réelle ;
- les certificats clients individuels et le mTLS sont implémentés et testés
  hors matériel, ainsi que l’appairage chiffré de la CA HTTPS par l’APK
  release ; leur activation avec Android Keystore doit encore être observée
  sur la Philips réelle ;
- DNS-SD, le manifeste ECDSA P-256 et le fallback IP sont implémentés et testés
  hors matériel ; la réception mDNS sur le firmware Philips reste à observer ;
- HDMI, Cast, AirPlay, puissance et retour automatique sont des contrats
  d’adaptateurs, pas des capacités Philips annoncées comme fonctionnelles ;
- PhairPlay n’est pas intégré avant validation de la version Android, de l’ABI
  et du matériel réel.

La liste des informations à relever sur la TV est dans
[docs/PHILIPS_VALIDATION.md](docs/PHILIPS_VALIDATION.md).

## Bundle et licence

Le bundle `bundles/roomframe-default-experience-1.0.0.rfbundle` est chargé
uniquement sur une instance vide. Une mise à jour ne le rejoue jamais.

- projet : **RoomFrame TV** ;
- application Android : `org.roomframe.tv` ;
- licence : Apache-2.0.
