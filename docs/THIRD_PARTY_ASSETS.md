# Assets tiers redistribués

RoomFrame conserve ses visuels génériques dans le dépôt public. Les trois
pictogrammes de source suivants proviennent du dépôt officiel Google Material
Design Icons :

| Fichiers RoomFrame | Icône amont | Source |
| --- | --- | --- |
| `prototype/admin/assets/source-airplay.svg`, `apps/tv-android/app/src/main/res/drawable/ic_source_airplay.xml` | `airplay` | `src/av/airplay/materialicons/24px.svg` |
| `prototype/admin/assets/source-cast.svg`, `apps/tv-android/app/src/main/res/drawable/ic_source_cast.xml` | `cast` | `src/hardware/cast/materialicons/24px.svg` |
| `prototype/admin/assets/source-hdmi.svg`, `apps/tv-android/app/src/main/res/drawable/ic_source_hdmi.xml` | `settings_input_hdmi` | `src/action/settings_input_hdmi/materialicons/24px.svg` |

Source : <https://github.com/google/material-design-icons>

Licence amont : Apache License 2.0. Les SVG ont seulement été nettoyés de leurs
rectangles transparents et les mêmes tracés ont été transposés en VectorDrawable
Android. La licence du dépôt amont reste applicable à ces fichiers.

Ces glyphes identifient des types de source connus. Ils ne valident ni une
marque partenaire ni le fonctionnement matériel de Cast, AirPlay ou HDMI sur
un modèle de téléviseur donné.

Sur un profil matériel validé, le client Android peut charger à l'exécution
l'icône publiée par le récepteur Cast déjà installé par le constructeur. Cette
icône système n'est ni extraite, ni modifiée, ni redistribuée dans le dépôt.
Le service AirPlay de la Philips testée publie seulement une icône Android
générique : RoomFrame conserve donc le glyphe vidéo AirPlay Apache-2.0 du
tableau ci-dessus, sans intégrer le pack graphique Apple réservé aux logiciels
Apple. Ces vecteurs restent aussi les replis neutres lorsqu'un service ne
fournit aucune icône exploitable.

## Données météo

La recherche de commune et les conditions courantes proviennent de
[Open-Meteo](https://open-meteo.com/). La régie conserve l’attribution
« Données météo : Open-Meteo » avec un lien vers le fournisseur dans les
propriétés du bloc météo et la documentation. L’accueil TV reste limité au nom
de la commune, à l’icône, à la température et aux conditions. Le mode
d’évaluation n’est destiné qu’aux usages couverts par les conditions gratuites
d’Open-Meteo ; une instance commerciale doit utiliser son endpoint client et
sa propre clé d’abonnement.
