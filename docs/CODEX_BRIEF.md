# Brief Codex — RoomFrame TV

Construire une solution local-first composée d’un Agent Android TV, d’un launcher natif, d’une API locale, d’un back-office créatif et d’un pipeline de mise à jour signé.

## Contraintes prioritaires

1. Dépôt public neutre ; branding créé depuis Admin.
2. Réseau du Debian/CT déjà configuré avant l’installation.
3. Installateur en une commande : détection IP/FQDN, HTTPS, secrets, bundle initial, démarrage et affichage de l’URL Admin.
4. Aucun champ IP/masque/passerelle/DNS dans l’assistant web.
5. Une seule origine par défaut : Admin `/`, API `/api`.
6. Support d’un domaine AD historique en `.local` avec DNS unicast et IP de secours.
7. Données persistantes et migrations non destructives.
8. Bundle d’expérience neutre importé uniquement sur instance vide.
9. Import offline `.rfupdate` depuis un Mac.
10. Image ou vidéo de fond par TV ; logo image en bas à droite par défaut et positionnable.
11. Designer 1920×1080 par composants typés et navigation D-pad calculée.
12. Veille planifiable ; réveil uniquement après détection de capacité.
13. PhairPlay forké dans un module isolé après validation Android/ABI.
14. Sécurité front, API, PKI, releases et médias dès la conception.
15. L’admin doit conserver une esthétique de régie/studio, pas un dashboard SaaS générique.

## Ordre de réalisation

- stabiliser les contrats ;
- fiabiliser install.sh et la persistance ;
- implémenter l’authentification et le bootstrap réel ;
- implémenter le studio de scène ;
- cache atomique TV ;
- Agent Device Owner ;
- OTA serveur et Android ;
- métriques ;
- HDMI / puissance par adaptateurs ;
- AirPlay ;
- audit et hardening.
