# Support

This is a local-first dashboard, not a hosted service. No support address, service-level agreement, response-time promise, or live Azure verification is provided.

Use [getting started](docs/getting-started.md), then run `npm run check`, `npm run lint`, and `npm test`. Check Docker Desktop/Linux-container availability when using containers. `/healthz` reports HTTP availability only; it does not prove Azure connectivity or permissions.

Azure CLI login must occur where the backend runs. The container has a separate CLI cache from the host. Project discovery, Foundry access, and Application Insights queries require their respective permissions; listing a project does not guarantee access to its agents or telemetry. Organization sign-in restrictions require an approved login method, not a local admin account.

If an owner-hosted issue tracker becomes available, use the bug template with versions, reproduction steps, and sanitized errors. Do not upload raw traces or configuration/credential volumes. See [privacy](docs/privacy.md); suspected vulnerabilities follow [SECURITY.md](SECURITY.md).

Public distribution is blocked until the owner chooses licensing terms. No registry or public release destination has been selected.
