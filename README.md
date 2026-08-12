# 林泉汐的小站 🛠️

一个轻量、活泼、零依赖的动态个人博客。

- **前端**：HTML / CSS / 原生 JS，文章列表与详情动态渲染
- **后端**：Node.js 零依赖（`server.js`，仅用内置模块），负责账号与文章 CRUD
- **存储**：文章以 JSON 存于 `data/articles/<id>.json`，用户存于 `data/users.json`
- **风格**：明亮渐变、圆角卡片、俏皮点缀

---

## 一、本地运行

需要 Node.js（任意较新版本即可，无需 `npm install` 任何依赖）。

```bash
# 方式一：双击启动（Windows）
start.bat

# 方式二：命令行
node server.js
```

然后打开浏览器访问 **http://localhost:3000**

> ⚠️ 不要用 `file://` 直接双击 `public/index.html` 打开——那样浏览器会拦截 `fetch`，文章加载不出来。一定要通过 `node server.js` 起服务再用 http 访问。

启动后首次访问会看到三篇示例文章（已内置在 `data/articles/`）。

---

## 二、目录结构

```
personal-site/
├─ server.js            # 零依赖后端：静态服务 + 账号 + 文章 CRUD
├─ render.yaml          # Render 部署配置（含持久化磁盘）
├─ package.json         # 启动入口声明
├─ start.bat / start.sh # 本地一键启动
├─ data/                # 运行时数据（也是部署时的种子）
│  ├─ articles/*.json   # 文章
│  └─ users.json        # 用户
├─ public/              # 前端页面
│  ├─ index.html        # 首页（文章列表）
│  ├─ article.html      # 文章详情（含 修改/删除 按钮）
│  ├─ publish.html      # 发布 / 编辑
│  ├─ login.html / register.html
│  ├─ about.html
│  └─ assets/{css,js,images}
└─ _old-static-backup/  # 最初静态版备份（可删）
```

---

## 三、发布 / 管理文章

在浏览器里登录后：

- **发布**：首页左上角「✍️ 发布」→ 填写标题、标签、日期、正文 → 提交即写入后端。
- **修改**：进入任意文章 → 底部「✏️ 修改」→ 改完重新提交覆盖。
- **删除**：进入任意文章 → 底部「🗑 删除」→ 确认即删。

所有改动实时生效，无需重新部署。

---

## 四、部署上线（Render + GitHub）

代码已初始化为 git 仓库并提交了文章数据。部署需**你自己的 GitHub 和 Render 账号**（无法代为注册）。

### 第 1 步：推到 GitHub

1. 打开 github.com → **New repository**，名字随意（如 `lin-quan-xi-blog`），**不要**勾选初始化 README / LICENSE（代码已存在）。
2. 在 `personal-site` 文件夹打开终端，执行（把链接换成你刚建的仓库地址）：

```bash
git remote add origin https://github.com/你的用户名/仓库名.git
git push -u origin main
```

### 第 2 步：Render 一键部署

1. 打开 [render.com](https://render.com) → 用 GitHub 登录 → **New → Blueprint**。
2. 连接 GitHub，选中刚才的仓库。
3. Render 自动读取 `render.yaml`，已配好：
   - 启动命令 `node server.js`
   - 免费 plan
   - 1 GB **持久化磁盘**（`/var/data`，发布的新文章重启/休眠后不丢）
   - 健康检查路径 `/`
4. 点击 **Create Web Service**，等待 1–2 分钟构建完成，得到一个公网地址 `https://xxx.onrender.com`，直接可访问。

> 说明：首次部署磁盘为空时，服务器会自动把内置的三篇示例文章复制到磁盘，所以上线即有内容。
> 免费实例一段时间无访问会休眠，磁盘上的文章不会丢；冷启动会慢几秒，属正常现象。

---

## 五、常见问题

- **首页文章空白 / 报 Failed to fetch**：后端 `server.js` 没启动，或你是用 `file://` 打开的。请按「本地运行」章节用 http 访问。
- **文章数据丢了**：`data/` 是运行时目录，重启一般不会丢；若异常清空，重新运行 `node migrate.js` 可从备份恢复（前提是 `_old-static-backup/` 还在）。
- **想换数据库 / 加评论 / 加暗色模式**：直接告诉我，我帮你加。

---

© 林泉汐 · 用 ❤️ 和静态文件 + 一点点 Node 搭建
