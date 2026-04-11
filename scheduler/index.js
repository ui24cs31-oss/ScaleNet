const axios = require('axios');

// ─── Constants & Structures ──────────────────────────────────────────
const MAX_QUEUE_SIZE = 100;
const TASK_TIMEOUT_MS = 8000;

function createPoolState() {
  return {
    workerMap: new Map(),
    eligibleArray: [],
    eligibleSet: new Set(),
    inFlight: new Map(), // Used explicitly for compute complexity tracking
    rrIndex: 0           // Used strictly by batch pool
  };
}

const pools = {
  interactive: createPoolState(),
  compute: createPoolState(),
  batch: createPoolState()
};

let queues = { interactive: [], compute: [], batch: [] };
let taskCounter = 0;

// Interval to check for dead workers (every 5 seconds)
setInterval(checkDeadWorkers, 5000);

// ─── Eligible Structure Maintenance ──────────────────────────────────
function addToEligible(workerId, type) {
  const pool = pools[type];
  if (!pool || pool.eligibleSet.has(workerId)) return;

  pool.eligibleArray.push(workerId);
  pool.eligibleSet.add(workerId);
  const worker = pool.workerMap.get(workerId);
  if (worker) {
    worker.arrayIndex = pool.eligibleArray.length - 1;
  }
}

function removeFromEligible(workerId, type) {
  const pool = pools[type];
  if (!pool || !pool.eligibleSet.has(workerId)) return;

  const worker = pool.workerMap.get(workerId);
  if (!worker) return;

  const idx = worker.arrayIndex;
  const lastId = pool.eligibleArray[pool.eligibleArray.length - 1];

  // swap-tail-pop O(1)
  pool.eligibleArray[idx] = lastId;
  const lastWorker = pool.workerMap.get(lastId);
  if (lastWorker) {
    lastWorker.arrayIndex = idx;
  }
  pool.eligibleArray.pop();

  pool.eligibleSet.delete(workerId);
  worker.arrayIndex = -1;
}

// ─── Heartbeat Management ──────────────────────────────────────────
function onHeartbeat(payload) {
  const { workerId, poolType, activeConnections, capacity, runningTotalComplexity, healthy, port } = payload;
  const pool = pools[poolType];
  if (!pool) return;

  let worker = pool.workerMap.get(workerId);
  
  if (!worker) {
    // Register dynamically if not preset
    const workerPort = port || workerId.split('-')[1]; // Fallback to string split if old payload
    worker = {
      id: workerId,
      capacity: capacity,
      activeConnections: activeConnections,
      runningTotalComplexity: runningTotalComplexity || 0,
      arrayIndex: -1,
      healthy: healthy,
      lastHeartbeat: Date.now(),
      type: poolType,
      url: `http://localhost:${workerPort}`
    };
    pool.workerMap.set(workerId, worker);
    console.log(`[Scheduler] Dynamically registered ${workerId} via heartbeat in ${poolType} pool`);
  } else {
    // Update existing
    worker.activeConnections = activeConnections;
    worker.runningTotalComplexity = runningTotalComplexity || 0;
    worker.capacity = capacity;
    worker.healthy = healthy;
    worker.lastHeartbeat = Date.now();
  }

  const shouldBeEligible =
    worker.healthy &&
    worker.activeConnections < worker.capacity &&
    (Date.now() - worker.lastHeartbeat) < 5000;

  if (shouldBeEligible) {
    addToEligible(workerId, poolType);
  } else {
    removeFromEligible(workerId, poolType);
  }
  dispatch(); // See if we can drain queues now
}

function checkDeadWorkers() {
  const now = Date.now();
  for (const [type, pool] of Object.entries(pools)) {
    for (const [id, worker] of pool.workerMap.entries()) {
      if (now - worker.lastHeartbeat > 5000) {
        if (worker.healthy) {
           console.log(`[Scheduler] Worker ${id} died (no heartbeat for 5s)`);
        }
        worker.healthy = false;
        removeFromEligible(id, type);
      }
    }
  }
}

// Legacy initial registration from LB
function addWorker(workerData) {
  // We'll insert it into workerMap now so the heartbeat finds it cleanly later,
  // preventing URL guessing. LB maps port 4001..4004 etc
  const poolType = workerData.type || 'batch';
  const pool = pools[poolType];
  
  const worker = {
    id: workerData.id,
    url: workerData.url,
    capacity: workerData.capacity || 2, // Default, will sync via heartbeat
    activeConnections: 0,
    runningTotalComplexity: 0,
    arrayIndex: -1,
    healthy: true,
    lastHeartbeat: Date.now(),
    type: poolType
  };
  pool.workerMap.set(worker.id, worker);
  addToEligible(worker.id, poolType);
}

function removeWorker(workerId) {
   for (const [type, pool] of Object.entries(pools)) {
       if (pool.workerMap.has(workerId)) {
           removeFromEligible(workerId, type);
           pool.workerMap.delete(workerId);
           pool.inFlight.delete(workerId);
           console.log(`[Scheduler] Manual deregister of ${workerId}`);
       }
   }
}

// ─── Selection Logic (P2C) ──────────────────────────────────────────
function selectInteractiveWorker() {
  const pool = pools.interactive;
  if (pool.eligibleArray.length === 0) return null;
  if (pool.eligibleArray.length === 1) return pool.workerMap.get(pool.eligibleArray[0]);

  let i = Math.floor(Math.random() * pool.eligibleArray.length);
  let j;
  do { j = Math.floor(Math.random() * pool.eligibleArray.length); } while (j === i);

  const workerA = pool.workerMap.get(pool.eligibleArray[i]);
  const workerB = pool.workerMap.get(pool.eligibleArray[j]);

  const scoreA = workerA.activeConnections / (workerA.capacity || 1);
  const scoreB = workerB.activeConnections / (workerB.capacity || 1);

  let winner = scoreA <= scoreB ? workerA : workerB;

  if (winner.activeConnections >= winner.capacity) {
      winner = null;
      for (const id of pool.eligibleArray) {
          const w = pool.workerMap.get(id);
          if (w.activeConnections < w.capacity) {
              winner = w; 
              break;
          }
      }
  }
  return winner;
}

function selectComputeWorker() {
  const pool = pools.compute;
  if (pool.eligibleArray.length === 0) return null;
  if (pool.eligibleArray.length === 1) return pool.workerMap.get(pool.eligibleArray[0]);

  let i = Math.floor(Math.random() * pool.eligibleArray.length);
  let j;
  do { j = Math.floor(Math.random() * pool.eligibleArray.length); } while (j === i);

  const workerA = pool.workerMap.get(pool.eligibleArray[i]);
  const workerB = pool.workerMap.get(pool.eligibleArray[j]);

  const scoreA = workerA.runningTotalComplexity / (workerA.capacity || 1);
  const scoreB = workerB.runningTotalComplexity / (workerB.capacity || 1);

  let winner = scoreA <= scoreB ? workerA : workerB;

  if (winner.activeConnections >= winner.capacity) {
      winner = null;
      for (const id of pool.eligibleArray) {
          const w = pool.workerMap.get(id);
          if (w.activeConnections < w.capacity) {
              winner = w; 
              break;
          }
      }
  }
  return winner;
}

function selectBatchWorker() {
  const pool = pools.batch;
  if (pool.eligibleArray.length === 0) return null;
  
  const workerId = pool.eligibleArray[pool.rrIndex % pool.eligibleArray.length];
  pool.rrIndex++;
  return pool.workerMap.get(workerId);
}

// ─── Core Dispatch ──────────────────────────────────────────────────
function dispatch() {
  // Interactive
  while (queues.interactive.length > 0) {
    const worker = selectInteractiveWorker();
    if (!worker) break;
    const task = queues.interactive.shift();
    clearTimeout(task.timeoutHandle);
    sendRequest(worker, task);
  }

  // Compute
  while (queues.compute.length > 0) {
    const worker = selectComputeWorker();
    if (!worker) break;
    const task = queues.compute.shift();
    clearTimeout(task.timeoutHandle);
    sendRequest(worker, task);
  }

  // Batch
  while (queues.batch.length > 0) {
    const worker = selectBatchWorker();
    if (!worker) break;
    const task = queues.batch.shift();
    clearTimeout(task.timeoutHandle);
    sendRequest(worker, task);
  }
}

async function sendRequest(worker, task) {
  worker.activeConnections++;
  let complexity = 1;
  
  if (worker.type === 'compute') {
    complexity = Math.max(1, Math.min(10, task.complexity || 1));
    worker.runningTotalComplexity += complexity;
    const pool = pools.compute;
    if (!pool.inFlight.has(worker.id)) pool.inFlight.set(worker.id, new Map());
    pool.inFlight.get(worker.id).set(task.id, complexity);
  }

  if (worker.activeConnections >= worker.capacity) {
    removeFromEligible(worker.id, worker.type);
  }

  console.log(`[Scheduler] Dispatching ${task.id} → ${worker.id} (${worker.activeConnections}/${worker.capacity} cap)`);

  const payload = {
      id: task.id,
      type: task.type,
      enqueuedAt: task.enqueuedAt,
      complexity: complexity,
      payload: task.payload || null
  };

  try {
    if (task.type === 'batch') {
        // Resolve early for batch queue as per spec (fire & forget)
        task.resolve({ status: 'accepted', message: 'Dispatched to batch worker', handledBy: worker.id });
    }

    const axTimeout = task.type === 'compute' ? 60000 : 10000;
    const response = await axios.post(`${worker.url}/task`, payload, { timeout: axTimeout });
    
    if (task.type !== 'batch') {
        task.resolve({
            ...response.data,
            handledBy: worker.id
        });
    }
  } catch (err) {
    const errorMsg = err.response ? `HTTP ${err.response.status}` : (err.code || err.message);
    const serverDetails = err.response && err.response.data && err.response.data.error ? err.response.data.error : '';
    const finalReason = serverDetails ? `${errorMsg} - ${serverDetails}` : errorMsg;
    
    console.error(`[Scheduler] Worker ${worker.id} failed task ${task.id}: ${finalReason}`);
    if (task.type !== 'batch') {
        task.reject({ error: 'Worker failed', worker: worker.id, reason: finalReason });
    }
  } finally {
    onRequestComplete(worker.id, worker.type, task.id);
  }
}

function onRequestComplete(workerId, poolType, taskId) {
    const pool = pools[poolType];
    const worker = pool.workerMap.get(workerId);
    if (!worker) return;

    worker.activeConnections--;

    if (poolType === 'compute') {
        const workerInFlight = pool.inFlight.get(workerId);
        if (workerInFlight && workerInFlight.has(taskId)) {
            const completedComplexity = workerInFlight.get(taskId);
            worker.runningTotalComplexity -= completedComplexity;
            workerInFlight.delete(taskId);
        }
    }

    const nowEligible =
        worker.healthy &&
        worker.activeConnections < worker.capacity &&
        (Date.now() - worker.lastHeartbeat) < 5000;

    if (nowEligible) {
        addToEligible(workerId, poolType);
    }
    dispatch(); 
}

// ─── Enqueue ─────────────────────────────────────────────────────────
function enqueue(taskData) {
  const type = taskData.type || 'batch';
  
  return new Promise((resolve, reject) => {
    if (!queues[type]) {
       return reject({ error: 'Invalid task type', type });
    }

    if (queues[type].length >= MAX_QUEUE_SIZE) {
      return reject({ error: 'Queue full', type, queueSize: queues[type].length });
    }

    taskCounter++;
    const taskId = taskData.id || `task-${taskCounter}`;
    
    if (type === 'compute') {
       taskData.complexity = Math.max(1, Math.min(10, taskData.complexity ?? 1));
    }

    const timeoutHandle = setTimeout(() => {
      queues[type] = queues[type].filter(t => t.id !== taskId);
      reject({ error: 'Task timed out', taskId, type });
    }, TASK_TIMEOUT_MS);

    queues[type].push({ 
      ...taskData, 
      id: taskId, 
      resolve, 
      reject, 
      timeoutHandle 
    });
    
    dispatch();
  });
}

function getStatus() {
  const status = {
    algorithm: 'P2C / O(1)',
    queues: {
        interactive: queues.interactive.length,
        compute: queues.compute.length,
        batch: queues.batch.length
    },
    workerPools: {}
  };

  for (const [type, pool] of Object.entries(pools)) {
    status.workerPools[type] = Array.from(pool.workerMap.values()).map(w => ({
      id: w.id,
      active: w.activeConnections,
      cap: w.capacity,
      healthy: w.healthy,
      eligible: pool.eligibleSet.has(w.id),
      runningTotalComplexity: w.runningTotalComplexity
    }));
  }

  return status;
}

function setAlgorithm() { return false; }
function getAlgorithm() { return 'P2C / O(1)'; }

module.exports = { 
    enqueue, 
    addWorker, 
    removeWorker, 
    getStatus, 
    onHeartbeat,
    setAlgorithm,
    getAlgorithm
};
