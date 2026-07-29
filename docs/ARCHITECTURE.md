# Architecture

## Deux phases distinctes

### Installation du serveur

`install.sh` s’exécute sur un Debian/CT dont le réseau existe déjà. Il détecte
l’IPv4 et un suffixe DNS, installe les dépendances manquantes, prépare HTTPS,
les secrets et les volumes persistants, puis démarre les conteneurs. Il ne
configure jamais l’IP, le masque, la passerelle, les routes ou les DNS.

### Configuration de l’instance

Le bootstrap applicatif crée l’identité, le premier propriétaire avec TOTP et
la première scène. Les salles, contenus, sources et politiques appartiennent à
l’application ; aucun champ réseau serveur n’est demandé.

## Pile du jalon 0.3.0

```text
Navigateur ── HTTPS ── Caddy ── API Node.js ── PostgreSQL
                  │                  │
                  │                  ├── médias privés
                  │                  ├── releases vérifiées
                  │                  └── seed figé
                  │
                  └── fichiers statiques admin/simulateur

Worker Sharp/FFmpeg ── file PostgreSQL ── médias privés

Bootstrap rôles ── admin PostgreSQL ── propriétaire sans login
Migration one-shot ── migrateur ──────── schéma versionné
API + worker + poller ── runtime ─────── données applicatives

Poller GitHub ── HTTPS sortant ── release `.rfupdate`
      │
      ├── vérificateur Ed25519 commun
      └── releases vérifiées + historique PostgreSQL

Administration ── demande SQL sans privilège ── PostgreSQL
                                                │
Timer systemd root ── courtier local ───────────┘
       │
       └── revalidation Ed25519 + sauvegarde + bascule du code

TV ── clé publique + preuve ── API ── demande SQL
                                     │
Courtier certificat root ────────────┘
       │
       └── CA root-only ── certificat public individuel ── TV/mTLS

Caddy ── CA HTTPS publique ── copie root contrôlée ── API
TV ── ticket chiffré sans secret sortant ────────────┘
       └── déchiffrement + validation de la chaîne ── pin d’instance
```

- Caddy est le seul service exposé sur le LAN, sur `443/tcp` ;
- l’administration et l’API partagent une origine ;
- PostgreSQL et le worker média restent sur un réseau Docker interne ;
- l’API rejoint seulement les réseaux internes `frontend` et `backend` ;
  Caddy reçoit le LAN sur `ingress` et le poller possède sa sortie dédiée
  `update-egress`, sans port publié ;
- l’API, le worker et le poller tournent sans privilège, avec racine en lecture seule,
  capacités supprimées et volumes dédiés ;
- l’API, le worker et le poller utilisent l’UID/GID du compte système Debian
  `roomframe`, sans home ni shell de connexion ;
- la demande de récupération est montée en lecture seule dans l’API ; l’état
  de consommation autoritatif reste transactionnel en base ;
- `database-roles` prépare idempotemment le propriétaire sans login,
  le migrateur et le runtime ; seul `migrate`, conteneur one-shot, peut prendre
  le rôle propriétaire et appliquer les migrations sous verrou advisory ;
- l’API, le worker et le poller utilisent uniquement `roomframe_runtime`,
  n’ont aucun droit DDL et ne peuvent ni lire ni modifier
  `schema_migrations` ;
- un seul worker média détient le verrou global de traitement ;
- un seul poller GitHub détient son propre verrou global ;
- l’administration peut écrire une demande d’application serveur, mais seul
  le courtier systemd root peut la prendre ; l’API ne possède ni socket Docker,
  ni sudo, ni chemin de bundle fourni par le navigateur ;
- le courtier délègue au moteur root, qui revalide le bundle signé et partage
  le verrou global des sauvegardes, restaurations et installations ;
- code, configuration, secrets, PKI, base, médias, releases et sauvegardes sont
  séparés.

Les modèles persistants couvrent l’instance, les rôles/utilisateurs/sessions,
les groupes/TV, les scènes et révisions, les médias et jobs, les messages, les
sources, les horaires, les métriques, les événements, les releases, les
déploiements TV, les demandes d’application serveur, leur politique
automatique opt-in, les programmations de scènes, les générations de
credential TV, les demandes/certificats clients individuels et l’audit.
La migration d’appairage conserve aussi, uniquement pendant les 30 minutes du
ticket, l’enveloppe chiffrée de la CA HTTPS ; elle est effacée à l’activation.

## Une seule origine HTTPS

```text
https://roomframe.domaine-interne/
https://roomframe.domaine-interne/api/
https://roomframe.domaine-interne/simulator/
```

L’IPv4 principale est également incluse dans le certificat Caddy et reste une
URL de secours. La CA locale doit être distribuée ou épinglée par un canal
administré.

## Scènes et publication

La scène logique mesure 1920 × 1080. Les composants et leurs propriétés sont
validés contre les contrats JSON et des contrôles sémantiques : limites du
canevas, identifiants uniques, propriétés autorisées, fuseau IANA, références
médias sûres et ordre de focus.

Le moteur n’accepte aucun HTML ni JavaScript fourni par un administrateur. Une
révision est immuable ; la publication déplace un pointeur et incrémente la
révision de synchronisation dans une transaction unique.

## Local-first TV

L’API produit un manifeste par révision comprenant les documents et assets
adressés par SHA-256. Le protocole attendu côté client est :

1. rendre immédiatement la dernière révision locale validée ;
2. demander la révision courante en arrière-plan ;
3. télécharger documents et médias dans une zone de staging ;
4. vérifier tailles et SHA-256 ;
5. activer atomiquement le nouveau pointeur ;
6. conserver l’ancienne révision tant que la nouvelle n’est pas complète.

Ce protocole et ses invariants serveur sont présents et testés. Le simulateur
web stocke les révisions et blobs dans IndexedDB, vérifie le hash canonique du
manifeste, chaque document et chaque asset, puis active le staging dans une
transaction qui conserve la révision précédente. Son interrupteur « Couper
l’API » et le rechargement du cache démontrent le rendu sans serveur.

Le client Android rend d’abord la révision active vérifiée, ou l’expérience
embarquée en secours, puis synchronise l’origine HTTPS en arrière-plan. Il
vérifie le manifeste canonique, chaque document et chaque média, active le
staging par renommage atomique et revient au pointeur précédent si l’actif est
corrompu. Les identifiants TV sont chiffrés via Android Keystore.

La TV génère en plus une clé RSA non exportable et prouve sa possession pendant
l’enrôlement. L’API ne signe rien elle-même : un courtier systemd root sans port
entrant utilise la CA privée persistante, qui n’est montée dans aucun
conteneur. Caddy vérifie le certificat lorsqu’il est présenté et transmet son
empreinte via des en-têtes qu’il réécrit lui-même. L’API rend cette empreinte
obligatoire après l’activation et la lie à la clé rotative et à l’UUID TV.

Le client possède au plus une clé active et une clé de rotation en attente,
chiffrées avec des données authentifiées distinctes. Il prépare localement la
nouvelle clé avant l’appel réseau ; le serveur ne stocke que son hash et garde
l’ancienne active jusqu’à une confirmation idempotente. La promotion côté
Android intervient seulement après la promotion transactionnelle côté
PostgreSQL. Ce protocole permet de reprendre une coupure à chacune des étapes.
La régie peut révoquer une génération ou créer un nouvel enrôlement, sans
effacer le cache d’expérience local-first.

`NativeSceneRenderer` rend la scène logique 1920 × 1080 avec des vues Android,
sans WebView : fonds image/vidéo, flou Android 12, textes, heure, messages,
logo global, médias, boutons source et ordre de focus D-pad. La couche logique
reste indépendante de la résolution 4K/HDR des applications natives ouvertes.

Après la synchronisation d’expérience, le client peut récupérer une mise à
jour APK affectée. Il vérifie l’artefact et utilise `PackageInstaller`
uniquement derrière `AppUpdateAdapter`; l’installation silencieuse reste
conditionnée à Device Owner et à une validation physique.

## Studio

Le Studio conserve l’esthétique de régie du prototype et utilise les endpoints
réels de bootstrap, authentification, scènes, médias, messages et releases. Le
modèle partagé côté interface est testé avec le validateur de layout de l’API.
Les interactions couvrent déplacement, redimensionnement, clavier, calques,
propriétés, palette et historique.

Le sélecteur d’aperçu TV/groupe résout côté serveur les affectations publiées
et reste distinct du brouillon modifiable. Le Studio expose également la
politique d’application serveur dans la même direction éditoriale, sans donner
de privilège système au navigateur.

Une scène programmée est un remplacement temporaire prioritaire sur
l’affectation statique. Le worker sérialise les transitions sous verrou,
incrémente la révision TV à l’activation et au retour, puis écrit l’audit. Si le
worker a été arrêté pendant toute une fenêtre, il la clôt sans prétendre
qu’elle a été affichée ; aucune transition matérielle n’est simulée.

## Frontière matérielle

L’architecture cible sépare :

- `RoomFrame Home`, le launcher visible ;
- un agent Device Owner chargé des politiques, si le matériel le permet ;
- des adaptateurs HDMI, puissance, Cast et AirPlay ;
- les intégrations constructeur isolées.

Le jalon ne prétend pas que ces adaptateurs fonctionnent sur une TV Philips.
PhairPlay reste absent jusqu’à la validation d’Android, de l’ABI, des codecs et
du budget mémoire réels. Ouvrir une application native ne doit jamais forcer
sa résolution 4K/HDR à celle du rendu d’accueil.
