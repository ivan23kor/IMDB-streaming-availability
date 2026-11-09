const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, readFile } = require('node:fs/promises');
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
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
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
            await route.fulfill({ contentType: 'text/html', body: await readFile(join(__dirname, 'fixtures/justwatch-shawshank.html'), 'utf8') });
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
        await page.locator('.global-offers-popup img[alt="Amazon Prime Video"]').waitFor({ state: 'visible' });
        await spinner.waitFor({ state: 'hidden' });
        await page.getByRole('heading', { name: 'Top 250', exact: true }).hover();
        const cdp = await context.newCDPSession(page);
        await cdp.send('ServiceWorker.enable');
        await cdp.send('ServiceWorker.stopAllWorkers');
        await page.getByRole('heading', { name: '1. The Godfather', exact: true }).hover();
        await spinner.waitFor({ state: 'visible' });
        await waitForRequests(3);
        releases.shift()();
        await page.locator('.global-offers-popup img[alt="Amazon Prime Video"]').waitFor({ state: 'visible' });
        await page.getByRole('heading', { name: 'Top 250', exact: true }).hover();
        await page.getByRole('heading', { name: '1. The Godfather', exact: true }).hover();
        await waitForRequests(4);
        await page.getByText('Streaming information is unavailable. Hover again to retry.', { exact: true }).waitFor({ timeout: 25000 });
        await spinner.waitFor({ state: 'hidden' });
        releases.shift()();
        for (const response of [
            { status: 503, body: '<html>Unavailable</html>', expected: 'Streaming information is unavailable. Hover again to retry.' },
            { status: 200, body: '<html><div class="search-content"><div class="title-list-options__box-left"><div>0 titles</div><span>Popularity</span></div></div></html>', expected: 'No streaming options available' },
            { status: 200, body: '<html>Changed page structure</html>', expected: 'Streaming information is unavailable. Hover again to retry.' },
            { status: 200, body: '<html><section class="inline buybox__content"></section></html>', expected: 'No streaming options available' },
            { status: 200, body: '<html><div class="title-list-row"><section class="inline buybox__content"><div class="rent inline buybox-row extra"><div class="buybox-row__offers"><a class="offer" href="https://example.com/rent"><img alt="Rental provider" src="https://example.com/icon.png"><span>CA$ 4.99</span></a></div></div></section></div></html>', expected: 'CA$ 4.99' }
        ]) {
            await context.unroute('https://www.justwatch.com/**');
            await context.route('https://www.justwatch.com/**', route => route.fulfill({ status: response.status, contentType: 'text/html', body: response.body }));
            await page.getByRole('heading', { name: 'Top 250', exact: true }).hover();
            await page.getByRole('heading', { name: '1. The Godfather', exact: true }).hover();
            await page.getByText(response.expected, { exact: true }).waitFor();
        }
        assert.deepEqual(errors, []);
    } finally {
        await context.close();
        await rm(profile, { recursive: true, force: true });
    }
});

test('real JustWatch lookups return providers, prices and links', { skip: !process.env.LIVE_JUSTWATCH }, async () => {
    const profile = await mkdtemp(join(tmpdir(), 'imdb-live-'));
    const extension = resolve(__dirname, '..');
    const context = await chromium.launchPersistentContext(profile, {
        headless: true,
        channel: 'chromium',
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
        executablePath: process.env.CHROME_PATH,
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-sandbox'],
    });
    context.setDefaultTimeout(25000);
    try {
        await context.route('https://www.imdb.com/**', route => route.fulfill({
            contentType: 'text/html',
            body: '<html><body><h1>Top 250</h1><ul></ul></body></html>',
        }));
        const page = await context.newPage();
        await page.goto('https://www.imdb.com/chart/top/');
        await page.locator('.global-offers-popup').waitFor({ state: 'attached' });
        for (const [title, year] of [['The Shawshank Redemption', '1994'], ['The Godfather', '1972'], ['The Dark Knight', '2008'], ['American History X', '1998']]) {
            await page.mouse.move(0, 0);
            await page.locator('ul').evaluate((list, html) => list.innerHTML = html, row(title).replace('1994', year));
            await page.getByRole('heading', { name: new RegExp(title) }).first().hover();
            const popup = page.locator('.global-offers-popup');
            await popup.locator('a img').first().waitFor({ state: 'visible' });
            const offers = await popup.locator('a').evaluateAll(links => links.map(link => ({
                name: link.querySelector('img').alt,
                url: link.href,
                price: link.textContent.trim()
            })));
            if (process.env.REVIEW_SCREENSHOT) await page.screenshot({ path: process.env.REVIEW_SCREENSHOT });
            assert.ok(offers.length > 0);
            assert.ok(offers.every(offer => offer.name !== 'JustWatch'));
            assert.ok(offers.every(offer => offer.name && offer.price && /^https:\/\//.test(offer.url)));
            console.log(title, JSON.stringify(offers.map(({ name, price }) => ({ name, price }))));
        }
    } finally {
        await context.close();
        await rm(profile, { recursive: true, force: true });
    }
});

test('current IMDb rows use the title and year while empty links are ignored', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'imdb-targets-'));
    const extension = resolve(__dirname, '..');
    const context = await chromium.launchPersistentContext(profile, {
        headless: true,
        channel: 'chromium',
        executablePath: process.env.CHROME_PATH,
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-sandbox'],
    });
    context.setDefaultTimeout(10000);
    try {
        const warnings = [];
        const requests = [];
        context.on('console', message => {
            if (['error', 'warning'].includes(message.type()) && /Just Watch IMDB/.test(message.text())) warnings.push(message.text());
        });
        const chartRow = await readFile(join(__dirname, 'fixtures/imdb-chart-row.html'), 'utf8');
        const offers = await readFile(join(__dirname, 'fixtures/justwatch-shawshank.html'), 'utf8');
        await context.route('https://www.imdb.com/**', route => route.fulfill({
            contentType: 'text/html',
            body: `<html><body><h1>Top 250</h1><div><div><div id="blank-poster"><a href="/title/tt1234567/" style="display:block;width:60px;height:40px"><span></span></a></div></div></div><ul><li id="blank-row" class="ipc-metadata-list-summary-item"><a href="/title/tt1234568/" style="display:block;width:60px;height:40px"><h3 class="ipc-title__text"></h3></a><a href="/name/nm123/">Unrelated actor</a></li>${chartRow}</ul><div class="ipc-poster-card"><a class="ipc-title-link-wrapper" href="/title/tt1234569/"></a><a class="ipc-title-link-wrapper" href="/title/tt1234569/">American History X</a></div></body></html>`
        }));
        await context.route('https://www.justwatch.com/**', route => {
            requests.push(new URL(route.request().url()).searchParams.get('q'));
            return route.fulfill({ contentType: 'text/html', body: offers });
        });
        const page = await context.newPage();
        await page.goto('https://www.imdb.com/chart/top/');
        await page.locator('.global-offers-popup').waitFor({ state: 'attached' });
        for (const selector of ['#blank-poster a', '#blank-row a[href*="/title/"]']) {
            await page.locator(selector).hover();
            assert.equal(await page.locator('img[src$="loading.svg"]').isVisible(), false);
            assert.deepEqual(requests, []);
        }
        await page.getByRole('heading', { name: 'The Shawshank Redemption', exact: true }).hover();
        await page.locator('.global-offers-popup img[alt="Amazon Prime Video"]').waitFor({ state: 'visible' });
        assert.deepEqual(requests, ['the shawshank redemption 1994']);
        await page.getByRole('heading', { name: 'Top 250', exact: true }).hover();
        await page.getByRole('link', { name: 'American History X', exact: true }).hover();
        await page.locator('.global-offers-popup img[alt="Amazon Prime Video"]').waitFor({ state: 'visible' });
        assert.deepEqual(requests, ['the shawshank redemption 1994', 'american history x']);
        assert.deepEqual(warnings, []);
    } finally {
        await context.close();
        await rm(profile, { recursive: true, force: true });
    }
});
