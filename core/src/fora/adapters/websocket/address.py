from __future__ import annotations

import re
from ipaddress import ip_address

from yarl import URL

HOST = "127.0.0.1"


def validate_host(value: str) -> str:
    if not value or any(
        character.isspace() or ord(character) < 33 or ord(character) == 127
        for character in value
    ):
        raise ValueError(
            "host must be a nonempty hostname or IP address without whitespace"
        )
    if "%" in value:
        raise ValueError("IPv6 zone identifiers and escaped hosts are not supported")
    if any(character in value for character in "[]/\\@?#"):
        raise ValueError(
            "host must contain only a hostname or an unbracketed IP address"
        )
    if ":" in value:
        return str(ip_address(value))
    url = URL.build(scheme="http", host=value)
    host = url.raw_host
    if host is None:
        raise ValueError("host must be a hostname or IP address")
    return host.lower().removesuffix(".")


def normalize_name(value: str) -> str:
    host = validate_host(value).lower()
    if len(host) > 253 or not all(
        re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
        for label in host.split(".")
    ):
        raise ValueError("invalid DNS name")
    if all(label.isdecimal() for label in host.split(".")):
        raise ValueError("numeric names are not DNS names")
    return host


def normalize_network_host(value: str) -> str:
    host = validate_host(value)
    try:
        return str(ip_address(host))
    except ValueError:
        return normalize_name(value)


def public_hosts(values: list[str]) -> frozenset[str]:
    result = set()
    for value in values:
        value = value.strip()
        if value.startswith("."):
            result.add("." + normalize_name(value[1:]))
        else:
            result.add(normalize_network_host(value))
    return frozenset(result)


def matches_public_host(host: str, allowed: frozenset[str]) -> bool:
    return any(
        host == entry
        or entry.startswith(".")
        and (host == entry[1:] or host.endswith(entry))
        for entry in allowed
    )


def parse_authority(value: str, scheme: str = "http") -> URL:
    if not value or value.endswith(":"):
        raise ValueError("invalid authority")
    return parse_origin(f"{scheme}://{value}")


def http_origin(host: str, port: int) -> str:
    return str(URL.build(scheme="http", host=host, port=port).origin())


def parse_origin(value: str) -> URL:
    if not value or any(
        character.isspace() or ord(character) < 33 or ord(character) == 127
        for character in value
    ):
        raise ValueError("invalid origin")
    url = URL(value)
    if (
        not url.scheme
        or url.raw_host is None
        or url.user is not None
        or url.password is not None
        or str(url.relative())
        or "?" in value
        or "#" in value
        or "%" in url.raw_host
        or value.endswith(":")
    ):
        raise ValueError("invalid origin")
    host = normalize_network_host(url.raw_host)
    return URL.build(scheme=url.scheme, host=host, port=url.explicit_port).origin()
