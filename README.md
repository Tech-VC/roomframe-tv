# RoomFrame TV

RoomFrame TV est une solution open source et **local-first** pour transformer
une Google TV ou Android TV en portail d’accueil personnalisable. Le serveur,
l’administration et les téléviseurs continuent de servir l’expérience locale
sans dépendre d’un service cloud.

Le dépôt public est volontairement neutre. L’organisation, le domaine local,
les salles, les comptes, les médias, les certificats et les règles sont créés
sur chaque instance après l’installation.

> État actuel : le jalon `0.3.0` est exécutable avec PostgreSQL, bootstrap à
> usage unique, TOTP, sessions, Studio relié à l’API, pipeline média,
> synchronisation TV et vérification des mises à jour signées. Le simulateur
> et le client Android conservent la dernière révision valide hors ligne ; le
> client natif rend la scène sans WebView et contrôle les APK distribués par
> vagues. Un poller non privilégié peut aussi importer automatiquement une
> release GitHub signée. Device Owner, installation silencieuse, application
> du code serveur, HDMI, veille/réveil, Cast et AirPlay restent à valider.

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

- migrations PostgreSQL additives avec checksum et verrou advisory ;
- modèles instance, utilisateurs, rôles, sessions, groupes, TV, scènes,
  révisions, médias, messages, horaires, métriques, événements, releases,
  déploiements et audit ;
- révisions de scène immuables et publication transactionnelle ;
- Studio de régie relié aux flux réels de bootstrap, session, scènes, médias,
  messages et releases, avec glisser-déposer, redimensionnement, calques,
  propriétés, clavier et historique ;
- règles AirPlay, Cast, HDMI, application privée, retour accueil et horaires
  configurables par instance, groupe ou TV sans prétendre exécuter le matériel ;
- bibliothèque de scènes, copie de brouillon et affectation publiée par
  instance, groupe ou TV avec aperçu résolu ;
- validation des scènes typées 1920 × 1080, sans HTML ni JavaScript libre ;
- upload image/vidéo avec contrôle du type réel, stockage par SHA-256 et
  traitement asynchrone par Sharp/FFmpeg, dont une variante transparente
  prudente pour les logos sur fond clair uniforme ;
- enrôlement TV à identifiant temporaire puis clé d’appareil à remise unique ;
- synchronisation par révision avec hashes des documents et médias ;
- simulateur IndexedDB : staging vérifié, activation transactionnelle,
  révision précédente conservée et interrupteur de coupure API ;
- import `.rfupdate` avec validation Ed25519, compatibilité, chemins, tailles et
  hashes, puis quarantaine ;
- découverte GitHub `stable` ou `preview`, ETag, téléchargement borné,
  redirections GitHub contrôlées et import automatique idempotent sans
  exécution de l’artefact ;
- distribution d’APK par canari ou vagues progressives avec état par TV ;
- état du parc alimenté par la dernière télémétrie technique autorisée, sans
  contenu consulté ni identifiant d’appareil personnel ;
- accueil Android natif, cache atomique, synchronisation HTTPS, enrôlement et
  contrôle de l’APK avant `PackageInstaller` ;
- diagnostic et sauvegarde cohérente avant migration.

## Exploitation

Les commandes installées sont :

```bash
sudo roomframe-compose ps
sudo roomframe-compose logs --tail=200 api worker update-poller
sudo roomframe-diagnose
sudo roomframe-backup
sudo roomframe-backup --without-media
sudo roomframe-verify-backup --latest
sudo roomframe-trust-update-key --key-id release-main \
  --public-key /chemin/release-main.pem \
  --sha256 EMPREINTE_SHA256
```

Les données sont séparées du code :

```text
/opt/roomframe/                      code installé
/etc/roomframe/                      configuration et secrets root-only
/var/lib/roomframe/app/             état applicatif
/var/lib/roomframe/postgres/        base PostgreSQL
/var/lib/roomframe/media/           originaux privés et variantes
/var/lib/roomframe/processing/      file de traitement
/var/lib/roomframe/pki/             confiance locale et clés publiques
/var/lib/roomframe/releases/        mises à jour vérifiées
/var/lib/roomframe/backups/         sauvegardes
/var/lib/roomframe/seed/            expérience initiale figée
```

Une seconde exécution de `install.sh` conserve les secrets et les données. Si
une base existe, l’installateur exige et lance une sauvegarde avant de recopier
le code.

## Développement et tests

Node.js 22.12 ou plus récent, Python 3 et Docker sont utilisés par les checks :

```bash
./scripts/check.sh
./scripts/test.sh
```

Sur un clone frais, `scripts/test.sh` installe les dépendances verrouillées,
puis démarre automatiquement un PostgreSQL 17 éphémère lorsqu’un serveur de
test n’est pas fourni. Il exécute 20 tests Studio/synchronisation TV et
23 tests API, contrôle de syntaxe serveur inclus, soit 43 tests. Les workflows GitHub de
validation et de release utilisent cette même commande. Les scénarios couvrent
notamment le bootstrap concurrent, Argon2id/TOTP, les sessions et permissions,
CSRF, les révisions, l’enrôlement TV, le seed unique, la récupération locale,
la compatibilité des scènes UI, le rejet concis des réponses API non JSON,
la stabilité des formulaires asynchrones, le détourage prudent des logos et le refus des
bundles de mise à jour altérés ou contenant des clés JSON dupliquées. Le test
d’intégration couvre aussi l’upload et le traitement réel d’une image ainsi
que l’import multipart d’un `.rfupdate`, la découverte GitHub conditionnelle,
le contrôle des redirections et l’import automatique idempotent.

Voir [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Limites connues

- l’import `.rfupdate`, le poller GitHub, le téléchargement APK affecté et les
  vagues canari/progressives sont implémentés ; le moteur privilégié qui
  sauvegarde puis applique atomiquement le code serveur reste à livrer ;
- le Studio gère plusieurs scènes et leurs affectations publiées ; la
  programmation temporelle d’un changement de scène reste à livrer ;
- le launcher Android rend la scène native depuis son cache vérifié,
  synchronise en HTTPS, conserve la révision précédente et contrôle les APK
  avant `PackageInstaller` ; le Device Owner et l’installation silencieuse
  doivent encore être validés sur la TV réelle ;
- les certificats individuels TV et le mTLS restent à finaliser ;
- le rôle PostgreSQL initial cumule propriété, migrations et accès runtime ;
  le futur moteur d’application devra être séparé de l’API web ;
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
