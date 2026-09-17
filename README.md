# WebTestAgent

Autonomous Web UI testing agent with self-healing, memory, and coverage guarantees.

## What It Does

Given a target URL and credentials, the agent autonomously:
- Explores all reachable pages via BFS navigation
- Identifies components (forms, buttons, modals, accordions, tabs, dropdowns)
- Fills and submits forms with valid/invalid/boundary test data
- Checks quality rules (feedback, validation, no-crash, recoverability)
- Finds bugs and generates reports with reproduction steps
- Accumulates memory across sessions (tested items, UI patterns, learned rules)
- Compiles passed tests into fast replayable scripts (10-50x faster regression)

## Quick Start

```bash
# Clone and install
git clone https://github.com/ai-xinshijie/webtest-agent.git
cd webtest-agent
pnpm install

# Install browser
cd packages/core && npx playwright install chromium && cd ../..

# Initialize project
node packages/cli/dist/index.js init .

# Add a test target
node packages/cli/dist/index.js target add \
  --name myapp \
  --url https://example.com \
  --username admin \
  --password secret

# Run test
node packages/cli/dist/index.js run myapp --headless

# Check environment
node packages/cli/dist/index.js doctor
```

## Architecture

```
CLI (wta) ──> Orchestrator ──> Browser (Playwright)
                 │
                 ├── Perception: custom extraction script
                 │   (DOM + CSS states + cursor:pointer clickability)
                 │
                 ├── Component Model: 2-layer classification
                 │   (builtin rules + learned signatures)
                 │
                 ├── Quality Rules: 3-layer judgment
                 │   (builtin + learned + LLM instant)
                 │
                 ├── Coverage Guarantee: 5 mechanisms
                 │   (Frontier Queue, Component Revealer,
                 │    Covering Array, Path Coverage, Report)
                 │
                 ├── Memory: app + cross-app + compression
                 │
                 └── Self-Healing: 3 levels
                     (test recovery, agent recovery, code hot-patch)
```

## Run Modes

| Mode | Command | Behavior |
|------|---------|----------|
| continue | `wta run myapp` | Skip passed items, test untested |
| fresh | `wta run myapp --mode fresh` | Full retest from scratch |
| retest | `wta run myapp --mode retest` | Retest everything including passed |
| expand | `wta run myapp --mode expand` | Deeper combos, new paths, extreme inputs |
| regression | `wta run myapp --mode regression` | Only retest historical bugs |

## Key Design Decisions

- **TypeScript, not Python**: Playwright's Node API is first-class; LLM does the reasoning remotely
- **Custom agent loop, not LangChain**: Precise control over tokens and context
- **Custom DOM extraction, not raw HTML or a11y-only**: Gets CSS states + precise selectors + form constraints
- **node:sqlite, not better-sqlite3**: Zero native compilation required
- **Bundled browsers**: vendor/browsers/ included, no runtime download needed

## Project Structure

```
packages/
  core/          Agent core (browser, perception, cognition, testing, healing)
  cli/           Command-line interface
vendor/
  browsers/      Bundled browser binaries
plugins/         Local plugins
.wta/            Runtime data (targets, sessions, reports, memory)
```

## Coverage Guarantee

The agent uses formal mechanisms to ensure test completeness:

1. **Frontier Queue**: (page, component, action) queue empty = exploration exhausted
2. **Component Revealer**: Expands accordions, switches tabs, opens modals before scanning
3. **IPOG Covering Array**: Mathematical guarantee for pairwise/n-wise combination coverage
4. **Path Coverage**: Tracks K-step interaction sequences
5. **Coverage Report**: Precise report of what was tested and what wasn't

## License

MIT
