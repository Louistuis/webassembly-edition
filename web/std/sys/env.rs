//! Horizon's browser build: environment variables kept in memory, so the
//! game's `HORIZON_*` switches can be set by the page's start-up code.
use crate::collections::BTreeMap;
use crate::ffi::{OsStr, OsString};
use crate::sync::Mutex;
use crate::{fmt, io, vec};

static VARS: Mutex<BTreeMap<OsString, OsString>> = Mutex::new(BTreeMap::new());

pub struct Env(vec::IntoIter<(OsString, OsString)>);

impl fmt::Debug for Env {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_list().entries(self.0.as_slice()).finish()
    }
}

impl Iterator for Env {
    type Item = (OsString, OsString);
    fn next(&mut self) -> Option<(OsString, OsString)> {
        self.0.next()
    }
}

pub fn env() -> Env {
    let vars = VARS.lock().unwrap_or_else(|e| e.into_inner());
    Env(vars.iter().map(|(k, v)| (k.clone(), v.clone())).collect::<vec::Vec<_>>().into_iter())
}

pub fn getenv(key: &OsStr) -> Option<OsString> {
    VARS.lock().unwrap_or_else(|e| e.into_inner()).get(key).cloned()
}

pub unsafe fn setenv(key: &OsStr, value: &OsStr) -> io::Result<()> {
    VARS.lock().unwrap_or_else(|e| e.into_inner()).insert(key.to_owned(), value.to_owned());
    Ok(())
}

pub unsafe fn unsetenv(key: &OsStr) -> io::Result<()> {
    VARS.lock().unwrap_or_else(|e| e.into_inner()).remove(key);
    Ok(())
}
