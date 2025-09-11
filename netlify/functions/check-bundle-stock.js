// netlify/functions/check-bundle-stock.js
exports.handler = async (event, context) => {
    // More comprehensive CORS headers
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Max-Age': '86400', // 24 hours
    }

    // Handle preflight OPTIONS request
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers,
            body: ''
        }
    }

    // Only allow POST for actual requests
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ error: 'Method not allowed' })
        }
    }

    try {
        const { properties, shopDomain, bundleProductId } = JSON.parse(event.body)

        if (!properties || typeof properties !== 'object') {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Invalid properties data' })
            }
        }

        // Shopify Admin API credentials
        const shopifyAccessToken = process.env.SHOPIFY_ACCESS_TOKEN
        const shopifyShopDomain = process.env.SHOPIFY_SHOP_DOMAIN || shopDomain

        if (!shopifyAccessToken || !shopifyShopDomain) {
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ error: 'Missing Shopify credentials' })
            }
        }

        console.log('Received properties:', properties)

        // Parse properties to extract SKUs using our product mapping
        const lineItems = parsePropertiesToSKUs(properties)

        console.log('Parsed line items:', lineItems)

        if (!Array.isArray(lineItems)) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({
                    error: 'Invalid line items format',
                    properties: properties,
                    lineItems: lineItems
                })
            }
        }

        // Check for exactly 2 products - bundle should always contain 2 items
        if (lineItems.length === 0) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({
                    error: 'No valid SKUs found from properties - could not map any products',
                    properties: properties,
                    lineItems: lineItems
                })
            }
        }

        if (lineItems.length === 1) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({
                    error: 'Bundle incomplete - only found 1 product SKU, expected 2 products',
                    properties: properties,
                    lineItems: lineItems,
                    foundProduct: lineItems[0]
                })
            }
        }

        if (lineItems.length !== 2) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({
                    error: `Invalid bundle configuration - found ${lineItems.length} products, expected exactly 2`,
                    properties: properties,
                    lineItems: lineItems
                })
            }
        }

        // Check inventory levels for all SKUs
        const stockResults = await checkInventoryLevels(lineItems, shopifyShopDomain, shopifyAccessToken)

        console.log('Stock check results:', stockResults)

        // Analyze results
        const outOfStockItems = stockResults.filter(item => !item.available)
        const allInStock = outOfStockItems.length === 0

        if (allInStock) {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    available: true,
                    message: 'All items in stock',
                    lineItems: lineItems,
                    stockResults: stockResults,
                    properties: properties
                })
            }
        } else {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    available: false,
                    message: 'Some items are out of stock',
                    outOfStockItems: outOfStockItems,
                    stockResults: stockResults,
                    lineItems: lineItems,
                    properties: properties
                })
            }
        }

    } catch (error) {
        console.error('Stock check error:', error)

        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
                error: 'Internal server error',
                message: error.message
            })
        }
    }
}

// Check inventory levels for multiple SKUs with detailed debugging
async function checkInventoryLevels(lineItems, shopDomain, accessToken) {
    const results = []

    for (const item of lineItems) {
        try {
            console.log(`\n=== Checking stock for SKU: ${item.sku} ===`)

            // Get variant by SKU
            const variantResult = await getVariantBySKU(item.sku, shopDomain, accessToken)

            if (!variantResult.found) {
                console.log(`❌ Variant not found for SKU: ${item.sku}`)
                results.push({
                    sku: item.sku,
                    quantity: item.quantity,
                    available: false,
                    error: 'Product variant not found',
                    availableQuantity: 0,
                    debug: {
                        variantFound: false,
                        searchedProducts: variantResult.searchedProducts
                    }
                })
                continue
            }

            const variant = variantResult.variant
            console.log(`✅ Found variant ID: ${variant.id} for SKU: ${item.sku}`)
            console.log(`📋 Variant details:`, {
                id: variant.id,
                sku: variant.sku,
                inventory_management: variant.inventory_management,
                inventory_policy: variant.inventory_policy,
                inventory_item_id: variant.inventory_item_id
            })

            // Check if inventory is tracked
            if (variant.inventory_management !== 'shopify') {
                console.log(`⚠️ Inventory not tracked for SKU: ${item.sku} (management: ${variant.inventory_management})`)
                results.push({
                    sku: item.sku,
                    quantity: item.quantity,
                    available: true, // If not tracked, assume available
                    availableQuantity: 'unlimited',
                    variantId: variant.id,
                    inventoryItemId: variant.inventory_item_id,
                    inventoryPolicy: variant.inventory_policy,
                    inventoryManagement: variant.inventory_management,
                    debug: {
                        variantFound: true,
                        inventoryTracked: false,
                        reason: 'Inventory management not set to shopify'
                    }
                })
                continue
            }

            // Get inventory levels for this variant
            const inventoryResult = await getInventoryLevel(variant.inventory_item_id, shopDomain, accessToken)

            console.log(`📦 Inventory check result:`, inventoryResult)

            if (!inventoryResult.success) {
                console.log(`❌ Failed to get inventory for SKU: ${item.sku}`)
                results.push({
                    sku: item.sku,
                    quantity: item.quantity,
                    available: false,
                    error: inventoryResult.error,
                    availableQuantity: 0,
                    variantId: variant.id,
                    inventoryItemId: variant.inventory_item_id,
                    debug: {
                        variantFound: true,
                        inventoryTracked: true,
                        inventoryCheckFailed: true,
                        error: inventoryResult.error,
                        locations: inventoryResult.locations
                    }
                })
                continue
            }

            const totalAvailable = inventoryResult.totalAvailable
            const isAvailable = totalAvailable >= item.quantity

            console.log(`📊 Final result for SKU ${item.sku}: ${totalAvailable} available, need ${item.quantity}, result: ${isAvailable ? '✅' : '❌'}`)

            results.push({
                sku: item.sku,
                quantity: item.quantity,
                available: isAvailable,
                availableQuantity: totalAvailable,
                variantId: variant.id,
                inventoryItemId: variant.inventory_item_id,
                inventoryPolicy: variant.inventory_policy,
                inventoryManagement: variant.inventory_management,
                debug: {
                    variantFound: true,
                    inventoryTracked: true,
                    locations: inventoryResult.locations,
                    totalAvailable: totalAvailable
                }
            })

        } catch (error) {
            console.error(`💥 Error checking stock for SKU ${item.sku}:`, error)
            results.push({
                sku: item.sku,
                quantity: item.quantity,
                available: false,
                error: error.message,
                availableQuantity: 0,
                debug: {
                    exception: error.message
                }
            })
        }
    }

    return results
}

// Enhanced variant search with better debugging
async function getVariantBySKU(sku, shopDomain, accessToken) {
    try {
        console.log(`🔍 Searching for variant with SKU: ${sku}`)

        let allProducts = []
        let nextPageInfo = null
        let pageCount = 0
        const maxPages = 10 // Prevent infinite loops

        do {
            pageCount++
            console.log(`📄 Fetching products page ${pageCount}`)

            let url = `https://${shopDomain}/admin/api/2024-01/products.json?fields=id,title,variants&limit=250`

            if (nextPageInfo) {
                url += `&page_info=${nextPageInfo}`
            }

            const response = await fetch(url, {
                headers: {
                    'X-Shopify-Access-Token': accessToken
                }
            })

            if (!response.ok) {
                throw new Error(`Failed to fetch products: ${response.status} ${response.statusText}`)
            }

            const data = await response.json()
            allProducts.push(...data.products)

            console.log(`📦 Found ${data.products.length} products on page ${pageCount}`)

            // Check for pagination
            const linkHeader = response.headers.get('Link')
            nextPageInfo = null

            if (linkHeader && linkHeader.includes('rel="next"')) {
                const nextMatch = linkHeader.match(/<[^>]*[?&]page_info=([^>&]+)[^>]*>;\s*rel="next"/)
                if (nextMatch) {
                    nextPageInfo = nextMatch[1]
                }
            }

        } while (nextPageInfo && pageCount < maxPages)

        console.log(`📋 Total products searched: ${allProducts.length}`)

        // Search through all variants to find matching SKU
        for (const product of allProducts) {
            for (const variant of product.variants) {
                if (variant.sku === sku) {
                    console.log(`🎯 Found matching variant in product: ${product.title}`)
                    return {
                        found: true,
                        variant: variant,
                        product: product,
                        searchedProducts: allProducts.length
                    }
                }
            }
        }

        console.log(`❌ No variant found with SKU: ${sku}`)
        return {
            found: false,
            variant: null,
            searchedProducts: allProducts.length
        }

    } catch (error) {
        console.error(`💥 Error fetching variant for SKU ${sku}:`, error)
        throw error
    }
}

// Enhanced inventory level check with multiple locations
async function getInventoryLevel(inventoryItemId, shopDomain, accessToken) {
    try {
        console.log(`📍 Getting inventory levels for item: ${inventoryItemId}`)

        // Get all locations first
        const locationsResponse = await fetch(`https://${shopDomain}/admin/api/2024-01/locations.json`, {
            headers: {
                'X-Shopify-Access-Token': accessToken
            }
        })

        if (!locationsResponse.ok) {
            throw new Error(`Failed to fetch locations: ${locationsResponse.status}`)
        }

        const locationsData = await locationsResponse.json()
        console.log(`🏪 Found ${locationsData.locations.length} locations:`)

        const locationDetails = locationsData.locations.map(loc => ({
            id: loc.id,
            name: loc.name,
            active: loc.active,
            legacy: loc.legacy || false
        }))
        console.log(locationDetails)

        if (locationsData.locations.length === 0) {
            return {
                success: false,
                error: 'No locations found',
                locations: [],
                totalAvailable: 0
            }
        }

        // Get inventory levels for all locations
        const locationIds = locationsData.locations.map(loc => loc.id).join(',')

        const inventoryResponse = await fetch(
            `https://${shopDomain}/admin/api/2024-01/inventory_levels.json?inventory_item_ids=${inventoryItemId}&location_ids=${locationIds}`,
            {
                headers: {
                    'X-Shopify-Access-Token': accessToken
                }
            }
        )

        if (!inventoryResponse.ok) {
            throw new Error(`Failed to fetch inventory levels: ${inventoryResponse.status}`)
        }

        const inventoryData = await inventoryResponse.json()
        console.log(`📦 Inventory levels response:`, inventoryData)

        // Calculate total available across all locations
        let totalAvailable = 0
        const locationBreakdown = []

        for (const level of inventoryData.inventory_levels) {
            const location = locationsData.locations.find(loc => loc.id === level.location_id)
            const available = level.available || 0
            totalAvailable += available

            locationBreakdown.push({
                locationId: level.location_id,
                locationName: location ? location.name : 'Unknown',
                available: available
            })

            console.log(`📍 ${location?.name || 'Unknown'} (${level.location_id}): ${available} available`)
        }

        console.log(`📊 Total available across all locations: ${totalAvailable}`)

        return {
            success: true,
            totalAvailable: totalAvailable,
            locations: locationBreakdown
        }

    } catch (error) {
        console.error(`💥 Error fetching inventory level for item ${inventoryItemId}:`, error)
        return {
            success: false,
            error: error.message,
            totalAvailable: 0,
            locations: []
        }
    }
}

// Product SKU mapping based on the CSV data provided
const PRODUCT_SKU_MAPPING = {
    // Comfort Insoles (max-comfort-insole handle)
    'Max Comfort Insoles': {
        'Max Cushion|Low|Men\'s 5-5.5 | Women\'s 6-6.5': 'CMXIN1M5',
        'Max Cushion|Low|Men\'s 6-6.5 | Women\'s 7-7.5': 'CMXIN1M6',
        'Max Cushion|Low|Men\'s 7-7.5 | Women\'s 8-8.5': 'CMXIN1M7',
        'Max Cushion|Low|Men\'s 8-8.5 | Women\'s 9-9.5': 'CMXIN1M8',
        'Max Cushion|Low|Men\'s 9-9.5 | Women\'s 10-10.5': 'CMXIN1M9',
        'Max Cushion|Low|Men\'s 10-10.5 | Women\'s 11-11.5': 'CMXIN1M10',
        'Max Cushion|Low|Men\'s 11-11.5 | Women\'s 12-12.5': 'CMXIN1M11',
        'Max Cushion|Low|Men\'s 12-12.5 | Women\'s 13-13.5': 'CMXIN1M12',
        'Max Cushion|Low|Men\'s 13-13.5': 'CMXIN1M13',
        'Max Cushion|Low|Men\'s 14-14.5': 'CMXIN1M14',
        'Max Cushion|Low|Men\'s 15-15.5': 'CMXIN1M15',
        'Max Cushion|Low|Men\'s 16-16.5': 'CMXIN1M16',
        'Max Cushion|Low|Men\'s 17-17.5': 'CMXIN1M17',

        'Max Cushion|Medium|Men\'s 5-5.5 | Women\'s 6-6.5': 'CASIN1M5',
        'Max Cushion|Medium|Men\'s 6-6.5 | Women\'s 7-7.5': 'CASIN1M6',
        'Max Cushion|Medium|Men\'s 7-7.5 | Women\'s 8-8.5': 'CASIN1M7',
        'Max Cushion|Medium|Men\'s 8-8.5 | Women\'s 9-9.5': 'CASIN1M8',
        'Max Cushion|Medium|Men\'s 9-9.5 | Women\'s 10-10.5': 'CASIN1M9',
        'Max Cushion|Medium|Men\'s 10-10.5 | Women\'s 11-11.5': 'CASIN1M10',
        'Max Cushion|Medium|Men\'s 11-11.5 | Women\'s 12-12.5': 'CASIN1M11',
        'Max Cushion|Medium|Men\'s 12-12.5 | Women\'s 13-13.5': 'CASIN1M12',
        'Max Cushion|Medium|Men\'s 13-13.5': 'CASIN1M13',
        'Max Cushion|Medium|Men\'s 14-14.5': 'CASIN1M14',
        'Max Cushion|Medium|Men\'s 15-15.5': 'CASIN1M15',

        'Max Cushion|High|Men\'s 5-5.5 | Women\'s 6-6.5': 'MXHIN1M5',
        'Max Cushion|High|Men\'s 6-6.5 | Women\'s 7-7.5': 'MXHIN1M6',
        'Max Cushion|High|Men\'s 7-7.5 | Women\'s 8-8.5': 'MXHIN1M7',
        'Max Cushion|High|Men\'s 8-8.5 | Women\'s 9-9.5': 'MXHIN1M8',
        'Max Cushion|High|Men\'s 9-9.5 | Women\'s 10-10.5': 'MXHIN1M9',
        'Max Cushion|High|Men\'s 10-10.5 | Women\'s 11-11.5': 'MXHIN1M10',
        'Max Cushion|High|Men\'s 11-11.5 | Women\'s 12-12.5': 'MXHIN1M11',
        'Max Cushion|High|Men\'s 12-12.5 | Women\'s 13-13.5': 'MXHIN1M12',
        'Max Cushion|High|Men\'s 13-13.5': 'MXHIN1M13',
        'Max Cushion|High|Men\'s 14-14.5': 'MXHIN1M14',
        'Max Cushion|High|Men\'s 15-15.5': 'MXHIN1M15',

        'Low Profile|Low|Men\'s 5-5.5 | Women\'s 6-6.5': 'CLPIN1M5',
        'Low Profile|Low|Men\'s 6-6.5 | Women\'s 7-7.5': 'CLPIN1M6',
        'Low Profile|Low|Men\'s 7-7.5 | Women\'s 8-8.5': 'CLPIN1M7',
        'Low Profile|Low|Men\'s 8-8.5 | Women\'s 9-9.5': 'CLPIN1M8',
        'Low Profile|Low|Men\'s 9-9.5 | Women\'s 10-10.5': 'CLPIN1M9',
        'Low Profile|Low|Men\'s 10-10.5 | Women\'s 11-11.5': 'CLPIN1M10',
        'Low Profile|Low|Men\'s 11-11.5 | Women\'s 12-12.5': 'CLPIN1M11',
        'Low Profile|Low|Men\'s 12-12.5 | Women\'s 13-13.5': 'CLPIN1M12',
        'Low Profile|Low|Men\'s 13-13.5': 'CLPIN1M13',
        'Low Profile|Low|Men\'s 14-14.5': 'CLPIN1M14',
        'Low Profile|Low|Men\'s 15-15.5': 'CLPIN1M15',

        'Low Profile|Medium|Men\'s 5-5.5 | Women\'s 6-6.5': 'LPMIN1M5',
        'Low Profile|Medium|Men\'s 6-6.5 | Women\'s 7-7.5': 'LPMIN1M6',
        'Low Profile|Medium|Men\'s 7-7.5 | Women\'s 8-8.5': 'LPMIN1M7',
        'Low Profile|Medium|Men\'s 8-8.5 | Women\'s 9-9.5': 'LPMIN1M8',
        'Low Profile|Medium|Men\'s 9-9.5 | Women\'s 10-10.5': 'LPMIN1M9',
        'Low Profile|Medium|Men\'s 10-10.5 | Women\'s 11-11.5': 'LPMIN1M10',
        'Low Profile|Medium|Men\'s 11-11.5 | Women\'s 12-12.5': 'LPMIN1M11',
        'Low Profile|Medium|Men\'s 12-12.5 | Women\'s 13-13.5': 'LPMIN1M12',
        'Low Profile|Medium|Men\'s 13-13.5': 'LPMIN1M13',
        'Low Profile|Medium|Men\'s 14-14.5': 'LPMIN1M14',
        'Low Profile|Medium|Men\'s 15-15.5': 'LPMIN1M15',

        'Low Profile|High|Men\'s 5-5.5 | Women\'s 6-6.5': 'LPHIN1M5',
        'Low Profile|High|Men\'s 6-6.5 | Women\'s 7-7.5': 'LPHIN1M6',
        'Low Profile|High|Men\'s 7-7.5 | Women\'s 8-8.5': 'LPHIN1M7',
        'Low Profile|High|Men\'s 8-8.5 | Women\'s 9-9.5': 'LPHIN1M8',
        'Low Profile|High|Men\'s 9-9.5 | Women\'s 10-10.5': 'LPHIN1M9',
        'Low Profile|High|Men\'s 10-10.5 | Women\'s 11-11.5': 'LPHIN1M10',
        'Low Profile|High|Men\'s 11-11.5 | Women\'s 12-12.5': 'LPHIN1M11',
        'Low Profile|High|Men\'s 12-12.5 | Women\'s 13-13.5': 'LPHIN1M12',
        'Low Profile|High|Men\'s 13-13.5': 'LPHIN1M13',
        'Low Profile|High|Men\'s 14-14.5': 'LPHIN1M14',
        'Low Profile|High|Men\'s 15-15.5': 'LPHIN1M15'
    },

    // NonSlip 'FoamLock' Performance Insoles (nonslip-insoles handle)
    'NonSlip \'FoamLock\' Performance Insoles': {
        'Max Cushion|Low|Men\'s 5-5.5 | Women\'s 6-6.5': 'KMXIN1M5',
        'Max Cushion|Low|Men\'s 6-6.5 | Women\'s 7-7.5': 'KMXIN1M6',
        'Max Cushion|Low|Men\'s 7-7.5 | Women\'s 8-8.5': 'KMXIN1M7',
        'Max Cushion|Low|Men\'s 8-8.5 | Women\'s 9-9.5': 'KMXIN1M8',
        'Max Cushion|Low|Men\'s 9-9.5 | Women\'s 10-10.5': 'KMXIN1M9',
        'Max Cushion|Low|Men\'s 10-10.5 | Women\'s 11-11.5': 'KMXIN1M10',
        'Max Cushion|Low|Men\'s 11-11.5 | Women\'s 12-12.5': 'KMXIN1M11',
        'Max Cushion|Low|Men\'s 12-12.5 | Women\'s 13-13.5': 'KMXIN1M12',
        'Max Cushion|Low|Men\'s 13-13.5': 'KMXIN1M13',
        'Max Cushion|Low|Men\'s 14-14.5': 'KMXIN1M14',
        'Max Cushion|Low|Men\'s 15-15.5': 'KMXIN1M15',
        'Max Cushion|Low|Men\'s 16-16.5': 'KMXIN1M16',
        'Max Cushion|Low|Men\'s 17-17.5': 'KMXIN1M17',

        'Max Cushion|Medium|Men\'s 5-5.5 | Women\'s 6-6.5': 'KASIN1M5',
        'Max Cushion|Medium|Men\'s 6-6.5 | Women\'s 7-7.5': 'KASIN1M6',
        'Max Cushion|Medium|Men\'s 7-7.5 | Women\'s 8-8.5': 'KASIN1M7',
        'Max Cushion|Medium|Men\'s 8-8.5 | Women\'s 9-9.5': 'KASIN1M8',
        'Max Cushion|Medium|Men\'s 9-9.5 | Women\'s 10-10.5': 'KASIN1M9',
        'Max Cushion|Medium|Men\'s 10-10.5 | Women\'s 11-11.5': 'KASIN1M10',
        'Max Cushion|Medium|Men\'s 11-11.5 | Women\'s 12-12.5': 'KASIN1M11',
        'Max Cushion|Medium|Men\'s 12-12.5 | Women\'s 13-13.5': 'KASIN1M12',
        'Max Cushion|Medium|Men\'s 13-13.5': 'KASIN1M13',
        'Max Cushion|Medium|Men\'s 14-14.5': 'KASIN1M14',
        'Max Cushion|Medium|Men\'s 15-15.5': 'KASIN1M15',

        'Max Cushion|High|Men\'s 5-5.5 | Women\'s 6-6.5': 'KMXHIN1M5',
        'Max Cushion|High|Men\'s 6-6.5 | Women\'s 7-7.5': 'KMXHIN1M6',
        'Max Cushion|High|Men\'s 7-7.5 | Women\'s 8-8.5': 'KMXHIN1M7',
        'Max Cushion|High|Men\'s 8-8.5 | Women\'s 9-9.5': 'KMXHIN1M8',
        'Max Cushion|High|Men\'s 9-9.5 | Women\'s 10-10.5': 'KMXHIN1M9',
        'Max Cushion|High|Men\'s 10-10.5 | Women\'s 11-11.5': 'KMXHIN1M10',
        'Max Cushion|High|Men\'s 11-11.5 | Women\'s 12-12.5': 'KMXHIN1M11',
        'Max Cushion|High|Men\'s 12-12.5 | Women\'s 13-13.5': 'KMXHIN1M12',
        'Max Cushion|High|Men\'s 13-13.5': 'KMXHIN1M13',
        'Max Cushion|High|Men\'s 14-14.5': 'KMXHIN1M14',
        'Max Cushion|High|Men\'s 15-15.5': 'KMXHIN1M15',

        'Low Profile|Low|Men\'s 5-5.5 | Women\'s 6-6.5': 'KLPIN1M5',
        'Low Profile|Low|Men\'s 6-6.5 | Women\'s 7-7.5': 'KLPIN1M6',
        'Low Profile|Low|Men\'s 7-7.5 | Women\'s 8-8.5': 'KLPIN1M7',
        'Low Profile|Low|Men\'s 8-8.5 | Women\'s 9-9.5': 'KLPIN1M8',
        'Low Profile|Low|Men\'s 9-9.5 | Women\'s 10-10.5': 'KLPIN1M9',
        'Low Profile|Low|Men\'s 10-10.5 | Women\'s 11-11.5': 'KLPIN1M10',
        'Low Profile|Low|Men\'s 11-11.5 | Women\'s 12-12.5': 'KLPIN1M11',
        'Low Profile|Low|Men\'s 12-12.5 | Women\'s 13-13.5': 'KLPIN1M12',
        'Low Profile|Low|Men\'s 13-13.5': 'KLPIN1M13',
        'Low Profile|Low|Men\'s 14-14.5': 'KLPIN1M14',
        'Low Profile|Low|Men\'s 15-15.5': 'KLPIN1M15',

        'Low Profile|Medium|Men\'s 5-5.5 | Women\'s 6-6.5': 'KLPMIN1M5',
        'Low Profile|Medium|Men\'s 6-6.5 | Women\'s 7-7.5': 'KLPMIN1M6',
        'Low Profile|Medium|Men\'s 7-7.5 | Women\'s 8-8.5': 'KLPMIN1M7',
        'Low Profile|Medium|Men\'s 8-8.5 | Women\'s 9-9.5': 'KLPMIN1M8',
        'Low Profile|Medium|Men\'s 9-9.5 | Women\'s 10-10.5': 'KLPMIN1M9',
        'Low Profile|Medium|Men\'s 10-10.5 | Women\'s 11-11.5': 'KLPMIN1M10',
        'Low Profile|Medium|Men\'s 11-11.5 | Women\'s 12-12.5': 'KLPMIN1M11',
        'Low Profile|Medium|Men\'s 12-12.5 | Women\'s 13-13.5': 'KLPMIN1M12',
        'Low Profile|Medium|Men\'s 13-13.5': 'KLPMIN1M13',
        'Low Profile|Medium|Men\'s 14-14.5': 'KLPMIN1M14',
        'Low Profile|Medium|Men\'s 15-15.5': 'KLPMIN1M15',

        'Low Profile|High|Men\'s 5-5.5 | Women\'s 6-6.5': 'KLPHIN1M5',
        'Low Profile|High|Men\'s 6-6.5 | Women\'s 7-7.5': 'KLPHIN1M6',
        'Low Profile|High|Men\'s 7-7.5 | Women\'s 8-8.5': 'KLPHIN1M7',
        'Low Profile|High|Men\'s 8-8.5 | Women\'s 9-9.5': 'KLPHIN1M8',
        'Low Profile|High|Men\'s 9-9.5 | Women\'s 10-10.5': 'KLPHIN1M9',
        'Low Profile|High|Men\'s 10-10.5 | Women\'s 11-11.5': 'KLPHIN1M10',
        'Low Profile|High|Men\'s 11-11.5 | Women\'s 12-12.5': 'KLPHIN1M11',
        'Low Profile|High|Men\'s 12-12.5 | Women\'s 13-13.5': 'KLPHIN1M12',
        'Low Profile|High|Men\'s 13-13.5': 'KLPHIN1M13',
        'Low Profile|High|Men\'s 14-14.5': 'KLPHIN1M14',
        'Low Profile|High|Men\'s 15-15.5': 'KLPHIN1M15'
    },

    // Fleks East Beach Slides
    'Fleks® East Beach Slides': {
        'Blu Blue|Women\'s 5 | Men\'s 4': '808-1BLUW5',
        'Blu Blue|Women\'s 6 | Men\'s 5': '808-1BLUW6',
        'Blu Blue|Women\'s 7 | Men\'s 6': '808-1BLUW7',
        'Blu Blue|Women\'s 8 | Men\'s 7': '808-1BLUW8',
        'Blu Blue|Women\'s 9 | Men\'s 8': '808-1BLUW9',
        'Blu Blue|Women\'s 10 | Men\'s 9': '808-1BLUW10',
        'Blu Blue|Women\'s 11 | Men\'s 10': '808-1BLUW11',
        'Blu Blue|Women\'s 12 | Men\'s 11': '808-1BLUW12',
        'Blu Blue|Women\'s 13 | Men\'s 12': '808-1BLUW13',
        'Blu Blue|Women\'s 14 | Men\'s 13': '808-1BLUW14',
        'Blu Blue|Women\'s 15 | Men\'s 14': '808-1BLUW15',
        'Blu Blue|Women\'s 16 | Men\'s 15': '808-1BLUW16',

        'Deep Blue Sea|Women\'s 5 | Men\'s 4': '808-1DBSW5',
        'Deep Blue Sea|Women\'s 6 | Men\'s 5': '808-1DBSW6',
        'Deep Blue Sea|Women\'s 7 | Men\'s 6': '808-1DBSW7',
        'Deep Blue Sea|Women\'s 8 | Men\'s 7': '808-1DBSW8',
        'Deep Blue Sea|Women\'s 9 | Men\'s 8': '808-1DBSW9',
        'Deep Blue Sea|Women\'s 10 | Men\'s 9': '808-1DBSW10',
        'Deep Blue Sea|Women\'s 11 | Men\'s 10': '808-1DBSW11',
        'Deep Blue Sea|Women\'s 12 | Men\'s 11': '808-1DBSW12',
        'Deep Blue Sea|Women\'s 13 | Men\'s 12': '808-1DBSW13',
        'Deep Blue Sea|Women\'s 14 | Men\'s 13': '808-1DBSW14',
        'Deep Blue Sea|Women\'s 15 | Men\'s 14': '808-1DBSW15',
        'Deep Blue Sea|Women\'s 16 | Men\'s 15': '808-1DBSW16',

        'Night|Women\'s 5 | Men\'s 4': '808-1NGTW5',
        'Night|Women\'s 6 | Men\'s 5': '808-1NGTW6',
        'Night|Women\'s 7 | Men\'s 6': '808-1NGTW7',
        'Night|Women\'s 8 | Men\'s 7': '808-1NGTW8',
        'Night|Women\'s 9 | Men\'s 8': '808-1NGTW9',
        'Night|Women\'s 10 | Men\'s 9': '808-1NGTW10',
        'Night|Women\'s 11 | Men\'s 10': '808-1NGTW11',
        'Night|Women\'s 12 | Men\'s 11': '808-1NGTW12',
        'Night|Women\'s 13 | Men\'s 12': '808-1NGTW13',
        'Night|Women\'s 14 | Men\'s 13': '808-1NGTW14',
        'Night|Women\'s 15 | Men\'s 14': '808-1NGTW15',
        'Night|Women\'s 16 | Men\'s 15': '808-1NGTW16',

        'Clear Day|Women\'s 5 | Men\'s 4': '808-1CLDW5',
        'Clear Day|Women\'s 6 | Men\'s 5': '808-1CLDW6',
        'Clear Day|Women\'s 7 | Men\'s 6': '808-1CLDW7',
        'Clear Day|Women\'s 8 | Men\'s 7': '808-1CLDW8',
        'Clear Day|Women\'s 9 | Men\'s 8': '808-1CLDW9',
        'Clear Day|Women\'s 10 | Men\'s 9': '808-1CLDW10',
        'Clear Day|Women\'s 11 | Men\'s 10': '808-1CLDW11',
        'Clear Day|Women\'s 12 | Men\'s 11': '808-1CLDW12',
        'Clear Day|Women\'s 13 | Men\'s 12': '808-1CLDW13',
        'Clear Day|Women\'s 14 | Men\'s 13': '808-1CLDW14',
        'Clear Day|Women\'s 15 | Men\'s 14': '808-1CLDW15',
        'Clear Day|Women\'s 16 | Men\'s 15': '808-1CLDW16',

        'Morning Coffee|Women\'s 5 | Men\'s 4': '808-1MCOW5',
        'Morning Coffee|Women\'s 6 | Men\'s 5': '808-1MCOW6',
        'Morning Coffee|Women\'s 7 | Men\'s 6': '808-1MCOW7',
        'Morning Coffee|Women\'s 8 | Men\'s 7': '808-1MCOW8',
        'Morning Coffee|Women\'s 9 | Men\'s 8': '808-1MCOW9',
        'Morning Coffee|Women\'s 10 | Men\'s 9': '808-1MCOW10',
        'Morning Coffee|Women\'s 11 | Men\'s 10': '808-1MCOW11',
        'Morning Coffee|Women\'s 12 | Men\'s 11': '808-1MCOW12',
        'Morning Coffee|Women\'s 13 | Men\'s 12': '808-1MCOW13',
        'Morning Coffee|Women\'s 14 | Men\'s 13': '808-1MCOW14',
        'Morning Coffee|Women\'s 15 | Men\'s 14': '808-1MCOW15',
        'Morning Coffee|Women\'s 16 | Men\'s 15': '808-1MCOW16',

        'Blushed|Women\'s 5 | Men\'s 4': '808-1BLSW5',
        'Blushed|Women\'s 6 | Men\'s 5': '808-1BLSW6',
        'Blushed|Women\'s 7 | Men\'s 6': '808-1BLSW7',
        'Blushed|Women\'s 8 | Men\'s 7': '808-1BLSW8',
        'Blushed|Women\'s 9 | Men\'s 8': '808-1BLSW9',
        'Blushed|Women\'s 10 | Men\'s 9': '808-1BLSW10',
        'Blushed|Women\'s 11 | Men\'s 10': '808-1BLSW11',
        'Blushed|Women\'s 12 | Men\'s 11': '808-1BLSW12',
        'Blushed|Women\'s 13 | Men\'s 12': '808-1BLSW13',
        'Blushed|Women\'s 14 | Men\'s 13': '808-1BLSW14',
        'Blushed|Women\'s 15 | Men\'s 14': '808-1BLSW15',
        'Blushed|Women\'s 16 | Men\'s 15': '808-1BLSW16',

        'Starfish|Women\'s 5 | Men\'s 4': '808-1STRW5',
        'Starfish|Women\'s 6 | Men\'s 5': '808-1STRW6',
        'Starfish|Women\'s 7 | Men\'s 6': '808-1STRW7',
        'Starfish|Women\'s 8 | Men\'s 7': '808-1STRW8',
        'Starfish|Women\'s 9 | Men\'s 8': '808-1STRW9',
        'Starfish|Women\'s 10 | Men\'s 9': '808-1STRW10',
        'Starfish|Women\'s 11 | Men\'s 10': '808-1STRW11',
        'Starfish|Women\'s 12 | Men\'s 11': '808-1STRW12',
        'Starfish|Women\'s 13 | Men\'s 12': '808-1STRW13',
        'Starfish|Women\'s 14 | Men\'s 13': '808-1STRW14',
        'Starfish|Women\'s 15 | Men\'s 14': '808-1STRW15',
        'Starfish|Women\'s 16 | Men\'s 15': '808-1STRW16'
    },

    // NonSlip Carbon Elite Insole
    'NonSlip Carbon Elite Insole': {
        'Men\'s 5-5.5 | Women\'s 6-6.5': 'KMXCEINM5',
        'Men\'s 6-6.5 | Women\'s 7-7.5': 'KMXCEINM6',
        'Men\'s 7-7.5 | Women\'s 8-8.5': 'KMXCEINM7',
        'Men\'s 8-8.5 | Women\'s 9-9.5': 'KMXCEINM8',
        'Men\'s 9-9.5 | Women\'s 10-10.5': 'KMXCEINM9',
        'Men\'s 10-10.5 | Women\'s 11-11.5': 'KMXCEINM10',
        'Men\'s 11-11.5 | Women\'s 12-12.5': 'KMXCEINM11',
        'Men\'s 12-12.5 | Women\'s 13-13.5': 'KMXCEINM12',
        'Men\'s 13-13.5': 'KMXCEINM13',
        'Men\'s 14-14.5': 'KMXCEINM14',
        'Men\'s 15-15.5': 'KMXCEINM15'
    }
}

// Parse bundle properties and convert to SKU-based line items
function parsePropertiesToSKUs (properties) {
    const lineItems = []

    // Group properties by product
    const productGroups = groupPropertiesByProduct(properties)

    for (const [productName, productProperties] of Object.entries(productGroups)) {
        console.log(`Processing product: ${productName}`, productProperties)

        const sku = findSKUForProduct(productName, productProperties)
        if (sku) {
            lineItems.push({
                sku: sku,
                quantity: 1,
                properties: convertToOriginalProperties(productName, productProperties)
            })
            console.log(`Found SKU ${sku} for ${productName}`)
        } else {
            console.log(`No SKU found for ${productName} with options:`, productProperties)
        }
    }

    return lineItems
}

// Group properties by product name
function groupPropertiesByProduct (properties) {
    const groups = {}

    for (const [key, value] of Object.entries(properties)) {
        // Parse property key format: "Product Name: Option Type"
        const match = key.match(/^(.+?):\s*(.+)$/)
        if (match) {
            const productName = match[1].trim()
            const optionType = match[2].trim()

            if (!groups[productName]) {
                groups[productName] = {}
            }
            groups[productName][optionType] = value
        }
    }

    return groups
}

// Find SKU for a specific product and options
function findSKUForProduct (productName, selectedOptions) {
    const productMapping = PRODUCT_SKU_MAPPING[productName]

    if (!productMapping) {
        console.log(`No SKU mapping found for product: ${productName}`)
        return null
    }

    // Create variant key based on product structure
    let variantKey

    if (productName === 'Max Comfort Insoles' || productName === 'NonSlip \'FoamLock\' Performance Insoles') {
        // Format: Profile|Arch Support|Size
        const profile = selectedOptions['Profile']
        const archSupport = selectedOptions['Arch Support']
        const size = selectedOptions['Size']

        if (profile && archSupport && size) {
            variantKey = `${profile}|${archSupport}|${size}`
        }
    } else if (productName === 'Fleks® East Beach Slides') {
        // Format: Color|Size
        const color = selectedOptions['Color']
        const size = selectedOptions['Size']

        if (color && size) {
            variantKey = `${color}|${size}`
        }
    } else if (productName === 'NonSlip Carbon Elite Insole') {
        // Format: Size only
        const size = selectedOptions['Size']

        if (size) {
            variantKey = size
        }
    }

    if (variantKey && productMapping[variantKey]) {
        return productMapping[variantKey]
    }

    console.log(`No SKU mapping found for key: ${variantKey} in product: ${productName}`)
    console.log('Available keys:', Object.keys(productMapping))

    return null
}

// Convert selected options back to Shopify properties array format
function convertToOriginalProperties (productName, selectedOptions) {
    const properties = []

    for (const [optionType, value] of Object.entries(selectedOptions)) {
        const propertyName = `${productName}: ${optionType}`
        properties.push({
            name: propertyName,
            value: value
        })
    }

    return properties
}