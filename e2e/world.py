"""The hub side of the end-to-end test: l0wagent's real hub core and this repo's board and spaces Workers, each under its own
`wrangler dev --local` (fresh local D1, R2 and Durable Object state in the test's folder), behind `proxy.mjs`, which plays
Cloudflare's routing (`board.<hub>` and `spaces.<hub>` to their Workers, everything else to the hub). The services reach the
hub (and through it, members) by their `HUB` service binding, as in production; wrangler's dev registry connects the three.

Instances are l0wagent's `HubStack`s (control, gateway, tunnel, egress, the runner) with the fake hub swapped for this one."""

from __future__ import annotations

import base64
import os
import secrets
import shutil
import subprocess
import sys
import time
from pathlib import Path

import httpx

HERE = Path(__file__).resolve().parent
SERVICES = HERE.parent
L0WAGENT = Path(os.environ.get("L0WAGENT", SERVICES.parents[2] / "l0wagent")).resolve()
HUB_DIR = L0WAGENT / "hub"
WRANGLER = HUB_DIR / "node_modules" / ".bin" / "wrangler"
DOMAIN = "hub.localhost"
ADMIN = "e2e-admin-token"
HUB_SEED = "lecYjx28aUdQ7GyN8sVZ3kZZdkBrMHqfDC8drU5zC9M"  # the hub's public dev seed (wrangler.dev.toml)

sys.path.insert(0, str(L0WAGENT / "control"))
from tests.stack import HubStack, free_port  # noqa: E402


def _seed() -> str:
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()


class HubWorld:
    def __init__(self, tmp: Path, moderators: tuple[str, ...] = ()):
        self.tmp = tmp
        self.port = free_port()  # the proxy: the hub's one public port
        self.hub_port, self.board_port, self.spaces_port, self.insp = free_port(), free_port(), free_port(), free_port()
        self.base = f"http://{DOMAIN}:{self.port}"
        self.hub_name = f"e2e-hub-{self.port}"
        self.seeds = {"board": _seed(), "spaces": _seed()}
        self.moderators = moderators
        self.procs: dict[str, subprocess.Popen] = {}

    # ── configs ────────────────────────────────────────────────────────────
    def _hub_toml(self) -> Path:
        p = self.tmp / "hub.toml"
        p.write_text(f'''name = "{self.hub_name}"
main = "{HUB_DIR / "src" / "index.ts"}"
compatibility_date = "2026-10-01"
[vars]
HUB_NAME = "E2E hub"
HUB_BASE_URL = "{self.base}"
TUNNEL_URL = "ws://{DOMAIN}:{self.port}/v0/tunnel"
INSTANCE_HOST_PATTERN = "{{name}}.{DOMAIN}:{self.port}"
FILES_HOST_PATTERN = "files--{{name}}.hubfiles.localhost:{self.port}"
MIN_RELEASE = "0.8.0"
HUB_SIGNING_SEED = "{HUB_SEED}"
ADMIN_TOKEN = "{ADMIN}"
[[d1_databases]]
binding = "DB"
database_name = "{self.hub_name}"
database_id = "00000000-0000-0000-0000-000000000001"
migrations_dir = "{HUB_DIR / "migrations"}"
[durable_objects]
bindings = [
  {{ name = "MEMBER", class_name = "MemberRoute" }},
  {{ name = "CONN", class_name = "TunnelConn" }},
]
[[migrations]]
tag = "v1"
new_sqlite_classes = ["MemberRoute", "TunnelConn"]
''')
        return p

    def _service_toml(self, name: str) -> Path:
        common = f'''name = "{self.hub_name}-{name}"
main = "{SERVICES / "services" / name / "src" / "index.ts"}"
compatibility_date = "2026-11-01"
[vars]
HUB_DOMAIN = "{DOMAIN}:{self.port}"
HUB_BASE = "{self.base}"
SERVICE_SEED = "{self.seeds[name]}"
ADMIN_TOKEN = "{name}-admin"
'''
        if name == "board":
            mods = ", ".join(f'"{m}"' for m in self.moderators)
            extra = f'''ROLES = '{{"moderator": [{mods}]}}'
HELD_FIRST_POSTS = "0"
[[d1_databases]]
binding = "DB"
database_name = "{self.hub_name}-board"
database_id = "00000000-0000-0000-0000-000000000002"
'''
        else:
            extra = f'''TICKET_KEY = "{_seed()}"
[[d1_databases]]
binding = "DB"
database_name = "{self.hub_name}-spaces"
database_id = "00000000-0000-0000-0000-000000000003"
[[r2_buckets]]
binding = "BLOBS"
bucket_name = "{self.hub_name}-blobs"
[[durable_objects.bindings]]
name = "SPACE"
class_name = "Space"
[[migrations]]
tag = "v1"
new_sqlite_classes = ["Space"]
'''
        p = self.tmp / f"{name}.toml"
        p.write_text(common + extra + f'''[[services]]
binding = "HUB"
service = "{self.hub_name}"
''')
        return p

    # ── processes ──────────────────────────────────────────────────────────
    def _spawn(self, name: str, argv: list[str], cwd: Path, env: dict | None = None) -> None:
        log = open(self.tmp / f"{name}.log", "ab")
        self.procs[name] = subprocess.Popen(argv, cwd=cwd, stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
                                            env={**os.environ, "WRANGLER_SEND_METRICS": "false", "NO_COLOR": "1", **(env or {})})

    def _wrangler_dev(self, name: str, toml: Path, port: int) -> None:
        state = self.tmp / "state" / name
        state.mkdir(parents=True, exist_ok=True)
        self._spawn(name, [str(WRANGLER), "dev", "--config", str(toml), "--local", "--ip", "127.0.0.1", "--port", str(port),
                           "--inspector-port", str(free_port()), "--persist-to", str(state), "--test-scheduled"], HUB_DIR)

    def up(self) -> HubWorld:
        self.tmp.mkdir(parents=True, exist_ok=True)
        hub = self._hub_toml()
        state = self.tmp / "state" / "hub"
        state.mkdir(parents=True, exist_ok=True)
        r = subprocess.run([str(WRANGLER), "d1", "migrations", "apply", "DB", "--local", "--config", str(hub), "--persist-to", str(state)],
                           cwd=HUB_DIR, capture_output=True, text=True, env={**os.environ, "WRANGLER_SEND_METRICS": "false", "CI": "1"})
        assert r.returncode == 0, r.stdout + r.stderr
        self._spawn("proxy", ["node", str(HERE / "proxy.mjs"), "--port", str(self.port), "--default", f"127.0.0.1:{self.hub_port}",
                              "--route", f"board.{DOMAIN}=127.0.0.1:{self.board_port}", "--route", f"spaces.{DOMAIN}=127.0.0.1:{self.spaces_port}"], HERE)
        self._wrangler_dev("hub", hub, self.hub_port)
        self.wait(f"http://127.0.0.1:{self.port}/.well-known/l0wagent/hub", "the hub")
        self._wrangler_dev("board", self._service_toml("board"), self.board_port)
        self._wrangler_dev("spaces", self._service_toml("spaces"), self.spaces_port)
        self.wait(f"http://127.0.0.1:{self.board_port}/", "the board", host=f"board.{DOMAIN}:{self.port}")
        self.wait(f"http://127.0.0.1:{self.spaces_port}/", "spaces", host=f"spaces.{DOMAIN}:{self.port}")
        for name, title in (("board", "Board"), ("spaces", "Shared spaces")):
            self.register(name, title)
        return self

    def wait(self, url: str, what: str, host: str | None = None, timeout: float = 120) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                r = httpx.get(url, headers={"Host": host or f"{DOMAIN}:{self.port}"}, timeout=3)
                if r.status_code < 500:
                    return
            except httpx.HTTPError:
                pass
            time.sleep(0.5)
        raise AssertionError(f"{what} did not answer within {timeout} s\n{self.logs()}")

    def register(self, name: str, title: str) -> None:
        roles = "moderator" if name == "board" else ""
        argv = ["pnpm", "--silent", "register", "--hub", f"http://127.0.0.1:{self.port}", "--name", name, "--kind", name, "--title", title]
        if roles:
            argv += ["--roles", roles]
        r = subprocess.run(argv, cwd=SERVICES, capture_output=True, text=True, timeout=60,
                           env={**os.environ, "SERVICE_SEED": self.seeds[name], "ADMIN_TOKEN": ADMIN})
        assert r.returncode == 0, f"register {name}: {r.stdout}\n{r.stderr}"

    def invite(self) -> str:
        r = subprocess.run(["node", str(HUB_DIR / "scripts" / "invite.mjs"), "--hub", self.base, "--connect", f"127.0.0.1:{self.port}"],
                           capture_output=True, text=True, timeout=30, env={**os.environ, "HUB_ADMIN_TOKEN": ADMIN})
        assert r.returncode == 0, r.stdout + r.stderr
        return r.stdout.strip().splitlines()[-1]

    def cron(self, name: str) -> None:
        """Run a service's scheduled handler now (wrangler's --test-scheduled)."""
        httpx.get(f"http://127.0.0.1:{getattr(self, f'{name}_port')}/__scheduled", params={"cron": "* * * * *"}, timeout=30)

    def logs(self) -> str:
        return "\n".join(f"── {p.name}\n{p.read_text(errors='replace')[-4000:]}" for p in sorted(self.tmp.glob("*.log")))

    def down(self) -> None:
        for p in self.procs.values():
            try:
                os.killpg(p.pid, 15)
            except (ProcessLookupError, PermissionError):
                pass
        for p in self.procs.values():
            try:
                p.wait(10)
            except subprocess.TimeoutExpired:
                os.killpg(p.pid, 9)


class Instance(HubStack):
    """An instance (control, gateway, tunnel, egress) on the world's hub, with the board and spaces extensions installed."""

    def __init__(self, tmp: Path, world: HubWorld, **kw):
        tmp.mkdir(parents=True, exist_ok=True)
        ext = tmp / "extensions"
        skip = shutil.ignore_patterns("tests", ".venv", "__pycache__", ".pytest_cache", ".ruff_cache", "uv.lock", "pyproject.toml")
        for name in ("board", "spaces"):
            shutil.copytree(SERVICES / "extensions" / name, ext / name, ignore=skip)
        self.world = world
        reach = f"127.0.0.1:{world.port}"
        super().__init__(tmp, hub_port=world.port, hub_host=DOMAIN, tunnel_from_ipv6=True, steps=3, delay=0.2, usage_policy="allow",
                         control_env={"L0W_EXTENSIONS_DIR": str(ext)}, **kw)
        self.gateway_env = {"L0W_HUB_ALLOW_HTTP": "1", "L0W_HUB_CONNECT_TO": reach, "GATEWAY_OUTBOX_MIN_DELAY": "1", "GATEWAY_OUTBOX_INTERVAL": "0.5"}

    def start_hub(self) -> None:  # the world's hub is already up
        pass

    def invite(self) -> str:
        return self.world.invite()
