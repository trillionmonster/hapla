# Session lifecycle

Hapla separates a durable conversation from the local agent process that serves it.

## State model

- A session record, its encrypted messages, and its provider thread ID remain durable until the user explicitly deletes the session.
- A running Codex or Claude process is only a temporary runtime for that record.
- The runtime changes the lifecycle state to `sleeping`, flushes pending messages, announces `session-end`, closes local resources, and exits only after the user explicitly selects the sleep action.
- Idle time, browser visibility, and a completed or aborted turn never put a runtime to sleep.
- The relay also marks a session inactive after three minutes without a valid activity signal. This is a recovery guard for crashed or disconnected clients, not the primary process supervisor.
- Opening a sleeping session in Web immediately shows its stored conversation and automatically calls the machine's `resume-hapla-session` RPC. The CLI resumes the saved Codex thread or Claude session and Web follows the new active runtime.
- If the original machine is offline or the provider resume ID is missing, Web keeps the history readable and presents the terminal resume command when one can be constructed.

## User actions

Sleep is an explicit user action and preserves the conversation for later resume. Delete is the only destructive session action and permanently removes the durable record after confirmation.

The legacy archive HTTP endpoint, metadata values, and RPC names remain accepted only for wire compatibility with older clients. New Hapla UI and runtime code must not create archived sessions.

## Activity

Socket heartbeats and browser visibility keep connection state current, but neither one changes the user-controlled lifecycle state.
