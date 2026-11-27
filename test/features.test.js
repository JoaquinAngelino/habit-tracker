import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyData, applyOp, replay, merge, normalize, streak, rate, isOff, isDone, level, addMonths, nextDue, completeTask, reopenTask, rescheduled, timerMinutes, recentLevels, queue, hasData, reminderTimes } from "../src/lib.js";
import { weekdayPattern, correlations, moodLinks, weekReview, yearRecap, sharedProgress, SHARED_WEEKS } from "../src/insights.js";
import { toIcs } from "../src/ics.js";
import { parseCsv, fromCsv, fromJson, importFile } from "../src/importer.js";

const TODAY = "2026-11-24"; // a Tuesday
const daily = { id: "h", name: "Read", type: "check", target: 1, unit: "", start: "2026-11-01" };

function dataWith(habits, log = {}) {
  const data = emptyData();
  data.habits.push(...[].concat(habits));
  for (const [date, day] of Object.entries(log)) data.log[date] = { ...day };
  return data;
}

const range = (from, n, fn) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`2026-11-${String(from + i).padStart(2, "0")}`, fn(i)]).filter(([, v]) => v));

test("a habit every N days is due only on those days, counted from its start", () => {
  const habit = { ...daily, start: "2026-11-18", every: 3 };
  const data = dataWith(habit, { "2026-11-18": { h: 1 }, "2026-11-21": { h: 1 } });
  assert.equal(isOff(data, habit, "2026-11-19"), true);
  assert.equal(isOff(data, habit, "2026-11-21"), false);
  assert.deepEqual(streak(data, habit, TODAY), { current: 2, best: 2, unit: "day" });
  assert.equal(rate(data, habit, TODAY, 7), 1);
});

test("a break keeps streaks alive, for one habit or all, and avoid habits count through it", () => {
  const weekly = { ...daily, id: "w", type: "weekly", target: 2 };
  const avoid = { ...daily, id: "a", type: "avoid" };
  const data = dataWith([daily, weekly, avoid], { "2026-11-09": { h: 1, w: 2 }, "2026-11-23": { h: 1, w: 2 } });
  for (let d = 1; d <= 8; d++) data.log[`2026-11-0${d}`] = { h: 1 };
  assert.equal(streak(data, daily, TODAY).current, 1);
  applyOp(data, { t: "break", break: { id: "p", from: "2026-11-10", to: "2026-11-22", habitId: "" } });
  assert.equal(streak(data, daily, TODAY).current, 10);
  assert.equal(streak(data, weekly, TODAY).current, 2);
  assert.equal(isOff(data, avoid, "2026-11-15"), false);
  assert.equal(level(data, daily, "2026-11-15", TODAY), "off");
  applyOp(data, { t: "break", break: { id: "p", from: "2026-11-10", to: "2026-11-22", habitId: "w" } });
  assert.equal(data.breaks.length, 1);
  assert.equal(streak(data, daily, TODAY).current, 1);
  applyOp(data, { t: "delHabit", id: "w" });
  assert.deepEqual(data.breaks, []);
});

test("a note is kept per habit per day, merges, and goes with its habit", () => {
  const data = dataWith(daily);
  applyOp(data, { t: "note", date: TODAY, id: "h", v: "Chapter 3" });
  assert.equal(data.notes[TODAY].h, "Chapter 3");
  assert.deepEqual(merge(emptyData(), data).notes, { [TODAY]: { h: "Chapter 3" } });
  assert.equal(queue([{ t: "note", date: TODAY, id: "h", v: "a" }], { t: "note", date: TODAY, id: "h", v: "ab" }).length, 1);
  applyOp(data, { t: "delHabit", id: "h" });
  assert.deepEqual(data.notes, {});
});

test("the day's mood, energy and note change one at a time, so two devices do not undo each other", () => {
  const phone = [{ t: "day", date: TODAY, patch: { mood: 4 } }];
  const laptop = [{ t: "day", date: TODAY, patch: { note: "Good one" } }];
  const synced = replay(replay(emptyData(), phone), laptop);
  assert.deepEqual(synced.days, { [TODAY]: { mood: 4, note: "Good one" } });
  assert.equal(hasData(synced), true);

  const other = emptyData();
  other.days[TODAY] = { energy: 2 };
  assert.deepEqual(merge(synced, other).days[TODAY], { mood: 4, note: "Good one", energy: 2 });

  applyOp(synced, { t: "day", date: TODAY, patch: { mood: 0 } });
  assert.deepEqual(synced.days[TODAY], { note: "Good one" });
  applyOp(synced, { t: "day", date: TODAY, patch: { note: "" } });
  assert.deepEqual(synced.days, {});
});

test("typing a day note queues one edit, and a mood set before it stays queued", () => {
  let ops = queue([], { t: "day", date: TODAY, patch: { mood: 1 } });
  ops = queue(ops, { t: "day", date: TODAY, patch: { note: "a" } });
  ops = queue(ops, { t: "day", date: TODAY, patch: { note: "ab" } });
  assert.deepEqual(ops.map((op) => op.patch), [{ mood: 1 }, { note: "ab" }]);
});

test("a timer counts minutes toward its target like an amount", () => {
  const timer = { ...daily, type: "timer", target: 20 };
  assert.equal(isDone(timer, 19), false);
  assert.equal(isDone(timer, 20), true);
  assert.equal(level(dataWith(timer, { [TODAY]: { h: 10 } }), timer, TODAY, TODAY), 2);
});

test("reordering moves the listed habits first and keeps the rest in place", () => {
  const data = dataWith([{ ...daily, id: "a" }, { ...daily, id: "b" }, { ...daily, id: "c" }]);
  applyOp(data, { t: "order", ids: ["c", "a"] });
  assert.deepEqual(data.habits.map((h) => h.id), ["c", "a", "b"]);
});

test("importing merges into what is there and replays like any edit", () => {
  const base = dataWith(daily, { "2026-11-20": { h: 1 } });
  const incoming = dataWith({ ...daily, id: "n", name: "Run" }, { "2026-11-20": { n: 1 }, "2026-11-21": { h: 1 } });
  const out = replay(base, [{ t: "import", data: incoming }]);
  assert.deepEqual(out.habits.map((h) => h.id), ["h", "n"]);
  assert.deepEqual(out.log, { "2026-11-20": { h: 1, n: 1 }, "2026-11-21": { h: 1 } });
  assert.deepEqual(base.habits.length, 1);
});

test("an imported file never brings its share key or a __proto__ key", () => {
  const theirs = { ...dataWith(daily), share: { key: "theirs", ids: ["h"], name: "" } };
  const out = replay(emptyData(), [{ t: "import", data: theirs }]);
  assert.deepEqual([out.habits.map((h) => h.id), out.share], [["h"], undefined]);
  const parsed = fromJson('{"habits":[],"log":{"__proto__":{"x":1}},"__proto__":{"x":1}}');
  assert.deepEqual([Object.hasOwn(parsed, "__proto__"), Object.hasOwn(parsed.log, "__proto__")], [false, false]);
});

test("the share syncs with the data: setting it, clearing it, and keeping the device's in a merge", () => {
  const share = { key: "k", ids: ["h"], name: "Ana" };
  const set = replay(emptyData(), [{ t: "share", share }]);
  assert.deepEqual(set.share, share);
  assert.equal(replay(set, [{ t: "share", share: null }]).share, undefined);
  assert.deepEqual(merge(emptyData(), set).share, share);
});

test("importing an older backup changes nothing the data already holds", () => {
  const backup = dataWith([daily, { ...daily, id: "old", name: "Deleted since" }], { "2026-11-20": { h: 5 } });
  backup.tasks.push({ id: "t", title: "Pay rent", done: "" });
  const now = dataWith({ ...daily, name: "Read fiction", archived: true }, { "2026-11-20": { h: 1 } });
  now.tasks.push({ id: "t", title: "Pay rent", done: TODAY });
  const out = replay(now, [{ t: "import", data: backup }]);
  assert.deepEqual(out.habits.map((h) => [h.id, h.name, Boolean(h.archived)]), [["h", "Read fiction", true], ["old", "Deleted since", false]]);
  assert.deepEqual([out.log["2026-11-20"].h, out.tasks[0].done], [1, TODAY]);
});

test("repeating tasks come due again after today", () => {
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2026-11-15", 2), "2027-01-15");
  assert.equal(nextDue({ due: "2026-11-24", repeat: "daily" }, TODAY), "2026-11-25");
  assert.equal(nextDue({ due: "2026-11-03", repeat: "weekly" }, TODAY), "2026-12-01");
  assert.equal(nextDue({ due: "2026-11-30", repeat: "weekly" }, TODAY), "2026-12-07");
  assert.equal(nextDue({ due: "", repeat: "monthly" }, TODAY), "2026-12-24");
});

test("a monthly task due at the end of the month comes back to that day after a shorter month", () => {
  assert.equal(nextDue({ due: "2026-01-31", repeat: "monthly" }, "2026-03-15"), "2026-03-31");
  let n = 0;
  const newId = () => `t${n++}`;
  let task = { id: "a", title: "Rent", repeat: "monthly", due: "2026-01-31", done: "" };
  const dues = [];
  for (const day of ["2026-01-31", "2026-02-28", "2026-03-31"]) {
    [{ task }] = completeTask(task, day, newId);
    dues.push(task.due);
  }
  assert.deepEqual(dues, ["2026-02-28", "2026-03-31", "2026-04-30"]);
});

test("finishing a repeating task opens the next one with its steps to do again, and undoing takes it back", () => {
  let n = 0;
  const data = emptyData();
  const task = { id: "a", title: "Water plants", repeat: "weekly", due: TODAY, done: "", steps: [{ id: "s", title: "Fill can", done: true }] };
  data.tasks.push(task);
  completeTask(task, TODAY, () => `new${n++}`).forEach((op) => applyOp(data, op));
  const [done, next] = [data.tasks.find((x) => x.id === "a"), data.tasks.find((x) => x.id !== "a")];
  assert.deepEqual([done.done, done.repeat, next.due, next.done, next.steps.map((s) => s.done)], [TODAY, "weekly", "2026-12-01", "", [false]]);

  reopenTask(done, data.tasks).forEach((op) => applyOp(data, op));
  assert.deepEqual(data.tasks.map((x) => [x.id, x.done, x.repeat, x.nextId]), [["a", "", "weekly", undefined]]);
});

test("two devices finishing the same repeating task open one next task", () => {
  const task = { id: "a", title: "x", repeat: "weekly", due: TODAY, done: "" };
  const out = replay({ ...emptyData(), tasks: [task] }, [...completeTask(task, TODAY, () => "p"), ...completeTask(task, TODAY, () => "q")]);
  assert.deepEqual(out.tasks.filter((x) => !x.done).map((x) => x.due), ["2026-12-01"]);
});

test("moving a repeating task to another day repeats it from that day", () => {
  const task = { id: "a", repeat: "weekly", due: "2026-11-02", anchor: "2026-11-02", done: "" };
  assert.equal(nextDue({ ...task, ...rescheduled(task, "2026-11-25") }, "2026-11-25"), "2026-12-02");
  assert.deepEqual(rescheduled({ id: "b", due: "" }, TODAY), { due: TODAY });
});

test("steps ticked on two devices both stay, and a removed one goes", () => {
  const steps = [{ id: "s1", title: "one", done: false }, { id: "s2", title: "two", done: false }];
  const ticked = replay({ ...emptyData(), tasks: [{ id: "a", title: "x", steps }] }, steps.map((step) => ({ t: "step", task: "a", step: { ...step, done: true } })));
  assert.deepEqual(ticked.tasks[0].steps.map((s) => s.done), [true, true]);
  assert.deepEqual(replay(ticked, [{ t: "delStep", task: "a", id: "s1" }]).tasks[0].steps.map((s) => s.id), ["s2"]);
});

test("undoing leaves the next task alone once it was finished too", () => {
  const data = emptyData();
  data.tasks.push({ id: "a", title: "x", repeat: "daily", due: TODAY, done: TODAY, nextId: "b" }, { id: "b", title: "x", repeat: "daily", due: "2026-11-25", done: "2026-11-25" });
  reopenTask(data.tasks[0], data.tasks).forEach((op) => applyOp(data, op));
  assert.deepEqual(data.tasks.map((x) => x.id), ["a", "b"]);
});

test("a task that does not repeat is only marked done", () => {
  assert.deepEqual(completeTask({ id: "a", title: "x", done: "" }, TODAY, () => "n"), [{ t: "task", task: { id: "a", title: "x", done: TODAY } }]);
});

test("a timer counts whole minutes, at least one, and stops counting after a day", () => {
  assert.deepEqual([10_000, 89_000, 91_000, 3 * 86_400_000].map((ms) => timerMinutes(0, ms)), [1, 1, 2, 1440]);
});

test("every-N days stay where they were when the start date is moved", () => {
  const habit = { ...daily, start: "2026-11-02", every: 2, everyFrom: "2026-11-02" };
  const data = dataWith(habit, { "2026-11-20": { h: 1 }, "2026-11-22": { h: 1 } });
  const before = streak(data, habit, "2026-11-23").current;
  assert.equal(streak(data, { ...habit, start: "2026-11-05" }, "2026-11-23").current, before);
  assert.equal(before, 2);
});

test("recent levels end with this week and leave days to come empty", () => {
  const data = dataWith(daily, { "2026-11-23": { h: 1 }, [TODAY]: { h: 1 } });
  const cells = recentLevels(data, daily, TODAY, 2);
  assert.deepEqual(cells, [0, 0, 0, 0, 0, 0, 0, 4, 4, null, null, null, null, null]);
});

test("weekday pattern shows which days a habit gets done", () => {
  const data = dataWith(daily, range(1, 23, (i) => (new Date(Date.UTC(2026, 10, 1 + i)).getUTCDay() === 0 ? null : { h: 1 })));
  const pattern = weekdayPattern(data, daily, TODAY);
  assert.equal(pattern[0], 1);
  assert.equal(pattern[6], 0);
  assert.equal(pattern[1], 1); // today, a Tuesday, is still open and left out
});

test("avoid habits are left out of links between habits and with mood", () => {
  const run = { ...daily, id: "a", name: "Run" };
  const smoking = { ...daily, id: "s", name: "Smoking", type: "avoid" };
  const data = dataWith([run, smoking], range(1, 23, (i) => (i % 2 ? { a: 1 } : { s: 1 })));
  for (let i = 0; i < 23; i++) data.days[`2026-11-${String(1 + i).padStart(2, "0")}`] = { mood: i % 2 ? 4 : 2 };
  assert.deepEqual(correlations(data, [run, smoking], TODAY), []);
  assert.deepEqual(moodLinks(data, [run, smoking], TODAY).map((m) => m.habit.id), ["a"]);
});

test("the year recap counts an every-N streak on the days it was scheduled", () => {
  const habit = { ...daily, start: "2025-12-31", every: 2 };
  const data = dataWith(habit, {});
  for (const date of ["2026-01-02", "2026-01-04", "2026-01-06", "2026-01-08"]) data.log[date] = { h: 1 };
  assert.equal(yearRecap(data, [habit], 2026, "2026-01-08").streak.count, 4);
});

test("correlations find habits done on the same days", () => {
  const a = { ...daily, id: "a", name: "Run" };
  const b = { ...daily, id: "b", name: "Stretch" };
  const c = { ...daily, id: "c", name: "Read" };
  const data = dataWith([a, b, c], range(1, 23, (i) => ({ ...(i % 2 ? { a: 1, b: 1 } : {}), ...(i % 3 ? { c: 1 } : {}) })));
  const found = correlations(data, [a, b, c], TODAY);
  assert.equal(found.length, 1);
  assert.deepEqual([found[0].a.id, found[0].b.id, found[0].withA, found[0].withoutA], ["a", "b", 1, 0]);
  assert.equal(Math.round(found[0].phi), 1);
});

test("mood links compare the mood on done and missed days", () => {
  const data = dataWith(daily, range(1, 23, (i) => (i % 2 ? { h: 1 } : null)));
  for (let i = 0; i < 23; i++) data.days[`2026-11-${String(1 + i).padStart(2, "0")}`] = { mood: i % 2 ? 4 : 2 };
  const [link] = moodLinks(data, [daily], TODAY);
  assert.deepEqual([link.done, link.missed, link.diff], [4, 2, 2]);
});

test("the week review counts what was due and done, and the year recap totals the year", () => {
  const weekly = { ...daily, id: "w", type: "weekly", target: 3 };
  const pages = { ...daily, id: "p", type: "amount", target: 10, unit: "pages" };
  const data = dataWith([daily, weekly, pages], {
    "2026-11-16": { h: 1, w: 1, p: 10 },
    "2026-11-17": { h: 1, w: 1, p: 4 },
    "2026-11-20": { h: 1 },
  });
  data.tasks.push({ id: "t", title: "x", done: "2026-11-18" });
  data.days["2026-11-16"] = { mood: 5 };
  const week = weekReview(data, [daily, weekly, pages], "2026-11-16", TODAY);
  assert.deepEqual(week.rows.map((r) => [r.habit.id, r.done, r.due]), [["h", 3, 7], ["w", 2, 3], ["p", 1, 7]]);
  assert.deepEqual([week.done, week.due, week.tasksDone, week.mood], [6, 17, 1, 5]);
  const year = yearRecap(data, [daily, weekly, pages], 2026, TODAY);
  assert.deepEqual([year.checkins, year.activeDays, year.tasksDone, year.top.habit.id, year.top.days], [7, 3, 1, "h", 3]);
  assert.deepEqual(year.totals.map((x) => [x.habit.id, x.total]), [["p", 14]]);
  assert.deepEqual([year.streak.habit.id, year.streak.count], ["h", 2]);
});

test("the calendar file has a repeating event per habit and an all-day one per dated task", () => {
  const data = dataWith([
    { ...daily, days: [0, 2], time: "07:30" },
    { ...daily, id: "e", name: "Water; plants, all", every: 3 },
    { ...daily, id: "a", type: "avoid", name: "No sugar" },
    { ...daily, id: "w", type: "weekly", name: "Gym", target: 3 },
  ]);
  data.tasks.push({ id: "t", title: "Pay rent", due: "2026-12-01", done: "" }, { id: "u", title: "No date", due: "", done: "" });
  const ics = toIcs(data, new Date(Date.UTC(2026, 10, 24, 12)));
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART:20261102T073000\r\nDURATION:PT15M\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE/);
  assert.match(ics, /SUMMARY:Water\\; plants\\, all\r\nDTSTART;VALUE=DATE:20261101\r\nDTEND;VALUE=DATE:20261102\r\nRRULE:FREQ=DAILY;INTERVAL=3/);
  assert.match(ics, /SUMMARY:Gym\r\n[^]*?RRULE:FREQ=WEEKLY\r\n/);
  assert.match(ics, /UID:task-t@habit-tracker\r\nDTSTAMP:20261124T120000Z\r\nSUMMARY:Pay rent\r\nDTSTART;VALUE=DATE:20261201/);
  assert.equal(ics.includes("No sugar") || ics.includes("No date"), false);
  assert.equal(ics.split("\r\n").every((line) => new TextEncoder().encode(line).length <= 75), true);
});

test("CSV import reads a column per habit or a row per entry, and matches habits by name", () => {
  assert.deepEqual(parseCsv('a,"b ""c"", d"\r\n1,2\n'), [["a", 'b "c", d'], ["1", "2"]]);
  let n = 0;
  const env = { uid: () => `new${n++}`, today: TODAY };
  const wide = fromCsv("Date,Read,Pages\n2026-11-20,1,12\n2026-11-21,0,30\n2026-12-25,1,1\n", dataWith(daily), env);
  assert.deepEqual(wide.habits.map((h) => [h.id, h.name, h.type, h.start]), [["new0", "Pages", "amount", "2026-11-20"]]);
  assert.deepEqual(wide.log, { "2026-11-20": { h: 1, new0: 12 }, "2026-11-21": { new0: 30 } });
  const long = fromCsv("date,habit,value\n2026/11/3,Run,yes\n2026-11-04,Run,\n", emptyData(), env);
  assert.deepEqual(long.log, { "2026-11-03": { new1: 1 } });
  assert.throws(() => fromCsv("a,b\n1,2\n", emptyData(), env), { code: "errImport" });
});

test("small counts are counts unless the file is Loop's, whose values are codes", () => {
  let n = 0;
  const env = { uid: () => `c${n++}`, today: TODAY };
  const text = "Date,Coffee\n2026-11-20,2\n2026-11-21,3\n2026-11-22,1\n";
  const counts = fromCsv(text, emptyData(), env);
  assert.deepEqual([counts.habits[0].type, counts.log], ["amount", { "2026-11-20": { c0: 2 }, "2026-11-21": { c0: 3 }, "2026-11-22": { c0: 1 } }]);
  const loop = importFile("Checkmarks.csv", text, emptyData(), env);
  assert.deepEqual([loop.habits[0].type, loop.log, loop.skips], ["check", { "2026-11-20": { c1: 1 } }, { "2026-11-21": { c1: 1 } }]);
});

test("CSV import reads semicolon-separated files and makes no habit from a column with nothing logged", () => {
  let n = 0;
  const env = { uid: () => `s${n++}`, today: TODAY };
  const out = fromCsv("Fecha;Leer;Comentario\n2026-11-20;1,5;muy bien\n2026-11-21;1;\n", emptyData(), env);
  assert.deepEqual(out.habits.map((h) => [h.name, h.type]), [["Leer", "amount"]]);
  assert.deepEqual(out.log, { "2026-11-20": { s0: 1.5 }, "2026-11-21": { s0: 1 } });
});

test("JSON import takes a downloaded file and rejects anything else", () => {
  const data = dataWith(daily, { [TODAY]: { h: 1 } });
  assert.deepEqual(fromJson(JSON.stringify(data)), normalize(data));
  assert.throws(() => fromJson("[1]"), { code: "errImport" });
  assert.throws(() => fromJson("nope"), { code: "errImport" });
});

test("a share shows streaks and recent days, and nothing of notes, amounts or tasks", () => {
  const pages = { ...daily, id: "p", type: "amount", target: 10, unit: "pages" };
  const data = dataWith([daily, pages], { "2026-11-23": { h: 1, p: 12 }, [TODAY]: { h: 1 } });
  data.notes[TODAY] = { h: "private" };
  data.tasks.push({ id: "t", title: "private task", done: "" });
  const shared = sharedProgress(data, [daily], TODAY, "Ana", () => 0.5);
  assert.deepEqual([shared.name, shared.habits.map((h) => [h.name, h.avoid, h.streak.current, h.rate, h.cells.length])], ["Ana", [["Read", false, 2, 0.5, SHARED_WEEKS * 7]]]);
  assert.deepEqual(shared.habits[0].cells.slice(-7), [4, 4, null, null, null, null, null]);
  assert.equal(JSON.stringify(shared).includes("private"), false);
});

test("recovery keys are easy to copy, and a sealed passphrase opens only with its key", async () => {
  const { newRecoveryCode, cleanCode, formatCode, wrap, unwrap } = await import("../src/crypto.js");
  const code = newRecoveryCode();
  assert.match(formatCode(code), /^([A-HJKMNP-TV-Z2-9]{4}-){5}[A-HJKMNP-TV-Z2-9]{4}$/);
  assert.equal(cleanCode(` ${formatCode(code).toLowerCase()} `), code);
  assert.notEqual(newRecoveryCode(), code);
  const sealed = await wrap("correct horse battery", code);
  assert.equal(await unwrap(sealed, code), "correct horse battery");
  await assert.rejects(unwrap(sealed, newRecoveryCode()), { name: "OperationError" });
});

test("a share link's key opens what it sealed, and no other key does", async () => {
  const { newKey, sealWithKey, openWithKey } = await import("../src/crypto.js");
  const key = newKey();
  const sealed = await sealWithKey("streaks", key);
  assert.equal(await openWithKey(sealed, key), "streaks");
  await assert.rejects(openWithKey(sealed, newKey()), { name: "OperationError" });
});

test("reminder times become minutes of the UTC day, on the UTC weekdays they are due", (t) => {
  const zone = process.env.TZ;
  t.after(() => (zone === undefined ? delete process.env.TZ : (process.env.TZ = zone)));
  // Five and a half hours ahead of UTC, so a wrong sign or a dropped half hour shows.
  process.env.TZ = "Asia/Kolkata";
  const at = (time, more = {}) => ({ ...daily, time, ...more });
  // 02:00 on a Monday here is 20:30 on Sunday in UTC, bit 0.
  const habits = [at("07:30"), at("07:30", { days: [0] }), at("02:00", { days: [0] }), at("09:00", { days: [0], every: 2 }), at("")];
  assert.deepEqual(reminderTimes(habits, new Date(2026, 10, 24, 12)), [120, 210, [1230, 1]]);
});

test("CSV import reads check-in logs and exports that mark each entry completed or skipped", () => {
  let n = 0;
  const env = { uid: () => `x${n++}`, today: TODAY };
  const log = fromCsv("Habit,Date,Habit ID\nRun,2026-11-20,abc\nRun,2026-11-21,abc\n", emptyData(), env);
  assert.deepEqual(log.log, { "2026-11-20": { x0: 1 }, "2026-11-21": { x0: 1 } });
  const typed = fromCsv(
    "task_id,title,entry_type,entry_date,quantity\n1,Run,completed_manually,20261120,0.0\n1,Run,missed_auto,20261121,0.0\n1,Run,skipped_manually,20261122,0.0\n",
    emptyData(),
    env,
  );
  assert.deepEqual([typed.log, typed.skips], [{ "2026-11-20": { x1: 1 } }, { "2026-11-22": { x1: 1 } }]);
});

test("the calendar file cannot be given lines of its own by imported data", () => {
  const data = dataWith([
    { ...daily, id: "a\r\nX-EVIL:1", name: "Read\rATTENDEE:mailto:x@example.com", time: "07:30\r\nX-EVIL:2", days: ["MO\r\nX-EVIL:3", 2], every: "2\r\nX-EVIL:4" },
    { ...daily, id: "b", start: "2026-11-01\r\nX-EVIL:5" },
  ]);
  data.tasks.push({ id: "t", title: "Pay", due: "2026-12-01\nX-EVIL:6", done: "" });
  const lines = toIcs(data).split("\r\n");
  assert.equal(lines.some((line) => /^(X-EVIL|ATTENDEE)/.test(line)), false);
  assert.equal(lines.filter((line) => line === "BEGIN:VEVENT").length, 1);
  assert.deepEqual(lines.filter((line) => /^(UID|DTSTART|RRULE)/.test(line)), ["UID:habit-aX-EVIL1@habit-tracker", "DTSTART;VALUE=DATE:20261104", "RRULE:FREQ=WEEKLY;BYDAY=WE"]);
});
