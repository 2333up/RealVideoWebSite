"""分类文件夹 + 批量导入的测试。

重点不是 CRUD 本身，而是几个一旦写错就会让用户「白操作」的语义：
    - 删文件夹不能删掉里面的视频（连带分析结果）
    - 重复导入同一个文件要返回 duplicate，而不是再插一条
    - 单文件失败不能让整批回滚
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.database import Base  # noqa: E402
from core.models import Folder, Video  # noqa: E402
from routers import folders as folders_mod  # noqa: E402
from routers import videos as videos_mod  # noqa: E402
from routers.folders import normalize_name  # noqa: E402


@pytest.fixture()
def db():
    """每个用例一套独立的内存库。

    in-memory SQLite 必须用 StaticPool：默认每个连接有自己的库，
    建表和后续查询会分别落在两个不同的空库上。
    """
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool, future=True
    )

    @event.listens_for(engine, "connect")
    def _fk_on(dbapi_conn, _rec):  # pragma: no cover - 只为贴近真实配置
        dbapi_conn.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, autoflush=False, future=True)()
    yield session
    session.close()
    engine.dispose()


# ------------------------------------------------------------------ 名称规范化

def test_名称去掉空白与非法字符():
    assert normalize_name("  机器学习 ") == "机器学习"
    assert normalize_name("C/C++: 入门") == "CC++ 入门"
    assert normalize_name("多   空格") == "多 空格"


def test_空名称报错():
    with pytest.raises(HTTPException) as e:
        normalize_name("   ")
    assert "不能为空" in str(e.value.detail)


def test_超长名称报错():
    with pytest.raises(HTTPException) as e:
        normalize_name("x" * 100)
    assert "不能超过" in str(e.value.detail)


# ------------------------------------------------------------------ CRUD

def test_新建文件夹(db):
    f = folders_mod.create_folder(type("R", (), {"name": "机器学习"}), db)
    assert f["id"] > 0
    assert f["name"] == "机器学习"
    assert f["video_count"] == 0


def test_同名文件夹被拒绝(db):
    folders_mod.create_folder(type("R", (), {"name": "机器学习"}), db)
    with pytest.raises(HTTPException) as e:
        folders_mod.create_folder(type("R", (), {"name": " 机器学习 "}), db)
    assert "同名" in str(e.value.detail)


def test_重命名到已存在名字被拒绝(db):
    a = folders_mod.create_folder(type("R", (), {"name": "A"}), db)
    folders_mod.create_folder(type("R", (), {"name": "B"}), db)
    with pytest.raises(HTTPException):
        folders_mod.rename_folder(a["id"], type("R", (), {"name": "B"}), db)


def test_删除文件夹_视频退回未分类而不是被删掉(db):
    f = folders_mod.create_folder(type("R", (), {"name": "课程"}), db)
    v = Video(title="v", filename="v.mp4", path="/x/v.mp4", folder_id=f["id"])
    db.add(v)
    db.commit()

    r = folders_mod.delete_folder(f["id"], db)
    assert r["unfiled"] == 1

    db.expire_all()
    assert db.query(Video).count() == 1, "删分类绝不能删掉视频本身"
    assert db.query(Video).first().folder_id is None
    assert db.query(Folder).count() == 0


def test_列表带视频计数(db):
    f = folders_mod.create_folder(type("R", (), {"name": "课程"}), db)
    db.add(Video(title="a", path="/a.mp4", folder_id=f["id"]))
    db.add(Video(title="b", path="/b.mp4", folder_id=f["id"]))
    db.add(Video(title="c", path="/c.mp4"))
    db.commit()

    items = folders_mod.list_folders(db)["items"]
    assert items[0]["video_count"] == 2


# ------------------------------------------------------------------ 移动

def test_批量移动进文件夹(db):
    f = folders_mod.create_folder(type("R", (), {"name": "课程"}), db)
    v1 = Video(title="a", path="/a.mp4")
    v2 = Video(title="b", path="/b.mp4")
    db.add_all([v1, v2])
    db.commit()

    r = folders_mod.assign_videos(
        type("R", (), {"video_ids": [v1.id, v2.id], "folder_id": f["id"]}), db
    )
    assert r["moved"] == 2
    assert db.get(Video, v1.id).folder_id == f["id"]


def test_移回未分类(db):
    f = folders_mod.create_folder(type("R", (), {"name": "课程"}), db)
    v = Video(title="a", path="/a.mp4", folder_id=f["id"])
    db.add(v)
    db.commit()

    r = folders_mod.assign_videos(
        type("R", (), {"video_ids": [v.id], "folder_id": None}), db
    )
    assert r["moved"] == 1
    assert db.get(Video, v.id).folder_id is None


def test_移动到不存在的文件夹报404(db):
    v = Video(title="a", path="/a.mp4")
    db.add(v)
    db.commit()
    with pytest.raises(HTTPException) as e:
        folders_mod.assign_videos(
            type("R", (), {"video_ids": [v.id], "folder_id": 999}), db
        )
    assert e.value.status_code == 404


def test_部分视频不存在时不整体失败(db):
    f = folders_mod.create_folder(type("R", (), {"name": "课程"}), db)
    v = Video(title="a", path="/a.mp4")
    db.add(v)
    db.commit()

    r = folders_mod.assign_videos(
        type("R", (), {"video_ids": [v.id, 12345], "folder_id": f["id"]}), db
    )
    assert r["moved"] == 1
    assert r["missing"] == [12345]


def test_get_or_create_同名复用(db):
    a = folders_mod.get_or_create_folder(db, "课程")
    b = folders_mod.get_or_create_folder(db, " 课程 ")
    db.commit()
    assert a.id == b.id
    assert db.query(Folder).count() == 1


# ------------------------------------------------------------------ 目录扫描

def test_扫描目录_按扩展名过滤且排序(tmp_path):
    (tmp_path / "b.mp4").write_bytes(b"")
    (tmp_path / "a.mkv").write_bytes(b"")
    (tmp_path / "notes.txt").write_bytes(b"")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "c.mov").write_bytes(b"")

    files = videos_mod.collect_video_files(tmp_path, recursive=True)
    names = [f.name for f in files]
    assert names == ["a.mkv", "b.mp4", "c.mov"]  # 排序稳定，且与创建顺序无关

    top_only = videos_mod.collect_video_files(tmp_path, recursive=False)
    assert len(top_only) == 2


def test_扫描目录_上限截断(tmp_path):
    for i in range(10):
        (tmp_path / f"v{i}.mp4").write_bytes(b"")
    assert len(videos_mod.collect_video_files(tmp_path, max_files=5)) == 5


def test_扫描目录_跳过隐藏项(tmp_path):
    hidden = tmp_path / ".cache"
    hidden.mkdir()
    (hidden / "secret.mp4").write_bytes(b"")
    (tmp_path / "ok.mp4").write_bytes(b"")
    assert [p.name for p in videos_mod.collect_video_files(tmp_path)] == ["ok.mp4"]


# ------------------------------------------------------------------ 单个导入

def _fake_probe(monkeypatch):
    """probe 需要真实的 ffmpeg，测试里替换成假对象。

    注意 pipeline.media 模块对象本身没变，变的是它的 probe 属性——
    videos._import_one 用的是 `from pipeline import media` 拿到的同一个模块。
    """
    from pipeline import media as media_mod

    class Probe:
        duration = 12.34

    monkeypatch.setattr(media_mod, "probe", lambda _path: Probe(), raising=False)


def test_导入单个文件_只登记路径(db, tmp_path, monkeypatch):
    _fake_probe(monkeypatch)
    p = tmp_path / "lecture.mp4"
    p.write_bytes(b"x" * 10)

    r = videos_mod._import_one(db, str(p))
    assert r["duplicate"] is False
    v = db.get(Video, r["id"])
    assert v.path == str(p.resolve())
    assert v.size_bytes == 10
    assert v.folder_id is None


def test_重复导入返回duplicate且不再插行(db, tmp_path, monkeypatch):
    _fake_probe(monkeypatch)
    p = tmp_path / "lecture.mp4"
    p.write_bytes(b"")

    videos_mod._import_one(db, str(p))
    again = videos_mod._import_one(db, str(p))
    assert again["duplicate"] is True
    assert db.query(Video).count() == 1


def test_重复导入时按新目标文件夹归位(db, tmp_path, monkeypatch):
    """从别处再导一次同名文件，用户期望的是「进当前分类」而不是毫无反应。"""
    _fake_probe(monkeypatch)
    p = tmp_path / "lecture.mp4"
    p.write_bytes(b"")
    videos_mod._import_one(db, str(p))

    f = folders_mod.get_or_create_folder(db, "课程")
    db.commit()
    videos_mod._import_one(db, str(p), f.id)
    db.expire_all()
    assert db.query(Video).first().folder_id == f.id


def test_不支持的格式直接报错(db, tmp_path):
    p = tmp_path / "notes.txt"
    p.write_bytes(b"")
    with pytest.raises(HTTPException) as e:
        videos_mod._import_one(db, str(p))
    assert "不支持的格式" in str(e.value.detail)


def test_文件不存在报错(db):
    with pytest.raises(HTTPException) as e:
        videos_mod._import_one(db, "J:/no/such/file.mp4")
    assert "不存在" in str(e.value.detail)


# ------------------------------------------------------------------ 批量 / 目录导入

def test_批量导入_统计新建与重复(db, tmp_path, monkeypatch):
    _fake_probe(monkeypatch)
    a = tmp_path / "a.mp4"
    b = tmp_path / "b.mp4"
    a.write_bytes(b"")
    b.write_bytes(b"")
    videos_mod._import_one(db, str(a))  # a 先已存在

    r = videos_mod.import_many(
        type("R", (), {"paths": [str(a), str(b)], "folder_id": None}), db
    )
    assert r["created"] == 1
    assert r["duplicates"] == 1
    assert db.query(Video).count() == 2


def test_批量导入_单文件失败不影响整批(db, tmp_path, monkeypatch):
    _fake_probe(monkeypatch)
    ok = tmp_path / "ok.mp4"
    ok.write_bytes(b"")
    bad_missing = str(tmp_path / "gone.mp4")

    r = videos_mod.import_many(
        type("R", (), {"paths": [str(ok), bad_missing], "folder_id": None}), db
    )
    assert r["created"] == 1
    assert len(r["failed"]) == 1
    assert r["failed"][0]["path"] == bad_missing


def test_目录导入_自动建同名分类(db, tmp_path, monkeypatch):
    _fake_probe(monkeypatch)
    course = tmp_path / "机器学习"
    course.mkdir()
    for name in ("01.mp4", "02.mkv", "readme.txt"):
        (course / name).write_bytes(b"")

    r = videos_mod.import_folder(
        type("R", (), {"path": str(course), "recursive": True, "create_folder": True, "max_files": 200}),
        db,
    )
    assert r["created"] == 2
    assert r["folder"]["name"] == "机器学习"
    db.expire_all()
    assert all(v.folder_id == r["folder"]["id"] for v in db.query(Video).all())

    # 再导入一次：全部算重复，不会重复建分类
    again = videos_mod.import_folder(
        type("R", (), {"path": str(course), "recursive": True, "create_folder": True, "max_files": 200}),
        db,
    )
    assert again["created"] == 0
    assert again["duplicates"] == 2
    assert db.query(Folder).count() == 1


def test_目录导入_空目录给出提示(db, tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()
    r = videos_mod.import_folder(
        type("R", (), {"path": str(empty), "recursive": True, "create_folder": True, "max_files": 200}),
        db,
    )
    assert r["created"] == 0
    assert "没有找到" in (r["message"] or "")
    assert db.query(Folder).count() == 0, "没导进东西时不该留下一个空分类"


def test_目录导入_传入文件而非目录报错(db, tmp_path):
    p = tmp_path / "a.mp4"
    p.write_bytes(b"")
    with pytest.raises(HTTPException) as e:
        videos_mod.import_folder(
            type("R", (), {"path": str(p), "recursive": True, "create_folder": True, "max_files": 200}),
            db,
        )
    assert "不是文件夹" in str(e.value.detail)


# ------------------------------------------------------------------ 文件对话框

def test_扩展名filter是稳定的通配串():
    from core.media_types import extension_filter, VIDEO_EXT

    filt = extension_filter()
    assert filt.startswith("*.avi")
    assert filt.count(";") == len(VIDEO_EXT) - 1


def test_去重且大小写不敏感(db, monkeypatch, tmp_path):
    from core import files_dialog

    a = tmp_path / "A.MP4"
    a.write_bytes(b"")
    out = files_dialog._dedupe([str(a), str(a).upper(), str(a)])
    # Windows 文件系统大小写不敏感，同一文件两种写法应算一个
    assert len(out) == 1


def test_能力探测返回可预期的字段():
    from core import files_dialog

    st = files_dialog.picker_status()
    assert set(["available", "method", "reason", "last_dir"]) <= set(st)
    if st["available"]:
        assert st["method"] in ("powershell", "tkinter")
    else:
        assert st["reason"], "不可用时必须给出原因，前端要靠它决定要不要退回手工输入"


def test_空filemode之外的值直接报错():
    from core import files_dialog

    with pytest.raises(files_dialog.PickerError):
        files_dialog.pick("bogus")
