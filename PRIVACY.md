# Privacy and data handling

Last updated: 2026-11-18.

This describes the open-source Hapla software. A self-hosting operator controls
the deployment, logs, retention, and external integrations. Agent providers and
other services have their own policies; this document does not promise legal
compliance or a retention schedule for independently operated installations.

## Conversations and pairing

The Web client and local CLI encrypt session payloads before synchronizing them
through the relay. Content keys are held by paired clients rather than the relay.
The relay still handles account authentication and operational metadata such as
account/session/machine identifiers, sequence numbers, timestamps, and connection
information. Encryption does not conceal that metadata from the deployment operator.

Local CLI state, pairing credentials, and agent-provider credentials remain on
the machines where they are created. Protect browser storage, local state
folders, and backups: a compromised paired client can access decrypted content.

## Files and optional integrations

File delivery has a separate trust boundary from encrypted conversation messages.
Images, attachments, previews, and originals can be uploaded to the Hapla server
or an explicitly configured external file service. Those services can process
original bytes for delivery or previews. Do not assume file bytes have the same
end-to-end encryption boundary as session payloads.

Private file endpoints check account access. Optional R2 delivery uses temporary
signed URLs; anyone holding a valid capability URL may use it until it expires.
Treat those URLs as credentials and keep them out of public reports and logs.
Cloudflare and an external file-service operator participate in that delivery
path when those integrations are configured.

Optional ASR sends microphone audio to the configured recognition service. The
bundled local ASR service processes audio and transcription in memory. Hosting,
proxies, custom integrations, and the resulting conversation messages can have
additional logging or retention behavior.

Claude Code and Codex send selected prompts, workspace context, and tool data to
the services configured for those CLIs. Hapla's relay encryption does not prevent
that provider processing. Interactive Skills can also contact services configured
by the user and must be reviewed before enabling them.

## Telemetry and logs

The Hapla application does not include product-usage analytics, subscriptions,
or push-notification delivery. Hosting infrastructure, optional tools such as
Wrangler, providers, and user-installed Skills may have their own telemetry.

Servers and CLIs keep operational logs. Protocol journals and acceptance tools
may contain raw requests, file paths, or private content. Keep generated evidence
in ignored local storage and redact it before sharing.

## Retention and operator controls

Conversation history persists until explicitly deleted; sleeping a runtime does
not delete its history. Database backups, local agent history, media stores,
external services, and logs have independent retention. Deleting a conversation
does not establish deletion from every backup or external service.

Operators should configure HTTPS, authentication, access gates, backup protection,
and cleanup policies appropriate to their installation. See [deployment](docs/deployment.md),
[configuration](docs/configuration.md), and [security reporting](SECURITY.md).
