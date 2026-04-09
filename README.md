# ScaleNet ⚖️

ScaleNet is a distributed load management and auto-scaling system inspired by cloud infrastructure primitives (like Kubernetes and AWS Auto Scaling). It simulates how incoming client requests are handled, queued, distributed, and processed across dynamically scaling Docker worker nodes.

## 🏗 Architecture

Traffic flows through the following pipeline:
`Client (Traffic Generator) → Load Balancer → Event-Driven Scheduler → Docker Worker Nodes`

### Core Components Built So Far:
* **Load Balancer:** The API Gateway. It exposes REST endpoints and proxies traffic to the underlying topology.
* **Concurrency-Aware Scheduler:** An event-driven, token-capacity scheduler implementing O(1) latency-free "Power of Two/Three Choices" bounded Round Robin. Handles queueing and timeouts.
* **Worker Nodes:** Dockerized Express containers simulating variable-latency computational backend work (ranging from 100ms - 800ms delays).
* **Worker Manager:** Programmatic Docker CLI orchestrator. It dynamically spins up and tears down Docker containers on the host machine and registers them with the Load Balancer via HTTP.
* **Traffic Generator:** An automated client capable of bursting simulated HTTP traffic at a precise RPS (Requests Per Second) to test concurrency bottlenecks.

## 🚀 How to Run

### 1. Start the Docker Network
Containers communicate via internal Docker DNS. Ensure the network exists:
```bash
docker network create scalenet-network
```

### 2. Spawn Initial Workers
```bash
docker run -d --network scalenet-network --name worker-1 -p 4001:4001 -e PORT=4001 -e WORKER_ID=worker-1 scalenet-worker
docker run -d --network scalenet-network --name worker-2 -p 4002:4001 -e PORT=4001 -e WORKER_ID=worker-2 scalenet-worker
```

### 3. Start the Load Balancer
```bash
cd load-balancer
npm install
node index.js
```

### 4. Run the Load Test
In the root directory, simulate 50 requests at 10 requests-per-second:
```bash
npm install axios
node test-traffic.js 10 50
```

## 🛠 Future Roadmap
- Metrics Collector (Rolling in-memory buffers for RPS and p95 latency)
- Health Monitor (Active pinging and container replacement logic)
- Reactive Auto-Scaler 
- ML Predictive Auto-Scaler (Holt-Winters forecasting for container pre-warming)
