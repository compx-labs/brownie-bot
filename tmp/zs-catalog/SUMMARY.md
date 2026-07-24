# ZeroSignal catalog snapshot

Fetched via local `zs-proxy` + each operator `/v1/zs/details` at **2026-07-24T13:06:11Z**.

Live data changes. Re-dump with the script/commands noted at the bottom.

## Key finding: tool limits are per-node, not per-model

The website badge is basically `tool_use: true|false` on each model.
The important loop caps live on the **operator node** details document:

| Field | Meaning |
| --- | --- |
| `max_tool_iterations` | Max tool-loop turns the node will run for one request (built-in / agent loop) |
| `tool_headroom_per_iteration` | Extra token budget reserved per tool iteration |
| `tool_use` (per model) | Whether that model advertises function/tool calling |

Vendor server-side tool caps (`call_cap` / Responses `max_tool_calls`) are operator config and are **not** always exposed in the public catalog.

## Operators / nodes

| Op | Node | Reachable | max_tool_iterations | tool_headroom | Models | Base URL |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | True | 20 | 4000 | 8 | `https://zai.haynode.dev.haystack.fun` |
| 1 | 2 | True | 20 | 4000 | 3 | `https://kimi.haynode.dev.haystack.fun` |
| 1 | 3 | True | 20 | 4000 | 2 | `https://grok.haynode.dev.haystack.fun` |
| 2 | 1 | True | 5 | 4000 | 1 | `https://ashford.belt.algo.xyz` |
| 2 | 2 | True | 5 | 4000 | 2 | `https://espinoza.belt.algo.xyz` |
| 2 | 3 | True | 5 | 4000 | 21 | `https://nauvoo.belt.algo.xyz` |
| 2 | 4 | True | None | None | 1 | `https://prax.belt.algo.xyz` |
| 3 | 1 | True | 20 | 4000 | 1 | `https://zerosignal.haystacknode.win` |

### Builtin tools (union / per node)

- op1/node1: zs_get_time, zs_image_edit, zs_image_generation, zs_web_read, zs_web_search
- op1/node2: zs_get_time, zs_image_edit, zs_image_generation, zs_web_read, zs_web_search
- op1/node3: zs_get_time, zs_image_edit, zs_image_generation, zs_web_read, zs_web_search
- op2/node1: zs_get_time, zs_web_read, zs_web_search
- op2/node2: zs_get_time, zs_image_generation, zs_web_read, zs_web_search
- op2/node3: zs_get_time, zs_web_read, zs_web_search
- op2/node4: (none)
- op3/node1: zs_get_time, zs_web_read, zs_web_search

## Models (proxy catalog ids)

Proxy `/v1/models` currently lists **37** ids:

- `AEON-7/Gemma-4-26B-A4B-it-Uncensored-NVFP4` — nodes=1; max_tool_iterations=[5]; context=[262144]
- `MiniMaxAI/Minimax-M3` — nodes=1; max_tool_iterations=[5]; context=[524288]
- `Qwen/Qwen3-4B-Instruct-2507` — nodes=1; max_tool_iterations=[20]; context=[4096]
- `XiaomiMiMo/MiMo-V2.5` — nodes=1; max_tool_iterations=[5]; context=[1000000]
- `XiaomiMiMo/MiMo-V2.5-Pro` — nodes=1; max_tool_iterations=[5]; context=[1024000]
- `anthropic/claude-fable-5` — nodes=1; max_tool_iterations=[5]; context=[1000000]
- `anthropic/claude-opus-4.7` — nodes=1; max_tool_iterations=[5]; context=[1000000]
- `anthropic/claude-opus-4.8` — nodes=1; max_tool_iterations=[5]; context=[1000000]
- `anthropic/claude-sonnet-4.6` — nodes=1; max_tool_iterations=[5]; context=[1000000]
- `anthropic/claude-sonnet-5` — nodes=1; max_tool_iterations=[5]; context=[1000000]
- `deepseek-ai/DeepSeek-V4-Flash` — nodes=1; max_tool_iterations=[5]; context=[1024000]
- `deepseek-ai/DeepSeek-V4-Pro` — nodes=1; max_tool_iterations=[5]; context=[1048576]
- `flux-edit` — nodes=2; max_tool_iterations=[20]; context=n/a
- `glm-4.5-flash` — nodes=1; max_tool_iterations=[20]; context=[128000]
- `glm-4.7` — nodes=1; max_tool_iterations=[20]; context=[200000]
- `glm-4.7-flash` — nodes=1; max_tool_iterations=[20]; context=[200000]
- `glm-5` — nodes=1; max_tool_iterations=[20]; context=[200000]
- `glm-5-turbo` — nodes=1; max_tool_iterations=[20]; context=[200000]
- `glm-5.2` — nodes=1; max_tool_iterations=[20]; context=[1000000]
- `google/gemini-2.5-flash` — nodes=1; max_tool_iterations=[5]; context=[1048576]
- `google/gemini-2.5-flash-lite` — nodes=1; max_tool_iterations=[5]; context=[1048576]
- `google/gemini-3-flash-preview` — nodes=1; max_tool_iterations=[5]; context=[1048576]
- `google/gemini-3.1-flash-lite` — nodes=1; max_tool_iterations=[5]; context=[1048576]
- `grok-4.5` — nodes=1; max_tool_iterations=[20]; context=[200000]
- `grok-imagine-image-quality` — nodes=1; max_tool_iterations=[20]; context=[8000]
- `ig1/medgemma-27b-it-FP8-Dynamic` — nodes=1; max_tool_iterations=n/a; context=[131072]
- `kimi-k3` — nodes=1; max_tool_iterations=[20]; context=[1048576]
- `moonshotai/kimi-k3` — nodes=1; max_tool_iterations=[5]; context=[1048576]
- `openai/gpt-5.5` — nodes=1; max_tool_iterations=[5]; context=[1050000]
- `openai/gpt-5.6-sol` — nodes=1; max_tool_iterations=[5]; context=[1050000]
- `openai/gpt-oss-120b` — nodes=1; max_tool_iterations=[5]; context=[131072]
- `poolside/Laguna-S-2.1-NVFP4` — nodes=1; max_tool_iterations=[5]; context=[262144]
- `stepfun-ai/Step-3.7-Flash` — nodes=1; max_tool_iterations=[5]; context=[256000]
- `tencent/Hy3` — nodes=1; max_tool_iterations=[5]; context=[262144]
- `z-image-turbo-20-NSFW-adult` — nodes=1; max_tool_iterations=[5]; context=n/a
- `zai-org/GLM-5.2` — nodes=1; max_tool_iterations=[5]; context=[1024000]
- `zimage` — nodes=2; max_tool_iterations=[20]; context=n/a

## Models with `tool_use` from live `/v1/zs/details`

These use the operator's advertised model id (often HuggingFace-style). Proxy may also expose short aliases.

| Model | tool_use | Serving nodes | Node max_tool_iterations | Context windows |
| --- | --- | --- | --- | --- |
| `AEON-7/Gemma-4-26B-A4B-it-Uncensored-NVFP4` | yes | 1 | [5] | [262144] |
| `MiniMaxAI/Minimax-M3` | yes | 1 | [5] | [524288] |
| `Qwen/Qwen3-4B-Instruct-2507` | no | 1 | [20] | [4096] |
| `XiaomiMiMo/MiMo-V2.5` | yes | 1 | [5] | [1000000] |
| `XiaomiMiMo/MiMo-V2.5-Pro` | yes | 1 | [5] | [1024000] |
| `anthropic/claude-fable-5` | yes | 1 | [5] | [1000000] |
| `anthropic/claude-opus-4.7` | yes | 1 | [5] | [1000000] |
| `anthropic/claude-opus-4.8` | yes | 1 | [5] | [1000000] |
| `anthropic/claude-sonnet-4.6` | yes | 1 | [5] | [1000000] |
| `anthropic/claude-sonnet-5` | yes | 1 | [5] | [1000000] |
| `deepseek-ai/DeepSeek-V4-Flash` | yes | 1 | [5] | [1024000] |
| `deepseek-ai/DeepSeek-V4-Pro` | yes | 1 | [5] | [1048576] |
| `flux-edit` | no | 2 | [20] | — |
| `glm-4.5-flash` | yes | 1 | [20] | [128000] |
| `glm-4.7` | yes | 1 | [20] | [200000] |
| `glm-4.7-flash` | yes | 1 | [20] | [200000] |
| `glm-5` | yes | 1 | [20] | [200000] |
| `glm-5-turbo` | yes | 1 | [20] | [200000] |
| `glm-5.2` | yes | 1 | [20] | [1000000] |
| `google/gemini-2.5-flash` | yes | 1 | [5] | [1048576] |
| `google/gemini-2.5-flash-lite` | yes | 1 | [5] | [1048576] |
| `google/gemini-3-flash-preview` | yes | 1 | [5] | [1048576] |
| `google/gemini-3.1-flash-lite` | yes | 1 | [5] | [1048576] |
| `grok-4.5` | yes | 1 | [20] | [200000] |
| `grok-imagine-image-quality` | no | 1 | [20] | [8000] |
| `ig1/medgemma-27b-it-FP8-Dynamic` | no | 1 | — | [131072] |
| `kimi-k3` | yes | 1 | [20] | [1048576] |
| `moonshotai/kimi-k3` | yes | 1 | [5] | [1048576] |
| `openai/gpt-5.5` | yes | 1 | [5] | [1050000] |
| `openai/gpt-5.6-sol` | yes | 1 | [5] | [1050000] |
| `openai/gpt-oss-120b` | yes | 1 | [5] | [131072] |
| `poolside/Laguna-S-2.1-NVFP4` | yes | 1 | [5] | [262144] |
| `stepfun-ai/Step-3.7-Flash` | yes | 1 | [5] | [256000] |
| `tencent/Hy3` | yes | 1 | [5] | [262144] |
| `z-image-turbo-20-NSFW-adult` | no | 1 | [5] | — |
| `zai-org/GLM-5.2` | yes | 1 | [5] | [1024000] |
| `zimage` | no | 2 | [20] | — |

## Brownie-relevant notes

- Brownie default `AI_MAX_TOOL_CALLS` is **16** (host-side MCP loop).
- Operator `max_tool_iterations` is a **separate** node-side loop cap for built-in/vendor tools inside one completion.
- Your `.env` uses `OPENAI_MODEL=glm-5` (proxy short id). Check which operators serve it above.

### `glm-5` / `glm-5.2` operators

- `glm` via op1/node1 `https://zai.haynode.dev.haystack.fun` max_tool_iterations=20 ctx=200000 in=1.1 out=3.52
- `glm` via op1/node1 `https://zai.haynode.dev.haystack.fun` max_tool_iterations=20 ctx=1000000 in=1.54 out=4.84

## Files in this snapshot

- `models.json` — `GET /v1/models` via zs-proxy
- `operators.json` — `GET /v1/zs/operators` via zs-proxy
- `details.json` — `GET /v1/zs/details` aggregate via zs-proxy
- `model-details/` — `GET /v1/models/{id}` per model
- `operator-details/` — each operator's live `/v1/zs/details`
- `catalog-summary.json` — machine-readable rollup

## Refresh

Start zs-proxy (Docker brownie entrypoint or host binary), then:

```bash
curl -s http://127.0.0.1:8080/v1/models > tmp/zs-catalog/models.json
curl -s http://127.0.0.1:8080/v1/zs/operators > tmp/zs-catalog/operators.json
curl -s http://127.0.0.1:8080/v1/zs/details > tmp/zs-catalog/details.json
```
