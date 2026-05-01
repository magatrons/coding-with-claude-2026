// CLI entry point: loads env, starts the Express server, serves the web UI,
// and hands /chat requests off to the agent loop in api.js.

require("dotenv").config();

const express = require("express");
const path = require("node:path");
const { chat } = require("./api");

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("\n  Missing ANTHROPIC_API_KEY.");
  console.error("  Copy .env.example to .env and add your key from https://console.anthropic.com/\n");
  process.exit(1);
}

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Bodies carry the full conversation history (including file contents Claude
// has already read), so they can get large. 10mb is generous but finite.
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// The one and only API route. Everything the browser needs flows through here:
//   request:  { message, history }
//   response: { reply, history, trace, iterations }
app.post("/chat", async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    const result = await chat(message, history);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  devlens  →  http://localhost:${PORT}`);
  console.log(`  watching: ${process.cwd()}\n`);
});
