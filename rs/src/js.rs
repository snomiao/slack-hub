//! The JavaScript semantics the TypeScript CLI's output depends on.
//!
//! A ported command has to print what the TypeScript prints, byte for byte, so
//! wherever the TypeScript lets the language decide — how a number is written,
//! what `Number("…")` makes of a string, which characters `trim()` removes,
//! the key order `JSON.stringify` writes — this module does what the language
//! does. Each function names the JavaScript it stands for.

use serde_json::{Map, Value};

/// `Number.prototype.toString()`: the shortest digits that read back as the
/// same double, written as ECMAScript's Number::toString lays them out.
pub fn num_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    // Rust's `{:e}` writes the shortest round-trip digits: "1.2345e3", "5e-324".
    let sci = format!("{:e}", x.abs());
    let (mantissa, exp) = sci.split_once('e').expect("LowerExp always has an exponent");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exp.parse::<i32>().expect("LowerExp exponent is an integer") + 1;
    let mut out = String::new();
    if x < 0.0 {
        out.push('-');
    }
    if k <= n && n <= 21 {
        out.push_str(&digits);
        out.push_str(&"0".repeat((n - k) as usize));
    } else if 0 < n && n <= 21 {
        out.push_str(&digits[..n as usize]);
        out.push('.');
        out.push_str(&digits[n as usize..]);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        out.push_str(&"0".repeat((-n) as usize));
        out.push_str(&digits);
    } else {
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        let e = n - 1;
        out.push('e');
        out.push(if e >= 0 { '+' } else { '-' });
        out.push_str(&e.abs().to_string());
    }
    out
}

/// `Number.prototype.toFixed(digits)`: rounds the double's exact decimal
/// value half up (ECMAScript picks the larger n on a tie), unlike Rust's
/// `{:.N}`, which rounds half to even.
pub fn to_fixed(x: f64, digits: usize) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.abs() >= 1e21 || x.is_infinite() {
        return num_to_string(x);
    }
    let neg = x < 0.0;
    // Exact: a double has at most 1074 binary fraction digits, so this many
    // decimal places hold its whole expansion and nothing gets rounded.
    let exact = format!("{:.1100}", x.abs());
    let (int_part, frac_part) = exact.split_once('.').expect("fixed precision has a point");
    let mut kept: Vec<u8> = int_part.bytes().chain(frac_part.bytes().take(digits)).collect();
    let next = frac_part.as_bytes().get(digits).copied().unwrap_or(b'0');
    if next >= b'5' {
        let mut i = kept.len();
        loop {
            if i == 0 {
                kept.insert(0, b'1');
                break;
            }
            i -= 1;
            if kept[i] == b'9' {
                kept[i] = b'0';
            } else {
                kept[i] += 1;
                break;
            }
        }
    }
    let s = String::from_utf8(kept).expect("ascii digits");
    let split = s.len() - digits;
    let mut out = String::new();
    if neg {
        out.push('-');
    }
    out.push_str(&s[..split]);
    if digits > 0 {
        out.push('.');
        out.push_str(&s[split..]);
    }
    out
}

/// The characters `String.prototype.trim()` removes, and `/\s/u` matches:
/// WhiteSpace and LineTerminator. Not Rust's `char::is_whitespace`, which
/// adds U+0085 and leaves out U+FEFF.
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{A}' | '\u{B}' | '\u{C}' | '\u{D}' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}'
            | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

/// `String.prototype.trim()`.
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_space)
}

/// `Number(string)`: ECMAScript's StringToNumber.
pub fn string_to_number(s: &str) -> f64 {
    let t = trim(s);
    if t.is_empty() {
        return 0.0;
    }
    let radix = |prefix: &[&str], radix: u32| -> Option<f64> {
        let rest = prefix.iter().find_map(|p| t.strip_prefix(p))?;
        if rest.is_empty() || !rest.chars().all(|c| c.is_digit(radix)) {
            return Some(f64::NAN);
        }
        Some(rest.chars().fold(0.0, |acc, c| acc * radix as f64 + c.to_digit(radix).unwrap() as f64))
    };
    if let Some(v) = radix(&["0x", "0X"], 16).or_else(|| radix(&["0o", "0O"], 8)).or_else(|| radix(&["0b", "0B"], 2)) {
        return v;
    }
    let (sign, body) = match t.as_bytes()[0] {
        b'+' => (1.0, &t[1..]),
        b'-' => (-1.0, &t[1..]),
        _ => (1.0, t),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    if !is_decimal_literal(body) {
        return f64::NAN;
    }
    sign * body.parse::<f64>().unwrap_or(f64::NAN)
}

/// StrUnsignedDecimalLiteral without Infinity: `1`, `1.`, `.5`, `1.5e-3`.
fn is_decimal_literal(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 0;
    let int_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let mut digits = i - int_start;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let frac_start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        digits += i - frac_start;
    }
    if digits == 0 {
        return false;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let exp_start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == exp_start {
            return false;
        }
    }
    i == b.len()
}

/// `parseInt(s, 10)`.
pub fn parse_int(s: &str) -> f64 {
    let t = s.trim_start_matches(is_space);
    let (sign, body) = match t.as_bytes().first() {
        Some(b'+') => (1.0, &t[1..]),
        Some(b'-') => (-1.0, &t[1..]),
        _ => (1.0, t),
    };
    let digits: String = body.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return f64::NAN;
    }
    sign * digits.parse::<f64>().unwrap_or(f64::NAN)
}

/// `Number(value)` for a JSON value; `None` is `undefined`.
pub fn to_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => string_to_number(s),
        Some(v @ Value::Array(_)) => string_to_number(&to_string(Some(v))),
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// `String(value)`, as a template literal writes it; `None` is `undefined`.
pub fn to_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => num_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|e| if e.is_null() { String::new() } else { to_string(Some(e)) })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// JavaScript truthiness; `None` is `undefined`.
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `a ?? b`.
pub fn coalesce<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    match a {
        None | Some(Value::Null) => b,
        some => some,
    }
}

/// `x[key]` where `x` went through the TypeScript's `asRecord`: anything but
/// a plain object reads as `{}`.
pub fn get<'a>(v: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match v {
        Some(Value::Object(m)) => m.get(key),
        _ => None,
    }
}

/// The TypeScript's `asArray`: anything but an array reads as `[]`.
pub fn array(v: Option<&Value>) -> &[Value] {
    match v {
        Some(Value::Array(a)) => a,
        _ => &[],
    }
}

/// `a === b` for two property reads; `None` is `undefined`. Objects and
/// arrays are distinct references, so never equal.
pub fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        _ => false,
    }
}

/// An array index key, which JavaScript objects list first, in numeric order.
fn is_index_key(k: &str) -> bool {
    if k == "0" {
        return true;
    }
    !k.is_empty() && !k.starts_with('0') && k.len() <= 10 && k.bytes().all(|b| b.is_ascii_digit()) && k.parse::<u64>().is_ok_and(|n| n < 4_294_967_295)
}

/// An object's keys in the order JavaScript enumerates them
/// (`Object.keys`, `JSON.stringify`): array indices ascending, then the rest
/// in insertion order.
pub fn key_order(m: &Map<String, Value>) -> Vec<&String> {
    let mut idx: Vec<&String> = m.keys().filter(|k| is_index_key(k)).collect();
    idx.sort_by_key(|k| k.parse::<u64>().unwrap_or(0));
    idx.extend(m.keys().filter(|k| !is_index_key(k)));
    idx
}

/// `JSON.stringify(value, null, 2)`.
pub fn stringify_pretty(v: &Value) -> String {
    let mut out = String::new();
    write_json(&mut out, v, 0);
    out
}

fn write_json(out: &mut String, v: &Value, depth: usize) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            let x = n.as_f64().unwrap_or(f64::NAN);
            out.push_str(&if x.is_finite() { num_to_string(x) } else { "null".into() });
        }
        Value::String(s) => quote(out, s),
        Value::Array(a) => {
            if a.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push_str("[\n");
            for (i, e) in a.iter().enumerate() {
                if i > 0 {
                    out.push_str(",\n");
                }
                indent(out, depth + 1);
                write_json(out, e, depth + 1);
            }
            out.push('\n');
            indent(out, depth);
            out.push(']');
        }
        Value::Object(m) => {
            if m.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push_str("{\n");
            for (i, k) in key_order(m).into_iter().enumerate() {
                if i > 0 {
                    out.push_str(",\n");
                }
                indent(out, depth + 1);
                quote(out, k);
                out.push_str(": ");
                write_json(out, &m[k.as_str()], depth + 1);
            }
            out.push('\n');
            indent(out, depth);
            out.push('}');
        }
    }
}

fn indent(out: &mut String, depth: usize) {
    for _ in 0..depth {
        out.push_str("  ");
    }
}

/// JSON.stringify's QuoteJSONString.
fn quote(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{C}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// A string's length in UTF-16 code units, as `.length` counts it.
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `s.padEnd(n, fill).slice(0, n)` in UTF-16 code units. A surrogate pair cut
/// in half becomes U+FFFD, which is what writing the lone half as UTF-8 gives.
pub fn pad_end_slice(s: &str, n: usize, fill: char) -> String {
    let mut units: Vec<u16> = s.encode_utf16().collect();
    while units.len() < n {
        units.push(fill as u16);
    }
    units.truncate(n);
    String::from_utf16_lossy(&units)
}

/// String.prototype.replace's GetSubstitution for a match without capture
/// groups: `$$`, `$&`, `` $` `` and `$'` are expanded, anything else is kept.
pub fn substitution(replacement: &str, haystack: &str, at: usize, matched: &str) -> String {
    if !replacement.contains('$') {
        return replacement.to_string();
    }
    let mut out = String::new();
    let mut chars = replacement.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '$' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            Some('$') => {
                out.push('$');
                chars.next();
            }
            Some('&') => {
                out.push_str(matched);
                chars.next();
            }
            Some('`') => {
                out.push_str(&haystack[..at]);
                chars.next();
            }
            Some('\'') => {
                out.push_str(&haystack[at + matched.len()..]);
                chars.next();
            }
            _ => out.push('$'),
        }
    }
    out
}

/// `haystack.replaceAll(needle, replacement)` for a string needle.
pub fn replace_all(haystack: &str, needle: &str, replacement: &str) -> String {
    if needle.is_empty() {
        // Not reachable from the callers (their needles are never empty).
        return haystack.to_string();
    }
    let mut out = String::new();
    let mut last = 0;
    for (at, m) in haystack.match_indices(needle) {
        out.push_str(&haystack[last..at]);
        out.push_str(&substitution(replacement, haystack, at, m));
        last = at + m.len();
    }
    out.push_str(&haystack[last..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_print_as_javascript_does() {
        for (x, s) in [
            (1.0, "1"), (1.5, "1.5"), (-0.0, "0"), (1e21, "1e+21"), (1e-7, "1e-7"), (123e-20, "1.23e-18"),
            (12345678901234567890.0, "12345678901234567000"), (0.1, "0.1"), (100.0, "100"), (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"), (-1.25e-5, "-0.0000125"), (0.000001, "0.000001"),
            (123456789012345680000.0, "123456789012345680000"), (1700000000.5, "1700000000.5"),
        ] {
            assert_eq!(num_to_string(x), s, "{x}");
        }
    }

    #[test]
    fn to_fixed_rounds_half_up_on_the_exact_value() {
        assert_eq!(to_fixed(1.25, 1), "1.3");
        assert_eq!(to_fixed(1.35, 1), "1.4");
        assert_eq!(to_fixed(1048575.0 / 1024.0, 1), "1024.0");
        assert_eq!(to_fixed(5.0, 1), "5.0");
        assert_eq!(to_fixed(9.96, 1), "10.0");
        assert_eq!(to_fixed(0.05, 1), "0.1");
    }

    #[test]
    fn number_conversion() {
        assert_eq!(string_to_number(""), 0.0);
        assert_eq!(string_to_number(" 5 "), 5.0);
        assert_eq!(string_to_number("0x10"), 16.0);
        assert_eq!(string_to_number("1e2"), 100.0);
        assert!(string_to_number("inf").is_nan());
        assert!(string_to_number("1_0").is_nan());
        assert_eq!(string_to_number("-Infinity"), f64::NEG_INFINITY);
        assert_eq!(string_to_number(".5"), 0.5);
        assert_eq!(string_to_number("5."), 5.0);
        assert!(string_to_number("-0x10").is_nan());
        assert_eq!(parse_int(" 1.9s"), 1.0);
        assert!(parse_int("soon").is_nan());
    }

    #[test]
    fn replacement_patterns() {
        assert_eq!(replace_all("a<x>b", "<x>", "$&-$$-$`-$'-$1"), "a<x>-$-a-b-$1b");
    }

    #[test]
    fn key_order_puts_indices_first() {
        let v: Value = serde_json::from_str(r#"{"b":1,"2":2,"a":3,"1":4,"01":5,"4294967295":6,"4294967294":7}"#).unwrap();
        let keys: Vec<&str> = key_order(v.as_object().unwrap()).into_iter().map(String::as_str).collect();
        assert_eq!(keys, ["1", "2", "4294967294", "b", "a", "01", "4294967295"]);
    }
}
