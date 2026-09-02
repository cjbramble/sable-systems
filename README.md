# SABLE Systems Distribution Portal

SABLE Systems is a wholesale supplier and manufacturer serving authorized distributors. Its portal combines
a public-facing brand gateway, an inventory-aware procurement catalog, charge-account checkout, and the
private COV-E customer-support console. COV-E uses the local Qwen3 4B model through `llama-server`
and grounds account-specific answers in a project-local D1/SQLite database.

Primary routes:

- `/` — SABLE marketing and brand identity
- `/shop` — live wholesale inventory, case-pack cart, and charge-account checkout
- `/support` — private COV-E support for authorized orders and inventory

Checkout creates durable orders, order lines, customer-safe events, and account-ledger records.
Physical inventory is reserved atomically and can be exhausted; the server rejects over-allocation,
non-case-pack quantities, duplicate PO references, and requested ship dates in the past.

The seed is deterministic and contains:

- 720 orders from 2021 through 2031
- 648 Calder Pike orders and 72 isolation records split across three other distributors
- one active purchasing user for each distributor, with every order tied to its placing user
- 18 catalog records, including one retired product and one fully quarantined product
- inventory balances, order lines, events, shipments, and returns

Other-distributor records are never included in COV-E's authorized context.

## Run it

```bash
npm run dev
```

Open [http://127.0.0.1:8016](http://127.0.0.1:8016). The command starts the model on port 8017,
waits until it is ready, and then starts the web app. Press Control-C once to stop both processes.

The default model is:

```text
/Users/chet/dev-projects/chatbot-testing/models/customer-support/Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf
```

To use a different GGUF or `llama-server` binary:

```bash
CUSTOMER_SUPPORT_MODEL_PATH=/absolute/path/to/model.gguf LLAMA_SERVER=/absolute/path/to/llama-server npm run dev
```

Validate the deterministic data contract with:

```bash
npm run validate:data
```

Model logs are written to `reports/server-logs/llama-server.log`. Local D1 state and generated
runtime files remain under the ignored `.wrangler` directory.
