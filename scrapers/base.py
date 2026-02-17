from abc import ABC, abstractmethod


class BaseScraper(ABC):
    """热榜抓取器抽象基类。新增平台只需继承此类并实现相应方法。"""

    @property
    @abstractmethod
    def name(self) -> str:
        """平台标识，如 'weibo'、'zhihu'，用作目录名和数据标识。"""
        ...

    @property
    @abstractmethod
    def display_name(self) -> str:
        """平台显示名称，如 '微博热搜'，用于前端展示。"""
        ...

    @abstractmethod
    def fetch(self) -> list[dict]:
        """
        抓取当前热榜数据。

        Returns:
            list[dict]: 热榜条目列表，每个条目包含:
                - rank (int): 排名，从 1 开始
                - title (str): 热搜标题
                - hotValue (int, optional): 热度值
                - category (str, optional): 分类
                - url (str, optional): 原始链接
        """
        ...
