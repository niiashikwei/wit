#!/usr/bin/env python3
"""Requirement ↔ test traceability. `python3 tests/traceability.py` prints the matrix."""
import os
import re
import sys
import unittest

TESTS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TESTS)


def requirements():
    with open(os.path.join(os.path.dirname(TESTS), "REQUIREMENTS.md")) as f:
        return dict(re.findall(r"^\| (R\d+) \| (.+?) \|$", f.read(), re.M))


def tests_by_requirement():
    suite = unittest.defaultTestLoader.discover(TESTS, pattern="test_*.py")
    mapping = {}

    def walk(s):
        for t in s:
            if isinstance(t, unittest.TestSuite):
                walk(t)
            else:
                fn = getattr(t, t._testMethodName, None)
                for r in getattr(fn, "_reqs", ()):
                    mapping.setdefault(r, []).append(t.id())
    walk(suite)
    for name, reqs in morpheus_tests():
        for r in reqs:
            mapping.setdefault(r, []).append(f"morpheus.{name}")
    return mapping


MORPHEUS_TESTS = os.path.join(os.path.dirname(TESTS), "plugins", "wit", "morpheus", "test")


def morpheus_tests():
    """(test name, [requirement IDs]) for each Morpheus Node test; untagged tests get []."""
    found = []
    for fname in sorted(os.listdir(MORPHEUS_TESTS)):
        if not fname.endswith(".test.ts"):
            continue
        with open(os.path.join(MORPHEUS_TESTS, fname)) as f:
            lines = f.read().split("\n")
        for i, line in enumerate(lines):
            m = re.match(r'^test\("(.*?)",', line)
            if m:
                tag = re.match(r"^// @req ((?:R\d+ ?)+)$", lines[i - 1]) if i else None
                found.append((m.group(1), tag.group(1).split() if tag else []))
    return found


if __name__ == "__main__":
    reqs, tests = requirements(), tests_by_requirement()
    for rid in sorted(reqs, key=lambda r: int(r[1:])):
        names = tests.get(rid, [])
        print(f"{rid:<4} {len(names):>3} tests  {reqs[rid][:90]}")
        for n in names:
            print(f"            - {n.split('.', 1)[1]}")
