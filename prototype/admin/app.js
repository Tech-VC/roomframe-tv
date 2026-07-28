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
} from "./scene-model.js";
import { ApiError, readApiResponse } from "./api-client.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const make = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = String(text);
  return element;
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
    if (method === "POST" && authenticated) {
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
};

const state = {
  bootstrapStatus: null,
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
  interaction: null,
  totpSetupId: null,
  studioLoaded: false,
};

const refs = {
  app: $("#app"),
  authGate: $("#authGate"),
  loginPanel: $("#loginPanel"),
  bootstrapPanel: $("#bootstrapPanel"),
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
  $("#saveButton").disabled = busy;
  $("#publishButton").disabled = busy;
};

const showGate = (panel) => {
  refs.authGate.classList.remove("hidden");
  refs.loginPanel.classList.toggle("hidden", panel !== "login");
  refs.bootstrapPanel.classList.toggle("hidden", panel !== "bootstrap");
  $("#gateNumber").textContent = panel === "login" ? "02" : "01";
  $("#gateHeadline").textContent = panel === "login" ? "Entrer dans la régie." : "Préparer l’instance.";
  refs.logoutButton.classList.add("hidden");
  setTimeout(() => (panel === "login" ? $("#loginUsername") : $("#bootstrapDisplayName")).focus(), 0);
};

const hideGate = () => {
  refs.authGate.classList.add("hidden");
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

const boot = async () => {
  setBusy(true);
  setStatus("loading", "Connexion à l’instance locale…");
  try {
    const status = await api.get("bootstrap/status");
    state.bootstrapStatus = status;
    const server = status.server ?? {};
    const serverUrl = server.adminUrl || server.preferredAdminUrl || location.origin;
    $("#loginServerUrl").textContent = serverUrl;
    $("#bootstrapServerUrl").textContent = `${serverUrl} · réseau géré hors RoomFrame`;
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
    const sourceScene = payload.scene?.document ?? payload.scene ?? payload.draft?.scene ?? payload.currentRevision?.scene ?? payload.layout;
    state.scene = normalizeScene(sourceScene ?? cloneScene(DEFAULT_SCENE));
    state.sceneId = payload.scene?.id ?? state.scene.layoutId;
    state.currentRevisionId = payload.scene?.currentRevision ?? payload.currentRevisionId ?? payload.draft?.revision ?? payload.currentRevision?.revision ?? null;
    state.revisions = Array.isArray(payload.revisions) ? payload.revisions : [];
    state.media = Array.isArray(payload.media) ? payload.media : [];
    state.messages = Array.isArray(payload.messages) ? payload.messages : [];
    state.targets = [
      ...(Array.isArray(payload.groups) ? payload.groups.map((group) => ({ ...group, name: `Groupe · ${group.name}` })) : []),
      ...(Array.isArray(payload.tvs) ? payload.tvs.map((tv) => ({ ...tv, name: `TV · ${tv.display_name ?? tv.displayName ?? tv.id}` })) : []),
    ];
    state.televisions = Array.isArray(payload.televisions) ? payload.televisions : Array.isArray(payload.tvs) ? payload.tvs : [];
    state.selectedId = state.scene.nodes[0]?.id ?? null;
    state.studioLoaded = true;
    renderStudio();
    setStatus("ok", sourceScene ? "Régie synchronisée avec l’API" : "Instance vide · scène locale prête à enregistrer");
  } catch (error) {
    state.studioLoaded = false;
    state.scene = null;
    renderStudio();
    setStatus("error", `Chargement du studio impossible : ${error.message}`, true);
  } finally {
    setBusy(false);
  }
};

const selectedNode = () => state.scene?.nodes.find((node) => node.id === state.selectedId) ?? null;

const renderStudio = () => {
  const hasScene = Boolean(state.scene);
  refs.stageEmpty.classList.toggle("hidden", hasScene);
  refs.monitor.classList.toggle("hidden", !hasScene);
  if (!hasScene) {
    refs.objectList.replaceChildren();
    refs.revisionList.replaceChildren(make("p", "empty-copy", "Aucune révision chargée."));
    renderProperties();
    renderCollections();
    return;
  }
  refs.sceneName.value = state.scene.name;
  const greeting = state.scene.nodes.find((node) => node.kind === "text" && node.props.role === "greeting");
  refs.greetingInput.value = greeting?.props.text ?? "";
  refs.stageTitle.textContent = state.scene.name;
  refs.stageMeta.textContent = `1920 × 1080 · ${state.currentRevisionId ? `révision ${state.currentRevisionId}` : "brouillon non enregistré"}`;
  $$("[data-fit]").forEach((button) => button.classList.toggle("on", button.dataset.fit === state.scene.canvas.background.mode));
  renderTargets();
  renderBackground();
  renderNodes();
  renderProperties();
  renderRevisions();
  renderCollections();
};

const renderTargets = () => {
  const option = make("option", "", "Simulateur local · affectation non modifiée");
  option.value = "";
  refs.targetSelect.replaceChildren(option);
  refs.targetSelect.disabled = true;
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

const renderBackground = () => {
  const background = state.scene.canvas.background;
  const url = assetUrl(background.asset);
  const position = `${background.focusX * 100}% ${background.focusY * 100}%`;
  $("#screenBg").style.backgroundColor = background.color || "#132323";
  $("#screenBg").style.backgroundImage = url ? `url("${String(url).replaceAll('"', "%22")}")` : "none";
  $("#screenBg").style.backgroundSize = background.mode === "contain" ? "contain" : "cover";
  $("#screenBg").style.backgroundPosition = position;
  $("#screenBg").style.backgroundRepeat = "no-repeat";
};

const applyNodeGeometry = (element, node) => {
  element.style.left = `${node.x / CANVAS_WIDTH * 100}%`;
  element.style.top = `${node.y / CANVAS_HEIGHT * 100}%`;
  element.style.width = `${node.width / CANVAS_WIDTH * 100}%`;
  element.style.height = `${node.height / CANVAS_HEIGHT * 100}%`;
  element.style.zIndex = String(node.zIndex);
};

const renderNodes = () => {
  const nodes = [];
  for (const node of [...state.scene.nodes].sort((a, b) => a.zIndex - b.zIndex)) {
    const roleClass = node.props?.role === "greeting" ? " role-greeting" : "";
    const element = make("div", `node kind-${node.kind}${roleClass}${node.id === state.selectedId ? " selected" : ""}`);
    element.dataset.nodeId = node.id;
    element.tabIndex = 0;
    element.setAttribute("role", "group");
    element.setAttribute("aria-label", `${nodeLabel(node)}, objet de scène`);
    applyNodeGeometry(element, node);

    if (["image", "video", "logo"].includes(node.kind)) {
      const url = assetUrl(
        node.props.asset ?? node.props.assetId,
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
    } else {
      element.append(make("span", "node-text", nodeDisplayText(node)));
    }

    if (node.id === state.selectedId) {
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
  const rows = state.scene.nodes
    .slice()
    .sort((a, b) => b.zIndex - a.zIndex)
    .map((node) => {
      const row = make("button", `object${node.id === state.selectedId ? " on" : ""}`);
      row.type = "button";
      row.dataset.selectNode = node.id;
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

const renderCollections = () => {
  const mediaRows = state.media.map((item) => ledgerRow(item.name ?? item.originalFilename ?? item.originalName ?? item.id, [item.kind ?? item.mimeType ?? item.mediaType, item.status].filter(Boolean).join(" · ")));
  $("#mediaList").replaceChildren(...(mediaRows.length ? mediaRows : [make("p", "empty-copy", "Aucun média.")]));

  const messageRows = state.messages.map((item) => ledgerRow(item.title ?? "Message", [item.startsAt, item.endsAt].filter(Boolean).map((date) => new Date(date).toLocaleString("fr-FR")).join(" → ")));
  $("#messageList").replaceChildren(...(messageRows.length ? messageRows : [make("p", "empty-copy", "Aucun message programmé.")]));

  const tvRows = state.televisions.map((tv) => {
    const card = make("article", "tv-cell");
    card.append(
      make("h3", "", tv.displayName ?? tv.display_name ?? tv.name ?? tv.id),
      make("p", "", [
        tv.online === true ? "En ligne" : tv.online === false ? "Hors ligne" : "État inconnu",
        `Source : ${tv.activeSource ?? tv.source_state?.activeSource ?? "inconnue"}`,
        `Version : ${tv.version ?? tv.home_version ?? "inconnue"}`,
      ].join("\n")),
    );
    return card;
  });
  $("#fleetList").replaceChildren(...(tvRows.length ? tvRows : [make("p", "empty-copy", "Aucune TV enrôlée.")]));
};

const renderSecurity = () => {
  const user = sessionUser(state.session);
  const ledger = $("#securityLedger");
  ledger.replaceChildren();
  const entries = [
    ["Session", user?.username ?? user?.email ?? "Authentifiée"],
    ["Rôle", user?.role ?? (Array.isArray(user?.roles) ? user.roles.join(", ") : "Non communiqué")],
    ["MFA", user?.mfaEnabled === true ? "Actif" : user?.mfaEnabled === false ? "Inactif" : "État non communiqué"],
  ];
  for (const [term, description] of entries) ledger.append(make("dt", "", term), make("dd", "", description));
};

const selectNode = (id, focus = false) => {
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
  if (!element || !state.scene) return;
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
  if (!state.scene || !state.selectedId) return;
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
  if (!state.scene) return;
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
  if (!state.scene) return;
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
      branding: { primary: "#151511", accent: "#e94318", logoAssetId: null },
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
    showGate("login");
  }
});

refs.retryButton.addEventListener("click", boot);
$("#reloadStudioButton").addEventListener("click", loadStudio);
$("#saveButton").addEventListener("click", saveRevision);
$("#publishButton").addEventListener("click", publishRevision);
$("#deleteNodeButton").addEventListener("click", deleteSelectedNode);

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
  if (!state.scene) return;
  state.scene.name = refs.sceneName.value.slice(0, 100);
  refs.stageTitle.textContent = state.scene.name || "Scène sans titre";
});
refs.greetingInput.addEventListener("input", () => {
  const greeting = state.scene?.nodes.find((node) => node.kind === "text" && node.props.role === "greeting");
  if (!greeting) return;
  setNodeDisplayText(greeting, refs.greetingInput.value.slice(0, 220));
  renderNodes();
});
refs.greetingInput.addEventListener("blur", () => {
  const greeting = state.scene?.nodes.find((node) => node.kind === "text" && node.props.role === "greeting");
  if (greeting) refs.greetingInput.value = greeting.props.text;
});
$("#backgroundModes").addEventListener("click", (event) => {
  const button = event.target.closest("[data-fit]");
  if (!button || !state.scene) return;
  state.scene.canvas.background.mode = button.dataset.fit;
  renderStudio();
});
$("#palette").addEventListener("click", (event) => {
  const button = event.target.closest("[data-add-kind]");
  if (!button) return;
  if (!state.scene) state.scene = normalizeScene({ ...cloneScene(DEFAULT_SCENE), nodes: [] });
  const node = createNode(button.dataset.addKind, button.dataset.source);
  node.zIndex = Math.min(10000, Math.max(0, ...state.scene.nodes.map((item) => item.zIndex)) + 1);
  state.scene.nodes.push(node);
  state.selectedId = node.id;
  renderStudio();
  selectNode(node.id, true);
});
refs.objectList.addEventListener("click", (event) => {
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
  if (!file || !state.scene) return;
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
    toast("Résultat de vérification reçu.");
  });
});

boot();
