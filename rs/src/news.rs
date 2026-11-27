//! `slack news`: ts/cli.ts cmdNews, as dispatched by the yargs command `news`
//! (with --limit/-l, and the global -w/--workspace and --as-user).
//!
//! The first page of search.messages for `to:me`, cut to --limit, grouped by
//! local day (ts/format.ts dayLabel), each group oldest first, each match one
//! message line. Only the argument shapes and the time zones implemented here
//! run natively; tests/parity.test.ts holds the proof.

use crate::api::Api;
use crate::cache::Cache;
use crate::cli::{self, Kind, Opt, GLOBAL};
use crate::config::{Config, HandBack};
use crate::msgfmt::Fmt;
use crate::{js, out};
use chrono::{Datelike, TimeZone};
use serde_json::Value;

const LIMIT: Opt = Opt { names: &["--limit", "-l"], kind: Kind::Number };

/// A local calendar day as `dateKey` sees it, with what the label needs.
#[derive(PartialEq)]
struct Day {
    year: i32,
    month0: u32,
    day: u32,
    weekday: u32,
}

/// `new Date(ms)` in the local time zone; `None` for an Invalid Date. Only
/// 1970–2099 is answered: older offsets (local mean time and the like) are
/// where the system's tz database and ICU's may disagree.
fn local_day(ms: f64) -> Result<Option<Day>, HandBack> {
    if !ms.is_finite() || ms.abs() > 8.64e15 {
        return Ok(None);
    }
    let t = ms.trunc() as i64;
    if !(0..4_102_444_800_000).contains(&t) {
        return Err(HandBack);
    }
    let d = chrono::Local.timestamp_millis_opt(t).single().ok_or(HandBack)?;
    Ok(Some(Day { year: d.year(), month0: d.month0(), day: d.day(), weekday: d.weekday().num_days_from_sunday() }))
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
}

/// ts/format.ts dayLabel.
fn day_label(epoch_sec: f64) -> Result<String, HandBack> {
    const DAYS: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let now = now_ms();
    let key = local_day(epoch_sec * 1000.0)?;
    let today = local_day(now)?;
    let yesterday = local_day(now - 86_400_000.0)?;
    Ok(match key {
        None => "Invalid Date, Invalid Date NaN".to_string(),
        Some(k) if Some(&k) == today.as_ref() => "Today".to_string(),
        Some(k) if Some(&k) == yesterday.as_ref() => "Yesterday".to_string(),
        Some(k) => format!("{}, {} {:02}", DAYS[k.weekday as usize], MONTHS[k.month0 as usize], k.day),
    })
}

/// The time zone bun would use is the one chrono reads: TZ unset (the
/// system's), `UTC`, or a zone name with a tz database file. bun treats any
/// other TZ (POSIX rules like `EST5EDT`, an unknown name, an empty value) as
/// UTC where chrono would not, and TZ set from a dotenv file reaches bun but
/// not chrono.
fn check_time_zone(cfg: &Config) -> Result<(), HandBack> {
    let start = cfg.start_env.get("TZ");
    if cfg.env.get("TZ") != start || cfg.start_env.get("TZDIR").is_some() {
        return Err(HandBack);
    }
    let Some(tz) = start else { return Ok(()) };
    if cfg!(windows) {
        return Err(HandBack);
    }
    if tz == "UTC" {
        return Ok(());
    }
    let name_ok = tz.contains('/')
        && !tz.starts_with('/')
        && !tz.split('/').any(|p| p.is_empty() || p == "." || p == "..")
        && tz.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'_' | b'-' | b'+'))
        && tz.as_bytes()[0].is_ascii_uppercase();
    if name_ok && std::path::Path::new("/usr/share/zoneinfo").join(tz).is_file() {
        Ok(())
    } else {
        Err(HandBack)
    }
}

pub fn run(args: &[String]) -> ! {
    let Some(p) = cli::parse(&args[1..], &[&LIMIT, &GLOBAL[0], &GLOBAL[1]], 0) else { out::hand_back() };
    let Some(limit) = p.values[0].as_deref().map_or(Some(20usize), |v| v.parse().ok()) else { out::hand_back() };
    let ws = p.values[1].as_deref();
    let cfg = cli::hand_back_on(Config::load(ws));
    cli::hand_back_on(check_time_zone(&cfg));
    let token = match cli::hand_back_on(cfg.resolve_token(ws)) {
        Ok(t) => t,
        Err(message) => cli::fail(&message),
    };
    let api = match Api::new(&cfg) {
        Ok(a) => a,
        Err(_) => out::hand_back(),
    };
    // cmdNews passes no session cookie: a desktop token gets resolveCookie()'s,
    // without --workspace.
    let resp = match cli::search_page(&api, &token, "to:me", 1, None) {
        Ok(r) => r,
        Err(crate::api::Fail::HandBack) => out::hand_back(),
        Err(e) => cli::fail(&e.message()),
    };
    let matches: Vec<Value> = js::array(js::get(js::get(Some(&resp), "messages"), "matches")).iter().take(limit).cloned().collect();
    cli::check_mentions(&matches);
    // Grouped by day before anything is printed, as cmdNews does.
    let mut groups: Vec<(String, Vec<&Value>)> = Vec::new();
    for m in &matches {
        let label = cli::hand_back_on(day_label(js::to_number(js::coalesce(js::get(Some(m), "ts"), Some(&Value::from(0))))));
        match groups.last_mut() {
            Some((l, ms)) if *l == label => ms.push(m),
            _ => groups.push((label, vec![m])),
        }
    }
    let mut fmt = Fmt::new(&api, Cache::new(cfg.home().join(".config").join("slack-cli").join("cache.json")));
    for (gi, (label, msgs)) in groups.iter().enumerate() {
        if gi > 0 {
            out::out("");
        }
        out::out(&format!("  {label}"));
        out::out("  ----------------------------");
        for m in msgs.iter().rev() {
            let ch = cli::channel_label(&mut fmt, &token, m, None);
            let line = fmt.line(&token, m, Some(&ch), None);
            out::out(&line);
        }
    }
    out::exit(0)
}
