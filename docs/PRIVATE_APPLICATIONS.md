# Sources et espace privé

## Parcours TV

Une scène peut afficher une tuile **Sources**. Elle ouvre un menu Android natif
plein écran, sans appel réseau pendant la navigation :

- **Accueil** ferme le menu et revient à la scène RoomFrame assignée ;
- **Cast**, **AirPlay** et **HDMI** utilisent les mêmes adaptateurs matériels que
  les anciennes tuiles directes ;
- **Espace privé** ouvre le contrôle d'accès puis le mini-accueil des
  applications autorisées.

Les anciennes tuiles Cast, AirPlay et HDMI restent acceptées afin de ne pas
casser les scènes publiées. Le menu Sources est opaque : aucune partie de la
scène ne doit rester lisible derrière lui.

Les nouveaux modèles et le secours embarqué dans l’APK utilisent ce menu.
Une mise à jour ne transforme jamais silencieusement une scène déjà publiée :
remplacez ses anciennes tuiles par **Sources** depuis Surface, puis enregistrez
et publiez explicitement la nouvelle révision.

## Code de l'espace privé

Le code RoomFrame comporte six chiffres. Il est généré dans la régie et affiché
une seule fois. La base conserve uniquement un sel et un dérivé lent ; le code
clair ne doit apparaître ni dans la synchronisation TV, ni dans l'audit, ni
dans les logs.

La TV présente son certificat client et sa clé rotative au serveur local pour
valider le code. Le serveur applique la politique effective la plus précise
dans l'ordre TV, groupe, instance. Après cinq erreurs, les nouvelles tentatives
sont temporairement bloquées pour cette TV. Une rotation incrémente la
génération et invalide immédiatement l'ancien code dès que la TV peut joindre
le serveur.

Le déverrouillage reste valable jusqu'à un retour explicite à l'accueil ou à
l'extinction de l'écran. Une simple ouverture d'application ne verrouille pas
la session : la touche Retour doit retrouver le mini-accueil privé.

Le code RoomFrame protège uniquement l'accès au mini-accueil. Il ne remplace
jamais le code de connexion ou d'activation propre à CANAL+, YouTube ou à une
autre application.

## Verrouillage Android

Quand RoomFrame est Device Owner, il masque uniquement les paquets explicitement
autorisés dans l'espace privé pendant que celui-ci est verrouillé, puis les
réactive après validation du code. Le paquet RoomFrame, le Play Store, les
launchers et les services système critiques sont toujours exclus de cette
politique.

Si Android refuse l'opération ou si RoomFrame n'est pas Device Owner, l'écran
de code reste utilisable mais ne constitue pas un verrou système complet : une
application pourrait encore être ouverte depuis une autre interface Android.
La TV doit alors remonter `accessEnforced=false` et la régie ne doit jamais
présenter le verrou comme confirmé.

RoomFrame ne remonte pas l'inventaire général de la TV. Il contrôle et publie
uniquement l'état des identifiants Android qui ont été configurés dans l'espace
privé : présence, version et état du verrouillage.

## Installation et mises à jour des applications

Dans l'architecture actuelle, une application absente ouvre sa fiche Google
Play. RoomFrame ne télécharge, n'extrait et ne redistribue aucun APK commercial.
Le Device Owner RoomFrame peut installer silencieusement une APK privée fournie
et autorisée par son éditeur, mais cette voie n'est pas un substitut au Play
Store pour CANAL+ ou YouTube.

Une distribution silencieuse officielle de ces applications exige une solution
Android Enterprise/Managed Google Play compatible avec le matériel. Cette
évolution doit rester derrière un fournisseur de distribution séparé : elle ne
doit pas être simulée par un bouton de la régie tant qu'aucun EMM admissible et
aucune TV réelle n'ont été validés.

Références officielles :

- [Installer des paquets sur un appareil dédié](https://developer.android.com/work/dpc/dedicated-devices/cookbook#install-app-packages)
- [Gérer les applications avec Android Management API](https://developers.google.com/android/management/apps)
- [Contrôler les mises à jour Managed Google Play](https://developers.google.com/android/management/control-app-updates)
- [Usages autorisés de l'Android Management API](https://developers.google.com/android/management/permissible-usage)

## Validation matérielle obligatoire

Avant d'annoncer le parcours comme validé sur une TV :

1. confirmer le statut Device Owner ;
2. vérifier qu'une application verrouillée ne s'ouvre ni depuis Google TV, ni
   depuis la recherche, ni depuis une recommandation ;
3. tester CANAL+ et YouTube séparément, notamment si YouTube est préinstallé ;
4. vérifier que Cast reste disponible lorsque l'application YouTube est
   verrouillée ;
5. contrôler Home, Retour, écran éteint, redémarrage et rotation du code ;
6. écouter le son après le test Home sur le firmware Philips concerné.
