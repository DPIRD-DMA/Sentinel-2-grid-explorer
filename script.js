// Configuration
const CONFIG = {
    minZoomForGrids: 3,
    labelZoomThreshold: 8, // NEW: Show labels only at this zoom level and above
    maxGridsToRender: 60000,
    geojsonPath: 'data/sentinel-2_grids.geojson',
    noCoverageAreaPath: 'data/sentinel-2_no_coverage.geojson', // Areas WITHOUT S2 coverage
    githubRepoUrl: 'https://github.com/DPIRD-DMA/Sentinel-2-grid-explorer',
    mapOptions: {
        center: [0, 0], // Start centred on the globe
        zoom: 3, // Begin zoomed out for a global overview
        maxZoom: 17,
        minZoom: 3,
        worldCopyJump: true, // Enable world wrapping
        maxBounds: [[-90, -Infinity], [90, Infinity]], // Allow infinite horizontal scrolling
        zoomControl: false
    }
};

const polygonRenderer = L.canvas({ padding: 0.5 });

function logShareDebug() { }

// Detect whether the current device likely uses a coarse pointer (touch-first)
function isCoarsePointerDevice() {
    if (typeof window === 'undefined') {
        return false;
    }

    if (window.matchMedia) {
        const coarseMatch = window.matchMedia('(pointer: coarse)');
        if (coarseMatch && typeof coarseMatch.matches === 'boolean') {
            return coarseMatch.matches;
        }
    }

    const hasTouchPoints = typeof navigator !== 'undefined' && (
        (typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 0) ||
        (typeof navigator.msMaxTouchPoints === 'number' && navigator.msMaxTouchPoints > 0)
    );

    return hasTouchPoints || 'ontouchstart' in window;
}

// Global variables
let map = null;
let polygonLayer = null;
let labelLayer = null;
let noCoverageLayer = null; // Layer for areas WITHOUT S2 coverage
let gridData = null;
let noCoverageData = null; // No coverage area data
let labelPositions = []; // Track label positions for collision detection
let searchIndex = []; // Search index for grid names
let highlightLayer = null; // Layer for highlighting searched grids
let highlightHaloLayer = null; // Outer halo for selection
let highlightCoreLayer = null; // Inner core for selection
let hoverHighlightLayer = null; // Temporary highlight for hover states
let currentBaseLayer = 'satellite'; // Track current base layer
let activeHighlightMode = null; // Track current highlight render mode
let shareLinkContainer = null;
let shareLinkInput = null;
let shareLinkCopyButton = null;
let shareLinkFeedback = null;
let shareLinkFeedbackTimer = null;
let pendingGridSelection = null;
let shareLinkOptionsContainer = null;
let shareDownloadGeoJsonButton = null;
let shareDownloadCsvButton = null;
let shareClearSelectionButton = null;
let shareZoomSelectionButton = null;
const selectedGridMap = new Map();
let activeMoveStartTime = null;
let activeZoomStartTime = null;
const rectangleSelectState = {
    active: false,
    startLatLng: null,
    lastLatLng: null,
    rectangle: null,
    hasMoved: false,
    draggingWasEnabled: true
};
let suppressNextGridClick = false;
let suppressNextGridClickTimer = null;

// Initialise map
function initMap() {
    map = L.map('map', CONFIG.mapOptions);

    map.createPane('highlight-pane');
    const highlightPane = map.getPane('highlight-pane');
    if (highlightPane) {
        highlightPane.style.zIndex = 650;
        highlightPane.style.pointerEvents = 'none';
    }

    map.boxZoom.disable();

    // Add base layers
    const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 17
    });

    const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
        maxZoom: 17
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

    addGitHubControl();

    // Add event listeners for base layer changes
    map.on('baselayerchange', function (e) {
        currentBaseLayer = e.name.toLowerCase();
        updateNoCoverageStyle();
    });

    // Add event listeners
    map.on('zoomend moveend', updateGridDisplay);

    map.on('movestart', () => {
        activeMoveStartTime = performance.now();
        logShareDebug('map event: movestart');
    });

    map.on('moveend', () => {
        const duration = activeMoveStartTime !== null ? performance.now() - activeMoveStartTime : null;
        logShareDebug('map event: moveend', {
            durationMs: duration !== null ? Number(duration.toFixed(2)) : null
        });
        activeMoveStartTime = null;
    });

    map.on('zoomstart', () => {
        activeZoomStartTime = performance.now();
        logShareDebug('map event: zoomstart');
    });

    map.on('zoomend', () => {
        const duration = activeZoomStartTime !== null ? performance.now() - activeZoomStartTime : null;
        logShareDebug('map event: zoomend', {
            durationMs: duration !== null ? Number(duration.toFixed(2)) : null
        });
        activeZoomStartTime = null;
    });

    setupRectangleSelection();

    // Load grid data and no-coverage areas
    loadGridData();
    loadNoCoverageArea();
}

function addGitHubControl() {
    if (!map || !CONFIG.githubRepoUrl) {
        return;
    }

    const GitHubControl = L.Control.extend({
        options: { position: 'topright' },
        onAdd: function () {
            const container = L.DomUtil.create('div', 'leaflet-control leaflet-bar github-control');
            const link = L.DomUtil.create('a', 'github-control__link', container);
            link.href = CONFIG.githubRepoUrl;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.title = 'Open Sentinel-2 Grid Explorer on GitHub';
            link.setAttribute('aria-label', 'Open Sentinel-2 Grid Explorer on GitHub');
            link.innerHTML = '<svg class="github-control__icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8a8 8 0 005.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.7 7.7 0 012-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.94-.01 2.21 0 .21.15.45.55.38A8 8 0 0016 8c0-4.42-3.58-8-8-8z"></path></svg>';
            L.DomEvent.disableClickPropagation(container);
            return container;
        }
    });

    map.addControl(new GitHubControl());
}

// Load GeoJSON data
async function loadGridData() {
    try {
        logShareDebug('loadGridData: fetching grid data', { path: CONFIG.geojsonPath });
        const response = await fetch(CONFIG.geojsonPath);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        gridData = await response.json();
        logShareDebug('loadGridData: data loaded', {
            featureCount: Array.isArray(gridData?.features) ? gridData.features.length : null
        });
        // Initial grid display
        updateGridDisplay();

        // Build search index
        buildSearchIndex();

        // Setup search functionality
        setupSearch();

        // Apply initial selection from URL if available
        applyPendingGridSelection();

        // Hide loading indicator
        hideLoading();

    } catch (error) {
        logShareDebug('loadGridData: failed to load grid data', { message: error?.message });
        showError('Failed to load Sentinel-2 grid data. Please check the file path.');
    }
}

// Update grid display based on zoom and bounds
function updateGridDisplay() {
    const start = performance.now();
    const zoom = map.getZoom();

    if (zoom < CONFIG.minZoomForGrids) {
        logShareDebug('updateGridDisplay: below min zoom', { zoom });
        clearGrids();
        refreshHighlightForCurrentZoom();
        return;
    }

    if (!gridData) return;

    const bounds = map.getBounds();
    logShareDebug('updateGridDisplay: begin', {
        zoom,
        bounds: {
            north: bounds.getNorth(),
            south: bounds.getSouth(),
            west: bounds.getWest(),
            east: bounds.getEast()
        }
    });
    const visibleGrids = getVisibleGrids(bounds);
    const visibleCount = visibleGrids.length;

    // Determine rendering mode based on zoom level
    const maxToRender = Number.isFinite(CONFIG.maxGridsToRender)
        ? CONFIG.maxGridsToRender
        : Infinity;

    if (visibleCount > maxToRender && Number.isFinite(maxToRender)) {
        visibleGrids.splice(maxToRender);
    }

    renderGridsAsPolygons(visibleGrids);

    refreshHighlightForCurrentZoom();

    // Ensure no-coverage layer stays on top after grid updates
    if (noCoverageLayer && map.hasLayer(noCoverageLayer)) {
        noCoverageLayer.bringToFront();
    }

    const duration = performance.now() - start;
    logShareDebug('updateGridDisplay: complete', {
        zoom,
        visibleCount,
        durationMs: Number(duration.toFixed(2))
    });
}

// Get grids within current map bounds (with world wrapping)
function getVisibleGrids(bounds) {
    const visibleGrids = [];
    const start = performance.now();

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

    const duration = performance.now() - start;
    logShareDebug('getVisibleGrids: finished', {
        visibleCount: visibleGrids.length,
        wrappedBoundsCount: wrappedBounds.length,
        durationMs: Number(duration.toFixed(2))
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
    const start = performance.now();

    if (!Array.isArray(grids) || grids.length === 0) {
        clearPolygonLayer();
        destroyLabelLayer();
        return logShareDebug('renderGridsAsPolygons: no grids to render');
    }

    ensurePolygonLayer();

    const clearStart = performance.now();
    polygonLayer.clearLayers();
    logShareDebug('renderGridsAsPolygons: cleared layer', {
        durationMs: Number((performance.now() - clearStart).toFixed(2))
    });

    labelPositions = [];

    const addStart = performance.now();
    polygonLayer.addData(grids);
    logShareDebug('renderGridsAsPolygons: data added', {
        count: grids.length,
        durationMs: Number((performance.now() - addStart).toFixed(2))
    });

    if (map.getZoom() >= CONFIG.labelZoomThreshold) {
        addPolygonLabels(grids);
    } else {
        destroyLabelLayer();
    }

    logShareDebug('renderGridsAsPolygons: complete', {
        count: grids.length,
        durationMs: Number((performance.now() - start).toFixed(2))
    });
}

function clearPolygonLayer() {
    if (!polygonLayer) {
        return;
    }

    if (typeof polygonLayer.clearLayers === 'function') {
        const clearStart = performance.now();
        polygonLayer.clearLayers();
        logShareDebug('clearPolygonLayer: cleared existing layers', {
            durationMs: Number((performance.now() - clearStart).toFixed(2))
        });
    }

    if (map.hasLayer(polygonLayer)) {
        const removeStart = performance.now();
        map.removeLayer(polygonLayer);
        logShareDebug('clearPolygonLayer: removed layer', {
            durationMs: Number((performance.now() - removeStart).toFixed(2))
        });
    }

    polygonLayer = null;
}

function ensurePolygonLayer() {
    if (polygonLayer && typeof polygonLayer.clearLayers === 'function' && typeof polygonLayer.addData === 'function') {
        if (!map.hasLayer(polygonLayer)) {
            polygonLayer.addTo(map);
            logShareDebug('ensurePolygonLayer: re-added existing layer');
        }
        return;
    }

    clearPolygonLayer();

    polygonLayer = L.geoJSON(null, {
        renderer: polygonRenderer,
        smoothFactor: 0.2,
        style: function (feature) {
            const name = getGridName(feature);
            const color = getGridColor(name);
            const zoom = map ? map.getZoom() : CONFIG.minZoomForGrids;
            const strokeOpacity = getGridStrokeOpacity(zoom);
            const fillOpacity = getGridFillOpacity(zoom);
            return {
                color: color,
                weight: 2,
                opacity: strokeOpacity,
                fillOpacity: fillOpacity,
                fillColor: color
            };
        },
        onEachFeature: function (feature, layer) {
            layer.on('click', function (event) {
                processGridClick(feature, event, {
                    centerMap: false
                });
            });
        }
    }).addTo(map);

    logShareDebug('ensurePolygonLayer: created layer');

}

function ensureLabelLayer() {
    if (labelLayer && typeof labelLayer.clearLayers === 'function') {
        if (!map.hasLayer(labelLayer)) {
            labelLayer.addTo(map);
            logShareDebug('ensureLabelLayer: re-added label layer');
        }
        return;
    }

    destroyLabelLayer();
    labelLayer = L.layerGroup().addTo(map);
    logShareDebug('ensureLabelLayer: created label layer');
}

function clearLabelLayer() {
    if (!labelLayer || typeof labelLayer.clearLayers !== 'function') {
        return;
    }

    const clearStart = performance.now();
    labelLayer.clearLayers();
    labelPositions = [];
    logShareDebug('clearLabelLayer: cleared label features', {
        durationMs: Number((performance.now() - clearStart).toFixed(2))
    });
}

function destroyLabelLayer() {
    if (!labelLayer) {
        labelPositions = [];
        return;
    }

    clearLabelLayer();

    if (map.hasLayer(labelLayer)) {
        const removeStart = performance.now();
        map.removeLayer(labelLayer);
        logShareDebug('destroyLabelLayer: removed label layer', {
            durationMs: Number((performance.now() - removeStart).toFixed(2))
        });
    }

    labelLayer = null;
    labelPositions = [];
}

// Replace the existing addPolygonLabels function with this updated version:

function addPolygonLabels(grids) {
    const start = performance.now();
    ensureLabelLayer();
    clearLabelLayer();

    const labels = [];
    const labelDebugStats = {
        requested: grids.length,
        placed: 0,
        skipped: 0,
        offsetAttempts: 0,
        collisionChecks: 0,
        totalPlacementTimeMs: 0,
        maxPlacementTimeMs: 0,
        findCalls: 0
    };

    grids.forEach(feature => {
        const centroid = getPolygonCentroid(feature.geometry);
        if (!centroid) return;

        const name = getGridName(feature);
        const labelPosition = findNonOverlappingPosition(centroid, name, labelDebugStats);

        if (labelPosition) {
            const label = L.marker([labelPosition.lat, labelPosition.lng], {
                icon: L.divIcon({
                    className: 'grid-label',
                    html: `<span class="selectable-label">${name}</span>`,
                    iconSize: [null, null],
                    iconAnchor: [0, 0]
                }),
                interactive: false
            });

            labels.push(label);

            // Track this label position
            labelPositions.push({
                lat: labelPosition.lat,
                lng: labelPosition.lng,
                width: name.length * 8, // Estimate label width
                height: 16
            });
            labelDebugStats.placed += 1;
        } else {
            labelDebugStats.skipped += 1;
        }
    });

    if (labels.length > 0) {
        labels.forEach(label => labelLayer.addLayer(label));
    }

    const duration = performance.now() - start;
    const averagePlacementMs = labelDebugStats.findCalls > 0
        ? labelDebugStats.totalPlacementTimeMs / labelDebugStats.findCalls
        : 0;

    logShareDebug('addPolygonLabels: complete', {
        requested: labelDebugStats.requested,
        placed: labelDebugStats.placed,
        skipped: labelDebugStats.skipped,
        offsetAttempts: labelDebugStats.offsetAttempts,
        collisionChecks: labelDebugStats.collisionChecks,
        averagePlacementMs: Number(averagePlacementMs.toFixed(2)),
        maxPlacementMs: Number(labelDebugStats.maxPlacementTimeMs.toFixed(2)),
        durationMs: Number(duration.toFixed(2))
    });
}

// Find position for label that doesn't overlap with existing labels
function findNonOverlappingPosition(centroid, text, debugStats) {
    const start = performance.now();
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
        if (debugStats) {
            debugStats.offsetAttempts += 1;
        }
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

            if (debugStats) {
                debugStats.collisionChecks += 1;
            }

            return distance < minDistance + (textWidth + existing.width) / 4;
        });

        if (!collides) {
            if (debugStats) {
                const elapsed = performance.now() - start;
                debugStats.totalPlacementTimeMs += elapsed;
                debugStats.maxPlacementTimeMs = Math.max(debugStats.maxPlacementTimeMs, elapsed);
                debugStats.findCalls += 1;
            }
            return testLatLng;
        }
    }

    if (debugStats) {
        const elapsed = performance.now() - start;
        debugStats.totalPlacementTimeMs += elapsed;
        debugStats.maxPlacementTimeMs = Math.max(debugStats.maxPlacementTimeMs, elapsed);
        debugStats.findCalls += 1;
    }

    // If no non-overlapping position found, don't show label
    return null;
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

function getGridStrokeOpacity(zoom) {
    const minZoom = CONFIG.minZoomForGrids;
    const maxZoom = map ? map.getMaxZoom() : CONFIG.mapOptions.maxZoom;
    if (typeof zoom !== 'number' || !Number.isFinite(zoom)) {
        return 0.8;
    }

    if (maxZoom <= minZoom) {
        return 0.8;
    }

    const clampedZoom = Math.min(Math.max(zoom, minZoom), maxZoom);
    const progress = (clampedZoom - minZoom) / (maxZoom - minZoom);
    return 0.5 + (progress * 0.5);
}

function getGridFillOpacity(zoom) {
    const strokeOpacity = getGridStrokeOpacity(zoom);
    return Math.max(0.05, strokeOpacity * 0.2);
}

// Clear existing grids and labels
function clearGrids(options = {}) {
    const { skipLabelLayer = false } = options;
    const start = performance.now();
    clearPolygonLayer();
    if (!skipLabelLayer) {
        destroyLabelLayer();
    }
    const duration = performance.now() - start;
    logShareDebug('clearGrids: complete', {
        durationMs: Number(duration.toFixed(2))
    });
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

    logShareDebug('buildSearchIndex: completed', {
        entryCount: Array.isArray(searchIndex) ? searchIndex.length : 0
    });
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
    const targetZoom = 8;
    map.setView([lat, lng], targetZoom);

    const searchInput = document.getElementById('grid-search');
    if (searchInput) {
        searchInput.value = gridName;
    }
}

function highlightGrids(features, options = {}) {
    clearHighlight();

    const featureList = Array.isArray(features)
        ? features.filter(Boolean)
        : [features].filter(Boolean);

    if (featureList.length === 0) {
        return;
    }

    const start = performance.now();
    const { flash = false } = options;

    const haloStyle = {
        color: '#ffffff',
        weight: 8,
        opacity: 0.7,
        fillOpacity: 0,
        fillColor: 'transparent'
    };

    const coreStyle = {
        color: '#ffff00',
        weight: 4,
        opacity: 1,
        fillOpacity: 0,
        fillColor: 'transparent'
    };

    const geoJsonData = featureList.length === 1
        ? featureList[0]
        : {
            type: 'FeatureCollection',
            features: featureList
        };

    highlightHaloLayer = L.geoJSON(geoJsonData, {
        style: haloStyle,
        interactive: false,
        pane: 'highlight-pane',
        className: 'selection-halo'
    });

    highlightCoreLayer = L.geoJSON(geoJsonData, {
        style: coreStyle,
        interactive: false,
        pane: 'highlight-pane',
        className: 'selection-core'
    });

    highlightLayer = L.layerGroup([highlightHaloLayer, highlightCoreLayer]).addTo(map);
    activeHighlightMode = 'polygons';

    if (highlightLayer && typeof highlightLayer.eachLayer === 'function') {
        highlightLayer.eachLayer(layer => {
            if (layer && typeof layer.bringToFront === 'function') {
                layer.bringToFront();
            }
        });
    }

    if (flash) {
        startHighlightFlash(coreStyle);
    }

    const duration = performance.now() - start;
    logShareDebug('highlightGrids: complete', {
        featureCount: featureList.length,
        mode: activeHighlightMode,
        durationMs: Number(duration.toFixed(2)),
        flash
    });
}

function startHighlightFlash(baseStyle) {
    if (!highlightCoreLayer) return;

    highlightCoreLayer.setStyle(baseStyle);
}

function showHoverHighlight(gridName) {
    if (!map || !gridName) return;

    const entry = selectedGridMap.get(gridName.toUpperCase());
    if (!entry || !entry.feature) return;

    clearHoverHighlight();

    hoverHighlightLayer = L.geoJSON(entry.feature, {
        pane: 'highlight-pane',
        interactive: false,
        className: 'selection-hover',
        style: {
            color: '#ff4d4f',
            weight: 1.5,
            opacity: 0.9,
            fillOpacity: 0.35,
            fillColor: '#ff4d4f'
        }
    }).addTo(map);

    if (hoverHighlightLayer) {
        if (typeof hoverHighlightLayer.bringToFront === 'function') {
            hoverHighlightLayer.bringToFront();
        } else if (typeof hoverHighlightLayer.eachLayer === 'function') {
            hoverHighlightLayer.eachLayer(layer => {
                if (layer && typeof layer.bringToFront === 'function') {
                    layer.bringToFront();
                }
            });
        }
    }
}

function clearHoverHighlight() {
    if (hoverHighlightLayer) {
        map.removeLayer(hoverHighlightLayer);
        hoverHighlightLayer = null;
    }
}

// Clear grid highlight
function clearHighlight() {
    if (highlightLayer) {
        map.removeLayer(highlightLayer);
        highlightLayer = null;
    }

    highlightHaloLayer = null;
    highlightCoreLayer = null;
    activeHighlightMode = null;

    clearHoverHighlight();
}

function refreshHighlightForCurrentZoom() {
    if (!map) {
        return;
    }

    if (selectedGridMap.size === 0) {
        clearHighlight();
        return;
    }

    if (highlightLayer && activeHighlightMode === 'polygons') {
        if (typeof highlightLayer.eachLayer === 'function') {
            highlightLayer.eachLayer(layer => {
                if (layer && typeof layer.bringToFront === 'function') {
                    layer.bringToFront();
                }
            });
        }
        return;
    }

    const features = getSelectedFeatures();
    if (features.length === 0) {
        clearHighlight();
        return;
    }

    highlightGrids(features, { flash: false });
}

function processGridClick(feature, event, overrideOptions = {}) {
    if (!feature) return;

    if (suppressNextGridClick) {
        suppressNextGridClick = false;
        if (suppressNextGridClickTimer) {
            clearTimeout(suppressNextGridClickTimer);
            suppressNextGridClickTimer = null;
        }
        return;
    }

    const latlng = event?.latlng || null;
    const candidates = latlng
        ? findGridCandidatesAtLatLng(latlng)
        : [];

    if (!candidates.some(candidate => candidate === feature)) {
        candidates.unshift(feature);
    }

    const uniqueCandidates = dedupeFeaturesByName(candidates);
    if (uniqueCandidates.length === 0) {
        return;
    }

    const selectionSizeBeforeToggle = selectedGridMap.size;
    const namesToRemove = [];
    const featuresToAdd = [];

    uniqueCandidates.forEach(candidate => {
        const name = getGridName(candidate);
        if (!name) {
            return;
        }

        const upper = name.toUpperCase();
        if (selectedGridMap.has(upper)) {
            namesToRemove.push(upper);
        } else {
            featuresToAdd.push({ feature: candidate, name, upper });
        }
    });

    if (namesToRemove.length === 0 && featuresToAdd.length === 0) {
        return;
    }

    let mutated = false;

    if (namesToRemove.length > 0) {
        namesToRemove.forEach(upper => {
            if (selectedGridMap.has(upper)) {
                selectedGridMap.delete(upper);
                mutated = true;
            }
        });
    }

    if (featuresToAdd.length > 0) {
        featuresToAdd.forEach(entry => {
            if (selectedGridMap.has(entry.upper)) {
                return;
            }
            const centroid = getPolygonCentroid(entry.feature.geometry);
            selectedGridMap.set(entry.upper, {
                feature: entry.feature,
                name: entry.name,
                centroid
            });
            mutated = true;
        });
    }

    if (!mutated) {
        return;
    }

    clearHoverHighlight();

    const centerMap = overrideOptions.centerMap !== undefined
        ? overrideOptions.centerMap
        : (selectionSizeBeforeToggle === 0 && selectedGridMap.size > 0);

    const focusShareLink = overrideOptions.focusShareLink !== undefined
        ? overrideOptions.focusShareLink
        : false;

    const flash = overrideOptions.flash !== undefined
        ? overrideOptions.flash
        : (featuresToAdd.length > 0);

    refreshSelectionState({
        flash,
        focusShareLink,
        centerMap
    });
}

function findGridCandidatesAtLatLng(latlng) {
    if (!latlng || !polygonLayer || typeof polygonLayer.eachLayer !== 'function') {
        return [];
    }

    const candidates = [];

    polygonLayer.eachLayer(layer => {
        const feature = layer.feature;
        if (!feature || !feature.geometry) return;

        if (isLatLngInFeature(latlng, feature)) {
            candidates.push(feature);
        }
    });

    return candidates;
}

function isLatLngInFeature(latlng, feature) {
    if (!feature || !feature.geometry) return false;

    const point = [latlng.lng, latlng.lat];
    const geometry = feature.geometry;

    if (geometry.type === 'Polygon') {
        return isPointInPolygon(point, geometry.coordinates);
    }

    if (geometry.type === 'MultiPolygon') {
        return geometry.coordinates.some(polygon => isPointInPolygon(point, polygon));
    }

    return false;
}

function isPointInPolygon(point, polygon) {
    if (!polygon || polygon.length === 0) return false;

    const outerRing = polygon[0];
    if (!isPointInLinearRing(point, outerRing)) {
        return false;
    }

    for (let i = 1; i < polygon.length; i++) {
        if (isPointInLinearRing(point, polygon[i])) {
            return false;
        }
    }

    return true;
}

function isPointInLinearRing(point, ring) {
    if (!ring || ring.length === 0) return false;

    let inside = false;

    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0];
        const yi = ring[i][1];
        const xj = ring[j][0];
        const yj = ring[j][1];

        const intersects = ((yi > point[1]) !== (yj > point[1])) &&
            (point[0] < ((xj - xi) * (point[1] - yi)) / ((yj - yi) || 1e-12) + xi);

        if (intersects) {
            inside = !inside;
        }
    }

    return inside;
}

function dedupeFeaturesByName(features) {
    if (!Array.isArray(features) || features.length === 0) {
        return [];
    }

    const uniqueFeatures = [];
    const seenNames = new Set();

    features.forEach(feature => {
        if (!feature) return;
        const name = getGridName(feature);
        if (!name) return;

        const upper = name.toUpperCase();
        if (seenNames.has(upper)) return;

        seenNames.add(upper);
        uniqueFeatures.push(feature);
    });

    return uniqueFeatures;
}

function computeBoundsForFeatures(features) {
    if (!Array.isArray(features) || features.length === 0) {
        return null;
    }

    const bounds = L.latLngBounds();
    let hasValidCoordinate = false;

    features.forEach(feature => {
        const geometry = feature?.geometry;
        const extended = extendBoundsWithGeometry(bounds, geometry);

        if (!extended) {
            const centroid = getPolygonCentroid(geometry);
            if (centroid) {
                bounds.extend([centroid.lat, centroid.lng]);
                hasValidCoordinate = true;
            }
        } else {
            hasValidCoordinate = true;
        }
    });

    return hasValidCoordinate ? bounds : null;
}

function zoomToSelection() {
    if (!map) return;

    const features = getSelectedFeatures();
    if (features.length === 0) {
        return;
    }

    const bounds = computeBoundsForFeatures(features);
    if (bounds && bounds.isValid()) {
        map.fitBounds(bounds, { padding: [80, 80] });
    }
}

function extendBoundsWithGeometry(bounds, geometry) {
    if (!geometry || !bounds) return false;

    let extended = false;

    const extendCoords = coords => {
        if (!Array.isArray(coords)) return;
        coords.forEach(coord => {
            if (!Array.isArray(coord) || coord.length < 2) return;
            const lng = coord[0];
            const lat = coord[1];
            if (typeof lat === 'number' && typeof lng === 'number') {
                bounds.extend([lat, lng]);
                extended = true;
            }
        });
    };

    switch (geometry.type) {
        case 'Polygon':
            geometry.coordinates?.forEach(ring => extendCoords(ring));
            break;
        case 'MultiPolygon':
            geometry.coordinates?.forEach(polygon => {
                polygon?.forEach(ring => extendCoords(ring));
            });
            break;
        case 'LineString':
            extendCoords(geometry.coordinates);
            break;
        case 'MultiLineString':
            geometry.coordinates?.forEach(line => extendCoords(line));
            break;
        case 'Point':
            extendCoords([geometry.coordinates]);
            break;
        case 'MultiPoint':
            extendCoords(geometry.coordinates);
            break;
        case 'GeometryCollection':
            geometry.geometries?.forEach(child => {
                if (extendBoundsWithGeometry(bounds, child)) {
                    extended = true;
                }
            });
            break;
        default:
            break;
    }

    return extended;
}

function setupRectangleSelection() {
    if (!map) return;

    const container = map.getContainer();

    map.on('mousedown', onRectangleMouseDown);
    map.on('mousemove', onRectangleMouseMove);
    map.on('mouseup', onRectangleMouseUp);
    container.addEventListener('mouseleave', onRectangleMouseLeave);
    document.addEventListener('mouseup', onDocumentMouseUp);
}

function onRectangleMouseDown(event) {
    if (!event.originalEvent || !event.originalEvent.shiftKey) {
        return;
    }

    if (!gridData) {
        return;
    }

    event.originalEvent.preventDefault();

    rectangleSelectState.active = true;
    rectangleSelectState.startLatLng = event.latlng;
    rectangleSelectState.lastLatLng = event.latlng;
    rectangleSelectState.hasMoved = false;
    rectangleSelectState.draggingWasEnabled = typeof map.dragging?.enabled === 'function'
        ? map.dragging.enabled()
        : true;

    if (rectangleSelectState.draggingWasEnabled && map.dragging) {
        map.dragging.disable();
    }

    map.getContainer().style.cursor = 'crosshair';

    rectangleSelectState.rectangle = L.rectangle(
        L.latLngBounds(event.latlng, event.latlng),
        {
            color: '#3498db',
            weight: 1,
            fillOpacity: 0.1,
            dashArray: '4 2',
            interactive: false
        }
    ).addTo(map);
}

function onRectangleMouseMove(event) {
    if (!rectangleSelectState.active || !rectangleSelectState.rectangle) {
        return;
    }

    rectangleSelectState.hasMoved = true;
    rectangleSelectState.lastLatLng = event.latlng;
    const bounds = L.latLngBounds(rectangleSelectState.startLatLng, event.latlng);
    rectangleSelectState.rectangle.setBounds(bounds);
}

function onRectangleMouseUp(event) {
    if (!rectangleSelectState.active) {
        return;
    }

    completeRectangleSelection(event?.latlng || rectangleSelectState.lastLatLng);
}

function onRectangleMouseLeave() {
    if (!rectangleSelectState.active) {
        return;
    }

    // If the mouse leaves the map container without releasing, keep the shape
    // but record that we've moved to ensure a selection occurs on document mouseup.
    rectangleSelectState.hasMoved = true;
}

function onDocumentMouseUp(event) {
    if (!rectangleSelectState.active) {
        return;
    }

    let latlng = null;
    try {
        latlng = map.mouseEventToLatLng(event);
    } catch (error) {
        latlng = rectangleSelectState.lastLatLng || rectangleSelectState.startLatLng;
    }

    completeRectangleSelection(latlng);
}

function resetRectangleSelection() {
    const wasDraggingEnabled = rectangleSelectState.draggingWasEnabled;

    if (rectangleSelectState.rectangle) {
        map.removeLayer(rectangleSelectState.rectangle);
    }

    rectangleSelectState.active = false;
    rectangleSelectState.startLatLng = null;
    rectangleSelectState.lastLatLng = null;
    rectangleSelectState.rectangle = null;
    rectangleSelectState.hasMoved = false;
    rectangleSelectState.draggingWasEnabled = true;

    map.getContainer().style.cursor = '';

    if (map && map.dragging && wasDraggingEnabled) {
        map.dragging.enable();
    }
}

function completeRectangleSelection(finalLatLng) {
    const hasMoved = rectangleSelectState.hasMoved;
    const startLatLng = rectangleSelectState.startLatLng;

    resetRectangleSelection();

    if (hasMoved) {
        scheduleSuppressNextGridClick();
    }

    if (!hasMoved || !startLatLng || !finalLatLng) {
        return;
    }

    const bounds = L.latLngBounds(startLatLng, finalLatLng);

    const selectedFeatures = findFeaturesInBounds(bounds);
    if (selectedFeatures.length === 0) {
        return;
    }

    const replaceSelection = selectedGridMap.size === 0;

    const newFeaturesCount = selectedFeatures.reduce((count, feature) => {
        const name = getGridName(feature);
        if (!name) return count;
        const upper = name.toUpperCase();
        return count + (replaceSelection || !selectedGridMap.has(upper) ? 1 : 0);
    }, 0);

    if (!replaceSelection && newFeaturesCount === 0) {
        return;
    }

    updateSelection(selectedFeatures, {
        replace: replaceSelection,
        centerMap: false,
        flash: true,
        focusShareLink: false
    });

}

function scheduleSuppressNextGridClick() {
    suppressNextGridClick = true;
    if (suppressNextGridClickTimer) {
        clearTimeout(suppressNextGridClickTimer);
    }
    suppressNextGridClickTimer = setTimeout(() => {
        suppressNextGridClick = false;
        suppressNextGridClickTimer = null;
    }, 250);
}

function findFeaturesInBounds(bounds) {
    if (!gridData || !bounds) {
        return [];
    }

    const matches = [];

    gridData.features.forEach(feature => {
        if (!feature || !feature.geometry) return;

        if (doesFeatureIntersectBounds(feature, bounds)) {
            matches.push(feature);
        }
    });

    return dedupeFeaturesByName(matches);
}

function doesFeatureIntersectBounds(feature, bounds) {
    if (!feature || !feature.geometry) return false;

    const geometry = feature.geometry;

    if (geometry.type === 'Polygon' && geometry.coordinates?.[0]) {
        if (isPolygonIntersectingBounds(geometry.coordinates[0], bounds)) {
            return true;
        }
    } else if (geometry.type === 'MultiPolygon') {
        if (geometry.coordinates.some(polygon => polygon?.[0] && isPolygonIntersectingBounds(polygon[0], bounds))) {
            return true;
        }
    }

    const centroid = getPolygonCentroid(geometry);
    if (centroid) {
        return bounds.contains([centroid.lat, centroid.lng]);
    }

    return false;
}

// Selection management
function updateSelection(features, options = {}) {
    if (!Array.isArray(features) || features.length === 0) {
        return;
    }

    const {
        replace = false,
        centerMap = true,
        flash = true,
        focusShareLink = true,
        debugSource = null
    } = options;

    if (debugSource) {
        logShareDebug('updateSelection: invoked', {
            debugSource,
            featureCount: features.length,
            replace,
            centerMap,
            flash,
            focusShareLink
        });
    }

    if (replace) {
        selectedGridMap.clear();
    }

    let addedCount = 0;

    features.forEach(feature => {
        if (!feature) return;

        const name = getGridName(feature);
        if (!name) return;

        const upper = name.toUpperCase();

        if (!replace && selectedGridMap.has(upper)) {
            return;
        }

        const centroid = getPolygonCentroid(feature.geometry);
        selectedGridMap.set(upper, {
            feature,
            name,
            centroid
        });
        addedCount++;
    });

    refreshSelectionState({
        flash: flash && (addedCount > 0 || replace),
        focusShareLink,
        centerMap: centerMap && selectedGridMap.size > 0
    });

    if (debugSource) {
        logShareDebug('updateSelection: selection refreshed', {
            debugSource,
            addedCount,
            totalSelected: selectedGridMap.size
        });
    }
}

function removeGridFromSelection(gridName) {
    if (!gridName) return;

    const upper = gridName.toUpperCase();
    if (!selectedGridMap.has(upper)) {
        return;
    }

    const entry = selectedGridMap.get(upper);
    selectedGridMap.delete(upper);

    refreshSelectionState({
        flash: false,
        focusShareLink: false,
        centerMap: false
    });

    clearHoverHighlight();
}

function clearSelection(options = {}) {
    if (selectedGridMap.size === 0) {
        return;
    }

    selectedGridMap.clear();

    refreshSelectionState({
        flash: false,
        focusShareLink: false,
        centerMap: false,
        suppressShareLink: false
    });

    clearHoverHighlight();
}

function getSelectedEntries() {
    return Array.from(selectedGridMap.values());
}

function getSelectedNamesSorted() {
    return Array.from(selectedGridMap.values())
        .map(entry => entry.name)
        .sort((a, b) => a.localeCompare(b));
}

function refreshSelectionState(options = {}) {
    const {
        flash = true,
        focusShareLink = true,
        centerMap = false,
        suppressShareLink = false
    } = options;

    const selectionEntries = getSelectedEntries();

    if (selectionEntries.length === 0) {
        clearHighlight();
        updateAddressBarWithSelection([]);
        if (!suppressShareLink) {
            hideShareLink();
        }
        return;
    }

    if (centerMap && selectionEntries.length > 0) {
        const primaryEntry = selectionEntries[0];
        const centroid = primaryEntry?.centroid;
        if (centroid) {
            const targetZoom = Math.max(map.getZoom(), 10);
            map.setView([centroid.lat, centroid.lng], targetZoom);
        }
    }

    highlightGrids(selectionEntries.map(entry => entry.feature), { flash });

    const shareUrl = updateAddressBarWithSelection(getSelectedNamesSorted());

    if (!suppressShareLink) {
        showShareLink(selectionEntries, shareUrl, { focusShareLink });
    }
}

function updateAddressBarWithSelection(gridNames) {
    const namesArray = Array.isArray(gridNames) ? gridNames : [];
    const upperSorted = [...new Set(namesArray.map(name => name.toUpperCase()))].sort();

    let shareUrl = window.location.href;

    try {
        const url = new URL(window.location.href);
        url.searchParams.delete('grid');
        url.searchParams.delete('grids');

        if (upperSorted.length === 1) {
            url.searchParams.set('grid', upperSorted[0]);
        } else if (upperSorted.length > 1) {
            url.searchParams.set('grids', upperSorted.join(','));
        }

        shareUrl = url.toString();

        if (window.history && window.history.replaceState) {
            window.history.replaceState({}, '', shareUrl);
        }
    } catch (error) {
        const origin = (window.location.origin && window.location.origin !== 'null')
            ? window.location.origin
            : '';
        const basePath = `${origin}${window.location.pathname}`;
        const hash = window.location.hash || '';

        let query = '';
        if (upperSorted.length === 1) {
            query = `?grid=${encodeURIComponent(upperSorted[0])}`;
        } else if (upperSorted.length > 1) {
            query = `?grids=${encodeURIComponent(upperSorted.join(','))}`;
        }

        shareUrl = `${basePath}${query}${hash}`;

        if (window.history && window.history.replaceState) {
            window.history.replaceState({}, '', shareUrl);
        }
    }

    return shareUrl;
}

function getSelectedFeatures() {
    return getSelectedEntries()
        .map(entry => entry.feature)
        .filter(feature => !!feature);
}

function downloadSelectionAsGeoJSON() {
    const features = getSelectedFeatures();
    if (features.length === 0) {
        setShareLinkFeedback('Select grids to export first');
        return;
    }

    const featureCollection = {
        type: 'FeatureCollection',
        features: features.map(feature => JSON.parse(JSON.stringify(feature)))
    };

    const filename = buildSelectionFilename('sentinel-grids', 'geojson');
    triggerDownload(filename, 'application/geo+json', JSON.stringify(featureCollection, null, 2));
}

function downloadSelectionAsCSV() {
    const selectionEntries = getSelectedEntries();
    if (selectionEntries.length === 0) {
        setShareLinkFeedback('Select grids to export first');
        return;
    }

    const propertyKeys = new Set();

    selectionEntries.forEach(entry => {
        const properties = entry.feature?.properties;
        if (properties && typeof properties === 'object') {
            Object.keys(properties).forEach(key => {
                propertyKeys.add(key);
            });
        }
    });

    const orderedPropertyKeys = Array.from(propertyKeys)
        .filter(key => typeof key === 'string' && key.toLowerCase() !== 'name')
        .sort();

    const headers = ['name', 'centroid_lat', 'centroid_lng', ...orderedPropertyKeys];

    const rows = selectionEntries.map(entry => {
        const name = entry.name || getGridName(entry.feature) || '';
        const centroid = entry.centroid || getPolygonCentroid(entry.feature?.geometry) || { lat: '', lng: '' };
        const properties = entry.feature?.properties || {};

        const baseValues = [name, formatCsvNumber(centroid.lat), formatCsvNumber(centroid.lng)];
        const propertyValues = orderedPropertyKeys.map(key => {
            const value = properties[key];
            if (value === null || value === undefined) return '';
            if (typeof value === 'object') return JSON.stringify(value);
            return value;
        });

        return [...baseValues, ...propertyValues].map(escapeCsvValue).join(',');
    });

    const csvContent = [headers.map(escapeCsvValue).join(','), ...rows].join('\n');
    const filename = buildSelectionFilename('sentinel-2-grid-tile', 'csv');
    triggerDownload(filename, 'text/csv', csvContent);
}

function escapeCsvValue(value) {
    const stringValue = value === null || value === undefined ? '' : String(value);
    if (/[",\n]/.test(stringValue)) {
        return '"' + stringValue.replace(/"/g, '""') + '"';
    }
    return stringValue;
}

function formatCsvNumber(num) {
    if (typeof num !== 'number' || Number.isNaN(num)) {
        return '';
    }
    return num.toFixed(6);
}

function buildSelectionFilename(base, extension) {
    const timestamp = new Date().toISOString().replace(/[:T]/g, '-').split('.')[0];
    return `${base}-selection-${timestamp}.${extension}`;
}

function triggerDownload(filename, mimeType, content) {
    try {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);

        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (error) {
        setShareLinkFeedback('Unable to download selection');
    }
}

function setupShareLinkUI() {
    shareLinkContainer = document.getElementById('share-link-container');
    if (!shareLinkContainer) return;

    shareLinkInput = document.getElementById('share-link-input');
    shareLinkCopyButton = document.getElementById('share-link-copy');
    shareLinkFeedback = document.getElementById('share-link-feedback');
    shareLinkOptionsContainer = document.getElementById('share-link-options');
    shareDownloadGeoJsonButton = document.getElementById('share-download-geojson');
    shareDownloadCsvButton = document.getElementById('share-download-csv');
    shareClearSelectionButton = document.getElementById('share-clear-selection');
    shareZoomSelectionButton = document.getElementById('share-zoom-selection');

    if (shareLinkCopyButton) {
        shareLinkCopyButton.addEventListener('click', async function () {
            if (!shareLinkInput || !shareLinkInput.value) return;

            const supportsClipboard = navigator.clipboard && navigator.clipboard.writeText;

            if (supportsClipboard) {
                try {
                    await navigator.clipboard.writeText(shareLinkInput.value);
                    return;
                } catch (error) {
                    // Fall back to manual copy below
                }
            }

            shareLinkInput.focus();
            shareLinkInput.select();
        });
    }

    if (shareLinkInput) {
        shareLinkInput.addEventListener('focus', function () {
            shareLinkInput.select();
        });
    }

    if (shareLinkOptionsContainer) {
        shareLinkOptionsContainer.addEventListener('click', function (event) {
            const optionButton = event.target.closest('.share-option');
            if (!optionButton) return;

            const gridName = optionButton.dataset.grid;
            if (!gridName) return;

            event.preventDefault();
            removeGridFromSelection(gridName);
        });

        shareLinkOptionsContainer.addEventListener('mouseleave', function () {
            clearHoverHighlight();
        });
    }

    if (shareDownloadGeoJsonButton) {
        shareDownloadGeoJsonButton.addEventListener('click', function () {
            downloadSelectionAsGeoJSON();
        });
    }

    if (shareDownloadCsvButton) {
        shareDownloadCsvButton.addEventListener('click', function () {
            downloadSelectionAsCSV();
        });
    }

    if (shareClearSelectionButton) {
        shareClearSelectionButton.addEventListener('click', function () {
            clearSelection({ silent: false });
        });
    }

    if (shareZoomSelectionButton) {
        shareZoomSelectionButton.addEventListener('click', function () {
            zoomToSelection();
        });
    }
}

function showShareLink(selectionEntries, shareUrl, options = {}) {
    if (!shareLinkContainer) return;

    const { focusShareLink = true } = options;

    shareLinkContainer.classList.remove('hidden');

    const count = selectionEntries.length;
    const primaryName = count === 1 ? selectionEntries[0].name : null;

    if (shareLinkInput) {
        shareLinkInput.value = shareUrl;
        const ariaLabel = count === 1
            ? `Shareable link for grid ${primaryName}`
            : `Shareable link for ${count} grids`;
        shareLinkInput.setAttribute('aria-label', ariaLabel);
    }

    updateShareLinkOptions(selectionEntries);

    if (!focusShareLink) {
        return;
    }

    if (count > 1 && shareLinkOptionsContainer) {
        const firstOption = shareLinkOptionsContainer.querySelector('.share-option');
        if (firstOption) {
            firstOption.focus();
            return;
        }
    }

    if (shareLinkInput) {
        shareLinkInput.focus();
        shareLinkInput.select();
    }
}

function updateShareLinkOptions(selectionEntries) {
    if (!shareLinkOptionsContainer) return;

    if (!Array.isArray(selectionEntries) || selectionEntries.length === 0) {
        shareLinkOptionsContainer.innerHTML = '';
        shareLinkOptionsContainer.classList.add('hidden');
        return;
    }

    shareLinkOptionsContainer.classList.remove('hidden');

    const sortedEntries = [...selectionEntries].sort((a, b) => a.name.localeCompare(b.name));

    const optionsHtml = sortedEntries.map(entry => {
        const upper = entry.name.toUpperCase();
        return `
            <button type="button" class="share-option active" data-grid="${upper}" aria-label="Remove grid ${entry.name}">
                <span class="share-option-name">${entry.name}</span>
            </button>
        `;
    }).join('');

    shareLinkOptionsContainer.innerHTML = optionsHtml;

    shareLinkOptionsContainer.querySelectorAll('.share-option').forEach(button => {
        button.addEventListener('mouseenter', function () {
            const gridName = this.dataset.grid;
            if (gridName) {
                showHoverHighlight(gridName);
            }
        });

        button.addEventListener('mouseleave', function () {
            clearHoverHighlight();
        });
    });
}

function hideShareLink() {
    if (shareLinkContainer) {
        shareLinkContainer.classList.add('hidden');
    }

    if (shareLinkFeedback) {
        shareLinkFeedback.textContent = '';
    }

    if (shareLinkFeedbackTimer) {
        clearTimeout(shareLinkFeedbackTimer);
        shareLinkFeedbackTimer = null;
    }
}

function setShareLinkFeedback(message) {
    if (!shareLinkFeedback) return;

    shareLinkFeedback.textContent = message;

    if (shareLinkFeedbackTimer) {
        clearTimeout(shareLinkFeedbackTimer);
    }

    if (!message) {
        shareLinkFeedbackTimer = null;
        return;
    }

    shareLinkFeedbackTimer = setTimeout(() => {
        if (shareLinkFeedback) {
            shareLinkFeedback.textContent = '';
        }
    }, 3000);
}

// Hide search results
function hideSearchResults() {
    const searchResults = document.getElementById('search-results');
    if (searchResults) {
        searchResults.classList.remove('show');
    }
}

function getGridParamsFromUrl() {
    try {
        const search = window.location.search || '';
        logShareDebug('getGridParamsFromUrl: parsing search params', { search });
        const params = new URLSearchParams(window.location.search);
        const gridsParam = params.get('grids');
        const gridParam = params.get('grid');

        const names = [];

        if (gridsParam) {
            gridsParam.split(',').forEach(name => {
                const trimmed = name.trim();
                if (trimmed.length > 0) {
                    names.push(trimmed.toUpperCase());
                }
            });
        }

        if (gridParam) {
            const trimmed = gridParam.trim();
            if (trimmed.length > 0) {
                names.push(trimmed.toUpperCase());
            }
        }

        logShareDebug('getGridParamsFromUrl: extracted raw names', { names: [...names] });
        const uniqueNames = [...new Set(names)];
        logShareDebug('getGridParamsFromUrl: unique names', { uniqueNames });
        return uniqueNames.length > 0 ? uniqueNames : null;
    } catch (error) {
        logShareDebug('getGridParamsFromUrl: failed to parse params', { message: error?.message });
        return null;
    }
}

function applyPendingGridSelection() {
    if (!Array.isArray(pendingGridSelection) || pendingGridSelection.length === 0) {
        logShareDebug('applyPendingGridSelection: no pending selection to apply');
        return;
    }

    if (!Array.isArray(searchIndex) || searchIndex.length === 0) {
        logShareDebug('applyPendingGridSelection: search index not ready yet', {
            pendingCount: pendingGridSelection.length
        });
        return;
    }

    logShareDebug('applyPendingGridSelection: attempting to match pending grids', {
        pending: [...pendingGridSelection],
        searchIndexSize: searchIndex.length
    });
    const matches = pendingGridSelection.map(name => {
        const match = searchIndex.find(item => item.name === name);
        if (!match) {
            logShareDebug('applyPendingGridSelection: grid not found in search index', { name });
        }
        return match;
    }).filter(Boolean);

    if (matches.length === 0) {
        logShareDebug('applyPendingGridSelection: no matches found, clearing pending selection');
        pendingGridSelection = null;
        return;
    }

    const features = matches.map(item => item.feature);
    logShareDebug('applyPendingGridSelection: matched features', {
        matchCount: matches.length,
        featureNames: matches.map(item => item.name)
    });

    setTimeout(() => {
        logShareDebug('applyPendingGridSelection: invoking updateSelection', {
            featureCount: features.length,
            replace: true
        });
        updateSelection(features, {
            replace: true,
            centerMap: false,
            flash: true,
            focusShareLink: false,
            debugSource: 'share-link'
        });

        if (map) {
            const bounds = computeBoundsForFeatures(features);
            if (bounds && bounds.isValid()) {
                map.fitBounds(bounds, { padding: [80, 80] });
                logShareDebug('applyPendingGridSelection: map.fitBounds executed', {
                    padding: [80, 80]
                });
            } else {
                logShareDebug('applyPendingGridSelection: bounds invalid or unavailable');
            }
        }
    }, 200);

    logShareDebug('applyPendingGridSelection: scheduled selection application');
    pendingGridSelection = null;
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
}

// Load areas WITHOUT Sentinel-2 coverage
async function loadNoCoverageArea() {
    try {
        const response = await fetch(CONFIG.noCoverageAreaPath);
        if (!response.ok) {
            return;
        }

        noCoverageData = await response.json();

        // Create no-coverage layer
        createNoCoverageLayer();

    } catch (error) {
        logShareDebug('loadNoCoverageArea: failed', { message: error?.message });
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
            layer.on('click', handleNoCoverageLayerClick);

            // Ensure the layer stays on top when added
            layer.bringToFront();
        }
    });

    // Add to layer control if it exists
    if (map.layerControl && noCoverageLayer) {
        map.layerControl.addOverlay(noCoverageLayer, 'Coverage Areas');
    }

    // Add no-coverage layer to map by default
    noCoverageLayer.addTo(map);

    // Ensure the layer is brought to front after being added
    setTimeout(() => {
        if (noCoverageLayer && map.hasLayer(noCoverageLayer)) {
            noCoverageLayer.bringToFront();
        }
    }, 100);
}

function handleNoCoverageLayerClick(event) {
    if (!event || !event.latlng) {
        return;
    }

    const candidates = findGridCandidatesAtLatLng(event.latlng);
    if (!Array.isArray(candidates) || candidates.length === 0) {
        return;
    }

    processGridClick(candidates[0], event, {
        centerMap: false
    });
}

// Show/hide UI elements
function hideLoading() {
    document.getElementById('loading').classList.add('hidden');
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
    setupShareLinkUI();
    pendingGridSelection = getGridParamsFromUrl();
    logShareDebug('DOMContentLoaded: initial share link state', {
        href: window.location.href,
        pendingGridSelection,
        hasPending: Array.isArray(pendingGridSelection) && pendingGridSelection.length > 0
    });

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
