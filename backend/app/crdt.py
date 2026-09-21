"""CRDT 文档适配层。

服务端只在这里接触 pycrdt，房间、存储与协议模块都通过本模块的函数间接使用
Yjs 文档。这样可以把“文档如何初始化”“如何克隆候选文档”集中在同一处。
"""

from __future__ import annotations

from pycrdt import Doc, XmlElement, XmlFragment

BODY_FIELD = "body"
PARAGRAPH_TAG = "paragraph"


def new_document() -> Doc:
    """创建带唯一规范空段落的文档。

    种子只由服务端在创建文档时写入一次并持久化，浏览器不会各自补一份同样的
    默认正文，避免重复初始化。
    """
    doc = Doc()
    root = doc.get(BODY_FIELD, type=XmlFragment)
    root.children.append(XmlElement(PARAGRAPH_TAG))
    return doc


def restore_document(updates: list[bytes]) -> Doc:
    """按给定顺序重放更新，重建文档。"""
    doc = Doc()
    for update in updates:
        doc.apply_update(update)
    return doc


def candidate_document(current: Doc, update: bytes) -> Doc:
    """在已提交文档的副本上应用更新，用于写入前的校验。

    只有候选验证通过并成功落盘后，调用方才把正式文档替换为这个候选，因此校验
    失败不会污染正在服务的房间状态。
    """
    candidate = restore_document([current.get_update()])
    candidate.apply_update(update)
    return candidate
