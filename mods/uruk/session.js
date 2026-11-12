export function saveSession(storage, state) {
  storage.setItem("conversation", JSON.stringify({
    version: 1,
    connection: { model: state.config.model, base_url: state.config.base_url },
    cwd: state.cwd,
    messages: state.messages,
    entries: state.entries,
    contextTokens: state.contextTokens,
    usage: state.usage ?? null,
    draft: state.input.value(),
    interrupted: state.busy,
  }));
}

export function loadSession(storage) {
  const text = storage.getItem("conversation");
  if (!text) return null;
  const value = JSON.parse(text);
  if (value?.version !== 1 || !Array.isArray(value.messages) || !Array.isArray(value.entries)
      || typeof value.cwd !== "string" || typeof value.connection?.model !== "string"
      || typeof value.connection?.base_url !== "string"
      || !Number.isSafeInteger(value.contextTokens) || value.contextTokens < 0
      || value.entries.some((entry) => typeof entry?.role !== "string" || typeof entry?.text !== "string")
      || value.messages.some((message) => !["system", "user", "assistant", "tool"].includes(message?.role))) {
    throw new Error("Saved conversation is invalid.");
  }
  return value;
}
