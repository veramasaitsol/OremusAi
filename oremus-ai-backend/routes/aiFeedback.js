const express = require('express');
const router = express.Router();
const AI_BACKEND_URL = 'http://122.175.56.137:8000/api/v1/feedback';

async function aiFeedback(req, res) {
  res.send("feedback working")
}


router.post('/feedback', aiFeedback);

module.exports = router;
