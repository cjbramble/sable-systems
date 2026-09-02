# COV-E local model

The customer-support app expects this local model file by default:

```text
Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf
```

Model weights live in this directory in the working tree but are intentionally
excluded from Git. `npm run dev` starts the model with `llama-server` on port
8017 before starting the web application on port 8016.

Expected SHA-256:

```text
2fde00ce69dd4899c70d020845e2638353015bba0fdf161b3eb965f2bca4464e
```

Set `CUSTOMER_SUPPORT_MODEL_PATH` to use a different GGUF without replacing the
default local file.
