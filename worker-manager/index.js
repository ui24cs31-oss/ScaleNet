const util = require('util');
const exec = util.promisify(require('child_process').exec);
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const logDir = path.join(__dirname, '../logs');
fs.mkdirSync(logDir, { recursive: true });

const POOL_LIMITS = {
    interactive: { min: 1, max: 5 },
    compute:     { min: 1, max: 4 },
    batch:       { min: 1, max: 3 }
};

const COOLDOWN_MS = 60000;
const AUTOSCALER_INTERVAL = 10000;
const EMERGENCY_UTILIZATION = 0.90;
const NORMAL_UTILIZATION = 0.70;
const SPAWN_TIMEOUT_MS = 30000;
const DRAIN_TIMEOUT_MS = 60000;
const HEALTH_POLL_INTERVAL_MS = 500;

const previousSnapshot = {
    interactive: { queueDepth: 0 },
    compute:     { queueDepth: 0 },
    batch:       { queueDepth: 0 }
};

const lastActionTime = {
    interactive: 0,
    compute:     0,
    batch:       0
};

// Track the workers we create: workerId -> mapped host port
const activeWorkers = new Map();

// Since you already have worker-1 (4001) and worker-2 (4002) running manually,
// we will start generating from worker-3 on port 4003.
let nextPort = 4001; 

/**
 * Spawns a new Docker container, then assumes heartbeat will handle registration
 */
async function spawnWorker(type = 'batch', workerIdStr = null, forcedPort = null) {
  const port = forcedPort || nextPort++;
  const workerId = workerIdStr || `${type}-${port}`;
  
  console.log(`[WorkerManager] Spawning ${workerId} on port ${port}...`);

  // We must pass LB_URL=http://host.docker.internal:3000 so the container can heartbeat back to the host!
  const cmd = `docker run -d --name ${workerId} -p ${port}:${port} -e PORT=${port} -e WORKER_ID=${workerId} -e WORKER_TYPE=${type} -e LB_URL=http://host.docker.internal:3000 scalenet-worker`;
  
  try {
    const { stdout, stderr } = await exec(cmd);
    
    // Save to our local tracker
    activeWorkers.set(workerId, { port, poolType: type, spawnedAt: Date.now() });
    console.log(`[WorkerManager] Container ${workerId} started (ID: ${stdout.trim().substring(0, 12)})`);

    // Poll /health to ensure worker is ready before returning
    console.log(`[WorkerManager] Waiting for ${workerId} to become healthy...`);
    const startTime = Date.now();
    let isHealthy = false;
    while (Date.now() - startTime < 30000) {
      try {
        const res = await axios.get(`http://localhost:${port}/health`);
        if (res.status === 200) {
          isHealthy = true;
          break;
        }
      } catch (err) {
        // Container still starting up
      }
      await new Promise(r => setTimeout(r, 500));
    }

    if (!isHealthy) {
      console.error(`[WorkerManager] Health check timeout for ${workerId}. Destroying zombie container.`);
      activeWorkers.delete(workerId);
      await exec(`docker rm -f ${workerId}`).catch(() => {});
      throw new Error(`Health check timeout for ${workerId} after 30 seconds.`);
    }

    // No need to manually post to /register anymore! Heartbeat handles it!
    console.log(`[WorkerManager] ${workerId} is healthy! Relying on Heartbeat to register...`);
    
    return { workerId, port, poolType: type, status: 'spawned' };
  } catch (err) {
    console.error(`[WorkerManager] Failed to spawn ${workerId}:`, err.message);
    throw err;
  }
}

/**
 * Kills a Docker container, then deregisters it from the Load Balancer
 */
async function stopWorker(workerId) {
  if (!activeWorkers.has(workerId)) {
    throw new Error(`${workerId} is not tracked by WorkerManager.`);
  }

  const port = activeWorkers.get(workerId).port;
  console.log(`[WorkerManager] Draining and stopping ${workerId}...`);
  
  try {
    // 1. Send drain signal
    await axios.post(`http://localhost:${port}/drain`).catch(() => {});

    // 2. Poll for 60 seconds waiting for activeConnections to drop to 0
    let drainComplete = false;
    const startDrain = Date.now();
    
    while (Date.now() - startDrain < DRAIN_TIMEOUT_MS) {
      try {
        const healthRes = await axios.get(`http://localhost:${port}/health`);
        if (healthRes.data && healthRes.data.activeConnections === 0) {
          drainComplete = true;
          break;
        }
      } catch (e) {
        // if health fails during drain, consider it dead/drained
        drainComplete = true;
        break;
      }
      await new Promise(r => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
    }

    if (!drainComplete) {
      console.warn(`[WorkerManager] Drain timeout for ${workerId} exceeded 60s. Forcefully proceeding.`);
    }

    // 3. Unregister from load balancer
    await axios.delete(`http://localhost:3000/deregister/${workerId}`).catch(() => {});
    console.log(`[WorkerManager] Deregistered ${workerId} from Load Balancer.`);

    // 4. Destroy container and clear map
    await exec(`docker rm -f ${workerId}`);
    activeWorkers.delete(workerId);
    console.log(`[WorkerManager] Container ${workerId} destroyed.`);

    return { workerId, status: 'stopped' };
  } catch (err) {
    console.error(`[WorkerManager] Failed to stop ${workerId}:`, err.message);
    throw err;
  }
}

/**
 * Simply returns the list of workers this manager has spawned
 */
function getActiveWorkers() {
  return Array.from(activeWorkers.entries()).map(([id, data]) => ({ id, ...data }));
}

function getWorkerCountByPool() {
  const counts = { interactive: 0, compute: 0, batch: 0 };
  for (const data of activeWorkers.values()) {
    if (counts[data.poolType] !== undefined) {
      counts[data.poolType]++;
    }
  }
  return counts;
}

function logDecision(pool, action, reason, workersBefore, workersAfter, trigger) {
  const logObject = {
      timestamp: Date.now(),
      pool,
      action,
      reason,
      workersBefore,
      workersAfter,
      trigger
  };
  
  const logFile = path.join(logDir, 'scaling_decisions.jsonl');
  fs.appendFileSync(logFile, JSON.stringify(logObject) + '\n');
}

// ─── Autoscaler Loop ───────────────────────────────────────────────────────────
setInterval(async () => {
  try {
    const statusRes = await axios.get('http://localhost:3000/status');
    const aggregatedStatus = statusRes.data;
    const currentWorkerCounts = getWorkerCountByPool();

    for (const pool of ['interactive', 'compute', 'batch']) {
      const status = aggregatedStatus[pool];
      if (!status) continue;

      const workerCount = currentWorkerCounts[pool];
      const utilization = workerCount === 0 ? 0 : status.activeWorkers / workerCount;
      const queueGrowing = status.queueDepth > previousSnapshot[pool].queueDepth;
      
      // ─── Emergency Check ───
      // (To be implemented in Step 7)

      // ─── Normal Scale Up/Down ───
      // (To be implemented in Step 7)
      
      previousSnapshot[pool].queueDepth = status.queueDepth;
    }
  } catch (err) {
    console.error(`[Autoscaler] Skipping cycle, failed to read status: ${err.message}`);
  }
}, AUTOSCALER_INTERVAL);

module.exports = { spawnWorker, stopWorker, getActiveWorkers, getWorkerCountByPool, logDecision };
