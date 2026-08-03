export const CANVAS_WIDTH = 1920;
export const CANVAS_HEIGHT = 1080;
export const NODE_KINDS = new Set([
  "text", "clock", "weather", "message", "image", "video", "logo", "source", "app", "network",
]);
const ALLOWED_PROPS = {
  text: new Set(["role", "text", "fontScale", "maxLines", "color", "align"]),
  clock: new Set(["showDate", "showWeather", "timezone", "format"]),
  weather: new Set(["location", "locationKey", "latitude", "longitude", "timezone", "units", "label"]),
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

export const greetingText = (value) => String(value ?? "")
  .replace(/\r\n?/gu, "\n")
  .split("\n")
  .map((line) => line.replace(/[\t\f\v ]+/gu, " ").trim())
  .slice(0, 2)
  .join("\n");

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
      blur: 0,
    },
  },
  nodes: [
    { id: "greeting", kind: "text", x: 90, y: 170, width: 1000, height: 220, zIndex: 20, focusOrder: 0, props: { role: "greeting", text: "Bonjour,\nBienvenue en salle de réunion 1", fontScale: 1, maxLines: 2 } },
    { id: "clock-weather", kind: "clock", x: 1210, y: 50, width: 610, height: 110, zIndex: 20, focusOrder: 0, props: { showDate: true, showWeather: true, format: "24h" } },
    { id: "airplay", kind: "source", x: 90, y: 420, width: 410, height: 125, zIndex: 20, focusOrder: 1, props: { source: "airplay", label: "AirPlay" } },
    { id: "cast", kind: "source", x: 90, y: 560, width: 410, height: 125, zIndex: 20, focusOrder: 2, props: { source: "cast", label: "Cast" } },
    { id: "hdmi", kind: "source", x: 90, y: 700, width: 410, height: 125, zIndex: 20, focusOrder: 3, props: { source: "hdmi", label: "HDMI", physicalInput: "auto" } },
    { id: "messages", kind: "message", x: 1160, y: 285, width: 610, height: 400, zIndex: 20, focusOrder: 0, props: { title: "ACTUALITÉS", feed: "default", maximumItems: 3 } },
    { id: "network", kind: "network", x: 90, y: 970, width: 700, height: 45, zIndex: 20, focusOrder: 0, props: { label: "RÉSEAU", value: "À CONFIGURER DANS L’ADMINISTRATION" } },
    { id: "logo", kind: "logo", x: 1505, y: 850, width: 285, height: 145, zIndex: 30, focusOrder: 0, props: { asset: "assets/logo-placeholder.png", fit: "contain", anchor: "bottom-right", alt: "Logo" } },
  ],
});

export const cloneScene = (scene) => structuredClone(scene);

const migrateNode = (input, index) => {
  const legacyGreeting = input?.kind === "greeting";
  const legacyKind = legacyGreeting ? "text" : input?.kind === "messages" ? "message" : input?.kind;
  const kind = NODE_KINDS.has(legacyKind) ? legacyKind : "text";
  const inputProps = input?.props && typeof input.props === "object" ? { ...input.props } : {};
  if (inputProps.packageName && !inputProps.applicationId) inputProps.applicationId = inputProps.packageName;
  const props = Object.fromEntries(Object.entries(inputProps).filter(([key]) => ALLOWED_PROPS[kind].has(key)));
  if (input?.content != null && kind === "text" && props.text == null) props.text = String(input.content);
  if (input?.content != null && kind === "message" && props.title == null) props.title = String(input.content).split(/[|\n]/)[0];
  if (legacyGreeting) props.role = "greeting";
  if (kind === "text" && props.role === "greeting") {
    props.text = greetingText(props.text);
    props.maxLines = 2;
  }
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
        blur: numberInRange(background.blur, 0, 0, 40),
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
    if (node.kind === "weather") {
      const configured = Boolean(
        node.props.location
        || node.props.locationKey
        || node.props.latitude !== undefined
        || node.props.longitude !== undefined
        || node.props.timezone,
      );
      if (configured && !(
        node.props.location
        && /^[a-f0-9]{64}$/.test(node.props.locationKey ?? "")
        && Number.isFinite(node.props.latitude)
        && Number.isFinite(node.props.longitude)
        && node.props.timezone
        && ["metric", "imperial"].includes(node.props.units)
      )) {
        throw new Error(`Choisissez une suggestion valide pour l’objet « ${node.props.label || "Météo"} ».`);
      }
    }
  }
  return normalized;
};

export const createNode = (kind, source = null) => {
  const safeKind = NODE_KINDS.has(kind) ? kind : "text";
  const props = {};
  if (safeKind === "text") Object.assign(props, { text: "Nouveau texte", role: "body" });
  if (safeKind === "clock") Object.assign(props, { showDate: true, showWeather: false, format: "24h" });
  if (safeKind === "weather") Object.assign(props, { label: "Météo", location: "", units: "metric" });
  if (safeKind === "message") Object.assign(props, { title: "ACTUALITÉS", feed: "default", maximumItems: 3 });
  if (safeKind === "source") Object.assign(props, { source: source || "hdmi", label: (source || "source").toUpperCase() });
  if (safeKind === "app") Object.assign(props, { applicationId: "org.roomframe.privateapp", label: "Application privée" });
  if (safeKind === "network") Object.assign(props, { label: "RÉSEAU", value: "INFORMATION LOCALE" });
  if (safeKind === "logo") Object.assign(props, { asset: "assets/logo-placeholder.png", fit: "contain", anchor: "bottom-right", alt: "Logo" });
  if (safeKind === "image") Object.assign(props, { assetId: null, fit: "contain", focalX: .5, focalY: .5, alt: "" });
  if (safeKind === "video") Object.assign(props, { assetId: null, fit: "cover", focalX: .5, focalY: .5, muted: true, loop: true });
  const dimensions = safeKind === "weather"
    ? [500, 70]
    : ["message"].includes(safeKind)
      ? [560, 300]
      : ["image", "video", "logo"].includes(safeKind)
        ? [320, 180]
        : [410, 125];
  return {
    id: uuid(),
    kind: safeKind,
    x: safeKind === "weather" ? 1320 : 160,
    y: safeKind === "weather" ? 160 : 160,
    width: dimensions[0],
    height: dimensions[1],
    zIndex: 40,
    focusOrder: ["source", "app"].includes(safeKind) ? 1 : 0,
    props,
  };
};

export const weatherReadingForNode = (node, weatherDocument) => (
  weatherDocument?.items?.find((item) => item.key === node?.props?.locationKey) ?? null
);

export const weatherDisplayLocation = (value) => String(value ?? "")
  .trim()
  .replace(/\s+\d{4,6}$/u, "")
  .trim();

export const weatherIconForCode = (value) => {
  const code = Number(value);
  if (!Number.isInteger(code)) return "🌡️";
  if (code === 0) return "☀️";
  if ([1, 2].includes(code)) return "⛅️";
  if (code === 3) return "☁️";
  if ([45, 48].includes(code)) return "🌫️";
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "🌧️";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "❄️";
  if ([95, 96, 99].includes(code)) return "⛈️";
  return "🌡️";
};

const validDate = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const optionalTimestamp = (value) => (
  value === undefined || value === null || value === ""
    ? null
    : validDate(value)?.getTime() ?? null
);

export const formatClockText = (props = {}, value = new Date()) => {
  const date = validDate(value) ?? new Date();
  const options = {};
  if (props.timezone) options.timeZone = props.timezone;
  const twelveHour = props.format === "12h";
  let time;
  try {
    time = new Intl.DateTimeFormat("fr-FR", {
      ...options,
      hour: twelveHour ? "numeric" : "2-digit",
      minute: "2-digit",
      hour12: twelveHour,
      hourCycle: twelveHour ? undefined : "h23",
    }).format(date);
  } catch {
    return formatClockText({ ...props, timezone: null }, date);
  }
  if (!twelveHour) time = time.replace(":", "h");
  if (!props.showDate) return time;
  const parts = new Intl.DateTimeFormat("fr-FR", {
    ...options,
    day: "numeric",
    month: "long",
  }).formatToParts(date);
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  const rawMonth = parts.find((part) => part.type === "month")?.value ?? "";
  const month = rawMonth ? `${rawMonth[0].toLocaleUpperCase("fr-FR")}${rawMonth.slice(1)}` : "";
  return `${[day, month].filter(Boolean).join(" ")} - ${time}`;
};

export const activeMessagesForNode = (node, source, now = Date.now()) => {
  const items = Array.isArray(source) ? source : Array.isArray(source?.items) ? source.items : [];
  const current = validDate(now)?.getTime() ?? Date.now();
  const maximumItems = Math.max(1, Math.min(20, Number(node?.props?.maximumItems) || 3));
  return items.filter((item) => {
    if (item?.active === false) return false;
    const startsAt = optionalTimestamp(item?.startsAt ?? item?.starts_at);
    const endsAt = optionalTimestamp(item?.endsAt ?? item?.ends_at);
    return !(startsAt != null && startsAt > current) && !(endsAt != null && endsAt <= current);
  }).slice(0, maximumItems);
};

export const nodeDisplayText = (node, weatherDocument = null) => {
  if (!node) return "";
  if (node.kind === "text") return node.props.text ?? "";
  if (node.kind === "message") return node.props.title ?? "MESSAGES";
  if (node.kind === "network") return [node.props.label, node.props.value].filter(Boolean).join(" · ");
  if (node.kind === "clock") return formatClockText(node.props);
  if (node.kind === "weather") {
    const location = node.props.location?.trim();
    const displayLocation = weatherDisplayLocation(location) || "Météo";
    if (!node.props.locationKey) {
      return location ? `${displayLocation}\nChoisissez une suggestion` : "Météo à configurer";
    }
    const reading = weatherReadingForNode(node, weatherDocument);
    const resolvedLocation = weatherDisplayLocation(location || reading?.location) || "Météo";
    if (!reading || reading.temperature == null) return `${resolvedLocation}\nDonnées en attente`;
    const rounded = Math.round(Number(reading.temperature));
    return `${resolvedLocation}\n${weatherIconForCode(reading.weatherCode)} ${rounded} ${reading.temperatureUnit} · ${reading.condition}`;
  }
  if (node.kind === "image" || node.kind === "video" || node.kind === "logo") return node.props.alt ?? node.kind;
  return node.props.label ?? node.kind;
};

export const setNodeDisplayText = (node, value) => {
  if (node.kind === "text") {
    node.props.text = node.props.role === "greeting" ? greetingText(value) : value;
    if (node.props.role === "greeting") node.props.maxLines = 2;
  }
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
