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
cours ou a réussi. Le code comporte 16 caractères, expire après 30 minutes et
ne fonctionne qu’une fois. La TV n’envoie pas le code lisible lors du premier
contact TLS : elle envoie seulement un identifiant SHA-256 dérivé, déchiffre
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

Procédure de laboratoire actuellement prévue :

1. conserver les informations nécessaires pour reconfigurer la TV, puis la
   réinitialiser ;
2. ne rattacher aucun compte personnel ou géré ;
3. activer le débogage prévu par le constructeur et autoriser le poste ADB ;
4. installer l’APK signé initial ;
5. déclarer son receiver comme Device Owner avant le provisionnement normal ;
6. vérifier le propriétaire, puis lancer RoomFrame.

```bash
adb install -r roomframe-tv.apk
adb shell dpm set-device-owner org.roomframe.tv/.RoomFrameAdminReceiver
adb shell dpm list owners
adb shell am start -n org.roomframe.tv/.MainActivity
```

Si `dpm set-device-owner` est refusé, arrêter le test et relever l’erreur. Ne
pas contourner la politique Android et ne pas réinitialiser une seconde fois
sans comprendre la cause. La documentation Android prévoit aussi le
provisionnement des appareils dédiés par QR code ; ce parcours devra être
implémenté et validé sur le firmware Philips avant d’être proposé comme mode
d’installation initiale.

Références Android officielles :

- [Dedicated devices](https://developer.android.com/work/dpc/dedicated-devices)
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
