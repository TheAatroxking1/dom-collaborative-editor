"""Python 侧 CRDT 行为：唯一初始化、克隆隔离、重放恢复、删除传播。

已知边界：pycrdt 的索引式编辑（`del text[a:b]`、`text.insert(i, s)`）按 Python
码点计数，而 Yjs 按 UTF-16 码元计数。含非 BMP 字符（如 emoji）时两者索引不再
一致，且 pycrdt 0.14.5 在非 BMP 文本上做区间删除会破坏内容并抛 Rust panic。
本项目的服务端只做“应用二进制更新 + 读取快照 + 编码状态”，从不按索引编辑正文，
因此不受该差异影响；测试也据此只用更新编码验证非 BMP 文本。
"""

from pycrdt import Doc, Text, XmlElement, XmlFragment

from app.crdt import candidate_document, new_document, restore_document

SAMPLE = "Hello中文🙂"


def test_new_document_has_one_shared_empty_paragraph():
    doc = new_document()
    root = doc.get("body", type=XmlFragment)
    assert len(root.children) == 1
    assert root.children[0].tag == "paragraph"
    assert len(root.children[0].children) == 0


def test_restoring_seed_keeps_single_paragraph():
    doc = new_document()
    restored = restore_document([doc.get_update()])
    root = restored.get("body", type=XmlFragment)
    assert len(root.children) == 1
    assert root.children[0].tag == "paragraph"


def test_candidate_does_not_mutate_committed_document():
    committed = new_document()
    incoming = Doc()
    incoming.get("probe", type=Text).insert(0, SAMPLE)
    candidate = candidate_document(committed, incoming.get_update())
    assert str(candidate.get("probe", type=Text)) == SAMPLE
    assert str(committed.get("probe", type=Text)) == ""
    restored = restore_document([candidate.get_update()])
    assert str(restored.get("probe", type=Text)) == SAMPLE


def test_replay_is_idempotent():
    doc = new_document()
    doc.get("probe", type=Text).insert(0, SAMPLE)
    update = doc.get_update()
    replayed = restore_document([update, update, update])
    assert str(replayed.get("probe", type=Text)) == SAMPLE


def test_non_bmp_text_survives_binary_roundtrip():
    doc = Doc()
    doc.get("probe", type=Text).insert(0, SAMPLE)
    restored = restore_document([doc.get_update()])
    assert str(restored.get("probe", type=Text)) == SAMPLE


def test_delete_only_update_is_not_skipped_for_equal_state_vector():
    """状态向量相同不代表没有待同步内容：删除不改变状态向量。

    删除操作用 ASCII 文本构造：pycrdt 0.14.5 的索引式区间删除多字节文本时会
    越界或误删（见模块开头说明）。这里验证的是与语言无关的状态向量性质，含中文
    和 emoji 的删除由 interop.test.ts 中 Yjs 产生的二进制更新覆盖。
    """
    source = Doc()
    source.get("probe", type=Text).insert(0, "abcdefghij")
    peer = restore_document([source.get_update()])
    before = source.get_state()

    del source.get("probe", type=Text)[5:7]
    assert str(source.get("probe", type=Text)) == "abcdehij"
    assert source.get_state() == before

    peer.apply_update(source.get_update(peer.get_state()))
    assert str(peer.get("probe", type=Text)) == "abcdehij"


def test_concurrent_inserts_converge_regardless_of_order():
    base = new_document()
    left = restore_document([base.get_update()])
    right = restore_document([base.get_update()])

    left.get("probe", type=Text).insert(0, "AAA")
    right.get("probe", type=Text).insert(0, "BBB")

    left_update, right_update = left.get_update(), right.get_update()

    left.apply_update(right_update)
    right.apply_update(left_update)

    assert str(left.get("probe", type=Text)) == str(right.get("probe", type=Text))
    assert set(str(left.get("probe", type=Text))) == {"A", "B"}


def test_xml_fragment_roundtrip_preserves_structure():
    doc = Doc()
    root = doc.get("body", type=XmlFragment)
    root.children.append(XmlElement("paragraph"))
    restored = restore_document([doc.get_update()])
    restored_root = restored.get("body", type=XmlFragment)
    assert len(restored_root.children) == 1
    assert restored_root.children[0].tag == "paragraph"
