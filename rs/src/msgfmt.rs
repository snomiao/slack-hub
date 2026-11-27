//! The message line (ts/cli.ts formatMsgLine) and what it is made of: author
//! handles through the two-tier lookup (ts/todo.ts userHandleCached), `<@U…>`
//! mentions and `<!date^…>` markup (ts/format.ts), reactions, files, replies
//! and forwarded messages (ts/attachments.ts).

use crate::api::{Api, Fail};
use crate::cache::Cache;
use crate::js;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};

pub struct Fmt<'a> {
    api: &'a Api<'a>,
    cache: Cache,
    /// ts/todo.ts identityMemo: auth.test per token, kept only when it worked.
    identity: HashMap<String, Value>,
    /// The command's in-process Map: `@U…` → handle, `U…` → display name.
    pub mem: HashMap<String, Value>,
}

fn s(v: &str) -> Value {
    Value::String(v.to_string())
}

/// ts/cli.ts slackTsToIso, in UTC.
pub fn slack_ts_to_iso(ts_raw: &str) -> String {
    let mut parts = ts_raw.split('.');
    let sec = parts.next().unwrap_or("");
    let frac = parts.next().unwrap_or("000000");
    let frac = js::pad_end_slice(frac, 6, '0');
    let ms = js::string_to_number(sec) * 1000.0;
    match utc(ms) {
        None => format!("NaN-NaN-NaNTNaN:NaN:NaN.{frac}"),
        Some(t) => format!("{}-{:02}-{:02}T{:02}:{:02}:{:02}.{frac}", t.year, t.month, t.day, t.hour, t.minute, t.second),
    }
}

pub struct Utc {
    pub year: i64,
    pub month: i64,
    pub day: i64,
    pub hour: i64,
    pub minute: i64,
    pub second: i64,
    /// 0 is Sunday.
    pub weekday: i64,
}

/// `new Date(ms)`'s UTC fields, or `None` for an Invalid Date (TimeClip).
pub fn utc(ms: f64) -> Option<Utc> {
    if !ms.is_finite() || ms.abs() > 8.64e15 {
        return None;
    }
    let t = ms.trunc() as i64;
    let days = t.div_euclid(86_400_000);
    let rem = t.rem_euclid(86_400_000);
    // Days since 1970-01-01 to a civil date (H. Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    Some(Utc {
        year,
        month,
        day,
        hour: rem / 3_600_000,
        minute: rem / 60_000 % 60,
        second: rem / 1000 % 60,
        weekday: (days + 4).rem_euclid(7),
    })
}

/// ts/format.ts resolveDateMarkup: `<!date^EPOCH^{format}|fallback>`.
pub fn resolve_date_markup(text: &str) -> String {
    const DAYS: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let b = text.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while let Some(p) = text[i..].find("<!date^") {
        let start = i + p;
        let mut j = start + 7;
        let digits_start = j;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        let mut found = None;
        if j > digits_start && j < b.len() && b[j] == b'^' {
            let epoch = &text[digits_start..j];
            j += 1;
            while j < b.len() && b[j] != b'|' && b[j] != b'>' {
                j += 1;
            }
            if j < b.len() && b[j] == b'>' {
                found = Some((j + 1, epoch, None));
            } else if j < b.len() && b[j] == b'|' {
                if let Some(g) = text[j + 1..].find('>') {
                    found = Some((j + 1 + g + 1, epoch, Some(&text[j + 1..j + 1 + g])));
                }
            }
        }
        match found {
            Some((end, epoch, fallback)) => {
                out.push_str(&text[i..start]);
                let e = js::string_to_number(epoch);
                let shown = if e.is_finite() { utc(e * 1000.0) } else { None };
                match shown {
                    Some(t) => out.push_str(&format!("{}, {} {:02}, {}", DAYS[t.weekday as usize], MONTHS[(t.month - 1) as usize], t.day, t.year)),
                    None => out.push_str(fallback.unwrap_or("date")),
                }
                i = end;
            }
            None => {
                out.push_str(&text[i..start + 1]);
                i = start + 1;
            }
        }
    }
    out.push_str(&text[i..]);
    out
}

/// The ids resolveMentions finds: whatever follows `<@U` up to `>` or `|`,
/// when it is 9 or more characters long.
pub fn mention_ids(text: &str) -> Vec<String> {
    let mut ids = Vec::new();
    let mut offset = 0;
    while let Some(p) = text[offset..].find("<@U") {
        let pos = offset + p;
        let rest = &text[pos + 2..];
        let uid = rest.find(['>', '|']).map_or(rest, |e| &rest[..e]);
        if js::utf16_len(uid) >= 9 {
            ids.push(uid.to_string());
        }
        offset = pos + 1;
    }
    ids
}

/// An id the TypeScript can put into `new RegExp(...)` as literal text. Any
/// other would throw there or match something else.
pub fn regex_safe(uid: &str) -> bool {
    !uid.contains(['\\', '^', '$', '.', '?', '*', '+', '(', ')', '[', ']', '{', '}'])
}

/// One mention resolved in `text`: `<@UID>` and `<@UID|label>` become `@name`.
fn apply_mention(text: &str, uid: &str, display: &Value) -> String {
    let rep = format!("@{}", js::to_string(Some(display)));
    let text = js::replace_all(text, &format!("<@{uid}>"), &rep);
    // text.replace(new RegExp(`<@${uid}\\|[^>]*>`, "g"), rep)
    let open = format!("<@{uid}|");
    let mut out = String::new();
    let mut i = 0;
    while let Some(p) = text[i..].find(&open) {
        let start = i + p;
        let after = start + open.len();
        let Some(g) = text[after..].find('>') else { break };
        let end = after + g + 1;
        out.push_str(&text[i..start]);
        out.push_str(&js::substitution(&rep, &text, start, &text[start..end]));
        i = end;
    }
    out.push_str(&text[i..]);
    out
}

/// A resolveMentions call in progress.
struct Job {
    text: String,
    ids: Vec<String>,
    next: usize,
}

pub struct Att {
    shared: bool,
    unfurl: bool,
    author_id: Option<String>,
    author_name: Option<String>,
    channel_id: Option<String>,
    ts: Option<String>,
    title: Option<String>,
    pub text: String,
    permalink: Option<String>,
}

/// `str(v) || null`.
fn nonempty(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
}

/// ts/attachments.ts parseAttachments.
pub fn parse_attachments(m: &Value) -> Vec<Att> {
    js::array(js::get(Some(m), "attachments"))
        .iter()
        .map(|a| {
            let a = Some(a);
            let blocks = match js::get(a, "message_blocks") {
                Some(Value::Array(b)) => Some(b),
                _ => None,
            };
            let shared = js::get(a, "is_share") == Some(&Value::Bool(true)) || js::get(a, "is_msg_unfurl") == Some(&Value::Bool(true)) || blocks.is_some();
            let mb = blocks.and_then(|b| b.first());
            let mb_message = js::get(mb, "message");
            let blocks_text = blocks
                .map(|b| b.iter().filter_map(|x| nonempty(js::get(js::get(Some(x), "message"), "text"))).collect::<Vec<_>>().join("\n"))
                .unwrap_or_default();
            let text = [nonempty(js::get(a, "text")), Some(blocks_text).filter(|t| !t.is_empty()), nonempty(js::get(a, "pretext")), nonempty(js::get(a, "fallback"))]
                .into_iter()
                .flatten()
                .next()
                .unwrap_or_default();
            Att {
                shared,
                unfurl: !shared && nonempty(js::get(a, "original_url")).is_some(),
                author_id: nonempty(js::get(a, "author_id")).or_else(|| nonempty(js::get(mb_message, "user"))),
                author_name: nonempty(js::get(a, "author_name")),
                channel_id: nonempty(js::get(a, "channel_id")).or_else(|| nonempty(js::get(mb, "channel"))),
                ts: nonempty(js::get(a, "ts")).or_else(|| nonempty(js::get(mb, "ts"))),
                title: nonempty(js::get(a, "title")),
                text,
                permalink: nonempty(js::get(a, "from_url")).or_else(|| nonempty(js::get(a, "title_link"))).or_else(|| nonempty(js::get(a, "original_url"))),
            }
        })
        .collect()
}

/// ts/attachments.ts attachmentLines.
fn attachment_lines(atts: &[Att]) -> String {
    let mut out = String::new();
    for a in atts.iter().filter(|a| !a.unfurl && (!a.text.is_empty() || a.title.is_some())) {
        let head = if a.shared {
            let mut h = "↪ shared message".to_string();
            if let Some(who) = a.author_name.as_ref().or(a.author_id.as_ref()) {
                h.push_str(&format!(" from @{who}"));
            }
            if let Some(c) = &a.channel_id {
                h.push_str(&format!(" in <#{c}>"));
            }
            if let Some(t) = &a.ts {
                h.push_str(&format!(" · {}", slack_ts_to_iso(t)));
            }
            h
        } else {
            format!("▸ {}", a.title.as_deref().unwrap_or("attachment"))
        };
        out.push_str(&format!("\n   {head}"));
        if !a.text.is_empty() {
            for l in a.text.trim_end_matches('\n').split('\n') {
                out.push_str(&format!("\n     │ {l}"));
            }
        }
        if let Some(p) = &a.permalink {
            out.push_str(&format!("\n     {p}"));
        }
    }
    out
}

/// ts/cli.ts fmtSize.
fn fmt_size(n: f64) -> String {
    if n < 1024.0 {
        format!("{} B", js::num_to_string(n))
    } else if n < 1_048_576.0 {
        format!("{} KB", js::to_fixed(n / 1024.0, 1))
    } else {
        format!("{} MB", js::to_fixed(n / 1_048_576.0, 1))
    }
}

/// `x.length > 0` for a display name of any JSON type.
fn has_length(v: &Value) -> bool {
    match v {
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(_) => js::to_number(js::get(Some(v), "length")) > 0.0,
        _ => false,
    }
}

impl<'a> Fmt<'a> {
    pub fn new(api: &'a Api<'a>, cache: Cache) -> Fmt<'a> {
        Fmt { api, cache, identity: HashMap::new(), mem: HashMap::new() }
    }

    fn users_info(&self, token: &str, uid: &str, cookie: Option<&str>) -> Result<Value, Fail> {
        self.api.get(token, "users.info", &[("user", uid)], cookie)
    }

    /// ts/slack.ts userInfoPair, the handle half: `user.name ?? id`, the id on
    /// any failure.
    pub fn user_handle(&self, token: &str, uid: &str, cookie: Option<&str>) -> Value {
        match self.users_info(token, uid, cookie) {
            Ok(resp) => js::coalesce(js::get(js::get(Some(&resp), "user"), "name"), None).cloned().unwrap_or_else(|| s(uid)),
            Err(_) => s(uid),
        }
    }

    /// ts/slack.ts userName: display name, else real name, else handle, else the id.
    fn user_name(&self, token: &str, uid: &str, cookie: Option<&str>) -> Value {
        let Ok(resp) = self.users_info(token, uid, cookie) else { return s(uid) };
        let user = js::get(Some(&resp), "user");
        if let Some(d) = js::get(js::get(user, "profile"), "display_name") {
            if js::truthy(Some(d)) && has_length(d) {
                return d.clone();
            }
        }
        js::coalesce(js::coalesce(js::get(user, "real_name"), js::get(user, "name")), None).cloned().unwrap_or_else(|| s(uid))
    }

    /// ts/todo.ts cacheScope: the token's team id, or "" when auth.test fails.
    fn cache_scope(&mut self, token: &str, cookie: Option<&str>) -> Value {
        if let Some(t) = self.identity.get(token) {
            return t.clone();
        }
        let api = self.api;
        match api.retry("auth.test", || api.get(token, "auth.test", &[], cookie)) {
            Ok(resp) => {
                let team = js::coalesce(js::get(Some(&resp), "team_id"), None).cloned().unwrap_or_else(|| s(""));
                self.identity.insert(token.to_string(), team.clone());
                team
            }
            Err(_) => s(""),
        }
    }

    /// ts/todo.ts userHandleCached: cache.json, then users.info.
    fn user_handle_cached(&mut self, token: &str, uid: &str, cookie: Option<&str>) -> Value {
        let scope = self.cache_scope(token, cookie);
        if let Some(hit) = self.cache.get_user(&scope, uid) {
            return s(&hit);
        }
        let api = self.api;
        let handle = match api.retry("users.info", || Ok(self.user_handle(token, uid, cookie))) {
            Ok(h) => h,
            Err(_) => s(uid),
        };
        if js::truthy(Some(&handle)) && !js::strict_eq(Some(&handle), Some(&s(uid))) {
            self.cache.set_user(&scope, uid, handle.clone());
        }
        handle
    }

    /// Runs resolveMentions over `texts` at once, as `Promise.all` does: each
    /// call goes until it needs a lookup, then the lookups complete in the
    /// order they were made, each resuming its call.
    fn resolve_mentions_all(&mut self, token: &str, texts: Vec<String>, cookie: Option<&str>) -> Vec<String> {
        let mut jobs: Vec<Job> = texts.into_iter().map(|t| Job { ids: mention_ids(&t), text: t, next: 0 }).collect();
        let mut pending: VecDeque<(usize, String)> = VecDeque::new();
        for i in 0..jobs.len() {
            if let Some(uid) = self.advance(&mut jobs[i]) {
                pending.push_back((i, uid));
            }
        }
        while let Some((i, uid)) = pending.pop_front() {
            let name = self.user_name(token, &uid, cookie);
            self.mem.insert(uid.clone(), name);
            let display = self.mem[&uid].clone();
            let job = &mut jobs[i];
            job.text = apply_mention(&job.text, &uid, &display);
            job.next += 1;
            if let Some(uid) = self.advance(&mut jobs[i]) {
                pending.push_back((i, uid));
            }
        }
        jobs.into_iter().map(|j| j.text).collect()
    }

    /// Resolve from the Map until an id is not in it; that id is returned.
    fn advance(&self, job: &mut Job) -> Option<String> {
        while job.next < job.ids.len() {
            let uid = &job.ids[job.next];
            let Some(display) = self.mem.get(uid) else { return Some(uid.clone()) };
            job.text = apply_mention(&job.text, uid, display);
            job.next += 1;
        }
        None
    }

    /// ts/cli.ts formatMsgLine.
    pub fn line(&mut self, token: &str, m: &Value, ch_label: Option<&str>, cookie: Option<&str>) -> String {
        let m = Some(m);
        let raw_ts = match js::get(m, "ts") {
            Some(Value::String(t)) => t.clone(),
            other => format!("{}.000000", js::num_to_string(js::to_number(js::coalesce(other, Some(&Value::from(0)))))),
        };
        let stamp = slack_ts_to_iso(&raw_ts);
        let handle = if let Some(Value::String(uid)) = js::get(m, "user") {
            let key = format!("@{uid}");
            if !self.mem.contains_key(&key) {
                let h = self.user_handle_cached(token, uid, cookie);
                self.mem.insert(key.clone(), h);
            }
            js::to_string(js::coalesce(self.mem.get(&key), Some(&s(uid))))
        } else if let Some(Value::String(u)) = js::get(m, "username") {
            u.clone()
        } else {
            "?".to_string()
        };
        let raw = js::get(m, "text").and_then(Value::as_str).unwrap_or("").to_string();
        let resolved = resolve_date_markup(&self.resolve_mentions_all(token, vec![raw], cookie).remove(0));
        let mut lines = resolved.split('\n');
        let mut body = lines.next().unwrap_or("").to_string();
        let rest: Vec<String> = lines.map(|l| format!("  {l}")).collect();
        if !rest.is_empty() {
            body.push('\n');
            body.push_str(&rest.join("\n"));
        }
        let who = match ch_label {
            Some(c) => format!("{c}  @{handle}"),
            None => format!("@{handle}"),
        };
        let reactions = js::array(js::get(m, "reactions"))
            .iter()
            .filter_map(|r| {
                let name = js::get(Some(r), "name").and_then(Value::as_str).unwrap_or("");
                let users_len = Value::from(js::array(js::get(Some(r), "users")).len());
                let count = js::to_number(js::coalesce(js::get(Some(r), "count"), Some(&users_len)));
                (!name.is_empty()).then(|| format!(":{name}:×{}", js::num_to_string(count)))
            })
            .collect::<Vec<_>>()
            .join(" ");
        let files: String = js::array(js::get(m, "files"))
            .iter()
            .map(|f| {
                let f = Some(f);
                let name = match (js::get(f, "name"), js::get(f, "title")) {
                    (Some(Value::String(n)), _) => n.clone(),
                    (_, Some(Value::String(t))) => t.clone(),
                    _ => "(file)".to_string(),
                };
                let size = match js::get(f, "size") {
                    Some(Value::Number(n)) => format!("  ({})", fmt_size(n.as_f64().unwrap_or(f64::NAN))),
                    _ => String::new(),
                };
                let id = match js::get(f, "id") {
                    Some(Value::String(i)) => format!("  [{i}]"),
                    _ => String::new(),
                };
                format!("\n   📎 {name}{size}{id}")
            })
            .collect();
        let replies = js::to_number(js::coalesce(js::get(m, "reply_count"), Some(&Value::from(0))));
        let thread_mark = if replies > 0.0 { format!("  [+{} {}]", js::num_to_string(replies), if replies == 1.0 { "reply" } else { "replies" }) } else { String::new() };
        let mut atts = parse_attachments(m.unwrap());
        let with_text: Vec<usize> = (0..atts.len()).filter(|&i| !atts[i].text.is_empty()).collect();
        let texts = with_text.iter().map(|&i| atts[i].text.clone()).collect();
        for (i, t) in with_text.into_iter().zip(self.resolve_mentions_all(token, texts, cookie)) {
            atts[i].text = resolve_date_markup(&t);
        }
        let mut tail = String::new();
        if !reactions.is_empty() {
            tail.push_str(&format!("\n   {reactions}"));
        }
        tail.push_str(&files);
        tail.push_str(&attachment_lines(&atts));
        format!("{stamp}  {who}:  {body}{thread_mark}{tail}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates() {
        assert_eq!(slack_ts_to_iso("1700000000.000100"), "2023-11-14T22:13:20.000100");
        assert_eq!(slack_ts_to_iso("1699800000.5"), "2023-11-12T14:40:00.500000");
        assert_eq!(slack_ts_to_iso("abc.def"), "NaN-NaN-NaNTNaN:NaN:NaN.def000");
        assert_eq!(slack_ts_to_iso("-1"), "1969-12-31T23:59:59.000000");
        assert_eq!(resolve_date_markup("<!date^1700000000^{d}|x> <!date^abc^x|fb> <!date^99999999999999^x|far> <!date^1^x|>"), "Tuesday, Nov 14, 2023 <!date^abc^x|fb> far Thursday, Jan 01, 1970");
    }

    #[test]
    fn mentions() {
        assert_eq!(mention_ids("a <@U00000001> <@U00000002|x> <@U1> <@U0000000X"), ["U00000001", "U00000002", "U0000000X"]);
        assert_eq!(apply_mention("<@U00000001|a <@U00000001|b> c", "U00000001", &s("Al")), "@Al c");
    }
}
