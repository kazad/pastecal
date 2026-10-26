// Which local server this Playwright worker talks to. scripts/test-browser.sh starts several servers and passes
// BASE_URLS (comma-separated); each worker process takes one by its parallel index and sets BASE_URL, so the
// `baseURL` fixture and specs that read process.env.BASE_URL both get it. Loaded by playwright.config.js, which
// Playwright evaluates in every worker before the spec files. With BASE_URLS unset, BASE_URL is left alone.
const urls = (process.env.BASE_URLS || '').split(',').filter(Boolean);
if (urls.length && process.env.TEST_PARALLEL_INDEX !== undefined) {
  process.env.BASE_URL = urls[Number(process.env.TEST_PARALLEL_INDEX) % urls.length];
} else if (urls.length && !process.env.BASE_URL) {
  process.env.BASE_URL = urls[0];
}
module.exports = process.env.BASE_URL || 'http://localhost:8787';
