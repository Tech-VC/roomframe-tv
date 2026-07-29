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
