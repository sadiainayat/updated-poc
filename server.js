const express = require('express');
const path = require('path');

const casesRouter = require('./src/routes/cases');
const queueRouter = require('./src/routes/queue');

const app = express();
// Raised from Express's 100kb default — CNIC photos as base64 need more room.
app.use(express.json({ limit: '15mb' }));

app.use('/api/cases', casesRouter);
app.use('/api/queue', queueRouter);

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Merchant onboarding POC running at http://localhost:${PORT}/`);
  console.log('Open that address in your browser to start the walkthrough.');
});
