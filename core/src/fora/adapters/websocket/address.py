from __future__ import annotations

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
    ):
        raise ValueError("invalid origin")
    host = validate_host(url.raw_host)
    return URL.build(scheme=url.scheme, host=host, port=url.explicit_port).origin()
