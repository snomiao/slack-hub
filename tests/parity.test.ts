// Parity: the Rust binary against the TypeScript CLI, invocation by invocation.
//
// A command may be served by the Rust binary only once this file shows that it
// behaves exactly like the TypeScript. Each case runs once per implementation,
// each run in a fresh, empty HOME with a fresh mock Slack (tests/mock.ts), and
// compares everything a user or a script can observe:
//
//   - stdout and stderr, byte for byte, and the exit code;
//   - every request the mock received (method, query, body, Authorization and
//     Cookie headers);
//   - every file left behind under HOME (cache.json's `expires` is the only
//     thing normalised: it is "now + 1 hour", so it is checked to be that).
//
// Then the routing cases check the binary's hand-back: an invocation the Rust
// does not implement (usage errors, --help, other commands, configuration it
// does not read) must reach the JavaScript unchanged.
//
// The binary is $RUSTIFY_BIN_DIR/slack in CI (rustify's parity job) and
// rs/target/release/slack locally (`cargo build --release --manifest-path
// rs/Cargo.toml`). Without one the suite is skipped locally — but never in CI:
// there a missing binary fails the run.
//
// PARITY_SELF=1 runs the TypeScript against itself. Every case has to pass
// that way first, or it compares something that is not deterministic.
// PARITY_DUMP=<dir> writes both outcomes of every case there, for reading.

import { describe, test, expect } from "./harness.ts";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock, type InlineFixtures } from "./mock.ts";
import { markdownToRichText } from "./slack-markdown.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TS_ENTRY = join(ROOT, "ts", "cli.ts");
const EXE = process.platform === "win32" ? ".exe" : "";
const BIN_DIR = process.env.RUSTIFY_BIN_DIR;
const RUST_BIN = BIN_DIR ? join(BIN_DIR, `slack${EXE}`) : join(ROOT, "rs", "target", "release", `slack${EXE}`);
if (BIN_DIR && !existsSync(RUST_BIN)) {
  throw new Error(`RUSTIFY_BIN_DIR is set, but ${RUST_BIN} does not exist: the binary under test is missing`);
}
const SELF = process.env.PARITY_SELF === "1";
const DUMP = process.env.PARITY_DUMP;
function dump(name: string, outcomes: Record<string, Outcome>): void {
  if (!DUMP) return;
  mkdirSync(DUMP, { recursive: true });
  writeFileSync(join(DUMP, `${name.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 80)}.json`), JSON.stringify(outcomes, null, 2));
}
const ENABLED = SELF || existsSync(RUST_BIN);

// Bun keeps a transpiler cache in HOME; keep it out of the HOME under test.
const BUN_CACHE = join(tmpdir(), "slack-parity-bun-cache");

// ─────────────────────────────── runner ───────────────────────────────

type Env = Record<string, string | null>;
type Setup = {
  /** Files to create, relative to HOME. The command runs in HOME/work. */
  files?: Record<string, string>;
  /** Added to the base environment; null removes a variable. */
  env?: Env;
  /** The mock's fixtures (default: DEPLOY). */
  fixtures?: InlineFixtures;
};
type Case = Setup & {
  name: string;
  args: string[];
  /** Checked on the TypeScript's outcome, so a case cannot silently stop
   *  exercising what its name says. */
  check?: (o: Outcome) => void;
};
type Req = { http: string; method: string; params: Record<string, string>; body: string; auth: string | null; cookie: string | null };
type Outcome = { exit: number | null; signal: string | null; stdout: string; stderr: string; requests: Req[]; files: Record<string, string> };

const HOUR = 60 * 60 * 1000;

function snapshot(dir: string, t0: number, t1: number, clean: (s: string) => string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const rel = relative(dir, p).split(sep).join("/");
      if (statSync(p).isDirectory()) { out[`${rel}/`] = ""; walk(p); continue; }
      let text = clean(readFileSync(p, "utf8"));
      if (name === "cache.json") {
        text = text.replace(/"expires": (\d+)/g, (m, n: string) => {
          const v = Number(n);
          return v >= t0 + HOUR && v <= t1 + HOUR ? `"expires": "<now + 1h>"` : m;
        });
      }
      out[rel] = text;
    }
  };
  walk(dir);
  return out;
}

function writeFiles(home: string, files: Record<string, string> | undefined, subst: (s: string) => string): void {
  for (const [rel, content] of Object.entries(files ?? {})) {
    const p = join(home, rel);
    if (rel.endsWith("/")) { mkdirSync(p, { recursive: true }); continue; }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, subst(content));
  }
}

type Impl = { cmd: string; args: string[] };
const TS_IMPL: Impl = { cmd: "bun", args: [TS_ENTRY] };
const RS_IMPL: Impl = SELF ? TS_IMPL : { cmd: RUST_BIN, args: [] };

async function run(impl: Impl, c: Setup & { args: string[] }, extraEnv: Env = {}): Promise<Outcome> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "slack-parity-")));
  const home = join(base, "home");
  const cwd = join(home, "work");
  mkdirSync(cwd, { recursive: true });
  const mock = await startMock({ inline: c.fixtures ?? DEPLOY });
  const subst = (s: string): string => s.replaceAll("{home}", home).replaceAll("{base}", base).replaceAll("{mock}", mock.baseUrl);
  try {
    writeFiles(home, c.files, subst);
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      TZ: "Asia/Tokyo",
      SLACK_API_BASE: `${mock.baseUrl}/api`,
      SLACK_TOKEN: "xoxp-fake",
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: BUN_CACHE,
    };
    for (const [k, v] of Object.entries({ ...c.env, ...extraEnv })) {
      if (v === null) delete env[k];
      else env[k] = subst(v);
    }
    const t0 = Date.now();
    const res = await new Promise<{ exit: number | null; signal: string | null; stdout: Buffer; stderr: Buffer }>((resolve, reject) => {
      const child = spawn(impl.cmd, [...impl.args, ...c.args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (d: Buffer) => out.push(d));
      child.stderr.on("data", (d: Buffer) => err.push(d));
      child.on("error", reject);
      child.on("close", (exit, signal) => resolve({ exit, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }));
    });
    const t1 = Date.now();
    // The run's own temp path and mock port are what differ between two runs.
    const clean = (s: string): string => s.replaceAll(base, "<tmp>").replaceAll(mock.baseUrl, "<mock>");
    return {
      exit: res.exit,
      signal: res.signal,
      stdout: clean(res.stdout.toString("utf8")),
      stderr: clean(res.stderr.toString("utf8")),
      requests: mock.requests.map((r) => ({
        http: r.httpMethod,
        method: r.method,
        params: r.params,
        body: r.body,
        auth: (r.headers.authorization as string | undefined) ?? null,
        cookie: (r.headers.cookie as string | undefined) ?? null,
      })),
      files: snapshot(home, t0, t1, clean),
    };
  } finally {
    await mock.stop();
    rmSync(base, { recursive: true, force: true });
  }
}

// ─────────────────────────────── fixtures ───────────────────────────────

const user = (id: string, name: unknown, extra: Record<string, unknown> = {}) => ({ ok: true, user: { id, name, ...extra } });
const USERS: InlineFixtures = {
  "users.info__user=U00000001": user("U00000001", "alice", { real_name: "Alice Example", profile: { display_name: "Alice" } }),
  "users.info__user=U00000002": user("U00000002", "bob", { real_name: "Bob Example", profile: { display_name: "" } }),
  // `$&`, `$$`, `` $` `` and `$'` mean something in a JS replacement string.
  "users.info__user=U00000003": user("U00000003", "carol", { profile: { display_name: "Ca$&rol $$ $` $'" } }),
  "users.info__user=U00000004": user("U00000004", "dave", { profile: {} }),
  "users.info__user=U00000005": { ok: false, error: "user_not_found" },
  "users.info__user=U00000007": user("U00000007", "eve", { real_name: null }),
};
const AUTH: InlineFixtures = { "auth.test": { ok: true, team_id: "T00000001", user_id: "U00000009", user: "me", team: "Acme", url: "https://acme.slack.com/" } };

const flatten = (md: string): string => md.replace(/\n/g, " ");
const rich = (md: string) => markdownToRichText(md);
const NEWLINE_SAMPLES = [
  "[slack-hub-nl] 换行测试\n第一行\n第二行\n\n第三行",
  "intro\n\n- one\n- two\n\nafter",
  "1. a\n   - x\n   - y\n2. b",
  "*見出し*\n• 項目 `code`\n• <https://acme.slack.com/x|ラベル の 説明>\n\n<@U00000001> 確認お願いします",
  "run:\n```\nls -la\npwd\n```\ndone",
  "> first\n> second",
  "<https://acme.slack.com/x|a b c>\nnext",
];

let tsSeq = 0;
const ts = (): string => `17000${String(90000 - ++tsSeq * 7).padStart(5, "0")}.${String(100 + tsSeq).padStart(6, "0")}`;
const ch = (name: string, extra: Record<string, unknown> = {}) => ({ id: "C00000001", name, ...extra });

const DEPLOY_MATCHES = [
  {
    type: "message", user: "U00000001", username: "alice", ts: "1700000000.000100",
    text: "Deploying now <@U00000002> and <@U00000003|carol> and <@U00000005> and <@U00000001> <@U0000000X",
    channel: ch("general", { is_channel: true }),
    reactions: [{ name: "eyes", count: 2, users: ["U00000002", "U00000003"] }, { name: "rocket", users: ["U00000002"] }, { count: 5 }, { name: "x", count: "3" }],
    reply_count: 1, permalink: "https://acme.slack.com/archives/C00000001/p1700000000000100",
  },
  {
    type: "message", user: "U00000002", ts: "1699990000.123456",
    text: "line one\nline two\n\n  indented <!date^1700000000^{date_short}|Nov 14> <!date^1700000000^{date}> <!date^abc^x|fb> <!date^99999999999999^{x}|far> <!date^1^x|>",
    channel: ch("random"), reply_count: 3,
  },
  {
    type: "message", user: "U00000003", ts: "1699900000.000001", text: "dm text with <@U00000003>",
    channel: { id: "D00000001", is_im: true, name: "U00000003" },
    files: [
      { name: "a.txt", size: 512, id: "F00000001" },
      { title: "Title only", size: 1280 },
      { size: 5242880, id: "F00000003" },
      { name: "n", size: 1048575 },
      {},
    ],
  },
  { type: "message", username: "deploy-bot", bot_id: "B00000001", ts: "1699800000.5", text: "bot says hi", channel: { id: "D00000002", is_im: true, name: "dm-abc" } },
  { type: "message", ts: "1699700000", text: "100% done %s %d %% $& $$", channel: { id: "C00000009" } },
  {
    type: "message", user: "U00000004", ts: "1699600000.000600", text: "fwd", channel: ch("general"),
    attachments: [
      { is_share: true, author_id: "U00000001", author_name: "alice", channel_id: "C00000001", ts: "1699500000.000100", text: "original <@U00000007> text\nsecond line\n\n\n", from_url: "https://acme.slack.com/archives/C00000001/p1699500000000100" },
      { original_url: "https://example.com", title: "Example", text: "unfurl preview" },
      { title: "Build #12", title_link: "https://ci.example.com/12", text: "passed <@U00000002>", fallback: "Build passed" },
      { message_blocks: [{ team: "T00000001", channel: "C00000002", ts: "1699400000.000200", message: { user: "U00000002", text: "old share text", blocks: [] } }], fallback: "[old] share" },
      { pretext: "only pretext" },
      { is_msg_unfurl: true, text: "", fallback: "", title: "" },
      "not-an-object",
    ],
  },
  ...NEWLINE_SAMPLES.map((md) => ({ type: "message", user: "U00000004", ts: ts(), text: flatten(md).replace(/&/g, "&amp;"), blocks: rich(md), channel: ch("notes") })),
  {
    type: "message", user: "U00000002", ts: ts(), channel: ch("notes"),
    text: "完了 :white_check_mark: 次へ 1️⃣ A B",
    blocks: [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "完了 " }, { type: "emoji", name: "white_check_mark", unicode: "2705" }, { type: "text", text: "\n次へ " }, { type: "emoji", name: "one", unicode: "0031-fe0f-20e3" }, { type: "text", text: " A\nB" }] }] }],
  },
];
const page = (matches: unknown[], p = 1, pages = 1, extra: Record<string, unknown> = {}) => ({
  ok: true, query: "deploy",
  messages: { total: matches.length, pagination: { total_count: matches.length, page: p, per_page: 100, page_count: pages, first: 1, last: matches.length }, paging: { count: 100, total: matches.length, page: p, pages }, matches, ...extra },
});
const DEPLOY: InlineFixtures = { "search.messages": page(DEPLOY_MATCHES), ...USERS, ...AUTH };

// JSON that a JS object literal cannot express, sent raw: `1.0`, integers past
// 2^53, exponents, `-0`, integer-like keys out of JS order, escapes.
const RAW_JSON = String.raw`{"ok":true,"query":"deploy","b":1,"2":"two","a":2,"1":"one","01":"zero-one","4294967295":"not an index","4294967294":"index",
"numbers":[1.0,1.5,-0,-0.0,1e21,1E-7,123e-20,12345678901234567890,9007199254740993,0.1,100,1e2,5e-324,1.7976931348623157e308,-1.25e-5],
"text":"quote\" backslash\\ ctl\u0001\u001f del\u007f` + " ls \u2028 raw-ls \u2028 tab\\t nl\\n \u00fc \u{1F389} \\ud83c\\udf89 \\u2028" + /* bun's String.raw spells non-ASCII as escapes */ String.raw` \/ slash",
"empty":{},"emptyArr":[],"nested":{"x":[{"y":null,"z":true,"w":false}]},
"messages":{"matches":[{"user":"U00000001","ts":"1700000000.000100","text":"one","channel":{"id":"C00000001","name":"general"},"score":1.0,"9":"nine","1":"one"}],"paging":{"count":100,"total":1,"page":1,"pages":1},"total":1}}`;

// Three pages of three, addressed by page number.
const paged = (pages: unknown[][], query = "deploy"): InlineFixtures => Object.fromEntries(pages.map((matches, i) => [
  `search.messages__count=100&page=${i + 1}&query=${query}&sort=timestamp&sort_dir=desc`, page(matches, i + 1, pages.length),
]));
const pm = (n: number) => ({ type: "message", user: "U00000001", ts: `1700000${String(900 - n).padStart(3, "0")}.000001`, text: `match ${n}`, channel: ch("general") });
const PAGED: InlineFixtures = { ...paged([[pm(1), pm(2), pm(3)], [pm(4), pm(5), pm(6)], [pm(7), pm(8), pm(9)]]), ...USERS, ...AUTH };

const ONE = (text = "hello"): InlineFixtures => ({ "search.messages": page([{ type: "message", user: "U00000001", ts: "1700000000.000100", text, channel: ch("general") }]), ...USERS, ...AUTH });

// profiles.json for an account with two workspaces of one team and one more.
const PROFILES = JSON.stringify({
  profiles: {
    "acme-bot": { token: "xoxb-acme-bot", team: "Acme", teamId: "T00000001", url: "https://acme.slack.com/", user: "bot" },
    "acme-alice": { token: "xoxc-acme-alice", team: "Acme", teamId: "T00000001", url: "https://acme.slack.com/", user: "alice", identity: "alice@example.com" },
    other: { token: "xoxp-other", team: "Other", teamId: "T00000002", url: "https://other.slack.com/", user: "alice" },
  },
  users: { "alice@example.com": { cookie: "xoxd-shared", source: "chrome:Default" } },
}, null, 2);
const PROFILES_FILE = { ".config/slack-cli/profiles.json": PROFILES };

const has = (where: "stdout" | "stderr", text: string) => (o: Outcome) => expect(o[where]).toContain(text);
const exits = (code: number) => (o: Outcome) => expect(o.exit).toBe(code);
const all = (...checks: ((o: Outcome) => void)[]) => (o: Outcome) => checks.forEach((c) => c(o));

// ─────────────────────────────── cases ───────────────────────────────

const SEARCH: Case[] = [
  // Output: the message line, mentions, dates, reactions, files, replies,
  // attachments, newline repair, DM labels.
  { name: "search: every part of the message line", args: ["search", "deploy"], check: all(exits(0), has("stdout", "↪ shared message"), has("stdout", "📎"), has("stdout", "[+1 reply]")) },
  { name: "search --json", args: ["search", "deploy", "--json"], check: has("stdout", '"matches": [') },
  { name: "search --json: numbers, key order and escapes as JSON.stringify writes them", args: ["search", "deploy", "--json"], fixtures: { "search.messages": { __raw: RAW_JSON } } },
  { name: "search: the same fixture as text", args: ["search", "deploy"], fixtures: { "search.messages": { __raw: RAW_JSON }, ...USERS, ...AUTH } },
  { name: "search --as-user (no effect on a read)", args: ["search", "deploy", "--as-user"] },
  { name: "search: an empty query", args: ["search", ""] },
  { name: "search: a numeric query stays a string", args: ["search", "123"], fixtures: ONE() },
  { name: "search: no matches", args: ["search", "deploy"], fixtures: { "search.messages": page([]) } },
  {
    name: "search: odd shapes (ts as a number or missing, non-string user, string counts)", args: ["search", "deploy"],
    fixtures: {
      ...USERS, ...AUTH,
      "users.info__user=U00000006": user("U00000006", 42),
      "search.messages": page([
        { ts: 1700000000.5, user: "U00000006", text: "numeric ts", channel: ch("general"), reply_count: "2", reactions: [{ name: "a", count: "x" }, { name: "b", users: "nope" }] },
        { user: 7, username: "named", text: "no ts", channel: "not-an-object" },
        null, 5, "str", [],
        { ts: "1.2.3", text: 12, channel: { is_im: true } },
        { ts: "abc.def", user: "U00000001", text: "bad ts", channel: { name: 5 }, files: [{ name: 3, title: "t", size: "9", id: 4 }] },
        { ts: "1700000000.000100", user: "U00000001", text: "ü<@U00000001>ü", channel: ch("general"), files: "nope", attachments: [null, 1, { text: 5, title: 6 }] },
      ]),
    },
  },

  // --count / -n, and paging.
  { name: "search -n 5: reads pages until it has enough", args: ["search", "deploy", "-n", "5"], fixtures: PAGED },
  { name: "search --count=5", args: ["search", "deploy", "--count=5"], fixtures: PAGED },
  { name: "search --count 7 --json: the last page, holding every match so far", args: ["search", "deploy", "--count", "7", "--json"], fixtures: PAGED },
  { name: "search --count 0", args: ["search", "deploy", "--count", "0"], fixtures: PAGED },
  { name: "search --count 0 --json", args: ["search", "deploy", "--count", "0", "--json"], fixtures: PAGED },
  { name: "search -n 100: stops at the last page", args: ["search", "deploy", "-n", "100"], fixtures: PAGED },
  {
    name: "search -n 100: stops at an empty page", args: ["search", "deploy", "-n", "100"],
    fixtures: { ...paged([[pm(1), pm(2)], [], [pm(3)]]), ...USERS, ...AUTH },
  },
  {
    name: "search: paging without `pages`, and with a string `pages`", args: ["search", "deploy", "-n", "100", "--json"],
    fixtures: {
      "search.messages__count=100&page=1&query=deploy&sort=timestamp&sort_dir=desc": { ok: true, messages: { matches: [pm(1)], paging: { pages: "2" } } },
      "search.messages__count=100&page=2&query=deploy&sort=timestamp&sort_dir=desc": { ok: true, messages: { matches: [pm(2)] } },
    },
  },
  { name: "search: a response without `messages`", args: ["search", "deploy", "--json"], fixtures: { "search.messages": { ok: true, query: "deploy" } } },
  { name: "search: `messages` without `matches`", args: ["search", "deploy", "--json"], fixtures: { "search.messages": { ok: true, messages: { total: 0 }, after: 1 } } },
  { name: "search: `messages: null`", args: ["search", "deploy", "--json"], fixtures: { "search.messages": { ok: true, messages: null, after: 1 } } },

  // Where the token comes from.
  { name: "token: none anywhere", args: ["search", "deploy"], env: { SLACK_TOKEN: null }, check: all(exits(1), has("stderr", "No Slack token found")) },
  { name: "token: SLACK_MCP_XOXP_TOKEN (legacy, no profiles)", args: ["search", "deploy"], env: { SLACK_TOKEN: null, SLACK_MCP_XOXP_TOKEN: "xoxp-legacy" } },
  { name: "token: SLACK_BOT_TOKEN (no profiles)", args: ["search", "deploy"], env: { SLACK_TOKEN: null, SLACK_BOT_TOKEN: "xoxp-in-bot-var" } },
  {
    name: "token: an empty SLACK_BOT_TOKEN hides SLACK_MCP_XOXP_TOKEN", args: ["search", "deploy"],
    env: { SLACK_TOKEN: null, SLACK_BOT_TOKEN: "", SLACK_MCP_XOXP_TOKEN: "xoxp-legacy" }, check: has("stderr", "No Slack token found"),
  },
  { name: "token: an empty SLACK_TOKEN does not count", args: ["search", "deploy"], env: { SLACK_TOKEN: "", SLACK_MCP_XOXP_TOKEN: "xoxp-legacy" } },
  { name: "token: profiles but none selected", args: ["search", "deploy"], env: { SLACK_TOKEN: null }, files: PROFILES_FILE, check: has("stderr", "Workspace not selected") },
  { name: "token: profile selected in ./.slack-cli/workspace", args: ["search", "deploy"], env: { SLACK_TOKEN: null }, files: { ...PROFILES_FILE, "work/.slack-cli/workspace": "  other \n" } },
  { name: "token: profile selected in ~/.slack-cli/workspace", args: ["search", "deploy"], env: { SLACK_TOKEN: null }, files: { ...PROFILES_FILE, ".slack-cli/workspace": "other" } },
  { name: "token: the local lockfile wins over the global one", args: ["search", "deploy"], env: { SLACK_TOKEN: null }, files: { ...PROFILES_FILE, ".slack-cli/workspace": "acme-alice", "work/.slack-cli/workspace": "other" } },
  { name: "token: an empty lockfile is no selection", args: ["search", "deploy"], env: { SLACK_TOKEN: null }, files: { ...PROFILES_FILE, "work/.slack-cli/workspace": " \n", ".slack-cli/workspace": "other" } },
  { name: "token: lockfile names a missing profile", args: ["search", "deploy"], env: { SLACK_TOKEN: null }, files: { ...PROFILES_FILE, "work/.slack-cli/workspace": "gone" }, check: exits(1) },
  { name: "token: global lockfile names a missing profile", args: ["search", "deploy"], env: { SLACK_TOKEN: null }, files: { ...PROFILES_FILE, ".slack-cli/workspace": "gone" }, check: exits(1) },
  { name: "token: SLACK_WORKSPACE", args: ["search", "deploy"], env: { SLACK_TOKEN: null, SLACK_WORKSPACE: "other" }, files: { ...PROFILES_FILE, "work/.slack-cli/workspace": "acme-bot" } },
  { name: "token: SLACK_WORKSPACE names a missing profile", args: ["search", "deploy"], env: { SLACK_TOKEN: null, SLACK_WORKSPACE: "gone" }, files: PROFILES_FILE, check: exits(1) },
  { name: "token: -w picks a profile over SLACK_TOKEN", args: ["search", "deploy", "-w", "other"], files: PROFILES_FILE },
  { name: "token: --workspace=NAME", args: ["search", "deploy", "--workspace=other"], files: PROFILES_FILE },
  { name: "token: --workspace NAME", args: ["search", "--workspace", "other", "deploy"], files: PROFILES_FILE },
  { name: "token: -w names a missing profile", args: ["search", "deploy", "-w", "gone"], files: PROFILES_FILE, check: has("stderr", 'Workspace "gone" not found. Available: acme-bot, acme-alice, other') },
  { name: "token: -w with no profiles at all", args: ["search", "deploy", "-w", "gone"], check: has("stderr", "Available: (none)") },
  {
    name: "token: a user token in the legacy variables, with profiles: warned once", args: ["search", "deploy"],
    env: { SLACK_TOKEN: null, SLACK_MCP_XOXP_TOKEN: "xoxp-legacy" }, files: { ...PROFILES_FILE, ".slack-cli/workspace": "other" }, check: has("stderr", "Warning: SLACK_MCP_XOXP_TOKEN"),
  },
  {
    name: "token: no warning when an .env.local up the tree holds the same legacy token", args: ["search", "deploy"],
    env: { SLACK_TOKEN: null, SLACK_MCP_XOXP_TOKEN: "xoxp-legacy" }, files: { ...PROFILES_FILE, ".slack-cli/workspace": "other", ".env.local": "SLACK_MCP_XOXP_TOKEN=xoxp-legacy\n" },
    check: (o) => expect(o.stderr).toBe(""),
  },
  { name: "token: a bot token in the legacy variables is not warned about", args: ["search", "deploy"], env: { SLACK_TOKEN: null, SLACK_BOT_TOKEN: "xoxb-bot" }, files: { ...PROFILES_FILE, ".slack-cli/workspace": "other" } },
  { name: "token: SLACK_TOKEN in ./.slack-hub/.env.local beats profiles", args: ["search", "deploy"], env: { SLACK_TOKEN: null }, files: { ...PROFILES_FILE, ".slack-cli/workspace": "other", "work/.slack-hub/.env.local": "SLACK_TOKEN=xoxp-walked\n" } },
  { name: "token: SLACK_TOKEN in ~/.env.local, at the top of the walk", args: ["search", "deploy"], env: { SLACK_TOKEN: null }, files: { ...PROFILES_FILE, ".slack-cli/workspace": "other", ".env.local": "SLACK_TOKEN=a\nSLACK_TOKEN=xoxp-last-wins\n" } },
  { name: "token: SLACK_TOKEN in ~/.slack-hub/.env.local", args: ["search", "deploy"], env: { SLACK_TOKEN: null }, files: { ".slack-hub/.env.local": "SLACK_TOKEN=xoxp-global-hub\n" } },
  { name: "token: the legacy ~/.slack-term/.env.local", args: ["search", "deploy"], env: { SLACK_TOKEN: null }, files: { ".slack-term/.env.local": "SLACK_TOKEN=xoxp-global-term\n" } },
  { name: "token: ./.slack-term/.env.local in the walk", args: ["search", "deploy"], env: { SLACK_TOKEN: null }, files: { "work/.slack-term/.env.local": "SLACK_TOKEN=xoxp-walk-term\n" } },
  { name: "token: an empty SLACK_TOKEN= in the walk is skipped", args: ["search", "deploy"], env: { SLACK_TOKEN: null }, files: { "work/.slack-hub/.env.local": "SLACK_TOKEN=\n", ".env.local": "SLACK_TOKEN=xoxp-next\n" } },
  { name: "dotenv: ~/.slack-cli/.env.local is read first, and the first value wins", args: ["search", "deploy"], env: { SLACK_TOKEN: null }, files: { ".slack-cli/.env.local": "SLACK_TOKEN='xoxp-home-local'\n", ".config/slack-cli/.env": "SLACK_TOKEN=xoxp-config\n", "work/.slack-cli/.env.local": "SLACK_TOKEN=xoxp-cwd\n" } },
  { name: "dotenv: ~/.config/slack-cli/.env beats ./.slack-cli/.env.local", args: ["search", "deploy"], env: { SLACK_TOKEN: null }, files: { ".config/slack-cli/.env": "SLACK_TOKEN=xoxp-config\n", "work/.slack-cli/.env.local": "SLACK_TOKEN=xoxp-cwd\n" } },
  { name: "dotenv: comments, spaces, quotes, CRLF", args: ["search", "deploy"], env: { SLACK_TOKEN: null }, files: { ".config/slack-cli/.env": "# comment\n\n  SLACK_TOKEN = \"xoxp-quoted\"  \r\nOTHER='x\n" } },
  { name: "dotenv: a BOM, lines without =, an empty key, `export`", args: ["search", "deploy"], env: { SLACK_TOKEN: null }, files: { "work/.slack-cli/.env.local": "\uFEFFSLACK_TOKEN=xoxp-bom\nBROKEN LINE\n=novalue\nexport SLACK_TOKEN=ignored\n\"\n" } },
  { name: "dotenv: a lone quote is an empty value", args: ["search", "deploy"], env: { SLACK_TOKEN: null, SLACK_MCP_XOXP_TOKEN: "xoxp-legacy" }, files: { ".config/slack-cli/.env": "SLACK_BOT_TOKEN=\"\n" } },
  { name: "dotenv: the shell's variable beats every dotenv file", args: ["search", "deploy"], env: { SLACK_TOKEN: "xoxp-shell" }, files: { ".config/slack-cli/.env": "SLACK_TOKEN=xoxp-config\n" } },
  { name: "dotenv: SLACK_API_BASE from a dotenv file", args: ["search", "deploy"], env: { SLACK_API_BASE: null }, files: { ".config/slack-cli/.env": "SLACK_API_BASE={mock}/api/\n" } },
  { name: "dotenv: SLACK_RATELIMIT_WAIT_SEC from a dotenv file is read too late to count", args: ["search", "deploy"], env: { SLACK_RATELIMIT_WAIT_SEC: null }, files: { ".config/slack-cli/.env": "SLACK_RATELIMIT_WAIT_SEC=0\n" }, fixtures: { ...DEPLOY, "search.messages": { __sequence: [{ __status: 429, __retryAfter: 1, ok: false }, page([])] } }, check: has("stderr", "retry after 1s — waiting") },
  { name: "dotenv: SLACK_WORKSPACE from a dotenv file", args: ["search", "deploy"], env: { SLACK_TOKEN: null }, files: { ...PROFILES_FILE, "work/.slack-cli/.env.local": "SLACK_WORKSPACE=other\n" } },

  // Session tokens (xoxc-) and their cookie.
  { name: "cookie: xoxc- with SLACK_COOKIE", args: ["search", "deploy"], env: { SLACK_TOKEN: "xoxc-session", SLACK_COOKIE: "xoxd-env" } },
  { name: "cookie: xoxc- with the legacy SLACK_MCP_XOXD_COOKIE", args: ["search", "deploy"], env: { SLACK_TOKEN: "xoxc-session", SLACK_MCP_XOXD_COOKIE: "xoxd-legacy" } },
  { name: "cookie: SLACK_COOKIE from the directory walk", args: ["search", "deploy"], env: { SLACK_TOKEN: "xoxc-session" }, files: { "work/.slack-hub/.env.local": "SLACK_COOKIE=xoxd-walked\n" } },
  { name: "cookie: the profile's shared identity cookie", args: ["search", "deploy"], env: { SLACK_TOKEN: null }, files: { ...PROFILES_FILE, ".slack-cli/workspace": "acme-alice" } },
  { name: "cookie: -w picks the profile's cookie", args: ["search", "deploy", "-w", "acme-alice"], files: PROFILES_FILE },
  { name: "cookie: a non-session token sends none", args: ["search", "deploy"], env: { SLACK_TOKEN: "xoxp-user", SLACK_COOKIE: "xoxd-env" } },
  {
    name: "cookie: xoxc- without a cookie, rejected", args: ["search", "deploy"], env: { SLACK_TOKEN: "xoxc-session" },
    fixtures: { "search.messages": { ok: false, error: "invalid_auth" } }, check: has("stderr", "Desktop app token (xoxc-) needs its session cookie"),
  },
  { name: "cookie: xoxc- with a cookie, rejected", args: ["search", "deploy"], env: { SLACK_TOKEN: "xoxc-session", SLACK_COOKIE: "xoxd-stale" }, fixtures: { "search.messages": { ok: false, error: "invalid_auth" } } },

  // Bot tokens: search needs a user token.
  {
    name: "bot token: falls back to the same team's user-token profile", args: ["search", "deploy"],
    env: { SLACK_TOKEN: null }, files: { ...PROFILES_FILE, "work/.slack-cli/workspace": "acme-bot" },
    fixtures: { ...DEPLOY, "search.messages": { __byAuth: { "Bearer xoxb-acme-bot": { ok: false, error: "not_allowed_token_type" }, "*": page(DEPLOY_MATCHES.slice(0, 3)) } } },
    check: has("stderr", 'falling back to profile "acme-alice"'),
  },
  {
    name: "bot token: the fallback fails too", args: ["search", "deploy"],
    env: { SLACK_TOKEN: null }, files: { ...PROFILES_FILE, "work/.slack-cli/workspace": "acme-bot" },
    fixtures: { "search.messages": { __byAuth: { "Bearer xoxb-acme-bot": { ok: false, error: "not_allowed_token_type" }, "*": { ok: false, error: "invalid_auth" } } } },
    check: exits(1),
  },
  {
    name: "bot token: no user-token profile of that team", args: ["search", "deploy"],
    env: { SLACK_TOKEN: "xoxb-unknown" }, files: PROFILES_FILE,
    fixtures: { "search.messages": { ok: false, error: "not_allowed_token_type" } }, check: has("stderr", "search requires a user token"),
  },
  {
    name: "bot token: an error whose text merely contains not_allowed_token_type", args: ["search", "not_allowed_token_type"],
    env: { SLACK_TOKEN: "xoxb-unknown" }, fixtures: { "search.messages": { ok: false, error: "invalid_auth" } }, check: has("stderr", "search requires a user token"),
  },
  { name: "bot token: missing_scope", args: ["search", "deploy"], env: { SLACK_TOKEN: "xoxb-bot" }, fixtures: { "search.messages": { ok: false, error: "missing_scope" } }, check: has("stderr", "lacks the user scope") },
  { name: "bot token: not_allowed_token_type from a user token is a plain error", args: ["search", "deploy"], fixtures: { "search.messages": { ok: false, error: "not_allowed_token_type" } } },

  // Failures.
  {
    name: "error: Slack's error, with the query as URLSearchParams spells it", args: ["search", "a b&c~ü/=+*'()!%"],
    fixtures: { "search.messages": { ok: false, error: "invalid_auth" } }, check: has("stderr", "Slack error on search.messages?query=a+b%26c%7E%C3%BC"),
  },
  { name: "error: a response without `error`", args: ["search", "deploy"], fixtures: { "search.messages": { ok: false } } },
  { name: "error: ok is not exactly true", args: ["search", "deploy"], fixtures: { "search.messages": { ok: "true", messages: { matches: [] } } } },
  { name: "error: on page 2", args: ["search", "deploy", "-n", "10"], fixtures: { ...paged([[pm(1)], [pm(2)]]), "search.messages__count=100&page=2&query=deploy&sort=timestamp&sort_dir=desc": { ok: false, error: "internal_error" } } },
  { name: "error: ratelimited in the body, no waiting allowed", args: ["search", "deploy"], env: { SLACK_RATELIMIT_WAIT_SEC: "0" }, fixtures: { "search.messages": { ok: false, error: "ratelimited" } }, check: has("stderr", "retry after 60s") },
  {
    name: "rate limit: HTTP 429, waited out, then answered", args: ["search", "deploy"],
    fixtures: { ...DEPLOY, "search.messages": { __sequence: [{ __status: 429, __retryAfter: 0, ok: false }, page(DEPLOY_MATCHES.slice(0, 2))] } },
    check: has("stderr", "— waiting"),
  },
  {
    name: "rate limit: Retry-After beyond the budget", args: ["search", "deploy"], env: { SLACK_RATELIMIT_WAIT_SEC: "1" },
    fixtures: { "search.messages": { __status: 429, __retryAfter: 2, ok: false } }, check: has("stderr", "retry after 2s"),
  },
  { name: "rate limit: a Retry-After that is not a number means 60", args: ["search", "deploy"], env: { SLACK_RATELIMIT_WAIT_SEC: "59" }, fixtures: { "search.messages": { __status: 429, __retryAfter: "soon", ok: false } } },
  { name: "rate limit: Retry-After \" 1.9s\" reads as 1", args: ["search", "deploy"], env: { SLACK_RATELIMIT_WAIT_SEC: "0" }, fixtures: { "search.messages": { __status: 429, __retryAfter: " 1.9s", ok: false } } },
  { name: "rate limit: an empty SLACK_RATELIMIT_WAIT_SEC is 0", args: ["search", "deploy"], env: { SLACK_RATELIMIT_WAIT_SEC: "" }, fixtures: { "search.messages": { __status: 429, __retryAfter: 1, ok: false } } },
  { name: "rate limit: an unreadable SLACK_RATELIMIT_WAIT_SEC is 120", args: ["search", "deploy"], env: { SLACK_RATELIMIT_WAIT_SEC: "lots" }, fixtures: { "search.messages": { __status: 429, __retryAfter: 121, ok: false } } },
  {
    name: "rate limit: auth.test throttled — retried, then the cache is skipped", args: ["search", "deploy"], env: { SLACK_RATELIMIT_WAIT_SEC: "0", NODE_ENV: "test" },
    fixtures: { ...ONE(), "auth.test": { __status: 429, __retryAfter: 1, ok: false } }, check: has("stderr", "Warning: Slack rate limit hit on auth.test"),
  },
  {
    name: "rate limit: users.info throttled — the raw id is shown", args: ["search", "deploy"], env: { SLACK_RATELIMIT_WAIT_SEC: "0" },
    fixtures: { ...ONE("hi <@U00000002>"), "users.info__user=U00000001": { __status: 429, __retryAfter: 1, ok: false }, "users.info__user=U00000002": { ok: false, error: "ratelimited" } },
  },

  // The lookup cache (~/.config/slack-cli/cache.json).
  { name: "cache: auth.test fails, so nothing is cached", args: ["search", "deploy"], fixtures: { ...DEPLOY, "auth.test": { ok: false, error: "invalid_auth" } } },
  {
    name: "cache: a fresh entry is used, an expired one is looked up again", args: ["search", "deploy"],
    files: {
      ".config/slack-cli/cache.json": JSON.stringify({
        channels: { "T00000001\t#general": { value: "C00000001", expires: 99999999999999 } },
        users: {
          "T00000001\tU00000001": { value: "alice-cached", expires: 99999999999999 },
          "T00000001\tU00000002": { value: "bob-stale", expires: 1 },
          "T00000002\tU00000003": { value: "other-team", expires: 99999999999999 },
          "T00000001\tU00000004": { value: 4, expires: 99999999999999 },
          "1": { value: "index-like key", expires: 99999999999999.5 },
        },
        extra: true,
      }),
    },
  },
  { name: "cache: a cache.json of another shape", args: ["search", "deploy"], files: { ".config/slack-cli/cache.json": JSON.stringify({ channels: [], users: "x" }) } },
  { name: "cache: a cache.json that is JSON null", args: ["search", "deploy"], files: { ".config/slack-cli/cache.json": "null" } },
  { name: "cache: a handle that is not a string", args: ["search", "deploy"], fixtures: { ...ONE(), "users.info__user=U00000001": user("U00000001", 42) } },
  { name: "cache: a cache.json that cannot be written", args: ["search", "deploy"], files: { ".config/slack-cli/cache.json/": "" } },
];

// Every invocation here must reach the JavaScript exactly as typed. The
// package root's dist/cli.js only prints its arguments.
type Route = Setup & { name: string; args: string[]; native?: false; requests?: "none" | "some" };
const HANDED_BACK: Route[] = [
  { name: "no arguments", args: [] },
  { name: "--help", args: ["--help"] },
  { name: "another command", args: ["news", "--limit", "5"] },
  { name: "a write command", args: ["send", "#general", "hi"] },
  { name: "search without a query", args: ["search"] },
  { name: "search --help", args: ["search", "--help"] },
  { name: "search -h", args: ["search", "q", "-h"] },
  { name: "search with two queries", args: ["search", "a", "b"] },
  { name: "search with an unknown flag", args: ["search", "q", "--bogus"] },
  { name: "search --version", args: ["search", "q", "--version"] },
  { name: "search -n10 (attached value)", args: ["search", "q", "-n10"] },
  { name: "search -n=10", args: ["search", "q", "-n=10"] },
  { name: "search --count abc", args: ["search", "q", "--count", "abc"] },
  { name: "search --count -1", args: ["search", "q", "--count", "-1"] },
  { name: "search --count 1.5", args: ["search", "q", "--count", "1.5"] },
  { name: "search --count 010", args: ["search", "q", "--count", "010"] },
  { name: "search --count with no value", args: ["search", "q", "--count"] },
  { name: "search --count twice", args: ["search", "q", "--count", "5", "--count", "7"] },
  { name: "search --json twice", args: ["search", "q", "--json", "--json"] },
  { name: "search --no-json", args: ["search", "q", "--no-json"] },
  { name: "search --json=false", args: ["search", "q", "--json=false"] },
  { name: "search --asUser", args: ["search", "q", "--asUser"] },
  { name: "search with a dash-led query", args: ["search", "-5"] },
  { name: "search --", args: ["search", "--", "q"] },
  { name: "search -w with no value", args: ["search", "q", "-w"] },
  { name: "search -w with an empty value", args: ["search", "q", "-w", ""] },
  { name: "search -w that names an Object.prototype key", args: ["search", "q", "-w", "constructor"] },
  { name: "a global flag before the command", args: ["-w", "acme", "search", "q"] },
  { name: "an identity", args: ["@alice", "search", "q"] },
  { name: "SLACK_HUB_NO_NATIVE=1", args: ["search", "q"], env: { SLACK_HUB_NO_NATIVE: "1" } },

  // Configuration the Rust does not read: identities and prefixes in settings.yml.
  { name: "a global settings.yml", args: ["search", "q"], files: { ".config/slack-hub/settings.yml": "prefix: \"[x]\"\n" } },
  { name: "a legacy global settings.yml", args: ["search", "q"], files: { ".config/slack-term/settings.yml": "x: 1\n" } },
  { name: "SLACK_HUB_HOME's settings.yml", args: ["search", "q"], env: { SLACK_HUB_HOME: "{home}/hub" }, files: { "hub/settings.yml": "x: 1\n" } },
  { name: "SLACK_HUB_HOME is a file", args: ["search", "q"], env: { SLACK_HUB_HOME: "{home}/hub" }, files: { hub: "not a dir" } },
  { name: "a settings.yml in the nearest .slack-hub/", args: ["search", "q"], files: { "work/.slack-hub/settings.yml": "x: 1\n" } },
  { name: "a settings.yml in a parent's .slack-term/", args: ["search", "q"], files: { ".slack-term/settings.yml": "x: 1\n" } },
  // Files the JavaScript would fail to read, with the runtime's own message.
  { name: "profiles.json that is not JSON", args: ["search", "q"], files: { ".config/slack-cli/profiles.json": "{nope" } },
  { name: "profiles.json without `profiles`", args: ["search", "q"], files: { ".config/slack-cli/profiles.json": "{}" } },
  { name: "profiles.json with a profile without a token", args: ["search", "q"], files: { ".config/slack-cli/profiles.json": JSON.stringify({ profiles: { a: { team: "x" } } }) } },
  { name: "profiles.json that is a directory", args: ["search", "q"], files: { ".config/slack-cli/profiles.json/": "" } },
  { name: "a lockfile that is a directory", args: ["search", "q"], files: { ...PROFILES_FILE, "work/.slack-cli/workspace/": "" } },
  { name: "a dotenv file that is a directory", args: ["search", "q"], files: { ".config/slack-cli/.env/": "" } },
  // Bun reads these from the cwd before the CLI starts, with its own parser.
  { name: "a .env in the cwd", args: ["search", "q"], files: { "work/.env": "SLACK_TOKEN=xoxp-x\n" } },
  { name: "a .env.local in the cwd", args: ["search", "q"], files: { "work/.env.local": "X=1\n" } },
  { name: "a .env.development in the cwd", args: ["search", "q"], files: { "work/.env.development": "X=1\n" } },
  { name: "a .env.production.local in the cwd", args: ["search", "q"], files: { "work/.env.production.local": "X=1\n" } },
  { name: "a .env.test in the cwd", args: ["search", "q"], files: { "work/.env.test": "X=1\n" } },
  { name: "a bunfig.toml in the cwd", args: ["search", "q"], files: { "work/bunfig.toml": "" } },
  { name: "BUN_OPTIONS", args: ["search", "q"], env: { BUN_OPTIONS: "--smol" } },
  { name: "a cache.json that is not JSON", args: ["search", "q"], files: { ".config/slack-cli/cache.json": "{nope" } },
  { name: "HOME unset", args: ["search", "q"], env: { HOME: null } },
  // Responses the JavaScript would fail on with the runtime's own message.
  // Nothing is printed before it, so the JavaScript simply runs the search again.
  { name: "a body that is not JSON", args: ["search", "q"], fixtures: { "search.messages": { __raw: "<html>bad gateway</html>" } }, requests: "some" },
  { name: "a lone surrogate", args: ["search", "q"], fixtures: { "search.messages": { __raw: String.raw`{"ok":true,"messages":{"matches":[{"text":"\ud800"}]}}` } }, requests: "some" },
  { name: "nothing listening", args: ["search", "q"], env: { SLACK_API_BASE: "http://127.0.0.1:1/api" } },
  { name: "an empty SLACK_API_BASE", args: ["search", "q"], env: { SLACK_API_BASE: "" } },
  { name: "`messages` that is a string", args: ["search", "q"], fixtures: { "search.messages": { ok: true, messages: "x" } }, requests: "some" },
  {
    name: "a null block next to rich_text", args: ["search", "q"], requests: "some",
    fixtures: { "search.messages": page([{ text: "a b", blocks: [{ type: "rich_text", elements: [] }, null] }]) },
  },
  {
    name: "an emoji code point past U+10FFFF", args: ["search", "q"], requests: "some",
    fixtures: { "search.messages": page([{ text: "a b", blocks: [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "emoji", name: "x", unicode: "110000" }, { type: "text", text: "\nb" }] }] }] }]) },
  },
  { name: "a mention id a RegExp cannot hold", args: ["search", "q"], fixtures: { "search.messages": page([{ text: "<@U1234567(8>" }]) }, requests: "some" },
];

// With a package root — installed from npm — `search` is still served natively.
const NATIVE_WITH_ROOT: Case[] = [
  { name: "installed: search is native", args: ["search", "deploy"] },
  { name: "installed: search --json is native", args: ["search", "deploy", "--json", "-n", "3"] },
];

// ─────────────────────────────── tests ───────────────────────────────

describe.skipIf(!ENABLED)("parity: TypeScript against Rust", () => {
  for (const c of SEARCH) {
    test(c.name, { timeout: 60_000 }, async () => {
      const tsOut = await run(TS_IMPL, c);
      c.check?.(tsOut);
      expect(tsOut.signal).toBeNull();
      const rsOut = await run(RS_IMPL, c);
      dump(c.name, { ts: tsOut, rs: rsOut });
      expect(rsOut).toEqual(tsOut);
    });
  }
});

describe.skipIf(!ENABLED || SELF)("parity: what the binary hands back to the JavaScript", () => {
  const pkg = (): string => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "slack-parity-pkg-")));
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "slack-hub" }));
    writeFileSync(join(root, "dist", "cli.js"), "console.log(JSON.stringify({ handedBack: process.argv.slice(2) }));\n");
    return root;
  };
  for (const r of HANDED_BACK) {
    test(r.name, { timeout: 60_000 }, async () => {
      const root = pkg();
      try {
        const out = await run(RS_IMPL, r, { SLACK_HUB_PACKAGE_ROOT: root });
        expect({ stdout: out.stdout, stderr: out.stderr, exit: out.exit }).toEqual({ stdout: `${JSON.stringify({ handedBack: r.args })}\n`, stderr: "", exit: 0 });
        if (r.requests === "some") expect(out.requests.length).toBeGreaterThan(0);
        else if (r.fixtures === undefined) expect(out.requests).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
  for (const c of NATIVE_WITH_ROOT) {
    test(c.name, { timeout: 60_000 }, async () => {
      const root = pkg();
      try {
        const tsOut = await run(TS_IMPL, c);
        const rsOut = await run(RS_IMPL, c, { SLACK_HUB_PACKAGE_ROOT: root });
        expect(rsOut).toEqual(tsOut);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

describe.skipIf(ENABLED)("parity (no Rust binary)", () => {
  test.skip("build it with `cargo build --release --manifest-path rs/Cargo.toml`, or set PARITY_SELF=1", () => {});
});
