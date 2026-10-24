# 微信公众号自动化工作流

把社团的新番评价收集、文章装配和公众号发布串成一条可重复的流水线。

## 目录

| 路径 | 用途 |
| --- | --- |
| `anime-review/` | 评价收集站：静态网页 + Supabase，支持社员填写与管理员汇总/导出 |
| `文章生成/` | 文章模板、样式、公众号复制脚本和数据快照 |
| `获取动漫资源/` | 抓取米麓星当季番剧名称与封面（`/list`） |
| `2026七月新番完结吐槽/` | 实际输出的公众号文章 |
| `文档/` | 背景、自动化流程和生成提示词 |

## 主流程

1. 每季度用 `获取动漫资源/miluxing_season_covers.py` 抓取当季番剧的 `title` 与 `cover_url`。
2. 用 `anime-review` 的 `npm run db:import` 把该 CSV 写入 Supabase，自动创建对应番季；管理员在网页工作台确认片单后「设为当期」。
3. 社员在 `anime-review/` 填写 CN、QQ 号、评分与吐槽；普通社员只能看到当期番季。
4. 管理员在收集站切换番季查看汇总并导出 CSV；导出包含 QQ 号（明细表单列，原表布局写在姓名后的括号里）。
5. 以 `文章生成/示例页面/模版.html` 为模板生成文章，按评价人数从高到低排序，输出到 `2026七月新番完结吐槽/`。
6. 在浏览器打开输出 HTML，点击「复制到公众号」，按 `Ctrl / ⌘ + C` 后粘贴到公众号编辑器。

## 常用命令

```bash
# 评价站本机预览
cd anime-review && npm start

# 评价站临时公网访问（Nginx + cloudflared）
cd anime-review && npm run web

# 抓取 2026 年十月番剧名称与封面
uv run python "获取动漫资源/miluxing_season_covers.py" --year 2026 --month 10

# 把抓取结果导入 Supabase（在 anime-review 目录执行）
cd anime-review
npm run db:import -- "../获取动漫资源/miluxing_2026_10.csv" --year 2026 --month 10
```

数据库初始化、季度导入、查询和管理员配置见 [anime-review/README.md](anime-review/README.md)。
