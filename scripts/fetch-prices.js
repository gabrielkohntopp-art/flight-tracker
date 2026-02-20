// scripts/fetch-prices.js
// Fetches real flight prices from Amadeus API for the next 10 weeks
// of Thursday (CGH->CWB, after 19h) + Sunday (CWB->CGH, after 18h) combos.
// Writes output to data/prices.json for the front-end to consume.
//
// Usage: AMADEUS_KEY=xxx AMADEUS_SECRET=yyy node scripts/fetch-prices.js

const fs = require('fs');

const KEY = process.env.AMADEUS_KEY;
const SECRET = process.env.AMADEUS_SECRET;
const WEEKS = 10;
const MIN_HOUR_IDA = 19;
const MIN_HOUR_VOLTA = 18;
const ORIG = 'CGH';
const DEST = 'CWB';

async function getToken() {
  const res = await fetch('https://api.amadeus.com/v1/security/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${KEY}&client_secret=${SECRET}`
  });
  if (!res.ok) throw new Error('Auth failed: ' + res.status);
  const json = await res.json();
  return json.access_token;
}

async function searchFlights(token, orig, dest, date) {
  const url = new URL('https://api.amadeus.com/v2/shopping/flight-offers');
  url.searchParams.set('originLocationCode', orig);
  url.searchParams.set('destinationLocationCode', dest);
  url.searchParams.set('departureDate', date);
  url.searchParams.set('adults', '1');
  url.searchParams.set('nonStop', 'true');
  url.searchParams.set('currencyCode', 'BRL');
  url.searchParams.set('max', '20');

  const res = await fetch(url.toString(), {
    headers: { Authorization: 'Bearer ' + token }
  });

  if (!res.ok) {
    console.warn('  Warning: Search failed for ' + orig + '->' + dest + ' on ' + date + ': ' + res.status);
    return [];
  }

  const json = await res.json();
  return (json.data || []).map(offer => {
    const seg = offer.itineraries[0] && offer.itineraries[0].segments[0];
    const carrier = (seg && seg.carrierCode) || (offer.validatingAirlineCodes && offer.validatingAirlineCodes[0]) || '??';
    return {
      price: parseFloat(offer.price.total),
      airline: carrier,
      departure: seg && seg.departure && seg.departure.at || null,
      arrival: seg && seg.arrival && seg.arrival.at || null
    };
  });
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

const CIA_MAP = { G3: 'GOL', JJ: 'LATAM', LA: 'LATAM', AD: 'Azul' };
const CIA_CODES = ['G3', 'LA', 'AD'];

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  console.log('Authenticating with Amadeus...');
  const token = await getToken();
  console.log('Token obtained. Fetching ' + WEEKS + ' weeks of prices...');

  const thursdays = getNextThursdays(WEEKS);
  const weeks = [];

  for (const thu of thursdays) {
    const sun = new Date(thu);
    sun.setDate(thu.getDate() + 3);
    const thuISO = fmtISO(thu);
    const sunISO = fmtISO(sun);

    console.log('Week: ' + thuISO + ' (Thu) -> ' + sunISO + ' (Sun)');

    const [idaAll, voltaAll] = await Promise.all([
      searchFlights(token, ORIG, DEST, thuISO),
      searchFlights(token, DEST, ORIG, sunISO)
    ]);

    console.log('  Ida: ' + idaAll.length + ' offers | Volta: ' + voltaAll.length + ' offers');

    const idaEvening = idaAll.filter(o => {
      if (!o.departure) return false;
      return parseInt(o.departure.slice(11, 13)) >= MIN_HOUR_IDA;
    });

    const voltaEvening = voltaAll.filter(o => {
      if (!o.departure) return false;
      return parseInt(o.departure.slice(11, 13)) >= MIN_HOUR_VOLTA;
    });

    console.log('  After time filter -> Ida: ' + idaEvening.length + ' | Volta: ' + voltaEvening.length);

    const combos = [];
    for (const code of CIA_CODES) {
      const ciaName = CIA_MAP[code];

      const bestIda = idaEvening
        .filter(o => o.airline === code)
        .sort((a, b) => a.price - b.price)[0];

      const bestVolta = voltaEvening
        .filter(o => o.airline === code)
        .sort((a, b) => a.price - b.price)[0];

      if (bestIda && bestVolta) {
        combos.push({
          airline: ciaName,
          airlineCode: code,
          idaPrice: bestIda.price,
          voltaPrice: bestVolta.price,
          totalPrice: +(bestIda.price + bestVolta.price).toFixed(2),
          idaDeparture: bestIda.departure,
          voltaDeparture: bestVolta.departure
        });
        console.log('  ' + ciaName + ': R$ ' + bestIda.price.toFixed(2) + ' + R$ ' + bestVolta.price.toFixed(2) + ' = R$ ' + (bestIda.price + bestVolta.price).toFixed(2));
      } else {
        console.log('  ' + ciaName + ': no evening flights found');
      }
    }

    // Mixed carrier combo (cheapest ida from any + cheapest volta from any)
    const cheapestIda = [...idaEvening].sort((a, b) => a.price - b.price)[0];
    const cheapestVolta = [...voltaEvening].sort((a, b) => a.price - b.price)[0];
    if (cheapestIda && cheapestVolta) {
      const mixedTotal = +(cheapestIda.price + cheapestVolta.price).toFixed(2);
      const bestSingle = combos.length ? Math.min(...combos.map(c => c.totalPrice)) : Infinity;
      if (cheapestIda.airline !== cheapestVolta.airline && mixedTotal < bestSingle) {
        const idaName = CIA_MAP[cheapestIda.airline] || cheapestIda.airline;
        const voltaName = CIA_MAP[cheapestVolta.airline] || cheapestVolta.airline;
        combos.push({
          airline: idaName + '+' + voltaName,
          airlineCode: 'MIX',
          idaPrice: cheapestIda.price,
          voltaPrice: cheapestVolta.price,
          totalPrice: mixedTotal,
          idaDeparture: cheapestIda.departure,
          voltaDeparture: cheapestVolta.departure,
          mixed: true
        });
        console.log('  Mix: R$ ' + mixedTotal.toFixed(2) + ' (' + cheapestIda.airline + ' ida + ' + cheapestVolta.airline + ' volta)');
      }
    }

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
    config: {
      origin: ORIG,
      destination: DEST,
      minHourIda: MIN_HOUR_IDA,
      minHourVolta: MIN_HOUR_VOLTA,
      weeksAhead: WEEKS
    },
    weeks
  };

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/prices.json', JSON.stringify(output, null, 2));

  const totalCombos = weeks.reduce((s, w) => s + w.combos.length, 0);
  console.log('Done! ' + weeks.length + ' weeks, ' + totalCombos + ' combos -> data/prices.json');
})();
