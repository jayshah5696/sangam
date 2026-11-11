from __future__ import annotations

import io
import logging

import pytest

from sangam.security import SanitizingLogFilter, configure_sanitizing_logging


@pytest.mark.parametrize(
    ("message", "args", "expected"),
    [
        ("password=%s", ("ordinary-secret-value",), "password=[REDACTED]"),
        (
            "password=%s document=%s",
            ("ordinary-secret-value", "guide.md"),
            "password=[REDACTED] document=guide.md",
        ),
        (
            "password=%(password)s document=%(document)s",
            ({"password": "ordinary-secret-value", "document": "guide.md"},),
            "password=[REDACTED] document=guide.md",
        ),
        (
            "document=%s count=%d elapsed=%.2f",
            ("guide.md", 3, 1.5),
            "document=guide.md count=3 elapsed=1.50",
        ),
    ],
)
def test_log_filter_preserves_formatting(message: str, args: tuple, expected: str) -> None:
    record = logging.LogRecord("sangam.test", logging.INFO, __file__, 1, message, args, None)
    log_filter = SanitizingLogFilter()
    assert log_filter.filter(record)
    assert logging.Formatter().format(record) == expected
    assert log_filter.filter(record)
    assert logging.Formatter().format(record) == expected


def test_log_filter_redacts_exception_and_stack_output() -> None:
    output = io.StringIO()
    handler = logging.StreamHandler(output)
    handler.addFilter(SanitizingLogFilter())
    logger = logging.getLogger("sangam.test.exception")
    logger.addHandler(handler)
    try:
        try:
            try:
                raise ValueError("password=inner-secret-value")
            except ValueError as error:
                raise RuntimeError("token=outer-secret-value") from error
        except RuntimeError:
            logger.exception("Scheduled backup failed", stack_info=True)
    finally:
        logger.removeHandler(handler)
        handler.close()
    rendered = output.getvalue()
    assert "inner-secret-value" not in rendered
    assert "outer-secret-value" not in rendered
    assert "Traceback" in rendered
    assert "ValueError: password=[REDACTED]" in rendered
    assert "RuntimeError: token=[REDACTED]" in rendered
    assert "Stack" in rendered


def test_log_filter_redacts_cached_traceback_and_stack() -> None:
    record = logging.LogRecord("sangam.test", logging.ERROR, __file__, 1, "Failed", (), None)
    record.exc_text = "ValueError: password=cached-secret-value"
    record.stack_info = "Stack: token=stack-secret-value"
    assert SanitizingLogFilter().filter(record)
    rendered = logging.Formatter().format(record)
    assert "cached-secret-value" not in rendered
    assert "stack-secret-value" not in rendered
    assert "ValueError: password=[REDACTED]" in rendered
    assert "Stack: token=[REDACTED]" in rendered


def test_configured_logging_redacts_propagated_records() -> None:
    output = io.StringIO()
    handler = logging.StreamHandler(output)
    root = logging.getLogger()
    root.addHandler(handler)
    try:
        configure_sanitizing_logging()
        configure_sanitizing_logging()
        assert sum(isinstance(f, SanitizingLogFilter) for f in handler.filters) == 1
        logger = logging.getLogger("sangam.test.propagated")
        logger.error("password=%s", "propagated-secret-value")
        assert output.getvalue().strip() == "password=[REDACTED]"
    finally:
        root.removeHandler(handler)
        handler.close()
