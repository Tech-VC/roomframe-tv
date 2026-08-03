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
