# Legacy compatibility boundary

Hapla writes new deployment names, client headers, RPC names, application links,
server tokens, and server-encrypted records with the `hapla` identity. A small
read-only compatibility boundary remains so existing encrypted installations can
upgrade without losing access to data.

The allowed legacy surface is limited to immutable persisted-data and authentication compatibility:

- encrypted machine/session field keys such as `happyCliVersion` and
  `happyHomeDir`;
- client-side content-key derivation labels needed to decrypt existing records;
- server token verifiers used only as fallback readers. Authentication is outside
  the project-isolation cleanup and is intentionally unchanged.

Runtime routing aliases are not accepted. Hapla ignores `HAPPY_*` environment
variables and does not register old CLI flags, RPC names, client headers, or deep
links. This prevents another checkout's configuration or clients from controlling
Hapla.

New outbound traffic uses `X-Hapla-Client`, new machine calls use
`spawn-hapla-session` / `resume-hapla-session`, and new auth/encryption material
uses Hapla labels. Deployment files must not contain old service names, external
Happy application identifiers, upstream hosted endpoints, or private-network sidecars.

`pnpm check:boundaries` enforces this boundary and fails if a legacy name appears
in a new runtime source file or if a cross-project deployment reference returns.
