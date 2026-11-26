//! ts/cache.ts: ~/.config/slack-cli/cache.json, user id → handle (and channel
//! name → id) for an hour, keyed by workspace. Every read and write is
//! fail-soft, as there.

use crate::js;
use serde_json::{json, Map, Value};
use std::path::PathBuf;

const TTL_MS: f64 = 60.0 * 60.0 * 1000.0;

struct Entry {
    value: Value,
    expires: f64,
}

#[derive(Default)]
struct Store {
    channels: Vec<(String, Entry)>,
    users: Vec<(String, Entry)>,
}

pub struct Cache {
    path: PathBuf,
    mem: Option<Store>,
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
}

fn scoped(scope: &Value, key: &str) -> Option<String> {
    js::truthy(Some(scope)).then(|| format!("{}\t{key}", js::to_string(Some(scope))))
}

impl Cache {
    pub fn new(path: PathBuf) -> Cache {
        Cache { path, mem: None }
    }

    fn load(&mut self) -> &mut Store {
        if self.mem.is_none() {
            let mut store = Store::default();
            if let Ok(text) = std::fs::read(&self.path).map(|b| String::from_utf8_lossy(&b).into_owned()) {
                if let Ok(Value::Object(raw)) = serde_json::from_str::<Value>(&text) {
                    for (kind, section) in [("channels", &mut store.channels), ("users", &mut store.users)] {
                        let Some(Value::Object(s)) = raw.get(kind) else { continue };
                        for k in js::key_order(s) {
                            let v = &s[k.as_str()];
                            if let (Some(Value::String(value)), Some(Value::Number(expires))) = (v.get("value"), v.get("expires")) {
                                section.push((k.clone(), Entry { value: Value::String(value.clone()), expires: expires.as_f64().unwrap_or(f64::NAN) }));
                            }
                        }
                    }
                }
            }
            self.mem = Some(store);
        }
        self.mem.as_mut().unwrap()
    }

    /// cacheGet("users", …).
    pub fn get_user(&mut self, scope: &Value, key: &str) -> Option<String> {
        let k = scoped(scope, key)?;
        let users = &mut self.load().users;
        let i = users.iter().position(|(ek, _)| *ek == k)?;
        if users[i].1.expires <= now_ms() {
            users.remove(i);
            return None;
        }
        users[i].1.value.as_str().map(str::to_string)
    }

    /// cacheSet("users", …), then the whole store written back.
    pub fn set_user(&mut self, scope: &Value, key: &str, value: Value) {
        let Some(k) = scoped(scope, key) else { return };
        let expires = now_ms() + TTL_MS;
        let users = &mut self.load().users;
        match users.iter_mut().find(|(ek, _)| *ek == k) {
            Some((_, e)) => *e = Entry { value, expires },
            None => users.push((k, Entry { value, expires })),
        }
        self.persist();
    }

    fn persist(&self) {
        let Some(store) = &self.mem else { return };
        let section = |entries: &[(String, Entry)]| {
            let mut m = Map::new();
            for (k, e) in entries {
                m.insert(k.clone(), json!({ "value": e.value, "expires": e.expires }));
            }
            Value::Object(m)
        };
        let doc = json!({ "channels": section(&store.channels), "users": section(&store.users) });
        if let Some(dir) = self.path.parent() {
            if std::fs::create_dir_all(dir).is_err() {
                return;
            }
        }
        let _ = std::fs::write(&self.path, js::stringify_pretty(&doc) + "\n");
    }
}
