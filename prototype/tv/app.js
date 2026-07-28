import { activateStagingRevision, getActiveRevision, openCache, putStagingRevision, seedBundledRevision } from "./cache-store.js?v=0.3.0-ui7";
import { bytesToHex, createAssetResolver, normalizeSyncPayload, stableStringify } from "./sync-format.js?v=0.3.0-ui7";

const CANVAS_WIDTH = 1920;
const CANVAS_HEIGHT = 1080;
const $ = (selector) => document.querySelector(selector);
const make = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = String(text);
  return element;
};

const bundledRevision = {
  id: "bundled-default-1.0.0",
  revisionNumber: 0,
  manifestHash: "bundled",
  receivedAt: "2026-07-24T00:00:00Z",
  assets: [],
  scene: {
    schemaVersion: 2,
    layoutId: "00000000-0000-4000-8000-000000000100",
    name: "Accueil embarqué",
    canvas: {
      width: 1920,
      height: 1080,
      renderTarget: "1080p",
      background: { type: "image", asset: "assets/background-default.webp", color: "#132323", mode: "cover", focusX: .5, focusY: .5, blur: 0 },
    },
    nodes: [
      { id: "greeting", kind: "text", x: 90, y: 170, width: 1000, height: 220, zIndex: 20, focusOrder: 0, props: { text: "Bonjour, bienvenue en salle de réunion 1", role: "greeting", fontScale: 1, maxLines: 1 } },
      { id: "clock", kind: "clock", x: 1320, y: 58, width: 500, height: 90, zIndex: 20, focusOrder: 0, props: { showDate: false, showWeather: true, format: "24h" } },
      { id: "airplay", kind: "source", x: 90, y: 485, width: 410, height: 125, zIndex: 20, focusOrder: 1, props: { source: "airplay", label: "AirPlay" } },
      { id: "cast", kind: "source", x: 90, y: 625, width: 410, height: 125, zIndex: 20, focusOrder: 2, props: { source: "cast", label: "Cast" } },
      { id: "hdmi", kind: "source", x: 90, y: 765, width: 410, height: 125, zIndex: 20, focusOrder: 3, props: { source: "hdmi", label: "HDMI" } },
      { id: "messages", kind: "message", x: 1160, y: 195, width: 610, height: 430, zIndex: 20, focusOrder: 0, props: { title: "ACTUALITÉS", feed: "default", maximumItems: 3 } },
      { id: "network", kind: "network", x: 90, y: 970, width: 700, height: 45, zIndex: 20, focusOrder: 0, props: { label: "RÉSEAU", value: "MODE LOCAL-FIRST" } },
      { id: "logo", kind: "logo", x: 1505, y: 850, width: 285, height: 145, zIndex: 30, focusOrder: 0, props: { asset: "assets/logo-placeholder.png", fit: "contain", anchor: "bottom-right", alt: "Logo" } },
    ],
  },
};

let database;
let currentRevision;
let objectUrls = [];

const setStatus = (kind, text, hash = "") => {
  $("#statusDot").className = `status-dot ${kind === "pending" ? "pending" : kind === "error" ? "error" : ""}`;
  $("#statusText").textContent = text;
  $("#hashLabel").textContent = hash;
};

const sha256 = async (value) => {
  const bytes = value instanceof ArrayBuffer ? value : new TextEncoder().encode(value);
  return bytesToHex(await crypto.subtle.digest("SHA-256", bytes));
};

const revokeObjectUrls = () => {
  objectUrls.forEach((url) => URL.revokeObjectURL(url));
  objectUrls = [];
};

const assetResolver = (revision) => {
  const indexed = createAssetResolver(revision.assets);
  objectUrls.push(...indexed.createdObjectUrls);
  return indexed.resolve;
};

const nodeText = (node) => {
  if (node.kind === "text") return node.props?.text ?? "";
  if (node.kind === "message") return node.props?.title ?? "MESSAGES";
  if (node.kind === "network") return [node.props?.label, node.props?.value].filter(Boolean).join(" · ");
  if (node.kind === "clock") return new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", hour12: node.props?.format === "12h" }).format(new Date());
  if (node.kind === "weather") return node.props?.label ?? "Météo";
  return node.props?.label ?? node.kind;
};

const sourceGlyph = (source) => {
  const normalized = ["airplay", "cast", "hdmi"].includes(source) ? source : "app";
  const glyph = make("span", `source-glyph ${normalized}`);
  glyph.setAttribute("aria-hidden", "true");
  return glyph;
};

const renderRevision = (revision) => {
  revokeObjectUrls();
  currentRevision = revision;
  const scene = revision?.scene;
  $("#emptyState").classList.toggle("hidden", Boolean(scene));
  if (!scene) return;
  const resolveAsset = assetResolver(revision);
  const background = scene.canvas?.background ?? {};
  const backgroundUrl = resolveAsset(background.assetId ?? background.asset);
  const backgroundElement = $("#background");
  const branding = revision.documents?.branding ?? {};
  if (/^#[0-9a-f]{6}$/i.test(branding.accent ?? "")) {
    document.documentElement.style.setProperty("--signal", branding.accent);
  }
  backgroundElement.style.backgroundColor = background.color ?? "#132323";
  backgroundElement.style.backgroundImage = backgroundUrl ? `url("${String(backgroundUrl).replaceAll('"', "%22")}")` : "none";
  backgroundElement.style.backgroundSize = background.mode === "contain" ? "contain" : "cover";
  backgroundElement.style.backgroundPosition = `${(background.focusX ?? .5) * 100}% ${(background.focusY ?? .5) * 100}%`;
  const blur = Math.max(0, Math.min(40, Number(background.blur ?? 0)));
  backgroundElement.style.filter = `blur(${blur / 19.2}cqw)`;
  backgroundElement.style.transform = `scale(${1 + blur / 240})`;

  const nodes = [...(scene.nodes ?? [])].sort((a, b) => a.zIndex - b.zIndex).map((node) => {
    const interactive = ["source", "app"].includes(node.kind);
    const roleClass = node.props?.role === "greeting" ? " role-greeting" : "";
    const element = make(interactive ? "button" : "div", `node kind-${node.kind}${roleClass}`);
    if (interactive) {
      element.type = "button";
      element.dataset.adapter = node.props?.source ?? node.props?.applicationId ?? "unsupported";
      element.addEventListener("click", () => setStatus("error", `${node.props?.label ?? node.kind} : adaptateur matériel non disponible dans le simulateur.`));
    }
    element.style.left = `${node.x / CANVAS_WIDTH * 100}%`;
    element.style.top = `${node.y / CANVAS_HEIGHT * 100}%`;
    element.style.width = `${node.width / CANVAS_WIDTH * 100}%`;
    element.style.height = `${node.height / CANVAS_HEIGHT * 100}%`;
    element.style.zIndex = String(node.zIndex);
    if (interactive && Number(node.focusOrder) > 0) element.tabIndex = Number(node.focusOrder);

    if (["logo", "image"].includes(node.kind)) {
      const nodeAsset = node.kind === "logo"
        && branding.logoAssetId
        && !node.props?.assetId
        && (!node.props?.asset || node.props?.asset === "assets/logo-placeholder.png")
        ? branding.logoAssetId
        : node.props?.assetId ?? node.props?.asset;
      const url = resolveAsset(
        nodeAsset,
        node.kind === "logo" ? "logo" : null,
      );
      if (url) {
        const image = make("img");
        image.src = url;
        image.alt = node.props?.alt ?? "";
        image.style.objectFit = node.props?.fit === "cover" ? "cover" : "contain";
        element.append(image);
      }
    } else if (node.kind === "video") {
      const url = resolveAsset(node.props?.assetId ?? node.props?.asset);
      if (url) {
        const video = make("video");
        video.src = url;
        video.autoplay = true;
        video.muted = true;
        video.loop = true;
        video.playsInline = true;
        element.append(video);
      }
    } else if (node.kind === "message") {
      element.append(make("strong", "", node.props?.title ?? "MESSAGES"));
    } else if (node.kind === "source") {
      element.append(
        sourceGlyph(node.props?.source),
        make("span", "node-text", nodeText(node)),
        make("span", "source-action", "↗"),
      );
    } else {
      element.append(make("span", "node-text", nodeText(node)));
    }
    return element;
  });
  $("#nodeLayer").replaceChildren(...nodes);
  $("#revisionLabel").textContent = `${scene.name ?? "Scène"} · ${revision.id}`;
  setStatus("ok", revision.id.startsWith("bundled-") ? "Expérience embarquée affichée, synchronisation en arrière-plan possible." : "Dernière révision validée affichée.", revision.manifestHash ?? "");
};

const loadActive = async () => {
  setStatus("pending", "Lecture de la dernière révision valide…");
  const active = await getActiveRevision(database);
  renderRevision(active);
  return active;
};

const downloadAndVerify = async (asset) => {
  const response = await fetch(asset.url, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error(`Téléchargement impossible pour ${asset.key} (${response.status}).`);
  const bytes = await response.arrayBuffer();
  if (asset.size && bytes.byteLength !== asset.size) throw new Error(`Taille incorrecte pour ${asset.key}.`);
  const digest = await sha256(bytes);
  if (digest !== asset.sha256) throw new Error(`SHA-256 incorrect pour ${asset.key}.`);
  return { ...asset, blob: new Blob([bytes], { type: asset.mimeType }), verifiedSha256: digest };
};

const synchronize = async () => {
  if ($("#offlineToggle").checked) {
    setStatus("error", "API volontairement coupée. La révision en cache reste active.", currentRevision?.manifestHash ?? "");
    return;
  }
  $("#syncButton").disabled = true;
  setStatus("pending", "Recherche d’une nouvelle révision…");
  try {
    const current = Number(currentRevision?.revisionNumber ?? 0);
    const response = await fetch(`/api/v1/tv/sync?deviceId=simulator&revision=${encodeURIComponent(current)}`, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (response.status === 204 || response.status === 304) {
      setStatus("ok", "Cache à jour.", currentRevision?.manifestHash ?? "");
      return;
    }
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const error = await response.json();
        message = error.message ?? error.error ?? message;
      } catch {}
      throw new Error(message);
    }
    const revision = normalizeSyncPayload(await response.json());
    if (revision.upToDate || revision.revisionNumber === currentRevision?.revisionNumber) {
      setStatus("ok", "Cache à jour.", currentRevision.manifestHash ?? "");
      return;
    }
    if (revision.manifestHash) {
      const manifestDigest = await sha256(stableStringify(revision.manifestBase));
      if (manifestDigest !== revision.manifestHash) throw new Error("SHA-256 du manifeste invalide.");
    }
    for (const entry of revision.documentEntries) {
      const key = String(entry.path ?? "").replace(/\.json$/, "");
      const documentValue = revision.documents[key];
      if (documentValue === undefined) throw new Error(`Document ${entry.path} absent.`);
      const digest = await sha256(stableStringify(documentValue));
      if (digest !== entry.sha256) throw new Error(`SHA-256 incorrect pour ${entry.path}.`);
    }
    const assets = [];
    for (const asset of revision.assets) {
      setStatus("pending", `Vérification de ${asset.key}…`);
      assets.push(await downloadAndVerify(asset));
    }
    const staged = { ...revision, assets };
    await putStagingRevision(database, staged);
    await activateStagingRevision(database, revision.id);
    await loadActive();
    setStatus("ok", "Nouvelle révision vérifiée puis activée atomiquement.", revision.manifestHash ?? "");
  } catch (error) {
    setStatus("error", `Synchronisation échouée : ${error.message}. Cache précédent conservé.`, currentRevision?.manifestHash ?? "");
  } finally {
    $("#syncButton").disabled = false;
  }
};

const start = async () => {
  try {
    database = await openCache();
    await seedBundledRevision(database, bundledRevision);
    await loadActive();
    synchronize();
  } catch (error) {
    $("#emptyState").classList.remove("hidden");
    setStatus("error", `Cache local indisponible : ${error.message}`);
  }
};

$("#syncButton").addEventListener("click", synchronize);
$("#reloadButton").addEventListener("click", loadActive);
$("#offlineToggle").addEventListener("change", () => {
  if ($("#offlineToggle").checked) setStatus("error", "API coupée. Rechargez : la scène active vient uniquement d’IndexedDB.", currentRevision?.manifestHash ?? "");
  else synchronize();
});
window.addEventListener("beforeunload", revokeObjectUrls);

start();
