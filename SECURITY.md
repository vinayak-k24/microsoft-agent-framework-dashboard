# Security policy

## Intended boundary
Trusted local use only. Anyone who reaches the backend can use its Azure identity and change shared settings. Azure sign-in authorizes cloud access, not dashboard access. There is no local administrator login, hosted authentication, or per-user isolation. Keep the host endpoint bound/published to loopback; a container listens internally on all interfaces and relies on loopback port publishing.

Protect `data/config.json`, container data volumes, and Azure CLI's credential cache. Do not mount or share credentials with untrusted users. Origin/Host checks are defense in depth, not a multi-user security boundary. Avoid processing untrusted imports without reviewing their provenance and contents.

## Reporting
No private reporting address or guaranteed response time has been established. If a repository owner enables GitHub private vulnerability reporting, use its **Security → Report a vulnerability** channel. Otherwise arrange a private channel with the owner before sharing sensitive details. Do not post exploit details, secrets, private telemetry, or credential files in public issues.

Include affected version, minimal synthetic reproduction, impact, and sanitized logs through the agreed private channel. If credentials were exposed, stop sharing the affected data and revoke/rotate credentials using the organization's approved process.

No supported-version or patch-service commitment is established yet. A release baseline and passing fixture tests are not a security certification or live Azure validation. Licensing remains the owner's decision before public distribution.
