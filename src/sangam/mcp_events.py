"""Authorized resource invalidation over the standard MCP listen stream.

Each stream observes canonical state, including REST/UI writes. Notifications
contain only URIs. Reconnect means subscribe again and read current state.
"""

import asyncio
import hashlib
import json
from collections.abc import Callable
from contextlib import suppress
from dataclasses import replace
from typing import Any

from mcp.server.context import CallNext, HandlerResult, ServerRequestContext
from mcp.server.subscriptions import InMemorySubscriptionBus, ListenHandler, ResourceUpdated
from mcp.shared.exceptions import MCPError
from mcp.types import INVALID_PARAMS, SubscriptionFilter, SubscriptionsListenRequestParams
from pydantic import JsonValue
from starlette.requests import Request

from sangam.errors import SangamError


class ResourceSubscriptions:
    """Bounded listeners with independent authority and SDK-owned wire framing."""

    def __init__(self, read: Callable[[str, str], dict[str, JsonValue]]) -> None:
        self.read = read
        self.active = 0

    def snapshot(self, token: str, uris: list[str]) -> dict[str, str]:
        return {
            uri: hashlib.sha256(
                json.dumps(self.read(token, uri), sort_keys=True).encode()
            ).hexdigest()
            for uri in uris
        }

    async def __call__(
        self, ctx: ServerRequestContext[Any, Any], call_next: CallNext
    ) -> HandlerResult:
        if ctx.method != "subscriptions/listen" or ctx.protocol_version != "2026-07-28":
            return await call_next(ctx)
        params = SubscriptionsListenRequestParams.model_validate(ctx.params)
        uris = list(dict.fromkeys(params.notifications.resource_subscriptions or []))
        if not uris or len(uris) > 25 or self.active >= 64:
            raise MCPError(INVALID_PARAMS, "Resource subscription limit reached")
        self.active += 1
        try:
            return await self.listen(ctx, params, uris)
        finally:
            self.active -= 1

    async def listen(
        self,
        ctx: ServerRequestContext[Any, Any],
        params: SubscriptionsListenRequestParams,
        uris: list[str],
    ) -> HandlerResult:
        if not isinstance(ctx.request, Request):
            raise MCPError(INVALID_PARAMS, "An authenticated HTTP connection is required")
        token = ctx.request.headers.get("authorization", "").partition(" ")[2].strip()
        try:
            previous = await asyncio.to_thread(self.snapshot, token, uris)
        except SangamError as error:
            raise MCPError(INVALID_PARAMS, error.message) from error
        params.notifications = SubscriptionFilter(resource_subscriptions=uris or None)
        bus = InMemorySubscriptionBus()
        handler = ListenHandler(bus, max_subscriptions=1, max_buffered_events=64)

        async def observe() -> None:
            nonlocal previous
            while True:
                await asyncio.sleep(1)
                try:
                    current = await asyncio.to_thread(self.snapshot, token, uris)
                except SangamError:
                    handler.close()
                    return
                except Exception:
                    handler.close()
                    raise
                for uri, version in current.items():
                    if version != previous[uri]:
                        await bus.publish(ResourceUpdated(uri))
                previous = current

        monitor = asyncio.create_task(observe())
        try:
            return await handler(replace(ctx, params=params.model_dump(by_alias=True)), params)
        finally:
            monitor.cancel()
            with suppress(asyncio.CancelledError):
                await monitor
            handler.close()
