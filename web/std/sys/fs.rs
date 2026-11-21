//! Horizon's browser build (docs/web.md): an in-memory file system.
//!
//! The page lists the game files it holds (`horizon_web::manifest`); a listed
//! file's bytes are copied in the first time it is opened. Everything the
//! game writes lives here, and each change is handed to the page
//! (`horizon_web::persist` / `forget`), which keeps the folders it wants
//! (the saves and options) in the browser's storage for the next visit.
//!
//! Relative paths are relative to `CWD`, which `env::current_dir` reports.
use crate::collections::BTreeMap;
use crate::ffi::OsString;
use crate::fmt;
use crate::fs::TryLockError;
use crate::hash::{Hash, Hasher};
use crate::io::{self, BorrowedCursor, IoSlice, IoSliceMut, SeekFrom};
use crate::path::{Component, Path, PathBuf};
use crate::string::String;
use crate::sync::{Arc, Mutex, MutexGuard};
pub use crate::sys::fs::common::Dir;
use crate::sys::horizon_web;
use crate::sys::time::SystemTime;
use crate::vec::{self, Vec};

/// The working directory the page starts the game in.
pub const CWD: &str = "/horizon";

struct Data {
    /// The file's path, for loading it from the page and persisting it.
    path: String,
    /// `None` while the bytes are still the page's.
    bytes: Option<Vec<u8>>,
    size: u64,
    modified: SystemTime,
}

impl Data {
    fn load(&mut self) -> io::Result<&mut Vec<u8>> {
        if self.bytes.is_none() {
            let bytes = horizon_web::load(&self.path).ok_or_else(|| {
                io::const_error!(io::ErrorKind::NotFound, "the page could not give this file")
            })?;
            self.size = bytes.len() as u64;
            self.bytes = Some(bytes);
        }
        Ok(self.bytes.as_mut().unwrap())
    }
    fn persist(&mut self) {
        if self.load().is_ok()
            && let Some(bytes) = &self.bytes
        {
            horizon_web::persist(&self.path, bytes);
        }
    }
}

enum Node {
    Dir { modified: SystemTime },
    File(Arc<Mutex<Data>>),
}

struct Tree {
    nodes: BTreeMap<String, Node>,
}

static TREE: Mutex<Option<Tree>> = Mutex::new(None);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The tree, built from the page's manifest on first use.
fn tree() -> MutexGuard<'static, Option<Tree>> {
    let mut guard = lock(&TREE);
    if guard.is_none() {
        let mut tree = Tree { nodes: BTreeMap::new() };
        let now = SystemTime::now();
        tree.nodes.insert(String::from("/"), Node::Dir { modified: now });
        tree.mkdirs(CWD, now);
        tree.mkdirs("/tmp", now);
        let manifest = horizon_web::manifest();
        for line in manifest.split(|b| *b == b'\n') {
            let Ok(line) = crate::str::from_utf8(line) else { continue };
            let Some((path, size)) = line.split_once('\t') else { continue };
            let key = key(Path::new(path));
            // A folder (one the game made, kept by the page) ends with a separator.
            if path.ends_with('/') {
                tree.mkdirs(&key, now);
                continue;
            }
            if key == "/" {
                continue;
            }
            tree.mkdirs(parent(&key), now);
            let size = size.trim().parse().unwrap_or(0);
            let data = Data { path: key.clone(), bytes: None, size, modified: now };
            tree.nodes.insert(key, Node::File(Arc::new(Mutex::new(data))));
        }
        *guard = Some(tree);
    }
    guard
}

impl Tree {
    /// Creates `dir` and its missing parents (the manifest's folders).
    fn mkdirs(&mut self, dir: &str, now: SystemTime) {
        if dir == "/" || self.nodes.contains_key(dir) {
            return;
        }
        self.mkdirs(parent(dir), now);
        self.nodes.insert(String::from(dir), Node::Dir { modified: now });
    }
    fn is_dir(&self, key: &str) -> bool {
        matches!(self.nodes.get(key), Some(Node::Dir { .. }))
    }
    /// The keys under `dir` (all depths), in order.
    fn below(&self, dir: &str) -> Vec<String> {
        let prefix = if dir == "/" { String::from("/") } else { format!("{dir}/") };
        self.nodes
            .range(prefix.clone()..)
            .take_while(|(k, _)| k.starts_with(&prefix))
            .filter(|(k, _)| k.as_str() != "/")
            .map(|(k, _)| k.clone())
            .collect()
    }
}

/// `path` made absolute against `CWD`, with `.` and `..` resolved and no
/// trailing separator: the tree's key.
fn key(path: &Path) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !path.has_root() {
        for part in CWD.split('/').filter(|p| !p.is_empty()) {
            parts.push(String::from(part));
        }
    }
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => parts.clear(),
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop();
            }
            Component::Normal(name) => {
                parts.push(name.to_string_lossy().into_owned());
            }
        }
    }
    let mut out = String::new();
    for part in parts {
        out.push('/');
        out.push_str(&part);
    }
    if out.is_empty() { String::from("/") } else { out }
}

fn parent(key: &str) -> &str {
    match key.rfind('/') {
        Some(0) | None => "/",
        Some(i) => &key[..i],
    }
}

fn not_found() -> io::Error {
    io::const_error!(io::ErrorKind::NotFound, "no such file or directory")
}

fn attr_of(node: &Node) -> FileAttr {
    match node {
        Node::Dir { modified } => {
            FileAttr { kind: FileType { dir: true }, size: 0, modified: *modified }
        }
        Node::File(data) => {
            let data = lock(data);
            FileAttr { kind: FileType { dir: false }, size: data.size, modified: data.modified }
        }
    }
}

#[derive(Clone)]
pub struct FileAttr {
    kind: FileType,
    size: u64,
    modified: SystemTime,
}

#[derive(Clone, Debug)]
pub struct OpenOptions {
    read: bool,
    write: bool,
    append: bool,
    truncate: bool,
    create: bool,
    create_new: bool,
}

#[derive(Copy, Clone, Debug, Default)]
pub struct FileTimes {}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct FilePermissions {
    readonly: bool,
}

#[derive(Copy, Clone, PartialEq, Eq, Hash, Debug)]
pub struct FileType {
    dir: bool,
}

#[derive(Debug)]
pub struct DirBuilder {}

impl FileAttr {
    pub fn size(&self) -> u64 {
        self.size
    }

    pub fn perm(&self) -> FilePermissions {
        FilePermissions { readonly: false }
    }

    pub fn file_type(&self) -> FileType {
        self.kind
    }

    pub fn modified(&self) -> io::Result<SystemTime> {
        Ok(self.modified)
    }

    pub fn accessed(&self) -> io::Result<SystemTime> {
        Ok(self.modified)
    }

    pub fn created(&self) -> io::Result<SystemTime> {
        Ok(self.modified)
    }
}

impl FilePermissions {
    pub fn readonly(&self) -> bool {
        self.readonly
    }

    pub fn set_readonly(&mut self, readonly: bool) {
        self.readonly = readonly;
    }
}

impl FileTimes {
    pub fn set_accessed(&mut self, _t: SystemTime) {}
    pub fn set_modified(&mut self, _t: SystemTime) {}
}

impl FileType {
    pub fn is_dir(&self) -> bool {
        self.dir
    }

    pub fn is_file(&self) -> bool {
        !self.dir
    }

    pub fn is_symlink(&self) -> bool {
        false
    }
}

pub struct ReadDir(vec::IntoIter<DirEntry>);

impl fmt::Debug for ReadDir {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ReadDir").finish_non_exhaustive()
    }
}

impl Iterator for ReadDir {
    type Item = io::Result<DirEntry>;

    fn next(&mut self) -> Option<io::Result<DirEntry>> {
        self.0.next().map(Ok)
    }
}

pub struct DirEntry {
    path: PathBuf,
    name: OsString,
    attr: FileAttr,
}

impl DirEntry {
    pub fn path(&self) -> PathBuf {
        self.path.clone()
    }

    pub fn file_name(&self) -> OsString {
        self.name.clone()
    }

    pub fn metadata(&self) -> io::Result<FileAttr> {
        Ok(self.attr.clone())
    }

    pub fn file_type(&self) -> io::Result<FileType> {
        Ok(self.attr.kind)
    }
}

impl OpenOptions {
    pub fn new() -> OpenOptions {
        OpenOptions {
            read: false,
            write: false,
            append: false,
            truncate: false,
            create: false,
            create_new: false,
        }
    }

    pub fn read(&mut self, read: bool) {
        self.read = read;
    }
    pub fn write(&mut self, write: bool) {
        self.write = write;
    }
    pub fn append(&mut self, append: bool) {
        self.append = append;
    }
    pub fn truncate(&mut self, truncate: bool) {
        self.truncate = truncate;
    }
    pub fn create(&mut self, create: bool) {
        self.create = create;
    }
    pub fn create_new(&mut self, create_new: bool) {
        self.create_new = create_new;
    }
}

pub struct File {
    data: Arc<Mutex<Data>>,
    pos: Mutex<u64>,
    write: bool,
    append: bool,
    dirty: Mutex<bool>,
}

impl File {
    pub fn open(path: &Path, opts: &OpenOptions) -> io::Result<File> {
        let key = key(path);
        let writes = opts.write || opts.append;
        let mut guard = tree();
        let tree = guard.as_mut().unwrap();
        let (data, created) = match tree.nodes.get(&key) {
            Some(Node::Dir { .. }) => {
                return Err(io::const_error!(io::ErrorKind::IsADirectory, "is a directory"));
            }
            Some(Node::File(data)) => {
                if opts.create_new {
                    return Err(io::const_error!(io::ErrorKind::AlreadyExists, "file exists"));
                }
                (data.clone(), false)
            }
            None => {
                if !(writes && (opts.create || opts.create_new)) {
                    return Err(not_found());
                }
                if !tree.is_dir(parent(&key)) {
                    return Err(not_found());
                }
                let data = Data {
                    path: key.clone(),
                    bytes: Some(Vec::new()),
                    size: 0,
                    modified: SystemTime::now(),
                };
                let data = Arc::new(Mutex::new(data));
                tree.nodes.insert(key, Node::File(data.clone()));
                (data, true)
            }
        };
        drop(guard);
        let mut dirty = created;
        if opts.truncate && writes && !created {
            let mut d = lock(&data);
            d.bytes = Some(Vec::new());
            d.size = 0;
            d.modified = SystemTime::now();
            dirty = true;
        }
        Ok(File {
            data,
            pos: Mutex::new(0),
            write: writes,
            append: opts.append,
            dirty: Mutex::new(dirty),
        })
    }

    fn save(&self) {
        let mut dirty = lock(&self.dirty);
        if *dirty {
            *dirty = false;
            lock(&self.data).persist();
        }
    }

    pub fn file_attr(&self) -> io::Result<FileAttr> {
        let data = lock(&self.data);
        Ok(FileAttr { kind: FileType { dir: false }, size: data.size, modified: data.modified })
    }

    pub fn fsync(&self) -> io::Result<()> {
        self.save();
        Ok(())
    }

    pub fn datasync(&self) -> io::Result<()> {
        self.save();
        Ok(())
    }

    pub fn lock(&self) -> io::Result<()> {
        Ok(())
    }

    pub fn lock_shared(&self) -> io::Result<()> {
        Ok(())
    }

    pub fn try_lock(&self) -> Result<(), TryLockError> {
        Ok(())
    }

    pub fn try_lock_shared(&self) -> Result<(), TryLockError> {
        Ok(())
    }

    pub fn unlock(&self) -> io::Result<()> {
        Ok(())
    }

    pub fn truncate(&self, size: u64) -> io::Result<()> {
        let mut data = lock(&self.data);
        data.load()?.resize(size as usize, 0);
        data.size = size;
        data.modified = SystemTime::now();
        *lock(&self.dirty) = true;
        Ok(())
    }

    pub fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        let mut data = lock(&self.data);
        let bytes = data.load()?;
        let mut pos = lock(&self.pos);
        let start = (*pos as usize).min(bytes.len());
        let n = buf.len().min(bytes.len() - start);
        buf[..n].copy_from_slice(&bytes[start..start + n]);
        *pos += n as u64;
        Ok(n)
    }

    pub fn read_vectored(&self, bufs: &mut [IoSliceMut<'_>]) -> io::Result<usize> {
        let mut total = 0;
        for buf in bufs {
            let n = self.read(buf)?;
            total += n;
            if n < buf.len() {
                break;
            }
        }
        Ok(total)
    }

    pub fn is_read_vectored(&self) -> bool {
        false
    }

    pub fn read_buf(&self, mut cursor: BorrowedCursor<'_, u8>) -> io::Result<()> {
        let mut data = lock(&self.data);
        let bytes = data.load()?;
        let mut pos = lock(&self.pos);
        let start = (*pos as usize).min(bytes.len());
        let n = cursor.capacity().min(bytes.len() - start);
        cursor.append(&bytes[start..start + n]);
        *pos += n as u64;
        Ok(())
    }

    pub fn write(&self, buf: &[u8]) -> io::Result<usize> {
        if !self.write {
            return Err(io::const_error!(io::ErrorKind::PermissionDenied, "not open for writing"));
        }
        let mut data = lock(&self.data);
        let bytes = data.load()?;
        let mut pos = lock(&self.pos);
        if self.append {
            *pos = bytes.len() as u64;
        }
        let start = *pos as usize;
        let end = start + buf.len();
        if bytes.len() < end {
            bytes.resize(end, 0);
        }
        bytes[start..end].copy_from_slice(buf);
        let size = bytes.len() as u64;
        *pos = end as u64;
        data.size = size;
        data.modified = SystemTime::now();
        *lock(&self.dirty) = true;
        Ok(buf.len())
    }

    pub fn write_vectored(&self, bufs: &[IoSlice<'_>]) -> io::Result<usize> {
        let mut total = 0;
        for buf in bufs {
            total += self.write(buf)?;
        }
        Ok(total)
    }

    pub fn is_write_vectored(&self) -> bool {
        false
    }

    pub fn flush(&self) -> io::Result<()> {
        Ok(())
    }

    pub fn seek(&self, pos: SeekFrom) -> io::Result<u64> {
        let size = lock(&self.data).size as i128;
        let mut at = lock(&self.pos);
        let next = match pos {
            SeekFrom::Start(n) => n as i128,
            SeekFrom::End(n) => size + n as i128,
            SeekFrom::Current(n) => *at as i128 + n as i128,
        };
        if next < 0 {
            return Err(io::const_error!(io::ErrorKind::InvalidInput, "seek before the start"));
        }
        *at = next as u64;
        Ok(*at)
    }

    pub fn size(&self) -> Option<io::Result<u64>> {
        Some(Ok(lock(&self.data).size))
    }

    pub fn tell(&self) -> io::Result<u64> {
        Ok(*lock(&self.pos))
    }

    pub fn duplicate(&self) -> io::Result<File> {
        Ok(File {
            data: self.data.clone(),
            pos: Mutex::new(*lock(&self.pos)),
            write: self.write,
            append: self.append,
            dirty: Mutex::new(false),
        })
    }

    pub fn set_permissions(&self, _perm: FilePermissions) -> io::Result<()> {
        Ok(())
    }

    pub fn set_times(&self, _times: FileTimes) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for File {
    fn drop(&mut self) {
        self.save();
    }
}

impl DirBuilder {
    pub fn new() -> DirBuilder {
        DirBuilder {}
    }

    pub fn mkdir(&self, p: &Path) -> io::Result<()> {
        let key = key(p);
        let mut guard = tree();
        let tree = guard.as_mut().unwrap();
        if tree.nodes.contains_key(&key) {
            return Err(io::const_error!(io::ErrorKind::AlreadyExists, "file exists"));
        }
        if !tree.is_dir(parent(&key)) {
            return Err(not_found());
        }
        tree.nodes.insert(key.clone(), Node::Dir { modified: SystemTime::now() });
        drop(guard);
        // A folder is persisted as its path with a trailing separator.
        horizon_web::persist(&format!("{key}/"), &[]);
        Ok(())
    }
}

impl fmt::Debug for File {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("File").field("path", &lock(&self.data).path).finish()
    }
}

pub fn readdir(p: &Path) -> io::Result<ReadDir> {
    let dir = key(p);
    let guard = tree();
    let tree = guard.as_ref().unwrap();
    if !tree.is_dir(&dir) {
        return Err(match tree.nodes.get(&dir) {
            Some(_) => io::const_error!(io::ErrorKind::NotADirectory, "not a directory"),
            None => not_found(),
        });
    }
    let mut entries = Vec::new();
    for child in tree.below(&dir) {
        let name = &child[if dir == "/" { 1 } else { dir.len() + 1 }..];
        if name.contains('/') {
            continue;
        }
        let attr = attr_of(&tree.nodes[&child]);
        entries.push(DirEntry { path: p.join(name), name: OsString::from(name), attr });
    }
    Ok(ReadDir(entries.into_iter()))
}

pub fn unlink(p: &Path) -> io::Result<()> {
    let key = key(p);
    let mut guard = tree();
    let tree = guard.as_mut().unwrap();
    match tree.nodes.get(&key) {
        Some(Node::File(_)) => {
            tree.nodes.remove(&key);
        }
        Some(Node::Dir { .. }) => {
            return Err(io::const_error!(io::ErrorKind::IsADirectory, "is a directory"));
        }
        None => return Err(not_found()),
    }
    drop(guard);
    horizon_web::forget(&key);
    Ok(())
}

pub fn rename(old: &Path, new: &Path) -> io::Result<()> {
    let from = key(old);
    let to = key(new);
    if from == to {
        return Ok(());
    }
    let mut guard = tree();
    let tree = guard.as_mut().unwrap();
    let Some(node) = tree.nodes.get(&from) else { return Err(not_found()) };
    let from_dir = matches!(node, Node::Dir { .. });
    if !tree.is_dir(parent(&to)) {
        return Err(not_found());
    }
    if to.starts_with(&format!("{from}/")) {
        return Err(io::const_error!(io::ErrorKind::InvalidInput, "cannot move into itself"));
    }
    match tree.nodes.get(&to) {
        Some(Node::Dir { .. }) if !from_dir => {
            return Err(io::const_error!(io::ErrorKind::IsADirectory, "is a directory"));
        }
        Some(Node::Dir { .. }) if !tree.below(&to).is_empty() => {
            return Err(io::const_error!(io::ErrorKind::DirectoryNotEmpty, "directory not empty"));
        }
        Some(Node::File(_)) if from_dir => {
            return Err(io::const_error!(io::ErrorKind::NotADirectory, "not a directory"));
        }
        _ => {}
    }
    let mut moved = Vec::new();
    let mut keys = vec![from.clone()];
    if from_dir {
        keys.extend(tree.below(&from));
    }
    for old_key in keys {
        let node = tree.nodes.remove(&old_key).unwrap();
        let new_key = format!("{to}{}", &old_key[from.len()..]);
        if let Node::File(data) = &node {
            lock(data).path = new_key.clone();
            moved.push((old_key.clone(), data.clone()));
        } else {
            moved.push((old_key.clone(), Arc::new(Mutex::new(Data {
                path: format!("{new_key}/"),
                bytes: Some(Vec::new()),
                size: 0,
                modified: SystemTime::now(),
            }))));
        }
        tree.nodes.insert(new_key, node);
    }
    drop(guard);
    horizon_web::forget(&from);
    for (_, data) in moved {
        lock(&data).persist();
    }
    Ok(())
}

pub fn set_perm(p: &Path, _perm: FilePermissions) -> io::Result<()> {
    stat(p).map(|_| ())
}

pub fn set_perm_nofollow(p: &Path, perm: FilePermissions) -> io::Result<()> {
    set_perm(p, perm)
}

pub fn set_times(p: &Path, _times: FileTimes) -> io::Result<()> {
    stat(p).map(|_| ())
}

pub fn set_times_nofollow(p: &Path, times: FileTimes) -> io::Result<()> {
    set_times(p, times)
}

pub fn rmdir(p: &Path) -> io::Result<()> {
    let key = key(p);
    let mut guard = tree();
    let tree = guard.as_mut().unwrap();
    if !tree.is_dir(&key) {
        return Err(match tree.nodes.get(&key) {
            Some(_) => io::const_error!(io::ErrorKind::NotADirectory, "not a directory"),
            None => not_found(),
        });
    }
    if !tree.below(&key).is_empty() {
        return Err(io::const_error!(io::ErrorKind::DirectoryNotEmpty, "directory not empty"));
    }
    tree.nodes.remove(&key);
    drop(guard);
    horizon_web::forget(&key);
    Ok(())
}

pub fn remove_dir_all(path: &Path) -> io::Result<()> {
    let key = key(path);
    let mut guard = tree();
    let tree = guard.as_mut().unwrap();
    if !tree.is_dir(&key) {
        return Err(match tree.nodes.get(&key) {
            Some(_) => io::const_error!(io::ErrorKind::NotADirectory, "not a directory"),
            None => not_found(),
        });
    }
    for child in tree.below(&key) {
        tree.nodes.remove(&child);
    }
    tree.nodes.remove(&key);
    drop(guard);
    horizon_web::forget(&key);
    Ok(())
}

pub fn exists(path: &Path) -> io::Result<bool> {
    let key = key(path);
    Ok(tree().as_ref().unwrap().nodes.contains_key(&key))
}

pub fn readlink(_p: &Path) -> io::Result<PathBuf> {
    Err(io::const_error!(io::ErrorKind::InvalidInput, "not a symbolic link"))
}

pub fn symlink(_original: &Path, _link: &Path) -> io::Result<()> {
    Err(io::const_error!(io::ErrorKind::Unsupported, "no symbolic links in the browser"))
}

pub fn link(_src: &Path, _dst: &Path) -> io::Result<()> {
    Err(io::const_error!(io::ErrorKind::Unsupported, "no hard links in the browser"))
}

pub fn stat(p: &Path) -> io::Result<FileAttr> {
    let key = key(p);
    let guard = tree();
    let tree = guard.as_ref().unwrap();
    tree.nodes.get(&key).map(attr_of).ok_or_else(not_found)
}

pub fn lstat(p: &Path) -> io::Result<FileAttr> {
    stat(p)
}

pub fn canonicalize(p: &Path) -> io::Result<PathBuf> {
    let key = key(p);
    if tree().as_ref().unwrap().nodes.contains_key(&key) {
        Ok(PathBuf::from(key))
    } else {
        Err(not_found())
    }
}

pub fn copy(from: &Path, to: &Path) -> io::Result<u64> {
    let mut read = OpenOptions::new();
    read.read(true);
    let source = File::open(from, &read)?;
    let bytes = {
        let mut data = lock(&source.data);
        data.load()?.clone()
    };
    let mut write = OpenOptions::new();
    write.write(true);
    write.create(true);
    write.truncate(true);
    let target = File::open(to, &write)?;
    target.write(&bytes)?;
    Ok(bytes.len() as u64)
}

impl Hash for FileAttr {
    fn hash<H: Hasher>(&self, h: &mut H) {
        self.kind.hash(h);
        self.size.hash(h);
    }
}
