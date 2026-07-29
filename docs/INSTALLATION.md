# Installation du serveur

## Prérequis

Le CT, la VM ou le serveur Debian possède déjà :

- une IPv4 de LAN, un masque et une passerelle ;
- des DNS internes ;
- une heure correcte ;
- un accès aux dépôts Debian et à GitHub lors de la première installation ;
- un compte capable d’utiliser `sudo`.

RoomFrame ne modifie jamais l’IP, le masque, la passerelle, les routes ou les
DNS. Sur Proxmox, cette configuration reste administrée par Proxmox.

L’installateur ajoute si nécessaire les outils système, Docker et Docker
Compose à partir des dépôts Debian, puis active le service Docker. Il crée
aussi un compte système `roomframe`, sans home ni shell interactif. L’API et le
worker utilisent son UID/GID au lieu d’un identifiant numérique supposé.

## Depuis le dépôt public

```bash
git clone --depth 1 https://github.com/Tech-VC/roomframe-tv.git
cd roomframe-tv
sudo ./install.sh
```

Pour imposer le nom publié par Caddy :

```bash
sudo ./install.sh --host roomframe.example.local
```

`--host` accepte un FQDN validé ou l’IPv4 principale détectée. Un schéma, un
port, un chemin, un nom DNS invalide ou une autre IPv4 sont refusés.

Quand la source possède un remote GitHub, l’installateur en déduit le dépôt de
releases. L’installateur autonome publié embarque le dépôt qui l’a construit.
Une source différente peut être fixée explicitement :

```bash
sudo ./install.sh \
  --updates-repository owner/roomframe-tv \
  --updates-channel stable \
  --update-poll-minutes 360
```

Le canal `stable` ignore les préreleases ; `preview` les accepte. La fréquence
doit rester entre 15 minutes et 7 jours. Une réinstallation conserve ces
valeurs. `--disable-github-updates` désactive le poller sans retirer l’import
hors ligne `.rfupdate`.

Sans `--host`, l’ordre de sélection est :

1. `roomframe.<suffixe-DNS-détecté>` ;
2. l’IPv4 principale si aucun suffixe valide n’existe.

Le suffixe est lu depuis le nom d’hôte puis la configuration de résolution.
L’IPv4 vient de la route principale, puis de la première adresse globale.
Aucune commande d’écriture réseau n’est exécutée.

Pour préparer le code, les volumes et les secrets sans démarrer les services :

```bash
sudo ./install.sh --no-start
```

Dans ce mode, la sortie indique « Préparation terminée » et non « Tout est
prêt », car le healthcheck HTTPS n’a pas été exécuté.

## Installateur autonome de release

Chaque release publiée produit un script qui contient l’URL exacte et le
SHA-256 de son archive :

```bash
curl -fsSL https://github.com/Tech-VC/roomframe-tv/releases/latest/download/roomframe-install.sh \
  | sudo bash
```

Avec un hôte explicite :

```bash
curl -fsSL https://github.com/Tech-VC/roomframe-tv/releases/latest/download/roomframe-install.sh \
  | sudo bash -s -- --host roomframe.example.local
```

Le script télécharge exclusivement en HTTPS, vérifie l’archive, refuse les
chemins ou types de fichiers non sûrs et installe la même pile que le dépôt.

## Résultat

Après démarrage et healthchecks, la sortie contient :

```text
Tout est prêt.
Interface d’administration : https://roomframe.example.local
API locale TV             : https://roomframe.example.local/api
URL de secours par IP     : https://192.0.2.20
Simulateur TV             : https://roomframe.example.local/simulator/
Updates GitHub signées     : owner/roomframe-tv · canal stable · toutes les 360 min
```

Si le FQDN ne pointe pas encore vers l’IPv4 détectée, l’installation continue.
L’URL IP reste disponible et la ligne exacte à créer dans le DNS unicast est
affichée :

```text
DNS à créer dans la zone interne : roomframe.example.local  A  192.0.2.20
```

Le certificat HTTPS de secours contient l’IPv4 détectée. Caddy utilise aussi
cette IPv4 comme SNI par défaut afin que les clients qui n’envoient aucun nom
de serveur lors d’un accès direct par IP reçoivent tout de même le bon
certificat local.

Les fichiers statiques de l’administration et du simulateur sont servis avec
`Cache-Control: no-cache` : le navigateur peut les conserver, mais doit les
revalider après une mise à jour. Cela évite de mélanger un nouvel HTML avec
une ancienne feuille de style ou un ancien JavaScript.
Le numéro de version des références CSS et JavaScript est également modifié
quand une release change ces fichiers, afin de sortir proprement d’un cache
créé avant l’ajout de cette politique.

## Configuration et données

```text
/opt/roomframe/                      code installé, appartenant à root
/etc/roomframe/runtime.conf         paramètres runtime non secrets
/etc/roomframe/Caddyfile            configuration HTTPS rendue
/etc/roomframe/secrets/             secrets root-only
/var/lib/roomframe/app/             état applicatif et récupération
/var/lib/roomframe/postgres/        PostgreSQL
/var/lib/roomframe/media/           originaux privés et variantes
/var/lib/roomframe/processing/      uploads temporaires et file locale
/var/lib/roomframe/pki/tv-client-ca/ CA cliente TV persistante root-only
/var/lib/roomframe/pki/server-ca/    copie publique CA HTTPS pour appairage TV
/var/lib/roomframe/releases/        mises à jour vérifiées
/var/lib/roomframe/backups/         sauvegardes
/var/lib/roomframe/pki/             confiance et clés publiques
/var/lib/roomframe/caddy/           données et autorité HTTPS locale
/var/lib/roomframe/caddy-config/    état Caddy
/var/lib/roomframe/seed/            expérience initiale figée
```

Les secrets PostgreSQL administrateur, migrateur et runtime, ainsi que les
secrets bootstrap, session et chiffrement TOTP, sont créés uniquement
lorsqu’ils sont absents. Une seconde exécution conserve les fichiers existants ;
aucun secret n’est régénéré silencieusement. Une installation antérieure reçoit
les deux nouveaux secrets PostgreSQL sans modifier son secret administrateur.

Un verrou local `/run/lock/roomframe-install.lock` refuse une seconde
installation, sauvegarde, restauration ou application de release tant qu’une
opération de maintenance est active. Il protège la sauvegarde, la copie du
code, les migrations, la restauration et la recréation des conteneurs contre
deux exécutions concurrentes.

Après construction réussie des images applicatives, l’installateur arrête
brièvement la pile sans supprimer aucun volume, puis recrée les réseaux
Compose. Cette étape est nécessaire pour appliquer réellement un durcissement
de réseau `internal` à une instance déjà installée ; un simple
`--force-recreate` des conteneurs ne modifie pas les propriétés d’un réseau
Docker existant.

Le répertoire `/etc/roomframe/secrets` reste `root:root` en mode `0700`. Ses
fichiers sont `root:root` en mode `0444` : ils restent inaccessibles directement
aux comptes non-root sur l’hôte, mais deviennent lisibles par l’API non-root
une fois montés individuellement et en lecture seule par Docker. Chaque service
ne reçoit que les secrets déclarés dans `compose.yaml`.

`database-roles` transfère idempotemment la propriété des objets historiques à
`roomframe_owner`, puis `migrate` applique les migrations avant tout service
permanent. Le propriétaire n’a pas de login ; le migrateur est one-shot et le
runtime ne possède aucun droit DDL. L’API, le worker et le poller ne lancent
jamais de migration à leur démarrage.

Le service `update-poller` est séparé de l’API et du worker média. Il ne reçoit
que le secret PostgreSQL runtime, le magasin de clés publiques en lecture seule
et les volumes `processing`/`releases`. Il ne publie aucun port. Lui seul
rejoint un réseau Docker de sortie Internet ; PostgreSQL reste sur le réseau
interne.

Le poller importe seulement. L’application automatique du serveur reste
`manual` par défaut et se configure ensuite dans le Studio. Lorsqu’elle est
explicitement activée, le courtier systemd root vérifie le délai, la fenêtre,
le fuseau, la provenance GitHub et l’absence de tentative antérieure avant de
mettre au plus une release en file. L’API ne reçoit toujours ni Docker ni sudo.

Le worker média traite également les transitions de scènes programmées toutes
les quelques secondes. Une activation ou une fin effective incrémente la
révision de synchronisation afin que les TV reçoivent le changement au prochain
poll. Une fenêtre entièrement manquée pendant un arrêt du worker est clôturée
et auditée sans être annoncée comme affichée.

`runtime.conf` mémorise également l’UID/GID du compte `roomframe`. Les médias,
traitements et releases lui appartiennent. La demande de récupération reste
écrite par root, lisible par le groupe runtime et montée en lecture seule dans
le conteneur API.

Le seed est copié seulement si son répertoire est vide. L’API l’applique dans
la base seulement lorsqu’aucune instance n’existe. Si PostgreSQL contient déjà
des données, `install.sh` exige la commande de sauvegarde de l’installation
existante et réalise une sauvegarde complète avant la recopie du code. Une
mise à jour sans sauvegarde exploitable est refusée.

La copie de code est additive : elle remplace les fichiers livrés, sans
supprimer un fichier présent uniquement dans `/opt/roomframe`. Cette stratégie
protège les données, mais n’est pas encore un déploiement atomique par
répertoire de version.

Les instructions locales `AGENTS.md`, les dossiers privés de validation
`local-branding/` et `local-hardware/`, ainsi que les métadonnées macOS
`.DS_Store` et AppleDouble `._*`, sont explicitement exclus de cette copie et
des archives de release.

## Commandes d’exploitation

```bash
sudo roomframe-compose ps
sudo roomframe-compose logs --tail=200 api worker update-poller
sudo roomframe-diagnose
sudo roomframe-backup
sudo roomframe-verify-backup --latest
sudo roomframe-restore \
  /var/lib/roomframe/backups/20260101T120000Z \
  --confirm 20260101T120000Z
sudo roomframe-apply-update \
  --release-id 00000000-0000-4000-8000-000000000000 \
  --confirm 0.3.1
sudo systemctl status roomframe-update-broker.timer
sudo systemctl status roomframe-tv-certificate-broker.timer
sudo roomframe-trust-update-key --key-id release-main \
  --public-key /chemin/release-main.pem \
  --sha256 EMPREINTE_SHA256
sudo roomframe-trust-update-key --revoke --key-id release-main \
  --sha256 EMPREINTE_SHA256
sudo roomframe-sync-server-ca
```

Les mêmes outils sont présents sous `/opt/roomframe/scripts/`. La commande
Compose charge uniquement `/etc/roomframe/runtime.conf` et monte les secrets
comme fichiers Docker sous `/run/secrets`.

Une sauvegarde met brièvement Caddy, l’API, le worker et le poller d’updates en
pause, produit un dump PostgreSQL au format custom, archive la configuration et
les données persistantes, puis écrit les SHA-256. Pour exclure les médias
volumineux :

```bash
sudo roomframe-backup --without-media
```

Une sauvegarde contient de la configuration sensible et de la PKI. Elle reste
root-only et doit être déplacée vers un stockage protégé.

`roomframe-verify-backup --latest` vérifie ensuite la liste et les permissions
des fichiers, les SHA-256, les métadonnées, la sûreté des archives et restaure
le dump dans un PostgreSQL 17 temporaire sans réseau ni port publié. Cette
validation ne modifie jamais la base installée. Un chemin explicite vers un
enfant direct de `/var/lib/roomframe/backups` peut remplacer `--latest`.

## Restauration complète

Une restauration est une action root explicite. Elle n’accepte pas `--latest` :
le nom du répertoire doit être répété après `--confirm`.

```bash
backup_id=20260101T120000Z
sudo roomframe-restore \
  "/var/lib/roomframe/backups/$backup_id" \
  --confirm "$backup_id"
```

Avant d’arrêter la pile, la commande vérifie la sauvegarde dans un PostgreSQL
isolé, prépare les archives dans des répertoires privés, crée une sauvegarde de
sécurité de l’état courant et la vérifie elle aussi. La configuration, les
secrets, la PKI et les données sont ensuite basculés par répertoires ; le dump
est chargé dans une base temporaire puis renommé. La pile complète et son URL
HTTPS doivent redevenir saines avant la suppression de l’ancienne base.

Tout échec après la première bascule déclenche le retour à la configuration,
aux données et à la base précédentes. Le chemin de la sauvegarde de sécurité
reste affiché et conservé. Une trace `backup.restored` est ajoutée au journal
d’audit après succès.

Pour éviter une base qui référencerait des fichiers absents, une sauvegarde
créée avec `--without-media` ne peut pas servir à cette restauration complète.
La version du code installée doit également correspondre à
`softwareVersion` dans la sauvegarde. Un changement de version passe par
`roomframe-apply-update`, qui associe le code signé, la sauvegarde et les
migrations.

## Application d’une release serveur importée

Une release `.rfupdate` valide et déjà importée peut être appliquée par sa
référence et sa version :

```bash
sudo roomframe-apply-update \
  --release-id 00000000-0000-4000-8000-000000000000 \
  --confirm 0.3.1
```

La commande root relit uniquement une release `verified` de PostgreSQL et
refuse un chemin de bundle fourni par l’opérateur. Elle exige que le fichier
soit exactement celui de la quarantaine adressée par hash, recalcule son
SHA-256, revalide Ed25519 avec la clé publique approuvée, puis contrôle
l’identité, la version, l’archive serveur et la liste des migrations.

Les images sont préconstruites avant l’interruption. Une sauvegarde complète
est ensuite créée et restaurée dans le PostgreSQL isolé de vérification. Le
code courant et le staging sont basculés sous `/opt` sur le même système de
fichiers, puis l’installateur idempotent exécute les migrations et les
healthchecks. Un échec après la bascule réinstalle automatiquement le code
précédent avec le point de retour déjà vérifié. Après succès, l’ancien code est
archivé avec son SHA-256 sous
`/var/lib/roomframe/app/server-rollbacks/`.

Les migrations restent additives et ne sont pas supprimées lors d’un retour
au code précédent. La sauvegarde complète permet une restauration explicite
si une intervention sur la base est nécessaire. L’API web ne lance jamais
cette commande et ne reçoit ni socket Docker ni privilège root.

L’installateur déploie aussi `roomframe-update-broker.service` et son timer
systemd. Depuis le Studio, une demande serveur écrit uniquement une ligne en
base après permission, CSRF et confirmation de version. Le service oneshot root
la prend au passage suivant, au plus une par exécution, puis appelle la même
commande de revalidation. Si le verrou de maintenance est occupé, la demande
retourne en file. `roomframe-diagnose` contrôle le timer et affiche le nombre de
demandes `pending|running`.

## Approuver une clé de mise à jour

Chaque release publie la clé publique et son fichier d’empreinte. Vérifiez
l’empreinte SHA-256 par un canal indépendant, puis installez la clé :

```bash
sudo roomframe-trust-update-key \
  --key-id release-main \
  --public-key /chemin/release-main.pem \
  --sha256 EMPREINTE_SHA256
```

La commande refuse les liens symboliques, les clés autres qu’Ed25519 et toute
empreinte différente. Elle installe la clé en `0640`, root et groupe
`roomframe`. Une clé existante identique rend la commande idempotente ; une
rotation différente exige `--replace`.

Pour une compromission ou un retrait, `--revoke` exige la même empreinte,
retire atomiquement la clé du magasin actif et la conserve sous
`/var/lib/roomframe/pki/update-revoked/`. Le moteur refusera ensuite toute
nouvelle application signée seulement par cette clé.

## Bootstrap initial

L’installateur ne révèle pas automatiquement le jeton. L’affichage doit être
demandé sur la console du serveur :

```bash
sudo roomframe-bootstrap-token --show
```

L’assistant utilise ce jeton pour créer un défi TOTP et le premier
administrateur. Le bootstrap est ensuite verrouillé dans PostgreSQL.

Une rotation explicite du fichier reste possible avant la configuration :

```bash
sudo roomframe-bootstrap-token --rotate --show
```

Si l’API est active, elle est recréée pour remonter le nouveau secret. Après
création de l’instance, cette rotation ne déverrouille pas le bootstrap.

## Récupération locale

Une personne ayant un accès root local peut créer une autorité temporaire :

```bash
sudo roomframe-recover-admin --create
```

La durée par défaut est 15 minutes et peut être réglée entre 5 et 60 minutes :

```bash
sudo roomframe-recover-admin --create --ttl-minutes 30
```

Une demande active n’est remplacée qu’avec `--replace`. Le jeton clair est
affiché une fois ; seul son SHA-256 et son expiration sont enregistrés. L’API
lie ensuite le défi au nom d’utilisateur, exige un nouveau TOTP et un nouveau
mot de passe, révoque les sessions existantes et interdit le rejeu.

## HTTPS local

Caddy émet un certificat pour le FQDN et l’IPv4. Sa racine se trouve après le
premier démarrage dans :

```text
/var/lib/roomframe/caddy/caddy/pki/authorities/local/root.crt
```

Cette racine doit être distribuée par un canal administré aux navigateurs et
épinglée ou installée lors de l’enrôlement des TV. L’APK release récupère une
copie chiffrée avec sa clé d’enrôlement, valide la chaîne TLS observée puis
épingle la CA avant de transmettre cette clé. Ne contournez pas les
avertissements TLS pour l’usage normal. L’API n’est pas publiée directement :
Caddy expose uniquement `443/tcp`.

L’installateur publie uniquement le certificat public vers :

```text
/var/lib/roomframe/pki/server-ca/ca.crt
```

La commande idempotente `sudo roomframe-sync-server-ca` refait cette
synchronisation après un démarrage différé avec `--no-start`. Elle n’expose ni
la clé racine ni la clé intermédiaire Caddy. `roomframe-diagnose` refuse une
copie absente, mal protégée ou différente de la CA active.

Une autorité distincte destinée aux certificats clients TV est créée une seule
fois pendant le bootstrap :

```text
/var/lib/roomframe/pki/tv-client-ca/ca.crt
/var/lib/roomframe/pki/tv-client-ca/private/ca.key
```

Le certificat public est `0644`; la clé privée est `0600 root:root` et n’est
montée dans aucun conteneur. `roomframe-tv-certificate-broker.timer` traite les
demandes d’émission toutes les dix secondes. Une réinstallation conserve la
CA ; si la paire est incomplète, l’installateur refuse de la régénérer
silencieusement.
