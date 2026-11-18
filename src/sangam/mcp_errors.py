"""Canonical mutation evidence carried across App retries."""

from typing import Literal

from sangam.errors import SangamError


class McpMutationError(SangamError):
    def __init__(
        self, error: SangamError, key: str, outcome: Literal["rejected", "committed", "unknown"]
    ):
        super().__init__(error.message)
        self.code = error.code
        self.key, self.outcome = key, outcome
