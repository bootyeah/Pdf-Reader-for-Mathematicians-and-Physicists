import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class TestTimePanelUI(unittest.TestCase):
    def test_static_time_panel_markup_and_styles(self):
        index_html = (ROOT / "static/index.html").read_text(encoding="utf-8")
        panel_match = re.search(
            r'<div id="time-panel".*?</div>\s*<button type="button" id="toggle-toolbar-btn"',
            index_html,
            re.S,
        )
        self.assertIsNotNone(panel_match, "#time-panel block must exist in static/index.html")
        panel_html = panel_match.group(0)

        for required_id in (
            'id="time-panel"',
            'id="close-time-btn"',
            'id="current-time-display"',
            'id="countdown-display"',
            'id="countdown-slider"',
            'id="countdown-start-btn"',
            'id="countdown-reset-btn"',
        ):
            self.assertIn(required_id, panel_html)

        self.assertNotIn('id="countdown-min-input"', index_html)
        self.assertNotIn('id="countdown-sec-input"', index_html)
        self.assertNotIn(">当前时间<", panel_html)
        self.assertNotIn(">倒计时<", panel_html)

        style_css = (ROOT / "static/css/style.css").read_text(encoding="utf-8")
        self.assertIn(".countdown-range-slider", style_css)
        self.assertIn("body.eye-protection-mode .countdown-range-slider", style_css)

        tailwind_css = (ROOT / "static/css/tailwind.min.css").read_text(encoding="utf-8")
        for cls in ("text-3xl", "text-xl", "w-\\[272px\\]", "tracking-\\[0\\.04em\\]"):
            self.assertIn(cls, tailwind_css)

    def _find_edge(self) -> Path:
        for candidate in (
            Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
            Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
        ):
            if candidate.exists():
                return candidate
        self.skipTest("Microsoft Edge not found for headless browser verification")

    def test_time_panel_ui_runtime(self):
        edge_path = self._find_edge()
        index_html = (ROOT / "static/index.html").read_text(encoding="utf-8")
        base_tag = f'<base href="{(ROOT / "static").as_uri()}/">'

        test_script = r"""
<script>
window.addEventListener('load', () => {
    setTimeout(() => {
        try {
            function assert(cond, msg) {
                if (!cond) throw new Error(msg);
            }

            const triggerBtn = document.getElementById('time-trigger-btn');
            const panel = document.getElementById('time-panel');
            const currentTimeEl = document.getElementById('current-time-display');
            const countdownEl = document.getElementById('countdown-display');
            const slider = document.getElementById('countdown-slider');
            const startBtn = document.getElementById('countdown-start-btn');
            const resetBtn = document.getElementById('countdown-reset-btn');

            assert(triggerBtn && panel && currentTimeEl && countdownEl && slider && startBtn && resetBtn,
                'Required time panel elements must exist');
            assert(document.getElementById('countdown-min-input') === null,
                '#countdown-min-input must be removed');
            assert(document.getElementById('countdown-sec-input') === null,
                '#countdown-sec-input must be removed');

            // Disable CSS transition before opening so bounding rects reflect settled state immediately
            panel.style.transition = 'none';
            triggerBtn.click();
            void panel.offsetHeight;

            assert(triggerBtn.getAttribute('aria-expanded') === 'true', 'Time panel should expand on trigger click');
            assert(getComputedStyle(panel).visibility === 'visible', 'Time panel must be visible');

            const text = panel.textContent || '';
            assert(!text.includes('当前时间'), 'Panel text must not contain "当前时间"');
            assert(!text.includes('倒计时'), 'Panel text must not contain "倒计时"');
            assert(text.includes('时间'), 'Panel header "时间" must remain');
            assert(startBtn.textContent.trim() === '', 'Start button should be icon-only without text');
            assert(resetBtn.textContent.trim() === '', 'Reset button should be icon-only without text');
            assert(startBtn.querySelector('i.ph-play') !== null, 'Start button should render play icon initially');
            assert(resetBtn.querySelector('i.ph-arrow-counter-clockwise') !== null, 'Reset button should render reset icon');
            assert(startBtn.getAttribute('aria-label') === '开始', 'Start button aria-label should be "开始"');
            assert(resetBtn.getAttribute('aria-label') === '重置', 'Reset button aria-label should be "重置"');

            // Current time enlarged and horizontally centered
            const panelRect = panel.getBoundingClientRect();
            const currentTimeRect = currentTimeEl.getBoundingClientRect();
            const panelCenterX = panelRect.left + panelRect.width / 2;
            const currentTimeCenterX = currentTimeRect.left + currentTimeRect.width / 2;
            assert(Math.abs(currentTimeCenterX - panelCenterX) <= 1.5,
                `Current time must be centered: panelCenter=${panelCenterX}, timeCenter=${currentTimeCenterX}`);

            const currentTimeFontSize = parseFloat(getComputedStyle(currentTimeEl).fontSize);
            const countdownFontSize = parseFloat(getComputedStyle(countdownEl).fontSize);
            assert(currentTimeFontSize === 30, `Current time font-size should be 30px, got ${currentTimeFontSize}`);
            assert(countdownFontSize === 20, `Countdown font-size should be 20px, got ${countdownFontSize}`);
            assert(currentTimeFontSize > countdownFontSize, 'Current time font-size must exceed countdown font-size');

            // Slider geometry and bounds
            assert(slider.type === 'range', 'Countdown slider must be an <input type="range">');
            const sliderRect = slider.getBoundingClientRect();
            assert(sliderRect.width > 0 && sliderRect.height > 0, 'Countdown slider must be visible');
            assert(
                sliderRect.left >= panelRect.left - 0.5 &&
                sliderRect.right <= panelRect.right + 0.5 &&
                sliderRect.top >= panelRect.top - 0.5 &&
                sliderRect.bottom <= panelRect.bottom + 0.5,
                'Countdown slider must stay within #time-panel bounds'
            );

            // Default countdown value
            assert(countdownEl.textContent.trim() === '25:00',
                `Default countdown should be 25:00, got ${countdownEl.textContent}`);

            // Drag / change slider to 45 min
            slider.value = '45';
            slider.dispatchEvent(new Event('input', { bubbles: true }));
            assert(countdownEl.textContent.trim() === '45:00',
                `Countdown after slider=45 should be 45:00, got ${countdownEl.textContent}`);
            const progress45 = slider.style.getPropertyValue('--slider-progress').trim();
            assert(progress45 === '36.97%', `Expected --slider-progress=36.97%, got ${progress45}`);

            // Drag / change slider to 90 min (1h 30m)
            slider.value = '90';
            slider.dispatchEvent(new Event('input', { bubbles: true }));
            assert(countdownEl.textContent.trim() === '01:30:00',
                `Countdown after slider=90 should be 01:30:00, got ${countdownEl.textContent}`);

            // Start / Pause / Reset flow
            startBtn.click();
            assert(startBtn.getAttribute('aria-label') === '暂停' && startBtn.dataset.state === 'running',
                `Expected running/暂停 state, got label=${startBtn.getAttribute('aria-label')} state=${startBtn.dataset.state}`);
            assert(startBtn.querySelector('i.ph-pause') !== null, 'Start button should switch to pause icon when running');
            assert(slider.disabled === true, 'Slider should be disabled while countdown is running');

            startBtn.click();
            assert(startBtn.getAttribute('aria-label') === '继续' && startBtn.dataset.state === 'paused',
                `Expected paused/继续 state, got label=${startBtn.getAttribute('aria-label')} state=${startBtn.dataset.state}`);
            assert(startBtn.querySelector('i.ph-play') !== null, 'Start button should switch back to play icon when paused');
            assert(slider.disabled === false, 'Slider should be re-enabled when paused');

            resetBtn.click();
            assert(startBtn.getAttribute('aria-label') === '开始' && startBtn.dataset.state === 'idle',
                `Expected idle/开始 state after reset, got label=${startBtn.getAttribute('aria-label')} state=${startBtn.dataset.state}`);
            assert(startBtn.querySelector('i.ph-play') !== null, 'Start button should show play icon after reset');
            assert(countdownEl.textContent.trim() === '01:30:00',
                `Countdown after reset should restore to 01:30:00, got ${countdownEl.textContent}`);

            // Eye-protection mode styling check
            document.body.classList.add('eye-protection-mode');
            const eyeBg = getComputedStyle(panel).backgroundColor;
            assert(eyeBg !== 'rgba(0, 0, 0, 0)' && eyeBg !== 'transparent',
                `Eye-protection #time-panel background must not be transparent, got ${eyeBg}`);
            const eyeSliderRect = slider.getBoundingClientRect();
            assert(eyeSliderRect.width > 0 && eyeSliderRect.height > 0,
                'Slider must remain visible in eye-protection mode');
            assert(getComputedStyle(slider).backgroundImage.includes('linear-gradient'),
                'Slider track gradient must remain intact in eye-protection mode');
            document.body.classList.remove('eye-protection-mode');

            document.title = 'TIME_PANEL_UI_OK';
        } catch (err) {
            document.title = 'TIME_PANEL_UI_ERR: ' + (err && err.stack ? err.stack : err);
        }
    }, 100);
});
</script>
"""
        patched_html = index_html.replace("<head>", "<head>" + base_tag, 1).replace("</body>", test_script + "</body>", 1)
        with tempfile.NamedTemporaryFile(suffix=".html", delete=False, mode="w", encoding="utf-8") as f:
            f.write(patched_html)
            temp_path = f.name

        try:
            cmd = [
                str(edge_path),
                "--headless=new",
                "--disable-gpu",
                "--window-size=1440,920",
                "--virtual-time-budget=3000",
                "--dump-dom",
                temp_path,
            ]
            res = subprocess.run(cmd, capture_output=True, timeout=25)
            stdout = res.stdout.decode("utf-8", errors="replace")
            m = re.search(r"<title>(.*?)</title>", stdout, re.S)
            self.assertIsNotNone(m, "Headless browser did not produce a <title>")
            self.assertEqual(m.group(1), "TIME_PANEL_UI_OK")
        finally:
            try:
                os.unlink(temp_path)
            except OSError:
                pass


if __name__ == "__main__":
    unittest.main()
