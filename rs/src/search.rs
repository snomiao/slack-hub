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
use crate::cli::{self, Kind, Opt, GLOBAL};
use crate::config::Config;
use crate::msgfmt::Fmt;
use crate::{js, out};
use serde_json::{Map, Value};

struct Opts {
    query: String,
    count: usize,
    json: bool,
    workspace: Option<String>,
}

const COUNT: Opt = Opt { names: &["--count", "-n"], kind: Kind::Number };
const JSON: Opt = Opt { names: &["--json"], kind: Kind::Flag };

/// The argument shapes answered natively. `None` hands the invocation back.
fn parse(args: &[String]) -> Option<Opts> {
    let p = cli::parse(args, &[&COUNT, &JSON, &GLOBAL[0], &GLOBAL[1]], 1)?;
    Some(Opts {
        query: p.positionals.into_iter().next()?,
        count: p.values[0].as_deref().map_or(Some(100), |v| v.parse().ok())?,
        json: p.values[1].is_some(),
        workspace: p.values[2].clone(),
    })
}

/// ts/slack.ts searchAll: pages of 100 until `max` matches, the last page or
/// an empty one; the last response, holding every match so far.
fn search_all(api: &Api, token: &str, query: &str, max: usize, cookie: Option<&str>) -> Result<Value, Fail> {
    let mut page = 1;
    let mut all: Vec<Value> = Vec::new();
    let mut last;
    loop {
        let resp = cli::search_page(api, token, query, page, cookie)?;
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
    let cfg = cli::hand_back_on(Config::load(opts.workspace.as_deref()));
    let ws = opts.workspace.as_deref();
    let token = match cli::hand_back_on(cfg.resolve_token(ws)) {
        Ok(t) => t,
        Err(message) => cli::fail(&message),
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
                cli::fail(&msg);
            }
            let Some((name, profile)) = cfg.user_token_profile(&token) else {
                cli::fail("Error: search requires a user token (xoxp-/xoxc-) — the active profile is a bot token (xoxb-), which Slack rejects for search.messages.\n  Add a user-token profile:  slack auth login   (or slack auth login --token <token>)\n  Then select it:            slack auth use <name>   (or pass --workspace <name>)");
            };
            out::err(&format!("Note: search.messages needs a user token — the active profile is a bot token (xoxb-); falling back to profile \"{name}\"."));
            search_token = profile.token;
            search_cookie = profile.cookie;
            match search_all(&api, &search_token, &opts.query, opts.count, search_cookie.as_deref()) {
                Ok(r) => r,
                Err(Fail::HandBack) => out::hand_back(),
                Err(e) => cli::fail(&e.message()),
            }
        }
    };

    if opts.json {
        out::out(&js::stringify_pretty(&resp));
        out::exit(0);
    }
    let matches: Vec<Value> = js::array(js::get(js::get(Some(&resp), "messages"), "matches")).to_vec();
    cli::check_mentions(&matches);
    let mut fmt = Fmt::new(&api, Cache::new(cfg.home().join(".config").join("slack-cli").join("cache.json")));
    let cookie = search_cookie.as_deref();
    for m in &matches {
        let label = cli::channel_label(&mut fmt, &search_token, m, cookie);
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
