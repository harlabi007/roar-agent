const express = require("express");
const cors    = require("cors");
const app     = express();

app.use(cors());
app.use(express.json());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

app.post("/ai/insight", async (req, res) => {
  try {
    const { question, matchId } = req.body;
    if (!question) return res.status(400).json({ error: "question required" });

    const prompt = `You are a sharp football analyst. In exactly 2 sentences (max 40 words total), give a specific statistical insight about this prediction: "${question}" for the match ${matchId.replace(/_/g," ")}. Be direct and confident.`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 100,
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || "";
    res.json({ insight: text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/ai/summary", async (req, res) => {
  try {
    const { markets } = req.body;
    if (!markets || !markets.length) return res.status(400).json({ error: "markets required" });

    const summary = markets.map(m => `"${m.question}" → ${m.outcome}`).join(", ");
    const prompt  = `You are a live football commentator. In 2-3 exciting sentences (max 60 words), summarize these prediction market results: ${summary}. Be enthusiastic!`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 120,
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || "";
    res.json({ summary: text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/health", (_, res) => res.json({ status: "ok", service: "ROAR AI Proxy" }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🤖 ROAR AI Proxy running on port ${PORT}`));