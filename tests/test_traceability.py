"""Every requirement is tested; every test cites a real requirement."""
import unittest

from traceability import morpheus_tests, requirements, tests_by_requirement


class TraceabilityTest(unittest.TestCase):
    def test_every_requirement_has_a_test(self):
        reqs, tests = requirements(), tests_by_requirement()
        self.assertGreaterEqual(len(reqs), 34)
        self.assertEqual(sorted(set(reqs) - set(tests)), [], "requirements without tests")

    def test_no_test_cites_unknown_requirement(self):
        self.assertEqual(sorted(set(tests_by_requirement()) - set(requirements())), [])

    def test_every_morpheus_test_is_tagged(self):
        found = morpheus_tests()
        self.assertGreaterEqual(len(found), 40)
        self.assertEqual([name for name, reqs in found if not reqs], [], "Morpheus tests without // @req")


if __name__ == "__main__":
    unittest.main()
