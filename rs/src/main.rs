//! slack-hub's `slack` command.
//!
//! Installed from npm, this binary is the command users run. A command runs
//! here once it has been ported and tests/parity.test.ts shows it behaves like
//! the TypeScript; until then it is handed back to the JavaScript the package
//! still ships, so nothing changes for users. See
//! https://github.com/snomiao/rustify/blob/main/docs/porting.md.

mod api;
mod cache;
mod cli;
mod config;
mod js;
mod js_fallback;
mod legacy;
mod msgfmt;
mod newlines;
mod news;
mod out;
mod search;
mod slack;

/// The package's JavaScript entry, relative to the package root: what the
/// published `slack` runs today. That is `bin` (ts/cli.ts, under bun), not
/// `publishConfig.bin` (the bundle dist/cli.js), which npm does not apply.
pub const JS_ENTRY: &str = "ts/cli.ts";

/// `SLACK_HUB_NO_NATIVE=1` hands every command back to the JavaScript: the
/// way out for a user if a ported command misbehaves.
fn native() -> bool {
    std::env::var_os("SLACK_HUB_NO_NATIVE").is_none()
}

fn main() {
    let Ok(args) = std::env::args_os().skip(1).map(|a| a.into_string()).collect::<Result<Vec<String>, _>>() else {
        js_fallback::run(JS_ENTRY)
    };
    match args.first().map(String::as_str) {
        // `slack --version`, answered by the binary itself.
        Some("--version") if args.len() == 1 && native() => println!("{}", env!("CARGO_PKG_VERSION")),
        Some("search") if native() => search::run(&args),
        Some("news") if native() => news::run(&args),
        _ => js_fallback::run(JS_ENTRY),
    }
}
