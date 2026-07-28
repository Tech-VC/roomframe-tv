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

Pour une release signée déjà importée, le chemin privilégié est désormais :

```bash
sudo roomframe-apply-update \
  --release-id 00000000-0000-4000-8000-000000000000 \
  --confirm 0.3.1
```

La commande n’accepte pas de chemin arbitraire. Elle relit la quarantaine
adressée par SHA-256, revalide la signature Ed25519 et la compatibilité, extrait
l’unique `server-archive` dans un staging root-only, contrôle les versions et
la liste de migrations, puis préconstruit les images.

Après création et vérification d’une sauvegarde complète, le répertoire de code
est basculé sous le même parent `/opt`. Le nouvel installateur applique les
migrations additives et exige les healthchecks HTTPS, API, worker et poller.
Un échec rétablit et réinstalle automatiquement le code précédent. La
sauvegarde reste disponible pour une restauration explicite de la base ; les
migrations ne sont pas supprimées automatiquement.

## Format `.rfupdate`

Un bundle est un ZIP contenant au minimum :

```text
release.rfupdate
├── manifest.json
├── manifest.sig
└── server/roomframe-server-<version>.tar.gz
```

Le contrat peut aussi décrire des APK, images OCI, migrations ou verrous
Compose. Un `home-apk` ou `agent-apk` porte obligatoirement son package Android,
son `versionCode` et le SHA-256 de son certificat de signature. Chaque artefact
présent doit être listé par le manifeste.

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

## Import automatique depuis GitHub

L’installateur configure un dépôt `owner/repo` lorsqu’il peut le déduire du
remote GitHub ou de l’installateur autonome. Une autre source, un canal et une
fréquence peuvent être fournis sans secret :

```bash
sudo ./install.sh \
  --updates-repository owner/roomframe-tv \
  --updates-channel stable \
  --update-poll-minutes 360
```

Le service `update-poller` interroge au plus 20 releases publiées. `stable`
ignore les préreleases ; `preview` accepte la première release publiée
contenant exactement un asset `.rfupdate`. Les requêtes utilisent l’API REST
GitHub versionnée et un ETag. Le poller public non authentifié reste par défaut
à six heures, très en dessous de la limite publique ; il ne nécessite aucun
token GitHub. Voir la documentation GitHub sur les
[releases](https://docs.github.com/en/rest/releases/releases), les
[assets](https://docs.github.com/en/rest/releases/assets) et les
[requêtes conditionnelles](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests-if-appropriate).

Avant l’écriture, RoomFrame contrôle l’identifiant et l’URL d’asset API, la
taille annoncée, l’espace disque, les redirections HTTPS autorisées, le nombre
d’octets et le digest SHA-256 GitHub lorsqu’il est fourni. Le `.rfupdate`
téléchargé passe ensuite dans le même vérificateur Ed25519, de contrat et de
compatibilité que l’import hors ligne. Une release identique est reconnue de
manière idempotente.

Le poller ne possède ni accès Docker, ni secret de session/TOTP, ni port
entrant. Il importe et historise uniquement. Il ne lance pas de déploiement TV
et n’applique pas le code serveur.

## Demande depuis l’administration

Le Studio propose uniquement les releases vérifiées contenant une archive
serveur. L’administrateur doit retaper la version ; l’API crée alors une ligne
`server_update_requests` et une trace d’audit. Une contrainte SQL interdit deux
demandes `pending`/`running` simultanées.

`roomframe-update-broker.timer` réveille chaque minute un service oneshot root.
Le courtier prend au plus une ligne puis appelle `roomframe-apply-update` avec
son UUID et la version confirmée. Il ne fait confiance ni à un chemin venant de
la base, ni au statut de vérification initial : le moteur recalcule le hash,
retrouve la clé approuvée et revalide Ed25519. Si une autre maintenance détient
le verrou, la demande retourne en file ; un processus interrompu devient un
échec contrôlé au passage suivant.

Le conteneur API n’a ni socket Docker, ni sudo, ni montage du courtier. Sa seule
capacité supplémentaire est l’écriture de la demande en base, déjà limitée par
la permission `releases:write` et CSRF.

Avant toute application de release, une sauvegarde peut être éprouvée sans
toucher à l’instance :

```bash
sudo roomframe-backup
sudo roomframe-verify-backup --latest
```

La seconde commande contrôle l’enveloppe puis restaure réellement le dump dans
un PostgreSQL temporaire sans réseau.

Une restauration complète de la même version est disponible avec un
identifiant répété explicitement :

```bash
backup_id=20260101T120000Z
sudo roomframe-restore \
  "/var/lib/roomframe/backups/$backup_id" \
  --confirm "$backup_id"
```

Elle vérifie d’abord la sauvegarde visée, crée et vérifie un point de retour de
l’état courant, restaure les fichiers par bascule de répertoires, charge le
dump dans une base temporaire, renomme les bases, puis exige un healthcheck
complet et HTTPS. Un échec déclenche le retour automatique. Les sauvegardes
sans médias et les changements de version sont refusés.

## Plans canari et progressifs

Après import, l’API peut enregistrer :

- une stratégie `canary` ciblant une TV ;
- une stratégie `progressive` ciblant un groupe ou le parc.

La première vague passe à `offered`. Chaque TV autorisée récupère uniquement
l’APK qui lui est affecté, puis annonce les états `downloaded`, `installing`,
`installed`, `failed` ou `deferred`. L’administration ne peut ouvrir la vague
suivante tant que la vague active contient un téléchargement, une installation
ou un échec. Les cibles suivantes restent `queued`. Une version annoncée comme
installée est acceptée uniquement si elle correspond à la release distribuée ;
un échec doit fournir un code de diagnostic contrôlé. L’opérateur peut remettre
explicitement les cibles `failed` ou `deferred` dans la vague sans recréer le
plan de déploiement.

L’APK extrait du bundle vérifié est matérialisé par hash sous
`/var/lib/roomframe/releases/artifacts/`; son chemin interne n’est jamais
renvoyé par l’API. Ce mécanisme distribue l’application TV, pas encore le code
du serveur.

## Ce qui reste à implémenter

Le jalon ne comprend pas encore :

- une politique d’application serveur entièrement automatique et
  explicitement activable après import GitHub ;
- la matérialisation d’images OCI lorsqu’un bundle en fournit ;
- la validation physique de l’installation silencieuse APK en Device Owner ;

Deux frontières restent particulièrement importantes :

- le rôle PostgreSQL `roomframe` initial cumule propriété, migration et accès
  applicatif ; sa séparation exigera une migration et une procédure
  d’exploitation versionnées ;
- `roomframe-apply-update` est un composant privilégié minimal, séparé de
  l’API web. Aucun endpoint HTTP ne reçoit directement le droit de remplacer
  le code, de contrôler Docker ou de restaurer une base. Le courtier systemd
  ne consomme que des releases signées déjà importées et revalidées.

La séquence serveur actuellement exécutable est :

1. vérifier et quarantainer ;
2. sauvegarder ;
3. appliquer dans un staging ;
4. exécuter les migrations ;
5. basculer le répertoire de code ;
6. vérifier ;
7. revenir au code précédent sur échec ;
8. conserver la restauration explicite déjà disponible.

Les vagues canari et progressives concernent l’APK TV. L’application serveur
peut être demandée depuis le Studio ou lancée manuellement par la commande
root ; elle n’est jamais déclenchée par le simple téléchargement GitHub.

## Migrations et seed

Les migrations sont versionnées et enregistrées avec leur SHA-256. Une
migration déjà appliquée dont le contenu a changé est refusée. Le script
maintient son verrou advisory dans la même session et enregistre le checksum
dans la transaction de migration.

`experience_seed_history` garantit que le bundle initial n’est appliqué qu’une
fois sur base vide. Relancer les migrations ou l’installateur ne réapplique pas
les valeurs par défaut.

## Android

Une mise à jour APK doit garder `applicationId` et clé de signature. Android
peut alors remplacer le code sans effacer les données privées. Le client
conserve son cache et la dernière révision complète validée.

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

Tant que RoomFrame est visible, le client Android interroge périodiquement
`/api/v1/tv/update`, télécharge par flux dans son stockage privé, vérifie
taille, SHA-256, package, `versionCode`, certificat du manifeste et
compatibilité avec la lignée de signature installée. Le fichier n’atteint
`PackageInstaller` qu’après ces contrôles.

L’adaptateur Android n’essaie l’installation silencieuse que lorsque
`DevicePolicyManager` confirme que RoomFrame est Device Owner. Sinon l’état
reste « APK vérifié · Device Owner requis » et aucune réussite n’est simulée.
Le parcours Device Owner reste à valider physiquement après réinitialisation de
la Philips.
