// scripts/fetch-prices.js
// Fetches real flight prices from Amadeus API for the next 10 weeks
// of Thursday (CGH->CWB, after 19h) + Sunday (CWB->CGH, after 18h) combos.
// Writes output to data/prices.json for the front-end to consume.
//
// v2 — 2026-03-01: Production API with test fallback, removed nonStop constraint,
//       improved LATAM carrier handling (JJ + LA), added retry logic,
//       relaxed time filters as fallback, better logging.
//
// Usage: AMADEUS_KEY=xxx AMADEUS_SECRET=yyy node scripts/fetch-prices.js
// Optional: AMADEUS_ENV=test to force test API (synthetic prices)

const fs = require('fs');

const KEY  = process.env.AMADEUS_KEY;
const SECRET = process.env.AMADEUS_SECRET;
const ENV = (process.env.AMADEUS_ENV || 'production').toLowerCase();

const WEEKS = 10;
const MIN_HOUR_IDA   = 19;
const MIN_HOUR_VOLTA = 18;
const ORIG = 'CGH';
const DEST = 'CWB';

// Production API returns real market prices; test returns synthetic data
const API_HOSTS = {
        production: 'https://api.amadeus.com',
        test: 'https://test.api.amadeus.com'
};

let API_BASE = API_HOSTS[ENV] || API_HOSTS.production;
let apiSource = ENV; // track which API we actually used

async function getToken(host) {
        const res = await fetch(host + '/v1/security/oauth2/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: `grant_type=client_credentials&client_id=${KEY}&client_secret=${SECRET}`
        });
        if (!res.ok) {
                    const body = await res.text();
                    throw new Error('Auth failed (' + host + '): ' + res.status + ' — ' + body.slice(0, 200));
        }
        const json = await res.json();
        return json.access_token;
}

async function authenticate() {
        // Try production first, fall back to test if credentials are test-only
    if (ENV === 'test') {
                console.log('Using test API (forced via AMADEUS_ENV)');
                return await getToken(API_HOSTS.test);
    }

    try {
                console.log('Trying production API...');
                const token = await getToken(API_HOSTS.production);
                API_BASE = API_HOSTS.production;
                apiSource = 'production';
                console.log('✓ Production API authenticated');
                return token;
    } catch (e) {
                console.warn('Production auth failed: ' + e.message);
                console.log('Falling back to test API...');
                try {
                                const token = await getToken(API_HOSTS.test);
                                API_BASE = API_HOSTS.test;
                                apiSource = 'test';
                                console.log('✓ Test API authenticated (prices will be synthetic)');
                                return token;
                } catch (e2) {
                                throw new Error('Both production and test auth failed. Check AMADEUS_KEY/SECRET.');
                }
    }
}

async function searchFlights(token, orig, dest, date, retries = 2) {
        const url = new URL(API_BASE + '/v2/shopping/flight-offers');
        url.searchParams.set('originLocationCode', orig);
        url.searchParams.set('destinationLocationCode', dest);
        url.searchParams.set('departureDate', date);
        url.searchParams.set('adults', '1');
        url.searchParams.set('currencyCode', 'BRL');
        url.searchParams.set('max', '50');

    for (let attempt = 0; attempt <= retries; attempt++) {
                try {
                                const res = await fetch(url.toString(), {
                                                    headers: { Authorization: 'Bearer ' + token }
                                });

                    if (res.status === 429) {
                                        const wait = Math.pow(2, attempt + 1) * 1000;
                                        console.warn('  Rate limited, waiting ' + (wait/1000) + 's...');
                                        await delay(wait);
                                        continue;
                    }

                    if (!res.ok) {
                                        console.warn('  Warning: ' + orig + '->' + dest + ' ' + date + ': HTTP ' + res.status);
                                        if (attempt < retries) { await delay(2000); continue; }
                                        return [];
                    }

                    const json = await res.json();
                                return (json.data || []).map(offer => {
                                                    const itin = offer.itineraries[0];
                                                    const seg = itin && itin.segments[0];
                                                    const numStops = itin ? itin.segments.length - 1 : 0;

                                                                             // Carrier: prefer operating carrier, then marketing, then validating
                                                                             const carrier = (seg && seg.operating && seg.operating.carrierCode)
                                                        || (seg && seg.carrierCode)
                                                        || (offer.validatingAirlineCodes && offer.validatingAirlineCodes[0])
                                                        || '??';

                                                                             return {
                                                                                                     price: parseFloat(offer.price.grandTotal || offer.price.total),
                                                                                                     airline: carrier,
                                                                                                     departure: seg && seg.departure && seg.departure.at || null,
                                                                                                     arrival: seg && seg.arrival && seg.arrival.at || null,
                                                                                                     stops: numStops
                                                                             };
                                });
                } catch (e) {
                                if (attempt < retries) {
                                                    console.warn('  Fetch error, retrying...', e.message);
                                                    await delay(2000);
                                                    continue;
                                }
                                console.error('  Search failed after retries:', e.message);
                                return [];
                }
    }
        return [];
}

function fmtISO(d) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return y + '-' + m + '-' + day;
}

function getNextThursdays(count) {
        const dates = [];
        const today = new Date();
        const dow = today.getDay();
        const diff = (4 - dow + 7) % 7 || 7;
        for (let i = 0; i < count; i++) {
                    const d = new Date(today);
                    d.setDate(today.getDate() + diff + i * 7);
                    dates.push(d);
        }
        return dates;
}

// Map all known carrier codes to display names
const CIA_MAP = {
        G3: 'GOL', JJ: 'LATAM', LA: 'LATAM', AD: 'Azul', '2Z': 'GOL'
};
const CIA_CODES = ['G3', 'LA', 'JJ', 'AD'];

function normalizeAirline(code) {
        return CIA_MAP[code] || code;
}

function delay(ms) {
        return new Promise(r => setTimeout(r, ms));
}

(async () => {
        console.log('=== Flight Price Fetcher v2 ===');
        console.log('Route: ' + ORIG + ' <-> ' + DEST + ' | Weeks: ' + WEEKS);
        console.log('');

     const token = await authenticate();
        console.log('');

     const thursdays = getNextThursdays(WEEKS);
        const weeks = [];

     for (const thu of thursdays) {
                 const sun = new Date(thu);
                 sun.setDate(thu.getDate() + 3);
                 const thuISO = fmtISO(thu);
                 const sunISO = fmtISO(sun);

            console.log('--- ' + thuISO + ' (Thu) -> ' + sunISO + ' (Sun) ---');

            const [idaAll, voltaAll] = await Promise.all([
                            searchFlights(token, ORIG, DEST, thuISO),
                            searchFlights(token, DEST, ORIG, sunISO)
                        ]);

            console.log('  Raw: ida=' + idaAll.length + ' volta=' + voltaAll.length);

            // Prefer non-stop flights
            const idaNonstop = idaAll.filter(o => o.stops === 0);
                 const voltaNonstop = voltaAll.filter(o => o.stops === 0);

            // Time filter helper
            const filterByTime = (offers, minHour) => offers.filter(o => {
                            if (!o.departure) return false;
                            return parseInt(o.departure.slice(11, 13)) >= minHour;
            });

            // Use nonstop if available, otherwise all flights
            const idaPool = idaNonstop.length > 0 ? idaNonstop : idaAll;
                 const voltaPool = voltaNonstop.length > 0 ? voltaNonstop : voltaAll;

            // Try strict time filter first
            let idaFinal = filterByTime(idaPool, MIN_HOUR_IDA);
                 let voltaFinal = filterByTime(voltaPool, MIN_HOUR_VOLTA);

            // Relax by 2h if needed
            if (idaFinal.length === 0 && idaPool.length > 0) {
                            idaFinal = filterByTime(idaPool, MIN_HOUR_IDA - 2);
                            if (idaFinal.length > 0) console.log('  Relaxed ida to >=' + (MIN_HOUR_IDA - 2) + 'h');
            }
                 if (voltaFinal.length === 0 && voltaPool.length > 0) {
                                 voltaFinal = filterByTime(voltaPool, MIN_HOUR_VOLTA - 2);
                                 if (voltaFinal.length > 0) console.log('  Relaxed volta to >=' + (MIN_HOUR_VOLTA - 2) + 'h');
                 }

            // Last resort: use any flight regardless of time
            if (idaFinal.length === 0 && idaAll.length > 0) {
                            idaFinal = [...idaAll].sort((a, b) => a.price - b.price).slice(0, 10);
                            console.log('  Using all ida flights (no evening options)');
            }
                 if (voltaFinal.length === 0 && voltaAll.length > 0) {
                                 voltaFinal = [...voltaAll].sort((a, b) => a.price - b.price).slice(0, 10);
                                 console.log('  Using all volta flights (no evening options)');
                 }

            console.log('  Final: ida=' + idaFinal.length + ' volta=' + voltaFinal.length +
                                    ' | nonstop: ida=' + idaNonstop.length + ' volta=' + voltaNonstop.length);

            const allAirlines = new Set([...idaFinal.map(o => o.airline), ...voltaFinal.map(o => o.airline)]);
                 console.log('  Airlines: ' + [...allAirlines].map(a => a + '(' + normalizeAirline(a) + ')').join(', '));

            // Build combos per airline
            const combos = [];
                 const processedNames = new Set();

            for (const code of CIA_CODES) {
                            const name = normalizeAirline(code);
                            if (processedNames.has(name)) continue;
                            processedNames.add(name);

                     const codes = CIA_CODES.filter(c => normalizeAirline(c) === name);

                     const bestIda = idaFinal
                                .filter(o => codes.includes(o.airline))
                                .sort((a, b) => a.price - b.price)[0];
                            const bestVolta = voltaFinal
                                .filter(o => codes.includes(o.airline))
                                .sort((a, b) => a.price - b.price)[0];

                     if (bestIda && bestVolta) {
                                         combos.push({
                                                                 airline: name,
                                                                 airlineCode: code === 'JJ' ? 'LA' : code,
                                                                 idaPrice: bestIda.price,
                                                                 voltaPrice: bestVolta.price,
                                                                 totalPrice: +(bestIda.price + bestVolta.price).toFixed(2),
                                                                 idaDeparture: bestIda.departure,
                                                                 voltaDeparture: bestVolta.departure,
                                                                 idaStops: bestIda.stops || 0,
                                                                 voltaStops: bestVolta.stops || 0
                                         });
                                         const tag = (bestIda.stops || bestVolta.stops) ? ' (connection)' : ' (nonstop)';
                                         console.log('  ✓ ' + name + ': R$' + bestIda.price.toFixed(2) + ' + R$' + bestVolta.price.toFixed(2) + ' = R$' + (bestIda.price + bestVolta.price).toFixed(2) + tag);
                     } else {
                                         console.log('  ✗ ' + name + ': incomplete (ida:' + idaFinal.filter(o => codes.includes(o.airline)).length + ' volta:' + voltaFinal.filter(o => codes.includes(o.airline)).length + ')');
                     }
            }

            // Mixed carrier combo
            const cheapestIda = [...idaFinal].sort((a, b) => a.price - b.price)[0];
                 const cheapestVolta = [...voltaFinal].sort((a, b) => a.price - b.price)[0];

            if (cheapestIda && cheapestVolta) {
                            const idaName = normalizeAirline(cheapestIda.airline);
                            const voltaName = normalizeAirline(cheapestVolta.airline);
                            const mixedTotal = +(cheapestIda.price + cheapestVolta.price).toFixed(2);
                            const bestSingle = combos.length ? Math.min(...combos.map(c => c.totalPrice)) : Infinity;

                     if (idaName !== voltaName && mixedTotal < bestSingle) {
                                         combos.push({
                                                                 airline: idaName + '+' + voltaName,
                                                                 airlineCode: 'MIX',
                                                                 idaPrice: cheapestIda.price,
                                                                 voltaPrice: cheapestVolta.price,
                                                                 totalPrice: mixedTotal,
                                                                 idaDeparture: cheapestIda.departure,
                                                                 voltaDeparture: cheapestVolta.departure,
                                                                 idaStops: cheapestIda.stops || 0,
                                                                 voltaStops: cheapestVolta.stops || 0,
                                                                 mixed: true
                                         });
                                         console.log('  ✓ MIX (' + idaName + '+' + voltaName + '): R$' + mixedTotal.toFixed(2));
                     }
            }

            if (combos.length === 0) console.log('  ⚠ No combos found!');

            weeks.push({
                            thursday: thuISO,
                            sunday: sunISO,
                            updatedAt: new Date().toISOString(),
                            combos: combos.sort((a, b) => a.totalPrice - b.totalPrice)
            });

            await delay(1500);
     }

     const output = {
                 generatedAt: new Date().toISOString(),
                 apiSource: apiSource, // 'production' or 'test'
                 config: { origin: ORIG, destination: DEST, minHourIda: MIN_HOUR_IDA, minHourVolta: MIN_HOUR_VOLTA, weeksAhead: WEEKS },
                 weeks
     };

     fs.mkdirSync('data', { recursive: true });
        fs.writeFileSync('data/prices.json', JSON.stringify(output, null, 2));

     const totalCombos = weeks.reduce((s, w) => s + w.combos.length, 0);
        const emptyWeeks = weeks.filter(w => w.combos.length === 0).length;
        console.log('\n=== Done! ===');
        console.log('API: ' + apiSource + ' | ' + weeks.length + ' weeks | ' + totalCombos + ' combos -> data/prices.json');
        if (emptyWeeks > 0) console.log('⚠ ' + emptyWeeks + ' empty weeks');
        if (apiSource === 'test') console.log('⚠ Using TEST API — prices are synthetic, not real market prices!');
})();
