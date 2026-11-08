export const sceneFingerprint = (scene) => (scene ? JSON.stringify(scene) : null);

export const publicationBlockReason = ({ scene, revision, savedFingerprint }) => {
  if (!scene) return "Chargez une scène avant de la publier.";
  if (!revision) return "Enregistrez d’abord une révision.";
  if (sceneFingerprint(scene) !== savedFingerprint) {
    return "Enregistrez les modifications du brouillon avant de publier.";
  }
  return null;
};
