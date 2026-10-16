"""SQLAlchemy 引擎与会话管理（SQLite）。"""

from __future__ import annotations

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import DB_PATH


class Base(DeclarativeBase):
    pass


engine = create_engine(
    f"sqlite:///{DB_PATH.as_posix()}",
    connect_args={"check_same_thread": False},
    future=True,
)


@event.listens_for(engine, "connect")
def _set_sqlite_pragma(dbapi_conn, _record):
    """SQLite 默认不开外键；同时开 WAL 让「读进度」与「写管线」互不阻塞。"""
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA foreign_keys=ON")
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA synchronous=NORMAL")
    cur.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


#: 历史库的新增列清单：{表名: [(列名, SQLite 类型), ...]}
#:
#: 为什么要有这张表：Base.metadata.create_all() 只会建「不存在的表」，
#: 对已经存在的表一个列都不会碰。老用户升级后 videos 表里没有 folder_id，
#: 任何一次查询都会炸 OperationalError: no such column。
#: 真上 Alembic 为一个本地小工具不值当，这里用一条明确的清单兜底。
_EXTRA_COLUMNS: dict[str, list[tuple[str, str]]] = {
    "videos": [("folder_id", "INTEGER")],
    "chapters": [("source_node_id", "VARCHAR(64)")],
    "folders": [("parent_id", "INTEGER")],
}


def _add_missing_columns() -> int:
    """给历史库补上新增列，返回补了几列。"""
    insp = inspect(engine)
    existing_tables = set(insp.get_table_names())
    added = 0

    for table, columns in _EXTRA_COLUMNS.items():
        if table not in existing_tables:
            continue  # 新库：create_all 已经按模型建好了
        have = {c["name"] for c in insp.get_columns(table)}
        missing = [(n, t) for n, t in columns if n not in have]
        if not missing:
            continue
        with engine.begin() as conn:
            for name, ddl in missing:
                conn.execute(text(f'ALTER TABLE "{table}" ADD COLUMN "{name}" {ddl}'))
                added += 1
        # 列变了要刷新 inspector 的缓存，否则下一轮判断还用旧结果
        insp.clear_cache()
    return added


def _drop_folders_name_unique() -> bool:
    """去掉老库在 folders.name 上的全局唯一索引。

    多级分类下「课程/进阶」和「项目/进阶」必须能共存，全局唯一会把这种合理
    结构判成重名。SQLite 改不了约束本身，但列级 unique=True 生成的是一个独立
    的 CREATE UNIQUE INDEX，直接删掉再补一个普通索引即可——表结构、数据、
    外键全都不用动，比重建表安全得多。
    """
    insp = inspect(engine)
    if "folders" not in insp.get_table_names():
        return False

    target: str | None = None
    for idx in insp.get_indexes("folders"):
        cols = [c for c in (idx.get("column_names") or []) if c]
        if idx.get("unique") and cols == ["name"]:
            target = idx["name"]
            break
    if not target:
        return False

    try:
        with engine.begin() as conn:
            conn.execute(text(f'DROP INDEX IF EXISTS "{target}"'))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_folders_name ON folders (name)"))
    except Exception:  # noqa: BLE001
        # 表级 UNIQUE 约束对应的是 sqlite_autoindex，删不掉；那种库保持原样即可，
        # 只是跨层级同名会被拒，其余功能不受影响
        return False

    insp.clear_cache()
    return True


def init_db() -> None:
    from . import models  # noqa: F401  注册所有表

    Base.metadata.create_all(engine)
    # 补列是幂等的，成功与否都不该阻塞启动
    _add_missing_columns()
    _drop_folders_name_unique()


def get_db():
    """FastAPI 依赖：每个请求一个会话，结束即关闭。"""
    db: Session = SessionLocal()
    try:
        yield db
    finally:
        db.close()
