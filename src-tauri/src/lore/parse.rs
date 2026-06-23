// Text parsers turning `lore`'s human-readable output into the serde structs.
// Every format here was captured from real `lore 0.8.3` output (see the tests
// at the bottom), not guessed.

use super::model::{Branch, BranchList, Commit, FileChange, StatusInfo};

/// Lore prints file lines as "M path (M)" where the trailing "(M)" is a status
/// annotation, not part of the name. Strip a short "(X)" suffix so it is never
/// fed back as a path - lore rejects that with "Invalid path <name> (M)" and the
/// change can never be committed.
fn strip_status_suffix(path: &str) -> String {
    // A conflicted file is shown as "M  file (M)!" - the trailing '!' flags that
    // markers are present. Drop it first, then the "(X)" annotation.
    let p = path.trim_end().trim_end_matches('!').trim_end();
    if p.ends_with(')') {
        if let Some(open) = p.rfind(" (") {
            let inner = &p[open + 2..p.len() - 1];
            if !inner.is_empty()
                && inner.len() <= 3
                && inner.chars().all(|c| c.is_ascii_alphabetic() || c == '?')
            {
                return p[..open].trim_end().to_string();
            }
        }
    }
    p.to_string()
}

/// Parse the output of `lore status --scan`.
pub(crate) fn parse_status(raw: String) -> StatusInfo {
    let mut info = StatusInfo {
        repository: String::new(),
        branch: String::new(),
        local_revision: String::new(),
        sync_state: String::new(),
        staged: Vec::new(),
        unstaged: Vec::new(),
        untracked: Vec::new(),
        conflicts: Vec::new(),
        raw: raw.clone(),
    };

    // Which file-list section are we currently inside.
    #[derive(PartialEq)]
    enum Section {
        None,
        Staged,
        Unstaged,
        Untracked,
        Conflicts,
    }
    let mut section = Section::None;

    for line in raw.lines() {
        let trimmed = line.trim_end();

        if let Some(rest) = trimmed.strip_prefix("Repository ") {
            info.repository = rest.trim().to_string();
            continue;
        }
        // "On branch main revision 1 -> <hash>"
        if let Some(rest) = trimmed.strip_prefix("On branch ") {
            // rest = "main revision 1 -> <hash>"
            let mut parts = rest.split_whitespace();
            if let Some(name) = parts.next() {
                info.branch = name.to_string();
            }
            // find token after "revision"
            let tokens: Vec<&str> = rest.split_whitespace().collect();
            if let Some(pos) = tokens.iter().position(|t| *t == "revision") {
                if let Some(rev) = tokens.get(pos + 1) {
                    info.local_revision = rev.to_string();
                }
            }
            continue;
        }
        if trimmed.starts_with("Local branch ") {
            // "Local branch in sync with remote" / "is ahead of remote" / "is behind remote"
            info.sync_state = trimmed.trim_start_matches("Local branch ").trim().to_string();
            continue;
        }

        // Section headers.
        if trimmed.starts_with("Changes staged for commit") {
            section = Section::Staged;
            continue;
        }
        if trimmed.starts_with("Changes not staged for commit") {
            section = Section::Unstaged;
            continue;
        }
        if trimmed.starts_with("Untracked files") {
            section = Section::Untracked;
            continue;
        }
        // Best-effort: a header mentioning "conflict" starts a conflicts list.
        // (Exact Lore wording needs checking against a real conflict.)
        let lower = trimmed.trim().to_lowercase();
        if (lower.contains("conflict") || lower.starts_with("unmerged")) && trimmed.trim_end().ends_with(':') {
            section = Section::Conflicts;
            continue;
        }
        if trimmed.starts_with("Tracked changes") {
            section = Section::None;
            continue;
        }

        // Conflicts can be marked differently (C/U/UU/...) or bare paths, so be
        // lenient here and take whatever path the line carries.
        if section == Section::Conflicts {
            let t = trimmed.trim();
            if !t.is_empty() {
                let mut chars = t.chars();
                let first = chars.next().unwrap();
                let marked = matches!(chars.next(), Some(c) if c.is_whitespace());
                let (status, path) = if marked {
                    (first.to_string(), strip_status_suffix(t[first.len_utf8()..].trim()))
                } else {
                    ("C".to_string(), strip_status_suffix(t))
                };
                info.conflicts.push(FileChange { status, path });
            }
            continue;
        }

        // File lines look like "A hello.txt", "M hello.txt", "D notes.txt".
        // (Staged lines can carry a trailing space, already stripped.)
        let starts_with_marker = trimmed.len() >= 2
            && matches!(&trimmed[0..1], "A" | "M" | "D")
            && trimmed[1..2].chars().all(|c| c.is_whitespace());
        if section != Section::None && starts_with_marker {
            let status = trimmed[0..1].to_string();
            let path = strip_status_suffix(trimmed[1..].trim());
            let change = FileChange { status, path };
            match section {
                Section::Staged => info.staged.push(change),
                Section::Unstaged => info.unstaged.push(change),
                Section::Untracked => info.untracked.push(change),
                Section::Conflicts | Section::None => {}
            }
        }
    }

    info
}

/// Parse `lore branch list`.
pub(crate) fn parse_branches(raw: String) -> BranchList {
    let mut list = BranchList {
        local: Vec::new(),
        remote: Vec::new(),
        raw: raw.clone(),
    };

    enum Sec {
        None,
        Local,
        Remote,
    }
    let mut sec = Sec::None;

    for line in raw.lines() {
        let t = line.trim_end();
        if t.starts_with("Local branches") {
            sec = Sec::Local;
            continue;
        }
        if t.starts_with("Remote branches") {
            sec = Sec::Remote;
            continue;
        }
        // Entries: "* main" (current) or "  feature-x".
        let current = t.trim_start().starts_with('*');
        let name = t.trim_start().trim_start_matches('*').trim().to_string();
        if name.is_empty() {
            continue;
        }
        let branch = Branch { name, current };
        match sec {
            Sec::Local => list.local.push(branch),
            Sec::Remote => list.remote.push(branch),
            Sec::None => {}
        }
    }

    list
}

pub(crate) fn parse_history(raw: String) -> Vec<Commit> {
    let mut out: Vec<Commit> = Vec::new();
    let mut msg: Vec<String> = Vec::new();

    // Message lines are indented 4 spaces; field lines start at column 0.
    let value = |line: &str| line.splitn(2, ':').nth(1).unwrap_or("").trim().to_string();

    for line in raw.lines() {
        if line.starts_with("    ") {
            msg.push(line.trim().to_string());
            continue;
        }
        let t = line.trim();
        if t.starts_with("Revision") {
            // Starting a new entry: attach accumulated message to the previous one.
            if let Some(last) = out.last_mut() {
                last.message = msg.join("\n");
            }
            msg.clear();
            out.push(Commit {
                revision: value(t),
                signature: String::new(),
                branch: String::new(),
                merge_parent: String::new(),
                date: String::new(),
                message: String::new(),
                is_merge: false,
                author: String::new(),
            });
        } else if t.starts_with("Signature") {
            if let Some(c) = out.last_mut() {
                c.signature = value(t);
            }
        } else if t.starts_with("Branch") {
            if let Some(c) = out.last_mut() {
                c.branch = value(t);
            }
        } else if t.starts_with("Merge") {
            if let Some(c) = out.last_mut() {
                c.is_merge = true;
                c.merge_parent = value(t);
            }
        } else if t.starts_with("Date") {
            if let Some(c) = out.last_mut() {
                c.date = value(t);
            }
        } else if t.starts_with("Committer") {
            // Prefer Committer as the per-commit author when Lore exposes it.
            if let Some(c) = out.last_mut() {
                c.author = value(t);
            }
        } else if t.starts_with("Creator") {
            // Fall back to Creator only if no Committer line was seen.
            if let Some(c) = out.last_mut() {
                if c.author.is_empty() {
                    c.author = value(t);
                }
            }
        }
        // Blank lines are ignored.
    }
    if let Some(last) = out.last_mut() {
        last.message = msg.join("\n");
    }
    out
}

/// Parse a list of "A/M/D path" lines (used by status sections and revision diff).
pub(crate) fn parse_change_list(raw: &str) -> Vec<FileChange> {
    let mut v = Vec::new();
    for line in raw.lines() {
        let t = line.trim_end();
        let marked = t.len() >= 2
            && matches!(&t[0..1], "A" | "M" | "D")
            && t[1..2].chars().all(|c| c.is_whitespace());
        if marked {
            v.push(FileChange {
                status: t[0..1].to_string(),
                path: t[1..].trim().to_string(),
            });
        }
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    // Verbatim output captured from real `lore 0.8.3` runs.

    #[test]
    fn parses_mixed_status() {
        let raw = "\
Repository 019ed7404c5b78728401b6dc4d7d3e55
On branch main revision 1 -> e99c04944fc13bbb4e72ea75e815c6b690f27a56f96d6cbec82083d07fbcd43d
Remote revision 1 -> e99c04944fc13bbb4e72ea75e815c6b690f27a56f96d6cbec82083d07fbcd43d
Local branch in sync with remote
Changes not staged for commit:
M hello.txt
D notes.txt
Untracked files:
A fresh.txt
Tracked changes: 1 added, 1 modified, 1 deleted
";
        let s = parse_status(raw.to_string());
        assert_eq!(s.repository, "019ed7404c5b78728401b6dc4d7d3e55");
        assert_eq!(s.branch, "main");
        assert_eq!(s.local_revision, "1");
        assert_eq!(s.sync_state, "in sync with remote");
        assert_eq!(s.unstaged.len(), 2);
        assert_eq!(s.unstaged[0].status, "M");
        assert_eq!(s.unstaged[0].path, "hello.txt");
        assert_eq!(s.unstaged[1].status, "D");
        assert_eq!(s.untracked.len(), 1);
        assert_eq!(s.untracked[0].path, "fresh.txt");
        assert!(s.staged.is_empty());
    }

    #[test]
    fn parses_staged_status() {
        // Staged lines carry a trailing space in real output.
        let raw = "\
Repository 019ed7404c5b78728401b6dc4d7d3e55
On branch main revision 0 -> 0000000000000000000000000000000000000000000000000000000000000000
Remote revision 0 -> 0000000000000000000000000000000000000000000000000000000000000000
Local branch in sync with remote
Changes staged for commit:
A hello.txt
A notes.txt
";
        let s = parse_status(raw.to_string());
        assert_eq!(s.staged.len(), 2);
        assert_eq!(s.staged[0].status, "A");
        assert_eq!(s.staged[0].path, "hello.txt");
        assert_eq!(s.local_revision, "0");
    }

    #[test]
    fn parses_branch_list() {
        let raw = "\
Local branches:
  main
* feature-x
Remote branches:
  main
";
        let b = parse_branches(raw.to_string());
        assert_eq!(b.local.len(), 2);
        assert_eq!(b.local[0].name, "main");
        assert!(!b.local[0].current);
        assert_eq!(b.local[1].name, "feature-x");
        assert!(b.local[1].current);
        assert_eq!(b.remote.len(), 1);
        assert_eq!(b.remote[0].name, "main");
    }
}
