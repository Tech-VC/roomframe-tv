# Signature des mises à jour

## Format signé

`manifest.sig` est la signature Ed25519 des octets exacts de
`manifest.json`. Le format produit est une signature binaire brute de 64
octets. Le manifeste désigne la clé :

```json
{
  "signature": {
    "algorithm": "Ed25519",
    "keyId": "release-main"
  }
}
```

Le serveur ne cherche que la clé publique approuvée
`<keyId>.pem` dans son répertoire de confiance. Aucune clé privée n’est
nécessaire pour vérifier ou importer une release.

## Construire une release serveur

La clé privée doit être un fichier régulier hors du dépôt, accessible
uniquement à son propriétaire :

```bash
chmod 0600 /chemin-protege/release-private.pem
COPYFILE_DISABLE=1 tar -C /chemin/source-roomframe -czf \
  dist/roomframe-tv-v0.3.0.tar.gz .
python3 scripts/build-sbom.py \
  --version 0.3.0 \
  --source-archive dist/roomframe-tv-v0.3.0.tar.gz \
  --source-repository OWNER/REPO \
  --source-revision SHA_GIT_COMPLET \
  --created-at 2026-07-29T12:00:00Z \
  --output dist/roomframe-tv-v0.3.0.spdx.json
python3 scripts/build-signed-update.py \
  --artifact dist/roomframe-tv-v0.3.0.tar.gz \
  --sbom dist/roomframe-tv-v0.3.0.spdx.json \
  --source-repository OWNER/REPO \
  --source-revision SHA_GIT_COMPLET \
  --source-ref refs/tags/v0.3.0 \
  --version 0.3.0 \
  --private-key /chemin-protege/release-private.pem \
  --key-id release-main \
  --output dist/roomframe-tv-v0.3.0.rfupdate
```

Le script :

- refuse une clé privée trop permissive ;
- refuse les liens, périphériques, traversées et métadonnées AppleDouble du
  tar serveur, et exige la même liste de migrations que le dépôt ;
- calcule le SHA-256 et la taille de l’archive serveur ;
- valide que le SBOM SPDX 2.3 décrit cette archive exacte et la même version ;
- lie dans les octets signés le dépôt, le SHA Git et la ref de tag ;
- liste les identifiants de migrations présents dans le dépôt ;
- signe le manifeste avec OpenSSL ;
- écrit le ZIP par staging puis renommage.

## Ajouter l’application TV

Le même bundle peut contenir le serveur et l’APK, ou seulement l’APK. Les
métadonnées doivent provenir de l’APK signé qui sera distribué :

```bash
python3 scripts/build-signed-update.py \
  --artifact dist/roomframe-tv-v0.3.1.tar.gz \
  --sbom dist/roomframe-tv-v0.3.1.spdx.json \
  --source-repository OWNER/REPO \
  --source-revision SHA_GIT_COMPLET \
  --source-ref refs/tags/v0.3.1 \
  --home-apk apps/tv-android/app/build/outputs/apk/release/app-release.apk \
  --home-package org.roomframe.tv \
  --home-version-code 4 \
  --home-signing-cert-sha256 SHA256_CERTIFICAT_ANDROID \
  --version 0.3.1 \
  --private-key /chemin-protege/release-private.pem \
  --key-id release-main \
  --output dist/roomframe-tv-v0.3.1.rfupdate
```

`--artifact` et `--home-apk` sont optionnels séparément, mais au moins l’un des
deux est requis. La clé Android et la clé Ed25519 de release restent distinctes
et hors du dépôt.

Vérification :

```bash
python3 scripts/verify-update-bundle.py \
  dist/roomframe-tv-v0.3.0.rfupdate \
  --trust-key /chemin-protege/release-public.pem \
  --current-version 0.2.1
```

## CI GitHub

Un tag `v*` déclenche `.github/workflows/release.yml`. Le workflow :

1. vérifie les sources et les tests dans un job sans accès au secret de
   signature et avec `contents: read` ;
2. vérifie que le commit tagué appartient à `main` et que les versions du tag,
   de l’installateur et de l’API concordent ;
3. entre dans l’environnement GitHub protégé `release-signing` ;
4. crée l’archive source et l’installateur autonome avec l’URL et le SHA-256
   exacts ;
5. produit un SBOM SPDX 2.3 à partir du lockfile npm, des coordonnées Gradle,
   du wrapper et des images OCI épinglées ;
6. charge la clé Ed25519 depuis le secret GitHub Actions dédié ;
7. reconstruit l'APK Android TV avec la clé de production conservée dans les
   secrets de l'environnement protégé, vérifie sa signature v3 et son
   empreinte épinglée, puis l'intègre au `.rfupdate` ;
8. construit puis vérifie le `.rfupdate`, y compris le SBOM et la source ;
9. demande à GitHub/Sigstore une attestation SLSA de provenance et une
   attestation SBOM avec `actions/attest` épinglée par SHA ;
10. publie l'APK, les assets serveur, le SBOM, la clé publique et son fichier
    `.sha256`.

La clé privée n’est écrite que dans le répertoire temporaire du runner et est
supprimée par le trap du job. Le secret CI
`ROOMFRAME_RELEASE_SIGNING_KEY_B64` et la variable facultative
`ROOMFRAME_RELEASE_KEY_ID` sont configurés dans GitHub, jamais dans le dépôt.
Le PKCS#12 Android et son mot de passe sont fournis séparément par
`ROOMFRAME_ANDROID_SIGNING_STORE_B64` et
`ROOMFRAME_ANDROID_SIGNING_STORE_PASSWORD`. GitHub ne reçoit ni fichier en
clair dans le dépôt, ni secret dans les logs ; le runner détruit sa copie
temporaire à la fin du job.
L’environnement `release-signing` doit rester protégé par les règles et
approbateurs du dépôt. Son job reçoit seulement les permissions GitHub
nécessaires à la publication et aux attestations. La vérification locale
Ed25519 et le SBOM embarqué continuent de fonctionner sans GitHub : les
attestations Sigstore sont une preuve publique supplémentaire, pas une
dépendance d’exécution.

Après téléchargement, l’origine GitHub du build peut être contrôlée en ligne :

```bash
gh attestation verify dist/roomframe-tv-v0.3.0.rfupdate \
  --repo OWNER/REPO \
  --signer-workflow OWNER/REPO/.github/workflows/release.yml \
  --source-ref refs/tags/v0.3.0
gh attestation verify dist/roomframe-tv-v0.3.0.rfupdate \
  --repo OWNER/REPO \
  --predicate-type https://spdx.dev/Document/v2.3
```

GitHub permet aussi de télécharger le bundle d’attestations et les racines
Sigstore pour une vérification ultérieure hors ligne. Cette preuve doit rester
distincte de la clé Ed25519 RoomFrame approuvée par l’instance.

Sur une instance, la clé publique publiée est installée après vérification de
son empreinte par un canal indépendant :

```bash
sudo roomframe-trust-update-key \
  --key-id release-main \
  --public-key /chemin/roomframe-release-release-main.pem \
  --sha256 EMPREINTE_SHA256
```

Révoquer une clé exige son identifiant et son empreinte exacte :

```bash
sudo roomframe-trust-update-key \
  --revoke \
  --key-id release-main \
  --sha256 EMPREINTE_SHA256
```

La clé quitte immédiatement `update-trust/` et est conservée en lecture seule
sous `update-revoked/` pour l’analyse forensique. Une release historique reste
auditée, mais ne peut plus être appliquée : le moteur exige toujours une clé
encore approuvée lors de sa nouvelle vérification.

Publier un asset signé ne signifie pas qu’il sera appliqué sans décision
locale. Le poller peut le récupérer et l’importer. L’application serveur peut
ensuite être demandée dans le Studio, où la version doit être retapée, ou
lancée par la commande root explicite :

```bash
sudo roomframe-apply-update \
  --release-id 00000000-0000-4000-8000-000000000000 \
  --confirm 0.3.1
```

## Bundle de test local

Pour les tests, le générateur crée une clé éphémère et un bundle hors dépôt :

```bash
node services/api/scripts/build-test-update.mjs \
  --output /private/tmp/roomframe-update-test
./scripts/test-supply-chain.sh
```

Il produit dans ce seul répertoire :

- un `.rfupdate` signé ;
- une clé publique à placer dans la confiance du serveur de test ;
- une clé privée de développement.

Cette clé doit être supprimée avec le dossier temporaire après les tests. Elle
ne doit jamais signer une release réelle, être copiée dans Git ou être
approuvée par une instance de production.

## Refus avant quarantaine

Les vérificateurs refusent notamment :

- clé inconnue ou signature invalide ;
- manifeste hors contrat ;
- version non supérieure ou incompatible ;
- architecture incompatible ;
- hash ou taille incorrects ;
- entrée ZIP dupliquée, chiffrée, traversante ou symbolique ;
- artefact absent ou non listé ;
- dépôt, tag, ref ou SHA source incohérent pour un import GitHub ;
- SBOM absent, dupliqué, hors limites ou ne décrivant pas l’archive exacte ;
- archive excessivement grande ou fortement compressée.

L’API d’import ne fait aucune extraction exécutable. Pour le serveur,
`roomframe-apply-update` revalide et sauvegarde avant la bascule. Pour l’APK,
une planification canari ou progressive reste explicite.
