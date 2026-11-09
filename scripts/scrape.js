import { parse } from "/lib/parse5.min.js";

// Establish connection with background script
let requestCounter = 0;
let activePorts = new Set();

chrome.runtime.onConnect.addListener(function (port) {
    console.log('[Service Worker] ✓ Port connected from content script');
    activePorts.add(port);

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
                const offers = await findOffers(document);

                const requestDuration = performance.now() - requestStart;

                // Summary logging
                const totalOffers = offers.reduce((sum, cat) => sum + cat.offers.length, 0);
                console.log(`\n${'─'.repeat(80)}`);
                console.log(`[Request #${requestId}] ✓ SUCCESS`);
                console.log(`[Request #${requestId}] Total offers found: ${totalOffers}`);
                console.log(`[Request #${requestId}] Duration: ${requestDuration.toFixed(2)}ms`);
                console.log(`[Request #${requestId}] Sending response to content script...`);
                console.log(`${'─'.repeat(80)}\n`);

                port.postMessage({ requestId: msg.requestId, offers: offers });

            } catch (error) {
                const requestDuration = performance.now() - requestStart;

                console.log(`\n${'─'.repeat(80)}`);
                console.error(`[Request #${requestId}] ✗ FAILED`);
                console.error(`[Request #${requestId}] Error: ${error.message}`);
                console.error(`[Request #${requestId}] Stack:`, error.stack);
                console.error(`[Request #${requestId}] Duration: ${requestDuration.toFixed(2)}ms`);
                console.log(`[Request #${requestId}] Sending lookup error response...`);
                console.log(`${'─'.repeat(80)}\n`);

                port.postMessage({
                    requestId: msg.requestId,
                    error: 'Streaming information is unavailable. Hover again to retry.'
                });
            }
        }
    });

    port.onDisconnect.addListener(() => {
        console.log('[Service Worker] ✗ Port disconnected from content script');
        activePorts.delete(port);

        // If no active ports, we can allow service worker to sleep
        if (activePorts.size === 0) {
            console.log('[Service Worker] No active ports remaining');
        }
    });
});

async function fetchDocument(title) {
    const encodedTitle = encodeURIComponent(title.toLowerCase());
    const url = `https://www.justwatch.com/ca/search/?q=${encodedTitle}`;

    console.log(`[Fetch] ${url}`);

    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`JustWatch HTTP ${response.status}`);
    return parse(await response.text());
}

function findOffersInCategory(offersNode, categoryName) {
    if (!offersNode) return [];

    const categoryNode = findTagWithClass(offersNode, `buybox-row ${categoryName} inline`);
    if (!categoryNode) return [];

    const offerNode = findTagWithClass(categoryNode, "buybox-row__offers");
    if (!offerNode) return [];

    const offerLinks = findTags(offerNode, "a");

    let result = [];
    for (const link of offerLinks) {
        if (!link.attrs?.some(attr => attr.name === "class" && attr.value.split(/\s+/).includes("offer"))) continue;
        try {
            const price = getFirstText(link).trim() || "Available";
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
            console.error(`[Scrape] Error parsing ${categoryName} offer:`, error);
        }
    }

    return result;
}

async function findOffers(document) {
    const firstResult = findTagWithClass(document, "title-list-row");
    const offersNode = findTagWithClass(firstResult || document, "buybox__content");
    if (!offersNode) throw new Error('JustWatch offers could not be read');
    return ["stream", "rent", "buy"].map(categoryName => ({
        categoryName,
        offers: findOffersInCategory(offersNode, categoryName)
    }));
}

// Extract offers from a document (movie detail page only)
function findOffersFromDocument(document) {
    const allOfferElements = findAllNodesWithClass(document, "offer");

    if (allOfferElements.length === 0) {
        console.warn('[Scrape] No offers found on movie detail page');
        return [
            { categoryName: "stream", offers: [] },
            { categoryName: "rent", offers: [] },
            { categoryName: "buy", offers: [] }
        ];
    }

    // Parse all offers
    const parsedOffers = [];
    for (const offerElement of allOfferElements) {
        try {
            const offer = parseOfferElement(offerElement);
            if (offer) {
                parsedOffers.push(offer);
            }
        } catch (error) {
            console.error('[Scrape] Error parsing offer:', error);
        }
    }

    console.log(`[Scrape] Extracted ${parsedOffers.length} offers`);

    // Return all offers under "stream" category
    return [
        { categoryName: "stream", offers: parsedOffers },
        { categoryName: "rent", offers: [] },
        { categoryName: "buy", offers: [] }
    ];
}

// Parse a single offer element from the new JustWatch structure
function parseOfferElement(offerElement) {
    const images = findAllTags(offerElement, "img");
    if (images.length === 0) return null;

    const image = images[0];
    const nameAttr = image.attrs?.find(attr => attr.name === "alt");
    const srcAttr = image.attrs?.find(attr => attr.name === "src");

    if (!nameAttr || !srcAttr) return null;

    // Find the price
    const priceNode = findTagWithClass(offerElement, "offer__label__price");
    let price = "Available";
    if (priceNode) {
        const priceText = getFirstText(priceNode);
        if (priceText && priceText.trim()) {
            price = priceText.trim();
        }
    }

    // Find the URL
    const links = findAllTags(offerElement, "a");
    let url = "#";
    for (const link of links) {
        const hrefAttr = link.attrs?.find(attr => attr.name === "href");
        if (hrefAttr && hrefAttr.value) {
            url = hrefAttr.value;
            break;
        }
    }

    return {
        name: nameAttr.value,
        imageSrc: srcAttr.value,
        price: price,
        url: url
    };
}

// Find all nodes with a specific class (not just the first one)
function findAllNodesWithClass(node, className) {
    const results = [];

    function traverse(n) {
        if (!n) return;

        // Check if current node has the class
        if (n.attrs && Array.isArray(n.attrs)) {
            const classAttr = n.attrs.find(attr => attr.name === "class");
            if (classAttr && classAttr.value === className) {
                results.push(n);
            }
        }

        // Recurse into children
        if (n.childNodes && n.childNodes.length > 0) {
            for (const child of n.childNodes) {
                traverse(child);
            }
        }
    }

    traverse(node);
    return results;
}

// Extract the URL of the first search result from a search results page
function extractFirstSearchResultUrl(document) {
    const allLinks = findAllTags(document, "a");

    for (const link of allLinks) {
        const hrefAttr = link.attrs?.find(attr => attr.name === "href");
        if (!hrefAttr) continue;

        const href = hrefAttr.value;

        // Look for links to movie pages (format: /ca/movie/...)
        if (href && (href.includes('/movie/') || href.includes('/tv-show/'))) {
            console.log(`[Scrape] Found movie link: ${href}`);
            return href;
        }
    }

    return null;
}

// Find all tags with a specific tag name (exhaustive search)
function findAllTags(node, tagName) {
    const results = [];

    function traverse(n) {
        if (!n) return;

        if (n.tagName === tagName) {
            results.push(n);
        }

        if (n.childNodes && n.childNodes.length > 0) {
            for (const child of n.childNodes) {
                traverse(child);
            }
        }
    }

    traverse(node);
    return results;
}


function findTagWithClass(node, name) {
    // Handle null/undefined nodes
    if (!node) {
        return null;
    }

    // Check if current node matches
    if (node.attrs && Array.isArray(node.attrs)) {
        const matchingAttr = node.attrs.find(attr =>
            attr.name === "class" && name.split(/\s+/).every(value => attr.value.split(/\s+/).includes(value))
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
