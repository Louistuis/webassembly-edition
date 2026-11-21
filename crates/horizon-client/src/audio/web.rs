//! Sound in the browser build (docs/web.md).
//!
//! The page has one thread and its own output (web/page/audio.js): a timer
//! there asks `horizon_audio_mix` for the next samples and schedules them on
//! an AudioContext. Nothing can decode on a worker thread, so sounds wait in
//! a queue that `horizon_audio_pump` works through between frames, a few
//! milliseconds at a time:
//!
//! - short sounds are decoded here, most of them in the call that plays them;
//! - music and records go to the browser's own decoder, off the thread
//!   (`horizonAudio.decode`, answered through `horizon_audio_decoded`), and
//!   are decoded here in steps where the browser cannot.
//!
//! Sound files are fetched from the file host when first asked for (boot.js).
//! A short sound whose file is not there yet is dropped, since it would play
//! late; music waits for its file.
use super::{Decoding, Mixer, Samples, SoundCache, State, attach, mix};
use crate::Result;
use crate::sound_engine::ChannelId;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use wasm_bindgen::prelude::wasm_bindgen;

#[wasm_bindgen]
extern "C" {
    /// Open the page's output; whether the browser has one.
    #[wasm_bindgen(js_namespace = horizonAudio, js_name = start, catch)]
    fn js_start() -> std::result::Result<bool, wasm_bindgen::JsValue>;
    /// Decode an Ogg file with the browser's decoder; whether it took it (the
    /// answer comes through `horizon_audio_decoded`).
    #[wasm_bindgen(js_namespace = horizonAudio, js_name = decode, catch)]
    fn js_decode(job: u32, file: &[u8]) -> std::result::Result<bool, wasm_bindgen::JsValue>;
    /// The same for a file the page still holds, by its path, so its bytes
    /// never enter the game's memory. 1: decoding; 0: the file is on its way;
    /// anything else: not the page's (a resource pack's), read it here.
    #[wasm_bindgen(js_namespace = horizonAudio, js_name = decodeFile, catch)]
    fn js_decode_file(job: u32, path: &str) -> std::result::Result<i32, wasm_bindgen::JsValue>;
}

/// The page's output, open for as long as the page is.
pub struct Stream;

/// What one pump may spend decoding.
const STEP: Duration = Duration::from_micros(2500);
/// How often a file that is still on its way is asked for again.
const RETRY: Duration = Duration::from_millis(250);
/// How long music waits for its file.
const PATIENCE: Duration = Duration::from_secs(120);
/// A short sound not decoded by then is dropped: it would play late.
const LATE: Duration = Duration::from_secs(1);
/// Sounds waiting at once; the oldest goes first past that.
const MAX_JOBS: usize = 96;

/// A sound to decode for a channel waiting on it.
struct Job {
    id: u32,
    /// The cache key of a static sound; a stream has none.
    key: Option<String>,
    file: PathBuf,
    channel: ChannelId,
    looping: bool,
    since: Instant,
    /// The file was not there: ask again then.
    retry: Option<Instant>,
    /// The page gave the file's bytes at least once.
    read: bool,
    /// The browser is decoding it.
    browser: bool,
    /// The browser could not: decode it here.
    here: bool,
    decoding: Option<Decoding>,
}

struct Web {
    mixer: Option<Arc<Mutex<Mixer>>>,
    cache: Option<Arc<Mutex<SoundCache>>>,
    jobs: VecDeque<Job>,
    next: u32,
}
static WEB: Mutex<Web> = Mutex::new(Web {
    mixer: None,
    cache: None,
    jobs: VecDeque::new(),
    next: 0,
});

fn web() -> MutexGuard<'static, Web> {
    WEB.lock().unwrap_or_else(|e| e.into_inner())
}

/// Whether `channel` still waits for its sound (not stopped or released).
fn waiting(mixer: &Mutex<Mixer>, channel: ChannelId) -> bool {
    mixer.lock().is_ok_and(|m| {
        m.channels
            .get(&channel)
            .is_some_and(|c| c.state == State::Initial)
    })
}

fn stop(mixer: &Mutex<Mixer>, channel: ChannelId) {
    if let Ok(mut m) = mixer.lock()
        && let Some(c) = m.channels.get_mut(&channel)
    {
        c.state = State::Stopped;
    }
}

pub fn open(mixer: Arc<Mutex<Mixer>>) -> Result<Stream> {
    match js_start() {
        Ok(true) => {}
        Ok(false) => return Err("this browser has no sound output".into()),
        Err(e) => return Err(format!("the page has no sound output: {e:?}").into()),
    }
    web().mixer = Some(mixer);
    log::info!("Horizon: audio output: the page's (Web Audio)");
    Ok(Stream)
}

/// Decode `file` for `channel` and start it: a static sound (`key`, its cache
/// name) or a stream.
pub fn queue(
    cache: &Arc<Mutex<SoundCache>>,
    key: Option<String>,
    file: PathBuf,
    channel: ChannelId,
    looping: bool,
) {
    {
        let mut web = web();
        web.cache = Some(cache.clone());
        while web.jobs.len() >= MAX_JOBS {
            if let Some(old) = web.jobs.pop_front()
                && let Some(mixer) = &web.mixer
            {
                stop(mixer, old.channel);
            }
        }
        web.next = web.next.wrapping_add(1);
        let id = web.next;
        web.jobs.push_back(Job {
            id,
            key,
            file,
            channel,
            looping,
            since: Instant::now(),
            retry: None,
            read: false,
            browser: false,
            here: false,
            decoding: None,
        });
    }
    // Most short sounds decode within the step: they start with this call.
    pump(STEP);
}

enum Progress {
    Done,
    Waiting,
    OutOfTime,
}

fn advance(
    job: &mut Job,
    mixer: &Arc<Mutex<Mixer>>,
    cache: &Mutex<SoundCache>,
    out_of_time: &dyn Fn() -> bool,
) -> Progress {
    if !waiting(mixer, job.channel) {
        return Progress::Done;
    }
    if job.browser {
        return Progress::Waiting;
    }
    let stream = job.key.is_none();
    if let Some(key) = &job.key
        && let Some(samples) = cache.lock().ok().and_then(|mut c| c.get(key))
    {
        attach(mixer, job.channel, samples, false);
        return Progress::Done;
    }
    if job.decoding.is_none() {
        let now = Instant::now();
        if job.retry.is_some_and(|at| now < at) {
            return Progress::Waiting;
        }
        if !stream && job.since.elapsed() > LATE {
            stop(mixer, job.channel);
            return Progress::Done;
        }
        if stream && !job.here && !job.read {
            match js_decode_file(job.id, &job.file.to_string_lossy()) {
                Ok(1) => {
                    job.browser = true;
                    return Progress::Waiting;
                }
                Ok(0) if job.since.elapsed() < PATIENCE => {
                    job.retry = Some(now + RETRY);
                    return Progress::Waiting;
                }
                Ok(0) => {
                    stop(mixer, job.channel);
                    return Progress::Done;
                }
                _ => {}
            }
        }
        if stream
            && !job.here
            && let Ok(bytes) = std::fs::read(&job.file)
        {
            job.read = true;
            if matches!(js_decode(job.id, &bytes), Ok(true)) {
                job.browser = true;
                return Progress::Waiting;
            }
            job.here = true;
        }
        match Decoding::open(&job.file) {
            Some(decoding) => job.decoding = Some(decoding),
            None => {
                // Listed but not here yet: the page is fetching it.
                let coming = stream
                    && !job.read
                    && job.since.elapsed() < PATIENCE
                    && std::fs::metadata(&job.file).is_ok();
                if coming {
                    job.retry = Some(now + RETRY);
                    return Progress::Waiting;
                }
                stop(mixer, job.channel);
                return Progress::Done;
            }
        }
    }
    let Some(decoding) = job.decoding.as_mut() else {
        return Progress::Waiting;
    };
    if !decoding.step(|| !out_of_time()) {
        return Progress::OutOfTime;
    }
    let Some(decoding) = job.decoding.take() else {
        return Progress::Done;
    };
    let samples: Samples = Some((Arc::new(decoding.mono), decoding.rate));
    if let Some(key) = job.key.take()
        && let Ok(mut c) = cache.lock()
    {
        c.insert(key, samples.clone());
    }
    attach(mixer, job.channel, samples, job.looping);
    Progress::Done
}

/// Work through the queue for at most `budget`: short sounds first.
fn pump(budget: Duration) {
    let Ok(mut web) = WEB.try_lock() else {
        return;
    };
    let web = &mut *web;
    let (Some(mixer), Some(cache)) = (web.mixer.clone(), web.cache.clone()) else {
        return;
    };
    let start = Instant::now();
    let out_of_time = || start.elapsed() >= budget;
    for streams in [false, true] {
        let mut i = 0;
        while i < web.jobs.len() {
            if out_of_time() {
                return;
            }
            if web.jobs[i].key.is_none() != streams {
                i += 1;
                continue;
            }
            match advance(&mut web.jobs[i], &mixer, &cache, &out_of_time) {
                Progress::Done => {
                    web.jobs.remove(i);
                }
                Progress::Waiting => i += 1,
                Progress::OutOfTime => return,
            }
        }
    }
}

/// The page, every few milliseconds: decode what waits.
#[wasm_bindgen]
pub fn horizon_audio_pump() {
    pump(STEP);
}

/// The page's output asks for the next samples: interleaved stereo at `rate`.
#[wasm_bindgen]
pub fn horizon_audio_mix(out: &mut [f32], rate: u32) {
    let mixer = WEB.try_lock().ok().and_then(|web| web.mixer.clone());
    if let Some(mixer) = mixer
        && let Ok(mut m) = mixer.try_lock()
    {
        mix(&mut m, out, 2, rate.max(1));
    } else {
        out.fill(0.0);
    }
}

/// The browser decoded job `job`: mono `samples` at `rate`, or nothing
/// (`rate` 0) when it could not.
#[wasm_bindgen]
pub fn horizon_audio_decoded(job: u32, samples: Vec<f32>, rate: u32) {
    let mut web = web();
    let Some(i) = web.jobs.iter().position(|j| j.id == job && j.browser) else {
        return;
    };
    if rate == 0 || samples.is_empty() {
        web.jobs[i].browser = false;
        web.jobs[i].here = true;
        return;
    }
    if let Some(job) = web.jobs.remove(i)
        && let Some(mixer) = &web.mixer
    {
        attach(
            mixer,
            job.channel,
            Some((Arc::new(samples), rate)),
            job.looping,
        );
    }
}
