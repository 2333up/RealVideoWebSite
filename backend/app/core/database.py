"""数据库会话管理。

采用 SQLAlchemy 2.0 风格 + SQLite 单文件存储，
零外部依赖即可运行，后续可无痛切换 PostgreSQL。
"""

from __future__ import annotations

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.core.config import settings


class Base(DeclarativeBase):
    """所有 ORM 模型的基类。"""


connect_args = {"check_same_thread": False} if settings.DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(
    settings.DATABASE_URL,
    connect_args=connect_args,
    future=True,
    echo=False,
)

# SQLite 默认不强制外键约束，显式开启
if settings.DATABASE_URL.startswith("sqlite"):

    @event.listens_for(engine, "connect")
    def _enable_sqlite_foreign_keys(dbapi_conn, _record):  # noqa: ANN001, ANN202
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False, future=True)


def init_db() -> None:
    """创建所有尚未存在的表。"""
    # 模型需先被导入以注册到 Base.metadata
    from app.models import account, anime  # noqa: F401

    Base.metadata.create_all(bind=engine)


def get_db() -> Session:  # noqa: D401 - FastAPI 依赖项
    """FastAPI 依赖项：请求作用域的数据库会话。"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
