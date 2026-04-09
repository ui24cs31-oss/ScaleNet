const axios = require('axios');

// ─── Config ────────────────────────────────────────────────────────────────────
const MAX_QUEUE_SIZE  = 100; // Increased so we can see tasks buffer up at high load
const TASK_TIMEOUT_MS = 8000; // drop task if not dispatched within 8 seconds

// ─── State ─────────────────────────────────────────────────────────────────────
let workers = []; // { id, url, activeRequests, capacity }
let queue   = []; // { id, resolve, reject, enqueuedAt, timeoutHandle }
let taskCounter = 0;
let rrIndex = 0;

// ─── Worker Management ─────────────────────────────────────────────────────────
function addWorker(worker) {
  // Assign a variable random capacity between 2 and 5 requests simultaneously
  const capacity = Math.floor(Math.random() * 4) + 2;
  workers.push({ ...worker, activeRequests: 0, capacity });
  console.log(`[Scheduler] Worker added: ${worker.id} | max capacity: ${capacity} | total workers: ${workers.length}`);
  dispatch(); // a new worker is free — try dispatching any queued tasks
}

function removeWorker(workerId) {
  workers = workers.filter(w => w.id !== workerId);
  console.log(`[Scheduler] Worker removed: ${workerId} | total workers: ${workers.length}`);
}

function getFreeWorker() {
  if (workers.length === 0) return null;

  // Check the current worker and at most the next 2 workers (up to 3 checks max).
  // This prevents the latency of scanning thousands of servers on every request!
  const maxChecks = Math.min(3, workers.length);

  for (let i = 0; i < maxChecks; i++) {
    const workerIndex = (rrIndex + i) % workers.length;
    const worker = workers[workerIndex];
    
    // Server has spare capacity?
    if (worker.activeRequests < worker.capacity) {
      rrIndex = (workerIndex + 1) % workers.length; // Next turn goes to the next server
      return worker;
    }
  }
  
  // If the 3 checked workers are all at max capacity, we advance rrIndex by 1 
  // so we check a different window of servers next time, but we return null 
  // right now to force the request to stay in the queue.
  rrIndex = (rrIndex + 1) % workers.length;
  return null;
}

// ─── Core Dispatch (Event-driven) ──────────────────────────────────────────────
function dispatch() {
  // Keep dispatching as long as there are queued tasks AND workers with spare capacity
  while (queue.length > 0) {
    const worker = getFreeWorker();
    if (!worker) break; // all workers hit their max capacity — wait until one finishes

    const task = queue.shift(); // dequeue
    clearTimeout(task.timeoutHandle); // Cancel the queue timeout

    console.log(`[Scheduler] Dispatching ${task.id} → ${worker.id} (${worker.activeRequests + 1}/${worker.capacity} capacity) | queue: ${queue.length}`);
    sendToWorker(worker, task);
  }
}

async function sendToWorker(worker, task) {
  worker.activeRequests++; // Consume a capacity slot
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
    worker.activeRequests--; // Free up the capacity slot
    dispatch(); // Slot is free — try dispatching next queued task immediately
  }
}

// ─── Enqueue ───────────────────────────────────────────────────────────────────
function enqueue(taskData) {
  return new Promise((resolve, reject) => {
    if (queue.length >= MAX_QUEUE_SIZE) {
      console.warn(`[Scheduler] Queue full (${MAX_QUEUE_SIZE}) — rejecting task`);
      return reject({ error: 'Queue full', queueSize: queue.length, max: MAX_QUEUE_SIZE });
    }

    taskCounter++;
    const taskId = taskData.id || `task-${taskCounter}`;

    const timeoutHandle = setTimeout(() => {
      queue = queue.filter(t => t.id !== taskId);
      console.warn(`[Scheduler] Task ${taskId} timed out in queue`);
      reject({ error: 'Task timed out', taskId, waitedMs: TASK_TIMEOUT_MS });
    }, TASK_TIMEOUT_MS);

    const task = { id: taskId, resolve, reject, enqueuedAt: Date.now(), timeoutHandle };
    queue.push(task);

    // Try dispatching immediately
    dispatch(); 
  });
}

// ─── Status (for metrics + debugging) ─────────────────────────────────────────
function getStatus() {
  return {
    queueSize:    queue.length,
    maxQueueSize: MAX_QUEUE_SIZE,
    workers:      workers.map(w => ({ id: w.id, activeRequests: w.activeRequests, capacity: w.capacity })),
    totalActive:  workers.reduce((acc, w) => acc + w.activeRequests, 0),
    totalCapacity: workers.reduce((acc, w) => acc + w.capacity, 0)
  };
}

module.exports = { enqueue, addWorker, removeWorker, getStatus };
