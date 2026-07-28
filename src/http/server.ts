import express from "express";
import "../config/env";

const app = express();

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const PORT = 3000;

app.listen(PORT, () => {
  console.log(`[http] listening on http://localhost:${PORT}`);
});
