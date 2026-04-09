const axios = require('axios');

// ─── Config ────────────────────────────────────────────────────────────────────
const MAX_QUEUE_SIZE  = 100;
const TASK_TIMEOUT_MS = 8000;

// ─── State ─────────────────────────────────────────────────────────────────────
let workers = []; // { id, url, activeRequests, capacity, weight }
let queue   = []; // { id, resolve, reject, enqueuedAt, timeoutHandle }
let taskCounter = 0;

// Algorithm state
let currentAlgorithm = 'weighted-least-connections';

// Round Robin state
let rrIndex = 0;

// Weighted Round Robin state
let wrrIndex = 0;
let wrrCounter = 0;

// ─── Worker Management ─────────────────────────────────────────────────────────
function addWorker(worker) {
  const capacity = Math.floor(Math.random() * 4) + 2;
  // According to requirement: Maintain weight per worker (default = 1)
  // We'll use capacity as a proxy for weight if weight isn't provided, 
  // or just default to 1 as requested. Let's use 1 to be safe, 
  // but allow it to be passed in.
  const weight = worker.weight || 1; 

  workers.push({ 
    ...worker, 
    activeRequests: 0, 
    capacity: capacity,
    weight: weight 
  });
  
  console.log(`[Scheduler] Worker added: ${worker.id} | max capacity: ${capacity} | weight: ${weight} | total workers: ${workers.length}`);
  dispatch();
}

function removeWorker(workerId) {
  workers = workers.filter(w => w.id !== workerId);
  // Reset indices if they go out of bounds
  if (rrIndex >= workers.length) rrIndex = 0;
  if (wrrIndex >= workers.length) {
    wrrIndex = 0;
    wrrCounter = 0;
  }
  console.log(`[Scheduler] Worker removed: ${workerId} | total workers: ${workers.length}`);
}

// ─── Algorithms ────────────────────────────────────────────────────────────────

// 1. Strict Round Robin (with 3-check bounding logic)
function getWorker_RoundRobin() {
  const maxChecks = Math.min(3, workers.length);

  for (let i = 0; i < maxChecks; i++) {
    const idx = (rrIndex + i) % workers.length;
    const worker = workers[idx];
    if (worker.activeRequests < worker.capacity) {
      rrIndex = (idx + 1) % workers.length;
      return worker;
    }
  }
  rrIndex = (rrIndex + 1) % workers.length;
  return null;
}

// 2. Weighted Round Robin
function getWorker_WeightedRoundRobin() {
  const maxChecks = Math.min(3, workers.length); // Bounding logic applied here too

  for (let i = 0; i < maxChecks; i++) {
    const idx = (wrrIndex + i) % workers.length;
    const worker = workers[idx];

    // If we've switched to a new worker in our "3-check window", reset counter
    if (idx !== wrrIndex) {
        // This is a bit complex for a "windowed" WRR. 
        // Let's simplify: If current worker is full or has used up its weight, move on.
    }

    if (worker.activeRequests < worker.capacity) {
      // Check if this worker still has weight-turns left
      // But if we are in a window-search, we just want to find WHO is free.
      // If idx is the current wrrIndex, check the counter.
      if (idx === wrrIndex) {
         if (wrrCounter < worker.weight) {
            wrrCounter++;
            return worker;
         } else {
            // Used up weight! Move to next and reset.
            wrrIndex = (wrrIndex + 1) % workers.length;
            wrrCounter = 0;
            // Don't return yet, the loop will check the next one in the next iteration
            continue; 
         }
      } else {
         // This is one of the "fallback" servers in the 3-check window.
         // We'll take it, but we won't update the main WRR index since it's a fallback.
         return worker;
      }
    }
  }

  // Fallback: Increment index to try a different window next time
  wrrIndex = (wrrIndex + 1) % workers.length;
  wrrCounter = 0;
  return null;
}

// 3. Weighted Least Connections
function getWorker_WeightedLeastConnections() {
  let bestWorker = null;
  let lowestScore = Infinity;

  // WLC typically scans all workers to find the absolute best
  for (const worker of workers) {
    if (worker.activeRequests < worker.capacity) {
      // score = activeConnections / weight
      const score = worker.activeRequests / (worker.weight || 1);
      
      if (score < lowestScore) {
        lowestScore = score;
        bestWorker = worker;
      }
    }
  }

  return bestWorker;
}

function getFreeWorker() {
  if (workers.length === 0) return null;

  switch (currentAlgorithm) {
    case 'round-robin':
      return getWorker_RoundRobin();
    case 'weighted-round-robin':
      return getWorker_WeightedRoundRobin();
    case 'weighted-least-connections':
    default:
      return getWorker_WeightedLeastConnections();
  }
}

// ─── Algorithm Control ─────────────────────────────────────────────────────────
function setAlgorithm(algo) {
  const validAlgos = ['round-robin', 'weighted-round-robin', 'weighted-least-connections'];
  if (validAlgos.includes(algo)) {
    currentAlgorithm = algo;
    console.log(`[Scheduler] Algorithm switched to: ${algo}`);
    return true;
  }
  return false;
}

function getAlgorithm() {
  return currentAlgorithm;
}

// ─── Core Dispatch (Event-driven) ──────────────────────────────────────────────
function dispatch() {
  while (queue.length > 0) {
    const worker = getFreeWorker();
    if (!worker) break;

    const task = queue.shift();
    clearTimeout(task.timeoutHandle);

    console.log(`[Scheduler] [${currentAlgorithm}] Dispatching ${task.id} → ${worker.id} (${worker.activeRequests + 1}/${worker.capacity} cap) | queue: ${queue.length}`);
    sendToWorker(worker, task);
  }
}

async function sendToWorker(worker, task) {
  worker.activeRequests++;
  try {
    const response = await axios.get(`${worker.url}/task`, { timeout: 10000 });
    task.resolve({
      ...response.data,
      handledBy: worker.id,
    });
  } catch (err) {
    console.error(`[Scheduler] Worker ${worker.id} failed for task ${task.id}: ${err.message}`);
    task.reject({ error: 'Worker failed', worker: worker.id, reason: err.message });
  } finally {
    worker.activeRequests--;
    dispatch();
  }
}

// ─── Enqueue ───────────────────────────────────────────────────────────────────
function enqueue(taskData) {
  return new Promise((resolve, reject) => {
    if (queue.length >= MAX_QUEUE_SIZE) {
      return reject({ error: 'Queue full', queueSize: queue.length });
    }

    taskCounter++;
    const taskId = taskData.id || `task-${taskCounter}`;

    const timeoutHandle = setTimeout(() => {
      queue = queue.filter(t => t.id !== taskId);
      reject({ error: 'Task timed out', taskId });
    }, TASK_TIMEOUT_MS);

    queue.push({ id: taskId, resolve, reject, enqueuedAt: Date.now(), timeoutHandle });
    dispatch();
  });
}

function getStatus() {
  return {
    algorithm: currentAlgorithm,
    queueSize: queue.length,
    workers: workers.map(w => ({ 
      id: w.id, 
      active: w.activeRequests, 
      cap: w.capacity, 
      weight: w.weight,
      score: w.activeRequests / (w.weight || 1)
    }))
  };
}

module.exports = { enqueue, addWorker, removeWorker, getStatus, setAlgorithm, getAlgorithm };
