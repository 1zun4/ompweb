import assert from "node:assert/strict";
import test from "node:test";

const { createNotificationDetector, parseNotificationPrefs, renderNotification } = await import("./notification-events.ts");

const session = { sessionId: "s1", sessionName: "Refactor auth" };

function run(frames) {
  const detect = createNotificationDetector();
  return frames.flatMap((frame) => detect(frame, session));
}

const summary = (events) => events.map((event) => [event.type, event.detail]);

test("completion fires when the session settles, not per prompt or per subagent", () => {
  const events = run([
    { type: "agent_start" },
    { type: "subagent_lifecycle", payload: { id: "a", status: "completed" } },
    { type: "subagent_event", payload: { id: "a", event: { type: "agent_end", isTerminal: true } } },
    { type: "agent_end", isTerminal: false },
    { type: "prompt_result", agentInvoked: true, status: "completed", sessionSettled: false },
    { type: "session_settled" },
  ]);
  assert.deepEqual(events, [{ sessionId: "s1", sessionName: "Refactor auth", type: "completed" }]);
});

test("local slash commands and aborted runs do not notify", () => {
  assert.deepEqual(run([{ type: "prompt_result", agentInvoked: false, status: "error", error: { message: "unknown command" } }]), []);
  assert.deepEqual(run([{ type: "prompt_result", agentInvoked: true, status: "aborted" }, { type: "session_settled" }]), []);
});

test("a run failure reported by omp-web and again by omp notifies once; a later crash adds nothing", () => {
  const events = run([
    { type: "prompt_error", errorMessage: "usage reserve is fail-closed" },
    { type: "prompt_result", agentInvoked: true, status: "error", error: { message: "usage reserve is fail-closed" } },
    { type: "process_exit", detail: "code 1" },
    { type: "session_settled" },
  ]);
  assert.deepEqual(summary(events), [["error", "usage reserve is fail-closed"]]);
});

test("a failed run notifies once as an error, not again as completed", () => {
  const events = run([
    { type: "prompt_result", agentInvoked: true, status: "error", error: { message: "Retry budget exhausted" } },
    { type: "session_settled" },
  ]);
  assert.deepEqual(summary(events), [["error", "Retry budget exhausted"]]);
});

test("after a failed stretch, a background wake with no prompt completes normally", () => {
  const events = run([
    { type: "prompt_result", agentInvoked: true, status: "error", error: { message: "boom" } },
    { type: "session_settled" },
    { type: "agent_start" },
    { type: "agent_end", isTerminal: true },
    { type: "session_settled" },
  ]);
  assert.deepEqual(events.map((event) => event.type), ["error", "completed"]);
});

test("every runner dialog asks for input; presentation UI frames do not", () => {
  const titled = ["select", "confirm", "input", "editor"].map((method, id) => ({ type: "ui_request", id, method, args: [`${method}?`] }));
  const events = run([
    ...titled,
    { type: "ui_request", id: 4, method: "askDialog", args: [[{ id: "q", question: "Ship it?", options: [] }]] },
    { type: "ui_request", id: 5, method: "approve", args: [{ full: "Run bash: ls", compact: "bash: ls" }] },
    { type: "ui_request", id: 6, method: "formDialog", args: ["<form></form>"] },
    { type: "ui", method: "notify", message: "fyi" },
    { type: "ui", method: "setStatus", statusKey: "k" },
  ]);
  assert.deepEqual(summary(events), [
    ["input", "select?"], ["input", "confirm?"], ["input", "input?"], ["input", "editor?"], ["input", "Ship it?"], ["input", "bash: ls"], ["input", undefined],
  ]);
});

test("a fallback takes its reason from the retry error omp sends right after it", () => {
  // omp's order: retry_fallback_applied, then auto_retry_start for the same failure.
  const events = run([
    { type: "auto_retry_start", attempt: 1, errorMessage: "429 rate limit, retry in 2s" },
    { type: "auto_retry_end", success: true },
    { type: "retry_fallback_applied", from: "anthropic/fable", to: "anthropic/opus", role: "default" },
    { type: "auto_retry_start", attempt: 2, errorMessage: "Request refused by the safety classifier" },
  ]);
  assert.deepEqual(events.map((event) => [event.from, event.to, event.detail]), [["anthropic/fable", "anthropic/opus", "Request refused by the safety classifier"]]);
});

test("an explicit fallback reason wins; a fallback with no following retry has none", () => {
  const events = run([
    { type: "retry_fallback_applied", from: "a/x", to: "b/y", reason: "usage reserve reached" },
    { type: "auto_retry_start", errorMessage: "ignored for the explicit reason" },
    { type: "retry_fallback_applied", from: "a/x", to: "b/y" },
    { type: "prompt_result", agentInvoked: true, status: "completed" },
    { type: "retry_fallback_applied", from: "a/x" },
  ]);
  assert.deepEqual(summary(events), [["modelSwitch", "usage reserve reached"], ["modelSwitch", undefined]]);
});

test("prewalk and plan hand-offs notify as model switches; other notices do not", () => {
  const events = run([
    { type: "notice", level: "info", source: "prewalk", message: "Prewalk: switched to openai/gpt-5 after first edit call." },
    { type: "notice", level: "info", source: "plan-yolo", message: "Plan-yolo: plan approved, switched to openai/gpt-5." },
    { type: "notice", level: "error", source: "session-persistence", message: "disk full" },
  ]);
  assert.deepEqual(events.map((event) => event.type), ["modelSwitch", "modelSwitch"]);
});

test("untrusted prefs fall back to defaults field by field", () => {
  assert.deepEqual(parseNotificationPrefs({ enabled: true, types: { input: false, bogus: true }, whenActive: "loud", locale: "<script>" }), {
    enabled: true,
    types: { completed: true, input: false, error: true, modelSwitch: false },
    whenActive: "toast",
    locale: "en",
  });
});

test("a blocking dialog carries its request id and answerable payload", () => {
  const [event] = run([{
    type: "ui_request",
    id: "req-1",
    method: "confirm",
    args: ["Allow tool: bash", "Run rm -rf build?"],
  }]);
  assert.equal(event.requestId, "req-1");
  assert.deepEqual(event.dialog, { requestId: "req-1", method: "confirm", title: "Allow tool: bash", message: "Run rm -rf build?" });
});

test("a dialog that cannot be carried exactly is omitted instead of clipped", () => {
  // A clipped confirm would show only the harmless prefix of an approval and
  // still offer Yes/No: omit the whole dialog, keep the request id for the
  // retraction, and let the app open the session instead.
  const destructive = `${"A".repeat(480)} --delete-everything`;
  const [confirm] = run([{ type: "ui_request", id: "req-long", method: "confirm", args: ["Allow tool: bash", destructive] }]);
  assert.equal(confirm.dialog, undefined);
  assert.equal(confirm.requestId, "req-long");

  // The title and an ask question are held to the same rule.
  const [title] = run([{ type: "ui_request", id: "req-title", method: "select", args: ["T".repeat(161), ["Yes", "No"]] }]);
  assert.equal(title.dialog, undefined);
  const [question] = run([{ type: "ui_request", id: "req-ask", method: "askDialog", args: [[{ id: "q", question: "Q".repeat(241), options: [] }]] }]);
  assert.equal(question.dialog, undefined);
  // open_url is fire-and-forget: no resolver in omp, so never a dialog.
  const [openUrl] = run([{ type: "ui_request", id: "req-url", method: "open_url", args: ["https://example.com"] }]);
  assert.equal(openUrl.dialog, undefined);

  // At the cap the whole text still fits, so the dialog is carried verbatim.
  const message = "B".repeat(480);
  const [atCap] = run([{ type: "ui_request", id: "req-cap", method: "confirm", args: ["Allow tool: bash", message] }]);
  assert.equal(atCap.dialog.message, message);
  assert.equal(atCap.dialog.message.length, 480);
});

test("an ask dialog keeps option labels verbatim and drops payloads that cannot be answered", () => {
  const questions = [{ id: "q1", question: "Ship it?", options: [{ label: "Yes" }, { label: "No" }], multi: true }];
  const [event] = run([{ type: "ui_request", id: "req-2", method: "askDialog", args: [questions] }]);
  assert.deepEqual(event.dialog.questions, [{ id: "q1", question: "Ship it?", options: ["Yes", "No"], multi: true, allowCustom: true }]);

  // A label that would have to be clipped cannot be answered: no dialog, but
  // the request id still reaches the notification so a retraction can close it.
  const long = [{ id: "q1", question: "Ship it?", options: [{ label: "x".repeat(200) }] }];
  const [clipped] = run([{ type: "ui_request", id: "req-3", method: "askDialog", args: [long] }]);
  assert.equal(clipped.dialog, undefined);
  assert.equal(clipped.requestId, "req-3");
});

test("a form dialog has no answerable dialog but keeps its request id", () => {
  const [event] = run([{ type: "ui_request", id: "req-4", method: "formDialog", args: ["<form><input name='x'></form>"] }]);
  assert.equal(event.requestId, "req-4");
  assert.equal(event.dialog, undefined);
});

test("rendered notifications open their session and clip long details", () => {
  const t = (key, vars) => `${key}${vars ? JSON.stringify(vars) : ""}`;
  const rendered = renderNotification({ type: "error", sessionId: "a b", sessionName: null, detail: "x".repeat(500) }, t);
  assert.equal(rendered.url, "/?session=a%20b");
  assert.equal(rendered.title, "notifications.untitledSession");
  assert.equal(rendered.tag, "a b:error");
  assert.ok(rendered.body.length < 260, rendered.body);
});

test("a pasted overlong session name is clipped so push payloads stay small", () => {
  const rendered = renderNotification({ type: "completed", sessionId: "s1", sessionName: "y".repeat(60_000) }, (key) => key);
  assert.equal(rendered.title.length, 100);
  assert.ok(rendered.title.endsWith("…"));
  assert.equal(renderNotification({ type: "completed", sessionId: "s1", sessionName: "Fix bug" }, (key) => key).title, "Fix bug");
});
