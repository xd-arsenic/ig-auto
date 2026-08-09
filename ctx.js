// Runs in <head> before first paint. The anchored toolbar popup is opened via
// popup.html?ctx=popup (see background.applyDisplayMode); the docked side panel
// loads popup.html with no query. Tagging <html> here lets CSS give the popup a
// fixed width while the side panel stays fluid to fill its container.
if (new URLSearchParams(location.search).get("ctx") === "popup") {
  document.documentElement.classList.add("as-popup");
}
