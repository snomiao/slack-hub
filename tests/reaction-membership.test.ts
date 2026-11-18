import { describe, test, expect } from "./harness.ts";
import { startMock } from "./mock.ts";
import { reactionAdd } from "../ts/slack.ts";

describe("bot reaction membership recovery", () => {
  for (const c of [
    { token: "xoxp-fake", channel: "C00000001", error: "not_in_channel" },
    { token: "xoxb-fake", channel: "D00000001", error: "not_in_channel" },
    { token: "xoxb-fake", channel: "G00000001", error: "not_in_channel" },
    { token: "xoxb-fake", channel: "C00000001", error: "already_reacted" },
    { token: "xoxb-fake", channel: "C00000001", error: "missing_scope" },
  ]) {
    test(`does not join for ${c.token.split("-")[0]} ${c.channel} ${c.error}`, async () => {
      const m = await startMock({ inline: { "reactions.add": { ok: false, error: c.error } } });
      const previous = process.env.SLACK_API_BASE;
      process.env.SLACK_API_BASE = `${m.baseUrl}/api`;
      try {
        await expect(reactionAdd(c.token, c.channel, "1700000000.000100", "one")).rejects.toThrow(c.error);
        expect(m.requests.map((r) => r.method)).toEqual(["reactions.add"]);
      } finally {
        if (previous === undefined) delete process.env.SLACK_API_BASE;
        else process.env.SLACK_API_BASE = previous;
        await m.stop();
      }
    });
  }

  for (const joinFails of [false, true]) {
    test(joinFails ? "failed join explains how to restore pills" : "retries only once if membership still fails", async () => {
      const m = await startMock({ inline: {
        "reactions.add": { ok: false, error: "not_in_channel" },
        "conversations.join": joinFails ? { ok: false, error: "missing_scope" } : { ok: true },
      } });
      const previous = process.env.SLACK_API_BASE;
      process.env.SLACK_API_BASE = `${m.baseUrl}/api`;
      try {
        await expect(reactionAdd("xoxb-fake", "C00000001", "1700000000.000100", "one")).rejects.toThrow(joinFails ? "Invite the bot" : "not_in_channel");
        expect(m.requests.map((r) => r.method)).toEqual(joinFails
          ? ["reactions.add", "conversations.join"]
          : ["reactions.add", "conversations.join", "reactions.add"]);
      } finally {
        if (previous === undefined) delete process.env.SLACK_API_BASE;
        else process.env.SLACK_API_BASE = previous;
        await m.stop();
      }
    });
  }
});
