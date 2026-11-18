# Security policy

Security fixes target the current default branch. Older releases do not have a
separate security maintenance guarantee.

## Report a vulnerability

Use GitHub's **Report a vulnerability** option on the repository's
[Security page](https://github.com/trillionmonster/hapla/security) when private
reporting is enabled. If unavailable, open an issue asking for a private contact
without including exploit details, secrets, or affected account data.

Include the affected revision, reproduction steps in an isolated environment,
expected and actual behavior, and likely impact. Do not attach credentials,
recovery keys, signed file URLs, database copies, or private conversations.

## Deployment responsibilities

Operators manage HTTPS, access controls, backups, agent permissions, and optional
external integrations. Keep `HAPLA_MASTER_SECRET` stable and private. A site access
password is an additional entry gate; it does not replace account authentication.
See the [deployment guide](docs/deployment.md), [configuration reference](docs/configuration.md),
and [privacy description](PRIVACY.md) for the relevant trust boundaries.
