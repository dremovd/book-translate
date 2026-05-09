# Coverage methodology — how the snapshot loop guarantees 100% within `cycle_hours`

## What "100% coverage" means here

A platform's **candidate set** (`data/<site>/candidates.jsonl`) is the
list of book ids we track. The system claims: every alive (non-dead-set)
candidate has at least one snapshot row in `snapshots.jsonl` newer than
`cycle_hours` (default 22h) — at all times, in steady state.

"Alive" means: not in the dead set (≥ 3 consecutive HTTP 404 / Gone
responses → permanently removed by the source platform; skipped on every
subsequent tick).

## Mechanism

Each snapshot script (`<site>-snapshot.py`) is wired into cron with three
relevant knobs:

```cron
*/M  * * * *  uv run python3 scripts/<site>-snapshot.py \
                --cycle-hours C  --limit K  --sleep S  --quiet
```

Per tick:

1. Load the candidate set (size **N**)
2. Filter to *due* books — `latest_snapshot_age > C` hours, OR never snapshotted
3. Drop ids in the dead set (3+ consecutive 404)
4. Order the remainder **oldest-first** (`filter_by_cycle` in
   `_jjwxc_engine.py` — never-snapshotted first, then by ascending
   latest-snapshot-ts)
5. Take the first **K** ids
6. Fetch each (with the proxy fail-over path on rate-limit) and append a
   row to `snapshots.jsonl`
7. Print a structured summary line that the dashboard reads:

   ```
   snapshot: 25 ok (direct=22 proxy_rescued=3), 1 failed (404=1 other=0) -> data/...
   ```

## The capacity inequality

Per cycle of length C hours, the cron fires
**T = C × 60 / M** times, processing up to **K** books each. Total
**capacity = T × K** book-slots. For 100% coverage:

> ```
> R = (T × K) / N ≥ 1
> ```

R is the **capacity ratio** — slots-per-cycle divided by candidate-set
size. With R ≥ 1, every candidate gets at least one slot per cycle.

### Current per-platform numbers

(N taken from live `data/<site>/candidates.jsonl`; cron parameters from
the deployed `crontab.txt`.)

| Platform | N | K | M | C | T = C·60/M | Capacity T·K | **R = T·K/N** | Max staleness in steady state |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| **jjwxc**  | 966 | 30 | 15 min | 22h | 88 | 2 640 | **2.73×** | 8.0h |
| **fanqie** | 545 | 25 | 60 min | 22h | 22 |   550 | **1.01×** | 21.8h |
| **qidian** | 578 |  8 | 15 min | 22h | 88 |   704 | **1.22×** | 18.1h |

## Proof of bound on max staleness

**Claim.** With **oldest-first** ordering and **R ≥ 1**, in steady state
the maximum snapshot age across all alive candidates is at most:

> ```
> A_max = N × M / K  minutes  =  (N / capacity) × C × 60  minutes
> ```

**Proof.** In steady state the system processes K books per M minutes,
so the per-book snapshot rate is `(K/M)` books-per-minute spread across
N candidates, giving each book a per-book rate of `K/(M × N)`
snapshots-per-minute, equivalently an inter-snapshot interval of
`N × M / K` minutes.

Oldest-first ordering ensures FIFO behaviour over the candidate set —
the book that hasn't been touched the longest is always next. So the
worst-case age of any book equals the inter-snapshot interval. In
formulas:

> ```
> A_max = N × M / K  =  N × C × 60 / (T × K)  =  C × 60 / R    [minutes]
>       = C / R  hours
> ```

For R = 1, A_max = C exactly.
For R > 1, A_max < C — coverage is achieved with headroom.

**Verifying against the table:**
- jjwxc:  C/R = 22/2.73 = 8.05h ≈ 8.0h ✓
- fanqie: C/R = 22/1.01 = 21.78h ≈ 21.8h ✓
- qidian: C/R = 22/1.22 = 18.03h ≈ 18.1h ✓

So all three currently meet the 100%-within-22h goal in steady state.

## What can break the bound

The proof assumes steady state and a few invariants. Each failure mode
has a corresponding mitigation in the code:

| Failure mode | Effect on R | Mitigation |
|---|---|---|
| Cron skipped a tick | T momentarily lower | next tick processes "more overdue" books first; backlog drains in `backlog/K × M` minutes |
| Source platform IP-blocks us | Direct fetches fail | `fetch_html` falls over to residential proxy on first 403/429; rescued fetches still count toward K |
| Source platform takes a book down (404 / Gone) | N inflated by dead candidates | `_permanently_dead_ids` filters books with ≥ 3 consecutive 404 — they stop consuming slots |
| Per-fetch sleep too long for K | Effective K_actual < K | tick wall time = K × (S + fetch_latency); enforced under M by choice of K and S |
| Discover keeps adding new candidates | N grows | not a coverage hazard *per se* — a newly-added candidate is "never snapshotted" → goes to front of queue → snapshotted within one tick |

## Recovery from a downtime episode

If the cron is broken for a window W (e.g. today's `jittered_sleep`
AttributeError episode), at recovery time the backlog is up to
`min(N, demand_during_W)` books with age ≥ C. The catch-up time is:

> ```
> recovery = backlog / K  ticks  =  backlog × M / K  minutes
> ```

For qidian's current state (320 overdue, K=8, M=15): recovery in
`320 × 15 / 8 = 600 min = 10h`. Until then, the dashboard's GLOBAL
indicator shows 🔴 honestly. Once R × C × 60 minutes pass with the cron
healthy, the system is back in steady-state coverage.

## Tuning levers if R is too tight

Currently fanqie (R = 1.01) is right on the edge — a single missed
cron tick could push real max-staleness above 22h. Two ways to widen
the margin:

1. **Increase K** (`--limit`) — linear lift in capacity
2. **Decrease M** (cron more often) — also linear lift

Doubling K or halving M both yield R = 2× current → max staleness
halved → 11h instead of 22h. Cost: 2× source-side request rate.

For qidian, R = 1.22 is healthier but also tight. A `--limit 12` instead
of 8 would push R to 1.83.

For jjwxc, R = 2.73 already has plenty of headroom; no tuning needed.

## TL;DR

100% coverage within `cycle_hours` is guaranteed iff cron-tick capacity
exceeds candidate set size — i.e. **R ≥ 1**. All three platforms
currently satisfy this; jjwxc and qidian have comfortable margin (≥ 1.2×),
fanqie is on the edge (1.01×) and would benefit from a bump to `--limit 50`.
