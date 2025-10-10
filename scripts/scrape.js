import { parse, serialize } from "/lib/parse5.min.js";

// Establish connection with background script
chrome.runtime.onConnect.addListener(function (port) {
    port.onMessage.addListener(async function (msg) {
        if (msg.title) {
            console.log(`[Scrape] Processing request for: "${msg.title}"`);
            try {
                const document = await fetchDocument(msg.title);
                const offers = findOffers(document);
                console.log(`[Scrape] Found offers:`, offers);
                port.postMessage({ offers: offers });
            } catch (error) {
                console.error(`[Scrape] Error processing "${msg.title}":`, error);
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
});

async function fetchDocument(title) {
    const encodedTitle = encodeURIComponent(title.toLowerCase());
    const url = `https://www.justwatch.com/ca/search/?q=${encodedTitle}`;

    console.log(url);

    try {
        const html = await (await fetch(url)).text();
        return await parse(html);
    } catch (error) {
        console.error('Failed to fetch from JustWatch, using sample data:', error);
        // Fallback to sample data if fetch fails
        const html = await (await fetch('/jw_sample_page.html')).text();
        return await parse(html);
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
    console.log('[Scrape] Searching for offers in document');
    const offersNode = findTagWithClass(document, "buybox__content inline");

    if (!offersNode) {
        console.warn('[Scrape] Could not find buybox__content inline node - JustWatch page structure may have changed');
        return [
            { categoryName: "stream", offers: [] },
            { categoryName: "rent", offers: [] },
            { categoryName: "buy", offers: [] }
        ];
    }

    console.log('[Scrape] Found offers node, extracting categories');
    const stream = findOffersInCategory(offersNode, "stream");
    const rent = findOffersInCategory(offersNode, "rent");
    const buy = findOffersInCategory(offersNode, "buy");

    return [
        { categoryName: "stream", offers: stream },
        { categoryName: "rent", offers: rent },
        { categoryName: "buy", offers: buy }
    ];
};

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
