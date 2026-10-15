from __future__ import annotations

import asyncio
import ctypes
import json
import logging
import os
import shutil
import socket
import sys
from ctypes import wintypes
from ipaddress import IPv4Address, IPv6Address, ip_address
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

import psutil

if TYPE_CHECKING:

    class HostsEntry:
        address: str
        names: list[str]

        @staticmethod
        def str_to_hostentry(entry: str) -> HostsEntry | Literal[False]: ...
else:
    from python_hosts.hosts import HostsEntry

from fora.adapters.websocket.address import normalize_name

Address = IPv4Address | IPv6Address
REFRESH_INTERVAL = 30
COMMAND_TIMEOUT = 2
log = logging.getLogger(__name__)


def unavailable(source: str, category: str) -> None:
    log.debug("Local name source unavailable: %s (%s)", source, category)


def valid_names(values: list[str] | tuple[str, ...]) -> set[str]:
    result = set()
    for value in values:
        try:
            result.add(normalize_name(value))
        except ValueError:
            unavailable("name", "invalid")
    return result


def interface_addresses() -> frozenset[Address]:
    result: set[Address] = set()
    for entries in psutil.net_if_addrs().values():
        for entry in entries:
            if entry.family not in (socket.AF_INET, socket.AF_INET6):
                continue
            if "%" in entry.address:
                continue
            address = ip_address(entry.address)
            if not address.is_unspecified and not address.is_multicast:
                result.add(address)
    return frozenset(result)


def windows_names() -> list[str]:
    windows_api: Any = ctypes
    kernel = windows_api.WinDLL("kernel32", use_last_error=True)
    query = kernel.GetComputerNameExW
    query.argtypes = [ctypes.c_int, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    query.restype = wintypes.BOOL
    result = []
    for kind in (5, 7):
        size = wintypes.DWORD()
        if query(kind, None, ctypes.byref(size)):
            raise RuntimeError("Unexpected computer name size response")
        error = windows_api.get_last_error()
        if error != 234 or not 0 < size.value <= 256:
            unavailable("windows", "name-unavailable")
            continue
        buffer = ctypes.create_unicode_buffer(size.value)
        if not query(kind, buffer, ctypes.byref(size)):
            unavailable("windows", "name-unavailable")
            continue
        result.append(buffer.value)
    return result


def windows_hosts_path() -> Path:
    import winreg

    registry: Any = winreg
    windows_api: Any = ctypes
    kernel = windows_api.WinDLL("kernel32", use_last_error=True)
    expand = kernel.ExpandEnvironmentStringsW
    expand.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD]
    expand.restype = wintypes.DWORD
    try:
        with registry.OpenKey(
            registry.HKEY_LOCAL_MACHINE,
            r"SYSTEM\CurrentControlSet\Services\Tcpip\Parameters",
            0,
            registry.KEY_READ | registry.KEY_WOW64_64KEY,
        ) as key:
            value, kind = registry.QueryValueEx(key, "DataBasePath")
    except FileNotFoundError:
        query = kernel.GetSystemDirectoryW
        query.argtypes = [wintypes.LPWSTR, wintypes.UINT]
        query.restype = wintypes.UINT
        buffer = ctypes.create_unicode_buffer(32768)
        size = query(buffer, len(buffer))
        if not 0 < size < len(buffer):
            raise OSError("System directory unavailable")
        directory = Path(buffer.value) / "drivers" / "etc"
    else:
        if kind not in (registry.REG_SZ, registry.REG_EXPAND_SZ) or not isinstance(
            value, str
        ):
            raise ValueError("Invalid hosts directory")
        if kind == registry.REG_EXPAND_SZ:
            size = expand(value, None, 0)
            if not 0 < size <= 32768:
                raise OSError("Environment expansion unavailable")
            buffer = ctypes.create_unicode_buffer(size)
            written = expand(value, buffer, size)
            if not 0 < written <= size:
                raise OSError("Environment expansion unavailable")
            value = buffer.value
        directory = Path(value)
    if (
        not directory.is_absolute()
        or len(directory.drive) != 2
        or not directory.drive[0].isalpha()
        or directory.drive[1] != ":"
    ):
        raise ValueError("Hosts directory must be a local absolute path")
    if (
        ctypes.sizeof(ctypes.c_void_p) == 4
        and os.environ.get("PROCESSOR_ARCHITEW6432")
        and directory.name.lower() == "etc"
        and directory.parent.name.lower() == "drivers"
    ):
        system = directory.parent.parent
        if system.name.lower() in ("system32", "syswow64"):
            directory = system.parent / "Sysnative" / "drivers" / "etc"
    return directory / "hosts"


def hosts_path() -> Path:
    return windows_hosts_path() if sys.platform == "win32" else Path("/etc/hosts")


def read_hosts(
    path: Path,
    bound: Address,
    interfaces: frozenset[Address],
    os_names: set[str],
    *,
    linux: bool,
) -> set[str]:
    result: set[str] = set()
    short_names = {name for name in os_names if "." not in name}
    with path.open(encoding="utf-8-sig") as source:
        for line in source:
            entry = HostsEntry.str_to_hostentry(line)
            if not entry:
                continue
            address = ip_address(entry.address)
            if address.is_unspecified or address.is_multicast:
                continue
            names = valid_names(entry.names)
            if address == bound or (
                bound.is_unspecified
                and address.version == bound.version
                and address in interfaces
            ):
                result.update(names)
            if linux and (address.is_loopback or address in interfaces):
                associated = short_names.intersection(names)
                result.update(
                    name
                    for name in names
                    if "." in name and name.partition(".")[0] in associated
                )
    return result


def local_configuration(bound: Address) -> tuple[set[str], frozenset[Address]]:
    names: set[str] = set()
    try:
        values = windows_names() if sys.platform == "win32" else [socket.gethostname()]
        names.update(valid_names(values))
        names.update(name.partition(".")[0] for name in tuple(names))
    except OSError:
        unavailable("os", "read-failed")
    try:
        interfaces = interface_addresses()
    except OSError:
        unavailable("interfaces", "read-failed")
        interfaces = frozenset()
    try:
        names.update(
            read_hosts(
                hosts_path(),
                bound,
                interfaces,
                names,
                linux=sys.platform.startswith("linux"),
            )
        )
    except (OSError, UnicodeError, ValueError):
        unavailable("hosts", "read-failed")
    return names, interfaces


async def command(argv: tuple[str, ...], deadline: float) -> bytes | None:
    started: asyncio.Task[asyncio.subprocess.Process] | None = None
    process: asyncio.subprocess.Process | None = None
    try:
        async with asyncio.timeout_at(deadline):
            started = asyncio.create_task(
                asyncio.create_subprocess_exec(
                    *argv,
                    stdin=asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL,
                )
            )
            process = await asyncio.shield(started)
            output, _ = await process.communicate()
            if process.returncode != 0:
                unavailable("command", "nonzero")
                return None
            return output
    except (OSError, TimeoutError):
        unavailable("command", "unavailable")
        return None
    finally:
        if started is not None and process is None:
            try:
                process = await started
            except OSError:
                pass
        if process is not None and process.returncode is None:
            process.kill()
            await process.communicate()


def tailscale_names(
    output: bytes, bound: Address, interfaces: frozenset[Address]
) -> set[str]:
    status = json.loads(output)
    if not isinstance(status, dict) or status.get("BackendState") != "Running":
        return set()
    own = status.get("Self")
    if not isinstance(own, dict) or own.get("Online") is not True:
        return set()
    value = own.get("DNSName")
    addresses = own.get("TailscaleIPs")
    if not isinstance(value, str) or not isinstance(addresses, list):
        return set()
    if not all(isinstance(item, str) for item in addresses):
        return set()
    own_addresses = {ip_address(item) for item in addresses}
    if bound.is_unspecified:
        if not any(
            address.version == bound.version and address in interfaces
            for address in own_addresses
        ):
            return set()
    elif bound not in own_addresses:
        return set()
    name = normalize_name(value)
    result = {name}
    tailnet = status.get("CurrentTailnet")
    if isinstance(tailnet, dict) and isinstance(tailnet.get("MagicDNSSuffix"), str):
        suffix = normalize_name(tailnet["MagicDNSSuffix"])
        if name.endswith("." + suffix):
            short = name[: -len(suffix) - 1]
            if "." not in short:
                result.add(short)
    return result


async def collect_names(bound: Address) -> frozenset[str]:
    task = asyncio.create_task(asyncio.to_thread(local_configuration, bound))
    try:
        names, interfaces = await asyncio.shield(task)
    except asyncio.CancelledError:
        await task
        raise
    deadline = asyncio.get_running_loop().time() + COMMAND_TIMEOUT
    if sys.platform == "darwin":
        for preference in ("HostName", "LocalHostName"):
            output = await command(("/usr/sbin/scutil", "--get", preference), deadline)
            if output is None:
                continue
            try:
                name = normalize_name(output.decode("utf-8").strip())
                if preference == "LocalHostName":
                    if "." in name:
                        unavailable("macos", "invalid")
                        continue
                    names.update((name, name + ".local"))
                else:
                    names.update((name, name.partition(".")[0]))
            except (UnicodeError, ValueError):
                unavailable("macos", "invalid")
    executable = shutil.which("tailscale")
    if executable is not None:
        output = await command(
            (executable, "status", "--json", "--peers=false"), deadline
        )
        if output is not None:
            try:
                names.update(tailscale_names(output, bound, interfaces))
            except (ValueError, UnicodeError):
                unavailable("tailscale", "invalid")
    return frozenset(names)
