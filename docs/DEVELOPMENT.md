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

Ils comptent 17 scénarios : modèle Studio, salutation mono-ligne, flou borné et
compatibilité avec le validateur API, normalisation du vrai manifeste TV,
réponse `upToDate`, hashes, préférence de la variante 1080p et traitement
sûr des réponses API non JSON ou malformées, ainsi que la conservation des
références de formulaire au-delà des appels asynchrones, ainsi que la présence
et le nettoyage du flux de récupération locale. Ce lot passe `17/17`.

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

La suite API couvre actuellement 20 scénarios Node, auxquels s’ajoutent les
20 tests UI, soit 40 tests sur un clone frais. Les workflows GitHub de
validation et de release appellent tous deux `./scripts/test.sh` et couvrent
donc ce même ensemble. Les scénarios comprennent notamment :

- bootstrap concurrent : une réussite, un conflit ;
- Argon2id, chiffrement TOTP et vecteurs RFC 6238 ;
- cookie sécurisé, session, permissions, origine et CSRF ;
- identité publique bornée, charte globale protégée par permission/CSRF et
  document `branding.json` hashé pour les TV ;
- bibliothèque de scènes, révision, conflit, publication, affectation ciblée
  et manifeste de synchronisation ;
- enrôlement temporaire puis clé TV à remise unique ;
- isolation des assets d’une TV ;
- seed appliqué une seule fois et migrations rejouables ;
- récupération liée au bon compte, consommation unique et refus du rejeu ;
- upload multipart réel, détection MIME, traitement Sharp, hashes des
  variantes, suppression des métadonnées, déduplication et refus d’un faux
  média ;
- détourage automatique prudent des logos et sélection de la variante alpha ;
- contrats de scène et fuseaux ;
- import multipart `.rfupdate`, quarantaine, matérialisation APK, cycle canari
  jusqu’à l’état installé et refus HTTP d’un manifeste signé contenant des
  clés JSON dupliquées ;
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
sudo /opt/roomframe/scripts/roomframe-verify-backup.sh --latest
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
- l’enrôlement HTTPS et le stockage chiffré de la clé TV dans Android Keystore ;
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
l’installation silencieuse réelle et la PKI individuelle restent à valider.
Aucun résultat HDMI, Cast, AirPlay, puissance ou mise à jour silencieuse ne
peut être déduit des adaptateurs `unsupported` ou des tests JVM.

La build suivante est `0.3.1` / `versionCode 4`, afin de tester une vraie
montée de version depuis l’APK `0.3.0` / code 3 déjà installé. Elle n’est pas
considérée installée tant que la TV n’a pas été reconnectée et contrôlée.
