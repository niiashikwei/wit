#!/usr/bin/env python3
"""Static token-waste audit of a project's Claude Code setup. Prints JSON findings.

Usage: audit.py [project-root]
Token estimates use ~4 chars/token; treat them as relative, not exact.
"""
import json
import os
import re
import sys

SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next", "target"}
GENERATED = re.compile(r"(\.min\.(js|css)$|\.map$|package-lock\.json$|yarn\.lock$|pnpm-lock\.yaml$|poetry\.lock$|Cargo\.lock$|\.snap$)")
BIG_FILE = 512 * 1024


def tokens(text):
    return len(text) // 4


def read(path):
    try:
        with open(path, errors="ignore") as f:
            return f.read()
    except OSError:
        return None


def finding(sev, area, msg, est_tokens=0, fix=""):
    return {"severity": sev, "area": area, "message": msg, "est_tokens_per_session": est_tokens, "fix": fix}


def audit_memory(root, out):
    for rel in ("CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"):
        text = read(os.path.join(root, rel))
        if text is None:
            continue
        n_lines, t = text.count("\n") + 1, tokens(text)
        imports = re.findall(r"^@(\S+)", text, re.M)
        imported = sum(tokens(read(os.path.join(root, i)) or "") for i in imports)
        if t + imported > 2500:
            out.append(finding("high" if t + imported > 6000 else "medium", "memory",
                               f"{rel}: {n_lines} lines, ~{t} tokens (+~{imported} via @imports) loaded every session",
                               t + imported, "Keep only rules Claude needs every session; move reference material to linked docs read on demand."))
        code_blocks = len(re.findall(r"^```", text, re.M)) // 2
        if code_blocks > 5:
            out.append(finding("low", "memory", f"{rel} has {code_blocks} code blocks", 0,
                               "Point to example files instead of inlining code."))


def audit_mcp(root, out):
    servers = set()
    cfg = read(os.path.join(root, ".mcp.json"))
    if cfg:
        try:
            servers |= set(json.loads(cfg).get("mcpServers", {}))
        except ValueError:
            pass
    user = read(os.path.expanduser("~/.claude.json"))
    if user:
        try:
            data = json.loads(user)
            servers |= set(data.get("mcpServers", {}))
            servers |= set((data.get("projects", {}).get(os.path.abspath(root), {}) or {}).get("mcpServers", {}))
        except ValueError:
            pass
    if len(servers) > 5:
        out.append(finding("medium", "mcp", f"{len(servers)} MCP servers configured for this project: {sorted(servers)}",
                           len(servers) * 1500,
                           "Disable servers this project doesn't use; tool schemas cost tokens unless tool search defers them."))


def audit_claude_dir(root, out):
    for kind in ("skills", "agents"):
        base = os.path.join(root, ".claude", kind)
        if not os.path.isdir(base):
            continue
        for dirpath, _, files in os.walk(base):
            for fn in files:
                if not fn.endswith(".md"):
                    continue
                p = os.path.join(dirpath, fn)
                text = read(p) or ""
                rel = os.path.relpath(p, root)
                m = re.search(r"^description:\s*(.+)$", text, re.M)
                if m and len(m.group(1)) > 400:
                    out.append(finding("low", kind, f"{rel}: description is {len(m.group(1))} chars (always in context)",
                                       tokens(m.group(1)), "Tighten to 1-2 sentences of trigger conditions."))
                if kind == "skills" and fn == "SKILL.md" and text.count("\n") > 500:
                    out.append(finding("low", kind, f"{rel}: {text.count(chr(10))} lines", 0,
                                       "Move reference sections into separate files the skill reads on demand."))
                if kind == "agents" and not re.search(r"^model:", text, re.M):
                    out.append(finding("low", kind, f"{rel}: no `model:` set, so it inherits the (possibly most expensive) main model",
                                       0, "Set `model: haiku` for search agents, `sonnet` for routine work."))


def audit_files(root, out):
    settings = (read(os.path.join(root, ".claude", "settings.json")) or "") + (read(os.path.join(root, ".claude", "settings.local.json")) or "")
    hits = []
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for fn in files:
            p = os.path.join(dirpath, fn)
            try:
                size = os.path.getsize(p)
            except OSError:
                continue
            if GENERATED.search(fn) or (size > BIG_FILE and not fn.endswith((".png", ".jpg", ".pdf", ".zip"))):
                rel = os.path.relpath(p, root)
                if rel not in settings:
                    hits.append((size, rel))
    hits.sort(reverse=True)
    if hits:
        out.append(finding("medium", "files", f"{len(hits)} large/generated files not denied, e.g. {[h[1] for h in hits[:5]]}",
                           0, 'Add to .claude/settings.json: "permissions": {"deny": ["Read(./path/**)"]} for generated artifacts.'))


def main():
    root = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else ".")
    out = []
    for fn in (audit_memory, audit_mcp, audit_claude_dir, audit_files):
        try:
            fn(root, out)
        except Exception as e:  # one broken check shouldn't sink the audit
            out.append(finding("info", fn.__name__, f"check failed: {e}"))
    order = {"high": 0, "medium": 1, "low": 2, "info": 3}
    out.sort(key=lambda f: (order[f["severity"]], -f["est_tokens_per_session"]))
    print(json.dumps({"project": os.path.basename(root), "findings": out}, indent=2))


if __name__ == "__main__":
    main()
