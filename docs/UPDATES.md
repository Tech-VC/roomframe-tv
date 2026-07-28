# Mises à jour sans perte de configuration

## Invariants

Une mise à jour remplace du code, jamais l’identité de l’instance. Elle ne doit
rejouer ni le seed, ni le bootstrap et ne doit remplacer ni base, ni médias,
ni PKI, ni secrets, ni scènes publiées.

Le code est sous `/opt/roomframe`, les données sous `/var/lib/roomframe` et la
configuration sous `/etc/roomframe`.

## Mise à niveau actuellement exécutable

Relancer un installateur plus récent constitue le chemin serveur disponible
dans ce jalon. Si PostgreSQL existe :

1. l’installateur vérifie la présence de l’ancien runtime et de la commande de
   sauvegarde ;
2. il exécute `roomframe-backup` avant de recopier le code ;
3. il conserve les secrets et le seed existants ;
4. il reconstruit et redémarre la pile ;
5. l’API applique les nouvelles migrations additives sous verrou ;
6. les healthchecks HTTPS et worker doivent réussir.

La copie actuelle est additive et non destructive, mais pas encore atomique
par répertoire de release. Un fichier ancien absent de la nouvelle archive
peut donc rester sous `/opt/roomframe`; il ne doit jamais contenir de données
d’instance.

## Format `.rfupdate`

Un bundle est un ZIP contenant au minimum :

```text
release.rfupdate
├── manifest.json
├── manifest.sig
└── server/roomframe-server-<version>.tar.gz
```

Le contrat peut aussi décrire des APK, images OCI, migrations ou verrous
Compose. Chaque artefact présent doit être listé par le manifeste.

Avant la quarantaine, le serveur vérifie :

1. chemins ZIP, doublons d’entrées, liens et chiffrement ;
2. limites de taille et de ratio de compression ;
3. contrat, version plus récente et compatibilité serveur/architecture ;
4. taille et SHA-256 de chaque artefact ;
5. absence d’artefact non listé ;
6. signature Ed25519 des octets exacts de `manifest.json`.

Les clés publiques approuvées sont placées par l’administrateur dans :

```text
/var/lib/roomframe/pki/update-trust/<keyId>.pem
```

La clé privée de release ne doit jamais être copiée dans le dépôt ou sur le
serveur.

Une release publie la clé publique et son empreinte. Après vérification par un
canal indépendant :

```bash
sudo roomframe-trust-update-key \
  --key-id release-main \
  --public-key /chemin/release-main.pem \
  --sha256 EMPREINTE_SHA256
```

La commande est idempotente pour la même empreinte et exige `--replace` pour
une rotation explicite. Le magasin est monté en lecture seule dans l’API.

## Import hors ligne

L’endpoint `POST /api/v1/releases/import` accepte un multipart `file` portant
l’extension `.rfupdate`. Après succès, l’archive est stockée par son SHA-256
dans :

```text
/var/lib/roomframe/releases/verified/
```

L’historique contient la version, le hash, l’identifiant de clé et le résultat
de vérification. L’import ne lance aucun artefact et ne modifie aucune donnée
applicative.

Une vérification indépendante est disponible :

```bash
python3 scripts/verify-update-bundle.py release.rfupdate \
  --trust-key /var/lib/roomframe/pki/update-trust/release-public.pem \
  --current-version 0.3.0
```

Ce vérificateur contrôle aussi les clés JSON dupliquées et n’extrait pas
l’archive.

Avant toute future application de release, une sauvegarde peut être éprouvée
sans toucher à l’instance :

```bash
sudo roomframe-backup
sudo roomframe-verify-backup --latest
```

La seconde commande contrôle l’enveloppe puis restaure réellement le dump dans
un PostgreSQL temporaire sans réseau. Elle ne constitue pas encore la
procédure de restauration complète de production.

## Plans canari et progressifs

Après import, l’API peut enregistrer :

- une stratégie `canary` ciblant une TV ;
- une stratégie `progressive` ciblant un groupe ou le parc.

Le résultat reste `planned` et indique explicitement que l’exécution
matérielle est simulée tant que l’adaptateur n’est pas validé.

## Ce qui reste à implémenter

Le jalon ne comprend pas encore :

- le poller périodique des releases GitHub ;
- le téléchargement automatique avec politique de canal ;
- un moteur privilégié, séparé de l’API web, qui extrait et applique le bundle ;
- l’association obligatoire d’une sauvegarde à une release importée ;
- l’import des images, le redémarrage orchestré et le healthcheck de rollback ;
- l’avancement automatique des vagues canari/progressives ;
- l’installation silencieuse d’APK sur Device Owner ;
- une commande documentée de restauration complète.

Deux frontières restent particulièrement importantes :

- le rôle PostgreSQL `roomframe` initial cumule propriété, migration et accès
  applicatif ; sa séparation exigera une migration et une procédure
  d’exploitation versionnées ;
- le futur `apply-update` devra être un composant privilégié minimal, séparé de
  l’API web. Aucun endpoint HTTP ne doit recevoir directement le droit de
  remplacer le code, de contrôler Docker ou de restaurer une base.

La séquence cible est donc :

1. vérifier et quarantainer ;
2. sauvegarder ;
3. appliquer dans un staging ;
4. exécuter les migrations ;
5. basculer atomiquement ;
6. vérifier ;
7. canari ;
8. vagues progressives ;
9. conserver une restauration explicite.

Il ne faut pas présenter cette séquence cible comme déjà automatisée.

## Migrations et seed

Les migrations sont versionnées et enregistrées avec leur SHA-256. Une
migration déjà appliquée dont le contenu a changé est refusée. Le script
maintient son verrou advisory dans la même session et enregistre le checksum
dans la transaction de migration.

`experience_seed_history` garantit que le bundle initial n’est appliqué qu’une
fois sur base vide. Relancer les migrations ou l’installateur ne réapplique pas
les valeurs par défaut.

## Android

Une future mise à jour APK doit garder `applicationId` et clé de signature.
Android pourra alors remplacer le code sans effacer les données privées. Le
client devra migrer son cache tout en conservant la dernière révision complète
validée.

Le parcours visé ne dépend pas d’une clé USB après l’enrôlement initial :

1. installer une première fois l’APK signé, de préférence par ADB (une clé USB
   peut aussi servir au sideload initial) ;
2. provisionner RoomFrame comme Device Owner sur une TV réinitialisée, si le
   firmware l’autorise ;
3. importer dans l’administration un `.rfupdate` contenant l’APK signé ;
4. vérifier la signature de release, le hash de l’APK, son package, son
   `versionCode` et sa signature Android ;
5. faire télécharger l’artefact dans le stockage privé de la TV ;
6. installer par `PackageInstaller`, puis confirmer la version et la santé
   avant d’avancer la vague.

Le squelette Android expose maintenant `AppUpdateAdapter`,
`AppUpdateCapabilities` et `VerifiedApkArtifact`. L’adaptateur actif répond
honnêtement « indisponible » tant que Device Owner n’est pas validé ; le
simulateur est réservé aux tests. Le client de téléchargement, la vérification
de signature APK et l’implémentation `PackageInstaller` restent à livrer.
Sans Device Owner, Android exigera une confirmation locale pour chaque mise à
jour et RoomFrame ne promet pas une installation silencieuse.
