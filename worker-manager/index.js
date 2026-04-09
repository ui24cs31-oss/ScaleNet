const util = require('util');
const exec = util.promisify(require('child_process').exec);
const axios = require('axios');

// Track the workers we create: workerId -> mapped host port
const activeWorkers = new Map();

// Since you already have worker-1 (4001) and worker-2 (4002) running manually,
// we will start generating from worker-3 on port 4003.
let nextPort = 4003; 
let workerCounter = 3;

/**
 * Spawns a new Docker container, then registers it with the Load Balancer
 */
async function spawnWorker() {
  const port = nextPort++;
  const workerId = `worker-${workerCounter++}`;
  
  console.log(`[WorkerManager] Spawning ${workerId} on port ${port}...`);

  // Run the exact same docker command you ran in the terminal!
  const cmd = `docker run -d --network scalenet-network --name ${workerId} -p ${port}:4001 -e PORT=4001 -e WORKER_ID=${workerId} scalenet-worker`;
  
  try {
    const { stdout, stderr } = await exec(cmd);
    
    // Save to our local tracker
    activeWorkers.set(workerId, port);
    console.log(`[WorkerManager] Container ${workerId} started (ID: ${stdout.trim().substring(0, 12)})`);

    // Wait 1.5 seconds to give the NodeJS Express server inside the container time to boot up
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Tell the Load Balancer to add it to its address book!
    // Because the LB is running on your host PC right now, it needs to contact it via localhost:4003
    const url = `http://localhost:${port}`; 
    
    await axios.post('http://localhost:3000/register', { id: workerId, url });
    console.log(`[WorkerManager] Registered ${workerId} with Load Balancer at ${url}`);
    
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
