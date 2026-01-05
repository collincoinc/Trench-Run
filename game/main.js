// game/main.js
(() => {
  "use strict";

  // ============================================================
  // Canvas
  // ============================================================
  const canvas = document.getElementById("game");
  /** @type {CanvasRenderingContext2D} */
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;

  // ============================================================
  // Input
  // ============================================================
  const keys = new Set();
  window.addEventListener(
    "keydown",
    (e) => {
      const k = e.key.toLowerCase();
      keys.add(k);
      if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(k)) e.preventDefault();
      if (k === "escape") game.togglePause();
      if (k === "enter") {
        if (game.state === "title" || game.state === "gameover") game.newGame();
      }
    },
    { passive: false }
  );
  window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
  const down = (k) => keys.has(k);

  // ============================================================
  // Helpers
  // ============================================================
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  function makeRng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (1664525 * s + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  // ============================================================
  // Tunables (you can tweak later)
  // ============================================================
  const TUNE = {
    // movement
    xSpeed: 7.1,
    ySpeed: 3.6,          // smaller than xSpeed (you asked “just a bit”)
    yClamp: 0.55,         // -0.55..+0.55 small vertical range

    // camera feel
    horizonBase: 120,
    yCameraShift: 26,     // how much up/down nudges projection
    cockpitBob: 0.9,      // subtle shake
    speedLines: 26,       // count of speed lines

    // trench motion
    slices: 40,
    segmentLen: 170,      // how fast the “rungs/panels” cycle forward
    rungEvery: 3,
    wallPanelEvery: 4,
    lightEvery: 7,
    greebleChance: 0.62,

    // difficulty (calm)
    enemyEnabled: true,
    enemySpawnMin: 1.4,
    enemySpawnMax: 2.4,
    enemyShotsEnabled: true,
    enemyShotRateScale: 0.25, // lower = fewer shots
    pipesEnabled: true,
    pipeChance: 0.32,
  };

  // ============================================================
  // Projection / camera
  // World: x left/right, z forward distance ahead.
  // We keep a tiny "yAim" that shifts projection to simulate up/down.
  // ============================================================
  const cam = {
    horizonY: TUNE.horizonBase,
    fov: 520,
    yOffset: 0,
    projectXZ(x, z) {
      const zz = Math.max(40, z);
      const s = this.fov / (zz + this.fov); // near bigger, far smaller
      const sx = W * 0.5 + x * s;

      // near -> bottom, far -> horizon
      let sy = this.horizonY + s * (H - this.horizonY);

      // simulate slight up/down camera movement:
      // (1 - s) makes far geometry shift more than near (pitch feel)
      sy += this.yOffset * (1 - s);

      return { x: sx, y: sy, s };
    },
  };

  // trench width (narrower far away)
  function trenchHalfWidthAt(z, nearHalf, farHalf, farZ) {
    const t = clamp((z - game.shipZ) / (farZ - game.shipZ), 0, 1);
    return lerp(nearHalf, farHalf, t);
  }

  // ============================================================
  // Entities (kept simple for now; we’ll polish later)
  // ============================================================
  class PlayerShot {
    constructor(x, z, kind) {
      this.x = x;
      this.z = z;
      this.kind = kind; // "laser" | "missile"
      this.alive = true;
      this.age = 0;
      this.speed = kind === "missile" ? 700 : 980;
      this.radius = kind === "missile" ? 22 : 12;
    }
    update(dt) {
      this.age += dt;
      this.z += this.speed * dt;
      this.z -= game.scrollSpeed * dt;
      if (this.z > game.renderFarZ + 300) this.alive = false;
    }
    draw() {
      const p = cam.projectXZ(this.x - game.ship.x, this.z);
      ctx.save();
      ctx.strokeStyle = "#e6f0ff";
      ctx.lineWidth = Math.max(1, 2.4 * p.s);

      if (this.kind === "laser") {
        ctx.beginPath();
        ctx.moveTo(p.x, p.y + 10 * p.s);
        ctx.lineTo(p.x, p.y - 14 * p.s);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(2.2, 5.2 * p.s), 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(p.x, p.y + 10 * p.s);
        ctx.lineTo(p.x, p.y - 18 * p.s);
        ctx.stroke();
      }

      // muzzle tracer (makes it feel like it’s firing from wing guns)
      if (this.age < 0.11 && this.kind === "laser") {
        const muzz = getWingMuzzlesScreen();
        const m = this.x < game.ship.x ? muzz.left : muzz.right;
        ctx.globalAlpha = 0.6;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(m.x, m.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      ctx.restore();
    }
  }

  class EnemyShot {
    constructor(x, z) {
      this.x = x;
      this.z = z;
      this.alive = true;
      this.speed = 720;
    }
    update(dt) {
      this.z -= this.speed * dt;
      this.z -= game.scrollSpeed * dt;
      if (this.z < game.shipZ - 240) this.alive = false;
    }
    draw() {
      const p = cam.projectXZ(this.x - game.ship.x, this.z);
      ctx.save();
      ctx.strokeStyle = "#e6f0ff";
      ctx.lineWidth = Math.max(1, 2.1 * p.s);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x, p.y + 12 * p.s);
      ctx.stroke();
      ctx.restore();
    }
  }

  class EnemyInterceptor {
    constructor(x, z, rng) {
      this.x = x;
      this.z = z;
      this.vx = (rng() * 2 - 1) * 0.42;
      this.hp = 2;
      this.fireCd = 1.2 + rng() * 1.4;
      this.alive = true;
    }
    update(dt) {
      const steer = clamp((game.ship.x - this.x) * 0.10, -0.22, 0.22);
      this.vx = clamp(this.vx + steer * dt, -0.8, 0.8);
      this.x += this.vx * dt * 60;

      this.z -= game.scrollSpeed * dt;

      // calm enemy fire
      if (TUNE.enemyShotsEnabled) {
        this.fireCd -= dt;
        const scale = clamp(1.0 - game.round * 0.05, 0.55, 1.0) / Math.max(0.15, TUNE.enemyShotRateScale);
        if (this.fireCd <= 0 && this.z < game.shipZ + 980 && this.z > game.shipZ + 260) {
          this.fireCd = (1.55 + Math.random() * 1.0) * scale;
          if (Math.random() < 0.35) game.enemyShots.push(new EnemyShot(this.x, this.z));
        }
      }

      if (this.z < game.shipZ - 120) this.alive = false;
    }
    draw() {
      const p = cam.projectXZ(this.x - game.ship.x, this.z);
      const s = p.s;
      const size = 18 + 42 * s;

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.strokeStyle = "#e6f0ff";
      ctx.lineWidth = Math.max(1, 2.2 * s);

      // wedge + fins silhouette
      ctx.beginPath();
      ctx.moveTo(0, -size * 0.72);
      ctx.lineTo(-size * 0.26, size * 0.12);
      ctx.lineTo(size * 0.26, size * 0.12);
      ctx.closePath();
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(-size * 0.12, size * 0.12);
      ctx.lineTo(-size * 0.18, size * 0.58);
      ctx.lineTo(size * 0.18, size * 0.58);
      ctx.lineTo(size * 0.12, size * 0.12);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(-size * 0.26, size * 0.22);
      ctx.lineTo(-size * 0.85, size * 0.36);
      ctx.lineTo(-size * 0.26, size * 0.50);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(size * 0.26, size * 0.22);
      ctx.lineTo(size * 0.85, size * 0.36);
      ctx.lineTo(size * 0.26, size * 0.50);
      ctx.stroke();

      ctx.restore();
    }
    hit(dmg) {
      this.hp -= dmg;
      if (this.hp <= 0) this.alive = false;
    }
  }

  class TrenchPipe {
    constructor(side, z, protrude, thickness) {
      this.side = side;
      this.z = z;
      this.protrude = protrude;
      this.thickness = thickness;
      this.alive = true;
    }
    update(dt) {
      this.z -= game.scrollSpeed * dt;
      if (this.z < game.shipZ - 260) this.alive = false;
    }
    draw() {
      const half = trenchHalfWidthAt(this.z, game.trenchNearHalf, game.trenchFarHalf, game.renderFarZ);
      const wallX = this.side * half;
      const innerX = wallX - this.side * this.protrude;

      const a = cam.projectXZ(wallX - game.ship.x, this.z);
      const b = cam.projectXZ(innerX - game.ship.x, this.z);

      ctx.save();
      ctx.strokeStyle = "#e6f0ff";
      ctx.lineWidth = Math.max(1, this.thickness * a.s * 0.65);

      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(b.x, b.y, Math.max(2, 6 * b.s), 0, Math.PI * 2);
      ctx.stroke();

      ctx.restore();
    }
    collidesWithShip() {
      if (Math.abs(this.z - game.shipZ) > 80) return false;
      const half = trenchHalfWidthAt(this.z, game.trenchNearHalf, game.trenchFarHalf, game.renderFarZ);
      const wallX = this.side * half;
      const innerX = wallX - this.side * this.protrude;

      const pipeMin = Math.min(wallX, innerX);
      const pipeMax = Math.max(wallX, innerX);
      return game.ship.x + game.shipHitR > pipeMin && game.ship.x - game.shipHitR < pipeMax;
    }
  }

  // ============================================================
  // Cockpit (better wings + barrels)
  // ============================================================
  function getWingMuzzlesScreen() {
    return {
      left: { x: W * 0.26, y: H - 86 },
      right: { x: W * 0.74, y: H - 86 },
    };
  }
  function getCenterMuzzleScreen() {
    return { x: W * 0.5, y: H - 92 };
  }

  function drawCockpit(t) {
    // subtle bob/shake
    const bob = Math.sin(t * 6.0) * TUNE.cockpitBob;
    const bob2 = Math.sin(t * 9.0) * (TUNE.cockpitBob * 0.55);

    ctx.save();
    ctx.translate(bob, bob2);

    ctx.strokeStyle = "rgba(230,240,255,0.90)";
    ctx.lineWidth = 2;

    // window frame
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.moveTo(W * 0.16, H - 160);
    ctx.lineTo(W * 0.16, H - 18);
    ctx.lineTo(W * 0.84, H - 18);
    ctx.lineTo(W * 0.84, H - 160);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // angled supports
    ctx.beginPath();
    ctx.moveTo(W * 0.20, H - 18);
    ctx.lineTo(W * 0.33, H - 170);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(W * 0.80, H - 18);
    ctx.lineTo(W * 0.67, H - 170);
    ctx.stroke();

    // dashboard base
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(40, H - 12);
    ctx.lineTo(W - 40, H - 12);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // --- wings (screen-space silhouettes) ---
    // Left wing edge
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    ctx.moveTo(W * 0.06, H - 20);
    ctx.lineTo(W * 0.24, H - 86);
    ctx.lineTo(W * 0.40, H - 86);
    ctx.stroke();

    // Right wing edge
    ctx.beginPath();
    ctx.moveTo(W * 0.94, H - 20);
    ctx.lineTo(W * 0.76, H - 86);
    ctx.lineTo(W * 0.60, H - 86);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // gun barrels at wing tips
    const muzz = getWingMuzzlesScreen();
    drawBarrel(muzz.left.x, muzz.left.y);
    drawBarrel(muzz.right.x, muzz.right.y);

    // center console
    ctx.globalAlpha = 0.55;
    ctx.strokeRect(W * 0.5 - 86, H - 132, 172, 104);
    ctx.globalAlpha = 1;

    // tiny instrument ticks
    ctx.globalAlpha = 0.45;
    for (let i = 0; i < 9; i++) {
      const x = W * 0.5 - 70 + i * 17;
      ctx.beginPath();
      ctx.moveTo(x, H - 40);
      ctx.lineTo(x, H - 52 - (i % 2) * 6);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    ctx.restore();
  }

  function drawBarrel(x, y) {
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = "rgba(230,240,255,0.95)";
    ctx.lineWidth = 2;

    // small mount
    ctx.beginPath();
    ctx.moveTo(-18, 0);
    ctx.lineTo(-6, -14);
    ctx.lineTo(18, -14);
    ctx.lineTo(26, 0);
    ctx.closePath();
    ctx.stroke();

    // barrel
    ctx.beginPath();
    ctx.moveTo(10, -14);
    ctx.lineTo(10, -34);
    ctx.stroke();

    // little side fin
    ctx.globalAlpha = 0.65;
    ctx.beginPath();
    ctx.moveTo(-2, -10);
    ctx.lineTo(-16, -2);
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.restore();
  }

  function drawReticle() {
    ctx.save();
    ctx.strokeStyle = "rgba(230,240,255,0.85)";
    ctx.lineWidth = 2;

    // reticle shifts a bit with vertical movement so it “feels” like you moved
    const cx = W * 0.5;
    const cy = H * 0.44 + game.ship.y * 18;

    ctx.beginPath();
    ctx.moveTo(cx - 18, cy);
    ctx.lineTo(cx + 18, cy);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(cx, cy - 18);
    ctx.lineTo(cx, cy + 18);
    ctx.stroke();

    ctx.globalAlpha = 0.65;
    ctx.strokeRect(cx - 34, cy - 34, 68, 68);
    ctx.globalAlpha = 1;

    ctx.restore();
  }

  function drawHUD() {
    ctx.save();
    ctx.fillStyle = "#e6f0ff";
    ctx.strokeStyle = "#e6f0ff";

    ctx.font = "16px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
    ctx.fillText(`SCORE ${game.score}`, 22, 34);
    ctx.font = "14px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
    ctx.globalAlpha = 0.9;
    ctx.fillText(`ROUND ${game.round}`, 22, 56);
    ctx.globalAlpha = 1;

    ctx.font = "16px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
    ctx.fillText(`LIVES ${game.lives}`, W - 130, 34);
    ctx.font = "14px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
    ctx.globalAlpha = 0.9;
    ctx.fillText(`MISSILES ${game.missiles}`, W - 170, 56);
    ctx.globalAlpha = 1;

    ctx.globalAlpha = 0.85;
    ctx.fillText(`SPEED ${Math.floor(game.scrollSpeed)}`, W * 0.5 - 56, 34);
    ctx.fillText(`COMBO x${game.combo}`, W * 0.5 - 56, 56);
    ctx.globalAlpha = 1;

    ctx.globalAlpha = 0.65;
    ctx.strokeRect(W * 0.5 - 34, 70, 68, 22);
    ctx.globalAlpha = 1;
    ctx.font = "14px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
    ctx.globalAlpha = 0.85;
    ctx.fillText(`LOCK`, W * 0.5 - 16, 87);
    ctx.globalAlpha = 1;

    ctx.restore();
  }

  function centerOverlay(title, lines) {
    ctx.save();
    ctx.fillStyle = "#e6f0ff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    ctx.font = "34px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
    ctx.fillText(title, W / 2, H / 2 - 30);

    ctx.font = "16px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
    let y = H / 2 + 10;
    for (const line of lines) {
      ctx.globalAlpha = 0.9;
      ctx.fillText(line, W / 2, y);
      y += 22;
    }
    ctx.globalAlpha = 1;

    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
    ctx.restore();
  }

  // ============================================================
  // Speed lines (helps “I am moving forward”)
  // ============================================================
  function drawSpeedLines(t) {
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = "#e6f0ff";
    ctx.lineWidth = 1;

    const r = makeRng(4242);
    for (let i = 0; i < TUNE.speedLines; i++) {
      const x = r() * W;
      const y = r() * (cam.horizonY + 40);
      const len = 18 + r() * 26;
      // animate downward from horizon, repeating
      const phase = (t * game.scrollSpeed * 0.18 + i * 23) % 220;
      const yy = y + phase;

      ctx.beginPath();
      ctx.moveTo(x, yy);
      ctx.lineTo(x, yy + len);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ============================================================
  // Trench drawing with TRUE motion (phase offset)
  // ============================================================
  function drawTrenchDetailed(t) {
    ctx.save();
    ctx.strokeStyle = "#e6f0ff";
    ctx.lineWidth = 2;

    const slices = TUNE.slices;
    const baseMin = game.shipZ + 100;
    const baseMax = game.renderFarZ;

    // This phase is the “secret sauce”: the trench texture flows toward you.
    const range = baseMax - baseMin;
    const phase = (t * game.scrollSpeed) % TUNE.segmentLen;

    let prevL = null;
    let prevR = null;

    for (let i = 0; i <= slices; i++) {
      const u = i / slices;

      // move features toward player by subtracting phase
      let z = baseMin + u * range - phase;

      // wrap so z stays in [baseMin, baseMax]
      while (z < baseMin) z += range;

      const half = trenchHalfWidthAt(z, game.trenchNearHalf, game.trenchFarHalf, game.renderFarZ);
      const Lw = -half;
      const Rw = half;

      const L = cam.projectXZ(Lw - game.ship.x, z);
      const R = cam.projectXZ(Rw - game.ship.x, z);

      if (prevL && prevR) {
        // rails
        ctx.beginPath();
        ctx.moveTo(prevL.x, prevL.y);
        ctx.lineTo(L.x, L.y);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(prevR.x, prevR.y);
        ctx.lineTo(R.x, R.y);
        ctx.stroke();
      }

      // floor rungs
      if (i % TUNE.rungEvery === 0) {
        ctx.globalAlpha = 0.45;
        ctx.beginPath();
        ctx.moveTo(L.x, L.y);
        ctx.lineTo(R.x, R.y);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // wall panels + greebles
      if (i % TUNE.wallPanelEvery === 0) {
        drawWallPanelAt(z, half, i);
      }

      // occasional light strip
      if (i % TUNE.lightEvery === 0) {
        drawWallLightAt(z, half);
      }

      prevL = L;
      prevR = R;
    }

    // center guideline
    ctx.globalAlpha = 0.22;
    const z0 = baseMin + 20;
    const z1 = baseMax - 20;
    const c0 = cam.projectXZ(0 - game.ship.x, z0);
    const c1 = cam.projectXZ(0 - game.ship.x, z1);
    ctx.beginPath();
    ctx.moveTo(c0.x, c0.y);
    ctx.lineTo(c1.x, c1.y);
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.restore();
  }

  function drawWallPanelAt(z, half, idx) {
    const r = makeRng(100000 + game.round * 97 + idx * 31 + Math.floor(z));
    const side = r() < 0.5 ? -1 : 1;

    const wallX = side * half;
    const inset = 22 + r() * 16;
    const panelX = wallX - side * inset;

    const p = cam.projectXZ(panelX - game.ship.x, z);
    const s = p.s;

    const w = (14 + r() * 18) * s;
    const h = (10 + r() * 22) * s;

    const y = p.y - (16 + r() * 18) * s;
    const x = p.x + side * (6 + r() * 8) * s;

    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 1;
    ctx.strokeRect(x - w / 2, y - h / 2, w, h);

    if (r() < TUNE.greebleChance) {
      ctx.globalAlpha = 0.22;
      ctx.strokeRect(x - w / 4, y - h / 4, w / 2, h / 2);
    }

    ctx.restore();
  }

  function drawWallLightAt(z, half) {
    const r = makeRng(80000 + Math.floor(z));
    const side = r() < 0.5 ? -1 : 1;
    const wallX = side * half;

    const p = cam.projectXZ(wallX - game.ship.x, z);
    const s = p.s;

    const len = (26 + r() * 34) * s;
    const x = p.x + side * (10 * s);
    const y = p.y - 28 * s;

    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.lineWidth = Math.max(1, 2 * s);
    ctx.beginPath();
    ctx.moveTo(x - len / 2, y);
    ctx.lineTo(x + len / 2, y);
    ctx.stroke();
    ctx.restore();
  }

  // ============================================================
  // Game state
  // ============================================================
  const game = {
    state: "title", // title | playing | paused | gameover
    rng: makeRng(1337),

    t: 0,

    round: 1,
    score: 0,
    combo: 0,
    lives: 3,
    missiles: 3,

    trenchNearHalf: 290,
    trenchFarHalf: 95,

    shipZ: 140,
    renderFarZ: 2600,

    ship: { x: 0, y: 0 }, // y is small “vertical position/aim”
    shipHitR: 36,

    scrollSpeed: 560,

    enemies: [],
    pipes: [],
    playerShots: [],
    enemyShots: [],

    enemyTimer: 0,
    pipeTimer: 0,

    fireCd: 0,
    missileCd: 0,

    togglePause() {
      if (this.state === "playing") this.state = "paused";
      else if (this.state === "paused") this.state = "playing";
    },

    newGame() {
      this.round = 1;
      this.score = 0;
      this.combo = 0;
      this.lives = 3;
      this.missiles = 3;

      this.scrollSpeed = 560;
      this.trenchNearHalf = 290;
      this.trenchFarHalf = 95;

      this.resetRound();
      this.state = "playing";
    },

    resetRound() {
      this.ship.x = 0;
      this.ship.y = 0;

      this.rng = makeRng(9000 + this.round * 101);

      this.enemies = [];
      this.pipes = [];
      this.playerShots = [];
      this.enemyShots = [];

      this.enemyTimer = 0.8;
      this.pipeTimer = 1.6;

      this.fireCd = 0;
      this.missileCd = 0;

      const seedCount = 1 + Math.min(2, Math.floor(this.round / 2));
      for (let i = 0; i < seedCount; i++) this.spawnEnemy(true);
    },

    loseLife() {
      this.lives -= 1;
      this.combo = 0;
      if (this.lives <= 0) this.state = "gameover";
      else this.resetRound();
    },

    nextRound() {
      this.round += 1;
      this.scrollSpeed = Math.min(900, this.scrollSpeed + 45);
      this.trenchNearHalf = Math.max(230, this.trenchNearHalf - 6);
      this.missiles = Math.min(6, this.missiles + 1);
      this.resetRound();
    },

    spawnEnemy(prefill = false) {
      if (!TUNE.enemyEnabled) return;
      const half = this.trenchNearHalf;
      const margin = 80;
      const x = (this.rng() * 2 - 1) * (half - margin);
      const z = prefill ? this.shipZ + 900 + this.rng() * 900 : this.shipZ + 1600 + this.rng() * 900;
      this.enemies.push(new EnemyInterceptor(x, z, this.rng));
    },

    spawnPipe() {
      if (!TUNE.pipesEnabled) return;
      const side = this.rng() < 0.5 ? -1 : 1;
      const z = this.shipZ + 1500 + this.rng() * 900;
      const protrude = 60 + this.rng() * 110;
      const thickness = 10 + this.rng() * 14;
      this.pipes.push(new TrenchPipe(side, z, protrude, thickness));
    },

    fireLaser() {
      if (this.fireCd > 0) return;
      this.fireCd = 0.10;

      const gunOffset = 78;
      const z0 = this.shipZ + 70;
      this.playerShots.push(new PlayerShot(this.ship.x - gunOffset, z0, "laser"));
      this.playerShots.push(new PlayerShot(this.ship.x + gunOffset, z0, "laser"));
    },
  };

  // ============================================================
  // Update
  // ============================================================
  function update(dt) {
    if (game.state !== "playing") return;

    game.t += dt;

    game.fireCd = Math.max(0, game.fireCd - dt);
    game.missileCd = Math.max(0, game.missileCd - dt);

    // Movement (left/right + slight up/down)
    const left = down("a") || down("arrowleft");
    const right = down("d") || down("arrowright");
    const up = down("w") || down("arrowup");
    const downKey = down("s") || down("arrowdown");

    const vx = (right ? 1 : 0) - (left ? 1 : 0);
    const vy = (downKey ? 1 : 0) - (up ? 1 : 0);

    game.ship.x += vx * TUNE.xSpeed * dt * 60;
    game.ship.y += vy * TUNE.ySpeed * dt * 60;

    game.ship.y = clamp(game.ship.y, -TUNE.yClamp, TUNE.yClamp);

    // constrain x within trench
    const half = trenchHalfWidthAt(game.shipZ, game.trenchNearHalf, game.trenchFarHalf, game.renderFarZ);
    game.ship.x = clamp(game.ship.x, -half + 70, half - 70);

    // Firing
    if (down(" ")) game.fireLaser();

    // Spawn enemies (calm)
    const enemyEvery = clamp(
      (TUNE.enemySpawnMin + (TUNE.enemySpawnMax - TUNE.enemySpawnMin) * game.rng()) - game.round * 0.03,
      0.75,
      2.8
    );
    game.enemyTimer -= dt;
    if (game.enemyTimer <= 0) {
      game.enemyTimer += enemyEvery;
      game.spawnEnemy(false);
    }

    // Pipes (rare)
    game.pipeTimer -= dt;
    const pipeEvery = clamp(2.6 - game.round * 0.06, 1.3, 2.6);
    if (game.pipeTimer <= 0) {
      game.pipeTimer += pipeEvery;
      if (Math.random() < TUNE.pipeChance) game.spawnPipe();
    }

    // Update entities
    for (const e of game.enemies) e.update(dt);
    for (const p of game.pipes) p.update(dt);
    for (const s of game.playerShots) s.update(dt);
    for (const s of game.enemyShots) s.update(dt);

    game.enemies = game.enemies.filter((e) => e.alive);
    game.pipes = game.pipes.filter((p) => p.alive);
    game.playerShots = game.playerShots.filter((s) => s.alive);
    game.enemyShots = game.enemyShots.filter((s) => s.alive);

    // Collisions: pipes vs ship
    for (const p of game.pipes) {
      if (p.collidesWithShip()) {
        game.loseLife();
        return;
      }
    }

    // Collisions: enemy shots vs ship
    for (const es of game.enemyShots) {
      if (Math.abs(es.z - game.shipZ) < 70) {
        if (Math.abs(es.x - game.ship.x) < game.shipHitR) {
          game.loseLife();
          return;
        }
      }
    }

    // Survival score
    game.score += Math.floor((6 + game.round * 2) * dt * 10);

    // TEMP: advance round manually until we add the vent/lock mission
    if (down("n")) {
      keys.delete("n");
      game.nextRound();
    }
  }

  // ============================================================
  // Render
  // ============================================================
  function render() {
    // Update camera offsets based on ship vertical movement
    cam.horizonY = TUNE.horizonBase;
    cam.yOffset = -game.ship.y * TUNE.yCameraShift;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#05070a";
    ctx.fillRect(0, 0, W, H);

    // frame
    ctx.strokeStyle = "rgba(230,240,255,0.25)";
    ctx.lineWidth = 1;
    ctx.strokeRect(10, 10, W - 20, H - 20);

    // speed lines + trench (now animated)
    drawSpeedLines(game.t);
    drawTrenchDetailed(game.t);

    // draw entities far-to-near
    const drawables = [];
    for (const p of game.pipes) drawables.push({ z: p.z, draw: () => p.draw() });
    for (const e of game.enemies) drawables.push({ z: e.z, draw: () => e.draw() });
    for (const s of game.playerShots) drawables.push({ z: s.z, draw: () => s.draw() });
    for (const s of game.enemyShots) drawables.push({ z: s.z, draw: () => s.draw() });

    drawables.sort((a, b) => b.z - a.z);
    for (const d of drawables) d.draw();

    // cockpit + reticle + hud
    drawCockpit(game.t);
    drawReticle();
    drawHUD();

    if (game.state === "title") {
      centerOverlay("TRENCH RUN", [
        "Press ENTER to start",
        "Move: WASD / Arrow Keys (up/down is small)",
        "Lasers: SPACE (wing guns)",
        "Debug: N = next round (for now)",
      ]);
    } else if (game.state === "paused") {
      centerOverlay("PAUSED", ["Press ESC to resume"]);
    } else if (game.state === "gameover") {
      centerOverlay("GAME OVER", ["Press ENTER to play again"]);
    }
  }

  // ============================================================
  // Loop
  // ============================================================
  let last = performance.now();
  function loop(now) {
    const dt = Math.min(0.033, (now - last) / 1000);
    last = now;
    update(dt);
    render();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
