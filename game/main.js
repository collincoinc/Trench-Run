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
  // Visual style / colors
  // ============================================================
  const COLORS = {
    ui: "#e6f0ff",
    trenchLine: "rgba(230,240,255,0.85)",
    trenchDim: "rgba(230,240,255,0.20)",
    trenchFill: "rgba(230,240,255,0.045)",

    playerLaser: "rgba(255,60,60,0.95)",     // RED
    missile: "rgba(80,170,255,0.95)",        // BLUE
    missileTrail: "rgba(80,170,255,0.22)",   // BLUE TRAIL
    enemyLaser: "rgba(255,150,30,0.95)",     // ORANGE

    cockpitLine: "rgba(230,240,255,0.90)",
    cockpitFill: "rgba(10,12,16,0.80)",
    cockpitFill2: "rgba(5,7,10,0.92)",
  };

  // ============================================================
  // Tuning
  // ============================================================
  const TUNE = {
    // movement (now real 2D inside trench: x and y)
    xSpeed: 8.2,
    ySpeed: 6.0,            // more than before (you asked “much more work”)
    xDamp: 0.88,
    yDamp: 0.88,

    // trench dimensions (world units)
    trenchNearHalfW: 310,
    trenchFarHalfW: 110,
    trenchHalfH: 120,       // trench height / 2

    // camera / projection
    horizonBase: 110,
    fov: 560,
    yScale: 1.15,           // vertical exaggeration (helps “inside trench” feel)
    pitchEffect: 36,        // how much looking up/down shifts far geometry

    // draw
    farZ: 2800,
    slices: 44,
    rungEvery: 2,
    panelEvery: 3,
    lightEvery: 7,

    // forward motion feel
    segmentLen: 160,        // trench texture scroll cycle length
    speedLines: 18,

    // weapons
    laserCooldown: 0.14,    // fewer lasers
    laserAlternate: true,   // left, right, left, right
    missileCooldown: 0.75,

    // difficulty calmer
    enemySpawnMin: 1.4,
    enemySpawnMax: 2.6,
    enemyShotsChance: 0.26, // per fire event
    enemyShotCooldownMin: 1.3,
    enemyShotCooldownMax: 2.2,

    pipeChance: 0.35,       // occasional wall pipes
  };

  // ============================================================
  // World + camera projection (x,y,z -> screen)
  // ============================================================
  const cam = {
    horizonY: TUNE.horizonBase,
    fov: TUNE.fov,
    pitch: 0, // derived from ship.y each frame
    project(x, y, z) {
      const zz = Math.max(40, z);
      const s = this.fov / (zz + this.fov);

      // x is left/right
      const sx = W * 0.5 + x * s;

      // base: near -> bottom, far -> horizon
      let sy = this.horizonY + s * (H - this.horizonY);

      // apply vertical world coordinate
      sy -= y * s * TUNE.yScale;

      // pitch (looking up/down affects far stuff more)
      sy += this.pitch * (1 - s);

      return { x: sx, y: sy, s };
    },
  };

  function trenchHalfWAt(z) {
    const t = clamp((z - game.shipZ) / (TUNE.farZ - game.shipZ), 0, 1);
    return lerp(game.trenchNearHalfW, game.trenchFarHalfW, t);
  }

  // ============================================================
  // Entities (now x,y,z)
  // ============================================================
  class LaserShot {
    constructor(x, y, z, owner) {
      this.x = x; this.y = y; this.z = z;
      this.owner = owner; // "player" | "enemy"
      this.alive = true;
      this.speed = owner === "player" ? 980 : 720;
      this.radius = owner === "player" ? 20 : 18;
      this.age = 0;
    }
    update(dt) {
      this.age += dt;

      if (this.owner === "player") {
        this.z += this.speed * dt;
      } else {
        this.z -= this.speed * dt;
      }

      // world scroll pulls everything toward player
      this.z -= game.scrollSpeed * dt;

      if (this.z > TUNE.farZ + 300) this.alive = false;
      if (this.z < game.shipZ - 260) this.alive = false;
    }
    draw() {
      const px = this.x - game.ship.x;
      const py = this.y - game.ship.y;

      const p = cam.project(px, py, this.z);
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
      // record trail
      this.trail.push({ x: this.x, y: this.y, z: this.z });
      if (this.trail.length > this.trailMax) this.trail.shift();

      this.z += this.speed * dt;
      this.z -= game.scrollSpeed * dt;

      if (this.z > TUNE.farZ + 300) this.alive = false;
    }
    draw() {
      ctx.save();

      // trail
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

      // missile body
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
      this.vy = (rng() * 2 - 1) * 0.25;
      this.hp = 2;
      this.alive = true;
      this.fireCd = TUNE.enemyShotCooldownMin + rng() * (TUNE.enemyShotCooldownMax - TUNE.enemyShotCooldownMin);
      this.rng = rng;
    }
    update(dt) {
      // gently track player
      const sx = clamp((game.ship.x - this.x) * 0.08, -0.25, 0.25);
      const sy = clamp((game.ship.y - this.y) * 0.06, -0.18, 0.18);
      this.vx = clamp(this.vx + sx * dt, -0.9, 0.9);
      this.vy = clamp(this.vy + sy * dt, -0.6, 0.6);

      this.x += this.vx * dt * 60;
      this.y += this.vy * dt * 60;

      this.z -= game.scrollSpeed * dt;

      this.fireCd -= dt;
      if (this.fireCd <= 0 && this.z < game.shipZ + 1050 && this.z > game.shipZ + 260) {
        this.fireCd =
          TUNE.enemyShotCooldownMin +
          this.rng() * (TUNE.enemyShotCooldownMax - TUNE.enemyShotCooldownMin);

        if (Math.random() < TUNE.enemyShotsChance) {
          game.enemyShots.push(new LaserShot(this.x, this.y, this.z, "enemy"));
        }
      }

      if (this.z < game.shipZ - 140) this.alive = false;
    }
    draw() {
      const p = cam.project(this.x - game.ship.x, this.y - game.ship.y, this.z);
      const s = p.s;
      const size = 18 + 40 * s;

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.strokeStyle = COLORS.ui;
      ctx.lineWidth = Math.max(1, 2.2 * s);

      // interceptor silhouette (simple, not copying anything)
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
      this.side = side;       // -1 left wall, +1 right wall
      this.y = y;             // height along wall
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
      if (Math.abs(this.z - game.shipZ) > 90) return false;

      const halfW = trenchHalfWAt(this.z);
      const wallX = this.side * halfW;
      const innerX = wallX - this.side * this.protrude;

      const pipeMinX = Math.min(wallX, innerX);
      const pipeMaxX = Math.max(wallX, innerX);

      const shipX = game.ship.x;
      const shipY = game.ship.y;

      const withinX = shipX + game.shipHitR > pipeMinX && shipX - game.shipHitR < pipeMaxX;
      const withinY = Math.abs(shipY - this.y) < 40;

      return withinX && withinY;
    }
  }

  // ============================================================
  // Cockpit
  // ============================================================
  function cockpitGunMuzzles() {
    // Screen-space muzzle points for laser tracer to look right
    return {
      left: { x: W * 0.22, y: H - 90 },
      right: { x: W * 0.78, y: H - 90 },
      center: { x: W * 0.50, y: H - 92 },
    };
  }

  function drawCockpit(time) {
    // heavy cockpit: filled + outlined, with struts + side panels
    const bob = Math.sin(time * 6.0) * 1.2 + Math.sin(time * 10.0) * 0.7;

    ctx.save();
    ctx.translate(0, bob);

    // bottom dark mask (gives cockpit depth)
    ctx.fillStyle = COLORS.cockpitFill2;
    ctx.beginPath();
    ctx.moveTo(0, H);
    ctx.lineTo(0, H - 170);
    ctx.lineTo(W * 0.18, H - 140);
    ctx.lineTo(W * 0.50, H - 128);
    ctx.lineTo(W * 0.82, H - 140);
    ctx.lineTo(W, H - 170);
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();

    // main cockpit frame outline
    ctx.strokeStyle = COLORS.cockpitLine;
    ctx.lineWidth = 2;

    // canopy frame
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(W * 0.12, H - 165);
    ctx.lineTo(W * 0.12, H - 26);
    ctx.lineTo(W * 0.88, H - 26);
    ctx.lineTo(W * 0.88, H - 165);
    ctx.stroke();

    // struts
    ctx.globalAlpha = 0.90;
    ctx.beginPath();
    ctx.moveTo(W * 0.20, H - 26);
    ctx.lineTo(W * 0.34, H - 185);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(W * 0.80, H - 26);
    ctx.lineTo(W * 0.66, H - 185);
    ctx.stroke();

    // side panel outlines
    ctx.globalAlpha = 0.60;
    ctx.strokeRect(W * 0.06, H - 120, 130, 78);
    ctx.strokeRect(W - (W * 0.06 + 130), H - 120, 130, 78);

    // dashboard center panel
    ctx.globalAlpha = 0.70;
    ctx.strokeRect(W * 0.50 - 110, H - 150, 220, 120);

    // “instruments”
    ctx.globalAlpha = 0.35;
    for (let i = 0; i < 12; i++) {
      const x = W * 0.50 - 96 + i * 16;
      ctx.beginPath();
      ctx.moveTo(x, H - 44);
      ctx.lineTo(x, H - 56 - (i % 2) * 6);
      ctx.stroke();
    }

    // wing edges (cleaner, less weird)
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(W * 0.02, H - 26);
    ctx.lineTo(W * 0.20, H - 92);
    ctx.lineTo(W * 0.42, H - 98);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(W * 0.98, H - 26);
    ctx.lineTo(W * 0.80, H - 92);
    ctx.lineTo(W * 0.58, H - 98);
    ctx.stroke();

    // gun barrels
    const muzz = cockpitGunMuzzles();
    drawBarrel(muzz.left.x, muzz.left.y);
    drawBarrel(muzz.right.x, muzz.right.y);

    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function drawBarrel(x, y) {
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = COLORS.cockpitLine;
    ctx.lineWidth = 2;

    ctx.beginPath();
    ctx.moveTo(-22, 0);
    ctx.lineTo(-8, -16);
    ctx.lineTo(20, -16);
    ctx.lineTo(32, 0);
    ctx.closePath();
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(12, -16);
    ctx.lineTo(12, -40);
    ctx.stroke();

    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.moveTo(-2, -10);
    ctx.lineTo(-18, -2);
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.restore();
  }

  function drawReticle() {
    ctx.save();
    ctx.strokeStyle = "rgba(230,240,255,0.85)";
    ctx.lineWidth = 2;

    // reticle tracks ship.y a bit
    const cx = W * 0.5;
    const cy = H * 0.43 + game.ship.y * 0.75;

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
    ctx.strokeStyle = COLORS.ui;

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
  // Trench drawing (real walls + floor + top edges) with motion
  // ============================================================
  function drawSpeedLines(t) {
    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.strokeStyle = COLORS.ui;
    ctx.lineWidth = 1;

    const r = makeRng(4242);
    for (let i = 0; i < TUNE.speedLines; i++) {
      const x = r() * W;
      const y = r() * (cam.horizonY + 50);
      const len = 18 + r() * 22;

      const phase = (t * game.scrollSpeed * 0.16 + i * 21) % 220;
      const yy = y + phase;

      ctx.beginPath();
      ctx.moveTo(x, yy);
      ctx.lineTo(x, yy + len);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawTrench(t) {
    const zMin = game.shipZ + 120;
    const zMax = TUNE.farZ;
    const range = zMax - zMin;

    const phase = (t * game.scrollSpeed) % TUNE.segmentLen;

    // We draw from far -> near so fills layer correctly
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

      // corners: left wall top/bot, right wall top/bot
      const L0T = cam.project((-halfW0 - game.ship.x), (yTop - game.ship.y), z0);
      const L0B = cam.project((-halfW0 - game.ship.x), (yBot - game.ship.y), z0);
      const R0T = cam.project((+halfW0 - game.ship.x), (yTop - game.ship.y), z0);
      const R0B = cam.project((+halfW0 - game.ship.x), (yBot - game.ship.y), z0);

      const L1T = cam.project((-halfW1 - game.ship.x), (yTop - game.ship.y), z1);
      const L1B = cam.project((-halfW1 - game.ship.x), (yBot - game.ship.y), z1);
      const R1T = cam.project((+halfW1 - game.ship.x), (yTop - game.ship.y), z1);
      const R1B = cam.project((+halfW1 - game.ship.x), (yBot - game.ship.y), z1);

      // soft fills for walls/floor (depth)
      ctx.save();
      ctx.fillStyle = COLORS.trenchFill;

      // floor quad
      ctx.beginPath();
      ctx.moveTo(L0B.x, L0B.y);
      ctx.lineTo(R0B.x, R0B.y);
      ctx.lineTo(R1B.x, R1B.y);
      ctx.lineTo(L1B.x, L1B.y);
      ctx.closePath();
      ctx.fill();

      // left wall quad
      ctx.beginPath();
      ctx.moveTo(L0T.x, L0T.y);
      ctx.lineTo(L0B.x, L0B.y);
      ctx.lineTo(L1B.x, L1B.y);
      ctx.lineTo(L1T.x, L1T.y);
      ctx.closePath();
      ctx.fill();

      // right wall quad
      ctx.beginPath();
      ctx.moveTo(R0T.x, R0T.y);
      ctx.lineTo(R0B.x, R0B.y);
      ctx.lineTo(R1B.x, R1B.y);
      ctx.lineTo(R1T.x, R1T.y);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // neon lines
      ctx.save();
      ctx.strokeStyle = COLORS.trenchLine;
      ctx.lineWidth = 2;

      // trench top edges + bottom edges
      line(L0T, R0T);
      line(L0B, R0B);

      // rails (left and right vertical edges)
      line(L0T, L0B);
      line(R0T, R0B);

      // occasionally draw rungs (floor and subtle wall segments)
      if (i % TUNE.rungEvery === 0) {
        ctx.globalAlpha = 0.35;
        line(L0B, R0B);
        ctx.globalAlpha = 1;
      }

      // wall panels/greebles
      if (i % TUNE.panelEvery === 0) {
        drawWallPanel(z0, -1, halfW0, yTop, yBot, i);
        drawWallPanel(z0, +1, halfW0, yTop, yBot, i + 7);
      }

      // occasional lights
      if (i % TUNE.lightEvery === 0) {
        drawWallLight(z0, -1, halfW0, yTop, yBot);
        drawWallLight(z0, +1, halfW0, yTop, yBot);
      }

      ctx.restore();
    }
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

    // pick a y along the wall
    const yy = lerp(yBot + 22, yTop - 22, r());
    const inset = 18 + r() * 14;
    const px = wallX - side * inset;

    const p = cam.project(px - game.ship.x, yy - game.ship.y, z);
    const s = p.s;

    const w = (18 + r() * 22) * s;
    const h = (10 + r() * 26) * s;

    ctx.save();
    ctx.globalAlpha = 0.28;
    ctx.lineWidth = 1;
    ctx.strokeStyle = COLORS.ui;
    ctx.strokeRect(p.x - w / 2, p.y - h / 2, w, h);

    if (r() < 0.6) {
      ctx.globalAlpha = 0.16;
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
    scrollSpeed: 580,

    // ship
    ship: { x: 0, y: 0, vx: 0, vy: 0 },
    shipHitR: 42,

    // gameplay
    round: 1,
    score: 0,
    lives: 3,
    missiles: 3,

    // weapons
    laserCd: 0,
    missileCd: 0,
    laserSide: -1, // alternate

    // entities
    enemies: [],
    pipes: [],
    playerShots: [],
    enemyShots: [],

    // spawners
    enemyTimer: 0.8,
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

      this.scrollSpeed = 580;
      this.trenchNearHalfW = TUNE.trenchNearHalfW;
      this.trenchFarHalfW = TUNE.trenchFarHalfW;

      this.resetRound();
      this.state = "playing";
    },

    resetRound() {
      this.ship.x = 0;
      this.ship.y = 0;
      this.ship.vx = 0;
      this.ship.vy = 0;

      this.rng = makeRng(9000 + this.round * 101);

      this.enemies = [];
      this.pipes = [];
      this.playerShots = [];
      this.enemyShots = [];

      this.enemyTimer = 0.9;
      this.pipeTimer = 1.4;

      this.laserCd = 0;
      this.missileCd = 0;
      this.laserSide = -1;

      // seed a couple enemies, but calm
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
      const margin = 90;
      const x = (this.rng() * 2 - 1) * (halfW - margin);
      const y = (this.rng() * 2 - 1) * (TUNE.trenchHalfH * 0.55);
      const z = prefill ? this.shipZ + 900 + this.rng() * 900 : this.shipZ + 1600 + this.rng() * 900;
      this.enemies.push(new Enemy(x, y, z, this.rng));
    },

    spawnPipe() {
      const side = this.rng() < 0.5 ? -1 : 1;
      const z = this.shipZ + 1400 + this.rng() * 1100;
      const y = (this.rng() * 2 - 1) * (TUNE.trenchHalfH * 0.55);
      const protrude = 60 + this.rng() * 120;
      const thickness = 10 + this.rng() * 16;
      this.pipes.push(new Pipe(side, y, z, protrude, thickness));
    },

    fireLaser() {
      if (this.laserCd > 0) return;
      this.laserCd = TUNE.laserCooldown;

      // alternate left/right, single shot each fire (less spam)
      const side = TUNE.laserAlternate ? (this.laserSide *= -1) : -1;

      const gunX = this.ship.x + side * 78;
      const gunY = this.ship.y - 10;
      const z0 = this.shipZ + 70;

      this.playerShots.push(new LaserShot(gunX, gunY, z0, "player"));
    },

    fireMissile() {
      if (this.missileCd > 0) return;
      if (this.missiles <= 0) return;

      this.missiles -= 1;
      this.missileCd = TUNE.missileCooldown;

      const z0 = this.shipZ + 80;
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

    // movement (true up/down inside trench)
    const left = down("a") || down("arrowleft");
    const right = down("d") || down("arrowright");
    const up = down("w") || down("arrowup");
    const downKey = down("s") || down("arrowdown");

    const ax = (right ? 1 : 0) - (left ? 1 : 0);
    const ay = (downKey ? 1 : 0) - (up ? 1 : 0);

    game.ship.vx = (game.ship.vx + ax * TUNE.xSpeed) * TUNE.xDamp;
    game.ship.vy = (game.ship.vy + ay * TUNE.ySpeed) * TUNE.yDamp;

    game.ship.x += game.ship.vx * dt * 60;
    game.ship.y += game.ship.vy * dt * 60;

    // clamp inside trench bounds (with padding)
    const halfW = trenchHalfWAt(game.shipZ);
    const padX = 85;
    const padY = 40;

    game.ship.x = clamp(game.ship.x, -halfW + padX, +halfW - padX);
    game.ship.y = clamp(game.ship.y, -TUNE.trenchHalfH + padY, +TUNE.trenchHalfH - padY);

    // fire controls
    if (down(" ")) game.fireLaser();
    if (down("m")) {
      keys.delete("m");
      game.fireMissile();
    }

    // spawn enemies (calm)
    const enemyEvery = clamp(
      (TUNE.enemySpawnMin + (TUNE.enemySpawnMax - TUNE.enemySpawnMin) * game.rng()) - game.round * 0.02,
      0.85,
      3.0
    );
    game.enemyTimer -= dt;
    if (game.enemyTimer <= 0) {
      game.enemyTimer += enemyEvery;
      game.spawnEnemy(false);
    }

    // pipes
    game.pipeTimer -= dt;
    const pipeEvery = clamp(2.8 - game.round * 0.05, 1.4, 2.8);
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
      if (Math.abs(es.z - game.shipZ) < 110) {
        const dx = es.x - game.ship.x;
        const dy = es.y - game.ship.y;
        if (dx * dx + dy * dy < (game.shipHitR * 0.9) ** 2) {
          game.loseLife();
          return;
        }
      }
    }

    // player shots hit enemies
    for (const ps of game.playerShots) {
      for (const e of game.enemies) {
        if (!ps.alive || !e.alive) continue;
        if (Math.abs(ps.z - e.z) < 80) {
          const dx = ps.x - e.x;
          const dy = ps.y - e.y;
          if (dx * dx + dy * dy < 55 * 55) {
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
      game.scrollSpeed = Math.min(900, game.scrollSpeed + 40);
      game.missiles = Math.min(6, game.missiles + 1);
      game.resetRound();
    }
  }

  // ============================================================
  // Render
  // ============================================================
  function render() {
    // camera pitch derives from ship.y (look up/down)
    cam.horizonY = TUNE.horizonBase;
    cam.pitch = -game.ship.y * 0.28 * (TUNE.pitchEffect / 36);

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#05070a";
    ctx.fillRect(0, 0, W, H);

    // subtle frame
    ctx.strokeStyle = "rgba(230,240,255,0.22)";
    ctx.lineWidth = 1;
    ctx.strokeRect(10, 10, W - 20, H - 20);

    // motion
    drawSpeedLines(game.t);

    // trench (true walls/floor/top edges)
    drawTrench(game.t);

    // entities far-to-near
    const drawables = [];
    for (const p of game.pipes) drawables.push({ z: p.z, draw: () => p.draw() });
    for (const e of game.enemies) drawables.push({ z: e.z, draw: () => e.draw() });
    for (const s of game.playerShots) drawables.push({ z: s.z, draw: () => s.draw() });
    for (const s of game.enemyShots) drawables.push({ z: s.z, draw: () => s.draw() });

    drawables.sort((a, b) => b.z - a.z);
    for (const d of drawables) d.draw();

    // cockpit overlay
    drawCockpit(game.t);
    drawReticle();
    drawHUD();

    if (game.state === "title") {
      overlay("TRENCH RUN", [
        "ENTER to start",
        "Move: WASD / Arrows (real up/down now)",
        "Laser: SPACE (red)",
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
  // Start state
  // ============================================================
  // Make title visible immediately:
  // (We draw it via render() while state is "title")
})();
