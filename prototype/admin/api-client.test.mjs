import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, readApiResponse } from "./api-client.js";

test("ne rend jamais une page HTML brute dans une erreur API", async () => {
  const response = new Response("<html><body>proxy indisponible</body></html>", {
    status: 502,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  await assert.rejects(
    readApiResponse(response),
    (error) => (
      error instanceof ApiError
      && error.status === 502
      && error.message === "Erreur HTTP 502"
      && !error.message.includes("<html>")
    ),
  );
});

test("refuse une réponse JSON annoncée mais invalide", async () => {
  const response = new Response("{invalide", {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  await assert.rejects(
    readApiResponse(response),
    (error) => (
      error instanceof ApiError
      && error.status === 502
      && error.message === "Réponse JSON invalide (HTTP 200)."
    ),
  );
});

test("conserve les erreurs JSON structurées de l’API", async () => {
  const response = new Response('{"error":"authentication_required"}', {
    status: 401,
    headers: { "content-type": "application/json" },
  });
  await assert.rejects(
    readApiResponse(response),
    (error) => (
      error instanceof ApiError
      && error.status === 401
      && error.code === "authentication_required"
      && error.payload.error === "authentication_required"
      && error.message === "Votre session a expiré. Reconnectez-vous."
    ),
  );
});

test("retourne une réponse JSON valide", async () => {
  const response = new Response('{"configured":true}', {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  assert.deepEqual(await readApiResponse(response), { configured: true });
});

test("les réponses sans contenu et les erreurs problem+json sont prises en charge", async () => {
  assert.deepEqual(await readApiResponse(new Response(null, {
    status: 204, headers: { 'content-type': 'application/json' },
  })), {});
  await assert.rejects(readApiResponse(new Response('{"error":"media_too_large"}', {
    status: 413, headers: { 'content-type': 'Application/Problem+Json; charset=utf-8' },
  })), (error) => error.status === 413 && error.code === 'media_too_large'
    && error.message === 'Ce média dépasse la taille autorisée.');
});

test("une erreur serveur inconnue ne divulgue pas de détails techniques", async () => {
  await assert.rejects(readApiResponse(new Response('{"error":"internal_error","message":"database credentials or internal path"}', {
    status: 500, headers: { 'content-type': 'application/json' },
  })), (error) => error.status === 500 && !error.message.includes('database')
    && error.message.includes('Réessayez'));
});
