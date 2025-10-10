// Global popup element
let globalPopup = null;
let currentHoveredTitle = null;
let port = null;
let loadingSpinner = null;
let lastCursorPosition = { x: 0, y: 0 };

// Selector configurations for different IMDB page types
const SELECTOR_CONFIGS = [
    {
        // Chart pages (Top 250, Most Popular, etc.) - CHECK THIS FIRST
        name: 'chart',
        container: '.ipc-metadata-list-summary-item',
        title: '.ipc-title__text',
        year: '.cli-title-metadata-item',
        removeNumberPrefix: true
    },
    {
        // Upcoming Releases / Calendar page - div containers with title links
        name: 'upcoming-releases',
        container: 'div.ipc-metadata-list-summary-item__c',
        title: 'a.ipc-metadata-list-summary-item__t',
        year: null, // Year is embedded in title text like "Movie Name (2025)"
        removeNumberPrefix: false
    },
    {
        // Search/Browse results pages
        name: 'search',
        container: '.ipc-metadata-list-summary-item',
        title: '.ipc-title__text',
        year: '.cli-title-metadata-item',
        removeNumberPrefix: false
    },
    {
        // Calendar/Upcoming Releases - list items with links
        name: 'calendar',
        container: 'li.ipc-metadata-list-summary-item',
        title: 'a.ipc-title-link-wrapper',
        year: 'span.ipc-metadata-list-summary-item__li',
        removeNumberPrefix: false
    },
    {
        // Poster cards (recommendations, similar movies on individual pages)
        name: 'poster-card',
        container: '.ipc-poster-card',
        title: '.ipc-title-link-wrapper',
        year: '.ipc-metadata-list-summary-item__li:first-child',
        removeNumberPrefix: false
    },
    {
        // Title list items (various list pages)
        name: 'title-list',
        container: 'li.ipc-title-list-item',
        title: '.ipc-title-link-wrapper',
        year: '.ipc-metadata-list-summary-item__li:first-child',
        removeNumberPrefix: false
    },
    {
        // Generic list items with title links
        name: 'generic-list',
        container: 'li[class*="list"]',
        title: 'a[href*="/title/"]',
        year: 'span',
        removeNumberPrefix: false
    },
    {
        // Legacy structure (older IMDB pages)
        name: 'legacy',
        container: 'td.titleColumn',
        title: 'a',
        year: '.secondaryInfo',
        removeNumberPrefix: false
    }
];

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', afterDOMLoaded);
} else {
    afterDOMLoaded();
}

function connect() {
    return chrome.runtime.connect({ name: "port" });
}

function attachPortListeners() {
    if (!port) return;

    port.onDisconnect.addListener(() => {
        console.log("IMDB W2W: Service worker port disconnected. Reconnecting...");

        // Check if it's a context invalidation (extension reload/update)
        if (chrome.runtime?.id) {
            // Extension context is still valid, safe to reconnect
            try {
                port = connect();
                attachPortListeners();
                console.log("IMDB W2W: Successfully reconnected to service worker");
            } catch (error) {
                console.error("IMDB W2W: Failed to reconnect:", error.message);
                port = null;
            }
        } else {
            // Extension context invalidated - extension was reloaded
            console.warn("IMDB W2W: Extension context invalidated. Page needs refresh.");
            port = null;
        }
    });
}

function afterDOMLoaded() {
    port = connect();
    attachPortListeners();

    // Create the global popup once
    createGlobalPopup();

    // Create loading spinner
    createLoadingSpinner();

    // Try each selector configuration until we find movie elements
    let titles = [];
    let activeConfig = null;

    for (const config of SELECTOR_CONFIGS) {
        const elements = document.querySelectorAll(config.container);
        if (elements.length > 0) {
            console.log(`IMDB W2W: Found ${elements.length} elements using '${config.name}' selector`);
            titles = elements;
            activeConfig = config;
            break;
        }
    }

    if (titles.length === 0) {
        console.log('IMDB W2W: No movie elements found on this page');
        return;
    }

    // Attach event listeners to all found movie title elements
    let attachedCount = 0;
    for (const title of titles) {
        // Store the config on the element for later use
        title._selectorConfig = activeConfig;

        // Quick validation - check if this element actually has a movie link
        const anyLink = title.querySelector('a[href*="/title/"]');
        if (!anyLink) {
            continue;
        }

        title.addEventListener('mouseenter', (event) => {
            lastCursorPosition = { x: event.clientX, y: event.clientY };
            showLoadingSpinner(event);
            showGlobalPopup(title);
        });
        title.addEventListener('mousemove', (event) => {
            lastCursorPosition = { x: event.clientX, y: event.clientY };
            moveLoadingSpinner(event);
        });
        title.addEventListener('mouseleave', (event) => {
            hideLoadingSpinner();
            // Clear current hovered title
            if (currentHoveredTitle === title) {
                currentHoveredTitle = null;
            }

            // Small delay to allow moving to popup or another title
            setTimeout(() => {
                if (!currentHoveredTitle && !isHoveringPopup()) {
                    hideGlobalPopup();
                }
            }, 100);
        });
        attachedCount++;
    }

    console.log(`IMDB W2W: Attached event listeners to ${attachedCount} of ${titles.length} elements`);

    // Hide popup when mouse leaves the page area
    document.addEventListener('mouseleave', () => {
        hideLoadingSpinner();
        hideGlobalPopup();
    });
}

function extractMovieTitle(titleElement) {
    // Get the selector config stored on the element
    const config = titleElement._selectorConfig;
    if (!config) {
        console.error('IMDB W2W: No selector config found on element');
        return null;
    }

    try {
        // Try multiple title selectors as fallbacks
        const titleSelectors = [
            config.title,
            'a.ipc-title-link-wrapper',
            'a[href*="/title/"]',
            '.ipc-title__text',
            'h3',
            'a'
        ];

        let titleNode = null;

        for (const selector of titleSelectors) {
            titleNode = titleElement.querySelector(selector);
            if (titleNode) {
                break;
            }
        }

        if (!titleNode) {
            return null;
        }

        let movieTitle = (titleNode.innerText || titleNode.textContent || '').trim();
        if (!movieTitle) {
            return null;
        }

        // Remove number prefix if configured (e.g., "1. The Shawshank Redemption" -> "The Shawshank Redemption")
        if (config.removeNumberPrefix) {
            movieTitle = movieTitle.replace(/^\d+\.\s+/, '');
        }

        // Remove genre keywords FIRST (before year extraction)
        // Common genres found in IMDB upcoming releases - they appear AFTER the year like "Movie (2025) Action"
        const genrePattern = /\s+(Action|Adventure|Animation|Biography|Comedy|Crime|Documentary|Drama|Family|Fantasy|Film-Noir|History|Horror|Music|Musical|Mystery|Romance|Sci-Fi|Short|Sport|Thriller|War|Western)(\s+\w+)*$/;
        movieTitle = movieTitle.replace(genrePattern, '').trim();

        let year = '';

        // If year selector is null, try to extract year from title text itself
        if (config.year === null) {
            // Extract year from title like "Movie Name (2025)"
            const yearInTitleMatch = movieTitle.match(/\((\d{4})\)$/);
            if (yearInTitleMatch) {
                year = yearInTitleMatch[1];
                // Remove year from title
                movieTitle = movieTitle.replace(/\s*\(\d{4}\)$/, '').trim();
            }
        } else {
            // Try multiple year selectors as fallbacks
            const yearSelectors = [
                config.year,
                '.cli-title-metadata-item',
                '.ipc-metadata-list-summary-item__li:first-child',
                '.secondaryInfo',
                'span.sc-5f7fb5b4-8'
            ];

            for (const selector of yearSelectors) {
                const yearNode = titleElement.querySelector(selector);
                if (yearNode) {
                    year = yearNode.innerText || yearNode.textContent;
                    // Clean year text (remove parentheses, extract just the year)
                    year = year.replace(/[()]/g, '').trim();
                    // Extract 4-digit year if embedded in other text
                    const yearMatch = year.match(/\b(19|20)\d{2}\b/);
                    if (yearMatch) {
                        year = yearMatch[0];
                        break;
                    }
                }
            }
        }

        // Return title with year if available
        return year ? `${movieTitle.trim()} ${year}` : movieTitle.trim();
    } catch (error) {
        console.error('IMDB W2W: Error extracting movie title:', error);
        return null;
    }
}

function createGlobalPopup() {
    globalPopup = document.createElement('div');
    globalPopup.classList.add("global-offers-popup");
    globalPopup.style.fontFamily = "Lato,Lato-fallback,Arial,sans-serif";
    globalPopup.style.fontSize = "14px";
    globalPopup.style.lineHeight = "1.428571429";
    globalPopup.style.color = "#d5d5d5";
    globalPopup.style.boxSizing = "border-box";
    globalPopup.style.display = "none";
    globalPopup.style.flexDirection = "column";
    globalPopup.style.gap = "8px";
    globalPopup.style.border = "1px solid #444";
    globalPopup.style.borderRadius = "8px";
    globalPopup.style.backgroundColor = "rgba(32, 32, 32, 0.95)";
    globalPopup.style.padding = "12px";
    globalPopup.style.backdropFilter = "blur(10px)";
    globalPopup.style.position = "absolute";
    globalPopup.style.zIndex = "1000";
    globalPopup.style.minWidth = "300px";
    globalPopup.style.maxWidth = "600px";
    globalPopup.style.width = "auto";
    globalPopup.style.pointerEvents = "auto"; // Allow interaction with popup
    
    // Add hover events to popup itself
    globalPopup.addEventListener('mouseenter', () => {
        // Keep popup visible when hovering over it
    });
    
    globalPopup.addEventListener('mouseleave', () => {
        // Hide popup when leaving both title and popup
        setTimeout(() => {
            if (!currentHoveredTitle) {
                hideGlobalPopup();
            }
        }, 50);
    });
    
    document.body.appendChild(globalPopup);
}

function createLoadingSpinner() {
    loadingSpinner = document.createElement('div');
    loadingSpinner.style.position = 'fixed';
    loadingSpinner.style.zIndex = '9999';
    loadingSpinner.style.display = 'none';
    loadingSpinner.style.pointerEvents = 'none';

    const spinnerImg = document.createElement('img');
    spinnerImg.src = chrome.runtime.getURL('assets/loading.svg');
    spinnerImg.style.width = '32px';
    spinnerImg.style.height = '32px';
    spinnerImg.style.opacity = '1'; // Full opacity for visibility

    loadingSpinner.appendChild(spinnerImg);
    document.body.appendChild(loadingSpinner);
}

function showLoadingSpinner(event) {
    if (!loadingSpinner) return;
    
    loadingSpinner.style.display = 'block';
    moveLoadingSpinner(event);
}

function moveLoadingSpinner(event) {
    if (!loadingSpinner) return;

    // Position spinner at cursor position (clientX/Y for viewport, no offset)
    loadingSpinner.style.left = event.clientX + 'px';
    loadingSpinner.style.top = event.clientY + 'px';
}

function hideLoadingSpinner() {
    if (loadingSpinner) {
        loadingSpinner.style.display = 'none';
    }
}

function showGlobalPopup(title) {
    currentHoveredTitle = title;

    // Position popup at cursor with bottom-left corner at cursor position
    const scrollX = window.scrollX || document.documentElement.scrollLeft;
    const scrollY = window.scrollY || document.documentElement.scrollTop;

    // Initial position at cursor (will adjust after content loads)
    const initialLeft = lastCursorPosition.x + scrollX;
    const initialTop = lastCursorPosition.y + scrollY;

    globalPopup.style.left = initialLeft + 'px';
    globalPopup.style.top = initialTop + 'px';

    // Keep popup hidden until content is loaded
    globalPopup.style.display = "none";

    // Store positioning info for later adjustment
    globalPopup._positionInfo = {
        cursorX: lastCursorPosition.x,
        cursorY: lastCursorPosition.y,
        scrollX,
        scrollY
    };
    
    // Clear popup content while waiting for data
    globalPopup.innerHTML = '';
    
    // Extract movie title under hover
    const movieTitle = extractMovieTitle(title);

    // If title extraction failed, abort
    if (!movieTitle) {
        console.warn('IMDB W2W: Title extraction failed for element:', title);
        hideLoadingSpinner();
        return;
    }

    console.log('IMDB W2W: Extracted title:', movieTitle, '- sending to background script');

    // Send a request to background script for this movie title
    try {
        // Check if port is still connected before sending
        if (!port) {
            console.log('IMDB W2W: Port not connected, reconnecting...');

            // Check if extension context is valid
            if (!chrome.runtime?.id) {
                console.error('IMDB W2W: Extension context invalidated. Cannot reconnect.');
                hideLoadingSpinner();
                globalPopup.innerHTML = '<div style="color: #ff6b6b; padding: 10px;">Extension needs reload - refresh page</div>';
                globalPopup.style.display = "flex";
                return;
            }

            port = chrome.runtime.connect({ name: "port" });
            attachPortListeners();
        }

        port.postMessage({ title: movieTitle });
    } catch (error) {
        console.error('IMDB W2W: Failed to send message:', error.message);

        // Check for context invalidation
        if (!chrome.runtime?.id) {
            console.error('IMDB W2W: Extension context invalidated.');
            hideLoadingSpinner();
            globalPopup.innerHTML = '<div style="color: #ff6b6b; padding: 10px;">Extension needs reload - refresh page</div>';
            globalPopup.style.display = "flex";
            return;
        }

        // Try to reconnect and send again
        try {
            console.log('IMDB W2W: Attempting reconnect...');
            port = chrome.runtime.connect({ name: "port" });
            attachPortListeners();
            port.postMessage({ title: movieTitle });
        } catch (retryError) {
            console.error('IMDB W2W: Failed to reconnect:', retryError.message);
            hideLoadingSpinner();
            return;
        }
    }

    // Create streaming icons based on received data from background script
    const handleMessage = function (msg) {
        if (currentHoveredTitle === title) {
            hideLoadingSpinner(); // Hide the cursor-following spinner
            updateGlobalPopupContent(msg.offers);
            // Show popup only after content is loaded
            globalPopup.style.display = "flex";
            // Adjust position after showing popup
            adjustPopupPosition();
        }
        // Remove the event listener after handling the message
        port.onMessage.removeListener(handleMessage);
    };
    port.onMessage.addListener(handleMessage);
}

function hideGlobalPopup() {
    currentHoveredTitle = null;
    if (globalPopup) {
        globalPopup.style.display = "none";
        globalPopup.innerHTML = "";
    }
    hideLoadingSpinner();
}

function updateGlobalPopupContent(offers) {
    if (!globalPopup) return;
    
    globalPopup.innerHTML = "";
    
    // Check if there are any offers to display
    let hasOffers = false;
    for (const offer of offers) {
        if (offer.offers && offer.offers.length > 0) {
            hasOffers = true;
            break;
        }
    }
    
    // Only show popup if there are offers
    if (hasOffers) {
        for (const offer of offers) {
            const categoryName = offer.categoryName;
            const categoryOffers = offer.offers;
            const category = createCategoryNode(categoryName, categoryOffers);
            if (category) {
                globalPopup.appendChild(category);
            }
        }
        
        // Adjust position after content is loaded
        adjustPopupPosition();
    } else {
        // Show a message when no offers are available
        globalPopup.innerHTML = '<div style="color: #999; font-style: italic; padding: 10px;">No streaming options available</div>';
        adjustPopupPosition();
    }
}

function adjustPopupPosition() {
    if (!globalPopup || !globalPopup._positionInfo) return;

    const { cursorX, cursorY, scrollX, scrollY } = globalPopup._positionInfo;
    const popupRect = globalPopup.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;

    // Position popup with bottom-left corner at cursor
    let newLeft = cursorX + scrollX;
    let newTop = cursorY + scrollY - popupRect.height;

    // Handle edge cases:
    // 1. If popup would go above viewport top, align top at cursor instead
    if (cursorY - popupRect.height < 0) {
        newTop = cursorY + scrollY;
    }

    // 2. If popup would go below viewport bottom, align bottom at viewport bottom
    const popupBottomY = newTop - scrollY + popupRect.height;
    if (popupBottomY > viewportHeight) {
        newTop = scrollY + viewportHeight - popupRect.height - 10;
    }

    // 3. If popup would go beyond right edge, shift left
    const popupRightX = newLeft - scrollX + popupRect.width;
    if (popupRightX > viewportWidth) {
        newLeft = scrollX + viewportWidth - popupRect.width - 10;
    }

    // 4. Ensure popup doesn't go beyond left edge
    if (newLeft < scrollX + 10) {
        newLeft = scrollX + 10;
    }

    globalPopup.style.left = newLeft + 'px';
    globalPopup.style.top = newTop + 'px';
}

function isHoveringPopup() {
    return globalPopup && globalPopup.matches(':hover');
}

// Remove this function as we're using a global popup now

// Remove this function as we're using updateGlobalPopupContent now


function createCategoryNode(categoryName, offers) {
    if (!offers || offers.length === 0) return null;
    
    const categoryContainer = document.createElement('div');
    categoryContainer.style.marginBottom = "8px";

    const categoryNode = createCategoryLabelNode(categoryName);
    categoryContainer.appendChild(categoryNode);

    const offersNode = createOffersNode(offers);
    categoryContainer.appendChild(offersNode);

    return categoryContainer;
}

function createCategoryLabelNode(categoryName) {
    const label = document.createElement('label');
    label.textContent = categoryName;
    label.style.margin = "0";
    label.style.fontSize = "14px";
    label.style.fontWeight = "400";
    label.style.lineHeight = "100%";
    label.style.letterSpacing = ".24px";
    label.style.textTransform = "uppercase";
    label.style.flexShrink = "0";
    label.style.display = "flex";
    label.style.alignItems = "center";
    label.style.justifyContent = "center";
    label.style.transform = "none";
    label.style.writingMode = "unset";
    label.style.minHeight = "min-content";
    label.style.width = "100%";
    label.style.padding = "4px 16px";
    label.style.height = "min-content";
    label.style.color = "#797a7b";
    label.style.background = "#e6e6e6";
    label.style.boxSizing = "border-box";
    return label;
}

function createOffersNode(offers) {
    const offersContainer = document.createElement('div');
    offersContainer.style.fontFamily = "Lato,Lato-fallback,Arial,sans-serif";
    offersContainer.style.fontSize = "12px";
    offersContainer.style.lineHeight = "1.2";
    offersContainer.style.color = "#d5d5d5";
    offersContainer.style.paddingTop = "8px";
    offersContainer.style.display = "flex";
    offersContainer.style.gap = "8px";
    offersContainer.style.overflowX = "auto";
    offersContainer.style.boxSizing = "border-box";
    offersContainer.style.flexWrap = "wrap";
    for (const offer of offers) {
        const offerNode = createOfferNode(offer);
        offersContainer.appendChild(offerNode);
    }
    return offersContainer;
}

function createOfferNode(offer) {
    const offerContainer = document.createElement('a');
    offerContainer.href = offer.url;
    offerContainer.style.textDecoration = "none";
    offerContainer.style.display = "flex";
    offerContainer.style.flexDirection = "column";
    offerContainer.style.alignItems = "center";
    offerContainer.style.gap = "4px";
    offerContainer.style.padding = "4px";
    offerContainer.style.borderRadius = "4px";
    offerContainer.style.transition = "background-color 0.2s";
    offerContainer.addEventListener('mouseenter', () => {
        offerContainer.style.backgroundColor = "rgba(255, 255, 255, 0.1)";
    });
    offerContainer.addEventListener('mouseleave', () => {
        offerContainer.style.backgroundColor = "transparent";
    });

    const icon = createOfferIcon(offer);
    offerContainer.appendChild(icon);

    const price = createPriceNode(offer);
    offerContainer.appendChild(price);
    return offerContainer;
}


function createOfferIcon(offer) {
    // Create an icon for the offer
    const icon = document.createElement("img");
    icon.src = offer.imageSrc;
    icon.title = offer.name;
    icon.alt = offer.name;
    icon.style.height = icon.style.width = "32px";
    icon.style.borderRadius = "4px";
    return icon;
}

function createPriceNode(offer) {
    const priceNode = document.createElement('div');
    priceNode.innerText = offer.price;
    priceNode.style.fontFamily = "Lato,Lato-fallback,Arial,sans-serif";
    priceNode.style.lineHeight = "1.428571429";
    priceNode.style.cursor = "pointer";
    priceNode.style.boxSizing = "border-box";
    priceNode.style.display = "flex";
    priceNode.style.alignItems = "center";
    priceNode.style.margin = "0";
    priceNode.style.textAlign = "center";
    priceNode.style.fontSize = "13px";
    priceNode.style.textDecoration = "none";
    priceNode.style.color = "#d5d5d5";
    priceNode.style.whiteSpace = "nowrap";
    return priceNode;
}