# 番外话 · 社团新番评价收集

轻量的新番评价网页：静态 HTML、CSS、JavaScript 直接连接 Supabase，无需自建后端，没有 npm 依赖，也没有编译步骤。项目带有 Nginx 本地托管配置。

## Nginx 与临时公网访问

本项目已经是静态网页，不需要构建、`dist` 或文件复制。先安装 Node.js（22 或以上）、Nginx 和 `cloudflared`，确保 `nginx`、`cloudflared` 命令可用。在项目目录运行：

```sh
npm run web
```

启动命令先读取项目内的 `nginx/nginx.conf` 并启动 Nginx，确认本次启动的进程和网页就绪后，再自动运行 `cloudflared tunnel --url http://127.0.0.1:80`。终端会显示 Cloudflare 分配的 `https://随机名称.trycloudflare.com` 地址，将它发给别人即可访问。只需保持这一个终端运行，按 `Ctrl+C` 会一并停止两个进程。

默认 Nginx 监听所有 IPv4 网卡的 **80 端口**，本机打开 <http://127.0.0.1/>。局域网内也可使用 `http://这台电脑的IP/`。修改 `nginx/nginx.conf` 中的 `listen 80;` 后，脚本会自动使用新的端口创建隧道。

配置中的 `root .;` 根据启动脚本传入的项目路径解析，移动项目后也无需修改绝对路径。修改网页后直接刷新，修改 Nginx 配置后重启命令。`.runtime/nginx/` 仅保存日志和进程文件。

通过 Cloudflare 隧道访问不需要本机有公网 IP，也不需要路由器端口转发；电脑需要能连接 Cloudflare。本机服务使用 HTTP，生成的公网链接使用 HTTPS。临时链接停止后失效，重新启动会更换地址，适合临时分享，没有可用性保证。参见 [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)。

如果启动时提示 80 端口权限不足，需要以有权监听该端口的用户运行 Nginx；提示端口被占用时，需要停止占用该端口的服务，或修改 `nginx/nginx.conf` 中的 `listen 80;`。

当前 `config.js` 已配置 Supabase，日常启动无需重复初始化。浏览器仍用匿名会话来保存登录状态；但成员身份绑定 CN + QQ，换域名、端口或设备后填同一组 CN + QQ 会回到原成员，不再产生重复账号。

### 启动脚本的含义

`npm run web` 执行 `node scripts/web.mjs`，流程如下：

1. 根据脚本自身位置找到项目目录，不依赖终端当前路径。
2. 创建 `.runtime/nginx/`，供 Nginx 保存 PID 和错误日志；目录已存在时直接使用。
3. 从 `listen 端口;` 读取端口，通过 `spawn` 前台启动 Nginx；最多等待 10 秒确认 PID 属于本次启动的进程且首页返回成功响应。
4. 网页就绪后，通过 `spawn` 启动 Cloudflare 隧道，将两个进程的输出显示在同一终端。
5. 按 `Ctrl+C`、收到终止信号、启动失败或任一进程意外退出时，停止其余进程；若 3 秒后仍未退出则强制结束。失败返回非零状态，正常手动停止返回成功状态。

| 启动参数 | 含义 |
| --- | --- |
| `-e stderr` | 将读取配置前的启动错误输出到终端；加载配置后按 `error_log` 写入日志。 |
| `-p 项目目录` | 将项目目录设为路径前缀，配置中的相对路径以此为基准。 |
| `-c nginx/nginx.conf` | 使用本项目的配置文件。 |
| `-g 'daemon off;'` | 前台运行 Nginx，由 Node 脚本管理其退出。 |
| `cloudflared tunnel --url 本机地址` | 将本机 Nginx 服务连接到 Cloudflare，输出临时 HTTPS 公网链接。 |

脚本不查询公网 IP、不枚举网卡，也不复制网页文件。端口统一在 `nginx/nginx.conf` 的 `listen 端口;` 修改。若未安装 Nginx 或 `cloudflared`，启动失败会给出错误并清理本次启动的进程。

### Nginx 配置的含义

| 配置 | 含义 |
| --- | --- |
| `pid` | 保存 Nginx 主进程编号。 |
| `error_log ... warn` | 将警告及更严重的错误写入 `.runtime/nginx/error.log`。 |
| `events` / `worker_connections 128` | 设置每个工作进程可同时处理的连接数上限；默认使用一个工作进程。 |
| `http` | 放置 HTTP 服务配置。 |
| `access_log off` | 关闭逐请求访问日志。 |
| `types` / `default_type` | 告诉浏览器哪些文件是 HTML、CSS、JavaScript、JSON 或 SVG；其他类型按二进制文件返回。 |
| `server` / `listen 80` | 建立网站服务，监听所有 IPv4 网卡的 80 端口。 |
| `root .` / `index index.html` | 直接提供项目目录中的文件，首页为 `index.html`。 |
| 两条带 `~` 的 `location` | 用正则匹配并屏蔽隐藏路径及脚本、配置和 SQL 目录，返回 404。 |
| `location /` / `try_files` | 查找请求对应的文件或目录；不存在时返回 404。 |

配置含义可参考 [Nginx 命令行参数](https://nginx.org/en/docs/switches.html)、[核心配置](https://nginx.org/en/docs/ngx_core_module.html)和 [HTTP 配置](https://nginx.org/en/docs/http/ngx_http_core_module.html)。

## 本地数据库管理

数据库管理只通过命令行执行。网页不包含 Access Token 输入框、初始化页面或执行 SQL 的接口。`npm run web` 只启动网站和公网隧道，不读取管理 Token，也不会自动修改数据库。

### 配置 Access Token

在项目目录准备本地配置文件（已有文件时不会覆盖）：

```sh
cp -n .env.example .env.local
chmod 600 .env.local
```

编辑 `.env.local`，填写：

```dotenv
SUPABASE_ACCESS_TOKEN=sbp_你的管理Token
```

Token 可在 [Supabase Access Tokens](https://supabase.com/dashboard/account/tokens) 创建。它是账号的 Personal Access Token，不是 Publishable key 或数据库密码。

项目地址与公开密钥默认沿用 `config.js`；更换项目时可填写 `.env.local` 中的 `SUPABASE_URL` 和 `SUPABASE_PUBLISHABLE_KEY`。`SUPABASE_ADMIN_USER_ID` 用于可选的管理员授权。也可以通过同名环境变量提供这些值。

`.env.local` 已加入 `.gitignore`，Nginx 和本机预览服务均不提供该文件。它保存的管理 Token 仅供本机命令调用 Supabase 官方管理 API，不会写入网页的 `config.js`。不要把它放入公开目录或推送到仓库。

### 初始化或升级

```sh
npm run db:init
```

命令会执行 `supabase/schema.sql`，更新数据表与权限、创建初始番季（2026-07）、启用匿名登录，验证后写入公开连接配置。片单不再随初始化导入，请用 `npm run db:import` 按季度导入。可重复执行，保留已有身份、番季、评价、番剧和管理员授权。

初始化后如果当期番季还没有片单，网页会显示 0 部；先导入当季 CSV，再到管理台「设为当期」即可。

完整初始化需要 Token 具备该项目的 Database、Auth Config、Project Settings 读写权限；未提供公开密钥而需要自动读取时，还需要 API Keys 读取权限。

### 每季度导入新番

先抓取当季列表。脚本会在 `获取动漫资源/` 下生成 `miluxing_年份_月份.csv`，包含 `title` 和 `cover_url` 两列：

```sh
uv run python "获取动漫资源/miluxing_season_covers.py" --year 2026 --month 10
```

再进入评价站，把 CSV 导入当前 Supabase 项目：

```sh
cd anime-review
npm run db:import -- "../获取动漫资源/miluxing_2026_10.csv" --year 2026 --month 10
```

- `--year` 和 `--month` 必填；`--month` 只能是 `1`、`4`、`7`、`10`。
- 导入会自动创建 `2026-10` 这个番季（如果还不存在），并按番名去重、更新封面和排序。重复执行不会重复插入，也不会删除已有评价。
- 默认只导入，不切换当期。确认片单无误后，在网页底部进入管理员工作台，在「番季管理」里选中该季，点「设为当期」。
- 想让导入命令顺便切换当期，可以加 `--current`。建议先不加，确认片单和封面后再手动切换。
- 只想看会执行什么 SQL、不写数据库时，加 `--dry-run`。
- `cover_url` 会保存到 `club_anime`，网页片单会显示封面缩略图；缺图或加载失败时回退为原来的符号。

普通社员只能读取 `is_current = true` 的番季；旧番季的番剧和评价仍保留，管理员可以在工作台切换查看，并按所选番季导出 CSV。

### 查询数据库

```sh
npm run db:query -- "select id, title from public.club_anime order by sort_order limit 10;"
```

`db:query` 以只读模式执行并打印 JSON 结果。

### 全量备份

在本机手动执行：

```sh
npm run db:backup
```

默认写入 `backups/<本地时间>/`，也可以用 `--out` 指定目录：

```sh
npm run db:backup -- --out ../anime-review-backups/2026-10-26
```

每次备份包含：

- `schema.sql`：仓库中的结构定义
- `data.json`：`public` schema 下所有基础表和全部行
- `auth-users.json`：auth 用户的安全字段（id、email、创建/确认/登录时间）
- `manifest.json`：表、行数、字段、数据库大小和版本
- `README.txt`：恢复提示

注意：

- 备份包含 **CN、QQ、反馈内容、管理员邮箱**，属于敏感数据；目录权限是 `700`，文件是 `600`，不要提交或公开分享。
- `backups/` 已加入 `.gitignore`；Nginx 配置也会拒绝 `/backups/`，本机预览服务不提供该目录。
- 这是 `public` schema 的内容备份，不是可直接 `pg_restore` 的物理备份。恢复时先运行 `npm run db:init`，再按 `data.json` 导入；如果要连 `auth`/`storage` 一起做物理备份，需要使用数据库连接串和 Supabase CLI / `pg_dump`。
- 密码、refresh token、access token 不会写入备份。社员换设备后可用 CN + QQ 重新登录；管理员账号需要重新创建或重置密码。
- 建议至少每周运行一次，或在大规模改动前手动运行；最好在没人填写时执行，避免表之间出现短暂的不一致。

### 执行 SQL 文件

```sh
npm run db:sql -- ./修改.sql
```

该命令将指定文件中的 SQL 提交到当前项目，可用于修改数据或表结构。相对文件路径以执行命令时的终端目录为准；Token 和 `config.js` 始终从项目目录读取。文件需要事务时自行包含 `begin;` 和 `commit;`。

`db:query` 和 `db:sql` 只需要对应项目的 Database 权限。底层使用 [Supabase SQL query API](https://supabase.com/docs/reference/api/v1-run-a-query)，该上游接口目前标记为实验性／Beta。

## 旧库升级（含番季）

本次升级新增 `club_seasons.year`、`month`、`is_current`，给 `club_anime` 增加 `cover_url`，并加入新建番季、切换当期、读取当期公开评价、CN+QQ 登录以及提交反馈的数据库函数。已有项目也需要执行数据库升级，不能只刷新前端。

本地配置好 Token 后，可以直接执行：

```sh
npm run db:sql -- supabase/schema.sql
```

或者运行上面的 `npm run db:init`，同时完成结构升级和匿名登录配置核对。升级会把已有的 `2026-07` 补成 2026 年七月；如果库里还没有当期，会自动把它设为当期。已有番季、评价、CN 和管理员授权都会保留。

升级保留现有 CN、评价和管理员授权，并把现有 profile 映射为稳定成员。QQ 现在是必填且唯一的字段；如果旧库里有资料缺少 QQ 或 QQ 重复，`db:init` 会先报错，需要补齐或合并后再执行。旧手机号不会被当作 QQ 号，历史联系方式仅保留在旧库原字段中，前端不再读取或写入。

升级会移除旧的自动截止时间字段及相关限制，是否允许填写只由管理员的“开放填写”开关决定。`db:init` 会重写 `config.js`，新版不再包含固定的 `seasonId`。

## 管理员

已有管理员从网页底部“管理员入口”使用邮箱和密码登录。

新增管理员时，在 Supabase Authentication → Users 创建并确认邮箱用户，将其 UUID 填入 `.env.local` 的 `SUPABASE_ADMIN_USER_ID`，再执行 `npm run db:init`。授权完成后可清空这个可选配置项；清空不会撤销已授予的权限。

管理员可查看全体评价、新增番剧、管理番剧公开状态、切换默认评价阶段、手动开放或关闭填写、导出 CSV（含 QQ 号）。在「番季管理」里还可以：

- 按年份 + 季度（1、4、7、10 月）新建番季；
- 切换当前查看的番季，查看该季片单和评价；
- 点「设为当期」决定普通社员能看到的番季；
- 按所选番季导出汇总表。每部番剧占两行（评分 / 吐槽）；列为番剧、项目、前中期均分、完结均分、分差，以及每位评分人的前中期 / 完结两列。分差 = 完结均分 − 前中期均分。
- 查看右下角「反馈」提交的 Bug / 建议，并标记已处理或重新打开。

## 使用说明

- 社员用 CN + QQ 登录/登记：第一次填写创建成员，之后换浏览器或设备填同一组 CN + QQ 会映射到同一成员，评价不会分裂。
- QQ 号唯一，CN 必须与已登记的一致；两个都必须填写才能写评价。QQ 是联系资料，不是强密码——知道某人 CN + QQ 的人可以登录，若需要更强安全需再加 PIN 或邮箱验证。
- 前中期与完结评价分别保存。评分 0～5，最多一位小数；可以只写吐槽，0 分和未评分分别处理。
- 输入后自动保存，可查看保存状态；失败时可重试，草稿保留在当前浏览器。
- 普通社员只能看到当期番季；旧番季不会出现在填写页，但管理员仍可切换查看和导出。切换当期不会删除旧番季的评价。
- 展开番剧后可以查看当期其他社员的评价，只显示 CN、阶段、评分和吐槽，不显示 QQ；评价较多时每页 4 条，可以翻页。只浏览评价不需要登录，也不会创建 auth 用户；写评价必须填写 CN + QQ。
- 未登录时页面顶部和展开的编辑区会提示登录；评价和反馈都需要先填 CN + QQ。右下角固定「反馈」按钮会先要求登录，再提交 Bug / 建议；会自动附带当前页面和浏览器信息，只有管理员能查看和处理，每人每小时最多 10 条。
- 普通用户不能新增番剧；管理员在工作台新增后直接公开，数据库也限制为仅管理员可新增。
- 支持个人导出和管理员汇总表导出；导出包含 QQ 号（个人明细单独一列，汇总表写在评分人列名后的括号里）。QQ 号用于联系和生成头像，请妥善保管，不要公开传播。
- 网页只读取云端数据，不提供本地体验模式；云端未配置或暂时不可用时会显示错误提示和重新连接入口。

## 本机预览

只在本机查看前端、不启动 Nginx 或公网隧道时，可以运行 `npm start`，打开 <http://127.0.0.1:4173/>；端口可用 `PORT=4175 npm start` 调整。预览服务只提供网页静态文件，没有数据库管理接口。页面会直接读取 `config.js` 中的 Supabase；未配置或网络不可用时只显示错误提示和重新连接入口。

## GitHub Pages 部署

本仓库的工作流位于根目录 `.github/workflows/pages.yml`，从 `anime-review/` 组装站点；在仓库 Settings → Pages → Source 选择 **GitHub Actions**。工作流只上传网页运行所需文件，不需要安装或构建，也不上传 `.env.local`、管理脚本、Nginx 配置、SQL 文件或内部笔记。公开的 `config.js` 需随网页上传。

如果只把本目录拆成独立仓库，需要把工作流放到该仓库根目录并调整复制路径。不要将整个微信公众号工作区直接作为静态站点发布，避免包含原始社员资料。

## 文件结构

| 文件或目录 | 用途 |
| --- | --- |
| `index.html`、`styles.css`、`favicon.svg` | 网页及样式 |
| `app.js`、`core.js`、`store.js` | 交互、评分与导出、数据访问 |
| `config.js` | 公开连接配置 |
| `.env.example` / `.env.local` | 本地管理配置示例 / 私有配置 |
| `scripts/web.mjs` | Nginx 与临时公网隧道启动 |
| `scripts/serve.mjs` | 本机静态预览 |
| `scripts/database.mjs`、`scripts/initialize.mjs` | 命令行数据库操作、导入及初始化实现 |
| `scripts/backup.mjs` | 本地手动全量备份脚本 |
| `scripts/import.mjs` | 季度 CSV 解析、去重和导入 SQL 生成 |
| `nginx/nginx.conf` | 网站托管配置 |
| `supabase/` | 表结构和权限升级 |
| `vendor/` | Supabase SDK、来源说明和许可 |
| `.github/workflows/pages.yml` | GitHub Pages 部署配置 |
