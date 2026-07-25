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

## Cas particulier de `.local`

`.local` est réservé à mDNS dans de nombreux clients, alors que certains
réseaux Active Directory historiques l'utilisent en DNS unicast. RoomFrame
supporte ce cas sans tenter de renommer le domaine :

1. DNS unicast administré en priorité ;
2. FQDN mémorisé après enrôlement ;
3. IPv4 de secours ;
4. découverte locale contrôlée et authentifiée pour le premier contact
   lorsqu’elle sera implémentée ;
5. validation de l'autorité ou de l'empreinte avant enrôlement.

La découverte RoomFrame ne doit pas être confondue avec AirPlay ou Cast. Entre
VLAN, ces derniers peuvent exiger un relais mDNS filtré et validé séparément.

## Flux minimaux

### TV vers services internes

```text
VLAN TV -> RoomFrame      TCP 443
VLAN TV -> DNS interne    UDP/TCP 53
VLAN TV -> NTP interne    UDP 123
```

### Administration

```text
VLAN Admin -> RoomFrame   TCP 443
```

PostgreSQL, le worker, Docker et les répertoires persistants restent sur un
réseau Docker interne et ne publient aucun port sur le LAN.

## Ordre de découverte cible côté TV

1. FQDN provisionné ou déjà mémorisé ;
2. découverte locale signée sur le VLAN autorisé ;
3. adresse IP ou nom saisi manuellement ;
4. validation de la CA ou de l'empreinte ;
5. code d'enrôlement approuvé dans l'administration.

Aucun balayage massif de ports n'est prévu.

Le jalon `0.3.0` prend en charge le FQDN, l’URL IP de secours, HTTPS et
l’enrôlement explicite côté serveur. La découverte locale signée et l’écran de
saisie manuelle du client Android restent à implémenter ; ils ne doivent pas
être remplacés par une découverte mDNS non authentifiée.
