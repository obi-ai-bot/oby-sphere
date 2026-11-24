# Kite API, v2 (draft)

Kite splits shared expenses inside a group: trips, flats, teams. This is the spec team's working draft of the v2 API.

## Principles

- Money is an integer number of minor units (cents) plus an ISO 4217 currency code. Never floats.
- Every write takes an `Idempotency-Key` header; a repeat with the same key returns the first result.
- Times are RFC 3339 in UTC.

## Resources

### Groups

- `POST /v2/groups` creates a group: `{ name, currency }`. The creator becomes its first member and its admin.
- `GET /v2/groups/{id}` returns the group, its members and each member's balance.
- `POST /v2/groups/{id}/invites` returns a single-use invite link that expires after 7 days.

### Expenses

- `POST /v2/groups/{id}/expenses` adds an expense: `{ paidBy, amount, currency, split, note }`.
  - `split` is one of `equal`, `shares` (integer weights per member) or `exact` (amounts per member that must add up to `amount`).
  - An expense in another currency than the group's is converted at the rate of the day it was added, and that rate is stored with it.
- `DELETE /v2/groups/{id}/expenses/{expenseId}` soft-deletes; balances are recomputed.

### Settling up

- `GET /v2/groups/{id}/settle` returns the smallest set of transfers that settles every balance (a greedy match of the largest debtor with the largest creditor, repeated).
- `POST /v2/groups/{id}/settlements` records a transfer someone made outside Kite.

## Auth

OAuth 2.1 with PKCE for the apps; personal access tokens for scripts, scoped per group, revocable. No API keys in query strings.

## Not in v2

- Recurring expenses (v2.1).
- Receipts as images (needs the storage decision, see DECISIONS.md).
