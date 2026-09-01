# Conversion Engine

A product-agnostic agent that takes a lead and pushes it to a named goal — onboarded,
reactivated, paid — replanning after every signal, and stopping only on success, budget
exhaustion, or withdrawn consent.

**Claude writes the plan. A deterministic engine executes it. Claude replans when reality
disagrees.**

Architecture: https://claude.ai/code/artifact/e8bf5d0c-22fe-49d0-8dd9-63c6deed8273

## Status

Foundation only. Schemas and collections are in place; adapters, engine and MCP server are next.

```
src/schemas   zod schemas — the contract for every document
src/db        mongo client, collection names, index definitions
```

## Two rules that are not negotiable

1. **Claude never sees a credential.** MCP tools return a connection id, provider name,
   status and capabilities. Secrets are resolved by the engine at send time.
2. **Guardrails live in code.** Budgets, frequency caps, consent and quiet hours are
   enforced by the engine. A model must not be able to argue past a cap.

## Setup

```bash
cp .env.example .env      # fill MONGODB_URI and MASTER_KEY_B64
npm install
npm run db:indexes
```

`MASTER_KEY_B64` in an environment variable is a launch compromise. Move to a managed KMS
before a second tenant's credentials are stored.

## The clock

The engine needs something to hit `/api/cron/tick` roughly every minute: it fetches due
sources, sends what is due, and reconciles delivery. Vercel's Hobby plan allows only one
cron run per day, so `vercel.json` keeps a daily entry as a fallback and the real clock
lives outside.

**cron-job.org (recommended)** — free, one-minute granularity.

```
URL      https://your-app.vercel.app/api/cron/tick
Every    1 minute
Header   Authorization: Bearer <CRON_SECRET>
```

**GitHub Actions** — five-minute floor, and it drifts under load. Pushing this file needs
a token with the `workflow` scope.

```yaml
# .github/workflows/tick.yml
name: Engine tick
on:
  schedule:
    - cron: "*/5 * * * *"
  workflow_dispatch:
jobs:
  tick:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl --fail --silent --show-error --max-time 60 \
            -H "authorization: Bearer ${{ secrets.CRON_SECRET }}" \
            "${{ secrets.APP_URL }}/api/cron/tick"
```

**Local, for testing** — works while your machine is on.

```bash
TICK_URL=https://your-app.vercel.app/api/cron/tick npm run scheduler
```

## Two clocks, two jobs

The engine clock above is deterministic and needs no model. Separately, an hourly Claude
routine calls the MCP server at `/api/mcp` to classify people, write their pipelines and
compose the next touches. Setup steps are on each product's **Connect Claude** page.
