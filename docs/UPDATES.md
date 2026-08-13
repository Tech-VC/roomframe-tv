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
2. il exécute `roomframe-backup` avant de recopier le code, puis restaure le
   dump dans un PostgreSQL isolé pour vérifier réellement le point de retour ;
3. il conserve les secrets et le seed existants ;
4. il reconstruit et redémarre la pile ;
5. le conteneur one-shot `migrate` applique les nouvelles migrations additives
   sous verrou avant le redémarrage de l’API ;
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

Un bundle serveur destiné au canal GitHub est un ZIP contenant :

```text
release.rfupdate
├── manifest.json
├── manifest.sig
├── metadata/roomframe-<version>.spdx.json
└── server/roomframe-server-<version>.tar.gz
```

Le contrat peut aussi décrire des APK, images OCI, migrations ou verrous
Compose. Un `home-apk` ou `agent-apk` porte obligatoirement son package Android,
son `versionCode` et le SHA-256 de son certificat de signature. Le SBOM SPDX
2.3 décrit le lockfile npm, les coordonnées Gradle, le wrapper et les images
OCI épinglées ; son package racine porte le SHA-256 de l’archive serveur.
Chaque artefact présent doit être listé par le manifeste.
Un ancien bundle ou un import strictement manuel peut ne pas porter de champ
`source` ni de SBOM ; il reste vérifiable par Ed25519, mais n’est jamais accepté
comme provenance GitHub ni éligible à l’application automatique.

Avant la quarantaine, le serveur vérifie :

1. chemins ZIP, doublons d’entrées, liens et chiffrement ;
2. limites de taille et de ratio de compression ;
3. contrat, version plus récente et compatibilité serveur/architecture ;
4. taille et SHA-256 de chaque artefact ;
5. absence d’artefact non listé ;
6. cohérence du SBOM avec la version et l’archive serveur ;
7. signature Ed25519 des octets exacts de `manifest.json`, dont le dépôt, le
   commit et la ref source lorsqu’ils sont présents.

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

Une clé compromise ou retirée est révoquée avec la même preuve d’empreinte :

```bash
sudo roomframe-trust-update-key \
  --revoke \
  --key-id release-main \
  --sha256 EMPREINTE_SHA256
```

RoomFrame la déplace atomiquement de `update-trust/` vers l’archive root-only
`update-revoked/`. Les bundles historiques restent audités, mais ne passent
plus la nouvelle vérification obligatoire avant application.

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
compatibilité que l’import hors ligne. Pour une source GitHub, RoomFrame exige
en plus un tag `v<version>`, le même dépôt dans la source signée, la ref exacte
du tag et un unique SBOM SPDX valide. Une release identique est reconnue de
manière idempotente.

Le workflow de publication crée également des attestations GitHub/Sigstore de
provenance SLSA et de SBOM. Elles permettent une vérification publique du
runner, du workflow et du commit. Elles complètent la signature Ed25519
RoomFrame, mais ne sont pas requises par une instance hors ligne.

Le poller ne possède ni accès Docker, ni secret de session/TOTP, ni port
entrant. Il importe et historise uniquement. Il ne lance pas de déploiement TV
et n’applique pas le code serveur.

Dans `Versions`, l’action **Rechercher maintenant** crée une demande persistante
en base puis réveille ce même poller par une notification PostgreSQL. La régie
web ne reçoit donc aucun accès Internet supplémentaire. Le résultat apparaît
dans la source GitHub et une limite courte empêche les contrôles répétés. Si le
poller redémarre après la demande, il reprend la recherche restée en attente.

## Application automatique opt-in

L’import GitHub et l’application serveur restent deux étapes distinctes. Par
défaut, `server_update_policy.mode` vaut `manual` et aucun téléchargement ne
déclenche une bascule.

Un administrateur doté de `releases:write` peut activer dans le Studio une
politique `automatic` après avoir retapé
`ACTIVER LES MISES A JOUR AUTOMATIQUES`. Il choisit :

- un délai minimal de 15 minutes à 7 jours après l’import ;
- une fenêtre de maintenance, y compris lorsqu’elle traverse minuit ;
- un fuseau IANA validé par PostgreSQL.

À chaque réveil, le courtier root évalue cette politique avant de prendre la
file. Il ne sélectionne qu’une release `verified`, non déployée, contenant
exactement un `server-archive`, importée par le poller GitHub et assez ancienne.
La source signée doit correspondre au manifeste enregistré et son SBOM SPDX
doit avoir été validé ; une ancienne entrée GitHub antérieure à ces contrôles
reste donc manuelle. Les imports manuels `.rfupdate` restent eux aussi soumis
à une demande humaine.

Une release ayant déjà produit une demande, quel qu’en soit le résultat,
n’est jamais remise en file automatiquement. Un échec, une interruption ou un
rollback exige donc une décision humaine explicite. La contrainte d’unicité
continue d’interdire deux opérations `pending`/`running`.

## Demande depuis l’administration

Le Studio propose uniquement les releases vérifiées contenant une archive
serveur. L’administrateur doit retaper la version ; l’API crée alors une ligne
`server_update_requests` et une trace d’audit. Une contrainte SQL interdit deux
demandes `pending`/`running` simultanées.

`roomframe-update-broker.timer` réveille chaque minute un service oneshot root.
Le courtier prend au plus une ligne puis appelle `roomframe-apply-update` avec
son UUID et la version confirmée. Il ne fait confiance ni à un chemin venant de
la base, ni au statut de vérification initial : il dérive le fichier hôte depuis
la quarantaine et le SHA-256, recalcule ce hash, retrouve la clé approuvée et
revalide Ed25519. Si une autre maintenance détient le verrou, la demande retourne
en file ; un processus interrompu devient un échec contrôlé au passage suivant.

Le conteneur API n’a ni socket Docker, ni sudo, ni montage du courtier. Sa seule
capacité supplémentaire est l’écriture de la demande en base, déjà limitée par
la permission `releases:write` et CSRF.

Avant toute application de release, une sauvegarde peut être éprouvée sans
toucher à l’instance :

```bash
sudo roomframe-backup
sudo roomframe-verify-backup --latest
```

Les nouveaux points utilisent le format 2 : dump, configuration et données
persistantes sont chiffrés en flux dans trois fichiers `.age`. La clé privée
n’est jamais placée dans le dépôt de code ni dans le répertoire final de la
sauvegarde. La seconde commande contrôle l’enveloppe, authentifie le
chiffrement, inspecte les archives puis restaure réellement le dump dans un
PostgreSQL temporaire sans réseau. Les sauvegardes historiques au format 1
restent vérifiables pour permettre une mise à niveau non destructive.

Une reprise après perte totale du serveur exige d’avoir exporté l’identité
root-only sur un support hors ligne :

```bash
sudo roomframe-backup-key --export-identity \
  /chemin/hors-ligne/roomframe-backup.agekey
```

La destination ne doit pas exister et n’est jamais écrasée.

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

- la matérialisation d’images OCI lorsqu’un bundle en fournit ;
- la validation physique de l’installation silencieuse APK en Device Owner ;

Une frontière reste particulièrement importante :

- `roomframe-apply-update` est un composant privilégié minimal, séparé de
  l’API web. Aucun endpoint HTTP ne reçoit directement le droit de remplacer
  le code, de contrôler Docker ou de restaurer une base. Le courtier systemd
  ne consomme que des releases signées déjà importées et revalidées.

La mise à jour conserve les trois secrets PostgreSQL existants. L’étape
`database-roles` est idempotente, transfère les anciens objets encore possédés
par le rôle historique, puis le migrateur one-shot applique les fichiers
versionnés. Les services runtime ne peuvent pas appliquer une migration.

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
peut être demandée depuis le Studio, lancée manuellement par la commande root
ou mise en file par la politique opt-in. Le simple téléchargement GitHub ne
suffit jamais : délai, fenêtre, provenance et absence de tentative antérieure
doivent tous être validés par le courtier.

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
Lorsque cette capacité est présente, la TV n’affiche pas de demande de
confirmation : elle installe au démarrage avant toute interaction, après 15
minutes d’inactivité ou juste avant une veille demandée par RoomFrame. Le
troisième déclencheur attend encore l’implémentation et la validation de
l’adaptateur de veille réel. Le parcours Device Owner et `PackageInstaller`
restent à valider physiquement après réinitialisation de la Philips. La
procédure et le mode manuel d’enrôlement sont décrits dans
[TV_PROVISIONING.md](TV_PROVISIONING.md).
