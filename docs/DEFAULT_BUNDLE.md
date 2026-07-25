# Bundle d’expérience par défaut

## Fichier

```text
bundles/roomframe-default-experience-1.0.0.rfbundle
```

Il s’agit d’un ZIP versionné contenant :

```text
manifest.json
layout.json
content.json
schedule.json
settings.json
assets/background-default.webp
assets/background-default.jpg
assets/logo-placeholder.png
preview.png
```

## Politique de seed

Le ZIP publié correspond au répertoire source vérifié `defaults/experience/`.
L’installateur copie ce répertoire dans
`/var/lib/roomframe/seed/default-experience` uniquement lorsque la destination
est vide. L’API contrôle le manifeste et les SHA-256 au démarrage, puis
initialise l’expérience uniquement lorsqu’aucune instance n’existe.

La transaction enregistre l’application dans `experience_seed_history`. Une
réexécution des migrations ou de l’installateur conserve donc une preuve
persistante que le seed a déjà été consommé.

Une mise à jour logicielle :

- ne rejoue pas le seed ;
- n’écrase pas les layouts ;
- n’écrase pas les médias ;
- ne repositionne pas le logo ;
- n’efface pas les salles ;
- n’annule pas les règles.

## Contenu initial

- scène 1920 × 1080 ;
- fond neutre optimisé ;
- salutation ;
- heure et météo ;
- AirPlay, Cast et HDMI ;
- zone de messages ;
- indication réseau ;
- logo image en bas à droite ;
- retour à l’accueil après 15 minutes sans source ;
- veille après 30 minutes sur l’accueil ;
- exemple d’horaires présent mais désactivé jusqu’au test de capacité de la TV.
