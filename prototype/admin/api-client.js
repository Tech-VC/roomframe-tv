const errorMessages = Object.freeze({
  authentication_required: "Votre session a expiré. Reconnectez-vous.",
  invalid_credentials: "Identifiant, phrase de passe ou code TOTP incorrect.",
  invalid_totp_code: "Le code TOTP est incorrect, expiré ou déjà utilisé. Saisissez le suivant.",
  csrf_validation_failed: "Rechargez la page pour renouveler la sécurité de votre session.",
  permission_denied: "Votre compte n’a pas l’autorisation d’effectuer cette action.",
  step_up_failed: "Phrase de passe ou nouveau code TOTP incorrect.",
  conflict: "Une modification concurrente a été détectée. Rechargez les données avant de réessayer.",
  scene_revision_conflict: "La scène a été modifiée ailleurs. Rechargez-la avant de réessayer.",
  invalid_value: "Vérifiez les valeurs saisies.",
  invalid_reference: "L’élément sélectionné n’existe plus. Actualisez la liste.",
  media_file_required: "Sélectionnez un fichier média valide.",
  media_too_large: "Ce média dépasse la taille autorisée.",
  upload_too_large: "Ce fichier dépasse la taille autorisée.",
  'request file too large': "Ce fichier dépasse la taille autorisée.",
  unsupported_media_type: "Ce format de média n’est pas pris en charge.",
  media_extension_mismatch: "L’extension du fichier ne correspond pas à son contenu.",
  invalid_multipart: "Le transfert du fichier est incomplet. Sélectionnez-le à nouveau et réessayez.",
  insufficient_storage: "Le serveur ne dispose pas d’assez d’espace libre pour cet import.",
  rfupdate_file_required: "Sélectionnez un fichier de mise à jour .rfupdate.",
  invalid_update_signature: "La signature du fichier de mise à jour est invalide.",
  update_version_not_newer: "Cette version n’est pas plus récente que la version installée.",
  update_entry_limit_exceeded: "Le fichier de mise à jour contient trop d’éléments.",
  github_update_check_rate_limited: "Une recherche a déjà été demandée récemment. Patientez avant de réessayer.",
  rate_limit_exceeded: "Trop de tentatives. Patientez avant de réessayer.",
});

const errorMessage = (payload, status) => {
  const code = typeof payload?.error === "string" ? payload.error : null;
  if (Object.hasOwn(errorMessages, code)) return errorMessages[code];
  if (typeof payload?.message === "string" && payload.message.trim() && status < 500) {
    return payload.message.slice(0, 500);
  }
  if (status === 413) return "Ce fichier dépasse la taille autorisée.";
  if (status === 429) return "Trop de tentatives. Patientez avant de réessayer.";
  if (status >= 500) return "Le serveur n’a pas pu traiter la demande. Réessayez.";
  if (status === 403) return "Votre compte n’a pas l’autorisation d’effectuer cette action.";
  if (status === 404) return "L’élément demandé n’est plus disponible. Actualisez la page.";
  return `La demande a été refusée (HTTP ${status}). Vérifiez les informations saisies.`;
};

export class ApiError extends Error {
  constructor(message, status, payload = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
    this.code = typeof payload?.error === "string" ? payload.error : null;
  }
}

export const readApiResponse = async (response) => {
  if (response.status === 204) return {};
  const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  let payload = {};

  if (contentType === "application/json" || contentType.endsWith("+json")) {
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
      errorMessage(payload, response.status),
      response.status,
      payload,
    );
  }
  return payload;
};
