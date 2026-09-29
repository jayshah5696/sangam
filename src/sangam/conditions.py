from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass

from sangam.errors import PreconditionError, ValidationError
from sangam.schemas import Document


@dataclass(frozen=True)
class EntityTag:
    opaque: str
    weak: bool = False


@dataclass(frozen=True)
class TagCondition:
    wildcard: bool
    tags: tuple[EntityTag, ...] = ()

    def matches(self, etag: str, *, strong: bool) -> bool:
        return self.wildcard or any(
            tag.opaque == etag[1:-1] and (not strong or not tag.weak) for tag in self.tags
        )


_ENTITY_TAG = re.compile(r'(W/)?"([\x21\x23-\x7e\x80-\xff]*)"')


def parse_condition(value: str | None) -> TagCondition | None:
    """Parse RFC entity tags without splitting commas inside opaque tags."""
    if value is None:
        return None
    value = value.strip(" \t")
    if value == "*":
        return TagCondition(wildcard=True)
    tags: list[EntityTag] = []
    position = 0
    # RFC list syntax permits empty members. A wholly empty field is rejected.
    while position < len(value):
        if value[position] in " \t,":
            position += 1
            continue
        match = _ENTITY_TAG.match(value, position)
        if match is None:
            raise ValidationError("Malformed HTTP entity-tag condition")
        tags.append(EntityTag(match[2], weak=match[1] is not None))
        position = match.end()
        while position < len(value) and value[position] in " \t":
            position += 1
        if position < len(value) and value[position] != ",":
            raise ValidationError("Malformed HTTP entity-tag condition")
    if not tags:
        raise ValidationError("HTTP entity-tag condition must contain a tag or wildcard")
    return TagCondition(wildcard=False, tags=tuple(tags))


def document_etag(document: Document) -> str:
    payload = json.dumps(
        document.model_dump(mode="json"), sort_keys=True, separators=(",", ":"), ensure_ascii=True
    ).encode()
    return '"' + hashlib.sha256(payload).hexdigest() + '"'


def artifact_etag(content: bytes, content_type: str) -> str:
    return '"' + hashlib.sha256(content_type.encode() + b"\x00" + content).hexdigest() + '"'


@dataclass(frozen=True)
class Preconditions:
    match: TagCondition | None
    none_match: TagCondition | None

    @classmethod
    def parse(cls, if_match: str | None, if_none_match: str | None) -> Preconditions:
        return cls(parse_condition(if_match), parse_condition(if_none_match))

    def evaluate(self, etag: str, *, read: bool = False) -> bool:
        if self.match is not None and not self.match.matches(etag, strong=True):
            raise PreconditionError("If-Match precondition failed")
        if self.none_match is not None and self.none_match.matches(etag, strong=False):
            if read:
                return False
            raise PreconditionError("If-None-Match precondition failed")
        return True


@dataclass(frozen=True)
class ConditionalMutation:
    """Request identity and storage validator shared by nested storage operations.

    The API boundary owns this context on its worker thread. Storage evaluates
    the validator after replay lookup and before writing in its own transaction.
    The fingerprint is the supplied request, never a resolved wildcard revision.
    """

    fingerprint: str
    validate: Callable[[sqlite3.Connection], None]


_mutation: ContextVar[ConditionalMutation | None] = ContextVar("conditional_mutation", default=None)


def conditional_fingerprint() -> str | None:
    mutation = _mutation.get()
    return mutation.fingerprint if mutation else None


def validate_storage_condition(connection: sqlite3.Connection) -> None:
    mutation = _mutation.get()
    if mutation is not None:
        mutation.validate(connection)


@contextmanager
def conditional_mutation(mutation: ConditionalMutation) -> Iterator[None]:
    token = _mutation.set(mutation)
    try:
        yield
    finally:
        _mutation.reset(token)
