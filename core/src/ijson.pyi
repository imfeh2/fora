from decimal import Decimal
from typing import Literal, Protocol

type _Scalar = str | int | float | bool | Decimal | None
type _EventName = Literal[
    "start_map",
    "end_map",
    "start_array",
    "end_array",
    "map_key",
    "null",
    "boolean",
    "integer",
    "double",
    "number",
    "string",
]
type _Event = tuple[str, _EventName, _Scalar]

class JSONError(Exception): ...
class IncompleteJSONError(JSONError): ...

class sendable_list[T](list[T]):
    def send(self, value: T, /) -> None: ...

class _EventSink(Protocol):
    def send(self, value: _Event, /) -> object: ...

class _Parser(Protocol):
    def send(self, value: bytes, /) -> object: ...
    def close(self) -> None: ...

def parse_coro(
    target: _EventSink,
    *,
    use_float: bool = False,
    multiple_values: bool = False,
    allow_comments: bool = False,
) -> _Parser: ...
