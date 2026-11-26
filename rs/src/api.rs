//! The Slack Web API as ts/slack.ts calls it: the same request, the same
//! errors (their text carries the query string), the same rate-limit waiting.
//!
//! A transport failure or a body that is not JSON makes the JavaScript print
//! its runtime's own message. Rust cannot reproduce that text, so it reports
//! `Fail::HandBack` and the invocation goes to the JavaScript — which, for a
//! read, simply does it again.

use crate::config::Config;
use crate::{js, out};
use serde_json::Value;

pub enum Fail {
    HandBack,
    /// An Error with this message.
    Error(String),
    /// ts/slack.ts RateLimitError.
    RateLimit { retry_after: f64, method: String },
}

impl Fail {
    /// `e.message`.
    pub fn message(&self) -> String {
        match self {
            Fail::HandBack => String::new(),
            Fail::Error(m) => m.clone(),
            Fail::RateLimit { retry_after, method } => format!("Slack rate limited on {method} — retry after {}s", js::num_to_string(*retry_after)),
        }
    }
}

pub type Res = Result<Value, Fail>;

/// `new URLSearchParams(params).toString()`.
pub fn query_string(params: &[(&str, &str)]) -> String {
    let enc = |s: &str| {
        let mut o = String::new();
        for b in s.bytes() {
            match b {
                b'*' | b'-' | b'.' | b'_' | b'0'..=b'9' | b'A'..=b'Z' | b'a'..=b'z' => o.push(b as char),
                b' ' => o.push('+'),
                _ => o.push_str(&format!("%{b:02X}")),
            }
        }
        o
    };
    params.iter().map(|(k, v)| format!("{}={}", enc(k), enc(v))).collect::<Vec<_>>().join("&")
}

pub struct Api<'a> {
    cfg: &'a Config,
    client: reqwest::blocking::Client,
    /// SLACK_RATELIMIT_WAIT_SEC, read when ts/slack.ts is imported: before the
    /// dotenv files are loaded, so only the process's own environment counts.
    wait_budget: f64,
}

impl<'a> Api<'a> {
    pub fn new(cfg: &'a Config) -> Result<Api<'a>, Fail> {
        let client = reqwest::blocking::Client::builder().build().map_err(|_| Fail::HandBack)?;
        let v = cfg.start_env.get("SLACK_RATELIMIT_WAIT_SEC").map_or(f64::NAN, js::string_to_number);
        let wait_budget = if v.is_finite() && v >= 0.0 { v } else { 120.0 };
        Ok(Api { cfg, client, wait_budget })
    }

    fn base(&self) -> String {
        let b = self.cfg.env.get("SLACK_API_BASE").unwrap_or("https://slack.com/api");
        b.strip_suffix('/').unwrap_or(b).to_string()
    }

    /// ts/slack.ts callOnce for a GET; `method` already carries `?query`.
    fn call_once(&self, token: &str, method: &str, cookie: Option<&str>) -> Res {
        let cookie: Option<String> = if token.starts_with("xoxc-") {
            cookie.map(str::to_string).or_else(|| self.cfg.default_cookie())
        } else {
            None
        };
        let mut req = self.client.get(format!("{}/{method}", self.base())).header("Authorization", format!("Bearer {token}"));
        if let Some(c) = cookie.as_deref().filter(|c| !c.is_empty()) {
            req = req.header("Cookie", format!("d={c}"));
        }
        let res = req.send().map_err(|_| Fail::HandBack)?;
        if res.status().as_u16() == 429 {
            let header = res.headers().get_all("retry-after").iter().map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned()).collect::<Vec<_>>();
            let raw = if header.is_empty() { "60".to_string() } else { header.join(", ") };
            let n = js::parse_int(&raw);
            return Err(Fail::RateLimit { retry_after: if n.is_nan() { 60.0 } else { n }, method: method.to_string() });
        }
        let bytes = res.bytes().map_err(|_| Fail::HandBack)?;
        let text = String::from_utf8_lossy(&bytes);
        // Response.json() decodes UTF-8 the WHATWG way, which drops a BOM.
        let text = text.strip_prefix('\u{FEFF}').unwrap_or(&text);
        let body: Value = serde_json::from_str(text).map_err(|_| Fail::HandBack)?;
        if body.is_null() {
            // `null.ok` is a TypeError in the JavaScript.
            return Err(Fail::HandBack);
        }
        if js::get(Some(&body), "ok") != Some(&Value::Bool(true)) {
            let err = js::coalesce(js::get(Some(&body), "error"), None);
            let err_s = match err {
                None => "unknown".to_string(),
                e => js::to_string(e),
            };
            let is = |s: &str| err == Some(&Value::String(s.to_string()));
            if is("ratelimited") {
                return Err(Fail::RateLimit { retry_after: 60.0, method: method.to_string() });
            }
            if is("invalid_auth") && token.starts_with("xoxc-") && cookie.as_deref().is_none_or(str::is_empty) {
                return Err(Fail::Error(
                    "Desktop app token (xoxc-) needs its session cookie to be accepted by the public Slack API.\nAttach it:  slack auth firefox   (Linux/macOS/Windows)   or   slack auth chrome   (macOS/Linux)\nOr replace the token with an xoxp- user token:\n  slack auth login".into(),
                ));
            }
            if (is("missing_scope") || is("cannot_dm_bot")) && token.starts_with("xoxb-") {
                let why = if is("cannot_dm_bot") {
                    "you're authenticated as a bot, so \"@you\" is the bot itself and it can't DM itself"
                } else {
                    "this bot token lacks the user scope this action needs"
                };
                return Err(Fail::Error(format!(
                    "Slack error on {method}: {err_s} — {why}.\nTailing/DMing people and listing users need a user session, not a bot token.\n  Switch workspace:  slack auth ls   then   slack auth use <name>\n  Or import your Slack desktop session:  slack auth login"
                )));
            }
            return Err(Fail::Error(format!("Slack error on {method}: {err_s}")));
        }
        Ok(body)
    }

    /// ts/slack.ts withRateLimitWait around callOnce.
    pub fn get(&self, token: &str, method: &str, params: &[(&str, &str)], cookie: Option<&str>) -> Res {
        let method = format!("{method}?{}", query_string(params));
        let mut waited = 0.0;
        loop {
            match self.call_once(token, &method, cookie) {
                Err(Fail::RateLimit { retry_after, method: m }) if !(waited + retry_after > self.wait_budget) => {
                    waited += retry_after;
                    let e = Fail::RateLimit { retry_after, method: m };
                    out::err(&format!("slack: {} — waiting", e.message()));
                    out::commit();
                    sleep_ms(retry_after * 1000.0);
                }
                r => return r,
            }
        }
    }

    /// ts/todo.ts withRateLimitRetry: back off and retry a 429 three times.
    pub fn retry<T>(&self, label: &str, mut f: impl FnMut() -> Result<T, Fail>) -> Result<T, Fail> {
        let mut attempt = 0;
        loop {
            match f() {
                Err(Fail::RateLimit { retry_after, .. }) => {
                    if attempt >= 3 {
                        return Err(Fail::Error(format!("Slack rate limit hit on {label} — gave up after 3 retries. Try again in a minute.")));
                    }
                    out::err(&format!("Warning: Slack rate limit hit on {label} — backing off for {}s", js::num_to_string(retry_after)));
                    if !self.cfg.test_env() {
                        sleep_ms(retry_after * 1000.0);
                    }
                }
                r => return r,
            }
            attempt += 1;
        }
    }
}

/// `setTimeout(r, ms)`: a delay under 1 ms (or not a number) is next tick.
fn sleep_ms(ms: f64) {
    if ms >= 1.0 && ms.is_finite() {
        std::thread::sleep(std::time::Duration::from_millis(ms as u64));
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn query_string_is_urlsearchparams() {
        assert_eq!(super::query_string(&[("query", "a b&c~ü/=+*'()!%"), ("page", "1")]), "query=a+b%26c%7E%C3%BC%2F%3D%2B*%27%28%29%21%25&page=1");
        assert_eq!(super::query_string(&[]), "");
    }
}
