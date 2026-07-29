# Pipeline médias

## Import

`POST /api/v1/media` reçoit un formulaire multipart avec un unique champ
`file`. Le flux est écrit dans `/var/lib/roomframe/processing`, compté pendant
la réception, puis inspecté d’après ses octets. L’extension fournie doit
correspondre au type réel.

Types acceptés :

- images JPEG (`.jpg`, `.jpeg`), PNG, WebP et AVIF ;
- vidéos MP4/M4V, WebM et QuickTime MOV.

Les limites par défaut sont :

- image : 25 Mio ;
- vidéo : 2 Gio ;
- durée vidéo : 30 minutes ;
- réserve de stockage après import : 512 Mio ;
- une seule pièce jointe par requête.

Un dépassement de capacité reçoit `507 insufficient_storage`. Le SVG et tout
autre type non listé sont refusés. Aucun original importé n’est servi
directement par HTTP.

## Stockage adressé

L’original privé est adressé par son SHA-256 :

```text
/var/lib/roomframe/media/originals/ab/<sha256>.jpg
```

Le déplacement entre les volumes de traitement et média passe par une copie de
staging dans le volume cible, puis un renommage atomique. Un contenu déjà
connu est dédupliqué par hash.

## File durable

Le job est créé dans PostgreSQL avec un index empêchant deux traitements
actifs du même asset. Le worker :

- détient un verrou advisory global ;
- réclame un job avec `FOR UPDATE SKIP LOCKED` ;
- récupère les jobs interrompus au redémarrage ;
- retente au plus trois fois avec délai ;
- publie les variantes et incrémente la révision de synchronisation dans une
  transaction.

Le traitement est donc durable, mais volontairement séquentiel dans ce jalon.
Le conteneur worker s’exécute avec l’UID/GID du compte système Debian
`roomframe`, sans capacité Linux et avec une racine en lecture seule.

## Images

Sharp applique l’orientation, décode avec une limite de pixels et produit sans
recopier les métadonnées :

- `thumbnail.webp`, au plus 480 × 270 ;
- `1080p.webp`, au plus 1920 × 1080 ;
- `4k.webp`, au plus 3840 × 2160, seulement si la source dépasse le 1080p.
- `logo.webp`, au plus 1920 × 1080, si la source possède déjà une transparence
  utile ou si un fond clair uniforme peut être retiré avec confiance.

Chaque variante possède son propre MIME, sa taille et son SHA-256.

Le détourage automatique des logos échantillonne les coins et le bord, puis
retire uniquement la zone de couleur claire reliée au bord de l’image. Les
zones claires internes au logo ne sont donc pas supprimées globalement. Si le
fond est ambigu ou si la zone détectée est trop petite, aucune variante
`logo` n’est publiée et la variante 1080p reste disponible. L’API expose le
résultat de cette décision dans `logoTransparency`, sans conserver la couleur
échantillonnée.

## Vidéos

`ffprobe` exige une piste vidéo, des dimensions et une durée valides. Les
sources de plus de 8192 pixels sur un axe, de plus de 33 554 432 pixels ou de
plus de 30 minutes sont refusées par défaut.

FFmpeg :

- crée une miniature WebP ;
- retire métadonnées et chapitres ;
- produit une variante H.264/AAC 1080p en `yuv420p` ;
- produit une variante 4K seulement si la source dépasse le 1080p ;
- active `faststart` pour le MP4 ;
- s’exécute avec délais et sorties bornés.

Les transcodages sont limités par les ressources du conteneur worker. Une
application Android native lancée ensuite garde ses propres modes 4K/HDR : la
résolution des variantes d’accueil ne force pas celle des autres applications.

## Mise en page et exposition

Les scènes acceptent `cover`, `contain` ou `focus`. Le point focal est un
couple normalisé entre `0` et `1`. Seules les variantes `thumbnail`, `1080p`,
`4k` et `logo` prêtes peuvent être servies.

Lors de la synchronisation, un asset utilisé uniquement par un composant
`logo` est livré avec sa variante `logo` si elle existe. S’il est aussi utilisé
comme fond ou image dans la même scène, RoomFrame livre aussi les variantes
standard ; chaque renderer choisit `logo` uniquement pour le composant logo.

Une TV authentifiée ne peut télécharger que les assets référencés par sa scène
publiée. Les réponses utilisent `nosniff`, un cache privé immuable et le type
enregistré par le worker.

## Vérification automatisée

Le scénario d’intégration PostgreSQL envoie une vraie requête multipart PNG,
fait réclamer le job par le worker, vérifie les fichiers WebP et leur SHA-256,
confirme l’absence de métadonnées EXIF/XMP, retélécharge la variante par l’API,
réimporte le même contenu pour contrôler la déduplication, puis vérifie qu’un
faux JPEG est refusé et ne laisse aucun fichier temporaire.

## Limites actuelles

- pas d’analyse antivirus externe ;
- pas encore de quota global par instance ni d’interface de purge ;
- pas de suppression administrée d’un original ou de ses variantes ;
- isolation FFmpeg par conteneur non privilégié, mais pas de sandbox dédiée
  par job ;
- paramètres de limites présents côté API, mais leur exposition propre dans la
  configuration installée reste à finaliser.
