// Linkify utility - converts URLs and emails in text to clickable links
function linkify(inputText) {
    var replacedText, replacePattern1, replacePattern2, replacePattern3;

    //URLs starting with http://, https://, or ftp://
    replacePattern1 = /(\b(https?|ftp):\/\/[^<>\s"']*[-A-Z0-9+&@#\/%=~_|])/gim;
    replacedText = inputText.replace(replacePattern1, '<a href="$1" target="_blank">$1</a>');

    //URLs starting with "www." (without // before it, or it'd re-link the ones done above).
    replacePattern2 = /(^|[^\/])(www\.[^<>\s"']+(\b|$))/gim;
    replacedText = replacedText.replace(replacePattern2, '$1<a href="http://$2" target="_blank">$2</a>');

    //Change email addresses to mailto:: links.
    replacePattern3 = /(([a-zA-Z0-9\-\_\.])+@[a-zA-Z\_]+?(\.[a-zA-Z]{2,6})+)/gim;
    replacedText = replacedText.replace(replacePattern3, '<a href="mailto:$1">$1</a>');

    return replacedText;
}

// Convert links in description to clickable items using MutationObserver
const linkifyObserver = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
        if (mutation.type === 'childList') {
            const descriptionEl = document.querySelector(".e-event-popup .e-description-details");
            if (descriptionEl && !descriptionEl.hasAttribute('data-processed')) {
                descriptionEl.setAttribute('data-processed', 'true');
                descriptionEl.innerHTML = linkify(descriptionEl.innerHTML);
            }
        }
    });
});

// Start observing the document with the configured parameters
linkifyObserver.observe(document.body, {
    childList: true,
    subtree: true
});
