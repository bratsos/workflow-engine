---
sidebar_position: 4
title: Migrating from 0.8 to 0.9
---

# Migrating from 0.8 to 0.9

## Summary
`0.9` adds support for reasoning models (e.g. Anthropic Claude 3.7 / Claude thinking models) to the `AIHelper` interface, introducing per-call `providerOptions` and access parameters for the separate reasoning channel.

This release is backward-compatible. There are no database schema modifications or required actions.

---

## Required Actions
None. This is a drop-in upgrade.

---

## New Features

### 1. `providerOptions` Passthrough
`generateText`, `generateObject`, and `streamText` now accept a per-call `providerOptions` parameter to control provider-specific settings like reasoning/thinking depth:

```typescript
// Disable reasoning/thinking for a specific call to save output tokens
const result = await ai.generateText("anthropic/claude-3.7-sonnet", prompt, {
  providerOptions: {
    anthropic: {
      thinking: { type: "disabled" }
    }
  }
});
```

### 2. Reasoning Channel Access
* **`AITextResult.reasoning`**: Contains the reasoning/thinking trace output.
* **`AIStreamResult.getReasoning()`**: Returns the reasoning trace for streamed responses.

```typescript
const { text, reasoning } = await ai.generateText(reasoningModel, prompt);
console.log("Thinking process:", reasoning);
```

---

## Bug Fixes

### Empty Text Channel Fallback
When a reasoning model emits output solely on its thinking channel first, streaming APIs previously resolved to an empty output error. The engine now falls back to buffering result outputs, preventing "no output generated" errors on slow thinking responses.
