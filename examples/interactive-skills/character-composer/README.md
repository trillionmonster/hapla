# Character composer interactive Skill example

This is a project example, not an automatically installed user Skill. It demonstrates Hapla's optional interactive Skill convention while remaining a normal Codex Skill and MCP Apps server.

## Try it locally

```bash
cd examples/interactive-skills/character-composer
pnpm install
```

Copy this directory to the project's `.agents/skills/character-composer` directory (or to `$CODEX_HOME/skills/character-composer`), then refresh the Skill catalog and enable `character-composer`. Start a new Hapla Codex session. Hapla reads `.hapla/interactive.json`, starts the MCP server through Codex, and exposes `render_character_composer`.

Ask Codex: `Use $character-composer to help me compose a character.`

For real assets, set `CHARACTER_ASSET_BASE_URL` before starting Hapla. The server inherits only environment variables listed in the manifest. The example fallback uses deterministic Picsum images so the interaction can be tested without shipping a 200-image repository.

The embedded page keeps only the current reference image in the DOM. Adjacent choices are preloaded briefly and released after ten seconds. This is the intended pattern for large media catalogs.
