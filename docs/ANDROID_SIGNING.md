# Signature Android de RoomFrame

La clé Android signe la première APK Device Owner et toutes ses mises à jour.
Elle est distincte de la clé Ed25519 des bundles `.rfupdate`. Sa perte empêche
une mise à jour continue et peut imposer une nouvelle réinitialisation des TV.

## Emplacement et identité

- alias stable : `roomframe-tv-production-v1` ;
- conteneur PKCS#12 hors dépôt :
  `~/Library/Application Support/RoomFrame/signing/roomframe-tv-production-v1.p12` ;
- dossier `0700`, fichier `0600` ;
- mot de passe uniquement dans le Trousseau macOS, service
  `RoomFrame Android Signing Store Password`, compte
  `roomframe-tv-production-v1` ;
- aucun secret dans Git, Gradle, une ligne de commande, un log ou un fichier
  `.env*`.

L’empreinte SHA-256 publique attendue est figée dans
`apps/tv-android/signing-certificate-sha256.txt`. Le build refuse une APK
signée avec une autre clé.

Utiliser une clé RSA 4096, `SHA256withRSA`, valide 50 ans. La même clé doit
être conservée pendant toute la durée de vie du parc.

La création initiale a été exécutée une seule fois avant l’épinglage de
l’empreinte. Le script refuse désormais toute nouvelle identité officielle et
oblige à restaurer une sauvegarde. Dans un fork qui initialise volontairement
sa propre distribution, il peut être exécuté uniquement avant la création du
fichier d’empreinte :

```bash
./scripts/create-android-tv-signing-key.sh
```

Ne jamais supprimer l’empreinte épinglée pour contourner une clé perdue.

## Sauvegarde obligatoire avant le premier Device Owner

Avant la réinitialisation de la première TV :

1. conserver deux copies chiffrées du PKCS#12 sur deux supports indépendants ;
2. conserver le secret de récupération dans un coffre distinct ;
3. restaurer une copie sur un autre compte ou Mac de test ;
4. vérifier que l’empreinte SHA-256 du certificat restauré est identique ;
5. signer et vérifier une APK d’essai avec cette copie restaurée.

Une simple seconde copie sur le même SSD ne constitue pas une sauvegarde.

## Construction locale

Le script lit le secret dans le Trousseau, le garde seulement dans le processus
Gradle sans daemon, puis vérifie l’APK avec `apksigner` :

```bash
./scripts/build-android-tv-release.sh
```

Le résultat attendu est :

```text
apps/tv-android/app/build/outputs/apk/release/app-release.apk
```

La signature attendue utilise le schéma APK v3, pris en charge par toute la
plage de l’application (`minSdk 29`). Les schémas v1 et v4 restent désactivés ;
le schéma v2 redondant n’est pas émis lorsque v3 couvre déjà tous les appareils.

Le build release refuse une configuration partielle des quatre variables de
signature. Sans aucune variable, Gradle peut encore produire un artefact
release non signé pour les contrôles statiques ; cet artefact ne doit jamais
être installé comme première APK Device Owner.

Référence : [Signer une application Android](https://developer.android.com/studio/publish/app-signing).
