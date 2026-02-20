# TopTrend

TopTrend 是一个零成本热榜追踪项目：

- GitHub Actions 定时抓取微博热搜（每 20 分钟）
- 数据保存为 JSON 并持续提交到仓库
- GitHub Pages 自动发布静态网页
- 前端读取仓库数据并展示实时榜单与趋势
- 支持抓取失败/长时间未更新的页面提示

## 功能概览

- **数据采集**: `scrape.yml` 每 20 分钟执行一次抓取
- **数据存储**: `data/raw/weibo/YYYY-MM-DD.json` 按天存快照
- **数据索引**: `data/index.json` 提供日期和平台索引
- **状态跟踪**: `data/status.json` 记录最近运行是否成功
- **前端展示**:
  - 首页：项目说明 + 平台入口（不承载交互）
  - 平台子页面（当前：`/weibo/`）：实时榜单、历史回顾、趋势分析、词条库
  - 抓取状态提示（失败/长时间未更新）

## 目录结构

```text
.
├── .github/workflows/
│   ├── scrape.yml
│   └── deploy-pages.yml
├── data/
│   ├── index.json
│   ├── status.json
│   └── raw/
│       └── weibo/
├── scrapers/
│   ├── __init__.py
│   ├── base.py
│   └── weibo.py
├── web/
│   ├── index.html
│   ├── weibo/
│   │   └── index.html
│   ├── app.js
│   ├── style.css
│   ├── manifest.webmanifest
│   ├── robots.txt
│   └── sitemap.xml
├── main.py
└── requirements.txt
```

## 本地快速开始

### 1) 安装依赖

```bash
pip3 install -r requirements.txt
```

### 2) 手动执行一次抓取

```bash
python3 main.py
```

执行后会更新：

- `data/raw/weibo/<当天日期>.json`
- `data/index.json`
- `data/status.json`

### 3) 本地查看网页

```bash
python3 -m http.server 8000
```

打开：

- `http://localhost:8000/web/`
- `http://localhost:8000/web/weibo/`（推荐：平台交互页）

## 分支协作约定

- 日常开发请从 `master` 拉出开发分支（如 `feat/xxx`、`fix/xxx`）。
- 功能完成后通过 PR 合并回 `master`，保持 `master` 始终为最新稳定版本。
- 避免直接在 `master` 上进行日常改动。

## GitHub 上线步骤

### 1) 推送代码

把当前项目目录作为仓库根目录推送到 GitHub（或在该目录初始化 git 仓库后 push）。

### 2) 启用定时抓取

- 工作流文件：`.github/workflows/scrape.yml`
- 触发方式：
  - cron：每 20 分钟
  - 手动：Actions 页面点 `Run workflow`

### 3) 启用自动部署 Pages

- 仓库 `Settings -> Pages`
- `Build and deployment -> Source` 选择 **GitHub Actions**
- 由 `.github/workflows/deploy-pages.yml` 定义触发条件（请以工作流文件为准）

### 4) 访问页面

部署成功后在 Actions 的 `Deploy Pages` 任务中可看到页面 URL，也可在仓库首页右侧 `Deployments` 查看。

## 抓取状态提示说明

`main.py` 每次运行会写入 `data/status.json`，前端读取该文件后会在页面顶部提示状态：

- 最近一次抓取失败：显示失败提示和最近执行时间
- 长时间未更新（超过约 50 分钟）：提示任务可能中断
- 正常：不显示告警条

`status.json` 关键字段：

- `ok`: 本次是否全部成功
- `lastRunAt`: 最近一次执行时间
- `lastSuccessAt`: 最近一次全量成功时间
- `message`: 简要结果描述
- `sourceResults`: 各平台抓取结果明细

## 常见问题排查

### 页面空白或无数据

- 检查 `data/index.json` 是否有日期
- 检查当天 `data/raw/weibo/*.json` 是否有 `snapshots`
- 检查浏览器控制台是否有 fetch 报错

### Actions 未按时触发

- 确认仓库有最近提交（GitHub 对长期无活动仓库可能降低调度稳定性）
- 去 Actions 页面手动触发一次，确认 workflow 正常

### Pages 无法访问

- 确认 `Settings -> Pages -> Source = GitHub Actions`
- 确认 `deploy-pages.yml` 最近一次执行成功

## 扩展新平台

1. 在 `scrapers/` 新建平台文件（如 `zhihu.py`）
2. 继承 `BaseScraper` 并实现 `name` / `display_name` / `fetch()`
3. 在 `scrapers/__init__.py` 注册实例

示例：

```python
from .base import BaseScraper


class ZhihuScraper(BaseScraper):
    @property
    def name(self) -> str:
        return "zhihu"

    @property
    def display_name(self) -> str:
        return "知乎热榜"

    def fetch(self) -> list[dict]:
        return []
```
