# SABLE Systems Distribution Portal

SABLE Systems is a wholesale supplier and manufacturer serving authorized distributors. Its portal combines
a public-facing brand gateway, an inventory-aware procurement catalog, charge-account checkout, and the
private COV-E customer-support console. COV-E uses the local Qwen3 4B model through `llama-server`
and grounds account-specific answers in a project-local D1/SQLite database.

Primary routes:

- `/` — SABLE marketing and brand identity
- `/shop` — live wholesale inventory, case-pack cart, and charge-account checkout
- `/orders` — authenticated, distributor-scoped order history with search and status filters
- `/support` — private COV-E support with durable per-user incident history

Checkout creates durable orders, order lines, customer-safe events, and account-ledger records.
Physical inventory is reserved atomically and can be exhausted; the server rejects over-allocation,
non-case-pack quantities, duplicate PO references, and requested ship dates in the past.

The seed is deterministic and contains:

- 720 orders from 2021 through 2031
- 648 Calder Pike orders and 72 isolation records split across three other distributors
- one active purchasing user for each distributor, with every order tied to its placing user
- 18 catalog records, including one retired product and one fully quarantined product
- inventory balances, order lines, events, shipments, and returns
- three starter support incidents per user, with later conversations stored in D1

COV-E uses a typed, read-only query router for tenant-scoped order searches,
shipments, returns, charge-account records, support incidents, and catalog or
inventory questions. Other-distributor records are never included in its
authorized context, and the model never receives a database handle or raw SQL
capability.

## Local access

The procurement catalog, ordering API, and COV-E console require a distributor
session. Seed credentials are stored as PBKDF2 hashes; the local access phrases
for the four fictional users are:

| Distributor | Email | Access phrase |
| --- | --- | --- |
| Calder Pike Distribution | `mara.venn@calderpike.example` | `Sable-WHS-0427!` |
| Meridian Civic Supply | `imani.kade@meridiancivic.example` | `Sable-WHS-1098!` |
| Northline Prosthetics Cooperative | `rowan.sato@northline.example` | `Sable-WHS-2714!` |
| Halcyon Industrial Exchange | `lena.orr@halcyonexchange.example` | `Sable-WHS-5830!` |

Sessions use random opaque credentials in an HttpOnly, SameSite cookie and
expire after twelve hours. Signing out revokes the server-side session.

## Run it

```bash
npm run dev
```

Open [http://127.0.0.1:8016](http://127.0.0.1:8016). The command starts the model on port 8017,
waits until it is ready, and then starts the web app. Press Control-C once to stop both processes.

The default model is stored locally in this repository working tree at:

```text
models/customer-support/Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf
```

GGUF model weights are intentionally ignored by Git because of their size. See
`models/customer-support/README.md` for the expected local asset. The launcher
still accepts an explicit model path when needed.

To use a different GGUF or `llama-server` binary:

```bash
CUSTOMER_SUPPORT_MODEL_PATH=/absolute/path/to/model.gguf LLAMA_SERVER=/absolute/path/to/llama-server npm run dev
```

Validate the deterministic data contract with:

```bash
npm run validate:data
```

Run the deterministic local quality gate with:

```bash
npm run check
```

Browser workflows run separately with `npm run test:e2e`; real Qwen evaluations
use `npm run test:model`. See [test organization and setup](tests/README.md) for
the browser installation step, page objects, and isolated test database.

Schema upgrades and fixture changes have separate version markers. Increment
`SCHEMA_VERSION` for migration-backed structure changes; increment
`SEED_VERSION` only when an intentional deterministic fixture rebuild is
required. This keeps orders placed through the application intact during
ordinary schema upgrades.

Model logs are written to `reports/server-logs/llama-server.log`. Local D1 state and generated
runtime files remain under the ignored `.wrangler` directory.
