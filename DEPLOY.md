# 部署指南 · 林泉汐的小站

本项目是一个**零依赖**的 Node.js 动态博客（`server.js` 仅用 Node 内置模块），
文章以 JSON 存于 `data/articles/`，支持注册/登录、文章发布/修改/删除。
本文件记录从本地运行到上线 Render 的完整步骤。

---

## 1. 本地运行

```bash
cd personal-site
node server.js
# 打开 http://localhost:3000
```

- 默认端口 3000，可用环境变量 `PORT` 覆盖。
- 默认数据目录为仓库内的 `data/`（含 3 篇示例文章 + `users.json`）。
- Windows 用户可直接双击 `start.bat`；macOS/Linux 用 `./start.sh`。

---

## 2. 推送到 GitHub

> ⚠️ **重要限制**：WorkBuddy 的 GitHub 连接器（`mcp__github__*`）对仓库只有
> **只读**权限（`push_files` / `create_or_update_file` 均返回
> `403 Resource not accessible by integration`）。因此**代码无法用连接器代推**，
> 只能由你用自己的 Personal Access Token (PAT) 推送。连接器的读权限可用于推送后核验文件。

### 方式 A：一键脚本（推荐）
1. 在 GitHub → Settings → Developer settings → Personal access tokens →
   Tokens (classic) 生成一个 Token，勾选 `repo` 权限。
2. 双击运行 `deploy-to-github.bat`：
   - 用户名填 `linquanxi809-tech`，仓库名直接回车（默认 `lin-quan-xi-blog`）。
   - 弹出口令时**粘贴你的 PAT 当密码**（GitHub 已不支持账户密码）。
3. 普通推送被拒（多为历史不一致）时脚本会**自动 `--force` 覆盖远端**。

### 方式 B：GitHub 网页上传
在仓库页面 **Add files → Upload files** 直接拖拽，适合少量文件更新。

> 注意：`.gitignore` 不会上传，不影响运行与部署。

---

## 3. Render 部署（Blueprint，自动读 render.yaml）

1. 打开 https://dashboard.render.com/ ，用 **GitHub 账号 `linquanxi809-tech`** 登录
   （推荐「Continue with GitHub」，顺带授权仓库）。
2. 右上角 **New + → Blueprint**。
3. 连接 GitHub → 选中仓库 **`lin-quan-xi-blog`**。
4. Render 自动读取 `render.yaml`，预览出 Web 服务 `lin-quan-xi-blog`
   （free 套餐，自带 1GB 持久化磁盘）。**无需改配置**，点 **Apply / Create**。
5. 构建：`npm install`（零依赖，几秒过）→ `node server.js`。
   日志出现 `✨ 小站已启动` 即成功。
6. 公网地址形如：**https://lin-quan-xi-blog.onrender.com**
   （若服务名被占用，Render 会追加随机后缀，请以控制台显示为准）。

### render.yaml 关键配置（已写好，一般不用改）
```yaml
services:
  - type: web
    name: lin-quan-xi-blog
    runtime: node
    plan: free
    branch: main
    buildCommand: "npm install"
    startCommand: "node server.js"
    healthCheckPath: /
    disk:
      name: data
      mountPath: /var/data
      sizeGB: 1
    envVars:
      - key: NODE_ENV
        value: production
      - key: DATA_DIR
        value: /var/data
```

---

## 4. 上线后要做的事

- **注册管理员账号**：发布/修改/删除文章需登录，打开
  `https://<你的地址>/register.html` 建一个账号。
- **数据持久化（free 套餐）**：当前用的是 **free 套餐，不支持持久化磁盘**，
  所以 `render.yaml` 里的 `disk` 块在 free 下不生效。文章实际写在运行容器的
  **临时文件系统**里。为保证文章重部署不丢，本项目启用了
  **自动同步回 GitHub 仓库**（见下方第 6 节 `GH_TOKEN` 等环境变量）。
- **想用真正的持久化磁盘**：需升级到 **Starter 套餐**（约 $7/月），
  在 Render 控制台给服务加上 `disk` 配置（name: data / mountPath: /var/data /
  sizeGB: 1）并设 `DATA_DIR=/var/data` 即可，与 `render.yaml` 一致。

---

## 5. 常见问题

- **免费套餐会休眠**：空闲 15 分钟实例休眠，再次访问需 ~30–50 秒冷启动。
  想要常驻升级 Starter 套餐（约 $7/月）。
- **首页打不开 / Not Found**：多半是地址猜错（服务名带后缀）或服务还没建出来
  （只授权未点 Apply）。以 Render 控制台显示的 `onrender.com` 地址为准。
- **部署失败**：把 Render 的 Build/Deploy 日志贴给 AI 排查。本项目端口、PORT 监听、
  持久化磁盘配置均已校验无误，问题多在外部配置。
- **改完代码怎么更新**：本项目已接入 **GitHub Actions 自动部署**
  （`.github/workflows/deploy-render.yml`）。本地改完，再跑一次 `deploy-to-github.bat`
  推到 GitHub，GitHub Actions 会**自动调用 Render API 触发部署**，无需手动操作。
  - 前提：仓库 Settings → Secrets → Actions 里已配置
    `RENDER_API_KEY`（Render API Key）与 `RENDER_SERVICE_ID`（如 `srv-xxx`）。
  - 若想手动触发也可：Render 控制台 → 服务 → **Manual Deploy → Deploy latest commit**，
    或用 API：`POST https://api.render.com/v1/services/<serviceId>/deploys`（Bearer Key）。
- **账号 / 文章清理**：API 创建的服务，重部署会把容器本地状态重置回 git 快照
  （即 GitHub 上 `data/users.json` 与 `data/articles/` 的内容）。若想清掉线上测试
  账号或测试文章，记得先在 GitHub 仓库里改好，再手动重部署。

---

## 6. 文章自动同步回 GitHub（free 套餐持久化方案）

由于 free 套餐无持久化磁盘，本项目让后台在**发布 / 修改 / 删除文章时，自动把
`data/articles/<id>.json` 同步回 GitHub 仓库**。这样重部署后文章不丢（仓库即数据源）。

在 Render 服务上设置以下环境变量（已设置，记录备查）：

| 变量 | 说明 | 是否已设 |
|------|------|----------|
| `GH_TOKEN` | 你的 GitHub PAT（classic，勾选 `repo`），**设为 Secret** | ✅ 已设 |
| `GH_REPO` | 目标仓库，如 `linquanxi809-tech/lin-quan-xi-blog` | ✅ 已设 |
| `GH_BRANCH` | 目标分支，如 `main` | ✅ 已设 |

> 未设置 `GH_TOKEN` 时，后台只写本地（不影响运行），只是重部署会丢新文章。
> 若需轮换 Token：在 GitHub 吊销旧 PAT → 在 Render 控制台更新 `GH_TOKEN` 变量
> （更新环境变量会自动触发一次重新部署）。

⚠️ **安全提示**：`GH_TOKEN` 与 Render API Key 都是高权限凭证。本项目演示中曾由 AI
临时使用，部署完成后请到 GitHub（Settings → Developer settings → PAT）与 Render
（Account Settings → API Keys）将其吊销/轮换，不要长期留存。
