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
/var/lib/roomframe/releases/        mises à jour vérifiées
/var/lib/roomframe/backups/         sauvegardes
/var/lib/roomframe/pki/             confiance et clés publiques
/var/lib/roomframe/caddy/           données et autorité HTTPS locale
/var/lib/roomframe/caddy-config/    état Caddy
/var/lib/roomframe/seed/            expérience initiale figée
```

Les secrets PostgreSQL, bootstrap, session et chiffrement TOTP sont créés
uniquement lorsqu’ils sont absents. Une seconde exécution conserve les fichiers
existants ; aucun secret n’est régénéré silencieusement.

Un verrou local `/run/lock/roomframe-install.lock` refuse une seconde
installation tant que la première est active. Il protège la sauvegarde, la
copie du code, les migrations et la recréation des conteneurs contre deux
exécutions concurrentes.

Le répertoire `/etc/roomframe/secrets` reste `root:root` en mode `0700`. Ses
fichiers sont `root:root` en mode `0444` : ils restent inaccessibles directement
aux comptes non-root sur l’hôte, mais deviennent lisibles par l’API non-root
une fois montés individuellement et en lecture seule par Docker. Chaque service
ne reçoit que les secrets déclarés dans `compose.yaml`.

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
sudo roomframe-compose logs --tail=200 api worker
sudo roomframe-diagnose
sudo roomframe-backup
sudo roomframe-verify-backup --latest
sudo roomframe-trust-update-key --key-id release-main \
  --public-key /chemin/release-main.pem \
  --sha256 EMPREINTE_SHA256
```

Les mêmes outils sont présents sous `/opt/roomframe/scripts/`. La commande
Compose charge uniquement `/etc/roomframe/runtime.conf` et monte les secrets
comme fichiers Docker sous `/run/secrets`.

Une sauvegarde met brièvement l’API et le worker en pause, produit un dump
PostgreSQL au format custom, archive la configuration et les données
persistantes, puis écrit les SHA-256. Pour exclure les médias volumineux :

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
épinglée ou installée lors de l’enrôlement des TV. Ne contournez pas les
avertissements TLS pour l’usage normal. L’API n’est pas publiée directement :
Caddy expose uniquement `443/tcp`.
