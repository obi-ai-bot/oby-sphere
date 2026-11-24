# Decisions

## 2026-10-02: integer minor units for money

Floats lost cents in the v1 settle-up for three-way splits. Every amount is now an integer number of minor units with its currency. Decided by the spec team; the apps changed in v1.9.

## 2026-10-19: rate of the day for foreign expenses

An expense in another currency keeps the exchange rate of the day it was added, stored with the expense, so balances don't move when rates do. Rejected: converting at settle-up time (balances drifting daily confused testers).

## 2026-11-04: receipts storage, still open

Images of receipts need object storage and a retention rule. Two options on the table: the cloud provider's bucket with 18 months' retention, or no storage at all (the app keeps the photo, the API only a hash). Waiting on the planning team's privacy review, due before v2.1.
