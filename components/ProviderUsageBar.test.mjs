import assert from "node:assert/strict";
import test from "node:test";

const { usageSummary } = await import("./ProviderUsageBar.tsx");

test("header summary is the highest window of any account in use, paused ones left out", () => {
  const accounts = [
    { provider: "anthropic", fiveHour: { percent: 40 }, sevenDay: { percent: 64.6 } },
    { provider: "github-copilot", monthly: { percent: 101 }, paused: true },
    { provider: "antigravity-acp", fiveHour: { percent: 12 } },
  ];
  assert.deepEqual(usageSummary(accounts), { percent: 65, window: "7D" });
  assert.equal(usageSummary([{ provider: "anthropic", paused: true }]), null);
});
