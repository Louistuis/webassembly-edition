//! The browser build's stand-in for the parts of `ureq` 2 the game uses
//! (docs/web.md). A page cannot make blocking HTTP requests, so every call
//! fails with [`Error::Transport`]: the callers already treat that as "the
//! service is unavailable" (online-mode join, skins, server packs).
use std::{fmt, io, time::Duration};

#[derive(Debug)]
pub struct Transport;
impl fmt::Display for Transport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("no HTTP in the browser build")
    }
}

#[derive(Debug)]
pub enum Error {
    Status(u16, Response),
    Transport(Transport),
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Status(code, _) => write!(f, "status code {code}"),
            Error::Transport(t) => t.fmt(f),
        }
    }
}
impl std::error::Error for Error {}

#[derive(Debug)]
pub struct Response;
impl Response {
    pub fn into_string(self) -> io::Result<String> {
        Ok(String::new())
    }
    pub fn into_reader(self) -> Box<dyn io::Read + Send + Sync + 'static> {
        Box::new(io::empty())
    }
    pub fn header(&self, _name: &str) -> Option<&str> {
        None
    }
    pub fn status(&self) -> u16 {
        0
    }
}

#[derive(Default)]
pub struct AgentBuilder;
impl AgentBuilder {
    pub fn new() -> Self {
        AgentBuilder
    }
    pub fn timeout(self, _: Duration) -> Self {
        self
    }
    pub fn timeout_read(self, _: Duration) -> Self {
        self
    }
    pub fn timeout_connect(self, _: Duration) -> Self {
        self
    }
    pub fn redirects(self, _: u32) -> Self {
        self
    }
    pub fn user_agent(self, _: &str) -> Self {
        self
    }
    pub fn build(self) -> Agent {
        Agent
    }
}

#[derive(Clone, Default)]
pub struct Agent;
impl Agent {
    pub fn new() -> Self {
        Agent
    }
    pub fn get(&self, _url: &str) -> Request {
        Request
    }
    pub fn post(&self, _url: &str) -> Request {
        Request
    }
}

pub fn get(_url: &str) -> Request {
    Request
}
pub fn post(_url: &str) -> Request {
    Request
}

pub struct Request;
impl Request {
    pub fn set(self, _name: &str, _value: &str) -> Self {
        self
    }
    pub fn timeout(self, _: Duration) -> Self {
        self
    }
    pub fn call(self) -> Result<Response, Error> {
        Err(Error::Transport(Transport))
    }
    pub fn send_string(self, _body: &str) -> Result<Response, Error> {
        Err(Error::Transport(Transport))
    }
    pub fn send_bytes(self, _body: &[u8]) -> Result<Response, Error> {
        Err(Error::Transport(Transport))
    }
}
