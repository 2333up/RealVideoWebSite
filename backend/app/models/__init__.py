"""所有 ORM 模型的注册入口。

导入本包即可确保全部模型被登记到 Base.metadata，
init_db() 才能正确建表。
"""

from app.models.account import PlatformAccount
from app.models.anime import AnimeFollow

__all__ = ["PlatformAccount", "AnimeFollow"]
