// game/main.js
(() => {
  "use strict";

  // ---------- Canvas ----------
  const canvas = document.getElementById("game");
  /** @type {CanvasRenderingContext2D} */
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;

  // ---------- Input ----------
  const keys = new Set();
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    keys.add(k);
    if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(k)) e.preventDefault();
    if (k === "escape") game.togglePause();
  }, { passive: false });
  window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
  const isDown = (k) => keys.has(k);

  // ---------- Helpers ----------
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  function drawText(text, x, y, size = 16, alpha = 1, align = "start") {
    ctx.globalAlpha = alpha;
    ctx.textAlign = align;
    ctx.font = `${size}px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif`;
    ctx.fillText(text, x, y);
    ctx.globalAlpha = 1;
    ctx.textAlign = "start";
  }

  function rectsOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  // ---------- Trench parameters ----------
  // Minimal-shape “2.5D” corridor: width narrows toward the horizon.
  const trench = {
    topY: 110,
    bottomY: H - 40,
    nearHalfWidth: 250, // at ship depth
    farHalfWidth: 70,   // at horizon
    // ship depth reference (we draw ship around this y)
    shipY: H * 0.72
  };

  function trenchHalfWidthAt(y) {
    // map y from topY..bottomY => 0..1
    const t = clamp((y - trench.topY) / (trench.bottomY - trench.topY), 0, 1);
    return lerp(trench.farHalfWidth, trench.nearHalfWidth, t);
  }

  function trenchLeftAt(y) { return W / 2 - trenchHalfWidthAt(y); }
  function trenchRightAt(y) { return W / 2 + trenchHalfWidthAt(y); }

  // ---------- Pillars ----------
  // Pillars scroll downward (toward player). We represent them as rectangles.
  // Their x is in "trench space": 0..1 across the trench at their y.
  function makeRng(seed) {
    // simple deterministic RNG (LCG)
    let s = seed >>> 0;
    return () => {
      s = (1664525 * s + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function spawnPillar() {
    // Spawn ahead near horizon; will scroll down.
    const y = trench.topY + 10;
    const lane = game.rng();         // 0..1
    const w = 18 + Math.floor(game.rng() * 22); // 18..40
    const h = 28 + Math.floor(game.rng() * 52); // 28..80
    const speedBoost = 0.85 + game.rng() * 0.35; // slight variety
    return { y, lane, w, h, speedBoost };
  }

  function pillarToRect(p) {
    // Convert pillar from lane/y into screen rect in the trench at that y.
    const left = trenchLeftAt(p.y);
    const right = trenchRightAt(p.y);
    const trenchW = right - left;
    const cx = left + p.lane * trenchW;

    // Scale pillars by depth (smaller near horizon)
    const t = clamp((p.y - trench.topY) / (trench.bottomY - trench.topY), 0, 1);
    const scale = lerp(0.45, 1.0, t);

    const w = p.w * scale;
    const h = p.h * scale;
    return { x: cx - w / 2, y: p.y - h / 2, w, h };
  }

  // ---------- Game State ----------
  const game = {
    state: "title", // title | playing | paused | gameover
    round: 1,
    score: 0,
    combo: 0,
    lives: 3,
    missiles: 3,

    // forward speed increases by round
    speed: 260,

    ship: { x: W * 0.5, y: trench.shipY, r: 10 },

    // round-run timer (used to increase intensity later)
    runTime: 0,

    // obstacle system
    pillars: [],
    spawnTimer: 0,

    rng: makeRng(12345),

    resetToRoundStart() {
      this.state = "playing";
      this.ship.x = W * 0.5;
      this.ship.y = trench.shipY;
      this.runTime = 0;

      // reset deterministic RNG per round so restarting feels fair
      this.rng = makeRng(1000 + this.round * 77);

      // reset pillars for this round
      this.pillars = [];
      this.spawnTimer = 0;

      // pre-spawn a few pillars so the trench isn't empty
      for (let i = 0; i < 6; i++) {
        const p = spawnPillar();
        p.y = trench.topY + 10 + i * 55;
        this.pillars.push(p);
      }
    },

    newGame() {
      this.round = 1;
      this.score = 0;
      this.combo = 0;
      this.lives = 3;
      this.missiles = 3;
      this.speed = 260;
      this.resetToRoundStart();
    },

    loseLife() {
      this.lives -= 1;
      this.combo = 0;
      if (this.lives <= 0) this.state = "gameover";
      else this.resetToRoundStart(); // restart same round
    },

    togglePause() {
      if (this.state === "playing") this.state = "paused";
      else if (this.state === "paused") this.state = "playing";
    },

    nextRound() {
      this.round += 1;
      this.missiles = Math.min(6, this.missiles + 1);
      this.speed = Math.min(620, this.speed + 35);
      this.resetToRoundStart();
    }
  };

  // Title enter
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (k === "enter") {
      if (game.state === "title" || game.state === "gameover") game.newGame();
    }
  });

  // ---------- Update ----------
  function update(dt) {
    if (game.state !== "playing") return;

    game.runTime += dt;

    // Movement
    const left = isDown("a") || isDown("arrowleft");
    const right = isDown("d") || isDown("arrowright");
    const up = isDown("w") || isDown("arrowup");
    const down = isDown("s") || isDown("arrowdown");

    const vx = (right ? 1 : 0) - (left ? 1 : 0);
    const vy = (down ? 1 : 0) - (up ? 1 : 0);

    const moveSpeed = 330; // player lateral speed
    game.ship.x += vx * moveSpeed * dt;
    game.ship.y += vy * moveSpeed * dt;

    // Constrain ship within trench at its current y
    game.ship.y = clamp(game.ship.y, trench.topY + 70, trench.bottomY - 10);

    const L = trenchLeftAt(game.ship.y);
    const R = trenchRightAt(game.ship.y);
    game.ship.x = clamp(game.ship.x, L + 18, R - 18);

    // Scroll pillars toward player (down)
    const baseScroll = game.speed; // px/sec
    for (const p of game.pillars) {
      p.y += baseScroll * p.speedBoost * dt;
    }

    // Despawn pillars off-screen and spawn new ones
    game.pillars = game.pillars.filter(p => p.y < trench.bottomY + 120);

    // Spawn rate ramps with round
    const spawnEvery = clamp(0.55 - game.round * 0.03, 0.20, 0.55);
    game.spawnTimer += dt;
    while (game.spawnTimer >= spawnEvery) {
      game.spawnTimer -= spawnEvery;
      game.pillars.push(spawnPillar());
    }

    // Score increases with survival and round difficulty
    game.score += Math.floor((10 + game.round * 3) * dt * 10);

    // Collision: ship vs walls (if somehow out of bounds)
    // We'll also check against a slightly tighter "safe corridor" to make it arcade.
    const safeL = L + 8;
    const safeR = R - 8;
    if (game.ship.x < safeL || game.ship.x > safeR) {
      game.loseLife();
      return;
    }

    // Collision: ship vs pillars
    const shipRect = { x: game.ship.x - 10, y: game.ship.y - 12, w: 20, h: 24 };
    for (const p of game.pillars) {
      const pr = pillarToRect(p);
      if (rectsOverlap(shipRect, pr)) {
        game.loseLife();
        return;
      }
    }

    // TEMP: press N to simulate "vent hit" and go to next round
    if (isDown("n")) { keys.delete("n"); game.nextRound(); }
  }

  // ---------- Render ----------
  function render() {
    // Background
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#05070a";
    ctx.fillRect(0, 0, W, H);

    // Frame
    ctx.strokeStyle = "rgba(230,240,255,0.25)";
    ctx.lineWidth = 1;
    ctx.strokeRect(10, 10, W - 20, H - 20);

    // Draw trench walls (minimal shapes)
    drawTrench();

    // Draw pillars
    ctx.strokeStyle = "#e6f0ff";
    ctx.lineWidth = 2;
    for (const p of game.pillars) {
      const r = pillarToRect(p);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    }

    // Draw ship
    if (game.state !== "title") drawShip(game.ship.x, game.ship.y);

    // HUD
    drawHUD();

    // Overlays
    if (game.state === "title") {
      centerOverlay("NEON TRENCH RUN", [
        "Press ENTER to start",
        "Move: WASD / Arrow Keys",
        "Avoid pillars and stay in the trench",
        "Debug: N = next round"
      ]);
    } else if (game.state === "paused") {
      centerOverlay("PAUSED", ["Press ESC to resume"]);
    } else if (game.state === "gameover") {
      centerOverlay("GAME OVER", ["Press ENTER to play again"]);
    }
  }

  function drawTrench() {
    ctx.strokeStyle = "#e6f0ff";
    ctx.lineWidth = 2;

    // Two corridor edges: from horizon to near
    const topY = trench.topY;
    const botY = trench.bottomY;

    const topL = trenchLeftAt(topY);
    const topR = trenchRightAt(topY);
    const botL = trenchLeftAt(botY);
    const botR = trenchRightAt(botY);

    // Left edge
    ctx.beginPath();
    ctx.moveTo(topL, topY);
    ctx.lineTo(botL, botY);
    ctx.stroke();

    // Right edge
    ctx.beginPath();
    ctx.moveTo(topR, topY);
    ctx.lineTo(botR, botY);
    ctx.stroke();

    // Add a few “floor” lines for motion feel
    ctx.globalAlpha = 0.5;
    for (let i = 0; i < 10; i++) {
      const t = i / 10;
      const y = lerp(topY + 20, botY, t);
      const L = trenchLeftAt(y);
      const R = trenchRightAt(y);
      ctx.beginPath();
      ctx.moveTo(L, y);
      ctx.lineTo(R, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawHUD() {
    ctx.fillStyle = "#e6f0ff";
    ctx.strokeStyle = "#e6f0ff";
    ctx.lineWidth = 1;

    drawText(`SCORE ${game.score}`, 22, 34, 16);
    drawText(`ROUND ${game.round}`, 22, 56, 14, 0.9);

    drawText(`LIVES ${game.lives}`, W - 130, 34, 16);
    drawText(`MISSILES ${game.missiles}`, W - 170, 56, 14, 0.9);

    drawText(`SPEED ${Math.floor(game.speed)}`, W * 0.5, 34, 14, 0.9, "center");
    drawText(`COMBO x${game.combo}`, W * 0.5, 56, 14, 0.9, "center");

    // LOCK placeholder box
    ctx.globalAlpha = 0.7;
    ctx.strokeRect(W * 0.5 - 32, 70, 64, 22);
    ctx.globalAlpha = 1;
    drawText(`LOCK`, W * 0.5, 87, 14, 0.8, "center");
  }

  function centerOverlay(title, lines) {
    ctx.fillStyle = "#e6f0ff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    drawText(title, W / 2, H / 2 - 30, 34, 1, "center");
    let y = H / 2 + 10;
    for (const line of lines) {
      drawText(line, W / 2, y, 16, 0.9, "center");
      y += 22;
    }

    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
  }

  function drawShip(x, y) {
    ctx.save();
    ctx.translate(x, y);

    ctx.strokeStyle = "#e6f0ff";
    ctx.lineWidth = 2;

    ctx.beginPath();
    ctx.moveTo(0, -14);
    ctx.lineTo(-10, 10);
    ctx.lineTo(10, 10);
    ctx.closePath();
    ctx.stroke();

    // “engine” tail line
    ctx.beginPath();
    ctx.moveTo(0, 10);
    ctx.lineTo(0, 18);
    ctx.stroke();

    ctx.restore();
  }

  // ---------- Loop ----------
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
