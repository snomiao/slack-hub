//! What every native command shares: the argument shapes it takes (a narrow
//! subset of what yargs accepts), the error exit of a yargs command handler,
//! and the steps of reading messages from search.messages.

use crate::api::{Api, Fail};
use crate::config::HandBack;
use crate::msgfmt::{self, Fmt};
use crate::{js, newlines, out};
use serde_json::Value;

pub enum Kind {
    /// A boolean option: `--json`.
    Flag,
    /// A number option, given as a plain decimal: `--count 10`, `--count=10`.
    Number,
    /// A string option: `-w acme`, `--workspace=acme`.
    Name,
}

pub struct Opt {
    pub names: &'static [&'static str],
    pub kind: Kind,
}

/// The global options every command takes (ts/cli.ts main()).
pub const GLOBAL: [Opt; 2] = [Opt { names: &["-w", "--workspace"], kind: Kind::Name }, Opt { names: &["--as-user"], kind: Kind::Flag }];

pub struct Parsed {
    /// One per option, in the order given: its value, `"true"` for a flag.
    pub values: Vec<Option<String>>,
    pub positionals: Vec<String>,
}

/// Parse the arguments after the command name, or `None` for a shape this
/// port does not answer (it is handed back then). Every option at most once;
/// a value never starts with `-`; numbers are plain decimals of up to 9 digits.
pub fn parse(args: &[String], opts: &[&Opt], max_positionals: usize) -> Option<Parsed> {
    let mut values: Vec<Option<String>> = vec![None; opts.len()];
    let mut positionals = Vec::new();
    let valid = |kind: &Kind, v: &str| -> bool {
        match kind {
            Kind::Number => v == "0" || (!v.starts_with('0') && (1..=9).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_digit())),
            Kind::Name => !v.is_empty() && !v.starts_with('-'),
            Kind::Flag => false,
        }
    };
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        let next = args.get(i + 1).map(String::as_str);
        if !a.starts_with('-') {
            if positionals.len() == max_positionals {
                return None;
            }
            positionals.push(a.to_string());
            i += 1;
            continue;
        }
        let (name, inline) = match a.split_once('=') {
            Some((n, v)) if n.starts_with("--") => (n, Some(v)),
            _ => (a, None),
        };
        let k = opts.iter().position(|o| o.names.contains(&name))?;
        if values[k].is_some() {
            return None;
        }
        match (&opts[k].kind, inline) {
            // yargs reads a following `true`/`false` as a boolean flag's value.
            (Kind::Flag, None) if matches!(next, Some("true" | "false")) => return None,
            (Kind::Flag, None) => values[k] = Some("true".into()),
            (Kind::Flag, Some(_)) => return None,
            (kind, Some(v)) => {
                if !valid(kind, v) {
                    return None;
                }
                values[k] = Some(v.to_string());
            }
            (kind, None) => {
                let v = next?;
                if !valid(kind, v) {
                    return None;
                }
                values[k] = Some(v.to_string());
                i += 1;
            }
        }
        i += 1;
    }
    Some(Parsed { values, positionals })
}

pub fn hand_back_on<T>(r: Result<T, HandBack>) -> T {
    r.unwrap_or_else(|HandBack| out::hand_back())
}

/// The error a yargs command handler threw: its message, exit 1.
pub fn fail(message: &str) -> ! {
    out::err(message);
    out::exit(1)
}

/// ts/slack.ts searchPage, with the newline repair at the fetch.
pub fn search_page(api: &Api, token: &str, query: &str, page: usize, cookie: Option<&str>) -> Result<Value, Fail> {
    let page = page.to_string();
    let params = [("query", query), ("sort", "timestamp"), ("sort_dir", "desc"), ("count", "100"), ("page", page.as_str())];
    let mut resp = api.get(token, "search.messages", &params, cookie)?;
    newlines::repair_messages(&mut resp).map_err(|HandBack| Fail::HandBack)?;
    Ok(resp)
}

/// An id the TypeScript would put into a RegExp it cannot build makes it fail
/// there: answered by the JavaScript, before anything is printed here.
pub fn check_mentions(matches: &[Value]) {
    for m in matches {
        let raw = js::get(Some(m), "text").and_then(Value::as_str).map(str::to_string);
        let texts = raw.into_iter().chain(msgfmt::parse_attachments(m).into_iter().map(|a| a.text));
        if texts.flat_map(|t| msgfmt::mention_ids(&t)).any(|id| !msgfmt::regex_safe(&id)) {
            out::hand_back();
        }
    }
}

/// Where a search match was said, as cmdSearch and cmdNews label it: `#chan`,
/// or `@handle` for a DM (looked up when the DM's name is a user id).
pub fn channel_label(fmt: &mut Fmt, token: &str, m: &Value, cookie: Option<&str>) -> String {
    let ch = js::get(Some(m), "channel");
    let is_im = js::get(ch, "is_im") == Some(&Value::Bool(true));
    let raw_name = js::get(ch, "name").and_then(Value::as_str).unwrap_or("dm");
    if is_im && raw_name.starts_with('U') {
        let key = format!("@{raw_name}");
        if !fmt.mem.contains_key(&key) {
            let h = fmt.user_handle(token, raw_name, cookie);
            fmt.mem.insert(key.clone(), h);
        }
        format!("@{}", js::to_string(js::coalesce(fmt.mem.get(&key), Some(&Value::String(raw_name.to_string())))))
    } else if is_im {
        format!("@{raw_name}")
    } else {
        format!("#{raw_name}")
    }
}
