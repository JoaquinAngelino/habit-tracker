export const TYPES = ["check", "weekly", "amount", "avoid"];

const DAY = 86_400_000;
const toUtc = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const fromUtc = (ms) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (iso, n) => fromUtc(toUtc(iso) + n * DAY);
export const daysBetween = (from, to) => Math.round((toUtc(to) - toUtc(from)) / DAY);
export const weekStart = (iso) => addDays(iso, -((new Date(toUtc(iso)).getUTCDay() + 6) % 7));
const later = (a, b) => (a > b ? a : b);

export function localIso(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const uid = () => Math.random().toString(36).slice(2, 10);

export const emptyData = () => ({ v: 1, habits: [], log: {}, goals: [] });

export function normalize(data) {
  const out = emptyData();
  if (!data || typeof data !== "object") return out;
  if (Array.isArray(data.habits)) out.habits = data.habits.filter((h) => h?.id && TYPES.includes(h.type));
  if (Array.isArray(data.goals)) out.goals = data.goals.filter((g) => g?.id && g.habitId);
  if (data.log && typeof data.log === "object") out.log = data.log;
  return out;
}

export const entry = (data, id, date) => data.log[date]?.[id] ?? 0;

// For an avoid habit the logged value marks a slip, so an empty day is a good one.
export function isDone(habit, value) {
  if (habit.type === "avoid") return !value;
  if (habit.type === "amount") return value >= (habit.target || 1);
  return value > 0;
}

export function weekCount(data, habit, date) {
  const start = weekStart(date);
  let n = 0;
  for (let i = 0; i < 7; i++) if (entry(data, habit.id, addDays(start, i)) > 0) n++;
  return n;
}

// Weekly habits are measured in weeks (keyed by their Monday), the rest in days.
function units(habit, from, to) {
  const weekly = habit.type === "weekly";
  return {
    step: weekly ? 7 : 1,
    first: weekly ? weekStart(later(from, habit.start)) : later(from, habit.start),
    last: weekly ? weekStart(to) : to,
  };
}

function unitMet(data, habit, date) {
  if (habit.type === "weekly") return weekCount(data, habit, date) >= (habit.target || 1);
  return isDone(habit, entry(data, habit.id, date));
}

// The current day or week counts only once met, so an unfinished today does not break a streak.
export function streak(data, habit, today) {
  const { step, first, last } = units(habit, habit.start, today);
  let best = 0;
  let run = 0;
  for (let d = first; d <= last; d = addDays(d, step)) {
    run = unitMet(data, habit, d) ? run + 1 : 0;
    best = Math.max(best, run);
  }
  let current = 0;
  let d = unitMet(data, habit, last) ? last : addDays(last, -step);
  while (d >= first && unitMet(data, habit, d)) {
    current++;
    d = addDays(d, -step);
  }
  return { current, best, unit: step === 7 ? "week" : "day" };
}

export function rate(data, habit, today, days) {
  const { step, first, last } = units(habit, addDays(today, -(days - 1)), today);
  let hit = 0;
  let total = 0;
  for (let d = first; d <= last; d = addDays(d, step)) {
    const met = unitMet(data, habit, d);
    if (d === last && !met) continue;
    total++;
    if (met) hit++;
  }
  return total ? hit / total : null;
}

// 0 = missed, 1–4 = how much got done, -1 = slipped (avoid habits), null = outside the habit's life.
export function level(data, habit, date, today) {
  if (date > today || date < habit.start) return null;
  const v = entry(data, habit.id, date);
  if (habit.type === "avoid") return v ? -1 : 4;
  if (habit.type === "amount") return v > 0 ? Math.min(4, Math.ceil((v / (habit.target || 1)) * 4)) : 0;
  return v > 0 ? 4 : 0;
}

export function goalProgress(data, goal, habit, today) {
  const end = goal.deadline < today ? goal.deadline : today;
  let done = 0;
  for (let d = later(goal.start, habit.start); d <= end; d = addDays(d, 1)) {
    const v = entry(data, habit.id, d);
    done += habit.type === "amount" ? v : isDone(habit, v) ? 1 : 0;
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

export function applyOp(data, op) {
  if (op.t === "log") {
    const day = (data.log[op.date] ??= {});
    if (op.v) day[op.id] = op.v;
    else delete day[op.id];
    if (!Object.keys(day).length) delete data.log[op.date];
  } else if (op.t === "habit") {
    upsert(data.habits, op.habit);
  } else if (op.t === "delHabit") {
    data.habits = data.habits.filter((h) => h.id !== op.id);
    data.goals = data.goals.filter((g) => g.habitId !== op.id);
    for (const date of Object.keys(data.log)) applyOp(data, { t: "log", date, id: op.id, v: 0 });
  } else if (op.t === "goal") {
    upsert(data.goals, op.goal);
  } else if (op.t === "delGoal") {
    data.goals = data.goals.filter((g) => g.id !== op.id);
  }
  return data;
}

export const replay = (base, ops) => ops.reduce(applyOp, structuredClone(base));

const opKey = (op) =>
  op.t === "log" ? `log:${op.date}:${op.id}` : op.t === "habit" ? `habit:${op.habit.id}` : op.t === "goal" ? `goal:${op.goal.id}` : null;

// Back-to-back edits of the same thing collapse into one op, so typing a name queues a single change.
export function queue(ops, op) {
  const last = ops.at(-1);
  const key = opKey(op);
  return last && key && opKey(last) === key ? [...ops.slice(0, -1), op] : [...ops, op];
}
