(() => {
  "use strict";

  // 公众号常用、且本模板实际使用的样式属性。
  // 复制时将浏览器的计算结果写入 style="..."，不再依赖外部 CSS。
  const INLINE_PROPERTIES = [
    "box-sizing",
    "display",
    "position",
    "z-index",
    "float",
    "clear",
    "width",
    "min-width",
    "max-width",
    "height",
    "min-height",
    "max-height",
    "margin-top",
    "margin-right",
    "margin-bottom",
    "margin-left",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "overflow",
    "overflow-x",
    "overflow-y",
    "color",
    "background-color",
    "background-image",
    "background-position",
    "background-size",
    "background-repeat",
    "border-top-width",
    "border-top-style",
    "border-top-color",
    "border-right-width",
    "border-right-style",
    "border-right-color",
    "border-bottom-width",
    "border-bottom-style",
    "border-bottom-color",
    "border-left-width",
    "border-left-style",
    "border-left-color",
    "border-top-left-radius",
    "border-top-right-radius",
    "border-bottom-right-radius",
    "border-bottom-left-radius",
    "box-shadow",
    "opacity",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "line-height",
    "letter-spacing",
    "text-align",
    "text-decoration-line",
    "text-decoration-color",
    "text-decoration-style",
    "text-indent",
    "text-transform",
    "vertical-align",
    "white-space",
    "word-break",
    "overflow-wrap",
    "list-style-position",
    "list-style-type",
    "object-fit",
    "object-position",
    "border-collapse",
    "border-spacing",
    "table-layout",
    "transform",
    "transform-origin",
  ];

  const root = document.querySelector(".wechat-article");
  const manualButton = document.querySelector("#manual-wechat-button");

  function inlineComputedStyles(sourceRoot, clonedRoot) {
    const sourceNodes = [sourceRoot, ...sourceRoot.querySelectorAll("*")];
    const clonedNodes = [clonedRoot, ...clonedRoot.querySelectorAll("*")];
    const sizeProperties = [
      "width",
      "min-width",
      "max-width",
      "height",
      "min-height",
      "max-height",
    ];

    sourceNodes.forEach((source, index) => {
      const target = clonedNodes[index];
      const computed = window.getComputedStyle(source);

      INLINE_PROPERTIES.forEach((property) => {
        const value = computed.getPropertyValue(property);
        if (value) {
          target.style.setProperty(property, value);
        }
      });

      // 计算样式会把 auto/100% 转成当前窗口的像素值。
      // 先清掉固化尺寸，只对确实需要固定大小的装饰元素恢复尺寸。
      sizeProperties.forEach((property) => target.style.removeProperty(property));

      if (source === sourceRoot) {
        target.style.setProperty("width", "100%");
        target.style.setProperty("max-width", "677px");
      } else if (source.matches(".banner-decoration")) {
        target.style.setProperty("width", "42px");
        target.style.setProperty("height", "5px");
      } else if (source.matches(".banner-tail, .banner-tail-fill")) {
        target.style.setProperty("width", "0");
        target.style.setProperty("height", "0");
      } else if (source.matches(".cover-figure img")) {
        target.style.setProperty("width", "100%");
        target.style.setProperty("max-width", "100%");
        target.style.setProperty("height", "auto");
      } else if (source.matches(".reviewer")) {
        target.style.setProperty("width", "100%");
        target.style.setProperty("min-height", "74px");
      } else if (source.matches(".avatar")) {
        target.style.setProperty("width", computed.getPropertyValue("width"));
        target.style.setProperty("height", computed.getPropertyValue("height"));
      } else if (source.matches(".avatar-badge")) {
        target.style.setProperty("min-width", "22px");
        target.style.setProperty("height", "22px");
      } else if (source.matches(".reviewer-meta")) {
        target.style.setProperty("width", "100%");
      } else if (source.matches(".connector")) {
        target.style.setProperty("width", "1px");
        target.style.setProperty("height", "18px");
      } else if (source.matches(".comment-dot")) {
        target.style.setProperty("width", "6px");
        target.style.setProperty("height", "6px");
      } else if (source.matches(".ending-decoration")) {
        target.style.setProperty("height", "37px");
      } else if (source.matches(".ending-decoration span")) {
        target.style.setProperty("width", "0");
        target.style.setProperty("height", "0");
      }

    });
    clonedRoot.style.setProperty("margin-left", "auto");
    clonedRoot.style.setProperty("margin-right", "auto");

    return clonedRoot;
  }

  function replaceTag(element, tagName) {
    const replacement = document.createElement(tagName);
    [...element.attributes].forEach((attribute) => {
      replacement.setAttribute(attribute.name, attribute.value);
    });
    while (element.firstChild) {
      replacement.appendChild(element.firstChild);
    }
    element.replaceWith(replacement);
    return replacement;
  }

  function createLayoutTable() {
    const table = document.createElement("table");
    table.setAttribute("role", "presentation");
    table.setAttribute("border", "0");
    table.setAttribute("cellpadding", "0");
    table.setAttribute("cellspacing", "0");
    table.style.cssText =
      "width:100%;border:0;border-collapse:collapse;border-spacing:0;table-layout:auto;margin:0;padding:0;background-color:transparent;";
    return table;
  }

  function normalizeReviewerRows(rootElement) {
    rootElement.querySelectorAll(".reviewer").forEach((reviewer) => {
      const avatar = reviewer.querySelector(".avatar");
      const badge = reviewer.querySelector(".avatar-badge");
      const meta = reviewer.querySelector(".reviewer-meta");

      const avatarWidth = avatar.style.getPropertyValue("width") || "66px";
      const table = createLayoutTable();
      table.style.minHeight = "74px";
      table.style.tableLayout = "fixed";
      const tbody = document.createElement("tbody");
      const row = document.createElement("tr");
      const avatarCell = document.createElement("td");
      const metaCell = document.createElement("td");

      avatarCell.setAttribute("width", "79");
      avatarCell.style.cssText =
        "width:79px;max-width:79px;padding:0;border:0;vertical-align:middle;text-align:left;";
      metaCell.style.cssText =
        "padding:0;border:0;vertical-align:middle;text-align:left;";

      avatar.style.cssText +=
        `;display:block;width:${avatarWidth};height:${avatar.style.getPropertyValue("height") || avatarWidth};margin:0 13px 0 0;`;
      avatarCell.appendChild(avatar);
      if (badge) {
        badge.style.cssText +=
          ";display:inline-block;position:static;margin:-22px 0 0 44px;vertical-align:top;";
        avatarCell.appendChild(badge);
      }
      while (meta.firstChild) {
        metaCell.appendChild(meta.firstChild);
      }

      row.append(avatarCell, metaCell);
      tbody.appendChild(row);
      table.appendChild(tbody);
      reviewer.replaceWith(table);
    });
  }

  function normalizeConnectors(rootElement) {
    rootElement.querySelectorAll(".connector").forEach((connector) => {
      const line = document.createElement("p");
      line.innerHTML = "&#8203;";
      line.style.cssText =
        "display:block;width:1px;height:18px;margin:0 0 0 33px;padding:0;border:0;border-left:1px solid #ffbd00;color:transparent;font-size:1px;line-height:18px;";
      connector.replaceWith(line);
    });
  }

  function normalizeCommentBoxes(rootElement) {
    rootElement.querySelectorAll(".comment-box").forEach((commentBox) => {
      const paragraph = [...commentBox.children].find(
        (child) => child.tagName === "P"
      );

      const table = createLayoutTable();
      const tbody = document.createElement("tbody");
      const row = document.createElement("tr");
      const leftDot = document.createElement("td");
      const content = document.createElement("td");
      const rightDot = document.createElement("td");

      leftDot.textContent = "●";
      rightDot.textContent = "●";
      leftDot.style.cssText =
        "width:8px;padding:0;border:0;color:#ffbd00;font-size:10px;line-height:1;text-align:center;vertical-align:middle;";
      rightDot.style.cssText = leftDot.style.cssText;
      content.style.cssText =
        "padding:8px 10px 9px;border:1px solid #ffbd00;background-color:rgba(255,255,255,0.38);vertical-align:top;";
      content.appendChild(paragraph);

      row.append(leftDot, content, rightDot);
      tbody.appendChild(row);
      table.appendChild(tbody);
      commentBox.replaceWith(table);
    });
  }

  function normalizeDecorations(rootElement) {
    rootElement.querySelectorAll(".banner-decoration").forEach((decoration) => {
      decoration.innerHTML = "&#8203;";
      decoration.style.setProperty("font-size", "1px");
      decoration.style.setProperty("line-height", "5px");
    });

    rootElement.querySelectorAll(".banner-tail").forEach((tail) => {
      tail.textContent = "◢";
      tail.style.cssText =
        "display:block;position:static;width:auto;height:20px;margin:-1px 0 12px 10px;padding:0;border:0;color:#303d82;background-color:transparent;font-size:25px;line-height:20px;text-align:left;transform:none;";
    });

    rootElement.querySelectorAll(".ending-decoration").forEach((ending) => {
      ending.innerHTML =
        '<span style="color:#85ddd0;font-size:23px;line-height:1;">▲</span>' +
        '<span style="color:#ffd2b5;font-size:31px;line-height:1;">▲</span>' +
        '<span style="color:#b8dfea;font-size:18px;line-height:1;">▲</span>';
      ending.style.cssText =
        "display:block;height:auto;margin:8px 14px;text-align:right;line-height:1;";
    });
  }

  function normalizeSemanticTags(rootElement) {
    rootElement.querySelectorAll("figure, footer").forEach((element) => {
      replaceTag(element, "section");
    });
    if (rootElement.tagName === "ARTICLE") {
      return replaceTag(rootElement, "section");
    }
    return rootElement;
  }

  function removeUnsupportedDependencies(rootElement) {
    [rootElement, ...rootElement.querySelectorAll("*")].forEach((element) => {
      element.removeAttribute("class");
      element.removeAttribute("id");
      element.style.removeProperty("z-index");
      element.style.removeProperty("transform");
      element.style.removeProperty("transform-origin");
    });
  }

  function normalizeForWechat(rootElement) {
    normalizeReviewerRows(rootElement);
    normalizeConnectors(rootElement);
    normalizeCommentBoxes(rootElement);
    normalizeDecorations(rootElement);
    const safeRoot = normalizeSemanticTags(rootElement);
    removeUnsupportedDependencies(safeRoot);
    return safeRoot;
  }

  function createWechatFragment() {
    let clone = root.cloneNode(true);
    inlineComputedStyles(root, clone);
    clone = normalizeForWechat(clone);
    return clone;
  }

  function prepareManualCopy() {
    const layer = document.createElement("div");
    layer.id = "wechat-manual-copy-layer";
    layer.style.cssText =
      "position:fixed;z-index:999999;inset:0;overflow:auto;padding:54px 16px 30px;background:#fff;";

    const tip = document.createElement("div");
    tip.setAttribute("data-copy-exclude", "true");
    tip.style.cssText =
      "position:fixed;z-index:1000000;top:0;left:0;right:0;display:flex;align-items:center;justify-content:center;gap:14px;min-height:44px;padding:5px 12px;color:#fff;background:#273957;font:600 14px/1.5 sans-serif;text-align:center;";
    tip.textContent = "兼容版已选中：现在按 Ctrl / ⌘ + C，然后粘贴到公众号";

    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "关闭";
    close.style.cssText =
      "padding:4px 10px;border:1px solid rgba(255,255,255,.65);border-radius:5px;color:#fff;background:transparent;cursor:pointer;";
    close.addEventListener("click", () => layer.remove());
    tip.appendChild(close);

    const copyArea = document.createElement("div");
    copyArea.setAttribute("contenteditable", "true");
    copyArea.setAttribute("spellcheck", "false");
    copyArea.style.cssText = "outline:none;";
    const fragment = createWechatFragment();
    copyArea.appendChild(fragment);
    layer.append(tip, copyArea);
    document.body.appendChild(layer);

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(copyArea);
    selection.removeAllRanges();
    selection.addRange(range);
    copyArea.focus();

  }

  manualButton.addEventListener("click", prepareManualCopy);
})();
