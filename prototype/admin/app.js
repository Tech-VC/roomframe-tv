import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  DEFAULT_SCENE,
  cloneScene,
  createNode,
  nodeDisplayText,
  nodeLabel,
  nodeSupportsLabel,
  normalizeScene,
  setNodeDisplayText,
  validateScene,
} from "./scene-model.js?v=0.3.0-ui12";
import { ApiError, readApiResponse } from "./api-client.js?v=0.3.0-ui12";
import {
  creationOptionsFromJSON,
  credentialToJSON,
  passkeysAvailable,
  requestOptionsFromJSON,
} from "./passkey-client.js?v=0.3.0-ui12";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const make = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = String(text);
  return element;
};

const formatBytes = (value) => {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} o`;
  const units = ["Kio", "Mio", "Gio", "Tio"];
  let amount = bytes;
  let unit = -1;
  do {
    amount /= 1024;
    unit += 1;
  } while (amount >= 1024 && unit < units.length - 1);
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
};

const localDateTimeInputValue = (date) => {
  const value = new Date(date);
  value.setMinutes(value.getMinutes() - value.getTimezoneOffset());
  return value.toISOString().slice(0, 16);
};

const DEFAULT_BRANDING = Object.freeze({
  primary: "#151511",
  accent: "#ff4f1f",
  surface: "#e7e4da",
  ink: "#11130f",
  muted: "#62645d",
  fontPreset: "studio",
  logoAssetId: null,
});

const normalizeBranding = (value = {}) => ({
  ...DEFAULT_BRANDING,
  ...Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null),
  ),
});

const sourceGlyph = (source) => {
  const normalized = ["airplay", "cast", "hdmi"].includes(source) ? source : "app";
  const glyph = make("span", `source-glyph ${normalized}`);
  glyph.setAttribute("aria-hidden", "true");
  return glyph;
};

const api = {
  csrfToken: "",
  async request(path, { method = "GET", body, authenticated = method === "POST" } = {}) {
    const headers = { Accept: "application/json" };
    const options = { method, headers, credentials: "same-origin", cache: "no-store" };
    if (body instanceof FormData) options.body = body;
    else if (body !== undefined) {
      headers["content-type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    if (!["GET", "HEAD"].includes(method) && authenticated) {
      if (!this.csrfToken) throw new ApiError("Jeton CSRF de session absent. Reconnectez-vous.", 401);
      headers["x-csrf-token"] = this.csrfToken;
    }
    const response = await fetch(`/api/v1/${path.replace(/^\/+/, "")}`, options);
    const payload = await readApiResponse(response);
    this.csrfToken = response.headers.get("x-csrf-token") || payload?.csrfToken || payload?.session?.csrfToken || this.csrfToken;
    return payload;
  },
  get(path) { return this.request(path, { authenticated: false }); },
  post(path, body, authenticated = true) { return this.request(path, { method: "POST", body, authenticated }); },
  put(path, body, authenticated = true) { return this.request(path, { method: "PUT", body, authenticated }); },
};

const state = {
  bootstrapStatus: null,
  instance: null,
  session: null,
  scene: null,
  scenes: [],
  sceneAssignments: [],
  sceneSchedules: [],
  selectedId: null,
  currentRevisionId: null,
  sceneId: null,
  revisions: [],
  media: [],
  messages: [],
  targets: [],
  televisions: [],
  groups: [],
  sourceSettings: [],
  powerSchedules: [],
  releases: [],
  deployments: [],
  serverUpdateRequests: [],
  releaseSource: null,
  serverUpdatePolicy: null,
  measuredMetrics: null,
  enrollmentTicket: null,
  tvCredentialAction: null,
  tvCredentialReturnFocus: null,
  interaction: null,
  preview: null,
  previewSelection: "",
  totpSetupId: null,
  recoveryChallengeId: null,
  passkeys: [],
  securitySessions: [],
  adminUsers: [],
  adminRoles: [],
  userInvitation: null,
  userActionTarget: null,
  userActionReturnFocus: null,
  passkeyCanonicalUrl: null,
  passkeyReturnFocus: null,
  activationChallengeId: null,
  studioLoaded: false,
};

const refs = {
  app: $("#app"),
  authGate: $("#authGate"),
  loginPanel: $("#loginPanel"),
  bootstrapPanel: $("#bootstrapPanel"),
  recoveryPanel: $("#recoveryPanel"),
  activationPanel: $("#activationPanel"),
  globalStatus: $("#globalStatus"),
  globalStatusText: $("#globalStatusText"),
  retryButton: $("#retryButton"),
  serverDot: $("#serverDot"),
  serverLabel: $("#serverLabel"),
  logoutButton: $("#logoutButton"),
  monitor: $("#monitor"),
  nodeLayer: $("#nodeLayer"),
  objectList: $("#objectList"),
  revisionList: $("#revisionList"),
  stageEmpty: $("#stageEmpty"),
  stageTitle: $("#stageTitle"),
  stageMeta: $("#stageMeta"),
  propertyFields: $("#propertyFields"),
  noSelection: $("#noSelection"),
  selectedKind: $("#selectedKind"),
  sceneName: $("#sceneName"),
  greetingInput: $("#greetingInput"),
  targetSelect: $("#targetSelect"),
  backgroundBlur: $("#backgroundBlur"),
  backgroundBlurValue: $("#backgroundBlurValue"),
  toast: $("#toast"),
};

let toastTimer;
const toast = (message, error = false) => {
  clearTimeout(toastTimer);
  refs.toast.textContent = message;
  refs.toast.classList.toggle("error", error);
  refs.toast.classList.add("show");
  toastTimer = setTimeout(() => refs.toast.classList.remove("show"), 3500);
};

const setStatus = (kind, text, retry = false) => {
  refs.globalStatus.className = `global-status ${kind}`;
  refs.globalStatusText.textContent = text;
  refs.retryButton.classList.toggle("hidden", !retry);
  refs.serverDot.className = `dot ${kind === "loading" ? "pending" : kind === "error" ? "error" : ""}`;
  refs.serverLabel.textContent = kind === "error" ? "serveur indisponible" : kind === "loading" ? "connexion…" : "serveur local";
};

const setBusy = (busy) => {
  refs.app.setAttribute("aria-busy", String(busy));
  $("#saveButton").disabled = busy || Boolean(state.preview);
  $("#publishButton").disabled = busy || Boolean(state.preview);
};

const showGate = (panel) => {
  refs.app.inert = true;
  refs.app.setAttribute("aria-hidden", "true");
  refs.authGate.classList.remove("hidden");
  refs.loginPanel.classList.toggle("hidden", panel !== "login");
  refs.bootstrapPanel.classList.toggle("hidden", panel !== "bootstrap");
  refs.recoveryPanel.classList.toggle("hidden", panel !== "recovery");
  refs.activationPanel.classList.toggle("hidden", panel !== "activation");
  const gateCopy = {
    login: ["AUTH / 02", "Poste de composition", "Administration locale"],
    bootstrap: ["INIT / 01", "Préparer l’instance", "Configuration applicative"],
    recovery: ["SECOURS / 03", "Récupération contrôlée", "Autorité locale temporaire"],
    activation: ["ACTIVATION / 04", "Créer votre accès", "Invitation locale à usage unique"],
  }[panel];
  $("#gateNumber").textContent = gateCopy[0];
  $("#gateHeadline").textContent = gateCopy[1];
  $("#gateAside").textContent = gateCopy[2];
  refs.logoutButton.classList.add("hidden");
  const focusTarget = panel === "login"
    ? $("#loginUsername")
    : panel === "bootstrap"
      ? $("#bootstrapDisplayName")
      : panel === "recovery"
        ? $("#recoveryToken")
        : $("#activationToken");
  setTimeout(() => focusTarget.focus(), 0);
};

const hideGate = () => {
  refs.authGate.classList.add("hidden");
  refs.app.inert = false;
  refs.app.removeAttribute("aria-hidden");
  refs.logoutButton.classList.remove("hidden");
};

const formError = (id, message = "") => {
  const element = $(`#${id}`);
  element.textContent = message;
  element.classList.toggle("hidden", !message);
};

const sessionIsAuthenticated = (payload) => Boolean(
  payload?.authenticated ?? payload?.session?.authenticated ?? payload?.user ?? payload?.session?.user,
);

const sessionUser = (payload) => payload?.user ?? payload?.session?.user ?? null;

const sessionHasPermission = (permission) => {
  const permissions = sessionUser(state.session)?.permissions;
  return Array.isArray(permissions)
    && (permissions.includes("*") || permissions.includes(permission));
};

const applyBranding = (instanceOrIdentity = {}) => {
  const branding = normalizeBranding(instanceOrIdentity.branding);
  const displayName = String(instanceOrIdentity.displayName || "RoomFrame").trim();
  const root = document.documentElement;
  root.style.setProperty("--brand", branding.primary);
  root.style.setProperty("--signal", branding.accent);
  root.style.setProperty("--paper", branding.surface);
  root.style.setProperty("--ink", branding.ink);
  root.style.setProperty("--muted", branding.muted);
  root.dataset.fontPreset = branding.fontPreset;
  $("#instanceWordmark").textContent = displayName;
  $("#gateOrgName").textContent = displayName;
  $("#brandPreviewName").textContent = displayName;
  state.instance = {
    ...(state.instance ?? {}),
    ...instanceOrIdentity,
    displayName,
    branding,
  };
};

const boot = async () => {
  setBusy(true);
  setStatus("loading", "Connexion à l’instance locale…");
  try {
    const status = await api.get("bootstrap/status");
    state.bootstrapStatus = status;
    if (status.identity) applyBranding(status.identity);
    const server = status.server ?? {};
    const serverUrl = server.adminUrl || server.preferredAdminUrl || location.origin;
    if ($("#bootstrapServerUrl")) {
      $("#bootstrapServerUrl").textContent = `${serverUrl} · réseau géré hors RoomFrame`;
    }
    if (!status.configured) {
      setStatus("ok", "Serveur prêt · configuration initiale requise");
      showGate("bootstrap");
      return;
    }
    try {
      const session = await api.get("auth/session");
      state.session = session;
      if (!sessionIsAuthenticated(session)) {
        setStatus("ok", "Instance configurée · authentification requise");
        showGate("login");
        return;
      }
      await enterStudio();
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        setStatus("ok", "Instance configurée · authentification requise");
        showGate("login");
      } else throw error;
    }
  } catch (error) {
    setStatus("error", `Impossible de joindre l’API : ${error.message}`, true);
    showGate(state.bootstrapStatus?.configured ? "login" : "bootstrap");
  } finally {
    setBusy(false);
  }
};

const enterStudio = async () => {
  if (!Array.isArray(sessionUser(state.session)?.permissions)) {
    state.session = await api.get("auth/session");
  }
  hideGate();
  renderSecurity();
  await loadStudio();
  await loadSecurityState();
};

const loadStudio = async (sceneId = null) => {
  setBusy(true);
  setStatus("loading", "Chargement de la régie…");
  try {
    const payload = await api.get(
      sceneId ? `studio?sceneId=${encodeURIComponent(sceneId)}` : "studio",
    );
    applyBranding(payload.instance ?? state.bootstrapStatus?.identity ?? {});
    const sourceScene = payload.scene?.document ?? payload.scene ?? payload.draft?.scene ?? payload.currentRevision?.scene ?? payload.layout;
    state.scene = normalizeScene(sourceScene ?? cloneScene(DEFAULT_SCENE));
    state.sceneId = payload.scene?.id ?? state.scene.layoutId;
    state.currentRevisionId = payload.scene?.currentRevision ?? payload.currentRevisionId ?? payload.draft?.revision ?? payload.currentRevision?.revision ?? null;
    state.scenes = Array.isArray(payload.scenes) ? payload.scenes : [];
    state.sceneAssignments = Array.isArray(payload.sceneAssignments) ? payload.sceneAssignments : [];
    state.sceneSchedules = Array.isArray(payload.sceneSchedules) ? payload.sceneSchedules : [];
    state.revisions = Array.isArray(payload.revisions) ? payload.revisions : [];
    state.media = Array.isArray(payload.media) ? payload.media : [];
    state.messages = Array.isArray(payload.messages) ? payload.messages : [];
    state.targets = [
      ...(Array.isArray(payload.groups) ? payload.groups.map((group) => ({
        ...group,
        targetType: "group",
        name: `Groupe · ${group.name}`,
      })) : []),
      ...(Array.isArray(payload.tvs) ? payload.tvs.map((tv) => ({
        ...tv,
        targetType: "tv",
        name: `TV · ${tv.display_name ?? tv.displayName ?? tv.id}`,
      })) : []),
    ];
    state.televisions = Array.isArray(payload.televisions) ? payload.televisions : Array.isArray(payload.tvs) ? payload.tvs : [];
    state.groups = Array.isArray(payload.groups) ? payload.groups : [];
    state.sourceSettings = Array.isArray(payload.sourceSettings) ? payload.sourceSettings : [];
    state.powerSchedules = Array.isArray(payload.powerSchedules) ? payload.powerSchedules : [];
    state.releases = Array.isArray(payload.releases) ? payload.releases : [];
    state.deployments = Array.isArray(payload.deployments) ? payload.deployments : [];
    state.serverUpdateRequests = Array.isArray(payload.serverUpdateRequests)
      ? payload.serverUpdateRequests
      : [];
    state.releaseSource = payload.releaseSource ?? null;
    state.serverUpdatePolicy = payload.serverUpdatePolicy ?? null;
    state.measuredMetrics = payload.measuredMetrics ?? null;
    state.preview = null;
    state.previewSelection = "";
    state.selectedId = state.scene.nodes[0]?.id ?? null;
    state.studioLoaded = true;
    renderStudio();
    setStatus("ok", sourceScene ? "Régie synchronisée avec l’API" : "Instance vide · scène locale prête à enregistrer");
  } catch (error) {
    state.studioLoaded = false;
    state.scene = null;
    state.preview = null;
    state.previewSelection = "";
    renderStudio();
    setStatus("error", `Chargement du studio impossible : ${error.message}`, true);
  } finally {
    setBusy(false);
  }
};

const displayedScene = () => state.preview?.scene ?? state.scene;

const selectedNode = () => (
  state.preview
    ? null
    : state.scene?.nodes.find((node) => node.id === state.selectedId) ?? null
);

const applyPreviewMode = () => {
  const previewing = Boolean(state.preview);
  for (const control of [
    refs.sceneName,
    refs.greetingInput,
    refs.backgroundBlur,
    $("#backgroundFile"),
    $("#deleteNodeButton"),
  ]) {
    control.disabled = previewing;
  }
  $$("[data-fit], [data-add-kind]").forEach((button) => {
    button.disabled = previewing;
  });
  refs.monitor.classList.toggle("target-preview", previewing);
  $("#saveButton").disabled = previewing || refs.app.getAttribute("aria-busy") === "true";
  $("#publishButton").disabled = previewing || refs.app.getAttribute("aria-busy") === "true";
};

const renderStudio = () => {
  const scene = displayedScene();
  const hasScene = Boolean(scene);
  populateBrandForm();
  refs.stageEmpty.classList.toggle("hidden", hasScene);
  refs.monitor.classList.toggle("hidden", !hasScene);
  if (!hasScene) {
    refs.objectList.replaceChildren();
    refs.revisionList.replaceChildren(make("p", "empty-copy", "Aucune révision chargée."));
    renderProperties();
    renderCollections();
    renderEnrollmentTicket();
    renderReleases();
    return;
  }
  refs.sceneName.value = scene.name;
  const greeting = scene.nodes.find((node) => node.kind === "text" && node.props.role === "greeting");
  refs.greetingInput.value = greeting?.props.text ?? "";
  refs.stageTitle.textContent = scene.name;
  refs.stageMeta.textContent = state.preview
    ? `1920 × 1080 · aperçu publié ${state.preview.target.name} · révision ${state.preview.revision}`
    : `1920 × 1080 · ${state.currentRevisionId ? `révision ${state.currentRevisionId}` : "brouillon non enregistré"}`;
  refs.backgroundBlur.value = String(scene.canvas.background.blur ?? 0);
  refs.backgroundBlurValue.value = `${Math.round(scene.canvas.background.blur ?? 0)} px`;
  refs.backgroundBlurValue.textContent = refs.backgroundBlurValue.value;
  $$("[data-fit]").forEach((button) => button.classList.toggle("on", button.dataset.fit === scene.canvas.background.mode));
  renderTargets();
  renderBackground();
  renderNodes();
  renderProperties();
  renderRevisions();
  renderCollections();
  renderEnrollmentTicket();
  renderReleases();
  applyPreviewMode();
};

const renderTargets = () => {
  const options = [make("option", "", "Brouillon local · édition")];
  options[0].value = "";
  for (const target of state.targets) {
    const option = make("option", "", target.name);
    option.value = `${target.targetType}:${target.id}`;
    options.push(option);
  }
  refs.targetSelect.replaceChildren(...options);
  refs.targetSelect.value = state.previewSelection;
  refs.targetSelect.disabled = state.targets.length === 0;
};

const loadTargetPreview = async (selection) => {
  if (!selection) {
    state.preview = null;
    state.previewSelection = "";
    state.selectedId = state.scene?.nodes[0]?.id ?? null;
    renderStudio();
    setStatus("ok", "Brouillon local prêt à être modifié");
    return;
  }
  const [targetType, targetId] = selection.split(":");
  if (!["group", "tv"].includes(targetType) || !targetId) {
    toast("Cible d’aperçu invalide.", true);
    return;
  }
  setBusy(true);
  refs.targetSelect.disabled = true;
  setStatus("loading", "Chargement de l’affectation publiée…");
  try {
    const query = new URLSearchParams({ targetType, targetId });
    const payload = await api.get(`studio/preview?${query}`);
    if (!payload.scene?.document || !payload.target?.name) {
      throw new Error("Réponse d’aperçu incomplète.");
    }
    state.preview = {
      target: payload.target,
      revision: payload.scene?.revision,
      scene: normalizeScene(payload.scene?.document),
      documents: payload.documents,
    };
    state.previewSelection = selection;
    state.selectedId = null;
    renderStudio();
    const messageCount = state.preview.documents?.messages?.items?.length ?? 0;
    setStatus(
      "ok",
      `Aperçu publié · ${state.preview.target.name} · ${messageCount} message${messageCount > 1 ? "s" : ""} actif${messageCount > 1 ? "s" : ""}`,
    );
  } catch (error) {
    state.preview = null;
    state.previewSelection = "";
    state.selectedId = state.scene?.nodes[0]?.id ?? null;
    renderStudio();
    toast(`Aperçu indisponible : ${error.message}`, true);
    setStatus("error", `Aperçu impossible : ${error.message}`, false);
  } finally {
    setBusy(false);
    refs.targetSelect.disabled = state.targets.length === 0;
  }
};

const assetUrl = (asset, preferredVariant = null) => {
  if (!asset) return null;
  if (/^(blob:|https?:|\/)/.test(asset)) return asset;
  if (asset.startsWith("assets/")) return asset;
  const media = state.media.find((item) => item.id === asset || item.sha256 === asset);
  return (
    media?.variants?.[preferredVariant]?.url
    ?? media?.url
    ?? media?.variants?.preview?.url
    ?? media?.variants?.["1080p"]?.url
    ?? null
  );
};

const logoAssetForNode = (node) => {
  if (node.kind !== "logo") return node.props.asset ?? node.props.assetId;
  const current = node.props.assetId ?? node.props.asset;
  if (
    state.instance?.branding?.logoAssetId
    && (!current || current === "assets/logo-placeholder.png")
  ) {
    return state.instance.branding.logoAssetId;
  }
  return current;
};

const renderBackground = () => {
  const background = displayedScene().canvas.background;
  const url = assetUrl(background.asset);
  const position = `${background.focusX * 100}% ${background.focusY * 100}%`;
  $("#screenBg").style.backgroundColor = background.color || "#132323";
  $("#screenBg").style.backgroundImage = url ? `url("${String(url).replaceAll('"', "%22")}")` : "none";
  $("#screenBg").style.backgroundSize = background.mode === "contain" ? "contain" : "cover";
  $("#screenBg").style.backgroundPosition = position;
  $("#screenBg").style.backgroundRepeat = "no-repeat";
  const blur = Number(background.blur ?? 0);
  $("#screenBg").style.filter = `blur(${blur / 19.2}cqw)`;
  $("#screenBg").style.transform = `scale(${1 + blur / 240})`;
};

const applyNodeGeometry = (element, node) => {
  element.style.left = `${node.x / CANVAS_WIDTH * 100}%`;
  element.style.top = `${node.y / CANVAS_HEIGHT * 100}%`;
  element.style.width = `${node.width / CANVAS_WIDTH * 100}%`;
  element.style.height = `${node.height / CANVAS_HEIGHT * 100}%`;
  element.style.zIndex = String(node.zIndex);
};

const renderNodes = () => {
  const scene = displayedScene();
  const nodes = [];
  for (const node of [...scene.nodes].sort((a, b) => a.zIndex - b.zIndex)) {
    const roleClass = node.props?.role === "greeting" ? " role-greeting" : "";
    const selected = !state.preview && node.id === state.selectedId;
    const element = make("div", `node kind-${node.kind}${roleClass}${selected ? " selected" : ""}`);
    element.dataset.nodeId = node.id;
    element.tabIndex = state.preview ? -1 : 0;
    element.setAttribute("role", "group");
    element.setAttribute(
      "aria-label",
      `${nodeLabel(node)}, ${state.preview ? "objet de l’aperçu publié" : "objet de scène"}`,
    );
    applyNodeGeometry(element, node);

    if (["image", "video", "logo"].includes(node.kind)) {
      const url = assetUrl(
        logoAssetForNode(node),
        node.kind === "logo" ? "logo" : null,
      );
      if (url) {
        const image = make("img");
        image.src = url;
        image.alt = "";
        image.draggable = false;
        image.style.objectFit = node.props.fit === "cover" ? "cover" : "contain";
        element.append(image);
      } else element.append(make("span", "media-placeholder", nodeLabel(node)));
    } else if (node.kind === "source") {
      element.append(
        sourceGlyph(node.props?.source),
        make("span", "node-text", nodeDisplayText(node)),
        make("span", "source-action", "↗"),
      );
    } else {
      element.append(make("span", "node-text", nodeDisplayText(node)));
    }

    if (selected) {
      for (const edge of ["nw", "ne", "sw", "se"]) {
        const handle = make("span", "resize-handle");
        handle.dataset.edge = edge;
        handle.setAttribute("aria-hidden", "true");
        element.append(handle);
      }
    }
    nodes.push(element);
  }
  refs.nodeLayer.replaceChildren(...nodes);
  renderObjectList();
};

const renderObjectList = () => {
  const rows = displayedScene().nodes
    .slice()
    .sort((a, b) => b.zIndex - a.zIndex)
    .map((node) => {
      const row = make("button", `object${node.id === state.selectedId ? " on" : ""}`);
      row.type = "button";
      row.dataset.selectNode = node.id;
      row.disabled = Boolean(state.preview);
      row.append(make("i"), make("span", "", nodeLabel(node)), make("small", "", `${Math.round(node.x)},${Math.round(node.y)}`));
      return row;
    });
  refs.objectList.replaceChildren(...rows);
};

const renderProperties = () => {
  const node = selectedNode();
  refs.noSelection.classList.toggle("hidden", Boolean(node));
  refs.propertyFields.classList.toggle("hidden", !node);
  if (!node) return;
  refs.selectedKind.textContent = node.kind;
  $("#nodeLabel").value = nodeLabel(node);
  $("#nodeLabel").disabled = !nodeSupportsLabel(node);
  $("#nodeText").value = nodeDisplayText(node);
  const supportsAsset = ["image", "video", "logo"].includes(node.kind);
  $("#nodeAssetField").classList.toggle("hidden", !supportsAsset);
  if (supportsAsset) {
    const options = [make("option", "", "Aucun média importé")];
    options[0].value = "";
    for (const media of state.media.filter((item) => item.status === "ready" || !item.status)) {
      const option = make("option", "", media.originalFilename ?? media.name ?? media.id);
      option.value = media.id;
      options.push(option);
    }
    $("#nodeAsset").replaceChildren(...options);
    $("#nodeAsset").value = node.props.assetId ?? "";
  }
  $("#nodeX").value = Math.round(node.x);
  $("#nodeY").value = Math.round(node.y);
  $("#nodeWidth").value = Math.round(node.width);
  $("#nodeHeight").value = Math.round(node.height);
  $("#nodeZ").value = node.zIndex;
  $("#focusOrder").value = node.focusOrder ?? 0;
};

const renderRevisions = () => {
  if (!state.revisions.length) {
    refs.revisionList.replaceChildren(make("p", "empty-copy", "Aucune révision publiée."));
    return;
  }
  refs.revisionList.replaceChildren(...state.revisions.map((revision) => {
    const row = make("div", "revision-row");
    row.append(
      make("span", "", revision.name ?? revision.id ?? `Révision ${revision.revision ?? "?"}`),
      make("small", "", revision.createdAt ? new Date(revision.createdAt).toLocaleString("fr-FR") : revision.status ?? ""),
    );
    return row;
  }));
};

const ledgerRow = (title, meta) => {
  const row = make("div", "ledger-row");
  const primary = make("div");
  primary.append(make("b", "", title), document.createElement("br"), make("small", "", meta));
  row.append(primary);
  return row;
};

const operationalTargetKey = (targetType, targetId) => (
  targetType === "instance" ? "instance" : `${targetType}:${targetId}`
);

const parseOperationalTarget = (value) => {
  if (value === "instance") return { targetType: "instance", targetId: null };
  const [targetType, targetId] = String(value).split(":");
  if (!["group", "tv"].includes(targetType) || !targetId) {
    throw new Error("Cible de règles invalide.");
  }
  return { targetType, targetId };
};

const operationalTargetOptions = () => {
  const entries = [
    { value: "instance", label: "Toute l’instance" },
    ...state.groups.map((group) => ({
      value: `group:${group.id}`,
      label: `Groupe · ${group.name}`,
    })),
    ...state.televisions
      .filter((tv) => (tv.enrollmentState ?? tv.enrollment_state) !== "simulated")
      .map((tv) => ({
        value: `tv:${tv.id}`,
        label: `TV · ${tv.displayName ?? tv.display_name ?? tv.id}`,
      })),
  ];
  return entries.map((entry) => {
    const option = make("option", "", entry.label);
    option.value = entry.value;
    return option;
  });
};

const renderSceneManagement = () => {
  const library = $("#sceneLibrarySelect");
  const previousLibrary = library.value;
  library.replaceChildren(...state.scenes.map((scene) => {
    const published = scene.publishedRevision ?? scene.published_revision;
    const option = make(
      "option",
      "",
      `${scene.name} · ${published == null ? "brouillon" : `publiée r${published}`}`,
    );
    option.value = scene.id;
    return option;
  }));
  library.value = state.scenes.some((scene) => scene.id === state.sceneId)
    ? state.sceneId
    : previousLibrary;
  library.disabled = state.scenes.length === 0;
  $("#sceneLoadButton").disabled = state.scenes.length === 0;
  $("#sceneCloneButton").disabled = !state.scene || Boolean(state.preview);

  const targetSelect = $("#sceneAssignmentTarget");
  const previousTarget = targetSelect.value || "instance";
  targetSelect.replaceChildren(...operationalTargetOptions());
  targetSelect.value = [...targetSelect.options].some((option) => option.value === previousTarget)
    ? previousTarget
    : "instance";

  const publishedScenes = state.scenes.filter(
    (scene) => (scene.publishedRevision ?? scene.published_revision) != null,
  );
  const sceneSelect = $("#sceneAssignmentScene");
  const previousScene = sceneSelect.value;
  sceneSelect.replaceChildren(...publishedScenes.map((scene) => {
    const option = make("option", "", scene.name);
    option.value = scene.id;
    return option;
  }));
  if (publishedScenes.some((scene) => scene.id === previousScene)) {
    sceneSelect.value = previousScene;
  }
  $("#sceneAssignmentForm").querySelector('button[type="submit"]').disabled = publishedScenes.length === 0;

  const sceneName = (id) => state.scenes.find((scene) => scene.id === id)?.name ?? id;
  const targetName = (assignment) => {
    const type = assignment.targetType ?? assignment.target_type;
    const id = assignment.targetId ?? assignment.target_id;
    if (type === "instance") return "Toute l’instance";
    if (type === "group") {
      return `Groupe · ${state.groups.find((group) => group.id === id)?.name ?? id}`;
    }
    const tv = state.televisions.find((screen) => screen.id === id);
    return `TV · ${tv?.displayName ?? tv?.display_name ?? id}`;
  };
  const rows = state.sceneAssignments.map((assignment) => ledgerRow(
    targetName(assignment),
    `Scène · ${sceneName(assignment.sceneId ?? assignment.scene_id)}`,
  ));
  $("#sceneAssignmentList").replaceChildren(
    ...(rows.length ? rows : [make("p", "empty-copy", "Aucune affectation.")]),
  );

  const scheduleTarget = $("#sceneScheduleTarget");
  const previousScheduleTarget = scheduleTarget.value || "instance";
  scheduleTarget.replaceChildren(...operationalTargetOptions());
  scheduleTarget.value = [...scheduleTarget.options].some(
    (option) => option.value === previousScheduleTarget,
  )
    ? previousScheduleTarget
    : "instance";
  const scheduleScene = $("#sceneScheduleScene");
  const previousScheduleScene = scheduleScene.value;
  scheduleScene.replaceChildren(...publishedScenes.map((scene) => {
    const option = make("option", "", scene.name);
    option.value = scene.id;
    return option;
  }));
  if (publishedScenes.some((scene) => scene.id === previousScheduleScene)) {
    scheduleScene.value = previousScheduleScene;
  }
  $("#sceneScheduleForm").querySelector('button[type="submit"]').disabled = publishedScenes.length === 0;
  const scheduleForm = $("#sceneScheduleForm");
  $("#sceneScheduleTimezone").textContent = Intl.DateTimeFormat().resolvedOptions().timeZone
    || "local du navigateur";
  if (scheduleForm.dataset.defaultsSet !== "true") {
    $("#sceneScheduleStartsAt").value = localDateTimeInputValue(Date.now() + 10 * 60 * 1000);
    $("#sceneScheduleEndsAt").value = localDateTimeInputValue(Date.now() + 2 * 60 * 60 * 1000);
    scheduleForm.dataset.defaultsSet = "true";
  }
  const scheduleStatus = {
    scheduled: "prévue",
    active: "en cours",
    completed: "terminée",
    cancelled: "annulée",
  };
  const scheduleRows = state.sceneSchedules
    .filter((schedule) => schedule.status !== "cancelled")
    .map((schedule) => {
      const row = ledgerRow(
        targetName(schedule),
        [
          `Scène · ${sceneName(schedule.sceneId ?? schedule.scene_id)}`,
          `${new Date(schedule.startsAt ?? schedule.starts_at).toLocaleString("fr-FR")} → ${
            schedule.endsAt ?? schedule.ends_at
              ? new Date(schedule.endsAt ?? schedule.ends_at).toLocaleString("fr-FR")
              : "sans fin"
          }`,
          scheduleStatus[schedule.status] ?? schedule.status,
        ].join(" · "),
      );
      if (["scheduled", "active"].includes(schedule.status)) {
        const cancel = make("button", "danger-link", "Annuler");
        cancel.type = "button";
        cancel.dataset.cancelSceneSchedule = schedule.id;
        cancel.setAttribute(
          "aria-label",
          `Annuler la scène programmée pour ${targetName(schedule)}`,
        );
        row.append(cancel);
      }
      return row;
    });
  $("#sceneScheduleList").replaceChildren(
    ...(scheduleRows.length
      ? scheduleRows
      : [make("p", "empty-copy", "Aucune scène programmée.")]),
  );
};

const sourceSettingFor = (kind, selection) => {
  const { targetType, targetId } = parseOperationalTarget(selection);
  return state.sourceSettings.find((setting) => (
    (setting.sourceKind ?? setting.source_kind) === kind
    && (setting.targetType ?? setting.target_type) === targetType
    && (setting.targetId ?? setting.target_id ?? null) === targetId
  ));
};

const populateSourceSettings = () => {
  const selection = $("#sourceTargetSelect").value || "instance";
  const fields = {
    airplay: {
      enabled: $("#sourceAirplayEnabled"),
      label: $("#sourceAirplayLabel"),
      defaultLabel: "AirPlay",
    },
    cast: {
      enabled: $("#sourceCastEnabled"),
      label: $("#sourceCastLabel"),
      defaultLabel: "Cast",
    },
    hdmi: {
      enabled: $("#sourceHdmiEnabled"),
      label: $("#sourceHdmiLabel"),
      defaultLabel: "HDMI",
    },
    "private-app": {
      enabled: $("#sourcePrivateAppEnabled"),
      label: $("#sourcePrivateAppLabel"),
      defaultLabel: "Application privée",
    },
  };
  for (const [kind, field] of Object.entries(fields)) {
    const setting = sourceSettingFor(kind, selection);
    field.enabled.checked = Boolean(setting?.enabled);
    field.label.value = setting?.label ?? field.defaultLabel;
  }
  const airplay = sourceSettingFor("airplay", selection)?.configuration ?? {};
  const cast = sourceSettingFor("cast", selection)?.configuration ?? {};
  const hdmi = sourceSettingFor("hdmi", selection)?.configuration ?? {};
  const privateApp = sourceSettingFor("private-app", selection)?.configuration ?? {};
  $("#sourceAirplayService").value = airplay.serviceName ?? "RoomFrame";
  $("#sourceCastReceiver").value = cast.receiverApplicationId ?? "";
  $("#sourceHdmiInput").value = hdmi.physicalInput ?? "HDMI1";
  $("#sourcePrivateAppId").value = privateApp.applicationId ?? "org.example.privateapp";
};

const powerScheduleFor = (selection) => {
  const { targetType, targetId } = parseOperationalTarget(selection);
  return state.powerSchedules.find((schedule) => (
    (schedule.targetType ?? schedule.target_type) === targetType
    && (schedule.targetId ?? schedule.target_id ?? null) === targetId
  ));
};

const populatePowerSettings = () => {
  const selection = $("#powerTargetSelect").value || "instance";
  const schedule = powerScheduleFor(selection);
  const policies = state.instance?.defaults?.policies ?? {};
  const rules = Array.isArray(schedule?.rules) ? schedule.rules : [];
  const weekdays = rules.find((rule) => rule.days?.some((day) => ["mon", "tue", "wed", "thu", "fri"].includes(day)));
  const weekend = rules.find((rule) => rule.days?.some((day) => ["sat", "sun"].includes(day)));
  $("#powerEnabled").checked = Boolean(schedule?.enabled);
  $("#powerTimezone").value = schedule?.timezone ?? "Europe/Paris";
  $("#powerReturnHome").value = String(
    schedule?.return_home_when_inactive_minutes
    ?? policies.returnHomeWhenInactiveMinutes
    ?? 15,
  );
  $("#powerHomeSleep").value = String(
    schedule?.home_sleep_minutes
    ?? policies.homeSleepMinutes
    ?? 30,
  );
  $("#powerWeekdaysEnabled").checked = Boolean(weekdays);
  $("#powerWeekdayWake").value = weekdays?.wake ?? "07:30";
  $("#powerWeekdaySleep").value = weekdays?.sleep ?? "20:00";
  $("#powerWeekendEnabled").checked = Boolean(weekend);
  $("#powerWeekendWake").value = weekend?.wake ?? "09:00";
  $("#powerWeekendSleep").value = weekend?.sleep ?? "18:00";
};

const renderOperationalSettings = () => {
  for (const select of [$("#sourceTargetSelect"), $("#powerTargetSelect")]) {
    const previous = select.value || "instance";
    select.replaceChildren(...operationalTargetOptions());
    select.value = [...select.options].some((option) => option.value === previous)
      ? previous
      : "instance";
  }
  populateSourceSettings();
  populatePowerSettings();
};

const renderCollections = () => {
  const mediaRows = state.media.map((item) => ledgerRow(item.name ?? item.originalFilename ?? item.originalName ?? item.id, [item.kind ?? item.mimeType ?? item.mediaType, item.status].filter(Boolean).join(" · ")));
  $("#mediaList").replaceChildren(...(mediaRows.length ? mediaRows : [make("p", "empty-copy", "Aucun média.")]));

  const messageRows = state.messages.map((item) => ledgerRow(item.title ?? "Message", [item.startsAt, item.endsAt].filter(Boolean).map((date) => new Date(date).toLocaleString("fr-FR")).join(" → ")));
  $("#messageList").replaceChildren(...(messageRows.length ? messageRows : [make("p", "empty-copy", "Aucun message programmé.")]));

  const tvRows = state.televisions.map((tv) => {
    const card = make("article", "tv-cell");
    const enrollmentState = tv.enrollmentState ?? tv.enrollment_state;
    const metric = tv.latestMetric ?? tv.latest_metric;
    const connectionState = enrollmentState === "pending"
      ? "Enrôlement en attente"
      : enrollmentState === "revoked"
        ? "Accès révoqué"
        : tv.online === true
          ? "En ligne"
          : tv.online === false
            ? "Hors ligne"
            : "État inconnu";
    const health = enrollmentState !== "active"
      ? "pending"
      : tv.online === true
        ? "online"
        : "offline";
    card.dataset.health = health;
    const signal = make("span", "tv-signal", connectionState);
    signal.setAttribute("aria-label", connectionState);
    const metricLines = metric ? [
      `Réseau : ${metric.networkState ?? "inconnu"}`,
      `Synchronisation : ${metric.syncRevision == null ? "non mesurée" : `r${metric.syncRevision}${metric.syncDurationMs == null ? "" : ` · ${metric.syncDurationMs} ms`}`}`,
      `Mémoire : ${formatBytes(metric.memoryBytes) ?? "non mesurée"}`,
      `Stockage libre : ${formatBytes(metric.storageFreeBytes) ?? "non mesuré"}`,
      `Démarrage : ${metric.startupMs == null ? "non mesuré" : `${metric.startupMs} ms`}`,
      `Mise à jour : ${metric.updateState ?? "inconnue"}`,
      ...(metric.errorCode ? [`Erreur : ${metric.errorCode}`] : []),
    ] : ["Mesures techniques : en attente"];
    const credentialGeneration = Number(
      tv.credentialGeneration ?? tv.credential_generation ?? 1,
    );
    const credentialRotatedAt = tv.credentialRotatedAt ?? tv.device_key_rotated_at;
    const credentialsRevokedAt = tv.credentialsRevokedAt ?? tv.credentials_revoked_at;
    const credentialLines = [
      `Identité : génération ${Number.isSafeInteger(credentialGeneration) ? credentialGeneration : "inconnue"}`,
      credentialRotatedAt
        ? `Rotation : ${new Date(credentialRotatedAt).toLocaleString("fr-FR")}`
        : "Rotation : jamais observée",
      ...(credentialsRevokedAt
        ? [`Révocation : ${new Date(credentialsRevokedAt).toLocaleString("fr-FR")}`]
        : []),
    ];
    card.append(
      signal,
      make("h3", "", tv.displayName ?? tv.display_name ?? tv.name ?? tv.id),
      make("p", "", [
        connectionState,
        `Source : ${tv.activeSource ?? tv.source_state?.activeSource ?? "inconnue"}`,
        `Version : ${tv.version ?? tv.home_version ?? "inconnue"}`,
        ...credentialLines,
        ...metricLines,
      ].join("\n")),
    );
    if (enrollmentState !== "simulated") {
      const actions = make("div", "tv-credential-actions");
      if (enrollmentState !== "revoked") {
        const revoke = make("button", "danger-link", "Révoquer");
        revoke.type = "button";
        revoke.dataset.tvCredentialAction = "revoke";
        revoke.dataset.tvId = tv.id;
        revoke.setAttribute(
          "aria-label",
          `Révoquer l’accès de ${tv.displayName ?? tv.display_name ?? tv.id}`,
        );
        actions.append(revoke);
      }
      const reenroll = make(
        "button",
        "text-button",
        enrollmentState === "active" ? "Réenrôler" : "Créer une nouvelle clé",
      );
      reenroll.type = "button";
      reenroll.dataset.tvCredentialAction = "reenrollment";
      reenroll.dataset.tvId = tv.id;
      reenroll.setAttribute(
        "aria-label",
        `Réenrôler ${tv.displayName ?? tv.display_name ?? tv.id}`,
      );
      actions.append(reenroll);
      card.append(actions);
    }
    return card;
  });
  const fleetSummary = state.measuredMetrics
    ? make(
      "p",
      "fleet-summary",
      `${state.measuredMetrics.onlineScreens}/${state.measuredMetrics.totalScreens} en ligne · ${state.measuredMetrics.reportingScreens} avec mesures`,
    )
    : null;
  $("#fleetList").replaceChildren(
    ...(fleetSummary ? [fleetSummary] : []),
    ...(tvRows.length ? tvRows : [make("p", "empty-copy", "Aucune TV enrôlée.")]),
  );
  renderSceneManagement();
  renderOperationalSettings();
};

const renderEnrollmentTicket = () => {
  const ticket = state.enrollmentTicket;
  $("#enrollmentTicket").classList.toggle("hidden", !ticket);
  if (!ticket) {
    $("#enrollmentServer").value = "";
    $("#enrollmentDeviceId").value = "";
    $("#enrollmentSecret").value = "";
    $("#enrollmentExpiry").textContent = "";
    return;
  }
  $("#enrollmentServer").value = location.origin;
  $("#enrollmentDeviceId").value = ticket.id;
  $("#enrollmentSecret").value = ticket.enrollmentKey;
  $("#enrollmentExpiry").textContent = (
    `Valable jusqu’au ${new Date(ticket.expiresAt).toLocaleString("fr-FR")}. `
    + "La TV appaire l’autorité HTTPS avant d’envoyer la clé, puis cette clé ne fonctionne plus."
  );
};

const setEnrollmentTicket = (ticket) => {
  state.enrollmentTicket = ticket;
  renderEnrollmentTicket();
  const delay = Math.max(
    0,
    Math.min(30 * 60 * 1000, new Date(ticket.expiresAt).getTime() - Date.now()),
  );
  setTimeout(() => {
    if (state.enrollmentTicket?.id === ticket.id) {
      state.enrollmentTicket = null;
      renderEnrollmentTicket();
    }
  }, delay);
};

const enrollmentErrorMessage = (error) => (
  error?.message === "server_ca_not_ready"
    ? "L’autorité HTTPS locale n’est pas encore prête. Exécutez le diagnostic serveur puis réessayez."
    : error?.message === "server_ca_invalid"
      ? "L’autorité HTTPS locale est invalide ou désynchronisée. Corrigez le diagnostic serveur avant l’enrôlement."
      : error?.message
);

const tvCredentialActionSpec = {
  revoke: {
    title: "Révoquer l’accès de la TV",
    phrase: "REVOQUER LA TV",
    submit: "Révoquer maintenant",
    description: (name) => (
      `${name} perdra immédiatement l’accès à l’API. Son cache local restera affichable, `
      + "mais un nouvel enrôlement sera nécessaire pour reprendre la synchronisation."
    ),
  },
  reenrollment: {
    title: "Créer un nouvel enrôlement",
    phrase: "REINITIALISER L ENROLEMENT",
    submit: "Créer la nouvelle clé",
    description: (name) => (
      `La clé actuelle de ${name} sera invalidée. La nouvelle clé à usage unique `
      + "ne sera affichée que dans cette session et expirera après 30 minutes."
    ),
  },
};

const openTvCredentialDialog = (tv, action) => {
  const spec = tvCredentialActionSpec[action];
  if (!spec) return;
  const name = tv.displayName ?? tv.display_name ?? tv.id;
  state.tvCredentialAction = { action, tvId: tv.id };
  state.tvCredentialReturnFocus = document.activeElement;
  $("#tvCredentialDialogTitle").textContent = spec.title;
  $("#tvCredentialDialogDescription").textContent = spec.description(name);
  $("#tvCredentialConfirmationPhrase").textContent = spec.phrase;
  $("#tvCredentialSubmit").textContent = spec.submit;
  $("#tvCredentialConfirmation").value = "";
  formError("tvCredentialError");
  $("#tvCredentialDialog").showModal();
  $("#tvCredentialConfirmation").focus();
};

const releaseHasHomeApk = (release) => (
  release.status === "verified"
  && Array.isArray(release.verification?.apkArtifacts)
  && release.verification.apkArtifacts.some((artifact) => artifact.kind === "home-apk")
);

const updateDeploymentTargetControls = () => {
  const strategy = $("#deploymentStrategy").value;
  const type = $("#deploymentTargetType");
  if (strategy === "canary") {
    type.value = "tv";
    type.disabled = true;
  } else {
    type.disabled = false;
    if (type.value === "tv") type.value = "fleet";
  }
  const targetType = type.value;
  const target = $("#deploymentTarget");
  const targetField = $("#deploymentTargetField");
  const candidates = targetType === "tv"
    ? state.televisions.filter((tv) => (tv.enrollmentState ?? tv.enrollment_state) === "active")
    : targetType === "group"
      ? state.groups
      : [];
  target.replaceChildren(...candidates.map((candidate) => {
    const option = make("option", "", candidate.displayName ?? candidate.display_name ?? candidate.name ?? candidate.id);
    option.value = candidate.id;
    return option;
  }));
  const needsTarget = targetType !== "fleet";
  targetField.classList.toggle("hidden", !needsTarget);
  target.disabled = !needsTarget;
  target.required = needsTarget;
  $("#deploymentBatchSize").disabled = strategy === "canary";
  if (strategy === "canary") $("#deploymentBatchSize").value = "1";
};

const updateServerUpdatePolicyControls = () => {
  const policy = state.serverUpdatePolicy;
  const mode = $("#serverUpdatePolicyMode").value;
  const activating = policy?.mode !== "automatic" && mode === "automatic";
  const confirmationField = $("#serverUpdatePolicyConfirmationField");
  const confirmationHelp = $("#serverUpdatePolicyConfirmationHelp");
  const confirmation = $("#serverUpdatePolicyConfirmation");
  confirmationField.classList.toggle("hidden", !activating);
  confirmationHelp.classList.toggle("hidden", !activating);
  confirmation.disabled = !activating;
  confirmation.required = activating;
  if (!activating) confirmation.value = "";
};

const renderServerUpdatePolicy = () => {
  const policy = state.serverUpdatePolicy;
  const form = $("#serverUpdatePolicyForm");
  const summary = $("#serverUpdatePolicySummary");
  if (!policy) {
    summary.textContent = "Cette session ne peut pas consulter la politique de mise à jour serveur.";
    [...form.elements].forEach((control) => {
      control.disabled = true;
    });
    return;
  }
  $("#serverUpdatePolicyMode").value = policy.mode ?? "manual";
  $("#serverUpdatePolicyDelay").value = String(policy.minimumImportAgeMinutes ?? 60);
  $("#serverUpdateWindowStart").value = policy.windowStart ?? "02:00";
  $("#serverUpdateWindowEnd").value = policy.windowEnd ?? "05:00";
  $("#serverUpdateTimezone").value = policy.timezone ?? "UTC";
  [...form.elements].forEach((control) => {
    control.disabled = false;
  });
  summary.textContent = policy.mode === "automatic"
    ? `Automatique : uniquement les imports GitHub signés, âgés d’au moins ${policy.minimumImportAgeMinutes} minutes, entre ${policy.windowStart} et ${policy.windowEnd} (${policy.timezone}). Un échec exige ensuite une décision humaine.`
    : `Manuel : chaque bascule serveur exige une demande explicite. La fenêtre ${policy.windowStart}–${policy.windowEnd} (${policy.timezone}) est mémorisée mais inactive.`;
  updateServerUpdatePolicyControls();
};

const renderReleases = () => {
  renderServerUpdatePolicy();
  const source = state.releaseSource;
  const sourcePanel = $("#automaticReleaseSource");
  const sourceTitle = make(
    "h3",
    "",
    source?.enabled ? "Veille GitHub signée" : "Veille GitHub désactivée",
  );
  const sourceState = source?.state;
  const sourceDetails = source?.enabled
    ? [
      `${source.repository} · canal ${source.channel}`,
      `Contrôle toutes les ${source.pollIntervalMinutes} minutes`,
      sourceState?.lastCheckedAt
        ? `Dernier contrôle ${new Date(sourceState.lastCheckedAt).toLocaleString("fr-FR")}`
        : "Premier contrôle en attente",
      sourceState?.lastResult ? `Résultat ${sourceState.lastResult}` : null,
      sourceState?.lastErrorCode ? `Refus ${sourceState.lastErrorCode}` : null,
    ]
    : [
      "L’import hors ligne .rfupdate reste disponible.",
      "L’installateur peut activer un dépôt owner/repo sans donner de privilèges système à l’API.",
    ];
  sourcePanel.replaceChildren(
    make("span", "record-kicker", source?.enabled ? "AUTO / GITHUB" : "HORS LIGNE"),
    sourceTitle,
    make("p", "", sourceDetails.filter(Boolean).join("\n")),
  );

  const eligible = state.releases.filter(releaseHasHomeApk);
  const releaseSelect = $("#deploymentRelease");
  const selectedRelease = releaseSelect.value;
  releaseSelect.replaceChildren(...eligible.map((release) => {
    const option = make("option", "", `v${release.version} · APK vérifié`);
    option.value = release.id;
    return option;
  }));
  if (eligible.some((release) => release.id === selectedRelease)) {
    releaseSelect.value = selectedRelease;
  }
  $("#deploymentForm").querySelector('button[type="submit"]').disabled = eligible.length === 0;
  updateDeploymentTargetControls();

  const activeServerRequest = state.serverUpdateRequests.find(
    (request) => request.status === "pending" || request.status === "running",
  );
  const serverEligible = state.releases.filter((release) => (
    release.status === "verified"
    && release.has_server_archive === true
    && !release.deployed_at
  ));
  const serverSelect = $("#serverUpdateRelease");
  const selectedServerRelease = serverSelect.value;
  serverSelect.replaceChildren(...serverEligible.map((release) => {
    const option = make("option", "", `v${release.version} · archive signée`);
    option.value = release.id;
    return option;
  }));
  if (serverEligible.some((release) => release.id === selectedServerRelease)) {
    serverSelect.value = selectedServerRelease;
  }
  const serverSubmit = $("#serverUpdateForm").querySelector('button[type="submit"]');
  serverSubmit.disabled = serverEligible.length === 0 || Boolean(activeServerRequest);

  const releaseRows = state.releases.map((release) => {
    const row = make("article", "release-record");
    const apk = release.verification?.apkArtifacts?.find((artifact) => artifact.kind === "home-apk");
    row.append(
      make("span", "record-kicker", releaseHasHomeApk(release) ? "APK HOME PRÊT" : "SERVEUR / ARCHIVE"),
      make("h3", "", `RoomFrame ${release.version}`),
      make("p", "", [
        release.status ?? "statut inconnu",
        release.deployed_at
          ? `Serveur appliqué le ${new Date(release.deployed_at).toLocaleString("fr-FR")}`
          : release.has_server_archive === true
            ? "Archive serveur disponible"
            : null,
        apk ? `${apk.packageName} · code ${apk.versionCode}` : "Aucun APK Home dans ce bundle",
        release.imported_at ? new Date(release.imported_at).toLocaleString("fr-FR") : null,
      ].filter(Boolean).join("\n")),
    );
    return row;
  });
  const deploymentRows = state.deployments.map((deployment) => {
    const row = make("article", "deployment-record");
    const progress = typeof deployment.progress === "object" && deployment.progress ? deployment.progress : {};
    const line = Object.entries(progress)
      .map(([status, count]) => `${status} ${count}`)
      .join(" · ");
    row.append(
      make("span", "record-kicker", `${deployment.strategy ?? "vague"} · ${deployment.target_type ?? "cible"}`),
      make("h3", "", deployment.status === "completed" ? "Vague terminée" : "Distribution en cours"),
      make("p", "", line || "En attente du premier retour TV"),
    );
    if (deployment.status === "running") {
      const advance = make("button", "tool");
      advance.type = "button";
      advance.dataset.advanceDeployment = deployment.id;
      advance.textContent = "Valider et ouvrir la suite";
      row.append(advance);
      if (Number(progress.failed ?? 0) + Number(progress.deferred ?? 0) > 0) {
        const retry = make("button", "tool");
        retry.type = "button";
        retry.dataset.retryDeployment = deployment.id;
        retry.textContent = "Relancer les TV interrompues";
        row.append(retry);
      }
    }
    return row;
  });
  const serverRequestRows = state.serverUpdateRequests.map((request) => {
    const row = make("article", "deployment-record");
    row.append(
      make("span", "record-kicker", `SERVEUR · ${request.status ?? "inconnu"}`),
      make("h3", "", `RoomFrame ${request.version}`),
      make("p", "", [
        request.status === "pending" ? "En attente du courtier Debian" : null,
        request.status === "running" ? "Sauvegarde ou bascule en cours" : null,
        request.status === "completed" ? "Healthchecks réussis" : null,
        request.status === "rolled-back" ? "Ancien code rétabli automatiquement" : null,
        request.status === "failed" ? `Échec contrôlé · ${request.last_error_code ?? "voir diagnostic"}` : null,
        request.requested_at
          ? new Date(request.requested_at).toLocaleString("fr-FR")
          : null,
      ].filter(Boolean).join("\n")),
    );
    return row;
  });
  const board = $("#releaseBoard");
  board.replaceChildren(
    ...(releaseRows.length ? releaseRows : [make("p", "empty-copy", "Aucune version vérifiée.")]),
    ...serverRequestRows,
    ...(deploymentRows.length ? deploymentRows : []),
  );
};

const refreshReleases = async () => {
  const payload = await api.get("releases");
  state.releases = Array.isArray(payload.releases) ? payload.releases : [];
  state.deployments = Array.isArray(payload.deployments) ? payload.deployments : [];
  state.serverUpdateRequests = Array.isArray(payload.serverUpdateRequests)
    ? payload.serverUpdateRequests
    : [];
  state.releaseSource = payload.source ?? null;
  state.serverUpdatePolicy = payload.policy ?? null;
  renderReleases();
};

const populateBrandForm = () => {
  const branding = normalizeBranding(state.instance?.branding);
  $("#brandDisplayName").value = state.instance?.displayName ?? "RoomFrame";
  for (const field of ["Primary", "Accent", "Surface", "Ink", "Muted"]) {
    const key = field.toLowerCase();
    $(`#brand${field}`).value = branding[key];
    $(`#brand${field}Text`).value = branding[key];
  }
  $("#brandFontPreset").value = branding.fontPreset;
  const logoSelect = $("#brandLogoAsset");
  const empty = make("option", "", "Aucun logo global");
  empty.value = "";
  const options = [empty];
  for (const media of state.media.filter((item) => item.kind === "image" && item.status === "ready")) {
    const option = make("option", "", media.originalFilename ?? media.id);
    option.value = media.id;
    options.push(option);
  }
  logoSelect.replaceChildren(...options);
  logoSelect.value = branding.logoAssetId ?? "";
  const logoUrl = assetUrl(branding.logoAssetId, "logo");
  for (const image of [$("#instanceLogo"), $("#brandPreviewLogo")]) {
    image.classList.toggle("hidden", !logoUrl);
    if (logoUrl) image.src = logoUrl;
    else image.removeAttribute("src");
  }
};

const previewBrandForm = () => {
  const candidate = {
    displayName: $("#brandDisplayName").value.trim() || "RoomFrame",
    branding: {
      primary: $("#brandPrimary").value,
      accent: $("#brandAccent").value,
      surface: $("#brandSurface").value,
      ink: $("#brandInk").value,
      muted: $("#brandMuted").value,
      fontPreset: $("#brandFontPreset").value,
      logoAssetId: $("#brandLogoAsset").value || null,
    },
  };
  applyBranding(candidate);
};

const renderSecurity = () => {
  const user = sessionUser(state.session);
  const ledger = $("#securityLedger");
  ledger.replaceChildren();
  const entries = [
    ["Session", user?.username ?? user?.email ?? "Authentifiée"],
    ["Rôle", user?.role ?? (Array.isArray(user?.roles) ? user.roles.join(", ") : "Non communiqué")],
    [
      "Double validation",
      state.passkeys.length > 0
        ? `TOTP actif · ${state.passkeys.length} passkey${state.passkeys.length > 1 ? "s" : ""}`
        : "TOTP obligatoire · aucune passkey liée",
    ],
    ["Protection TOTP", "Secret chiffré · code 30 s · réutilisation refusée"],
    ["Sessions actives", state.securitySessions.length || "Chargement…"],
  ];
  for (const [term, description] of entries) ledger.append(make("dt", "", term), make("dd", "", description));
};

const securityDate = (value) => (
  value ? new Date(value).toLocaleString("fr-FR") : "Jamais"
);

const sessionAgentLabel = (value) => {
  const agent = String(value || "");
  const platform = /Macintosh|Mac OS X/i.test(agent)
    ? "Mac"
    : /Android/i.test(agent)
      ? "Android"
      : /Windows/i.test(agent)
        ? "Windows"
        : /Linux/i.test(agent)
          ? "Linux"
          : "Navigateur";
  const browser = /Edg\//.test(agent)
    ? "Edge"
    : /Chrome\//.test(agent)
      ? "Chrome"
      : /Safari\//.test(agent)
        ? "Safari"
        : /Firefox\//.test(agent)
          ? "Firefox"
          : "client web";
  return `${platform} · ${browser}`;
};

const passkeyErrorMessage = (error) => {
  if (error?.name === "NotAllowedError") {
    return "La demande a été annulée ou l’appareil n’a pas validé la passkey.";
  }
  const messages = {
    passkey_not_available: "Aucune passkey n’est encore liée à ce compte. Utilisez le TOTP.",
    passkey_not_configured: "Les passkeys ne sont pas configurées sur cette instance.",
    passkey_canonical_origin_required: (
      `Ouvrez le nom HTTPS principal${
        error?.payload?.preferredUrl ? ` : ${error.payload.preferredUrl}` : ""
      }. Les passkeys ne fonctionnent pas sur l’URL IP de secours.`
    ),
    step_up_failed: "Phrase de passe ou nouveau code TOTP incorrect.",
    invalid_passkey_response: "La preuve passkey a été refusée.",
    invalid_passkey_challenge: "La demande passkey a expiré. Recommencez.",
  };
  return messages[error?.message] ?? error?.message ?? "Opération passkey impossible.";
};

const renderPasskeys = () => {
  const container = $("#passkeyList");
  const available = passkeysAvailable();
  $("#openPasskeyRegistration").disabled = !available;
  $("#passkeyCanonicalUrl").textContent = state.passkeyCanonicalUrl
    ? `Origine liée : ${state.passkeyCanonicalUrl}`
    : available
      ? "Origine HTTPS principale non communiquée."
      : "Ce navigateur ne fournit pas WebAuthn dans ce contexte sécurisé.";
  if (state.passkeys.length === 0) {
    container.replaceChildren(make(
      "p",
      "empty-copy",
      available
        ? "Aucune passkey. Le TOTP reste obligatoire pour ouvrir la régie."
        : "Aucune passkey affichée. Utilisez un navigateur WebAuthn sur le nom HTTPS principal.",
    ));
    return;
  }
  container.replaceChildren(...state.passkeys.map((passkey) => {
    const row = make("article", "security-record");
    const identity = make("div");
    identity.append(
      make("h3", "", passkey.label),
      make(
        "p",
        "",
        `${passkey.deviceType === "multiDevice" ? "Synchronisée" : "Appareil unique"}`
          + `${passkey.backedUp ? " · sauvegardée" : ""}`,
      ),
    );
    const activity = make("div");
    activity.append(
      make("span", "record-state", passkey.lastUsedAt ? "UTILISÉE" : "PRÊTE"),
      make(
        "p",
        "",
        `Ajoutée ${securityDate(passkey.createdAt)} · Dernier usage ${securityDate(passkey.lastUsedAt)}`,
      ),
    );
    const revoke = make("button", "tool", "Révoquer");
    revoke.type = "button";
    revoke.dataset.passkeyRevoke = passkey.id;
    revoke.setAttribute("aria-label", `Révoquer la passkey ${passkey.label}`);
    row.append(identity, activity, revoke);
    return row;
  }));
};

const renderSecuritySessions = () => {
  const container = $("#sessionList");
  $("#revokeOtherSessions").disabled = state.securitySessions.length <= 1;
  if (state.securitySessions.length === 0) {
    container.replaceChildren(make("p", "empty-copy", "Aucune session active communiquée."));
    return;
  }
  container.replaceChildren(...state.securitySessions.map((session) => {
    const row = make("article", "security-record");
    const identity = make("div");
    identity.append(
      make("h3", "", sessionAgentLabel(session.userAgent)),
      make("p", "", session.remoteAddress || "Adresse non communiquée"),
    );
    const activity = make("div");
    activity.append(
      make(
        "span",
        `record-state${session.current ? "" : " remote"}`,
        session.current ? "CETTE SESSION" : "AUTORISÉE",
      ),
      make(
        "p",
        "",
        `Ouverte ${securityDate(session.createdAt)} · Vue ${securityDate(session.lastSeenAt)}`
          + ` · Expire ${securityDate(session.expiresAt)}`,
      ),
    );
    const revoke = make("button", "tool", session.current ? "Se déconnecter" : "Fermer");
    revoke.type = "button";
    revoke.dataset.sessionRevoke = session.id;
    revoke.setAttribute(
      "aria-label",
      session.current ? "Fermer cette session" : `Fermer la session ${sessionAgentLabel(session.userAgent)}`,
    );
    row.append(identity, activity, revoke);
    return row;
  }));
};

const roleLabel = (slug) => (
  state.adminRoles.find((role) => role.slug === slug)?.displayName
  ?? slug
  ?? "Rôle inconnu"
);

const userStatusLabel = (status) => ({
  active: "actif",
  pending: "en attente",
  disabled: "désactivé",
}[status] ?? "inconnu");

const populateUserRoleSelects = () => {
  for (const select of [$("#userInvitationRole"), $("#userActionRole")]) {
    const selected = select.value;
    select.replaceChildren(...state.adminRoles.map((role) => {
      const option = make("option", "", role.displayName);
      option.value = role.slug;
      return option;
    }));
    if (state.adminRoles.some((role) => role.slug === selected)) {
      select.value = selected;
    }
  }
};

const renderUserInvitationTicket = () => {
  const ticket = $("#userInvitationTicket");
  if (!state.userInvitation) {
    ticket.classList.add("hidden");
    $("#userInvitationToken").textContent = "";
    return;
  }
  $("#userInvitationToken").textContent = state.userInvitation.activationToken;
  $("#userInvitationTicketDescription").textContent = (
    `${state.userInvitation.username} · expire ${securityDate(state.userInvitation.expiresAt)}. `
    + "Ce jeton ne sera plus affiché après masquage ou rechargement."
  );
  ticket.classList.remove("hidden");
};

const renderAdminUsers = () => {
  const container = $("#userList");
  const currentUser = sessionUser(state.session);
  const canRead = sessionHasPermission("users:read");
  const canManage = currentUser?.role === "owner";
  $("#openUserInvitation").classList.toggle("hidden", !canManage);
  $("#openUserInvitation").disabled = !canManage;
  populateUserRoleSelects();
  renderUserInvitationTicket();
  if (!canRead) {
    container.replaceChildren(make(
      "p",
      "empty-copy",
      "Votre rôle ne permet pas de consulter les autres comptes.",
    ));
    return;
  }
  if (state.adminUsers.length === 0) {
    container.replaceChildren(make("p", "empty-copy", "Aucun compte communiqué."));
    return;
  }
  container.replaceChildren(...state.adminUsers.map((user) => {
    const row = make("article", "security-record");
    const identity = make("div");
    identity.append(
      make("h3", "", user.username),
      make("p", "", user.email || "Aucun e-mail associé"),
    );
    const activity = make("div");
    const statusLabel = {
      active: "ACTIF",
      pending: "EN ATTENTE",
      disabled: "DÉSACTIVÉ",
    }[user.status] ?? "INCONNU";
    activity.append(
      make(
        "span",
        `record-state ${user.status === "pending" ? "pending" : user.status === "disabled" ? "disabled" : ""}`,
        statusLabel,
      ),
      make(
        "p",
        "",
        `${roleLabel(user.role)} · ${user.sessionCount} session${user.sessionCount > 1 ? "s" : ""}`
          + ` · ${user.passkeyCount} passkey${user.passkeyCount > 1 ? "s" : ""}`
          + (
            user.status === "pending" && user.invitationExpiresAt
              ? ` · invitation jusqu’au ${securityDate(user.invitationExpiresAt)}`
              : ""
          ),
      ),
    );
    const manage = make("button", "tool", "Gérer");
    manage.type = "button";
    manage.dataset.userManage = user.id;
    manage.disabled = !canManage || user.id === currentUser?.id;
    manage.setAttribute(
      "aria-label",
      user.id === currentUser?.id
        ? `Le compte courant ${user.username} ne peut pas se modifier lui-même`
        : `Gérer le compte ${user.username}`,
    );
    row.append(identity, activity, manage);
    return row;
  }));
};

const loadSecurityState = async () => {
  formError("passkeyError");
  formError("sessionSecurityError");
  formError("userAdministrationError");
  const canReadUsers = sessionHasPermission("users:read");
  const [
    passkeyResult,
    sessionResult,
    usersResult,
    rolesResult,
  ] = await Promise.allSettled([
    api.get("auth/passkeys"),
    api.get("auth/sessions"),
    canReadUsers ? api.get("users") : Promise.resolve({ users: [] }),
    canReadUsers ? api.get("roles") : Promise.resolve({ roles: [] }),
  ]);
  if (passkeyResult.status === "fulfilled") {
    state.passkeys = passkeyResult.value.passkeys ?? [];
    state.passkeyCanonicalUrl = passkeyResult.value.canonicalUrl ?? null;
  } else {
    state.passkeys = [];
    formError("passkeyError", passkeyErrorMessage(passkeyResult.reason));
  }
  if (sessionResult.status === "fulfilled") {
    state.securitySessions = sessionResult.value.sessions ?? [];
  } else {
    state.securitySessions = [];
    formError("sessionSecurityError", sessionResult.reason.message);
  }
  if (usersResult.status === "fulfilled") {
    state.adminUsers = usersResult.value.users ?? [];
  } else {
    state.adminUsers = [];
    formError("userAdministrationError", usersResult.reason.message);
  }
  if (rolesResult.status === "fulfilled") {
    state.adminRoles = rolesResult.value.roles ?? [];
  } else {
    state.adminRoles = [];
    formError("userAdministrationError", rolesResult.reason.message);
  }
  renderSecurity();
  renderPasskeys();
  renderSecuritySessions();
  renderAdminUsers();
};

const selectNode = (id, focus = false) => {
  if (state.preview) return;
  state.selectedId = id;
  renderNodes();
  renderProperties();
  if (focus) refs.nodeLayer.querySelector(`[data-node-id="${CSS.escape(id)}"]`)?.focus();
};

const scenePoint = (event) => {
  const rect = refs.monitor.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / rect.width * CANVAS_WIDTH,
    y: (event.clientY - rect.top) / rect.height * CANVAS_HEIGHT,
  };
};

const beginInteraction = (event) => {
  const element = event.target.closest("[data-node-id]");
  if (!element || !state.scene || state.preview) return;
  const node = state.scene.nodes.find((item) => item.id === element.dataset.nodeId);
  if (!node) return;
  event.preventDefault();
  const point = scenePoint(event);
  state.selectedId = node.id;
  const edge = event.target.dataset.edge;
  state.interaction = {
    pointerId: event.pointerId,
    node,
    edge,
    start: point,
    origin: { x: node.x, y: node.y, width: node.width, height: node.height },
  };
  refs.monitor.setPointerCapture(event.pointerId);
  renderNodes();
  renderProperties();
};

const moveInteraction = (event) => {
  const interaction = state.interaction;
  if (!interaction || event.pointerId !== interaction.pointerId) return;
  const point = scenePoint(event);
  const dx = point.x - interaction.start.x;
  const dy = point.y - interaction.start.y;
  const { node, origin, edge } = interaction;
  if (!edge) {
    node.x = Math.max(0, Math.min(CANVAS_WIDTH - node.width, origin.x + dx));
    node.y = Math.max(0, Math.min(CANVAS_HEIGHT - node.height, origin.y + dy));
  } else {
    let left = origin.x;
    let top = origin.y;
    let right = origin.x + origin.width;
    let bottom = origin.y + origin.height;
    if (edge.includes("w")) left = Math.max(0, Math.min(right - 20, origin.x + dx));
    if (edge.includes("e")) right = Math.min(CANVAS_WIDTH, Math.max(left + 20, origin.x + origin.width + dx));
    if (edge.includes("n")) top = Math.max(0, Math.min(bottom - 20, origin.y + dy));
    if (edge.includes("s")) bottom = Math.min(CANVAS_HEIGHT, Math.max(top + 20, origin.y + origin.height + dy));
    node.x = left;
    node.y = top;
    node.width = right - left;
    node.height = bottom - top;
  }
  const element = refs.nodeLayer.querySelector(`[data-node-id="${CSS.escape(node.id)}"]`);
  if (element) applyNodeGeometry(element, node);
  renderProperties();
  renderObjectList();
};

const endInteraction = (event) => {
  if (state.interaction?.pointerId === event.pointerId) state.interaction = null;
};

const nudgeSelected = (event) => {
  const node = selectedNode();
  if (!node || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Delete", "Backspace"].includes(event.key)) return;
  if (["Delete", "Backspace"].includes(event.key)) {
    event.preventDefault();
    deleteSelectedNode();
    return;
  }
  event.preventDefault();
  const amount = event.shiftKey ? 10 : 1;
  const dx = event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0;
  const dy = event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0;
  if (event.altKey) {
    node.width = Math.max(20, Math.min(CANVAS_WIDTH - node.x, node.width + dx));
    node.height = Math.max(20, Math.min(CANVAS_HEIGHT - node.y, node.height + dy));
  } else {
    node.x = Math.max(0, Math.min(CANVAS_WIDTH - node.width, node.x + dx));
    node.y = Math.max(0, Math.min(CANVAS_HEIGHT - node.height, node.y + dy));
  }
  renderNodes();
  renderProperties();
  refs.nodeLayer.querySelector(`[data-node-id="${CSS.escape(node.id)}"]`)?.focus();
};

const deleteSelectedNode = () => {
  if (!state.scene || !state.selectedId || state.preview) return;
  const index = state.scene.nodes.findIndex((node) => node.id === state.selectedId);
  if (index < 0) return;
  state.scene.nodes.splice(index, 1);
  state.selectedId = state.scene.nodes[Math.min(index, state.scene.nodes.length - 1)]?.id ?? null;
  renderNodes();
  renderProperties();
};

const updateSelectedProperties = () => {
  const node = selectedNode();
  if (!node) return;
  if (nodeSupportsLabel(node)) node.props.label = $("#nodeLabel").value.slice(0, 120);
  setNodeDisplayText(node, $("#nodeText").value.slice(0, 1000));
  if (["image", "video", "logo"].includes(node.kind)) {
    const assetId = $("#nodeAsset").value || null;
    node.props.assetId = assetId;
    if (assetId && node.kind === "logo") delete node.props.asset;
  }
  node.x = Math.max(0, Math.min(CANVAS_WIDTH - node.width, Number($("#nodeX").value) || 0));
  node.y = Math.max(0, Math.min(CANVAS_HEIGHT - node.height, Number($("#nodeY").value) || 0));
  node.width = Math.max(20, Math.min(CANVAS_WIDTH - node.x, Number($("#nodeWidth").value) || 20));
  node.height = Math.max(20, Math.min(CANVAS_HEIGHT - node.y, Number($("#nodeHeight").value) || 20));
  node.zIndex = Math.max(0, Math.min(10000, Math.round(Number($("#nodeZ").value) || 0)));
  node.focusOrder = Math.max(0, Math.min(10000, Math.round(Number($("#focusOrder").value) || 0)));
  renderNodes();
};

const saveRevision = async () => {
  if (!state.scene || state.preview) return;
  setBusy(true);
  try {
    state.scene = validateScene(state.scene);
    const payload = await api.post(`scenes/${encodeURIComponent(state.sceneId ?? state.scene.layoutId)}/revisions`, {
      scene: state.scene,
      baseRevision: state.currentRevisionId,
    });
    state.currentRevisionId = payload.revision ?? payload.revisionId ?? payload.revision?.id ?? payload.id ?? state.currentRevisionId;
    if (payload.revision) state.revisions.unshift({
      revision: payload.revision,
      sha256: payload.sha256,
      createdAt: new Date().toISOString(),
      status: "brouillon",
    });
    renderStudio();
    toast(`Brouillon enregistré${state.currentRevisionId ? ` · ${state.currentRevisionId}` : ""}.`);
    setStatus("ok", "Brouillon enregistré par l’API");
  } catch (error) {
    toast(`Enregistrement refusé : ${error.message}`, true);
    setStatus("error", `Enregistrement impossible : ${error.message}`, false);
  } finally {
    setBusy(false);
  }
};

const publishRevision = async () => {
  if (!state.scene || state.preview) return;
  if (!state.currentRevisionId) {
    toast("Enregistrez d’abord une révision.", true);
    return;
  }
  setBusy(true);
  try {
    const payload = await api.post(`scenes/${encodeURIComponent(state.sceneId ?? state.scene.layoutId)}/publish`, {
      revision: state.currentRevisionId,
    });
    const count = payload.targetCount ?? payload.deployment?.targetCount;
    toast(count == null ? "Révision publiée par le serveur." : `Révision publiée vers ${count} cible${count > 1 ? "s" : ""}.`);
    setStatus("ok", `Publication atomique confirmée${payload.manifestHash ? ` · ${payload.manifestHash.slice(0, 12)}` : ""}`);
    await loadStudio(state.sceneId);
  } catch (error) {
    toast(`Publication refusée : ${error.message}`, true);
    setStatus("error", `Publication impossible : ${error.message}`, false);
  } finally {
    setBusy(false);
  }
};

const uploadForm = async (endpoint, form, success) => {
  const data = new FormData(form);
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const payload = await api.post(endpoint, data);
    success(payload);
    form.reset();
  } catch (error) {
    toast(`Opération refusée : ${error.message}`, true);
  } finally {
    submit.disabled = false;
  }
};

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  formError("loginError");
  const form = event.currentTarget;
  const data = new FormData(form);
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const payload = await api.post("auth/login", {
      username: String(data.get("username") || "").trim(),
      password: String(data.get("password") || ""),
      totpCode: String(data.get("totpCode") || "").trim() || null,
    }, false);
    state.session = payload.session ?? payload;
    if (!sessionIsAuthenticated(state.session) && !payload.authenticated) throw new Error("Session non créée.");
    form.reset();
    await enterStudio();
  } catch (error) {
    formError("loginError", error.message);
  } finally {
    submit.disabled = false;
  }
});

$("#loginPasskeyButton").addEventListener("click", async () => {
  formError("loginError");
  if (!passkeysAvailable()) {
    formError(
      "loginError",
      "Ce navigateur ne fournit pas WebAuthn sur cette origine HTTPS.",
    );
    return;
  }
  const username = $("#loginUsername").value.trim();
  const password = $("#loginPassword").value;
  if (!username || !password) {
    formError("loginError", "Saisissez l’identifiant et la phrase de passe.");
    $("#loginUsername").focus();
    return;
  }
  const button = $("#loginPasskeyButton");
  button.disabled = true;
  try {
    const challenge = await api.post("auth/passkey/options", {
      username,
      password,
    }, false);
    const credential = await navigator.credentials.get({
      publicKey: requestOptionsFromJSON(challenge.options),
    });
    const payload = await api.post("auth/passkey/complete", {
      challengeId: challenge.challengeId,
      response: credentialToJSON(credential),
    }, false);
    state.session = payload.session ?? payload;
    if (!sessionIsAuthenticated(state.session) && !payload.authenticated) {
      throw new Error("Session non créée.");
    }
    $("#loginForm").reset();
    await enterStudio();
  } catch (error) {
    formError("loginError", passkeyErrorMessage(error));
  } finally {
    button.disabled = false;
  }
});

$("#openPasskeyRegistration").addEventListener("click", (event) => {
  formError("passkeyError");
  if (!passkeysAvailable()) {
    formError("passkeyError", "WebAuthn n’est pas disponible dans ce navigateur.");
    return;
  }
  if (
    state.passkeyCanonicalUrl
    && location.origin !== state.passkeyCanonicalUrl
  ) {
    formError(
      "passkeyError",
      `Ouvrez ${state.passkeyCanonicalUrl} pour ajouter une passkey.`,
    );
    return;
  }
  state.passkeyReturnFocus = event.currentTarget;
  $("#passkeyRegistrationDialog").showModal();
  $("#passkeyLabel").focus();
});

$("#passkeyRegistrationCancel").addEventListener("click", () => {
  $("#passkeyRegistrationDialog").close();
});

$("#passkeyRegistrationDialog").addEventListener("close", () => {
  $("#passkeyRegistrationForm").reset();
  formError("passkeyRegistrationError");
  state.passkeyReturnFocus?.focus();
  state.passkeyReturnFocus = null;
});

$("#passkeyRegistrationDialog").addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    $("#passkeyRegistrationDialog").close();
  }
});

$("#passkeyRegistrationForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  formError("passkeyRegistrationError");
  const form = event.currentTarget;
  const data = new FormData(form);
  const label = String(data.get("label") || "").trim();
  const submit = $("#passkeyRegistrationSubmit");
  submit.disabled = true;
  try {
    const challenge = await api.post("auth/passkeys/registration/options", {
      label,
      password: String(data.get("password") || ""),
      totpCode: String(data.get("totpCode") || "").trim(),
    });
    const credential = await navigator.credentials.create({
      publicKey: creationOptionsFromJSON(challenge.options),
    });
    await api.post("auth/passkeys/registration/complete", {
      challengeId: challenge.challengeId,
      label,
      response: credentialToJSON(credential),
    });
    $("#passkeyRegistrationDialog").close();
    await loadSecurityState();
    toast("Passkey liée et journalisée.");
  } catch (error) {
    formError("passkeyRegistrationError", passkeyErrorMessage(error));
  } finally {
    submit.disabled = false;
  }
});

$("#passkeyList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-passkey-revoke]");
  if (!button) return;
  const passkey = state.passkeys.find((entry) => entry.id === button.dataset.passkeyRevoke);
  if (!passkey) return;
  state.passkeyReturnFocus = button;
  $("#passkeyRevokeId").value = passkey.id;
  $("#passkeyRevokeDescription").textContent = (
    `« ${passkey.label} » ne pourra plus ouvrir la régie. `
    + "Confirmez avec votre phrase de passe et un nouveau code TOTP."
  );
  $("#passkeyRevokeDialog").showModal();
  $("#passkeyRevokePassword").focus();
});

$("#passkeyRevokeCancel").addEventListener("click", () => {
  $("#passkeyRevokeDialog").close();
});

$("#passkeyRevokeDialog").addEventListener("close", () => {
  $("#passkeyRevokeForm").reset();
  formError("passkeyRevokeError");
  state.passkeyReturnFocus?.focus();
  state.passkeyReturnFocus = null;
});

$("#passkeyRevokeDialog").addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    $("#passkeyRevokeDialog").close();
  }
});

$("#passkeyRevokeForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  formError("passkeyRevokeError");
  const data = new FormData(event.currentTarget);
  const passkeyId = String(data.get("passkeyId") || "");
  const submit = $("#passkeyRevokeSubmit");
  submit.disabled = true;
  try {
    await api.post(`auth/passkeys/${encodeURIComponent(passkeyId)}/revoke`, {
      password: String(data.get("password") || ""),
      totpCode: String(data.get("totpCode") || "").trim(),
    });
    $("#passkeyRevokeDialog").close();
    await loadSecurityState();
    toast("Passkey révoquée.");
  } catch (error) {
    formError("passkeyRevokeError", passkeyErrorMessage(error));
  } finally {
    submit.disabled = false;
  }
});

$("#sessionList").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-session-revoke]");
  if (!button) return;
  button.disabled = true;
  formError("sessionSecurityError");
  try {
    const result = await api.post(
      `auth/sessions/${encodeURIComponent(button.dataset.sessionRevoke)}/revoke`,
      {},
    );
    if (result.current) {
      api.csrfToken = "";
      state.session = null;
      state.scene = null;
      state.passkeys = [];
      state.securitySessions = [];
      state.adminUsers = [];
      state.adminRoles = [];
      state.userInvitation = null;
      state.passkeyCanonicalUrl = null;
      state.preview = null;
      $("#loginForm").reset();
      showGate("login");
      return;
    }
    await loadSecurityState();
    toast("Session distante fermée.");
  } catch (error) {
    formError("sessionSecurityError", error.message);
    button.disabled = false;
  }
});

$("#revokeOtherSessions").addEventListener("click", async () => {
  const button = $("#revokeOtherSessions");
  button.disabled = true;
  formError("sessionSecurityError");
  try {
    const result = await api.post("auth/sessions/revoke-others", {});
    await loadSecurityState();
    toast(`${result.revoked} autre${result.revoked > 1 ? "s" : ""} session${result.revoked > 1 ? "s" : ""} fermée${result.revoked > 1 ? "s" : ""}.`);
  } catch (error) {
    formError("sessionSecurityError", error.message);
  } finally {
    button.disabled = false;
  }
});

const userAdministrationErrorMessage = (error) => {
  const messages = {
    step_up_failed: "Phrase de passe ou nouveau code TOTP incorrect.",
    conflict: "Cet identifiant ou cet e-mail existe déjà.",
    self_management_forbidden: "Le compte courant ne peut pas se modifier lui-même.",
    last_owner_required: "Au moins un propriétaire actif doit rester disponible.",
    user_confirmation_failed: "L’identifiant retapé ne correspond pas.",
    user_not_active: "Ce compte est déjà inactif.",
    role_unchanged: "Choisissez un rôle différent.",
    invalid_role: "Le rôle demandé n’existe pas.",
  };
  return messages[error?.message] ?? error?.message ?? "Gestion du compte impossible.";
};

$("#openUserInvitation").addEventListener("click", (event) => {
  formError("userInvitationError");
  state.userActionReturnFocus = event.currentTarget;
  populateUserRoleSelects();
  $("#userInvitationRole").value = (
    state.adminRoles.some((role) => role.slug === "content")
      ? "content"
      : state.adminRoles[0]?.slug ?? ""
  );
  $("#userInvitationDialog").showModal();
  $("#userInvitationUsername").focus();
});

$("#userInvitationCancel").addEventListener("click", () => {
  $("#userInvitationDialog").close();
});

$("#userInvitationDialog").addEventListener("close", () => {
  $("#userInvitationForm").reset();
  formError("userInvitationError");
  state.userActionReturnFocus?.focus();
  state.userActionReturnFocus = null;
});

$("#userInvitationDialog").addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    $("#userInvitationDialog").close();
  }
});

$("#userInvitationForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  formError("userInvitationError");
  const form = event.currentTarget;
  const data = new FormData(form);
  const submit = $("#userInvitationSubmit");
  submit.disabled = true;
  try {
    const payload = await api.post("users", {
      username: String(data.get("username") || "").trim().toLowerCase(),
      email: String(data.get("email") || "").trim() || null,
      role: String(data.get("role") || ""),
      password: String(data.get("password") || ""),
      totpCode: String(data.get("totpCode") || "").trim(),
    });
    state.userInvitation = {
      username: payload.user.username,
      activationToken: payload.invitation.activationToken,
      expiresAt: payload.invitation.expiresAt,
    };
    $("#userInvitationDialog").close();
    await loadSecurityState();
    toast("Invitation créée. Transmettez le jeton avant de le masquer.");
  } catch (error) {
    formError("userInvitationError", userAdministrationErrorMessage(error));
  } finally {
    submit.disabled = false;
  }
});

$("#copyUserInvitation").addEventListener("click", async () => {
  if (!state.userInvitation?.activationToken) return;
  try {
    await navigator.clipboard.writeText(state.userInvitation.activationToken);
    toast("Jeton copié. Effacez le presse-papiers après transmission.");
  } catch {
    toast("Copie indisponible. Sélectionnez le jeton affiché.", true);
  }
});

$("#hideUserInvitation").addEventListener("click", () => {
  state.userInvitation = null;
  renderUserInvitationTicket();
  toast("Jeton masqué. Il ne peut pas être réaffiché.");
});

const updateUserActionControls = () => {
  const action = $("#userActionKind").value;
  const needsConfirmation = action !== "role";
  $("#userActionRoleField").classList.toggle("hidden", action !== "role");
  $("#userActionRole").required = action === "role";
  $("#userActionConfirmationField").classList.toggle("hidden", !needsConfirmation);
  $("#userActionConfirmation").required = needsConfirmation;
  const target = state.userActionTarget;
  $("#userActionHelp").textContent = {
    role: "Le changement ferme toutes les sessions du compte.",
    reissue: (
      "Le compte sera désactivé, ses sessions et passkeys révoquées, puis un nouveau jeton sera affiché une seule fois."
    ),
    disable: "La désactivation ferme les sessions, retire les passkeys et révoque toute invitation active.",
  }[action];
  $("#userActionSubmit").textContent = {
    role: "Changer le rôle",
    reissue: "Révoquer et réinviter",
    disable: "Désactiver",
  }[action];
  if (target) {
    $("#userActionConfirmation").placeholder = target.username;
  }
};

$("#userList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-user-manage]");
  if (!button || button.disabled) return;
  const user = state.adminUsers.find((entry) => entry.id === button.dataset.userManage);
  if (!user) return;
  state.userActionTarget = user;
  state.userActionReturnFocus = button;
  $("#userActionId").value = user.id;
  $("#userActionDescription").textContent = (
    `${user.username} · ${roleLabel(user.role)} · état ${userStatusLabel(user.status)}. `
    + "Chaque action exige votre phrase de passe et un nouveau TOTP."
  );
  populateUserRoleSelects();
  $("#userActionRole").value = user.role;
  $("#userActionKind").value = user.active ? "role" : "reissue";
  const disableOption = $("#userActionKind").querySelector('option[value="disable"]');
  disableOption.disabled = !user.active;
  updateUserActionControls();
  formError("userActionError");
  $("#userActionDialog").showModal();
  $("#userActionKind").focus();
});

$("#userActionKind").addEventListener("change", updateUserActionControls);

$("#userActionCancel").addEventListener("click", () => {
  $("#userActionDialog").close();
});

$("#userActionDialog").addEventListener("close", () => {
  $("#userActionForm").reset();
  formError("userActionError");
  state.userActionTarget = null;
  state.userActionReturnFocus?.focus();
  state.userActionReturnFocus = null;
});

$("#userActionDialog").addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    $("#userActionDialog").close();
  }
});

$("#userActionForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  formError("userActionError");
  const target = state.userActionTarget;
  if (!target) return;
  const data = new FormData(event.currentTarget);
  const action = String(data.get("action") || "");
  const common = {
    password: String(data.get("password") || ""),
    totpCode: String(data.get("totpCode") || "").trim(),
  };
  const submit = $("#userActionSubmit");
  submit.disabled = true;
  try {
    let payload;
    if (action === "role") {
      payload = await api.post(`users/${encodeURIComponent(target.id)}/role`, {
        ...common,
        role: String(data.get("role") || ""),
      });
    } else if (action === "reissue") {
      payload = await api.post(`users/${encodeURIComponent(target.id)}/invitation`, {
        ...common,
        confirmation: String(data.get("confirmation") || "").trim().toLowerCase(),
      });
      state.userInvitation = {
        username: payload.user.username,
        activationToken: payload.invitation.activationToken,
        expiresAt: payload.invitation.expiresAt,
      };
    } else {
      payload = await api.post(`users/${encodeURIComponent(target.id)}/disable`, {
        ...common,
        confirmation: String(data.get("confirmation") || "").trim().toLowerCase(),
      });
    }
    $("#userActionDialog").close();
    await loadSecurityState();
    toast(
      action === "role"
        ? "Rôle modifié et sessions fermées."
        : action === "reissue"
          ? "Ancien accès révoqué. Nouveau jeton affiché une seule fois."
          : "Compte désactivé et accès révoqués.",
    );
  } catch (error) {
    formError("userActionError", userAdministrationErrorMessage(error));
  } finally {
    submit.disabled = false;
  }
});

const resetActivationForm = () => {
  state.activationChallengeId = null;
  $("#activationForm").reset();
  $("#activationTotpDetails").classList.add("hidden");
  $("#activationTotpSecret").textContent = "";
  $("#activationTotpUri").removeAttribute("href");
  $("#activationTotpCode").required = false;
  $("#activationSubmit").disabled = true;
  formError("activationError");
};

const activationErrorMessage = (error) => ({
  invalid_activation_token: "Cette invitation est invalide, expirée ou déjà consommée.",
  invalid_activation_challenge: "Le défi TOTP est invalide ou expiré. Recommencez l’enrôlement.",
  invalid_password_length: "La phrase de passe doit contenir entre 12 et 256 caractères.",
  password_too_weak: "Choisissez une phrase de passe plus forte et moins prévisible.",
}[error?.message] ?? error?.message ?? "Activation impossible.");

$("#openActivationButton").addEventListener("click", () => {
  formError("loginError");
  resetActivationForm();
  showGate("activation");
});

$("#cancelActivationButton").addEventListener("click", () => {
  resetActivationForm();
  showGate("login");
});

$("#prepareActivationTotpButton").addEventListener("click", async () => {
  formError("activationError");
  const form = $("#activationForm");
  const data = new FormData(form);
  if (!form.reportValidity()) return;
  if (data.get("password") !== data.get("passwordConfirm")) {
    formError("activationError", "Les phrases de passe ne correspondent pas.");
    return;
  }
  const button = $("#prepareActivationTotpButton");
  button.disabled = true;
  try {
    const payload = await api.post("auth/activation/totp", {
      activationToken: String(data.get("activationToken") || ""),
    }, false);
    state.activationChallengeId = payload.challengeId;
    $("#activationIdentity").textContent = payload.username;
    $("#activationRole").textContent = payload.roleName || payload.role;
    $("#activationTotpSecret").textContent = payload.secret;
    $("#activationTotpUri").href = payload.otpauthUrl;
    $("#activationTotpDetails").classList.remove("hidden");
    $("#activationTotpCode").required = true;
    $("#activationSubmit").disabled = false;
    $("#activationTotpCode").focus();
  } catch (error) {
    formError("activationError", activationErrorMessage(error));
  } finally {
    button.disabled = false;
  }
});

$("#activationForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  formError("activationError");
  if (!state.activationChallengeId) {
    formError("activationError", "Préparez d’abord votre TOTP.");
    return;
  }
  const form = event.currentTarget;
  const data = new FormData(form);
  if (data.get("password") !== data.get("passwordConfirm")) {
    formError("activationError", "Les phrases de passe ne correspondent pas.");
    return;
  }
  const submit = $("#activationSubmit");
  submit.disabled = true;
  try {
    const payload = await api.post("auth/activation/complete", {
      activationToken: String(data.get("activationToken") || ""),
      challengeId: state.activationChallengeId,
      password: String(data.get("password") || ""),
      totpCode: String(data.get("totpCode") || "").trim(),
    }, false);
    state.session = payload;
    resetActivationForm();
    setStatus("ok", "Compte activé · invitation consommée");
    await enterStudio();
  } catch (error) {
    formError("activationError", activationErrorMessage(error));
    submit.disabled = false;
  }
});

$("#openRecoveryButton").addEventListener("click", () => {
  formError("loginError");
  showGate("recovery");
});
$("#cancelRecoveryButton").addEventListener("click", () => {
  state.recoveryChallengeId = null;
  $("#recoveryForm").reset();
  $("#recoveryTotpDetails").classList.add("hidden");
  $("#recoveryTotpSecret").textContent = "";
  $("#recoveryTotpCode").required = false;
  $("#recoveryTotpUri").removeAttribute("href");
  showGate("login");
});
$("#prepareRecoveryTotpButton").addEventListener("click", async () => {
  formError("recoveryError");
  const form = $("#recoveryForm");
  const data = new FormData(form);
  if (!form.reportValidity()) return;
  if (data.get("password") !== data.get("passwordConfirm")) {
    formError("recoveryError", "Les phrases de passe ne correspondent pas.");
    return;
  }
  const button = $("#prepareRecoveryTotpButton");
  button.disabled = true;
  try {
    const payload = await api.post("auth/recovery/totp", {
      recoveryToken: String(data.get("recoveryToken") || ""),
      username: String(data.get("username") || "").trim(),
    }, false);
    state.recoveryChallengeId = payload.challengeId ?? payload.setupId ?? null;
    const secret = payload.secret ?? payload.totpSecret;
    const uri = payload.otpauthUrl ?? payload.otpauthUri ?? payload.uri;
    if (!state.recoveryChallengeId || !secret) throw new Error("Réponse TOTP incomplète.");
    $("#recoveryTotpSecret").textContent = secret;
    $("#recoveryTotpUri").classList.toggle("hidden", !uri);
    if (uri) $("#recoveryTotpUri").href = uri;
    $("#recoveryTotpDetails").classList.remove("hidden");
    $("#recoveryTotpCode").required = true;
    $("#recoveryTotpCode").focus();
  } catch (error) {
    formError("recoveryError", error.message);
  } finally {
    button.disabled = false;
  }
});
$("#recoveryForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  formError("recoveryError");
  const form = event.currentTarget;
  const data = new FormData(form);
  const username = String(data.get("username") || "").trim();
  if (data.get("password") !== data.get("passwordConfirm")) {
    formError("recoveryError", "Les phrases de passe ne correspondent pas.");
    return;
  }
  if (!state.recoveryChallengeId) {
    formError("recoveryError", "Créez et validez d’abord le nouveau TOTP.");
    return;
  }
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    await api.post("auth/recovery/complete", {
      recoveryToken: String(data.get("recoveryToken") || ""),
      challengeId: state.recoveryChallengeId,
      username,
      password: String(data.get("password") || ""),
      totpCode: String(data.get("totpCode") || "").trim(),
    }, false);
    state.recoveryChallengeId = null;
    form.reset();
    $("#recoveryTotpDetails").classList.add("hidden");
    $("#recoveryTotpSecret").textContent = "";
    $("#recoveryTotpCode").required = false;
    $("#recoveryTotpUri").removeAttribute("href");
    showGate("login");
    $("#loginUsername").value = username;
    $("#loginPassword").focus();
    toast("Compte récupéré. Les anciennes sessions et passkeys ont été révoquées.");
  } catch (error) {
    formError("recoveryError", error.message);
  } finally {
    submit.disabled = false;
  }
});

$("#prepareTotpButton").addEventListener("click", async () => {
  formError("bootstrapError");
  const form = $("#bootstrapForm");
  const data = new FormData(form);
  if (!form.reportValidity()) return;
  if (data.get("password") !== data.get("passwordConfirm")) {
    formError("bootstrapError", "Les phrases de passe ne correspondent pas.");
    return;
  }
  $("#prepareTotpButton").disabled = true;
  try {
    const payload = await api.post("bootstrap/totp", {
      bootstrapToken: String(data.get("bootstrapToken") || ""),
      displayName: String(data.get("displayName") || "").trim(),
      username: String(data.get("username") || "").trim(),
      email: String(data.get("email") || "").trim(),
    }, false);
    state.totpSetupId = payload.challengeId ?? payload.setupId ?? payload.totpSetupId ?? payload.token ?? null;
    const secret = payload.secret ?? payload.totpSecret;
    const uri = payload.otpauthUrl ?? payload.otpauthUri ?? payload.uri;
    if (!secret || !state.totpSetupId) throw new Error("Réponse TOTP incomplète.");
    $("#totpSecret").textContent = secret;
    $("#totpUri").classList.toggle("hidden", !uri);
    if (uri) $("#totpUri").href = uri;
    $("#totpDetails").classList.remove("hidden");
    $("#bootstrapTotpCode").required = true;
    $("#bootstrapTotpCode").focus();
  } catch (error) {
    formError("bootstrapError", error.message);
  } finally {
    $("#prepareTotpButton").disabled = false;
  }
});

$("#bootstrapForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  formError("bootstrapError");
  const form = event.currentTarget;
  const data = new FormData(form);
  if (data.get("password") !== data.get("passwordConfirm")) {
    formError("bootstrapError", "Les phrases de passe ne correspondent pas.");
    return;
  }
  if (!state.totpSetupId) {
    formError("bootstrapError", "Préparez le TOTP avant de verrouiller l’instance.");
    return;
  }
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    await api.post("bootstrap/complete", {
      bootstrapToken: String(data.get("bootstrapToken") || ""),
      challengeId: state.totpSetupId,
      totpCode: String(data.get("totpCode") || "").trim(),
      displayName: String(data.get("displayName") || "").trim(),
      roomName: String(data.get("roomName") || "").trim(),
      defaultGreeting: String(data.get("defaultGreeting") || "").trim(),
      branding: DEFAULT_BRANDING,
      policies: { returnHomeWhenInactiveMinutes: 15, homeSleepMinutes: 30, powerScheduleEnabled: false },
      bootstrapAdmin: {
        username: String(data.get("username") || "").trim(),
        email: String(data.get("email") || "").trim(),
        password: String(data.get("password") || ""),
        mfaRequired: true,
      },
    }, false);
    const completedSession = await api.get("auth/session");
    form.reset();
    state.totpSetupId = null;
    $("#totpDetails").classList.add("hidden");
    state.session = completedSession;
    setStatus("ok", "Instance initialisée et assistant verrouillé");
    await enterStudio();
  } catch (error) {
    formError("bootstrapError", error.message);
  } finally {
    submit.disabled = false;
  }
});

refs.logoutButton.addEventListener("click", async () => {
  try {
    await api.post("auth/logout", {});
  } catch (error) {
    toast(`Déconnexion non confirmée : ${error.message}`, true);
  } finally {
    api.csrfToken = "";
    state.session = null;
    state.scene = null;
    state.passkeys = [];
    state.securitySessions = [];
    state.adminUsers = [];
    state.adminRoles = [];
    state.userInvitation = null;
    state.passkeyCanonicalUrl = null;
    state.preview = null;
    state.previewSelection = "";
    $("#loginForm").reset();
    showGate("login");
  }
});

refs.retryButton.addEventListener("click", boot);
$("#reloadStudioButton").addEventListener("click", () => loadStudio(state.sceneId));
$("#saveButton").addEventListener("click", saveRevision);
$("#publishButton").addEventListener("click", publishRevision);
$("#deleteNodeButton").addEventListener("click", deleteSelectedNode);
$("#sceneLoadButton").addEventListener("click", async () => {
  const sceneId = $("#sceneLibrarySelect").value;
  if (!sceneId || sceneId === state.sceneId) return;
  await loadStudio(sceneId);
});
$("#sceneCloneButton").addEventListener("click", async () => {
  if (!state.scene || state.preview) return;
  const name = $("#sceneCloneName").value.trim();
  if (!name) {
    toast("Donnez un nom à la nouvelle scène.", true);
    $("#sceneCloneName").focus();
    return;
  }
  const button = $("#sceneCloneButton");
  button.disabled = true;
  try {
    const scene = validateScene(cloneScene(state.scene));
    scene.name = name;
    const created = await api.post("scenes", { name, scene });
    $("#sceneCloneName").value = "";
    await loadStudio(created.id);
    toast(`Scène « ${name} » créée en brouillon.`);
  } catch (error) {
    toast(`Création refusée : ${error.message}`, true);
  } finally {
    button.disabled = false;
  }
});
$("#sceneAssignmentForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  formError("sceneAssignmentError");
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  const sceneId = $("#sceneAssignmentScene").value;
  let target;
  try {
    target = parseOperationalTarget($("#sceneAssignmentTarget").value);
  } catch (error) {
    formError("sceneAssignmentError", error.message);
    return;
  }
  submit.disabled = true;
  try {
    const payload = await api.put("scene-assignments", { sceneId, ...target });
    const key = operationalTargetKey(target.targetType, target.targetId);
    state.sceneAssignments = state.sceneAssignments.filter((assignment) => (
      operationalTargetKey(
        assignment.targetType ?? assignment.target_type,
        assignment.targetId ?? assignment.target_id ?? null,
      ) !== key
    ));
    state.sceneAssignments.push({
      scene_id: sceneId,
      target_type: target.targetType,
      target_id: target.targetId,
    });
    renderSceneManagement();
    toast(`Scène affectée · synchronisation r${payload.syncRevision}.`);
  } catch (error) {
    formError("sceneAssignmentError", error.message);
  } finally {
    submit.disabled = false;
  }
});
$("#sceneScheduleForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  formError("sceneScheduleError");
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  let target;
  try {
    target = parseOperationalTarget($("#sceneScheduleTarget").value);
  } catch (error) {
    formError("sceneScheduleError", error.message);
    return;
  }
  const startsAt = new Date($("#sceneScheduleStartsAt").value);
  const endValue = $("#sceneScheduleEndsAt").value;
  const endsAt = endValue ? new Date(endValue) : null;
  if (
    Number.isNaN(startsAt.getTime())
    || (endsAt && Number.isNaN(endsAt.getTime()))
    || (endsAt && endsAt <= startsAt)
  ) {
    formError("sceneScheduleError", "La fenêtre de programmation est invalide.");
    return;
  }
  submit.disabled = true;
  try {
    const payload = await api.post("scene-schedules", {
      sceneId: $("#sceneScheduleScene").value,
      ...target,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt?.toISOString() ?? null,
    });
    state.sceneSchedules.unshift(payload.schedule);
    form.reset();
    delete form.dataset.defaultsSet;
    renderSceneManagement();
    toast(
      payload.syncRevision == null
        ? "Scène programmée. Le worker activera la révision à l’heure prévue."
        : `Scène activée · synchronisation r${payload.syncRevision}.`,
    );
  } catch (error) {
    formError("sceneScheduleError", error.message);
  } finally {
    submit.disabled = false;
  }
});
$("#sceneScheduleList").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-cancel-scene-schedule]");
  if (!button) return;
  const scheduleId = button.dataset.cancelSceneSchedule;
  button.disabled = true;
  try {
    const payload = await api.post(
      `scene-schedules/${encodeURIComponent(scheduleId)}/cancel`,
      {},
    );
    state.sceneSchedules = state.sceneSchedules.map((schedule) => (
      schedule.id === scheduleId ? payload.schedule : schedule
    ));
    renderSceneManagement();
    toast(
      payload.syncRevision == null
        ? "Programmation annulée."
        : `Scène retirée · synchronisation r${payload.syncRevision}.`,
    );
  } catch (error) {
    button.disabled = false;
    toast(`Annulation refusée : ${error.message}`, true);
  }
});
refs.targetSelect.addEventListener("change", () => {
  loadTargetPreview(refs.targetSelect.value);
});

$$(".section").forEach((button) => button.addEventListener("click", () => {
  $$(".section").forEach((item) => {
    const active = item === button;
    item.classList.toggle("on", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  $$(".workspace-panel").forEach((panel) => panel.classList.toggle("on", panel.id === `view-${button.dataset.view}`));
}));

refs.sceneName.addEventListener("input", () => {
  if (!state.scene || state.preview) return;
  state.scene.name = refs.sceneName.value.slice(0, 100);
  refs.stageTitle.textContent = state.scene.name || "Scène sans titre";
});
refs.greetingInput.addEventListener("input", () => {
  if (state.preview) return;
  const greeting = state.scene?.nodes.find((node) => node.kind === "text" && node.props.role === "greeting");
  if (!greeting) return;
  setNodeDisplayText(greeting, refs.greetingInput.value.slice(0, 220));
  renderNodes();
});
refs.greetingInput.addEventListener("blur", () => {
  if (state.preview) return;
  const greeting = state.scene?.nodes.find((node) => node.kind === "text" && node.props.role === "greeting");
  if (greeting) refs.greetingInput.value = greeting.props.text;
});
$("#backgroundModes").addEventListener("click", (event) => {
  const button = event.target.closest("[data-fit]");
  if (!button || !state.scene || state.preview) return;
  state.scene.canvas.background.mode = button.dataset.fit;
  renderStudio();
});
refs.backgroundBlur.addEventListener("input", () => {
  if (!state.scene || state.preview) return;
  state.scene.canvas.background.blur = Number(refs.backgroundBlur.value);
  refs.backgroundBlurValue.value = `${refs.backgroundBlur.value} px`;
  refs.backgroundBlurValue.textContent = refs.backgroundBlurValue.value;
  renderBackground();
});
$("#sourceTargetSelect").addEventListener("change", populateSourceSettings);
$("#powerTargetSelect").addEventListener("change", populatePowerSettings);
$("#sourceSettingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  formError("sourceSettingsError");
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  const { targetType, targetId } = parseOperationalTarget($("#sourceTargetSelect").value);
  const castReceiver = $("#sourceCastReceiver").value.trim();
  const privateApplicationId = $("#sourcePrivateAppId").value.trim();
  const items = [
    {
      kind: "airplay",
      enabled: $("#sourceAirplayEnabled").checked,
      label: $("#sourceAirplayLabel").value.trim(),
      configuration: {
        adapter: "unsupported",
        serviceName: $("#sourceAirplayService").value.trim(),
        receiverMode: "isolated",
      },
    },
    {
      kind: "cast",
      enabled: $("#sourceCastEnabled").checked,
      label: $("#sourceCastLabel").value.trim(),
      configuration: {
        adapter: "unsupported",
        ...(castReceiver ? { receiverApplicationId: castReceiver } : {}),
      },
    },
    {
      kind: "hdmi",
      enabled: $("#sourceHdmiEnabled").checked,
      label: $("#sourceHdmiLabel").value.trim(),
      configuration: {
        adapter: "unsupported",
        physicalInput: $("#sourceHdmiInput").value,
        signalProbe: true,
      },
    },
    {
      kind: "private-app",
      enabled: $("#sourcePrivateAppEnabled").checked,
      label: $("#sourcePrivateAppLabel").value.trim(),
      configuration: {
        adapter: "unsupported",
        ...(privateApplicationId ? { applicationId: privateApplicationId } : {}),
        returnPolicy: "home-on-exit",
      },
    },
  ];
  submit.disabled = true;
  try {
    const payload = await api.put("settings/sources", {
      targetType,
      targetId,
      items,
    });
    const targetKey = operationalTargetKey(targetType, targetId);
    state.sourceSettings = state.sourceSettings.filter((setting) => (
      operationalTargetKey(
        setting.targetType ?? setting.target_type,
        setting.targetId ?? setting.target_id ?? null,
      ) !== targetKey
    ));
    state.sourceSettings.push(...items.map((item) => ({
      target_type: targetType,
      target_id: targetId,
      source_kind: item.kind,
      enabled: item.enabled,
      label: item.label,
      configuration: item.configuration,
    })));
    populateSourceSettings();
    toast(`${payload.sourceCount} sources enregistrées. Les adaptateurs restent à valider sur la TV.`);
  } catch (error) {
    formError("sourceSettingsError", error.message);
  } finally {
    submit.disabled = false;
  }
});
$("#powerSettingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  formError("powerSettingsError");
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  const { targetType, targetId } = parseOperationalTarget($("#powerTargetSelect").value);
  const rules = [];
  if ($("#powerWeekdaysEnabled").checked) {
    rules.push({
      days: ["mon", "tue", "wed", "thu", "fri"],
      wake: $("#powerWeekdayWake").value || null,
      sleep: $("#powerWeekdaySleep").value || null,
    });
  }
  if ($("#powerWeekendEnabled").checked) {
    rules.push({
      days: ["sat", "sun"],
      wake: $("#powerWeekendWake").value || null,
      sleep: $("#powerWeekendSleep").value || null,
    });
  }
  const schedule = {
    targetType,
    targetId,
    timezone: $("#powerTimezone").value.trim(),
    enabled: $("#powerEnabled").checked,
    returnHomeWhenInactiveMinutes: Number($("#powerReturnHome").value),
    homeSleepMinutes: Number($("#powerHomeSleep").value),
    rules,
  };
  submit.disabled = true;
  try {
    const payload = await api.put("settings/power", schedule);
    const targetKey = operationalTargetKey(targetType, targetId);
    state.powerSchedules = state.powerSchedules.filter((entry) => (
      operationalTargetKey(
        entry.targetType ?? entry.target_type,
        entry.targetId ?? entry.target_id ?? null,
      ) !== targetKey
    ));
    state.powerSchedules.push({
      target_type: targetType,
      target_id: targetId,
      timezone: schedule.timezone,
      enabled: schedule.enabled,
      rules: schedule.rules,
      return_home_when_inactive_minutes: schedule.returnHomeWhenInactiveMinutes,
      home_sleep_minutes: schedule.homeSleepMinutes,
    });
    populatePowerSettings();
    toast(payload.capabilityProbeRequired
      ? "Horaires enregistrés · exécution conditionnée à la sonde matérielle."
      : "Horaires enregistrés.");
  } catch (error) {
    formError("powerSettingsError", error.message);
  } finally {
    submit.disabled = false;
  }
});
$("#enrollmentForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  formError("enrollmentError");
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  const data = new FormData(form);
  const displayName = String(data.get("displayName") || "").trim();
  const roomName = String(data.get("roomName") || "").trim();
  submit.disabled = true;
  try {
    const ticket = await api.post("tvs/enrollment", { displayName, roomName });
    if (
      !/^[0-9a-f-]{36}$/i.test(String(ticket.id || "")) ||
      typeof ticket.enrollmentKey !== "string" ||
      ticket.enrollmentKey.length < 20 ||
      !ticket.expiresAt ||
      ticket.trustBootstrap?.mode !== "encrypted-server-ca" ||
      ticket.trustBootstrap?.version !== 1
    ) {
      throw new Error("Réponse d’enrôlement incomplète.");
    }
    if (!state.televisions.some((tv) => (tv.id ?? tv.deviceId) === ticket.id)) {
      state.televisions.unshift({
        id: ticket.id,
        displayName,
        roomName,
        enrollmentState: "pending",
      });
    }
    form.reset();
    renderCollections();
    setEnrollmentTicket(ticket);
    toast("Enrôlement créé. La clé ne sera plus réaffichée après masquage.");
  } catch (error) {
    formError("enrollmentError", enrollmentErrorMessage(error));
  } finally {
    submit.disabled = false;
  }
});
$("#copyEnrollmentButton").addEventListener("click", async () => {
  const ticket = state.enrollmentTicket;
  if (!ticket) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify({
      serverUrl: location.origin,
      deviceId: ticket.id,
      enrollmentKey: ticket.enrollmentKey,
    }));
    toast("Paramètres d’enrôlement copiés. Effacez le presse-papiers après usage.");
  } catch {
    toast("Copie indisponible. Utilisez les trois champs affichés.", true);
  }
});
$("#hideEnrollmentButton").addEventListener("click", () => {
  state.enrollmentTicket = null;
  renderEnrollmentTicket();
  toast("Clé masquée. Créez un nouvel enrôlement si elle n’a pas été utilisée.");
});
$("#fleetList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-tv-credential-action]");
  if (!button) return;
  const tv = state.televisions.find((item) => item.id === button.dataset.tvId);
  if (tv) openTvCredentialDialog(tv, button.dataset.tvCredentialAction);
});
$("#tvCredentialCancel").addEventListener("click", () => {
  $("#tvCredentialDialog").close();
});
$("#tvCredentialDialog").addEventListener("close", () => {
  const returnFocus = state.tvCredentialReturnFocus;
  state.tvCredentialAction = null;
  state.tvCredentialReturnFocus = null;
  $("#tvCredentialConfirmation").value = "";
  formError("tvCredentialError");
  returnFocus?.focus();
});
$("#tvCredentialDialog").addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    $("#tvCredentialDialog").close();
  }
});
$("#tvCredentialForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const pending = state.tvCredentialAction;
  const spec = pending ? tvCredentialActionSpec[pending.action] : null;
  if (!pending || !spec) return;
  const confirmation = $("#tvCredentialConfirmation").value;
  if (confirmation !== spec.phrase) {
    formError("tvCredentialError", `Retapez exactement « ${spec.phrase} ».`);
    return;
  }
  const submit = $("#tvCredentialSubmit");
  submit.disabled = true;
  formError("tvCredentialError");
  try {
    const payload = await api.post(
      `tvs/${encodeURIComponent(pending.tvId)}/${
        pending.action === "revoke" ? "revoke" : "reenrollment"
      }`,
      { confirmation },
    );
    if (pending.action === "revoke") {
      state.televisions = state.televisions.map((tv) => (
        tv.id === pending.tvId
          ? {
              ...tv,
              enrollmentState: payload.tv.enrollmentState,
              enrollment_state: payload.tv.enrollmentState,
              credentialGeneration: payload.tv.credentialGeneration,
              credential_generation: payload.tv.credentialGeneration,
              credentialsRevokedAt: payload.tv.credentialsRevokedAt,
              credentials_revoked_at: payload.tv.credentialsRevokedAt,
              online: null,
            }
          : tv
      ));
      toast("Accès TV révoqué. Son cache local n’a pas été effacé.");
    } else {
      state.televisions = state.televisions.map((tv) => (
        tv.id === pending.tvId
          ? {
              ...tv,
              enrollmentState: "pending",
              enrollment_state: "pending",
              credentialGeneration: payload.credentialGeneration,
              credential_generation: payload.credentialGeneration,
              credentialsRevokedAt: null,
              credentials_revoked_at: null,
              online: null,
            }
          : tv
      ));
      setEnrollmentTicket(payload);
      toast("Nouvel enrôlement créé. L’ancienne clé ne fonctionne plus.");
    }
    $("#tvCredentialDialog").close();
    renderCollections();
  } catch (error) {
    formError("tvCredentialError", enrollmentErrorMessage(error));
  } finally {
    submit.disabled = false;
  }
});
$("#palette").addEventListener("click", (event) => {
  const button = event.target.closest("[data-add-kind]");
  if (!button || state.preview) return;
  if (!state.scene) state.scene = normalizeScene({ ...cloneScene(DEFAULT_SCENE), nodes: [] });
  const node = createNode(button.dataset.addKind, button.dataset.source);
  node.zIndex = Math.min(10000, Math.max(0, ...state.scene.nodes.map((item) => item.zIndex)) + 1);
  state.scene.nodes.push(node);
  state.selectedId = node.id;
  renderStudio();
  selectNode(node.id, true);
});

for (const field of ["Primary", "Accent", "Surface", "Ink", "Muted"]) {
  const picker = $(`#brand${field}`);
  const textInput = $(`#brand${field}Text`);
  picker.addEventListener("input", () => {
    textInput.value = picker.value;
    previewBrandForm();
  });
  textInput.addEventListener("input", () => {
    const value = textInput.value.trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(value)) {
      picker.value = value;
      previewBrandForm();
    }
  });
}
$("#brandDisplayName").addEventListener("input", previewBrandForm);
$("#brandFontPreset").addEventListener("change", previewBrandForm);
$("#brandLogoAsset").addEventListener("change", previewBrandForm);
$("#brandForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  formError("brandError");
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  const branding = {
    primary: $("#brandPrimaryText").value.trim().toLowerCase(),
    accent: $("#brandAccentText").value.trim().toLowerCase(),
    surface: $("#brandSurfaceText").value.trim().toLowerCase(),
    ink: $("#brandInkText").value.trim().toLowerCase(),
    muted: $("#brandMutedText").value.trim().toLowerCase(),
    fontPreset: $("#brandFontPreset").value,
    logoAssetId: $("#brandLogoAsset").value || null,
  };
  submit.disabled = true;
  try {
    const payload = await api.put("instance/branding", {
      displayName: $("#brandDisplayName").value.trim(),
      branding,
    });
    applyBranding(payload.instance);
    populateBrandForm();
    toast("Charte globale enregistrée et transmise à la synchronisation TV.");
    setStatus("ok", "Identité visuelle enregistrée par l’API");
  } catch (error) {
    formError("brandError", error.message);
    applyBranding(state.instance ?? state.bootstrapStatus?.identity ?? {});
  } finally {
    submit.disabled = false;
  }
});
refs.objectList.addEventListener("click", (event) => {
  if (state.preview) return;
  const button = event.target.closest("[data-select-node]");
  if (button) selectNode(button.dataset.selectNode, true);
});
refs.nodeLayer.addEventListener("pointerdown", beginInteraction);
refs.nodeLayer.addEventListener("focusin", (event) => {
  const element = event.target.closest("[data-node-id]");
  if (element && element.dataset.nodeId !== state.selectedId) selectNode(element.dataset.nodeId);
});
refs.nodeLayer.addEventListener("keydown", nudgeSelected);
refs.monitor.addEventListener("pointermove", moveInteraction);
refs.monitor.addEventListener("pointerup", endInteraction);
refs.monitor.addEventListener("pointercancel", endInteraction);
$("#propertiesForm").addEventListener("input", updateSelectedProperties);

$("#backgroundFile").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file || !state.scene || state.preview) return;
  const form = new FormData();
  form.append("file", file);
  form.append("purpose", "scene-background");
  try {
    const payload = await api.post("media", form);
    const media = payload.media ?? payload;
    if (media?.id) state.media.unshift(media);
    state.scene.canvas.background.type = file.type.startsWith("video/") ? "video" : "image";
    state.scene.canvas.background.asset = media.id ?? media.sha256 ?? media.url;
    renderStudio();
    toast("Média validé et associé au brouillon.");
  } catch (error) {
    toast(`Import refusé : ${error.message}`, true);
  } finally {
    event.target.value = "";
  }
});

$("#mediaForm").addEventListener("submit", (event) => {
  event.preventDefault();
  uploadForm("media", event.currentTarget, (payload) => {
    const media = payload.media ?? payload;
    if (media?.id) state.media.unshift(media);
    renderCollections();
    toast("Média accepté par le serveur.");
  });
});
$("#messageForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const payload = await api.post("messages", {
      title: String(data.get("title") || "").trim(),
      body: String(data.get("body") || "").trim(),
      startsAt: data.get("startsAt") ? new Date(String(data.get("startsAt"))).toISOString() : null,
      endsAt: data.get("endsAt") ? new Date(String(data.get("endsAt"))).toISOString() : null,
      targetType: "instance",
      targetId: null,
    });
    const message = payload.message ?? payload;
    if (message?.id) state.messages.unshift(message);
    form.reset();
    renderCollections();
    toast("Message programmé par le serveur.");
  } catch (error) {
    toast(`Programmation refusée : ${error.message}`, true);
  } finally {
    submit.disabled = false;
  }
});
$("#releaseForm").addEventListener("submit", (event) => {
  event.preventDefault();
  uploadForm("releases/import", event.currentTarget, (payload) => {
    const result = $("#releaseResult");
    result.replaceChildren();
    const entries = [
      ["Bundle", payload.name ?? payload.release?.name ?? "Importé"],
      ["Version", payload.version ?? payload.release?.version ?? "Non communiquée"],
      ["Signature", payload.signatureValid === true ? "Valide" : payload.signatureValid === false ? "Invalide" : "Vérifiée par le serveur"],
      ["Statut", payload.status ?? "Import accepté"],
    ];
    for (const [label, value] of entries) {
      const line = make("div", "release-line");
      line.append(make("b", "", label), make("span", "", value));
      result.append(line);
    }
    refreshReleases().catch((error) => toast(`Version importée, actualisation impossible : ${error.message}`, true));
    toast("Bundle vérifié. Aucun déploiement n’a été lancé automatiquement.");
  });
});
$("#deploymentStrategy").addEventListener("change", updateDeploymentTargetControls);
$("#deploymentTargetType").addEventListener("change", updateDeploymentTargetControls);
$("#serverUpdatePolicyMode").addEventListener("change", updateServerUpdatePolicyControls);
$("#serverUpdatePolicyForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  formError("serverUpdatePolicyError");
  const form = event.currentTarget;
  const data = new FormData(form);
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const payload = await api.put("settings/server-updates", {
      mode: String(data.get("mode") || "manual"),
      minimumImportAgeMinutes: Number(data.get("minimumImportAgeMinutes")),
      windowStart: String(data.get("windowStart") || ""),
      windowEnd: String(data.get("windowEnd") || ""),
      timezone: String(data.get("timezone") || "").trim(),
      confirmation: String(data.get("confirmation") || ""),
    });
    state.serverUpdatePolicy = payload.policy;
    renderServerUpdatePolicy();
    toast(
      payload.policy.mode === "automatic"
        ? "Automatisation serveur activée dans la fenêtre choisie."
        : "Mises à jour serveur maintenues en validation manuelle.",
    );
  } catch (error) {
    formError("serverUpdatePolicyError", error.message);
  } finally {
    submit.disabled = false;
    updateServerUpdatePolicyControls();
  }
});
$("#serverUpdateForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  formError("serverUpdateError");
  const form = event.currentTarget;
  const data = new FormData(form);
  const releaseId = String(data.get("releaseId") || "");
  const confirmVersion = String(data.get("confirmVersion") || "").trim();
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const request = await api.post(
      `releases/${encodeURIComponent(releaseId)}/server-update-requests`,
      { confirmVersion },
    );
    form.reset();
    await refreshReleases();
    toast(`RoomFrame ${request.version} est en file. Le courtier Debian revalidera tout avant la bascule.`);
  } catch (error) {
    formError("serverUpdateError", error.message);
  } finally {
    renderReleases();
  }
});
$("#deploymentForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  formError("deploymentError");
  const form = event.currentTarget;
  const data = new FormData(form);
  const releaseId = String(data.get("releaseId") || "");
  const strategy = String(data.get("strategy") || "canary");
  const targetType = strategy === "canary" ? "tv" : String(data.get("targetType") || "fleet");
  const targetId = targetType === "fleet" ? null : String(data.get("targetId") || "");
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const deployment = await api.post(`releases/${encodeURIComponent(releaseId)}/deployments`, {
      strategy,
      targetType,
      targetId,
      batchSize: strategy === "canary" ? 1 : Number(data.get("batchSize") || 1),
    });
    await refreshReleases();
    toast(`Vague ouverte pour ${deployment.offeredCount} TV sur ${deployment.targetCount}.`);
  } catch (error) {
    formError("deploymentError", error.message);
  } finally {
    submit.disabled = false;
  }
});
$("#releaseBoard").addEventListener("click", async (event) => {
  const retry = event.target.closest("[data-retry-deployment]");
  if (retry) {
    retry.disabled = true;
    try {
      const result = await api.post(
        `deployments/${encodeURIComponent(retry.dataset.retryDeployment)}/retry`,
        {},
      );
      await refreshReleases();
      toast(`${result.retriedCount} TV remise(s) dans la vague active.`);
    } catch (error) {
      toast(`La relance a été refusée : ${error.message}`, true);
    } finally {
      retry.disabled = false;
    }
    return;
  }
  const button = event.target.closest("[data-advance-deployment]");
  if (!button) return;
  button.disabled = true;
  try {
    const result = await api.post(
      `deployments/${encodeURIComponent(button.dataset.advanceDeployment)}/advance`,
      { batchSize: Number($("#deploymentBatchSize").value || 1) },
    );
    await refreshReleases();
    toast(result.status === "completed" ? "Déploiement terminé." : `${result.offeredCount} nouvelle(s) TV ont reçu la vague.`);
  } catch (error) {
    toast(`La vague ne peut pas avancer : ${error.message}`, true);
  } finally {
    button.disabled = false;
  }
});

boot();
