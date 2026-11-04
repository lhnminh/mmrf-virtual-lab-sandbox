"""The Lambda package: what it holds, and that rebuilding unchanged code changes nothing."""

import importlib.util
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("build_lambda", ROOT / "scripts/build_lambda.py")
build_lambda = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build_lambda)


def build(monkeypatch, output: Path) -> bytes:
    monkeypatch.setattr(build_lambda, "install", lambda target: None)
    monkeypatch.setattr(build_lambda, "OUTPUT", output)
    build_lambda.main()
    return output.read_bytes()


def test_package_holds_both_handlers_at_its_root(monkeypatch, tmp_path):
    output = tmp_path / "nested" / "lambda.zip"
    build(monkeypatch, output)
    assert {"handler.py", "load_neo4j.py"} <= set(zipfile.ZipFile(output).namelist())


def test_rebuilding_unchanged_code_gives_identical_bytes(monkeypatch, tmp_path):
    output = tmp_path / "lambda.zip"
    assert build(monkeypatch, output) == build(monkeypatch, output)


def test_default_output_is_the_path_terraform_reads():
    assert build_lambda.OUTPUT == ROOT / "build" / "lambda.zip"
