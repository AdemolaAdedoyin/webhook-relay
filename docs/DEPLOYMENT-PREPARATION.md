# Deployment preparation

The supported local workflow remains the default. A separate, tested
production-mode template is now included; nothing has been deployed publicly.

Use [Operations](OPERATIONS.md) for local development, disposable production checks,
configuration, create-only tenant provisioning, migration/upgrade and backup steps.
Use [Final audit](FINAL-AUDIT.md) for validation evidence and remaining launch gates.

Do not expose the default development Compose stack as production. Use
`compose.production.yml` with a protected environment file and a correctly
configured TLS reverse proxy/network boundary. Host-specific production acceptance
still requires TLS, secrets, restore, load, monitoring and infrastructure checks.
