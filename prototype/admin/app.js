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
} from "./scene-model.js?v=0.3.0-ui8";
import { ApiError, readApiResponse } from "./api-client.js?v=0.3.0-ui8";

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
  measuredMetrics: null,
  enrollmentTicket: null,
  interaction: null,
  preview: null,
  previewSelection: "",
  totpSetupId: null,
  recoveryChallengeId: null,
  studioLoaded: false,
};

const refs = {
  app: $("#app"),
  authGate: $("#authGate"),
  loginPanel: $("#loginPanel"),
  bootstrapPanel: $("#bootstrapPanel"),
  recoveryPanel: $("#recoveryPanel"),
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
  const gateCopy = {
    login: ["AUTH / 02", "Poste de composition", "Administration locale"],
    bootstrap: ["INIT / 01", "Préparer l’instance", "Configuration applicative"],
    recovery: ["SECOURS / 03", "Récupération contrôlée", "Autorité locale temporaire"],
  }[panel];
  $("#gateNumber").textContent = gateCopy[0];
  $("#gateHeadline").textContent = gateCopy[1];
  $("#gateAside").textContent = gateCopy[2];
  refs.logoutButton.classList.add("hidden");
  const focusTarget = panel === "login"
    ? $("#loginUsername")
    : panel === "bootstrap"
      ? $("#bootstrapDisplayName")
      : $("#recoveryToken");
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
  hideGate();
  renderSecurity();
  await loadStudio();
};

const loadStudio = async () => {
  setBusy(true);
  setStatus("loading", "Chargement de la régie…");
  try {
    const payload = await api.get("studio");
    applyBranding(payload.instance ?? state.bootstrapStatus?.identity ?? {});
    const sourceScene = payload.scene?.document ?? payload.scene ?? payload.draft?.scene ?? payload.currentRevision?.scene ?? payload.layout;
    state.scene = normalizeScene(sourceScene ?? cloneScene(DEFAULT_SCENE));
    state.sceneId = payload.scene?.id ?? state.scene.layoutId;
    state.currentRevisionId = payload.scene?.currentRevision ?? payload.currentRevisionId ?? payload.draft?.revision ?? payload.currentRevision?.revision ?? null;
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
    card.append(
      signal,
      make("h3", "", tv.displayName ?? tv.display_name ?? tv.name ?? tv.id),
      make("p", "", [
        connectionState,
        `Source : ${tv.activeSource ?? tv.source_state?.activeSource ?? "inconnue"}`,
        `Version : ${tv.version ?? tv.home_version ?? "inconnue"}`,
        ...metricLines,
      ].join("\n")),
    );
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
  $("#enrollmentExpiry").textContent = `Valable jusqu’au ${new Date(ticket.expiresAt).toLocaleString("fr-FR")}. Après échange, cette clé ne fonctionne plus.`;
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

const renderReleases = () => {
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

  const releaseRows = state.releases.map((release) => {
    const row = make("article", "release-record");
    const apk = release.verification?.apkArtifacts?.find((artifact) => artifact.kind === "home-apk");
    row.append(
      make("span", "record-kicker", releaseHasHomeApk(release) ? "APK HOME PRÊT" : "SERVEUR / ARCHIVE"),
      make("h3", "", `RoomFrame ${release.version}`),
      make("p", "", [
        release.status ?? "statut inconnu",
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
  const board = $("#releaseBoard");
  board.replaceChildren(
    ...(releaseRows.length ? releaseRows : [make("p", "empty-copy", "Aucune version vérifiée.")]),
    ...(deploymentRows.length ? deploymentRows : []),
  );
};

const refreshReleases = async () => {
  const payload = await api.get("releases");
  state.releases = Array.isArray(payload.releases) ? payload.releases : [];
  state.deployments = Array.isArray(payload.deployments) ? payload.deployments : [];
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
    ["Double validation", "TOTP obligatoire à chaque connexion"],
    ["Protection TOTP", "Secret chiffré · code 30 s · réutilisation refusée"],
  ];
  for (const [term, description] of entries) ledger.append(make("dt", "", term), make("dd", "", description));
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
    await loadStudio();
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
    toast("Compte récupéré. Toutes les anciennes sessions ont été révoquées.");
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
    state.preview = null;
    state.previewSelection = "";
    $("#loginForm").reset();
    showGate("login");
  }
});

refs.retryButton.addEventListener("click", boot);
$("#reloadStudioButton").addEventListener("click", loadStudio);
$("#saveButton").addEventListener("click", saveRevision);
$("#publishButton").addEventListener("click", publishRevision);
$("#deleteNodeButton").addEventListener("click", deleteSelectedNode);
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
      !ticket.expiresAt
    ) {
      throw new Error("Réponse d’enrôlement incomplète.");
    }
    state.enrollmentTicket = ticket;
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
    renderEnrollmentTicket();
    const delay = Math.max(0, Math.min(30 * 60 * 1000, new Date(ticket.expiresAt).getTime() - Date.now()));
    setTimeout(() => {
      if (state.enrollmentTicket?.id === ticket.id) {
        state.enrollmentTicket = null;
        renderEnrollmentTicket();
      }
    }, delay);
    toast("Enrôlement créé. La clé ne sera plus réaffichée après masquage.");
  } catch (error) {
    formError("enrollmentError", error.message);
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
