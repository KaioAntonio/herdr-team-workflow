import { agentStatus } from "./model.js";

export function drawAvatar(canvas, agent, pose = 0) {
  const ctx = canvas.getContext("2d");
  canvas.width = 48;
  canvas.height = 60;
  ctx.imageSmoothingEnabled = false;
  sprite(ctx, 7, 2, agent.color, pose, agent.id === "reviewer", 2);
}

function sprite(ctx, x, y, color, pose, glasses, scale = 2) {
  const rows = [
    "....hhhhhh....",
    "...hhhhhhhh...",
    "...hhsssshh...",
    "...hssssssh...",
    "....seses.....",
    "....ssssss....",
    ".....ssss.....",
    "...cccccccc...",
    "..cccccccccc..",
    "..ssccccccss..",
    "..ssccccccss..",
    "....cccccc....",
    "....pppppp....",
    "....pp.ppp....",
    "....pp.ppp....",
    "...bbb.bbbb..."
  ];
  const colors = { h: "#4c463b", s: "#d6ac87", e: "#45443c", c: color, p: "#62685b", b: "#424d43" };
  rows.forEach((row, ry) => [...row].forEach((pixel, rx) => {
    if (!colors[pixel]) return;
    ctx.fillStyle = colors[pixel];
    const dx = (ry === 9 || ry === 10) && pose ? (rx < 7 ? -1 : 1) : 0;
    ctx.fillRect(x + (rx + dx) * scale, y + ry * scale, scale, scale);
  }));
  if (glasses) {
    ctx.fillStyle = "#4d5354";
    ctx.fillRect(x + 4 * scale, y + 4 * scale, 6 * scale, scale);
    ctx.fillStyle = "#aac1ad";
    ctx.fillRect(x + 4 * scale, y + 4 * scale, scale, scale);
    ctx.fillRect(x + 8 * scale, y + 4 * scale, scale, scale);
  }
}

export function deskPositions(count) {
  if (count <= 4) return [{ x: 320, y: 242 }, { x: 680, y: 242 }, { x: 320, y: 446 }, { x: 680, y: 446 }].slice(0, count);
  const columns = Math.ceil(count / 2);
  return Array.from({ length: count }, (_, index) => ({ x: 190 + (index % columns) * (620 / (columns - 1)), y: index < columns ? 242 : 446 }));
}

export class Office {
  constructor(canvas, getState, getLive) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.getState = getState;
    this.getLive = getLive;
    this.frame = 0;
    this.lastFrame = 0;
    this.request = requestAnimationFrame(this.tick.bind(this));
  }

  destroy() {
    cancelAnimationFrame(this.request);
  }

  tick(time) {
    if (time - this.lastFrame > 110) {
      this.draw(time);
      this.lastFrame = time;
    }
    this.request = requestAnimationFrame(this.tick.bind(this));
  }

  draw(time = 0) {
    const ctx = this.ctx;
    const state = this.getState();
    const motion = !state.reducedMotion && !matchMedia("(prefers-reduced-motion: reduce)").matches;
    const beat = motion ? Math.floor(time / 650) % 2 : 0;
    ctx.imageSmoothingEnabled = false;
    const r = (x, y, w, h, color) => { ctx.fillStyle = color; ctx.fillRect(x, y, w, h); };
    const text = (value, x, y, size = 10, color = "#8e987d") => { ctx.fillStyle = color; ctx.font = `${size}px monospace`; ctx.fillText(value, x, y); };
    const plant = (x, y, size = 1) => {
      r(x - 12 * size, y + 22 * size, 24 * size, 6 * size, "#c0c5a9");
      r(x - 10 * size, y, 20 * size, 24 * size, "#b8a68b");
      r(x - 12 * size, y - 3 * size, 24 * size, 7 * size, "#caba9e");
      r(x - 2 * size, y - 38 * size, 4 * size, 38 * size, "#7c9062");
      for (const [dx, dy, w] of [[-16, -37, 14], [1, -44, 13], [-23, -24, 21], [2, -29, 22], [-13, -51, 12]]) {
        r(x + dx * size, y + dy * size, w * size, 9 * size, "#829765");
        r(x + dx * size, y + dy * size, w * size, 3 * size, "#99aa7f");
      }
    };
    const window = (x, y) => {
      r(x - 7, y - 7, 169, 91, "#c2ccb5");
      r(x - 3, y - 3, 161, 83, "#f4f5e9");
      r(x + 3, y + 3, 149, 65, "#c5d9d0");
      r(x + 3, y + 40, 149, 28, "#b9cbb3");
      r(x + 13, y + 42, 16, 26, "#a9bd9b");
      r(x + 22, y + 33, 24, 35, "#b4c8a6");
      r(x + 109, y + 38, 30, 30, "#adc4a1");
      r(x + 119, y + 29, 14, 9, "#adc4a1");
      r(x + 77, y, 5, 73, "#eef0e2");
      r(x, y + 34, 155, 4, "#eef0e2");
      r(x - 8, y + 74, 173, 8, "#d6d8c3");
      r(x - 4, y + 82, 166, 4, "#aeb99d");
      r(x + 11, y + 5, 2, 26, "#dce8da");
    };
    r(0, 0, 1000, 610, "#e5e9da");
    r(22, 19, 956, 582, "#d3dac4");
    r(27, 24, 946, 571, "#e9eddf");
    r(27, 149, 946, 446, "#dedbc3");
    for (let y = 149, row = 0; y < 595; y += 26, row++) {
      for (let x = 27 - (row % 2) * 87; x < 973; x += 174) {
        const sx = Math.max(27, x);
        const width = Math.min(973, x + 174) - sx;
        r(sx, y, width, 25, (row + Math.floor(x / 174)) % 3 === 0 ? "#e5e1ca" : "#e8e4cd");
        r(sx, y + 25, width, 1, "#d5d2b9");
        if (x > 27) r(x, y, 1, 25, "#d9d6bf");
        if ((row + Math.floor(x / 174)) % 4 === 0) r(sx + 18, y + 12, Math.max(0, width - 49), 1, "#dedbc2");
      }
    }
    r(27, 146, 946, 7, "#cbd3bc");
    r(27, 153, 946, 4, "#d5d9c4");
    r(27, 590, 946, 5, "#c6c9ad");
    window(109, 51);
    window(736, 51);
    r(417, 45, 174, 85, "#aebaa0");
    r(421, 49, 166, 77, "#fafaf0");
    r(429, 57, 150, 61, "#f0f2e7");
    text("TEAM BOARD", 462, 70, 8, "#9ca78d");
    [[443, 81, "#b5c8a0"], [475, 83, "#d6c6a3"], [508, 81, "#c3b8d0"], [541, 83, "#b6c8d0"]].forEach(([x, y, color]) => {
      r(x, y, 21, 23, color);
      r(x + 4, y + 6, 12, 2, "#f9f9ee90");
      r(x + 4, y + 11, 9, 2, "#f9f9ee90");
    });
    r(425, 127, 158, 4, "#c4cbb5");
    r(531, 124, 13, 3, "#7e9472");
    r(549, 124, 10, 3, "#b7a374");
    plant(66, 142, .9);
    plant(936, 142, 1);
    r(47, 339, 98, 13, "#b5baa0");
    r(43, 296, 102, 45, "#bdc6a3");
    r(49, 301, 91, 32, "#cbd3b2");
    r(46, 332, 96, 38, "#a6b68c");
    r(51, 334, 41, 24, "#bfcca6");
    r(96, 334, 41, 24, "#bfcca6");
    r(39, 320, 11, 46, "#b4c19a");
    r(139, 320, 11, 46, "#b4c19a");
    r(50, 369, 9, 8, "#8b9479");
    r(132, 369, 9, 8, "#8b9479");
    r(59, 404, 79, 39, "#cecab0");
    r(54, 397, 86, 38, "#f0ecd7");
    r(56, 435, 5, 15, "#b5ae91");
    r(132, 435, 5, 15, "#b5ae91");
    r(75, 407, 16, 16, "#a7b78e");
    r(79, 410, 8, 9, "#c1cfaa");
    r(105, 405, 14, 19, "#c6ae8a");
    r(108, 406, 8, 3, "#e7dcc3");
    text("TAKE A BREAK", 50, 478, 7, "#a1a489");
    r(857, 300, 91, 93, "#beb89b");
    r(853, 291, 99, 12, "#e0d9bf");
    r(862, 307, 80, 76, "#d1c9ac");
    r(900, 308, 2, 74, "#bbb496");
    r(891, 339, 3, 15, "#a1a080");
    r(909, 339, 3, 15, "#a1a080");
    r(862, 259, 40, 32, "#6c7965");
    r(867, 264, 30, 20, "#83917b");
    r(878, 276, 10, 10, "#d8ddc6");
    r(913, 277, 14, 14, "#ece9d8");
    r(925, 280, 5, 7, "#ece9d8");
    plant(945, 451, .85);
    text("COFFEE STATION", 856, 410, 7, "#a0a48a");
    r(449, 350, 105, 63, "#d7d5b8");
    r(439, 345, 125, 63, "#d2d2b2");
    r(451, 339, 103, 73, "#d2d2b2");
    r(460, 346, 85, 57, "#dfe0c5");
    r(470, 351, 64, 46, "#e4e4cd");
    r(484, 364, 38, 27, "#c1bea3");
    r(480, 360, 46, 27, "#eee9d3");
    r(486, 384, 5, 13, "#bcb69b");
    r(515, 384, 5, 13, "#bcb69b");
    r(493, 365, 15, 10, "#b5bfa2");
    plant(503, 364, .26);
    text("COLLABORATION", 458, 429, 7, "#a0a48b");
    const positions = deskPositions(state.agents.length);
    const compact = state.agents.length > 4;
    state.agents.forEach((agent, index) => {
      const { x, y } = positions[index];
      const status = agentStatus(state, agent.id, this.getLive());
      const working = status.key === "working";
      const s = compact ? .76 : 1;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(s, s);
      r(-91, -17, 184, 72, "#c9c4a8");
      r(-92, -31, 184, 68, "#bbab89");
      r(-95, -37, 190, 63, "#e4caa0");
      r(-91, -33, 182, 4, "#efd7b3");
      r(-95, 26, 190, 7, "#c7ad83");
      r(-84, 33, 8, 24, "#a69775");
      r(77, 33, 8, 24, "#a69775");
      r(-75, -16, 22, 31, "#d6bd94");
      r(-71, -9, 14, 3, "#c5a883");
      r(-71, 2, 14, 3, "#c5a883");
      r(-45, -78, 82, 49, "#a1ab90");
      r(-48, -81, 82, 49, "#687761");
      r(-43, -76, 72, 38, working ? "#384f41" : "#647b60");
      r(-42, -75, 70, 5, "#84987b");
      const lines = working ? [41, 22, 49, 33] : [31, 42, 23];
      lines.forEach((width, i) => r(-35, -63 + i * 7, width, 2, working ? (i === 1 ? agent.color : "#a0b992") : "#9cad86"));
      if (working && beat) r(12, -42, 4, 3, "#c4d5a9");
      r(-12, -32, 10, 14, "#8e9b81");
      r(-27, -19, 40, 4, "#8e9b81");
      r(-41, -7, 72, 17, "#eff0db");
      for (let row = 0; row < 3; row++) for (let col = 0; col < 11; col++) r(-36 + col * 6, -4 + row * 4, 4, 2, "#c0c5aa");
      r(43, -3, 13, 15, "#ededda");
      r(49, -1, 1, 4, "#b5bea3");
      r(67, -26, 13, 15, "#f3ecdb");
      r(79, -24, 5, 8, "#f3ecdb");
      r(69, -26, 9, 3, "#b4a085");
      if (working && motion) {
        r(72, -35 - beat * 3, 2, 5, "#ebe7d2");
        r(77, -39 + beat * 2, 2, 4, "#ebe7d2");
      }
      r(-31, 43, 56, 41, "#9da98c");
      r(-28, 38, 50, 38, "#bcc8a4");
      r(-24, 42, 42, 28, "#cad4b3");
      r(-9, 80, 9, 18, "#85917c");
      r(-23, 96, 38, 4, "#89917d");
      sprite(ctx, -19, 17 + (working && motion ? beat : 0), agent.color, working && beat, agent.id === "reviewer", 2.2);
      if (status.key === "approval" || status.key === "blocked") {
        r(30, -7, 22, 22, "#e7d3a1");
        r(33, -4, 16, 16, "#fff4d4");
        text("!", 38, 8, 13, "#a38c52");
      }
      if (status.key === "unknown") {
        r(30, -7, 22, 22, "#c8cbb9");
        text("?", 37, 9, 13, "#919a80");
      }
      if (agent.binding && state.mode === "live") r(-72, -32, 5, 5, "#87a974");
      ctx.restore();
    });
    r(27, 24, 946, 3, "#f4f5e9");
    r(27, 24, 3, 571, "#f0f1df");
    r(970, 24, 3, 571, "#bec7ae");
    r(27, 592, 946, 3, "#b8bfa4");
    text("HERDR OFFICE", 444, 569, 9, "#acaf95");
  }
}
