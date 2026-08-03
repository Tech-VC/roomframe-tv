import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {
  searchWeatherLocations,
  weatherConditionFr,
  weatherLocationKey,
  weatherLocationsFromScene,
} from '../src/weather.mjs';

test('une commune sélectionnée produit une clé stable sans valeur par défaut', () => {
  const location = {
    latitude: 47.3431,
    longitude: 1.18653,
    timezone: 'Europe/Paris',
    units: 'metric',
  };
  const key = weatherLocationKey(location);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(key, weatherLocationKey({ ...location }));
  assert.equal(weatherLocationsFromScene({ nodes: [] }).length, 0);
  assert.equal(weatherConditionFr(2), 'Éclaircies');
  assert.equal(weatherConditionFr(63), 'Pluie');
});

test('la recherche passe par la passerelle et ne conserve que les champs utiles', async (context) => {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://weather.test');
    assert.equal(url.pathname, '/locations');
    assert.equal(url.searchParams.get('q'), 'Ville Exemple 12345');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      results: [{
        location: 'Ville Exemple 12345',
        detail: 'Loir-et-Cher · Centre-Val de Loire · France',
        latitude: 47.3431,
        longitude: 1.18653,
        timezone: 'Europe/Paris',
        ignored: 'not-forwarded',
      }],
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const result = await searchWeatherLocations({
    weatherGatewayUrl: `http://127.0.0.1:${address.port}`,
    weatherRequestTimeoutMs: 2_000,
  }, '  Ville   Exemple   12345 ');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].location, 'Ville Exemple 12345');
  assert.equal(result.results[0].timezone, 'Europe/Paris');
  assert.equal(result.results[0].units, 'metric');
  assert.equal('ignored' in result.results[0], false);
  assert.equal(result.attribution.url, 'https://open-meteo.com/');
});
