const SIZE = 1080;
const EDGE = 80;
const LEVEL_ALPHA = { 0: 0.14, 1: 0.3, 2: 0.52, 3: 0.76, 4: 1 };

function fit(c, text, width) {
  if (c.measureText(text).width <= width) return text;
  let cut = text;
  while (cut.length > 1 && c.measureText(`${cut}…`).width > width) cut = cut.slice(0, -1);
  return `${cut}…`;
}

// A square picture of a habit: its name, one big figure, a few lines, and its recent days as a heatmap.
// `cells` holds levels as `level()` returns them, in columns of seven days.
export function drawCard({ name, label, big, lines, cells, footer, colors }) {
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const c = canvas.getContext("2d");
  const width = SIZE - EDGE * 2;
  c.fillStyle = colors.panel;
  c.fillRect(0, 0, SIZE, SIZE);
  c.fillStyle = colors.green;
  c.fillRect(0, 0, SIZE, 28);

  c.fillStyle = colors.ink;
  c.font = '600 60px "Barlow", system-ui, sans-serif';
  c.fillText(fit(c, name, width), EDGE, 170);
  c.fillStyle = colors.muted;
  c.font = '600 34px "Barlow", system-ui, sans-serif';
  c.fillText(label.toUpperCase(), EDGE, 270);
  c.fillStyle = colors.green;
  c.font = '700 230px "Barlow Condensed", "Barlow", system-ui, sans-serif';
  c.fillText(fit(c, big, width), EDGE - 6, 480);
  c.fillStyle = colors.ink;
  c.font = '500 42px "Barlow", system-ui, sans-serif';
  lines.forEach((line, i) => c.fillText(fit(c, line, width), EDGE, 580 + i * 60));

  const step = Math.floor(width / (cells.length / 7));
  const box = step - 7;
  cells.forEach((level, i) => {
    if (level == null) return;
    const x = EDGE + Math.floor(i / 7) * step;
    const y = 730 + (i % 7) * step;
    if (level === "off") {
      c.globalAlpha = 0.3;
      c.strokeStyle = colors.muted;
      c.lineWidth = 2;
      c.strokeRect(x + 1, y + 1, box - 2, box - 2);
    } else {
      c.globalAlpha = level < 0 ? 1 : LEVEL_ALPHA[level];
      c.fillStyle = level < 0 ? colors.red : level ? colors.green : colors.muted;
      c.fillRect(x, y, box, box);
    }
  });
  c.globalAlpha = 1;
  c.fillStyle = colors.muted;
  c.font = '600 30px "Barlow", system-ui, sans-serif';
  c.fillText(footer, EDGE, SIZE - 44);
  return canvas;
}
