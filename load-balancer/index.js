const express   = require('express');
const morgan    = require('morgan');
const cors      = require('cors');
const scheduler = require('../scheduler');

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// ─── Metrics State ─────────────────────────────────────────────────────────────
let requestCount = 0;
let currentRPS = 0;

// Update RPS every 1 second
setInterval(() => {
  currentRPS = requestCount;
  requestCount = 0;
}, 1000);

// ─── Register Workers into Scheduler ──────────────────────────────────────────
// Running on host → workers reachable via mapped ports
const INITIAL_WORKERS = [
  { id: 'worker-1', url: 'http://localhost:4001', weight: 4 },
  { id: 'worker-2', url: 'http://localhost:4002', weight: 2 },
];

INITIAL_WORKERS.forEach(w => scheduler.addWorker(w));

// ─── Routes ────────────────────────────────────────────────────────────────────

// GET /task — enqueue into scheduler, wait for result
app.get('/task', async (req, res) => {
  requestCount++; // Increment RPS counter
  const taskData = { id: req.query.id || null };

  try {
    const result = await scheduler.enqueue(taskData);
    res.json(result);
  } catch (err) {
    // Queue full or timed out
    const status = err.error === 'Queue full' ? 503 : 504;
    res.status(status).json(err);
  }
});

// GET /health — Load Balancer health
app.get('/health', (req, res) => {
  const status = scheduler.getStatus();
  res.json({
    status: 'ok',
    algorithm: scheduler.getAlgorithm(),
    ...status,
  });
});

// GET /metrics — Clean metrics for monitoring/auto-scaling
app.get('/metrics', (req, res) => {
  const status = scheduler.getStatus();
  res.json({
    timestamp: new Date().toISOString(),
    rps: currentRPS,
    queueSize: status.queueSize,
    totalActiveConnections: status.workers.reduce((acc, w) => acc + w.active, 0),
    algorithm: status.algorithm
  });
});

// GET /queue — current scheduler state (for debugging/dashboard)
app.get('/queue', (req, res) => {
  res.json(scheduler.getStatus());
});

// POST /register — Worker Manager calls this to add a new worker
app.post('/register', (req, res) => {
  const { id, url } = req.body;
  if (!id || !url) return res.status(400).json({ error: 'id and url required' });
  scheduler.addWorker({ id, url });
  res.json({ success: true, message: `${id} registered` });
});

// DELETE /deregister — Worker Manager calls this to remove a stopped worker
app.delete('/deregister/:id', (req, res) => {
  scheduler.removeWorker(req.params.id);
  res.json({ success: true, message: `${req.params.id} removed` });
});

// POST /algorithm — Switch the scheduling algorithm at runtime
app.post('/algorithm', (req, res) => {
  const { algorithm } = req.body;
  if (!algorithm) return res.status(400).json({ error: 'algorithm name required' });
  
  const success = scheduler.setAlgorithm(algorithm);
  if (!success) {
    return res.status(400).json({ 
      error: 'Invalid algorithm', 
      valid: ['round-robin', 'weighted-round-robin', 'weighted-least-connections'] 
    });
  }
  
  res.json({ success: true, algorithm });
});

// ─── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ Load Balancer listening on port ${PORT}`);
  console.log(`   Scheduling via: Scheduler (event-driven dispatch)`);
  console.log(`\n   GET  /task        → enqueue + await result`);
  console.log(`   GET  /health      → LB + scheduler status`);
  console.log(`   GET  /metrics     → live RPS + system state`);
  console.log(`   GET  /queue       → queue state`);
  console.log(`   POST /register    → add worker`);
  console.log(`   DEL  /deregister  → remove worker`);
  console.log(`   POST /algorithm   → switch algorithm (RR, WRR, WLC)\n`);
});
