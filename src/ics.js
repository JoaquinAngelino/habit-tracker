import { addDays, weekday, isAmount } from "./lib.js";

const BYDAY = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const compact = (iso) => iso.replaceAll("-", "");
const text = (value) => String(value).replace(/\\/g, "\\\\").replace(/([;,])/g, "\\$1").replace(/\r?\n/g, "\\n");

// Lines longer than 75 bytes continue on the next one after a space.
function fold(line) {
  const out = [];
  let part = "";
  let size = 0;
  for (const ch of line) {
    const bytes = new TextEncoder().encode(ch).length;
    if (size + bytes > 74) {
      out.push(part);
      part = " ";
      size = 1;
    }
    part += ch;
    size += bytes;
  }
  out.push(part);
  return out.join("\r\n");
}

function rule(habit) {
  if (habit.type === "weekly") return "FREQ=WEEKLY";
  if (habit.type === "monthly") return "FREQ=MONTHLY";
  if (habit.every > 1) return `FREQ=DAILY;INTERVAL=${habit.every}`;
  if (habit.days?.length) return `FREQ=WEEKLY;BYDAY=${habit.days.map((d) => BYDAY[d]).join(",")}`;
  return "FREQ=DAILY";
}

// The first day the rule lands on, which a calendar needs as the event's start.
function firstDay(habit) {
  let d = habit.start;
  if ((habit.type === "check" || isAmount(habit)) && !(habit.every > 1) && habit.days?.length) {
    while (!habit.days.includes(weekday(d))) d = addDays(d, 1);
  }
  return d;
}

function when(date, time) {
  if (!time) return [`DTSTART;VALUE=DATE:${compact(date)}`, `DTEND;VALUE=DATE:${compact(addDays(date, 1))}`];
  return [`DTSTART:${compact(date)}T${time.replace(":", "")}00`, "DURATION:PT15M"];
}

// Habits as repeating events and open tasks with a due date as all-day ones. Avoid habits have nothing to schedule.
export function toIcs(data, now = new Date()) {
  const stamp = `${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Habit Tracker//EN", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Habit Tracker"];
  const event = (uid, summary, body) => lines.push("BEGIN:VEVENT", `UID:${uid}@habit-tracker`, `DTSTAMP:${stamp}`, `SUMMARY:${text(summary)}`, ...body, "TRANSP:TRANSPARENT", "END:VEVENT");
  for (const habit of data.habits) {
    if (habit.archived || habit.type === "avoid" || !habit.start || !habit.name?.trim()) continue;
    event(`habit-${habit.id}`, habit.name.trim(), [...when(firstDay(habit), habit.time), `RRULE:${rule(habit)}`]);
  }
  for (const task of data.tasks) {
    if (task.done || !task.due || !task.title?.trim()) continue;
    event(`task-${task.id}`, task.title.trim(), when(task.due));
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
