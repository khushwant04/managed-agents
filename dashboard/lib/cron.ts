/** Validation and plain-English descriptions for 5-field cron schedules. */

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
] as const;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const ALIASES: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

function toNumber(token: string, field: number): number | null {
  const t = token.toLowerCase();
  if (field === 3 && MONTHS.includes(t)) return MONTHS.indexOf(t) + 1;
  if (field === 4 && DAYS.includes(t)) return DAYS.indexOf(t);
  return /^\d+$/.test(t) ? Number(t) : null;
}

function checkPart(part: string, field: number): string | null {
  const { name, min, max } = FIELDS[field]!;
  const [range, step, extra] = part.split("/");
  if (extra !== undefined) return `too many "/" in the ${name} field`;
  if (step !== undefined && (!/^\d+$/.test(step) || Number(step) === 0)) return `the ${name} step must be a positive number`;
  if (range === "*") return null;
  const bounds = range!.split("-");
  if (bounds.length > 2) return `invalid range in the ${name} field`;
  for (const b of bounds) {
    const n = toNumber(b, field);
    if (n === null) return `"${b}" is not a valid ${name}`;
    if (n < min || n > max) return `${name} must be between ${min} and ${max}`;
  }
  return null;
}

/** Expand `@daily`-style shortcuts to five fields. */
export function normalizeCron(expr: string): string {
  const t = expr.trim().replace(/\s+/g, " ");
  return ALIASES[t.toLowerCase()] ?? t;
}

/** A message explaining what is wrong with `expr`, or null when it is a valid 5-field schedule. */
export function cronError(expr: string): string | null {
  const t = normalizeCron(expr);
  if (!t) return "enter a schedule";
  const parts = t.split(" ");
  if (parts.length !== 5) return `expected 5 fields (minute hour day month weekday), got ${parts.length}`;
  for (let i = 0; i < 5; i++) {
    for (const item of parts[i]!.split(",")) {
      if (!item) return `empty value in the ${FIELDS[i]!.name} field`;
      const err = checkPart(item, i);
      if (err) return err;
    }
  }
  return null;
}

const pad = (n: number) => String(n).padStart(2, "0");
const isNum = (s: string) => /^\d+$/.test(s);

function dayName(token: string): string {
  const n = toNumber(token, 4);
  return n === null ? token : DAY_NAMES[n]!;
}

function listDays(field: string): string {
  if (field === "1-5" || field.toLowerCase() === "mon-fri") return "weekdays";
  if (field === "0,6" || field === "6,0" || field.toLowerCase() === "sat,sun") return "weekends";
  return field
    .split(",")
    .map((p) => (p.includes("-") ? p.split("-").map(dayName).join(" through ") : dayName(p)))
    .join(", ");
}

function listMonths(field: string): string {
  return field
    .split(",")
    .map((p) =>
      p
        .split("-")
        .map((m) => {
          const n = toNumber(m, 3);
          return n === null ? m : MONTH_NAMES[n - 1]!;
        })
        .join(" through ")
    )
    .join(", ");
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${s}`;
}

function timeOfDay(minute: string, hour: string): string | null {
  if (!isNum(minute)) return null;
  const hours = hour.split(",");
  if (!hours.every(isNum)) return null;
  return hours.map((h) => `${pad(Number(h))}:${pad(Number(minute))}`).join(", ");
}

/**
 * A short English description, e.g. "Every 30 minutes", "Every day at 09:00",
 * "At 09:00 on weekdays". Falls back to a field-by-field reading for unusual
 * schedules. Returns null for invalid input.
 */
export function describeCron(expr: string): string | null {
  if (cronError(expr)) return null;
  const [minute, hour, dom, month, dow] = normalizeCron(expr).split(" ") as [string, string, string, string, string];
  const anyDay = dom === "*" && month === "*" && dow === "*";

  let when: string;
  const at = timeOfDay(minute, hour);
  if (minute === "*" && hour === "*") when = "Every minute";
  else if (/^\*\/\d+$/.test(minute) && hour === "*") {
    const n = Number(minute.slice(2));
    when = n === 1 ? "Every minute" : `Every ${n} minutes`;
  } else if (isNum(minute) && hour === "*") when = Number(minute) === 0 ? "Every hour" : `Every hour at :${pad(Number(minute))}`;
  else if (isNum(minute) && /^\*\/\d+$/.test(hour)) {
    const n = Number(hour.slice(2));
    when = `Every ${n === 1 ? "hour" : `${n} hours`}${Number(minute) ? ` at :${pad(Number(minute))}` : ""}`;
  } else if (at) when = anyDay ? `Every day at ${at}` : `At ${at}`;
  else {
    const m = minute === "*" ? "every minute" : minute.startsWith("*/") ? `every ${minute.slice(2)} minutes` : `minute ${minute}`;
    const h = hour === "*" ? "" : hour.startsWith("*/") ? ` of every ${hour.slice(2)} hours` : ` past hour ${hour}`;
    when = `At ${m}${h}`.replace(/^At every/, "Every");
  }

  const parts: string[] = [];
  if (dom !== "*") parts.push(dom.split(",").every(isNum) ? `on the ${dom.split(",").map((d) => ordinal(Number(d))).join(", ")}` : `on day ${dom}`);
  if (dow !== "*") parts.push(`${dom !== "*" ? "or" : "on"} ${listDays(dow)}`);
  if (month !== "*") parts.push(`in ${listMonths(month)}`);
  return [when, ...parts].join(" ");
}

/** Handy starting points for the schedule field. */
export const CRON_PRESETS: { label: string; schedule: string }[] = [
  { label: "Every 15 min", schedule: "*/15 * * * *" },
  { label: "Hourly", schedule: "0 * * * *" },
  { label: "Daily 09:00", schedule: "0 9 * * *" },
  { label: "Weekdays 09:00", schedule: "0 9 * * 1-5" },
  { label: "Mondays 08:00", schedule: "0 8 * * 1" },
];
