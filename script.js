// Configuration
const CONFIG = {
    minZoomForGrids: 4,
    pointZoomThreshold: 7, // Show as points below this zoom level
    labelZoomThreshold: 8, // NEW: Show labels only at this zoom level and above
    maxGridsToRender: 10000,
    maxPointsToRender: 50000, // Can show more points than polygons
    geojsonPath: 'data/sentinel-2_grids.geojson',
    noCoverageAreaPath: 'data/sentinel-2_no_coverage.geojson', // Areas WITHOUT S2 coverage
    mapOptions: {
        center: [-25, 135], // Centre of Australia
        zoom: 5, // Zoom level to show most of Australia
        maxZoom: 18,
        minZoom: 4,
        worldCopyJump: true, // Enable world wrapping
        maxBounds: [[-90, -Infinity], [90, Infinity]] // Allow infinite horizontal scrolling
    }
};

// Global variables
let map = null;
let gridLayer = null;
let labelLayer = null;
let noCoverageLayer = null; // Layer for areas WITHOUT S2 coverage
let gridData = null;
let noCoverageData = null; // No coverage area data
let labelPositions = []; // Track label positions for collision detection
let searchIndex = []; // Search index for grid names
let highlightLayer = null; // Layer for highlighting searched grids
let currentBaseLayer = 'satellite'; // Track current base layer

// Initialise map
function initMap() {
    map = L.map('map', CONFIG.mapOptions);

    // Add base layers
    const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 19
    });

    const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
        maxZoom: 19
    });

    // Set default layer to satellite
    satelliteLayer.addTo(map);

    // Layer control with coverage area
    const baseLayers = {
        'OpenStreetMap': osmLayer,
        'Satellite': satelliteLayer
    };

    // Create layer control without overlay layers initially
    const layerControl = L.control.layers(baseLayers).addTo(map);

    // Store reference to layer control for later use
    map.layerControl = layerControl;

    // Add event listeners for base layer changes
    map.on('baselayerchange', function (e) {
        currentBaseLayer = e.name.toLowerCase();
        updateNoCoverageStyle();
    });

    // Add event listeners
    map.on('zoomend moveend', updateGridDisplay);
    map.on('zoomstart', hideZoomInfo);

    // Load grid data and no-coverage areas
    loadGridData();
    loadNoCoverageArea();
}

// Load GeoJSON data
async function loadGridData() {
    try {
        const response = await fetch(CONFIG.geojsonPath);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        gridData = await response.json();
        console.log(`Loaded ${gridData.features.length} grid features`);

        // Debug: log first feature to understand structure
        if (gridData.features.length > 0) {
            console.log('Sample feature:', gridData.features[0]);
            console.log('Sample geometry:', gridData.features[0].geometry);
            console.log('Sample properties:', gridData.features[0].properties);
        }

        // Initial grid display
        updateGridDisplay();

        // Build search index
        buildSearchIndex();

        // Setup search functionality
        setupSearch();

        // Hide loading indicator
        hideLoading();

    } catch (error) {
        console.error('Error loading grid data:', error);
        showError('Failed to load Sentinel-2 grid data. Please check the file path.');
    }
}

// Update grid display based on zoom and bounds
function updateGridDisplay() {
    const zoom = map.getZoom();

    if (zoom < CONFIG.minZoomForGrids) {
        clearGrids();
        showZoomInfo();
        return;
    }

    hideZoomInfo();

    if (!gridData) return;

    const bounds = map.getBounds();
    console.log('Current map bounds:', bounds.toString(), 'Zoom:', zoom);

    const visibleGrids = getVisibleGrids(bounds);
    console.log(`Found ${visibleGrids.length} visible grids out of ${gridData.features.length} total`);

    // Determine rendering mode based on zoom level
    const showAsPoints = zoom < CONFIG.pointZoomThreshold;
    const maxToRender = showAsPoints ? CONFIG.maxPointsToRender : CONFIG.maxGridsToRender;

    if (visibleGrids.length > maxToRender) {
        console.warn(`Too many grids to render: ${visibleGrids.length}. Limiting to ${maxToRender}`);
        visibleGrids.splice(maxToRender);
    }

    if (showAsPoints) {
        renderGridsAsPoints(visibleGrids);
    } else {
        renderGridsAsPolygons(visibleGrids);
    }

    // Ensure no-coverage layer stays on top after grid updates
    if (noCoverageLayer && map.hasLayer(noCoverageLayer)) {
        noCoverageLayer.bringToFront();
    }
}

// Get grids within current map bounds (with world wrapping)
function getVisibleGrids(bounds) {
    const visibleGrids = [];

    // Get the wrapped bounds to handle world repetition
    const wrappedBounds = getWrappedBounds(bounds);

    gridData.features.forEach(feature => {
        if (!feature.geometry || !feature.geometry.coordinates) return;

        const geometry = feature.geometry;
        let isVisible = false;

        // Check visibility against each wrapped bounds
        wrappedBounds.forEach(wrappedBound => {
            if (isVisible) return; // Already found visible

            if (geometry.type === 'Polygon') {
                isVisible = isPolygonIntersectingBounds(geometry.coordinates[0], wrappedBound);
            } else if (geometry.type === 'MultiPolygon') {
                isVisible = geometry.coordinates.some(polygon =>
                    isPolygonIntersectingBounds(polygon[0], wrappedBound)
                );
            }
        });

        if (isVisible) {
            visibleGrids.push(feature);
        }
    });

    return visibleGrids;
}

// Get wrapped bounds for world repetition
function getWrappedBounds(bounds) {
    const wrappedBounds = [bounds];

    const west = bounds.getWest();
    const east = bounds.getEast();
    const north = bounds.getNorth();
    const south = bounds.getSouth();

    // If the view spans across the 180/-180 meridian, create additional bounds
    if (west > east) {
        // Split into two bounds
        wrappedBounds.push(
            L.latLngBounds([[south, west], [north, 180]]),
            L.latLngBounds([[south, -180], [north, east]])
        );
    }

    // Add repeated world bounds for continuous panning
    const worldWidth = 360;
    const viewWidth = east - west;

    // Add bounds for worlds to the left and right
    for (let offset = -worldWidth; offset <= worldWidth; offset += worldWidth) {
        if (offset === 0) continue; // Skip the original world

        const offsetWest = west + offset;
        const offsetEast = east + offset;

        wrappedBounds.push(
            L.latLngBounds([[south, offsetWest], [north, offsetEast]])
        );
    }

    return wrappedBounds;
}

// Check if polygon intersects with map bounds
function isPolygonIntersectingBounds(coords, bounds) {
    if (!coords || coords.length === 0) return false;

    // Get polygon bounding box
    let minLat = Infinity, maxLat = -Infinity;
    let minLng = Infinity, maxLng = -Infinity;

    coords.forEach(coord => {
        const lng = coord[0];
        const lat = coord[1];
        minLat = Math.min(minLat, lat);
        maxLat = Math.max(maxLat, lat);
        minLng = Math.min(minLng, lng);
        maxLng = Math.max(maxLng, lng);
    });

    // Check if polygon bounding box intersects with map bounds
    const mapSouth = bounds.getSouth();
    const mapNorth = bounds.getNorth();
    const mapWest = bounds.getWest();
    const mapEast = bounds.getEast();

    // Handle longitude wrapping around 180/-180
    const lngIntersects = (maxLng >= mapWest && minLng <= mapEast) ||
        (mapWest > mapEast && (maxLng >= mapWest || minLng <= mapEast));

    const latIntersects = maxLat >= mapSouth && minLat <= mapNorth;

    return lngIntersects && latIntersects;
}

// Render grids as polygons (high zoom)
function renderGridsAsPolygons(grids) {
    clearGrids();

    if (grids.length === 0) return;

    // Reset label collision tracking
    labelPositions = [];

    gridLayer = L.geoJSON(grids, {
        style: function (feature) {
            const name = getGridName(feature);
            const color = getGridColor(name);
            return {
                color: color,
                weight: 2,
                opacity: 0.8,
                fillOpacity: 0.1,
                fillColor: color
            };
        }
    }).addTo(map);

    // Only add labels if zoom level is high enough
    const currentZoom = map.getZoom();
    if (currentZoom >= CONFIG.labelZoomThreshold) {
        addPolygonLabels(grids);
    }

    console.log(`Rendered ${grids.length} grids as polygons${currentZoom >= CONFIG.labelZoomThreshold ? ' with labels' : ''}`);
}

// Replace the existing addPolygonLabels function with this updated version:

function addPolygonLabels(grids) {
    const labels = [];

    grids.forEach(feature => {
        const centroid = getPolygonCentroid(feature.geometry);
        if (!centroid) return;

        const name = getGridName(feature);
        const labelPosition = findNonOverlappingPosition(centroid, name);

        if (labelPosition) {
            const label = L.marker([labelPosition.lat, labelPosition.lng], {
                icon: L.divIcon({
                    className: 'grid-label',
                    html: `<span class="selectable-label">${name}</span>`,
                    iconSize: [null, null],
                    iconAnchor: [0, 0]
                }),
                interactive: true
            });

            // Get the actual DOM element after the marker is created
            label.on('add', function () {
                const labelElement = label.getElement();
                if (labelElement) {
                    const spanElement = labelElement.querySelector('.selectable-label');

                    // Stop all map events from propagating through the label
                    L.DomEvent.disableClickPropagation(labelElement);
                    L.DomEvent.disableScrollPropagation(labelElement);

                    // Prevent double-click zoom and handle text selection properly
                    labelElement.addEventListener('dblclick', function (e) {
                        L.DomEvent.stopPropagation(e);
                        L.DomEvent.preventDefault(e);

                        // Clear any existing selections first
                        if (window.getSelection) {
                            window.getSelection().removeAllRanges();
                        }

                        // Select only this label's text
                        if (spanElement && window.getSelection) {
                            const range = document.createRange();
                            range.selectNodeContents(spanElement);
                            const selection = window.getSelection();
                            selection.removeAllRanges();
                            selection.addRange(range);
                        }
                    });

                    // Handle single click to select text
                    labelElement.addEventListener('click', function (e) {
                        L.DomEvent.stopPropagation(e);

                        // Clear any existing selections
                        if (window.getSelection) {
                            window.getSelection().removeAllRanges();
                        }

                        // Select this label's text
                        if (spanElement && window.getSelection) {
                            const range = document.createRange();
                            range.selectNodeContents(spanElement);
                            const selection = window.getSelection();
                            selection.addRange(range);
                        }
                    });

                    // Prevent map panning when selecting text
                    labelElement.addEventListener('mousedown', function (e) {
                        L.DomEvent.stopPropagation(e);
                    });

                    labelElement.addEventListener('touchstart', function (e) {
                        L.DomEvent.stopPropagation(e);
                    });

                    // Prevent text selection from extending beyond this label
                    labelElement.addEventListener('selectstart', function (e) {
                        L.DomEvent.stopPropagation(e);
                    });
                }
            });

            labels.push(label);

            // Track this label position
            labelPositions.push({
                lat: labelPosition.lat,
                lng: labelPosition.lng,
                width: name.length * 8, // Estimate label width
                height: 16
            });
        }
    });

    if (labels.length > 0) {
        labelLayer = L.layerGroup(labels).addTo(map);
    }
}

// Find position for label that doesn't overlap with existing labels
function findNonOverlappingPosition(centroid, text) {
    const textWidth = text.length * 8; // Rough estimate
    const textHeight = 16;
    const minDistance = 20; // Minimum pixels between labels

    // Convert lat/lng to pixel coordinates for collision detection
    const centerPixel = map.latLngToContainerPoint([centroid.lat, centroid.lng]);

    // Try positions around the centroid
    const offsets = [
        { x: 0, y: 0 }, // Center first
        { x: 10, y: -5 }, // Right
        { x: -10, y: -5 }, // Left  
        { x: 0, y: -15 }, // Top
        { x: 0, y: 10 }, // Bottom
        { x: 15, y: -15 }, // Top-right
        { x: -15, y: -15 }, // Top-left
        { x: 15, y: 10 }, // Bottom-right
        { x: -15, y: 10 } // Bottom-left
    ];

    for (const offset of offsets) {
        const testPixel = {
            x: centerPixel.x + offset.x,
            y: centerPixel.y + offset.y
        };

        const testLatLng = map.containerPointToLatLng([testPixel.x, testPixel.y]);

        // Check if this position collides with existing labels
        const collides = labelPositions.some(existing => {
            const existingPixel = map.latLngToContainerPoint([existing.lat, existing.lng]);

            const distance = Math.sqrt(
                Math.pow(testPixel.x - existingPixel.x, 2) +
                Math.pow(testPixel.y - existingPixel.y, 2)
            );

            return distance < minDistance + (textWidth + existing.width) / 4;
        });

        if (!collides) {
            return testLatLng;
        }
    }

    // If no non-overlapping position found, don't show label
    return null;
}

// Render grids as points (low zoom)
function renderGridsAsPoints(grids) {
    clearGrids();

    if (grids.length === 0) return;

    const markers = grids.map(feature => {
        const centroid = getPolygonCentroid(feature.geometry);
        if (!centroid) return null;

        const name = getGridName(feature);
        const color = getGridColor(name);
        const marker = L.circleMarker([centroid.lat, centroid.lng], {
            radius: 3,
            color: color,
            weight: 1,
            opacity: 0.8,
            fillOpacity: 0.6,
            fillColor: color
        });

        return marker;
    }).filter(marker => marker !== null);

    gridLayer = L.layerGroup(markers).addTo(map);

    console.log(`Rendered ${markers.length} grids as points`);
}

// Calculate polygon centroid
function getPolygonCentroid(geometry) {
    if (!geometry || !geometry.coordinates) return null;

    let coords;
    if (geometry.type === 'Polygon') {
        coords = geometry.coordinates[0];
    } else if (geometry.type === 'MultiPolygon') {
        coords = geometry.coordinates[0][0];
    } else {
        return null;
    }

    if (!coords || coords.length === 0) return null;

    // Calculate centroid using average of coordinates
    let sumLat = 0, sumLng = 0;
    const validCoords = coords.filter(coord => coord.length >= 2);

    validCoords.forEach(coord => {
        sumLng += coord[0];
        sumLat += coord[1];
    });

    return {
        lat: sumLat / validCoords.length,
        lng: sumLng / validCoords.length
    };
}

// Get grid name from feature properties
function getGridName(feature) {
    return feature.properties?.name ||
        feature.properties?.Name ||
        feature.properties?.title ||
        feature.properties?.TITLE ||
        feature.properties?.id ||
        'Grid';
}

// Generate contrasting colors for each column (01-60)
function generateColumnColors() {
    const colors = [];
    const totalColumns = 60;

    // Use HSL color space for even distribution and high contrast
    for (let i = 0; i < totalColumns; i++) {
        // Space hues evenly around the color wheel with offset for better contrast
        const hue = (i * 137.508) % 360; // Golden angle for optimal spacing
        const saturation = 70 + (i % 3) * 10; // Vary saturation slightly
        const lightness = 45 + (i % 2) * 15; // Alternate lightness for contrast
        colors.push(`hsl(${hue}, ${saturation}%, ${lightness}%)`);
    }

    return colors;
}

// Get color for a grid based on its column number
function getGridColor(gridName) {
    if (!gridName || gridName.length < 2) return '#e74c3c'; // Default red

    // Extract column number (first 2 digits)
    const columnStr = gridName.substring(0, 2);
    const columnNum = parseInt(columnStr, 10);

    if (isNaN(columnNum) || columnNum < 1 || columnNum > 60) {
        return '#e74c3c'; // Default red for invalid columns
    }

    const colors = generateColumnColors();
    return colors[columnNum - 1]; // Convert to 0-based index
}

// Clear existing grids and labels
function clearGrids() {
    if (gridLayer) {
        map.removeLayer(gridLayer);
        gridLayer = null;
    }
    if (labelLayer) {
        map.removeLayer(labelLayer);
        labelLayer = null;
    }
    labelPositions = [];
}

// Build search index for quick grid lookup
function buildSearchIndex() {
    searchIndex = gridData.features.map(feature => {
        const name = getGridName(feature);
        const centroid = getPolygonCentroid(feature.geometry);
        return {
            name: name.toUpperCase(),
            originalName: name,
            feature: feature,
            centroid: centroid
        };
    }).filter(item => item.centroid !== null);

    console.log(`Built search index with ${searchIndex.length} grids`);
}

// Setup search functionality
function setupSearch() {
    const searchInput = document.getElementById('grid-search');
    const searchResults = document.getElementById('search-results');

    if (!searchInput || !searchResults) return;

    // Search as user types
    searchInput.addEventListener('input', function (e) {
        const query = e.target.value.trim().toUpperCase();

        if (query.length === 0) {
            hideSearchResults();
            clearHighlight();
            return;
        }

        performSearch(query);
    });

    // Hide results when clicking outside
    document.addEventListener('click', function (e) {
        if (!e.target.closest('#search-container')) {
            hideSearchResults();
        }
    });

    // Clear search on escape
    searchInput.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
            searchInput.value = '';
            hideSearchResults();
            clearHighlight();
        }
    });
}

// Perform search and display results
function performSearch(query) {
    const results = searchIndex.filter(item =>
        item.name.includes(query)
    ).slice(0, 10); // Limit to 10 results

    displaySearchResults(results, query);
}

// Display search results
function displaySearchResults(results, query) {
    const searchResults = document.getElementById('search-results');

    if (results.length === 0) {
        searchResults.innerHTML = '<div class="no-results">No grids found</div>';
        searchResults.classList.add('show');
        return;
    }

    const html = results.map(result => {
        const centroid = result.centroid;
        const lat = centroid.lat.toFixed(2);
        const lng = centroid.lng.toFixed(2);

        return `
            <div class="search-result" data-name="${result.originalName}">
                <div class="search-result-name">${result.originalName}</div>
                <div class="search-result-info">Lat: ${lat}, Lng: ${lng}</div>
            </div>
        `;
    }).join('');

    searchResults.innerHTML = html;
    searchResults.classList.add('show');

    // Add click handlers
    searchResults.querySelectorAll('.search-result').forEach(element => {
        element.addEventListener('click', function () {
            const gridName = this.dataset.name;
            zoomToGrid(gridName);
            hideSearchResults();
        });
    });
}

// Zoom to specific grid
function zoomToGrid(gridName) {
    const searchItem = searchIndex.find(item =>
        item.originalName === gridName
    );

    if (!searchItem || !searchItem.centroid) return;

    const { lat, lng } = searchItem.centroid;

    // Zoom to grid location
    map.setView([lat, lng], 10);

    // Highlight the grid
    highlightGrid(searchItem.feature);

    // Update search input
    document.getElementById('grid-search').value = gridName;
}

// Highlight a specific grid
function highlightGrid(feature) {
    clearHighlight();

    const name = getGridName(feature);
    const color = getGridColor(name);

    highlightLayer = L.geoJSON(feature, {
        style: {
            color: '#ffff00', // Bright yellow highlight
            weight: 4,
            opacity: 1,
            fillOpacity: 0.3,
            fillColor: '#ffff00'
        }
    }).addTo(map);

    // Remove highlight after 3 seconds
    setTimeout(() => {
        clearHighlight();
    }, 3000);
}

// Clear grid highlight
function clearHighlight() {
    if (highlightLayer) {
        map.removeLayer(highlightLayer);
        highlightLayer = null;
    }
}

// Hide search results
function hideSearchResults() {
    const searchResults = document.getElementById('search-results');
    if (searchResults) {
        searchResults.classList.remove('show');
    }
}

// Get no-coverage styling based on current base layer
function getNoCoverageStyle() {
    if (currentBaseLayer === 'satellite') {
        // Lighter styling for satellite view
        return {
            color: '#9e9e9e', // Lighter grey outline
            weight: 1,
            opacity: 0.9,
            fillOpacity: 0.5, // Slightly more prominent
            fillColor: '#bdbdbd' // Much lighter grey fill
        };
    } else {
        // Original darker styling for OSM
        return {
            color: '#757575', // Dark grey outline
            weight: 1,
            opacity: 0.8,
            fillOpacity: 0.4,
            fillColor: '#424242' // Darker grey fill
        };
    }
}

// Update no-coverage layer styling
function updateNoCoverageStyle() {
    if (!noCoverageLayer) return;

    // Get the new style
    const newStyle = getNoCoverageStyle();

    // Apply the style to all layers in the no-coverage layer
    noCoverageLayer.eachLayer(function (layer) {
        layer.setStyle(newStyle);
    });

    // Ensure it stays on top after style update
    noCoverageLayer.bringToFront();

    console.log(`Updated no-coverage styling for ${currentBaseLayer} view`);
}

// Load areas WITHOUT Sentinel-2 coverage
async function loadNoCoverageArea() {
    try {
        const response = await fetch(CONFIG.noCoverageAreaPath);
        if (!response.ok) {
            console.warn('No-coverage area file not found, continuing without it');
            return;
        }

        noCoverageData = await response.json();
        console.log(`Loaded Sentinel-2 no-coverage areas with ${noCoverageData.features?.length || 1} features`);

        // Create no-coverage layer
        createNoCoverageLayer();

    } catch (error) {
        console.warn('Failed to load no-coverage area:', error);
    }
}

// Create and setup no-coverage layer
function createNoCoverageLayer() {
    if (!noCoverageData) return;

    noCoverageLayer = L.geoJSON(noCoverageData, {
        style: getNoCoverageStyle(),
        pane: 'overlayPane', // Ensure it's in the overlay pane
        interactive: true, // Ensure it remains interactive
        onEachFeature: function (feature, layer) {
            // Enhanced tooltip for no-coverage areas that follows the mouse
            const tooltipText = feature.properties?.name ?
                `No S2 Coverage: ${feature.properties.name}` :
                'No Sentinel-2 Data Available';

            layer.bindTooltip(tooltipText, {
                permanent: false,
                direction: 'auto', // Auto-position based on cursor location
                sticky: true, // Follow the mouse cursor
                className: 'no-coverage-tooltip'
            });

            // Ensure the layer stays on top when added
            layer.bringToFront();
        }
    });

    // Add to layer control if it exists
    if (map.layerControl && noCoverageLayer) {
        map.layerControl.addOverlay(noCoverageLayer, 'No S2 Coverage Areas');
    }

    // Add no-coverage layer to map by default
    noCoverageLayer.addTo(map);

    // Ensure the layer is brought to front after being added
    setTimeout(() => {
        if (noCoverageLayer && map.hasLayer(noCoverageLayer)) {
            noCoverageLayer.bringToFront();
        }
    }, 100);

    console.log('No-coverage area layer created and added to map');
}

// Show/hide UI elements
function hideLoading() {
    document.getElementById('loading').classList.add('hidden');
}

function showZoomInfo() {
    document.getElementById('zoom-info').classList.remove('hidden');
}

function hideZoomInfo() {
    document.getElementById('zoom-info').classList.add('hidden');
}

function showError(message) {
    const loading = document.getElementById('loading');
    loading.innerHTML = `
        <div style="color: #e74c3c;">
            <h3>Error</h3>
            <p>${message}</p>
        </div>
    `;
}

// Utility functions
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// Performance optimised update function
const debouncedUpdate = debounce(updateGridDisplay, 100);

// Replace the direct event listeners with debounced versions
function setupEventListeners() {
    map.off('zoomend moveend', updateGridDisplay);
    map.on('zoomend moveend', debouncedUpdate);
}

// Initialise when DOM is ready
document.addEventListener('DOMContentLoaded', function () {
    initMap();

    // Replace event listeners with debounced versions after initial load
    setTimeout(setupEventListeners, 1000);
});

// Handle window resize
window.addEventListener('resize', function () {
    if (map) {
        map.invalidateSize();
    }
});