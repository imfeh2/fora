from html import escape

ORIGIN_ERROR_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<title>Fora</title>
<style>
* { box-sizing: border-box; }
body {
  margin: 0; padding: 24px 16px; background: rgb(31 30 30);
  color: rgb(175 172 171);
  font: 14px/20px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
main {
  max-width: 34em; margin: 0 auto; padding: 20px;
  border: 1px solid rgb(46 45 45); border-radius: 6px;
  background: rgb(24 23 23);
}
h1 {
  margin: 0; color: rgb(247 245 244); font-size: 24px;
  line-height: 30px; font-weight: 600; letter-spacing: -0.025em;
}
p { margin: 12px 0 0; }
a {
  color: rgb(108 148 236); overflow-wrap: anywhere;
  font: 13px/20px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
a:hover { color: rgb(173 199 252); }
a:focus-visible { outline: 2px solid rgb(50 73 148); outline-offset: 2px; }
</style>
</head>
<body>
<main>
<h1>This address is not allowed</h1>
<p>Fora answers only on this computer's own addresses and names. The address you opened is not one of them, so the page could not load.</p>
<p>Open Fora at this address:</p>
<p><a href="ENTRY_URL" rel="noreferrer">ENTRY_URL</a></p>
<p>A name that merely resolves to this computer is not accepted, so a page you visit elsewhere cannot reach this instance through a name it controls.</p>
</main>
</body>
</html>
"""


def origin_error_page(url: str) -> str:
    return ORIGIN_ERROR_PAGE.replace("ENTRY_URL", escape(url, quote=True))
