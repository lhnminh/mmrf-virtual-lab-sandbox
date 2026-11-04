"""Checks a recorded answer quotes only numbers from tool summaries. Task 8 runs check_numbers
against saved streams; the tests here cover the check itself."""
import re
import unittest

# A number on its own. The digits inside TP53, p.G12V or c.35G>A are names, not numbers.
_NUMBER = re.compile(r"(?<![A-Za-z0-9_.])(?<![A-Za-z]-)\d+(?:,\d{3})*(?:\.\d+)?(?![A-Za-z0-9_])")


def _numbers(text: str) -> list[str]:
    return _NUMBER.findall(text)


def _value(number: str) -> str:
    return number.replace(",", "")


def check_numbers(answer: str, summaries: list[str]) -> list[str]:
    """Numbers in the answer, as written, that aren't in any summary."""
    allowed = {_value(number) for summary in summaries for number in _numbers(summary)}
    missing = []
    for number in _numbers(answer):
        if _value(number) not in allowed and number not in missing:
            missing.append(number)
    return missing


class CheckNumbers(unittest.TestCase):
    def test_quoted_numbers_pass(self):
        summary = "KRAS (148), NRAS (113) and DIS3 (100). The matrix shows 282 of the 334 cases."
        answer = "KRAS (148), NRAS (113) and DIS3 (100) are the most mutated, in 282 of the 334 cases."
        self.assertEqual(check_numbers(answer, [summary]), [])

    def test_invented_numbers_are_returned_as_written(self):
        self.assertEqual(check_numbers("About 1,200 cases, or 44.5%.", ["334 cases."]), ["1,200", "44.5"])

    def test_any_summary_counts(self):
        self.assertEqual(check_numbers("334 and 148.", ["334 cases.", "148 samples."]), [])

    def test_commas_do_not_matter(self):
        self.assertEqual(check_numbers("1,000 cases", ["from 1000 to 334"]), [])
        self.assertEqual(check_numbers("1000 cases", ["from 1,000 to 334"]), [])

    def test_names_with_digits_are_not_numbers(self):
        answer = "TP53, DIS3, p.Q61H, p.G12V, c.35G>A and COVID-19 appear."
        self.assertEqual(check_numbers(answer, []), [])

    def test_a_name_in_a_summary_does_not_allow_its_digits(self):
        self.assertEqual(check_numbers("There were 53.", ["TP53 was found."]), ["53"])

    def test_sentence_punctuation_is_not_part_of_a_number(self):
        self.assertEqual(check_numbers("It had 148, then 113.", ["148 and 113"]), [])

    def test_both_ends_of_a_range_are_checked(self):
        self.assertEqual(check_numbers("Between 10-20.", ["10"]), ["20"])

    def test_repeats_are_returned_once(self):
        self.assertEqual(check_numbers("7 and 7", []), ["7"])

    def test_no_numbers(self):
        self.assertEqual(check_numbers("No numbers here.", []), [])


if __name__ == "__main__":
    unittest.main()
