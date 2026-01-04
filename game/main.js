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

  function circleHit(ax, ay, ar, bx, by, br) {
    const dx = ax - bx;
    const dy = ay - by;
    const rr = ar + br;
    return dx * dx + dy * dy <= rr * rr;
  }

  // ============================================================
  // Projection / camera
  // World space: x (left/right), z (forward distance ahead of player)
  // Player is at z = shipZ. Objects are ahead with z > shipZ.
  // We move forward by decreasing all objects' z (world scroll).
  // ============================================================
  const cam = {
    horizonY: 120,
    fov: 520,
    projectXZ(x, z) {
      const zz = Math.max(40, z);
      const s = this.fov / (zz + this.fov); // 0..1
      const sx = W * 0.5 + x * s;
      const sy = this.horizonY + (1 - s) * (H - this.horizonY);
      return { x: sx, y: sy, s };
    },
  };

  // ============================================================
  // Trench model
  // halfWidth shrinks as z increases (farther away -> narrower)
  // ============================================================
  function trenchHalfWidthAt(z, nearHalf, farHalf, farZ) {
    // z ~ shipZ .. farZ
    const t = clamp((z - game.shipZ) / (farZ - game.shipZ), 0, 1);
    return lerp(nearHalf, farHalf, t); // narrower farther away
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
      this.speed = kind === "missile" ? 680 : 980;
      this.radius = kind === "missile" ? 18 : 10; // world-ish collision against enemies
    }
    update(dt) {
      this.age += dt;
      // move forward relative to the world
      this.z += this.speed * dt;
      // world scroll moves everything toward player
      this.z -= game.scrollSpeed * dt;

      if (this.z > game.renderFarZ + 300) this.alive = false;
    }
    draw() {
      const p = cam.projectXZ(this.x, this.z);
      ctx.save();
      ctx.strokeStyle = "#e6f0ff";
      ctx.lineWidth = Math.max(1, 2.4 * p.s);

      if (this.kind === "laser") {
        // tiny tracer
        ctx.beginPath();
        ctx.moveTo(p.x, p.y + 10 * p.s);
        ctx.lineTo(p.x, p.y - 14 * p.s);
        ctx.stroke();
      } else {
        // missile = capsule + glow dot
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(2.2, 5.2 * p.s), 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(p.x, p.y + 10 * p.s);
        ctx.lineTo(p.x, p.y - 18 * p.s);
        ctx.stroke();
      }

      // first 0.12s: draw cockpit muzzle tracer line so it feels like wing guns
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
      // moves toward player (decrease z faster than world)
      this.z -= this.speed * dt;
      this.z -= game.scrollSpeed * dt;

      if (this.z < game.shipZ - 200) this.alive = false;
    }
    draw() {
      const p = cam.projectXZ(this.x, this.z);
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
      this.hp = 2; // missiles/lasers matter
      this.fireCd = 0.6 + rng() * 0.9;
      this.alive = true;
      this.r = 26; // collision-ish
    }
    update(dt) {
      // slight steering toward player lane (arcade feel)
      const steer = clamp((game.ship.x - this.x) * 0.15, -0.35, 0.35);
      this.vx = clamp(this.vx + steer * dt, -1.1, 1.1);
      this.x += this.vx * dt * 60;

      // world scroll
      this.z -= game.scrollSpeed * dt;

      // fire if close enough
      this.fireCd -= dt;
      if (this.fireCd <= 0 && this.z < game.shipZ + 950 && this.z > game.shipZ + 180) {
        this.fireCd = clamp(0.95 - game.round * 0.05, 0.25, 0.95);
        game.enemyShots.push(new EnemyShot(this.x, this.z));
      }

      // despawn if passed player
      if (this.z < game.shipZ - 80) this.alive = false;
    }
    draw() {
      const p = cam.projectXZ(this.x, this.z);
      const s = p.s;
      const size = 18 + 42 * s;

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.strokeStyle = "#e6f0ff";
      ctx.lineWidth = Math.max(1, 2.2 * s);

      // Original silhouette: wedge + fins (not TIE-like)
      // nose
      ctx.beginPath();
      ctx.moveTo(0, -size * 0.7);
      ctx.lineTo(-size * 0.25, size * 0.15);
      ctx.lineTo(size * 0.25, size * 0.15);
      ctx.closePath();
      ctx.stroke();

      // fuselage
      ctx.beginPath();
      ctx.moveTo(-size * 0.12, size * 0.15);
      ctx.lineTo(-size * 0.18, size * 0.55);
      ctx.lineTo(size * 0.18, size * 0.55);
      ctx.lineTo(size * 0.12, size * 0.15);
      ctx.stroke();

      // fins
      ctx.beginPath();
      ctx.moveTo(-size * 0.25, size * 0.23);
      ctx.lineTo(-size * 0.85, size * 0.35);
      ctx.lineTo(-size * 0.25, size * 0.47);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(size * 0.25, size * 0.23);
      ctx.lineTo(size * 0.85, size * 0.35);
      ctx.lineTo(size * 0.25, size * 0.47);
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
      this.side = side; // -1 left wall, +1 right wall
      this.z = z;
      this.protrude = protrude;
      this.thickness = thickness;
      this.alive = true;
      this.r = 18 + thickness; // collision buffer
    }
    update(dt) {
      this.z -= game.scrollSpeed * dt;
      if (this.z < game.shipZ - 200) this.alive = false;
    }
    draw() {
      const half = trenchHalfWidthAt(this.z, game.trenchNearHalf, game.trenchFarHalf, game.renderFarZ);
      const wallX = this.side * half;
      const innerX = wallX - this.side * this.protrude;

      const a = cam.projectXZ(wallX, this.z);
      const b = cam.projectXZ(innerX, this.z);

      ctx.save();
      ctx.strokeStyle = "#e6f0ff";
      ctx.lineWidth = Math.max(1, this.thickness * a.s * 0.7);

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
      // only when pipe is near player depth
      if (Math.abs(this.z - game.shipZ) > 70) return false;
      const half = trenchHalfWidthAt(this.z, game.trenchNearHalf, game.trenchFarHalf, game.renderFarZ);
      const wallX = this.side * half;
      const innerX = wallX - this.side * this.protrude;

      const pipeMin = Math.min(wallX, innerX);
      const pipeMax = Math.max(wallX, innerX);
      return game.ship.x + game.shipHitR > pipeMin && game.ship.x - game.shipHitR < pipeMax;
    }
  }

  // ============================================================
  // Cockpit UI (muzzles / HUD / reticle)
  // ============================================================
  function getWingMuzzlesScreen() {
    // screen positions for muzzle flashes (fixed cockpit geometry)
    return {
      left: { x: W * 0.33, y: H - 82 },
      right: { x: W * 0.67, y: H - 82 },
    };
  }
  function getCenterMuzzleScreen() {
    return { x: W * 0.5, y: H - 92 };
  }

  function drawCockpit() {
    ctx.save();
    ctx.strokeStyle = "rgba(230,240,255,0.85)";
    ctx.lineWidth = 2;

    // bottom cockpit frame
    ctx.beginPath();
    ctx.moveTo(40, H - 12);
    ctx.lineTo(W - 40, H - 12);
    ctx.stroke();

    // angled window supports
    ctx.beginPath();
    ctx.moveTo(60, H - 12);
    ctx.lineTo(W * 0.22, H - 120);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(W - 60, H - 12);
    ctx.lineTo(W * 0.78, H - 120);
    ctx.stroke();

    // wing tips / gun pods
    const muzz = getWingMuzzlesScreen();
    drawGunPod(muzz.left.x, muzz.left.y);
    drawGunPod(muzz.right.x, muzz.right.y);

    // center console
    ctx.globalAlpha = 0.7;
    ctx.strokeRect(W * 0.5 - 70, H - 120, 140, 90);
    ctx.globalAlpha = 1;

    ctx.restore();
  }

  function drawGunPod(x, y) {
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = "rgba(230,240,255,0.95)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-30, 0);
    ctx.lineTo(-10, -18);
    ctx.lineTo(28, -18);
    ctx.lineTo(38, 0);
    ctx.closePath();
    ctx.stroke();

    // barrel
    ctx.beginPath();
    ctx.moveTo(10, -18);
    ctx.lineTo(10, -32);
    ctx.stroke();

    ctx.restore();
  }

  function drawReticle() {
    ctx.save();
    ctx.strokeStyle = "rgba(230,240,255,0.85)";
    ctx.lineWidth = 2;

    const cx = W * 0.5;
    const cy = H * 0.46;

    // minimal crosshair
    ctx.beginPath();
    ctx.moveTo(cx - 18, cy);
    ctx.lineTo(cx + 18, cy);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(cx, cy - 18);
    ctx.lineTo(cx, cy + 18);
    ctx.stroke();

    // small outer box
    ctx.globalAlpha = 0.65;
    ctx.strokeRect(cx - 34, cy - 34, 68, 68);
    ctx.globalAlpha = 1;

    ctx.restore();
  }

  function drawHUD() {
    ctx.save();
    ctx.fillStyle = "#e6f0ff";
    ctx.strokeStyle = "#e6f0ff";
    ctx.lineWidth = 1;

    // top left
    ctx.font = "16px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
    ctx.fillText(`SCORE ${game.score}`, 22, 34);
    ctx.font = "14px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
    ctx.globalAlpha = 0.9;
    ctx.fillText(`ROUND ${game.round}`, 22, 56);
    ctx.globalAlpha = 1;

    // top right
    ctx.font = "16px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
    ctx.fillText(`LIVES ${game.lives}`, W - 130, 34);
    ctx.font = "14px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif";
    ctx.globalAlpha = 0.9;
    ctx.fillText(`MISSILES ${game.missiles}`, W - 170, 56);
    ctx.globalAlpha = 1;

    // center top
    ctx.globalAlpha = 0.85;
    ctx.fillText(`SPEED ${Math.floor(game.scrollSpeed)}`, W * 0.5 - 56, 34);
    ctx.fillText(`COMBO x${game.combo}`, W * 0.5 - 56, 56);
    ctx.globalAlpha = 1;

    // lock indicator placeholder
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

    // trench
    trenchNearHalf: 280,
    trenchFarHalf: 90,

    shipZ: 120,
    renderFarZ: 2400,

    ship: { x: 0 },
    shipHitR: 36,

    // motion
    scrollSpeed: 560,

    // entities
    enemies: [],
    pipes: [],
    playerShots: [],
    enemyShots: [],

    // spawning
    enemyTimer: 0,
    pipeTimer: 0,

    // weapons
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
      this.trenchNearHalf = 280;
      this.trenchFarHalf = 90;

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

      this.enemyTimer = 0.3;
      this.pipeTimer = 1.6;

      this.fireCd = 0;
      this.missileCd = 0;

      // seed a couple enemies
      for (let i = 0; i < 2 + Math.min(4, this.round); i++) {
        this.spawnEnemy(true);
      }
    },

    loseLife() {
      this.lives -= 1;
      this.combo = 0;
      if (this.lives <= 0) this.state = "gameover";
      else this.resetRound();
    },

    nextRound() {
      this.round += 1;
      this.scrollSpeed = Math.min(980, this.scrollSpeed + 55);
      this.trenchNearHalf = Math.max(220, this.trenchNearHalf - 7);
      this.missiles = Math.min(6, this.missiles + 1);
      this.resetRound();
    },

    spawnEnemy(prefill = false) {
      const half = this.trenchNearHalf;
      const margin = 70;
      const x = (this.rng() * 2 - 1) * (half - margin);
      const z = prefill ? this.shipZ + 650 + this.rng() * 900 : this.shipZ + 1200 + this.rng() * 900;
      this.enemies.push(new EnemyInterceptor(x, z, this.rng));
    },

    spawnPipe() {
      // rare trench-attached obstacle
      const side = this.rng() < 0.5 ? -1 : 1;
      const z = this.shipZ + 1400 + this.rng() * 900;
      const protrude = 70 + this.rng() * 90;     // how far it sticks inward
      const thickness = 10 + this.rng() * 14;
      this.pipes.push(new TrenchPipe(side, z, protrude, thickness));
    },

    fireLaser() {
      if (this.fireCd > 0) return;
      this.fireCd = 0.09; // rapid arcade fire

      const gunOffset = 72;
      const z0 = this.shipZ + 60;

      // two wing shots
      this.playerShots.push(new PlayerShot(this.ship.x - gunOffset, z0, "laser"));
      this.playerShots.push(new PlayerShot(this.ship.x + gunOffset, z0, "laser"));
    },

    fireMissile() {
      if (this.missileCd > 0) return;
      if (this.missiles <= 0) return;

      this.missiles -= 1;
      this.missileCd = 0.6;

      const z0 = this.shipZ + 70;
      this.playerShots.push(new PlayerShot(this.ship.x, z0, "missile"));
    },
  };

  // ============================================================
  // Update
  // ============================================================
  function update(dt) {
    if (game.state !== "playing") return;

    // cooldowns
    game.fireCd = Math.max(0, game.fireCd - dt);
    game.missileCd = Math.max(0, game.missileCd - dt);

    // movement (world x only; cockpit view handles visuals)
    const left = down("a") || down("arrowleft");
    const right = down("d") || down("arrowright");

    // allow small vertical aim feel by nudging horizon (optional) later.
    const vx = (right ? 1 : 0) - (left ? 1 : 0);
    const moveSpeed = 7.2; // world units per frame-ish
    game.ship.x += vx * moveSpeed * dt * 60;

    // constrain to trench at ship depth
    const half = trenchHalfWidthAt(game.shipZ, game.trenchNearHalf, game.trenchFarHalf, game.renderFarZ);
    game.ship.x = clamp(game.ship.x, -half + 60, half - 60);

    // firing
    if (down(" ")) game.fireLaser();
    if (down("m")) {
      // single-fire missile
      keys.delete("m");
      game.fireMissile();
    }

    // spawn enemies (main threat)
    const enemyEvery = clamp(0.95 - game.round * 0.06, 0.32, 0.95);
    game.enemyTimer -= dt;
    if (game.enemyTimer <= 0) {
      game.enemyTimer += enemyEvery;
      game.spawnEnemy(false);
    }

    // spawn occasional trench pipes
    const pipeEvery = clamp(2.3 - game.round * 0.08, 0.95, 2.3);
    game.pipeTimer -= dt;
    if (game.pipeTimer <= 0) {
      game.pipeTimer += pipeEvery;
      if (game.rng() < 0.55) game.spawnPipe(); // not every time
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

    // collisions: pipes vs ship (rare)
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

    // collisions: enemies vs ship (ram)
    for (const e of game.enemies) {
      if (Math.abs(e.z - game.shipZ) < 70) {
        if (Math.abs(e.x - game.ship.x) < game.shipHitR + 18) {
          game.loseLife();
          return;
        }
      }
    }

    // player shots vs enemies
    for (const ps of game.playerShots) {
      for (const e of game.enemies) {
        // use world x + z proximity as collision check
        if (Math.abs(ps.z - e.z) < ps.radius + 38) {
          if (Math.abs(ps.x - e.x) < ps.radius + 34) {
            ps.alive = false;
            e.hit(ps.kind === "missile" ? 2 : 1);

            // scoring + combo
            game.combo = Math.min(25, game.combo + 1);
            const base = ps.kind === "missile" ? 160 : 90;
            game.score += Math.floor(base * (1 + game.combo * 0.08));
          }
        }
      }
    }

    // passive score for survival
    game.score += Math.floor((6 + game.round * 2) * dt * 10);

    // TEMP: advance round manually for now
    if (down("n")) {
      keys.delete("n");
      game.nextRound();
    }
  }

  // ============================================================
  // Render
  // ============================================================
  function render() {
    // background
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#05070a";
    ctx.fillRect(0, 0, W, H);

    // frame
    ctx.strokeStyle = "rgba(230,240,255,0.25)";
    ctx.lineWidth = 1;
    ctx.strokeRect(10, 10, W - 20, H - 20);

    // trench
    drawTrench();

    // draw far-to-near ordering: pipes/enemies/shots by z desc
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
        "Debug: N = next round",
      ]);
    } else if (game.state === "paused") {
      centerOverlay("PAUSED", ["Press ESC to resume"]);
    } else if (game.state === "gameover") {
      centerOverlay("GAME OVER", ["Press ENTER to play again"]);
    }
  }

  function drawTrench() {
    ctx.save();
    ctx.strokeStyle = "#e6f0ff";
    ctx.lineWidth = 2;

    const slices = 28;
    const zMin = game.shipZ + 80;
    const zMax = game.renderFarZ;

    // draw left/right rails as segmented lines
    let prevL = null;
    let prevR = null;

    for (let i = 0; i <= slices; i++) {
      const t = i / slices;
      const z = lerp(zMin, zMax, t);
      const half = trenchHalfWidthAt(z, game.trenchNearHalf, game.trenchFarHalf, game.renderFarZ);

      const Lw = -half;
      const Rw = half;

      const L = cam.projectXZ(Lw, z);
      const R = cam.projectXZ(Rw, z);

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
      prevL = L;
      prevR = R;

      // floor rungs (motion feel)
      if (i % 3 === 0) {
        ctx.globalAlpha = 0.45;
        ctx.beginPath();
        ctx.moveTo(L.x, L.y);
        ctx.lineTo(R.x, R.y);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // center guideline (subtle) helps “forward” feel
    ctx.globalAlpha = 0.28;
    ctx.beginPath();
    const c0 = cam.projectXZ(0, zMin);
    const c1 = cam.projectXZ(0, zMax);
    ctx.moveTo(c0.x, c0.y);
    ctx.lineTo(c1.x, c1.y);
    ctx.stroke();
    ctx.globalAlpha = 1;

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
