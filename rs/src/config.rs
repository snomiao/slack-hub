//! Where the TypeScript finds its configuration and credentials: the
//! environment after the dotenv files (ts/cli.ts loadDotenvFiles), profiles.json
//! and the workspace lockfiles (ts/profiles.ts), and the `.slack-hub/` scope
//! (ts/scope.ts).
//!
//! Some states make the JavaScript fail with its runtime's own words (a
//! profiles.json that is not JSON, a lockfile that is a directory) or depend on
//! files this port does not read (settings.yml, the .env files bun itself loads
//! from the working directory). For those, `Config::load` returns `HandBack`:
//! the invocation goes to the JavaScript, which is exact by definition.

use crate::js;
use serde_json::{Map, Value};
use std::cell::{Cell, RefCell};
use std::path::{Path, PathBuf};

/// The invocation has to be answered by the JavaScript.
#[derive(Debug)]
pub struct HandBack;

/// `process.env`: the environment, then the dotenv files' values for keys it
/// did not have.
pub struct Env {
    vars: Vec<(String, String)>,
}

impl Env {
    fn from_process() -> Env {
        Env {
            vars: std::env::vars_os()
                .map(|(k, v)| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned()))
                .collect(),
        }
    }

    fn same(a: &str, b: &str) -> bool {
        if cfg!(windows) { a.eq_ignore_ascii_case(b) } else { a == b }
    }

    /// `process.env[key]`.
    pub fn get(&self, key: &str) -> Option<&str> {
        self.vars.iter().find(|(k, _)| Env::same(k, key)).map(|(_, v)| v.as_str())
    }

    /// `process.env[key]` when it is truthy (set and not empty).
    pub fn truthy(&self, key: &str) -> Option<&str> {
        self.get(key).filter(|v| !v.is_empty())
    }

    /// `key in process.env`: inherited Object.prototype members count as present.
    fn has(&self, key: &str) -> bool {
        PROTO_KEYS.contains(&key) || self.vars.iter().any(|(k, _)| Env::same(k, key))
    }
}

/// Names every JavaScript object inherits. Looking one of them up in a parsed
/// JSON object finds the inherited member, not "missing".
const PROTO_KEYS: &[&str] = &[
    "__proto__", "constructor", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString",
    "toString", "valueOf", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
];

/// Files bun loads from the working directory before any script runs, with its
/// own parser (variable expansion, `export`, multi-line values).
const BUN_ENV_FILES: &[&str] = &[
    ".env", ".env.local", ".env.development", ".env.production", ".env.test",
    ".env.development.local", ".env.production.local", ".env.test.local", "bunfig.toml",
];

/// One profile of profiles.json, as far as reading a token needs it.
#[derive(Clone)]
pub struct Profile {
    pub token: String,
    pub cookie: Option<String>,
    identity: Option<String>,
    team_id: Option<Value>,
}

pub struct Config {
    /// The environment the process started with (before the dotenv files).
    pub start_env: Env,
    pub env: Env,
    pub cwd: PathBuf,
    /// `os.homedir()`.
    homedir: PathBuf,
    /// Profiles in the order `Object.keys` lists them.
    profiles: Vec<(String, Profile)>,
    /// profiles.json's `users`: identity → shared cookie.
    users: Map<String, Value>,
    warned: Cell<bool>,
    cookie_memo: RefCell<Option<Option<String>>>,
}

fn read_text(path: &Path) -> Result<String, HandBack> {
    std::fs::read(path).map(|b| String::from_utf8_lossy(&b).into_owned()).map_err(|_| HandBack)
}

/// `existsSync`: follows symlinks; a broken one does not exist.
fn exists(path: &Path) -> bool {
    path.exists()
}

/// `fs.readFileSync` would throw on this existing path (a directory, no access).
fn unreadable(path: &Path) -> bool {
    exists(path) && std::fs::File::open(path).and_then(|f| f.metadata()).map_or(true, |m| !m.is_file())
}

fn proto_key(name: &str) -> bool {
    PROTO_KEYS.contains(&name)
}

/// KEY=value lines as both dotenv readers split them; `None` for a line they skip.
fn env_line(raw: &str) -> Option<(&str, &str)> {
    let line = js::trim(raw);
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let eq = line.find('=')?;
    let key = js::trim(&line[..eq]);
    let mut val = js::trim(&line[eq + 1..]);
    if (val.starts_with('"') && val.ends_with('"')) || (val.starts_with('\'') && val.ends_with('\'')) {
        val = if val.len() >= 2 { &val[1..val.len() - 1] } else { "" };
    }
    Some((key, val))
}

/// ts/profiles.ts readEnvFile: every read error is "no values"; a key seen
/// twice keeps its last value.
fn read_env_file(path: &Path) -> Vec<(String, String)> {
    if !exists(path) {
        return Vec::new();
    }
    let Ok(text) = read_text(path) else { return Vec::new() };
    let mut out: Vec<(String, String)> = Vec::new();
    for raw in text.split('\n') {
        if let Some((k, v)) = env_line(raw) {
            match out.iter_mut().find(|(ok, _)| ok == k) {
                Some(e) => e.1 = v.to_string(),
                None => out.push((k.to_string(), v.to_string())),
            }
        }
    }
    out
}

fn first_value(vars: &[(String, String)], keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| vars.iter().find(|(k, v)| k == key && !v.is_empty()).map(|(_, v)| v.clone()))
}

/// ts/brand.ts preferExisting.
fn prefer_existing(path: PathBuf, legacy: PathBuf) -> PathBuf {
    if !exists(&path) && exists(&legacy) { legacy } else { path }
}

impl Config {
    pub fn load(workspace: Option<&str>) -> Result<Config, HandBack> {
        let start_env = Env::from_process();
        // Options bun reads before the script: they can change what runs.
        if start_env.get("BUN_OPTIONS").is_some() {
            return Err(HandBack);
        }
        let homedir = if cfg!(windows) { start_env.truthy("USERPROFILE") } else { start_env.truthy("HOME") }.map(PathBuf::from).ok_or(HandBack)?;
        let cwd = std::env::current_dir().map_err(|_| HandBack)?;
        if BUN_ENV_FILES.iter().any(|f| exists(&cwd.join(f))) {
            return Err(HandBack);
        }
        let mut env = Env { vars: start_env.vars.clone() };
        // ts/cli.ts loadDotenvFiles: the global files, then the project's; the
        // first value of a key wins, and the process's own value beats them all.
        let dotenvs = [
            homedir.join(".slack-cli").join(".env.local"),
            homedir.join(".config/slack-cli").join(".env"),
            cwd.join(".slack-cli").join(".env.local"),
            cwd.join(".env.local"),
            cwd.join(".env"),
        ];
        for path in &dotenvs {
            if !exists(path) {
                continue;
            }
            let text = read_text(path)?;
            for raw in text.split('\n') {
                if let Some((k, v)) = env_line(raw) {
                    if !env.has(k) {
                        env.vars.push((k.to_string(), v.to_string()));
                    }
                }
            }
        }
        let mut cfg = Config {
            start_env,
            env,
            cwd,
            homedir,
            profiles: Vec::new(),
            users: Map::new(),
            warned: Cell::new(false),
            cookie_memo: RefCell::new(None),
        };
        cfg.check_scope()?;
        cfg.load_profiles()?;
        for lock in [cfg.local_lockfile(), cfg.global_lockfile()] {
            if unreadable(&lock) {
                return Err(HandBack);
            }
        }
        if let Some(w) = workspace {
            cfg.lookup(w)?;
        }
        let cache = cfg.home().join(".config").join("slack-cli").join("cache.json");
        if exists(&cache) {
            if let Ok(text) = read_text(&cache) {
                serde_json::from_str::<Value>(&text).map_err(|_| HandBack)?;
            }
        }
        Ok(cfg)
    }

    /// `process.env.HOME || homedir()`.
    pub fn home(&self) -> PathBuf {
        self.env.truthy("HOME").map(PathBuf::from).unwrap_or_else(|| self.homedir.clone())
    }

    /// ts/identity.ts listIdentities reads settings.yml from the nearest
    /// `.slack-hub/` and the global one, with bun's YAML parser, and fails the
    /// command when it cannot. No Rust crate is that parser: hand back whenever
    /// one is there.
    fn check_scope(&self) -> Result<(), HandBack> {
        let global = match self.env.get("SLACK_HUB_HOME").or_else(|| self.env.get("SLACK_TERM_HOME")) {
            Some(h) => PathBuf::from(h),
            None => prefer_existing(self.homedir.join(".config").join("slack-hub"), self.homedir.join(".config").join("slack-term")),
        };
        let mut dirs = vec![global];
        let mut d = self.cwd.as_path();
        loop {
            if let Some(found) = [".slack-hub", ".slack-term"].iter().map(|n| d.join(n)).find(|c| c.is_dir()) {
                dirs.push(found);
                break;
            }
            match d.parent() {
                Some(up) => d = up,
                None => break,
            }
        }
        for dir in dirs {
            match std::fs::metadata(dir.join("settings.yml")) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                _ => return Err(HandBack),
            }
        }
        Ok(())
    }

    fn profiles_path(&self) -> PathBuf {
        self.home().join(".config").join("slack-cli").join("profiles.json")
    }

    fn local_lockfile(&self) -> PathBuf {
        self.cwd.join(".slack-cli").join("workspace")
    }

    fn global_lockfile(&self) -> PathBuf {
        self.home().join(".slack-cli").join("workspace")
    }

    /// profiles.json, accepted only in the shape the TypeScript reads without
    /// tripping over it.
    fn load_profiles(&mut self) -> Result<(), HandBack> {
        let path = self.profiles_path();
        if !exists(&path) {
            return Ok(());
        }
        let text = read_text(&path)?;
        let store: Value = serde_json::from_str(&text).map_err(|_| HandBack)?;
        let Value::Object(top) = store else { return Err(HandBack) };
        let Some(Value::Object(profiles)) = top.get("profiles") else { return Err(HandBack) };
        for name in js::key_order(profiles) {
            let Value::Object(p) = &profiles[name.as_str()] else { return Err(HandBack) };
            let Some(Value::String(token)) = p.get("token") else { return Err(HandBack) };
            let string_or_absent = |k: &str| -> Result<Option<String>, HandBack> {
                match p.get(k) {
                    None => Ok(None),
                    Some(Value::String(s)) => Ok(Some(s.clone())),
                    Some(_) => Err(HandBack),
                }
            };
            let profile = Profile {
                token: token.clone(),
                cookie: string_or_absent("cookie")?,
                identity: string_or_absent("identity")?,
                team_id: p.get("teamId").cloned(),
            };
            self.profiles.push((name.clone(), profile));
        }
        match top.get("users") {
            None | Some(Value::Null) => {}
            Some(Value::Object(users)) => {
                for v in users.values() {
                    if let Value::Object(u) = v {
                        if !matches!(u.get("cookie"), None | Some(Value::String(_))) {
                            return Err(HandBack);
                        }
                    }
                }
                self.users = users.clone();
            }
            Some(_) => return Err(HandBack),
        }
        Ok(())
    }

    /// `profiles[name]`. A name that only an inherited member answers to would
    /// make the TypeScript use `undefined` as the token.
    fn lookup(&self, name: &str) -> Result<Option<&Profile>, HandBack> {
        match self.profiles.iter().find(|(n, _)| n == name) {
            Some((_, p)) => Ok(Some(p)),
            None if proto_key(name) => Err(HandBack),
            None => Ok(None),
        }
    }

    fn names(&self) -> String {
        self.profiles.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>().join(", ")
    }

    /// ts/profiles.ts readLockfile.
    fn read_lockfile(&self, path: &Path) -> Option<String> {
        if !exists(path) {
            return None;
        }
        let text = read_text(path).ok()?;
        let t = js::trim(&text);
        (!t.is_empty()).then(|| t.to_string())
    }

    /// ts/profiles.ts walkDirEnv: from `start` up to $HOME, then the global
    /// ~/.slack-hub/.env.local.
    fn walk_dir_env(&self, keys: &[&str]) -> Option<String> {
        let home = self.home();
        let mut dir = self.cwd.clone();
        loop {
            for f in [dir.join(".slack-hub").join(".env.local"), dir.join(".slack-term").join(".env.local"), dir.join(".env.local")] {
                if let Some(v) = first_value(&read_env_file(&f), keys) {
                    return Some(v);
                }
            }
            if dir.as_os_str() == home.as_os_str() {
                break;
            }
            match dir.parent() {
                Some(up) => dir = up.to_path_buf(),
                None => break,
            }
        }
        let global = prefer_existing(home.join(".slack-hub").join(".env.local"), home.join(".slack-term").join(".env.local"));
        first_value(&read_env_file(&global), keys)
    }

    /// ts/profiles.ts resolveToken. `Err` is the error's message.
    pub fn resolve_token(&self, workspace: Option<&str>) -> Result<Result<String, String>, HandBack> {
        let not_found = |w: &str| format!("Workspace \"{w}\" not found. Available: {}", if self.profiles.is_empty() { "(none)".into() } else { self.names() });
        if let Some(w) = workspace.filter(|w| !w.is_empty()) {
            return Ok(self.lookup(w)?.map(|p| p.token.clone()).ok_or_else(|| not_found(w)));
        }
        if let Some(t) = self.env.truthy("SLACK_TOKEN") {
            return Ok(Ok(t.to_string()));
        }
        let bot = self.env.get("SLACK_BOT_TOKEN");
        let legacy_xoxp = self.env.get("SLACK_MCP_XOXP_TOKEN");
        let legacy = bot.or(legacy_xoxp);
        if let Some(t) = legacy.filter(|t| !t.is_empty()) {
            if self.profiles.is_empty() {
                return Ok(Ok(t.to_string()));
            }
        }
        let legacy_user = [bot, legacy_xoxp].into_iter().flatten().find(|t| !t.is_empty() && !t.starts_with("xoxb-"));
        if let Some(lu) = legacy_user {
            if !self.profiles.is_empty() {
                let env_file = self.walk_dir_env(&["SLACK_BOT_TOKEN", "SLACK_MCP_XOXP_TOKEN"]);
                if env_file.as_deref() != Some(lu) && !self.warned.replace(true) {
                    crate::out::err(
                        "Warning: SLACK_MCP_XOXP_TOKEN / SLACK_BOT_TOKEN is set but workspace profiles exist — using profiles.\n  Migrate to SLACK_TOKEN=... or remove from your shell config.",
                    );
                }
            }
        }
        if let Some(t) = self.walk_dir_env(&["SLACK_TOKEN"]) {
            return Ok(Ok(t));
        }
        if let Some(sel) = self.env.truthy("SLACK_WORKSPACE") {
            return Ok(self.lookup(sel)?.map(|p| p.token.clone()).ok_or_else(|| not_found(sel)));
        }
        if let Some(local) = self.read_lockfile(&self.local_lockfile()) {
            return Ok(self.lookup(&local)?.map(|p| p.token.clone()).ok_or_else(|| format!("Workspace \"{local}\" (from .slack-cli/workspace) not found in profiles.")));
        }
        if let Some(global) = self.read_lockfile(&self.global_lockfile()) {
            return Ok(self.lookup(&global)?.map(|p| p.token.clone()).ok_or_else(|| format!("Workspace \"{global}\" (from ~/.slack-cli/workspace) not found in profiles.")));
        }
        if !self.profiles.is_empty() {
            return Ok(Err(format!(
                "Workspace not selected ({} available).\n  Select locally:  slack auth use <name>          (writes .slack-cli/workspace)\n  Select globally: slack auth use -g <name>       (writes ~/.slack-cli/workspace)",
                self.names()
            )));
        }
        Ok(Err("No Slack token found.\n  Run one of:\n    slack auth login          — interactive wizard (desktop / browser / token / new app)\n    slack auth login chrome   — import workspaces from Chrome (all platforms)\n    slack auth cookie         — attach the xoxd cookie from Chrome (macOS/Windows)\n    slack auth firefox        — attach the xoxd cookie from Firefox (all platforms)\n    slack auth token --token xoxp-...   — paste an existing token\n  Or set SLACK_TOKEN=xoxp-... in .slack-hub/.env.local".into()))
    }

    /// ts/profiles.ts cookieFor: the profile's own cookie, else its identity's.
    fn cookie_for(&self, name: &str) -> Option<String> {
        if name.is_empty() {
            return None;
        }
        let (_, p) = self.profiles.iter().find(|(n, _)| n == name)?;
        if let Some(c) = p.cookie.as_ref().filter(|c| !c.is_empty()) {
            return Some(c.clone());
        }
        let identity = p.identity.as_ref().filter(|i| !i.is_empty())?;
        match self.users.get(identity.as_str()) {
            Some(Value::Object(u)) => u.get("cookie").and_then(Value::as_str).map(str::to_string),
            _ => None,
        }
    }

    /// ts/profiles.ts resolveCookie.
    pub fn resolve_cookie(&self, workspace: Option<&str>) -> Option<String> {
        if let Some(w) = workspace.filter(|w| !w.is_empty()) {
            return self.cookie_for(w);
        }
        if let Some(c) = self.env.truthy("SLACK_COOKIE") {
            return Some(c.to_string());
        }
        if let Some(c) = self.env.truthy("SLACK_MCP_XOXD_COOKIE") {
            return Some(c.to_string());
        }
        if self.env.truthy("SLACK_MCP_XOXP_TOKEN").is_some() && self.profiles.is_empty() {
            return self.env.get("SLACK_MCP_XOXD_COOKIE").map(str::to_string);
        }
        if let Some(c) = self.walk_dir_env(&["SLACK_COOKIE"]) {
            return Some(c);
        }
        if let Some(sel) = self.env.truthy("SLACK_WORKSPACE") {
            return self.cookie_for(sel);
        }
        if let Some(local) = self.read_lockfile(&self.local_lockfile()) {
            return self.cookie_for(&local);
        }
        if let Some(global) = self.read_lockfile(&self.global_lockfile()) {
            return self.cookie_for(&global);
        }
        None
    }

    /// `resolveCookie()` with no workspace, as the HTTP layer calls it for a
    /// session token that came without a cookie. Its inputs do not change
    /// during a run, so it is read once.
    pub fn default_cookie(&self) -> Option<String> {
        self.cookie_memo.borrow_mut().get_or_insert_with(|| self.resolve_cookie(None)).clone()
    }

    /// ts/cli.ts findUserTokenProfile: a user-token profile of the same team as
    /// the bot-token profile in use.
    pub fn user_token_profile(&self, current_token: &str) -> Option<(String, Profile)> {
        let listed: Vec<(String, Profile)> = self
            .profiles
            .iter()
            .map(|(n, p)| {
                let mut p = p.clone();
                if let Some(c) = self.cookie_for(n).filter(|c| !c.is_empty()) {
                    p.cookie = Some(c);
                }
                (n.clone(), p)
            })
            .collect();
        let current = listed.iter().find(|(_, p)| p.token == current_token)?;
        listed
            .iter()
            .find(|(_, p)| (p.token.starts_with("xoxp-") || p.token.starts_with("xoxc-")) && js::strict_eq(p.team_id.as_ref(), current.1.team_id.as_ref()))
            .cloned()
    }

    /// ts/todo.ts isTestEnv: retries back off without sleeping under a test runner.
    pub fn test_env(&self) -> bool {
        self.env.truthy("VITEST").is_some() || self.env.get("NODE_ENV") == Some("test") || self.env.truthy("BUN_TEST").is_some()
    }
}
