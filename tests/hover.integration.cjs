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

test('country selection changes local offers, rejects stale replies and persists across pages', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'imdb-countries-'));
    const extension = resolve(__dirname, '..');
    const context = await chromium.launchPersistentContext(profile, {
        headless: true,
        channel: 'chromium',
        executablePath: process.env.CHROME_PATH,
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-sandbox'],
    });
    context.setDefaultTimeout(10000);
    let releaseFrance;
    let markFranceReady;
    const franceReady = new Promise(resolve => markFranceReady = resolve);
    try {
        const requests = [];
        const errors = [];
        await context.route('https://www.imdb.com/**', route => route.fulfill({
            contentType: 'text/html',
            body: `<html><body><h1>Top 250</h1><ul>${row('The Shawshank Redemption')}</ul></body></html>`
        }));
        const regions = {
            '/us/search': { host: 'www.justwatch.com', provider: 'US provider', price: '$3.99' },
            '/de/Suche': { host: 'www.justwatch.com', provider: 'German provider', price: '3,99 €' },
            '/fr/recherche': { host: 'www.justwatch.com', provider: 'French provider', price: '4,99 €' },
            '/br/busca': { host: 'br.justwatch.com', provider: 'Brazilian provider', price: 'R$ 9,90' },
            '/cz/vyhledání': { host: 'www.justwatch.com', empty: true },
            '/ca/search': { host: 'www.justwatch.com', provider: 'Canadian provider', price: 'CA$ 4.99' }
        };
        await context.route(/^https:\/\/(?:www|br)\.justwatch\.com\//, async route => {
            const url = new URL(route.request().url());
            const path = decodeURIComponent(url.pathname);
            requests.push({ host: url.host, path, query: url.searchParams.get('q') });
            const region = regions[path];
            assert.ok(region, `Unexpected search path: ${path}`);
            assert.equal(url.host, region.host);
            if (path === '/fr/recherche') await new Promise(resolve => {
                releaseFrance = resolve;
                markFranceReady();
            });
            const extraOffers = path === '/de/Suche' ? Array.from({ length: 35 }, (_, index) => `<a class="offer" href="https://example.com/de/${index}"><img alt="German provider ${index}" src="https://example.com/icon.png"><span>${index},00 €</span></a>`).join('') : '';
            const body = region.empty
                ? '<html><div class="search-content"><div class="title-list-options__box-left">0 titulů<span>Popularita</span></div></div></html>'
                : `<html><div class="title-list-row"><section class="buybox__content"><div class="buybox-row rent inline"><div class="buybox-row__offers"><a class="offer" href="https://example.com/${path.split('/')[1]}"><img alt="${region.provider}" src="https://example.com/icon.png"><span>${region.price}</span></a>${extraOffers}</div></div></section></div></html>`;
            await route.fulfill({ contentType: 'text/html', body });
        });
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        await page.goto('https://www.imdb.com/chart/top/');
        await page.locator('.global-offers-popup').waitFor({ state: 'attached' });
        await page.getByRole('heading', { name: '1. The Shawshank Redemption' }).hover();
        const popup = page.locator('.global-offers-popup');
        await popup.getByText('$3.99', { exact: true }).waitFor();
        const country = page.getByRole('combobox', { name: 'Streaming country' });
        assert.equal(await country.inputValue(), 'us');
        assert.ok(await country.locator('option').count() > 100);
        assert.equal(await country.locator('option[value=uk]').textContent(), 'United Kingdom');
        assert.equal(await country.locator('option[value=jp]').textContent(), 'Japan');
        await country.hover();
        await country.selectOption('de');
        await popup.getByText('3,99 €', { exact: true }).waitFor();
        await country.hover();
        const beforeCountryChange = await popup.boundingBox();
        await country.selectOption('fr');
        await franceReady;
        await popup.getByText('Loading streaming options…', { exact: true }).waitFor();
        const duringCountryChange = await popup.boundingBox();
        assert.equal(duringCountryChange.width, beforeCountryChange.width);
        assert.equal(duringCountryChange.y, beforeCountryChange.y);
        assert.equal(await popup.getByText('3,99 €', { exact: true }).count(), 0);
        await country.selectOption('us');
        await popup.getByText('$3.99', { exact: true }).waitFor();
        const staleReply = context.waitForEvent('console', message => message.text().includes('[Request #3] Sending response to content script'));
        releaseFrance();
        releaseFrance = null;
        await staleReply;
        assert.equal(await popup.getByText('4,99 €', { exact: true }).count(), 0);
        assert.equal(await country.inputValue(), 'us');
        await country.selectOption('cz');
        await popup.getByText('No streaming options available', { exact: true }).waitFor();
        assert.equal(await country.isVisible(), true);
        await country.selectOption('br');
        await popup.getByText('R$ 9,90', { exact: true }).waitFor();
        await page.reload();
        await page.locator('.global-offers-popup').waitFor({ state: 'attached' });
        await page.getByRole('heading', { name: '1. The Shawshank Redemption' }).hover();
        await popup.getByText('R$ 9,90', { exact: true }).waitFor();
        assert.equal(await country.inputValue(), 'br');
        const otherPage = await context.newPage();
        await otherPage.goto('https://www.imdb.com/chart/top/');
        await otherPage.locator('.global-offers-popup').waitFor({ state: 'attached' });
        await otherPage.getByRole('heading', { name: '1. The Shawshank Redemption' }).hover();
        await otherPage.getByText('R$ 9,90', { exact: true }).waitFor();
        const otherCountry = otherPage.getByRole('combobox', { name: 'Streaming country' });
        await otherCountry.hover();
        await otherCountry.selectOption('ca');
        await otherPage.getByText('CA$ 4.99', { exact: true }).waitFor();
        assert.equal(await country.inputValue(), 'ca');
        const cdp = await context.newCDPSession(otherPage);
        await cdp.send('ServiceWorker.enable');
        await cdp.send('ServiceWorker.stopAllWorkers');
        await otherPage.getByRole('heading', { name: 'Top 250', exact: true }).hover();
        await otherPage.locator('.global-offers-popup').waitFor({ state: 'hidden' });
        await otherPage.getByRole('heading', { name: '1. The Shawshank Redemption' }).hover();
        await otherPage.getByText('CA$ 4.99', { exact: true }).waitFor();
        assert.equal(requests[0].path, '/us/search');
        assert.equal(requests.at(-1).path, '/ca/search');
        assert.ok(requests.every(request => request.query === 'the shawshank redemption 1994'));
        assert.deepEqual(errors, []);
    } finally {
        if (releaseFrance) releaseFrance();
        await context.close();
        await rm(profile, { recursive: true, force: true });
    }
});

test('live country selection returns local offers across continents', { skip: !process.env.LIVE_JUSTWATCH }, async () => {
    const profile = await mkdtemp(join(tmpdir(), 'imdb-worldwide-'));
    const extension = resolve(__dirname, '..');
    const context = await chromium.launchPersistentContext(profile, {
        headless: true,
        channel: 'chromium',
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
        executablePath: process.env.CHROME_PATH,
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-sandbox'],
    });
    context.setDefaultTimeout(25000);
    const diagnostics = [];
    let page;
    context.on('console', message => {
        if (message.type() === 'error' || message.text().startsWith('[Fetch]')) diagnostics.push(message.text());
    });
    try {
        const requests = [];
        context.on('request', request => {
            if (/https:\/\/(?:www|br)\.justwatch\.com\//.test(request.url())) requests.push(new URL(request.url()));
        });
        await context.route('https://www.imdb.com/**', route => route.fulfill({
            contentType: 'text/html',
            body: `<html><body><h1>Top 250</h1><ul>${row('The Shawshank Redemption')}</ul></body></html>`
        }));
        page = await context.newPage();
        await page.goto('https://www.imdb.com/chart/top/');
        await page.locator('.global-offers-popup').waitFor({ state: 'attached' });
        await page.getByRole('heading', { name: '1. The Shawshank Redemption' }).hover();
        const popup = page.locator('.global-offers-popup');
        const country = page.getByRole('combobox', { name: 'Streaming country' });
        for (const [code, path] of [
            ['us', '/us/search'], ['ca', '/ca/search'], ['uk', '/uk/search'],
            ['de', '/de/Suche'], ['fr', '/fr/recherche'], ['cz', '/cz/vyhledání'],
            ['br', '/br/busca'], ['in', '/in/search'], ['jp', '/jp/検索'],
            ['au', '/au/search'], ['za', '/za/search'], ['ae', '/ae/search']
        ]) {
            if (code !== 'us') {
                await country.hover();
                await country.selectOption(code);
            }
            await popup.locator('a img').first().waitFor({ state: 'visible' });
            assert.equal(await country.inputValue(), code);
            assert.equal(decodeURIComponent(requests.at(-1).pathname), path);
            const offers = await popup.locator('a').evaluateAll(links => links.map(link => ({
                name: link.querySelector('img').alt,
                url: link.href,
                price: link.textContent.trim()
            })));
            assert.ok(offers.length > 0, `${code} has no offers`);
            assert.ok(offers.every(offer => offer.name && offer.price && /^https:\/\//.test(offer.url)));
            if (code === 'br') assert.equal(requests.at(-1).host, 'br.justwatch.com');
            if (process.env.REVIEW_SCREENSHOT && code === 'us') await page.screenshot({ path: process.env.REVIEW_SCREENSHOT });
            console.log(code, JSON.stringify({ offers: offers.length, price: offers[0].price }));
        }
    } catch (error) {
        console.log('Country diagnostics', JSON.stringify(diagnostics));
        if (page) {
            console.log('Popup state', JSON.stringify(await page.locator('.global-offers-popup').evaluate(element => ({
                visible: getComputedStyle(element).display,
                text: element.innerText,
                country: element.querySelector('select').value
            }))));
            await page.screenshot({ path: '/tmp/justwatch-worldwide-failure.png' });
        }
        throw error;
    } finally {
        await context.close();
        await rm(profile, { recursive: true, force: true });
    }
});
