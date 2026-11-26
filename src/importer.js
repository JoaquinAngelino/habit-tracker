import { emptyData, normalize } from "./lib.js";

const formatError = () => Object.assign(new Error("Unrecognized file"), { code: "errImport" });

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
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

const isoDate = (value) => {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(value) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
};

function amount(value) {
  const v = value.toLowerCase();
  if (["yes", "true", "x", "done", "✓"].includes(v)) return 1;
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

// Loop Habit Tracker's Checkmarks.csv marks each day 2 (done), 3 (skipped), or 0, 1 and -1 (not done).
const LOOP = new Set([-1, 0, 1, 2, 3]);

// Reads a table with a date column and one column per habit, or one row per entry (date, habit, value).
// The second covers Habitify's check-in log (Habit, Date) and Streaks' export (title, entry_date, entry_type,
// quantity), where only completed entries count and skipped ones become skips.
// Habits are matched to existing ones by name; the rest are created. Returns data to merge.
export function fromCsv(text, data, { uid, today }) {
  const [head, ...rows] = parseCsv(text);
  if (!head || rows.length < 1) throw formatError();
  const names = head.map((h) => h.toLowerCase());
  const dateAt = names.findIndex((n) => ["date", "day", "fecha", "entry_date"].includes(n));
  if (dateAt < 0) throw formatError();
  const habitAt = names.findIndex((n) => ["habit", "name", "title", "hábito", "habito"].includes(n));
  const valueAt = names.findIndex((n) => ["value", "amount", "count", "quantity", "valor"].includes(n));
  const typeAt = names.indexOf("entry_type");

  const entries = [];
  if (habitAt >= 0) {
    for (const r of rows) {
      const type = typeAt >= 0 ? (r[typeAt] ?? "").toLowerCase() : "completed";
      const value = valueAt >= 0 ? amount(r[valueAt] ?? "") : 1;
      if (type.startsWith("completed")) entries.push([isoDate(r[dateAt] ?? ""), r[habitAt] ?? "", typeAt >= 0 ? value || 1 : value]);
      else if (type.startsWith("skip")) entries.push([isoDate(r[dateAt] ?? ""), r[habitAt] ?? "", 0, true]);
    }
  } else {
    for (const r of rows) head.forEach((name, i) => i !== dateAt && name && entries.push([isoDate(r[dateAt] ?? ""), name, amount(r[i] ?? "")]));
  }
  const valid = entries.filter(([date, name]) => date && date <= today && name);
  if (!valid.length) throw formatError();
  const loop = habitAt < 0 && valid.every(([, , v]) => LOOP.has(v)) && valid.some(([, , v]) => v >= 2);

  const out = emptyData();
  const known = new Map(data.habits.map((h) => [h.name.trim().toLowerCase(), h]));
  const made = new Map();
  for (const [date, name, raw, skipped] of valid) {
    const key = name.toLowerCase();
    let habit = known.get(key) ?? made.get(key);
    if (!habit) {
      habit = { id: uid(), name, type: "check", target: 1, unit: "", start: date, archived: false };
      made.set(key, habit);
    }
    if (made.has(key)) {
      if (date < habit.start) habit.start = date;
      if (!loop && raw > 1) habit.type = "amount";
    }
    if (skipped || (loop && raw === 3)) (out.skips[date] ??= {})[habit.id] = 1;
    const value = loop ? (raw === 2 ? 1 : 0) : raw;
    if (value > 0) (out.log[date] ??= {})[habit.id] = value;
  }
  out.habits = [...made.values()];
  return out;
}

// A file saved by Download my data.
export function fromJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw formatError();
  }
  if (!parsed || !Array.isArray(parsed.habits) || typeof parsed.log !== "object") throw formatError();
  return normalize(parsed);
}

export const importFile = (name, text, data, env) => (name.toLowerCase().endsWith(".json") || text.trimStart().startsWith("{") ? fromJson(text) : fromCsv(text, data, env));
