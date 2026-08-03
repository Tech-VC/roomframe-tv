# Démarrage rapide

Ce guide installe RoomFrame TV sur un CT, une VM ou un serveur Debian déjà
connecté au réseau local. L’installation ajoute la pile serveur, le Studio
d’administration et le simulateur TV. L’application Android TV se construit
et se déploie séparément.

## Prérequis

Le serveur doit disposer avant l’installation :

- d’une IPv4 de LAN, d’un masque, d’une passerelle et de DNS fonctionnels ;
- d’une heure correcte ;
- d’un accès temporaire aux dépôts Debian et à GitHub ;
- d’un compte autorisé à utiliser `sudo`.

RoomFrame ne modifie jamais l’adresse IP, les routes, la passerelle ou les DNS
du serveur.

## Installation en une commande

Depuis un répertoire dans lequel `roomframe-tv` n’existe pas encore :

```bash
git clone --depth 1 https://github.com/Tech-VC/roomframe-tv.git roomframe-tv \
  && cd roomframe-tv \
  && sudo ./install.sh
```

Pour imposer un nom HTTPS local :

```bash
git clone --depth 1 https://github.com/Tech-VC/roomframe-tv.git roomframe-tv \
  && cd roomframe-tv \
  && sudo ./install.sh --host roomframe.example.local
```

Sans `--host`, RoomFrame essaie
`roomframe.<suffixe-DNS-local-détecté>`, puis utilise l’IPv4 principale si
aucun suffixe valide n’est disponible.

Lorsqu’une release est publiée, son installateur autonome vérifie le SHA-256
de l’archive avant extraction :

```bash
curl -fsSL https://github.com/Tech-VC/roomframe-tv/releases/latest/download/roomframe-install.sh \
  | sudo bash
```

## Ce que fait l’installateur

L’installateur :

1. détecte l’IPv4 principale et le suffixe DNS sans les modifier ;
2. installe Docker et Docker Compose s’ils sont absents ;
3. crée les comptes, secrets et volumes persistants avec des droits limités ;
4. construit et démarre PostgreSQL, l’API, le worker et Caddy ;
5. applique les migrations additives après une sauvegarde vérifiée lorsque
   l’instance existe déjà ;
6. contrôle l’interface HTTPS par FQDN et par IP avant d’afficher
   `Tout est prêt.`.

Une seconde exécution est supportée : elle conserve la base, les médias, la
PKI, les secrets, les sauvegardes et la personnalisation.

## Résultat attendu

La fin de l’installation affiche les valeurs propres à l’instance :

```text
Tout est prêt.
Interface d’administration : https://roomframe.example.local
API locale TV             : https://roomframe.example.local/api
URL de secours par IP     : https://192.0.2.20
Simulateur TV             : https://roomframe.example.local/simulator/
```

Si le nom n’existe pas encore dans le DNS unicast, l’installateur affiche
également l’enregistrement `A` à créer. L’URL IP reste disponible.

## Première connexion

Le jeton de bootstrap se lit uniquement sur la console locale :

```bash
sudo roomframe-bootstrap-token --show
```

Ouvrir ensuite l’URL d’administration affichée par l’installateur. L’assistant
crée le premier propriétaire, son mot de passe Argon2id et son second facteur
TOTP. Il ne demande aucune configuration réseau.

Pour éviter l’alerte du navigateur, distribuer la CA locale indiquée à la fin
de l’installation uniquement aux postes administrés qui doivent faire
confiance à cette instance.

## Contrôle et maintenance

```bash
sudo roomframe-diagnose
sudo roomframe-compose ps
sudo roomframe-backup
sudo roomframe-verify-backup --latest
```

Avant la mise en production, exporter l’identité de reprise vers un support
hors ligne protégé :

```bash
sudo roomframe-backup-key --export-identity \
  /chemin/hors-ligne/roomframe-backup.agekey
```

Pour les détails sur le DNS `.local`, les certificats, les mises à jour et la
récupération administrateur, consulter :

- [Installation complète](INSTALLATION.md)
- [Réseau et découverte locale](NETWORKING.md)
- [Installation et rattachement d’une TV](TV_PROVISIONING.md)
- [Sécurité](SECURITY.md)
- [Mises à jour](UPDATES.md)
