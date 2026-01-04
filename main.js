// game/main.js
(() => {
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#e6f0ff";
  ctx.font = "28px system-ui, sans-serif";
  ctx.fillText("Neon Trench Run", 40, 80);
  ctx.font = "18px system-ui, sans-serif";
  ctx.fillText("Next step: build the game loop + trench + HUD.", 40, 120);
})();
