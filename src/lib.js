export const TYPES = ["check", "weekly", "monthly", "amount", "timer", "avoid"];
export const KINDS = ["do", "buy", "fix"];
export const REPEATS = ["", "daily", "weekly", "monthly"];

const DAY = 86_400_000;
const toUtc = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const fromUtc = (ms) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (iso, n) => fromUtc(toUtc(iso) + n * DAY);
export const daysBetween = (from, to) => Math.round((toUtc(to) - toUtc(from)) / DAY);
export const dayNumber = (iso) => Math.round(toUtc(iso) / DAY);
// Monday is 0.
export const weekday = (iso) => (new Date(toUtc(iso)).getUTCDay() + 6) % 7;
export const weekStart = (iso) => addDays(iso, -weekday(iso));
export const later = (a, b) => (a > b ? a : b);
export const earlier = (a, b) => (a < b ? a : b);
export const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const isIsoDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

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

export const emptyData = () => ({ v: 1, habits: [], log: {}, skips: {}, notes: {}, days: {}, breaks: [], goals: [], tasks: [] });

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
    breaks: list(data.breaks).filter((b) => b?.id && b.from && b.to),
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

// Only habits measured per day can have a schedule: chosen weekdays, every N days, or single days skipped.
export const canSchedule = (habit) => habit.type === "check" || isAmount(habit);
export const isSkipped = (data, id, date) => Boolean(data.skips?.[date]?.[id]);

// Fixed when the interval is chosen, so moving the start date leaves the days where they were.
export const everyFrom = (habit) => habit.everyFrom ?? habit.start;

// Earlier dates are typos, and walking decades of empty days would stall the app.
export const MIN_DATE = "1970-01-01";
export const lifeStart = (habit) => later(habit.start, MIN_DATE);

// The fields that decide whether a day is due and done.
const ruleOf = (habit) => ({ type: habit.type, target: habit.target ?? 1, days: habit.days ?? [], every: habit.every ?? 0, everyFrom: everyFrom(habit) });

// Eras come from synced or imported files, so only well-formed rule fields are taken from them.
function cleanEra(era) {
  if (!era || typeof era !== "object" || !isIsoDate(era.until)) return null;
  const out = { until: era.until };
  if (typeof era.type === "string") out.type = era.type;
  if (Number.isFinite(era.target) && era.target > 0) out.target = era.target;
  if (Array.isArray(era.days)) out.days = era.days.filter((d) => Number.isInteger(d) && d >= 0 && d < 7);
  if (Number.isFinite(era.every) && era.every >= 0) out.every = era.every;
  if (isIsoDate(era.everyFrom)) out.everyFrom = era.everyFrom;
  return out;
}

const byUntil = (a, b) => (a.until < b.until ? -1 : a.until > b.until ? 1 : 0);
const MAX_ERAS = 1000;

// `past` holds ended eras by last day; older versions ignore it, so their edits change only the current era.
const erasCache = new WeakMap();
function erasOf(habit) {
  if (!Array.isArray(habit.past) || !habit.past.length) return [];
  let eras = erasCache.get(habit);
  if (!eras) {
    eras = habit.past
      .map(cleanEra)
      .filter(Boolean)
      .sort(byUntil)
      .slice(-MAX_ERAS)
      .map(({ until, ...rule }) => ({ until, habit: { ...habit, ...rule, past: undefined } }));
    erasCache.set(habit, eras);
  }
  return eras;
}

export function habitAt(habit, date) {
  const eras = erasOf(habit);
  if (!eras.length || date > eras.at(-1).until) return habit;
  let lo = 0;
  let hi = eras.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (eras[mid].until < date) lo = mid + 1;
    else hi = mid;
  }
  return eras[lo].habit;
}

// The habit's current rules alone, for what looks ahead, like calendars and reminders.
export const currentRules = (habit) => ({ ...habit, past: undefined });

export function rulesSince(habit) {
  const last = erasOf(habit).at(-1)?.until;
  return last ? later(addDays(last, 1), habit.start) : habit.start;
}

export const hasPastRules = (habit) => erasOf(habit).length > 0;

const sameRule = (a, b) => JSON.stringify(ruleOf(a)) === JSON.stringify(ruleOf(b));

export const changesRules = (habit, patch) => !sameRule(habit, { ...habit, ...patch });

// Once rules changed today, later changes that day only adjust the new ones without asking.
export const asksRuleChoice = (habit, patch, today) =>
  habit.start < today && changesRules(habit, patch) && !erasOf(habit).some((e) => e.until === addDays(today, -1));

// `scope`: "today" ends the current rules yesterday, "current" rewrites them, "all" drops every earlier era.
// Stored eras keep fields this version does not know; ones ending today or later can only come from a wrong clock.
export function withRules(habit, patch, today, scope) {
  const next = { ...habit, ...patch };
  if (scope === "all") return { ...next, past: undefined };
  if (scope !== "today" || !asksRuleChoice(habit, patch, today)) return next;
  const yesterday = addDays(today, -1);
  const kept = (Array.isArray(habit.past) ? habit.past : []).filter((e) => isIsoDate(e?.until) && e.until < yesterday).sort(byUntil);
  return { ...next, past: [...kept, { until: yesterday, ...ruleOf(habit) }] };
}

// These take a habit as `habitAt` returns it; the exported forms below look it up for the date.
function scheduledOn(rule, date) {
  if (!canSchedule(rule)) return true;
  if (rule.every > 1) return daysBetween(everyFrom(rule), date) % rule.every === 0;
  return !rule.days?.length || rule.days.includes(weekday(date));
}

// Avoid habits count through breaks, except one covering days they were archived.
function onBreak(data, rule, date) {
  const avoid = rule.type === "avoid";
  return (data.breaks ?? []).some((b) => (avoid ? b.archived && b.habitId === rule.id : !b.habitId || b.habitId === rule.id) && b.from <= date && date <= b.to);
}

const offOn = (data, rule, date) => onBreak(data, rule, date) || (canSchedule(rule) && (isSkipped(data, rule.id, date) || !scheduledOn(rule, date)));

export const isScheduled = (habit, date) => scheduledOn(habitAt(habit, date), date);
export const isOnBreak = (data, habit, date) => onBreak(data, habitAt(habit, date), date);
export const isOff = (data, habit, date) => offOn(data, habitAt(habit, date), date);

// Older versions restore and re-archive without updating `archivedAt`, so a later entry wins. An avoid habit's
// entries are slips, so one archived before `archivedAt` existed keeps counting, as it always did.
export function lastDay(data, habit, today) {
  if (!habit.archived) return today;
  const known = isIsoDate(habit.archivedAt);
  if (!known && habit.type === "avoid") return today;
  let end = known ? habit.archivedAt : habit.start;
  for (const name of Object.values(HABIT_DAY_MAPS)) {
    for (const [date, day] of Object.entries(data[name] ?? {})) if (day[habit.id] && date > end) end = date;
  }
  return earlier(end, today);
}

export const archiveOps = (habit, today) => [{ t: "habit", habit: { ...habit, archived: true, archivedAt: today } }];

// The days it was archived become a break, so they do not count as missed. Without a known archive day there is
// no telling which days those were, so none are taken out.
export function restoreOps(data, habit, today, newId) {
  const ops = [{ t: "habit", habit: { ...habit, archived: false, archivedAt: undefined } }];
  const from = isIsoDate(habit.archivedAt) && addDays(lastDay(data, habit, today), 1);
  const to = addDays(today, -1);
  if (from && from <= to) ops.push({ t: "break", break: { id: newId(), from, to, habitId: habit.id, archived: true } });
  return ops;
}

// For an avoid habit the logged value marks a slip, so an empty day is a good one.
export function isDone(habit, value) {
  if (habit.type === "avoid") return !value;
  if (isAmount(habit)) return value >= (habit.target || 1);
  return value > 0;
}

const monthStart = (iso) => `${iso.slice(0, 7)}-01`;

export const PERIODS = {
  day: { start: (d) => d, next: (d) => addDays(d, 1) },
  week: { start: weekStart, next: (d) => addDays(d, 7) },
  month: { start: monthStart, next: (d) => monthStart(addDays(d, 32)) },
  year: { start: (d) => `${d.slice(0, 4)}-01-01`, next: (d) => addMonths(d, 12) },
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

// Whether a period from `start` to `end` met `rule`, and the day it did.
function tally(data, rule, start, end) {
  if (periodOf(rule) === "day") return { met: isDone(rule, entry(data, rule.id, start)), on: start };
  let sum = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) {
    sum += entry(data, rule.id, d);
    if (sum >= (rule.target || 1)) return { met: true, on: d };
  }
  return { met: false, on: end };
}

// A week or month is off when a break touches it.
function periodOff(data, rule, start, end) {
  if (periodOf(rule) === "day") return offOn(data, rule, start);
  if (!data.breaks?.length) return false;
  for (let d = start; d <= end; d = addDays(d, 1)) if (onBreak(data, rule, d)) return true;
  return false;
}

// Spans of days under one habit type, oldest first; the last one has no end.
function typeRuns(habit) {
  const runs = [];
  let from = lifeStart(habit);
  const add = (type, to) => {
    if (runs.at(-1)?.type === type) runs.at(-1).to = to;
    else runs.push({ type, from, to });
  };
  for (const era of erasOf(habit)) {
    if (era.until < from) continue;
    add(era.habit.type, era.until);
    from = addDays(era.until, 1);
  }
  add(habit.type, null);
  return runs;
}

// Each period is judged by the rules of its last day, and counts `on` the day its target was met, else its last
// day, at most `to`. A type change starts a new `run`, which owns the period holding the change; the old type
// keeps that period's days before the change only if they had already met its target.
export function periodsOf(data, habit, from, to) {
  const out = [];
  const runs = typeRuns(habit);
  runs.forEach((r, run) => {
    const unit = periodOf(r);
    const p = PERIODS[unit];
    const next = runs[run + 1];
    const lastStart = p.start(r.to && r.to < to ? r.to : to);
    for (let d = p.start(later(from, r.from)); d <= lastStart; d = p.next(d)) {
      const full = unit === "day" ? d : addDays(p.next(d), -1);
      const cut = next && full >= next.from;
      const end = cut ? addDays(next.from, -1) : full;
      const rule = habitAt(habit, end);
      const { met, on } = tally(data, rule, d, end);
      if (cut) {
        if (met) out.push({ start: d, end, unit, rule, run, met, off: false, on: earlier(on, to) });
        break;
      }
      out.push({ start: d, end, unit, rule, run, met, on: earlier(on, to), off: (!met || rule.type === "avoid") && periodOff(data, rule, d, end) });
    }
  });
  return out;
}

// An open period counts once met, except an avoid habit's, whose slips are final.
export function countsTowardRate(period, last) {
  const avoid = period.rule.type === "avoid";
  if (period.off) return period.met && !avoid;
  return period.met || period.end < last || avoid;
}

// An unfinished current period does not break a streak yet; a slip on an avoid habit is final.
const stillOpen = (period) => period.rule.type !== "avoid" && !period.met;

export function streak(data, habit, today) {
  const periods = periodsOf(data, habit, habit.start, today);
  const unit = periodOf(habit);
  let best = 0;
  let count = 0;
  periods.forEach((x, i) => {
    if (i && x.run !== periods[i - 1].run) count = 0;
    if (x.off) return;
    count = x.met ? count + 1 : 0;
    if (x.unit === unit) best = Math.max(best, count);
  });
  let current = 0;
  const last = periods.at(-1);
  for (let i = last && stillOpen(last) ? periods.length - 2 : periods.length - 1; i >= 0 && periods[i].run === last.run; i--) {
    if (periods[i].off) continue;
    if (periods[i].met) current++;
    else break;
  }
  return { current, best, unit };
}

// Periods count on the day they were met, or their last day, so the window holds the same ones as Compare's ranges.
export function rate(data, habit, today, days) {
  const from = addDays(today, -(days - 1));
  let hit = 0;
  let total = 0;
  for (const x of periodsOf(data, habit, from, today)) {
    if (x.on < from || !countsTowardRate(x, today)) continue;
    total++;
    if (x.met) hit++;
  }
  return total ? hit / total : null;
}

// 0 = missed, 1–4 = how much got done, -1 = slipped (avoid habits), "off" = a day off, null = outside the habit's life.
export function level(data, habit, date, today) {
  if (date > today || date < habit.start) return null;
  habit = habitAt(habit, date);
  const v = entry(data, habit.id, date);
  if (!v && offOn(data, habit, date)) return "off";
  if (habit.type === "avoid") return v ? -1 : 4;
  if (isAmount(habit)) return v > 0 ? Math.min(4, Math.ceil((v / (habit.target || 1)) * 4)) : 0;
  return v > 0 ? 4 : 0;
}

// Levels of the last `weeks` weeks, Monday first, up to the end of this week; days still to come are null.
export function recentLevels(data, habit, today, weeks) {
  const first = addDays(weekStart(today), -7 * (weeks - 1));
  return Array.from({ length: weeks * 7 }, (_, i) => level(data, habit, addDays(first, i), today));
}

export function goalProgress(data, goal, habit, today) {
  const end = goal.deadline < today ? goal.deadline : today;
  let done = 0;
  for (let d = later(goal.start, habit.start); d <= end; d = addDays(d, 1)) {
    const v = entry(data, habit.id, d);
    const rule = habitAt(habit, d);
    done += isAmount(rule) || periodOf(rule) !== "day" ? v : isDone(rule, v) ? 1 : 0;
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
const HABIT_DAY_MAPS = { log: "log", skip: "skips", note: "notes" };

// Next due date of a repeating task: the first one after both today and its due date. It is counted from
// `anchor`, the first due date of the series, so a task due on the 31st comes back to the 31st after February.
export function nextDue({ due, repeat, anchor }, today) {
  const from = anchor || due || today;
  const after = later(due || today, today);
  for (let k = 1; ; k++) {
    const d = repeat === "daily" ? addDays(from, k) : repeat === "weekly" ? addDays(from, 7 * k) : addMonths(from, k);
    if (d > after) return d;
  }
}

// Finishing a repeating task opens its next one, with the steps to do again. The done one remembers which.
// The next one's ID comes from the series and its date, so two devices finishing the same task open the same one.
export function completeTask(task, today, newId) {
  if (!task.repeat) return [{ t: "task", task: { ...task, done: today } }];
  const series = task.series || task.id;
  const due = nextDue(task, today);
  const next = { ...task, id: `${series}-${due}`, series, due, anchor: task.anchor || task.due || today, created: today };
  if (task.steps) next.steps = task.steps.map((s) => ({ ...s, id: newId(), done: false }));
  return [{ t: "task", task: next }, { t: "task", task: { ...task, done: today, nextId: next.id } }];
}

// A repeating task moved to another day repeats from that day.
export const rescheduled = (task, due) => (task.repeat ? { due, anchor: due } : { due });

// Undoing takes back the task it opened, unless that one was finished meanwhile.
export function reopenTask(task, tasks) {
  const { nextId, ...rest } = task;
  const next = tasks.find((x) => x.id === nextId);
  return [...(next && !next.done ? [{ t: "delTask", id: next.id }] : []), { t: "task", task: { ...rest, done: "" } }];
}

const EVERY_DAY = 127;

// Each habit's time of day as a minute of the UTC day, with the UTC weekdays it is due on as bits, Sunday first;
// a plain minute means every day. Offsets shift with daylight saving, so these are sent again on each visit.
export function reminderTimes(habits, now = new Date()) {
  const at = new Map();
  for (const habit of habits) {
    if (!habit.time) continue;
    const local = new Date(now.getFullYear(), now.getMonth(), now.getDate(), +habit.time.slice(0, 2), +habit.time.slice(3, 5));
    const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
    const shift = local.getUTCDay() - local.getDay() + 7;
    const weekdays = canSchedule(habit) && !(habit.every > 1) && habit.days?.length ? habit.days : [0, 1, 2, 3, 4, 5, 6];
    const days = weekdays.reduce((bits, d) => bits | (1 << ((d + 1 + shift) % 7)), 0);
    at.set(minute, (at.get(minute) ?? 0) | days);
  }
  return [...at].sort((a, b) => a[0] - b[0]).map(([minute, days]) => (days === EVERY_DAY ? minute : [minute, days]));
}

const MAX_TIMER_MINUTES = 24 * 60;

// To the nearest minute; a timer that ran at all counts for one, and one left running stops counting after a day.
export const timerMinutes = (startMs, nowMs) => Math.min(MAX_TIMER_MINUTES, Math.max(1, Math.round((nowMs - startMs) / 60000)));

const compactDay = (day) => Object.fromEntries(Object.entries(day).filter(([, v]) => v));

export function applyOp(data, op) {
  if (HABIT_DAY_MAPS[op.t]) {
    const days = (data[HABIT_DAY_MAPS[op.t]] ??= {});
    const day = (days[op.date] ??= {});
    if (op.v) day[op.id] = op.v;
    else delete day[op.id];
    if (!Object.keys(day).length) delete days[op.date];
  } else if (op.t === "day") {
    // A patch, so mood set on one device and a note typed on another both stay.
    const day = compactDay({ ...data.days?.[op.date], ...op.patch });
    data.days ??= {};
    if (Object.keys(day).length) data.days[op.date] = day;
    else delete data.days[op.date];
  } else if (op.t === "break") {
    upsert((data.breaks ??= []), op.break);
  } else if (op.t === "delBreak") {
    data.breaks = (data.breaks ?? []).filter((b) => b.id !== op.id);
  } else if (op.t === "share") {
    if (op.share) data.share = op.share;
    else delete data.share;
  } else if (op.t === "order") {
    const at = new Map(op.ids.map((id, i) => [id, i]));
    data.habits = data.habits.map((h, i) => [h, at.get(h.id) ?? op.ids.length + i]).sort((a, b) => a[1] - b[1]).map(([h]) => h);
  } else if (op.t === "import") {
    const out = addMissing(data, normalize(op.data));
    for (const name of IMPORTED) data[name] = out[name];
  } else if (op.t === "habit") {
    upsert(data.habits, op.habit);
  } else if (op.t === "delHabit") {
    data.habits = data.habits.filter((h) => h.id !== op.id);
    data.goals = data.goals.filter((g) => g.habitId !== op.id);
    data.breaks = (data.breaks ?? []).filter((b) => b.habitId !== op.id);
    for (const [t, name] of Object.entries(HABIT_DAY_MAPS)) {
      for (const date of Object.keys(data[name] ?? {})) applyOp(data, { t, date, id: op.id, v: 0 });
    }
  } else if (op.t === "goal") {
    upsert(data.goals, op.goal);
  } else if (op.t === "delGoal") {
    data.goals = data.goals.filter((g) => g.id !== op.id);
  } else if (op.t === "task") {
    upsert(data.tasks, op.task);
  } else if (op.t === "step" || op.t === "delStep") {
    // One step at a time, so steps ticked on two devices both stay.
    const task = data.tasks.find((x) => x.id === op.task);
    if (task) {
      const steps = (task.steps ?? []).filter((s) => op.t === "step" || s.id !== op.id);
      if (op.step) upsert(steps, op.step);
      upsert(data.tasks, { ...task, steps });
    }
  } else if (op.t === "delTask") {
    data.tasks = data.tasks.filter((x) => x.id !== op.id);
  } else if (op.t === "delTasks") {
    const ids = new Set(op.ids);
    data.tasks = data.tasks.filter((x) => !ids.has(x.id));
  }
  return data;
}

export const replay = (base, ops) => ops.reduce(applyOp, structuredClone(base));

const LISTS = ["habits", "goals", "tasks", "breaks"];
// Only these come from an imported file: a share key in it is someone else's.
const IMPORTED = [...LISTS, ...Object.values(HABIT_DAY_MAPS), "days"];

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
  for (const name of Object.values(HABIT_DAY_MAPS)) {
    for (const [date, day] of Object.entries(device[name] ?? {})) (out[name] ??= {})[date] = { ...out[name][date], ...day };
  }
  for (const [date, day] of Object.entries(device.days ?? {})) (out.days ??= {})[date] = { ...out.days[date], ...day };
  if (device.share) out.share = device.share;
  return out;
}

// What an imported file adds: items and entries the data does not have. What is already there stays as it is,
// in its order, so importing an older backup changes nothing it already holds.
function addMissing(data, incoming) {
  const out = merge(incoming, data);
  for (const kind of LISTS) {
    const mine = new Set((data[kind] ?? []).map((item) => item.id));
    out[kind] = [...(data[kind] ?? []), ...(incoming[kind] ?? []).filter((item) => !mine.has(item.id))];
  }
  return out;
}

export const hasData = (data) =>
  LISTS.some((kind) => data[kind]?.length) || [...Object.values(HABIT_DAY_MAPS), "days"].some((name) => Object.keys(data[name] ?? {}).length > 0);

function opKey(op) {
  if (HABIT_DAY_MAPS[op.t]) return `${op.t}:${op.date}:${op.id}`;
  if (op.t === "share") return "share";
  if (op.t === "step") return `step:${op.task}:${op.step.id}`;
  if (op.t === "day") return `day:${op.date}:${Object.keys(op.patch)}`;
  const item = op.habit ?? op.goal ?? op.task ?? op.break;
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
