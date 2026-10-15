# Design decisions

Short, ADR-style records of the main trade-offs in this project. Each one has the same headings: **Context**, **Options considered**, **Decision**, **Consequences**. The prompts under each heading are placeholders to be replaced with the actual reasoning.

---

## ADR-001: Transactional outbox instead of dual writes

**Status:** draft

### Context
- What happens if we write to PostgreSQL and then publish to Kafka, and the process crashes in between?
- Which failure modes matter here (lost event, phantom event, out-of-order)?

### Options considered
- Dual write (DB, then publish; or publish, then DB)
- Transactional outbox + polling relay
- Change data capture (e.g. Debezium on the WAL)
- Distributed transactions / 2PC

### Decision
- _Which option, and why?_

### Consequences
- What does the relay cost (latency, polling load, table growth, cleanup)?
- How do multiple relay instances avoid publishing the same row concurrently?
- When would you switch to CDC?

---

## ADR-002: At-least-once delivery with consumer-side dedup

**Status:** draft

### Context
- Why is exactly-once delivery not something we can rely on end to end?
- Where can duplicates come from (relay retry, producer retry, consumer rebalance)?

### Options considered
- At-most-once (commit offset before processing)
- At-least-once + idempotent consumers
- Kafka transactions / exactly-once semantics

### Decision
- _Which option, and why?_

### Consequences
- How is dedup stored (processed-event table, unique key, same transaction as side effects)?
- When are offsets committed?
- How long are processed ids kept, and what happens to a duplicate older than that?
- How do retries, backoff and the DLQ fit in, and how is a DLQ message replayed?

---

## ADR-003: Idempotency keys and the concurrent-request race

**Status:** draft

### Context
- A till times out and retries while the first request is still running. What must the API guarantee?

### Options considered
- Application-level "check then insert"
- Unique constraint + `INSERT ... ON CONFLICT` claim with an `IN_PROGRESS` state
- Advisory locks / distributed lock

### Decision
- _Which option, and why?_

### Consequences
- What does a concurrent duplicate get while the first is `IN_PROGRESS` (`409`? wait?), and why?
- Same key, different payload: why `422`, and what goes into the request fingerprint?
- What happens to an `IN_PROGRESS` claim if the worker crashes (lock timeout, takeover)?
- Which responses are stored and replayed (only successes? 4xx too? never 5xx?)
- Key scope and retention window.

---

## ADR-004: Behaviour at scale: partitioning, consumer groups and ordering

**Status:** draft

### Context
- What ordering do downstream consumers actually need (global? per transaction? per site?)

### Options considered
- Partition key: transaction id vs merchant/site id vs none
- Number of partitions and consumer group sizing
- Single relay vs several relay instances

### Decision
- _Which partition key, and why?_

### Consequences
- How is per-transaction ordering preserved from outbox to consumer?
- What happens on rebalance, and with hot keys (one very busy site)?
- How do retries without blocking a partition interact with ordering (retry topics vs in-place retry)?
- What would you measure first (consumer lag, outbox backlog, DLQ rate)?
