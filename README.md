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
