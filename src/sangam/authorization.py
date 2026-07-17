from __future__ import annotations

from sangam.capabilities import Capability
from sangam.errors import AuthorizationError
from sangam.security import Principal, path_matches


class AuthorizationPolicy:
    """Deny-by-default capability and normalized workspace-prefix policy."""

    @staticmethod
    def allows(principal: Principal, capability: Capability, path: str | None) -> bool:
        if principal.administrator or principal.identity_kind == "system":
            return True
        return any(
            grant.capability == capability and path_matches(grant.path_prefix, path)
            for grant in principal.scopes
        )

    def require(self, principal: Principal, capability: Capability, path: str | None) -> None:
        if self.allows(principal, capability, path):
            return
        raise AuthorizationError(
            "The authenticated actor is not allowed to perform this operation",
            details={"capability": capability.value, "path": path},
        )

    @staticmethod
    def require_administrator(principal: Principal) -> None:
        if not principal.administrator:
            raise AuthorizationError("This operation requires the trusted human administrator")

    @staticmethod
    def allowed_prefixes(principal: Principal, *capabilities: Capability) -> tuple[str, ...] | None:
        """Return the path union allowed by every requested capability.

        ``None`` means unrestricted, while an empty tuple means no visible path.
        The latter distinction keeps unmaterialized documents visible only to a
        principal with a global grant.
        """
        if principal.administrator or principal.identity_kind == "system":
            return None
        grants_by_capability = [
            [grant.path_prefix for grant in principal.scopes if grant.capability == capability]
            for capability in capabilities
        ]
        if not grants_by_capability or any(not grants for grants in grants_by_capability):
            return ()
        intersections = grants_by_capability[0]
        for grants in grants_by_capability[1:]:
            narrowed: list[str | None] = []
            for left in intersections:
                for right in grants:
                    matched, intersection = AuthorizationPolicy._intersect_prefixes(left, right)
                    if matched:
                        narrowed.append(intersection)
            intersections = narrowed
        if any(prefix is None for prefix in intersections):
            return None
        minimal: list[str] = []
        for prefix in sorted(set(intersections), key=lambda value: (len(value or ""), value or "")):
            if prefix is not None and not any(path_matches(parent, prefix) for parent in minimal):
                minimal.append(prefix)
        return tuple(minimal)

    @staticmethod
    def _intersect_prefixes(left: str | None, right: str | None) -> tuple[bool, str | None]:
        if left is None:
            return True, right
        if right is None:
            return True, left
        if path_matches(left, right):
            return True, right
        if path_matches(right, left):
            return True, left
        return False, None
