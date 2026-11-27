const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS = {
  x: "M4 4l8 8M12 4l-8 8",
  plus: "M8 3v10M3 8h10",
  minus: "M3 8h10",
  left: "M10 3L5 8l5 5",
  right: "M6 3l5 5-5 5",
  up: "M3 10l5-5 5 5",
  down: "M3 6l5 5 5-5",
};
const TOAST_MS = 6000;

export const $ = (sel) => document.querySelector(sel);

export function el(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "style") e.style.cssText = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k in e) e[k] = v;
    else e.setAttribute(k, v);
  }
  e.append(...children.filter((c) => c != null && c !== false));
  return e;
}

export const mark = (text, tone) => el("span", { class: "mark", "data-tone": tone, textContent: text });

export function icon(name) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "icon");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

export function iconButton(name, label, onclick, extra = {}) {
  return el("button", { type: "button", class: "icon-btn", title: label, "aria-label": label, onclick, ...extra }, [icon(name)]);
}

// No empty text: only the heading shows. `title` is text, or a node to put in the heading.
export function lane(tone, title, { count = "", tools = [], rows, empty }) {
  return el("section", { class: "lane", "data-tone": tone }, [
    el("div", { class: "lane-head" }, [
      el("h2", { class: "lane-title" }, [title]),
      count ? el("span", { class: "lane-count", textContent: count }) : null,
      el("span", { class: "lane-tools" }, tools),
    ]),
    el("div", { class: "rows" }, rows.length || empty == null ? rows : [el("p", { class: "lane-empty" }, [].concat(empty))]),
  ]);
}

let toastTimer = null;

function hideToast() {
  clearTimeout(toastTimer);
  $("#toast")?.replaceChildren();
}

// One message at a time, in a live region; it stays while focus is inside it.
export function toast(text, { action, onAction } = {}) {
  const box = $("#toast");
  if (!box) return;
  clearTimeout(toastTimer);
  const button = action
    ? el("button", {
      type: "button",
      class: "toast-action",
      textContent: action,
      onclick: () => {
        hideToast();
        onAction();
      },
    })
    : null;
  // The space keeps a screen reader from running the message into the button's name.
  box.replaceChildren(el("div", { class: "toast-body" }, [el("span", { textContent: text }), button ? " " : null, button]));
  const later = () => {
    toastTimer = setTimeout(() => (box.contains(document.activeElement) ? later() : hideToast()), TOAST_MS);
  };
  later();
}

export function heatmapLegend({ less, more, slip, off }) {
  const swatch = (level) => el("span", { class: "cell", "data-level": level });
  return el("div", { class: "heatmap-legend", "aria-hidden": "true" }, [
    el("span", { textContent: less }),
    ...["0", "1", "2", "3", "4"].map(swatch),
    el("span", { textContent: more }),
    el("span", { class: "legend-item" }, [swatch("-1"), slip]),
    el("span", { class: "legend-item" }, [swatch("off"), off]),
  ]);
}

// Cells run down each week's column.
export function heatmap(cells, { label, hint = "" }) {
  const nodes = cells.map((c) => el("span", { class: "cell", "data-level": c.level ?? "none" }));
  const interactive = cells.some((c) => c.text);
  const grid = el("div", { class: "heatmap", role: interactive ? "group" : "img", "aria-label": label }, nodes);
  if (!interactive) return el("div", { class: "heatmap-wrap" }, [grid]);

  const detail = el("p", { class: "heatmap-detail", "aria-live": "polite", textContent: hint });
  let picked = -1;
  const pick = (i) => {
    if (!cells[i]?.text || i === picked) return;
    nodes[picked]?.removeAttribute("data-picked");
    picked = i;
    nodes[i].setAttribute("data-picked", "");
    detail.textContent = cells[i].text;
  };
  const last = () => cells.findLastIndex((c) => c.text);
  grid.tabIndex = 0;
  grid.addEventListener("focus", () => picked < 0 && pick(last()));
  grid.addEventListener("keydown", (e) => {
    const step = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[e.key];
    if (e.key === "Home") pick(cells.findIndex((c) => c.text));
    else if (e.key === "End") pick(last());
    else if (step) pick(Math.max(0, picked) + step);
    else return;
    e.preventDefault();
    nodes[picked]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
  // Gaps between cells count too, so a finger need not land on a 10px square.
  grid.addEventListener("click", (e) => {
    const first = nodes[0].getBoundingClientRect();
    const pitch = nodes.length > 7 ? nodes[7].getBoundingClientRect().left - first.left : first.width;
    const col = Math.floor((e.clientX - first.left) / pitch);
    const row = Math.floor((e.clientY - first.top) / pitch);
    if (col >= 0 && row >= 0 && row < 7) pick(col * 7 + row);
  });
  return el("div", { class: "heatmap-block" }, [el("div", { class: "heatmap-wrap" }, [grid]), detail]);
}
