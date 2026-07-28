# Relevé matériel Philips

Les éléments suivants doivent être relevés sur la TV réelle avant de créer un adaptateur constructeur ou d’intégrer PhairPlay.

## Profil actuellement rapporté

Les informations suivantes croisent l’écran système de la TV, sa référence
commerciale et un relevé ADB en lecture seule :

| Champ | Valeur rapportée |
| --- | --- |
| Constructeur | Philips |
| Référence commerciale | `55PUS8808/12` |
| Gamme | The One, 55 pouces, 4K Ambilight, Google TV |
| Désignation affichée | Google TV TA1 |
| Identifiant de plateforme | `PH1M_WW_9972` |
| Système | Android TV / Google TV 12, API 31 |
| Correctif de sécurité | `2025-01-05` |
| Noyau | `5.4.283` |
| Build Android TV | `STT2.230831.001` |
| Version logicielle Philips | `TPM231WW_R.101.002.038.234` |
| Mémoire flash annoncée | `16 Go` selon la fiche constructeur |
| Stockage partagé mesuré par ADB | `4,9 Go` au total, `2,4 Go` utilisés, `2,3 Go` libres |
| Mémoire vive | `2 890 048 ko` au total, environ `930 Mo` disponibles pendant le relevé |
| SoC | MediaTek `mt5896`, plateforme `merak`, modèle `t50` |
| ABI applicative | `armeabi-v7a`, `armeabi` — espace utilisateur 32 bits |
| Affichage | dalle `3840 × 2160` à 60 Hz ; interface logique `1920 × 1080` |
| HDR déclaré | types Android 1, 2, 3 et 4 ; validation visuelle encore requise |
| Options développeur | Activées |
| Débogage ADB | Option « Débogage USB » présente ; aucune option « Débogage sans fil » |
| ADB local | Compatible sur Wi-Fi et même sous-réseau, TCP `5555`, authentification RSA |
| ADB routé | Délai dépassé dans la topologie inter-VLAN testée |
| HDMI | Quatre entrées exposées par `TvInputManager`; CEC actif, ARC sur HDMI 2 |
| AirPlay | Services MediaTek présents ; fonctionnement utilisateur non validé |
| Codecs déclarés | AVC, HEVC, VP8, VP9, AV1, VVC, MPEG-2/4 et Dolby Vision |
| Compte Google | Compte géré retirable avant une réinitialisation de test |
| Réinitialisation | Possible si le protocole Device Owner l’exige |

La référence correspond à la
[page d’assistance officielle Philips](https://www.philips.fr/c-p/55PUS8808_12/8800-series-televiseur-4k-ambilight/aide).
La
[fiche technique Philips](https://www.documents.philips.com/assets/20230814/f17454ed165a412f9386b05e001459c2.pdf)
annonce 16 Go de mémoire flash, dont seule une partie apparaît comme stockage
partagé accessible après les partitions système et les applications
préinstallées.
Ce profil identifie une base de test, mais ne prouve pas encore que Device
Owner, `PackageInstaller`, HDMI, veille/réveil ou les API constructeur sont
disponibles.

Les fichiers codecs MediaTek déclarent notamment des décodeurs matériels et
sécurisés pour AVC, HEVC, VP9, AV1 et Dolby Vision, avec des points de
performance allant jusqu’à la 4K/120 et la 8K/60 selon le codec. Il s’agit de
capacités annoncées par le firmware, pas de mesures de lecture. La dalle
observée reste 4K/60 et chaque combinaison codec, profil, HDR et fréquence
devra être testée avec un média maîtrisé avant d’être annoncée compatible.

L’option Android « Certification de l’affichage sans fil » n’est pas une
méthode de connexion ADB. Sur ce firmware Android TV 12, une tentative
contrôlée sur le réseau local avec `adb connect <IP-TV>:5555` doit être faite
avant d’envisager un câble : certains firmwares Philips exposent le débogage
réseau derrière l’intitulé « Débogage USB », sans afficher le nouveau menu de
pairage sans fil. L’absence du menu ne vaut donc pas encore résultat
`indisponible`.

Plusieurs essais depuis un poste placé sur un autre VLAN, dont un après
autorisation du débogage côté TV et un après redémarrage complet, n’ont reçu
ni réponse ICMP ni réponse TCP sur le port `5555`. `adb connect` a expiré et
les listes `adb devices -l` et `adb mdns services` sont restées vides. Des
contrôles ciblés des ports Google TV/Cast courants ont également expiré. Une
route existait entre les deux réseaux, mais le chemin ne permet donc pas de
distinguer un ADB fermé d’une TV qui refuse les connexions routées, d’une
isolation réseau ou d’une adresse momentanément indisponible. Les adresses IP
et le numéro de série réels ne sont pas conservés dans ce dépôt public.

Après connexion de la TV en Wi-Fi sur le même sous-réseau que le poste de
diagnostic, ICMP et TCP `5555` ont répondu immédiatement. `adb connect` a
déclenché l’autorisation RSA puis `adb devices -l` a identifié l’appareil avec
l’état `device`. ADB sur réseau local est donc classé `compatible` pour cette
version. Le fonctionnement inter-VLAN reste un résultat propre à la topologie
testée et ne remet pas en cause cette capacité.

La
[documentation ADB officielle](https://developer.android.com/tools/adb)
réserve le nouveau pairage sans fil des TV à Android 13 ou ultérieur. Son mode
TCP historique utilise `adb tcpip 5555`, normalement après une première
connexion physique, sauf lorsqu’un constructeur l’active lui-même. Un
[retour technique Philips](https://hydralien.net/blog/posts/philips-65oled-disable-logo-screensaver/)
montre qu’un modèle Google TV de la même plateforme TPM231WW ouvre directement
`5555` après activation de « USB Debugging ». Ce retour n’est pas une
documentation constructeur et ne prouve pas le comportement de la version
exacte testée. Le
[CDD Android 12](https://source.android.com/docs/compatibility/12/android-12-cdd#61_developer_tools)
impose néanmoins un mécanisme de connexion ADB et, pour un appareil dépourvu
de port USB en mode périphérique, une implémentation ADB sur le réseau local.
La
[documentation Home Assistant](https://www.home-assistant.io/integrations/androidtv#adb-troubleshooting)
signale en outre que certains téléviseurs Philips n’acceptent la première
autorisation ADB que sur leur interface Wi-Fi ; après cette autorisation, leur
interface Ethernet peut fonctionner.

### Premier essai de connexion

1. Laisser la TV et le poste de diagnostic sur le même réseau local.
2. Activer « Débogage USB » sur la TV.
3. Relever l’IPv4 dans **Paramètres > Système > À propos > État** ou
   **Paramètres > Réseau et Internet > Afficher les paramètres réseau**.
4. Depuis le poste de diagnostic, remplacer `TV_IP_ADDRESS` puis exécuter :

```bash
adb connect TV_IP_ADDRESS:5555
adb devices -l
```

5. Si la TV affiche une empreinte RSA, l’accepter uniquement pour le poste de
   diagnostic maîtrisé.
6. En cas de refus ou de délai dépassé, ne pas brancher un câble USB mâle-mâle
   au hasard : identifier d’abord dans la documentation constructeur le port
   de service ou le mode USB périphérique utilisable.
7. Si la TV est raccordée en Ethernet, tenter sa première autorisation ADB en
   Wi-Fi, relever sa nouvelle IPv4, puis recommencer. Ce test ne nécessite pas
   que le poste ADB soit lui-même connecté en Wi-Fi, mais le routage et les
   règles de sécurité doivent permettre TCP `5555`.
8. Si le poste ne peut pas rejoindre le réseau de la TV et que celle-ci
   n’accepte que des clients de son sous-réseau, utiliser un relais
   d’administration temporaire dans ce sous-réseau ou une règle SNAT
   strictement limitée au poste, à la TV et à TCP `5555`. Ne jamais exposer ce
   port à un réseau non maîtrisé ; retirer la règle et désactiver le débogage
   après validation.

La documentation utilisateur identifie USB 1 comme USB 2.0 et USB 2 comme USB
3.0 pour les périphériques et médias. La fiche technique mentionne séparément
un « connecteur de service », sans documenter son brochage ni son emploi pour
ADB. Les deux ports USB ordinaires ne doivent donc pas être considérés comme
des ports ADB tant qu’un document Philips ou un test sûr ne le confirme pas.

## Collecte ADB sans root

Après avoir activé le débogage sur une TV de test et accepté l’ordinateur, les
commandes suivantes sont en lecture seule :

```bash
adb devices -l
adb shell getprop ro.product.manufacturer
adb shell getprop ro.product.model
adb shell getprop ro.product.device
adb shell getprop ro.build.version.release
adb shell getprop ro.build.version.sdk
adb shell getprop ro.build.version.security_patch
adb shell getprop ro.build.fingerprint
adb shell getprop ro.product.cpu.abilist
adb shell pm list features
adb shell cat /proc/meminfo
adb shell df -h /data
adb shell dumpsys display
adb shell dumpsys media.codec
adb shell dumpsys device_policy
adb shell dumpsys tv_input
adb shell dumpsys power
```

Conserver les sorties dans un dossier de travail privé. La fingerprint et les
identifiants de l’appareil servent au diagnostic local et ne doivent pas être
ajoutés au dépôt public.

## Identité système

- référence de châssis et nom de périphérique ADB ;
- confirmation ADB de la version Android et du SDK ;
- date du correctif de sécurité ;
- ABI complète (`arm64-v8a`, `armeabi-v7a`, autre) ;
- SoC, RAM, stockage total et stockage libre ;
- codecs matériels disponibles.

## Affichage et applications

- sortie de `adb shell dumpsys display` ;
- modes 1080p/4K, fréquences et HDR disponibles ;
- comportement après lancement d’une application native 4K/HDR ;
- packages et intents exacts des applications privées à lancer ;
- ordre et rendu du focus D-pad.

## Administration

- possibilité réelle de provisionner Device Owner après réinitialisation ;
- méthode d’installation initiale retenue : ADB ou sideload USB ;
- type et brochage du connecteur de service Philips, à demander au support ou
  relever sur l’appareil avant tout branchement ;
- disponibilité de Lock Task ;
- installation et mise à jour silencieuses d’un APK signé localement ;
- résultat d’un essai `PackageInstaller` lancé par le Device Owner, avec
  redémarrage de l’application et contrôle du `versionCode` ;
- conservation du cache et des données privées après remplacement de l’APK ;
- politiques DevicePolicyManager acceptées ;
- installation ou épinglage de l’autorité HTTPS locale.

Le relevé `dumpsys device_policy` ne montre actuellement aucun administrateur
ou Device Owner actif. Le système est déjà provisionné, possède un compte sur
l’utilisateur principal et un second utilisateur sans compte. Un essai
Device Owner exigera donc un protocole de réinitialisation préparé et ne doit
pas être improvisé sur l’installation actuelle.

### Premier APK RoomFrame validé

Le build debug `org.roomframe.tv` 0.3.0 (`versionCode` 3), ciblant Android 35
avec un minimum Android 29, a été compilé avec JDK 17 et Gradle 8.9. Sa
signature APK v2 et son certificat debug local ont été vérifiés avant
installation. `adb install -r` a réussi sans réinitialiser la TV, puis
`MainActivity` a effectué un démarrage à froid en moins d’une seconde.

Le premier relevé visuel a mis en évidence que la densité Android 320 dpi
agrandissait à tort les coordonnées de la scène : les boutons Cast et HDMI
sortaient de l’écran. Le renderer utilise désormais les coordonnées logiques
1920 × 1080 mises à l’échelle selon la fenêtre, indépendamment de la densité.
Le firmware Philips lève également une exception si
`WindowInsetsController` est demandé avant l’attachement de la vue ; le mode
immersif est donc appliqué après `setContentView`.
Un second build installé sur la TV confirme à l’écran :

- la salutation, les trois boutons et le logo entièrement visibles ;
- le rendu capturé en 1920 × 1080 ;
- l’ordre de focus D-pad AirPlay, Cast puis HDMI ;
- l’affichage explicite de « Intégration matérielle non validée sur ce
  téléviseur » lors de l’activation de l’adaptateur HDMI non pris en charge.

Après correction du mode immersif, un nouveau démarrage à froid est resté au
premier plan et le journal Android ne contient aucun crash RoomFrame.

Un test complémentaire a chargé un fond photographique légèrement flouté et
un logo propres à l’instance depuis le stockage privé du build debug. Le rendu
1920 × 1080, le recadrage `cover`, le voile de contraste et le logo en bas à
droite ont été confirmés sur l’écran réel. Ces médias privés et leur identité
ne sont pas conservés dans le dépôt public.

L’économiseur Google TV est actif, avec le composant système Backdrop et un
délai écran de 600000 ms. RoomFrame porte bien le drapeau de fenêtre
`KEEP_SCREEN_ON`. Après fermeture d’un rêve déjà actif, un test avec un délai
temporairement réduit à 15000 ms a confirmé que RoomFrame reste au premier
plan, que la TV reste `Awake` et qu’aucun nouveau rêve ne démarre. Le délai
initial a été restauré après le test.

Cette validation ne définit pas RoomFrame comme launcher HOME par défaut, ne
provisionne pas Device Owner et ne valide pas encore l’installation silencieuse
depuis l’administration. Une clé de release durable, conservée hors dépôt,
devra remplacer la clé debug avant tout vrai canal de mise à jour.

La candidate courante `0.3.2` (`versionCode` 5) ajoute le renderer alimenté par
le cache, l’enrôlement HTTPS, la distribution APK vérifiée, l’envoi borné des
mesures techniques et la rotation de credential en deux phases. Elle doit
servir à la montée de version depuis le code 3, mais n’est pas encore installée
ni validée sur cette Philips. La candidate intermédiaire `0.3.1` / code 4 a
uniquement été construite hors matériel.

## HDMI et sources

- noms/identifiants des entrées HDMI ;
- intents, API ou services constructeur disponibles ;
- détection du signal HDMI ;
- événement observé quand le signal disparaît ;
- comportement HDMI-CEC ;
- retour possible au launcher sans root.

Le relevé ADB expose quatre services `HdmiInputService`, associés aux ports 1
à 4. HDMI-CEC est activé et chaque port est déclaré compatible CEC ; HDMI 2
est déclaré ARC. Ce relevé confirme l’existence des interfaces système, pas
la commutation, la détection d’un signal réel ni le retour automatique.

## Veille et réveil

- différence entre veille rapide et extinction ;
- comportement d’AlarmManager en veille ;
- éventuel timer RTC constructeur ;
- Wake-on-LAN/Wi-Fi ;
- commande réseau constructeur documentée ;
- réveil HDMI-CEC.

Chaque capacité doit être enregistrée comme `compatible`, `expérimentale` ou `indisponible`. Le simulateur ne vaut jamais validation matérielle.

Pour chaque test, noter au minimum :

```text
Capacité :
État : compatible / expérimentale / indisponible
Firmware testé :
Commande ou action :
Résultat observé :
Comportement après redémarrage :
Logs utiles :
```

## Réseau et PhairPlay

- résolution DNS unicast du domaine local ;
- comportement spécifique de `.local` et du mDNS ;
- multicast entre VLAN ;
- version Android, ABI, codecs et mémoire disponibles avant tout fork de PhairPlay ;
- processus isolé, budget mémoire et stratégie de redémarrage envisagés.
