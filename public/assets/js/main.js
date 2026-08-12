// 小站 · 互动脚本（无依赖）
// 1) 滚动入场动画  2) 页脚年份自动更新

document.addEventListener("DOMContentLoaded", function () {
  // 页脚年份
  var y = document.getElementById("year");
  if (y) y.textContent = new Date().getFullYear();

  // 滚动入场
  var items = document.querySelectorAll(".reveal");
  if (!("IntersectionObserver" in window) || items.length === 0) {
    items.forEach(function (el) { el.classList.add("in"); });
    return;
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) {
        e.target.classList.add("in");
        io.unobserve(e.target);
      }
    });
  }, { threshold: 0.12 });
  items.forEach(function (el) { io.observe(el); });
});
