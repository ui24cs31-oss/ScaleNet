const { spawnWorker } = require('./index');

async function startAll() {
  console.log("=== Starting Docker Containers for ScaleNet ===\n");
  try {
    const w1 = await spawnWorker('interactive', 'interactive-1', 4001);
    const w2 = await spawnWorker('compute', 'compute-1', 4002);
    const w3 = await spawnWorker('batch', 'batch-1', 4003);
    
    console.log("\n✅ All 3 workers are now isolated inside Docker running locally!");
    console.log("Interactive is on 4001, Compute on 4002, and Batch on 4003.");
  } catch (err) {
    console.error("Failed to start workers:", err.message);
  }
}

startAll();
