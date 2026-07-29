# Réseau local et découverte

## Frontière de responsabilité

Le réseau du Debian/CT est configuré avant RoomFrame. L'installateur détecte
l'IPv4 principale et un suffixe DNS raisonnable ; il ne change jamais l'IP, le
masque, la passerelle, les routes ou les DNS. Les TV restent en DHCP.

## Nom interne et origine unique

Le nom automatique est :

```text
roomframe.<suffixe-DNS-détecté>
```

Une instance peut donc utiliser :

```text
roomframe.example.local  A  <IP_DU_SERVEUR>
```

Le même hôte sert tous les parcours :

```text
https://roomframe.example.local/             administration
https://roomframe.example.local/api/         API TV
https://roomframe.example.local/simulator/   simulateur local-first
```

L'IPv4 est ajoutée au certificat Caddy et reste toujours affichée comme URL de
secours. Un échec ou une incohérence DNS produit un avertissement et la ligne A
à créer, sans bloquer l'installation.

Les passkeys administrateur sont volontairement liées au FQDN HTTPS principal :
WebAuthn ne peut pas partager une identité entre ce nom et l’URL IP. Le secours
par IP reste donc disponible avec phrase de passe + TOTP. Créer le DNS unicast
et faire approuver la CA Caddy dans le navigateur sont nécessaires avant
l’enrôlement d’une passkey.

Caddy présente le certificat de cette IPv4 comme certificat SNI par défaut :
l’URL de secours fonctionne aussi avec les clients TLS qui n’envoient pas de
nom de serveur pour une adresse IP.

La même origine accepte les navigateurs sans certificat client et vérifie les
certificats individuels lorsqu’une TV en présente un. L’API les rend
obligatoires uniquement après leur activation pour l’identité TV concernée ;
aucun second port ou hôte mTLS n’est nécessaire.

Au premier enrôlement, l’APK effectue un GET sans secret pour obtenir une
enveloppe de CA chiffrée par le ticket. Il ne transmet la clé à usage unique
qu’après déchiffrement, contrôle de la chaîne TLS réellement rencontrée,
validation du nom/IP et épinglage local de la CA. Cette étape fonctionne avec
le FQDN comme avec l’URL IP de secours.

## Cas particulier de `.local`

`.local` est réservé à mDNS dans de nombreux clients, alors que certains
réseaux Active Directory historiques l'utilisent en DNS unicast. RoomFrame
supporte ce cas sans tenter de renommer le domaine :

1. DNS unicast administré en priorité ;
2. FQDN mémorisé après enrôlement ;
3. IPv4 de secours ;
4. découverte DNS-SD locale `_roomframe._tcp` et manifeste signé pour le
   premier contact sur le même domaine de broadcast ;
5. validation de l'autorité ou de l'empreinte avant enrôlement.

Avahi publie uniquement le type de service, le port HTTPS, le chemin du
manifeste et l’empreinte de sa clé publique. Le manifeste complet reste servi
sur l’origine HTTPS unique à `/api/v1/discovery` et est signé en ECDSA P-256,
compatible avec Android 12. La signature protège l’intégrité du candidat mais
n’est pas, seule, une racine de confiance : l’APK déchiffre ensuite la CA liée
au ticket, vérifie la chaîne TLS réellement observée et compare son empreinte
avant d’envoyer la clé d’enrôlement. Un faux annonceur ne reçoit donc pas le
secret.

L’annonce peut être désactivée sans perdre les autres chemins :

```bash
sudo ./install.sh --disable-local-discovery
```

La réactiver exige une réinstallation idempotente avec
`--enable-local-discovery`. RoomFrame installe alors le paquet Debian
`avahi-daemon`, mais ne modifie ni adresse, ni route, ni résolveur.

La découverte RoomFrame ne doit pas être confondue avec AirPlay ou Cast. Entre
VLAN, ces derniers peuvent exiger un relais mDNS filtré et validé séparément.

## Flux minimaux

### TV vers services internes

```text
VLAN TV -> RoomFrame      TCP 443
VLAN TV -> DNS interne    UDP/TCP 53
VLAN TV -> NTP interne    UDP 123
TV <-> multicast local    UDP 5353 (DNS-SD, si activé)
```

### Administration

```text
VLAN Admin -> RoomFrame   TCP 443
```

PostgreSQL, le worker, Docker et les répertoires persistants restent sur un
réseau Docker interne et ne publient aucun port sur le LAN.

Docker crée ses propres interfaces et routes de pont internes. Elles ne
modifient ni l’adresse, ni le préfixe, ni la route par défaut, ni les DNS de
l’interface LAN déjà configurée.

## Ordre de découverte cible côté TV

1. FQDN provisionné ou déjà mémorisé ;
2. découverte locale signée sur le VLAN autorisé ;
3. adresse IP ou nom saisi manuellement ;
4. appairage chiffré et validation de la CA ;
5. code d'enrôlement approuvé dans l'administration.

Aucun balayage massif de ports n'est effectué. Le client Android 0.3.5 acquiert
temporairement le verrou multicast exigé sur Android 12, collecte les annonces,
résout uniquement `_roomframe._tcp`, télécharge et vérifie le manifeste signé,
puis propose le FQDN. En cas d’échec DNS, il essaie l’origine IP signée avant
l’envoi unique du secret. Plusieurs serveurs détectés restent un cas ambigu :
l’APK demande alors une saisie manuelle au lieu d’en choisir un arbitrairement.
