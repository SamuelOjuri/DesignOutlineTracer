import { chromium, expect } from '@playwright/test';

const browser = await chromium.launch();
const baseURL = process.argv[2] ?? process.env.FRONTEND_URL ?? 'http://127.0.0.1:4183';

try {
  for (const mobile of [false, true]) {
    const label = mobile ? 'mobile' : 'desktop';
    const page = await browser.newPage({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1,
    });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== new URL(baseURL).origin || url.pathname.startsWith('/api/')) return route.abort();
      return route.continue();
    });
    await page.goto(`${baseURL}/new-build`);
    await page.evaluate(async () => {
      const { default: React } = await import('/node_modules/.vite/deps/react.js');
      const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
      const { PaintBucketCanvas } = await import('/src/components/newbuild/PaintBucketCanvas.tsx');
      const outlines = [
        [{ x: 40, y: 40 }, { x: 200, y: 40 }, { x: 202, y: 160 }, { x: 200, y: 260 }, { x: 40, y: 260 }],
        [{ x: 280, y: 40 }, { x: 360, y: 40 }, { x: 360, y: 260 }, { x: 280, y: 260 }],
      ];
      const holes = [[{ x: 60, y: 80 }, { x: 90, y: 80 }, { x: 90, y: 110 }, { x: 60, y: 110 }]];
      const source = document.createElement('canvas');
      source.width = 400; source.height = 300;
      const context = source.getContext('2d');
      context.fillStyle = 'white'; context.fillRect(0, 0, 400, 300);
      context.strokeStyle = '#555'; context.lineWidth = 1;
      for (const polygon of [...outlines, ...holes]) {
        context.beginPath(); context.moveTo(polygon[0].x, polygon[0].y);
        for (const point of polygon.slice(1)) context.lineTo(point.x, point.y);
        context.closePath(); context.stroke();
      }
      function Editor() {
        const [currentOutlines, setOutlines] = React.useState(outlines);
        const [currentHoles, setHoles] = React.useState(holes);
        window.adjustmentFixture = { outlines: currentOutlines, holes: currentHoles };
        return React.createElement(PaintBucketCanvas, {
          pdfCanvas: source, roofOutlines: currentOutlines, interiorHoles: currentHoles,
          onOutlinesExtracted: setOutlines, onHolesExtracted: setHoles,
        });
      }
      document.getElementById('root').remove();
      const host = document.createElement('div');
      host.style.height = '100dvh'; host.style.width = '100%';
      document.body.appendChild(host);
      ReactDOM.createRoot(host).render(React.createElement(Editor));
    });
    const adjust = page.getByRole('button', { name: 'Adjust', exact: true });
    await expect(adjust).toBeEnabled();
    await adjust.click();
    const initial = await page.evaluate(() => window.adjustmentFixture);
    const canvas = page.getByTestId('paint-interaction-canvas');
    const source = page.getByTestId('paint-source-canvas');
    const session = mobile ? await page.context().newCDPSession(page) : null;
    const point = async (x, y) => {
      const bounds = await canvas.boundingBox();
      return { x: bounds.x + x * bounds.width / 400, y: bounds.y + y * bounds.height / 300 };
    };
    const pointer = async (phase, x, y) => {
      const position = await point(x, y);
      if (mobile) {
        await session.send('Input.dispatchTouchEvent', {
          type: phase === 'down' ? 'touchStart' : phase === 'move' ? 'touchMove' : 'touchEnd',
          touchPoints: phase === 'up' ? [] : [{ ...position, id: 1 }],
        });
      } else {
        await page.mouse.move(position.x, position.y);
        if (phase === 'down') await page.mouse.down();
        if (phase === 'up') await page.mouse.up();
      }
    };
    const vertexCount = () => page.evaluate(() => window.adjustmentFixture.outlines[0].length);
    await pointer('down', 202, 160);
    const before = await canvas.boundingBox();
    await pointer('move', 200, 40);
    await expect(page.getByRole('status')).toHaveText('Merge vertex');
    expect((await canvas.boundingBox()).y).toBe(before.y);
    expect(await vertexCount()).toBe(5);
    await expect.poll(() => source.evaluate(element => {
      const pixels = element.getContext('2d').getImageData(0, 0, element.width, element.height).data;
      let green = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index + 1] > pixels[index] + 50 && pixels[index + 1] > pixels[index + 2] + 20) green++;
      }
      return green;
    })).toBeGreaterThan(5);
    await page.screenshot({ path: `.vite/adjust-${label}-merge.png`, animations: 'disabled' });
    await pointer('up', 200, 40);
    await expect.poll(vertexCount).toBe(4);
    expect(await page.evaluate(() => window.adjustmentFixture.holes)).toEqual(initial.holes);
    expect(await page.evaluate(() => window.adjustmentFixture.outlines[1])).toEqual(initial.outlines[1]);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    expect(await page.evaluate(() => window.adjustmentFixture)).toEqual(initial);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Straighten', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Straighten', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await pointer('down', 201, 100);
    await pointer('up', 201, 100);
    await expect.poll(() => page.evaluate(() => window.adjustmentFixture.outlines[0][2].x)).toBe(200);
    expect(await vertexCount()).toBe(5);
    const pixels = await source.evaluate(element => {
      const context = element.getContext('2d');
      return { roof: [...context.getImageData(120, 150, 1, 1).data], hole: [...context.getImageData(75, 95, 1, 1).data] };
    });
    expect(pixels.roof[0]).toBeGreaterThan(pixels.roof[1]);
    expect(pixels.hole).toEqual([255, 255, 255, 255]);
    await page.screenshot({ path: `.vite/adjust-${label}-straightened.png`, animations: 'disabled' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const toolbarButtons = await page.getByRole('button').evaluateAll(buttons => buttons.map(button => {
      const bounds = button.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, width: button.clientWidth, content: button.scrollWidth };
    }));
    for (const button of toolbarButtons) {
      expect(button.left).toBeGreaterThanOrEqual(0);
      expect(button.right).toBeLessThanOrEqual(mobile ? 390 : 1440);
      expect(button.content).toBeLessThanOrEqual(button.width);
    }
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    expect(await page.evaluate(() => window.adjustmentFixture)).toEqual(initial);
    await adjust.click();
    for (const reduction of [{ name: 'partial', top: 95 }, { name: 'outside', top: 130 }]) {
      await pointer('down', 120, 40);
      await pointer('move', 120, reduction.top);
      await expect(page.getByRole('status')).not.toContainText('blocked');
      expect(await page.evaluate(() => window.adjustmentFixture)).toEqual(initial);
      await pointer('up', 120, reduction.top);
      await expect.poll(() => page.evaluate(() => window.adjustmentFixture.holes.length)).toBe(0);
      const result = await page.evaluate(() => window.adjustmentFixture);
      expect(result.outlines[1]).toEqual(initial.outlines[1]);
      expect(Math.min(...result.outlines[0].map(vertex => vertex.y))).toBe(reduction.top);
      if (reduction.name === 'partial') {
        expect(result.outlines[0]).toContainEqual({ x: 60, y: 95 });
        expect(result.outlines[0]).toContainEqual({ x: 90, y: 110 });
      }
      const sample = await source.evaluate(element => {
        const context = element.getContext('2d');
        return { excluded: [...context.getImageData(75, 100, 1, 1).data],
          retained: [...context.getImageData(120, 200, 1, 1).data] };
      });
      expect(sample.excluded).toEqual([255, 255, 255, 255]);
      expect(sample.retained[0]).toBeGreaterThan(sample.retained[1]);
      await page.screenshot({ path: `.vite/adjust-${label}-scope-${reduction.name}.png`, animations: 'disabled' });
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      expect(await page.evaluate(() => window.adjustmentFixture)).toEqual(initial);
      await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    }
    expect(errors).toEqual([]);
    console.log(`${label}: merge, straighten, scope reduction past/through cutouts, exact undo, pixels and layout passed`);
    await page.close();
  }
} finally {
  await browser.close();
}