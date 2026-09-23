# Operational Runbook: Shop & Purchases

## Overview
This runbook covers the operational procedures for managing the Tycoon Shop and Purchases module, including troubleshooting failed transactions, managing coupons, and auditing financial activity.

## Authoritative Write Path
`shop-api` is the single source of truth for money, inventory, and purchase state.
The backend `POST /shop/purchase` endpoint is a **proxy/read model only**: it forwards
the request to `shop-api` and must never mutate balances or inventory itself. Any
backend-side caching (e.g. `shop:inventory:<USER_ID>`) is a derived read model and
must be invalidated from `shop-api` responses, never treated as authoritative.

## Common Issues & Troubleshooting

### 1. Failed Purchases
If a user reports a failed purchase but claims they were charged (or vice versa):
1.  **Check Audit Logs**:
    ```sql
    SELECT * FROM audit_trails 
    WHERE action = 'PURCHASE_CREATED' 
    AND user_id = <USER_ID> 
    ORDER BY created_at DESC;
    ```
2.  **Verify Ledger**: Check the `ledger_reconciliation` module/logs to see if the transaction was recorded in the internal ledger.
3.  **Inventory Check**: Verify if the item exists in the user's inventory:
    ```sql
    SELECT * FROM user_inventories 
    WHERE user_id = <USER_ID> 
    AND shop_item_id = <ITEM_ID>;
    ```

### 2. Invalid Coupon Errors
If coupons are not working as expected:
-   **Expiry**: Check `valid_until` in the `coupons` table.
-   **Usage Limit**: Check if `usage_count` has reached `max_usages`.
-   **Scope**: Ensure the coupon is valid for the specific `shop_item_id`.

### 3. Inventory Out of Sync
If a user cannot see their purchased items:
-   The cache might be stale. Invalidate the shop cache for the user:
    -   Redis Key: `shop:inventory:<USER_ID>`
    -   Action: `DEL shop:inventory:<USER_ID>`

### 4. Duplicate Purchase Reports (Idempotency)
`POST /shop/purchase` accepts an `Idempotency-Key` header and is wrapped with
`IdempotencyInterceptor` (`src/modules/redis/idempotency.interceptor.ts`), matching the
claim → complete → fail lifecycle used by `shop-api`'s `IdempotencyService.claimKey`:
-   **Claim**: on a new key, the request is marked `processing` in Redis (`idempotency:<key>`, 24h TTL) before the handler runs.
-   **Complete**: on success, the response is cached and replayed (with `X-Idempotency-Replayed: true`) for any repeat request using the same key.
-   **Fail**: if the handler throws, the key is deleted so the client can safely retry with the same key.
-   A second request while the first is still `processing` receives `409 Conflict`.
-   Requests without an `Idempotency-Key` header are not deduplicated — each is processed independently.

If a user reports being charged twice for what they believe was one click, check whether
the client sent the same `Idempotency-Key` on both requests; if not, this is expected
behavior and should be treated as two independent purchases (see Section 1).

## Operational Procedures

### Deactivating a Malfunctioning Shop Item
If an item is causing issues (e.g., incorrect pricing), deactivate it immediately:
```sql
UPDATE shop_items SET active = false WHERE id = <ITEM_ID>;
```
This is preferred over deletion to preserve historical purchase records.

### Refunding a Purchase
Currently, refunds are handled manually by:
1.  Removing the item from `user_inventories`.
2.  Crediting the user's balance (if applicable).
3.  Logging the action in `audit_trails` with a reason.

## Canary Reconciliation & Rollback (Proxy)

When rolling out a new `shop-api` purchase path behind the backend proxy, use a
canary and reconcile before promoting. The proxy must fail closed on writes.

### Canary Procedure
1.  Route a small percentage of `POST /shop/purchase` traffic to the canary via the
    proxy flag (e.g. `SHOP_PURCHASE_CANARY_PERCENT`). Reads may stay on stable.
2.  Watch RED metrics for the purchase path: `tycoon_purchases_total` (rate/errors)
    and latency histograms, split by canary vs stable.
3.  Reconcile canary vs stable before widening:
    ```sql
    SELECT idempotency_key, status, created_at
    FROM purchases
    WHERE created_at > now() - interval '1 hour'
    ORDER BY created_at DESC;
    ```
    Confirm no duplicate `idempotency_key` rows and that inventory deltas match
    successful purchases (inventory must never go negative).
4.  Widen the canary only after a clean reconciliation window.

### Rollback Procedure
1.  Set the canary percentage to `0` (or disable the proxy flag) to send all
    purchase writes back to the stable path. This is the primary rollback lever.
2.  Do **not** delete idempotency keys during rollback — replaying a key must still
    return the stored response so clients cannot double-purchase across the switch.
3.  If the canary wrote partial state, reconcile against `shop-api` (source of truth)
    and correct the backend read model by invalidating `shop:inventory:<USER_ID>`.
4.  Record the incident and rollback in `audit_trails` with a reason.

### Fail-Closed Behavior
If `shop-api` (or its Postgres/Redis dependencies) is unavailable, the proxy must
return an error and **not** fall back to a local write. Writes fail closed; reads may
serve stale cached data with a clear degraded indicator.

## Monitoring & Metrics
-   **Metric**: `tycoon_purchases_total` - Track successful vs failed purchases.
-   **Metric**: `tycoon_coupon_usage_total` - Monitor marketing campaign effectiveness.

## Support Contacts
-   Backend Team: #team-backend
-   Finance/Operations: #ops-billing
