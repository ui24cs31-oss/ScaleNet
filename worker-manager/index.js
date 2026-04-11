const util = require('util');
const exec = util.promisify(require('child_process').exec);
const axios = require('axios');

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
    activeWorkers.set(workerId, port);
    console.log(`[WorkerManager] Container ${workerId} started (ID: ${stdout.trim().substring(0, 12)})`);

    // No need to manually post to /register anymore! Heartbeat handles it!
    console.log(`[WorkerManager] Relying on Heartbeat to register ${workerId} ...`);
    
    return { workerId, port, status: 'spawned' };
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

  console.log(`[WorkerManager] Stopping and destroying ${workerId}...`);
  const cmd = `docker rm -f ${workerId}`;
  
  try {
    await exec(cmd);
    activeWorkers.delete(workerId);
    console.log(`[WorkerManager] Container ${workerId} destroyed.`);

    // Tell Load Balancer to remove it from routing
    await axios.delete(`http://localhost:3000/deregister/${workerId}`);
    console.log(`[WorkerManager] Deregistered ${workerId} from Load Balancer.`);
    
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
  return Array.from(activeWorkers.entries()).map(([id, port]) => ({ id, port }));
}

module.exports = { spawnWorker, stopWorker, getActiveWorkers };
