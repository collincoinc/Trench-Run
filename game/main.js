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
  // Tuning knobs (easy to adjust later)
  // ============================================================
  const TUNE = {
    // Trench look/feel
    slices: 36,              // more slices = smoother perspective
    rungEvery: 3,            // floor “rungs” frequency
    wallPanelEvery: 4,       // wall panel frequency
    lightEvery: 7,           // occasional “light strip”
    greebleChance: 0.55,     // chance a segment gets a greeble rectangle

    // Difficulty / chaos
    enemySpawnMin: 1.25,     // bigger = fewer enemies
    enemySpawnMax: 2.20,
    enemyShotsEnabled: true,
    enemyShotRateScale: 0.35, // lower = fewer enemy shots (0.35 = calm)
    pipesEnabled: true,
    pipeChance: 0.40,        // chance to spawn a wall pipe when timer hits
  };

  // ============================================================
  // Projection / camera (FIXED so near is bottom, far is horizon)
  // World space: x (left/right), z (forward distance ahead of ship)
  // ============================================================
  const cam = {
    horizonY: 120,
    fov: 520,
    projectXZ(x, z) {
      const zz = Math.max(40, z);
      const s = this.fov / (zz + this.fov); // near -> bigger s, far -> smaller s
      const sx = W * 0.5 + x * s;

      // ✅ FIX: near points should be near the bottom (bigger s => bigger y)
      const sy = this.horizonY + s * (H - this.horizonY);

      return { x: sx, y: sy, s };
    },
  };

  // ============================================================
  // Trench width model (narrower in the distance)
  // ============================================================
  function trenchHalfWidthAt(z, nearHalf, farHalf, farZ) {
    const t = clamp((z - game.shipZ) / (farZ - game.shipZ), 0, 1);
    return lerp(nearHalf, farHalf, t);
  }

  // ============================================================
  // Entities
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

      // muzzle tracer for “wing guns” feel
      if (this.age < 0.12 && this.kind === "laser") {
        const muzz = getWingMuzzlesScreen();
        const m = this.x < game.ship.x ? muzz.left : muzz.right;
        ctx.globalAlpha = 0.6;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(m.x, m.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (this.age < 0.14 && this.kind === "missile") {
        const m = getCenterMuzzleScreen();
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
      this.vx = (rng() * 2 - 1) * 0.45;
      this.hp = 2;
      this.fireCd = 0.9 + rng() * 1.2;
      this.alive = true;
    }
    update(dt) {
      // gentle drift and light steering toward player
      const steer = clamp((game.ship.x - this.x) * 0.12, -0.25, 0.25);
      this.vx = clamp(this.vx + steer * dt, -0.9, 0.9);
      this.x += this.vx * dt * 60;

      this.z -= game.scrollSpeed * dt;

      // calmer enemy fire
      if (TUNE.enemyShotsEnabled) {
        this.fireCd -= dt;
        const fireScale = clamp(1.0 - game.round * 0.05, 0.55, 1.0) / Math.max(0.15, TUNE.enemyShotRateScale);
        // fireScale > 1 means slower effective firing (since we multiply cooldown)
        if (this.fireCd <= 0 && this.z < game.shipZ + 980 && this.z > game.shipZ + 240) {
          this.fireCd = (1.35 + Math.random() * 1.0) * fireScale;
          if (Math.random() < 0.45) game.enemyShots.push(new EnemyShot(this.x, this.z));
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

      // original “interceptor” silhouette (not TIE-like)
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
      this.side = side; // -1 left, +1 right
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
  // Cockpit UI (better looking cockpit, not weird geometry)
  // ============================================================
  function getWingMuzzlesScreen() {
    return {
      left: { x: W * 0.28, y: H - 84 },
      right: { x: W * 0.72, y: H - 84 },
    };
  }
  function getCenterMuzzleScreen() {
    return { x: W * 0.5, y: H - 92 };
  }

  function drawCockpit() {
    ctx.save();
    ctx.strokeStyle = "rgba(230,240,255,0.90)";
    ctx.lineWidth = 2;

    // window frame (top arch + sides)
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.moveTo(W * 0.18, H - 150);
    ctx.lineTo(W * 0.18, H - 18);
    ctx.lineTo(W * 0.82, H - 18);
    ctx.lineTo(W * 0.82, H - 150);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // angled supports
    ctx.beginPath();
    ctx.moveTo(W * 0.22, H - 18);
    ctx.lineTo(W * 0.34, H - 160);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(W * 0.78, H - 18);
    ctx.lineTo(W * 0.66, H - 160);
    ctx.stroke();

    // dashboard base
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(40, H - 12);
    ctx.lineTo(W - 40, H - 12);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // gun pods
    const muzz = getWingMuzzlesScreen();
    drawGunPod(muzz.left.x, muzz.left.y);
    drawGunPod(muzz.right.x, muzz.right.y);

    // center console
    ctx.globalAlpha = 0.55;
    ctx.strokeRect(W * 0.5 - 86, H - 132, 172, 104);
    ctx.globalAlpha = 1;

    // tiny “instrument” ticks
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

  function drawGunPod(x, y) {
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = "rgba(230,240,255,0.95)";
    ctx.lineWidth = 2;

    ctx.beginPath();
    ctx.moveTo(-34, 0);
    ctx.lineTo(-14, -20);
    ctx.lineTo(32, -20);
    ctx.lineTo(44, 0);
    ctx.closePath();
    ctx.stroke();

    // barrel
    ctx.beginPath();
    ctx.moveTo(16, -20);
    ctx.lineTo(16, -38);
    ctx.stroke();

    ctx.restore();
  }

  function drawReticle() {
    ctx.save();
    ctx.strokeStyle = "rgba(230,240,255,0.85)";
    ctx.lineWidth = 2;

    const cx = W * 0.5;
    const cy = H * 0.44;

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

    // lock placeholder
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
  // Game state
  // ============================================================
  const game = {
    state: "title", // title | playing | paused | gameover

    rng: makeRng(1337),

    round: 1,
    score: 0,
    combo: 0,
    lives: 3,
    missiles: 3,

    trenchNearHalf: 290,
    trenchFarHalf: 95,

    shipZ: 140,
    renderFarZ: 2600,

    ship: { x: 0 },
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
      this.rng = makeRng(9000 + this.round * 101);

      this.enemies = [];
      this.pipes = [];
      this.playerShots = [];
      this.enemyShots = [];

      this.enemyTimer = 0.6;
      this.pipeTimer = 1.4;

      this.fireCd = 0;
      this.missileCd = 0;

      // seed a couple enemies, not too many
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

    fireMissile() {
      if (this.missileCd > 0) return;
      if (this.missiles <= 0) return;

      this.missiles -= 1;
      this.missileCd = 0.75;

      const z0 = this.shipZ + 80;
      this.playerShots.push(new PlayerShot(this.ship.x, z0, "missile"));
    },
  };

  // ============================================================
  // Update
  // ============================================================
  function update(dt) {
    if (game.state !== "playing") return;

    game.fireCd = Math.max(0, game.fireCd - dt);
    game.missileCd = Math.max(0, game.missileCd - dt);

    // movement (left/right in trench)
    const left = down("a") || down("arrowleft");
    const right = down("d") || down("arrowright");
    const vx = (right ? 1 : 0) - (left ? 1 : 0);

    game.ship.x += vx * 7.2 * dt * 60;

    // constrain to trench at ship depth
    const half = trenchHalfWidthAt(game.shipZ, game.trenchNearHalf, game.trenchFarHalf, game.renderFarZ);
    game.ship.x = clamp(game.ship.x, -half + 70, half - 70);

    // firing
    if (down(" ")) game.fireLaser();
    if (down("m")) {
      keys.delete("m");
      game.fireMissile();
    }

    // enemy spawning (calmer)
    const enemyEvery = clamp(
      (TUNE.enemySpawnMin + (TUNE.enemySpawnMax - TUNE.enemySpawnMin) * game.rng()) - game.round * 0.03,
      0.65,
      2.6
    );
    game.enemyTimer -= dt;
    if (game.enemyTimer <= 0) {
      game.enemyTimer += enemyEvery;
      game.spawnEnemy(false);
    }

    // occasional pipes
    game.pipeTimer -= dt;
    const pipeEvery = clamp(2.4 - game.round * 0.06, 1.2, 2.4);
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
      if (Math.abs(es.z - game.shipZ) < 70) {
        if (Math.abs(es.x - game.ship.x) < game.shipHitR) {
          game.loseLife();
          return;
        }
      }
    }

    // collisions: enemies ramming
    for (const e of game.enemies) {
      if (Math.abs(e.z - game.shipZ) < 80) {
        if (Math.abs(e.x - game.ship.x) < game.shipHitR + 20) {
          game.loseLife();
          return;
        }
      }
    }

    // player shots vs enemies
    for (const ps of game.playerShots) {
      for (const e of game.enemies) {
        if (!ps.alive || !e.alive) continue;
        if (Math.abs(ps.z - e.z) < ps.radius + 42) {
          if (Math.abs(ps.x - e.x) < ps.radius + 40) {
            ps.alive = false;
            e.hit(ps.kind === "missile" ? 2 : 1);

            game.combo = Math.min(25, game.combo + 1);
            const base = ps.kind === "missile" ? 160 : 90;
            game.score += Math.floor(base * (1 + game.combo * 0.08));
          }
        }
      }
    }

    // survival score
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
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#05070a";
    ctx.fillRect(0, 0, W, H);

    // frame
    ctx.strokeStyle = "rgba(230,240,255,0.25)";
    ctx.lineWidth = 1;
    ctx.strokeRect(10, 10, W - 20, H - 20);

    // star haze (subtle, above horizon)
    drawStarHaze();

    // trench
    drawTrenchDetailed();

    // draw far-to-near ordering (z desc)
    const drawables = [];
    for (const p of game.pipes) drawables.push({ z: p.z, draw: () => p.draw() });
    for (const e of game.enemies) drawables.push({ z: e.z, draw: () => e.draw() });
    for (const s of game.playerShots) drawables.push({ z: s.z, draw: () => s.draw() });
    for (const s of game.enemyShots) drawables.push({ z: s.z, draw: () => s.draw() });

    drawables.sort((a, b) => b.z - a.z);
    for (const d of drawables) d.draw();

    // cockpit + reticle + HUD
    drawCockpit();
    drawReticle();
    drawHUD();

    if (game.state === "title") {
      centerOverlay("TRENCH RUN", [
        "Press ENTER to start",
        "Move: A/D or Arrow Left/Right",
        "Lasers: SPACE (wing guns)",
        "Missile: M (limited)",
        "Debug: N = next round (for now)",
      ]);
    } else if (game.state === "paused") {
      centerOverlay("PAUSED", ["Press ESC to resume"]);
    } else if (game.state === "gameover") {
      centerOverlay("GAME OVER", ["Press ENTER to play again"]);
    }
  }

  function drawStarHaze() {
    ctx.save();
    ctx.globalAlpha = 0.25;
    ctx.strokeStyle = "#e6f0ff";
    ctx.lineWidth = 1;

    // a few faint “stars” with deterministic positions based on round
    const r = makeRng(7000 + game.round * 13);
    for (let i = 0; i < 50; i++) {
      const x = r() * W;
      const y = r() * cam.horizonY;
      if (r() < 0.25) {
        ctx.beginPath();
        ctx.moveTo(x - 2, y);
        ctx.lineTo(x + 2, y);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(x, y, 1, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawTrenchDetailed() {
    ctx.save();
    ctx.strokeStyle = "#e6f0ff";
    ctx.lineWidth = 2;

    const slices = TUNE.slices;
    const zMin = game.shipZ + 100;
    const zMax = game.renderFarZ;

    let prevL = null;
    let prevR = null;

    for (let i = 0; i <= slices; i++) {
      const t = i / slices;
      const z = lerp(zMin, zMax, t);

      const half = trenchHalfWidthAt(z, game.trenchNearHalf, game.trenchFarHalf, game.renderFarZ);
      const Lw = -half;
      const Rw = half;

      const L = cam.projectXZ(Lw - game.ship.x, z);
      const R = cam.projectXZ(Rw - game.ship.x, z);

      // side rails
      if (prevL && prevR) {
        ctx.beginPath();
        ctx.moveTo(prevL.x, prevL.y);
        ctx.lineTo(L.x, L.y);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(prevR.x, prevR.y);
        ctx.lineTo(R.x, R.y);
        ctx.stroke();
      }

      // floor rungs (motion feel)
      if (i % TUNE.rungEvery === 0) {
        ctx.globalAlpha = 0.45;
        ctx.beginPath();
        ctx.moveTo(L.x, L.y);
        ctx.lineTo(R.x, R.y);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // wall panels (adds “graphics” without heavy art)
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

    // center guideline for speed feel
    ctx.globalAlpha = 0.22;
    ctx.beginPath();
    const c0 = cam.projectXZ(0 - game.ship.x, zMin);
    const c1 = cam.projectXZ(0 - game.ship.x, zMax);
    ctx.moveTo(c0.x, c0.y);
    ctx.lineTo(c1.x, c1.y);
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.restore();
  }

  function drawWallPanelAt(z, half, idx) {
    // deterministic panel pattern per slice
    const r = makeRng(100000 + game.round * 97 + idx * 31);

    // choose left or right
    const side = r() < 0.5 ? -1 : 1;

    // panel is inset slightly from wall
    const wallX = side * half;
    const inset = 22 + r() * 16;
    const panelX = wallX - side * inset;

    // panel height effect (in screen, based on projection scale)
    const p = cam.projectXZ(panelX - game.ship.x, z);
    const s = p.s;

    const w = (14 + r() * 18) * s;
    const h = (10 + r() * 22) * s;

    // place it slightly above the floor line
    const y = p.y - (16 + r() * 18) * s;
    const x = p.x + (side * (6 + r() * 8) * s);

    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = "#e6f0ff";
    ctx.lineWidth = 1;

    ctx.strokeRect(x - w / 2, y - h / 2, w, h);

    // tiny “greeble” inside sometimes
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
