from __future__ import annotations

import getpass

from .main import hash_password


def main() -> None:
    password = getpass.getpass("管理员密码: ")
    confirmation = getpass.getpass("再次输入: ")
    if not password:
        raise SystemExit("密码不能为空")
    if password != confirmation:
        raise SystemExit("两次输入不一致")
    print(hash_password(password))


if __name__ == "__main__":
    main()

