# ShopFlow

A realtime order system built with NestJS, RabbitMQ, Redis, Socket.IO and Postgres, running on Docker Compose.

## What

ShopFlow takes an order over REST, hands the slow work (stock reservation, payment) to background workers through
RabbitMQ, and pushes every status change to the customer's browser over Socket.IO.

| Component | Role |
|---|---|
| `order-service` | REST API. Validates and stores the order, then publishes `OrderCreated` |
| `inventory-worker` | Reserves stock for each order and reports the result |
| `payment-worker` | Simulated payment provider with configurable latency and failure rate |
| `notification-gateway` | Socket.IO server. Authenticates clients and pushes order status to their room |

## Why

A synchronous checkout that reserves stock and charges the card inside one HTTP request is easy to write and hard to
keep fast. Every slow dependency adds to the response time, and a crash halfway leaves the order in an unknown state.
ShopFlow shows the event-driven alternative step by step, together with the problems it brings: duplicate messages,
retries, dead letters, overselling under load, and clients that miss updates while offline.

## Architecture

```
            HTTP                         OrderCreated
  client ----------> order-service --------------------> RabbitMQ
    ^                     |                              |       |
    |                     v                              v       v
    |                 Postgres                 inventory-worker  payment-worker
    |                                                |               |
    |                                                v               |
    |                                              Redis (Pro)       |
    |                                                                |
    |                         order status events                    |
    |                  RabbitMQ <------------------------------------+
    |                     |
    |    Socket.IO        v
    +------------- notification-gateway
```

## Status

Early development. `order-service` boots with a health check against Postgres. The workers and the
notification gateway are added one at a time, each in small commits that can be checked out and run on their own.

## Quickstart

Requirements: Docker with Compose v2, Node.js 24.11 or later.

```bash
cp .env.example .env
docker compose up -d --wait
npm ci
npm run start:dev
```

In another terminal:

```bash
curl http://127.0.0.1:3010/health
# {"status":"ok","database":"up"}
```

The RabbitMQ management UI is at http://127.0.0.1:15674 (user and password from `.env`).
Stop the stack with `docker compose down`; add `-v` to drop the data volumes.

## Free vs Pro

This repository is the free edition under the MIT license. A paid Pro edition extends the same codebase.

| Topic | Free | Pro |
|---|---|---|
| Project setup, synchronous baseline, RabbitMQ basics | Yes | Yes |
| Workers | ack, prefetch | + idempotent consumers, duplicate handling |
| Failure handling | — | Delayed retry, dead-letter queue, transactional outbox |
| Redis | — | Stock cache, lock against overselling |
| Socket.IO | Single instance, per-user rooms | + reconnect, replay of missed events |
| Scaling, operations, Kafka, deployment | — | Multiple gateway instances, Redis adapter, k6 load tests, metrics, deploy scripts |

## License

[MIT](LICENSE)
