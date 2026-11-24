"""Run after the frontend build with Python Playwright and Google Chrome installed."""

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
import unittest

from playwright.sync_api import expect, sync_playwright


class StaticAssets(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class DashboardViewportTest(unittest.TestCase):
    def test_desktop_pinch_and_resize(self):
        dist = Path(__file__).resolve().parents[1] / "dist"
        self.assertTrue((dist / "index.html").exists(), "Build the frontend first")
        with ThreadingHTTPServer(
            ("127.0.0.1", 0), partial(StaticAssets, directory=str(dist))
        ) as server:
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with sync_playwright() as pw:
                    browser = pw.chromium.launch(channel="chrome")
                    page = browser.new_page(viewport={"width": 1440, "height": 900})
                    page.route("**/api/**", lambda route: route.fulfill(json=[]))
                    page.goto(f"http://127.0.0.1:{server.server_port}/")
                    expect(page.locator(".directory")).to_be_visible()
                    page.set_viewport_size({"width": 922, "height": 1069})
                    cdp = page.context.new_cdp_session(page)
                    cdp.send("Input.synthesizePinchGesture", {
                        "x": 305, "y": 2, "scaleFactor": 1.1944,
                        "gestureSourceType": "mouse",
                    })
                    page.wait_for_function(
                        "visualViewport.scale > 1.18 && visualViewport.offsetLeft > 10"
                    )
                    self.assert_fits_view(page, ".brand, .help, .mast h1, .mode-switch, .metric, .map-card")
                    page.get_by_role("button", name="CCTV 목록", exact=True).click()
                    expect(page.locator(".directory")).to_be_visible()
                    self.assert_fits_view(page, ".directory, .search-tools, .list-foot")
                    cdp.send("Emulation.setPageScaleFactor", {"pageScaleFactor": 1})
                    page.set_viewport_size({"width": 1440, "height": 900})
                    expect(page.locator(".map-card")).to_be_visible()
                    expect(page.locator(".directory")).to_be_visible()
                    self.assert_fits_view(page, ".brand, .help, .dashboard-grid")
                    browser.close()
            finally:
                server.shutdown()
                thread.join()

    def assert_fits_view(self, page, selector):
        page.wait_for_function(
            """selector => {
                const { offsetLeft, width } = visualViewport
                const elements = [...document.querySelectorAll(selector)]
                return elements.length > 0 && elements.every(e => {
                    const box = e.getBoundingClientRect()
                    return box.width > 0 && box.left >= offsetLeft - 1
                        && box.right <= offsetLeft + width + 1
                })
            }""", arg=selector, timeout=3000,
        )


if __name__ == "__main__":
    unittest.main()
