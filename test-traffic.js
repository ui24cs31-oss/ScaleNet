const axios = require('axios');

const LB_URL = 'http://localhost:3000';

// Allow overriding via command line: node test-traffic.js <RPS> <TOTAL>
const TARGET_RPS = Number(process.argv[2]) || 5; 
const MAX_REQUESTS = Number(process.argv[3]) || 50; 

let activeRequests = 0;
let completed = 0;
let errors = 0;
let totalLatency = 0;

console.log(`\n🚀 Starting Traffic Generator`);
console.log(`   Target  : ${TARGET_RPS} RPS`);
console.log(`   Total   : ${MAX_REQUESTS} requests`);
console.log(`   Command : node test-traffic.js [RPS] [TOTAL]\n`);

let generated = 0;

// Fire off requests at exact intervals to match our Target RPS
const interval = setInterval(async () => {
  if (generated >= MAX_REQUESTS) {
    clearInterval(interval);
    return;
  }
  
  generated++;
  activeRequests++;
  const id = `req-${generated}`;
  const start = Date.now();
  
  const type = ['interactive', 'compute', 'batch'][Math.floor(Math.random() * 3)];
  // Randomly assign complexity between 1 and 5 for diverse testing
  const complexity = Math.floor(Math.random() * 5) + 1;
  const body = { id, type, complexity };
  
  try {
    const res = await axios.post(`${LB_URL}/task`, body, { timeout: 30000 });
    const latency = Date.now() - start;
    totalLatency += latency;
    completed++;
    
    // Check if it's a batch accepted status (202)
    const statusText = res.data.status === 'accepted' ? 'ACCEPTED (Batch)' : 'DONE';
    console.log(`✅ ${id.padEnd(8)} | ${type.padEnd(11)} | Comp: ${complexity} | ${latency.toString().padStart(5)}ms | ${statusText.padEnd(16)} | Worker: ${res.data.workerId || 'LB'}`);
  } catch (err) {
    errors++;
    const latency = Date.now() - start;
    let reason = err.message;
    if (err.response && err.response.data) {
       reason = err.response.data.reason || err.response.data.error || err.response.status;
    }
    console.log(`❌ ${id.padEnd(8)} | ${type.padEnd(11)} | Comp: ${complexity} | ${latency.toString().padStart(5)}ms | FAILED: ${reason}`);
  } finally {
    activeRequests--;
    
    // When the very last request finishes (success or fail)
    if (completed + errors === MAX_REQUESTS) {
      console.log(`\n🏁 Traffic generation complete.`);
      console.log(`   Successful : ${completed}`);
      console.log(`   Errors     : ${errors}`);
      console.log(`   Avg Latency: ${completed > 0 ? Math.round(totalLatency / completed) : 0}ms\n`);
      process.exit(0);
    }
  }
}, 1000 / TARGET_RPS);
