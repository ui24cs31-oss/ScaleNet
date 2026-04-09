const express = require('express');
const morgan = require('morgan');

const app = express();
app.use(express.json());

// ─── Config from environment ───────────────────────────────────────────────────
const PORT      = process.env.PORT      || 4001;
const WORKER_ID = process.env.WORKER_ID || 'worker-1';

// ─── Metrics state ─────────────────────────────────────────────────────────────
let activeConnections = 0;
let totalProcessed    = 0;
const latencyHistory  = []; // keeps last 100 latencies

function recordLatency(ms) {
  latencyHistory.push(ms);
  if (latencyHistory.length > 100) latencyHistory.shift();
}

function avgLatency() {
  if (latencyHistory.length === 0) return 0;
  const sum = latencyHistory.reduce((a, b) => a + b, 0);
  return Math.round(sum / latencyHistory.length);
}

// ─── Helper: simulate async work ──────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ─── Logging ───────────────────────────────────────────────────────────────────
app.use(morgan('dev'));

// ─── Routes ────────────────────────────────────────────────────────────────────

// GET /task — simulate backend work (GET for easy browser testing)
app.get('/task', async (req, res) => {
  activeConnections++;
  const startTime      = Date.now();
  const processingTime = randomBetween(100, 800); // ms

  console.log(`[${WORKER_ID}] Task received | processing for ${processingTime}ms | active: ${activeConnections}`);

  try {
    await sleep(processingTime);

    const latency = Date.now() - startTime;
    recordLatency(latency);
    totalProcessed++;
    activeConnections--;

    console.log(`[${WORKER_ID}] Task done | latency: ${latency}ms | total processed: ${totalProcessed}`);

    res.json({
      workerId: WORKER_ID,
      status:   'done',
      latency,
      taskId:   req.query.id || null,
    });
  } catch (err) {
    activeConnections--;
    console.error(`[${WORKER_ID}] Task error:`, err.message);
    res.status(500).json({ workerId: WORKER_ID, status: 'error', error: err.message });
  }
});

// GET /health — instant response, no delay
app.get('/health', (req, res) => {
  res.json({
    status:            'ok',
    workerId:          WORKER_ID,
    activeConnections,
    totalProcessed,
    avgLatency:        avgLatency(),
  });
});

// ─── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ Worker [${WORKER_ID}] listening on port ${PORT}`);
  console.log(`   GET  /task   → simulate work (open in browser)`);
  console.log(`   GET  /health → status + metrics\n`);
});
