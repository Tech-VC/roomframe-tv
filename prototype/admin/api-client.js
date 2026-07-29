export class ApiError extends Error {
  constructor(message, status, payload = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

export const readApiResponse = async (response) => {
  const contentType = response.headers.get("content-type") || "";
  let payload = {};

  if (contentType.includes("application/json")) {
    try {
      payload = await response.json();
    } catch {
      throw new ApiError(
        `Réponse JSON invalide (HTTP ${response.status}).`,
        502,
      );
    }
  } else if (response.status !== 204) {
    if (!response.ok) {
      throw new ApiError(`Erreur HTTP ${response.status}`, response.status);
    }
    throw new ApiError(
      `Réponse API inattendue (HTTP ${response.status}).`,
      502,
    );
  }

  if (!response.ok) {
    throw new ApiError(
      payload?.message || payload?.error || `Erreur HTTP ${response.status}`,
      response.status,
      payload,
    );
  }
  return payload;
};
