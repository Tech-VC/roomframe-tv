# Développement et vérification

## Prérequis locaux

- Node.js 22.12 ou plus récent ;
- npm ;
- Python 3 ;
- Bash et ripgrep ;
- Docker avec Docker Compose pour les tests PostgreSQL et la validation de la
  pile.

Les dépendances applicatives sont verrouillées dans
`services/api/package-lock.json`.

## Vérification complète

Depuis la racine :

```bash
./scripts/check.sh
./scripts/test.sh
```

`check.sh` contrôle :

- la syntaxe des scripts shell ;
- tous les contrats, defaults et exemples JSON ;
- l’intégrité du bundle d’expérience ;
- la syntaxe des modules API et des JavaScript statiques ;
- l’absence de script, style ou attribut de style inline interdits par la CSP ;
- la configuration Compose, si Docker Compose est disponible.

`test.sh` exécute d’abord ces checks, puis installe avec `npm ci` les
dépendances API verrouillées si elles sont absentes. Si aucune base de test
n’est fournie, il démarre ensuite un conteneur PostgreSQL 17 éphémère sur
l’interface locale. Il lance enfin les tests Studio/simulateur, le contrôle de
syntaxe API et les tests serveur en série, puis supprime le conteneur.

Les tests UI sont bien inclus dans la commande globale :

```bash
node --test prototype/admin/*.test.mjs prototype/tv/*.test.mjs
```

Ils comptent 9 scénarios : modèle Studio et compatibilité avec le validateur
API, normalisation du vrai manifeste TV, réponse `upToDate`, hashes et
préférence de la variante 1080p. Ce lot passe `9/9`.

Pour utiliser une installation Node non découverte automatiquement :

```bash
ROOMFRAME_NODE_BIN=/chemin/vers/node ./scripts/test.sh
```

## API seule

```bash
cd services/api
npm ci
npm run check
npm test
```

Sans PostgreSQL de test, le scénario d’intégration est marqué `SKIP`. Une base
dédiée dont le nom contient `test` peut être fournie avec :

```text
ROOMFRAME_TEST_DB_HOST
ROOMFRAME_TEST_DB_PORT
ROOMFRAME_TEST_DB_NAME
ROOMFRAME_TEST_DB_USER
ROOMFRAME_TEST_DB_PASSWORD
```

Le test refuse de réinitialiser une base dont le nom n’indique pas clairement
qu’elle est réservée aux tests.

La suite API couvre actuellement 13 scénarios Node, auxquels s’ajoutent les
9 tests UI, soit 22 tests sur un clone frais. Les workflows GitHub de
validation et de release appellent tous deux `./scripts/test.sh` et couvrent
donc ce même ensemble. Les scénarios comprennent notamment :

- bootstrap concurrent : une réussite, un conflit ;
- Argon2id, chiffrement TOTP et vecteurs RFC 6238 ;
- cookie sécurisé, session, permissions, origine et CSRF ;
- révision, conflit, publication et manifeste de synchronisation ;
- enrôlement temporaire puis clé TV à remise unique ;
- isolation des assets d’une TV ;
- seed appliqué une seule fois et migrations rejouables ;
- récupération liée au bon compte, consommation unique et refus du rejeu ;
- contrats de scène et fuseaux ;
- mise à jour Ed25519 valide et refus des altérations, artefacts non listés et
  downgrades, ainsi que remplacement sûr d’une quarantaine corrompue.

## Installateur

Le smoke test non démarré et idempotent est :

```bash
sudo ./install.sh --host roomframe.example.local --no-start
sudo ./install.sh --host roomframe.example.local --no-start
```

Le test complet doit être effectué dans une VM ou un CT Debian jetable :

```bash
sudo ./install.sh --host roomframe.example.local
sudo ./install.sh --host roomframe.example.local
sudo /opt/roomframe/scripts/roomframe-diagnose.sh
sudo /opt/roomframe/scripts/roomframe-backup.sh
```

La seconde exécution doit conserver les secrets, la base, les médias, la PKI,
le seed figé et toute personnalisation.

## Bundles

```bash
python3 scripts/verify-experience-bundle.py \
  bundles/roomframe-default-experience-1.0.0.rfbundle
node services/api/scripts/build-test-update.mjs \
  --output /private/tmp/roomframe-update-test
```

Le second script crée une clé de développement éphémère et un `.rfupdate`
uniquement dans le répertoire temporaire indiqué. Ce matériel ne doit pas être
copié dans le dépôt ni servir à une release.

## Android

Le projet fournit ses fichiers Gradle mais pas encore de wrapper `gradlew`
versionné. Il compile un fallback d’accueil natif sans WebView et contient :

- `cache/FileExperienceStore`, qui vérifie les hashes, écrit un staging,
  bascule les pointeurs atomiquement et conserve la révision précédente ;
- les interfaces `ExperienceSyncClient` et `ManifestVerifier` ;
- les contrats HDMI, Cast, AirPlay et puissance ;
- des adaptateurs qui répondent honnêtement `unsupported` et des simulateurs
  réservés aux tests.

Le build Android reproductible n’est pas encore exécuté dans cette suite faute
de wrapper/SDK validé. L’intégration du cache, du client HTTPS et de la PKI au
launcher reste incomplète. Aucun résultat matériel réel ne peut être déduit
des adaptateurs simulés.
