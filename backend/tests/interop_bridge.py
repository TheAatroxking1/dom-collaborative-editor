"""Node 测试调用的 Python 二进制桥。

从 stdin 读取 {"updates": [base64]}，重放为文档后向 stdout 输出
{"update": base64, "stateVector": base64}。工作目录为 backend，执行方式为
`python -m tests.interop_bridge`。
"""

import base64
import json
import sys

from app.crdt import restore_document


def main() -> None:
    request = json.load(sys.stdin)
    updates = [base64.b64decode(value, validate=True) for value in request["updates"]]
    doc = restore_document(updates)
    json.dump(
        {
            "update": base64.b64encode(doc.get_update()).decode("ascii"),
            "stateVector": base64.b64encode(doc.get_state()).decode("ascii"),
        },
        sys.stdout,
    )


if __name__ == "__main__":
    main()
