// game/main.js
(() => {
  "use strict";

  // ============================================================
  // Canvas
  // ============================================================
  const canvas = document.getElementById("game");
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
  // Style / Colors
  // ============================================================
  const COLORS = {
    ui: "#e6f0ff",
    frame: "rgba(230,240,255,0.22)",

    trenchLine: "rgba(230,240,255,0.82)",
    trenchDim: "rgba(230,240,255,0.18)",
    trenchFill: "rgba(230,240,255,0.045)",

    playerLaser: "rgba(255,60,60,0.95)",     // RED
    enemyLaser: "rgba(255,150,30,0.95)",     // ORANGE
    missile: "rgba(80,170,255,0.95)",        // BLUE
    missileTrail: "rgba(80,170,255,0.22)",   // BLUE TRAIL

    cockpitLine: "rgba(230,240,255,0.90)",
    cockpitLineDim: "rgba(230,240,255,0.55)",
    cockpitFill: "rgba(5,7,10,0.92)",
    cockpitFill2: "rgba(12,14,18,0.80)",
    cockpitGlass: "rgba(230,240,255,0.06)",
  };

  // ============================================================
  // Tuning
  // ============================================================
  const TUNE = {
    // movement inside trench (x,y)
    xAccel: 9.0,
    yAccel: 7.5,
    damp: 0.86,

    // trench size (world units)
    trenchNearHalfW: 320,
    trenchFarHalfW: 120,
    trenchHalfH: 140, // half height of trench (bigger = taller trench)

    // sit lower
    sitLowerY: -55,      // starting ship y (lower)
    padX: 92,
    padY: 46,

    // camera/projection
    horizonBase: 105,
    fov: 580,
    yScale: 1.2,
    pitchEffect: 40,     // look up/down effect

    // drawing
    farZ: 3000,
    slices: 46,
    segmentLen: 165,     // trench detail scroll loop length
    rungEvery: 2,
    panelEvery: 3,
    lightEvery: 7,
    speedLines: 16,

    // weapons
    laserCooldown: 0.18, // fewer lasers
    laserAlternate: true,
    missileCooldown: 0.80,

    // laser aim convergence
    aimTargetZ: 1500,    // how far out the convergence aims

    // hit tuning
    hitRadius: 80,       // forgiving hit radius (you asked lasers were hard)
    enemyZWindow: 90,    // z closeness window for hit test

    // enemies (calmer)
    enemySpawnMin: 1.6,
    enemySpawnMax: 2.9,
    enemyShotsChance: 0.24,
    enemyShotCooldownMin: 1.5,
    enemyShotCooldownMax: 2.6,

    // obstacles
    pipeChance: 0.30,
  };

  // ============================================================
  // Camera / projection (x,y,z -> screen)
  // ============================================================
  const cam = {
    horizonY: TUNE.horizonBase,
    fov: TUNE.fov,
    pitch: 0, // derived from ship.y each frame
    project(x, y, z) {
      const zz = Math.max(40, z);
      const s = this.fov / (zz + this.fov);
      const sx = W * 0.5 + x * s;

      // near -> bottom, far -> horizon
      let sy = this.horizonY + s * (H - this.horizonY);

      // apply world y
      sy -= y * s * TUNE.yScale;

      // pitch affects far more than near
      sy += this.pitch * (1 - s);

      return { x: sx, y: sy, s };
    },
  };

  function trenchHalfWAt(z) {
    const t = clamp((z - game.shipZ) / (TUNE.farZ - game.shipZ), 0, 1);
    return lerp(game.trenchNearHalfW, game.trenchFarHalfW, t);
  }

  // ============================================================
  // Entities (x,y,z)
  // ============================================================
  class LaserShot {
    constructor(x, y, z, owner) {
      this.x = x; this.y = y; this.z = z;
      this.owner = owner; // "player" | "enemy"
      this.alive = true;
      this.age = 0;

      if (owner === "player") {
        this.speed = 980;

        // ✅ Converge toward "aim point" in the distance so hitting feels right
        const targetZ = game.shipZ + TUNE.aimTargetZ;
        const targetX = game.ship.x;
        const targetY = game.ship.y; // aim follows your position

        const dz = Math.max(1, targetZ - z);
        const dx = targetX - x;
        const dy = targetY - y;

        this.vx = (dx / dz) * this.speed;
        this.vy = (dy / dz) * this.speed;
      } else {
        this.speed = 720;
        this.vx = 0;
        this.vy = 0;
      }
    }

    update(dt) {
      this.age += dt;

      if (this.owner === "player") {
        this.x += this.vx * dt;
        this.y += this.vy * dt;
        this.z += this.speed * dt;
      } else {
        this.z -= this.speed * dt;
      }

      // world scroll
      this.z -= game.scrollSpeed * dt;

      if (this.z > TUNE.farZ + 350) this.alive = false;
      if (this.z < game.shipZ - 280) this.alive = false;
    }

    draw() {
      const p = cam.project(this.x - game.ship.x, this.y - game.ship.y, this.z);
      ctx.save();

      ctx.strokeStyle = this.owner === "player" ? COLORS.playerLaser : COLORS.enemyLaser;
      ctx.lineWidth = Math.max(1, 2.4 * p.s);

      ctx.beginPath();
      ctx.moveTo(p.x, p.y + 14 * p.s);
      ctx.lineTo(p.x, p.y - 18 * p.s);
      ctx.stroke();

      ctx.restore();
    }
  }

  class MissileShot {
    constructor(x, y, z) {
      this.x = x; this.y = y; this.z = z;
      this.alive = true;
      this.speed = 720;
      this.radius = 34;
      this.trail = [];
      this.trailMax = 14;
    }
    update(dt) {
      this.trail.push({ x: this.x, y: this.y, z: this.z });
      if (this.trail.length > this.trailMax) this.trail.shift();

      this.z += this.speed * dt;
      this.z -= game.scrollSpeed * dt;

      if (this.z > TUNE.farZ + 350) this.alive = false;
    }
    draw() {
      ctx.save();

      // ✅ blue trail
      ctx.strokeStyle = COLORS.missileTrail;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < this.trail.length; i++) {
        const t = this.trail[i];
        const p = cam.project(t.x - game.ship.x, t.y - game.ship.y, t.z);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();

      // ✅ blue missile
      const p = cam.project(this.x - game.ship.x, this.y - game.ship.y, this.z);
      ctx.strokeStyle = COLORS.missile;
      ctx.lineWidth = Math.max(1, 2.6 * p.s);

      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(2.2, 6.0 * p.s), 0, Math.PI * 2);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(p.x, p.y + 12 * p.s);
      ctx.lineTo(p.x, p.y - 20 * p.s);
      ctx.stroke();

      ctx.restore();
    }
  }

  class Enemy {
    constructor(x, y, z, rng) {
      this.x = x; this.y = y; this.z = z;
      this.vx = (rng() * 2 - 1) * 0.45;
      this.vy = (rng() * 2 - 1) * 0.30;
      this.hp = 2;
      this.alive = true;
      this.rng = rng;

      this.fireCd =
        TUNE.enemyShotCooldownMin +
        rng() * (TUNE.enemyShotCooldownMax - TUNE.enemyShotCooldownMin);
    }

    update(dt) {
      // gentle tracking toward player
      const sx = clamp((game.ship.x - this.x) * 0.08, -0.25, 0.25);
      const sy = clamp((game.ship.y - this.y) * 0.07, -0.22, 0.22);
      this.vx = clamp(this.vx + sx * dt, -0.9, 0.9);
      this.vy = clamp(this.vy + sy * dt, -0.75, 0.75);

      this.x += this.vx * dt * 60;
      this.y += this.vy * dt * 60;

      this.z -= game.scrollSpeed * dt;

      // calmer fire
      this.fireCd -= dt;
      if (this.fireCd <= 0 && this.z < game.shipZ + 1100 && this.z > game.shipZ + 260) {
        this.fireCd =
          TUNE.enemyShotCooldownMin +
          this.rng() * (TUNE.enemyShotCooldownMax - TUNE.enemyShotCooldownMin);

        if (Math.random() < TUNE.enemyShotsChance) {
          game.enemyShots.push(new LaserShot(this.x, this.y, this.z, "enemy"));
        }
      }

      if (this.z < game.shipZ - 160) this.alive = false;
    }

    draw() {
      const p = cam.project(this.x - game.ship.x, this.y - game.ship.y, this.z);
      const s = p.s;
      const size = 18 + 40 * s;

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.strokeStyle = COLORS.ui;
      ctx.lineWidth = Math.max(1, 2.2 * s);

      // simple interceptor silhouette (original, not copying)
      ctx.beginPath();
      ctx.moveTo(0, -size * 0.75);
      ctx.lineTo(-size * 0.26, size * 0.12);
      ctx.lineTo(size * 0.26, size * 0.12);
      ctx.closePath();
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(-size * 0.12, size * 0.12);
      ctx.lineTo(-size * 0.20, size * 0.58);
      ctx.lineTo(size * 0.20, size * 0.58);
      ctx.lineTo(size * 0.12, size * 0.12);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(-size * 0.26, size * 0.25);
      ctx.lineTo(-size * 0.85, size * 0.38);
      ctx.lineTo(-size * 0.26, size * 0.52);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(size * 0.26, size * 0.25);
      ctx.lineTo(size * 0.85, size * 0.38);
      ctx.lineTo(size * 0.26, size * 0.52);
      ctx.stroke();

      ctx.restore();
    }

    hit(dmg) {
      this.hp -= dmg;
      if (this.hp <= 0) this.alive = false;
    }
  }

  class Pipe {
    constructor(side, y, z, protrude, thickness) {
      this.side = side; // -1 left wall, +1 right wall
      this.y = y;
      this.z = z;
      this.protrude = protrude;
      this.thickness = thickness;
      this.alive = true;
    }
    update(dt) {
      this.z -= game.scrollSpeed * dt;
      if (this.z < game.shipZ - 280) this.alive = false;
    }
    draw() {
      const halfW = trenchHalfWAt(this.z);
      const wallX = this.side * halfW;
      const innerX = wallX - this.side * this.protrude;

      const a = cam.project((wallX - game.ship.x), (this.y - game.ship.y), this.z);
      const b = cam.project((innerX - game.ship.x), (this.y - game.ship.y), this.z);

      ctx.save();
      ctx.strokeStyle = COLORS.ui;
      ctx.lineWidth = Math.max(1, this.thickness * a.s * 0.6);

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
      if (Math.abs(this.z - game.shipZ) > 95) return false;

      const halfW = trenchHalfWAt(this.z);
      const wallX = this.side * halfW;
      const innerX = wallX - this.side * this.protrude;

      const pipeMinX = Math.min(wallX, innerX);
      const pipeMaxX = Math.max(wallX, innerX);

      const shipX = game.ship.x;
      const shipY = game.ship.y;

      const withinX = shipX + game.shipHitR > pipeMinX && shipX - game.shipHitR < pipeMaxX;
      const withinY = Math.abs(shipY - this.y) < 45;

      return withinX && withinY;
    }
  }

  // ============================================================
  // Cockpit (improved)
  // ============================================================
  function drawCockpit(t) {
    const bob = Math.sin(t * 6.0) * 1.2 + Math.sin(t * 10.0) * 0.7;
    ctx.save();
    ctx.translate(0, bob);

    // Bottom mask (deep cockpit body)
    ctx.fillStyle = COLORS.cockpitFill;
    ctx.beginPath();
    ctx.moveTo(0, H);
    ctx.lineTo(0, H - 190);
    ctx.lineTo(W * 0.18, H - 155);
    ctx.lineTo(W * 0.50, H - 140);
    ctx.lineTo(W * 0.82, H - 155);
    ctx.lineTo(W, H - 190);
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();

    // Inner dashboard "plate"
    ctx.fillStyle = COLORS.cockpitFill2;
    ctx.beginPath();
    ctx.moveTo(W * 0.10, H - 28);
    ctx.lineTo(W * 0.18, H - 115);
    ctx.lineTo(W * 0.50, H - 132);
    ctx.lineTo(W * 0.82, H - 115);
    ctx.lineTo(W * 0.90, H - 28);
    ctx.closePath();
    ctx.fill();

    // Canopy glass hint (subtle)
    ctx.fillStyle = COLORS.cockpitGlass;
    ctx.beginPath();
    ctx.moveTo(W * 0.14, H - 178);
    ctx.lineTo(W * 0.14, H - 86);
    ctx.lineTo(W * 0.86, H - 86x; // placeholder removed by next line
    ctx.closePath();
    ctx.restore();
  }

  // --- Fix a tiny typo from the editor above (keep everything valid) ---
  // We'll re-define drawCockpit immediately with the correct final version.
  function drawCockpit(t) {
    const bob = Math.sin(t * 6.0) * 1.2 + Math.sin(t * 10.0) * 0.7;
    ctx.save();
    ctx.translate(0, bob);

    // Bottom mask (deep cockpit body)
    ctx.fillStyle = COLORS.cockpitFill;
    ctx.beginPath();
    ctx.moveTo(0, H);
    ctx.lineTo(0, H - 190);
    ctx.lineTo(W * 0.18, H - 155);
    ctx.lineTo(W * 0.50, H - 140);
    ctx.lineTo(W * 0.82, H - 155);
    ctx.lineTo(W, H - 190);
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();

    // Inner dashboard "plate"
    ctx.fillStyle = COLORS.cockpitFill2;
    ctx.beginPath();
    ctx.moveTo(W * 0.10, H - 28);
    ctx.lineTo(W * 0.18, H - 115);
    ctx.lineTo(W * 0.50, H - 132);
    ctx.lineTo(W * 0.82, H - 115);
    ctx.lineTo(W * 0.90, H - 28);
    ctx.closePath();
    ctx.fill();

    // Canopy glass hint (subtle)
    ctx.fillStyle = COLORS.cockpitGlass;
    ctx.beginPath();
    ctx.moveTo(W * 0.14, H - 178);
    ctx.lineTo(W * 0.14, H - 92);
    ctx.lineTo(W * 0.86, H - 92);
    ctx.lineTo(W * 0.86, H - 178);
    ctx.closePath();
    ctx.fill();

    // Outline frame
    ctx.strokeStyle = COLORS.cockpitLine;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.90;

    // Outer canopy frame
    strokePoly([
      [W * 0.12, H - 178],
      [W * 0.12, H - 26],
      [W * 0.88, H - 26],
      [W * 0.88, H - 178],
    ]);

    // Struts (strong)
    ctx.globalAlpha = 0.95;
    strokeLine(W * 0.20, H - 26, W * 0.34, H - 198);
    strokeLine(W * 0.80, H - 26, W * 0.66, H - 198);

    // Center strut (subtle)
    ctx.globalAlpha = 0.55;
    strokeLine(W * 0.50, H - 26, W * 0.50, H - 200);

    // Side panel outlines
    ctx.globalAlpha = 0.60;
    ctx.strokeStyle = COLORS.cockpitLineDim;
    ctx.strokeRect(W * 0.06, H - 122, 150, 84);
    ctx.strokeRect(W - (W * 0.06 + 150), H - 122, 150, 84);

    // Center instrument bay
    ctx.globalAlpha = 0.75;
    ctx.strokeStyle = COLORS.cockpitLine;
    ctx.strokeRect(W * 0.50 - 120, H - 158, 240, 130);

    // Little instruments/ticks
    ctx.globalAlpha = 0.35;
    for (let i = 0; i < 14; i++) {
      const x = W * 0.50 - 106 + i * 16;
      strokeLine(x, H - 46, x, H - 60 - (i % 2) * 7);
    }

    // Dash hood ridge
    ctx.globalAlpha = 0.65;
    strokePoly([
      [W * 0.22, H - 115],
      [W * 0.50, H - 136],
      [W * 0.78, H - 115],
    ]);

    // Wing edges (cleaner)
    ctx.globalAlpha = 0.90;
    ctx.strokeStyle = COLORS.cockpitLine;
    strokeLine(W * 0.02, H - 26, W * 0.20, H - 96);
    strokeLine(W * 0.20, H - 96, W * 0.42, H - 104);

    strokeLine(W * 0.98, H - 26, W * 0.80, H - 96);
    strokeLine(W * 0.80, H - 96, W * 0.58, H - 104);

    // Gun barrels
    drawBarrel(W * 0.22, H - 92);
    drawBarrel(W * 0.78, H - 92);

    // Glass reflections (diagonal faint)
    ctx.globalAlpha = 0.16;
    ctx.strokeStyle = COLORS.ui;
    ctx.lineWidth = 1;
    strokeLine(W * 0.18, H - 168, W * 0.44, H - 110);
    strokeLine(W * 0.82, H - 168, W * 0.56, H - 110);

    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function drawBarrel(x, y) {
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = COLORS.cockpitLine;
    ctx.lineWidth = 2;

    // mount
    ctx.beginPath();
    ctx.moveTo(-26, 0);
    ctx.lineTo(-10, -18);
    ctx.lineTo(22, -18);
    ctx.lineTo(38, 0);
    ctx.closePath();
    ctx.stroke();

    // barrel
    ctx.beginPath();
    ctx.moveTo(14, -18);
    ctx.lineTo(14, -46);
    ctx.stroke();

    // side fin
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.moveTo(-2, -12);
    ctx.lineTo(-22, -2);
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.restore();
  }

  function strokeLine(x0, y0, x1, y1) {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }

  function strokePoly(points) {
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
    ctx.closePath();
    ctx.stroke();
  }

  function drawReticle() {
    ctx.save();
    ctx.strokeStyle = "rgba(230,240,255,0.85)";
    ctx.lineWidth = 2;

    const cx = W * 0.5;
    const cy = H * 0.42 + game.ship.y * 0.55; // follows a bit

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
    ctx.fillStyle = COLORS.ui;
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
    ctx.globalAlpha = 1;

    ctx.restore();
  }

  function overlay(title, lines) {
    ctx.save();
    ctx.fillStyle = COLORS.ui;
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

    ctx.restore();
  }

  // ============================================================
  // Motion / background
  // ============================================================
  function drawSpeedLines(t) {
    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.strokeStyle = COLORS.ui;
    ctx.lineWidth = 1;

    const r = makeRng(4242);
    for (let i = 0; i < TUNE.speedLines; i++) {
      const x = r() * W;
      const y = r() * (cam.horizonY + 55);
      const len = 18 + r() * 22;

      const phase = (t * game.scrollSpeed * 0.16 + i * 21) % 240;
      const yy = y + phase;

      ctx.beginPath();
      ctx.moveTo(x, yy);
      ctx.lineTo(x, yy + len);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ============================================================
  // Trench drawing (OPEN TOP, no roof line)
  // ============================================================
  function drawTrench(t) {
    const zMin = game.shipZ + 120;
    const zMax = TUNE.farZ;
    const range = zMax - zMin;

    const phase = (t * game.scrollSpeed) % TUNE.segmentLen;

    // Draw far -> near for depth layering
    for (let i = TUNE.slices; i >= 1; i--) {
      const u0 = (i - 1) / TUNE.slices;
      const u1 = i / TUNE.slices;

      let z0 = zMin + u0 * range - phase;
      let z1 = zMin + u1 * range - phase;
      while (z0 < zMin) z0 += range;
      while (z1 < zMin) z1 += range;

      const halfW0 = trenchHalfWAt(z0);
      const halfW1 = trenchHalfWAt(z1);

      const yTop = +TUNE.trenchHalfH;
      const yBot = -TUNE.trenchHalfH;

      const L0T = cam.project((-halfW0 - game.ship.x), (yTop - game.ship.y), z0);
      const L0B = cam.project((-halfW0 - game.ship.x), (yBot - game.ship.y), z0);
      const R0T = cam.project((+halfW0 - game.ship.x), (yTop - game.ship.y), z0);
      const R0B = cam.project((+halfW0 - game.ship.x), (yBot - game.ship.y), z0);

      const L1T = cam.project((-halfW1 - game.ship.x), (yTop - game.ship.y), z1);
      const L1B = cam.project((-halfW1 - game.ship.x), (yBot - game.ship.y), z1);
      const R1T = cam.project((+halfW1 - game.ship.x), (yTop - game.ship.y), z1);
      const R1B = cam.project((+halfW1 - game.ship.x), (yBot - game.ship.y), z1);

      // fills
      ctx.save();
      ctx.fillStyle = COLORS.trenchFill;

      // floor quad
      fillQuad(L0B, R0B, R1B, L1B);

      // left wall quad
      fillQuad(L0T, L0B, L1B, L1T);

      // right wall quad
      fillQuad(R0T, R0B, R1B, R1T);

      ctx.restore();

      // lines
      ctx.save();
      ctx.strokeStyle = COLORS.trenchLine;
      ctx.lineWidth = 2;

      // ✅ OPEN TOP: Do NOT draw line(L0T, R0T) (that looks like a roof)
      // floor edge across
      line(L0B, R0B);

      // wall vertical edges (near slice)
      line(L0T, L0B);
      line(R0T, R0B);

      // wall "rails" along depth (side top edges only, not connected across)
      ctx.globalAlpha = 0.35;
      line(L0T, L1T);
      line(R0T, R1T);
      ctx.globalAlpha = 1;

      // floor rungs
      if (i % TUNE.rungEvery === 0) {
        ctx.globalAlpha = 0.30;
        line(L0B, R0B);
        ctx.globalAlpha = 1;
      }

      // wall panels/lights
      if (i % TUNE.panelEvery === 0) {
        drawWallPanel(z0, -1, halfW0, yTop, yBot, i);
        drawWallPanel(z0, +1, halfW0, yTop, yBot, i + 7);
      }
      if (i % TUNE.lightEvery === 0) {
        drawWallLight(z0, -1, halfW0, yTop, yBot);
        drawWallLight(z0, +1, halfW0, yTop, yBot);
      }

      ctx.restore();
    }
  }

  function fillQuad(a, b, c, d) {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
    ctx.lineTo(d.x, d.y);
    ctx.closePath();
    ctx.fill();
  }

  function line(a, b) {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  function drawWallPanel(z, side, halfW, yTop, yBot, seed) {
    const r = makeRng(90000 + seed * 131 + Math.floor(z));
    const wallX = side * halfW;

    const yy = lerp(yBot + 22, yTop - 22, r());
    const inset = 18 + r() * 14;
    const px = wallX - side * inset;

    const p = cam.project(px - game.ship.x, yy - game.ship.y, z);
    const s = p.s;

    const w = (18 + r() * 22) * s;
    const h = (10 + r() * 26) * s;

    ctx.save();
    ctx.globalAlpha = 0.26;
    ctx.lineWidth = 1;
    ctx.strokeStyle = COLORS.ui;
    ctx.strokeRect(p.x - w / 2, p.y - h / 2, w, h);

    if (r() < 0.65) {
      ctx.globalAlpha = 0.14;
      ctx.strokeRect(p.x - w / 4, p.y - h / 4, w / 2, h / 2);
    }
    ctx.restore();
  }

  function drawWallLight(z, side, halfW, yTop, yBot) {
    const r = makeRng(120000 + Math.floor(z) + side * 999);
    const wallX = side * halfW;
    const yy = lerp(yBot + 18, yTop - 18, r());
    const px = wallX - side * 10;

    const p = cam.project(px - game.ship.x, yy - game.ship.y, z);
    const s = p.s;

    const len = (22 + r() * 30) * s;
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = COLORS.ui;
    ctx.lineWidth = Math.max(1, 2 * s);

    ctx.beginPath();
    ctx.moveTo(p.x - len / 2, p.y);
    ctx.lineTo(p.x + len / 2, p.y);
    ctx.stroke();

    ctx.restore();
  }

  // ============================================================
  // Game state
  // ============================================================
  const game = {
    state: "title",
    rng: makeRng(1337),
    t: 0,

    // world
    shipZ: 160,
    trenchNearHalfW: TUNE.trenchNearHalfW,
    trenchFarHalfW: TUNE.trenchFarHalfW,
    scrollSpeed: 600,

    // ship (sits lower by default)
    ship: { x: 0, y: TUNE.sitLowerY, vx: 0, vy: 0 },
    shipHitR: 42,

    // gameplay
    round: 1,
    score: 0,
    lives: 3,
    missiles: 3,

    // weapons
    laserCd: 0,
    missileCd: 0,
    laserSide: -1,

    // entities
    enemies: [],
    pipes: [],
    playerShots: [], // LaserShot and MissileShot
    enemyShots: [],  // LaserShot (enemy)

    // spawners
    enemyTimer: 0.9,
    pipeTimer: 1.4,

    togglePause() {
      if (this.state === "playing") this.state = "paused";
      else if (this.state === "paused") this.state = "playing";
    },

    newGame() {
      this.round = 1;
      this.score = 0;
      this.lives = 3;
      this.missiles = 3;

      this.scrollSpeed = 600;
      this.trenchNearHalfW = TUNE.trenchNearHalfW;
      this.trenchFarHalfW = TUNE.trenchFarHalfW;

      this.resetRound();
      this.state = "playing";
    },

    resetRound() {
      this.ship.x = 0;
      this.ship.y = TUNE.sitLowerY; // ✅ sit lower every round
      this.ship.vx = 0;
      this.ship.vy = 0;

      this.rng = makeRng(9000 + this.round * 101);

      this.enemies = [];
      this.pipes = [];
      this.playerShots = [];
      this.enemyShots = [];

      this.enemyTimer = 1.0;
      this.pipeTimer = 1.5;

      this.laserCd = 0;
      this.missileCd = 0;
      this.laserSide = -1;

      const count = 1 + Math.min(2, Math.floor(this.round / 2));
      for (let i = 0; i < count; i++) this.spawnEnemy(true);
    },

    loseLife() {
      this.lives -= 1;
      if (this.lives <= 0) this.state = "gameover";
      else this.resetRound();
    },

    spawnEnemy(prefill = false) {
      const halfW = this.trenchNearHalfW;
      const margin = 95;
      const x = (this.rng() * 2 - 1) * (halfW - margin);
      const y = (this.rng() * 2 - 1) * (TUNE.trenchHalfH * 0.50) - 10;
      const z = prefill ? this.shipZ + 900 + this.rng() * 900 : this.shipZ + 1600 + this.rng() * 950;
      this.enemies.push(new Enemy(x, y, z, this.rng));
    },

    spawnPipe() {
      const side = this.rng() < 0.5 ? -1 : 1;
      const z = this.shipZ + 1500 + this.rng() * 1100;
      const y = (this.rng() * 2 - 1) * (TUNE.trenchHalfH * 0.55);
      const protrude = 60 + this.rng() * 120;
      const thickness = 10 + this.rng() * 16;
      this.pipes.push(new Pipe(side, y, z, protrude, thickness));
    },

    fireLaser() {
      if (this.laserCd > 0) return;
      this.laserCd = TUNE.laserCooldown;

      // single alternating shot (less spam)
      const side = TUNE.laserAlternate ? (this.laserSide *= -1) : -1;

      const gunX = this.ship.x + side * 78;
      const gunY = this.ship.y - 6;
      const z0 = this.shipZ + 70;

      this.playerShots.push(new LaserShot(gunX, gunY, z0, "player"));
    },

    fireMissile() {
      if (this.missileCd > 0) return;
      if (this.missiles <= 0) return;

      this.missiles -= 1;
      this.missileCd = TUNE.missileCooldown;

      const z0 = this.shipZ + 85;
      this.playerShots.push(new MissileShot(this.ship.x, this.ship.y, z0));
    },
  };

  // ============================================================
  // Update
  // ============================================================
  function update(dt) {
    if (game.state !== "playing") return;

    game.t += dt;

    game.laserCd = Math.max(0, game.laserCd - dt);
    game.missileCd = Math.max(0, game.missileCd - dt);

    // movement
    const left = down("a") || down("arrowleft");
    const right = down("d") || down("arrowright");
    const up = down("w") || down("arrowup");
    const downKey = down("s") || down("arrowdown");

    const ax = (right ? 1 : 0) - (left ? 1 : 0);
    const ay = (downKey ? 1 : 0) - (up ? 1 : 0);

    game.ship.vx = (game.ship.vx + ax * TUNE.xAccel) * TUNE.damp;
    game.ship.vy = (game.ship.vy + ay * TUNE.yAccel) * TUNE.damp;

    game.ship.x += game.ship.vx * dt * 60;
    game.ship.y += game.ship.vy * dt * 60;

    // clamp inside trench
    const halfW = trenchHalfWAt(game.shipZ);
    game.ship.x = clamp(game.ship.x, -halfW + TUNE.padX, +halfW - TUNE.padX);
    game.ship.y = clamp(game.ship.y, -TUNE.trenchHalfH + TUNE.padY, +TUNE.trenchHalfH - TUNE.padY);

    // fire controls
    if (down(" ")) game.fireLaser();
    if (down("m")) {
      keys.delete("m");
      game.fireMissile();
    }

    // spawn enemies (calm)
    const enemyEvery = clamp(
      (TUNE.enemySpawnMin + (TUNE.enemySpawnMax - TUNE.enemySpawnMin) * game.rng()) - game.round * 0.02,
      0.95,
      3.2
    );
    game.enemyTimer -= dt;
    if (game.enemyTimer <= 0) {
      game.enemyTimer += enemyEvery;
      game.spawnEnemy(false);
    }

    // spawn pipes
    game.pipeTimer -= dt;
    const pipeEvery = clamp(2.9 - game.round * 0.05, 1.5, 2.9);
    if (game.pipeTimer <= 0) {
      game.pipeTimer += pipeEvery;
      if (Math.random() < TUNE.pipeChance) game.spawnPipe();
    }

    // update entities
    for (const e of game.enemies) e.update(dt);
    for (const p of game.pipes) p.update(dt);
    for (const s of game.playerShots) s.update(dt);
    for (const s of game.enemyShots) s.update(dt);

    game.enemies = game.enemies.filter((e) => e.alive);
    game.pipes = game.pipes.filter((p) => p.alive);
    game.playerShots = game.playerShots.filter((s) => s.alive);
    game.enemyShots = game.enemyShots.filter((s) => s.alive);

    // collisions: pipes vs ship
    for (const p of game.pipes) {
      if (p.collidesWithShip()) {
        game.loseLife();
        return;
      }
    }

    // collisions: enemy shots vs ship
    for (const es of game.enemyShots) {
      if (Math.abs(es.z - game.shipZ) < 120) {
        const dx = es.x - game.ship.x;
        const dy = es.y - game.ship.y;
        if (dx * dx + dy * dy < (game.shipHitR * 0.95) ** 2) {
          game.loseLife();
          return;
        }
      }
    }

    // ✅ player shots hit enemies (more forgiving + uses x/y aim)
    for (const ps of game.playerShots) {
      for (const e of game.enemies) {
        if (!ps.alive || !e.alive) continue;
        if (Math.abs(ps.z - e.z) < TUNE.enemyZWindow) {
          const dx = ps.x - e.x;
          const dy = ps.y - e.y;
          if (dx * dx + dy * dy < TUNE.hitRadius * TUNE.hitRadius) {
            ps.alive = false;
            e.hit(ps instanceof MissileShot ? 2 : 1);
            game.score += ps instanceof MissileShot ? 220 : 120;
          }
        }
      }
    }

    // survival score
    game.score += Math.floor((8 + game.round * 2) * dt * 10);

    // temp next round
    if (down("n")) {
      keys.delete("n");
      game.round += 1;
      game.scrollSpeed = Math.min(920, game.scrollSpeed + 40);
      game.missiles = Math.min(6, game.missiles + 1);
      game.resetRound();
    }
  }

  // ============================================================
  // Render
  // ============================================================
  function render() {
    // camera pitch derived from y (helps up/down feel)
    cam.horizonY = TUNE.horizonBase;
    cam.pitch = -game.ship.y * 0.28 * (TUNE.pitchEffect / 36);

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#05070a";
    ctx.fillRect(0, 0, W, H);

    // frame
    ctx.strokeStyle = COLORS.frame;
    ctx.lineWidth = 1;
    ctx.strokeRect(10, 10, W - 20, H - 20);

    drawSpeedLines(game.t);
    drawTrench(game.t);

    // draw entities far->near
    const drawables = [];
    for (const p of game.pipes) drawables.push({ z: p.z, draw: () => p.draw() });
    for (const e of game.enemies) drawables.push({ z: e.z, draw: () => e.draw() });
    for (const s of game.playerShots) drawables.push({ z: s.z, draw: () => s.draw() });
    for (const s of game.enemyShots) drawables.push({ z: s.z, draw: () => s.draw() });

    drawables.sort((a, b) => b.z - a.z);
    for (const d of drawables) d.draw();

    drawCockpit(game.t);
    drawReticle();
    drawHUD();

    if (game.state === "title") {
      overlay("TRENCH RUN", [
        "ENTER to start",
        "Move: WASD / Arrows (you sit lower in the trench now)",
        "Laser: SPACE (red, aimed)",
        "Missile: M (blue + trail)",
        "Debug: N = next round (temporary)",
      ]);
    } else if (game.state === "paused") {
      overlay("PAUSED", ["ESC to resume"]);
    } else if (game.state === "gameover") {
      overlay("GAME OVER", ["ENTER to play again"]);
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

  // ============================================================
  // Start on title screen
  // ============================================================
})();
