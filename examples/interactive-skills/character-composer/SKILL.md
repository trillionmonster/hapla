---
name: character-composer
description: Help a user discover and combine face, face shape, hairstyle, outfit, and body references through an interactive visual composer, then hand the structured selection to imagegen.
---

# Character composer

Use this Skill when the user wants to explore a character visually instead of describing every attribute in text.

1. Call the `render_character_composer` tool from the `hapla-skill-character-composer` MCP server.
2. Let the user make and submit selections in the embedded page. Do not ask them to repeat the choices in chat.
3. Hapla sends the submitted selection back as a new Codex turn with the selected images and an explicit `imagegen` Skill reference.
4. Generate one coherent image that treats the submitted face, face shape, hairstyle, outfit, and body images as references. Preserve the user's written notes.
5. Return the generated image in the main Hapla conversation.

The MCP tools remain useful without a UI: `render_character_composer` returns the initial indices and a text explanation of the available categories.
