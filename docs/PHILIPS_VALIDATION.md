# Relevé matériel Philips

Les éléments suivants doivent être relevés sur la TV réelle avant de créer un adaptateur constructeur ou d’intégrer PhairPlay.

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

- référence commerciale exacte et référence de châssis ;
- version Android / Google TV ;
- build firmware et date du correctif de sécurité ;
- ABI complète (`arm64-v8a`, `armeabi-v7a`, autre) ;
- SoC, RAM et stockage libre ;
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
- disponibilité de Lock Task ;
- installation et mise à jour silencieuses d’un APK signé localement ;
- résultat d’un essai `PackageInstaller` lancé par le Device Owner, avec
  redémarrage de l’application et contrôle du `versionCode` ;
- conservation du cache et des données privées après remplacement de l’APK ;
- politiques DevicePolicyManager acceptées ;
- installation ou épinglage de l’autorité HTTPS locale.

## HDMI et sources

- noms/identifiants des entrées HDMI ;
- intents, API ou services constructeur disponibles ;
- détection du signal HDMI ;
- événement observé quand le signal disparaît ;
- comportement HDMI-CEC ;
- retour possible au launcher sans root.

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
