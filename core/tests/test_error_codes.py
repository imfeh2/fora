from __future__ import annotations

import ast
from pathlib import Path

from fora.core.error_codes import ErrorCode

SOURCE = Path(__file__).resolve().parent.parent / "src" / "fora"
CATALOG = SOURCE / "core" / "error_codes.py"


def catalog_values() -> list[str]:
    return [
        value
        for name, value in vars(ErrorCode).items()
        if not name.startswith("_") and isinstance(value, str)
    ]


def code_arguments(tree: ast.AST) -> list[ast.expr]:
    arguments: list[ast.expr] = []
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id in ("DomainError", "_edit_error")
            and node.args
        ):
            arguments.append(node.args[0])
    return arguments


def test_the_catalog_has_no_duplicate_codes() -> None:
    names = [name for name in vars(ErrorCode) if not name.startswith("_")]
    values = catalog_values()
    assert len(names) == len(values)
    assert len(set(values)) == len(values)


def test_every_code_argument_is_a_catalog_entry() -> None:
    assert CATALOG.is_file()
    values = catalog_values()
    checked = 0
    for path in sorted(SOURCE.rglob("*.py")):
        tree = ast.parse(path.read_text())
        for argument in code_arguments(tree):
            checked += 1
            if isinstance(argument, ast.Constant):
                assert isinstance(argument.value, str)
                assert argument.value in values, (
                    f"{path}: {argument.value} is not in the catalog"
                )
            elif (
                isinstance(argument, ast.Attribute)
                and isinstance(argument.value, ast.Name)
                and argument.value.id == "ErrorCode"
            ):
                assert argument.attr in vars(ErrorCode), (
                    f"{path}: ErrorCode.{argument.attr} does not exist"
                )
    assert checked > 300


def test_layers_do_not_write_code_literals() -> None:
    offenders = []
    for path in sorted(SOURCE.rglob("*.py")):
        if path == CATALOG:
            continue
        for argument in code_arguments(ast.parse(path.read_text())):
            if isinstance(argument, ast.Constant) and isinstance(argument.value, str):
                offenders.append(f"{path.relative_to(SOURCE)}: {argument.value}")
    assert offenders == []
