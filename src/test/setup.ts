import "@testing-library/jest-dom/vitest";

// jsdom 未实现 scrollIntoView（设置对话框的分区跳转依赖它）
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
