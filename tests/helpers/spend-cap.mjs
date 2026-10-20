// Loaded before every test file (package.json "test"): the suite runs as a
// deployment whose operator set PG1_DAILY_SPEND_CAP_USD, so the tests of
// routing, fallbacks and paid engines exercise them. Unset, the cap is $0
// and no paid engine is planned (lib/aiRouter.mjs dailySpendCapUsd);
// tests/spend-default.test.mjs checks that default with its own env.
if (process.env.PG1_DAILY_SPEND_CAP_USD === undefined) process.env.PG1_DAILY_SPEND_CAP_USD = '1000';
