/**
 * file: nerdlets/migration-ui/analyzer.js
 */

export const assessScript = (scriptText) => {
    if (!scriptText) return { status: 'UNKNOWN', issues: ['Could not retrieve script content'] };

    const issues = [];
    const text = scriptText; // shorter alias

    // --- CRITICAL FAILURES (Code will definitely crash) ---

    // 1. Deprecated HTTP Clients (Removed in Node 16/18)
    if (match(text, /require\s*\(['"]request['"]\)/)) {
        issues.push("CRITICAL: Uses 'request' module (Removed in Node 16+). Migrate to 'got' or '$http'.");
    }
    if (match(text, /require\s*\(['"]unirest['"]\)/)) {
        issues.push("CRITICAL: Uses 'unirest' (Likely incompatible with Node 18+ SSL logic).");
    }

    // 2. Selenium Legacy Control Flow (Promise Manager)
    // If we see Selenium commands but NO async/await, it's a legacy script.
    const hasSelenium = text.includes('$browser') || text.includes('$driver');
    const hasAsync = text.includes('async function') || text.includes('await ');
    
    if (hasSelenium && !hasAsync) {
        issues.push("CRITICAL: Legacy Control Flow detected. Selenium 4 requires 'async/await' for all driver interactions.");
    }

    // --- WARNINGS (Code might run but is fragile) ---

    // 3. Legacy Promise Libraries
    if (match(text, /require\s*\(['"]bluebird['"]\)/)) {
        issues.push("WARNING: Uses 'bluebird'. Native Promises are preferred in Node 22.");
    }

    // 4. Crypto/MD5 Legacy
    if (text.includes('createHash') && text.includes('md5')) {
        issues.push("WARNING: MD5 hashing changes in Node 17+. Ensure you aren't using legacy crypto providers.");
    }

    // 5. Old URL Parser
    if (text.includes('url.parse(')) {
        issues.push("WARNING: 'url.parse' is deprecated. Use the new 'URL()' constructor.");
    }

    return {
        status: issues.some(i => i.startsWith("CRITICAL")) ? 'FAIL' : (issues.length > 0 ? 'WARN' : 'PASS'),
        issues: issues,
        timestamp: new Date().toISOString()
    };
};

// Helper for cleaner regex matching
function match(text, regex) {
    return regex.test(text);
}