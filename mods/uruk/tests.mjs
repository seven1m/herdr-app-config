import assert from "node:assert/strict";
import { defaults, parseConfig, discoverLimit, boundedOutput, formatUsage, runTurn } from "./agent.js";
import { saveSession, loadSession } from "./session.js";

const fresh = () => ({ messages: [], contextTokens: 0, limit: 65536 });
const answer = (input, output, content = "Hello", calls = []) => ({
  choices: [{ message: { role: "assistant", content, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: calls.length ? "tool_calls" : "stop" }],
  usage: { prompt_tokens: input, completion_tokens: output },
});
const toolCall = (id, command) => ({ id, type: "function", function: { name: "shell", arguments: JSON.stringify({ command }) } });

export async function runTests() {
  const passed = [];
  const test = async (name, fn) => { await fn(); passed.push(name); };
  const adapter = (request, extra = {}) => ({ request, shell: async () => { throw new Error("unexpected shell execution"); }, entry() {}, usage() {}, cancelled: () => false, ...extra });

  await test("sessions restore history, tools, draft and usage without credentials", () => {
    const storage = () => { const data = new Map(); return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }; };
    const first = storage(), second = storage();
    const state = { ...fresh(), config: { ...defaults, api_key: "private-key" }, cwd: "/project", busy: true,
      entries: [{ role: "command", text: "pwd", expanded: true }, { role: "tool", text: "/project" }],
      messages: [{ role: "user", content: "where am I" }], usage: { input: 20, output: 5 }, input: { value: () => "draft" } };
    saveSession(first, state);
    const restored = loadSession(first);
    assert.deepEqual(restored.messages, state.messages);
    assert.deepEqual(restored.entries, state.entries);
    assert.deepEqual(restored.usage, state.usage);
    assert.equal(restored.draft, "draft");
    assert.equal(restored.interrupted, true);
    assert.equal(restored.cwd, "/project");
    assert.equal(first.getItem("conversation").includes("private-key"), false);
    assert.equal(loadSession(second), null);
    saveSession(first, { ...state, entries: [], messages: [], busy: false });
    assert.deepEqual(loadSession(first).messages, []);
    first.setItem("conversation", '{"version":1}');
    assert.throws(() => loadSession(first), /invalid/);
  });

  await test("JSON defaults, values, and validation", () => {
    const cfg = parseConfig(JSON.stringify({ model: "Qwen custom", api_key: "it's # private", max_tokens: 123, enable_thinking: true }));
    assert.equal(cfg.model, "Qwen custom");
    assert.equal(cfg.api_key, "it's # private");
    assert.equal(cfg.max_tokens, 123);
    assert.equal(cfg.enable_thinking, true);
    assert.equal(cfg.max_steps, defaults.max_steps);
    assert.deepEqual(parseConfig(""), defaults);
    for (const bad of [null, [], "model", { max_toknes: 5 }, { max_steps: 0 }, { model: "" }, { shell_timeout_seconds: 601 }, { temperature: 3 }, { base_url: "file:///tmp" }, { max_steps: true }]) assert.throws(() => parseConfig(JSON.stringify(bad)));
    assert.throws(() => parseConfig("not JSON"));
  });

  await test("metadata selects the exact model and authenticates", async () => {
    const cfg = { ...defaults, api_key: "secret" };
    const limit = await discoverLimit(cfg, async (url, options) => {
      assert.equal(url, "http://127.0.0.1:8000/v1/models");
      assert.equal(options.headers.Authorization, "Bearer secret");
      return { data: [{ id: "other", max_model_len: 1 }, { id: cfg.model, max_model_len: 262144 }] };
    });
    assert.equal(limit, 262144);
    await assert.rejects(() => discoverLimit(cfg, async () => ({ data: [{ id: cfg.model }] })), /No context limit/);
  });

  await test("input delta excludes repeated history and previous output", async () => {
    let calls = 0;
    const io = adapter(async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.tools.length, 1);
      assert.equal(body.chat_template_kwargs.enable_thinking, false);
      assert.equal(body.messages[0].role, "system");
      calls++;
      return calls === 1 ? answer(403, 9) : answer(426, 22);
    });
    const first = await runTurn(defaults, fresh(), "hi", io);
    assert.equal(first.error, null);
    assert.equal(first.usage.input, 403);
    assert.equal(first.contextTokens, 412);
    const second = await runTurn(defaults, { ...first, limit: 65536 }, "what's my name", io);
    assert.equal(second.usage.input, 14);
    assert.equal(second.usage.output, 22);
    assert.equal(second.contextTokens, 448);
    assert.equal(formatUsage(second.usage), "Context ~448/65536 (0.7%) · input +14 · output 22");
  });

  await test("tool results return to the model and usage includes every step", async () => {
    let requests = 0, executions = 0;
    const checkpoints = [];
    const result = await runTurn(defaults, fresh(), "where am I", adapter(async (_url, options) => {
      if (++requests === 1) return answer(250, 20, "", [toolCall("one", "pwd")]);
      const messages = JSON.parse(options.body).messages;
      assert.deepEqual(messages.at(-1), { role: "tool", content: "/project", tool_call_id: "one" });
      return answer(300, 2, "Done");
    }, {
      shell: async (command) => { assert.equal(command, "pwd"); executions++; return "/project"; },
      checkpoint: (state) => checkpoints.push(JSON.parse(JSON.stringify(state))),
    }));
    assert.equal(result.error, null);
    assert.equal(executions, 1);
    assert.equal(result.usage.input, 280);
    assert.equal(result.usage.output, 22);
    assert.equal(result.usage.context, 302);
    assert.equal(result.usage.requests, 2);
    assert.equal(checkpoints.length, 3);
    assert.equal(checkpoints[0].messages.at(-1).role, "user");
    assert.equal(checkpoints[1].messages.at(-1).role, "tool");
    assert.equal(checkpoints[1].messages.at(-1).tool_call_id, "one");
    assert.equal(checkpoints[2].messages.at(-1).content, "Done");
  });

  await test("stopping prevents remaining commands and keeps tool history valid", async () => {
    let stopped = false, executions = 0;
    const result = await runTurn(defaults, fresh(), "test", adapter(async () => answer(250, 20, "", [toolCall("one", "first"), toolCall("two", "second")]), {
      cancelled: () => stopped,
      shell: async () => { executions++; stopped = true; return "done"; },
    }));
    assert.equal(executions, 1);
    assert.equal(result.stopped, true);
    assert.equal(result.messages.at(-2).tool_call_id, "one");
    assert.equal(result.messages.at(-1).tool_call_id, "two");
    assert.match(result.messages.at(-1).content, /Not executed/);
    assert.equal(result.usage.context, null);
  });

  await test("malformed tool calls never execute", async () => {
    const bad = toolCall("", "echo should-not-run");
    const result = await runTurn(defaults, fresh(), "test", adapter(async () => answer(250, 20, "", [bad])));
    assert.match(result.error, /malformed tool call/);
    assert.equal(result.messages.length, 2);
  });

  await test("UTF-8 output limits do not split a code point", () => {
    assert.equal(boundedOutput("abc", 3), "abc");
    assert.equal(boundedOutput("a🙂b", 5), "a🙂\n[output truncated]");
    assert.equal(boundedOutput("🙂", 3), "\n[output truncated]");
  });

  await test("errors preserve completed history and missing usage is explicit", async () => {
    const failed = await runTurn(defaults, fresh(), "hi", adapter(async () => { throw new Error("oMLX 507: memory pressure"); }));
    assert.match(failed.error, /507/);
    assert.equal(failed.messages.length, 2);
    const response = answer(403, 9); delete response.usage;
    const unknown = await runTurn(defaults, fresh(), "hi", adapter(async () => response));
    assert.equal(formatUsage(unknown.usage), "Token usage unavailable");
  });

  return { passed: passed.length, tests: passed };
}
