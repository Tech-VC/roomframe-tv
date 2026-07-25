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

## Réveil

Un réveil programmé est plus contraignant : une application ne s’exécute pas si la TV est totalement hors tension. Trois niveaux sont prévus :

1. **veille rapide Android** : alarme de réveil + activité autorisée à allumer l’écran, à tester ;
2. **fonction RTC / timer du firmware Philips** : meilleure solution si exposée ;
3. **Wake-on-LAN/Wi-Fi ou commande réseau constructeur** : seulement si le modèle l’accepte.

Le futur back-office affichera une capacité réelle par TV :

```text
Veille programmée : compatible
Réveil programmé : compatible / expérimental / indisponible
```

Aucune interface ne promettra un réveil tant que le modèle n’a pas réussi un test de capacité.
