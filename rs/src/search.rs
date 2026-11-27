//! `slack search <query>`: ts/cli.ts cmdSearch, as dispatched by the yargs
//! command `search <query>` (with --count/-n, --json, and the global
//! -w/--workspace and --as-user).
//!
//! Only invocations of a shape implemented here run natively; every other
//! one — a usage error, --help, an option spelled another way, a
//! configuration this port does not read — goes to the JavaScript unchanged.
//! tests/parity.test.ts holds the proof, case by case.

use crate::api::{Api, Fail};
use crate::cache::Cache;
use crate::config::{Config, HandBack};
use crate::msgfmt::{self, Fmt};
use crate::{js, newlines, out};
use serde_json::{Map, Value};

struct Opts {
    query: String,
    count: usize,
    json: bool,
    workspace: Option<String>,
}

/// The argument shapes answered natively. `None` hands the invocation back.
fn parse(args: &[String]) -> Option<Opts> {
    let (mut query, mut count, mut json, mut workspace, mut as_user) = (None, None, false, None, false);
    let count_value = |v: &str| -> Option<usize> {
        let ok = v == "0" || (!v.starts_with('0') && (1..=9).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_digit()));
        ok.then(|| v.parse().ok()).flatten()
    };
    let workspace_value = |v: &str| (!v.is_empty() && !v.starts_with('-')).then(|| v.to_string());
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        let next = args.get(i + 1).map(String::as_str);
        match a {
            // yargs reads a following `true`/`false` as a boolean flag's value.
            "--json" | "--as-user" if matches!(next, Some("true" | "false")) => return None,
            "--json" if !json => json = true,
            "--as-user" if !as_user => as_user = true,
            "--count" | "-n" if count.is_none() => {
                count = Some(count_value(next?)?);
                i += 1;
            }
            "-w" | "--workspace" if workspace.is_none() => {
                workspace = Some(workspace_value(next?)?);
                i += 1;
            }
            _ if a.starts_with("--count=") && count.is_none() => count = Some(count_value(&a[8..])?),
            _ if a.starts_with("--workspace=") && workspace.is_none() => workspace = Some(workspace_value(&a[12..])?),
            _ if a.starts_with('-') => return None,
            _ if query.is_none() => query = Some(a.to_string()),
            _ => return None,
        }
        i += 1;
    }
    Some(Opts { query: query?, count: count.unwrap_or(100), json, workspace })
}

fn hand_back_on<T>(r: Result<T, HandBack>) -> T {
    r.unwrap_or_else(|HandBack| out::hand_back())
}

/// The error a yargs command handler threw: its message, exit 1.
fn fail(message: &str) -> ! {
    out::err(message);
    out::exit(1)
}

/// ts/slack.ts searchPage, with the newline repair at the fetch.
fn search_page(api: &Api, token: &str, query: &str, page: usize, cookie: Option<&str>) -> Result<Value, Fail> {
    let page = page.to_string();
    let params = [("query", query), ("sort", "timestamp"), ("sort_dir", "desc"), ("count", "100"), ("page", page.as_str())];
    let mut resp = api.get(token, "search.messages", &params, cookie)?;
    newlines::repair_messages(&mut resp).map_err(|HandBack| Fail::HandBack)?;
    Ok(resp)
}

/// ts/slack.ts searchAll: pages of 100 until `max` matches, the last page or
/// an empty one; the last response, holding every match so far.
fn search_all(api: &Api, token: &str, query: &str, max: usize, cookie: Option<&str>) -> Result<Value, Fail> {
    let mut page = 1;
    let mut all: Vec<Value> = Vec::new();
    let mut last;
    loop {
        let resp = search_page(api, token, query, page, cookie)?;
        let messages = js::get(Some(&resp), "messages");
        let arr = js::array(js::get(messages, "matches")).to_vec();
        let got = arr.len();
        all.extend(arr);
        let pages = js::to_number(js::coalesce(js::get(js::get(messages, "paging"), "pages"), Some(&Value::from(1))));
        last = resp;
        if got == 0 || page as f64 >= pages || all.len() >= max {
            break;
        }
        page += 1;
    }
    all.truncate(max);
    let Value::Object(obj) = &mut last else { return Err(Fail::HandBack) };
    if !js::truthy(obj.get("messages")) {
        obj.insert("messages".into(), Value::Object(Map::new()));
    }
    match obj.get_mut("messages") {
        Some(Value::Object(m)) => {
            m.insert("matches".into(), Value::Array(all));
        }
        // An array takes the property without showing it; anything else
        // throws a TypeError in the JavaScript.
        Some(Value::Array(_)) => {}
        _ => return Err(Fail::HandBack),
    }
    Ok(last)
}

pub fn run(args: &[String]) -> ! {
    let Some(opts) = parse(&args[1..]) else { out::hand_back() };
    let cfg = hand_back_on(Config::load(opts.workspace.as_deref()));
    let ws = opts.workspace.as_deref();
    let token = match hand_back_on(cfg.resolve_token(ws)) {
        Ok(t) => t,
        Err(message) => fail(&message),
    };
    let cookie = cfg.resolve_cookie(ws);
    let api = match Api::new(&cfg) {
        Ok(a) => a,
        Err(_) => out::hand_back(),
    };

    let mut search_token = token.clone();
    let mut search_cookie = cookie;
    let resp = match search_all(&api, &search_token, &opts.query, opts.count, search_cookie.as_deref()) {
        Ok(r) => r,
        Err(Fail::HandBack) => out::hand_back(),
        Err(e) => {
            let msg = e.message();
            if !(token.starts_with("xoxb-") && msg.contains("not_allowed_token_type")) {
                fail(&msg);
            }
            let Some((name, profile)) = cfg.user_token_profile(&token) else {
                fail("Error: search requires a user token (xoxp-/xoxc-) — the active profile is a bot token (xoxb-), which Slack rejects for search.messages.\n  Add a user-token profile:  slack auth login   (or slack auth login --token <token>)\n  Then select it:            slack auth use <name>   (or pass --workspace <name>)");
            };
            out::err(&format!("Note: search.messages needs a user token — the active profile is a bot token (xoxb-); falling back to profile \"{name}\"."));
            search_token = profile.token;
            search_cookie = profile.cookie;
            match search_all(&api, &search_token, &opts.query, opts.count, search_cookie.as_deref()) {
                Ok(r) => r,
                Err(Fail::HandBack) => out::hand_back(),
                Err(e) => fail(&e.message()),
            }
        }
    };

    if opts.json {
        out::out(&js::stringify_pretty(&resp));
        out::exit(0);
    }
    let matches: Vec<Value> = js::array(js::get(js::get(Some(&resp), "messages"), "matches")).to_vec();
    // An id the TypeScript would put into a RegExp it cannot build: answered
    // there, before anything is printed here.
    for m in &matches {
        let raw = js::get(Some(m), "text").and_then(Value::as_str).map(str::to_string);
        let texts = raw.into_iter().chain(msgfmt::parse_attachments(m).into_iter().map(|a| a.text));
        if texts.flat_map(|t| msgfmt::mention_ids(&t)).any(|id| !msgfmt::regex_safe(&id)) {
            out::hand_back();
        }
    }
    let mut fmt = Fmt::new(&api, Cache::new(cfg.home().join(".config").join("slack-cli").join("cache.json")));
    let cookie = search_cookie.as_deref();
    for m in &matches {
        let ch = js::get(Some(m), "channel");
        let is_im = js::get(ch, "is_im") == Some(&Value::Bool(true));
        let raw_name = js::get(ch, "name").and_then(Value::as_str).unwrap_or("dm");
        let label = if is_im && raw_name.starts_with('U') {
            let key = format!("@{raw_name}");
            if !fmt.mem.contains_key(&key) {
                let h = fmt.user_handle(&search_token, raw_name, cookie);
                fmt.mem.insert(key.clone(), h);
            }
            format!("@{}", js::to_string(js::coalesce(fmt.mem.get(&key), Some(&Value::String(raw_name.to_string())))))
        } else if is_im {
            format!("@{raw_name}")
        } else {
            format!("#{raw_name}")
        };
        let line = fmt.line(&search_token, m, Some(&label), cookie);
        out::out(&line);
    }
    out::exit(0)
}

#[cfg(test)]
mod tests {
    use super::parse;

    fn p(args: &[&str]) -> Option<(String, usize, bool, Option<String>)> {
        let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        parse(&args).map(|o| (o.query, o.count, o.json, o.workspace))
    }

    #[test]
    fn shapes() {
        assert_eq!(p(&["q"]), Some(("q".into(), 100, false, None)));
        assert_eq!(p(&["q", "-n", "5", "--json", "-w", "acme"]), Some(("q".into(), 5, true, Some("acme".into()))));
        assert_eq!(p(&["--count=0", "--workspace=x", "q", "--as-user"]), Some(("q".into(), 0, false, Some("x".into()))));
        assert_eq!(p(&[""]), Some(("".into(), 100, false, None)));
        for bad in [
            &[][..], &["a", "b"], &["-5"], &["q", "-n10"], &["q", "-n=10"], &["q", "--count", "010"], &["q", "--count", "1.5"],
            &["q", "--count"], &["q", "--count", "5", "-n", "6"], &["q", "--json", "--json"], &["--json", "true"], &["q", "--as-user", "false"],
            &["q", "--no-json"], &["q", "-w", ""], &["q", "-w", "-x"], &["--", "q"], &["q", "--help"], &["q", "-h"],
        ] {
            assert_eq!(p(bad), None, "{bad:?}");
        }
    }
}
