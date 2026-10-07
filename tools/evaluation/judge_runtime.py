"""Explicit privacy setup and scoped network access for judge requests."""

import os
import socket
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from threading import Lock

type SocketAddress = tuple[str, int] | tuple[str, int, int, int] | tuple[int, bytes]

_openrouter_request: ContextVar[set[SocketAddress] | None] = ContextVar(
    "openrouter_request", default=None
)
_openrouter_transport = ContextVar(
    "openrouter_transport", default=("openrouter.ai", 443)
)


def restrict_network(event: str, args: tuple[object, ...]) -> None:
    # The adapter fixes the HTTPS destination and verifies its TLS certificate.
    # Background SDK calls remain blocked, including during threaded judging.
    destinations = _openrouter_request.get()
    if destinations is not None:
        if event == "socket.getaddrinfo" and args[:2] != _openrouter_transport.get():
            raise PermissionError("Judge evaluation permits only OpenRouter resolution")
        if event == "socket.connect":
            address = args[1]
            if not isinstance(address, tuple) or address not in destinations:
                raise PermissionError("Judge evaluation permits only OpenRouter HTTPS")
        return
    if event in ("socket.getaddrinfo", "socket.connect"):
        raise PermissionError(
            "Judge network access requires an explicit OpenRouter request"
        )


def connect_openrouter(
    address: tuple[str, int],
    timeout: float,
    source_address: tuple[str, int] | None = None,
) -> socket.socket:
    if address != _openrouter_transport.get() or source_address is not None:
        raise PermissionError("Unexpected judge HTTPS destination")
    destinations = _openrouter_request.get()
    if destinations is None:
        raise PermissionError("OpenRouter connection outside an explicit judge request")
    last_error = None
    # Use these resolved addresses directly; no second DNS lookup or redirects.
    for family, kind, protocol, _, destination in socket.getaddrinfo(
        *address, type=socket.SOCK_STREAM
    ):
        destinations.add(destination)
        connection = socket.socket(family, kind, protocol)
        try:
            connection.settimeout(timeout)
            connection.connect(destination)
            return connection
        except OSError as error:
            last_error = error
            connection.close()
    raise last_error or OSError("OpenRouter has no reachable HTTPS address")


_initialization_lock = Lock()
_initialized = False


def initialize_runtime() -> None:
    """Disable SDK side effects and install the process-wide guard once."""
    global _initialized
    with _initialization_lock:
        # Set these before importing DeepEval, regardless of the caller's environment.
        os.environ.update(
            {
                "DEEPEVAL_TELEMETRY_OPT_OUT": "1",
                "DEEPEVAL_TELEMETRY_ENABLED": "0",
                "DEEPEVAL_DISABLE_DOTENV": "1",
                "DEEPEVAL_UPDATE_WARNING_OPT_IN": "0",
                "DEEPEVAL_FILE_SYSTEM": "READ_ONLY",
                "CONFIDENT_TRACE_FLUSH": "0",
            }
        )

        if not _initialized:
            sys.addaudithook(restrict_network)
            _initialized = True


@contextmanager
def request_scope(destination: tuple[str, int]) -> Iterator[None]:
    """Permit only this request's transport and restore the enclosing scope."""
    initialize_runtime()
    transport_scope = _openrouter_transport.set(destination)
    network_scope = _openrouter_request.set(set())
    try:
        yield
    finally:
        _openrouter_request.reset(network_scope)
        _openrouter_transport.reset(transport_scope)
