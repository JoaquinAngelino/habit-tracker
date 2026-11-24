import { $, el, icon, iconButton } from "./ui.js";
import { TYPES, localIso, addDays, weekStart, uid, entry, isDone, weekCount, streak, rate, level, goalProgress } from "./lib.js";
import { createStore, local, session, read, write } from "./store.js";

const CONFIG_KEY = "ht.config";
const TOKEN_KEY = "ht.token";
const PASS_KEY = "ht.passphrase";
const DATA_PATH = "data/habits.enc";
const VIEWS = ["today", "progress", "habits"];
const TYPE_LABEL = { check: "Daily", weekly: "Weekly", amount: "Amount", avoid: "Avoid" };
const DEFAULT_TARGET = { check: 1, weekly: 3, amount: 1, avoid: 1 };

const today = () => localIso();
const ui = { day: today(), shownToday: today(), confirmDelete: null, goalDraft: null, focus: null };

function loadSettings() {
  const defaults = { repo: "", branch: "data", remember: true };
  try {
    return { ...defaults, ...JSON.parse(read(local, CONFIG_KEY) ?? "{}") };
  } catch {
    return defaults;
  }
}

const settings = loadSettings();
const saveSettings = () => write(local, CONFIG_KEY, JSON.stringify(settings));
const secret = (key) => read(session, key) || read(local, key) || "";

function saveSecret(key, value) {
  write(session, key, settings.remember ? null : value || null);
  write(local, key, settings.remember ? value || null : null);
}

const config = () => ({
  repo: settings.repo.trim(),
  branch: settings.branch.trim() || "data",
  path: DATA_PATH,
  token: secret(TOKEN_KEY),
  passphrase: secret(PASS_KEY),
});

const store = createStore({ config, onChange: () => render(), onStatus: showStatus });
const data = () => store.data();
const activeHabits = () => data().habits.filter((h) => !h.archived);

/* Formatting */

function fmtDay(iso, opts = { weekday: "short", month: "short", day: "numeric" }) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", opts).format(new Date(y, m - 1, d));
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const num = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10));
const percent = (r) => (r == null ? "–" : `${Math.round(r * 100)}%`);
const habitName = (habit) => habit.name.trim() || "Untitled habit";

function streakText(habit, s) {
  if (habit.type === "avoid") return `${plural(s.current, "day")} clean`;
  return s.current ? `${plural(s.current, s.unit)} streak` : "No streak";
}

function goalUnit(habit) {
  if (habit.type === "amount") return habit.unit.trim() || "total";
  return habit.type === "avoid" ? "clean days" : "times";
}

/* Building blocks */

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

function setLog(habit, date, value) {
  store.commit({ t: "log", date, id: habit.id, v: value > 0 ? value : 0 });
}

function patchHabit(id, patch, opts) {
  const habit = data().habits.find((h) => h.id === id);
  if (habit) store.commit({ t: "habit", habit: { ...habit, ...patch } }, opts);
}

/* Today */

function todayTape(habit, day, value) {
  const done = isDone(habit, value);
  const slipped = habit.type === "avoid" && value > 0;
  const tone = slipped ? " is-slip" : done ? " is-done" : "";
  if (habit.type === "amount") {
    const input = el("input", {
      class: "tape-input",
      type: "number",
      min: 0,
      step: "any",
      inputMode: "decimal",
      value: value || "",
      placeholder: "0",
      "aria-label": `${habitName(habit)}, amount`,
      "data-focus-key": `${habit.id}:amount`,
      onchange: () => setLog(habit, day, Number(input.value) || 0),
      onkeydown: (e) => e.key === "Enter" && input.blur(),
    });
    return el("label", { class: `tape item-tape${tone}` }, [input, el("span", { class: "tape-of", textContent: `/${num(habit.target || 1)}` })]);
  }
  const pressed = habit.type === "avoid" ? slipped : done;
  return el("button", {
    type: "button",
    class: `tape item-tape${tone}`,
    "aria-pressed": String(pressed),
    title: habit.type === "avoid" ? (slipped ? "Undo the slip" : "Log a slip") : done ? "Mark as not done" : "Mark as done",
    "data-focus-key": `${habit.id}:tape`,
    textContent: habit.type === "avoid" ? (slipped ? "Slipped" : "Clean") : done ? "Done" : "To do",
    onclick: () => setLog(habit, day, value ? 0 : 1),
  });
}

function todayRow(habit, day) {
  const d = data();
  const value = entry(d, habit.id, day);
  const s = streak(d, habit, today());
  const marks = [mark(streakText(habit, s), s.current ? "green" : null)];
  if (s.best > s.current) marks.push(mark(`Best ${plural(s.best, s.unit)}`));
  if (habit.type === "weekly") marks.push(mark(`${weekCount(d, habit, day)} of ${habit.target} this week`));
  if (habit.type === "amount" && habit.unit.trim()) marks.push(mark(habit.unit.trim()));
  const stepper = habit.type === "amount"
    ? el("div", { class: "item-actions" }, [
      iconButton("minus", "One less", () => setLog(habit, day, Math.max(0, value - 1)), { disabled: !value }),
      iconButton("plus", "One more", () => setLog(habit, day, value + 1)),
    ])
    : null;
  return el("article", { class: "item", "data-id": habit.id }, [
    el("div", { class: "item-main" }, [
      todayTape(habit, day, value),
      el("div", { class: "item-body" }, [
        el("p", { class: "item-title", textContent: habitName(habit) }),
        el("p", { class: "item-marks" }, marks),
      ]),
      stepper,
    ]),
  ]);
}

function todayView() {
  const day = ui.day;
  const now = today();
  const habits = activeHabits().filter((h) => h.start <= day);
  const done = habits.filter((h) => isDone(h, entry(data(), h.id, day))).length;
  const go = (to) => {
    ui.day = to;
    render();
  };
  return [
    lane("green", day === now ? "Today" : fmtDay(day), {
      count: habits.length ? `${done} of ${habits.length} done` : "",
      tools: [
        day !== now ? textButton("Back to today", () => go(now), { small: true }) : null,
        iconButton("left", "Previous day", () => go(addDays(day, -1))),
        iconButton("right", "Next day", () => go(addDays(day, 1)), { disabled: day >= now }),
      ],
      rows: habits.map((h) => todayRow(h, day)),
      empty: activeHabits().length
        ? "No habits had started by this day."
        : ["No habits yet. ", el("a", { href: "#habits", textContent: "Add your first one" }), "."],
    }),
  ];
}

/* Progress */

function goalRow(goal, habit) {
  const p = goalProgress(data(), goal, habit, today());
  const unit = goalUnit(habit);
  const gap = Math.max(1, Math.round(Math.abs(p.diff)));
  const tone = { done: " is-done", ahead: " is-done", behind: " is-behind", missed: " is-slip" }[p.status];
  const status = {
    done: mark("Reached", "green"),
    missed: mark("Missed", "red"),
    ahead: mark(`On pace${p.diff >= 0.5 ? `, ${gap} ahead` : ""}`, "green"),
    behind: mark(`${gap} behind · ${num(Math.ceil(p.perDay * 10) / 10)} a day to finish`, "yellow"),
  }[p.status];
  const title = `${habitName(habit)}: ${num(goal.target)} ${unit} by ${fmtDay(goal.deadline, { month: "short", day: "numeric", year: "numeric" })}`;
  const open = p.status === "ahead" || p.status === "behind";
  return el("article", { class: "item", "data-id": goal.id }, [
    el("div", { class: "item-main" }, [
      el("span", { class: `tape item-tape${tone}`, textContent: `${Math.floor(p.pct * 100)}%` }),
      el("div", { class: "item-body" }, [
        el("p", { class: "item-title", textContent: title }),
        el("div", { class: "bar", role: "progressbar", "aria-label": title, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.floor(p.pct * 100) }, [
          el("span", { class: "bar-fill", style: `width:${p.pct * 100}%` }),
          open ? el("span", { class: "bar-pace", style: `left:${p.expectedPct * 100}%`, title: "Where you should be by today" }) : null,
        ]),
        el("p", { class: "item-marks" }, [
          mark(`${num(p.done)} of ${num(goal.target)}`),
          open ? mark(`${plural(p.daysLeft, "day")} left`) : null,
          status,
        ]),
      ]),
      el("div", { class: "item-x" }, [iconButton("x", "Remove goal", () => store.commit({ t: "delGoal", id: goal.id }))]),
    ]),
  ]);
}

function goalForm(habits) {
  const draft = ui.goalDraft;
  if (!habits.some((h) => h.id === draft.habitId)) draft.habitId = habits[0].id;
  const habit = habits.find((h) => h.id === draft.habitId);
  const habitSelect = el(
    "select",
    { class: "pill-select is-set", "aria-label": "Habit", "data-focus-key": "goal:habit", onchange: () => { draft.habitId = habitSelect.value; render(); } },
    habits.map((h) => el("option", { value: h.id, textContent: habitName(h) })),
  );
  habitSelect.value = draft.habitId;
  const target = el("input", { type: "number", class: "num-input", min: 1, step: "any", value: draft.target, "aria-label": "Target", "data-focus-key": "goal:target", oninput: () => { draft.target = target.value; } });
  const deadline = el("input", { type: "date", value: draft.deadline, min: today(), "aria-label": "Deadline", "data-focus-key": "goal:deadline", oninput: () => { draft.deadline = deadline.value; } });
  const add = () => {
    const value = Number(draft.target);
    if (!(value > 0) || !draft.deadline || draft.deadline < today()) return;
    ui.goalDraft = null;
    store.commit({ t: "goal", goal: { id: uid(), habitId: draft.habitId, target: value, start: today(), deadline: draft.deadline } });
  };
  return el("div", { class: "item" }, [
    el("div", { class: "item-meta" }, [
      habitSelect,
      el("span", { class: "meta-group" }, [target, el("span", { class: "meta-label", textContent: goalUnit(habit) })]),
      el("span", { class: "meta-group" }, [el("span", { class: "meta-label", textContent: "by" }), deadline]),
      el("button", { type: "button", class: "btn", textContent: "Add goal", onclick: add }),
      textButton("Cancel", () => { ui.goalDraft = null; render(); }, { small: true }),
    ]),
  ]);
}

const stat = (label, value) => el("div", { class: "stat" }, [el("dt", { textContent: label }), el("dd", { textContent: value })]);

function heatmap(habit) {
  const d = data();
  const now = today();
  const first = addDays(weekStart(now), -7 * 52);
  const cells = [];
  for (let i = 0; i < 53 * 7; i++) {
    const date = addDays(first, i);
    const lvl = date > now ? null : level(d, habit, date, now) ?? "before";
    let text = "";
    if (lvl != null && lvl !== "before") {
      const v = entry(d, habit.id, date);
      text = habit.type === "amount" ? `${num(v)} of ${num(habit.target || 1)}` : habit.type === "avoid" ? (v ? "slipped" : "clean") : v ? "done" : "missed";
    }
    cells.push(el("span", { class: "cell", "data-level": lvl ?? "none", title: text && `${fmtDay(date)}: ${text}` }));
  }
  return el("div", { class: "heatmap-wrap" }, [el("div", { class: "heatmap", role: "img", "aria-label": `${habitName(habit)}, last 12 months` }, cells)]);
}

function statsRow(habit) {
  const d = data();
  const now = today();
  const s = streak(d, habit, now);
  const target = habit.type === "weekly" ? `, ${habit.target} a week` : habit.type === "amount" ? `, ${num(habit.target)} ${habit.unit.trim()} a day` : "";
  return el("article", { class: "item", "data-id": habit.id }, [
    el("div", { class: "item-main" }, [
      el("span", { class: `tape item-tape${s.current ? " is-done" : ""}`, title: streakText(habit, s), textContent: `${s.current}${s.unit === "week" ? "W" : "D"}` }),
      el("div", { class: "item-body" }, [
        el("p", { class: "item-title", textContent: habitName(habit) }),
        el("p", { class: "item-marks" }, [mark(`${TYPE_LABEL[habit.type]}${target}`)]),
      ]),
    ]),
    el("dl", { class: "stats" }, [
      stat(habit.type === "avoid" ? "Clean" : "Streak", plural(s.current, s.unit)),
      stat("Best", plural(s.best, s.unit)),
      stat("Last 7 days", percent(rate(d, habit, now, 7))),
      stat("Last 30 days", percent(rate(d, habit, now, 30))),
      stat("Last 90 days", percent(rate(d, habit, now, 90))),
    ]),
    heatmap(habit),
  ]);
}

function progressView() {
  const habits = activeHabits();
  const byId = new Map(data().habits.map((h) => [h.id, h]));
  const goals = data().goals.filter((g) => byId.has(g.habitId));
  const rows = goals.map((g) => goalRow(g, byId.get(g.habitId)));
  if (ui.goalDraft && habits.length) rows.push(goalForm(habits));
  return [
    lane("purple", "Goals", {
      count: goals.length ? plural(goals.length, "goal") : "",
      tools: habits.length && !ui.goalDraft
        ? [textButton("Add goal", () => { ui.goalDraft = { habitId: habits[0].id, target: "30", deadline: addDays(today(), 30) }; ui.focus = "goal:target"; render(); }, { plus: true })]
        : [],
      rows,
      empty: habits.length ? "No goals yet. Try something like 100 runs by the end of the year." : "Add a habit first.",
    }),
    lane("blue", "Stats", {
      rows: habits.map(statsRow),
      empty: ["No habits yet. ", el("a", { href: "#habits", textContent: "Add your first one" }), "."],
    }),
  ];
}

/* Habits */

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
    placeholder: "Habit, like Read or No sugar",
    "aria-label": "Habit name",
    "data-focus-key": `${habit.id}:name`,
    oninput: () => patch({ name: name.value }, { quiet: true }),
    onchange: () => render(),
    onkeydown: (e) => e.key === "Enter" && name.blur(),
  });
  const type = el(
    "select",
    { class: "pill-select is-set", "aria-label": "Type", "data-focus-key": `${habit.id}:type`, onchange: () => patch({ type: type.value, target: DEFAULT_TARGET[type.value] }) },
    TYPES.map((t) => el("option", { value: t, textContent: TYPE_LABEL[t] })),
  );
  type.value = habit.type;
  const fields = [type];
  if (habit.type === "weekly" || habit.type === "amount") {
    const target = el("input", {
      type: "number",
      class: "num-input",
      min: 1,
      step: "any",
      value: habit.target,
      "aria-label": "Target",
      "data-focus-key": `${habit.id}:target`,
      onchange: () => patch({ target: Number(target.value) > 0 ? Number(target.value) : 1 }),
    });
    fields.push(el("span", { class: "meta-group" }, [target, el("span", { class: "meta-label", textContent: habit.type === "weekly" ? "times a week" : "a day" })]));
  }
  if (habit.type === "amount") {
    const unit = el("input", {
      class: "unit-input",
      value: habit.unit,
      placeholder: "Unit, like pages",
      "aria-label": "Unit",
      "data-focus-key": `${habit.id}:unit`,
      oninput: () => patch({ unit: unit.value }, { quiet: true }),
    });
    fields.push(unit);
  }
  const start = el("input", {
    type: "date",
    value: habit.start,
    max: today(),
    "aria-label": "Start date",
    "data-focus-key": `${habit.id}:start`,
    onchange: () => start.value && patch({ start: start.value }),
  });
  fields.push(el("span", { class: "meta-group" }, [el("span", { class: "meta-label", textContent: "Since" }), start]));

  const confirming = ui.confirmDelete === habit.id;
  const actions = confirming
    ? [
      textButton("Delete it and its history", () => { ui.confirmDelete = null; store.commit({ t: "delHabit", id: habit.id }); }, { danger: true }),
      textButton("Cancel", () => { ui.confirmDelete = null; render(); }, { small: true }),
    ]
    : [
      textButton(habit.archived ? "Restore" : "Archive", () => patch({ archived: !habit.archived }), { small: true }),
      iconButton("x", "Delete habit", () => { ui.confirmDelete = habit.id; render(); }),
    ];
  return el("article", { class: "item", "data-id": habit.id }, [
    el("div", { class: "edit-row" }, [name, el("div", { class: "item-actions" }, actions)]),
    el("div", { class: "item-meta" }, fields),
  ]);
}

function habitsView() {
  const habits = data().habits;
  const current = habits.filter((h) => !h.archived);
  const archived = habits.filter((h) => h.archived);
  return [
    lane("yellow", "Habits", {
      count: current.length ? plural(current.length, "habit") : "",
      tools: [textButton("Add habit", addHabit, { plus: true })],
      rows: current.map(editRow),
      empty: "No habits yet. Daily ones are checked off, weekly ones count toward N times a week, amounts add up to a daily target, and avoid ones count clean days.",
    }),
    archived.length ? lane("muted", "Archived", { count: plural(archived.length, "habit"), rows: archived.map(editRow) }) : null,
  ];
}

/* Shell */

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
  if (!ui.focus && active?.selectionStart != null) selection = [active.selectionStart, active.selectionEnd];
  ui.focus = null;

  const builders = { today: todayView, progress: progressView, habits: habitsView };
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

function showStatus(state, message = "") {
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date());
  const status = $("#sync");
  status.textContent = {
    off: "Not synced",
    local: "Saved on this device",
    syncing: "Syncing…",
    synced: `Synced ${time}`,
    error: "Sync failed",
  }[state];
  status.dataset.tone = state === "error" ? "error" : state === "synced" ? "ok" : "";
  const banner = $("#banner");
  banner.hidden = state !== "error";
  banner.textContent = message;
}

function initSettings() {
  const panel = $("#settings");
  const toggle = $("#settingsToggle");
  const setOpen = (open) => {
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
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

  repo.addEventListener("input", () => {
    settings.repo = repo.value.trim();
    saveSettings();
  });
  branch.addEventListener("input", () => {
    settings.branch = branch.value.trim();
    saveSettings();
  });
  token.addEventListener("input", () => saveSecret(TOKEN_KEY, token.value.trim()));
  passphrase.addEventListener("input", () => saveSecret(PASS_KEY, passphrase.value));
  remember.addEventListener("change", () => {
    settings.remember = remember.checked;
    saveSettings();
    saveSecret(TOKEN_KEY, token.value.trim());
    saveSecret(PASS_KEY, passphrase.value);
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

  const cfg = config();
  setOpen(!cfg.repo || !cfg.token || !cfg.passphrase);
}

initSettings();
window.addEventListener("hashchange", () => {
  ui.confirmDelete = null;
  render();
  window.scrollTo(0, 0);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (ui.day === ui.shownToday) ui.day = today();
  ui.shownToday = today();
  render();
  store.sync();
});
render();
store.sync();
