// game/main.js
(() => {
  "use strict";

  // ---------- Canvas ----------
  const canvas = document.getElementById("game");
  /** @type {CanvasRenderingContext2D} */
  const ctx = canvas.getContext("2d");

  // Keep internal resolution fixed (retro), but scale visually via CSS.
  const W = canvas.width;
  const H = canvas.height;

  // ---------- Input ----------
  const keys = new Set();
  window.addEventListener("keydown", (e) => {
    keys.add(e.key.toLowerCase());
    // prevent arrow keys from scrolling the page
    if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(e.key.toLowerCase())) {
      e.preventDefault();
    }
    // toggle pause
    if (e.key.toLowerCase() === "escape") game.togglePause();
  }, { passive: false });

  window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));

  function isDown(k) { return keys.has(k); }

  // ---------- Helpers ----------
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function drawText(text, x, y, size = 16, alpha = 1) {
    ctx.globalAlpha = alpha;
    ctx.font = `${size}px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif`;
    ctx.fillText(text, x, y);
    ctx.globalAlpha = 1;
  }

  function drawBar(x, y, w, h, pct) {
    ctx.strokeRect(x, y, w, h);
    ctx.fillRect(x + 1, y + 1, Math.max(0, (w - 2) * pct), h - 2);
  }

  // ---------- Game State ----------
  const game = {
    state: "title", // title | playing | paused | gameover
    round: 1,
    score: 0,
    combo: 0,
    lives: 3,
    missiles: 3,
    speed: 240, // px/sec forward feel (used later)
    ship: { x: W * 0.5, y: H * 0.72, r: 10 },

    resetToRoundStart() {
      this.state = "playing";
      this.ship.x = W * 0.5;
      this.ship.y = H * 0.72;
      // (later: reset trench seed / obstacle layout for this round)
    },

    newGame() {
      this.round = 1;
      this.score = 0;
      this.combo = 0;
      this.lives = 3;
      this.missiles = 3;
      this.speed = 240;
      this.resetToRoundStart();
    },

    loseLife() {
      this.lives -= 1;
      this.combo = 0;
      if (this.lives <= 0) {
        this.state = "gameover";
      } else {
        // restart from beginning of the same round
        this.resetToRoundStart();
      }
    },

    togglePause() {
      if (this.state === "playing") this.state = "paused";
      else if (this.state === "paused") this.state = "playing";
    },

    nextRound() {
      this.round += 1;
      this.missiles = Math.min(5, this.missiles + 1); // small refill each round
      this.speed = Math.min(520, this.speed + 30);    // ramp difficulty
      this.resetToRoundStart();
    }
  };

  // Start instructions: press Enter to start/restart
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (k === "enter") {
      if (game.state === "title" || game.state === "gameover") game.newGame();
    }
  });

  // ---------- Update ----------
  function update(dt) {
    if (game.state !== "playing") return;

    // Movement: WASD or arrows
    const left = isDown("a") || isDown("arrowleft");
    const right = isDown("d") || isDown("arrowright");
    const up = isDown("w") || isDown("arrowup");
    const down = isDown("s") || isDown("arrowdown");

    const vx = (right ? 1 : 0) - (left ? 1 : 0);
    const vy = (down ? 1 : 0) - (up ? 1 : 0);

    const speed = 320; // lateral/vertical speed
    game.ship.x += vx * speed * dt;
    game.ship.y += vy * speed * dt;

    // Keep ship within a safe play area (we'll tighten once trench exists)
    game.ship.x = clamp(game.ship.x, 40, W - 40);
    game.ship.y = clamp(game.ship.y, H * 0.45, H - 40);

    // Simple score tick for now
    game.score += Math.floor(10 * dt * game.round);

    // TEMP test: Press L to simulate losing a life (for verification)
    if (isDown("l")) {
      keys.delete("l");
      game.loseLife();
    }

    // TEMP test: Press N to simulate "vent hit" and advance round
    if (isDown("n")) {
      keys.delete("n");
      game.nextRound();
    }
  }

  // ---------- Render ----------
  function render() {
    // background
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#05070a";
    ctx.fillRect(0, 0, W, H);

    // Retro “Pong-era” minimal shapes: frame
    ctx.strokeStyle = "rgba(230,240,255,0.25)";
    ctx.lineWidth = 1;
    ctx.strokeRect(10, 10, W - 20, H - 20);

    // HUD (full)
    ctx.fillStyle = "#e6f0ff";
    ctx.strokeStyle = "#e6f0ff";
    ctx.lineWidth = 1;

    drawText(`SCORE ${game.score}`, 22, 34, 16);
    drawText(`ROUND ${game.round}`, 22, 56, 14, 0.9);

    drawText(`LIVES ${game.lives}`, W - 130, 34, 16);
    drawText(`MISSILES ${game.missiles}`, W - 170, 56, 14, 0.9);

    drawText(`SPEED ${Math.floor(game.speed)}`, W * 0.5 - 60, 34, 14, 0.9);
    drawText(`COMBO x${game.combo}`, W * 0.5 - 60, 56, 14, 0.9);

    // LOCK indicator placeholder (will light up during vent run later)
    ctx.globalAlpha = 0.7;
    ctx.strokeRect(W * 0.5 - 32, 70, 64, 22);
    ctx.globalAlpha = 1;
    drawText(`LOCK`, W * 0.5 - 18, 87, 14, 0.8);

    // Ship (simple triangle)
    if (game.state !== "title") {
      drawShip(game.ship.x, game.ship.y);
    }

    // Overlays
    if (game.state === "title") {
      centerOverlay(
        "NEON TRENCH RUN",
        ["Press ENTER to start", "Move: WASD / Arrows", "Fire: Space (soon)  |  Missile: M (soon)"]
      );
    } else if (game.state === "paused") {
      centerOverlay("PAUSED", ["Press ESC to resume"]);
    } else if (game.state === "gameover") {
      centerOverlay("GAME OVER", ["Press ENTER to play again"]);
    } else {
      // small debug help
      ctx.globalAlpha = 0.6;
      drawText("Debug: N = next round, L = lose life", 22, H - 24, 12);
      ctx.globalAlpha = 1;
    }
  }

  function centerOverlay(title, lines) {
    ctx.fillStyle = "#e6f0ff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    drawText(title, W / 2, H / 2 - 30, 34);
    let y = H / 2 + 10;
    for (const line of lines) {
      drawText(line, W / 2, y, 16, 0.9);
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

    // triangle ship
    ctx.beginPath();
    ctx.moveTo(0, -14);
    ctx.lineTo(-10, 10);
    ctx.lineTo(10, 10);
    ctx.closePath();
    ctx.stroke();

    // tiny “engine” line
    ctx.beginPath();
    ctx.moveTo(0, 10);
    ctx.lineTo(0, 16);
    ctx.stroke();

    ctx.restore();
  }

  // ---------- Main Loop ----------
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
