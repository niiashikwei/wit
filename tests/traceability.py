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
    return mapping


if __name__ == "__main__":
    reqs, tests = requirements(), tests_by_requirement()
    for rid in sorted(reqs, key=lambda r: int(r[1:])):
        names = tests.get(rid, [])
        print(f"{rid:<4} {len(names):>3} tests  {reqs[rid][:90]}")
        for n in names:
            print(f"            - {n.split('.', 1)[1]}")
