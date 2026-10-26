// Shared by the browser journeys.

// Wait until the page stops drawing: no DOM change for `quiet` ms, at most `max` ms. Used after a page has loaded
// (its own condition met: the calendar and its events are there) instead of a fixed sleep for the calendar
// (Syncfusion or native) to finish laying out; on a quiet page it returns after `quiet` ms.
async function settled(page, { quiet = 200, max = 3000 } = {}) {
  await page.evaluate(({ quiet, max }) => new Promise((resolve) => {
    let t = null;
    const done = () => { ob.disconnect(); clearTimeout(t); clearTimeout(cap); resolve(); };
    const ob = new MutationObserver(() => { clearTimeout(t); t = setTimeout(done, quiet); });
    ob.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    t = setTimeout(done, quiet);
    const cap = setTimeout(done, max);
  }), { quiet, max });
}

// Every URL that is not this machine's: for a context's allowlist route, so local requests (nearly all of them)
// never make the round trip to the test process ('**/*' sent every one there).
const NOT_LOCAL = /^(?!https?:\/\/(localhost|127\.0\.0\.1)[:/])/;

module.exports = { settled, NOT_LOCAL };
