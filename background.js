browser.browserAction.onClicked.addListener(() => {
    browser.tabs.create({ url: "player.html" });
});
