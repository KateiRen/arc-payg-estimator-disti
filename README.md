# Arc PAYG vs. SPLA Estimator for the Indirect Channel

An estimator for comparing the economics of Azure Arc
pay-as-you-go licensing and SPLA for SQL Server and Windows Server workloads.

The estimator is self-contained in `site/index.html`. Distributor Azure PAYG
prices for all supported currencies are embedded in that file so the published
site loads without making a pricing API request. Distributor SPLA list prices,
reseller SPLA prices, and reseller Azure PAYG prices remain user-provided. The
SQL and Windows comparisons use the reseller prices. The distributor business
case compares those revenues with distributor SPLA list costs and embedded Azure
costs after the fixed 15% PEC discount. User-provided prices persist in
browser storage and exported project JSON files, but are never embedded in a
hosted or offline HTML copy. Project names and configured workloads are retained
only in exported project JSON files.

Missing-price warnings apply only to products with active workloads. Zero VM
quantities or no workload rows do not require prices for that product or block
the other product's distributor business case. A positive VM quantity with zero
entered cores still applies the existing licensing minimums and requires prices.

## Printing

The Print button and the browser's print command always include Instructions and
SQL Server PAYG, plus Windows Server PAYG when at least one workload has a VM count
greater than zero. The Distributor tab is never printed. Each sheet, including
expanded incentive component details, is automatically scaled to one A4 portrait
page. Large workload lists will use smaller text. The active tab and browser
layout are unchanged after printing or cancelling.

## Price refresh and deployment

The **Refresh estimator prices** GitHub Actions workflow:

- can be started manually from the repository's **Actions** tab;
- runs on the first day of every month at 12:00 AM Pacific time, accounting for
  both PST and PDT;
- fetches current SQL Server and Windows Server Arc PAYG prices from the
  [Azure Retail Prices API](https://learn.microsoft.com/rest/api/cost-management/retail-prices/azure-retail-prices);
- updates the embedded price map and ISO refresh timestamp in `site/index.html`;
- commits the refreshed estimator to `main`.

The successful refresh workflow triggers **Deploy estimator to GitHub
Pages**. Pushes to `main` and manual workflow dispatches also deploy the current
contents of `site/`.

## Project layout

| Path | Purpose |
| --- | --- |
| `site/index.html` | Self-contained estimator published to GitHub Pages |
| `site/pricing.js` | Azure Retail Prices API fetch and filtering helper |
| `scripts/fetch-prices.js` | Updates prices and refresh time embedded in the estimator |
| `.github/workflows/refresh-prices.yml` | Refreshes pricing monthly or manually |
| `.github/workflows/pages.yml` | Tests and deploys `site/` to GitHub Pages |

## Setup

1. In **Settings > Pages**, set **Source** to **GitHub Actions**.
2. In **Settings > Actions > General**, allow workflows read and write
   permissions so the refresh workflow can commit updated prices.
3. Run **Refresh estimator prices** from the **Actions** tab once, or refresh
   locally with `npm run fetch-prices`.
4. Push to `main`, or manually run **Deploy estimator to GitHub Pages**.

## Development

Node.js 20 or later is recommended. There are no package dependencies.

```sh
npm test
npm run fetch-prices
python -m http.server --directory site 8000
```

Print integration tests also run when `ARC_PRINT_BROWSER` points to a Chromium
browser executable and Node.js 22+ is used. They verify PDF page counts, conditional
Windows inclusion, and preservation of the browser layout, focus, and data.
