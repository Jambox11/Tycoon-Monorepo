# ADR-002: Games Realtime Transport

- Status: Accepted
- Date: 2024-01-01
- Deciders: Platform, Games
- Related: ADR-004 (auth), `GAMES_MATCHMAKING_RUNBOOK.md`

## Context

The games surface is currently REST-only. Clients poll for match state, which
adds latency, wastes bandwidth, and makes turn-based play feel sluggish. We need
a realtime transport that:

- authenticates players using the same JWT issued by the auth service (ADR-004),
- keeps turn state authoritative on the server so clients cannot spoof dice or
turns,
- fans out events across multiple gateway instances for horizontal scale,
- survives reconnects without replaying or duplicating actions.

## Decision

We will expose a WebSocket gateway on the `/games` namespace using Socket.IO.
The gateway is the single realtime entry point for matchmaking, turns, and dice.

### 1. Namespace and handshake

- Namespace: `/games`.
- JWT is read from the `access_token` cookie first, then from the
  `Authorization: Bearer <token>` header, then from the `auth.token` handshake
  field. This mirrors ADR-004 so browser and native clients share one path.
- The token is verified during the handshake. Missing, malformed, or expired
  tokens are rejected before the socket is accepted; the client receives an
  `unauthorized` error and the socket is closed.
- The verified principal (`sub`, `seat`, `gameId` when present) is attached to
  `socket.data` and is the only source of identity for later events.

### 2. Rooms and seat authorization

- Each game uses a room keyed by `gameId`.
- `join` accepts `{ gameId, seat }`. The gateway verifies that the authenticated
  principal is allowed to occupy that seat for that game before adding the
  socket to the room.
- `join` is idempotent: a duplicate join for the same `gameId`/`seat` is a no-op
  and returns the current room state instead of erroring or double-adding.
- Turn and roll events are only accepted from the socket that currently holds
  the active seat. Off-turn actions are rejected with a `forbidden` error and
  are not broadcast.

### 3. Server-authoritative dice

- Clients never send dice outcomes. Any `roll` payload containing a result,
  value, or seed field is rejected.
- The server generates the dice result, records it against the game, and
  broadcasts the authoritative result to the room.
- This keeps the server as the single source of truth and prevents turn and
  dice spoofing.

### 4. Redis adapter, rate limiting, schema version

- The gateway uses the Socket.IO Redis adapter so events fan out across all
  gateway instances. A Redis partition degrades to per-instance delivery; the
  gateway logs the failure and clients fall back to REST polling until the
  adapter reconnects.
- `roll` events are rate limited per socket and per game to bound abuse.
- Every payload includes a `schemaVersion` field so clients can negotiate
  compatible event shapes as the protocol evolves.

### 5. Reconnect and idempotency

- Reconnect reuses the existing JWT; if the token expired mid-game the client
  must refresh and re-handshake.
- Action idempotency keys are coordinated with the REST write path so a
  reconnect replay does not double-apply a turn or roll.
- On reconnect the client rejoins its room and receives the current state
  rather than a replay of missed events.

## Consequences

- Realtime play no longer requires polling.
- Turn and dice integrity is enforced server-side.
- Multi-instance deployments scale through the Redis adapter.
- Clients must handle handshake rejection, off-turn errors, and reconnect.

## Out of scope

- Unrelated package refactors.
- Mainnet irreversible deploys without a readiness issue.
