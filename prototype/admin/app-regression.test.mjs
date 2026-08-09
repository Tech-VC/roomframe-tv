import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");
const markup = await readFile(new URL("./index.html", import.meta.url), "utf8");
const styles = await readFile(new URL("./styles.css", import.meta.url), "utf8");

test("les formulaires asynchrones conservent leur référence après un await", () => {
  assert.doesNotMatch(source, /event\.currentTarget\.reset\(\)/);
  assert.match(
    source,
    /\$\("#loginForm"\)\.addEventListener\("submit", async \(event\) => \{[\s\S]*?const form = event\.currentTarget;[\s\S]*?const data = new FormData\(form\);[\s\S]*?form\.reset\(\);/,
  );
  assert.match(
    source,
    /\$\("#bootstrapForm"\)\.addEventListener\("submit", async \(event\) => \{[\s\S]*?const form = event\.currentTarget;[\s\S]*?const data = new FormData\(form\);[\s\S]*?form\.reset\(\);/,
  );
});

test("la récupération locale est utilisable et efface les secrets affichés", () => {
  assert.match(markup, /id="recoveryPanel"/);
  assert.match(markup, /id="recoveryToken"[^>]*type="password"/);
  assert.match(source, /api\.post\("auth\/recovery\/totp"/);
  assert.match(source, /api\.post\("auth\/recovery\/complete"/);
  assert.match(source, /\$\("#recoveryTotpSecret"\)\.textContent = ""/);
  assert.match(source, /\$\("#recoveryTotpCode"\)\.required = false/);
});

test("l’aperçu TV ou groupe reste séparé du brouillon modifiable", () => {
  assert.match(markup, /id="targetSelect"/);
  assert.match(source, /api\.get\(`studio\/preview\?\$\{query\}`\)/);
  assert.match(source, /const displayedScene = \(\) => state\.preview\?\.scene \?\? state\.scene/);
  assert.match(source, /if \(!state\.scene \|\| state\.preview\) return;/);
  assert.match(source, /state\.preview = null;[\s\S]*state\.selectedId = state\.scene\?\.nodes\[0\]\?\.id/);
});

test("les règles de salle utilisent des formulaires structurés et l’API atomique", () => {
  assert.match(markup, /id="sourceSettingsForm"/);
  assert.match(markup, /id="powerSettingsForm"/);
  assert.match(markup, /id="powerWeekdaysEnabled"/);
  assert.match(markup, /si la TV confirme qu’elle le prend en charge/);
  assert.match(source, /api\.put\("settings\/sources"/);
  assert.match(source, /api\.put\("settings\/power"/);
  assert.doesNotMatch(markup, /textarea[^>]*id="(?:source|power)/);
  assert.match(styles, /\.source-settings-form,[\s\S]*grid-template-columns: repeat\(2, minmax\(280px, 1fr\)\)/);
  assert.match(styles, /\.source-settings-form legend,[\s\S]*float: left;[\s\S]*width: 100%/);
  assert.doesNotMatch(source, /source-action|↗/);
});

test("la bibliothèque de scènes sépare chargement, copie et affectation publiée", () => {
  assert.match(markup, /id="sceneLibrarySelect"/);
  assert.match(markup, /id="sceneLoadButton"/);
  assert.match(markup, /id="sceneCloneName"/);
  assert.match(markup, /id="sceneAssignmentForm"/);
  assert.match(source, /api\.post\("scenes", \{ name, scene \}\)/);
  assert.match(source, /api\.put\("scene-assignments"/);
  assert.match(source, /studio\?sceneId=/);
  assert.match(markup, /les modifications non enregistrées seront perdues/);
  assert.match(markup, /id="automaticReleaseSource"/);
  assert.match(source, /state\.releaseSource = payload\.source \?\? null/);
  assert.match(source, /Aucun déploiement n’a été lancé automatiquement/);
  assert.match(markup, /id="serverUpdateForm"/);
  assert.match(markup, /Confirmer en saisissant la version/);
  assert.match(markup, /Installer une version vérifiée/);
  assert.match(source, /server-update-requests/);
  assert.match(source, /state\.serverUpdateRequests/);
});

test("l’automatisation serveur reste un opt-in éditorial et explicite", () => {
  assert.match(markup, /id="serverUpdatePolicyForm"/);
  assert.match(markup, /Manuel · validation humaine/);
  assert.match(markup, /Automatique · GitHub signé/);
  assert.match(markup, /ACTIVER LES MISES A JOUR AUTOMATIQUES/);
  assert.match(markup, /id="serverUpdatePolicyError" role="alert"/);
  assert.match(source, /api\.put\("settings\/server-updates"/);
  assert.match(source, /state\.serverUpdatePolicy = payload\.policy/);
  assert.match(source, /Après un échec, une confirmation manuelle est obligatoire/);
});

test("les scènes programmées gardent un retour explicite vers l’affectation habituelle", () => {
  assert.match(markup, /id="sceneScheduleForm"/);
  assert.match(markup, /Programmer une scène temporaire/);
  assert.match(markup, /À la fin du créneau, la scène habituelle reviendra automatiquement/);
  assert.match(markup, /Deux créneaux ne peuvent pas se chevaucher pour une même cible/);
  assert.match(markup, /id="sceneScheduleError" role="alert"/);
  assert.match(source, /api\.post\("scene-schedules"/);
  assert.match(source, /scene-schedules\/\$\{encodeURIComponent\(scheduleId\)\}\/cancel/);
  assert.match(source, /Elle sera affichée automatiquement à l’heure prévue/);
});

test("les pages principales utilisent un français clair sans dépasser leur colonne", () => {
  assert.match(markup, /Composer<br>l’écran d’accueil/);
  assert.match(markup, /Les TV,<br>salle par<br>salle/);
  assert.match(markup, /Gérer les<br>mises à<br>jour/);
  assert.match(markup, /Accès à<br>la régie/);
  assert.doesNotMatch(markup, /constellation|Chaque<br>accès laisse|Mettre à<br>jour sans|Table<br>de composition/i);
  assert.doesNotMatch(markup, /sans donner root au web|Ouvrir une voie de distribution/i);
  assert.match(source, /untrusted_update_key: "la clé de signature de cette version n’est pas approuvée"/);
  assert.match(styles, /\.panel-index \{[^}]*overflow: hidden/);
  assert.match(styles, /\.console-index \{ min-width: 0; \}/);
  assert.match(styles, /@media \(max-width: 1050px\)[\s\S]*grid-template-columns: 1fr/);
});

test("la météo utilise une autocomplétion serveur et exige une suggestion", () => {
  assert.match(markup, /id="weatherLocation"[^>]*role="combobox"/);
  assert.match(markup, /Ville ou code postal/);
  assert.match(markup, /Données météo : Open-Meteo/);
  assert.match(source, /api\.get\(`weather\/locations\?\$\{parameters\}`/);
  assert.match(source, /api\.get\(`weather\/current\?\$\{parameters\}`/);
  assert.match(source, /delete node\.props\.locationKey/);
  assert.match(styles, /\.weather-suggestions/);
});

test("l’horloge et les actualités suivent la composition TV demandée", () => {
  assert.match(markup, /id="clockShowDate"/);
  assert.match(markup, /24 heures · 18h15/);
  assert.match(source, /activeMessagesForNode\(/);
  assert.match(source, /node\.kind === "message" && messages\.length === 0/);
  assert.match(styles, /\.node\.kind-clock \{[^}]*1\.55cqw/);
});

test("le logo ne remplace les couleurs manuelles qu’après confirmation", () => {
  assert.match(markup, /id="brandPaletteDialog"/);
  assert.match(markup, /Vos couleurs manuelles restent inchangées tant que vous ne confirmez pas/);
  assert.match(markup, /Garder mes couleurs/);
  assert.match(markup, /Remplacer les deux couleurs/);
  assert.match(source, /paletteFromRgba\(await rgbaForLogo\(url\)\)/);
  assert.match(source, /brandPaletteForm"\)\.addEventListener\("submit"/);
  assert.match(source, /brandLogoAsset"\)\.addEventListener\("change", \(\) => \{[\s\S]*previewBrandForm\(\);[\s\S]*proposeBrandPalette\(\);/);
  assert.doesNotMatch(
    source,
    /brandLogoAsset"\)\.addEventListener\("change"[\s\S]{0,240}brandPrimaryText"\)\.value\s*=/,
  );
});

test("le cycle d’identité TV exige une confirmation et conserve le cache local", () => {
  assert.match(markup, /id="tvCredentialDialog"/);
  assert.match(markup, /IDENTITÉ TV \/ ACTION SENSIBLE/);
  assert.match(markup, /id="tvCredentialConfirmation"[^>]*required/);
  assert.match(source, /REVOQUER LA TV/);
  assert.match(source, /REINITIALISER L ENROLEMENT/);
  assert.match(source, /api\.post\([\s\S]*tvs\/\$\{encodeURIComponent\(pending\.tvId\)\}/);
  assert.match(source, /Son cache local n’a pas été effacé/);
  assert.match(source, /L’ancienne clé ne fonctionne plus/);
  assert.match(source, /if \(event\.key === "Escape"\)/);
  assert.match(source, /state\.tvCredentialReturnFocus/);
  assert.match(source, /ticket\.trustBootstrap\?\.mode === "encrypted-server-ca"/);
  assert.match(source, /ticket\.simplifiedEnrollment\?\.mode === "encrypted-code-bootstrap"/);
  assert.match(markup, /saisissez uniquement ses 16 chiffres/);
  assert.match(markup, /Les tirets s’ajoutent automatiquement sur la TV/);
  assert.match(markup, /Ces valeurs techniques ne sont jamais à saisir dans l’application TV actuelle/);
  assert.match(source, /enrollmentCodePresentation\(ticket\.enrollmentCode\)\.valid/);
  assert.match(source, /16 chiffres copiés sans les tirets/);
  assert.match(styles, /\.enrollment-ticket input \{[^}]*color: var\(--ink\);[^}]*background: #fff;/);
  assert.match(styles, /\.enrollment-code-field input \{[^}]*font-variant-numeric: tabular-nums;/);
  assert.match(source, /server_ca_not_ready/);
  assert.match(source, /L’autorité HTTPS locale n’est pas encore prête/);
});

test("le parc se rafraîchit sans réécrire les formulaires ni le brouillon", () => {
  const start = source.indexOf("const fleetRefreshAllowed");
  const end = source.indexOf("const validEnrollmentTicket", start);
  assert.ok(start > 0 && end > start, "la fonction de rafraîchissement ciblé existe");
  const refreshSource = source.slice(start, end);

  assert.match(source, /const FLEET_REFRESH_INTERVAL_MS = 30_000/);
  assert.match(source, /view === "fleet"[\s\S]{0,80}refreshFleetState\(\{ reportError: true \}\)/);
  assert.match(source, /setInterval\(\(\) => \{ void refreshFleetState\(\); \}, FLEET_REFRESH_INTERVAL_MS\)/);
  assert.match(refreshSource, /fleetRefreshInFlight/);
  assert.match(refreshSource, /sessionHasPermission\("fleet:read"\)/);
  assert.match(refreshSource, /!document\.hidden/);
  assert.match(refreshSource, /#view-fleet/);
  assert.match(refreshSource, /#tvCredentialDialog/);
  assert.match(refreshSource, /api\.get\("tvs"\)/);
  assert.match(refreshSource, /renderFleet\(\)/);
  assert.match(refreshSource, /renderHome\(\)/);
  assert.doesNotMatch(
    refreshSource,
    /loadStudio|renderStudio|renderCollections|renderSceneManagement|renderOperationalSettings|populate[A-Z]/,
  );
});

test("les passkeys et les sessions restent des parcours API vérifiés", () => {
  assert.match(markup, /id="loginPasskeyButton"/);
  assert.match(markup, /id="passkeyRegistrationDialog"/);
  assert.match(markup, /id="passkeyRevokeDialog"/);
  assert.match(markup, /id="sessionList"/);
  assert.match(source, /navigator\.credentials\.get/);
  assert.match(source, /navigator\.credentials\.create/);
  assert.match(source, /auth\/passkeys\/registration\/options/);
  assert.match(source, /auth\/passkeys\/registration\/complete/);
  assert.match(source, /auth\/passkey\/complete/);
  assert.match(source, /auth\/sessions\/revoke-others/);
  assert.match(source, /step_up_failed/);
  assert.match(
    source,
    /passkeyRegistrationDialog"\)\.addEventListener\("keydown"[\s\S]+event\.key === "Escape"/,
  );
  assert.match(
    source,
    /passkeyRevokeDialog"\)\.addEventListener\("keydown"[\s\S]+event\.key === "Escape"/,
  );
});

test("les invitations administrateur restent one-shot et séparées des rôles", () => {
  assert.match(markup, /id="userAdministrationConsole"/);
  assert.match(markup, /id="userInvitationDialog"/);
  assert.match(markup, /id="userActionDialog"/);
  assert.match(markup, /id="activationPanel"/);
  assert.match(markup, /Aucun mot de passe temporaire n’est généré/);
  assert.match(markup, /affiché une seule fois/);
  assert.match(source, /api\.post\("users"/);
  assert.match(source, /auth\/activation\/totp/);
  assert.match(source, /auth\/activation\/complete/);
  assert.match(source, /users\/\$\{encodeURIComponent\(target\.id\)\}\/role/);
  assert.match(source, /users\/\$\{encodeURIComponent\(target\.id\)\}\/disable/);
  assert.match(source, /users\/\$\{encodeURIComponent\(target\.id\)\}\/invitation/);
  assert.match(source, /state\.userInvitation = null/);
  assert.match(source, /\$\("#userInvitationToken"\)\.textContent = ""/);
  assert.match(source, /state\.activationChallengeId = null/);
  assert.match(source, /role\.slug === "content"/);
  assert.match(source, /invalid_activation_token/);
});
