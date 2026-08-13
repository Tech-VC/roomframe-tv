# Installer et rattacher une TV

## Ce qui reste manuel

La toute première installation de RoomFrame reste une opération locale sur la
TV. L’application doit être installée une fois par ADB ou par sideload USB ; un
serveur RoomFrame ne peut pas pousser une application sur une TV Android qui ne
possède encore aucun agent de gestion.

Après cette première installation, l’application ouvre automatiquement le
parcours de rattachement. Aucun identifiant technique n’est demandé dans le
parcours normal.

## Rattachement avec secours manuel

1. Dans le Studio, ouvrir **Parc**, saisir le nom de la TV et sa salle, puis
   choisir **Créer le code**.
2. Ouvrir RoomFrame sur la TV. Elle cherche les annonces DNS-SD
   `_roomframe._tcp` sans balayer le réseau.
3. Si un seul serveur valide est trouvé, saisir uniquement le code affiché par
   le Studio.
4. Si aucun serveur n’est trouvé, si plusieurs serveurs répondent ou si mDNS
   ne traverse pas les VLAN, choisir **Saisir le serveur manuellement**, saisir
   son URL HTTPS ou son URL IP de secours, puis le même code.

Le mode manuel est toujours disponible, même lorsque la détection est en
cours ou a réussi. Le code comporte 16 chiffres groupés automatiquement par
quatre, expire après 30 minutes et ne fonctionne qu’une fois. La TV n’envoie
pas le code lisible lors du premier contact TLS : elle envoie seulement un
identifiant SHA-256 dérivé, déchiffre
localement la CA et la clé longue contenues dans l’enveloppe, puis vérifie que
la chaîne TLS observée dépend bien de cette CA avant l’enrôlement.

Les champs UUID, clé longue et URL complète restent visibles dans le volet de
dépannage du Studio pour une ancienne version de l’application. Ils ne font
pas partie du parcours normal.

## Provisionnement Device Owner sur une TV de test

Une installation APK silencieuse exige que RoomFrame soit réellement Device
Owner. Sur une TV déjà configurée avec un compte, Android impose normalement
une réinitialisation d’usine avant ce provisionnement. La réinitialisation
efface les comptes, applications et réglages de la TV : ne l’exécuter qu’après
confirmation sur le matériel exact et après avoir figé la clé de signature de
l’APK de production.

RoomFrame déclare les deux activités exigées par le provisionnement intégré
Android 12 et versions ultérieures. Il accepte uniquement le mode
**appareil entièrement géré** et demande explicitement à Android de conserver
toutes les applications système. Sur Philips, cette conservation est
obligatoire : LauncherX, SetupWraith et les services constructeur utilisés par
HDMI, Cast ou AirPlay ne doivent jamais être désactivés.

Après l’activation Device Owner, RoomFrame enregistre `MainActivity` comme
gestionnaire HOME persistant. Android la lance alors au démarrage et avec le
bouton Home. La politique est réconciliée de façon idempotente à l’activation
de l’administrateur, à la fin du provisionnement et à chaque démarrage du
processus, y compris après une mise à jour APK. Aucun mode lock task, aucune
restriction utilisateur et aucune désactivation de paquet système ne sont
activés par défaut.

### Limites de l’écran de démarrage

Device Owner agit une fois Android et son service de gestion démarrés. Il peut
donc imposer RoomFrame comme HOME, mais il ne peut pas remplacer le logo du
bootloader, le logo Philips ni l’animation Google TV fournis par le firmware.
Ces éléments précèdent toute application Android et leur modification exigerait
une image système constructeur ou un appareil rooté, hors du périmètre sûr de
RoomFrame.

RoomFrame personnalise uniquement la courte fenêtre de lancement de son
activité : fond sombre et icône RoomFrame sur Android 12 et versions
ultérieures, puis affichage immédiat de la dernière scène locale. LauncherX et
SetupWraith restent installés et actifs comme chemins de récupération OEM.
Une apparition constructeur avant HOME ne doit donc jamais être masquée en
désactivant ces paquets.

### Prérequis avant la réinitialisation

- obtenir une confirmation explicite pour la réinitialisation de la TV ;
- figer la clé de signature Android qui signera la première APK et toutes ses
  mises à jour ;
- restaurer l’une des deux sauvegardes indépendantes de cette clé et vérifier
  son empreinte comme décrit dans `ANDROID_SIGNING.md` ;
- conserver les réglages nécessaires pour remettre la TV en service ;
- vérifier que l’APK et ADB fonctionnent avant d’effacer la TV.

Le build debug peut valider la mécanique, mais son Device Owner est jetable :
une APK signée ensuite avec une autre clé ne pourra pas le remplacer. Dans ce
cas une nouvelle réinitialisation serait nécessaire. Ne pas transformer un
test debug en déploiement de production.

### Procédure ADB après réinitialisation confirmée

1. Réinitialiser depuis l’interface de la TV, sans automatiser cette étape.
2. Ne rattacher aucun compte Google, personnel ou géré.
3. Activer le débogage prévu par le constructeur et autoriser uniquement le
   poste ADB de validation.
4. Vérifier que l’utilisateur courant est l’utilisateur système principal,
   que le mode headless est désactivé et qu’aucun autre utilisateur ne reste.
5. Installer l’APK signée initiale, puis déclarer son receiver Device Owner
   avant tout autre provisionnement.

```bash
APK_PATH="/chemin/vers/roomframe-tv.apk"

adb shell am get-current-user
adb shell cmd user is-headless-system-user-mode
adb shell pm list users
adb install -r "$APK_PATH"
adb shell dpm set-device-owner org.roomframe.tv/.RoomFrameAdminReceiver
adb shell dpm list owners
adb shell cmd package resolve-activity --brief \
  -a android.intent.action.MAIN \
  -c android.intent.category.HOME
```

Résultats attendus :

- `dpm set-device-owner` répond par un succès ;
- `dpm list owners` désigne `org.roomframe.tv/.RoomFrameAdminReceiver` ;
- la résolution HOME désigne `org.roomframe.tv/.MainActivity` ;
- LauncherX et SetupWraith restent installés et actifs.

Si `dpm set-device-owner` est refusé, arrêter le test et relever l’erreur. Ne
pas contourner la politique Android et ne pas réinitialiser une seconde fois
sans comprendre la cause.

### Validation démarrage, Home et maintenance

Après l’activation, valider séparément le lancement HOME, le bouton physique
et un redémarrage volontaire :

```bash
adb shell am start \
  -a android.intent.action.MAIN \
  -c android.intent.category.HOME
adb shell pm list packages -d | rg -i 'launcherx|setupwraith'
adb reboot
adb wait-for-device
until [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = "1" ]; do sleep 2; done
adb shell cmd package resolve-activity --brief \
  -a android.intent.action.MAIN \
  -c android.intent.category.HOME
```

La commande `pm list packages -d` ne doit pas retourner LauncherX ou
SetupWraith. Vérifier aussi physiquement qu’un appui sur Home et le démarrage
reviennent bien sur RoomFrame, sans boucle de redémarrage.

RoomFrame ne verrouille pas la TV en mode kiosk. Pendant la validation, les
réglages restent lançables explicitement :

```bash
adb shell am start -a android.settings.SETTINGS
```

Les builds debug et release contiennent deux commandes de récupération ADB
protégées par la permission système `DUMP`. Elles retirent ou remettent
uniquement la préférence HOME persistante, sans supprimer Device Owner,
désactiver un paquet ou modifier une autre politique :

```bash
adb shell am broadcast --receiver-foreground \
  -a org.roomframe.tv.maintenance.CLEAR_PERSISTENT_HOME \
  -n org.roomframe.tv/.deviceadmin.DeviceOwnerPolicyRecoveryReceiver

adb shell am broadcast --receiver-foreground \
  -a org.roomframe.tv.maintenance.APPLY_PERSISTENT_HOME \
  -n org.roomframe.tv/.deviceadmin.DeviceOwnerPolicyRecoveryReceiver
```

La première doit retourner `CLEAR_REQUESTED`; la seconde `APPLY_REQUESTED` ou
`ALREADY_APPLIED`. Une application ordinaire ne peut pas appeler ce receiver :
seul un appelant système possédant `android.permission.DUMP`, notamment le
shell ADB autorisé, passe la protection du manifeste.

### QR code

Le QR Android 14 exige une APK disponible sur une URL HTTPS immuable et son
checksum de signature ou de paquet. Google limite aussi le téléchargement d’un
DPC pendant le provisionnement aux solutions approuvées : RoomFrame n’est pas
encore approuvé et un QR personnalisé peut être refusé par Android. Tant que la
clé de signature, l’URL et cette approbation ne sont pas acquises, le chemin de
validation fiable reste ADB. L’application possède néanmoins déjà les
activités de provisionnement intégré nécessaires à un futur QR.

Références Android officielles :

- [Accueil personnalisé sur appareil dédié](https://developer.android.com/work/dpc/dedicated-devices/cookbook#be_the_home_app)
- [Écran de lancement Android 12+](https://developer.android.com/develop/ui/views/launch/splash-screen)
- [Animation de démarrage intégrée par le constructeur](https://source.android.com/docs/core/ota/nonab/device_code#boot-animation)
- [Conditions d’approbation des DPC Android Enterprise](https://support.google.com/work/android/answer/16694822?hl=fr)
- [Provisionner un appareil](https://developers.google.com/android/work/play/emm-api/prov-devices)
- [PackageInstaller](https://developer.android.com/reference/android/content/pm/PackageInstaller)

## Mises à jour après l’installation initiale

Le Studio distribue ensuite l’APK signé sans demander une nouvelle validation
sur l’écran, mais uniquement si Android confirme le statut Device Owner. La TV
télécharge d’abord l’APK dans son stockage privé et vérifie sa taille, son
SHA-256, son package, son `versionCode` et sa lignée de signature.

L’installation est autorisée à l’un de ces moments sûrs :

- au démarrage à froid, tant qu’aucune interaction utilisateur n’a eu lieu ;
- après 15 minutes sans interaction ;
- juste avant une demande de veille RoomFrame.

Le troisième déclencheur est défini dans la politique Android, mais ne sera
effectivement appelé qu’après validation de l’adaptateur de veille sur la TV
réelle. Tant que RoomFrame n’est pas Device Owner, l’APK reste téléchargé avec
l’état **Device Owner requis** et aucune réussite silencieuse n’est annoncée.
