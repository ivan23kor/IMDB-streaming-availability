import { parse, serialize } from "/lib/parse5.min.js";

// Establish connection with background script
let requestCounter = 0;

chrome.runtime.onConnect.addListener(function (port) {
    console.log('[Service Worker] ✓ Port connected from content script');

    port.onMessage.addListener(async function (msg) {
        if (msg.title) {
            const requestId = ++requestCounter;
            const requestStart = performance.now();

            console.log(`\n${'='.repeat(80)}`);
            console.log(`[Request #${requestId}] ⚡ NEW REQUEST`);
            console.log(`[Request #${requestId}] Title: "${msg.title}"`);
            console.log(`[Request #${requestId}] Timestamp: ${new Date().toISOString()}`);
            console.log(`${'='.repeat(80)}\n`);

            try {
                // Fetch document
                const document = await fetchDocument(msg.title);

                // Extract offers
                const offers = findOffers(document);

                const requestDuration = performance.now() - requestStart;

                // Summary logging
                const totalOffers = offers.reduce((sum, cat) => sum + cat.offers.length, 0);
                console.log(`\n${'─'.repeat(80)}`);
                console.log(`[Request #${requestId}] ✓ SUCCESS`);
                console.log(`[Request #${requestId}] Total offers found: ${totalOffers}`);
                console.log(`[Request #${requestId}] Duration: ${requestDuration.toFixed(2)}ms`);
                console.log(`[Request #${requestId}] Sending response to content script...`);
                console.log(`${'─'.repeat(80)}\n`);

                port.postMessage({ offers: offers });

            } catch (error) {
                const requestDuration = performance.now() - requestStart;

                console.log(`\n${'─'.repeat(80)}`);
                console.error(`[Request #${requestId}] ✗ FAILED`);
                console.error(`[Request #${requestId}] Error: ${error.message}`);
                console.error(`[Request #${requestId}] Stack:`, error.stack);
                console.error(`[Request #${requestId}] Duration: ${requestDuration.toFixed(2)}ms`);
                console.log(`[Request #${requestId}] Sending empty offers response...`);
                console.log(`${'─'.repeat(80)}\n`);

                // Send empty offers on error
                port.postMessage({
                    offers: [
                        { categoryName: "stream", offers: [] },
                        { categoryName: "rent", offers: [] },
                        { categoryName: "buy", offers: [] }
                    ]
                });
            }
        }
    });

    port.onDisconnect.addListener(() => {
        console.log('[Service Worker] ✗ Port disconnected from content script');
    });
});

async function fetchDocument(title) {
    const encodedTitle = encodeURIComponent(title.toLowerCase());
    const url = `https://www.justwatch.com/ca/search/?q=${encodedTitle}`;

    console.log(`[Fetch] Starting fetch for: "${title}"`);
    console.log(`[Fetch] URL: ${url}`);

    const fetchStart = performance.now();

    try {
        console.log('[Fetch] Sending request to JustWatch...');
        const response = await fetch(url);

        console.log(`[Fetch] Response received - Status: ${response.status} ${response.statusText}`);
        console.log(`[Fetch] Response headers:`, {
            'content-type': response.headers.get('content-type'),
            'content-length': response.headers.get('content-length'),
            'server': response.headers.get('server')
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const html = await response.text();
        const htmlSize = new Blob([html]).size;
        console.log(`[Fetch] HTML received - Size: ${(htmlSize / 1024).toFixed(2)} KB`);

        const parseStart = performance.now();
        const document = await parse(html);
        const parseDuration = performance.now() - parseStart;

        const fetchDuration = performance.now() - fetchStart;
        console.log(`[Fetch] ✓ Success - Fetch: ${fetchDuration.toFixed(2)}ms, Parse: ${parseDuration.toFixed(2)}ms`);
        console.log(`[Fetch] Using LIVE JustWatch data`);

        return document;
    } catch (error) {
        const fetchDuration = performance.now() - fetchStart;
        console.error(`[Fetch] ✗ Failed after ${fetchDuration.toFixed(2)}ms:`, error.message);
        console.error('[Fetch] Error stack:', error.stack);
        console.warn('[Fetch] Falling back to sample data...');

        // Fallback to sample data if fetch fails
        try {
            const fallbackStart = performance.now();
            const html = await (await fetch('/jw_sample_page.html')).text();
            const document = await parse(html);
            const fallbackDuration = performance.now() - fallbackStart;
            console.log(`[Fetch] ✓ Fallback loaded - Duration: ${fallbackDuration.toFixed(2)}ms`);
            console.log(`[Fetch] Using SAMPLE/FALLBACK data`);
            return document;
        } catch (fallbackError) {
            console.error('[Fetch] ✗ Fallback also failed:', fallbackError);
            throw fallbackError;
        }
    }
}

function findOffersInCategory(offersNode, categoryName) {
    if (!offersNode) {
        console.log(`[Scrape] offersNode is null for category: ${categoryName}`);
        return [];
    }

    const categoryNode = findTagWithClass(offersNode, `buybox-row ${categoryName} inline`);
    if (!categoryNode) {
        console.log(`[Scrape] categoryNode not found for: ${categoryName}`);
        return [];
    }

    const offerNode = findTagWithClass(categoryNode, "buybox-row__offers");
    if (!offerNode) {
        console.log(`[Scrape] offerNode not found for: ${categoryName}`);
        return [];
    }

    const offerLinks = findTags(offerNode, "a");
    console.log(`[Scrape] Found ${offerLinks.length} offer links for: ${categoryName}`);

    let result = [];
    for (const link of offerLinks) {
        try {
            const price = getFirstText(link);
            const url = link.attrs.find(attr => attr.name === "href").value;
            const image = findTags(link, "img")[0];
            const name = image.attrs.find(attr => attr.name === "alt").value
            const imageSrc = image.attrs.find(attr => attr.name === "src").value

            result.push({
                price: price,
                url: url,
                name: name,
                imageSrc: imageSrc || getServiceIcon(name)
            });
        } catch (error) {
            console.error(`[Scrape] Error parsing offer link in ${categoryName}:`, error);
        }
    }

    return result;
}

function findOffers(document) {
    console.log('[Scrape] ━━━ Starting offers extraction ━━━');
    console.log('[Scrape] Analyzing document structure...');

    // Count nodes and collect class names for debugging
    const nodeStats = analyzeDocumentStructure(document);
    console.log(`[Scrape] Document stats: ${nodeStats.totalNodes} total nodes, ${nodeStats.nodesWithClasses} with classes`);
    console.log(`[Scrape] Sample class names found:`, nodeStats.classNames.slice(0, 20));

    // Search for the buybox content
    console.log('[Scrape] Searching for target class: "buybox__content inline"');
    const offersNode = findTagWithClass(document, "buybox__content inline");

    if (!offersNode) {
        console.error('[Scrape] ✗ Could not find "buybox__content inline" node!');
        console.warn('[Scrape] This likely means:');
        console.warn('[Scrape]   1. JustWatch changed their page structure');
        console.warn('[Scrape]   2. The search returned no results (movie not found)');
        console.warn('[Scrape]   3. JustWatch is blocking/rate-limiting requests');

        // Try to find similar classes
        const similarClasses = nodeStats.classNames.filter(c => c.includes('buybox') || c.includes('content'));
        if (similarClasses.length > 0) {
            console.log('[Scrape] Found similar classes that might be relevant:', similarClasses);
        } else {
            console.log('[Scrape] No similar class names found containing "buybox" or "content"');
        }

        return [
            { categoryName: "stream", offers: [] },
            { categoryName: "rent", offers: [] },
            { categoryName: "buy", offers: [] }
        ];
    }

    console.log('[Scrape] ✓ Found buybox__content inline node');
    console.log('[Scrape] Extracting offers from categories...');

    const stream = findOffersInCategory(offersNode, "stream");
    const rent = findOffersInCategory(offersNode, "rent");
    const buy = findOffersInCategory(offersNode, "buy");

    const totalOffers = stream.length + rent.length + buy.length;
    console.log(`[Scrape] ━━━ Extraction complete: ${totalOffers} total offers (stream: ${stream.length}, rent: ${rent.length}, buy: ${buy.length}) ━━━`);

    return [
        { categoryName: "stream", offers: stream },
        { categoryName: "rent", offers: rent },
        { categoryName: "buy", offers: buy }
    ];
};

function analyzeDocumentStructure(node, stats = { totalNodes: 0, nodesWithClasses: 0, classNames: [] }) {
    if (!node) return stats;

    stats.totalNodes++;

    // Collect class names
    if (node.attrs && Array.isArray(node.attrs)) {
        const classAttr = node.attrs.find(attr => attr.name === "class");
        if (classAttr && classAttr.value) {
            stats.nodesWithClasses++;
            if (!stats.classNames.includes(classAttr.value)) {
                stats.classNames.push(classAttr.value);
            }
        }
    }

    // Recurse into children
    if (node.childNodes && node.childNodes.length > 0) {
        for (const child of node.childNodes) {
            analyzeDocumentStructure(child, stats);
        }
    }

    return stats;
}

function findTagWithClass(node, name) {
    // Handle null/undefined nodes
    if (!node) {
        return null;
    }

    // Check if current node matches
    if (node.attrs && Array.isArray(node.attrs)) {
        const matchingAttr = node.attrs.find(attr =>
            attr.name === "class" && attr.value === name
        );
        if (matchingAttr) {
            return node;
        }
    }

    // Base case: no children
    if (!node.childNodes || node.childNodes.length === 0) {
        return null;
    }

    // Recursive case: traverse all children
    for (const childNode of node.childNodes) {
        const classNode = findTagWithClass(childNode, name);
        if (classNode) {
            return classNode;
        }
    }

    return null;
}

// Find all tags with a specific name.
// The search ends when the first tag is found.
// Only tags from the same parent are returned.
function findTags(node, name) {
    // Handle null/undefined nodes
    if (!node) {
        return [];
    }

    // Check if current node matches
    if (node.tagName === name) {
        return [node];
    }

    // Base case: no children
    if (!node.childNodes || node.childNodes.length === 0) {
        return [];
    }

    return node.childNodes.map(childNode => findTags(childNode, name)).flat();
}

function getFirstText(node) {
    // Handle null/undefined nodes
    if (!node) {
        return "";
    }

    if (node.nodeName === "#text") {
        return node.value;
    }

    if (!node.childNodes || node.childNodes.length === 0) {
        return "";
    }

    for (const childNode of node.childNodes) {
        const textNode = getFirstText(childNode);
        if (textNode) {
            return textNode;
        }
    }
    return "";
}

function getServiceIcon(serviceName) {
    const serviceIcons = {
        'netflix': 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDIiIGhlaWdodD0iNDIiIHZpZXdCb3g9IjAgMCA0MiA0MiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjQyIiBoZWlnaHQ9IjQyIiByeD0iNCIgZmlsbD0iI0UxMDkxNSIvPgo8cGF0aCBkPSJNMTAuNSA5SDE0VjMzSDEwLjVWOVoiIGZpbGw9IndoaXRlIi8+CjxwYXRoIGQ9Ik0yOCA5SDMxLjVWMzNIMjhWOVoiIGZpbGw9IndoaXRlIi8+CjxwYXRoIGQ9Ik0xNCA5TDI4IDMzSDI0LjVMMTAuNSA5SDE0WiIgZmlsbD0id2hpdGUiLz4KPC9zdmc+',
        'amazon prime video': 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDIiIGhlaWdodD0iNDIiIHZpZXdCb3g9IjAgMCA0MiA0MiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjQyIiBoZWlnaHQ9IjQyIiByeD0iNCIgZmlsbD0iIzAwQTZGQiIvPgo8cGF0aCBkPSJNMTIgMjRMMjEgMTVMMzAgMjRIMTJaIiBmaWxsPSJ3aGl0ZSIvPgo8L3N2Zz4=',
        'disney+': 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDIiIGhlaWdodD0iNDIiIHZpZXdCb3g9IjAgMCA0MiA0MiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjQyIiBoZWlnaHQ9IjQyIiByeD0iNCIgZmlsbD0iIzExM0FDQyIvPgo8cGF0aCBkPSJNMTAgMThIMzJWMjRIMTBWMThaIiBmaWxsPSJ3aGl0ZSIvPgo8L3N2Zz4=',
        'hulu': 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDIiIGhlaWdodD0iNDIiIHZpZXdCb3g9IjAgMCA0MiA0MiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjQyIiBoZWlnaHQ9IjQyIiByeD0iNCIgZmlsbD0iIzNEQjc5NCIvPgo8cGF0aCBkPSJNMTAgMTBIMzJWMzJIMTBWMTBaIiBmaWxsPSJ3aGl0ZSIvPgo8L3N2Zz4=',
        'hbo max': 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDIiIGhlaWdodD0iNDIiIHZpZXdCb3g9IjAgMCA0MiA0MiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjQyIiBoZWlnaHQ9IjQyIiByeD0iNCIgZmlsbD0iIzc0MUI5NiIvPgo8cGF0aCBkPSJNMTAgMTBIMzJWMzJIMTBWMTBaIiBmaWxsPSJ3aGl0ZSIvPgo8L3N2Zz4=',
        'apple tv+': 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDIiIGhlaWdodD0iNDIiIHZpZXdCb3g9IjAgMCA0MiA0MiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjQyIiBoZWlnaHQ9IjQyIiByeD0iNCIgZmlsbD0iIzAwMDAwMCIvPgo8cGF0aCBkPSJNMTAgMTBIMzJWMzJIMTBWMTBaIiBmaWxsPSJ3aGl0ZSIvPgo8L3N2Zz4='
    };
    
    const normalizedName = serviceName.toLowerCase();
    return serviceIcons[normalizedName] || 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDIiIGhlaWdodD0iNDIiIHZpZXdCb3g9IjAgMCA0MiA0MiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjQyIiBoZWlnaHQ9IjQyIiByeD0iNCIgZmlsbD0iIzY2NjY2NiIvPgo8dGV4dCB4PSIyMSIgeT0iMjUiIGZvbnQtZmFtaWx5PSJBcmlhbCIgZm9udC1zaXplPSIxMiIgZmlsbD0id2hpdGUiIHRleHQtYW5jaG9yPSJtaWRkbGUiPj88L3RleHQ+Cjwvc3ZnPg==';
}
