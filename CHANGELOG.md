# Changelog

## 0.3.0 — 2026-07-25

Premier jalon serveur/admin exécutable :

- installation Debian idempotente, HTTPS local Caddy, origine unique et
  volumes persistants séparés du code ;
- détection de l’IPv4 et du suffixe DNS sans modification du réseau, avec
  option `--host` et URL IP de secours ;
- secrets root-only créés une seule fois, commandes de diagnostic, sauvegarde,
  vérification de restauration isolée, bootstrap et récupération ;
- PostgreSQL 17, migrations additives vérifiées par checksum et bundle initial
  appliqué une seule fois sur instance vide ;
- bootstrap concurrent sûr, premier propriétaire Argon2id, MFA TOTP, sessions,
  CSRF, rôles, limitation de débit et audit ;
- modèles et API pour l’instance, le parc, les scènes et révisions, les médias,
  les messages, les sources, la puissance, la télémétrie et les releases ;
- publication atomique d’une scène et manifeste TV par révision avec hashes ;
- Studio web relié à l’API réelle : bootstrap/TOTP, session, scène 1920 × 1080,
  drag/resize, clavier, propriétés, historique, médias, messages et releases ;
- cible d’aperçu volontairement limitée à l’instance tant que les affectations
  TV/groupe ne sont pas exposées par l’API ;
- simulateur IndexedDB avec vérification des documents/assets, staging,
  activation transactionnelle, révision précédente et mode API coupée ;
- enrôlement TV temporaire puis remise unique d’une clé d’appareil ;
- pipeline image/vidéo adressé par hash, file PostgreSQL durable, variantes
  1080p/4K pertinentes et métadonnées supprimées ;
- import `.rfupdate` vérifié par Ed25519, structure, compatibilité, tailles et
  hashes et unicité des clés JSON, puis quarantaine et plan
  canari/progressif ;
- génération CI d’un installateur autonome et d’un `.rfupdate` signé avec une
  clé conservée dans l’environnement GitHub protégé `release-signing` ;
- compte système `roomframe` sans login pour l’API/worker, récupération montée
  en lecture seule et images externes verrouillées par digest ;
- copie d’installation filtrant les instructions locales, médias et relevés
  matériels privés, ainsi que les métadonnées macOS AppleDouble ;
- tests unitaires et intégration PostgreSQL, checks de contrats, scripts, CSP
  et configuration Compose : 14 tests Studio/synchronisation TV et 19 tests
  API, dont médias et import `.rfupdate` multipart réels, exécutés par les
  workflows de validation et de release sur clone frais.

Limites connues de ce jalon :

- le poller GitHub et l’application automatique d’une mise à jour ne sont pas
  encore implémentés ;
- le ciblage d’aperçu TV/groupe reste à implémenter ;
- le client Android possède les interfaces et le stockage atomique, mais pas
  encore leur intégration réseau/PKI complète ;
- le rôle PostgreSQL initial reste propriétaire, migrateur et runtime ;
- les adaptateurs Philips, HDMI, puissance, Cast et AirPlay ne sont pas validés
  sur matériel ; PhairPlay est volontairement absent.

## 0.2.1 — 2026-07-25

- ajout de `CODEX_START_PROMPT.md` prêt à utiliser ;
- cadrage du jalon serveur/admin exécutable ;
- ajout des exigences de sécurité, persistance, fonctionnement hors ligne et
  mises à jour non destructives dans le prompt de lancement.

## 0.2.0

- installateur Debian/CT initial ;
- détection automatique de l’IP et du suffixe DNS ;
- administration et API sous une seule origine HTTPS ;
- bundle d’expérience neutre versionné ;
- première structure des volumes, migrations, contrats, prototype studio et
  squelette Android.
