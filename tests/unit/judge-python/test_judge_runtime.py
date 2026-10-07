"""Runtime setup protects SDK imports and restores each request's network scope."""

import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

EVALUATION = Path(__file__).resolve().parents[3] / "tools/evaluation"


def run_isolated(source):
    result = subprocess.run(
        [sys.executable, "-c", textwrap.dedent(source)],
        cwd=EVALUATION,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr


def test_runtime_setup_is_explicit_and_installs_one_working_guard():
    run_isolated("""
        import os
        import sys
        os.environ["DEEPEVAL_TELEMETRY_ENABLED"] = "caller-value"
        hooks = []
        original = sys.addaudithook
        def install(hook):
            hooks.append(hook)
            original(hook)
        sys.addaudithook = install
        import judge_runtime
        import judge_settings
        assert os.environ["DEEPEVAL_TELEMETRY_ENABLED"] == "caller-value"
        assert not hooks
        judge_runtime.initialize_runtime()
        judge_runtime.initialize_runtime()
        assert len(hooks) == 1
        assert os.environ["DEEPEVAL_TELEMETRY_ENABLED"] == "0"
        assert os.environ["DEEPEVAL_DISABLE_DOTENV"] == "1"
        try:
            sys.audit("socket.getaddrinfo", "example.com", 443)
        except PermissionError:
            pass
        else:
            raise AssertionError("Unguarded network access")
    """)


def test_grading_initializes_privacy_before_importing_deepeval():
    run_isolated("""
        import importlib.abc
        import os
        import sys
        expected = {
            "DEEPEVAL_TELEMETRY_OPT_OUT": "1",
            "DEEPEVAL_TELEMETRY_ENABLED": "0",
            "DEEPEVAL_DISABLE_DOTENV": "1",
            "DEEPEVAL_UPDATE_WARNING_OPT_IN": "0",
            "DEEPEVAL_FILE_SYSTEM": "READ_ONLY",
            "CONFIDENT_TRACE_FLUSH": "0",
        }
        for key in expected:
            os.environ[key] = "caller-value"
        imports = []
        class Observe(importlib.abc.MetaPathFinder):
            def find_spec(self, fullname, path=None, target=None):
                if fullname == "deepeval":
                    imports.append(fullname)
                    assert all(os.environ[key] == value for key, value in expected.items())
                    try:
                        sys.audit("socket.connect", None, ("127.0.0.1", 443))
                    except PermissionError:
                        pass
                    else:
                        raise AssertionError("SDK imported without network guard")
        sys.meta_path.insert(0, Observe())
        import support_grading
        assert imports == ["deepeval"]
    """)


@pytest.mark.parametrize("failure", [ValueError, KeyboardInterrupt])
def test_nested_request_scopes_restore_destination_and_permissions(failure):
    import judge_runtime as runtime

    with runtime.request_scope(("proxy", 8080)):
        runtime.restrict_network("socket.getaddrinfo", ("proxy", 8080))
        with pytest.raises(failure):
            with runtime.request_scope(("openrouter.ai", 443)):
                runtime.restrict_network("socket.getaddrinfo", ("openrouter.ai", 443))
                with pytest.raises(PermissionError):
                    runtime.restrict_network("socket.getaddrinfo", ("proxy", 8080))
                raise failure("Request interrupted")
        runtime.restrict_network("socket.getaddrinfo", ("proxy", 8080))
        with pytest.raises(PermissionError):
            runtime.restrict_network("socket.getaddrinfo", ("openrouter.ai", 443))
    with pytest.raises(PermissionError):
        runtime.restrict_network("socket.getaddrinfo", ("proxy", 8080))


def test_socket_factory_uses_resolved_addresses_and_closes_failed_socket(monkeypatch):
    import judge_runtime as runtime

    attempts = []
    closed = []
    ipv4 = ("203.0.113.1", 443)
    ipv6 = ("2001:db8::1", 443, 0, 0)
    monkeypatch.setattr(
        runtime.socket,
        "getaddrinfo",
        lambda *args, **kwargs: [
            (runtime.socket.AF_INET, runtime.socket.SOCK_STREAM, 6, "", ipv4),
            (runtime.socket.AF_INET6, runtime.socket.SOCK_STREAM, 6, "", ipv6),
        ],
    )

    class Socket:
        def __init__(self, family, kind, protocol):
            self.family = family

        def settimeout(self, value):
            assert value == 180

        def connect(self, address):
            runtime.restrict_network("socket.connect", (self, address))
            attempts.append(address)
            if self.family == runtime.socket.AF_INET:
                raise OSError("Unreachable")

        def close(self):
            closed.append(self.family)

    monkeypatch.setattr(runtime.socket, "socket", Socket)
    with runtime.request_scope(("openrouter.ai", 443)):
        connection = runtime.connect_openrouter(("openrouter.ai", 443), 180)
        assert connection.family == runtime.socket.AF_INET6
        with pytest.raises(PermissionError):
            runtime.restrict_network(
                "socket.connect", (connection, ("203.0.113.2", 443))
            )
    assert attempts == [ipv4, ipv6]
    assert closed == [runtime.socket.AF_INET]


def test_request_scopes_are_isolated_between_threads():
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    import judge_runtime as runtime

    ready = Barrier(2)
    destinations = [("openrouter.ai", 443), ("proxy", 8080)]

    def request(index):
        with runtime.request_scope(destinations[index]):
            ready.wait(timeout=5)
            runtime.restrict_network("socket.getaddrinfo", destinations[index])
            with pytest.raises(PermissionError):
                runtime.restrict_network("socket.getaddrinfo", destinations[1 - index])
        with pytest.raises(PermissionError):
            runtime.restrict_network("socket.getaddrinfo", destinations[index])

    with ThreadPoolExecutor(max_workers=2) as executor:
        list(executor.map(request, range(2)))


def test_transport_initializes_guard_without_sdk_and_closes_outside_scope():
    run_isolated("""
        import os
        import sys
        from pydantic import BaseModel
        import openrouter_transport as transport
        os.environ["OPENROUTER_API_KEY"] = "offline-key"
        os.environ.pop("https_proxy", None)
        os.environ.pop("HTTPS_PROXY", None)
        closed = []
        class Verdict(BaseModel):
            score: int
        class Connection:
            def __init__(self, *args, **kwargs):
                pass
            def request(self, *args):
                sys.audit("socket.getaddrinfo", "openrouter.ai", 443)
                try:
                    sys.audit("socket.getaddrinfo", "example.com", 443)
                except PermissionError:
                    pass
                else:
                    raise AssertionError("Request destination not guarded")
                raise TimeoutError("No response")
            def close(self):
                try:
                    sys.audit("socket.getaddrinfo", "openrouter.ai", 443)
                except PermissionError:
                    closed.append(True)
                else:
                    raise AssertionError("Request scope still active during close")
        transport.http.client.HTTPSConnection = Connection
        records = []
        try:
            transport.request_verdict({}, Verdict, records)
        except TimeoutError:
            pass
        else:
            raise AssertionError("Transport error was swallowed")
        assert closed == [True]
        assert len(records) == 1
        assert records[0]["errorType"] == "TimeoutError"
        assert "deepeval" not in sys.modules
    """)
