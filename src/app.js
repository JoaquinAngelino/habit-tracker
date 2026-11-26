import { $, el, icon, iconButton } from "./ui.js";
import { TYPES, KINDS, REPEATS, sortTasks, localIso, addDays, weekStart, uid, entry, note, isDone, isAmount, periodCount, streak, rate, level, goalProgress, canSchedule, isSkipped, isPaused, isOff, nextDue } from "./lib.js";
import { weekdayPattern, correlations, moodLinks, weekReview, yearRecap } from "./insights.js";
import { toIcs } from "./ics.js";
import { importFile } from "./importer.js";
import { drawCard } from "./share.js";
import { createStore } from "./store.js";
import { local, session, read, write } from "./storage.js";
import { fromB64, wrap, unwrap } from "./crypto.js";
import { DEFAULT_BRANCH } from "./github.js";
import { t, setLanguage, getLanguage, applyTranslations } from "./i18n.js";
import { GOOGLE_CLIENT_ID, signIn, signOut, deleteAccount, publishLink, removeLink, feedUrl, saveRecovery, readRecovery } from "./server.js";
import { buildShare, randomKey, newRecoveryCode, cleanCode, formatCode, utcMinutes, canRemind, syncReminders, createPasskey, usePasskey } from "./extras.js";

const CONFIG_KEY = "ht.config";
const TOKEN_KEY = "ht.token";
const PASS_KEY = "ht.passphrase";
const SESSION_KEY = "ht.session";
const EMAIL_KEY = "ht.email";
const SECRET_KEYS = [TOKEN_KEY, PASS_KEY, SESSION_KEY, EMAIL_KEY];
const MODES = ["account", "github", "none"];
const LANG_KEY = "ht.lang";
const VIEWS = ["today", "tasks", "progress", "habits"];
const TIMER_KEY = "ht.timer";
const DEFAULT_TARGET = { check: 1, weekly: 3, monthly: 8, amount: 1, timer: 20, avoid: 1 };
const HEATMAP_WEEKS = 53;
const SHARE_WEEKS = 26;
const MOODS = [1, 2, 3, 4, 5];
const MAX_TIMER_MINUTES = 24 * 60;
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
  week: 0,
  year: null,
  timer: loadTimer(),
  extraNote: "",
  recovering: false,
  published: {},
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
  const defaults = { repo: "", branch: DEFAULT_BRANCH, remember: true, sub: "" };
  let saved = {};
  try {
    saved = JSON.parse(read(local, CONFIG_KEY) ?? "{}") ?? {};
  } catch {
    /* start from the defaults */
  }
  // Before sync modes existed, a saved repository meant GitHub sync.
  const mode = MODES.includes(saved.mode) ? saved.mode : saved.repo ? "github" : "none";
  return { ...defaults, ...saved, mode };
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

function config() {
  const passphrase = secret(PASS_KEY);
  if (settings.mode === "account") {
    const token = secret(SESSION_KEY);
    return { mode: "account", target: `account:${settings.sub}`, session: token, passphrase, ready: Boolean(settings.sub && token && passphrase) };
  }
  if (settings.mode === "github") {
    const repo = settings.repo.trim();
    const branch = settings.branch.trim() || DEFAULT_BRANCH;
    const token = secret(TOKEN_KEY);
    return { mode: "github", target: `github:${repo}@${branch}`, repo, branch, token, passphrase, ready: Boolean(repo && token && passphrase) };
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
const byTime = (list) => [...list].sort((a, b) => ((a.time || "~") < (b.time || "~") ? -1 : (a.time || "~") > (b.time || "~") ? 1 : 0));

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
const streakOf = (habit) => remember(habit, "streak", () => streak(data(), habit, today()));
const rateOf = (habit, days) => remember(habit, `rate${days}`, () => rate(data(), habit, today(), days));

function streakText(habit, s) {
  if (habit.type === "avoid") return t("clean", { units: units(s.current, "day") });
  return s.current ? t("streak", { units: units(s.current, s.unit) }) : t("noStreak");
}

function goalUnit(habit) {
  if (isAmount(habit)) return unitOf(habit) || t("unit_total");
  return t(habit.type === "avoid" ? "unit_clean" : "unit_times");
}

const mark = (text, tone) => el("span", { class: "mark", "data-tone": tone, textContent: text });

function textButton(label, onclick, { small = false, plus = false, danger = false } = {}) {
  return el("button", { type: "button", class: `btn-text${small ? " btn-small" : ""}${danger ? " btn-danger" : ""}`, onclick }, [
    plus ? icon("plus") : null,
    el("span", { textContent: label }),
  ]);
}

// With nothing to say when empty, an empty lane is only its heading.
function lane(tone, title, { count = "", tools = [], rows, empty }) {
  return el("section", { class: "lane", "data-tone": tone }, [
    el("div", { class: "lane-head" }, [
      el("h2", { class: "lane-title", textContent: title }),
      count ? el("span", { class: "lane-count", textContent: count }) : null,
      el("span", { class: "lane-tools" }, tools),
    ]),
    el("div", { class: "rows" }, rows.length || empty == null ? rows : [el("p", { class: "lane-empty" }, [].concat(empty))]),
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

const firstHabitLink = () => [`${t("noHabits")} `, el("a", { href: "#habits", textContent: t("addFirst") }), "."];

function setLog(habit, date, value) {
  store.commit({ t: "log", date, id: habit.id, v: value > 0 ? value : 0 });
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
    class: `tape item-tape${task.done ? " is-done" : ""}`,
    "aria-pressed": String(Boolean(task.done)),
    title: t(task.done ? "markUndone" : "markDone"),
    "data-focus-key": `${task.id}:tape`,
    textContent: t(task.done ? "tape_done" : "tape_todo"),
    onclick: () => toggleTask(task),
  });
}

// Finishing a repeating task leaves it done and opens its next one, with the steps to do again.
function toggleTask(task) {
  if (task.done) return patchTask(task.id, { done: "" });
  if (task.repeat) {
    const next = { ...task, id: uid(), due: nextDue(task.due, task.repeat, today()), created: today() };
    if (task.steps) next.steps = task.steps.map((s) => ({ ...s, id: uid(), done: false }));
    store.commit({ t: "task", task: next }, { quiet: true });
  }
  patchTask(task.id, { done: today(), repeat: "" });
}

function stepsMark(task) {
  const steps = task.steps ?? [];
  return steps.length ? mark(t("stepsDone", { done: steps.filter((s) => s.done).length, total: steps.length })) : null;
}

function stepRows(task) {
  const steps = task.steps ?? [];
  const save = (next, opts) => patchTask(task.id, { steps: next }, opts);
  const change = (id, patch) => steps.map((s) => (s.id === id ? { ...s, ...patch } : s));
  return steps.map((step) => {
    const check = el("input", {
      type: "checkbox",
      checked: Boolean(step.done),
      "aria-label": t("stepDone"),
      "data-focus-key": `${step.id}:done`,
      onchange: () => save(change(step.id, { done: check.checked })),
    });
    const title = el("input", {
      class: "title-input",
      value: step.title,
      placeholder: t("stepPlaceholder"),
      "aria-label": t("stepPlaceholder"),
      "data-focus-key": `${step.id}:title`,
      onchange: () => save(change(step.id, { title: title.value })),
      onkeydown: (e) => e.key === "Enter" && title.blur(),
    });
    return el("div", { class: `step${step.done ? " is-closed" : ""}` }, [check, title, iconButton("x", t("removeStep"), () => save(steps.filter((s) => s.id !== step.id)))]);
  });
}

function addStep(task) {
  const id = uid();
  ui.focus = `${id}:title`;
  patchTask(task.id, { steps: [...(task.steps ?? []), { id, title: "", done: false }] });
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
      el("p", { class: "item-marks" }, [mark(t(`kind_${task.kind}`)), dueMark(task), task.repeat ? mark(t(`every_${task.repeat}`)) : null, stepsMark(task)]),
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
    onchange: () => patchTask(task.id, { due: due.value }),
  });
  const repeat = el(
    "select",
    { class: "pill-select", "aria-label": t("taskRepeat"), "data-focus-key": `${task.id}:repeat`, onchange: () => patchTask(task.id, { repeat: repeat.value }) },
    REPEATS.map((k) => el("option", { value: k, textContent: t(`every_${k || "none"}`) })),
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
    side: el("div", { class: "item-x" }, [iconButton("x", t("deleteTask"), () => store.commit({ t: "delTask", id: task.id }))]),
    after: steps.length ? [el("div", { class: "steps" }, steps)] : [],
  });
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
  const clear = ui.confirm === "done"
    ? confirmButtons(t("clearConfirm", { count: done.length }), () => store.commit({ t: "delTasks", ids: done.map((x) => x.id) }), render)
    : [textButton(t("clearDone"), () => setConfirm("done", render), { small: true })];
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
    done.length ? lane("muted", t("doneTasks"), { count: String(done.length), tools: [more, ...clear], rows: listed.map(taskRow) }) : null,
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
  const tone = TAPE_TONES[state];
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
  return el("button", {
    type: "button",
    class: `tape item-tape${tone}`,
    "aria-pressed": String(state === "slipped" || state === "done"),
    title: t(TAPE_TITLES[state]),
    "data-focus-key": `${habit.id}:tape`,
    textContent: t(`tape_${state}`) + (value > 1 ? ` ×${value}` : ""),
    onclick: () => setLog(habit, day, value ? 0 : 1),
  });
}

const clock = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
const timerLabel = () => t("stopTimer", { time: clock(Date.now() - ui.timer.at) });

function saveTimer(timer) {
  ui.timer = timer;
  write(local, TIMER_KEY, timer ? JSON.stringify(timer) : null);
}

// Logged on the day it started, to the nearest minute; a timer that ran at all counts for one.
function stopTimer() {
  const timer = ui.timer;
  if (!timer) return;
  saveTimer(null);
  const habit = habits().find((h) => h.id === timer.id);
  if (!habit) return render();
  const minutes = Math.min(MAX_TIMER_MINUTES, Math.max(1, Math.round((Date.now() - timer.at) / 60000)));
  setLog(habit, timer.day, entry(data(), habit.id, timer.day) + minutes);
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

function offMark(d, habit, day) {
  if (isSkipped(d, habit.id, day)) return t("skipped");
  return t(isPaused(d, habit, day) ? "onBreak" : "notScheduled");
}

function todayRow(habit, day) {
  const d = data();
  const value = entry(d, habit.id, day);
  const s = streakOf(habit);
  const marks = [habit.time ? mark(habit.time) : null, mark(streakText(habit, s), s.current ? "green" : null)];
  if (s.best > s.current) marks.push(mark(t("best", { units: units(s.best, s.unit) })));
  if (habit.type === "weekly" || habit.type === "monthly") {
    marks.push(mark(t(habit.type === "weekly" ? "thisWeek" : "thisMonth", { count: periodCount(d, habit, day), target: habit.target })));
  }
  if (isAmount(habit) && unitOf(habit)) marks.push(mark(unitOf(habit)));
  const off = isOff(d, habit, day);
  if (!value && off) marks.push(mark(offMark(d, habit, day)));
  if (isSkipped(d, habit.id, day)) marks.push(textButton(t("undoSkip"), () => setSkip(habit, day, false), { small: true }));
  else if (canSchedule(habit) && !isDone(habit, value) && !off) marks.push(textButton(t("skip"), () => setSkip(habit, day, true), { small: true }));

  const text = note(d, habit.id, day);
  const noteKey = `${habit.id}:note`;
  const openKey = `${habit.id}:${day}`;
  const setNote = (v, opts) => store.commit({ t: "note", date: day, id: habit.id, v }, opts);
  let noteInput = null;
  if (text || ui.noteOpen === openKey) {
    noteInput = el("input", {
      class: "title-input note-input",
      value: text,
      maxLength: 500,
      placeholder: t("notePlaceholder"),
      "aria-label": t("noteFor", { name: habitName(habit) }),
      "data-focus-key": noteKey,
      oninput: () => setNote(noteInput.value, { quiet: true }),
      onchange: () => {
        if (noteInput.value.trim()) return;
        ui.noteOpen = null;
        setNote("");
      },
      onkeydown: (e) => e.key === "Enter" && noteInput.blur(),
    });
  } else {
    marks.push(textButton(t("addNote"), () => {
      ui.noteOpen = openKey;
      ui.focus = noteKey;
      render();
    }, { small: true }));
  }

  const actions = [];
  if (habit.type === "timer") {
    if (day === today()) actions.push(timerButton(habit));
  } else if (habit.type === "amount" || habit.type === "weekly" || habit.type === "monthly") {
    actions.push(
      iconButton("minus", t("oneLess"), () => setLog(habit, day, Math.max(0, value - 1)), { disabled: !value }),
      iconButton("plus", t("oneMore"), () => setLog(habit, day, value + 1)),
    );
  }
  return itemRow({
    id: habit.id,
    tape: todayTape(habit, day, value),
    body: [el("p", { class: "item-title", textContent: habitName(habit) }), el("p", { class: "item-marks" }, marks), noteInput],
    side: actions.length ? el("div", { class: "item-actions" }, actions) : null,
  });
}

// A group of habits, such as a morning routine, listed together in the order they are done.
function groupLane(name, list, day) {
  const d = data();
  const done = list.filter((h) => isDone(h, entry(d, h.id, day))).length;
  const todo = list.filter((h) => h.type === "check" && !entry(d, h.id, day));
  return lane("green", name, {
    count: t("doneCount", { done, total: list.length }),
    tools: todo.length > 1 ? [textButton(t("doAll"), () => todo.forEach((h) => setLog(h, day, 1)), { small: true })] : [],
    rows: list.map((h) => todayRow(h, day)),
  });
}

function dayLane(day) {
  const current = data().days?.[day] ?? {};
  const set = (patch, opts) => store.commit({ t: "day", date: day, day: { ...(data().days?.[day] ?? {}), ...patch } }, opts);
  const scale = (field, label) => el("span", { class: "days", role: "group", "aria-label": t(field) }, MOODS.map((m) =>
    el("button", {
      type: "button",
      class: "day",
      "aria-pressed": String(current[field] === m),
      "aria-label": label(m),
      title: label(m),
      "data-focus-key": `day:${field}${m}`,
      textContent: String(m),
      onclick: () => set({ [field]: current[field] === m ? 0 : m }),
    })));
  const moods = scale("mood", (m) => t(`mood_${m}`));
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
          moods,
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

function todayView() {
  const day = ui.day;
  const now = today();
  const started = byTime(activeHabits().filter((h) => h.start <= day));
  // A day off still lists the habit, apart, so it can be logged anyway; logging moves it back.
  const off = started.filter((h) => !entry(data(), h.id, day) && isOff(data(), h, day));
  const due = started.filter((h) => !off.includes(h));
  const done = due.filter((h) => isDone(h, entry(data(), h.id, day))).length;
  const groups = [...new Set(due.map(groupOf).filter(Boolean))];
  const go = (to) => {
    ui.day = to;
    render();
  };
  return [
    lane("green", day === now ? t("today") : fmtDay(day), {
      count: due.length ? t("doneCount", { done, total: due.length }) : "",
      tools: [
        day !== now ? textButton(t("backToday"), () => go(now), { small: true }) : null,
        iconButton("left", t("prevDay"), () => go(addDays(day, -1))),
        iconButton("right", t("nextDay"), () => go(addDays(day, 1)), { disabled: day >= now }),
      ],
      rows: due.filter((h) => !groupOf(h)).map((h) => todayRow(h, day)),
      empty: groups.length ? null : !activeHabits().length ? firstHabitLink() : started.length ? t("allOff") : t("noneStarted"),
    }),
    ...groups.map((name) => groupLane(name, due.filter((h) => groupOf(h) === name), day)),
    off.length ? lane("muted", t("dayOff"), { count: t("habits", { count: off.length }), rows: off.map((h) => todayRow(h, day)) }) : null,
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
    side: el("div", { class: "item-x" }, [iconButton("x", t("removeGoal"), () => store.commit({ t: "delGoal", id: goal.id }))]),
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
  const cells = [];
  for (let i = 0; i < HEATMAP_WEEKS * 7; i++) {
    const date = addDays(first, i);
    const lvl = date > now ? null : level(d, habit, date, now) ?? "before";
    const text = lvl == null || lvl === "before" ? "" : `${fmtDay(date)}: ${cellText(habit, entry(d, habit.id, date), lvl)}`;
    cells.push(el("span", { class: "cell", "data-level": lvl ?? "none", title: text }));
  }
  return el("div", { class: "heatmap-wrap" }, [
    el("div", { class: "heatmap", role: "img", "aria-label": t("heatmapLabel", { name: habitName(habit) }) }, cells),
  ]);
}

function pattern(habit) {
  const rates = remember(habit, "pattern", () => weekdayPattern(data(), habit, today()));
  if (rates.every((r) => r == null)) return null;
  return el("div", { class: "pattern", role: "img", "aria-label": t("byWeekday"), title: t("byWeekday") }, rates.map((r, i) =>
    el("span", { class: "pattern-day", title: `${weekdayName(i, "long")}: ${percent(r)}` }, [
      el("span", { class: "pattern-track" }, [el("span", { class: "pattern-bar", style: `height:${Math.round((r ?? 0) * 100)}%` })]),
      el("span", { class: "pattern-label", textContent: weekdayName(i, "narrow") }),
    ])));
}

function download(blob, name) {
  const link = el("a", { href: URL.createObjectURL(blob), download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

// Shared through the system sheet where the browser can share files, downloaded otherwise.
async function shareCard(habit) {
  const s = streakOf(habit);
  const now = today();
  const css = getComputedStyle(document.documentElement);
  const first = addDays(weekStart(now), -7 * (SHARE_WEEKS - 1));
  const canvas = drawCard({
    name: habitName(habit),
    label: t(habit.type === "avoid" ? "cleanLabel" : "streakLabel"),
    big: units(s.current, s.unit),
    lines: [`${t("bestLabel")}: ${units(s.best, s.unit)}`, `${t("last30")}: ${percent(rateOf(habit, 30))}`],
    cells: Array.from({ length: SHARE_WEEKS * 7 }, (_, i) => (addDays(first, i) > now ? null : level(data(), habit, addDays(first, i), now))),
    footer: t("title"),
    colors: Object.fromEntries(["panel", "ink", "muted", "green", "red"].map((name) => [name, css.getPropertyValue(`--${name}`).trim()])),
  });
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return;
  const file = new File([blob], "streak.png", { type: "image/png" });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: habitName(habit) });
    } catch {
      /* closed without sharing */
    }
    return;
  }
  download(blob, "streak.png");
}

const insight = (text) => el("article", { class: "item" }, [el("p", { class: "item-title", textContent: text })]);

function weekLane(active) {
  const now = today();
  const start = addDays(weekStart(now), -7 * ui.week);
  const week = weekReview(data(), active, start, now);
  const before = weekReview(data(), active, addDays(start, -7), now);
  const delta = week.rate != null && before.rate != null ? Math.round((week.rate - before.rate) * 100) : null;
  const short = { month: "short", day: "numeric" };
  const move = (n) => {
    ui.week += n;
    render();
  };
  const summary = el("article", { class: "item" }, [
    el("dl", { class: "stats stats-wide" }, [
      stat(t("completion"), percent(week.rate)),
      stat(t("vsLastWeek"), delta == null ? "–" : `${delta > 0 ? "+" : ""}${delta}%`),
      stat(t("tasksDoneLabel"), num(week.tasksDone)),
      stat(t("mood"), week.mood == null ? "–" : num(week.mood)),
    ]),
    el("p", { class: "item-marks" }, week.rows.map((r) => mark(`${habitName(r.habit)} ${num(r.done)}/${num(r.due)}`, r.done >= r.due ? "green" : null))),
  ]);
  return lane("green", t("weekReview"), {
    count: `${fmtDay(week.start, short)} – ${fmtDay(week.end, short)}`,
    tools: [iconButton("left", t("prevWeek"), () => move(1)), iconButton("right", t("nextWeek"), () => move(-1), { disabled: !ui.week })],
    rows: [summary],
  });
}

function patternsLane(active) {
  const now = today();
  const rows = [
    ...correlations(data(), active, now).map((c) => insight(t("corrWith", { a: habitName(c.a), b: habitName(c.b), withA: percent(c.withA), withoutA: percent(c.withoutA) }))),
    ...moodLinks(data(), active, now).map((m) => insight(t("moodLink", { habit: habitName(m.habit), done: num(m.done), missed: num(m.missed) }))),
  ];
  return lane("purple", t("patterns"), { rows, empty: t("patternsEmpty") });
}

function yearLane() {
  const now = today();
  const thisYear = Number(now.slice(0, 4));
  const year = ui.year ?? thisYear;
  const r = yearRecap(data(), habits(), year, now);
  const move = (n) => {
    ui.year = year + n;
    render();
  };
  const rows = [];
  if (r.checkins || r.tasksDone || r.slips) {
    rows.push(el("article", { class: "item" }, [
      el("dl", { class: "stats stats-wide" }, [
        stat(t("checkins"), num(r.checkins)),
        stat(t("activeDays"), num(r.activeDays)),
        stat(t("longestStreak"), r.streak ? units(r.streak.count, "day") : "–"),
        stat(t("tasksDoneLabel"), num(r.tasksDone)),
      ]),
      el("p", { class: "item-marks" }, [
        r.top ? mark(`${t("topHabit")}: ${habitName(r.top.habit)} · ${units(r.top.days, "day")}`, "green") : null,
        r.streak ? mark(`${t("longestStreak")}: ${habitName(r.streak.habit)}`) : null,
        ...r.totals.map((x) => mark(`${habitName(x.habit)}: ${num(x.total)} ${unitOf(x.habit)}`.trim())),
        r.mood == null ? null : mark(`${t("mood")}: ${num(r.mood)}`),
        r.slips ? mark(`${t("slipsLabel")}: ${num(r.slips)}`) : null,
      ]),
    ]));
  }
  return lane("yellow", t("yearTitle", { year }), {
    tools: [iconButton("left", t("prevYear"), () => move(-1)), iconButton("right", t("nextYear"), () => move(1), { disabled: year >= thisYear })],
    rows,
    empty: t("yearEmpty"),
  });
}

function statsRow(habit) {
  const s = streakOf(habit);
  let kind = t(`type_${habit.type}`);
  if (habit.type === "weekly") kind += ` · ${t("perWeek", { count: habit.target })}`;
  if (habit.type === "monthly") kind += ` · ${t("perMonth", { count: habit.target })}`;
  if (isAmount(habit)) kind += ` · ${t("perDayUnit", { count: num(habit.target), unit: unitOf(habit) })}`;
  return itemRow({
    id: habit.id,
    tape: el("span", { class: `tape item-tape${s.current ? " is-done" : ""}`, title: streakText(habit, s), textContent: t(`short_${s.unit}`, { count: s.current }) }),
    body: [el("p", { class: "item-title", textContent: habitName(habit) }), el("p", { class: "item-marks" }, [mark(kind), textButton(t("share"), () => shareCard(habit), { small: true })])],
    after: [
      el("dl", { class: "stats" }, [
        stat(t(habit.type === "avoid" ? "cleanLabel" : "streakLabel"), units(s.current, s.unit)),
        stat(t("bestLabel"), units(s.best, s.unit)),
        stat(t("last7"), percent(rateOf(habit, 7))),
        stat(t("last30"), percent(rateOf(habit, 30))),
        stat(t("last90"), percent(rateOf(habit, 90))),
      ]),
      pattern(habit),
      heatmap(habit),
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
  return [
    lane("purple", t("goals"), {
      count: goals.length ? t("goals", { count: goals.length }) : "",
      tools: active.length && !ui.goalDraft ? [textButton(t("addGoal"), () => startGoal(active), { plus: true })] : [],
      rows,
      empty: active.length ? t("noGoals") : t("addHabitFirst"),
    }),
    active.length ? weekLane(active) : null,
    lane("blue", t("stats"), { rows: active.map(statsRow), empty: firstHabitLink() }),
    active.length ? patternsLane(active) : null,
    habits().length ? yearLane() : null,
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
  store.commit({ t: "habit", habit });
}

// Unpicking the last day goes back to every day.
function dayPicker(habit, patch) {
  const chosen = habit.days ?? [];
  const toggle = (i) => patch({ days: chosen.includes(i) ? chosen.filter((x) => x !== i) : [...chosen, i].sort() });
  return el("span", { class: "days", role: "group", "aria-label": t("onDays") }, [0, 1, 2, 3, 4, 5, 6].map((i) =>
    el("button", {
      type: "button",
      class: "day",
      "aria-pressed": String(chosen.includes(i)),
      "aria-label": weekdayName(i, "long"),
      "data-focus-key": `${habit.id}:day${i}`,
      textContent: weekdayName(i, "narrow"),
      onclick: () => toggle(i),
    })));
}

const SCHEDULES = { daily: { days: [], every: 0 }, days: { days: [0, 1, 2, 3, 4], every: 0 }, every: { days: [], every: 2 } };

function scheduleFields(habit, patch) {
  const mode = habit.every > 1 ? "every" : habit.days?.length ? "days" : "daily";
  const select = el(
    "select",
    { class: "pill-select", "aria-label": t("schedule"), "data-focus-key": `${habit.id}:repeat`, onchange: () => patch(SCHEDULES[select.value]) },
    Object.keys(SCHEDULES).map((k) => el("option", { value: k, textContent: t(`repeat_${k}`) })),
  );
  select.value = mode;
  if (mode === "days") return [select, dayPicker(habit, patch)];
  if (mode === "daily") return [select];
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
  return [select, el("span", { class: "meta-group" }, [el("span", { class: "meta-label", textContent: t("everyN") }), every, el("span", { class: "meta-label", textContent: t("daysWord") })])];
}

// Swaps a habit with its neighbour in the list it is shown in.
function moveHabit(habit, step) {
  const peers = habits().filter((h) => Boolean(h.archived) === Boolean(habit.archived));
  const other = peers[peers.findIndex((h) => h.id === habit.id) + step];
  if (!other) return;
  const ids = data().habits.map((h) => h.id);
  const a = ids.indexOf(habit.id);
  const b = ids.indexOf(other.id);
  [ids[a], ids[b]] = [ids[b], ids[a]];
  ui.focus = `${habit.id}:${step < 0 ? "up" : "down"}`;
  store.commit({ t: "order", ids });
}

function editRow(habit) {
  const patch = (p, opts) => patchHabit(habit.id, p, opts);
  const name = el("input", {
    class: "title-input",
    value: habit.name,
    placeholder: t("namePlaceholder"),
    "aria-label": t("habitName"),
    "data-focus-key": `${habit.id}:name`,
    oninput: () => patch({ name: name.value }, { quiet: true }),
    onchange: () => render(),
    onkeydown: (e) => e.key === "Enter" && name.blur(),
  });
  const type = el(
    "select",
    { class: "pill-select", "aria-label": t("type"), "data-focus-key": `${habit.id}:type`, onchange: () => patch({ type: type.value, target: DEFAULT_TARGET[type.value] }) },
    TYPES.map((k) => el("option", { value: k, textContent: t(`type_${k}`) })),
  );
  type.value = habit.type;
  const fields = [type];
  if (habit.type !== "check" && habit.type !== "avoid") {
    const target = el("input", {
      type: "number",
      class: "num-input",
      min: 1,
      step: "any",
      inputMode: "decimal",
      value: habit.target,
      "aria-label": t("target"),
      "data-focus-key": `${habit.id}:target`,
      onchange: () => patch({ target: Number(target.value) > 0 ? Number(target.value) : 1 }),
    });
    fields.push(el("span", { class: "meta-group" }, [target, el("span", { class: "meta-label", textContent: t({ weekly: "timesWeek", monthly: "timesMonth", amount: "aDay", timer: "minDay" }[habit.type]) })]));
  }
  if (habit.type === "amount") {
    const unit = el("input", {
      class: "unit-input",
      value: habit.unit,
      placeholder: t("unitPlaceholder"),
      "aria-label": t("unit"),
      "data-focus-key": `${habit.id}:unit`,
      oninput: () => patch({ unit: unit.value }, { quiet: true }),
    });
    fields.push(unit);
  }
  const start = el("input", {
    type: "date",
    value: habit.start,
    max: today(),
    "aria-label": t("startDate"),
    "data-focus-key": `${habit.id}:start`,
    onchange: () => start.value && patch({ start: start.value }),
  });
  fields.push(el("span", { class: "meta-group" }, [el("span", { class: "meta-label", textContent: t("since") }), start]));
  const time = el("input", {
    type: "time",
    value: habit.time ?? "",
    "aria-label": t("timeOfDay"),
    "data-focus-key": `${habit.id}:time`,
    onchange: () => patch({ time: time.value }),
  });
  fields.push(el("span", { class: "meta-group" }, [el("span", { class: "meta-label", textContent: t("at") }), time]));
  if (canSchedule(habit)) fields.push(...scheduleFields(habit, patch));
  const group = el("input", {
    class: "unit-input",
    value: habit.group ?? "",
    placeholder: t("groupPlaceholder"),
    "aria-label": t("group"),
    "data-focus-key": `${habit.id}:group`,
    oninput: () => patch({ group: group.value }, { quiet: true }),
    onchange: () => render(),
  });
  // `list` is read-only as a property.
  group.setAttribute("list", "groups");
  fields.push(group);
  const peers = habits().filter((h) => Boolean(h.archived) === Boolean(habit.archived));
  const at = peers.findIndex((h) => h.id === habit.id);

  const confirmKey = `habit:${habit.id}`;
  const actions = ui.confirm === confirmKey
    ? confirmButtons(t("deleteConfirm"), () => store.commit({ t: "delHabit", id: habit.id }), render)
    : [
      iconButton("up", t("moveUp"), () => moveHabit(habit, -1), { disabled: at === 0, "data-focus-key": `${habit.id}:up` }),
      iconButton("down", t("moveDown"), () => moveHabit(habit, 1), { disabled: at === peers.length - 1, "data-focus-key": `${habit.id}:down` }),
      textButton(t(habit.archived ? "restore" : "archive"), () => patch({ archived: !habit.archived }), { small: true }),
      iconButton("x", t("deleteHabit"), () => setConfirm(confirmKey, render)),
    ];
  return el("article", { class: "item", "data-id": habit.id }, [
    el("div", { class: "edit-row" }, [name, el("div", { class: "item-actions" }, actions)]),
    el("div", { class: "item-meta" }, fields),
  ]);
}

function pauseRow(pause) {
  // Moving one end past the other drags the other along.
  const save = (patch) => {
    const next = { ...pause, ...patch };
    if (next.to < next.from) Object.assign(next, patch.from ? { to: next.from } : { from: next.to });
    store.commit({ t: "pause", pause: next });
  };
  const who = el(
    "select",
    { class: "pill-select", "aria-label": t("habit"), "data-focus-key": `${pause.id}:who`, onchange: () => save({ habitId: who.value }) },
    [el("option", { value: "", textContent: t("allHabits") }), ...habits().filter((h) => h.type !== "avoid").map((h) => el("option", { value: h.id, textContent: habitName(h) }))],
  );
  who.value = pause.habitId ?? "";
  const date = (field, label) => {
    const input = el("input", {
      type: "date",
      value: pause[field],
      "aria-label": t(label),
      "data-focus-key": `${pause.id}:${field}`,
      onchange: () => input.value && save({ [field]: input.value }),
    });
    return el("span", { class: "meta-group" }, [el("span", { class: "meta-label", textContent: t(label) }), input]);
  };
  return el("article", { class: "item", "data-id": pause.id }, [
    el("div", { class: "edit-row" }, [
      el("div", { class: "item-meta" }, [who, date("from", "breakFrom"), date("to", "breakTo"), pause.from <= today() && today() <= pause.to ? mark(t("onBreak"), "yellow") : null]),
      el("div", { class: "item-actions" }, [iconButton("x", t("removeBreak"), () => store.commit({ t: "delPause", id: pause.id }))]),
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
  const pauses = [...(data().pauses ?? [])].sort((a, b) => (a.from < b.from ? 1 : a.from > b.from ? -1 : 0));
  const addBreak = () => store.commit({ t: "pause", pause: { id: uid(), from: today(), to: addDays(today(), 6), habitId: "" } });
  return [
    el("datalist", { id: "groups" }, [...new Set(habits().map(groupOf).filter(Boolean))].map((name) => el("option", { value: name }))),
    lane("yellow", t("habits"), {
      count: current.length ? t("habits", { count: current.length }) : "",
      tools: [templatePicker(), textButton(t("addHabit"), () => addHabit(), { plus: true })],
      rows: current.map(editRow),
      empty: t("habitsEmpty"),
    }),
    habits().length ? lane("blue", t("breaks"), { tools: [textButton(t("addBreak"), addBreak, { plus: true })], rows: pauses.map(pauseRow), empty: t("breaksEmpty") }) : null,
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

  const active = document.activeElement;
  const jump = Boolean(ui.focus);
  const focus = ui.focus ?? active?.dataset?.focusKey;
  let selection = null;
  if (!jump && active?.selectionStart != null) selection = [active.selectionStart, active.selectionEnd];
  ui.focus = null;

  const builders = { today: todayView, tasks: tasksView, progress: progressView, habits: habitsView };
  $("#view").replaceChildren(...builders[view]().filter(Boolean));
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
  if (err.code) return t(err.code, { repo: settings.repo, message: err.message });
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
  if (state === "synced") refreshPublished().catch(() => {});
}

// The server no longer knows this session; the device keeps its data until Sign out.
function endSession() {
  saveSecret(SESSION_KEY, "");
  paintSettings();
}

function changeLanguage(lang) {
  write(local, LANG_KEY, setLanguage(lang));
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
  try {
    const incoming = importFile(file.name, await file.text(), data(), { uid, today: today() });
    const known = new Set(data().habits.map((h) => h.id));
    store.commit({ t: "import", data: incoming });
    result.textContent = t("imported", { count: incoming.habits.filter((h) => !known.has(h.id)).length, days: Object.keys(incoming.log).length });
  } catch {
    result.textContent = t("errImport");
  }
  result.hidden = false;
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

// Display only: the server checks the token itself.
function credentialProfile(credential) {
  const payload = JSON.parse(new TextDecoder().decode(fromB64(credential.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))));
  return { sub: payload.sub, email: payload.email ?? "" };
}

function startAccount({ token, sub, email }) {
  // Another person's passphrase must not seal this account's data.
  if (settings.sub && settings.sub !== sub) {
    saveSecret(PASS_KEY, "");
    $("#passphrase").value = "";
  }
  settings.sub = sub;
  saveSettings();
  saveSecret(SESSION_KEY, token);
  saveSecret(EMAIL_KEY, email);
  paintSettings();
  if (!secret(PASS_KEY)) $("#passphrase").focus();
  store.sync();
}

async function onCredential({ credential }) {
  try {
    const { token } = await signIn(credential);
    startAccount({ token, ...credentialProfile(credential) });
  } catch (err) {
    showStatus("error", { code: "errSignIn", message: describe(err) });
  }
}

// An account opened with a passkey is known by the server's own ID for it.
async function passkeyAccount(ceremony) {
  try {
    const { token, userId } = await ceremony();
    startAccount({ token, sub: `id:${userId}`, email: "" });
  } catch (err) {
    // Closing the browser's passkey sheet is not an error.
    if (err.name !== "NotAllowedError" && err.name !== "AbortError") showStatus("error", { code: "errSignIn", message: describe(err) });
  }
}

const inAccount = () => settings.mode === "account" && Boolean(secret(SESSION_KEY));
const shareUrl = () => `${new URL("share.html", location.href).href}#${settings.share.token}.${settings.share.key}`;
const reminderMinutes = () => utcMinutes([...new Set(activeHabits().map((h) => h.time).filter(Boolean))]);
// The time the file was made changes on every build and is not a change worth publishing.
const feedBody = () => toIcs(data());
const feedKey = (body) => body.replace(/DTSTAMP:.*/g, "");
const shareBody = () => JSON.stringify(buildShare(data(), activeHabits().filter((h) => settings.share.ids.includes(h.id)), today(), settings.share.name ?? ""));

async function publishFeed() {
  const body = feedBody();
  settings.feed = (await publishLink("feed", secret(SESSION_KEY), new TextEncoder().encode(body))).token;
  ui.published.feed = feedKey(body);
}

async function publishShare() {
  const body = shareBody();
  settings.share.token = (await publishLink("share", secret(SESSION_KEY), await wrap(body, settings.share.key))).token;
  ui.published.share = body;
}

async function sendReminders() {
  const minutes = reminderMinutes();
  await syncReminders(secret(SESSION_KEY), minutes, true);
  ui.published.remind = minutes.join();
}

// After a sync, whatever is published is brought up to date if it changed.
async function refreshPublished() {
  if (!inAccount()) return;
  if (settings.feed && ui.published.feed !== feedKey(feedBody())) await publishFeed();
  if (settings.share && ui.published.share !== shareBody()) await publishShare();
  if (settings.remind && canRemind() && ui.published.remind !== reminderMinutes().join()) await sendReminders();
  saveSettings();
}

// Runs one of the account extras, then repaints with what it said or how it failed.
async function extra(action) {
  ui.extraNote = "";
  try {
    ui.extraNote = (await action()) ?? "";
  } catch (err) {
    if (err.name !== "NotAllowedError" && err.name !== "AbortError") ui.extraNote = err.name === "OperationError" ? t("errRecovery") : describe(err);
  }
  saveSettings();
  paintSettings();
}

const EXTRAS = {
  feed: async (on) => {
    if (on) return void (await publishFeed());
    await removeLink("feed", secret(SESSION_KEY));
    settings.feed = "";
  },
  share: async (on) => {
    if (on) {
      settings.share = { key: randomKey(), ids: activeHabits().map((h) => h.id), token: "" };
      return void (await publishShare());
    }
    await removeLink("share", secret(SESSION_KEY));
    settings.share = null;
  },
  remind: async (on) => {
    if (on) await sendReminders();
    else await syncReminders(secret(SESSION_KEY), [], false);
    settings.remind = on;
  },
};

async function makeRecovery() {
  const passphrase = secret(PASS_KEY);
  if (passphrase.length < 8) return t("errWeakPassphrase");
  const code = newRecoveryCode();
  await saveRecovery(secret(SESSION_KEY), await wrap(passphrase, code));
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

function paintExtras() {
  const on = inAccount();
  $("#passkeyButtons").hidden = on || settings.mode !== "account" || !window.PublicKeyCredential;
  $("#passkeyButtons").replaceChildren(
    textButton(t("passkeySignIn"), () => passkeyAccount(usePasskey), { small: true }),
    textButton(t("passkeyNew"), () => passkeyAccount(() => createPasskey()), { small: true }),
  );

  const toggle = (label, checked, onchange) => el("label", { class: "check" }, [el("input", { type: "checkbox", checked, onchange }), el("span", { textContent: label })]);
  const address = (url) => el("input", { readOnly: true, value: url, "aria-label": t("linkAddress"), onfocus: (e) => e.target.select() });
  const hint = (text) => el("p", { class: "hint", textContent: text });
  const rows = [];
  if (on) {
    rows.push(el("div", { class: "row" }, [
      window.PublicKeyCredential ? textButton(t("addPasskey"), () => extra(async () => (await createPasskey(secret(SESSION_KEY))) && t("passkeyAdded")), { small: true }) : null,
      textButton(t("newRecovery"), () => extra(makeRecovery), { small: true }),
    ]));
    rows.push(toggle(t("feedToggle"), Boolean(settings.feed), (e) => extra(() => EXTRAS.feed(e.target.checked))));
    if (settings.feed) rows.push(address(feedUrl(settings.feed)), hint(t("feedHint")));
    rows.push(toggle(t("shareToggle"), Boolean(settings.share), (e) => extra(() => EXTRAS.share(e.target.checked))));
    if (settings.share?.token) {
      const pick = (id, shared) => extra(async () => {
        settings.share.ids = shared ? [...settings.share.ids, id] : settings.share.ids.filter((x) => x !== id);
        await publishShare();
      });
      const name = el("input", {
        value: settings.share.name ?? "",
        maxLength: 60,
        placeholder: t("shareName"),
        "aria-label": t("shareName"),
        onchange: () => extra(async () => {
          settings.share.name = name.value.trim();
          await publishShare();
        }),
      });
      rows.push(address(shareUrl()), hint(t("shareHint")), name, el("div", { class: "row" }, activeHabits().map((h) => toggle(habitName(h), settings.share.ids.includes(h.id), (e) => pick(h.id, e.target.checked)))));
    }
    if (canRemind()) rows.push(toggle(t("remindToggle"), Boolean(settings.remind), (e) => extra(() => EXTRAS.remind(e.target.checked))), hint(t("remindHint")));
    if (ui.extraNote) rows.push(el("p", { class: "hint", role: "status", textContent: ui.extraNote }));
  }
  $("#accountExtras").replaceChildren(...rows);

  const code = el("input", { placeholder: t("recoveryCode"), "aria-label": t("recoveryCode"), autocomplete: "off", spellcheck: false });
  $("#recoveryBox").hidden = !on;
  $("#recoveryBox").replaceChildren(
    ...(ui.recovering
      ? [code, el("button", { type: "button", class: "btn", textContent: t("recover"), onclick: () => extra(() => useRecovery(code.value)) })]
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
  clearDevice();
  if (token) signOut(token).catch(() => {});
}

// Leaves nothing of the account on this device: data, passphrase, email and sign-in.
function clearDevice() {
  ui.confirm = null;
  store.reset();
  for (const key of [SESSION_KEY, PASS_KEY, EMAIL_KEY]) saveSecret(key, "");
  $("#passphrase").value = "";
  // Links stay published until turned off; this device only forgets them.
  Object.assign(settings, { feed: "", share: null, remind: false });
  ui.published = {};
  ui.extraNote = "";
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
  paintExtras();
  $("#syncMode").value = mode;
  $("#noneHint").hidden = mode !== "none";
  $("#accountBlock").hidden = mode !== "account";
  $("#githubBlock").hidden = mode !== "github";
  $("#passphraseBlock").hidden = mode === "none";
  $("#passphraseHint").innerHTML = t(mode === "github" ? "passphraseHint_github" : "passphraseHint");
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
  const panel = $("#settings");
  const toggle = $("#settingsToggle");
  const setOpen = (open) => {
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    if (open) paintSettings();
  };
  toggle.addEventListener("click", () => setOpen(panel.hidden));

  const repo = $("#repo");
  const branch = $("#branch");
  const token = $("#token");
  const passphrase = $("#passphrase");
  const remember = $("#remember");
  repo.value = settings.repo;
  branch.value = settings.branch;
  token.value = secret(TOKEN_KEY);
  passphrase.value = secret(PASS_KEY);
  remember.checked = settings.remember;

  $("#syncMode").addEventListener("change", (e) => {
    settings.mode = e.target.value;
    ui.confirm = null;
    saveSettings();
    paintSettings();
    store.sync();
  });
  repo.addEventListener("input", () => {
    settings.repo = repo.value.trim();
    saveSettings();
  });
  branch.addEventListener("input", () => {
    settings.branch = branch.value.trim();
    saveSettings();
  });
  token.addEventListener("input", () => saveSecret(TOKEN_KEY, token.value.trim()));
  // Saved once typing ends: a save in the middle could seal new data with half a passphrase.
  passphrase.addEventListener("change", () => saveSecret(PASS_KEY, passphrase.value));
  remember.addEventListener("change", () => {
    settings.remember = remember.checked;
    saveSettings();
    for (const key of SECRET_KEYS) saveSecret(key, secret(key));
  });
  for (const input of [repo, branch, token, passphrase]) input.addEventListener("change", () => store.sync());
  $("#syncNow").addEventListener("click", () => store.sync());
  $("#forget").addEventListener("click", () => {
    token.value = "";
    passphrase.value = "";
    saveSecret(TOKEN_KEY, "");
    saveSecret(PASS_KEY, "");
    store.sync();
  });
  $("#exportData").addEventListener("click", exportData);
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
  setOpen(settings.mode !== "none" && !config().ready);
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

const lang = setLanguage(read(local, LANG_KEY) || (navigator.language?.startsWith("es") ? "es" : "en"));
$("#language").value = lang;
$("#language").addEventListener("change", (e) => changeLanguage(e.target.value));
applyTranslations();
initSettings();
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
setInterval(() => {
  const node = ui.timer && document.querySelector("[data-timer]");
  if (node) node.textContent = timerLabel();
}, 1000);
navigator.serviceWorker?.register("sw.js").catch(() => {});
paintStatus();
await store.ready();
render();
store.sync();
