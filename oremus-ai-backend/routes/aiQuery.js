const express = require('express');
const router = express.Router();
const AI_BACKEND_URL = 'http://122.175.56.137:8000/api/v1/query';

async function queryAi(req, res) {
    console.log("Inside");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(AI_BACKEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: controller.signal,
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'AI backend timed out' });
    }
    console.error('AI backend proxy error:', err.message);
    res.status(502).json({ error: 'AI backend unreachable' });
  } finally {
    clearTimeout(timeout);
  }
}


router.post('/query', queryAi);

module.exports = router;