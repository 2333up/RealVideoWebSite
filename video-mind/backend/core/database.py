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


def init_db() -> None:
    from . import models  # noqa: F401  注册所有表

    Base.metadata.create_all(engine)
    if _add_missing_columns():
        # 只记日志失败勘查用：补列是幂等的，成功与否都不该阻塞启动
        pass


def get_db():
    """FastAPI 依赖：每个请求一个会话，结束即关闭。"""
    db: Session = SessionLocal()
    try:
        yield db
    finally:
        db.close()
