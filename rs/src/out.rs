//! stdout and stderr as the TypeScript CLI writes them (ts/stdout.ts), and the
//! hand-back to the JavaScript.
//!
//! - A line is written whole or the process ends: a reader that went away
//!   (EPIPE) exits 141 like a shell's SIGPIPE; any other write error says so on
//!   stderr (for stdout) and exits 1.
//! - On a terminal, stderr looks like bun's `console.error`: red, unless
//!   NO_COLOR is set to something. The JavaScript is started with bun when bun
//!   is installed, and with node (no colour) otherwise.
//! - stderr is held back until the command commits to answering natively.
//!   Until then it may still hand the invocation to the JavaScript, which will
//!   print those lines itself; holding them means they are not printed twice.

use std::cell::RefCell;
use std::io::{IsTerminal, Write};

const EPIPE_EXIT: i32 = 141;

struct State {
    /// Lines for stderr not written yet; `None` once committed.
    held: Option<Vec<String>>,
}

thread_local! {
    static STATE: RefCell<State> = const { RefCell::new(State { held: Some(Vec::new()) }) };
}

fn errno_name(e: &std::io::Error) -> String {
    let name = match e.raw_os_error() {
        Some(5) => "EIO",
        Some(9) => "EBADF",
        Some(22) => "EINVAL",
        Some(27) => "EFBIG",
        Some(28) => "ENOSPC",
        #[cfg(target_os = "linux")]
        Some(122) => "EDQUOT",
        #[cfg(target_os = "macos")]
        Some(69) => "EDQUOT",
        _ => return e.to_string(),
    };
    name.to_string()
}

fn write_all(fd: i32, bytes: &[u8]) {
    let result = if fd == 1 {
        let mut o = std::io::stdout().lock();
        o.write_all(bytes).and_then(|()| o.flush())
    } else {
        let mut e = std::io::stderr().lock();
        e.write_all(bytes).and_then(|()| e.flush())
    };
    if let Err(e) = result {
        if e.kind() == std::io::ErrorKind::BrokenPipe {
            std::process::exit(EPIPE_EXIT);
        }
        if fd != 2 {
            let _ = std::io::stderr().write_all(format!("slack: cannot write output ({}); output is incomplete\n", errno_name(&e)).as_bytes());
        }
        std::process::exit(1);
    }
}

fn bun_on_path() -> bool {
    let Some(path) = std::env::var_os("PATH") else { return false };
    let names: &[&str] = if cfg!(windows) { &["bun.exe", "bun.cmd", "bun"] } else { &["bun"] };
    std::env::split_paths(&path).any(|dir| names.iter().any(|n| dir.join(n).is_file()))
}

fn stderr_text(line: &str) -> String {
    let red = std::io::stderr().is_terminal() && std::env::var_os("NO_COLOR").is_none_or(|v| v.is_empty()) && bun_on_path();
    if red {
        format!("\x1b[0m\x1b[31m{line}\x1b[0m\n")
    } else {
        format!("{line}\n")
    }
}

/// `console.error(line)`.
pub fn err(line: &str) {
    let held = STATE.with(|s| match s.borrow_mut().held.as_mut() {
        Some(h) => {
            h.push(line.to_string());
            true
        }
        None => false,
    });
    if !held {
        write_all(2, stderr_text(line).as_bytes());
    }
}

/// From here on the command answers natively: write what stderr held.
pub fn commit() {
    let held = STATE.with(|s| s.borrow_mut().held.take()).unwrap_or_default();
    for line in held {
        write_all(2, stderr_text(&line).as_bytes());
    }
}

/// `console.log(line)`.
pub fn out(line: &str) {
    commit();
    write_all(1, format!("{line}\n").as_bytes());
}

/// `process.exit(code)`.
pub fn exit(code: i32) -> ! {
    commit();
    std::process::exit(code)
}

/// Hand this invocation to the JavaScript, unchanged. Only before anything
/// reached stdout. What stderr held is dropped, since the JavaScript prints it
/// again; lines already written (a rate-limit wait) will appear twice.
pub fn hand_back() -> ! {
    STATE.with(|s| s.borrow_mut().held = None);
    crate::js_fallback::run(crate::JS_ENTRY)
}
