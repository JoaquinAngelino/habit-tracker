import { $, el, mark, lane, heatmap, heatmapLegend } from "./ui.js";
import { t, startLanguage, applyTranslations, streakText, LANG_KEY } from "./i18n.js";
import { openWithKey } from "./crypto.js";
import { readShare } from "./server.js";
import { local, read, write } from "./storage.js";

const FOLLOWING_KEY = "ht.following";
const lang = startLanguage(read(local, LANG_KEY));
applyTranslations();

const percent = (r) => (r == null ? "–" : new Intl.NumberFormat(lang, { style: "percent" }).format(r));

function row(habit) {
  const s = habit.streak;
  return el("article", { class: "item" }, [
    el("div", { class: "item-main" }, [
      el("span", { class: `tape item-tape${s.current ? " is-done" : ""}`, textContent: t(`short_${s.unit}`, { count: s.current }) }),
      el("div", { class: "item-body" }, [
        el("p", { class: "item-title", textContent: habit.name.trim() || t("untitled") }),
        el("p", { class: "item-marks" }, [
          mark(streakText(habit.avoid, s), s.current ? "green" : null),
          mark(t("best", { units: t(s.unit, { count: s.best }) })),
          mark(`${t("last30")}: ${percent(habit.rate)}`),
        ]),
      ]),
    ]),
    heatmap(habit.cells.map((level) => ({ level })), { label: t("heatmapLabel", { name: habit.name.trim() || t("untitled") }) }),
  ]);
}

const parse = (text) => (text ?? "").split(",").filter((link) => link.includes("."));
const links = () => parse(location.hash.slice(1));

function follow(next) {
  write(local, FOLLOWING_KEY, next.join(","));
  location.hash = next.join(",");
}

// The key after the dot stays in the address's fragment, which servers never receive.
async function sharedLane(link) {
  const [token, key] = link.split(".");
  const tools = links().length > 1 ? [el("button", { type: "button", class: "btn-text btn-small", textContent: t("sharedRemove"), onclick: () => follow(links().filter((x) => x !== link)) })] : [];
  try {
    const shared = JSON.parse(await openWithKey(await readShare(token), key));
    const [y, m, d] = shared.updated.split("-").map(Number);
    const date = new Intl.DateTimeFormat(lang, { month: "long", day: "numeric" }).format(new Date(y, m - 1, d));
    const legend = heatmapLegend({ less: t("legendLess"), more: t("legendMore"), slip: t("legendSlip"), off: t("legendOff") });
    return lane("green", shared.name || t("sharedTitle"), { count: t("sharedUpdated", { date }), tools: [legend, ...tools], rows: shared.habits.map(row) });
  } catch {
    return lane("muted", t("sharedTitle"), { tools, rows: [], empty: t("sharedGone") });
  }
}

function followBox() {
  const input = el("input", { placeholder: t("sharedFollow"), "aria-label": t("sharedFollow"), spellcheck: false, autocomplete: "off" });
  const add = () => {
    const [link] = parse(input.value.trim().split("#").pop());
    if (link && !links().includes(link)) follow([...links(), link]);
  };
  return lane("blue", t("sharedFollow"), {
    rows: [el("div", { class: "item" }, [el("p", { class: "hint", textContent: t("sharedFollowHint") }), el("div", { class: "row" }, [input, el("button", { type: "button", class: "btn", textContent: t("sharedAdd"), onclick: add })])])],
  });
}

async function render() {
  $("#view").replaceChildren(...(await Promise.all(links().map(sharedLane))), followBox());
}

// A link just opened joins the ones this browser already follows.
const saved = parse(read(local, FOLLOWING_KEY));
const opened = links();
if (saved.some((link) => !opened.includes(link))) history.replaceState(null, "", `#${[...saved, ...opened.filter((link) => !saved.includes(link))].join(",")}`);
if (opened.some((link) => !saved.includes(link))) write(local, FOLLOWING_KEY, links().join(","));
window.addEventListener("hashchange", render);
await render();
