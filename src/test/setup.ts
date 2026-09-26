import "@testing-library/jest-dom/vitest";

// jsdom 未实现 scrollIntoView（设置对话框的分区跳转依赖它）
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// jsdom 未实现 ResizeObserver（TextDiffDialog 的虚拟滚动视口测量依赖它）
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}
