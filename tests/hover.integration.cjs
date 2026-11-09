const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { chromium } = require('playwright');

const row = (title) => `<li class="ipc-metadata-list-summary-item"><a href="/title/tt0111161/"><h3 class="ipc-title__text">1. ${title}</h3></a><span class="cli-title-metadata-item">1994</span></li>`;

test('hover survives delayed rows, replacement, stale replies and worker restart', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'imdb-hover-'));
    const extension = resolve(__dirname, '..');
    const context = await chromium.launchPersistentContext(profile, {
        headless: true,
        channel: 'chromium',
        executablePath: process.env.CHROME_PATH,
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-sandbox'],
    });
    context.setDefaultTimeout(10000);
    try {
        const requests = [];
        const releases = [];
        await context.route('https://www.imdb.com/**', route => route.fulfill({
            contentType: 'text/html',
            body: '<html><body><h1>Top 250</h1><ul></ul></body></html>',
        }));
        await context.route('https://www.justwatch.com/**', async route => {
            requests.push(route.request().url());
            await new Promise(resolve => releases.push(resolve));
            await route.fulfill({ contentType: 'text/html', body: '<html></html>' });
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto('https://www.imdb.com/chart/top/');
        await page.locator('.global-offers-popup').waitFor({ state: 'attached' });
        const spinner = page.locator('div').filter({ has: page.locator('img[src$="loading.svg"]') }).last();
        await page.locator('ul').evaluate((list, html) => list.innerHTML = html, row('The Shawshank Redemption'));
        await page.getByRole('heading', { name: '1. The Shawshank Redemption' }).hover();
        await spinner.waitFor({ state: 'visible' });
        const waitForRequests = async count => {
            const deadline = Date.now() + 10000;
            while (requests.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
            assert.equal(requests.length, count);
        };
        await waitForRequests(1);
        await page.getByRole('heading', { name: 'Top 250', exact: true }).hover();
        await spinner.waitFor({ state: 'hidden' });
        await page.locator('ul').evaluate((list, html) => list.innerHTML = html, row('The Godfather'));
        await page.getByRole('heading', { name: '1. The Godfather', exact: true }).hover();
        await spinner.waitFor({ state: 'visible' });
        await waitForRequests(2);
        const firstReply = context.waitForEvent('console', message => message.text().includes('Sending response to content script'));
        releases.shift()();
        await firstReply;
        assert.equal(await spinner.isVisible(), true);
        releases.shift()();
        await page.getByText('No streaming options available', { exact: true }).waitFor();
        await spinner.waitFor({ state: 'hidden' });
        await page.getByRole('heading', { name: 'Top 250', exact: true }).hover();
        const cdp = await context.newCDPSession(page);
        await cdp.send('ServiceWorker.enable');
        await cdp.send('ServiceWorker.stopAllWorkers');
        await page.getByRole('heading', { name: '1. The Godfather', exact: true }).hover();
        await spinner.waitFor({ state: 'visible' });
        await waitForRequests(3);
        releases.shift()();
        await page.getByText('No streaming options available', { exact: true }).waitFor();
        await page.getByRole('heading', { name: 'Top 250', exact: true }).hover();
        await page.getByRole('heading', { name: '1. The Godfather', exact: true }).hover();
        await waitForRequests(4);
        await page.getByText('Streaming information is unavailable. Hover again to retry.', { exact: true }).waitFor({ timeout: 25000 });
        await spinner.waitFor({ state: 'hidden' });
        releases.shift()();
        assert.deepEqual(errors, []);
    } finally {
        await context.close();
        await rm(profile, { recursive: true, force: true });
    }
});
