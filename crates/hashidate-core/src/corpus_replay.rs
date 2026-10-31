//! Reader for the corpora under `tests/corpora/`: fixed goldens recorded from the TypeScript
//! implementation these modules replaced.
//!
//! A function corpus is `<fn>.bin`, little-endian f64 with one case after another (the inputs,
//! then the outputs), and `<fn>.json`, which names the fields of each half and their lengths.
//! `avatar-base.bin` holds named arrays of u32, f64 or f32 at the byte offsets
//! `avatar-base.json` gives. Test-only and `std`-only, so the index is parsed by the small JSON
//! reader below rather than by a dependency.

use std::fs;
use std::path::PathBuf;

/// The value of a node index that names no node.
pub const NO_NODE: u32 = u32::MAX;

fn corpus_path(file: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/corpora")
        .join(file)
}

fn read(file: &str) -> Vec<u8> {
    let path = corpus_path(file);
    fs::read(&path).unwrap_or_else(|e| panic!("reading {}: {e}", path.display()))
}

/// The JSON the indexes are written in: objects keep their key order.
#[derive(Debug)]
enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    fn parse(text: &str) -> Json {
        let mut p = Parser {
            s: text.as_bytes(),
            at: 0,
        };
        let v = p.value();
        p.space();
        assert!(p.at == p.s.len(), "trailing characters at byte {}", p.at);
        v
    }

    fn get(&self, key: &str) -> &Json {
        match self {
            Json::Obj(fields) => fields
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v)
                .unwrap_or_else(|| panic!("no key {key}")),
            _ => panic!("{key} looked up on a non-object"),
        }
    }

    fn num(&self) -> f64 {
        match self {
            Json::Num(n) => *n,
            _ => panic!("expected a number, got {self:?}"),
        }
    }

    fn index(&self) -> usize {
        let n = self.num();
        assert!(n >= 0.0 && n.fract() == 0.0, "expected an index, got {n}");
        n as usize
    }

    fn str(&self) -> &str {
        match self {
            Json::Str(s) => s,
            _ => panic!("expected a string, got {self:?}"),
        }
    }

    fn arr(&self) -> &[Json] {
        match self {
            Json::Arr(items) => items,
            _ => panic!("expected an array, got {self:?}"),
        }
    }
}

struct Parser<'a> {
    s: &'a [u8],
    at: usize,
}

impl Parser<'_> {
    fn space(&mut self) {
        while self.at < self.s.len() && matches!(self.s[self.at], b' ' | b'\t' | b'\n' | b'\r') {
            self.at += 1;
        }
    }

    fn eat(&mut self, c: u8) {
        self.space();
        assert!(
            self.s.get(self.at) == Some(&c),
            "expected '{}' at byte {}",
            c as char,
            self.at
        );
        self.at += 1;
    }

    fn word(&mut self, w: &str, v: Json) -> Json {
        assert!(
            self.s[self.at..].starts_with(w.as_bytes()),
            "bad literal at byte {}",
            self.at
        );
        self.at += w.len();
        v
    }

    fn value(&mut self) -> Json {
        self.space();
        match self.s.get(self.at) {
            Some(b'{') => {
                self.at += 1;
                let mut fields = Vec::new();
                self.space();
                if self.s.get(self.at) == Some(&b'}') {
                    self.at += 1;
                    return Json::Obj(fields);
                }
                loop {
                    self.space();
                    let key = self.string();
                    self.eat(b':');
                    fields.push((key, self.value()));
                    self.space();
                    self.at += 1;
                    match self.s[self.at - 1] {
                        b',' => continue,
                        b'}' => return Json::Obj(fields),
                        c => panic!("unexpected '{}' at byte {}", c as char, self.at - 1),
                    }
                }
            }
            Some(b'[') => {
                self.at += 1;
                let mut items = Vec::new();
                self.space();
                if self.s.get(self.at) == Some(&b']') {
                    self.at += 1;
                    return Json::Arr(items);
                }
                loop {
                    items.push(self.value());
                    self.space();
                    self.at += 1;
                    match self.s[self.at - 1] {
                        b',' => continue,
                        b']' => return Json::Arr(items),
                        c => panic!("unexpected '{}' at byte {}", c as char, self.at - 1),
                    }
                }
            }
            Some(b'"') => Json::Str(self.string()),
            Some(b't') => self.word("true", Json::Bool(true)),
            Some(b'f') => self.word("false", Json::Bool(false)),
            Some(b'n') => self.word("null", Json::Null),
            Some(_) => {
                let start = self.at;
                while self.at < self.s.len()
                    && matches!(
                        self.s[self.at],
                        b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9'
                    )
                {
                    self.at += 1;
                }
                let text = std::str::from_utf8(&self.s[start..self.at]).expect("ASCII number");
                Json::Num(text.parse().unwrap_or_else(|_| panic!("bad number {text}")))
            }
            None => panic!("unexpected end of input"),
        }
    }

    fn hex4(&mut self) -> u32 {
        let text = std::str::from_utf8(&self.s[self.at..self.at + 4]).expect("ASCII escape");
        self.at += 4;
        u32::from_str_radix(text, 16).unwrap_or_else(|_| panic!("bad escape {text}"))
    }

    fn string(&mut self) -> String {
        assert!(
            self.s.get(self.at) == Some(&b'"'),
            "expected a string at byte {}",
            self.at
        );
        self.at += 1;
        let mut out = Vec::new();
        loop {
            let c = self.s[self.at];
            self.at += 1;
            match c {
                b'"' => return String::from_utf8(out).expect("UTF-8 string"),
                b'\\' => {
                    let e = self.s[self.at];
                    self.at += 1;
                    let ch = match e {
                        b'"' => '"',
                        b'\\' => '\\',
                        b'/' => '/',
                        b'b' => '\u{8}',
                        b'f' => '\u{c}',
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        b'u' => {
                            let mut code = self.hex4();
                            if (0xd800..0xdc00).contains(&code) {
                                assert!(self.s[self.at..].starts_with(b"\\u"), "lone surrogate");
                                self.at += 2;
                                code = 0x10000 + ((code - 0xd800) << 10) + (self.hex4() - 0xdc00);
                            }
                            char::from_u32(code).expect("valid code point")
                        }
                        _ => panic!("bad escape at byte {}", self.at - 1),
                    };
                    let mut buf = [0u8; 4];
                    out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                }
                _ => out.push(c),
            }
        }
    }
}

/// One named field of a case: where it starts within its half, and how many f64 it holds.
#[derive(Debug, Clone)]
pub struct Field {
    pub name: String,
    pub offset: usize,
    pub len: usize,
}

fn fields(list: &[Json]) -> (Vec<Field>, usize) {
    let mut offset = 0;
    let out = list
        .iter()
        .map(|f| {
            let len = f.get("len").index();
            let field = Field {
                name: f.get("name").str().to_owned(),
                offset,
                len,
            };
            offset += len;
            field
        })
        .collect();
    (out, offset)
}

fn lookup<'a>(fields: &'a [Field], name: &str) -> &'a Field {
    fields
        .iter()
        .find(|f| f.name == name)
        .unwrap_or_else(|| panic!("no field {name}"))
}

/// A function's recorded calls.
pub struct Corpus {
    pub function: String,
    pub inputs: Vec<Field>,
    pub outputs: Vec<Field>,
    input_len: usize,
    stride: usize,
    data: Vec<f64>,
}

impl Corpus {
    /// The corpus of `function`; panics when it is missing or inconsistent.
    pub fn load(function: &str) -> Corpus {
        let index = Json::parse(
            std::str::from_utf8(&read(&format!("{function}.json"))).expect("UTF-8 index"),
        );
        let (inputs, input_len) = fields(index.get("in").arr());
        let (outputs, output_len) = fields(index.get("out").arr());
        let cases = index.get("cases").index();
        let bytes = read(&format!("{function}.bin"));
        let stride = input_len + output_len;
        assert_eq!(bytes.len(), cases * stride * 8, "{function}.bin size");
        let data = bytes
            .as_chunks::<8>()
            .0
            .iter()
            .map(|b| f64::from_le_bytes(*b))
            .collect();
        Corpus {
            function: index.get("fn").str().to_owned(),
            inputs,
            outputs,
            input_len,
            stride,
            data,
        }
    }

    pub fn cases(&self) -> usize {
        self.data.len() / self.stride
    }

    pub fn case(&self, i: usize) -> Case<'_> {
        assert!(i < self.cases(), "case {i} of {}", self.cases());
        let row = &self.data[i * self.stride..(i + 1) * self.stride];
        Case {
            corpus: self,
            input: &row[..self.input_len],
            output: &row[self.input_len..],
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = Case<'_>> {
        (0..self.cases()).map(|i| self.case(i))
    }
}

/// One recorded call.
pub struct Case<'a> {
    corpus: &'a Corpus,
    input: &'a [f64],
    output: &'a [f64],
}

impl<'a> Case<'a> {
    /// An input field by name.
    pub fn input(&self, name: &str) -> &'a [f64] {
        let f = lookup(&self.corpus.inputs, name);
        &self.input[f.offset..f.offset + f.len]
    }

    /// An output field by name: `return`, or an argument the function writes.
    pub fn output(&self, name: &str) -> &'a [f64] {
        let f = lookup(&self.corpus.outputs, name);
        &self.output[f.offset..f.offset + f.len]
    }

    /// A one-value field as a scalar; for an input when `output` is false.
    pub fn scalar(&self, name: &str, output: bool) -> f64 {
        let v = if output {
            self.output(name)
        } else {
            self.input(name)
        };
        assert_eq!(v.len(), 1, "{name} is not a scalar");
        v[0]
    }
}

/// What kind of number an array of the base avatar holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    U32,
    F64,
    F32,
}

struct Entry {
    name: String,
    kind: Kind,
    offset: usize,
    len: usize,
}

/// The base synthetic avatar as the rig is built on it.
pub struct AvatarBase {
    entries: Vec<Entry>,
    bytes: Vec<u8>,
}

impl AvatarBase {
    pub fn load() -> AvatarBase {
        let index =
            Json::parse(std::str::from_utf8(&read("avatar-base.json")).expect("UTF-8 index"));
        let bytes = read("avatar-base.bin");
        let entries: Vec<Entry> = index
            .get("arrays")
            .arr()
            .iter()
            .map(|a| {
                let kind = match a.get("kind").str() {
                    "u32" => Kind::U32,
                    "f64" => Kind::F64,
                    "f32" => Kind::F32,
                    other => panic!("unknown kind {other}"),
                };
                let entry = Entry {
                    name: a.get("name").str().to_owned(),
                    kind,
                    offset: a.get("offset").index(),
                    len: a.get("len").index(),
                };
                let width = if kind == Kind::F64 { 8 } else { 4 };
                assert!(
                    entry.offset + entry.len * width <= bytes.len(),
                    "{} overruns",
                    entry.name
                );
                entry
            })
            .collect();
        AvatarBase { entries, bytes }
    }

    /// Every array's name and kind, in the order they were written.
    pub fn names(&self) -> impl Iterator<Item = (&str, Kind)> {
        self.entries.iter().map(|e| (e.name.as_str(), e.kind))
    }

    fn entry(&self, name: &str, kind: Kind) -> Option<(&[u8], usize)> {
        let e = self.entries.iter().find(|e| e.name == name)?;
        assert_eq!(e.kind, kind, "{name} holds {:?}", e.kind);
        Some((&self.bytes[e.offset..], e.len))
    }

    pub fn u32(&self, name: &str) -> Option<Vec<u32>> {
        let (b, len) = self.entry(name, Kind::U32)?;
        Some(
            b.as_chunks::<4>()
                .0
                .iter()
                .take(len)
                .map(|c| u32::from_le_bytes(*c))
                .collect(),
        )
    }

    pub fn f64(&self, name: &str) -> Option<Vec<f64>> {
        let (b, len) = self.entry(name, Kind::F64)?;
        Some(
            b.as_chunks::<8>()
                .0
                .iter()
                .take(len)
                .map(|c| f64::from_le_bytes(*c))
                .collect(),
        )
    }

    pub fn f32(&self, name: &str) -> Option<Vec<f32>> {
        let (b, len) = self.entry(name, Kind::F32)?;
        Some(
            b.as_chunks::<4>()
                .0
                .iter()
                .take(len)
                .map(|c| f32::from_le_bytes(*c))
                .collect(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_reads_every_form() {
        let v = Json::parse(
            r#" { "a": [1, -2.5e3, true, false, null], "b": "q\"\\\/\b\f\n\r\té😀", "c": {} , "d": []} "#,
        );
        let a = v.get("a").arr();
        assert_eq!(a[0].index(), 1);
        assert_eq!(a[1].num(), -2500.0);
        assert!(matches!(a[2], Json::Bool(true)));
        assert!(matches!(a[3], Json::Bool(false)));
        assert!(matches!(a[4], Json::Null));
        assert_eq!(v.get("b").str(), "q\"\\/\u{8}\u{c}\n\r\té😀");
        assert!(matches!(v.get("c"), Json::Obj(f) if f.is_empty()));
        assert!(v.get("d").arr().is_empty());
    }

    fn corpus_names() -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(corpus_path(""))
            .expect("corpora directory")
            .filter_map(|e| {
                let name = e.ok()?.file_name().into_string().ok()?;
                let stem = name.strip_suffix(".json")?;
                (stem != "avatar-base").then(|| stem.to_owned())
            })
            .collect();
        names.sort();
        names
    }

    #[test]
    fn every_corpus_reads_back_whole() {
        let names = corpus_names();
        assert!(!names.is_empty(), "no corpora recorded");
        for name in names {
            let corpus = Corpus::load(&name);
            assert_eq!(corpus.function, name);
            assert!(corpus.cases() > 0, "{name} has no cases");
            let last = corpus.iter().last().expect("a case");
            let f = &corpus.inputs[0];
            assert_eq!(last.input(&f.name).len(), f.len);
            let g = &corpus.outputs[corpus.outputs.len() - 1];
            assert_eq!(last.output(&g.name).len(), g.len);
            if let Some(s) = corpus.inputs.iter().find(|f| f.len == 1) {
                assert!(!last.scalar(&s.name, false).is_nan() || last.input(&s.name)[0].is_nan());
            }
        }
    }

    #[test]
    fn the_base_avatar_reads_back_whole() {
        let base = AvatarBase::load();
        let parent = base.u32("node.parent").expect("node.parent");
        let n = parent.len();
        assert_eq!(
            base.f64("node.position").expect("node.position").len(),
            3 * n
        );
        assert_eq!(
            base.f64("node.matrixWorld")
                .expect("node.matrixWorld")
                .len(),
            16 * n
        );
        assert_eq!(parent[0], NO_NODE);
        assert!(
            parent
                .iter()
                .enumerate()
                .skip(1)
                .all(|(i, &p)| (p as usize) < i)
        );
        let face = base.f32("measure.face.pos").expect("measure.face.pos");
        assert!(!face.is_empty() && face.len().is_multiple_of(3));
        assert!(base.u32("no such array").is_none());
        assert!(
            base.names()
                .any(|(name, kind)| name == "profile.sideSign" && kind == Kind::F64)
        );
    }
}
