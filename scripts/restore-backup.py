from __future__ import annotations

import argparse
from pathlib import Path

from sangam.backup import BackupManager
from sangam.db import Database


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Verify and restore a Sangam backup into empty targets while Sangam is stopped."
    )
    parser.add_argument("backup_id")
    parser.add_argument("--backup-root", type=Path, required=True)
    parser.add_argument("--database-path", type=Path, required=True)
    parser.add_argument("--workspace-root", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    manager = BackupManager(
        database=Database(args.database_path),
        workspace_root=args.workspace_root,
        backup_root=args.backup_root,
        retention_count=14,
    )
    manager.restore_to(
        args.backup_id,
        database_path=args.database_path,
        workspace_root=args.workspace_root,
    )
    print(f"Restored and verified backup {args.backup_id}")


if __name__ == "__main__":
    main()
