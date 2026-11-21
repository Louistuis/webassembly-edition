//! Horizon's browser build: the command line the page starts the game with
//! (sys/horizon_web.rs), program name first.
use crate::ffi::OsString;
use crate::{fmt, vec};

pub struct Args(vec::IntoIter<OsString>);

pub fn args() -> Args {
    let mut all = vec![OsString::from("/horizon/horizon-client")];
    all.extend(crate::sys::horizon_web::args().into_iter().map(OsString::from));
    Args(all.into_iter())
}

impl fmt::Debug for Args {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_list().entries(self.0.as_slice()).finish()
    }
}

impl Iterator for Args {
    type Item = OsString;

    fn next(&mut self) -> Option<OsString> {
        self.0.next()
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        self.0.size_hint()
    }
}

impl DoubleEndedIterator for Args {
    fn next_back(&mut self) -> Option<OsString> {
        self.0.next_back()
    }
}

impl ExactSizeIterator for Args {
    fn len(&self) -> usize {
        self.0.len()
    }
}
