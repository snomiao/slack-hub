//! ts/newlines.ts: line breaks back for messages Slack stored flattened.
//!
//! Applied to every message of a search response at the fetch, as the
//! TypeScript does, so `--json` prints the repaired text too. Where the
//! TypeScript would throw (a `null` block, an emoji code point past U+10FFFF),
//! this returns `HandBack`.

use crate::config::HandBack;
use crate::js;
use serde_json::Value;

/// A visible character of the blocks, or one of an emoji's spellings.
enum Anchor {
    Char(u32),
    Any(Vec<Vec<u32>>),
}

const ESC: &[(char, &str)] = &[('&', "&amp;"), ('<', "&lt;"), ('>', "&gt;")];

fn emoji_glyphs(unicode: Option<&Value>) -> Result<Vec<Vec<u32>>, HandBack> {
    let Some(Value::String(u)) = unicode else { return Ok(Vec::new()) };
    let valid = !u.is_empty() && u.split('-').all(|h| !h.is_empty() && h.bytes().all(|b| b.is_ascii_hexdigit()));
    if !valid {
        return Ok(Vec::new());
    }
    let mut cps = Vec::new();
    for h in u.split('-') {
        // parseInt(h, 16) is exact up to 2^53; anything past U+10FFFF throws
        // in String.fromCodePoint.
        let v = u64::from_str_radix(h.trim_start_matches('0'), 16).unwrap_or(u64::MAX);
        let v = if h.trim_start_matches('0').is_empty() { 0 } else { v };
        if v > 0x10FFFF {
            return Err(HandBack);
        }
        cps.push(v as u32);
    }
    let bare: Vec<u32> = cps.iter().copied().filter(|c| *c != 0xFE0F).collect();
    let (full, bare) = (code_points(&cps), code_points(&bare));
    Ok(if full == bare { vec![full] } else { vec![full, bare] })
}

/// The code points `[...String.fromCodePoint(...cps)]` yields: a high and a
/// low surrogate given one after the other make one character.
fn code_points(cps: &[u32]) -> Vec<u32> {
    let mut out = Vec::with_capacity(cps.len());
    let mut i = 0;
    while i < cps.len() {
        let c = cps[i];
        if (0xD800..0xDC00).contains(&c) && cps.get(i + 1).is_some_and(|n| (0xDC00..0xE000).contains(n)) {
            out.push(0x10000 + ((c - 0xD800) << 10) + (cps[i + 1] - 0xDC00));
            i += 2;
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

struct Anchors {
    out: Vec<Option<Anchor>>,
}

impl Anchors {
    fn chars(&mut self, s: &str) {
        for ch in s.chars() {
            if ch == '\n' {
                self.out.push(None);
            } else if !js::is_space(ch) {
                match ESC.iter().find(|(c, _)| *c == ch) {
                    Some((_, esc)) => self.out.extend(esc.chars().map(|c| Some(Anchor::Char(c as u32)))),
                    None => self.out.push(Some(Anchor::Char(ch as u32))),
                }
            }
        }
    }

    fn inline(&mut self, e: &Value) -> Result<(), HandBack> {
        if e.is_null() {
            return Err(HandBack);
        }
        let field = |k: &str| js::to_string(Some(js::coalesce(js::get(Some(e), k), Some(&Value::String(String::new()))).unwrap()));
        match js::get(Some(e), "type").and_then(Value::as_str) {
            Some("text") => self.chars(&field("text")),
            Some("link" | "message_mention") => self.chars(&field("url")),
            Some("user") => self.chars(&field("user_id")),
            Some("channel") => self.chars(&field("channel_id")),
            Some("usergroup") => self.chars(&field("usergroup_id")),
            Some("broadcast") => self.chars(&field("range")),
            Some("emoji") => {
                let name: Vec<u32> = format!(":{}:", field("name")).chars().map(|c| c as u32).collect();
                let mut alts = vec![name];
                alts.extend(emoji_glyphs(js::get(Some(e), "unicode"))?);
                let colons: Vec<u32> = "::".chars().map(|c| c as u32).collect();
                alts.retain(|a| *a != colons);
                self.out.push(Some(Anchor::Any(alts)));
            }
            _ => {}
        }
        Ok(())
    }

    fn container(&mut self, b: &Value) -> Result<(), HandBack> {
        if b.is_null() {
            return Err(HandBack);
        }
        let els = js::array(js::get(Some(b), "elements"));
        let t = js::get(Some(b), "type").and_then(Value::as_str);
        if t == Some("rich_text_list") || t == Some("rich_text") {
            for (k, x) in els.iter().enumerate() {
                if k > 0 {
                    self.out.push(None);
                }
                self.container(x)?;
            }
        } else {
            for e in els {
                self.inline(e)?;
            }
        }
        Ok(())
    }
}

fn find(chars: &[u32], a: &Anchor, from: usize) -> Option<(usize, usize)> {
    match a {
        Anchor::Char(c) => (from..chars.len()).find(|&q| chars[q] == *c).map(|q| (q, 1)),
        Anchor::Any(alts) => {
            let mut best: Option<(usize, usize)> = None;
            for alt in alts {
                let mut q = from;
                while q + alt.len() <= chars.len() && best.is_none_or(|(b, _)| q < b) {
                    if alt.iter().enumerate().all(|(k, c)| chars[q + k] == *c) {
                        best = Some((q, alt.len()));
                        break;
                    }
                    q += 1;
                }
            }
            best
        }
    }
}

/// `arr.lastIndexOf(x, fromIndex)`, where a negative fromIndex counts from the end.
fn last_index_of(chars: &[u32], x: u32, from_index: i64) -> i64 {
    let len = chars.len() as i64;
    let start = if from_index < 0 { len + from_index } else { from_index.min(len - 1) };
    let mut k = start;
    while k >= 0 {
        if chars[k as usize] == x {
            return k;
        }
        k -= 1;
    }
    -1
}

fn is_marker(word: &[u32]) -> bool {
    let w: String = word.iter().filter_map(|c| char::from_u32(*c)).collect();
    if matches!(w.as_str(), "-" | "*" | "+" | "•" | "&gt;" | ">") {
        return true;
    }
    let b = w.as_bytes();
    let digits = b.iter().take_while(|c| c.is_ascii_digit()).count();
    (1..=9).contains(&digits) && b.len() == digits + 1 && (b[digits] == b'.' || b[digits] == b')')
}

fn has_type(v: Option<&Value>, t: &str) -> bool {
    js::get(v, "type").and_then(Value::as_str) == Some(t)
}

/// ts/newlines.ts restoreNewlines.
pub fn restore_newlines(text: &str, blocks: Option<&Value>) -> Result<String, HandBack> {
    let Some(Value::Array(blocks)) = blocks else { return Ok(text.to_string()) };
    if text.contains('\n') || !blocks.iter().any(|b| has_type(Some(b), "rich_text")) {
        return Ok(text.to_string());
    }
    let mut a = Anchors { out: Vec::new() };
    for (k, b) in blocks.iter().enumerate() {
        if k > 0 {
            a.out.push(None);
        }
        if b.is_null() {
            return Err(HandBack);
        }
        if has_type(Some(b), "rich_text") {
            a.container(b)?;
        }
    }
    let seq = a.out;
    if !seq.iter().any(Option::is_none) {
        return Ok(text.to_string());
    }
    let mut chars: Vec<u32> = text.chars().map(|c| c as u32).collect();
    let first_elems = js::get(blocks.first(), "elements");
    let last_elems = js::get(blocks.last(), "elements");
    let starts_pre = matches!(first_elems, Some(Value::Array(e)) if has_type(e.first(), "rich_text_preformatted"));
    let ends_pre = matches!(last_elems, Some(Value::Array(e)) if has_type(e.last(), "rich_text_preformatted"));
    let (mut p, mut last, mut pending) = (0usize, -1i64, starts_pre);
    let mut breaks: Vec<(usize, usize)> = Vec::new();
    for anchor in &seq {
        let Some(anchor) = anchor else {
            pending = true;
            continue;
        };
        let Some((q, len)) = find(&chars, anchor, p) else { return Ok(text.to_string()) };
        if pending {
            breaks.push(((last + 1) as usize, q));
            pending = false;
        }
        last = q as i64 + len as i64 - 1;
        p = q + len;
    }
    if (pending || ends_pre) && last >= 0 {
        breaks.push(((last + 1) as usize, chars.len()));
    }
    let (lt, gt, sp, nl) = ('<' as u32, '>' as u32, ' ' as u32, '\n' as u32);
    for (gap_from, to) in breaks {
        let mut k = gap_from;
        if last_index_of(&chars, lt, gap_from as i64 - 1) > last_index_of(&chars, gt, gap_from as i64 - 1) {
            if let Some(close) = (gap_from..chars.len()).find(|&i| chars[i] == gt) {
                if close < to {
                    k = close + 1;
                }
            }
        }
        let mut word: Vec<u32> = Vec::new();
        let mut line_start = gap_from == 0;
        while k < to {
            if chars[k] == sp {
                let mut e = k;
                while e < to && chars[e] == sp {
                    e += 1;
                }
                if line_start && is_marker(&word) {
                    line_start = false;
                } else {
                    let n = if e - k <= 2 { e - k } else { 1 };
                    for c in &mut chars[k..k + n] {
                        *c = nl;
                    }
                    line_start = true;
                }
                word.clear();
                k = e;
            } else {
                word.push(chars[k]);
                k += 1;
            }
        }
    }
    Ok(chars.into_iter().filter_map(char::from_u32).collect())
}

/// ts/slack.ts repairMessages: every message of a history/replies/search
/// response, in place.
pub fn repair_messages(resp: &mut Value) -> Result<(), HandBack> {
    let msgs: &mut Vec<Value> = match resp.get_mut("messages") {
        Some(Value::Array(a)) => a,
        Some(Value::Object(m)) => match m.get_mut("matches") {
            Some(Value::Array(a)) => a,
            _ => return Ok(()),
        },
        _ => return Ok(()),
    };
    for m in msgs.iter_mut() {
        if let Value::Object(r) = m {
            if let Some(Value::String(text)) = r.get("text") {
                let fixed = restore_newlines(text, r.get("blocks"))?;
                r.insert("text".into(), Value::String(fixed));
            }
        }
    }
    Ok(())
}
