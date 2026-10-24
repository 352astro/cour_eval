#!/usr/bin/env python3
"""从米麓星 /list 筛选指定年份、季度，只保存名称和封面链接。

在项目根目录运行：
    uv run python "获取动漫资源/miluxing_season_covers.py"

默认筛选 2026 年七月，遍历所有分页，生成脚本同目录下的
miluxing_2026_07.csv。可用 --year、--month 修改季度；--format both
同时生成 CSV 和 JSON。两种格式均只包含 title 和 cover_url。
生成的 CSV 可直接用 anime-review 的 `npm run db:import` 写入 Supabase。
不进入作品详情页，也不下载封面文件。
"""

import argparse
import base64
import csv
import json
import sys
from pathlib import Path
from urllib.parse import urljoin, urlparse


SOURCE_URL = "https://www.miluxing.com/list"
MONTH_LABELS = {1: "一月", 4: "四月", 7: "七月", 10: "十月"}
CARD_SELECTOR = ".anime-content-list"
NAME_SELECTOR = ".anime-content-list-name"
# 浏览器只需渲染列表，无需访问图片服务器。返回一像素占位图，保留
# img 的原始 src，避免加载失败时 Element Plus 移除 img 而丢失链接。
PLACEHOLDER_GIF = base64.b64decode(
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
)


def launch_browser(playwright, browser_name: str, headless: bool):
    """优先启动系统 Chrome/Edge，也可使用 Playwright Chromium。"""
    if browser_name == "auto":
        candidates = (
            ("Chrome", {"channel": "chrome"}),
            ("Edge", {"channel": "msedge"}),
            ("Playwright Chromium", {}),
        )
    elif browser_name == "chromium":
        candidates = (("Playwright Chromium", {}),)
    else:
        candidates = ((browser_name, {"channel": browser_name}),)

    errors: list[str] = []
    for label, options in candidates:
        try:
            browser = playwright.chromium.launch(headless=headless, **options)
            return browser, label
        except Exception as exc:  # Playwright 的异常类会随版本变化
            errors.append(f"{label}: {exc}")

    raise RuntimeError(
        "无法启动浏览器。请安装 Chrome，或运行 "
        "`uv run playwright install chromium` 后使用 `--browser chromium`。\n"
        + "\n".join(errors)
    )


EXTRACT_CARDS_JS = """cards => cards.map(card => {
    const name = card.querySelector('.anime-content-list-name');
    const image = card.querySelector('.anime-content-list-cover-image img');
    return {
        title: name?.textContent?.trim() || '',
        cover_url: image?.getAttribute('src') || '',
        href: name?.getAttribute('href') || ''
    };
})"""


def page_signature(page) -> list[str]:
    return page.locator(NAME_SELECTOR).evaluate_all(
        "names => names.map(name => name.getAttribute('href'))"
    )


def wait_for_list(page, previous: list[str] | None = None) -> None:
    """等到新列表出现，防止筛选或翻页后读到上一批数据。"""
    if previous is not None:
        page.wait_for_function(
            """previous => {
                const names = [...document.querySelectorAll(
                    '.anime-content-list-name'
                )].map(name => name.getAttribute('href'));
                return names.length > 0 &&
                    JSON.stringify(names) !== JSON.stringify(previous);
            }""",
            arg=previous,
        )
    page.locator(NAME_SELECTOR).first.wait_for(state="visible")
    page.wait_for_load_state("networkidle")


def select_filter(page, index: int, label: str) -> None:
    previous = page_signature(page)
    # Element Plus 的内部 input 被占位文字覆盖，应点击整个可见外框。
    select = page.locator(".el-select").nth(index)
    select.locator(".el-select__wrapper").click()
    page.get_by_role("option", name=label, exact=True).click()
    wait_for_list(page, previous)
    selected = select.inner_text().strip()
    if selected != label:
        raise RuntimeError(f"筛选未生效：期望 {label!r}，实际 {selected!r}")


def normalize_card(card: dict) -> tuple[str, dict[str, str]]:
    """href 只用于内部去重；导出字段严格限制为名称和封面链接。"""
    title = card["title"].strip()
    href = card["href"].strip()
    cover = card["cover_url"].strip()
    if not title or not href or not cover:
        raise RuntimeError(f"列表中存在缺少名称或封面链接的作品：{title!r}")
    cover_url = urljoin(SOURCE_URL, cover)
    if urlparse(cover_url).scheme not in ("http", "https"):
        raise RuntimeError(f"{title} 的封面不是有效的网页链接：{cover!r}")
    return urljoin(SOURCE_URL, href), {"title": title, "cover_url": cover_url}


def scrape_covers(
    year: int,
    month: int,
    *,
    browser_name: str = "auto",
    headless: bool = True,
    timeout_seconds: int = 60,
) -> list[dict[str, str]]:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise RuntimeError("缺少 Playwright，请先在项目根目录运行 `uv sync`。") from exc

    with sync_playwright() as playwright:
        browser, label = launch_browser(playwright, browser_name, headless)
        print(f"浏览器：{label}；筛选：{year} 年 {month} 月", file=sys.stderr)
        try:
            context = browser.new_context(locale="zh-CN", timezone_id="Asia/Shanghai")

            def handle_route(route):
                if route.request.resource_type == "image":
                    route.fulfill(content_type="image/gif", body=PLACEHOLDER_GIF)
                else:
                    route.continue_()

            context.route("**/*", handle_route)
            page = context.new_page()
            page.set_default_timeout(timeout_seconds * 1000)
            page.goto(SOURCE_URL, wait_until="domcontentloaded")
            wait_for_list(page)
            # /list 的前两个下拉框分别是年份和季度，其余条件保留不限。
            select_filter(page, 0, str(year))
            select_filter(page, 1, MONTH_LABELS[month])

            results: dict[str, dict[str, str]] = {}
            seen_pages: set[tuple[str, ...]] = set()
            page_number = 1
            while True:
                signature = tuple(page_signature(page))
                if not signature or signature in seen_pages:
                    raise RuntimeError("列表为空或翻页结果重复，已停止以避免导出不完整数据。")
                seen_pages.add(signature)
                cards = page.locator(CARD_SELECTOR).evaluate_all(EXTRACT_CARDS_JS)
                for card in cards:
                    identity, item = normalize_card(card)
                    results.setdefault(identity, item)
                print(f"第 {page_number} 页：{len(cards)} 部", file=sys.stderr)

                next_button = page.get_by_role("button", name="下一页", exact=True)
                # 分页控件缺失时不能假设已抓全，直接报错。
                next_button.wait_for(state="attached")
                if next_button.is_disabled():
                    break
                next_button.click()
                wait_for_list(page, list(signature))
                page_number += 1

            return list(results.values())
        finally:
            browser.close()


def write_outputs(items: list[dict[str, str]], directory: Path, stem: str,
                  output_format: str) -> list[Path]:
    directory.mkdir(parents=True, exist_ok=True)
    created = []
    if output_format in ("csv", "both"):
        path = directory / f"{stem}.csv"
        with path.open("w", encoding="utf-8-sig", newline="") as file:
            writer = csv.DictWriter(file, fieldnames=("title", "cover_url"))
            writer.writeheader()
            writer.writerows(items)
        created.append(path)
    if output_format in ("json", "both"):
        path = directory / f"{stem}.json"
        path.write_text(json.dumps(items, ensure_ascii=False, indent=2) + "\n",
                        encoding="utf-8")
        created.append(path)
    return created


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--year", type=int, default=2026, help="年份（默认：2026）")
    parser.add_argument("--month", type=int, choices=MONTH_LABELS, default=7,
                        help="季度起始月份：1、4、7、10（默认：7）")
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).resolve().parent,
                        help="输出目录（默认：脚本所在目录）")
    parser.add_argument("--format", choices=("csv", "json", "both"), default="csv",
                        help="输出格式（默认：csv）")
    parser.add_argument("--browser", choices=("auto", "chrome", "msedge", "chromium"),
                        default="auto", help="浏览器（默认：auto，依次尝试 Chrome、Edge、Playwright Chromium）")
    parser.add_argument("--headful", action="store_true", help="显示浏览器窗口")
    parser.add_argument("--timeout", type=int, default=60, help="超时秒数（默认：60）")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if args.year <= 0 or args.timeout <= 0:
        parser.error("--year 和 --timeout 必须大于 0")
    try:
        items = scrape_covers(args.year, args.month, browser_name=args.browser,
                             headless=not args.headful, timeout_seconds=args.timeout)
        created = write_outputs(items, args.output_dir.expanduser().resolve(),
                                f"miluxing_{args.year}_{args.month:02d}", args.format)
    except Exception as exc:
        print(f"抓取失败：{exc}", file=sys.stderr)
        print("请确认筛选年份有作品；页面加载或验证失败可尝试 --headful。", file=sys.stderr)
        return 1
    print(f"抓取完成：共 {len(items)} 部动漫，只保存名称和封面链接。")
    for path in created:
        print(f"已写入：{path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
