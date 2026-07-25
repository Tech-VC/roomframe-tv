# Modèle de sécurité

## Principes

- aucun secret, certificat d’instance ou mot de passe dans Git ;
- HTTPS obligatoire, avec administration et API de même origine ;
- bootstrap à usage unique puis verrou définitif ;
- Argon2id, MFA TOTP, sessions bornées, CSRF et limitation de débit ;
- rôles explicites et journal d’audit ;
- validation stricte des scènes, médias et bundles ;
- moindre privilège des conteneurs et exposition réseau minimale ;
- collecte de télémétrie technique limitée, sans contenu vu ni appareil
  personnel.

WebAuthn, les certificats individuels TV et le mTLS font partie de
l’architecture cible, mais ne sont pas encore implémentés dans ce jalon.

## Secrets de l’instance

L’installation crée une fois, sous `/etc/roomframe/secrets/` :

- `postgres_password` ;
- `bootstrap_token` ;
- `session_secret` ;
- `totp_encryption_key`.

Ces fichiers sont root-only, réguliers, non vides et en mode `0600`. Ils sont
montés dans les conteneurs sous `/run/secrets` et ne transitent pas dans les
variables d’environnement. Une seconde installation conserve leur contenu.

`/etc/roomframe/runtime.conf` contient uniquement les chemins, URL, hôte,
IPv4, version et fuseau nécessaires à Compose.

## Identités administrateur

Les phrases de passe doivent faire entre 12 et 256 caractères, couvrir au
moins trois classes et ne pas commencer par une valeur faible connue. Elles
sont hachées avec Argon2id.

Le secret TOTP est généré aléatoirement, chiffré au repos avec AES-256-GCM et
associé à un défi temporaire. La vérification tolère une fenêtre d’un pas et
refuse la réutilisation d’un compteur déjà accepté.

Le jeton initial est lu explicitement avec :

```bash
sudo roomframe-bootstrap-token --show
```

L’API le compare en temps constant. La création du propriétaire, de l’instance
et du seed est transactionnelle ; une seconde tentative reçoit un conflit.

## Sessions, permissions et audit

Les jetons de session ne sont stockés qu’après HMAC. Le cookie
`__Host-roomframe_session` est `Secure`, `HttpOnly`, `SameSite=Strict`, sans
attribut Domain et limité au chemin `/`. La durée par défaut est 12 heures.

Les écritures exigent :

1. une session active ;
2. la permission correspondant à la route ;
3. un `x-csrf-token` lié à la session ;
4. une origine égale au FQDN ou à l’URL IP de secours lorsqu’un en-tête Origin
   est présent.

Les rôles initiaux séparent propriétaire, contenu et sécurité. Les lectures
agrégées du Studio retirent les collections auxquelles le rôle n’a pas droit.
Les actions sensibles produisent un événement dans `audit_log`.

## Récupération locale

```bash
sudo roomframe-recover-admin --create
```

La commande exige root, génère un jeton aléatoire et n’écrit que son SHA-256,
sa date et son expiration. L’API crée aussi une autorité one-shot verrouillée
en base, lie le défi TOTP au compte demandé, puis :

- remplace le hash du mot de passe et le secret TOTP ;
- révoque toutes les sessions du compte ;
- consomme le défi et l’autorité ;
- journalise la récupération.

Le répertoire de demande est monté en lecture seule dans l’API. La tentative
de marquage du fichier reste best effort, mais la consommation autoritative en
base empêche le rejeu même lorsque le fichier root-owned reste inchangé.

## HTTPS et navigateur

Caddy crée une autorité locale. Sa racine est distribuée par un canal
administré ou épinglée pendant l’enrôlement TV.

Les en-têtes incluent HSTS, `nosniff`, refus des frames, politique de
référent, Permissions Policy et une CSP restrictive. Les scripts et feuilles
de style doivent être des fichiers locaux ; la CSP n’autorise ni code inline,
ni objet, ni frame, ni base externe. Les aperçus contrôlés peuvent utiliser
`blob:` et certaines images `data:`.

`scripts/check.sh` refuse les scripts, styles et attributs de style inline dans
les deux interfaces.

## TV et données

La clé d’enrôlement expire après 30 minutes et ne peut pas synchroniser. Elle
est échangée atomiquement contre une clé d’appareil remise une fois. Seul son
SHA-256 est stocké.

Les téléchargements d’une TV sont limités aux assets de sa scène. Les
métriques et événements acceptent des champs et types fermés, des tailles
bornées et une rétention de 90 jours par défaut.

Limites avant production :

- clés TV bearer sans rotation administrée ;
- pas encore de certificat client individuel ni mTLS ;
- découverte locale authentifiée non implémentée ;
- gestion de révocation et renouvellement PKI à ajouter.

## Conteneurs et base

- seul Caddy publie `443/tcp` ;
- PostgreSQL reste sur le réseau Docker interne ;
- l’installateur crée le compte système Debian `roomframe`, sans home ni shell
  de connexion ; l’API et le worker utilisent son UID/GID explicite ;
- API et worker utilisent une racine en lecture seule, des `tmpfs` bornés,
  `no-new-privileges`, aucune capacité Linux et des limites CPU/mémoire/PID ;
- le répertoire de récupération et le magasin de clés publiques sont montés en
  lecture seule dans l’API ;
- les volumes écrits sont limités à leurs responsabilités ;
- le code installé appartient à root et n’est pas modifiable par groupe ou
  autres utilisateurs.

Les images externes Caddy et PostgreSQL sont verrouillées par digest dans
Compose. L’image API est construite depuis une image Node elle aussi verrouillée
par digest et des dépendances npm issues du lockfile. Un changement amont ne
peut donc pas remplacer silencieusement ces bases sous le même tag.

Dans `0.3.0`, le rôle PostgreSQL `roomframe` créé par l’image assure aussi les
migrations. La base n’est pas exposée au LAN, mais la séparation
propriétaire/migrateur/runtime reste un durcissement nécessaire. Les
migrations automatiques au démarrage doivent rester précédées de la sauvegarde
effectuée par l’installateur lors d’une mise à niveau existante.

## Médias et updates

Les médias sont typés d’après leurs octets, stockés par hash, traités hors
requête et servis seulement depuis des variantes produites. SVG, HTML et
JavaScript libre sont refusés.

Les `.rfupdate` exigent une signature Ed25519 et une clé publique approuvée.
La clé privée reste hors du dépôt et du serveur. La requête d’import ne fait
qu’une vérification et une mise en quarantaine ; elle n’exécute ni shell, ni
migration, ni image. Le vérificateur CLI refuse les clés JSON dupliquées ; la
parité de ce contrôle dans le vérificateur Node de l’API reste à ajouter.

Une clé publique est approuvée uniquement après contrôle d’empreinte :

```bash
sudo roomframe-trust-update-key \
  --key-id release-main \
  --public-key /chemin/release-main.pem \
  --sha256 EMPREINTE_SHA256
```

Le workflow de signature utilise l’environnement GitHub
`release-signing`. Cet environnement doit conserver ses règles de protection
et approbateurs ; le job de vérification non privilégié n’a pas accès à la clé
et le job de packaging reçoit `contents: write` seulement après validation.

## Sauvegardes

`roomframe-backup` produit un dump PostgreSQL et des archives avec
`SHA256SUMS`. Une sauvegarde contient la configuration et la PKI : elle doit
être protégée comme un secret, déplacée vers un stockage sûr et chiffrée selon
la politique de l’organisation.
