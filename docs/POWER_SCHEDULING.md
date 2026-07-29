# Programmation de l’alimentation

## Politique configurable

Chaque TV ou groupe peut recevoir :

```text
Lun–Ven : réveil 07:30, veille 19:00
Sam–Dim : rester en veille
Exceptions : jours fériés, maintenance, événements
```

## Extinction / veille

Le retour à l’accueil et la demande de veille peuvent être planifiés par l’Agent. La méthode exacte sera sélectionnée après détection des capacités Philips : API Device Owner, commande constructeur, événement système ou comportement du launcher.

Le serveur valide et persiste déjà les horaires avec
`requireCapabilityProbe=true`. Le squelette Android n’exécute pas encore ces
politiques et aucune commande Philips n’est fournie dans le jalon `0.3.0`.

Le Studio permet de choisir l’instance, un groupe ou une TV, puis de saisir
séparément semaine et week-end. Il persiste aussi, pour cette même cible, le
délai de retour automatique à l’accueil et le délai de veille de l’accueil.
L’aperçu résout ces valeurs avec les mêmes règles d’héritage que la
synchronisation TV.

## Économiseur d’écran et mode ambiant

Le launcher applique `FLAG_KEEP_SCREEN_ON` tant que son activité est visible.
RoomFrame empêche ainsi l’économiseur ou le mode ambiant de démarrer pendant
l’affichage de l’accueil, sans modifier le réglage système de la TV. Lorsque
RoomFrame passe en arrière-plan, Android autorise de nouveau l’extinction
normale de l’écran.

Sur la Philips de validation, l’économiseur Google TV est activé avec un délai
de 600000 ms. Un test contrôlé a temporairement réduit ce délai à 15000 ms :
RoomFrame est resté au premier plan, la TV est restée `Awake` et aucun
`DreamService` n’a démarré. La valeur de 600000 ms a ensuite été restaurée.

Si l’économiseur est déjà actif avant le lancement distant de RoomFrame, le
drapeau ne ferme pas le rêve en cours. Une interaction télécommande l’arrête
normalement. Le futur adaptateur de réveil devra traiter explicitement ce cas
sans dépendre d’une commande ADB.

Avant une veille programmée explicite, l’Agent devra libérer le maintien
d’écran, puis seulement appeler l’adaptateur de puissance validé. Ce chemin
reste à implémenter.

## Réveil

Un réveil programmé est plus contraignant : une application ne s’exécute pas si la TV est totalement hors tension. Trois niveaux sont prévus :

1. **veille rapide Android** : alarme de réveil + activité autorisée à allumer l’écran, à tester ;
2. **fonction RTC / timer du firmware Philips** : meilleure solution si exposée ;
3. **Wake-on-LAN/Wi-Fi ou commande réseau constructeur** : seulement si le modèle l’accepte.

Le Studio rappelle que l’exécution est conditionnée à la sonde matérielle. Une
future étape affichera une capacité réelle par TV :

```text
Veille programmée : compatible
Réveil programmé : compatible / expérimental / indisponible
```

Aucune interface ne promettra un réveil tant que le modèle n’a pas réussi un test de capacité.
