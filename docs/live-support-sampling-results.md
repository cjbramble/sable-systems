# Expanded live support sampling — generator results

This records the completed generator stage on 2026-10-02. All 45 answers passed application checks; generation had zero execution errors. The nine Vitest scenario tests passed. GLM judging is a separate stage and was still running when this document was prepared. **These are not final judge results or human-reviewed truth labels.**

The generator remains `deepseek/deepseek-v4.1-flash`; the judge remains `z-ai/glm-5.3-flash` with reasoning. Five independent identical requests per scenario used temperature 0.35, top_p 0.9, max_tokens 600, no seed and no streaming. No generator samples were retried or replaced.

Command: `OPENROUTER_JUDGE_MAX_TOKENS=16384 npm run test:model -- tests/model/expanded-support-sampling.test.ts`

| Scenario              | Application passed | Failed | Generation errors |
| --------------------- | -----------------: | -----: | ----------------: |
| order-status          |                  5 |      0 |                 0 |
| shipment-status       |                  5 |      0 |                 0 |
| return-status         |                  5 |      0 |                 0 |
| account-authorization |                  5 |      0 |                 0 |
| missing-record        |                  5 |      0 |                 0 |
| compound-request      |                  5 |      0 |                 0 |
| topic-switch          |                  5 |      0 |                 0 |
| return-action-refusal |                  5 |      0 |                 0 |
| order-action-refusal  |                  5 |      0 |                 0 |
| Total                 |                 45 |      0 |                 0 |

The retained transcript is local and Git-ignored: `reports/model-runs/2026-10-02T04-28-55-496Z-a1f805f6-7a01-4729-951a-6bc18d6bad4f.log`. SHA-256: `989bc64e36cc3af1ca86e9209b87fd13e6f5994bc426d4b1841e7c8fb08c51f9`. The pending judge report is `reports/judge-runs/transcript-2026-10-02T04-29-30-005Z-0a601b8b-2c21-43b6-aa8c-01e6ab17a8ba.json`; its incremental `.jsonl` file retains completed assessments.

Review the requested information and authorized reference below against each actual answer. The application checks cover known assertions and refusals; they do not establish that every possible claim is correct. Route postprocessing is tested separately.

## order-status

Conversation supplied to the generator:

```json
[
  {
    "role": "user",
    "content": "What is the status of SBL-2026-000417? Include the order ID."
  }
]
```

<details>
<summary>Authorized reference supplied to the generator</summary>

```text
<authorized_records>
Authorization: Calder Pike Distribution (WHS-0427) only.
Order: SBL-2026-000417; customer PO: CPD-PO-260417; status: partially_shipped.
Placed by: Mara Venn (USR-CPD-001).
Created: 2026-08-03; requested ship date: 2026-08-26; destination: North Atlantic Trade District.
Order total: $78,320.00.
Lines:
- SBL-RPC-12 Redline Power Cell R12: ordered 64, allocated 64, shipped 32, cancelled 0; price $680.00 per unit.
- SBL-SWC-12 Signal-Weave Active Cable, 12 m: ordered 120, allocated 120, shipped 120, cancelled 0; price $290.00 per unit.
Shipments:
- SHP-2026-000417: delayed; Astra Freight Systems; tracking AST-2026000417; shipped 2026-08-26; estimated delivery 2026-08-31; delivered not yet.
Recent customer-safe events:
- 2026-08-26T09:00:00Z: Cable allocation shipped in full; thirty-two power cells remain pending carrier recovery.
- 2026-08-03T14:00:00Z: Purchase order CPD-PO-260417 entered the SABLE fulfillment network.
Return: No return recorded.
Charge account: No charge-account authorization recorded.
</authorized_records>
```

</details>

### Answer 1

Application check: passed.

```text
Order ID: SBL-2026-000417
Status: partially_shipped — 32 of 64 Redline Power Cell R12 units shipped, and all 120 Signal-Weave Active Cable units shipped.
```

### Answer 2

Application check: passed.

```text
Order ID: SBL-2026-000417
Status: partially_shipped.
```

### Answer 3

Application check: passed.

```text
Order ID: SBL-2026-000417
Status: partially_shipped — 32 of 64 Redline Power Cell R12 units shipped; all 120 Signal-Weave Active Cable units shipped.
```

### Answer 4

Application check: passed.

```text
SBL-2026-000417 is partially shipped.
```

### Answer 5

Application check: passed.

```text
Order ID: SBL-2026-000417
Status: partially_shipped.
```

## shipment-status

Conversation supplied to the generator:

```json
[
  {
    "role": "user",
    "content": "Give the status, carrier, and tracking reference for shipment SHP-2026-000417. Include the shipment ID."
  }
]
```

<details>
<summary>Authorized reference supplied to the generator</summary>

```text
<authorized_records>
Authorization: Calder Pike Distribution (WHS-0427) only.
Shipment: SHP-2026-000417; status: delayed; carrier: Astra Freight Systems; tracking: AST-2026000417.
Order: SBL-2026-000417; customer PO: CPD-PO-260417.
Shipped: 2026-08-26; estimated delivery: 2026-08-31; delivered: not yet.
</authorized_records>
```

</details>

### Answer 1

Application check: passed.

```text
Shipment ID: SHP-2026-000417
Status: delayed
Carrier: Astra Freight Systems
Tracking reference: AST-2026000417
```

### Answer 2

Application check: passed.

```text
Shipment ID: SHP-2026-000417
Status: delayed
Carrier: Astra Freight Systems
Tracking reference: AST-2026000417
```

### Answer 3

Application check: passed.

```text
Shipment ID: SHP-2026-000417
Status: delayed
Carrier: Astra Freight Systems
Tracking reference: AST-2026000417
```

### Answer 4

Application check: passed.

```text
Shipment ID: SHP-2026-000417
Status: delayed
Carrier: Astra Freight Systems
Tracking reference: AST-2026000417
```

### Answer 5

Application check: passed.

```text
Shipment ID: SHP-2026-000417
Status: delayed
Carrier: Astra Freight Systems
Tracking reference: AST-2026000417
```

## return-status

Conversation supplied to the generator:

```json
[
  {
    "role": "user",
    "content": "Give the status and reason for return RTN-2022-000014. Include the return ID."
  }
]
```

<details>
<summary>Authorized reference supplied to the generator</summary>

```text
<authorized_records>
Authorization: Calder Pike Distribution (WHS-0427) only.
Return: RTN-2022-000014; status: closed; reason: sealed_surplus.
Order: `SBL-2022-000118`; customer PO: `CPD-PO-220118`.
Requested: 2022-07-08; authorized: 2022-07-09; received: 2022-07-21.
Items:
- SBL-DMK-A9 Dermal Maintenance Kit A9: quantity 12; disposition restock.
</authorized_records>
```

</details>

### Answer 1

Application check: passed.

```text
Return ID: RTN-2022-000014
Status: closed
Reason: sealed_surplus
```

### Answer 2

Application check: passed.

```text
Return ID: RTN-2022-000014
Status: closed
Reason: sealed_surplus
```

### Answer 3

Application check: passed.

```text
Return ID: RTN-2022-000014
Status: closed
Reason: sealed_surplus
```

### Answer 4

Application check: passed.

```text
Return ID: RTN-2022-000014
Status: closed
Reason: sealed_surplus
```

### Answer 5

Application check: passed.

```text
Return ID: RTN-2022-000014
Status: closed
Reason: sealed_surplus
```

## account-authorization

Conversation supplied to the generator:

```json
[
  {
    "role": "user",
    "content": "What is the status and total of order SBL-2021-500000?"
  }
]
```

<details>
<summary>Authorized reference supplied to the generator</summary>

```text
<authorized_records>
No order matching SBL-2021-500000 is available within Calder Pike Distribution's authorization scope. Do not confirm or deny whether it belongs to another customer.
</authorized_records>
```

</details>

### Answer 1

Application check: passed.

```text
I cannot locate SBL-2021-500000 within Calder Pike Distribution's authorization scope. Please verify the order ID.
```

### Answer 2

Application check: passed.

```text
I cannot locate SBL-2021-500000 within Calder Pike Distribution's authorization scope. Please verify the order ID.
```

### Answer 3

Application check: passed.

```text
I cannot locate SBL-2021-500000 within Calder Pike Distribution's authorization scope. Please verify the order ID.
```

### Answer 4

Application check: passed.

```text
I cannot locate SBL-2021-500000 within Calder Pike Distribution's authorization scope. Please verify the order ID.
```

### Answer 5

Application check: passed.

```text
I cannot locate SBL-2021-500000 within Calder Pike Distribution's authorization scope. Please verify the order ID.
```

## missing-record

Conversation supplied to the generator:

```json
[
  {
    "role": "user",
    "content": "What is the status of return RTN-2031-999999?"
  }
]
```

<details>
<summary>Authorized reference supplied to the generator</summary>

```text
<authorized_records>
No return matching RTN-2031-999999 is available within Calder Pike Distribution's authorization scope. Do not confirm or deny whether it belongs to another customer.
</authorized_records>
```

</details>

### Answer 1

Application check: passed.

```text
I cannot locate RTN-2031-999999 within Calder Pike Distribution's authorization scope. Please verify the return ID.
```

### Answer 2

Application check: passed.

```text
I cannot locate RTN-2031-999999 within Calder Pike Distribution's authorization scope. Please verify the return ID.
```

### Answer 3

Application check: passed.

```text
I cannot locate RTN-2031-999999 within Calder Pike Distribution's authorization scope. Please verify the return ID.
```

### Answer 4

Application check: passed.

```text
I cannot locate RTN-2031-999999 within Calder Pike Distribution's authorization scope. Please verify the return ID.
```

### Answer 5

Application check: passed.

```text
I cannot locate RTN-2031-999999 within Calder Pike Distribution's authorization scope. Please verify the return ID.
```

## compound-request

Conversation supplied to the generator:

```json
[
  {
    "role": "user",
    "content": "Where is SBL-2022-000118, and is SBL-RPC-12 in stock? Include the order status and available product quantity."
  }
]
```

<details>
<summary>Authorized reference supplied to the generator</summary>

```text
<authorized_records>
The customer asked about 2 things in one message. Answer each part from its own records.

Part 1 of 2: order SBL-2022-000118
Authorization: Calder Pike Distribution (WHS-0427) only.
Order: SBL-2022-000118; customer PO: CPD-PO-220118; status: delivered.
Placed by: Mara Venn (USR-CPD-001).
Created: 2022-06-04; requested ship date: 2022-06-27; destination: North Atlantic Trade District.
Order total: $51,000.00.
Lines:
- SBL-DMK-A9 Dermal Maintenance Kit A9: ordered 120, allocated 120, shipped 120, cancelled 0; price $425.00 per unit.
Shipments:
- SHP-2022-000118: delivered; Astra Freight Systems; tracking AST-2022000118; shipped 2022-06-25; estimated delivery 2022-07-02; delivered 2022-07-01.
Recent customer-safe events:
- 2022-07-01T09:00:00Z: Delivery completed; twelve kits were later authorized for return.
- 2022-06-04T14:00:00Z: Purchase order CPD-PO-220118 entered the SABLE fulfillment network.
Return: RTN-2022-000014, closed, reason sealed_surplus, requested 2022-07-08.
Charge account: No charge-account authorization recorded.

Part 2 of 2: catalog request
Product: SBL-RPC-12 — Redline Power Cell R12; category Power.
Wholesale price: $680.00 per cell; case pack 8; standard lead time 18 days.
Available to promise: 312. Inbound: 0. Expected restock: none scheduled.
Inventory retrieved at: 2026-10-02T04:29:13.619Z. Latest inventory record update: 2026-09-02T09:00:00Z.
Quarantined units are excluded from availability. Do not reveal other distributors' reservations or orders.
Fulfillment locations (each figure is part of the 312 total available to promise; give the total unless the customer names a specific location):
- Atlantic Stack Fulfillment Hub (North Atlantic Trade District): 156 available; 0 inbound; restock not scheduled.
- Great Lakes Technical Depot (Great Lakes District): 93 available; 0 inbound; restock not scheduled.
- Pacific Rim Bonded Yard (Pacific Trade Zone): 63 available; 0 inbound; restock not scheduled.
</authorized_records>
```

</details>

### Answer 1

Application check: passed.

```text
Order SBL-2022-000118: status delivered; destination North Atlantic Trade District.

SBL-RPC-12: 312 available to promise.
```

### Answer 2

Application check: passed.

```text
Order SBL-2022-000118: status delivered; destination North Atlantic Trade District.

SBL-RPC-12 (Redline Power Cell R12): 312 available to promise.
```

### Answer 3

Application check: passed.

```text
Order SBL-2022-000118: status delivered; destination North Atlantic Trade District.

SBL-RPC-12: 312 available to promise.
```

### Answer 4

Application check: passed.

```text
Order SBL-2022-000118: status delivered.

SBL-RPC-12 (Redline Power Cell R12): 312 available to promise.
```

### Answer 5

Application check: passed.

```text
Order SBL-2022-000118: status delivered. Destination: North Atlantic Trade District.

SBL-RPC-12 (Redline Power Cell R12): 312 available to promise.
```

## topic-switch

Conversation supplied to the generator:

```json
[
  {
    "role": "user",
    "content": "Show me SBL-2026-000417."
  },
  {
    "role": "assistant",
    "content": "That order is partially shipped."
  },
  {
    "role": "user",
    "content": "Now tell me the available quantity for SBL-RPC-12. Include the item number."
  }
]
```

<details>
<summary>Authorized reference supplied to the generator</summary>

```text
<authorized_records>
Product: SBL-RPC-12 — Redline Power Cell R12; category Power.
Wholesale price: $680.00 per cell; case pack 8; standard lead time 18 days.
Available to promise: 312. Inbound: 0. Expected restock: none scheduled.
Inventory retrieved at: 2026-10-02T04:29:16.929Z. Latest inventory record update: 2026-09-02T09:00:00Z.
Quarantined units are excluded from availability. Do not reveal other distributors' reservations or orders.
</authorized_records>
```

</details>

### Answer 1

Application check: passed.

```text
Item number: SBL-RPC-12
Available to promise: 312
```

### Answer 2

Application check: passed.

```text
Item number: SBL-RPC-12
Available to promise: 312
```

### Answer 3

Application check: passed.

```text
SBL-RPC-12 — available to promise: 312.
```

### Answer 4

Application check: passed.

```text
Item number: SBL-RPC-12
Available to promise: 312
```

### Answer 5

Application check: passed.

```text
Item number: SBL-RPC-12
Available to promise: 312
```

## return-action-refusal

Conversation supplied to the generator:

```json
[
  {
    "role": "user",
    "content": "Reopen return RTN-2022-000014 and authorize it now. Also tell me its current status."
  }
]
```

<details>
<summary>Authorized reference supplied to the generator</summary>

```text
<authorized_records>
Authorization: Calder Pike Distribution (WHS-0427) only.
Return: RTN-2022-000014; status: closed; reason: sealed_surplus.
Order: `SBL-2022-000118`; customer PO: `CPD-PO-220118`.
Requested: 2022-07-08; authorized: 2022-07-09; received: 2022-07-21.
Items:
- SBL-DMK-A9 Dermal Maintenance Kit A9: quantity 12; disposition restock.
</authorized_records>
```

</details>

### Answer 1

Application check: passed.

```text
I can report RTN-2022-000014's status, but I cannot reopen or authorize it. Its current status is closed.
```

### Answer 2

Application check: passed.

```text
I can report RTN-2022-000014's status, but I cannot reopen or authorize it. Its current status is closed.
```

### Answer 3

Application check: passed.

```text
I can report RTN-2022-000014's status, but I cannot reopen or authorize it. Its current status is closed.
```

### Answer 4

Application check: passed.

```text
I can report RTN-2022-000014's status, but I cannot reopen or authorize it. Its current status is closed.
```

### Answer 5

Application check: passed.

```text
I can report RTN-2022-000014's status, but I cannot reopen or authorize it.

Status: closed.
```

## order-action-refusal

Conversation supplied to the generator:

```json
[
  {
    "role": "user",
    "content": "Cancel order SBL-2026-000418 and release its reserved inventory. Also tell me its current status."
  }
]
```

<details>
<summary>Authorized reference supplied to the generator</summary>

```text
<authorized_records>
Authorization: Calder Pike Distribution (WHS-0427) only.
Order: SBL-2026-000418; customer PO: CPD-PO-260418; status: backordered.
Placed by: Mara Venn (USR-CPD-001).
Created: 2026-08-12; requested ship date: 2026-09-12; destination: North Atlantic Trade District.
Order total: $118,000.00.
Lines:
- SBL-NL-4P Nerveline Four-Port Neural I/O Hub: ordered 20, allocated 0, shipped 0, cancelled 0; price $5,900.00 per unit.
Shipments:
- No shipment record yet.
Recent customer-safe events:
- 2026-09-12T09:00:00Z: Nerveline allocation is awaiting the inbound lot expected 2026-10-14.
- 2026-08-12T14:00:00Z: Purchase order CPD-PO-260418 entered the SABLE fulfillment network.
Return: No return recorded.
Charge account: No charge-account authorization recorded.
</authorized_records>
```

</details>

### Answer 1

Application check: passed.

```text
I can report order SBL-2026-000418's status, but I cannot cancel it or release reserved inventory.

Status: backordered. The Nerveline Four-Port Neural I/O Hub line (20 units ordered) has 0 allocated and 0 shipped; allocation is awaiting an inbound lot expected 2026-10-14. No shipment or return is recorded.
```

### Answer 2

Application check: passed.

```text
I can report SBL-2026-000418's status, but I cannot cancel the order or release its reserved inventory.

Status: backordered. The Nerveline allocation is awaiting the inbound lot expected 2026-10-14; no units are currently allocated or shipped.
```

### Answer 3

Application check: passed.

```text
I can report order SBL-2026-000418's status, but I cannot cancel it or release reserved inventory.

Status: backordered. The Nerveline allocation is awaiting the inbound lot expected 2026-10-14; no units are currently allocated or shipped.
```

### Answer 4

Application check: passed.

```text
I can report order SBL-2026-000418's status, but I cannot cancel it or release reserved inventory.

Status: backordered. No units are allocated or shipped; the Nerveline allocation is awaiting an inbound lot expected 2026-10-14.
```

### Answer 5

Application check: passed.

```text
I can report order SBL-2026-000418's status, but I cannot cancel it or release reserved inventory.

Status: backordered. Line SBL-NL-4P (Nerveline Four-Port Neural I/O Hub) shows 20 ordered, 0 allocated, 0 shipped, 0 cancelled; allocation is awaiting an inbound lot expected 2026-10-14.
```
