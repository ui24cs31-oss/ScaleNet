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
  
  try {
    const res = await axios.get(`${LB_URL}/task?id=${id}`, { timeout: 15000 });
    const latency = Date.now() - start;
    totalLatency += latency;
    completed++;
    console.log(`✅ ${id.padEnd(8)} | ${latency.toString().padStart(4)}ms | ${res.data.handledBy || 'unknown'}`);
  } catch (err) {
    errors++;
    const latency = Date.now() - start;
    const reason = err.response ? (err.response.data.error || err.response.status) : err.message;
    console.log(`❌ ${id.padEnd(8)} | ${latency.toString().padStart(4)}ms | FAILED: ${reason}`);
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
