import { emptyData, normalize, MIN_DATE } from "./lib.js";

const formatError = () => Object.assign(new Error("Unrecognized file"), { code: "errImport" });

// Spreadsheets in languages that write decimals with a comma separate columns with semicolons.
const delimiterOf = (text) => {
  const head = text.split(/\r?\n/, 1)[0];
  return head.split(";").length > head.split(",").length ? ";" : ",";
};

export function parseCsv(text) {
  const src = text.replace(/^﻿/, "");
  const delimiter = delimiterOf(src);
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some(Boolean));
}

// Dates before MIN_DATE are typos, and would start a habit decades back.
const isoDate = (value) => {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(value) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  const date = m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
  return date && date >= MIN_DATE ? date : null;
};

function amount(value) {
  const v = value.toLowerCase();
  if (["yes", "true", "x", "done", "✓"].includes(v)) return 1;
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

const column = (names, wanted) => names.findIndex((n) => wanted.includes(n));

// One row per entry: Habitify's check-in log (Habit, Date) and Streaks' export (title, entry_date, entry_type,
// quantity), where only completed entries count and skipped ones become skips.
function rowEntries(rows, at) {
  const entries = [];
  for (const r of rows) {
    const entry = { date: isoDate(r[at.date] ?? ""), name: r[at.habit] ?? "" };
    const type = at.type >= 0 ? (r[at.type] ?? "").toLowerCase() : "completed";
    const value = at.value >= 0 ? amount(r[at.value] ?? "") : 1;
    if (type.startsWith("completed")) entries.push({ ...entry, value: at.type >= 0 ? value || 1 : value });
    else if (type.startsWith("skip")) entries.push({ ...entry, value: 0, skipped: true });
  }
  return entries;
}

// Loop Habit Tracker's Checkmarks.csv marks each day 2 (done), 3 (skipped), or 0, 1 and -1 (not done).
const fromLoop = ({ value, ...entry }) => ({ ...entry, value: value === 2 ? 1 : 0, skipped: value === 3 });

// One column per habit.
function columnEntries(head, rows, dateAt) {
  const entries = [];
  for (const r of rows) {
    head.forEach((name, i) => {
      if (i !== dateAt && name) entries.push({ date: isoDate(r[dateAt] ?? ""), name, value: amount(r[i] ?? "") });
    });
  }
  return entries;
}

// Habits are matched to existing ones by name; the rest are created, once they have something logged.
// `loop` says the file is Loop's, whose values are codes: nothing in the values themselves tells them from counts.
export function fromCsv(text, data, { uid, today, loop = false }) {
  const [head, ...rows] = parseCsv(text);
  if (!head || !rows.length) throw formatError();
  const names = head.map((h) => h.toLowerCase());
  const at = {
    date: column(names, ["date", "day", "fecha", "entry_date"]),
    habit: column(names, ["habit", "name", "title", "hábito", "habito"]),
    value: column(names, ["value", "amount", "count", "quantity", "valor"]),
    type: names.indexOf("entry_type"),
  };
  if (at.date < 0) throw formatError();
  const columns = () => columnEntries(head, rows, at.date);
  const read = at.habit >= 0 ? rowEntries(rows, at) : loop ? columns().map(fromLoop) : columns();
  const entries = read.filter((e) => e.date && e.date <= today && e.name);
  if (!entries.length) throw formatError();

  const out = emptyData();
  const known = new Map(data.habits.map((h) => [String(h.name ?? "").trim().toLowerCase(), h]));
  const made = new Map();
  for (const { date, name, value, skipped } of entries) {
    if (!(value > 0) && !skipped) continue;
    const key = name.toLowerCase();
    let habit = known.get(key) ?? made.get(key);
    if (!habit) {
      habit = { id: uid(), name, type: "check", target: 1, unit: "", start: date, archived: false };
      made.set(key, habit);
    }
    if (made.has(key)) {
      if (date < habit.start) habit.start = date;
      if (value > 1) habit.type = "amount";
    }
    if (skipped) (out.skips[date] ??= {})[habit.id] = 1;
    else (out.log[date] ??= {})[habit.id] = value;
  }
  out.habits = [...made.values()];
  return out;
}

// A file saved by Download my data.
export function fromJson(text) {
  let parsed;
  try {
    // A "__proto__" key would reach objects that are later assigned to.
    parsed = JSON.parse(text, (key, value) => (key === "__proto__" ? undefined : value));
  } catch {
    throw formatError();
  }
  if (!parsed || !Array.isArray(parsed.habits) || typeof parsed.log !== "object") throw formatError();
  return normalize(parsed);
}

export function importFile(name, text, data, env) {
  if (name.toLowerCase().endsWith(".json") || text.trimStart().startsWith("{")) return fromJson(text);
  return fromCsv(text, data, { ...env, loop: /checkmarks/i.test(name) });
}
