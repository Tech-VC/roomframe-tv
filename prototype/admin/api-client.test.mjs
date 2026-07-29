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
      && error.message === "authentication_required"
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
