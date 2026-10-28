'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const P = require('../site/pricing.js');
const U = require('../scripts/fetch-prices.js');

test('distributor Azure PAYG has zero SPLA incentive impact without reducing contribution', () => {
  const html = fs.readFileSync(path.join(__dirname, '../site/index.html'), 'utf8');
  const render = html.split('\n').find(line => line.startsWith('function renderDistributorBusiness()'));
  assert.ok(render);
  for (const splaIncentive of [0, 5, 20]) {
    for (const hasDco of [false, true]) {
      const elements = {};
      let chartValues;
      const context = {
        $: id => elements[id] ||= {},
        currency: value => value,
        state: { sql: { currency: 'EUR', rows: [{}] }, windows: { rows: [] } },
        storedPrices: () => ({ splaListEntered: true, resellerPaygEntered: true }),
        distributorRowEconomics: () => ({
          splaRevenue: 120, splaCost: 100, azureRevenue: 160, azureCost: 100,
        }),
        dcoSettings: { splaIncentive, mci: 3, growth: 12, hasDco, dcoRate: 10, passDco: true, dcoShare: 25 },
        drawDistributorBusinessChart: values => { chartValues = Array.from(values); },
      };
      vm.runInNewContext(`${render}\nrenderDistributorBusiness();`, context);
      const expectedSpla = 240 + 1200 * splaIncentive / 100;
      const expectedAzure = 720 + 36 + 144 + (hasDco ? 90 : 0);
      assert.strictEqual(elements.distSplaLoss.textContent, 0);
      assert.strictEqual(elements.distSplaIncentiveValue.textContent, 1200 * splaIncentive / 100);
      assert.strictEqual(elements.distSplaContribution.textContent, expectedSpla);
      assert.strictEqual(elements.distAzureContribution.textContent, expectedAzure);
      assert.deepStrictEqual(chartValues, [1440, expectedSpla, 1920, expectedAzure]);
      const growth = (expectedAzure - expectedSpla) / Math.abs(expectedSpla) * 100;
      assert.strictEqual(elements.distEconomicImpactGrowth.textContent,
        `+${growth.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`);
    }
  }
});

const item = (over) => Object.assign({
  currencyCode: 'USD', unitPrice: 0.1, location: 'Global', meterName: 'm', productName: 'p',
  skuName: '1 Core', serviceName: 's', serviceFamily: 'f', unitOfMeasure: '1 Hour',
  type: 'Consumption', armRegionName: 'global', meterId: 'x',
}, over);

test('buildUrl contains currency and the OData filter', () => {
  const url = P.buildUrl('EUR');
  assert.ok(url.startsWith("https://prices.azure.com/api/retail/prices?currencyCode='EUR'&$filter="));
  assert.strictEqual(decodeURIComponent(url.split('$filter=')[1]), P.API_FILTER);
});

test('covers all currencies from the original query', () => {
  assert.deepStrictEqual(P.CURRENCIES,
    ['USD', 'EUR', 'AUD', 'BRL', 'CAD', 'CHF', 'DKK', 'GBP', 'INR', 'JPY', 'KRW', 'NOK', 'NZD', 'SEK']);
});

test('queries the SQL and Windows Server Arc PAYG products', () => {
  assert.match(P.API_FILTER, /Azure Arc-enabled SQL Server/);
  assert.match(P.API_FILTER, /Az Arc Pay As You Go Windows Server/);
  assert.deepStrictEqual(P.SKU_NAMES,
    ['1 Core', 'Ent edition - PAYG', 'Std edition - PAYG']);
});

test('applyProxy supports placeholder and prefix styles', () => {
  const url = 'https://prices.azure.com/api/retail/prices?a=1';
  assert.strictEqual(P.applyProxy(url, ''), url);
  assert.strictEqual(P.applyProxy(url, 'https://proxy/?'), 'https://proxy/?' + encodeURIComponent(url));
  assert.strictEqual(P.applyProxy(url, 'https://proxy/?url={url}&x=1'),
    'https://proxy/?url=' + encodeURIComponent(url) + '&x=1');
});

test('transform filters, selects columns, sorts and adds refresh time', () => {
  const rows = P.transform([
    item({ serviceName: 'b', productName: 'z' }),
    item({ serviceName: 'a', productName: 'y', skuName: 'Ent edition - PAYG' }),
    item({ type: 'Reservation' }),
    item({ unitOfMeasure: '1/Month' }),
    item({ location: 'EU West' }),
    item({ skuName: 'Other' }),
    item({ serviceName: 'a', productName: 'x', skuName: 'Std edition - PAYG', reservationTerm: '1 Year' }),
  ], 'T');
  assert.deepStrictEqual(rows.map((r) => r.productName), ['x', 'y', 'z']);
  assert.deepStrictEqual(Object.keys(rows[0]), P.COLUMNS.concat('Last Refresh Time'));
  assert.strictEqual(rows[0].reservationTerm, '1 Year');
  assert.strictEqual(rows[1].reservationTerm, null);
  assert.ok(rows.every((r) => r['Last Refresh Time'] === 'T'));
});

test('fetchAll follows NextPageLink for every currency', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    const currency = /currencyCode='(\w+)'/.exec(decodeURIComponent(url))[1];
    const page2 = url.includes('page=2');
    return {
      ok: true,
      json: async () => ({
        Items: [item({ currencyCode: currency, meterName: page2 ? 'p2' : 'p1' })],
        NextPageLink: page2 ? null : `https://prices.azure.com/api/retail/prices?currencyCode='${currency}'&page=2`,
      }),
    };
  };
  const progress = [];
  const result = await P.fetchAll({ currencies: ['USD', 'EUR'], fetch: fakeFetch, onProgress: (p) => progress.push(p.currency) });
  assert.strictEqual(calls.length, 4);
  assert.strictEqual(result.rows.length, 4);
  assert.deepStrictEqual(progress, ['USD', 'EUR']);
  assert.ok(result.refreshTime);
});

test('fetchAll applies proxy to every page and reports HTTP errors', async () => {
  const calls = [];
  await P.fetchAll({
    currencies: ['USD'],
    proxy: 'https://proxy/?',
    fetch: async (url) => {
      calls.push(url);
      return { ok: true, json: async () => ({ Items: [], NextPageLink: calls.length < 2 ? 'https://prices.azure.com/next' : null }) };
    },
  });
  assert.ok(calls.every((u) => u.startsWith('https://proxy/?')));
  await assert.rejects(
    P.fetchAll({ currencies: ['USD'], fetch: async () => ({ ok: false, status: 429 }) }),
    /HTTP 429/);
});

test('toCsv escapes values', () => {
  const csv = P.toCsv([Object.assign(item({ meterName: 'a,"b"' }), { 'Last Refresh Time': 'T' })]);
  const [header, line] = csv.split('\r\n');
  assert.strictEqual(header, P.COLUMNS.concat('Last Refresh Time').join(','));
  assert.ok(line.includes('"a,""b"""'));
});

test('toCsv quotes separators/newlines, renders null as empty and neutralizes formulas', () => {
  const csv = P.toCsv([Object.assign(item({ meterName: 'a;b', productName: 'x\ny', skuName: '=1+1', unitPrice: -1 }),
    { 'Last Refresh Time': 'T' })]);
  const line = csv.slice(csv.indexOf('\r\n') + 2);
  assert.ok(line.includes('"a;b"'));
  assert.ok(line.includes('"x\ny"'));
  assert.ok(line.includes(",'=1+1,"));
  assert.ok(line.startsWith('USD,-1,'));
  assert.ok(line.includes(',,T'));
});

test('buildEmbeddedPrices maps only SQL and Windows Azure prices', () => {
  const rows = P.CURRENCIES.flatMap((currency, index) => [
    item({
      currencyCode: currency,
      productName: U.SQL_PRODUCT,
      meterName: 'Std edition - PAYG',
      unitPrice: index + 0.1,
    }),
    item({
      currencyCode: currency,
      productName: U.SQL_PRODUCT,
      meterName: 'Ent edition - PAYG',
      unitPrice: index + 0.2,
    }),
    item({
      currencyCode: currency,
      productName: U.WINDOWS_PRODUCT,
      meterName: '1 Core License',
      unitPrice: index + 0.3,
    }),
  ]);

  const prices = U.buildEmbeddedPrices(rows, {
    'sql:USD': { spla1: 12, spla2: 34, splaEntered: true },
  });

  assert.deepStrictEqual(prices['sql:USD'], {
    payg1: 0.1,
    payg2: 0.2,
  });
  assert.deepStrictEqual(prices['windows:SEK'], {
    payg1: 13.3,
    payg2: 13.3,
  });
});

test('updateHtml rewrites embedded prices and refresh timestamps', () => {
  const rows = P.CURRENCIES.flatMap((currency) => [
    item({
      currencyCode: currency,
      productName: U.SQL_PRODUCT,
      meterName: 'Std edition - PAYG',
      unitPrice: 1,
    }),
    item({
      currencyCode: currency,
      productName: U.SQL_PRODUCT,
      meterName: 'Ent edition - PAYG',
      unitPrice: 2,
    }),
    item({
      currencyCode: currency,
      productName: U.WINDOWS_PRODUCT,
      meterName: '1 Core License',
      unitPrice: 3,
    }),
  ]);
  const html = [
    '<span id="time">old</span>',
    'const EMBEDDED_PRICES={"sql:USD":{"spla1":4}};',
    "const EMBEDDED_REFRESHED_AT='old';",
  ].join('\n');
  const timestamp = '2026-09-29T22:00:00.000Z';
  const updated = U.updateHtml(html, rows, timestamp);

  assert.match(updated, /"sql:USD":\{"payg1":1,"payg2":2\}/);
  assert.doesNotMatch(updated, /"spla1"|"spla2"|"splaEntered"/);
  assert.match(updated, /"windows:USD":\{"payg1":3,"payg2":3\}/);
  assert.match(updated, /const EMBEDDED_REFRESHED_AT="2026-09-29T22:00:00.000Z";/);
  assert.match(updated, /<span id="time">Azure prices refreshed 2026-09-29T22:00:00.000Z \(UTC\)<\/span>/);
});

test('published estimator uses workflow pricing and offers an offline copy', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'site', 'index.html'), 'utf8');

  assert.doesNotMatch(html, /id="refresh"|fetchAzurePrices|refreshPrices|\/api\/prices/);
  assert.doesNotMatch(html, /id="saveUpdated"|saveUpdatedFile/);
  assert.match(html, /<header[\s\S]*id="saveOffline" hidden[\s\S]*<\/header>/);
  assert.match(html, /function saveOfflineFile\(/);
  assert.match(html, /location\.hostname==='kateiren\.github\.io'/);
  assert.match(html, /location\.pathname\.startsWith\('\/arc-payg-estimator-disti\/'\)/);
  assert.match(html, /id="saveOfflineInstruction" hidden/);
  assert.match(html, /\$\('saveOffline'\)\.hidden=\$\('saveOfflineInstruction'\)\.hidden=!onGitHubPages/);
  assert.match(html, /if\(onGitHubPages\)\$\('saveOffline'\)\.onclick=saveOfflineFile/);
  assert.match(html, /id="offlineNotice"[\s\S]*hidden/);
  assert.match(html, /const OFFLINE_EXPORTED_AT=null;/);
  assert.match(html, /const OFFLINE_EXPORTED_AT=\$\{JSON\.stringify\(new Date\(\)\.toISOString\(\)\)\};/);
  assert.match(html, /offline=location\.protocol==='file:'/);
  assert.match(html, /\$\('offlineNotice'\)\.hidden=!offline/);
  assert.match(html, /https:\/\/kateiren\.github\.io\/arc-payg-estimator-disti\//);
  assert.doesNotMatch(html, /dco-tooltip|dcoTooltip|class="tooltip"|role="tooltip"/);
  assert.match(html, /\.tabs\{display:flex;gap:0;overflow:hidden;border:1px solid var\(--line\);border-radius:11px/);
  assert.match(html, /\.tabs \.tab\{flex:1;border:0;border-radius:0\}/);
  assert.match(html, /\.tabs \.tab\+\.tab\{border-left:1px solid var\(--line\)\}/);
  assert.match(html, /function compact\(v\)\{return new Intl\.NumberFormat\(undefined,\{style:'currency',currency:state\[pane\]\.currency,notation:'compact'/);
  assert.match(html, /const PEC_RATE=\.15;/);
  assert.doesNotMatch(html, /id="pec"/);
  assert.match(html, /reseller SPLA incentives are calculated using the reseller SPLA price\. This overstates the incentive base by the distributor's SPLA markup\./);
  assert.match(html, /PEC is fixed at 15% and deducted only from embedded distributor Azure cost\./);
  assert.doesNotMatch(html, /<span class="pill">PEC applied<\/span>/);
  assert.match(html, /payg:paygC\*HOURS\[r\.uptime\]\*p\['resellerPayg'\+paygIdx\]/);
  assert.doesNotMatch(html, /payg:paygC\*HOURS\[r\.uptime\]\*p\['resellerPayg'\+paygIdx\]\*\(1-PEC_RATE\)/);
  assert.match(html, /function defaultDcoSettings\(\)\{return\{hasDco:false,dcoRate:12,passDco:false,dcoShare:0,splaIncentive:5,mci:3,growth:12\}\}/);
  assert.match(html, /id="hasDco"/);
  assert.strictEqual((html.match(/id="hasDco"/g) || []).length, 1);
  assert.match(html, /id="dcoRate"/);
  assert.match(html, /id="passDco"/);
  assert.match(html, /id="dcoShareField"[\s\S]*hidden/);
  assert.match(html, /Share of DCO to pass along \(%\)/);
  assert.match(html, /id="dcoShare"[^>]*step="1"/);
  assert.match(html, /labels=parts\.map\(x=>x\[2\]\)/);
  assert.match(html, /dco=pa\*dcoSettings\.dcoRate\/100\*dcoShare/);
  assert.match(html, /if\(dcoShare>0\)parts\.push\(\['DCO incentive'/);
  assert.doesNotMatch(html, /s\.hasDco=\$\('hasDco'\)|s\.hasDco\?\.1/);
  assert.match(html, /distributor:JSON\.parse\(JSON\.stringify\(dcoSettings\)\)/);
  assert.match(html, /format:'arc-payg-spla-disti-project'/);
  assert.match(html, /if\(data\?\.format==='arc-payg-spla-project'\)throw Error\('This is a project of the Direct Arc PAYG Estimator'\)/);
  assert.match(html, /data\.format!=='arc-payg-spla-disti-project'/);
  assert.match(html, /projectName:name,currency:state\.sql\.currency,azurePricesRefreshedAt/);
  assert.match(html, /function calculationsSnapshot\(\).*?let\{currency,hasSpla,\.\.\.calculation\}=state\[product\]/);
  assert.match(html, /hasSplaIncentives:hasSpla/);
  assert.match(html, /currency=data\.currency\?\?legacySqlCurrency/);
  assert.match(html, /if\(data\.currency===undefined&&legacyWindowsCurrency!==legacySqlCurrency\)/);
  assert.match(html, /hasSplaIncentives=s\.hasSplaIncentives\?\?s\.hasSpla/);
  assert.match(html, /calculations\[product\]=\{currency,rows,hasSpla:hasSplaIncentives/);
  assert.match(html, /sqlServerStandardSpla:p\.spla1/);
  assert.match(html, /sqlServerEnterprisePayg:p\.payg2/);
  assert.match(html, /windowsServerStandardSpla:p\.spla1/);
  assert.match(html, /windowsServerDatacenterPayg:p\.payg2/);
  assert.doesNotMatch(html, /windowsServerStandardPayg:p\.payg1/);
  assert.doesNotMatch(html, /windowsServerStandardResellerPayg:p\.resellerPayg1/);
  assert.match(html, /sqlServerStandardSpla\?\?p\.spla1/);
  assert.match(html, /payg=p\.windowsServerDatacenterPayg\?\?p\.windowsServerStandardPayg\?\?p\.payg2\?\?p\.payg1/);
  assert.match(html, /resellerPayg=p\.windowsServerDatacenterResellerPayg\?\?p\.windowsServerStandardResellerPayg\?\?p\.resellerPayg2\?\?p\.resellerPayg1/);
  assert.match(html, /payg1:payg,payg2:payg,resellerPayg1:resellerPayg,resellerPayg2:resellerPayg/);
  assert.match(html, /paygIdx=sql\?splaIdx:2/);
  assert.match(html, /p=normalizeProjectPrice\(product,existingPricing\[key\]\);project\.pricing\[key\]\.payg1=p\.payg1;project\.pricing\[key\]\.payg2=p\.payg2/);
  assert.match(html, /id="distSplaIncentive"/);
  assert.match(html, /Your average incentives on SLA \(%\)/);
  assert.match(html, /Non-Named Hoster&#10;- SQL SE 4%&#10;- SQL EE 7%&#10;&#10;Named Hoster&#10;- SQL SE 3%&#10;- SQL EE 3%/);
  assert.match(html, /id="distMci"/);
  assert.match(html, /id="distGrowth"/);
  assert.match(html, /function distributorRowEconomics\(/);
  assert.match(html, /azureRevenue:paygC\*hours\*p\['resellerPayg'\+paygIdx\],azureCost:/);
  assert.doesNotMatch(html, /azureRevenue:paygC\*hours\*p\['resellerPayg'\+paygIdx\]\*\(1-PEC_RATE\)/);
  assert.match(html, /azureCost:paygC\*hours\*p\['payg'\+paygIdx\]\*\(1-PEC_RATE\)/);
  assert.match(html, /splaContribution=splaBaseGrossProfit\+splaIncentive/);
  assert.match(html, /azureContribution=azureBaseGrossProfit\+mci\+growth\+retainedDco/);
  assert.match(html, /show\('distSplaLoss',0\)/);
  assert.match(html, /id="distEconomicImpactGrowth"/);
  assert.match(html, /economicImpactGrowth=splaContribution===0\?null:\(azureContribution-splaContribution\)\/Math\.abs\(splaContribution\)\*100/);
  assert.match(html, /economicImpactGrowth===null\?'Not available'/);
  assert.match(html, /retainedDco=dcoSettings\.hasDco\?totals\.azureCost\*dcoSettings\.dcoRate\/100\*\(1-passedShare\):0/);
  assert.match(html, /id="distBusinessChart"/);
  assert.doesNotMatch(html, /Partner Earned Credit/);
  assert.match(html, /data-pane="pricing">Distributor<\/button>/);
  assert.match(html, /id="distributorWarning"[\s\S]*Distributor internal data[\s\S]*Do you really want to open it\?/);
  assert.match(html, /function confirmDistributorAccess\(\)/);
  assert.match(html, /if\(next==='pricing'&&!await confirmDistributorAccess\(\)\)return/);
  assert.match(html, /id="projectTips"/);
  assert.match(html, /Tipp: Only enter once\. Exporting the calculation saves your entered values/);
  assert.match(html, /Pro-Tipp: export without entering anything and ask Copilot to fill your prices in the json file\./);
  assert.match(html, /\$\('projectTips'\)\.hidden=!!name/);
  assert.match(html, /SQL Server List Prices/);
  assert.match(html, /Windows Server List Prices/);
  assert.match(html, /SQL Server Reseller Prices/);
  assert.match(html, /Windows Server Reseller Prices/);
  assert.match(html, /\.pricing-section\{border-top:1px solid var\(--line\)/);
  for (const id of [
    'sqlSplaList1', 'sqlSplaList2', 'winSplaList1', 'winSplaList2',
    'sqlSpla1', 'sqlSpla2', 'winSpla1', 'winSpla2',
    'sqlPayg1', 'sqlPayg2', 'winPayg1',
    'sqlResellerPayg1', 'sqlResellerPayg2', 'winResellerPayg1',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /if\(!p\.splaEntered\)missing\.push\('reseller SPLA prices'\)/);
  assert.match(html, /if\(!p\.resellerPaygEntered\)missing\.push\('reseller Azure PAYG prices'\)/);
  assert.match(html, /id="distBusinessWarning"[\s\S]*Distributor SPLA list prices and reseller Azure PAYG prices have not been entered/);
  assert.match(html, /splaList1:splaListEntered\?splaList1:0/);
  assert.match(html, /resellerPayg1:resellerPaygEntered\?resellerPayg1:0/);
  assert.doesNotMatch(html, /const WINSPLA=|const SQL=\{/);
  assert.match(html, /const SQLPAYG=\{/);
  assert.match(html, /function azurePricingSnapshot\(\).*?snapshot\[key\]=\{payg1:p\.payg1,payg2:p\.payg2\}/);
  assert.match(html, /const EMBEDDED_PRICES=\$\{JSON\.stringify\(azurePricingSnapshot\(\)\)\};/);
  assert.match(html, /function ensureOfflinePrivacy\(content\)/);
  assert.match(html, /Offline HTML must not contain a project name or configured workloads/);
  assert.match(html, /return ensureOfflinePrivacy\(content\)/);
  assert.doesNotMatch(html, /localStorage\.setItem\(['"](?:projectName|calculations|rows)/);
  assert.match(html, /function defaultState\(\)\{return\{sql:\{currency:'EUR',rows:\[\{edition:'Standard',qty:1,cores:32,uptime:'7x24'\},\{edition:'Standard',qty:1,cores:16,uptime:'5x10'\}\]/);
  assert.match(html, /windows:\{currency:'EUR',rows:\[\{edition:'Datacenter',qty:0,cores:8,uptime:'7x24'\},\{edition:'Datacenter',qty:0,cores:4,uptime:'5x10'\}\]/);
  assert.match(html, /function resetAll\(\).*?let defaults=defaultState\(\);state\.sql=defaults\.sql;state\.windows=defaults\.windows/);
  assert.doesNotMatch(html, /cores:220|qty:20|qty:40/);

  const embedded = JSON.parse(/const EMBEDDED_PRICES=(.*?);/.exec(html)[1]);
  for (const price of Object.values(embedded)) {
    assert.deepStrictEqual(Object.keys(price).sort(), ['payg1', 'payg2']);
  }
});
