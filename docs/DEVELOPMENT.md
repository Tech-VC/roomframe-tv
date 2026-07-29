# Développement et vérification

## Prérequis locaux

- Node.js 22.12 ou plus récent ;
- npm ;
- Python 3 ;
- Bash et ripgrep ;
- Docker avec Docker Compose pour les tests PostgreSQL et la validation de la
  pile ;
- JDK 17 et Android SDK Platform 35 pour le client TV natif.

Les dépendances applicatives sont verrouillées dans
`services/api/package-lock.json`.

Le client Android se contrôle séparément :

```bash
cd apps/tv-android
./gradlew --no-daemon clean :app:testDebugUnitTest :app:assembleDebug
```

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
l’interface locale. Il y crée les rôles propriétaire, migration et runtime,
applique les migrations avec le migrateur puis exécute l’intégration avec le
seul rôle runtime. Le test confirme notamment que ce rôle ne peut pas créer
d’objet, lire `schema_migrations` ou prendre le rôle propriétaire. Il lance
enfin les tests Studio/simulateur, le contrôle de syntaxe API et les tests
serveur en série, puis supprime le conteneur.

Les tests UI sont bien inclus dans la commande globale :

```bash
node --test prototype/admin/*.test.mjs prototype/tv/*.test.mjs
```

Ils comptent 27 scénarios : modèle Studio, salutation mono-ligne, flou borné et
compatibilité avec le validateur API, normalisation du vrai manifeste TV,
réponse `upToDate`, hashes, préférence de la variante 1080p et traitement
sûr des réponses API non JSON ou malformées, ainsi que la conservation des
références de formulaire au-delà des appels asynchrones, la présence et le
nettoyage du flux de récupération locale, la politique d’update opt-in, les
scènes temporaires et les confirmations du cycle d’identité TV. Ce lot passe
`27/27`.

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
ROOMFRAME_TEST_SERVER_CA_FILE
```

Le test refuse de réinitialiser une base dont le nom n’indique pas clairement
qu’elle est réservée aux tests. `ROOMFRAME_TEST_SERVER_CA_FILE` pointe vers un
certificat de CA public de test valide ; `scripts/test.sh` en génère un
automatiquement et ne conserve pas sa clé privée.

La suite API couvre actuellement 24 scénarios Node, auxquels s’ajoutent les
27 tests UI, soit 51 tests sur un clone frais. Les workflows GitHub de
validation et de release appellent `./scripts/test.sh`, puis trois tests root :
deux dédiés au format `age`, à la rétention, au trousseau historique et à la
restauration PostgreSQL isolée, ainsi qu’un troisième pour la découverte
ECDSA P-256 et Avahi. Les scénarios comprennent notamment :

- bootstrap concurrent : une réussite, un conflit ;
- Argon2id, chiffrement TOTP et vecteurs RFC 6238 ;
- cookie sécurisé, session, permissions, origine et CSRF ;
- WebAuthn avec paire P-256 éphémère, attestation CBOR minimale, signature
  d’assertion réelle, compteur, rejet du rejeu, origine canonique et révocation
  de session ;
- identité publique bornée, charte globale protégée par permission/CSRF et
  document `branding.json` hashé pour les TV ;
- bibliothèque de scènes, révision, conflit, publication, affectation ciblée
  et manifeste de synchronisation ;
- enrôlement temporaire, rotation TV en deux phases, confirmation idempotente,
  révocation et réenrôlement protégés par permission/CSRF, ainsi que
  chiffrement/déchiffrement croisé Node/Kotlin de la CA HTTPS et refus d’une
  enveloppe altérée ;
- isolation des assets d’une TV ;
- seed appliqué une seule fois et migrations rejouables ;
- récupération liée au bon compte, consommation unique et refus du rejeu ;
- invitation administrateur affichée une fois, activation TOTP, refus du
  rejeu, absence d’escalade depuis un rôle délégué, révocation de session et
  conservation obligatoire du dernier propriétaire ;
- upload multipart réel, détection MIME, traitement Sharp, hashes des
  variantes, suppression des métadonnées, déduplication et refus d’un faux
  média ;
- détourage automatique prudent des logos et sélection de la variante alpha ;
- contrats de scène et fuseaux ;
- import multipart `.rfupdate`, quarantaine, matérialisation APK, cycle canari
  jusqu’à l’état installé et refus HTTP d’un manifeste signé contenant des
  clés JSON dupliquées ;
- mise à jour Ed25519 valide et refus des altérations, artefacts non listés et
  downgrades, ainsi que remplacement sûr d’une quarantaine corrompue ;
- sélection GitHub `stable`/`preview`, ETag, refus d’assets ambigus,
  redirections limitées, contrôle taille/digest et réimport idempotent ;
- politique serveur manuelle par défaut, activation protégée, fenêtre
  traversant minuit, refus des imports manuels et absence de relance
  automatique après échec ;
- création, chevauchement refusé, activation, fin et annulation d’une scène
  programmée, avec résolution réelle dans le manifeste TV et conservation
  après réexécution des migrations.

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
sudo /opt/roomframe/scripts/roomframe-verify-backup.sh --latest
sudo /opt/roomframe/scripts/roomframe-backup-key.sh --show-recipient
sudo /opt/roomframe/scripts/roomframe-refresh-discovery.sh
sudo systemctl status avahi-daemon
backup_id="$(find /var/lib/roomframe/backups -mindepth 1 -maxdepth 1 \
  -type d -name '????????T??????Z' -printf '%f\n' | sort | tail -n 1)"
sudo /opt/roomframe/scripts/roomframe-restore.sh \
  "/var/lib/roomframe/backups/$backup_id" \
  --confirm "$backup_id"
sudo roomframe-apply-update \
  --release-id UUID_RELEASE_DE_TEST \
  --confirm VERSION_RELEASE_DE_TEST
```

La seconde exécution doit conserver les secrets, la base, les médias, la PKI,
le seed figé et toute personnalisation. Le test de restauration doit être
réservé au CT jetable : il crée un point de retour, restaure la sauvegarde
choisie, redémarre les cinq services et vérifie HTTPS. Il doit aussi confirmer
qu’aucun `postgres.dump`, `configuration.tar.gz` ou
`persistent-data.tar.gz` en clair n’existe dans le répertoire final, qu’un
octet altéré dans un `.age` est refusé et que les deux timers restent actifs
après une seconde installation. Une restauration entre deux identités
différentes doit conserver le point de sécurité via `backup-keyring`.
Le test `apply-update` doit utiliser une clé de développement éphémère, une
release strictement supérieure et le CT jetable. Il doit confirmer la
préconstruction, le point de retour, la bascule, les cinq services, l’audit et
l’archive root-only de l’ancien code.
Le parcours Studio doit aussi créer une ligne `pending`, refuser une seconde
demande active, puis laisser `roomframe-update-broker.service` la faire passer
à `completed` ou `rolled-back`. L’API et ses conteneurs ne doivent jamais
recevoir `/var/run/docker.sock`.

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

Le projet versionne un wrapper Gradle 8.9 avec le SHA-256 de la distribution.
Le build nécessite JDK 17, Android SDK Platform 35 et Android SDK Build Tools
35.0.0 :

```bash
cd apps/tv-android
./gradlew --no-daemon clean testDebugUnitTest lintDebug :app:assembleDebug
```

L’APK de développement est produit dans
`app/build/outputs/apk/debug/app-debug.apk`. Après avoir autorisé ADB sur une
TV de test :

```bash
adb connect TV_IP_ADDRESS:5555
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -W -n org.roomframe.tv/.MainActivity
```

`adb install -r` conserve les données de l’application lorsqu’une version
signée avec la même clé est déjà installée. La clé debug locale ne doit jamais
devenir la clé de signature des releases.

Pour constituer un relevé matériel privé et reproductible :

```bash
./scripts/collect-android-tv-capabilities.sh \
  --target TV_IP_ADDRESS:5555 \
  --output PRIVATE_OUTPUT_DIRECTORY
```

L’option `--include-third-party-packages` ajoute uniquement les identifiants
des applications installées. La collecte exclut volontairement numéro de
série, comptes, SSID, adresses réseau, appareils associés et contenu consulté.
Le dossier de sortie doit rester privé ; `local-hardware/` est ignoré par Git
pour les essais effectués dans ce dépôt.

### Surcharge visuelle locale de test

Un APK debuggable peut charger temporairement un fond et un logo depuis son
stockage privé, sans les embarquer dans le dépôt public. Les noms acceptés
sont `background` et `logo`, avec une extension `.webp`, `.png`, `.jpg` ou
`.jpeg`, une limite de 25 Mio par fichier et une limite décodée de 3840 ×
2160 pixels.

```bash
adb push LOCAL_BACKGROUND_FILE /data/local/tmp/roomframe-background.png
adb push LOCAL_LOGO_FILE /data/local/tmp/roomframe-logo.png
adb shell run-as org.roomframe.tv mkdir -p files/branding
adb shell run-as org.roomframe.tv cp /data/local/tmp/roomframe-background.png files/branding/background.png
adb shell run-as org.roomframe.tv cp /data/local/tmp/roomframe-logo.png files/branding/logo.png
adb shell run-as org.roomframe.tv chmod 600 files/branding/background.png files/branding/logo.png
adb shell rm /data/local/tmp/roomframe-background.png /data/local/tmp/roomframe-logo.png
```

Ce chemin est désactivé dans les builds non debuggables. Il sert uniquement
au prototypage matériel ; les releases doivent recevoir leurs médias validés,
optimisés et adressés par hash via le pipeline de synchronisation.

Les builds debug acceptent les autorités de certification ajoutées par
l’utilisateur Android afin de tester la CA Caddy locale. Les builds release
continuent de faire confiance uniquement aux CA système tant que le client
HTTPS n’a pas reçu la CA d’instance par le flux d’enrôlement.

Le launcher compile un accueil natif sans WebView et contient :

- `cache/FileExperienceStore`, qui vérifie les hashes, écrit un staging,
  bascule les pointeurs atomiquement et conserve la révision précédente ;
- `HttpExperienceSyncClient`, le parseur strict des documents et le renderer
  logique 1920 × 1080 ;
- l’enrôlement HTTPS, la clé TLS RSA non exportable, le certificat client
  individuel, l’appairage/épinglage de la CA HTTPS et le stockage chiffré de
  la clé TV dans Android Keystore ;
- `RoomFrameDiscovery`, qui résout uniquement `_roomframe._tcp`, vérifie le
  manifeste ECDSA P-256 et conserve FQDN puis IP comme candidats bornés ;
- `HttpAppUpdateCoordinator`, le contrôle de l’APK et l’adaptateur
  `PackageInstaller` conditionné à Device Owner ;
- les contrats HDMI, Cast, AirPlay et puissance ;
- des adaptateurs qui répondent honnêtement `unsupported` et des simulateurs
  réservés aux tests.

Le build debug 0.3.0 a été installé et lancé sur le matériel Philips documenté
dans `PHILIPS_VALIDATION.md`. Le rendu logique 1920 × 1080 et le parcours
D-pad AirPlay, Cast puis HDMI y sont confirmés. L’intégration du cache, du
client HTTPS, de la distribution APK et des métriques techniques minimales est
maintenant codée et testée hors matériel. Le provisionnement Device Owner,
l’installation silencieuse réelle, la découverte DNS-SD, l’appairage CA, la
rotation et le mTLS 0.3.5 restent à valider sur la TV.
Aucun résultat HDMI, Cast, AirPlay, puissance ou mise à jour silencieuse ne
peut être déduit des adaptateurs `unsupported` ou des tests JVM.

La candidate courante est `0.3.5` / `versionCode 8`. Elle inclut le cache,
la synchronisation, la distribution APK, l’appairage chiffré de la CA,
la rotation de credential, le mTLS et la découverte locale signée ; elle
n’est pas considérée installée tant que la TV n’a pas été reconnectée et
contrôlée. La candidate intermédiaire `0.3.1` / code 4 a seulement été
construite hors matériel.
