(() => {
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#e6f0ff";
  ctx.font = "28px system-ui, sans-serif";
  ctx.fillText("JS LOADED ✅", 40, 80);
})();

