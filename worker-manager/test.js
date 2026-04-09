const { spawnWorker, stopWorker, getActiveWorkers } = require('./index');

async function runTest() {
  console.log("=== Executing Worker Manager Scalability Test ===\n");
  
  try {
    // 1. Spawn a new worker dynamically
    const newWorker = await spawnWorker();
    
    console.log("\nCurrently active auto-scaled workers:");
    console.log(getActiveWorkers());
    
    console.log("\n⏳ Sleeping for 15 seconds...");
    console.log("👉 CHECK YOUR BROWSER NOW: http://localhost:3000/queue");
    console.log("You will see worker-3 has magically appeared in the list!\n");
    
    // 2. Wait 15 seconds to give you time to check the browser
    await new Promise(resolve => setTimeout(resolve, 15000));
    
    // 3. Kill it
    console.log("\nScaling down... Destroying worker-3");
    await stopWorker(newWorker.workerId);
    
    console.log("\n✅ Test completed. Check http://localhost:3000/queue again — worker-3 is gone.");
  } catch(e) {
    console.error("Test failed", e);
  }
}

runTest();
