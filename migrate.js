/**
 * 把旧静态 HTML 文章迁移到 data/articles/<id>.json
 * 用法：node migrate.js
 */
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const OLD_POSTS = path.join(ROOT, "_old-static-backup", "posts");
const DATA_DIR = path.join(ROOT, "data");
const ARTICLES_DIR = path.join(DATA_DIR, "articles");

fs.mkdirSync(ARTICLES_DIR, { recursive: true });

function safeId(title, filename) {
  // 优先用原文件名（去掉扩展名）做 id，更 URL 友好
  if (filename) {
    const base = path.basename(filename, ".html");
    if (/^[a-zA-Z0-9_-]+$/.test(base) && base.length > 1) return base;
  }
  return title
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "post-" + Date.now();
}

function extractText(el) {
  if (!el) return "";
  return el.textContent.trim();
}

function htmlToText(html) {
  // 简单把 HTML 段落转成文本换行，列表转成 "- "
  return html
    .replace(/<\/li>\s*<li>/gi, "\n- ")
    .replace(/<li>/gi, "- ")
    .replace(/<\/li>/gi, "")
    .replace(/<\/p>\s*<p>/gi, "\n\n")
    .replace(/<p>/gi, "")
    .replace(/<\/p>/gi, "")
    .replace(/<blockquote>/gi, "> ")
    .replace(/<\/blockquote>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/h[2-6]>/gi, "\n\n")
    .replace(/<h[2-6][^>]*>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const files = fs.readdirSync(OLD_POSTS).filter((f) => f.endsWith(".html"));

files.forEach((file) => {
  const html = fs.readFileSync(path.join(OLD_POSTS, file), "utf8");

  const titleMatch = html.match(/<article[^>]*>[\s\S]*?<h1>([\s\S]*?)<\/h1>/);
  const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : path.basename(file, ".html");

  const metaMatch = html.match(/<div class="post-meta">([\s\S]*?)<\/div>/);
  const meta = metaMatch ? metaMatch[1] : "";
  const spans = meta.match(/<span[^>]*>[\s\S]*?<\/span>/g) || [];
  function cleanSpan(s) {
    return s.replace(/<[^>]+>/g, "").replace(/^[^\u4e00-\u9fa5a-zA-Z0-9]+/, "").trim();
  }
  const tag = spans[0] ? cleanSpan(spans[0]) : "生活";
  const date = spans[1] ? cleanSpan(spans[1]) : new Date().toISOString().slice(0, 10);
  const readTime = spans[2] ? cleanSpan(spans[2]) : "约 3 分钟";

  const contentMatch = html.match(/<\/h1>([\s\S]*?)<div class="post-actions">/);
  const contentHtml = contentMatch ? contentMatch[1] : "";
  const content = htmlToText(contentHtml);

  const id = safeId(title, file);
  const article = {
    id,
    title,
    tag,
    date,
    readTime,
    content,
    author: "林泉汐",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(ARTICLES_DIR, id + ".json"), JSON.stringify(article, null, 2));
  console.log("Migrated:", file, "->", id + ".json");
});

console.log("Done.", files.length, "articles migrated.");
