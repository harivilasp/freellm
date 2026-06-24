# Contributing

Contributions are welcome, especially:

- adapters for providers that are not OpenAI-compatible;
- provider catalog and model updates;
- encrypted credential storage;
- router-key rotation and revocation;
- tests for routing and management flows;
- accessibility and dashboard improvements.

## Local setup

```bash
npm install
npm run typecheck
npm test
npm run cli -- init
npm run cli -- start
```

Open `http://localhost:8787`.

## Pull requests

1. Keep credentials, `.env` files, and `.freellm/` out of commits.
2. Add tests for behavior changes.
3. Run `npm run typecheck`, `npm test`, and `npm run build`.
4. Explain any provider-specific API differences or terms in the PR.

Provider entries should have a stable id, an OpenAI-compatible base URL, a
currently available model, a key-creation URL, and a source for free-tier
limits.
