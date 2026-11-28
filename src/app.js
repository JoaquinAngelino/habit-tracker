import { $, el, icon, iconButton, mark, lane, toast, heatmap as heatmapGrid, heatmapLegend, lineChart, columnChart } from "./ui.js";
import { TYPES, KINDS, REPEATS, sortTasks, localIso, addDays, weekStart, uid, entry, note, isDone, isAmount, periodCount, streak, rate, recentLevels, goalProgress, canSchedule, isSkipped, isOnBreak, isOff, completeTask, reopenTask, rescheduled, timerMinutes, reminderTimes, habitAt, archiveOps, restoreOps, MIN_DATE, withRules, changesRules, asksRuleChoice, hasPastRules, rulesSince } from "./lib.js";
import { weekdayPattern, correlations, moodLinks, sharedProgress } from "./insights.js";
import { UNITS, AVERAGE_OF, KPIS, GLOBAL_KPIS, LOWER_BETTER, RUN_KPIS, amountTotals, comparesFor, kpiValue, rangeFor, compare, habitFacts, measure, rangesWithData, trendRanges, yearEarlier, habitExtremes, distribution, pastRanges, metricsCsv } from "./metrics.js";
import { toIcs } from "./ics.js";
import { importFile } from "./importer.js";
import { drawCard } from "./card.js";
import { createStore } from "./store.js";
import { local, session, read, write } from "./storage.js";
import { fromB64url, wrap, unwrap, newKey, sealWithKey, newRecoveryCode, cleanCode, formatCode } from "./crypto.js";
import { t, setLanguage, startLanguage, getLanguage, applyTranslations, streakText, LANG_KEY } from "./i18n.js";
import { GOOGLE_CLIENT_ID, signIn, signOut, deleteAccount, publishedLinks, publishLink, updateLink, removeLink, feedUrl, saveRecovery, readRecovery, passkeyCount, removePasskeys } from "./server.js";
import { canRemind, setDeviceReminders, stopDeviceReminders, createPasskey, usePasskey } from "./account.js";

const CONFIG_KEY = "ht.config";
const PASS_KEY = "ht.passphrase";
const SESSION_KEY = "ht.session";
const EMAIL_KEY = "ht.email";
const SECRET_KEYS = [PASS_KEY, SESSION_KEY, EMAIL_KEY];
const MODES = ["account", "none"];
const VIEWS = ["today", "tasks", "progress", "habits", "settings"];
const TIMER_KEY = "ht.timer";
const DEFAULT_TARGET = { check: 1, weekly: 3, monthly: 8, amount: 1, timer: 20, avoid: 1 };
const HEATMAP_WEEKS = 53;
const CARD_WEEKS = 26;
const MOODS = [1, 2, 3, 4, 5];
const TEMPLATES = [
  { key: "water", type: "amount", target: 8, unit: "glasses" },
  { key: "read", type: "amount", target: 20, unit: "pages" },
  { key: "walk", type: "amount", target: 8000, unit: "steps" },
  { key: "exercise", type: "weekly", target: 3 },
  { key: "meditate", type: "timer", target: 10 },
  { key: "journal", type: "check" },
  { key: "sleep", type: "check" },
  { key: "sugar", type: "avoid" },
];
const DONE_TASKS_SHOWN = 20;

const today = () => localIso();
const ui = {
  day: today(),
  lastSeenDay: today(),
  confirm: null,
  allDone: false,
  taskFilter: "all",
  goalDraft: null,
  noteOpen: null,
  openHabit: null,
  // Per habit, history shown or hidden by hand; otherwise it depends on how many habits there are.
  statsOpen: {},
  // Habit or task just checked off, so only its tape plays the check-off.
  popped: null,
  shown: null,
  period: { unit: "week", back: 0, compare: "previous", full: false, from: null, to: null, kpi: "rate", group: "", overlay: false, details: null },
  // A rule change waiting for its scope, and the scope picked per habit today.
  rulePrompt: null,
  rulesPicked: {},
  timer: loadTimer(),
  accountNote: "",
  recovering: false,
  // What the account has published and its passkeys, as the server lists them; null until asked.
  links: null,
  passkeys: null,
  // What each published thing was last made from, so only a change is sent.
  sent: {},
  focus: null,
  status: { state: "off", err: null },
  syncedAt: null,
};

function loadTimer() {
  try {
    const timer = JSON.parse(read(local, TIMER_KEY) ?? "null");
    return timer?.id && timer.at && timer.day ? timer : null;
  } catch {
    return null;
  }
}

function loadSettings() {
  const defaults = { remember: true, sub: "" };
  let saved = {};
  try {
    saved = JSON.parse(read(local, CONFIG_KEY) ?? "{}") ?? {};
  } catch {
    /* start from the defaults */
  }
  return { ...defaults, ...saved, mode: MODES.includes(saved.mode) ? saved.mode : "none" };
}

const settings = loadSettings();
const saveSettings = () => write(local, CONFIG_KEY, JSON.stringify(settings));
const secret = (key) => read(session, key) || read(local, key) || "";

function saveSecret(key, value) {
  write(session, key, settings.remember ? null : value || null);
  write(local, key, settings.remember ? value || null : null);
}

// Earlier versions kept the email with the settings, whatever Remember said.
if (settings.email) {
  saveSecret(EMAIL_KEY, settings.email);
  delete settings.email;
  saveSettings();
}
// GitHub sync is gone, and its token could write to the repository.
for (const kind of [local, session]) write(kind, "ht.token", null);
if ("repo" in settings || "branch" in settings) {
  delete settings.repo;
  delete settings.branch;
  saveSettings();
}

function config() {
  const passphrase = secret(PASS_KEY);
  if (settings.mode === "account") {
    const token = secret(SESSION_KEY);
    return { mode: "account", target: `account:${settings.sub}`, session: token, passphrase, ready: Boolean(settings.sub && token && passphrase) };
  }
  return { mode: "none" };
}

const store = createStore({ config, onChange: () => render(), onStatus: showStatus });
const data = () => store.data();
// Habit types from a newer version stay in the data but are not shown.
const habits = () => data().habits.filter((h) => TYPES.includes(h.type));
const activeHabits = () => habits().filter((h) => !h.archived);

const formatters = new Map();
function formatter(Kind, opts) {
  const key = `${Kind.name}:${getLanguage()}:${JSON.stringify(opts)}`;
  if (!formatters.has(key)) formatters.set(key, new Kind(getLanguage(), opts));
  return formatters.get(key);
}

function fmtDay(iso, opts = { weekday: "short", month: "short", day: "numeric" }) {
  const [y, m, d] = iso.split("-").map(Number);
  return formatter(Intl.DateTimeFormat, opts).format(new Date(y, m - 1, d));
}

const num = (n) => formatter(Intl.NumberFormat, { maximumFractionDigits: 1 }).format(n);
const percent = (r) => (r == null ? "–" : formatter(Intl.NumberFormat, { style: "percent" }).format(r));
const units = (count, unit) => t(unit, { count });
const habitName = (habit) => habit.name.trim() || t("untitled");
const unitOf = (habit) => (habit.type === "timer" ? t("minutes") : (habit.unit ?? "").trim());
const groupOf = (habit) => (habit.group ?? "").trim();
// 2024 began on a Monday.
const weekdayName = (i, weekday) => formatter(Intl.DateTimeFormat, { weekday }).format(new Date(2024, 0, 1 + i));
const byTime = (list) => [...list].sort((a, b) => (a.time || "~").localeCompare(b.time || "~"));

// Streaks and rates walk a habit's whole history, so they are recomputed only when that habit's data changes.
const memo = new Map();
function remember(habit, name, compute) {
  const key = `${name}:${habit.id}`;
  const stamp = `${store.revision(habit.id)}:${today()}`;
  const hit = memo.get(key);
  if (hit?.stamp === stamp) return hit.value;
  const value = compute();
  memo.set(key, { stamp, value });
  return value;
}
// For figures that read all the data: recomputed when any of it, the day or `scope` changes.
function rememberAll(name, scope, compute) {
  const stamp = `${store.edits()}:${today()}:${scope}`;
  const hit = memo.get(name);
  if (hit?.stamp === stamp) return hit.value;
  const value = compute();
  memo.set(name, { stamp, value });
  return value;
}
const streakOf = (habit) => remember(habit, "streak", () => streak(data(), habit, today()));
const rateOf = (habit, days) => remember(habit, `rate${days}`, () => rate(data(), habit, today(), days));

const habitStreakText = (habit, s) => streakText(habit.type === "avoid", s);

function goalUnit(habit) {
  if (isAmount(habit)) return unitOf(habit) || t("unit_total");
  return t(habit.type === "avoid" ? "unit_clean" : "unit_times");
}

function textButton(label, onclick, { small = false, plus = false, danger = false } = {}) {
  return el("button", { type: "button", class: `btn-text${small ? " btn-small" : ""}${danger ? " btn-danger" : ""}`, onclick }, [
    plus ? icon("plus") : null,
    el("span", { textContent: label }),
  ]);
}

function itemRow({ id, tape, body, side = null, closed = false, after = [] }) {
  return el("article", { class: `item${closed ? " is-closed" : ""}`, "data-id": id }, [
    el("div", { class: "item-main" }, [tape, el("div", { class: "item-body" }, body), side]),
    ...after,
  ]);
}

function setConfirm(key, repaint) {
  ui.confirm = key;
  repaint();
}

// The danger button that carries out a confirmed action, and the one that backs out.
function confirmButtons(label, action, repaint) {
  return [
    textButton(label, () => {
      ui.confirm = null;
      action();
    }, { danger: true }),
    textButton(t("cancel"), () => setConfirm(null, repaint), { small: true }),
  ];
}

const commitAll = (ops) => ops.forEach((op, i) => store.commit(op, { quiet: i < ops.length - 1 }));

function undoable(text, ops, undo) {
  commitAll(ops);
  toast(text, { action: t("undo"), onAction: undo });
}

const firstHabitLink = () => [`${t("noHabits")} `, el("a", { href: "#habits", textContent: t("addFirst") }), "."];

function setLog(habit, date, value) {
  const v = value > 0 ? value : 0;
  const rule = habitAt(habit, date);
  if (rule.type !== "avoid" && isDone(rule, v) && !isDone(rule, entry(data(), habit.id, date))) ui.popped = habit.id;
  store.commit({ t: "log", date, id: habit.id, v });
}

function setSkip(habit, date, skipped) {
  store.commit({ t: "skip", date, id: habit.id, v: skipped ? 1 : 0 });
}

function patchHabit(id, patch, opts) {
  const habit = data().habits.find((h) => h.id === id);
  if (habit) store.commit({ t: "habit", habit: { ...habit, ...patch } }, opts);
}

function patchTask(id, patch, opts) {
  const task = data().tasks.find((x) => x.id === id);
  if (task) store.commit({ t: "task", task: { ...task, ...patch } }, opts);
}

function taskTape(task) {
  return el("button", {
    type: "button",
    class: `tape item-tape${task.done ? " is-done" : ""}${task.done && ui.popped === task.id ? " is-popping" : ""}`,
    "aria-pressed": String(Boolean(task.done)),
    title: t(task.done ? "markUndone" : "markDone"),
    "data-focus-key": `${task.id}:tape`,
    "aria-label": `${t(task.done ? "tape_done" : "tape_todo")}, ${task.title.trim() || t("untitledTask")}`,
    textContent: t(task.done ? "tape_done" : "tape_todo"),
    onclick: () => toggleTask(task),
  });
}

function toggleTask(task) {
  if (!task.done) ui.popped = task.id;
  commitAll(task.done ? reopenTask(task, data().tasks) : completeTask(task, today(), uid));
}

function stepsMark(task) {
  const steps = task.steps ?? [];
  return steps.length ? mark(t("stepsDone", { done: steps.filter((s) => s.done).length, total: steps.length })) : null;
}

function stepRows(task) {
  const save = (step, patch) => store.commit({ t: "step", task: task.id, step: { ...step, ...patch } });
  // Put back where it was, among the steps as they are by then.
  const restore = (step, at) => {
    const now = data().tasks.find((x) => x.id === task.id);
    if (!now) return;
    const steps = (now.steps ?? []).filter((s) => s.id !== step.id);
    steps.splice(at, 0, step);
    store.commit({ t: "task", task: { ...now, steps } });
  };
  return (task.steps ?? []).map((step, at) => {
    const check = el("input", {
      type: "checkbox",
      checked: Boolean(step.done),
      "aria-label": t("stepDone"),
      "data-focus-key": `${step.id}:done`,
      onchange: () => save(step, { done: check.checked }),
    });
    const title = el("input", {
      class: "title-input",
      value: step.title,
      placeholder: t("stepPlaceholder"),
      "aria-label": t("stepPlaceholder"),
      "data-focus-key": `${step.id}:title`,
      onchange: () => save(step, { title: title.value }),
      onkeydown: (e) => e.key === "Enter" && title.blur(),
    });
    const remove = () => undoable(t("stepRemoved"), [{ t: "delStep", task: task.id, id: step.id }], () => restore(step, at));
    return el("div", { class: `step${step.done ? " is-closed" : ""}` }, [el("label", { class: "step-check" }, [check]), title, iconButton("x", t("removeStep"), remove)]);
  });
}

function addStep(task) {
  const id = uid();
  ui.focus = `${id}:title`;
  store.commit({ t: "step", task: task.id, step: { id, title: "", done: false } });
}

function dueMark(task) {
  if (!task.due) return null;
  const date = fmtDay(task.due, { month: "short", day: "numeric" });
  if (task.done || task.due > today()) return mark(t("dueOn", { date }));
  return task.due === today() ? mark(t("dueToday"), "yellow") : mark(t("overdue", { date }), "red");
}

function dueRow(task) {
  return itemRow({
    id: task.id,
    tape: taskTape(task),
    body: [
      el("p", { class: "item-title", textContent: task.title.trim() || t("untitledTask") }),
      el("p", { class: "item-marks" }, [mark(t(`kind_${task.kind}`)), dueMark(task), task.repeat ? mark(t(`repeat_${task.repeat}`)) : null, stepsMark(task)]),
    ],
  });
}

function taskRow(task) {
  const title = el("input", {
    class: "title-input",
    value: task.title,
    placeholder: t("taskPlaceholder"),
    "aria-label": t("taskName"),
    "data-focus-key": `${task.id}:title`,
    oninput: () => patchTask(task.id, { title: title.value }, { quiet: true }),
    onkeydown: (e) => e.key === "Enter" && title.blur(),
  });
  const kind = el(
    "select",
    { class: "pill-select", "aria-label": t("type"), "data-focus-key": `${task.id}:kind`, onchange: () => patchTask(task.id, { kind: kind.value }) },
    KINDS.map((k) => el("option", { value: k, textContent: t(`kind_${k}`) })),
  );
  kind.value = task.kind;
  const due = el("input", {
    type: "date",
    value: task.due,
    "aria-label": t("dueDate"),
    "data-focus-key": `${task.id}:due`,
    onchange: () => patchTask(task.id, rescheduled(task, due.value)),
  });
  const repeat = el(
    "select",
    { class: "pill-select", "aria-label": t("taskRepeat"), "data-focus-key": `${task.id}:repeat`, onchange: () => patchTask(task.id, { repeat: repeat.value }) },
    REPEATS.map((k) => el("option", { value: k, textContent: t(`repeat_${k || "none"}`) })),
  );
  repeat.value = REPEATS.includes(task.repeat) ? task.repeat : "";
  const steps = stepRows(task);
  return itemRow({
    id: task.id,
    closed: Boolean(task.done),
    tape: taskTape(task),
    body: [
      title,
      el("div", { class: "item-meta" }, [
        kind,
        el("span", { class: "meta-group" }, [el("span", { class: "meta-label", textContent: t("due") }), due]),
        dueMark(task),
        task.done ? null : repeat,
        stepsMark(task),
        task.done ? null : textButton(t("addStep"), () => addStep(task), { small: true, plus: true }),
      ]),
    ],
    side: el("div", { class: "item-x" }, [iconButton("x", t("deleteTask"), () => removeTasks([task.id], t("taskDeleted")))]),
    after: steps.length ? [el("div", { class: "steps" }, steps)] : [],
  });
}

// Titles are saved as they are typed, without a repaint, so what Undo puts back is read at the time.
function removeTasks(ids, text) {
  const removed = data().tasks.filter((x) => ids.includes(x.id));
  undoable(text, [ids.length === 1 ? { t: "delTask", id: ids[0] } : { t: "delTasks", ids }], () => commitAll(removed.map((task) => ({ t: "task", task }))));
}

function addTask() {
  const task = { id: uid(), title: "", kind: KINDS.includes(ui.taskFilter) ? ui.taskFilter : "do", due: "", done: "", created: today() };
  ui.focus = `${task.id}:title`;
  store.commit({ t: "task", task });
}

function tasksView() {
  const shown = data().tasks.filter((x) => ui.taskFilter === "all" || x.kind === ui.taskFilter);
  const { open, done } = sortTasks(shown);
  const filter = el(
    "select",
    {
      class: "pill-select",
      "aria-label": t("show"),
      "data-focus-key": "tasks:filter",
      onchange: () => {
        ui.taskFilter = filter.value;
        ui.confirm = null;
        render();
      },
    },
    ["all", ...KINDS].map((k) => el("option", { value: k, textContent: t(k === "all" ? "filter_all" : `kind_${k}`) })),
  );
  filter.value = ui.taskFilter;
  const clear = textButton(t("clearDone"), () => removeTasks(done.map((x) => x.id), t("tasksCleared", { count: done.length })), { small: true });
  const listed = ui.allDone ? done : done.slice(0, DONE_TASKS_SHOWN);
  const more = done.length > DONE_TASKS_SHOWN
    ? textButton(t(ui.allDone ? "showFewer" : "showAll", { count: done.length }), () => {
      ui.allDone = !ui.allDone;
      render();
    }, { small: true })
    : null;
  return [
    lane("blue", t("tasks"), {
      count: open.length ? t("open", { count: open.length }) : "",
      tools: [filter, textButton(t("addTask"), addTask, { plus: true })],
      rows: open.map(taskRow),
      empty: ui.taskFilter === "all" ? t("tasksEmpty") : t("filterEmpty"),
    }),
    done.length ? lane("muted", t("doneTasks"), { count: String(done.length), tools: [more, clear], rows: listed.map(taskRow) }) : null,
  ];
}

function tapeState(habit, value) {
  if (habit.type === "avoid") return value > 0 ? "slipped" : "clean";
  return isDone(habit, value) ? "done" : "todo";
}

const TAPE_TITLES = { slipped: "undoSlip", clean: "logSlip", done: "markUndone", todo: "markDone" };
const TAPE_TONES = { slipped: " is-slip", done: " is-done", clean: " is-done", todo: "" };

function todayTape(habit, day, value) {
  const state = tapeState(habit, value);
  const tone = TAPE_TONES[state] + (state === "done" && ui.popped === habit.id ? " is-popping" : "");
  if (isAmount(habit)) {
    const input = el("input", {
      class: "tape-input",
      type: "number",
      min: 0,
      step: "any",
      inputMode: "decimal",
      value: value || "",
      placeholder: "0",
      "aria-label": t("amountOf", { name: habitName(habit) }),
      "data-focus-key": `${habit.id}:amount`,
      onchange: () => setLog(habit, day, Number(input.value) || 0),
      onkeydown: (e) => e.key === "Enter" && input.blur(),
    });
    return el("label", { class: `tape item-tape${tone}` }, [input, el("span", { class: "tape-of", textContent: `/${num(habit.target || 1)}` })]);
  }
  const text = t(`tape_${state}`) + (value > 1 ? ` ×${value}` : "");
  return el("button", {
    type: "button",
    class: `tape item-tape${tone}`,
    "aria-label": `${text}, ${habitName(habit)}`,
    "aria-pressed": String(state === "slipped" || state === "done"),
    title: t(TAPE_TITLES[state]),
    "data-focus-key": `${habit.id}:tape`,
    textContent: text,
    onclick: () => setLog(habit, day, value ? 0 : 1),
  });
}

const clock = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
const timerLabel = () => t("stopTimer", { time: clock(Date.now() - ui.timer.at) });

function saveTimer(timer) {
  ui.timer = timer;
  write(local, TIMER_KEY, timer ? JSON.stringify(timer) : null);
}

// Logged on the day it started. Read again first: another tab may have stopped or replaced it.
function stopTimer() {
  const timer = loadTimer();
  saveTimer(null);
  const habit = timer && habits().find((h) => h.id === timer.id);
  if (!habit) return render();
  setLog(habit, timer.day, entry(data(), habit.id, timer.day) + timerMinutes(timer.at, Date.now()));
}

function timerButton(habit) {
  const running = ui.timer?.id === habit.id;
  return el("button", {
    type: "button",
    class: "btn",
    "data-timer": running ? "on" : null,
    "data-focus-key": `${habit.id}:timer`,
    textContent: running ? timerLabel() : t("start"),
    onclick: () => {
      stopTimer();
      if (running) return;
      saveTimer({ id: habit.id, at: Date.now(), day: today() });
      render();
    },
  });
}

const noteKey = (habit) => `${habit.id}:note`;

function openNote(habit, day) {
  ui.noteOpen = `${habit.id}:${day}`;
  ui.focus = noteKey(habit);
  render();
}

// Shown once there is a note, or while one is being started.
function noteField(habit, day) {
  const text = note(data(), habit.id, day);
  if (!text && ui.noteOpen !== `${habit.id}:${day}`) return null;
  const save = (v, opts) => store.commit({ t: "note", date: day, id: habit.id, v }, opts);
  const input = el("input", {
    class: "title-input note-input",
    value: text,
    maxLength: 500,
    placeholder: t("notePlaceholder"),
    "aria-label": t("noteFor", { name: habitName(habit) }),
    "data-focus-key": noteKey(habit),
    oninput: () => save(input.value, { quiet: true }),
    onchange: () => {
      if (input.value.trim()) return;
      ui.noteOpen = null;
      save("");
    },
    onkeydown: (e) => e.key === "Enter" && input.blur(),
  });
  return input;
}

function offMark(d, habit, day) {
  if (isSkipped(d, habit.id, day)) return t("skipped");
  return t(isOnBreak(d, habit, day) ? "onBreak" : "notScheduled");
}

function todayRow(habit, day) {
  const d = data();
  const value = entry(d, habit.id, day);
  const s = streakOf(habit);
  const rule = habitAt(habit, day);
  const marks = [habit.time ? mark(habit.time) : null, mark(habitStreakText(habit, s), s.current ? "green" : null)];
  if (s.best > s.current) marks.push(mark(t("best", { units: units(s.best, s.unit) })));
  if (rule.type === "weekly" || rule.type === "monthly") {
    marks.push(mark(t(rule.type === "weekly" ? "thisWeek" : "thisMonth", { count: periodCount(d, rule, day), target: rule.target })));
  }
  if (isAmount(rule) && unitOf(rule)) marks.push(mark(unitOf(rule)));
  const dayOff = isOff(d, habit, day);
  if (!value && dayOff) marks.push(mark(offMark(d, habit, day)));
  if (isSkipped(d, habit.id, day)) marks.push(textButton(t("undoSkip"), () => setSkip(habit, day, false), { small: true }));
  else if (canSchedule(rule) && !isDone(rule, value) && !dayOff) marks.push(textButton(t("skip"), () => setSkip(habit, day, true), { small: true }));

  const noteInput = noteField(habit, day);
  if (!noteInput) marks.push(textButton(t("addNote"), () => openNote(habit, day), { small: true }));

  const actions = [];
  if (rule.type === "timer") {
    if (day === today()) actions.push(timerButton(habit));
  } else if (rule.type === "amount" || rule.type === "weekly" || rule.type === "monthly") {
    actions.push(
      iconButton("minus", t("oneLess"), () => setLog(habit, day, Math.max(0, value - 1)), { disabled: !value }),
      iconButton("plus", t("oneMore"), () => setLog(habit, day, value + 1)),
    );
  }
  return itemRow({
    id: habit.id,
    tape: todayTape(rule, day, value),
    body: [el("p", { class: "item-title", textContent: habitName(habit) }), el("p", { class: "item-marks" }, marks), noteInput],
    side: actions.length ? el("div", { class: "item-actions" }, actions) : null,
  });
}

function groupLane(name, list, day) {
  const d = data();
  const done = list.filter((h) => isDone(habitAt(h, day), entry(d, h.id, day))).length;
  const todo = list.filter((h) => habitAt(h, day).type === "check" && !entry(d, h.id, day));
  const log = (v) => todo.map((h) => ({ t: "log", date: day, id: h.id, v }));
  const doAll = () => undoable(t("markedDone", { count: todo.length }), log(1), () => commitAll(log(0)));
  return completed(lane("green", name, {
    count: t("doneCount", { done, total: list.length }),
    tools: todo.length > 1 ? [textButton(t("doAll"), doAll, { small: true })] : [],
    rows: list.map((h) => todayRow(h, day)),
  }), list, done);
}

function completed(section, list, done) {
  if (list.length && done === list.length && list.some((h) => h.id === ui.popped)) section.classList.add("just-completed");
  return section;
}

function startRow(own, hint = null) {
  return el("div", { class: "item onboarding" }, [
    hint ? el("p", { class: "hint", textContent: hint }) : null,
    el("p", {}, [`${t("startWith")} `, el("button", { type: "button", class: "btn-text btn-inline", textContent: t("createOwn"), onclick: own }), "."]),
    el("div", { class: "chips" }, TEMPLATES.map((x) => el("button", { type: "button", class: "chip", onclick: () => addHabit(x) }, [icon("plus"), el("span", { textContent: t(`tpl_${x.key}`) })]))),
  ]);
}

// A row of toggle buttons, as for weekdays or a 1 to 5 scale.
function toggleRow(label, items) {
  return el("span", { class: "days", role: "group", "aria-label": label }, items.map((item) =>
    el("button", {
      type: "button",
      class: "day",
      "aria-pressed": String(item.on),
      "aria-label": item.label,
      title: item.label,
      "data-focus-key": item.key,
      textContent: item.text,
      onclick: item.pick,
    })));
}

function dayLane(day) {
  const current = data().days?.[day] ?? {};
  const set = (patch, opts) => store.commit({ t: "day", date: day, patch }, opts);
  const scale = (field, label) => toggleRow(t(field), MOODS.map((m) => ({
    on: current[field] === m,
    label: label(m),
    key: `day:${field}${m}`,
    text: String(m),
    pick: () => set({ [field]: current[field] === m ? 0 : m }),
  })));
  const text = el("input", {
    class: "title-input note-input",
    value: current.note ?? "",
    maxLength: 1000,
    placeholder: t("dayNotePlaceholder"),
    "aria-label": t("dayNote"),
    "data-focus-key": "day:note",
    oninput: () => set({ note: text.value }, { quiet: true }),
    onkeydown: (e) => e.key === "Enter" && text.blur(),
  });
  return lane("purple", t("dayLog"), {
    rows: [
      el("article", { class: "item" }, [
        el("div", { class: "item-meta" }, [
          el("span", { class: "meta-label", textContent: t("mood") }),
          scale("mood", (m) => t(`mood_${m}`)),
          current.mood ? mark(t(`mood_${current.mood}`)) : null,
          el("span", { class: "meta-label", textContent: t("energy") }),
          scale("energy", (m) => t("energyLevel", { level: m })),
        ]),
        text,
      ]),
    ],
  });
}

// Tasks due by today, kept for the rest of the day once checked off.
function dueLane(day) {
  const now = today();
  if (day !== now) return null;
  const { open, done } = sortTasks(data().tasks.filter((x) => x.due && x.due <= now && (!x.done || x.done === now)));
  if (!open.length && !done.length) return null;
  return lane("blue", t("tasksDue"), {
    count: t("doneCount", { done: done.length, total: open.length + done.length }),
    rows: [...open, ...done].map(dueRow),
  });
}

function emptyToday(groups, started) {
  if (groups.length) return null;
  return t(started.length ? "allOff" : "noneStarted");
}

// The heading opens the browser's date picker; the field itself stays out of sight and out of the tab order.
function dayHeading(day, go) {
  const now = today();
  const title = day === now ? t("today") : fmtDay(day);
  const picker = el("input", {
    type: "date",
    class: "date-shadow",
    value: day,
    max: now,
    tabIndex: -1,
    "aria-hidden": "true",
    onchange: () => picker.value && go(picker.value > now ? now : picker.value),
  });
  const open = () => {
    try {
      picker.showPicker();
    } catch {
      picker.click();
    }
  };
  return el("span", { class: "date-jump" }, [
    el("button", { type: "button", class: "lane-title-btn", "aria-label": `${title}, ${t("pickDay")}`, "data-focus-key": "today:pick", onclick: open }, [title]),
    picker,
  ]);
}

function todayView() {
  const day = ui.day;
  const now = today();
  const started = byTime(activeHabits().filter((h) => h.start <= day));
  // A day off still lists the habit, apart, so it can be logged anyway; logging moves it back.
  const offHabits = started.filter((h) => !entry(data(), h.id, day) && isOff(data(), h, day));
  const due = started.filter((h) => !offHabits.includes(h));
  const done = due.filter((h) => isDone(habitAt(h, day), entry(data(), h.id, day))).length;
  const groups = [...new Set(due.map(groupOf).filter(Boolean))];
  const go = (to) => {
    ui.day = to;
    render();
  };
  const own = () => {
    location.hash = "#habits";
    addHabit();
  };
  return [
    completed(lane("green", dayHeading(day, go), {
      count: due.length ? t("doneCount", { done, total: due.length }) : "",
      tools: [
        day !== now ? textButton(t("backToday"), () => go(now), { small: true }) : null,
        iconButton("left", t("prevDay"), () => go(addDays(day, -1))),
        iconButton("right", t("nextDay"), () => go(addDays(day, 1)), { disabled: day >= now }),
      ],
      rows: activeHabits().length ? due.filter((h) => !groupOf(h)).map((h) => todayRow(h, day)) : [startRow(own)],
      empty: emptyToday(groups, started),
    }), due, done),
    ...groups.map((name) => groupLane(name, due.filter((h) => groupOf(h) === name), day)),
    offHabits.length ? lane("muted", t("dayOff"), { count: t("habits", { count: offHabits.length }), rows: offHabits.map((h) => todayRow(h, day)) }) : null,
    dueLane(day),
    activeHabits().length ? dayLane(day) : null,
  ];
}

function goalRow(goal, habit) {
  const p = goalProgress(data(), goal, habit, today());
  const gap = Math.max(1, Math.round(Math.abs(p.diff)));
  const tone = { done: " is-done", ahead: " is-done", behind: " is-behind", missed: " is-slip" }[p.status];
  const status = {
    done: mark(t("reached"), "green"),
    missed: mark(t("missed"), "red"),
    ahead: mark(p.diff >= 0.5 ? t("onPaceAhead", { count: gap }) : t("onPace"), "green"),
    behind: mark(t("behind", { count: gap, perDay: num(Math.ceil(p.perDay * 10) / 10) }), "yellow"),
  }[p.status];
  const title = t("goalTitle", {
    habit: habitName(habit),
    target: num(goal.target),
    unit: goalUnit(habit),
    date: fmtDay(goal.deadline, { month: "short", day: "numeric", year: "numeric" }),
  });
  const open = p.status === "ahead" || p.status === "behind";
  const pct = Math.floor(p.pct * 100);
  return itemRow({
    id: goal.id,
    tape: el("span", { class: `tape item-tape${tone}`, textContent: `${pct}%` }),
    body: [
      el("p", { class: "item-title", textContent: title }),
      el("div", { class: "bar", role: "progressbar", "aria-label": title, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": pct }, [
        el("span", { class: "bar-fill", style: `width:${p.pct * 100}%` }),
        open ? el("span", { class: "bar-pace", style: `left:${p.expectedPct * 100}%`, title: t("pace") }) : null,
      ]),
      el("p", { class: "item-marks" }, [
        mark(t("ofTarget", { done: num(p.done), target: num(goal.target) })),
        open ? mark(t("daysLeft", { count: p.daysLeft })) : null,
        status,
      ]),
    ],
    side: el("div", { class: "item-x" }, [iconButton("x", t("removeGoal"), () => undoable(t("goalRemoved"), [{ t: "delGoal", id: goal.id }], () => store.commit({ t: "goal", goal })))]),
  });
}

function goalForm(choices) {
  const draft = ui.goalDraft;
  if (!choices.some((h) => h.id === draft.habitId)) draft.habitId = choices[0].id;
  const habit = choices.find((h) => h.id === draft.habitId);
  const habitSelect = el(
    "select",
    {
      class: "pill-select",
      "aria-label": t("habit"),
      "data-focus-key": "goal:habit",
      onchange: () => {
        draft.habitId = habitSelect.value;
        render();
      },
    },
    choices.map((h) => el("option", { value: h.id, textContent: habitName(h) })),
  );
  habitSelect.value = draft.habitId;
  const target = el("input", {
    type: "number",
    class: "num-input",
    min: 1,
    step: "any",
    inputMode: "decimal",
    value: draft.target,
    "aria-label": t("target"),
    "data-focus-key": "goal:target",
    oninput: () => {
      draft.target = target.value;
    },
  });
  const deadline = el("input", {
    type: "date",
    value: draft.deadline,
    min: today(),
    "aria-label": t("deadline"),
    "data-focus-key": "goal:deadline",
    oninput: () => {
      draft.deadline = deadline.value;
    },
  });
  const add = () => {
    const value = Number(draft.target);
    if (!(value > 0) || !draft.deadline || draft.deadline < today()) return;
    ui.goalDraft = null;
    store.commit({ t: "goal", goal: { id: uid(), habitId: draft.habitId, target: value, start: today(), deadline: draft.deadline } });
  };
  const cancel = () => {
    ui.goalDraft = null;
    render();
  };
  return el("div", { class: "item" }, [
    el("div", { class: "item-meta" }, [
      habitSelect,
      el("span", { class: "meta-group" }, [target, el("span", { class: "meta-label", textContent: goalUnit(habit) })]),
      el("span", { class: "meta-group" }, [el("span", { class: "meta-label", textContent: t("by") }), deadline]),
      el("span", { class: "meta-group" }, [
        el("button", { type: "button", class: "btn", textContent: t("addGoal"), onclick: add }),
        textButton(t("cancel"), cancel, { small: true }),
      ]),
    ]),
  ]);
}

const stat = (label, value) => el("div", { class: "stat" }, [el("dt", { textContent: label }), el("dd", { textContent: value })]);

function cellText(habit, value, lvl) {
  if (lvl === "off") return t("cell_off");
  if (isAmount(habit)) return t("cell_amount", { value: num(value), target: num(habit.target || 1) });
  if (habit.type === "avoid") return t(lvl < 0 ? "cell_slipped" : "cell_clean");
  return t(value ? "cell_done" : "cell_missed") + (value > 1 ? ` ×${value}` : "");
}

function heatmap(habit) {
  const d = data();
  const now = today();
  const first = addDays(weekStart(now), -7 * (HEATMAP_WEEKS - 1));
  const levels = recentLevels(d, habit, now, HEATMAP_WEEKS);
  const cells = levels.map((_, i) => {
    const date = addDays(first, i);
    const level = date > now ? null : levels[i] ?? "before";
    const text = level == null || level === "before" ? "" : `${fmtDay(date)}: ${cellText(habitAt(habit, date), entry(d, habit.id, date), level)}`;
    return { level, text };
  });
  return heatmapGrid(cells, { label: t("heatmapLabel", { name: habitName(habit) }), hint: t("heatmapHint") });
}

const legend = () => heatmapLegend({ less: t("legendLess"), more: t("legendMore"), slip: t("legendSlip"), off: t("legendOff") });

function weekdayBars(habit) {
  const rates = remember(habit, "weekdayBars", () => weekdayPattern(data(), habit, today()));
  if (rates.every((r) => r == null)) return null;
  return el("div", { class: "weekday-bars", role: "img", "aria-label": t("byWeekday"), title: t("byWeekday") }, rates.map((r, i) =>
    el("span", { class: "weekday-bar", title: `${weekdayName(i, "long")}: ${percent(r)}` }, [
      el("span", { class: "weekday-track" }, [el("span", { class: "weekday-fill", style: `height:${Math.round((r ?? 0) * 100)}%` })]),
      el("span", { class: "weekday-label", textContent: weekdayName(i, "narrow") }),
    ])));
}

function download(blob, name) {
  const link = el("a", { href: URL.createObjectURL(blob), download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

async function streakCard(habit) {
  const s = streakOf(habit);
  const css = getComputedStyle(document.documentElement);
  const canvas = drawCard({
    name: habitName(habit),
    label: t(habit.type === "avoid" ? "cleanLabel" : "streakLabel"),
    big: units(s.current, s.unit),
    lines: [`${t("bestLabel")}: ${units(s.best, s.unit)}`, `${t("last30")}: ${percent(rateOf(habit, 30))}`],
    cells: recentLevels(data(), habit, today(), CARD_WEEKS),
    footer: t("title"),
    colors: Object.fromEntries(["panel", "ink", "muted", "green", "red"].map((name) => [name, css.getPropertyValue(`--${name}`).trim()])),
  });
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return;
  const file = new File([blob], "streak.png", { type: "image/png" });
  if (!navigator.canShare?.({ files: [file] })) return download(blob, "streak.png");
  try {
    await navigator.share({ files: [file], title: habitName(habit) });
  } catch {
    /* closed without sharing */
  }
}

const insight = (text) => el("article", { class: "item" }, [el("p", { class: "item-title", textContent: text })]);

const factsOf = () => habits().map((h) => remember(h, "facts", () => habitFacts(data(), h, today()))).filter(Boolean);

const shortDay = { month: "short", day: "numeric" };
const longDay = { month: "short", day: "numeric", year: "numeric" };
const tenth = (v) => Math.round(v * 10) / 10;
// An average can be fractional: `count` picks the plural form and `n` shows it in the language's format.
const countOf = (v) => ({ count: tenth(v), n: num(tenth(v)) });

function spanText(from, to) {
  if (from === to) return fmtDay(from, longDay);
  return `${fmtDay(from, from.slice(0, 4) === to.slice(0, 4) ? shortDay : longDay)} – ${fmtDay(to, longDay)}`;
}

function rangeText(unit, r, whole = r.cut >= r.to) {
  if (!whole) return spanText(r.from, r.cut);
  if (unit === "month") return fmtDay(r.from, { month: "long", year: "numeric" });
  if (unit === "year") return r.from.slice(0, 4);
  if (unit === "day") return fmtDay(r.from, { weekday: "short", ...longDay });
  return spanText(r.from, r.to);
}

function tickText(unit, r) {
  if (unit === "day") return fmtDay(r.from, { weekday: "narrow" });
  if (unit === "month") return fmtDay(r.from, { month: "short" });
  if (unit === "year") return r.from.slice(0, 4);
  return fmtDay(r.from, shortDay);
}

const periodsText = (unit, count) => t(unit === "custom" ? "rangesCount" : unit, { count });

const PERCENT_KPIS = new Set(["rate", "onTime"]);
const SCALE_KPIS = new Set(["mood", "energy"]);

function kpiText(key, v) {
  if (v == null) return "–";
  if (PERCENT_KPIS.has(key)) return percent(v);
  if (RUN_KPIS.has(key)) return units(Math.round(v), "day");
  return num(v);
}

function deltaMark(key, now, before) {
  if (now == null || before == null) return null;
  const diff = PERCENT_KPIS.has(key) ? Math.round((now - before) * 100) : tenth(now - before);
  if (!diff) return mark("±0");
  const good = LOWER_BETTER.has(key) ? diff < 0 : diff > 0;
  const text = `${diff > 0 ? "+" : "−"}${num(Math.abs(diff))}`;
  return mark(PERCENT_KPIS.has(key) ? t("pts", { value: text }) : text, good ? "green" : "red");
}

function currentRange() {
  const p = ui.period;
  if (p.unit !== "custom") return rangeFor(p.unit, today(), { back: p.back });
  p.to ??= today();
  p.from ??= addDays(p.to, -29);
  return rangeFor("custom", today(), { from: p.from, to: p.to, back: p.back });
}

const factsIn = (facts, group) => (group ? facts.filter((f) => groupOf(f.habit) === group) : facts);

function compareLabel(unit, mode, ranges) {
  if (mode === "best") return t("bestWas", { period: rangeText(unit, ranges[0]) });
  if (mode === "average") return t("avgOfLabel", { span: periodsText(unit, ranges.length) });
  return rangeText(unit, ranges[0]);
}

function compared() {
  const p = ui.period;
  if (p.group && !habits().some((h) => groupOf(h) === p.group)) p.group = "";
  const range = currentRange();
  const key = JSON.stringify([p.unit, p.back, p.compare, p.full, p.from, p.to, p.group, getLanguage()]);
  return rememberAll("compare", key, () => {
    const facts = factsIn(factsOf(), p.group);
    const { before, ranges } = compare(data(), facts, p.unit, range, p.compare, { full: p.full });
    const now = measure(data(), facts, range);
    // Today, set against a whole day, counts what is still open as not done yet.
    if (p.unit === "day" && range.cut === today() && now.pending) now.rate = now.done / (now.due + now.pending);
    return { range, facts, now, before, label: before ? compareLabel(p.unit, p.compare, ranges) : "" };
  });
}

function shownKpis(now, before) {
  const has = (key) => kpiValue(now, key) != null || (before && kpiValue(before, key) != null);
  return KPIS.filter((key) => {
    if (ui.period.group && GLOBAL_KPIS.has(key)) return false;
    if (key === "slips" || key === "longestClean") return now.rows.some((r) => r.rule.type === "avoid") || now.slips > 0;
    if (SCALE_KPIS.has(key) || key === "onTime") return has(key);
    if (key === "tasksDone" || key === "overdue") return data().tasks.length > 0;
    return true;
  });
}

function kpiTile(key, now, before) {
  const v = kpiValue(now, key);
  const was = before ? kpiValue(before, key) : null;
  return el("button", {
    type: "button",
    class: "kpi",
    "aria-pressed": String(ui.period.kpi === key),
    "data-focus-key": `kpi:${key}`,
    onclick: () => {
      ui.period.kpi = key;
      render();
    },
  }, [
    el("span", { class: "kpi-label", textContent: t(`kpi_${key}`) }),
    el("span", { class: "kpi-value", textContent: kpiText(key, v) }),
    el("span", { class: "kpi-delta" }, [deltaMark(key, v, was), before ? el("span", { class: "kpi-was", textContent: t("vsValue", { value: kpiText(key, was) }) }) : null]),
  ]);
}

function periodTools() {
  const p = ui.period;
  const pick = (unit) => {
    Object.assign(p, { unit, back: 0, details: null });
    if (!comparesFor(unit).includes(p.compare)) p.compare = "previous";
    render();
  };
  return [el("span", { class: "segmented", role: "group", "aria-label": t("periodUnit") }, UNITS.map((unit) =>
    el("button", { type: "button", class: "segment", "aria-pressed": String(p.unit === unit), "data-focus-key": `unit:${unit}`, textContent: t(`unit_${unit}`), onclick: () => pick(unit) })))];
}

function periodNav(range) {
  const p = ui.period;
  const move = (n) => {
    p.back = Math.max(0, p.back + n);
    render();
  };
  return el("div", { class: "period-nav" }, [
    iconButton("left", t("prevPeriod"), () => move(1), { "data-focus-key": "period:prev" }),
    el("p", { class: "period-label", "aria-live": "polite", textContent: rangeText(p.unit, range, true) }),
    iconButton("right", t("nextPeriod"), () => move(-1), { disabled: !p.back, "data-focus-key": "period:next" }),
  ]);
}

function pillSelect(label, key, value, options, onchange) {
  const select = el("select", { class: "pill-select", "aria-label": label, "data-focus-key": key, onchange: () => onchange(select.value) },
    options.map(([v, text]) => el("option", { value: v, textContent: text })));
  select.value = value;
  return select;
}

function compareControls(range) {
  const p = ui.period;
  const set = (patch) => {
    Object.assign(p, patch);
    render();
  };
  const controls = [
    pillSelect(t("compareWith"), "period:compare", p.compare, comparesFor(p.unit).map((m) => [m, t(`cmp_${m}`, { span: periodsText(p.unit, AVERAGE_OF[p.unit]) })]), (v) => set({ compare: v })),
  ];
  if (range.cut < range.to) {
    controls.push(pillSelect(t("countBy"), "period:full", p.full ? "full" : "same", [["same", t("sameDays")], ["full", t("wholePeriod")]], (v) => set({ full: v === "full" })));
  }
  const groups = [...new Set(habits().map(groupOf).filter(Boolean))].sort();
  if (groups.length) {
    controls.push(pillSelect(t("group"), "period:group", p.group, [["", t("allGroups")], ...groups.map((g) => [g, g])], (v) => set({ group: v, details: null })));
  }
  if (p.unit === "custom") {
    const date = (field, label) => {
      const input = el("input", {
        type: "date",
        value: p[field],
        min: MIN_DATE,
        max: today(),
        "aria-label": label,
        "data-focus-key": `period:${field}`,
        onchange: () => {
          if (!input.value || input.value < MIN_DATE) return;
          p[field] = input.value;
          if (p.to < p.from) Object.assign(p, field === "from" ? { to: p.from } : { from: p.to });
          set({ back: 0 });
        },
      });
      return input;
    };
    controls.push(el("span", { class: "meta-group" }, [date("from", t("rangeFrom")), el("span", { class: "meta-label", textContent: "–" }), date("to", t("rangeTo"))]));
  }
  controls.push(textButton(t("downloadCsv"), downloadCompareCsv, { small: true }));
  return el("div", { class: "item-meta compare-controls" }, controls);
}

function downloadCompareCsv() {
  const { range, now, before, label } = compared();
  const csv = metricsCsv(before ? [now, before] : [now], habitName, (m) => (m === now ? rangeText(ui.period.unit, range) : label), { global: !ui.period.group });
  download(new Blob([csv], { type: "text/csv" }), `habit-tracker-${range.from}-${range.cut}.csv`);
}

function exportMetrics() {
  const facts = factsOf();
  const ranges = [...pastRanges("month", facts, today()), rangeFor("month", today())];
  const csv = metricsCsv(ranges.map((r) => measure(data(), facts, r)), habitName, (m) => fmtDay(m.from, { month: "long", year: "numeric" }));
  download(new Blob([csv], { type: "text/csv" }), `habit-tracker-metrics-${today()}.csv`);
}

const trendLabel = (unit, r) => ({ short: tickText(unit, r), long: rangeText(unit, r) });

function trendCharts(range, facts) {
  const p = ui.period;
  const key = JSON.stringify([p.unit, p.back, p.from, p.to, p.group, p.overlay]);
  const { ranges, measures, earlierMeasures } = rememberAll("trend", key, () => {
    const list = rangesWithData(facts, trendRanges(p.unit, range), { keepLast: true });
    return {
      ranges: list,
      measures: list.map((r) => measure(data(), facts, r)),
      earlierMeasures: p.overlay ? yearEarlier(p.unit, list).map((r) => measure(data(), facts, r)) : null,
    };
  });
  const kpi = p.kpi;
  const series = [{ name: t("thisSeries"), tone: "green", values: measures.map((m) => kpiValue(m, kpi)) }];
  if (earlierMeasures) series.push({ name: t("yearBefore"), tone: "muted", values: earlierMeasures.map((m) => kpiValue(m, kpi)) });
  const scale = PERCENT_KPIS.has(kpi) ? { min: 0, max: 1 } : SCALE_KPIS.has(kpi) ? { min: 1, max: 5 } : { min: 0 };
  const labels = ranges.map((r) => trendLabel(p.unit, r));
  const title = t("trendOf", { metric: t(`kpi_${kpi}`), span: periodsText(p.unit, ranges.length) });
  const overlay = el("label", { class: "meta-group check-label" }, [
    el("input", { type: "checkbox", checked: p.overlay, "data-focus-key": "period:overlay", onchange: (e) => {
      p.overlay = e.target.checked;
      render();
    } }),
    el("span", { class: "meta-label", textContent: t("showYearBefore") }),
  ]);
  const out = [el("article", { class: "item" }, [
    el("div", { class: "item-meta" }, [el("p", { class: "chart-title", textContent: title }), overlay]),
    lineChart({ label: title, labels, series, format: (v) => kpiText(kpi, v), ...scale, tableSummary: t("showTable") }),
  ])];
  if (!SCALE_KPIS.has(kpi) && !p.group && measures.some((m) => m.mood != null || m.energy != null)) {
    out.push(el("article", { class: "item" }, [
      el("p", { class: "chart-title", textContent: t("moodEnergy") }),
      lineChart({
        label: t("moodEnergy"),
        labels,
        series: [{ name: t("mood"), tone: "mood", values: measures.map((m) => m.mood) }, { name: t("energy"), tone: "energy", values: measures.map((m) => m.energy) }],
        format: num,
        min: 1,
        max: 5,
        tableSummary: t("showTable"),
      }),
    ]));
  }
  return out;
}

function rowFigures(row) {
  if (!row) return { value: null, text: "–" };
  if (row.rule.type === "avoid") return { value: row.slips, text: t("slipsCount", countOf(row.slips)), key: "slips" };
  return { value: row.rate, text: percent(row.rate), key: "rate" };
}

function habitDetails(row, range, facts) {
  const p = ui.period;
  const { habit, rule } = row;
  const avoid = rule.type === "avoid";
  const fact = facts.find((f) => f.habit.id === habit.id);
  const { ranges, measures, extremes, bins } = rememberAll(`habitTrend:${habit.id}`, JSON.stringify([p.unit, p.back, p.from, p.to]), () => {
    const list = rangesWithData([fact], trendRanges(p.unit, range), { keepLast: true });
    return {
      ranges: list,
      measures: list.map((r) => measure(data(), [fact], r)),
      extremes: p.unit === "custom" ? null : habitExtremes(fact, p.unit, range.from),
      bins: isAmount(rule) ? distribution(fact, list[0].from, range.cut) : [],
    };
  });
  // A period ruled by another kind of habit has nothing comparable to plot.
  const values = measures.map((m) => {
    const r = m.rows[0];
    if (!r || (r.rule.type === "avoid") !== avoid) return null;
    return avoid ? r.slips : r.rate;
  });
  const metric = avoid ? t("kpi_slips") : t("kpi_rate");
  const distributionTitle = t("distributionLabel", { span: periodsText(p.unit, ranges.length) });
  return el("div", { class: "habit-details" }, [
    lineChart({
      label: t("trendOf", { metric: `${habitName(habit)} · ${metric}`, span: periodsText(p.unit, ranges.length) }),
      labels: ranges.map((r) => trendLabel(p.unit, r)),
      series: [{ name: metric, tone: avoid ? "red" : "green", values }],
      format: avoid ? num : percent,
      ...(avoid ? { min: 0 } : { min: 0, max: 1 }),
      tableSummary: t("showTable"),
    }),
    extremes ? el("p", { class: "item-marks" }, [
      mark(t("bestPeriod", { period: rangeText(p.unit, extremes.best), rate: percent(extremes.best.rate) }), "green"),
      mark(t("worstPeriod", { period: rangeText(p.unit, extremes.worst), rate: percent(extremes.worst.rate) })),
    ]) : null,
    isAmount(rule) && row.average != null ? el("p", { class: "item-marks" }, [mark(t("amountSummary", { average: num(row.average), best: num(row.bestDay), unit: unitOf(rule) }))]) : null,
    bins.length ? el("p", { class: "chart-title", textContent: distributionTitle }) : null,
    bins.length ? columnChart({ label: distributionTitle, bars: bins.map((b) => ({ label: `${num(b.from)}–${num(b.to)}`, value: b.count })) }) : null,
  ]);
}

// `before` is the comparison's figures for this habit, or null when nothing is compared.
function compareRow(row, before, range, facts) {
  const p = ui.period;
  const { habit, rule } = row;
  const open = p.details === habit.id;
  const now = rowFigures(row);
  const marks = [];
  if (row.due && rule.type === "avoid") {
    marks.push(mark(t("cleanDays", countOf(row.clean))));
    if (row.longestClean) marks.push(mark(`${t("kpi_longestClean")}: ${units(Math.round(row.longestClean), "day")}`));
  } else if (row.due) marks.push(mark(t("doneOfDue", { done: num(row.done), due: num(row.due) })));
  else if (row.total && !isAmount(rule)) marks.push(mark(t("loggedTimes", countOf(row.total))));
  if (isAmount(rule) && row.total) marks.push(mark(`${num(row.total)} ${unitOf(rule)}`.trim()));
  // Slips and rates cannot be set against each other, as when the habit's type changed in between.
  const comparable = before && (!before.key || !now.key || before.key === now.key);
  if (comparable && (before.value != null || now.value != null)) {
    marks.push(el("span", { class: "meta-label", textContent: t("vsValue", { value: before.text }) }), deltaMark(now.key ?? before.key, now.value, before.value));
  }
  const toggle = el("button", {
    type: "button",
    class: "btn-text btn-small",
    "aria-expanded": String(open),
    "data-focus-key": `${habit.id}:details`,
    textContent: t(open ? "hideDetails" : "details"),
    onclick: () => {
      p.details = open ? null : habit.id;
      render();
    },
  });
  const tone = rule.type === "avoid" ? (row.slips ? " is-slip" : " is-done") : row.rate >= 1 ? " is-done" : "";
  return itemRow({
    id: `cmp-${habit.id}`,
    tape: el("span", { class: `tape item-tape${tone}`, textContent: now.text }),
    body: [el("p", { class: "item-title", textContent: habitName(habit) + (habit.archived ? ` · ${t("archived")}` : "") }), el("p", { class: "item-marks" }, [...marks, toggle])],
    after: open ? [habitDetails(row, range, facts)] : [],
  });
}

function compareRows(now, before, range, facts) {
  const was = new Map((before?.rows ?? []).map((r) => [r.habit.id, r]));
  const change = (r) => {
    const b = was.get(r.habit.id);
    if (!b) return -1;
    // Slips as a share of the days due, so both kinds of change sit on one scale.
    if (r.rule.type === "avoid") return b.slips == null ? -1 : Math.abs(r.slips - b.slips) / Math.max(1, r.due, b.due);
    return r.rate == null || b.rate == null ? -1 : Math.abs(r.rate - b.rate);
  };
  return now.rows
    .filter((r) => r.due || r.slips || r.total)
    .sort((a, b) => change(b) - change(a))
    .map((r) => compareRow(r, before ? rowFigures(was.get(r.habit.id)) : null, range, facts));
}

function yearExtras(m) {
  const totals = amountTotals(m);
  if (!m.top && !m.longest && !totals.length) return null;
  return el("p", { class: "item-marks" }, [
    m.top ? mark(`${t("topHabit")}: ${habitName(m.top.habit)} · ${units(m.top.count, "day")}`, "green") : null,
    m.longest ? mark(`${t("kpi_longest")}: ${habitName(m.longest.habit)} · ${units(m.longest.count, "day")}`) : null,
    ...totals.map((r) => mark(`${habitName(r.habit)}: ${num(r.total)} ${unitOf(r.rule)}`.trim())),
  ]);
}

function compareLane() {
  const p = ui.period;
  const { range, facts, now, before, label } = compared();
  const rows = [periodNav(range), compareControls(range)];
  if (facts.some((f) => f.start <= range.cut && f.end >= range.from)) {
    const kpis = shownKpis(now, before);
    if (!kpis.includes(p.kpi)) p.kpi = "rate";
    rows.push(el("article", { class: "item" }, [
      el("p", { class: "meta-label", textContent: before ? t("comparedWith", { period: label }) : t("noComparison") }),
      el("div", { class: "kpis" }, kpis.map((key) => kpiTile(key, now, before))),
      p.unit === "year" ? yearExtras(now) : null,
    ]));
    rows.push(...trendCharts(range, facts));
    rows.push(...compareRows(now, before, range, facts));
  } else {
    rows.push(el("p", { class: "lane-empty", textContent: t("compareEmpty") }));
  }
  return lane("green", t("compare"), { tools: periodTools(), rows });
}

function patternsLane(active) {
  const [pairs, moods] = rememberAll("patterns", "", () => [correlations(data(), active, today()), moodLinks(data(), active, today())]);
  const rows = [
    ...pairs.map((c) => insight(t("corrWith", { a: habitName(c.a), b: habitName(c.b), withA: percent(c.withA), withoutA: percent(c.withoutA) }))),
    ...moods.map((m) => insight(t("moodLink", { habit: habitName(m.habit), done: num(m.done), missed: num(m.missed) }))),
  ];
  return lane("purple", t("patterns"), { rows, empty: t("patternsEmpty") });
}

function habitKind(habit) {
  let kind = t(`type_${habit.type}`);
  if (habit.type === "weekly") kind += ` · ${t("perWeek", { count: habit.target })}`;
  if (habit.type === "monthly") kind += ` · ${t("perMonth", { count: habit.target })}`;
  if (isAmount(habit)) kind += ` · ${t("perDayUnit", { count: num(habit.target), unit: unitOf(habit) })}`;
  return kind;
}

function statsRow(habit, open) {
  const s = streakOf(habit);
  const history = el("button", {
    type: "button",
    class: "btn-text btn-small",
    "aria-expanded": String(open),
    "data-focus-key": `${habit.id}:history`,
    textContent: t(open ? "hideHistory" : "showHistory"),
    onclick: () => {
      ui.statsOpen[habit.id] = !open;
      render();
    },
  });
  return itemRow({
    id: habit.id,
    tape: el("span", { class: `tape item-tape${s.current ? " is-done" : ""}`, title: habitStreakText(habit, s), textContent: t(`short_${s.unit}`, { count: s.current }) }),
    body: [el("p", { class: "item-title", textContent: habitName(habit) }), el("p", { class: "item-marks" }, [mark(habitKind(habit)), textButton(t("share"), () => streakCard(habit), { small: true }), history])],
    after: [
      el("dl", { class: "stats" }, [
        stat(t(habit.type === "avoid" ? "cleanLabel" : "streakLabel"), units(s.current, s.unit)),
        stat(t("bestLabel"), units(s.best, s.unit)),
        stat(t("last7"), percent(rateOf(habit, 7))),
        stat(t("last30"), percent(rateOf(habit, 30))),
        stat(t("last90"), percent(rateOf(habit, 90))),
      ]),
      ...(open ? [weekdayBars(habit), heatmap(habit)] : []),
    ],
  });
}

function startGoal(choices) {
  ui.goalDraft = { habitId: choices[0].id, target: "30", deadline: addDays(today(), 30) };
  ui.focus = "goal:target";
  render();
}

function progressView() {
  const active = activeHabits();
  const byId = new Map(habits().map((h) => [h.id, h]));
  const goals = data().goals.filter((g) => byId.has(g.habitId));
  const rows = goals.map((g) => goalRow(g, byId.get(g.habitId)));
  if (ui.goalDraft && active.length) rows.push(goalForm(active));
  const historyOpen = (h) => ui.statsOpen[h.id] ?? active.length <= 3;
  return [
    habits().length ? compareLane() : null,
    lane("purple", t("goals"), {
      count: goals.length ? t("goals", { count: goals.length }) : "",
      tools: active.length && !ui.goalDraft ? [textButton(t("addGoal"), () => startGoal(active), { plus: true })] : [],
      rows,
      empty: active.length ? t("noGoals") : t("addHabitFirst"),
    }),
    lane("blue", t("stats"), {
      tools: active.some(historyOpen) ? [legend()] : [],
      rows: active.map((h) => statsRow(h, historyOpen(h))),
      empty: firstHabitLink(),
    }),
    active.length ? patternsLane(active) : null,
  ];
}

function addHabit(template) {
  const habit = { id: uid(), name: "", type: "check", target: 1, unit: "", start: today(), archived: false };
  if (template) {
    Object.assign(habit, {
      name: t(`tpl_${template.key}`),
      type: template.type,
      target: template.target ?? DEFAULT_TARGET[template.type],
      unit: template.unit ? t(`unit_${template.unit}`) : "",
    });
  }
  ui.focus = `${habit.id}:name`;
  ui.openHabit = habit.id;
  store.commit({ t: "habit", habit });
}

// Unpicking the last day goes back to every day.
function dayPicker(habit, patch) {
  const chosen = habit.days ?? [];
  return toggleRow(t("onDays"), [0, 1, 2, 3, 4, 5, 6].map((i) => ({
    on: chosen.includes(i),
    label: weekdayName(i, "long"),
    key: `${habit.id}:day${i}`,
    text: weekdayName(i, "narrow"),
    pick: () => patch({ days: chosen.includes(i) ? chosen.filter((x) => x !== i) : [...chosen, i].sort() }),
  })));
}

const SCHEDULES = {
  daily: () => ({ days: [], every: 0 }),
  days: () => ({ days: [0, 1, 2, 3, 4], every: 0 }),
  every: () => ({ days: [], every: 2, everyFrom: today() }),
};

function scheduleFields(habit, patch) {
  const mode = habit.every > 1 ? "every" : habit.days?.length ? "days" : "daily";
  const select = el(
    "select",
    { class: "pill-select", "data-focus-key": `${habit.id}:schedule`, onchange: () => patch(SCHEDULES[select.value]()) },
    Object.keys(SCHEDULES).map((k) => el("option", { value: k, textContent: t(`schedule_${k}`) })),
  );
  select.value = mode;
  const repeats = labelled(t("schedule"), select);
  if (mode === "days") return [repeats, dayPicker(habit, patch)];
  if (mode === "daily") return [repeats];
  const every = el("input", {
    type: "number",
    class: "num-input",
    min: 2,
    step: 1,
    inputMode: "numeric",
    value: habit.every,
    "aria-label": t("interval"),
    "data-focus-key": `${habit.id}:every`,
    onchange: () => patch({ every: Math.max(2, Math.round(Number(every.value)) || 2) }),
  });
  return [repeats, el("span", { class: "meta-group" }, [el("span", { class: "meta-label", textContent: t("everyN") }), every, el("span", { class: "meta-label", textContent: t("daysWord") })])];
}

const peersOf = (habit) => habits().filter((h) => Boolean(h.archived) === Boolean(habit.archived));

// Swaps a habit with its neighbour in the list it is shown in.
function moveHabit(habit, step) {
  const peers = peersOf(habit);
  const other = peers[peers.findIndex((h) => h.id === habit.id) + step];
  if (!other) return;
  const ids = data().habits.map((h) => h.id);
  const a = ids.indexOf(habit.id);
  const b = ids.indexOf(other.id);
  [ids[a], ids[b]] = [ids[b], ids[a]];
  ui.focus = `${habit.id}:${step < 0 ? "up" : "down"}`;
  store.commit({ t: "order", ids });
}

function scheduleText(habit) {
  if (habit.every > 1) return `${t("everyN")} ${habit.every} ${t("daysWord")}`;
  if (habit.days?.length) return habit.days.map((i) => weekdayName(i, "short")).join(" ");
  return t("schedule_daily");
}

function habitSummary(habit) {
  return el("p", { class: "item-marks" }, [
    mark(habitKind(habit)),
    canSchedule(habit) ? mark(scheduleText(habit)) : null,
    habit.time ? mark(habit.time) : null,
    groupOf(habit) ? mark(groupOf(habit)) : null,
  ]);
}

const labelled = (label, input, after = "") =>
  el("label", { class: "meta-group" }, [el("span", { class: "meta-label", textContent: label }), input, after ? el("span", { class: "meta-label", textContent: after }) : null]);

// Asks once a day per habit how far back a rule change reaches.
function patchRules(habit, patch) {
  const picked = ui.rulesPicked[habit.id];
  if (!asksRuleChoice(habit, patch, today())) return commitRules(habit, patch, "today");
  if (picked?.day === today()) return commitRules(habit, patch, picked.scope);
  ui.rulePrompt = { id: habit.id, patch };
  render();
}

function commitRules(habit, patch, scope) {
  const current = data().habits.find((h) => h.id === habit.id);
  if (!current) return;
  ui.rulePrompt = null;
  if (changesRules(current, patch)) ui.rulesPicked[habit.id] = { day: today(), scope };
  store.commit({ t: "habit", habit: withRules(current, patch, today(), scope) });
}

function rulePromptRow(habit) {
  const { patch } = ui.rulePrompt;
  const apply = (scope) => () => commitRules(habit, patch, scope);
  const cancel = () => {
    ui.rulePrompt = null;
    render();
  };
  return el("div", { class: "rule-prompt", role: "group", "aria-label": t("rulesPrompt") }, [
    el("p", { class: "hint", textContent: t("rulesPrompt") }),
    el("div", { class: "row" }, [
      el("button", { type: "button", class: "btn", "data-focus-key": `${habit.id}:rulesToday`, textContent: t("rulesFromToday"), onclick: apply("today") }),
      hasPastRules(habit) ? textButton(t("rulesSinceDate", { date: fmtDay(rulesSince(habit), longDay) }), apply("current"), { small: true }) : null,
      textButton(t("rulesAll"), apply("all"), { small: true }),
      textButton(t("cancel"), cancel, { small: true }),
    ]),
  ]);
}

function restoreHabit(habit) {
  const current = data().habits.find((h) => h.id === habit.id);
  if (current) commitAll(restoreOps(data(), current, today(), uid));
}

function editRow(habit) {
  const open = ui.openHabit === habit.id;
  const patch = (p, opts) => patchHabit(habit.id, p, opts);
  const patchRule = (p) => patchRules(habit, p);
  const peers = peersOf(habit);
  const at = peers.findIndex((h) => h.id === habit.id);
  const editorId = `habit-${habit.id}`;
  const toggle = el("button", {
    type: "button",
    class: "habit-toggle",
    "aria-expanded": String(open),
    "aria-controls": open ? editorId : null,
    "data-focus-key": `${habit.id}:toggle`,
    onclick: () => {
      ui.openHabit = open ? null : habit.id;
      ui.confirm = null;
      render();
    },
  }, [el("span", { class: "item-title", textContent: habitName(habit) }), icon(open ? "up" : "down")]);
  const head = el("div", { class: "edit-row" }, [
    toggle,
    el("div", { class: "item-actions" }, [
      habit.archived ? textButton(t("restore"), () => restoreHabit(habit), { small: true }) : null,
      iconButton("up", t("moveUp"), () => moveHabit(habit, -1), { disabled: at === 0, "data-focus-key": `${habit.id}:up` }),
      iconButton("down", t("moveDown"), () => moveHabit(habit, 1), { disabled: at === peers.length - 1, "data-focus-key": `${habit.id}:down` }),
    ]),
  ]);
  if (!open) return el("article", { class: "item", "data-id": habit.id }, [head, habitSummary(habit)]);

  const name = el("input", {
    class: "name-input",
    value: habit.name,
    placeholder: t("namePlaceholder"),
    "data-focus-key": `${habit.id}:name`,
    oninput: () => patch({ name: name.value }, { quiet: true }),
    onchange: () => render(),
    onkeydown: (e) => e.key === "Enter" && name.blur(),
  });
  const type = el(
    "select",
    { class: "pill-select", "data-focus-key": `${habit.id}:type`, onchange: () => patchRule({ type: type.value, target: DEFAULT_TARGET[type.value] }) },
    TYPES.map((k) => el("option", { value: k, textContent: t(`type_${k}`) })),
  );
  type.value = habit.type;
  const fields = [labelled(t("type"), type)];
  if (habit.type !== "check" && habit.type !== "avoid") {
    const target = el("input", {
      type: "number",
      class: "num-input",
      min: 1,
      step: "any",
      inputMode: "decimal",
      value: habit.target,
      "data-focus-key": `${habit.id}:target`,
      onchange: () => patchRule({ target: Number(target.value) > 0 ? Number(target.value) : 1 }),
    });
    fields.push(labelled(t("target"), target, t({ weekly: "timesWeek", monthly: "timesMonth", amount: "aDay", timer: "minDay" }[habit.type])));
  }
  if (habit.type === "amount") {
    const unit = el("input", {
      class: "unit-input",
      value: habit.unit,
      placeholder: t("unitPlaceholder"),
      "data-focus-key": `${habit.id}:unit`,
      oninput: () => patch({ unit: unit.value }, { quiet: true }),
      // Past amounts keep their numbers, so a new unit misreads them.
      onchange: () => habit.start < today() && habit.unit?.trim() && unit.value.trim() !== habit.unit.trim() && toast(t("unitChanged")),
    });
    fields.push(labelled(t("unit"), unit));
  }
  const start = el("input", {
    type: "date",
    value: habit.start,
    max: today(),
    "data-focus-key": `${habit.id}:start`,
    onchange: () => start.value && patch({ start: start.value }),
  });
  fields.push(labelled(t("since"), start));
  const time = el("input", {
    type: "time",
    value: habit.time ?? "",
    "data-focus-key": `${habit.id}:time`,
    onchange: () => patch({ time: time.value }),
  });
  fields.push(labelled(t("at"), time));
  if (canSchedule(habit)) fields.push(...scheduleFields(habit, patchRule));
  const group = el("input", {
    class: "unit-input",
    value: habit.group ?? "",
    placeholder: t("groupPlaceholder"),
    "data-focus-key": `${habit.id}:group`,
    oninput: () => patch({ group: group.value }, { quiet: true }),
    onchange: () => render(),
  });
  // `list` is read-only as a property.
  group.setAttribute("list", "groups");
  fields.push(labelled(t("group"), group));

  const archive = () => {
    const now = data().habits.find((h) => h.id === habit.id);
    ui.openHabit = null;
    undoable(t("archivedName", { name: habitName(now) }), archiveOps(now, today()), () => patchHabit(habit.id, { archived: false, archivedAt: undefined }));
  };
  const remove = () => {
    ui.openHabit = null;
    store.commit({ t: "delHabit", id: habit.id });
  };
  const confirmKey = `habit:${habit.id}`;
  const actions = ui.confirm === confirmKey
    ? confirmButtons(t("deleteConfirm", { name: habitName(habit) }), remove, render)
    : [
      habit.archived ? null : textButton(t("archive"), archive, { small: true }),
      textButton(t("deleteHabit"), () => setConfirm(confirmKey, render), { small: true, danger: true }),
    ];
  return el("article", { class: "item is-open", "data-id": habit.id }, [
    head,
    el("div", { class: "habit-editor", id: editorId }, [
      labelled(t("habitName"), name),
      el("div", { class: "item-meta" }, fields),
      ui.rulePrompt?.id === habit.id ? rulePromptRow(habit) : null,
      hasPastRules(habit) ? el("p", { class: "item-marks" }, [mark(t("rulesSinceMark", { date: fmtDay(rulesSince(habit), longDay) }))]) : null,
      el("div", { class: "row" }, actions),
    ]),
  ]);
}

function breakRow(item) {
  // Moving one end past the other drags the other along.
  const save = (patch) => {
    const next = { ...item, ...patch };
    // The mark covers the days its own habit was archived, so it does not follow the break to another one.
    if ("habitId" in patch && patch.habitId !== item.habitId) delete next.archived;
    if (next.to < next.from) Object.assign(next, patch.from ? { to: next.from } : { from: next.to });
    store.commit({ t: "break", break: next });
  };
  const who = el(
    "select",
    { class: "pill-select", "aria-label": t("habit"), "data-focus-key": `${item.id}:who`, onchange: () => save({ habitId: who.value }) },
    [el("option", { value: "", textContent: t("allHabits") }), ...habits().filter((h) => h.type !== "avoid" || h.id === item.habitId).map((h) => el("option", { value: h.id, textContent: habitName(h) }))],
  );
  who.value = item.habitId ?? "";
  const date = (field, labelKey, ariaKey) => {
    const input = el("input", {
      type: "date",
      value: item[field],
      "aria-label": t(ariaKey),
      "data-focus-key": `${item.id}:${field}`,
      onchange: () => input.value && save({ [field]: input.value }),
    });
    return el("span", { class: "meta-group" }, [el("span", { class: "meta-label", textContent: t(labelKey) }), input]);
  };
  return el("article", { class: "item", "data-id": item.id }, [
    el("div", { class: "edit-row" }, [
      el("div", { class: "item-meta" }, [who, date("from", "breakFrom", "breakStarts"), date("to", "breakTo", "breakEnds"), item.from <= today() && today() <= item.to ? mark(t("onBreak"), "yellow") : null]),
      el("div", { class: "item-actions" }, [iconButton("x", t("removeBreak"), () => undoable(t("breakRemoved"), [{ t: "delBreak", id: item.id }], () => store.commit({ t: "break", break: item })))]),
    ]),
  ]);
}

function templatePicker() {
  const select = el(
    "select",
    {
      class: "pill-select",
      "aria-label": t("templates"),
      "data-focus-key": "habits:template",
      onchange: () => {
        const template = TEMPLATES.find((x) => x.key === select.value);
        if (template) addHabit(template);
      },
    },
    [el("option", { value: "", textContent: t("fromTemplate") }), ...TEMPLATES.map((x) => el("option", { value: x.key, textContent: t(`tpl_${x.key}`) }))],
  );
  return select;
}

function habitsView() {
  const current = habits().filter((h) => !h.archived);
  const archived = habits().filter((h) => h.archived);
  const breaks = [...(data().breaks ?? [])].sort((a, b) => (a.from < b.from ? 1 : a.from > b.from ? -1 : 0));
  const addBreak = () => store.commit({ t: "break", break: { id: uid(), from: today(), to: addDays(today(), 6), habitId: "" } });
  return [
    el("datalist", { id: "groups" }, [...new Set(habits().map(groupOf).filter(Boolean))].map((name) => el("option", { value: name }))),
    lane("yellow", t("habits"), {
      count: current.length ? t("habits", { count: current.length }) : "",
      tools: [current.length ? templatePicker() : null, textButton(t("addHabit"), () => addHabit(), { plus: true })],
      rows: current.length ? current.map(editRow) : [startRow(() => addHabit(), t("habitsEmpty"))],
    }),
    habits().length ? lane("blue", t("breaks"), { tools: [textButton(t("addBreak"), addBreak, { plus: true })], rows: breaks.map(breakRow), empty: t("breaksEmpty") }) : null,
    archived.length ? lane("muted", t("archived"), { count: t("habits", { count: archived.length }), rows: archived.map(editRow) }) : null,
  ];
}

const currentView = () => (VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "today");

function render() {
  const view = currentView();
  for (const tab of document.querySelectorAll(".tab")) {
    if (tab.getAttribute("href") === `#${view}`) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }
  $("#today").textContent = fmtDay(today(), { weekday: "long", month: "long", day: "numeric" });

  // Settings are painted on the way in only: repainting while open would drop what is being typed there.
  const inSettings = view === "settings";
  $("#view").hidden = inSettings;
  $("#settings").hidden = !inSettings;
  const entering = inSettings && ui.shown !== "settings";
  ui.shown = view;
  if (inSettings) {
    ui.popped = null;
    if (entering) paintSettings();
    return;
  }

  const active = document.activeElement;
  const jump = Boolean(ui.focus);
  const focus = ui.focus ?? active?.dataset?.focusKey;
  let selection = null;
  if (!jump && active?.selectionStart != null) selection = [active.selectionStart, active.selectionEnd];
  ui.focus = null;

  const builders = { today: todayView, tasks: tasksView, progress: progressView, habits: habitsView };
  $("#view").replaceChildren(...builders[view]().filter(Boolean));
  ui.popped = null;
  for (const wrap of document.querySelectorAll(".heatmap-wrap")) wrap.scrollLeft = wrap.scrollWidth;

  const node = focus && document.querySelector(`[data-focus-key="${CSS.escape(focus)}"]`);
  if (node) {
    node.focus({ preventScroll: !jump });
    try {
      if (selection) node.setSelectionRange(...selection);
    } catch {
      /* number and date inputs have no selection */
    }
  }
}

// Worded when shown, so changing the language rewords a standing error.
function describe(err) {
  if (!err) return "";
  if (err.name === "OperationError") return t("errPassphrase");
  if (err.code) return t(err.code, { message: err.message });
  if (err instanceof TypeError) return t("errNetwork");
  return err.message || String(err);
}

function paintStatus() {
  const { state, err } = ui.status;
  const time = ui.syncedAt ? formatter(Intl.DateTimeFormat, { hour: "numeric", minute: "2-digit" }).format(ui.syncedAt) : "";
  const status = $("#sync");
  status.textContent = t(`status_${state}`, { time });
  status.dataset.tone = state === "error" ? "error" : state === "synced" ? "ok" : "";
  const banner = $("#banner");
  banner.hidden = state !== "error";
  banner.textContent = state === "error" ? describe(err) : "";
}

function showStatus(state, err = null) {
  if (err?.code === "errSignedOut") endSession();
  ui.status = { state, err };
  if (state === "synced") ui.syncedAt = new Date();
  paintStatus();
  if (state === "synced") refreshPublished();
}

// The server no longer knows this session; the device keeps its data until Sign out.
function endSession() {
  saveSecret(SESSION_KEY, "");
  paintSettings();
}

// The service worker words reminders, and can read neither localStorage nor these strings.
const tellWorker = () =>
  globalThis.caches?.open("habit-tracker-settings").then((cache) => cache.put("notification", Response.json({ title: t("title"), body: t("remindBody") }))).catch(() => {});

function changeLanguage(lang) {
  write(local, LANG_KEY, setLanguage(lang));
  tellWorker();
  formatters.clear();
  applyTranslations();
  paintSettings();
  render();
  paintStatus();
}

function exportData() {
  download(new Blob([JSON.stringify(data(), null, 2)], { type: "application/json" }), `habit-tracker-${today()}.json`);
}

async function importData(file) {
  const result = $("#importResult");
  result.hidden = false;
  let incoming;
  try {
    incoming = importFile(file.name, await file.text(), data(), { uid, today: today() });
  } catch (err) {
    result.textContent = err.code === "errImport" ? t("errImport") : describe(err);
    return;
  }
  const known = new Set(data().habits.map((h) => h.id));
  const { log } = data();
  const daysAdded = Object.entries(incoming.log).filter(([date, day]) => Object.keys(day).some((id) => !log[date]?.[id])).length;
  store.commit({ t: "import", data: incoming });
  // Synced, or folded into the device copy, right away: the edit holds the whole file until then.
  store.sync();
  const habitsAdded = t("importedHabits", { count: incoming.habits.filter((h) => !known.has(h.id)).length });
  result.textContent = `${habitsAdded} ${t("importedDays", { count: daysAdded })}`;
}

let googleReady = null;

function loadGoogle() {
  googleReady ??= new Promise((resolve, reject) => {
    document.head.append(el("script", { src: "https://accounts.google.com/gsi/client", async: true, onload: resolve, onerror: reject }));
  }).then(() => window.google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: onCredential }));
  googleReady.catch(() => {
    googleReady = null;
  });
  return googleReady;
}

async function renderGoogleButton() {
  const box = $("#googleButton");
  try {
    await loadGoogle();
  } catch {
    return showStatus("error", { code: "errNetwork" });
  }
  box.replaceChildren();
  window.google.accounts.id.renderButton(box, { theme: "outline", size: "large", text: "signin_with", width: 260, locale: getLanguage() });
}

// Read here only to name the account on the device; the server checks the token itself.
const claims = (credential) => JSON.parse(new TextDecoder().decode(fromB64url(credential.split(".")[1])));

let accountInfo = null;
// Another device may publish a link or add a passkey meanwhile, so the list is asked for again after this long.
const ACCOUNT_INFO_TTL = 120_000;

function forgetAccountInfo() {
  accountInfo = null;
  Object.assign(ui, { links: null, passkeys: null, sent: {} });
}

function loadAccountInfo() {
  if (accountInfo && Date.now() - accountInfo.at < ACCOUNT_INFO_TTL) return accountInfo.promise;
  const token = secret(SESSION_KEY);
  const promise = Promise.all([publishedLinks(token), passkeyCount(token)]).then(([links, passkeys]) => Object.assign(ui, { links, passkeys }));
  promise.catch(() => {
    if (accountInfo?.promise === promise) accountInfo = null;
  });
  accountInfo = { at: Date.now(), promise };
  return promise;
}

// However it is opened, an account is known on the device by the server's ID for it. Before the server sent
// that ID, a device knew a Google account by its Google ID.
function startAccount({ token, userId, googleSub, email }) {
  const sub = userId ? `id:${userId}` : googleSub;
  if (settings.sub && settings.sub !== sub) {
    if (googleSub && settings.sub === googleSub) store.rename(`account:${googleSub}`, `account:${sub}`);
    else {
      // Another person's passphrase must not seal this account's data.
      saveSecret(PASS_KEY, "");
      $("#passphrase").value = "";
    }
  }
  settings.sub = sub;
  saveSettings();
  saveSecret(SESSION_KEY, token);
  saveSecret(EMAIL_KEY, email);
  forgetAccountInfo();
  paintSettings();
  if (!secret(PASS_KEY)) $("#passphrase").focus();
  store.sync();
}

async function onCredential({ credential }) {
  try {
    const { sub, email = "" } = claims(credential);
    startAccount({ googleSub: sub, ...(await signIn(credential)), email });
  } catch (err) {
    showStatus("error", { code: "errSignIn", message: describe(err) });
  }
}

// Closing the browser's passkey sheet is not an error.
const dismissed = (err) => err.name === "NotAllowedError" || err.name === "AbortError";

async function passkeyAccount(ceremony) {
  try {
    startAccount({ ...(await ceremony()), email: "" });
  } catch (err) {
    if (!dismissed(err)) showStatus("error", { code: "errSignIn", message: describe(err) });
  }
}

const inAccount = () => settings.mode === "account" && Boolean(secret(SESSION_KEY));
const sharing = () => data().share ?? null;
const shareUrl = () => `${new URL("share.html", location.href).href}#${ui.links.share}.${sharing().key}`;
// The time stamp is left out, so an unchanged feed reads the same.
const feedSource = () => toIcs(data(), new Date(0));
const feedBody = () => new TextEncoder().encode(toIcs(data()));
const remindSource = () => JSON.stringify(reminderTimes(activeHabits()));

function shareText({ ids, name }) {
  const shown = activeHabits().filter((h) => ids.includes(h.id));
  return JSON.stringify(sharedProgress(data(), shown, today(), name ?? "", (h) => rateOf(h, 30)));
}

// A link is brought up to date only while it is still published: a 404 means another device took it down.
async function refreshLink(kind, body) {
  try {
    await updateLink(kind, secret(SESSION_KEY), await body);
    return true;
  } catch (err) {
    if (err.status !== 404) throw err;
    delete ui.links[kind];
    return false;
  }
}

async function sendChanged(kind, source, send) {
  if (ui.sent[kind] === source) return;
  await send();
  ui.sent[kind] = source;
}

// After each sync what is published follows the data, sent only when what it is made from changed.
async function refreshPublished() {
  if (!inAccount()) return;
  try {
    await loadAccountInfo();
    const share = ui.links.share && sharing();
    const text = share && shareText(share);
    const steps = [
      ui.links.feed && sendChanged("feed", feedSource(), () => refreshLink("feed", feedBody())),
      share && sendChanged("share", `${share.key}:${text}`, () => refreshLink("share", sealWithKey(text, share.key))),
      settings.remind && canRemind() && sendChanged("remind", remindSource(), () => setDeviceReminders(secret(SESSION_KEY), reminderTimes(activeHabits()))),
    ];
    const failed = (await Promise.allSettled(steps)).find((step) => step.status === "rejected");
    if (failed) throw failed.reason;
  } catch (err) {
    ui.accountNote = describe(err);
  }
  if (!$("#settings").hidden) paintAccountOptions();
}

// Runs something from the account options, then repaints with what it said or how it failed.
async function accountAction(action) {
  ui.accountNote = "";
  try {
    ui.accountNote = (await action()) ?? "";
  } catch (err) {
    if (!dismissed(err)) ui.accountNote = err.name === "OperationError" ? t("errRecovery") : describe(err);
  }
  paintSettings();
}

// Only turning sharing on publishes a link; a change updates one still published, so a device behind cannot
// bring back a link taken down elsewhere.
async function setShare(share, { create = false } = {}) {
  const text = shareText(share);
  const body = await sealWithKey(text, share.key);
  if (create) ui.links.share = (await publishLink("share", secret(SESSION_KEY), body)).token;
  else if (!(await refreshLink("share", body))) return;
  ui.sent.share = `${share.key}:${text}`;
  store.commit({ t: "share", share });
}

const TOGGLES = {
  feed: async (on) => {
    if (on) {
      ui.links.feed = (await publishLink("feed", secret(SESSION_KEY), feedBody())).token;
      ui.sent.feed = feedSource();
    } else {
      await removeLink("feed", secret(SESSION_KEY));
      delete ui.links.feed;
    }
  },
  share: async (on) => {
    if (on) return setShare(sharing() ?? { key: newKey(), ids: activeHabits().map((h) => h.id), name: "" }, { create: true });
    await removeLink("share", secret(SESSION_KEY));
    delete ui.links.share;
    store.commit({ t: "share", share: null });
  },
  remind: async (on) => {
    if (on) await setDeviceReminders(secret(SESSION_KEY), reminderTimes(activeHabits()));
    else await stopDeviceReminders(secret(SESSION_KEY));
    ui.sent.remind = on ? remindSource() : undefined;
    settings.remind = on;
    saveSettings();
  },
};

// A sync with nothing new never decrypts, so the passphrase is checked against the data before it gets a key:
// a mistyped one would replace the good key.
async function makeRecovery() {
  await store.sync();
  if (ui.status.state !== "synced") return t("recoveryNeedsSync");
  if (!(await store.opens())) return t("errPassphrase");
  const code = newRecoveryCode();
  await saveRecovery(secret(SESSION_KEY), await wrap(secret(PASS_KEY), code));
  return t("recoveryMade", { code: formatCode(code) });
}

async function useRecovery(code) {
  let sealed;
  try {
    sealed = await readRecovery(secret(SESSION_KEY));
  } catch (err) {
    if (err.status === 404) return t("noRecovery");
    throw err;
  }
  const passphrase = await unwrap(sealed, cleanCode(code));
  $("#passphrase").value = passphrase;
  saveSecret(PASS_KEY, passphrase);
  ui.recovering = false;
  store.sync();
  return t("recovered");
}

async function addPasskey() {
  await createPasskey(secret(SESSION_KEY));
  ui.passkeys = { ...ui.passkeys, count: ui.passkeys.count + 1 };
  return t("passkeyAdded");
}

async function dropPasskeys() {
  const before = ui.passkeys.count;
  ui.passkeys = { ...ui.passkeys, ...(await removePasskeys(secret(SESSION_KEY))) };
  return t("passkeysRemoved", { count: before - ui.passkeys.count });
}

function paintPasskeyButtons() {
  $("#passkeyButtons").hidden = inAccount() || settings.mode !== "account" || !window.PublicKeyCredential;
  $("#passkeyButtons").replaceChildren(
    textButton(t("passkeySignIn"), () => passkeyAccount(usePasskey), { small: true }),
    textButton(t("passkeyNew"), () => passkeyAccount(createPasskey), { small: true }),
  );
}

function paintAccountOptions() {
  const box = $("#accountOptions");
  if (!inAccount()) return box.replaceChildren();
  if (!ui.links) {
    loadAccountInfo().then(paintAccountOptions, () => {});
    return box.replaceChildren();
  }
  const toggle = (label, checked, onchange) => el("label", { class: "check" }, [el("input", { type: "checkbox", checked, onchange }), el("span", { textContent: label })]);
  const address = (url) => el("input", { readOnly: true, value: url, "aria-label": t("linkAddress"), onfocus: (e) => e.target.select() });
  const hint = (text) => el("p", { class: "hint", textContent: text });
  const publish = (kind) => (e) => accountAction(() => TOGGLES[kind](e.target.checked));
  // A passkey-only account keeps the passkey it is signed in with.
  const { count, google } = ui.passkeys;
  const share = ui.links.share && sharing();
  const rows = [
    el("div", { class: "row" }, [
      window.PublicKeyCredential ? textButton(t("addPasskey"), () => accountAction(addPasskey), { small: true }) : null,
      count > (google ? 0 : 1) ? textButton(t(google ? "removePasskeys" : "removeOtherPasskeys"), () => accountAction(dropPasskeys), { small: true }) : null,
      textButton(t("newRecovery"), () => accountAction(makeRecovery), { small: true }),
    ]),
    toggle(t("feedToggle"), Boolean(ui.links.feed), publish("feed")),
    ...(ui.links.feed ? [address(feedUrl(ui.links.feed)), hint(t("feedHint"))] : []),
    toggle(t("shareToggle"), Boolean(share), publish("share")),
  ];
  if (share) {
    const name = el("input", {
      value: share.name ?? "",
      maxLength: 60,
      placeholder: t("shareName"),
      "aria-label": t("shareName"),
      onchange: () => accountAction(() => setShare({ ...share, name: name.value.trim() })),
    });
    const pick = (id, shown) => accountAction(() => setShare({ ...share, ids: shown ? [...share.ids, id] : share.ids.filter((x) => x !== id) }));
    rows.push(address(shareUrl()), hint(t("shareHint")), name, el("div", { class: "row" }, activeHabits().map((h) => toggle(habitName(h), share.ids.includes(h.id), (e) => pick(h.id, e.target.checked)))));
  }
  if (canRemind()) rows.push(toggle(t("remindToggle"), Boolean(settings.remind), publish("remind")), hint(t("remindHint")));
  if (ui.accountNote) rows.push(el("p", { class: "hint", role: "status", textContent: ui.accountNote }));
  box.replaceChildren(...rows);
}

function paintRecovery() {
  const code = el("input", { placeholder: t("recoveryCode"), "aria-label": t("recoveryCode"), autocomplete: "off", spellcheck: false });
  $("#recoveryBox").hidden = !inAccount();
  $("#recoveryBox").replaceChildren(
    ...(ui.recovering
      ? [code, el("button", { type: "button", class: "btn", textContent: t("recover"), onclick: () => accountAction(() => useRecovery(code.value)) })]
      : [textButton(t("forgot"), () => {
        ui.recovering = true;
        paintSettings();
      }, { small: true })]),
  );
}

async function signOutAccount() {
  if (store.hasPending() && ui.confirm !== "signOut") {
    await store.sync();
    if (store.hasPending()) return setConfirm("signOut", paintSettings);
  }
  const token = secret(SESSION_KEY);
  // Reminders belong to this browser, so they stop with the session.
  if (token && settings.remind && canRemind()) await stopDeviceReminders(token).catch(() => {});
  clearDevice();
  if (token) signOut(token).catch(() => {});
}

// Leaves nothing of the account on this device: data, passphrase, email and sign-in.
function clearDevice() {
  ui.confirm = null;
  store.reset();
  for (const key of SECRET_KEYS) saveSecret(key, "");
  $("#passphrase").value = "";
  forgetAccountInfo();
  ui.accountNote = "";
  settings.remind = false;
  settings.sub = "";
  saveSettings();
  paintSettings();
  store.sync();
}

async function removeAccount() {
  try {
    await deleteAccount(secret(SESSION_KEY));
  } catch (err) {
    return showStatus("error", err);
  }
  clearDevice();
}

function paintSettings() {
  const mode = settings.mode;
  const signedIn = Boolean(secret(SESSION_KEY));
  const email = secret(EMAIL_KEY);
  paintPasskeyButtons();
  paintAccountOptions();
  paintRecovery();
  $("#syncMode").value = mode;
  $("#noneHint").hidden = mode !== "none";
  $("#accountBlock").hidden = mode !== "account";
  $("#passphraseBlock").hidden = mode === "none";
  $("#accountHint").hidden = signedIn;
  $("#googleButton").hidden = signedIn;
  // An account's data stays on the device after its session ends, so Sign out stays reachable.
  $("#signedIn").hidden = !settings.sub;
  $("#signedInAs").textContent = email ? t(signedIn ? "signedInAs" : "sessionEnded", { email }) : t(signedIn ? "signedInPasskey" : "accountOnDevice");
  const actions = {
    signOut: () => confirmButtons(t("signOutDiscard"), signOutAccount, paintSettings),
    deleteAccount: () => confirmButtons(t("deleteAccountConfirm"), removeAccount, paintSettings),
  }[ui.confirm];
  $("#accountActions").replaceChildren(
    ...(actions?.() ?? [
      el("button", { type: "button", class: "btn", textContent: t("signOut"), onclick: signOutAccount }),
      signedIn ? textButton(t("deleteAccount"), () => setConfirm("deleteAccount", paintSettings), { small: true }) : null,
    ]).filter(Boolean),
  );
  // Google's script loads only once someone looks at the sign-in, not on every visit.
  if (mode === "account" && !signedIn && !$("#settings").hidden) renderGoogleButton();
}

function initSettings() {
  const passphrase = $("#passphrase");
  const remember = $("#remember");
  passphrase.value = secret(PASS_KEY);
  remember.checked = settings.remember;

  $("#syncMode").addEventListener("change", (e) => {
    settings.mode = e.target.value;
    ui.confirm = null;
    saveSettings();
    paintSettings();
    store.sync();
  });
  // Saved once typing ends: a save in the middle could seal new data with half a passphrase.
  passphrase.addEventListener("change", () => saveSecret(PASS_KEY, passphrase.value));
  remember.addEventListener("change", () => {
    settings.remember = remember.checked;
    saveSettings();
    for (const key of SECRET_KEYS) saveSecret(key, secret(key));
  });
  passphrase.addEventListener("change", () => store.sync());
  $("#syncNow").addEventListener("click", () => store.sync());
  $("#forget").addEventListener("click", () => {
    passphrase.value = "";
    saveSecret(PASS_KEY, "");
    store.sync();
  });
  $("#exportData").addEventListener("click", exportData);
  $("#exportMetrics").addEventListener("click", exportMetrics);
  $("#calendarFile").addEventListener("click", () => download(new Blob([toIcs(data())], { type: "text/calendar" }), "habit-tracker.ics"));
  const picker = $("#importFile");
  $("#importData").addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => {
    const [file] = picker.files;
    picker.value = "";
    if (file) importData(file);
  });
  initInstall();

  paintSettings();
  // An account that cannot sync yet opens on its settings, unless the address asked for a view.
  if (settings.mode !== "none" && !config().ready && !location.hash) history.replaceState(null, "", "#settings");
}

// Arrow keys step through the days on Today, unless focus is somewhere they already mean something.
function stepDays(e) {
  if (currentView() !== "today" || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return;
  if (e.target.closest?.("input, select, textarea, [contenteditable], [role=group]")) return;
  const now = today();
  if (e.key === "ArrowLeft") ui.day = addDays(ui.day, -1);
  else if (e.key === "ArrowRight" && ui.day < now) ui.day = addDays(ui.day, 1);
  else return;
  e.preventDefault();
  render();
}

// Only browsers that fire beforeinstallprompt can install from a button; the rest use their own menu.
function initInstall() {
  const button = $("#installApp");
  let prompt = null;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    prompt = event;
    button.hidden = false;
  });
  window.addEventListener("appinstalled", () => (button.hidden = true));
  button.addEventListener("click", async () => {
    if (!prompt) return;
    prompt.prompt();
    await prompt.userChoice;
    prompt = null;
    button.hidden = true;
  });
}

$("#language").value = startLanguage(read(local, LANG_KEY));
tellWorker();
$("#language").addEventListener("change", (e) => changeLanguage(e.target.value));
applyTranslations();
initSettings();
document.addEventListener("keydown", stepDays);
window.addEventListener("hashchange", () => {
  ui.confirm = null;
  render();
  window.scrollTo(0, 0);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") {
    if (store.hasPending()) store.sync();
    return;
  }
  if (ui.day === ui.lastSeenDay) ui.day = today();
  ui.lastSeenDay = today();
  render();
  store.refresh();
});
// A timer started or stopped in another tab.
window.addEventListener("storage", (e) => {
  if (e.key !== TIMER_KEY) return;
  ui.timer = loadTimer();
  render();
});
setInterval(() => {
  const node = ui.timer && document.querySelector("[data-timer]");
  if (node) node.textContent = timerLabel();
}, 1000);
navigator.serviceWorker?.register("sw.js").catch(() => {});
paintStatus();
await store.ready();
render();
store.sync();
