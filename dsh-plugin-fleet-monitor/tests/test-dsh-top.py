#!/usr/bin/env python3
"""Prueba interactiva de dsh-top sobre un pseudo-terminal real.

Comprueba: paginacion, filtro, peticion de conmutacion (con estado simulado)
y salida limpia. No toca el modo real: usa DSH_FLEET_STATE_DIR=/tmp/...
"""
import json
import os
import pty
import re
import select
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(os.path.dirname(HERE), "bin", "dsh-top")
ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]")


def strip(text):
    return ANSI.sub("", text)


def run():
    state_dir = tempfile.mkdtemp(prefix="dsh-top-test-")
    with open(os.path.join(state_dir, "state.json"), "w") as fh:
        json.dump({"mode": "standard", "pid": os.getpid(), "at": "test"}, fh)

    env = dict(os.environ)
    env.update({
        "DSH_FLEET_STATE_DIR": state_dir,
        "DSH_FLEET_PID_FILE": os.path.join(state_dir, "monitor.pid"),
        "COLUMNS": "120",
        "LINES": "20",
        "TERM": "xterm-256color",
    })

    master, slave = pty.openpty()
    proc = subprocess.Popen([sys.executable, SCRIPT], stdin=slave, stdout=slave,
                            stderr=slave, env=env, close_fds=True)
    os.close(slave)
    buffer = ""
    failures = []

    def pump(seconds):
        nonlocal buffer
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([master], [], [], 0.1)
            if not ready:
                continue
            try:
                chunk = os.read(master, 65536)
            except OSError:
                return
            if not chunk:
                return
            buffer += strip(chunk.decode("utf-8", "replace"))

    def expect(text, label):
        ok = text in buffer
        print(("  OK   " if ok else "  FALLA") + " " + label)
        if not ok:
            failures.append(label)

    def expect_re(pattern, label):
        ok = re.search(pattern, buffer) is not None
        print(("  OK   " if ok else "  FALLA") + " " + label)
        if not ok:
            failures.append(label)

    pump(2.0)
    expect("DSH FLEET MONITOR", "render inicial con cabecera")
    expect("PROJECT", "cabecera de tabla")
    expect_re(r"page 1/\d+", "paginacion pagina 1")

    buffer = ""
    os.write(master, b"n")
    pump(1.5)
    expect_re(r"page 2/\d+", "la tecla [n] avanza de pagina")

    buffer = ""
    os.write(master, b"b")
    pump(1.5)
    expect_re(r"page 1/\d+", "la tecla [b] retrocede de pagina")

    buffer = ""
    os.write(master, b"f")
    pump(1.5)
    expect("filter: recent only", "la tecla [f] activa el filtro")

    buffer = ""
    os.write(master, b"f")
    pump(1.5)
    expect_re(r"filter: all", "la tecla [f] vuelve a todas")

    buffer = ""
    os.write(master, b"p")
    pump(1.5)
    expect("Switch to PTC?", "la tecla [p] pide confirmacion")

    buffer = ""
    os.write(master, b"s")
    pump(1.5)
    expect("cancelled", "otra tecla cancela el cambio")
    request = os.path.join(state_dir, "request.json")
    if os.path.exists(request):
        failures.append("una tecla distinta de [y] escribio la peticion")
        print("  FALLA una tecla distinta de [y] escribio la peticion")

    buffer = ""
    os.write(master, b"p")
    pump(1.0)
    os.write(master, b"y")
    pump(1.5)
    payload = None
    for _ in range(10):
        if os.path.exists(request):
            payload = json.load(open(request))
            break
        time.sleep(0.2)
    ok = payload is not None and payload.get("mode") == "ptc"
    print(("  OK   " if ok else "  FALLA") + " [p] + [y] pide conmutar a ptc")
    if not ok:
        failures.append("conmutacion ptc")

    buffer = ""
    os.write(master, b"q")
    try:
        code = proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        code = None
        proc.kill()
    ok = code == 0
    print(("  OK   " if ok else "  FALLA") + " la tecla [q] sale con codigo 0")
    if not ok:
        failures.append("salida")

    shutil.rmtree(state_dir, ignore_errors=True)
    return failures


if __name__ == "__main__":
    problems = run()
    print()
    if problems:
        print("FALLOS: " + ", ".join(problems))
        sys.exit(1)
    print("dsh-top: todas las pruebas interactivas pasan")
