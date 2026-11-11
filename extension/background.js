// Float the caption panel over every page in the session: a detached popup
// in the bottom-right corner, open for as long as the session runs.
browser.browserAction.setPopupStyles({
    backgroundColor: "#FFFFFF40",
    borderRadius: "20px",
});
browser.browserAction.resizePopup(380, 560);
browser.browserAction.setPopupPosition({ bottom: "24px", right: "24px" });
if (browser.browserAction.detachPopup) {
    browser.browserAction.detachPopup();
}
// keepOpen: clicking the page must not close (and so drop) the captions
browser.browserAction.openPopup(true);
