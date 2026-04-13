# ScaleNet ⚖️

ScaleNet is a high-performance distributed load management and auto-scaling system. Inspired by cloud infrastructure primitives, it simulates how incoming client requests are handled, distributed, and processed across dynamically scaling backend worker node pools.

## 🏗 Architecture (v2 - O(1) Push Model)

Traffic flows through the following highly optimized pipeline:
`Client → Load Balancer → O(1) P2C Scheduler → Specialized Worker Pools (Docker)`

### Core Innovations & Components:
* **Load Balancer (API Gateway):** Exposes REST endpoints, ingests tasks, and proxies them to the distributed scheduler.
* **$O(1)$ Event-Driven Scheduler:** Implements a heavily optimized "Power of Two Choices" (P2C) algorithm combined with a Weighted Least Connections approach.
  * Uses a highly efficient `Swap-Tail-Pop` Array and Hashmap synchronization to guarantee $O(1)$ time complexity for enqueueing, dispatching, filtering, and deleting worker states. No full array scans.
* **Push-Based Heartbeat System:** Workers operate entirely autonomously and send state metrics (capacity, active connections, running complexity) natively via active `fetch()` heartbeats every 2 seconds. The Load Balancer passively registers them dynamically without manual intervention.
* **Specialized Worker Pools:** Backends are now strictly grouped logically enforcing strict SLAs:
    1. **Interactive Pool**: Real-time SLA. Immediate execution. 200ms harsh deadline enforcement.
    2. **Compute Pool**: Heavy-duty SLA. Processes highly variated arbitrary complexity loads. Throttled based on `utilization = running_total_complexity / capacity`. Strict sleep emulation `1000 + (complexity / 10) * 3000ms`.
    3. **Batch Pool**: Deferred execution SLA. Absorbs unlimited bursts into an internal worker buffer queue before draining and scaling.
* **Distributed Admission Control**: An intelligent API-Gateway-level circuit breaker calculating aggregated real-time system pressure (`(3i + 2c + 1b)/6`). Gracefully sheds low-priority tasks with intelligent HTTP `503 Retry-After` headers during peak overload before hitting execution queues.
* **Granular Telemetry Pipeline**: Asynchronously streams 5-second interval metric snapshots natively to `logs/metrics.jsonl` tracking rolling latencies, worker limits, and gateway drop ratios.
* **Docker Orchestrator**: Programmatically spins up isolated container topologies locally and binds them back to the host via explicit Docker networking headers (`host.docker.internal`).

## 🚀 How to Run locally via Docker

### 1. Build the Docker Image
Whenever you make a change to the worker logic (`worker/server.js`), you must take a new Docker snapshot:
```bash
cd worker
docker build -t scalenet-worker .
cd ..
```

### 2. Start the Load Balancer
The gateway and scheduler run as a unified native process safely listening for heartbeats.
```bash
node load-balancer/index.js
```

### 3. Spin up the Worker Typology
Run the manager script to spin up the local worker containers and watch them instantly sync with the Load Balancer natively:
```bash
node worker-manager/start-docker-workers.js
```

### 4. Unleash the Load Generator
In a new terminal window, simulate asynchronous cascading HTTP traffic (e.g. 15 requests-per-second until 150 requests are processed):
```bash
node test-traffic.js 15 150
```

*Note: Heavy Compute tasks with excessive requests may beautifully and securely timeout out of the queue after 8000ms if concurrency limits are saturated.*

## 🛠 Future Roadmap
- Active Monitoring and Health pinging
- ML Predictive Auto-Scaler (Holt-Winters forecasting for container pre-warming)
