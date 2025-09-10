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
    } else if (productName === 'Fleks® East Beach Slides') { // Fixed: Added ® symbol
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