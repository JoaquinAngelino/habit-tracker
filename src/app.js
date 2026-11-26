import { $, el, icon, iconButton } from "./ui.js";
import { TYPES, KINDS, sortTasks, localIso, addDays, weekStart, uid, entry, isDone, periodCount, streak, rate, level, goalProgress } from "./lib.js";
import { createStore } from "./store.js";
import { local, session, read, write } from "./storage.js";
import { fromB64 } from "./crypto.js";
import { DEFAULT_BRANCH } from "./github.js";
import { t, setLanguage, getLanguage, applyTranslations } from "./i18n.js";
import { GOOGLE_CLIENT_ID, signIn, signOut, deleteAccount } from "./server.js";

const CONFIG_KEY = "ht.config";
const TOKEN_KEY = "ht.token";
const PASS_KEY = "ht.passphrase";
const SESSION_KEY = "ht.session";
const EMAIL_KEY = "ht.email";
const SECRET_KEYS = [TOKEN_KEY, PASS_KEY, SESSION_KEY, EMAIL_KEY];
const MODES = ["account", "github", "none"];
const LANG_KEY = "ht.lang";
const VIEWS = ["today", "tasks", "progress", "habits"];
const DEFAULT_TARGET = { check: 1, weekly: 3, monthly: 8, amount: 1, avoid: 1 };
const HEATMAP_WEEKS = 53;
const DONE_TASKS_SHOWN = 20;

const today = () => localIso();
const ui = {
  day: today(),
  lastSeenDay: today(),
  confirm: null,
  allDone: false,
  taskFilter: "all",
  goalDraft: null,
  focus: null,
  status: { state: "off", err: null },
  syncedAt: null,
};

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
  if (habit.type === "amount") return habit.unit.trim() || t("unit_total");
  return t(habit.type === "avoid" ? "unit_clean" : "unit_times");
}

const mark = (text, tone) => el("span", { class: "mark", "data-tone": tone, textContent: text });

function textButton(label, onclick, { small = false, plus = false, danger = false } = {}) {
  return el("button", { type: "button", class: `btn-text${small ? " btn-small" : ""}${danger ? " btn-danger" : ""}`, onclick }, [
    plus ? icon("plus") : null,
    el("span", { textContent: label }),
  ]);
}

function lane(tone, title, { count = "", tools = [], rows, empty }) {
  return el("section", { class: "lane", "data-tone": tone }, [
    el("div", { class: "lane-head" }, [
      el("h2", { class: "lane-title", textContent: title }),
      count ? el("span", { class: "lane-count", textContent: count }) : null,
      el("span", { class: "lane-tools" }, tools),
    ]),
    el("div", { class: "rows" }, rows.length ? rows : [el("p", { class: "lane-empty" }, [].concat(empty))]),
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
    onclick: () => patchTask(task.id, { done: task.done ? "" : today() }),
  });
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
      el("p", { class: "item-marks" }, [mark(t(`kind_${task.kind}`)), dueMark(task)]),
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
      ]),
    ],
    side: el("div", { class: "item-x" }, [iconButton("x", t("deleteTask"), () => store.commit({ t: "delTask", id: task.id }))]),
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
  if (habit.type === "amount") {
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

function todayRow(habit, day) {
  const d = data();
  const value = entry(d, habit.id, day);
  const s = streakOf(habit);
  const marks = [mark(streakText(habit, s), s.current ? "green" : null)];
  if (s.best > s.current) marks.push(mark(t("best", { units: units(s.best, s.unit) })));
  if (habit.type === "weekly" || habit.type === "monthly") {
    marks.push(mark(t(habit.type === "weekly" ? "thisWeek" : "thisMonth", { count: periodCount(d, habit, day), target: habit.target })));
  }
  if (habit.type === "amount" && habit.unit.trim()) marks.push(mark(habit.unit.trim()));
  const stepper = habit.type === "amount" || habit.type === "weekly" || habit.type === "monthly"
    ? el("div", { class: "item-actions" }, [
      iconButton("minus", t("oneLess"), () => setLog(habit, day, Math.max(0, value - 1)), { disabled: !value }),
      iconButton("plus", t("oneMore"), () => setLog(habit, day, value + 1)),
    ])
    : null;
  return itemRow({
    id: habit.id,
    tape: todayTape(habit, day, value),
    body: [el("p", { class: "item-title", textContent: habitName(habit) }), el("p", { class: "item-marks" }, marks)],
    side: stepper,
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
  const started = activeHabits().filter((h) => h.start <= day);
  const done = started.filter((h) => isDone(h, entry(data(), h.id, day))).length;
  const go = (to) => {
    ui.day = to;
    render();
  };
  return [
    lane("green", day === now ? t("today") : fmtDay(day), {
      count: started.length ? t("doneCount", { done, total: started.length }) : "",
      tools: [
        day !== now ? textButton(t("backToday"), () => go(now), { small: true }) : null,
        iconButton("left", t("prevDay"), () => go(addDays(day, -1))),
        iconButton("right", t("nextDay"), () => go(addDays(day, 1)), { disabled: day >= now }),
      ],
      rows: started.map((h) => todayRow(h, day)),
      empty: activeHabits().length ? t("noneStarted") : firstHabitLink(),
    }),
    dueLane(day),
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
  if (habit.type === "amount") return t("cell_amount", { value: num(value), target: num(habit.target || 1) });
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

function statsRow(habit) {
  const s = streakOf(habit);
  let kind = t(`type_${habit.type}`);
  if (habit.type === "weekly") kind += ` · ${t("perWeek", { count: habit.target })}`;
  if (habit.type === "monthly") kind += ` · ${t("perMonth", { count: habit.target })}`;
  if (habit.type === "amount") kind += ` · ${t("perDayUnit", { count: num(habit.target), unit: habit.unit.trim() })}`;
  return itemRow({
    id: habit.id,
    tape: el("span", { class: `tape item-tape${s.current ? " is-done" : ""}`, title: streakText(habit, s), textContent: t(`short_${s.unit}`, { count: s.current }) }),
    body: [el("p", { class: "item-title", textContent: habitName(habit) }), el("p", { class: "item-marks" }, [mark(kind)])],
    after: [
      el("dl", { class: "stats" }, [
        stat(t(habit.type === "avoid" ? "cleanLabel" : "streakLabel"), units(s.current, s.unit)),
        stat(t("bestLabel"), units(s.best, s.unit)),
        stat(t("last7"), percent(rateOf(habit, 7))),
        stat(t("last30"), percent(rateOf(habit, 30))),
        stat(t("last90"), percent(rateOf(habit, 90))),
      ]),
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
    lane("blue", t("stats"), { rows: active.map(statsRow), empty: firstHabitLink() }),
  ];
}

function addHabit() {
  const habit = { id: uid(), name: "", type: "check", target: 1, unit: "", start: today(), archived: false };
  ui.focus = `${habit.id}:name`;
  store.commit({ t: "habit", habit });
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
    fields.push(el("span", { class: "meta-group" }, [target, el("span", { class: "meta-label", textContent: t({ weekly: "timesWeek", monthly: "timesMonth", amount: "aDay" }[habit.type]) })]));
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

  const confirmKey = `habit:${habit.id}`;
  const actions = ui.confirm === confirmKey
    ? confirmButtons(t("deleteConfirm"), () => store.commit({ t: "delHabit", id: habit.id }), render)
    : [
      textButton(t(habit.archived ? "restore" : "archive"), () => patch({ archived: !habit.archived }), { small: true }),
      iconButton("x", t("deleteHabit"), () => setConfirm(confirmKey, render)),
    ];
  return el("article", { class: "item", "data-id": habit.id }, [
    el("div", { class: "edit-row" }, [name, el("div", { class: "item-actions" }, actions)]),
    el("div", { class: "item-meta" }, fields),
  ]);
}

function habitsView() {
  const current = habits().filter((h) => !h.archived);
  const archived = habits().filter((h) => h.archived);
  return [
    lane("yellow", t("habits"), {
      count: current.length ? t("habits", { count: current.length }) : "",
      tools: [textButton(t("addHabit"), addHabit, { plus: true })],
      rows: current.map(editRow),
      empty: t("habitsEmpty"),
    }),
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
  const file = new Blob([JSON.stringify(data(), null, 2)], { type: "application/json" });
  const link = el("a", { href: URL.createObjectURL(file), download: `habit-tracker-${today()}.json` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
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

async function onCredential({ credential }) {
  try {
    const { token } = await signIn(credential);
    const { sub, email } = credentialProfile(credential);
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
  } catch (err) {
    showStatus("error", { code: "errSignIn", message: describe(err) });
  }
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
  $("#signedInAs").textContent = email ? t(signedIn ? "signedInAs" : "sessionEnded", { email }) : t("accountOnDevice");
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

  paintSettings();
  setOpen(settings.mode !== "none" && !config().ready);
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
navigator.serviceWorker?.register("sw.js").catch(() => {});
paintStatus();
await store.ready();
render();
store.sync();
