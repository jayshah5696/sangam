"""Launch the pinned worker with no server environment and OS resource caps."""

import os
import resource
import sys
from pathlib import Path


def main() -> None:
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    binary = Path(sys.executable).parent / "monty"
    os.execve(binary, [str(binary), *sys.argv[1:]], {"RAYON_NUM_THREADS": "1"})
