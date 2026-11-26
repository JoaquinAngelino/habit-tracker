export const TYPES = ["check", "weekly", "monthly", "amount", "timer", "avoid"];
export const KINDS = ["do", "buy", "fix"];
export const REPEATS = ["", "daily", "weekly", "monthly"];

const DAY = 86_400_000;
const toUtc = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const fromUtc = (ms) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (iso, n) => fromUtc(toUtc(iso) + n * DAY);
export const daysBetween = (from, to) => Math.round((toUtc(to) - toUtc(from)) / DAY);
// Monday is 0.
export const weekday = (iso) => (new Date(toUtc(iso)).getUTCDay() + 6) % 7;
export const weekStart = (iso) => addDays(iso, -weekday(iso));
export const later = (a, b) => (a > b ? a : b);

// The same day of a later month, or that month's last day when it is shorter.
export function addMonths(iso, n) {
  const first = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return fromUtc(first.getTime() + (Math.min(+iso.slice(8, 10), last) - 1) * DAY);
}

export function localIso(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const uid = () => Math.random().toString(36).slice(2, 10);

export const emptyData = () => ({ v: 1, habits: [], log: {}, skips: {}, notes: {}, days: {}, pauses: [], goals: [], tasks: [] });

// Unknown fields and habit types are kept, so an older version never drops what a newer one saved.
export function normalize(data) {
  if (!data || typeof data !== "object") return emptyData();
  const list = (items) => (Array.isArray(items) ? items : []);
  const map = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
  return {
    ...data,
    v: 1,
    habits: list(data.habits).filter((h) => h?.id),
    goals: list(data.goals).filter((g) => g?.id && g.habitId),
    tasks: list(data.tasks).filter((x) => x?.id),
    pauses: list(data.pauses).filter((p) => p?.id && p.from && p.to),
    log: map(data.log),
    skips: map(data.skips),
    notes: map(data.notes),
    days: map(data.days),
  };
}

export const entry = (data, id, date) => data.log[date]?.[id] ?? 0;

export const note = (data, id, date) => data.notes?.[date]?.[id] ?? "";

// A timer is an amount counted in minutes.
export const isAmount = (habit) => habit.type === "amount" || habit.type === "timer";

// Only habits measured per day can have a schedule: chosen weekdays, every N days from the start, or single days skipped.
export const canSchedule = (habit) => habit.type === "check" || isAmount(habit);
export const isSkipped = (data, id, date) => Boolean(data.skips?.[date]?.[id]);

export function isScheduled(habit, date) {
  if (!canSchedule(habit)) return true;
  if (habit.every > 1) return daysBetween(habit.start, date) % habit.every === 0;
  return !habit.days?.length || habit.days.includes(weekday(date));
}

// A break covers one habit or, with no habit named, all of them. Avoid habits keep counting through it.
export const isPaused = (data, habit, date) =>
  habit.type !== "avoid" && (data.pauses ?? []).some((p) => (!p.habitId || p.habitId === habit.id) && p.from <= date && date <= p.to);

export const isOff = (data, habit, date) =>
  isPaused(data, habit, date) || (canSchedule(habit) && (isSkipped(data, habit.id, date) || !isScheduled(habit, date)));

// For an avoid habit the logged value marks a slip, so an empty day is a good one.
export function isDone(habit, value) {
  if (habit.type === "avoid") return !value;
  if (isAmount(habit)) return value >= (habit.target || 1);
  return value > 0;
}

const monthStart = (iso) => `${iso.slice(0, 7)}-01`;

const PERIODS = {
  day: { start: (d) => d, next: (d) => addDays(d, 1), prev: (d) => addDays(d, -1) },
  week: { start: weekStart, next: (d) => addDays(d, 7), prev: (d) => addDays(d, -7) },
  month: { start: monthStart, next: (d) => monthStart(addDays(d, 32)), prev: (d) => monthStart(addDays(d, -1)) },
};

const periodOf = (habit) => (habit.type === "weekly" ? "week" : habit.type === "monthly" ? "month" : "day");

// Times logged in the week or month that holds `date`; a day can count more than once.
export function periodCount(data, habit, date) {
  const p = PERIODS[periodOf(habit)];
  const start = p.start(date);
  const end = p.next(start);
  let n = 0;
  for (let d = start; d < end; d = addDays(d, 1)) n += entry(data, habit.id, d);
  return n;
}

// Weekly and monthly habits are measured per period, keyed by its first day; the rest per day.
function periodRange(habit, from, to) {
  const p = PERIODS[periodOf(habit)];
  return { p, first: p.start(later(from, habit.start)), last: p.start(to) };
}

function periodMet(data, habit, date) {
  if (periodOf(habit) !== "day") return periodCount(data, habit, date) >= (habit.target || 1);
  return isDone(habit, entry(data, habit.id, date));
}

// A day off neither extends nor breaks a streak and is left out of the rate, unless the target was met anyway.
// A week or month counts as off when a break touches it.
function excused(data, habit, date) {
  if (periodMet(data, habit, date)) return false;
  const p = PERIODS[periodOf(habit)];
  if (p === PERIODS.day) return isOff(data, habit, date);
  if (!data.pauses?.length) return false;
  for (let d = p.start(date), end = p.next(d); d < end; d = addDays(d, 1)) if (isPaused(data, habit, d)) return true;
  return false;
}

// An unfinished current period does not break a streak yet; a slip on an avoid habit is final.
const stillOpen = (data, habit, last) => habit.type !== "avoid" && !periodMet(data, habit, last);

export function streak(data, habit, today) {
  const { p, first, last } = periodRange(habit, habit.start, today);
  let best = 0;
  let run = 0;
  for (let d = first; d <= last; d = p.next(d)) {
    if (excused(data, habit, d)) continue;
    run = periodMet(data, habit, d) ? run + 1 : 0;
    best = Math.max(best, run);
  }
  let current = 0;
  let d = stillOpen(data, habit, last) ? p.prev(last) : last;
  for (; d >= first; d = p.prev(d)) {
    if (excused(data, habit, d)) continue;
    if (!periodMet(data, habit, d)) break;
    current++;
  }
  return { current, best, unit: periodOf(habit) };
}

export function rate(data, habit, today, days) {
  const { p, first, last } = periodRange(habit, addDays(today, -(days - 1)), today);
  let hit = 0;
  let total = 0;
  for (let d = first; d <= last; d = p.next(d)) {
    if ((d === last && stillOpen(data, habit, d)) || excused(data, habit, d)) continue;
    const met = periodMet(data, habit, d);
    total++;
    if (met) hit++;
  }
  return total ? hit / total : null;
}

// 0 = missed, 1–4 = how much got done, -1 = slipped (avoid habits), "off" = a day off, null = outside the habit's life.
export function level(data, habit, date, today) {
  if (date > today || date < habit.start) return null;
  const v = entry(data, habit.id, date);
  if (!v && isOff(data, habit, date)) return "off";
  if (habit.type === "avoid") return v ? -1 : 4;
  if (isAmount(habit)) return v > 0 ? Math.min(4, Math.ceil((v / (habit.target || 1)) * 4)) : 0;
  return v > 0 ? 4 : 0;
}

export function goalProgress(data, goal, habit, today) {
  const end = goal.deadline < today ? goal.deadline : today;
  let done = 0;
  for (let d = later(goal.start, habit.start); d <= end; d = addDays(d, 1)) {
    const v = entry(data, habit.id, d);
    done += isAmount(habit) || periodOf(habit) !== "day" ? v : isDone(habit, v) ? 1 : 0;
  }
  const span = daysBetween(goal.start, goal.deadline) + 1;
  const elapsed = Math.min(span, Math.max(0, daysBetween(goal.start, today) + 1));
  const expected = (goal.target * elapsed) / span;
  const daysLeft = Math.max(0, daysBetween(today, goal.deadline) + 1);
  const remaining = Math.max(0, goal.target - done);
  const status = done >= goal.target ? "done" : today > goal.deadline ? "missed" : done >= expected ? "ahead" : "behind";
  return {
    done,
    pct: Math.min(1, done / goal.target),
    expectedPct: Math.min(1, expected / goal.target),
    diff: done - expected,
    daysLeft,
    perDay: daysLeft ? remaining / daysLeft : remaining,
    status,
  };
}

function upsert(list, item) {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) list.push(item);
  else list[i] = item;
}

// Each keeps one value per habit per day.
const DAY_MAPS = { log: "log", skip: "skips", note: "notes" };

// Next due date of a repeating task: the first one after today, counted from its due date.
export function nextDue(due, repeat, today) {
  let d = due || today;
  do d = repeat === "daily" ? addDays(d, 1) : repeat === "weekly" ? addDays(d, 7) : addMonths(d, 1);
  while (d <= today);
  return d;
}

export function applyOp(data, op) {
  if (DAY_MAPS[op.t]) {
    const days = (data[DAY_MAPS[op.t]] ??= {});
    const day = (days[op.date] ??= {});
    if (op.v) day[op.id] = op.v;
    else delete day[op.id];
    if (!Object.keys(day).length) delete days[op.date];
  } else if (op.t === "day") {
    data.days ??= {};
    if (Object.values(op.day ?? {}).some(Boolean)) data.days[op.date] = op.day;
    else delete data.days[op.date];
  } else if (op.t === "pause") {
    upsert((data.pauses ??= []), op.pause);
  } else if (op.t === "delPause") {
    data.pauses = (data.pauses ?? []).filter((p) => p.id !== op.id);
  } else if (op.t === "order") {
    const at = new Map(op.ids.map((id, i) => [id, i]));
    data.habits = data.habits.map((h, i) => [h, at.get(h.id) ?? op.ids.length + i]).sort((a, b) => a[1] - b[1]).map(([h]) => h);
  } else if (op.t === "import") {
    Object.assign(data, merge(data, normalize(op.data)));
  } else if (op.t === "habit") {
    upsert(data.habits, op.habit);
  } else if (op.t === "delHabit") {
    data.habits = data.habits.filter((h) => h.id !== op.id);
    data.goals = data.goals.filter((g) => g.habitId !== op.id);
    data.pauses = (data.pauses ?? []).filter((p) => p.habitId !== op.id);
    for (const [t, name] of Object.entries(DAY_MAPS)) {
      for (const date of Object.keys(data[name] ?? {})) applyOp(data, { t, date, id: op.id, v: 0 });
    }
  } else if (op.t === "goal") {
    upsert(data.goals, op.goal);
  } else if (op.t === "delGoal") {
    data.goals = data.goals.filter((g) => g.id !== op.id);
  } else if (op.t === "task") {
    upsert(data.tasks, op.task);
  } else if (op.t === "delTask") {
    data.tasks = data.tasks.filter((x) => x.id !== op.id);
  } else if (op.t === "delTasks") {
    const ids = new Set(op.ids);
    data.tasks = data.tasks.filter((x) => !ids.has(x.id));
  }
  return data;
}

export const replay = (base, ops) => ops.reduce(applyOp, structuredClone(base));

const LISTS = ["habits", "goals", "tasks", "pauses"];

// `device` added into `base`: its habits, goals, tasks and breaks replace those with the same id, and its entries for a day win.
export function merge(base, device) {
  const out = structuredClone(base);
  for (const kind of LISTS) {
    out[kind] ??= [];
    const at = new Map(out[kind].map((item, i) => [item.id, i]));
    for (const item of device[kind] ?? []) {
      if (at.has(item.id)) out[kind][at.get(item.id)] = item;
      else at.set(item.id, out[kind].push(item) - 1);
    }
  }
  for (const name of Object.values(DAY_MAPS)) {
    for (const [date, day] of Object.entries(device[name] ?? {})) (out[name] ??= {})[date] = { ...out[name][date], ...day };
  }
  out.days = { ...out.days, ...device.days };
  return out;
}

export const hasData = (data) =>
  LISTS.some((kind) => data[kind]?.length) || [...Object.values(DAY_MAPS), "days"].some((name) => Object.keys(data[name] ?? {}).length > 0);

function opKey(op) {
  if (DAY_MAPS[op.t]) return `${op.t}:${op.date}:${op.id}`;
  if (op.t === "day") return `day:${op.date}`;
  const item = op.habit ?? op.goal ?? op.task ?? op.pause;
  return item ? `${op.t}:${item.id}` : null;
}

// Back-to-back edits of the same thing collapse into one op, so typing a name queues a single change.
export function queue(ops, op) {
  const last = ops.at(-1);
  const key = opKey(op);
  return last && key && opKey(last) === key ? [...ops.slice(0, -1), op] : [...ops, op];
}

// Open tasks by due date with undated ones last, done ones newest first.
export function sortTasks(tasks) {
  const byDue = (a, b) => (a.due || "~") < (b.due || "~") ? -1 : (a.due || "~") > (b.due || "~") ? 1 : 0;
  const open = tasks.filter((x) => !x.done).sort(byDue);
  const done = tasks.filter((x) => x.done).sort((a, b) => (a.done < b.done ? 1 : a.done > b.done ? -1 : 0));
  return { open, done };
}
