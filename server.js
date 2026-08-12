/**
 * 小站 · 轻量动态博客后端
 * 零依赖：仅使用 Node 内置模块。
 *
 * 文章存为 <DATA_DIR>/articles/<id>.json
 * 用户存为 <DATA_DIR>/users.json
 * 会话保存在内存（重启后需重新登录）
 *
 * 启动：node server.js   （默认端口 3000，可用 PORT 环境变量覆盖）
 * 数据目录：默认用仓库内的 data/；部署到带持久化磁盘的平台（如 Render）时，
 *           用环境变量 DATA_DIR 指向挂载盘（如 /var/data），避免实例重启/休眠丢数据。
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
// SEED_DIR：仓库内置的初始数据（已提交到 git，部署时随代码一起存在）
const SEED_DIR = path.join(ROOT, "data");
// DATA_DIR：运行时真实读写的数据目录。本地默认用仓库内的 data/；
// 部署到 Render 等带持久化磁盘的平台时，用 DATA_DIR 指向挂载盘。
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : SEED_DIR;
const ARTICLES_DIR = path.join(DATA_DIR, "articles");
const USERS_FILE = path.join(DATA_DIR, "users.json");

const PORT = process.env.PORT || 3000;
const SESSION_TTL = 1000 * 60 * 60 * 24 * 7; // 7 天

// ---------- 初始化目录 ----------
// 若数据目录（持久化磁盘）为空，从仓库内置 seed 复制初始文章与用户，
// 保证首次部署后站点就有内容。
function seedIfEmpty() {
  if (DATA_DIR === SEED_DIR) return; // 本地默认路径，无需 seed
  const seedArticles = path.join(SEED_DIR, "articles");
  const seedUsers = path.join(SEED_DIR, "users.json");
  let needSeed = false;
  if (!fs.existsSync(ARTICLES_DIR) || fs.readdirSync(ARTICLES_DIR).length === 0) needSeed = true;
  if (!fs.existsSync(USERS_FILE)) needSeed = true;
  if (!needSeed) return;
  try {
    fs.mkdirSync(ARTICLES_DIR, { recursive: true });
    if (fs.existsSync(seedArticles)) {
      for (const f of fs.readdirSync(seedArticles)) {
        if (f.endsWith(".json")) fs.copyFileSync(path.join(seedArticles, f), path.join(ARTICLES_DIR, f));
      }
    }
    if (!fs.existsSync(USERS_FILE) && fs.existsSync(seedUsers)) {
      fs.copyFileSync(seedUsers, USERS_FILE);
    }
    console.log("[seed] 已从内置 seed 初始化数据目录 " + DATA_DIR);
  } catch (e) {
    console.error("[seed] 初始化失败:", e.message);
  }
}
seedIfEmpty();
fs.mkdirSync(ARTICLES_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "[]");

// ---------- 工具 ----------
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1e6) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error("无效的 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx < 0) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function setCookie(res, name, value, maxAge) {
  const opts = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
  res.setHeader("Set-Cookie", `${name}=${value}; ${opts}`);
}

function clearCookie(res, name) {
  res.setHeader("Set-Cookie", `${name}=; Path=/; HttpOnly; Max-Age=0`);
}

// ---------- 用户 ----------
function readUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch {
    return [];
  }
}
function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
function makeSalt() {
  return crypto.randomBytes(16).toString("hex");
}
function hashPassword(pw, salt) {
  return crypto.scryptSync(pw, salt, 64).toString("hex");
}

// ---------- 会话（内存） ----------
const sessions = new Map(); // sid -> { userId, expires }

function createSession(userId) {
  const sid = crypto.randomBytes(24).toString("hex");
  sessions.set(sid, { userId, expires: Date.now() + SESSION_TTL });
  return sid;
}
function currentUser(req) {
  const cookies = parseCookies(req);
  const sid = cookies.sid;
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (s.expires < Date.now()) {
    sessions.delete(sid);
    return null;
  }
  const user = readUsers().find((u) => u.id === s.userId);
  return user ? { id: user.id, username: user.username } : null;
}

// ---------- 文章 ----------
function safeId(id) {
  return String(id || "").replace(/[^a-zA-Z0-9_-]/g, "");
}
function excerpt(html, len = 90) {
  const text = String(html || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  return text.length > len ? text.slice(0, len) + "…" : text;
}
function listArticles() {
  let files = [];
  try {
    files = fs.readdirSync(ARTICLES_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const items = files.map((f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(ARTICLES_DIR, f), "utf8"));
    } catch {
      return null;
    }
  });
  return items
    .filter(Boolean)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .map((a) => ({
      id: a.id,
      title: a.title,
      tag: a.tag,
      date: a.date,
      readTime: a.readTime,
      author: a.author,
      excerpt: excerpt(a.content),
    }));
}
function getArticle(id) {
  const file = path.join(ARTICLES_DIR, safeId(id) + ".json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
function saveArticle(article) {
  const file = path.join(ARTICLES_DIR, safeId(article.id) + ".json");
  fs.writeFileSync(file, JSON.stringify(article, null, 2));
}
function deleteArticle(id) {
  const file = path.join(ARTICLES_DIR, safeId(id) + ".json");
  if (fs.existsSync(file)) fs.unlinkSync(file);
}
function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------- 静态文件 ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA 兜底：未知路径回 index.html
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (e2, d2) => {
        if (e2) {
          res.writeHead(404);
          return res.end("Not Found");
        }
        res.writeHead(200, { "Content-Type": MIME[".html"] });
        res.end(d2);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

// ---------- API ----------
async function handleApi(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
  const seg = parts.slice(1); // 去掉 "api"

  // /api/me
  if (seg[0] === "me" && req.method === "GET") {
    const u = currentUser(req);
    return sendJSON(res, 200, { user: u ? { username: u.username } : null });
  }

  // /api/register
  if (seg[0] === "register" && req.method === "POST") {
    const body = await readBody(req);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    if (username.length < 2) return sendJSON(res, 400, { error: "用户名至少 2 个字符" });
    if (password.length < 6) return sendJSON(res, 400, { error: "密码至少 6 位" });
    const users = readUsers();
    if (users.some((u) => u.username === username))
      return sendJSON(res, 409, { error: "用户名已存在" });
    const salt = makeSalt();
    const user = {
      id: newId(),
      username,
      salt,
      hash: hashPassword(password, salt),
      createdAt: new Date().toISOString(),
    };
    users.push(user);
    writeUsers(users);
    const sid = createSession(user.id);
    setCookie(res, "sid", sid, SESSION_TTL / 1000);
    return sendJSON(res, 200, { ok: true, user: { username } });
  }

  // /api/login
  if (seg[0] === "login" && req.method === "POST") {
    const body = await readBody(req);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const user = readUsers().find((u) => u.username === username);
    if (!user || hashPassword(password, user.salt) !== user.hash)
      return sendJSON(res, 401, { error: "用户名或密码错误" });
    const sid = createSession(user.id);
    setCookie(res, "sid", sid, SESSION_TTL / 1000);
    return sendJSON(res, 200, { ok: true, user: { username } });
  }

  // /api/logout
  if (seg[0] === "logout" && req.method === "POST") {
    const cookies = parseCookies(req);
    if (cookies.sid) sessions.delete(cookies.sid);
    clearCookie(res, "sid");
    return sendJSON(res, 200, { ok: true });
  }

  // /api/articles
  if (seg[0] === "articles") {
    // 列表
    if (seg.length === 1 && req.method === "GET") {
      return sendJSON(res, 200, { articles: listArticles() });
    }
    // 创建（需登录）
    if (seg.length === 1 && req.method === "POST") {
      const u = currentUser(req);
      if (!u) return sendJSON(res, 401, { error: "请先登录" });
      const body = await readBody(req);
      const title = String(body.title || "").trim();
      const content = String(body.content || "");
      if (!title || !content) return sendJSON(res, 400, { error: "标题和正文不能为空" });
      const id = newId();
      const article = {
        id,
        title,
        tag: String(body.tag || "生活"),
        date: String(body.date || new Date().toISOString().slice(0, 10)),
        readTime: String(body.readTime || "约 3 分钟"),
        content,
        author: u.username,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      saveArticle(article);
      return sendJSON(res, 200, { ok: true, id });
    }
    // /api/articles/:id
    const id = safeId(seg[1]);
    if (!id) return sendJSON(res, 400, { error: "无效的文章 ID" });
    if (req.method === "GET") {
      const a = getArticle(id);
      if (!a) return sendJSON(res, 404, { error: "文章不存在" });
      return sendJSON(res, 200, { article: a });
    }
    // 修改 / 删除（需登录）
    if (req.method === "PUT" || req.method === "DELETE") {
      const u = currentUser(req);
      if (!u) return sendJSON(res, 401, { error: "请先登录" });
      const existing = getArticle(id);
      if (!existing) return sendJSON(res, 404, { error: "文章不存在" });
      if (req.method === "DELETE") {
        deleteArticle(id);
        return sendJSON(res, 200, { ok: true });
      }
      // PUT
      const body = await readBody(req);
      const updated = {
        ...existing,
        title: String(body.title || existing.title),
        tag: String(body.tag || existing.tag),
        date: String(body.date || existing.date),
        readTime: String(body.readTime || existing.readTime),
        content: String(body.content || existing.content),
        updatedAt: new Date().toISOString(),
      };
      saveArticle(updated);
      return sendJSON(res, 200, { ok: true, id });
    }
    return sendJSON(res, 405, { error: "方法不被允许" });
  }

  return sendJSON(res, 404, { error: "接口不存在" });
}

// ---------- 主服务器 ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url).catch((err) => {
      sendJSON(res, 400, { error: err.message || "请求错误" });
    });
    return;
  }
  serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`✨ 小站已启动： http://localhost:${PORT}`);
});

module.exports = server;
