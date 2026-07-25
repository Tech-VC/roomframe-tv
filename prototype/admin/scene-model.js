export const CANVAS_WIDTH = 1920;
export const CANVAS_HEIGHT = 1080;
export const NODE_KINDS = new Set([
  "text", "clock", "weather", "message", "image", "video", "logo", "source", "app", "network",
]);
const ALLOWED_PROPS = {
  text: new Set(["role", "text", "fontScale", "maxLines", "color", "align"]),
  clock: new Set(["showDate", "showWeather", "timezone", "format"]),
  weather: new Set(["location", "units", "label"]),
  message: new Set(["title", "feed", "maximumItems"]),
  image: new Set(["assetId", "fit", "focalX", "focalY", "alt"]),
  video: new Set(["assetId", "fit", "focalX", "focalY", "muted", "loop"]),
  logo: new Set(["assetId", "asset", "fit", "anchor", "alt"]),
  source: new Set(["source", "label", "physicalInput"]),
  app: new Set(["applicationId", "label", "iconAssetId"]),
  network: new Set(["label", "value"]),
};

const numberInRange = (value, fallback, min, max) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

const uuid = () => globalThis.crypto?.randomUUID?.() ?? `node-${Date.now()}-${Math.random().toString(16).slice(2)}`;

export const DEFAULT_SCENE = Object.freeze({
  schemaVersion: 2,
  layoutId: "00000000-0000-4000-8000-000000000100",
  name: "Accueil par défaut",
  canvas: {
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    renderTarget: "1080p",
    background: {
      type: "image",
      asset: "assets/background-default.webp",
      color: "#132323",
      mode: "cover",
      focusX: 0.5,
      focusY: 0.5,
    },
  },
  nodes: [
    { id: "greeting", kind: "text", x: 90, y: 170, width: 1000, height: 220, zIndex: 20, focusOrder: 0, props: { role: "greeting", text: "Bonjour, bienvenue dans cette salle", fontScale: 1, maxLines: 3 } },
    { id: "clock-weather", kind: "clock", x: 1320, y: 58, width: 500, height: 90, zIndex: 20, focusOrder: 0, props: { showDate: false, showWeather: true, format: "24h" } },
    { id: "airplay", kind: "source", x: 90, y: 485, width: 410, height: 125, zIndex: 20, focusOrder: 1, props: { source: "airplay", label: "AirPlay" } },
    { id: "cast", kind: "source", x: 90, y: 625, width: 410, height: 125, zIndex: 20, focusOrder: 2, props: { source: "cast", label: "Cast" } },
    { id: "hdmi", kind: "source", x: 90, y: 765, width: 410, height: 125, zIndex: 20, focusOrder: 3, props: { source: "hdmi", label: "HDMI", physicalInput: "auto" } },
    { id: "messages", kind: "message", x: 1160, y: 195, width: 610, height: 430, zIndex: 20, focusOrder: 0, props: { title: "ACTUALITÉS", feed: "default", maximumItems: 3 } },
    { id: "network", kind: "network", x: 90, y: 970, width: 700, height: 45, zIndex: 20, focusOrder: 0, props: { label: "RÉSEAU", value: "À CONFIGURER DANS L’ADMINISTRATION" } },
    { id: "logo", kind: "logo", x: 1505, y: 850, width: 285, height: 145, zIndex: 30, focusOrder: 0, props: { asset: "assets/logo-placeholder.png", fit: "contain", anchor: "bottom-right", alt: "Logo" } },
  ],
});

export const cloneScene = (scene) => structuredClone(scene);

const migrateNode = (input, index) => {
  const legacyKind = input?.kind === "greeting" ? "text" : input?.kind === "messages" ? "message" : input?.kind;
  const kind = NODE_KINDS.has(legacyKind) ? legacyKind : "text";
  const inputProps = input?.props && typeof input.props === "object" ? { ...input.props } : {};
  if (inputProps.packageName && !inputProps.applicationId) inputProps.applicationId = inputProps.packageName;
  const props = Object.fromEntries(Object.entries(inputProps).filter(([key]) => ALLOWED_PROPS[kind].has(key)));
  if (input?.content != null && kind === "text" && props.text == null) props.text = String(input.content);
  if (input?.content != null && kind === "message" && props.title == null) props.title = String(input.content).split(/[|\n]/)[0];
  if (ALLOWED_PROPS[kind].has("label") && props.label == null) props.label = input?.label ?? kind;
  const x = numberInRange(input?.x, 100 + index * 20, 0, CANVAS_WIDTH - 20);
  const y = numberInRange(input?.y, 100 + index * 20, 0, CANVAS_HEIGHT - 20);
  const width = numberInRange(input?.width ?? input?.w, 360, 20, CANVAS_WIDTH - x);
  const height = numberInRange(input?.height ?? input?.h, 120, 20, CANVAS_HEIGHT - y);
  return {
    id: String(input?.id || uuid()),
    kind,
    x,
    y,
    width,
    height,
    zIndex: Math.round(numberInRange(input?.zIndex, 20 + index, 0, 10000)),
    focusOrder: Math.round(numberInRange(input?.focusOrder ?? inputProps.focusOrder, 0, 0, 10000)),
    props,
  };
};

export const normalizeScene = (input) => {
  const source = input && typeof input === "object" ? input : DEFAULT_SCENE;
  const background = source.canvas?.background ?? DEFAULT_SCENE.canvas.background;
  const mode = ["cover", "contain", "focus"].includes(background.mode) ? background.mode : "cover";
  const type = ["color", "image", "video"].includes(background.type) ? background.type : "color";
  const nodes = Array.isArray(source.nodes) ? source.nodes.map(migrateNode) : [];
  return {
    schemaVersion: 2,
    layoutId: String(source.layoutId || uuid()),
    name: String(source.name || "Scène sans titre").slice(0, 100),
    canvas: {
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      renderTarget: source.canvas?.renderTarget === "native" ? "native" : "1080p",
      background: {
        type,
        asset: background.asset == null ? null : String(background.asset),
        color: background.color == null ? "#132323" : String(background.color),
        mode,
        focusX: numberInRange(background.focusX, 0.5, 0, 1),
        focusY: numberInRange(background.focusY, 0.5, 0, 1),
      },
    },
    nodes,
  };
};

export const validateScene = (scene) => {
  const normalized = normalizeScene(scene);
  const ids = new Set();
  for (const node of normalized.nodes) {
    if (ids.has(node.id)) throw new Error(`Identifiant d’objet dupliqué : ${node.id}`);
    ids.add(node.id);
    if (node.x + node.width > CANVAS_WIDTH || node.y + node.height > CANVAS_HEIGHT) {
      throw new Error(`L’objet « ${node.props.label || node.id} » dépasse de la scène.`);
    }
  }
  return normalized;
};

export const createNode = (kind, source = null) => {
  const safeKind = NODE_KINDS.has(kind) ? kind : "text";
  const props = {};
  if (safeKind === "text") Object.assign(props, { text: "Nouveau texte", role: "body" });
  if (safeKind === "clock") Object.assign(props, { showDate: false, showWeather: false, format: "24h" });
  if (safeKind === "weather") Object.assign(props, { label: "Météo", location: "", units: "metric" });
  if (safeKind === "message") Object.assign(props, { title: "ACTUALITÉS", feed: "default", maximumItems: 3 });
  if (safeKind === "source") Object.assign(props, { source: source || "hdmi", label: (source || "source").toUpperCase() });
  if (safeKind === "app") Object.assign(props, { applicationId: "org.roomframe.privateapp", label: "Application privée" });
  if (safeKind === "network") Object.assign(props, { label: "RÉSEAU", value: "INFORMATION LOCALE" });
  if (safeKind === "logo") Object.assign(props, { asset: "assets/logo-placeholder.png", fit: "contain", anchor: "bottom-right", alt: "Logo" });
  if (safeKind === "image") Object.assign(props, { assetId: null, fit: "contain", focalX: .5, focalY: .5, alt: "" });
  if (safeKind === "video") Object.assign(props, { assetId: null, fit: "cover", focalX: .5, focalY: .5, muted: true, loop: true });
  const dimensions = ["message"].includes(safeKind) ? [560, 300] : ["image", "video", "logo"].includes(safeKind) ? [320, 180] : [410, 125];
  return {
    id: uuid(),
    kind: safeKind,
    x: 160,
    y: 160,
    width: dimensions[0],
    height: dimensions[1],
    zIndex: 40,
    focusOrder: ["source", "app"].includes(safeKind) ? 1 : 0,
    props,
  };
};

export const nodeDisplayText = (node) => {
  if (!node) return "";
  if (node.kind === "text") return node.props.text ?? "";
  if (node.kind === "message") return node.props.title ?? "MESSAGES";
  if (node.kind === "network") return [node.props.label, node.props.value].filter(Boolean).join(" · ");
  if (node.kind === "clock") return new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", hour12: node.props.format === "12h" }).format(new Date());
  if (node.kind === "weather") return node.props.label ?? "Météo";
  if (node.kind === "image" || node.kind === "video" || node.kind === "logo") return node.props.alt ?? node.kind;
  return node.props.label ?? node.kind;
};

export const setNodeDisplayText = (node, value) => {
  if (node.kind === "text") node.props.text = value;
  else if (node.kind === "message") node.props.title = String(value).split("\n")[0];
  else if (node.kind === "network") node.props.value = value;
  else if (node.kind === "weather" || ALLOWED_PROPS[node.kind].has("label")) node.props.label = value;
  else if (["image", "video", "logo"].includes(node.kind)) node.props.alt = value;
};

export const nodeLabel = (node) => {
  const labels = {
    text: node.props.role === "greeting" ? "Salutation" : "Texte",
    clock: "Heure",
    weather: node.props.label || "Météo",
    message: node.props.title || "Messages",
    image: "Image",
    video: "Vidéo",
    logo: "Logo",
    source: node.props.label || "Source",
    app: node.props.label || "Application",
    network: node.props.label || "Réseau",
  };
  return labels[node.kind] || node.kind;
};

export const nodeSupportsLabel = (node) => ALLOWED_PROPS[node.kind]?.has("label") ?? false;
